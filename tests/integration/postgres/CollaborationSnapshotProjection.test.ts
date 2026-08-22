import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COLLAB_CLOUD_BINDING_LIMITS } from '@claudian/collab-protocol';
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

async function seedProject(
  database: PostgresTestDatabase,
  projectId: string,
  memberCount: number,
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
       ) VALUES ($1, 'Snapshot Project', 1, $2, 'active', $3, $3)`,
      [projectId, 'a'.repeat(40), CREATED],
    );
    for (let index = 0; index < memberCount; index += 1) {
      const memberId = `member-${String(index).padStart(3, '0')}`;
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

describe('Collaboration snapshot projection', () => {
  it('sorts nonempty Requests and exposes the newest five open Ticket summaries', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-a', 2);
      await seedProject(database, 'project-b', 2);
      const store = coordination(database);
      try {
        await store.withProjectScope('project-a', async scope => {
          await scope.collaboration.requests.create({
            createdAt: CREATED,
            description: 'Second by identifier',
            firstBaseOid: 'a'.repeat(40),
            latestHeadOid: 'b'.repeat(40),
            memberId: 'member-000',
            requestId: 'request-b',
          });
          await scope.collaboration.requests.create({
            createdAt: CREATED,
            description: 'First by identifier',
            firstBaseOid: 'a'.repeat(40),
            latestHeadOid: 'c'.repeat(40),
            memberId: 'member-001',
            requestId: 'request-a',
          });
          for (let index = 0; index < 6; index += 1) {
            const label = String(index);
            await scope.collaboration.tickets.create({
              authorMemberId: 'member-000',
              body: `Ticket body ${label}`,
              createdAt: `2026-08-23T0${label}:00:00.000Z`,
              ticketId: `ticket-${label}`,
              title: `Ticket ${label}`,
            });
          }
        });
        await store.withProjectScope('project-b', scope => (
          scope.collaboration.requests.create({
            createdAt: CREATED,
            description: 'Other Project',
            firstBaseOid: 'a'.repeat(40),
            latestHeadOid: 'd'.repeat(40),
            memberId: 'member-000',
            requestId: 'request-a',
          })
        ));

        const projectA = await store.withProjectReadScope('project-a', scope => (
          scope.collaboration.snapshot.read()
        ));
        assert.equal(projectA.kind, 'snapshot');
        assert.deepEqual(
          projectA.snapshot.openRequests.map(request => request.id),
          ['request-a', 'request-b'],
        );
        assert.equal(projectA.snapshot.openTicketCount, 6);
        assert.deepEqual(
          projectA.snapshot.ticketHighlights.map(ticket => ticket.id),
          ['ticket-5', 'ticket-4', 'ticket-3', 'ticket-2', 'ticket-1'],
        );

        const projectB = await store.withProjectReadScope('project-b', scope => (
          scope.collaboration.snapshot.read()
        ));
        assert.equal(projectB.kind, 'snapshot');
        assert.deepEqual(
          projectB.snapshot.openRequests.map(request => ({
            description: request.description,
            id: request.id,
          })),
          [{ description: 'Other Project', id: 'request-a' }],
        );
        assert.equal(projectB.snapshot.openTicketCount, 0);
        assert.deepEqual(projectB.snapshot.ticketHighlights, []);
      } finally {
        await store.close();
      }
    });
  });

  it('admits 100 bounded Requests and fails closed at collection or byte limits', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-count', 101);
      await seedProject(database, 'project-bytes', 30);
      const store = coordination(database);
      try {
        await store.withProjectScope('project-count', async scope => {
          for (let index = 0; index < 100; index += 1) {
            await scope.collaboration.requests.create({
              createdAt: CREATED,
              description: `${String(index).padStart(3, '0')}:${'x'.repeat(3_500)}`,
              firstBaseOid: 'a'.repeat(40),
              latestHeadOid: 'b'.repeat(40),
              memberId: `member-${String(index).padStart(3, '0')}`,
              requestId: `request-${String(index).padStart(3, '0')}`,
            });
          }
        });
        const bounded = await store.withProjectReadScope('project-count', scope => (
          scope.collaboration.snapshot.read()
        ));
        assert.equal(bounded.kind, 'snapshot');
        assert.equal(bounded.snapshot.openRequests.length, 100);
        assert.equal(
          Buffer.byteLength(JSON.stringify(bounded.snapshot), 'utf8')
            < COLLAB_CLOUD_BINDING_LIMITS.maxCloudSnapshotUtf8Bytes,
          true,
        );

        await store.withProjectScope('project-count', scope => (
          scope.collaboration.requests.create({
            createdAt: CREATED,
            description: 'One too many',
            firstBaseOid: 'a'.repeat(40),
            latestHeadOid: 'c'.repeat(40),
            memberId: 'member-100',
            requestId: 'request-100',
          })
        ));
        assert.deepEqual(
          await store.withProjectReadScope('project-count', scope => (
            scope.collaboration.snapshot.read()
          )),
          { kind: 'too-large' },
        );

        await store.withProjectScope('project-bytes', async scope => {
          for (let index = 0; index < 30; index += 1) {
            await scope.collaboration.requests.create({
              createdAt: CREATED,
              description: `${String(index).padStart(3, '0')}:${'y'.repeat(16_000)}`,
              firstBaseOid: 'a'.repeat(40),
              latestHeadOid: 'd'.repeat(40),
              memberId: `member-${String(index).padStart(3, '0')}`,
              requestId: `large-request-${String(index).padStart(3, '0')}`,
            });
          }
        });
        assert.deepEqual(
          await store.withProjectReadScope('project-bytes', scope => (
            scope.collaboration.snapshot.read()
          )),
          { kind: 'too-large' },
        );
      } finally {
        await store.close();
      }
    });
  });
});
