import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { PostgresMigrator } from '../../src/coordination/postgres/PostgresMigrator.js';
import { DeletionCoordinator } from '../../src/project-authority/lifecycle/delete/DeletionCoordinator.js';
import {
  LeaveCoordinator,
  LeaveCoordinatorError,
} from '../../src/project-authority/lifecycle/leave/LeaveCoordinator.js';
import { RetireCoordinator } from '../../src/project-authority/lifecycle/retire/RetireCoordinator.js';
import {
  RepositoryCheckpointAuthority,
  RepositoryCheckpointError,
} from '../../src/repositories/RepositoryCheckpointAuthority.js';
import type {
  RepositoryPlacementLease,
  RepositoryPlacementValidator,
} from '../../src/repositories/RepositoryPlacement.js';
import { ResourceAdmission } from '../../src/resource-admission/ResourceAdmission.js';
import {
  CLOUD_TO_LAN_MANAGER_PRINCIPAL,
  CLOUD_TO_LAN_TARGET_PRINCIPAL,
  cloudToLanPostgres,
  seedCloudToLanProject,
  seedCloudToLanRepository,
} from '../helpers/CloudToLanPostgresHarness.js';
import { withPostgresTestDatabase } from '../helpers/PostgresTestDatabase.js';

const GIT = '/usr/bin/git';
const RETIRED_AT = '2026-08-27T00:00:01.000Z';
const RECOVERED_AT = '2026-08-27T00:00:10.000Z';
const DELETION_PROCESS_WORKER = fileURLToPath(new URL(
  '../helpers/TerminalDeletionProcessWorker.ts',
  import.meta.url,
));
const DELETION_PHASES = [
  'traffic-denied',
  'repository-delete-intent',
  'repository-removed',
  'coordination-removed',
  'tombstoned',
  'completed',
] as const;

function spawnDeletionWorker(input: Readonly<{
  readonly operationId: string;
  readonly operationRoot: string;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly runtimeUrl: string;
  readonly targetPhase: typeof DELETION_PHASES[number];
}>) {
  return spawn(process.execPath, ['--import', 'tsx', DELETION_PROCESS_WORKER], {
    env: {
      ...process.env,
      CLAUDIAN_TERMINAL_DELETE_OPERATION_ID: input.operationId,
      CLAUDIAN_TERMINAL_DELETE_OPERATION_ROOT: input.operationRoot,
      CLAUDIAN_TERMINAL_DELETE_PROJECT_ID: input.projectId,
      CLAUDIAN_TERMINAL_DELETE_REPOSITORY_ROOT: input.repositoryRoot,
      CLAUDIAN_TERMINAL_DELETE_RUNTIME_URL: input.runtimeUrl,
      CLAUDIAN_TERMINAL_DELETE_TARGET_PHASE: input.targetPhase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForDeletionPhase(
  child: ReturnType<typeof spawnDeletionWorker>,
  expectedPhase: typeof DELETION_PHASES[number],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error('terminal-deletion-worker.timeout'));
    }, 10_000);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      try {
        const result = JSON.parse(output.slice(0, output.indexOf('\n'))) as {
          readonly phase?: string;
        };
        if (result.phase !== expectedPhase) {
          reject(new Error('terminal-deletion-worker.invalid-output'));
          return;
        }
        resolve();
      } catch {
        reject(new Error('terminal-deletion-worker.invalid-output'));
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error('terminal-deletion-worker.failed'));
      }
    });
  });
}

class CurrentPlacement implements RepositoryPlacementValidator {
  async isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    await Promise.resolve();
    return true;
  }
}

function storageKey(projectId: string): string {
  return `repository_${createHash('sha256').update(projectId).digest('hex').slice(0, 20)}`;
}

function repositoryPath(root: string, projectId: string): string {
  return join(
    root,
    'repositories',
    Buffer.from(projectId).toString('hex'),
    storageKey(projectId),
  );
}

async function writeOwnershipMarker(root: string, projectId: string): Promise<void> {
  await writeFile(
    join(repositoryPath(root, projectId), '.claudian-cloud-publication.json'),
    `${JSON.stringify({
      artifactKey: 'artifact-terminal-recovery',
      attemptId: 'attempt-terminal-recovery',
      generation: 7,
      markerSha256: '1'.repeat(64),
      objectFormat: 'sha1',
      projectId,
      refs: [],
      repositoryStorageKey: storageKey(projectId),
      schemaVersion: 1,
      storageNodeId: 'local',
      validationMarkerSha256: '1'.repeat(64),
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function expectMissing(path: string): Promise<void> {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

describe('terminal lifecycle cross-store recovery', () => {
  it('recovers exact Leave after membership settlement and store restart', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const root = await mkdtemp(join(tmpdir(), 'claudian-leave-recovery-'));
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
      try {
        const projectId = 'project-leave-recovery';
        const expectedOid = await seedCloudToLanRepository(root, projectId);
        await seedCloudToLanProject(database, projectId, expectedOid);
        const request = {
          projectId,
          idempotencyKey: 'leave-recovery-intent',
          expectedPersonalRefOid: expectedOid,
        };
        let failDeletion = true;
        let store = cloudToLanPostgres(database);
        let leave = new LeaveCoordinator({
          clock: () => new Date(RETIRED_AT),
          coordination: store,
          repository: {
            reserveExactRepositoryOperation: (projectId, signal) => (
              repository.reserveExactRepositoryOperation(projectId, signal)
            ),
            verifyExactPersonalRef: (reservation, input) => (
              repository.verifyExactPersonalRef(reservation, input)
            ),
            deleteExactPersonalRef(reservation, input) {
              if (failDeletion) {
                failDeletion = false;
                return Promise.reject(new Error('injected-after-membership-settlement'));
              }
              return repository.deleteExactPersonalRef(reservation, input);
            },
          },
        });
        await assert.rejects(leave.leave({
          principalId: CLOUD_TO_LAN_TARGET_PRINCIPAL,
          request,
        }), (error: unknown) => error instanceof LeaveCoordinatorError
          && error.code === 'dependency-failed');
        await store.withProjectScope(projectId, async scope => {
          assert.equal((await scope.portability.getNonterminalLifecycleJournal())?.phase,
            'membership-left');
          assert.equal((await scope.portability.findProjectPrincipalBinding(
            CLOUD_TO_LAN_TARGET_PRINCIPAL,
          ))?.state, 'revoked');
        });
        await store.close();

        store = cloudToLanPostgres(database);
        leave = new LeaveCoordinator({
          clock: () => new Date(RECOVERED_AT),
          coordination: store,
          repository,
        });
        await assert.rejects(leave.leave({
          principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
          request: {
            expectedPersonalRefOid: expectedOid,
            idempotencyKey: request.idempotencyKey,
            projectId,
          },
        }), (error: unknown) => error instanceof LeaveCoordinatorError
          && error.code === 'manager-succession-required');
        const verification = await repository.reserveExactRepositoryOperation(projectId);
        await repository.verifyExactPersonalRef(verification, {
          expectedOid,
          personalRef: 'refs/heads/members/member-target',
          placement: {
            active: true,
            generation: 7,
            projectId,
            repositoryStorageKey: storageKey(projectId),
            storageNodeId: 'local',
          },
        });
        await verification.close();
        const result = await leave.leave({
          principalId: CLOUD_TO_LAN_TARGET_PRINCIPAL,
          request: {
            expectedPersonalRefOid: expectedOid,
            idempotencyKey: request.idempotencyKey,
            projectId,
          },
        });
        assert.deepEqual(await leave.leave({
          principalId: CLOUD_TO_LAN_TARGET_PRINCIPAL,
          request,
        }), result);
        const removedVerification = await repository.reserveExactRepositoryOperation(
          projectId,
        );
        await assert.rejects(repository.verifyExactPersonalRef(removedVerification, {
          expectedOid,
          personalRef: 'refs/heads/members/member-target',
          placement: {
            active: true,
            generation: 7,
            projectId,
            repositoryStorageKey: storageKey(projectId),
            storageNodeId: 'local',
          },
        }), (error: unknown) => error instanceof RepositoryCheckpointError
          && error.code === 'repository-invalid');
        await removedVerification.close();
        await store.close();
      } finally {
        await repository.close();
        await admission.close();
        await rm(root, { force: true, recursive: true });
      }
    });
  });

  it('recovers every deletion phase after process death with PostgreSQL and real Git', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const root = await mkdtemp(join(tmpdir(), 'claudian-terminal-recovery-'));
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
      try {
        for (const [index, stoppedPhase] of DELETION_PHASES.entries()) {
          const projectId = `project-terminal-${String(index)}`;
          const expectedMainOid = await seedCloudToLanRepository(root, projectId);
          await writeOwnershipMarker(root, projectId);
          await seedCloudToLanProject(database, projectId, expectedMainOid);
          let store = cloudToLanPostgres(database);
          const request = {
            expectedAuthorityGeneration: 4,
            expectedMainOid,
            idempotencyKey: `retire-terminal-${String(index)}`,
            projectId,
          };
          const retire = new RetireCoordinator({
            clock: () => new Date(RETIRED_AT),
            coordination: store,
            repository,
          });
          const retired = await retire.retire({
            principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
            request,
          });
          const facts = await store.withProjectScope(projectId, async scope => {
            const deletion = await scope.portability.getNonterminalLifecycleJournal();
            const intent = deletion === undefined
              ? undefined
              : await scope.portability.getDeletionIntent(deletion.operationId);
            assert.ok(deletion);
            assert.ok(intent);
            return { deletion, intent };
          });
          await store.close();

          const worker = spawnDeletionWorker({
            operationId: facts.deletion.operationId,
            operationRoot,
            projectId,
            repositoryRoot,
            runtimeUrl: database.runtimeUrl,
            targetPhase: stoppedPhase,
          });
          await waitForDeletionPhase(worker, stoppedPhase);
          const exited = once(worker, 'exit');
          assert.equal(worker.kill('SIGKILL'), true);
          await exited;

          store = cloudToLanPostgres(database);
          const replay = new RetireCoordinator({
            clock: () => new Date(RECOVERED_AT),
            coordination: store,
            repository,
          });
          assert.deepEqual(await replay.retire({
            principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
            request,
          }), retired);
          const deletion = new DeletionCoordinator({
            clock: () => new Date(RECOVERED_AT),
            coordination: store,
            repository,
          });
          assert.equal(await deletion.resumeAuthorized({
            authorizationSha256: facts.intent.authorizationSha256,
            operationId: facts.deletion.operationId,
            projectId,
          }), 'settled');
          assert.equal(await deletion.resumeAuthorized({
            authorizationSha256: facts.intent.authorizationSha256,
            operationId: facts.deletion.operationId,
            projectId,
          }), 'settled');
          await store.withProjectScope(projectId, async scope => {
            assert.equal(await scope.getProject(), undefined);
            assert.equal((await scope.portability.getLifecycleJournal(
              facts.deletion.operationId,
            ))?.state, 'completed');
            assert.equal(
              (await scope.portability.getProjectTombstone())?.terminalOperationId,
              retired.retirementId,
            );
          });
          await expectMissing(repositoryPath(root, projectId));
          await store.close();
        }
      } finally {
        await repository.close();
        await admission.close();
        await rm(root, { force: true, recursive: true });
      }
    });
  });
});
