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
    projectLockTimeoutMs: 1_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

async function seedProject(
  database: PostgresTestDatabase,
  projectId: string,
): Promise<void> {
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
       ) VALUES ($1, 'Collaboration Project', 1, $2, 'active', $3, $3)`,
      [projectId, 'a'.repeat(40), CREATED],
    );
    for (const memberId of ['member-a', 'member-b']) {
      await client.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, display_name, role, status, revision,
           created_at, updated_at
         ) VALUES ($1, $2, $2, 'member', 'active', 1, $3, $3)`,
        [projectId, memberId, CREATED],
      );
    }
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

describe('Collaboration persistence', () => {
  it('applies migration 0004 with forced Project RLS and composite locality', async () => {
    await withPostgresTestDatabase(async database => {
      const migrator = new PostgresMigrator({
        connectionString: database.migrationUrl,
      });
      await migrator.apply();
      await migrator.apply();

      const client = new Client({ connectionString: database.migrationUrl });
      try {
        await client.connect();
        const history = await client.query<{
          readonly name: string;
          readonly state: string;
          readonly version: number;
        }>(
          `SELECT version, name, state
             FROM claudian_cloud.schema_migrations
            ORDER BY version`,
        );
        assert.deepEqual(history.rows, [
          { name: 'foundation', state: 'applied', version: 1 },
          { name: 'development-bootstrap', state: 'applied', version: 2 },
          { name: 'project-read-events', state: 'applied', version: 3 },
          { name: 'collaboration', state: 'applied', version: 4 },
          { name: 'accept-recovery', state: 'applied', version: 5 },
          { name: 'portability-lifecycle', state: 'applied', version: 6 },
          { name: 'lan-to-cloud-transfer', state: 'applied', version: 7 },
          { name: 'cloud-to-lan-transfer', state: 'applied', version: 8 },
          { name: 'terminal-project-lifecycle', state: 'applied', version: 9 },
          { name: 'terminal-continuity-catalog', state: 'applied', version: 10 },
          { name: 'cloud-project-membership', state: 'applied', version: 11 },
        ]);

        const relations = [
          'change_requests',
          'idempotency_results',
          'request_comments',
          'request_ticket_relations',
          'ticket_comments',
          'ticket_mentions',
          'tickets',
        ];
        const rls = await client.query<{
          readonly forced: boolean;
          readonly relation: string;
          readonly rowSecurity: boolean;
        }>(
          `SELECT c.relname AS relation,
                  c.relrowsecurity AS "rowSecurity",
                  c.relforcerowsecurity AS forced
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'claudian_cloud'
              AND c.relname = ANY($1::text[])
            ORDER BY c.relname`,
          [relations],
        );
        assert.deepEqual(
          rls.rows,
          relations.map(relation => ({ forced: true, relation, rowSecurity: true })),
        );

        const foreignKeys = await client.query<{
          readonly definition: string;
          readonly relation: string;
        }>(
          `SELECT c.relname AS relation,
                  pg_get_constraintdef(k.oid) AS definition
             FROM pg_constraint k
             JOIN pg_class c ON c.oid = k.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'claudian_cloud'
              AND c.relname = ANY($1::text[])
              AND k.contype = 'f'`,
          [relations],
        );
        assert.equal(
          foreignKeys.rows.every(row => (
            row.definition.includes('(project_id')
            && row.definition.includes('REFERENCES claudian_cloud.')
          )),
          true,
        );

        const indexes = await client.query<{ readonly definition: string }>(
          `SELECT indexdef AS definition
             FROM pg_indexes
            WHERE schemaname = 'claudian_cloud'
              AND tablename = ANY($1::text[])`,
          [relations],
        );
        assert.equal(
          indexes.rows.every(row => row.definition.includes('(project_id')),
          true,
        );

        const privileges = await client.query<{
          readonly canDelete: boolean;
          readonly canInsert: boolean;
          readonly canSelect: boolean;
          readonly canUpdate: boolean;
        }>(
          `SELECT
             has_table_privilege(
               'claudian_cloud_runtime',
               'claudian_cloud.idempotency_results',
               'DELETE'
             ) AS "canDelete",
             has_table_privilege(
               'claudian_cloud_runtime',
               'claudian_cloud.idempotency_results',
               'INSERT'
             ) AS "canInsert",
             has_table_privilege(
               'claudian_cloud_runtime',
               'claudian_cloud.idempotency_results',
               'SELECT'
             ) AS "canSelect",
             has_table_privilege(
               'claudian_cloud_runtime',
               'claudian_cloud.idempotency_results',
               'UPDATE'
             ) AS "canUpdate"`,
        );
        assert.deepEqual(privileges.rows, [{
          canDelete: false,
          canInsert: true,
          canSelect: true,
          canUpdate: false,
        }]);
      } finally {
        await client.end();
      }
    });
  });

  it('stores and reads a Request only through its Project transaction', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-a');
      await seedProject(database, 'project-b');
      const store = coordination(database);
      try {
        const created = await store.withProjectScope('project-a', scope => (
          scope.collaboration.requests.create({
            createdAt: CREATED,
            description: 'First request',
            firstBaseOid: 'a'.repeat(40),
            latestHeadOid: 'b'.repeat(40),
            memberId: 'member-a',
            requestId: 'request-a',
          })
        ));
        assert.deepEqual(created, {
          commentCount: 0,
          createdAt: CREATED,
          description: 'First request',
          firstBaseOid: 'a'.repeat(40),
          id: 'request-a',
          latestHeadOid: 'b'.repeat(40),
          memberId: 'member-a',
          revision: 1,
          status: 'open',
          ticketRelations: [],
          updatedAt: CREATED,
        });
        assert.deepEqual(
          await store.withProjectReadScope('project-a', scope => (
            scope.collaboration.requests.find('request-a')
          )),
          created,
        );
        assert.equal(
          await store.withProjectReadScope('project-b', scope => (
            scope.collaboration.requests.find('request-a')
          )),
          undefined,
        );
      } finally {
        await store.close();
      }
    });
  });

  it('preserves the protocol UTF-16 title limit independently of UTF-8 bytes', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-a');
      await seedProject(database, 'project-b');
      const store = coordination(database);
      try {
        const title = '😀'.repeat(100);
        const ticket = await store.withProjectScope('project-a', scope => (
          scope.collaboration.tickets.create({
            authorMemberId: 'member-a',
            body: 'Unicode title fixture',
            createdAt: CREATED,
            ticketId: 'ticket-unicode',
            title,
          })
        ));
        assert.equal(ticket.title, title);
        assert.deepEqual(
          await store.withProjectReadScope('project-a', scope => (
            scope.collaboration.tickets.findDetailBase('ticket-unicode')
          )),
          { body: 'Unicode title fixture', ticket },
        );
        assert.equal(
          await store.withProjectReadScope('project-b', scope => (
            scope.collaboration.tickets.findDetailBase('ticket-unicode')
          )),
          undefined,
        );
      } finally {
        await store.close();
      }
    });
  });
});
