import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CollabProjectId } from '@claudian-collab/protocol';
import { Client } from 'pg';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { ProjectEventWakeup } from '../../../src/project-authority/reads/ProjectEventWakeup.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const NOW = '2026-08-22T00:00:00.000Z';
const OLD = '2026-07-01T00:00:00.000Z';
const YOUNG = '2026-08-21T00:00:00.000Z';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('postgres-read-timeout')), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function coordination(
  database: PostgresTestDatabase,
  onProjectEventCommitted?: (projectId: CollabProjectId) => void,
): PostgresCoordination {
  return new PostgresCoordination({
    ...(onProjectEventCommitted === undefined ? {} : { onProjectEventCommitted }),
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
         project_id,
         project_name,
         manager_set_generation,
         expected_main_oid,
         service_state,
         created_at,
         activated_at
       ) VALUES (
         $1, 'Read Project', 1, repeat('a', 40), 'active',
         $2::timestamptz, $2::timestamptz
       )`,
      [projectId, YOUNG],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

describe('Project event persistence', () => {
  it('applies migration 0003 with forced RLS and least-privilege grants', async () => {
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
              AND c.relname IN ('project_event_sequences', 'project_events')
            ORDER BY c.relname`,
        );
        assert.deepEqual(rls.rows, [
          { forced: true, relation: 'project_event_sequences', rowSecurity: true },
          { forced: true, relation: 'project_events', rowSecurity: true },
        ]);

        const privileges = await client.query<{
          readonly privilege: string;
          readonly relation: string;
        }>(
          `SELECT table_name AS relation, privilege_type AS privilege
             FROM information_schema.table_privileges
            WHERE table_schema = 'claudian_cloud'
              AND grantee = 'claudian_cloud_runtime'
              AND table_name IN ('project_event_sequences', 'project_events')
            ORDER BY table_name, privilege_type`,
        );
        assert.deepEqual(privileges.rows, [
          { privilege: 'INSERT', relation: 'project_event_sequences' },
          { privilege: 'SELECT', relation: 'project_event_sequences' },
          { privilege: 'UPDATE', relation: 'project_event_sequences' },
          { privilege: 'DELETE', relation: 'project_events' },
          { privilege: 'INSERT', relation: 'project_events' },
          { privilege: 'SELECT', relation: 'project_events' },
        ]);
      } finally {
        await client.end();
      }
    });
  });

  it('assigns isolated monotonic sequences and returns exact keyset replay facts', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-a');
      await seedProject(database, 'project-b');
      const store = coordination(database);
      try {
        const first = await store.withProjectScope('project-a', scope => (
          scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: YOUNG,
            payload: { memberId: 'member-a' },
          })
        ));
        const second = await store.withProjectScope('project-a', scope => (
          scope.appendProjectEvent({
            kind: 'main.updated',
            occurredAt: NOW,
            payload: {
              mainOid: 'b'.repeat(40),
              requestId: 'request-a',
            },
          })
        ));
        const isolated = await store.withProjectScope('project-b', scope => (
          scope.appendProjectEvent({
            kind: 'ticket.updated',
            occurredAt: NOW,
            payload: { ticketId: 'ticket-b' },
          })
        ));

        assert.equal(first.sequence, 1);
        assert.equal(second.sequence, 2);
        assert.equal(isolated.sequence, 1);
        assert.deepEqual(first, {
          kind: 'membership.updated',
          occurredAt: YOUNG,
          payload: { memberId: 'member-a' },
          projectId: 'project-a',
          protocolVersion: 8,
          sequence: 1,
        });

        const page = await store.withProjectScope('project-a', scope => (
          scope.readProjectEvents({ afterSequence: 0, limit: 1 })
        ));
        assert.deepEqual(page, {
          events: [first],
          latestSequence: 2,
          retainedFromSequence: 1,
        });
        assert.deepEqual(
          await store.withProjectScope('project-a', scope => (
            scope.readProjectEvents({ afterSequence: 1, limit: 500 })
          )),
          {
            events: [second],
            latestSequence: 2,
            retainedFromSequence: 1,
          },
        );
        assert.deepEqual(
          await store.withProjectScope('project-b', scope => (
            scope.readProjectEvents({ afterSequence: 0, limit: 500 })
          )),
          {
            events: [isolated],
            latestSequence: 1,
            retainedFromSequence: 1,
          },
        );

        const runtime = new Client({ connectionString: database.runtimeUrl });
        try {
          await runtime.connect();
          assert.deepEqual(
            (await runtime.query('SELECT * FROM claudian_cloud.project_events')).rows,
            [],
          );
        } finally {
          await runtime.end();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('wakes after committed event transactions and never after rollback', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-commit-wakeup');
      const wakeup = new ProjectEventWakeup();
      let wakeups = 0;
      const unsubscribeThrowing = wakeup.subscribe(
        'project-commit-wakeup',
        () => { throw new Error('subscriber-failed'); },
      );
      const unsubscribe = wakeup.subscribe('project-commit-wakeup', () => {
        wakeups += 1;
      });
      const store = coordination(database, projectId => wakeup.notify(projectId));
      try {
        await store.withProjectScope('project-commit-wakeup', async scope => {
          await scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: YOUNG,
            payload: { memberId: 'member-committed' },
          });
          assert.equal(wakeups, 0);
        });
        assert.equal(wakeups, 1);

        await assert.rejects(
          store.withProjectScope('project-commit-wakeup', async scope => {
            await scope.appendProjectEvent({
              kind: 'membership.updated',
              occurredAt: NOW,
              payload: { memberId: 'member-rolled-back' },
            });
            throw new Error('force-rollback');
          }),
          /force-rollback/,
        );
        assert.equal(wakeups, 1);

        const lease = await store.acquireProjectLease('project-commit-wakeup');
        try {
          await lease.withProjectScope(scope => scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: NOW,
            payload: { memberId: 'member-pinned' },
          }));
        } finally {
          await lease.close();
        }
        assert.equal(wakeups, 2);

        const replay = await store.withProjectReadScope(
          'project-commit-wakeup',
          scope => scope.readProjectEvents({ afterSequence: 0, limit: 500 }),
        );
        assert.deepEqual(
          replay.events.map(event => event.payload),
          [
            { memberId: 'member-committed' },
            { memberId: 'member-pinned' },
          ],
        );
      } finally {
        unsubscribeThrowing();
        unsubscribe();
        await store.close();
      }
    });
  });

  it('retains the newest 10,000 events and every event younger than 30 days', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-retention');

      const client = new Client({ connectionString: database.migrationUrl });
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', 'project-retention', true)",
        );
        await client.query(
          `INSERT INTO claudian_cloud.project_event_sequences (
             project_id, current_sequence, updated_at
           ) VALUES ('project-retention', 10003, $1::timestamptz)`,
          [YOUNG],
        );
        await client.query(
          `INSERT INTO claudian_cloud.project_events (
             project_id, sequence, kind, payload, occurred_at
           )
           SELECT 'project-retention',
                  sequence,
                  'membership.updated',
                  jsonb_build_object('memberId', 'member-' || sequence::text),
                  CASE WHEN sequence <= 2 THEN $1::timestamptz ELSE $2::timestamptz END
             FROM generate_series(1, 10003) AS sequence`,
          [OLD, YOUNG],
        );
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }

      const store = coordination(database);
      try {
        const appended = await store.withProjectScope('project-retention', scope => (
          scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: NOW,
            payload: { memberId: 'member-10004' },
          })
        ));
        assert.equal(appended.sequence, 10004);
        assert.deepEqual(
          await store.withProjectScope('project-retention', scope => (
            scope.readProjectEvents({ afterSequence: 0, limit: 500 })
          )),
          {
            events: Array.from({ length: 500 }, (_, index) => ({
              kind: 'membership.updated',
              occurredAt: YOUNG,
              payload: { memberId: `member-${String(index + 3)}` },
              projectId: 'project-retention',
              protocolVersion: 8,
              sequence: index + 3,
            })),
            latestSequence: 10004,
            retainedFromSequence: 3,
          },
        );
        const tail = await store.withProjectScope('project-retention', scope => (
          scope.readProjectEvents({ afterSequence: 10003, limit: 500 })
        ));
        assert.equal(tail.events.length, 1);
        assert.equal(tail.events[0]?.sequence, 10004);
      } finally {
        await store.close();
      }
    });
  });

  it('runs same-Project reads concurrently against repeatable snapshots', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-concurrent-read');
      const store = coordination(database);
      const entered = deferred();
      const release = deferred();
      try {
        const first = store.withProjectReadScope(
          'project-concurrent-read',
          async scope => {
            const before = await scope.getProjectEventSequence();
            entered.resolve();
            await release.promise;
            return [before, await scope.getProjectEventSequence()] as const;
          },
        );
        await entered.promise;
        const appended = await within(store.withProjectScope(
          'project-concurrent-read',
          scope => scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: YOUNG,
            payload: { memberId: 'member-a' },
          }),
        ));
        assert.equal(appended.sequence, 1);
        assert.equal(
          await within(store.withProjectReadScope(
            'project-concurrent-read',
            scope => scope.getProjectEventSequence(),
          )),
          1,
        );
        release.resolve();
        assert.deepEqual(await first, [0, 0]);

        const concurrent = await Promise.all([
          store.withProjectScope('project-concurrent-read', scope => (
            scope.appendProjectEvent({
              kind: 'membership.updated',
              occurredAt: NOW,
              payload: { memberId: 'member-b' },
            })
          )),
          store.withProjectScope('project-concurrent-read', scope => (
            scope.appendProjectEvent({
              kind: 'membership.updated',
              occurredAt: NOW,
              payload: { memberId: 'member-c' },
            })
          )),
        ]);
        assert.deepEqual(
          concurrent.map(event => event.sequence).sort((left, right) => left - right),
          [2, 3],
        );
      } finally {
        release.resolve();
        await store.close();
      }
    });
  });
});
