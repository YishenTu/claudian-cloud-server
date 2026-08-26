import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const CREATED = '2026-08-23T00:00:00.000Z';

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 4,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

async function seedProject(database: PostgresTestDatabase, projectId: string): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation,
         expected_main_oid, service_state, created_at, activated_at
       ) VALUES ($1, 'Idempotency Project', 1, $2, 'active', $3, $3)`,
      [projectId, 'a'.repeat(40), CREATED],
    );
    await client.query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, display_name, role, status, revision,
         created_at, updated_at
       ) VALUES ($1, 'member-a', 'Member A', 'member', 'active', 1, $2, $2)`,
      [projectId, CREATED],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

describe('Collaboration idempotency persistence', () => {
  it('returns exact replay and reports a changed normalized fingerprint', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-a');
      const store = coordination(database);
      const identity = {
        idempotencyKey: 'idempotency-a',
        memberId: 'member-a',
        operation: 'createTicket' as const,
        requestFingerprint: '1'.repeat(64),
      };
      try {
        assert.deepEqual(
          await store.withProjectReadScope('project-a', scope => (
            scope.collaboration.idempotency.find(identity)
          )),
          { kind: 'missing' },
        );
        assert.deepEqual(
          await store.withProjectScope('project-a', scope => (
            scope.collaboration.idempotency.store({
              ...identity,
              createdAt: CREATED,
              response: { ticketId: 'ticket-a' },
            })
          )),
          { kind: 'stored', response: { ticketId: 'ticket-a' } },
        );
        assert.deepEqual(
          await store.withProjectReadScope('project-a', scope => (
            scope.collaboration.idempotency.find(identity)
          )),
          { kind: 'replay', response: { ticketId: 'ticket-a' } },
        );
        assert.deepEqual(
          await store.withProjectReadScope('project-a', scope => (
            scope.collaboration.idempotency.find({
              ...identity,
              requestFingerprint: '2'.repeat(64),
            })
          )),
          { kind: 'conflict' },
        );
      } finally {
        await store.close();
      }
    });
  });

  it('serializes concurrent same-key stores into one durable result', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-a');
      const store = coordination(database);
      const input = {
        createdAt: CREATED,
        idempotencyKey: 'idempotency-concurrent',
        memberId: 'member-a',
        operation: 'createComment' as const,
        requestFingerprint: '3'.repeat(64),
        response: { commentId: 'comment-a' },
      };
      try {
        const results = await Promise.all([
          store.withProjectScope('project-a', scope => (
            scope.collaboration.idempotency.store(input)
          )),
          store.withProjectScope('project-a', scope => (
            scope.collaboration.idempotency.store(input)
          )),
        ]);
        assert.deepEqual(
          results.map(result => result.kind).sort(),
          ['replay', 'stored'],
        );
        for (const result of results) {
          assert.notEqual(result.kind, 'conflict');
          if (result.kind !== 'conflict') {
            assert.deepEqual(result.response, input.response);
          }
        }
      } finally {
        await store.close();
      }
    });
  });

  it('retains results for the Project lifetime after membership state changes', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-a');
      const store = coordination(database);
      const identity = {
        idempotencyKey: 'idempotency-lifetime',
        memberId: 'member-a',
        operation: 'updateTicketContent' as const,
        requestFingerprint: '4'.repeat(64),
      };
      try {
        await store.withProjectScope('project-a', scope => (
          scope.collaboration.idempotency.store({
            ...identity,
            createdAt: CREATED,
            response: { revision: 2 },
          })
        ));

        const client = new Client({ connectionString: database.migrationUrl });
        try {
          await client.connect();
          await client.query('BEGIN');
          await client.query(
            "SELECT set_config('claudian_cloud.project_id', 'project-a', true)",
          );
          await client.query(
            `UPDATE claudian_cloud.project_memberships
                SET status = 'left', revision = 2,
                    left_at = $1::timestamptz
              WHERE project_id = 'project-a' AND member_id = 'member-a'`,
            [CREATED],
          );
          await client.query('COMMIT');
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          await client.end();
        }

        assert.deepEqual(
          await store.withProjectReadScope('project-a', scope => (
            scope.collaboration.idempotency.find(identity)
          )),
          { kind: 'replay', response: { revision: 2 } },
        );
      } finally {
        await store.close();
      }
    });
  });

  it('rolls back collaboration state, idempotency, and event append together', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-a');
      const store = coordination(database);
      const identity = {
        idempotencyKey: 'idempotency-rollback',
        memberId: 'member-a',
        operation: 'ensureMyRequest' as const,
        requestFingerprint: '5'.repeat(64),
      };
      try {
        await assert.rejects(
          store.withProjectScope('project-a', async scope => {
            await scope.collaboration.requests.create({
              createdAt: CREATED,
              description: 'Rollback request',
              firstBaseOid: 'a'.repeat(40),
              latestHeadOid: 'b'.repeat(40),
              memberId: 'member-a',
              requestId: 'request-rollback',
            });
            await scope.collaboration.idempotency.store({
              ...identity,
              createdAt: CREATED,
              response: { requestId: 'request-rollback' },
            });
            await scope.appendProjectEvent({
              kind: 'request.updated',
              occurredAt: CREATED,
              payload: { requestId: 'request-rollback' },
            });
            throw new Error('rollback-fixture');
          }),
          /rollback-fixture/u,
        );
        await store.withProjectReadScope('project-a', async scope => {
          assert.equal(
            await scope.collaboration.requests.find('request-rollback'),
            undefined,
          );
          assert.deepEqual(
            await scope.collaboration.idempotency.find(identity),
            { kind: 'missing' },
          );
          assert.equal(await scope.getProjectEventSequence(), 0);
        });
      } finally {
        await store.close();
      }
    });
  });
});
