import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from 'pg';
import { CollabError } from '@claudian-collab/protocol';
import { PostgresSchemaInitializer } from '../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { ProjectMemberRemovalCoordinator } from '../../src/project-authority/membership/ProjectMemberRemovalCoordinator.js';
import { createVaultCredentialPrincipal } from '../../src/request-context/RequestPrincipal.js';
import { RepositoryCheckpointAuthority, RepositoryCheckpointError } from '../../src/repositories/RepositoryCheckpointAuthority.js';
import type { RepositoryPlacementLease, RepositoryPlacementValidator } from '../../src/repositories/RepositoryPlacement.js';
import { ResourceAdmission } from '../../src/resource-admission/ResourceAdmission.js';
import { CLOUD_TO_LAN_MANAGER_PRINCIPAL, CLOUD_TO_LAN_TARGET_PRINCIPAL, cloudToLanPostgres, seedCloudToLanProject, seedCloudToLanRepository } from '../helpers/CloudToLanPostgresHarness.js';
import { withPostgresTestDatabase } from '../helpers/PostgresTestDatabase.js';

const GIT = '/usr/bin/git';
const CREATED_AT = '2026-08-26T00:00:00.000Z';
const WORKER = fileURLToPath(new URL('../helpers/MemberRemovalProcessWorker.ts', import.meta.url));
class CurrentPlacement implements RepositoryPlacementValidator {
  isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> { return Promise.resolve(true); }
}

async function waitForSettlement(worker: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('member-removal-worker.timeout')), 10_000);
    let output = '';
    worker.stdout?.setEncoding('utf8');
    worker.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (output === 'membership-revoked\n') { clearTimeout(timer); resolve(); }
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('member-removal-worker.exited')); });
  });
}

test('recovers Remove with its immutable result and exact ref after process death at membership settlement', async () => {
  await withPostgresTestDatabase(async database => {
    await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      const root = await mkdtemp(join(tmpdir(), 'claudian-removal-recovery-'));
      const repositoryRoot = join(root, 'repositories');
      const operationRoot = join(root, 'operations');
      await Promise.all([
        mkdir(repositoryRoot, { recursive: true }),
        mkdir(operationRoot, { recursive: true }),
      ]);
      const admission = new ResourceAdmission({
        maxChildren: 2,
        maxChildrenPerProject: 1,
        queueMax: 2,
        queueMaxPerProject: 1,
        queueTimeoutMs: 1_000,
      });
      const repository = new RepositoryCheckpointAuthority({
        gitExecutable: GIT,
        maximumBlobBytes: 1024 * 1024,
        maximumBundleBytes: 2 * 1024 * 1024,
        maximumExpandedTreeEntries: 100_000,
        maximumRepositoryBytes: 2 * 1024 * 1024,
        maximumTreeEntries: 2_000,
        operationRoot,
        operationTimeoutMs: 5_000,
        outputMaxBytes: 64 * 1024,
        placementValidator: new CurrentPlacement(),
        repositoryRoot,
        resourceAdmission: admission,
        storageNodeId: 'local',
      });
    const projectId = 'project-removal-recovery';
    let store = cloudToLanPostgres(database);
    let worker: ReturnType<typeof spawn> | undefined;
    let removal: ProjectMemberRemovalCoordinator | undefined;
    try {
      const expectedOid = await seedCloudToLanRepository(root, projectId);
      await seedCloudToLanProject(database, projectId, expectedOid);
      await store.withProjectScope(projectId, async scope => {
        await scope.collaboration.requests.create({ createdAt: CREATED_AT, description: 'Open work', firstBaseOid: expectedOid, latestHeadOid: expectedOid, memberId: 'member-target', requestId: 'request-removal-recovery' });
        await scope.portability.putLifecycleJournal({ actorMemberId: 'member-manager', createdAt: CREATED_AT, direction: 'lan-to-cloud', expectedAuthorityGeneration: 3,
          idempotencyKey: 'import-recovery', kind: 'authority-transfer', operationId: 'transfer-removal-recovery', phase: 'checkpoint-received', projectId, requestFingerprint: 'a'.repeat(64), scheduledAt: CREATED_AT });
        await scope.portability.advanceLifecycleJournal({ batchRevision: 1, batchSha256: 'b'.repeat(64), checkpointSha256: 'c'.repeat(64), expectedPhase: 'checkpoint-received', expectedState: 'active', nextPhase: 'completed', nextState: 'completed', operationId: 'transfer-removal-recovery', scheduledAt: CREATED_AT, updatedAt: CREATED_AT });
        await scope.portability.putTransferredMembershipClaim({ batchRevision: 1, checkpointSha256: 'c'.repeat(64), claimSha256: 'd'.repeat(64), createdAt: CREATED_AT, expiresAt: '2026-09-26T00:00:00.000Z', memberId: 'member-target', transferId: 'transfer-removal-recovery' });
      });
      const fault = new Client({ connectionString: database.migrationUrl });
      await fault.connect();
      try {
        await fault.query(`CREATE FUNCTION claudian_cloud.reject_membership_event() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected-membership-event-failure'; END $$`);
        await fault.query(`CREATE TRIGGER reject_membership_event BEFORE INSERT ON claudian_cloud.project_events
          FOR EACH ROW EXECUTE FUNCTION claudian_cloud.reject_membership_event()`);
        removal = new ProjectMemberRemovalCoordinator({ clock: () => new Date('2026-08-27T00:00:01.000Z'), coordination: store, repository });
        await assert.rejects(removal.remove(createVaultCredentialPrincipal({ principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL }), {
          expectedManagerSetGeneration: 1, expectedTargetMembershipRevision: 1, idempotencyKey: 'remove-recovery-intent', projectId, targetMemberId: 'member-target',
        }), (error: unknown) => error instanceof CollabError && error.code === 'operation-failed');
        await store.withProjectScope(projectId, async scope => {
          const prepared = await scope.membership.getNonterminalRemoval();
          assert.equal(prepared?.phase, 'prepared');
          assert.equal(prepared.response, undefined);
          assert.equal((await scope.findMembership('member-target'))?.status, 'active');
          assert.equal((await scope.portability.findProjectPrincipalBinding(CLOUD_TO_LAN_TARGET_PRINCIPAL))?.state, 'active');
          assert.equal((await scope.portability.getTransferredMembershipClaim('transfer-removal-recovery', 'member-target'))?.state, 'unclaimed');
          assert.equal((await scope.collaboration.requests.find('request-removal-recovery'))?.status, 'open');
          assert.deepEqual((await scope.readProjectEvents({ afterSequence: 0, limit: 10 })).events, []);
        });
        await removal.close();
        removal = undefined;
        await fault.query('DROP TRIGGER reject_membership_event ON claudian_cloud.project_events');
        await fault.query('DROP FUNCTION claudian_cloud.reject_membership_event()');
      } finally { await fault.end(); }
      await store.close();
      worker = spawn(process.execPath, ['--import', 'tsx', WORKER], {
        env: { ...process.env, CLAUDIAN_REMOVAL_PROJECT_ID: projectId, CLAUDIAN_REMOVAL_REPOSITORY_ROOT: repositoryRoot, CLAUDIAN_REMOVAL_OPERATION_ROOT: operationRoot, CLAUDIAN_REMOVAL_RUNTIME_URL: database.runtimeUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitForSettlement(worker);
      const exited = once(worker, 'exit');
      assert.equal(worker.kill('SIGKILL'), true);
      await exited;
      worker = undefined;
      store = cloudToLanPostgres(database);
      const journal = await store.withProjectScope(projectId, async scope => {
        const current = await scope.membership.getNonterminalRemoval();
        assert.equal(current?.phase, 'membership-revoked');
        assert.equal(current.expectedPersonalRefOid, expectedOid);
        assert.equal(current.response?.discardedRequestId, 'request-removal-recovery');
        assert.equal((await scope.findMembership('member-target'))?.status, 'revoked');
        assert.equal((await scope.portability.findProjectPrincipalBinding(CLOUD_TO_LAN_TARGET_PRINCIPAL))?.state, 'revoked');
        assert.equal((await scope.portability.getTransferredMembershipClaim('transfer-removal-recovery', 'member-target'))?.state, 'revoked');
        assert.equal((await scope.collaboration.requests.find('request-removal-recovery'))?.status, 'discarded');
        const events = await scope.readProjectEvents({ afterSequence: 0, limit: 10 });
        assert.equal(events.events.filter(event => event.kind === 'membership.updated').length, 1);
        return current;
      });
      const placement = await store.withProjectScope(projectId, scope => scope.getRepositoryPlacement());
      assert.ok(placement);
      const verification = await repository.reserveExactRepositoryOperation(projectId);
      try { await repository.verifyExactPersonalRef(verification, { expectedOid, personalRef: journal.personalRef, placement }); }
      finally { await verification.close(); }
      removal = new ProjectMemberRemovalCoordinator({ clock: () => new Date('2026-08-27T00:00:10.000Z'), coordination: store, repository });
      await removal.recoverProject(projectId);
      const request = { expectedManagerSetGeneration: 1, expectedTargetMembershipRevision: 1, idempotencyKey: 'remove-recovery-intent', projectId, targetMemberId: 'member-target' };
      assert.deepEqual(await removal.remove(createVaultCredentialPrincipal({ principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL }), request), journal.response);
      await assert.rejects(removal.remove(createVaultCredentialPrincipal({ principalId: CLOUD_TO_LAN_TARGET_PRINCIPAL }), request), (error: unknown) => error instanceof CollabError && error.code === 'authorization-denied');
      await store.withProjectScope(projectId, async scope => {
        assert.equal(await scope.membership.getNonterminalRemoval(), undefined);
        assert.deepEqual((await scope.membership.getRemoval(journal.operationId))?.response, journal.response);
        assert.equal((await scope.readProjectEvents({ afterSequence: 0, limit: 10 })).events.filter(event => event.kind === 'membership.updated').length, 1);
      });
      const removed = await repository.reserveExactRepositoryOperation(projectId);
      try { await assert.rejects(repository.verifyExactPersonalRef(removed, { expectedOid, personalRef: journal.personalRef, placement }), (error: unknown) => error instanceof RepositoryCheckpointError && error.code === 'repository-invalid'); }
      finally { await removed.close(); }
    } finally {
      if (worker !== undefined) { const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited; }
      await removal?.close();
      await store.close();
      await repository.close();
      await admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
