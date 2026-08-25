import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLLAB_MAIN_REF,
  collabMemberRef,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import { CoordinationError } from '../../../src/coordination/CoordinationError.js';
import type { PrepareAcceptInput } from '../../../src/coordination/AcceptPersistence.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import {
  ProjectWriteAdmission,
  ProjectWriteAdmissionError,
} from '../../../src/project-authority/admission/ProjectWriteAdmission.js';
import { createDevelopmentIngressPrincipal } from '../../../src/request-context/IngressPrincipal.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const T0 = '2026-08-24T00:00:00.000Z';
const T1 = '2026-08-24T00:01:00.000Z';
const T2 = '2026-08-24T00:02:00.000Z';
const T3 = '2026-08-24T00:03:00.000Z';
const T4 = '2026-08-24T00:04:00.000Z';
const MAIN_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);
const TREE_OID = 'c'.repeat(40);
const RESULT_OID = 'd'.repeat(40);

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 4,
    pinnedPoolMax: 3,
    projectLockTimeoutMs: 2_000,
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
       ) VALUES ($1, 'Accept Project', 1, $2, 'active', $3, $3)`,
      [projectId, MAIN_OID, T0],
    );
    for (const [memberId, role] of [
      ['member-manager', 'manager'],
      ['member-author', 'member'],
    ] as const) {
      await client.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, display_name, role, status, revision,
           created_at, updated_at
         ) VALUES ($1, $2, $2, $3, 'active', 1, $4, $4)`,
        [projectId, memberId, role, T0],
      );
    }
    await client.query(
      `INSERT INTO claudian_cloud.development_actor_mappings (
         project_id, actor_id, member_id, created_at
       ) VALUES ($1, 'member-manager', 'member-manager', $2)`,
      [projectId, T0],
    );
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, 'accept-node', $2, 7, true, $3, $3)`,
      [projectId, `storage-${projectId}`, T0],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, 'accept-node', $2, 7)`,
      [projectId, `storage-${projectId}`],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function seedCollaboration(
  store: PostgresCoordination,
  projectId: string,
): Promise<void> {
  await store.withProjectScope(projectId, async scope => {
    await scope.collaboration.requests.create({
      createdAt: T0,
      description: 'Accept this request',
      firstBaseOid: MAIN_OID,
      latestHeadOid: HEAD_OID,
      memberId: 'member-author',
      requestId: 'request-shared',
    });
    await scope.collaboration.tickets.create({
      authorMemberId: 'member-author',
      body: 'Resolve this Ticket',
      createdAt: T0,
      ticketId: 'ticket-resolve',
      title: 'Resolve',
    });
    await scope.collaboration.tickets.create({
      authorMemberId: 'member-author',
      body: 'Reference this Ticket',
      createdAt: T0,
      ticketId: 'ticket-reference',
      title: 'Reference',
    });
    await scope.collaboration.requests.replacePendingRelations({
      actorMemberId: 'member-author',
      commitOid: HEAD_OID,
      relations: [
        {
          kind: 'references',
          relationId: 'relation-reference',
          ticketId: 'ticket-reference',
        },
        {
          kind: 'resolves',
          relationId: 'relation-resolve',
          ticketId: 'ticket-resolve',
        },
      ],
      requestId: 'request-shared',
      updatedAt: T0,
    });
  });
}

function prepareInput(
  projectId: string,
  operationId = 'accept-operation',
): Extract<PrepareAcceptInput, { readonly resultKind: 'merge' }> {
  return {
    actorMemberId: 'member-manager',
    commit: {
      authorEmail: 'collab@claudian.local',
      authorName: 'Claudian Collab',
      committerEmail: 'collab@claudian.local',
      committerName: 'Claudian Collab',
      message: 'Accept request request-shared\n',
      parents: [MAIN_OID, HEAD_OID],
      timezone: '+0000',
      treeOid: TREE_OID,
    },
    expectedHeadOid: HEAD_OID,
    expectedMainOid: MAIN_OID,
    expectedRequestRevision: 1,
    idempotencyKey: `idempotency-${operationId}`,
    mainRef: COLLAB_MAIN_REF,
    objectFormat: 'sha1',
    operationId,
    personalRef: collabMemberRef('member-author'),
    placement: {
      generation: 7,
      projectId,
      repositoryStorageKey: `storage-${projectId}`,
      storageNodeId: 'accept-node',
    },
    preparedAt: T1,
    relations: [
      {
        commitOid: HEAD_OID,
        kind: 'references',
        relationId: 'relation-reference',
        ticketId: 'ticket-reference',
        ticketRevision: 1,
      },
      {
        commitOid: HEAD_OID,
        kind: 'resolves',
        relationId: 'relation-resolve',
        ticketId: 'ticket-resolve',
        ticketRevision: 1,
      },
    ],
    requestFingerprint: 'e'.repeat(64),
    requestId: 'request-shared',
    requestMemberId: 'member-author',
    resultKind: 'merge',
  };
}

async function prepareThroughMainUpdated(
  store: PostgresCoordination,
  projectId: string,
  operationId = 'accept-operation',
): Promise<void> {
  await store.withProjectScope(projectId, async scope => {
    const accept = scope.accept;
    assert.equal(await accept.prepare(prepareInput(projectId, operationId)), 'created');
    assert.equal(await accept.persistResult({
      expectedPhase: 'prepared',
      operationId,
      resultOid: RESULT_OID,
      updatedAt: T2,
    }), 'advanced');
    assert.equal(await accept.markMainUpdated({
      expectedPhase: 'result-persisted',
      operationId,
      updatedAt: T3,
    }), 'advanced');
  });
}

async function expectStateConflict(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof CoordinationError);
    assert.equal(error.code, 'state-conflict');
    return true;
  });
}

describe('Accept journal persistence', () => {
  it('applies migration 0005 with forced RLS, composite locality, and least privilege', async () => {
    await withPostgresTestDatabase(async database => {
      const migrator = new PostgresMigrator({ connectionString: database.migrationUrl });
      await migrator.apply();
      await migrator.apply();

      const migration = new Client({ connectionString: database.migrationUrl });
      const runtime = new Client({ connectionString: database.runtimeUrl });
      try {
        await migration.connect();
        await runtime.connect();
        const history = await migration.query<{
          readonly name: string;
          readonly state: string;
          readonly version: number;
        }>(
          `SELECT version, name, state
             FROM claudian_cloud.schema_migrations
            ORDER BY version`,
        );
        assert.deepEqual(history.rows.find(row => row.version === 5), {
          name: 'accept-recovery',
          state: 'applied',
          version: 5,
        });

        const relations = ['accept_journal_relations', 'accept_journals'];
        const rls = await migration.query<{
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

        const foreignKeys = await migration.query<{
          readonly definition: string;
        }>(
          `SELECT pg_get_constraintdef(k.oid) AS definition
             FROM pg_constraint k
             JOIN pg_class c ON c.oid = k.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'claudian_cloud'
              AND c.relname = ANY($1::text[])
              AND k.contype = 'f'`,
          [relations],
        );
        assert.equal(
          foreignKeys.rows.every(row => row.definition.includes('(project_id')),
          true,
        );

        const indexes = await migration.query<{ readonly definition: string }>(
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

        const privileges = await migration.query<{
          readonly canDelete: boolean;
          readonly canInsert: boolean;
          readonly canSelect: boolean;
          readonly canUpdate: boolean;
          readonly canUpdatePhase: boolean;
        }>(
          `SELECT
             has_table_privilege(
               'claudian_cloud_runtime', 'claudian_cloud.accept_journals', 'DELETE'
             ) AS "canDelete",
             has_table_privilege(
               'claudian_cloud_runtime', 'claudian_cloud.accept_journals', 'INSERT'
             ) AS "canInsert",
             has_table_privilege(
               'claudian_cloud_runtime', 'claudian_cloud.accept_journals', 'SELECT'
             ) AS "canSelect",
             has_table_privilege(
               'claudian_cloud_runtime', 'claudian_cloud.accept_journals', 'UPDATE'
             ) AS "canUpdate",
             has_column_privilege(
               'claudian_cloud_runtime', 'claudian_cloud.accept_journals',
               'phase', 'UPDATE'
             ) AS "canUpdatePhase"`,
        );
        assert.deepEqual(privileges.rows, [{
          canDelete: false,
          canInsert: true,
          canSelect: true,
          canUpdate: false,
          canUpdatePhase: true,
        }]);
        assert.deepEqual(
          (await runtime.query('SELECT * FROM claudian_cloud.accept_journals')).rows,
          [],
        );
      } finally {
        await runtime.end();
        await migration.end();
      }
    });
  });

  it('persists the exact plan, phases, candidate, replay, and one nonterminal journal', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-a');
      await seedProject(database, 'project-b');
      const store = coordination(database);
      try {
        await seedCollaboration(store, 'project-a');
        await seedCollaboration(store, 'project-b');
        const input = prepareInput('project-a');
        await store.withProjectScope('project-a', async scope => {
          const accept = scope.accept;
          assert.equal(await accept.prepare(input), 'created');
          assert.equal(await accept.prepare(input), 'replayed');
          assert.deepEqual(await accept.get('accept-operation'), {
            ...input,
            phase: 'prepared',
            recoveryFromPhase: undefined,
            resultOid: undefined,
            updatedAt: T1,
          });
          assert.deepEqual(await accept.getNonterminal(), await accept.get('accept-operation'));
          await expectStateConflict(accept.prepare({
            ...input,
            commit: {
              ...input.commit,
              parents: [MAIN_OID, RESULT_OID],
            },
            expectedHeadOid: RESULT_OID,
          }));
          await expectStateConflict(accept.prepare(prepareInput(
            'project-a',
            'accept-operation-two',
          )));
          assert.equal(await accept.persistResult({
            expectedPhase: 'prepared',
            operationId: 'accept-operation',
            resultOid: RESULT_OID,
            updatedAt: T2,
          }), 'advanced');
          assert.equal(await accept.persistResult({
            expectedPhase: 'prepared',
            operationId: 'accept-operation',
            resultOid: RESULT_OID,
            updatedAt: T2,
          }), 'replayed');
          await expectStateConflict(accept.persistResult({
            expectedPhase: 'prepared',
            operationId: 'accept-operation',
            resultOid: 'f'.repeat(40),
            updatedAt: T2,
          }));
          assert.equal(await accept.markMainUpdated({
            expectedPhase: 'result-persisted',
            operationId: 'accept-operation',
            updatedAt: T3,
          }), 'advanced');
        });

        assert.deepEqual(
          (await store.listRecoveryCandidates()).candidates.filter(candidate => (
            candidate.kind === 'accept'
          )),
          [{
            kind: 'accept',
            operationId: 'accept-operation',
            projectId: 'project-a',
            scheduledAt: T3,
          }],
        );

        await store.withProjectScope('project-b', async scope => {
          const accept = scope.accept;
          assert.equal(
            await accept.prepare(prepareInput('project-b')),
            'created',
          );
        });

        const restarted = coordination(database);
        try {
          await restarted.withProjectReadScope('project-a', async scope => {
            const record = await scope.accept
              .get('accept-operation');
            assert.ok(record);
            assert.equal(record.phase, 'main-updated');
            assert.equal(record.resultOid, RESULT_OID);
            assert.equal(record.updatedAt, T3);
          });
        } finally {
          await restarted.close();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('classifies exact journal recovery state and removes scheduling visibility', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-recovery');
      const store = coordination(database);
      try {
        await seedCollaboration(store, 'project-recovery');
        await store.withProjectScope('project-recovery', async scope => {
          const accept = scope.accept;
          assert.equal(
            await accept.prepare(prepareInput('project-recovery')),
            'created',
          );
          assert.equal(await accept.markRecoveryRequired({
            expectedPhase: 'prepared',
            operationId: 'accept-operation',
            updatedAt: T2,
          }), 'advanced');
          assert.equal(await accept.markRecoveryRequired({
            expectedPhase: 'prepared',
            operationId: 'accept-operation',
            updatedAt: T2,
          }), 'replayed');
          const journal = await accept.get('accept-operation');
          assert.ok(journal);
          assert.equal(journal.phase, 'recovery-required');
          assert.equal(journal.recoveryFromPhase, 'prepared');
          assert.equal((await scope.getProject())?.serviceState, 'recovery-required');
          assert.ok(await scope.getRepositoryPlacement());
        });

        assert.equal(
          (await store.listRecoveryCandidates()).candidates.some(candidate => (
            candidate.projectId === 'project-recovery'
          )),
          false,
        );
        assert.equal(
          (await store.listActiveRepositoryPlacements()).placements.some(placement => (
            placement.projectId === 'project-recovery'
          )),
          false,
        );
        let recoveryCalled = false;
        const admission = new ProjectWriteAdmission({
          coordination: store,
          recovery: {
            recoverProject: () => {
              recoveryCalled = true;
              return Promise.resolve();
            },
          },
        });
        try {
          await assert.rejects(
            admission.run(
              createDevelopmentIngressPrincipal('member-manager'),
              'project-recovery',
              () => Promise.resolve('unexpected'),
            ),
            error => {
              assert.ok(error instanceof ProjectWriteAdmissionError);
              assert.equal(error.code, 'recovery-required');
              return true;
            },
          );
          assert.equal(recoveryCalled, false);
        } finally {
          await admission.close();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('persists contained Accept without inventing commit material', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-contained');
      const store = coordination(database);
      try {
        await seedCollaboration(store, 'project-contained');
        const mergePlan = prepareInput('project-contained');
        const containedPlan = {
          ...mergePlan,
          commit: undefined,
          resultKind: 'contained' as const,
        };
        await store.withProjectScope('project-contained', async scope => {
          assert.equal(await scope.accept.prepare(containedPlan), 'created');
          const journal = await scope.accept.get('accept-operation');
          assert.ok(journal);
          assert.equal(journal.resultKind, 'contained');
          assert.equal('commit' in journal, false);
          await expectStateConflict(scope.accept.persistResult({
            expectedPhase: 'prepared',
            operationId: 'accept-operation',
            resultOid: RESULT_OID,
            updatedAt: T2,
          }));
          assert.equal(await scope.accept.persistResult({
            expectedPhase: 'prepared',
            operationId: 'accept-operation',
            resultOid: MAIN_OID,
            updatedAt: T2,
          }), 'advanced');
          assert.equal(await scope.accept.markMainUpdated({
            expectedPhase: 'result-persisted',
            operationId: 'accept-operation',
            updatedAt: T3,
          }), 'advanced');
          const response = await scope.accept.complete({
            completedAt: T4,
            operationId: 'accept-operation',
          });
          assert.equal(response.mainOid, MAIN_OID);
          assert.equal(response.mergeCommitOid, MAIN_OID);
          assert.equal(response.request.mergedOid, MAIN_OID);
        });
      } finally {
        await store.close();
      }
    });
  });

  it('atomically completes Request, relations, Tickets, main, event, and idempotency', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-complete');
      const store = coordination(database);
      try {
        await seedCollaboration(store, 'project-complete');
        await prepareThroughMainUpdated(store, 'project-complete');

        const response = await store.withProjectScope(
          'project-complete',
          scope => scope.accept.complete({
            completedAt: T4,
            operationId: 'accept-operation',
          }),
        );
        assert.deepEqual(response, {
          mainOid: RESULT_OID,
          mergeCommitOid: RESULT_OID,
          request: {
            commentCount: 0,
            createdAt: T0,
            description: 'Accept this request',
            firstBaseOid: MAIN_OID,
            id: 'request-shared',
            latestHeadOid: HEAD_OID,
            memberId: 'member-author',
            mergedOid: RESULT_OID,
            revision: 1,
            status: 'merged',
            ticketRelations: [
              {
                commitOid: HEAD_OID,
                id: 'relation-resolve',
                kind: 'resolves',
                state: 'accepted',
                ticketId: 'ticket-resolve',
                ticketNumber: 1,
                ticketRevision: 2,
                ticketTitle: 'Resolve',
              },
              {
                commitOid: HEAD_OID,
                id: 'relation-reference',
                kind: 'references',
                state: 'accepted',
                ticketId: 'ticket-reference',
                ticketNumber: 2,
                ticketRevision: 1,
                ticketTitle: 'Reference',
              },
            ],
            updatedAt: T4,
          },
        });

        await store.withProjectReadScope('project-complete', async scope => {
          assert.equal((await scope.getProject())?.expectedMainOid, RESULT_OID);
          assert.equal(
            (await scope.collaboration.tickets.find('ticket-resolve'))?.status,
            'closed',
          );
          assert.equal(
            (await scope.collaboration.tickets.find('ticket-reference'))?.status,
            'open',
          );
          assert.deepEqual(await scope.collaboration.idempotency.find({
            idempotencyKey: 'idempotency-accept-operation',
            memberId: 'member-manager',
            operation: 'acceptRequest',
            requestFingerprint: 'e'.repeat(64),
          }), { kind: 'replay', response });
          assert.deepEqual(await scope.readProjectEvents({
            afterSequence: 0,
            limit: 2,
          }), {
            events: [{
              kind: 'main.updated',
              occurredAt: T4,
              payload: {
                mainOid: RESULT_OID,
                requestId: 'request-shared',
              },
              projectId: 'project-complete',
              protocolVersion: 5,
              sequence: 1,
            }],
            latestSequence: 1,
            retainedFromSequence: 1,
          });
          const accept = scope.accept;
          assert.equal(await accept.getNonterminal(), undefined);
          const journal = await accept.get('accept-operation');
          assert.ok(journal);
          assert.equal(
            journal.phase,
            'completed',
          );
        });
        assert.equal(
          (await store.listRecoveryCandidates()).candidates.some(candidate => (
            candidate.projectId === 'project-complete'
          )),
          false,
        );
        assert.deepEqual(
          await store.withProjectScope(
            'project-complete',
            scope => scope.accept.complete({
              completedAt: T4,
              operationId: 'accept-operation',
            }),
          ),
          response,
        );
        assert.equal(
          await store.withProjectScope(
            'project-complete',
            scope => scope.accept.prepare(prepareInput('project-complete')),
          ),
          'replayed',
        );
        assert.equal(
          (await store.listRecoveryCandidates()).candidates.some(candidate => (
            candidate.projectId === 'project-complete'
          )),
          false,
        );
      } finally {
        await store.close();
      }
    });
  });

  it('rolls terminal completion back as one transaction', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-rollback');
      const store = coordination(database);
      try {
        await seedCollaboration(store, 'project-rollback');
        await prepareThroughMainUpdated(store, 'project-rollback');
        await assert.rejects(
          store.withProjectScope('project-rollback', async scope => {
            await scope.accept.complete({
              completedAt: T4,
              operationId: 'accept-operation',
            });
            throw new Error('accept-terminal-rollback');
          }),
          /accept-terminal-rollback/u,
        );

        await store.withProjectReadScope('project-rollback', async scope => {
          assert.equal((await scope.getProject())?.expectedMainOid, MAIN_OID);
          assert.equal(
            (await scope.collaboration.requests.find('request-shared'))?.status,
            'open',
          );
          assert.equal(
            (await scope.collaboration.tickets.find('ticket-resolve'))?.status,
            'open',
          );
          assert.deepEqual(await scope.collaboration.idempotency.find({
            idempotencyKey: 'idempotency-accept-operation',
            memberId: 'member-manager',
            operation: 'acceptRequest',
            requestFingerprint: 'e'.repeat(64),
          }), { kind: 'missing' });
          assert.equal(await scope.getProjectEventSequence(), 0);
          const journal = await scope.accept.get('accept-operation');
          assert.ok(journal);
          assert.equal(
            journal.phase,
            'main-updated',
          );
        });
        assert.equal(
          (await store.listRecoveryCandidates()).candidates.some(candidate => (
            candidate.projectId === 'project-rollback'
          )),
          true,
        );
      } finally {
        await store.close();
      }
    });
  });
});
