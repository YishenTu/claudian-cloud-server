import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';
import { cloudToLanPostgres, seedCloudToLanProject } from '../../helpers/CloudToLanPostgresHarness.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';

test('exit CAS failures roll back prior writes and Project lanes isolate concurrent exit', async () => {
  await withPostgresTestDatabase(async database => {
    await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
    for (const project of ['project-exit-cas-a', 'project-exit-cas-b']) {
      await seedCloudToLanProject(database, project, 'a'.repeat(40));
    }
    const store = cloudToLanPostgres(database);
    const projectId = 'project-exit-cas-a';
    const now = '2026-08-27T00:01:00.000Z';
    try {
      const before = await store.withProjectScope(projectId, async scope => ({
        manager: await scope.findMembership('member-manager'),
        target: await scope.findMembership('member-target'),
        generation: (await scope.getProject())?.managerSetGeneration,
      }));
      await assert.rejects(store.withProjectScope(projectId, scope => scope.membership.applyMemberExit({
        advanceManagerSet: true, exitedAt: now, expectedManagerSetGeneration: 1,
        expectedMembershipRevision: 999n, memberId: 'member-manager', status: 'left',
      })));
      assert.deepEqual(await store.withProjectScope(projectId, async scope => ({
        manager: await scope.findMembership('member-manager'),
        target: await scope.findMembership('member-target'),
        generation: (await scope.getProject())?.managerSetGeneration,
      })), before);
      await assert.rejects(store.withProjectScope(projectId, scope => scope.membership.applyMemberExit({
        advanceManagerSet: true, exitedAt: now, expectedManagerSetGeneration: 1,
        expectedMembershipRevision: 1n, memberId: 'member-manager', status: 'left',
        successor: { memberId: 'member-target', membershipRevision: 1, offerId: 'missing-offer', offerRevision: 1 },
      })));
      assert.deepEqual(await store.withProjectScope(projectId, async scope => ({
        manager: await scope.findMembership('member-manager'),
        target: await scope.findMembership('member-target'),
        generation: (await scope.getProject())?.managerSetGeneration,
      })), before);
      const held = await store.acquireProjectLease(projectId);
      let sameProjectCompleted = false;
      const concurrentExit = store.withProjectScope(projectId, async scope => {
        await scope.membership.applyMemberExit({
          advanceManagerSet: false, exitedAt: now, expectedManagerSetGeneration: 1,
          expectedMembershipRevision: 1n, memberId: 'member-target', status: 'revoked',
        });
        sameProjectCompleted = true;
      });
      try {
        assert.equal((await store.withProjectScope('project-exit-cas-b', scope => scope.findMembership('member-target')))?.status, 'active');
        assert.equal(sameProjectCompleted, false);
        assert.equal((await held.withProjectScope(scope => scope.findMembership('member-target')))?.status, 'active');
      } finally { await held.close(); }
      await concurrentExit;
      assert.equal((await store.withProjectScope(projectId, scope => scope.findMembership('member-target')))?.status, 'revoked');
      assert.equal((await store.withProjectScope('project-exit-cas-b', scope => scope.findMembership('member-target')))?.status, 'active');
    } finally { await store.close(); }
  });
});
