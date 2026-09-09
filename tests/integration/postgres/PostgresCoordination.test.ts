import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import { CoordinationError } from '../../../src/coordination/CoordinationError.js';
import {
  type PinnedProjectLease,
  PostgresCoordination,
} from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { createRepositoryPlacementLease } from '../../../src/repositories/RepositoryPlacement.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}

async function expectCoordinationError(
  operation: Promise<unknown>,
  code: CoordinationError['code'],
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof CoordinationError);
    assert.equal(error.code, code);
    assert.deepEqual(error.toJSON(), {
      code,
      message: `coordination.error.${code}`,
      name: 'CoordinationError',
      retryable: code === 'busy' || code === 'lease-busy',
    });
    assert.doesNotMatch(JSON.stringify(error), /postgresql:|SELECT |private/i);
    return true;
  });
}

async function seedProject(
  database: PostgresTestDatabase,
  input: {
    readonly projectId: string;
    readonly repositoryStorageKey: string;
    readonly role: 'manager' | 'member';
  },
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [input.projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id,
         project_name,
         manager_set_generation,
         expected_main_oid,
         service_state,
         created_at,
         activated_at
       ) VALUES (
         $1, 'Overlapping Project', 1, repeat('a', 40), 'active',
         clock_timestamp(), clock_timestamp()
       )`,
      [input.projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, display_name, role, status, revision,
         created_at, updated_at
       ) VALUES (
         $1, 'overlapping-member', 'Overlapping member', $2, 'active', 1,
         clock_timestamp(), clock_timestamp()
       )`,
      [input.projectId, input.role],
    );
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES (
         $1, 'node-a', $2, 1, true, clock_timestamp(), clock_timestamp()
       )`,
      [input.projectId, input.repositoryStorageKey],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, 'node-a', $2, 1)`,
      [input.projectId, input.repositoryStorageKey],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function verifyUnscopedRuntime(database: PostgresTestDatabase): Promise<void> {
  const client = new Client({ connectionString: database.runtimeUrl });
  try {
    await client.connect();
    const result = await client.query(
      'SELECT project_id FROM claudian_cloud.projects',
    );
    assert.deepEqual(result.rows, []);
  } finally {
    await client.end();
  }
}

async function terminatePinnedRuntimeConnection(
  database: PostgresTestDatabase,
): Promise<void> {
  const client = new Client({ connectionString: database.adminUrl });
  try {
    await client.connect();
    const result = await client.query<{ readonly terminated: boolean }>(
      `SELECT pg_terminate_backend(a.pid) AS terminated
         FROM pg_stat_activity a
        WHERE a.usename = 'claudian_cloud_runtime'
          AND EXISTS (
            SELECT 1
              FROM pg_locks l
             WHERE l.pid = a.pid
               AND l.locktype = 'advisory'
               AND l.granted
          )`,
    );
    assert.deepEqual(result.rows, [{ terminated: true }]);
  } finally {
    await client.end();
  }
}

async function terminateOrdinaryCheckedOutConnection(
  database: PostgresTestDatabase,
): Promise<void> {
  const client = new Client({ connectionString: database.adminUrl });
  try {
    await client.connect();
    const result = await client.query<{ readonly terminated: boolean }>(
      `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = 'claudian-cloud-ordinary'
          AND state = 'idle in transaction'`,
    );
    assert.deepEqual(result.rows, [{ terminated: true }]);
  } finally {
    await client.end();
  }
}

async function terminateIdlePoolConnections(
  database: PostgresTestDatabase,
): Promise<void> {
  const client = new Client({ connectionString: database.adminUrl });
  try {
    await client.connect();
    const result = await client.query<{
      readonly application_name: string;
      readonly terminated: boolean;
    }>(
      `SELECT application_name,
              pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name IN (
            'claudian-cloud-ordinary',
            'claudian-cloud-pinned',
            'claudian-cloud-reserved'
          )
          AND state = 'idle'
        ORDER BY application_name`,
    );
    assert.deepEqual(result.rows, [
      { application_name: 'claudian-cloud-ordinary', terminated: true },
      { application_name: 'claudian-cloud-pinned', terminated: true },
      { application_name: 'claudian-cloud-reserved', terminated: true },
    ]);
  } finally {
    await client.end();
  }
}

async function waitForBlockedPoolConnections(client: Client): Promise<void> {
  const expected = [
    'claudian-cloud-ordinary',
    'claudian-cloud-pinned',
    'claudian-cloud-reserved',
  ];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query<{ readonly application_name: string }>(
      `SELECT application_name
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = ANY($1::text[])
          AND wait_event_type = 'Lock'
        ORDER BY application_name`,
      [expected],
    );
    if (
      result.rows.map(row => row.application_name).join(',')
      === expected.join(',')
    ) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('postgres-test-pool-queries-not-blocked');
}

async function waitForPinnedTableLock(database: PostgresTestDatabase): Promise<void> {
  const client = new Client({ connectionString: database.adminUrl });
  try {
    await client.connect();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await client.query('SELECT pg_stat_clear_snapshot()');
      const result = await client.query<{ readonly blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND application_name = 'claudian-cloud-pinned'
              AND wait_event_type = 'Lock'
         ) AS blocked`,
      );
      if (result.rows[0]?.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('postgres-test-pinned-query-not-blocked');
  } finally {
    await client.end();
  }
}

async function cloudConnectionCount(adminUrl: string): Promise<number> {
  const client = new Client({ connectionString: adminUrl });
  try {
    await client.connect();
    const result = await client.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name LIKE 'claudian-cloud-%'`,
    );
    return Number(result.rows[0]?.count);
  } finally {
    await client.end();
  }
}

async function waitForNoCloudConnections(adminUrl: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await cloudConnectionCount(adminUrl) === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('postgres-test-cloud-connection-survived');
}

async function replaceSchemaChecksum(
  database: PostgresTestDatabase,
  checksum: string,
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query(
      `UPDATE claudian_cloud.schema_metadata
          SET checksum = $1
        WHERE singleton`,
      [checksum],
    );
  } finally {
    await client.end();
  }
}

describe('PostgresCoordination', () => {
  it('hands Project admission to a cross-process upload fence without a gap', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({
        connectionString: database.migrationUrl,
      }).apply();
      const first = new PostgresCoordination({
        ordinaryPoolMax: 1,
        pinnedPoolMax: 1,
        projectLockTimeoutMs: 1_000,
        reservedPoolMax: 1,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 2_000,
      });
      const second = new PostgresCoordination({
        ordinaryPoolMax: 1,
        pinnedPoolMax: 1,
        projectLockTimeoutMs: 1_000,
        reservedPoolMax: 1,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 2_000,
      });
      try {
        const admission = await first.acquireProjectLease('project-upload');
        const upload = await admission.handoffToDevelopmentBootstrapUpload(
          'attempt-upload',
        );
        await admission.close();

        const settlement = await second.acquireProjectLease('project-upload');
        const draining = settlement.drainDevelopmentBootstrapUploads(
          'attempt-upload',
        );
        const settledEarly = await Promise.race([
          draining.then(() => true),
          new Promise<false>(resolve => setTimeout(() => resolve(false), 25)),
        ]);
        assert.equal(settledEarly, false);

        await upload.close();
        await draining;
        await settlement.close();
      } finally {
        await Promise.all([
          first.close().catch(() => undefined),
          second.close().catch(() => undefined),
        ]);
      }
    });
  });

  it('cancels a blocked pinned Project transaction and releases its lock', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({
        connectionString: database.migrationUrl,
      }).apply();
      const coordination = new PostgresCoordination({
        ordinaryPoolMax: 1,
        pinnedPoolMax: 1,
        projectLockTimeoutMs: 1_000,
        reservedPoolMax: 1,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 2_000,
      });
      const blocker = new Client({ connectionString: database.migrationUrl });
      try {
        await blocker.connect();
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE claudian_cloud.project_tombstones IN ACCESS EXCLUSIVE MODE',
        );
        const lease = await coordination.acquireProjectLease('project-cancelled-pinned');
        const controller = new AbortController();
        const blocked = lease.withProjectScope(
          scope => scope.portability.getProjectTombstone(),
          { signal: controller.signal },
        );
        await waitForPinnedTableLock(database);

        controller.abort();
        await expectCoordinationError(blocked, 'cancelled');
        await expectCoordinationError(lease.close(), 'dependency-failed');
        await blocker.query('ROLLBACK');

        const recovered = await coordination.acquireProjectLease(
          'project-cancelled-pinned',
        );
        await recovered.close();
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end().catch(() => undefined);
        await coordination.close().catch(() => undefined);
      }
    });
  });

  it('cancels a blocked pinned lifecycle read and releases its lock', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({
        connectionString: database.migrationUrl,
      }).apply();
      const coordination = new PostgresCoordination({
        ordinaryPoolMax: 1,
        pinnedPoolMax: 1,
        projectLockTimeoutMs: 1_000,
        reservedPoolMax: 1,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 2_000,
      });
      const blocker = new Client({ connectionString: database.migrationUrl });
      try {
        await blocker.connect();
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE claudian_cloud.project_lifecycle_journals IN ACCESS EXCLUSIVE MODE',
        );
        const lease = await coordination.acquireProjectLease('project-cancelled-lifecycle');
        const controller = new AbortController();
        const blocked = lease.withProjectScope(
          scope => scope.portability.getLifecycleJournal('transfer-cancelled-lifecycle'),
          { signal: controller.signal },
        );
        await waitForPinnedTableLock(database);

        controller.abort();
        await expectCoordinationError(blocked, 'cancelled');
        await expectCoordinationError(lease.close(), 'dependency-failed');
        await blocker.query('ROLLBACK');

        const recovered = await coordination.acquireProjectLease(
          'project-cancelled-lifecycle',
        );
        await recovered.close();
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end().catch(() => undefined);
        await coordination.close().catch(() => undefined);
      }
    });
  });

  it('owns Project scope, lock contention, pool isolation, and placement reads', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({
        connectionString: database.migrationUrl,
      }).apply();
      await seedProject(database, {
        projectId: 'project-a',
        repositoryStorageKey: 'storage_a',
        role: 'manager',
      });
      await seedProject(database, {
        projectId: 'project-b',
        repositoryStorageKey: 'storage_b',
        role: 'member',
      });
      await verifyUnscopedRuntime(database);

      const coordination = new PostgresCoordination({
        ordinaryPoolMax: 1,
        pinnedPoolMax: 1,
        projectLockTimeoutMs: 75,
        reservedPoolMax: 1,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 1_000,
      });
      try {
        await coordination.verifySchemaCompatibility();

        const firstPlacementPage = await coordination
          .listActiveRepositoryPlacements({ limit: 1 });
        assert.deepEqual(firstPlacementPage.placements.map(item => item.projectId), [
          'project-a',
        ]);
        assert.equal(firstPlacementPage.nextCursor, 'project-a');
        const secondPlacementPage = await coordination
          .listActiveRepositoryPlacements({
            after: firstPlacementPage.nextCursor,
            limit: 1,
          });
        assert.deepEqual(secondPlacementPage.placements.map(item => item.projectId), [
          'project-b',
        ]);
        assert.equal(secondPlacementPage.nextCursor, undefined);

        const projectA = await coordination.withProjectScope(
          'project-a',
          async scope => ({
            membership: await scope.findMembership('overlapping-member'),
            placement: await scope.getRepositoryPlacement(),
          }),
        );
        assert.deepEqual(projectA.membership, {
          displayName: 'Overlapping member',
          memberId: 'overlapping-member',
          revision: 1n,
          role: 'manager',
          status: 'active',
        });
        assert.deepEqual(projectA.placement, {
          active: true,
          generation: 1,
          projectId: 'project-a',
          repositoryStorageKey: 'storage_a',
          storageNodeId: 'node-a',
        });

        const projectB = await coordination.withProjectScope(
          'project-b',
          scope => scope.findMembership('overlapping-member'),
        );
        assert.equal(projectB?.role, 'member');

        assert.equal(await coordination.isCurrent(projectA.placement), true);
        assert.equal(
          await coordination.isCurrent(createRepositoryPlacementLease({
            ...projectA.placement,
            generation: 2,
          })),
          false,
        );

        const pinnedA = await coordination.acquireProjectLease('project-a');
        assert.equal(await coordination.isCurrent(projectA.placement), true);
        await expectCoordinationError(
          coordination.withProjectScope('project-a', async () => Promise.resolve()),
          'busy',
        );
        const unrelated = await coordination.withProjectScope(
          'project-b',
          scope => scope.getRepositoryPlacement(),
        );
        assert.equal(unrelated?.projectId, 'project-b');

        const secondOwner = new PostgresCoordination({
          ordinaryPoolMax: 1,
          pinnedPoolMax: 1,
          projectLockTimeoutMs: 75,
          reservedPoolMax: 1,
          runtimeConnectionString: database.runtimeUrl,
          shutdownTimeoutMs: 1_000,
        });
        try {
          await expectCoordinationError(
            secondOwner.withProjectScope(
              'project-a',
              async () => Promise.resolve(),
            ),
            'busy',
          );
          const secondOwnerProgress = await secondOwner.withProjectScope(
            'project-b',
            scope => scope.getRepositoryPlacement(),
          );
          assert.equal(secondOwnerProgress?.projectId, 'project-b');
        } finally {
          await secondOwner.close();
        }

        const waitingCancellation = new AbortController();
        const cancelledLease = coordination.acquireProjectLease('project-a', {
          signal: waitingCancellation.signal,
        });
        waitingCancellation.abort();
        await expectCoordinationError(cancelledLease, 'cancelled');
        const pinnedClose = pinnedA.close();
        assert.equal(pinnedA.close(), pinnedClose);
        await pinnedClose;

        const transactionEntered = deferred();
        const releaseTransaction = deferred();
        const heldTransaction = coordination.withProjectScope(
          'project-a',
          async () => {
            transactionEntered.resolve();
            await releaseTransaction.promise;
          },
        );
        await transactionEntered.promise;

        await expectCoordinationError(
          coordination.acquireProjectLease('project-a'),
          'busy',
        );
        const independentPinned = await coordination.acquireProjectLease('project-b');
        await coordination.verifySchemaCompatibility();
        await independentPinned.close();
        releaseTransaction.resolve();
        await heldTransaction;

        const cancelledBefore = new AbortController();
        cancelledBefore.abort();
        await expectCoordinationError(
          coordination.acquireProjectLease('project-a', {
            signal: cancelledBefore.signal,
          }),
          'cancelled',
        );

        const lostLease = await coordination.acquireProjectLease('project-a');
        await terminatePinnedRuntimeConnection(database);
        await expectCoordinationError(
          lostLease.withProjectScope(scope => scope.getRepositoryPlacement()),
          'dependency-failed',
        );
        const lostClose = lostLease.close();
        assert.equal(lostLease.close(), lostClose);
        await expectCoordinationError(lostClose, 'dependency-failed');

        const recoveredLease = await coordination.acquireProjectLease('project-a');
        const recoveredPlacement = await recoveredLease.withProjectScope(
          scope => scope.getRepositoryPlacement(),
        );
        assert.equal(recoveredPlacement?.generation, 1);
        await recoveredLease.close();

        await replaceSchemaChecksum(database, '0'.repeat(64));
        await expectCoordinationError(
          coordination.verifySchemaCompatibility(),
          'schema-incompatible',
        );
        await replaceSchemaChecksum(
          database,
          'fb19a46a46b4d6ae644cb05d6b2df9d2c21afe0353cb4fc107231d469ee65c94',
        );
        await coordination.verifySchemaCompatibility();

        const wrongRole = new PostgresCoordination({
          ordinaryPoolMax: 1,
          pinnedPoolMax: 1,
          projectLockTimeoutMs: 75,
          reservedPoolMax: 1,
          runtimeConnectionString: database.adminUrl,
          shutdownTimeoutMs: 1_000,
        });
        try {
          await expectCoordinationError(
            wrongRole.verifySchemaCompatibility(),
            'schema-incompatible',
          );
        } finally {
          await wrongRole.close();
        }

        const close = coordination.close();
        assert.equal(coordination.close(), close);
        await close;
        await expectCoordinationError(
          coordination.withProjectScope('project-a', async () => Promise.resolve()),
          'closed',
        );
      } finally {
        await coordination.close().catch(() => undefined);
      }
    });
  });

  it('recovers every pool after an idle client connection fails', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({
        connectionString: database.migrationUrl,
      }).apply();
      await seedProject(database, {
        projectId: 'project-a',
        repositoryStorageKey: 'storage_a',
        role: 'manager',
      });
      const coordination = new PostgresCoordination({
        ordinaryPoolMax: 1,
        pinnedPoolMax: 1,
        projectLockTimeoutMs: 1_000,
        reservedPoolMax: 1,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 2_000,
      });
      try {
        await coordination.verifySchemaCompatibility();
        await coordination.withProjectScope(
          'project-a',
          scope => scope.getRepositoryPlacement(),
        );
        const firstLease = await coordination.acquireProjectLease('project-a');
        await firstLease.close();

        await terminateIdlePoolConnections(database);
        await waitForNoCloudConnections(database.adminUrl);
        await new Promise(resolve => setTimeout(resolve, 50));

        await coordination.verifySchemaCompatibility();
        const placement = await coordination.withProjectScope(
          'project-a',
          scope => scope.getRepositoryPlacement(),
        );
        assert.equal(placement?.projectId, 'project-a');
        const recoveredLease = await coordination.acquireProjectLease('project-a');
        await recoveredLease.close();
      } finally {
        await coordination.close();
      }
    });
  });

  it('contains connection loss for an ordinary checked-out client', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({
        connectionString: database.migrationUrl,
      }).apply();
      await seedProject(database, {
        projectId: 'project-a',
        repositoryStorageKey: 'storage_a',
        role: 'manager',
      });
      const coordination = new PostgresCoordination({
        ordinaryPoolMax: 1,
        pinnedPoolMax: 1,
        projectLockTimeoutMs: 1_000,
        reservedPoolMax: 1,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 2_000,
      });
      const callbackEntered = deferred();
      const releaseCallback = deferred();
      let uncaughtClientErrors = 0;
      const onUncaughtException = (): void => {
        uncaughtClientErrors += 1;
      };
      process.on('uncaughtException', onUncaughtException);
      try {
        const operation = coordination.withProjectScope(
          'project-a',
          async scope => {
            await scope.getRepositoryPlacement();
            callbackEntered.resolve();
            await releaseCallback.promise;
            return scope.getRepositoryPlacement();
          },
        );
        await callbackEntered.promise;
        await terminateOrdinaryCheckedOutConnection(database);
        await new Promise(resolve => setTimeout(resolve, 50));
        releaseCallback.resolve();

        await expectCoordinationError(operation, 'dependency-failed');
        await coordination.close();
        await waitForNoCloudConnections(database.adminUrl);
        assert.equal(uncaughtClientErrors, 0);
      } finally {
        process.removeListener('uncaughtException', onUncaughtException);
        releaseCallback.resolve();
        await coordination.close().catch(() => undefined);
      }
    });
  });

  it('revokes active clients from every pool during bounded close', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({
        connectionString: database.migrationUrl,
      }).apply();
      await seedProject(database, {
        projectId: 'project-a',
        repositoryStorageKey: 'storage_a',
        role: 'manager',
      });
      await seedProject(database, {
        projectId: 'project-b',
        repositoryStorageKey: 'storage_b',
        role: 'member',
      });
      const coordination = new PostgresCoordination({
        ordinaryPoolMax: 1,
        pinnedPoolMax: 1,
        projectLockTimeoutMs: 5_000,
        reservedPoolMax: 1,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 500,
      });
      const blocker = new Client({ connectionString: database.adminUrl });
      let pinnedLease: PinnedProjectLease | undefined;
      try {
        pinnedLease = await coordination.acquireProjectLease('project-a');
        await blocker.connect();
        await blocker.query('BEGIN');
        await blocker.query(
          `LOCK TABLE claudian_cloud.repository_placements,
                      claudian_cloud.schema_metadata
             IN ACCESS EXCLUSIVE MODE`,
        );

        const ordinary = coordination.withProjectScope(
          'project-b',
          scope => scope.getRepositoryPlacement(),
        );
        const pinned = pinnedLease.withProjectScope(
          scope => scope.getRepositoryPlacement(),
        );
        const reserved = coordination.verifySchemaCompatibility();
        const failures = [
          expectCoordinationError(ordinary, 'dependency-failed'),
          expectCoordinationError(pinned, 'dependency-failed'),
          expectCoordinationError(reserved, 'dependency-failed'),
        ];
        await waitForBlockedPoolConnections(blocker);

        const startedAt = Date.now();
        await coordination.close();
        await Promise.all(failures);
        await waitForNoCloudConnections(database.adminUrl);

        assert.equal(Date.now() - startedAt < 1_000, true);
        await expectCoordinationError(
          pinnedLease.close(),
          'dependency-failed',
        );
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end().catch(() => undefined);
        await pinnedLease?.close().catch(() => undefined);
        await coordination.close().catch(() => undefined);
      }
    });
  });

  it('fails schema and dependency checks without raw connection context', async () => {
    const credential = 'coordination-private-sentinel';
    const coordination = new PostgresCoordination({
      ordinaryPoolMax: 1,
      pinnedPoolMax: 1,
      projectLockTimeoutMs: 25,
      reservedPoolMax: 1,
      runtimeConnectionString: `postgresql://runtime:${credential}@127.0.0.1:1/cloud`,
      shutdownTimeoutMs: 1_000,
    });
    try {
      await expectCoordinationError(
        coordination.verifySchemaCompatibility(),
        'dependency-failed',
      );
    } finally {
      await coordination.close().catch(() => undefined);
    }
  });
});
