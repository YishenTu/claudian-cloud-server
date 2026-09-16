import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { it } from 'node:test';

import { collabCloudProjectOperationRoute, collabControlOperationCodec, decodeCollabCloudSuccessEnvelope } from '@claudian-collab/protocol';
import { Client } from 'pg';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { ProjectWriteAdmission } from '../../../src/project-authority/admission/ProjectWriteAdmission.js';
import { ProtectedSecretCustody } from '../../../src/project-authority/lifecycle/ProtectedSecretCustody.js';
import { ProjectRecoveryLinkAuthority } from '../../../src/project-authority/membership/ProjectRecoveryLinkAuthority.js';
import { createVaultCredentialPrincipal } from '../../../src/request-context/RequestPrincipal.js';
import { CloudProjectMembershipRoutes } from '../../../src/server/control/CloudProjectMembershipRoutes.js';
import { withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

const PROJECT = 'project_recovery';
const NOW = '2026-09-14T12:00:00.000Z';
const ORIGINAL_CREDENTIAL = 'b'.repeat(64);
const TARGET_CREDENTIAL = 'c'.repeat(64);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const manager = createVaultCredentialPrincipal({ principalId: `vault-${hash('a'.repeat(64))}` });
const target = createVaultCredentialPrincipal({ principalId: `vault-${hash(TARGET_CREDENTIAL)}` });

it('issues independent recovery links and atomically binds the proven member with exact receipt replay', async () => {
  await withPostgresTestDatabase(async database => {
    await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
    const client = new Client({ connectionString: database.migrationUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('claudian_cloud.project_id', $1, true)", [PROJECT]);
      await client.query(`INSERT INTO claudian_cloud.projects
        (project_id, project_name, manager_set_generation, expected_main_oid, service_state, created_at, activated_at, authority_generation)
        VALUES ($1, 'Recovery Project', 1, $2, 'active', $3, $3, 4)`, [PROJECT, '1'.repeat(40), NOW]);
      await client.query(`INSERT INTO claudian_cloud.project_memberships
        (project_id, member_id, display_name, role, status, revision, created_at, updated_at, activated_at)
        VALUES ($1, 'member_manager', 'Manager', 'manager', 'active', 1, $2, $2, $2),
          ($1, 'member_recipient', 'Recipient', 'member', 'active', 1, $2, $2, $2),
          ($1, 'member_second', 'Second', 'member', 'active', 1, $2, $2, $2)`, [PROJECT, NOW]);
      await client.query(`INSERT INTO claudian_cloud.project_principal_bindings
        (project_id, principal_id, member_id, state, bound_at, revoked_at)
        VALUES ($1, $2, 'member_manager', 'active', $3, NULL)`, [PROJECT, manager.principalId, NOW]);
      await client.query(`INSERT INTO claudian_cloud.project_member_recovery_credentials
        (project_id, member_id, credential_sha256) VALUES ($1, 'member_recipient', $2), ($1, 'member_second', $3)`, [PROJECT, hash(ORIGINAL_CREDENTIAL), hash('d'.repeat(64))]);
      await client.query(`INSERT INTO claudian_cloud.repository_placements
        (project_id, storage_node_id, repository_storage_key, generation, active, created_at, updated_at)
        VALUES ($1, 'node-a', 'repo_recovery', 1, true, $2, $2)`, [PROJECT, NOW]);
      await client.query('COMMIT');
    } finally { await client.end(); }
    const coordination = new PostgresCoordination({ ordinaryPoolMax: 4, pinnedPoolMax: 2, reservedPoolMax: 1,
      projectLockTimeoutMs: 2_000, runtimeConnectionString: database.runtimeUrl, shutdownTimeoutMs: 2_000 });
    const admission = new ProjectWriteAdmission({ coordination, recovery: { recoverProject: async () => {} } });
    const custody = new ProtectedSecretCustody({ activeKeyId: 'test-key', keys: [{ keyId: 'test-key', keyVersion: 1, key: Buffer.alloc(32, 7) }] });
    let now = new Date(NOW);
    const authority = new ProjectRecoveryLinkAuthority({ coordination, custody, writeAdmission: admission, clock: () => now });
    try {
      const bindingCheck = await coordination.acquireProjectLease(PROJECT);
      try {
        await assert.rejects(bindingCheck.withProjectScope(scope => scope.portability.bindProjectPrincipal({
          memberId: 'member_second', principalId: `vault-${hash(ORIGINAL_CREDENTIAL)}`, boundAt: NOW,
        })));
        await assert.rejects(bindingCheck.withProjectScope(async scope => {
          for (let index = 0; index < 255; index++) {
            await scope.membershipRecovery.retainMemberCredentialHash('member_second', hash(`historical-${String(index)}`));
          }
          await scope.portability.bindProjectPrincipal({ memberId: 'member_second', principalId: `vault-${hash('new-target')}`, boundAt: NOW });
        }));
      } finally { await bindingCheck.close(); }
      const request = { projectId: PROJECT, expectedAuthorityGeneration: 4, idempotencyKey: 'create_1' };
      const first = await authority.create(manager, request);
      const second = await authority.create(manager, { ...request, idempotencyKey: 'create_2' });
      assert.notEqual(first.recoveryLinkId, second.recoveryLinkId);
      assert.notEqual(first.token, second.token);
      assert.deepEqual(await authority.create(manager, request), first);
      const redeem = { ...request, idempotencyKey: 'redeem_1', recoveryLinkId: first.recoveryLinkId,
        token: first.token, proofCredential: ORIGINAL_CREDENTIAL };
      await assert.rejects(authority.redeem(target, { ...redeem, proofCredential: 'e'.repeat(64) }));
      await assert.rejects(authority.redeem(target, { ...redeem, expectedAuthorityGeneration: 3 }));
      const responses = await Promise.all([authority.redeem(target, redeem), authority.redeem(target, redeem)]);
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(responses[0].memberId, 'member_recipient');
      assert.equal(responses[0].personalRef, 'refs/heads/members/member_recipient');
      const lease = await coordination.acquireProjectLease(PROJECT);
      try {
        await lease.withProjectScope(async scope => {
          const backup = await scope.checkpoint.readProjectCheckpointRecords({ profile: 'backup', snapshotAt: NOW,
            maximumCoordinationBytes: 1_000_000, metadata: { authorityId: 'authority_recovery', authorityVolumeIdentity: 'volume_recovery',
              coordinationSchemaVersion: 13, maximumServerBuild: 'a'.repeat(40), minimumServerBuild: 'a'.repeat(40), repositoryFormatVersion: 1, restoreEpoch: 1 } });
          const retained = backup.find(item => item.kind === 'project-recovery-link' && item.recordId === first.recoveryLinkId);
          assert.equal(retained?.kind, 'project-recovery-link');
          assert.deepEqual(retained.value.redemption?.response, responses[0]);
          const portable = backup.find(item => item.kind === 'member' && item.recordId === 'member_recipient');
          assert.equal(portable?.kind, 'member');
          assert.deepEqual(portable.value.recoveryCredentialHashes, [hash(ORIGINAL_CREDENTIAL), hash(TARGET_CREDENTIAL)].sort());
          assert.equal(JSON.stringify(backup).includes(first.token), false);
          assert.equal(JSON.stringify(backup).includes(ORIGINAL_CREDENTIAL), false);
          assert.equal((await scope.findMembership('member_recipient'))?.status, 'active');
          assert.equal((await scope.listMemberships()).length, 3);
          assert.equal(await scope.membership.readPrincipalBindingState(target.principalId), 'active');
        });
      } finally { await lease.close(); }
      const secondPrincipal = createVaultCredentialPrincipal({ principalId: `vault-${hash('f'.repeat(64))}` });
      const secondRedeem = { ...redeem, idempotencyKey: 'redeem_2', recoveryLinkId: second.recoveryLinkId,
        token: second.token, proofCredential: 'd'.repeat(64) };
      await assert.rejects(authority.redeem(manager, secondRedeem));
      await assert.rejects(authority.redeem(secondPrincipal, { ...secondRedeem, proofCredential: ORIGINAL_CREDENTIAL }));
      const fault = new Client({ connectionString: database.migrationUrl });
      await fault.connect();
      try {
        await fault.query(`CREATE FUNCTION claudian_cloud.fail_recovery_receipt() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'injected recovery receipt failure'; END $$`);
        await fault.query(`CREATE TRIGGER fail_recovery_receipt BEFORE UPDATE ON claudian_cloud.project_recovery_links
          FOR EACH ROW EXECUTE FUNCTION claudian_cloud.fail_recovery_receipt()`);
        await assert.rejects(authority.redeem(secondPrincipal, secondRedeem));
        const inspection = await coordination.acquireProjectLease(PROJECT);
        try {
          await inspection.withProjectScope(async scope => {
            assert.equal(await scope.portability.findProjectPrincipalBinding(secondPrincipal.principalId), undefined);
            assert.deepEqual(await scope.membershipRecovery.readMemberCredentialHashes('member_second'), [hash('d'.repeat(64))]);
            assert.equal((await scope.membershipRecovery.readLink(second.recoveryLinkId))?.redemption, undefined);
          });
        } finally { await inspection.close(); }
      } finally {
        await fault.query('DROP TRIGGER IF EXISTS fail_recovery_receipt ON claudian_cloud.project_recovery_links');
        await fault.query('DROP FUNCTION IF EXISTS claudian_cloud.fail_recovery_receipt()');
        await fault.end();
      }
      const secondReceipt = await authority.redeem(secondPrincipal, secondRedeem);
      assert.equal(secondReceipt.memberId, 'member_second');
      assert.deepEqual(await authority.redeem(secondPrincipal, secondRedeem), secondReceipt);
      now = new Date('2026-09-14T12:01:00.000Z');
      const fresh = await authority.create(manager, { ...request, idempotencyKey: 'create_3' });
      const repeated = await authority.redeem(target, { ...redeem, idempotencyKey: 'redeem_3',
        recoveryLinkId: fresh.recoveryLinkId, token: fresh.token });
      assert.equal(repeated.memberId, 'member_recipient');
      assert.equal(repeated.personalRef, responses[0].personalRef);
      assert.equal(repeated.recoveredAt, now.toISOString());
      const routes = new CloudProjectMembershipRoutes({ recoveryLinks: authority,
        creation: { create: () => Promise.reject(new Error('Unused creation route')) },
        join: { join: () => Promise.reject(new Error('Unused join route')) },
        maximumJsonBytes: 64 * 1024, operationTimeoutMs: 2_000 });
      const server = createServer((incoming, outgoing) => { if (!routes.handle(incoming, outgoing)) outgoing.writeHead(404).end(); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const submit = async (operation: 'createProjectRecoveryLink' | 'redeemProjectRecoveryLink', data: unknown, credential: string) => {
          const route = collabCloudProjectOperationRoute(PROJECT, operation);
          const reply = await fetch(`http://127.0.0.1:${String(address.port)}${route.target}`, {
            method: route.method, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
            body: JSON.stringify({ protocolVersion: 15, requestId: 'request_http_recovery', data }),
          });
          return { status: reply.status, body: await reply.json() as unknown };
        };
        const issued = await submit('createProjectRecoveryLink', { ...request, idempotencyKey: 'create_http' }, 'a'.repeat(64));
        assert.equal(issued.status, 200);
        const link = collabControlOperationCodec('createProjectRecoveryLink').decodeResponse(decodeCollabCloudSuccessEnvelope(issued.body).data);
        const httpRedeem = { ...redeem, recoveryLinkId: link.recoveryLinkId, token: link.token, idempotencyKey: 'redeem_http', proofCredential: TARGET_CREDENTIAL };
        assert.equal((await submit('redeemProjectRecoveryLink', httpRedeem, 'f'.repeat(64))).status, 403);
        const redeemed = await submit('redeemProjectRecoveryLink', httpRedeem, TARGET_CREDENTIAL);
        assert.equal(redeemed.status, 200);
        const receipt = collabControlOperationCodec('redeemProjectRecoveryLink').decodeResponse(decodeCollabCloudSuccessEnvelope(redeemed.body).data);
        assert.equal(receipt.memberId, 'member_recipient');
        assert.deepEqual((await submit('redeemProjectRecoveryLink', httpRedeem, TARGET_CREDENTIAL)).body, redeemed.body);
      } finally { await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); })); }
      now = new Date('2026-09-14T12:20:00.000Z');
      assert.deepEqual(await authority.redeem(target, redeem), responses[0]);
      await assert.rejects(authority.redeem(target, { ...redeem, idempotencyKey: 'another_intent' }));
      await assert.rejects(authority.redeem(target, { ...redeem, recoveryLinkId: second.recoveryLinkId, token: second.token }));
      await assert.rejects(authority.create(manager, request));
    } finally {
      await authority.close();
      await admission.close();
      await coordination.close();
    }
  });
});
