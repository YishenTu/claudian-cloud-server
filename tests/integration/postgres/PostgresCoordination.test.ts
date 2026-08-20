import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import { CoordinationError } from '../../../src/coordination/CoordinationError.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
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
      `INSERT INTO claudian_cloud.projects (project_id, created_at)
       VALUES ($1, clock_timestamp())`,
      [input.projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, role, status, revision, created_at, updated_at
       ) VALUES (
         $1, 'overlapping-member', $2, 'active', 1,
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

async function replaceMigrationChecksum(
  database: PostgresTestDatabase,
  checksum: string,
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query(
      `UPDATE claudian_cloud.schema_migrations
          SET checksum = $1
        WHERE version = 1`,
      [checksum],
    );
  } finally {
    await client.end();
  }
}

describe('PostgresCoordination', () => {
  it('owns Project scope, lock contention, pool isolation, and placement reads', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
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
      });
      try {
        await coordination.verifySchemaCompatibility();

        const projectA = await coordination.withProjectScope(
          'project-a',
          async scope => ({
            membership: await scope.findMembership('overlapping-member'),
            placement: await scope.getRepositoryPlacement(),
          }),
        );
        assert.deepEqual(projectA.membership, {
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

        await replaceMigrationChecksum(database, '0'.repeat(64));
        await expectCoordinationError(
          coordination.verifySchemaCompatibility(),
          'schema-incompatible',
        );
        await replaceMigrationChecksum(
          database,
          '9938e8206d911ef7d410e63bbd3bba3f4b699ed4bd9c9f1b7f13ae1d9252fdbe',
        );
        await coordination.verifySchemaCompatibility();

        const wrongRole = new PostgresCoordination({
          ordinaryPoolMax: 1,
          pinnedPoolMax: 1,
          projectLockTimeoutMs: 75,
          reservedPoolMax: 1,
          runtimeConnectionString: database.adminUrl,
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

  it('fails schema and dependency checks without raw connection context', async () => {
    const credential = 'coordination-private-sentinel';
    const coordination = new PostgresCoordination({
      ordinaryPoolMax: 1,
      pinnedPoolMax: 1,
      projectLockTimeoutMs: 25,
      reservedPoolMax: 1,
      runtimeConnectionString: `postgresql://runtime:${credential}@127.0.0.1:1/cloud`,
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
