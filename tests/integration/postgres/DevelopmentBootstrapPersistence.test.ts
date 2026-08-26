import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import { CoordinationError } from '../../../src/coordination/CoordinationError.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const T0 = '2026-08-21T00:00:00.000Z';
const T1 = '2026-08-21T00:01:00.000Z';
const T2 = '2026-08-21T00:02:00.000Z';
const T3 = '2026-08-21T00:03:00.000Z';
const T4 = '2026-08-21T00:04:00.000Z';
const T5 = '2026-08-21T00:05:00.000Z';
const T6 = '2026-08-21T00:06:00.000Z';
const T7 = '2026-08-21T00:07:00.000Z';
const T8 = '2026-08-21T00:08:00.000Z';
const T9 = '2026-08-21T00:09:00.000Z';
const EXPIRES = '2026-08-22T00:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

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

async function expectCoordinationError(
  operation: Promise<unknown>,
  code: CoordinationError['code'],
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof CoordinationError);
    assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify(error), /postgresql:|manifest|report|journal/i);
    return true;
  });
}

describe('development bootstrap persistence', () => {
  it('applies and reapplies migration 0002 with forced-RLS runtime grants', async () => {
    await withPostgresTestDatabase(async database => {
      const migrator = new PostgresMigrator({
        connectionString: database.migrationUrl,
      });
      await migrator.apply();
      await migrator.apply();

      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        const history = await migration.query<{
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
        ]);

        const relations = await migration.query<{
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
              AND c.relname IN (
                'development_actor_mappings',
                'development_bootstrap_attempts',
                'development_bootstrap_reports',
                'development_bootstrap_settlements',
                'development_bootstrap_uploads'
              )
            ORDER BY c.relname`,
        );
        assert.deepEqual(relations.rows, [
          { forced: true, relation: 'development_actor_mappings', rowSecurity: true },
          { forced: true, relation: 'development_bootstrap_attempts', rowSecurity: true },
          { forced: true, relation: 'development_bootstrap_reports', rowSecurity: true },
          { forced: true, relation: 'development_bootstrap_settlements', rowSecurity: true },
          { forced: true, relation: 'development_bootstrap_uploads', rowSecurity: true },
        ]);

        const uniqueIndexes = await migration.query<{ readonly index_name: string }>(
          `SELECT indexrelid::regclass::text AS index_name
             FROM pg_index
            WHERE indexrelid IN (
              'claudian_cloud.development_bootstrap_one_nonterminal_per_project'::regclass,
              'claudian_cloud.development_bootstrap_one_nonterminal_settlement_per_project'::regclass
            )
              AND indisunique
            ORDER BY indexrelid::regclass::text`,
        );
        assert.deepEqual(uniqueIndexes.rows, [{
          index_name: 'claudian_cloud.development_bootstrap_one_nonterminal_per_project',
        }, {
          index_name: 'claudian_cloud.development_bootstrap_one_nonterminal_settlement_per_project',
        }]);

        const recoveryRls = await migration.query<{
          readonly forced: boolean;
          readonly rowSecurity: boolean;
        }>(
          `SELECT c.relrowsecurity AS "rowSecurity",
                  c.relforcerowsecurity AS forced
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'claudian_cloud'
              AND c.relname = 'recovery_candidates'`,
        );
        assert.deepEqual(recoveryRls.rows, [{
          forced: false,
          rowSecurity: false,
        }]);

        const routingColumns = await migration.query<{
          readonly columnName: string;
        }>(
          `SELECT column_name AS "columnName"
             FROM information_schema.columns
            WHERE table_schema = 'claudian_cloud'
              AND table_name = 'development_bootstrap_attempt_routes'
            ORDER BY ordinal_position`,
        );
        assert.deepEqual(routingColumns.rows, [
          { columnName: 'attempt_id' },
          { columnName: 'project_id' },
        ]);

        const routePrivileges = await migration.query<{
          readonly privilege: string;
        }>(
          `SELECT privilege_type AS privilege
             FROM information_schema.table_privileges
            WHERE table_schema = 'claudian_cloud'
              AND table_name = 'development_bootstrap_attempt_routes'
              AND grantee = 'claudian_cloud_runtime'
            ORDER BY privilege_type`,
        );
        assert.deepEqual(routePrivileges.rows, []);

        const runtimePrivileges = await migration.query<{
          readonly privilege: string;
          readonly relation: string;
        }>(
          `SELECT table_name AS relation, privilege_type AS privilege
             FROM information_schema.table_privileges
            WHERE table_schema = 'claudian_cloud'
              AND grantee = 'claudian_cloud_runtime'
              AND table_name IN (
                'development_actor_mappings',
                'development_bootstrap_attempts',
                'development_bootstrap_reports',
                'development_bootstrap_settlements',
                'development_bootstrap_uploads',
                'recovery_candidates'
              )
            ORDER BY table_name, privilege_type`,
        );
        const mutableRelations = [
          'development_actor_mappings',
          'development_bootstrap_attempts',
          'development_bootstrap_reports',
          'development_bootstrap_settlements',
          'development_bootstrap_uploads',
          'recovery_candidates',
        ];
        assert.deepEqual(runtimePrivileges.rows, mutableRelations.flatMap(relation => (
          ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map(privilege => ({
            privilege,
            relation,
          }))
        )));
      } finally {
        await migration.end();
      }
    });
  });

  it('persists exact attempts, two reports, upload, activation, and cancellation phases', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const store = coordination(database);
      try {
        const attempt = {
          attemptId: 'attempt-a',
          createdAt: T0,
          expiresAt: EXPIRES,
          manifestJson: '{"manifest":"a"}',
          manifestSha256: SHA_A,
          projectId: 'project-a',
          sourceHostMemberId: 'member-a',
        } as const;
        await store.withProjectScope('project-a', async scope => {
          assert.equal(
            await scope.putDevelopmentBootstrapAttempt(attempt),
            'created',
          );
          assert.equal(
            await scope.putDevelopmentBootstrapAttempt(attempt),
            'replayed',
          );
          await expectCoordinationError(
            scope.putDevelopmentBootstrapAttempt({
              ...attempt,
              manifestSha256: SHA_B,
            }),
            'state-conflict',
          );

          const reportA = {
            attemptId: attempt.attemptId,
            capturedAt: T2,
            createdAt: T1,
            reportJson: '{"reporter":"a"}',
            reportSha256: SHA_A,
            reporterMemberId: 'member-a',
          } as const;
          const reportB = {
            attemptId: attempt.attemptId,
            capturedAt: T1,
            createdAt: T2,
            reportJson: '{"reporter":"b"}',
            reportSha256: SHA_B,
            reporterMemberId: 'member-b',
          } as const;
          assert.equal(await scope.putDevelopmentBootstrapReport(reportA), 'created');
          assert.equal(await scope.putDevelopmentBootstrapReport(reportA), 'replayed');
          assert.equal(await scope.putDevelopmentBootstrapReport(reportB), 'created');
          await expectCoordinationError(
            scope.putDevelopmentBootstrapReport({
              ...reportB,
              reportSha256: SHA_A,
              reporterMemberId: 'member-c',
            }),
            'state-conflict',
          );

          const upload = {
            attemptId: attempt.attemptId,
            byteCount: 1024,
            createdAt: T2,
            sha256: SHA_A,
            stagingArtifactKey: 'artifact-a',
            validationMarkerSha256: SHA_B,
          } as const;
          assert.equal(await scope.putDevelopmentBootstrapUpload(upload), 'created');
          assert.equal(await scope.putDevelopmentBootstrapUpload(upload), 'replayed');
          await expectCoordinationError(
            scope.putDevelopmentBootstrapUpload({ ...upload, byteCount: 1025 }),
            'state-conflict',
          );

          assert.equal(await scope.transitionDevelopmentBootstrapAttempt({
            attemptId: attempt.attemptId,
            expectedBundleState: 'uploaded',
            expectedState: 'collecting',
            nextBundleState: 'uploaded',
            nextState: 'validating',
            updatedAt: T3,
          }), 'advanced');
          assert.equal(await scope.transitionDevelopmentBootstrapAttempt({
            attemptId: attempt.attemptId,
            expectedBundleState: 'uploaded',
            expectedState: 'validating',
            nextBundleState: 'validated',
            nextState: 'ready',
            updatedAt: T4,
          }), 'advanced');

          const activation = {
            attemptId: attempt.attemptId,
            journalJson: '{"target":"repository-a"}',
            operationId: 'activation-a',
            scheduledAt: T5,
          } as const;
          assert.equal(
            await scope.beginDevelopmentBootstrapActivation(activation),
            'created',
          );
          assert.equal(
            await scope.beginDevelopmentBootstrapActivation(activation),
            'replayed',
          );
        });

        assert.equal(
          await store.findDevelopmentBootstrapProject('attempt-a'),
          'project-a',
        );
        assert.equal(
          await store.findDevelopmentBootstrapProject('attempt-unknown'),
          undefined,
        );

        assert.deepEqual(await store.listRecoveryCandidates(), {
          candidates: [{
            kind: 'activation',
            operationId: 'activation-a',
            projectId: 'project-a',
            scheduledAt: T5,
          }],
          nextCursor: undefined,
        });

        await store.withProjectScope('project-a', async scope => {
          assert.equal(
            (await scope.getDevelopmentBootstrapRecoveryAttempt('activation-a'))
              ?.attemptId,
            'attempt-a',
          );
          assert.equal(
            await scope.getDevelopmentBootstrapRecoveryAttempt('activation-other'),
            undefined,
          );
          assert.equal(
            (await scope.getNonterminalDevelopmentBootstrapAttempt())?.attemptId,
            'attempt-a',
          );
        });

        await store.withProjectScope('project-b', async scope => {
          assert.equal(
            await scope.getDevelopmentBootstrapAttempt('attempt-a'),
            undefined,
          );
        });

        const lease = await store.acquireProjectLease('project-a');
        try {
          await lease.withProjectScope(async scope => {
            assert.equal(await scope.advanceDevelopmentBootstrapActivation({
              attemptId: 'attempt-a',
              expectedPhase: 'publish-intent',
              nextPhase: 'repository-published',
              updatedAt: T6,
            }), 'advanced');
            const activatedProject = {
              activatedAt: T7,
              attemptId: 'attempt-a',
              expectedMainOid: 'a'.repeat(40),
              managerSetGeneration: 1,
              members: [{
                activatedAt: T8,
                createdAt: T0,
                displayName: 'Alice',
                memberId: 'member-a',
                role: 'manager',
              }, {
                activatedAt: T8,
                createdAt: T0,
                displayName: 'Bob',
                memberId: 'member-b',
                role: 'member',
              }],
              projectCreatedAt: T8,
              projectName: 'P'.repeat(200),
              repositoryStorageKey: 'repository-a',
              storageNodeId: 'node-a',
            } as const;
            assert.equal(
              await scope.insertActivatedDevelopmentProject(activatedProject),
              'created',
            );
            assert.equal(
              await scope.insertActivatedDevelopmentProject(activatedProject),
              'replayed',
            );
            await expectCoordinationError(
              scope.insertActivatedDevelopmentProject({
                ...activatedProject,
                projectCreatedAt: T1,
              }),
              'state-conflict',
            );
            assert.equal(await scope.advanceDevelopmentBootstrapActivation({
              attemptId: 'attempt-a',
              expectedPhase: 'repository-published',
              nextPhase: 'activated',
              updatedAt: T7,
            }), 'advanced');
          });
        } finally {
          await lease.close();
        }

        assert.deepEqual(await store.listRecoveryCandidates(), {
          candidates: [{
            kind: 'activation',
            operationId: 'activation-a',
            projectId: 'project-a',
            scheduledAt: T7,
          }],
          nextCursor: undefined,
        });

        await store.withProjectScope('project-a', async scope => {
          assert.equal(await scope.advanceDevelopmentBootstrapActivation({
            attemptId: 'attempt-a',
            expectedPhase: 'activated',
            nextPhase: 'completed',
            updatedAt: T8,
          }), 'advanced');
          assert.equal(await scope.advanceDevelopmentBootstrapActivation({
            attemptId: 'attempt-a',
            expectedPhase: 'activated',
            nextPhase: 'completed',
            updatedAt: T8,
          }), 'replayed');

          const snapshot = await scope.getDevelopmentBootstrapAttempt('attempt-a');
          assert.ok(snapshot);
          assert.equal(snapshot.state, 'activated');
          assert.equal(snapshot.bundleState, 'validated');
          assert.deepEqual(
            snapshot.reports.map(report => report.reporterMemberId),
            ['member-a', 'member-b'],
          );
          assert.equal(snapshot.upload?.state, 'validated');
          assert.deepEqual(snapshot.settlement, {
            activationPhase: 'completed',
            attemptId: 'attempt-a',
            journalJson: '{"target":"repository-a"}',
            kind: 'activation',
            operationId: 'activation-a',
            updatedAt: T8,
          });
          assert.deepEqual(await scope.findMembership('member-a'), {
            displayName: 'Alice',
            memberId: 'member-a',
            revision: 1n,
            role: 'manager',
            status: 'active',
          });
          assert.deepEqual(await scope.findMembership('member-b'), {
            displayName: 'Bob',
            memberId: 'member-b',
            revision: 1n,
            role: 'member',
            status: 'active',
          });
          assert.equal(
            await scope.findDevelopmentActorMember('member-a'),
            'member-a',
          );
          assert.equal(
            await scope.findDevelopmentActorMember('member-b'),
            'member-b',
          );
          assert.equal(
            await scope.findDevelopmentActorMember('member-c'),
            undefined,
          );
          assert.deepEqual(await scope.getProject(), {
            activatedAt: T7,
            authorityGeneration: 1,
            authorityStateRevision: 1,
            createdAt: T8,
            expectedMainOid: 'a'.repeat(40),
            managerSetGeneration: 1,
            projectId: 'project-a',
            projectName: 'P'.repeat(200),
            serviceState: 'active',
          });
          assert.deepEqual(await scope.getRepositoryPlacement(), {
            active: true,
            generation: 1,
            projectId: 'project-a',
            repositoryStorageKey: 'repository-a',
            storageNodeId: 'node-a',
          });
          assert.equal(
            await scope.getDevelopmentBootstrapRecoveryAttempt('activation-a'),
            undefined,
          );
          assert.equal(
            await scope.getNonterminalDevelopmentBootstrapAttempt(),
            undefined,
          );
        });
        assert.deepEqual(
          (await store.listActiveRepositoryPlacements()).placements
            .map(placement => placement.projectId),
          ['project-a'],
        );
        await store.withProjectScope('project-a', async scope => {
          assert.equal(await scope.markDevelopmentBootstrapActivationRecoveryRequired({
            attemptId: 'attempt-a',
            expectedPhase: 'completed',
            updatedAt: T9,
          }), 'advanced');
          assert.equal(await scope.markDevelopmentBootstrapActivationRecoveryRequired({
            attemptId: 'attempt-a',
            expectedPhase: 'completed',
            updatedAt: T9,
          }), 'replayed');
        });
        assert.deepEqual(
          (await store.listActiveRepositoryPlacements()).placements,
          [],
        );
        assert.deepEqual(await store.listRecoveryCandidates(), {
          candidates: [],
          nextCursor: undefined,
        });

        await store.withProjectScope('project-c', async scope => {
          const cancelledAttempt = {
            ...attempt,
            attemptId: 'attempt-c',
            manifestJson: '{"manifest":"c"}',
            projectId: 'project-c',
          } as const;
          await scope.putDevelopmentBootstrapAttempt(cancelledAttempt);
          assert.equal(await scope.beginDevelopmentBootstrapCancellation({
            attemptId: 'attempt-c',
            expectedState: 'collecting',
            journalJson: '{"cleanup":"staging-c"}',
            operationId: 'cancellation-c',
            scheduledAt: T1,
          }), 'created');
          assert.equal(await scope.advanceDevelopmentBootstrapCancellation({
            attemptId: 'attempt-c',
            expectedPhase: 'cancel-intent',
            nextPhase: 'cancelled',
            updatedAt: T2,
          }), 'advanced');
          const snapshot = await scope.getDevelopmentBootstrapAttempt('attempt-c');
          assert.ok(snapshot);
          assert.equal(snapshot.state, 'cancelled');
          assert.equal(
            snapshot.settlement?.kind === 'cancellation'
              ? snapshot.settlement.cancellationPhase
              : undefined,
            'cancelled',
          );
        });
        assert.deepEqual((await store.listRecoveryCandidates()).candidates, []);

        await store.withProjectScope('project-c-recovery', async scope => {
          await scope.putDevelopmentBootstrapAttempt({
            ...attempt,
            attemptId: 'attempt-c-recovery',
            manifestJson: '{"manifest":"c-recovery"}',
            projectId: 'project-c-recovery',
          });
          await scope.beginDevelopmentBootstrapCancellation({
            attemptId: 'attempt-c-recovery',
            expectedState: 'collecting',
            journalJson: '{"cleanup":"staging-c-recovery"}',
            operationId: 'cancellation-c-recovery',
            scheduledAt: T1,
          });
          assert.equal(await scope.advanceDevelopmentBootstrapCancellation({
            attemptId: 'attempt-c-recovery',
            expectedPhase: 'cancel-intent',
            nextPhase: 'recovery-required',
            updatedAt: T2,
          }), 'advanced');
          const snapshot = await scope.getDevelopmentBootstrapAttempt(
            'attempt-c-recovery',
          );
          assert.ok(snapshot);
          assert.equal(snapshot.state, 'recovery-required');
          assert.equal(
            snapshot.settlement?.kind === 'cancellation'
              ? snapshot.settlement.cancellationPhase
              : undefined,
            'recovery-required',
          );
        });
        assert.deepEqual((await store.listRecoveryCandidates()).candidates, []);

        await store.withProjectScope('project-d', async scope => {
          const recoveryAttempt = {
            ...attempt,
            attemptId: 'attempt-d',
            manifestJson: '{"manifest":"d"}',
            projectId: 'project-d',
          } as const;
          await scope.putDevelopmentBootstrapAttempt(recoveryAttempt);
          await scope.putDevelopmentBootstrapUpload({
            attemptId: 'attempt-d',
            byteCount: 1024,
            createdAt: T1,
            sha256: SHA_A,
            stagingArtifactKey: 'artifact-d',
            validationMarkerSha256: SHA_B,
          });
          await scope.transitionDevelopmentBootstrapAttempt({
            attemptId: 'attempt-d',
            expectedBundleState: 'uploaded',
            expectedState: 'collecting',
            nextBundleState: 'uploaded',
            nextState: 'validating',
            updatedAt: T2,
          });
          await scope.transitionDevelopmentBootstrapAttempt({
            attemptId: 'attempt-d',
            expectedBundleState: 'uploaded',
            expectedState: 'validating',
            nextBundleState: 'validated',
            nextState: 'ready',
            updatedAt: T3,
          });
          await scope.beginDevelopmentBootstrapActivation({
            attemptId: 'attempt-d',
            journalJson: '{"target":"repository-d"}',
            operationId: 'activation-d',
            scheduledAt: T4,
          });
          assert.equal(await scope.markDevelopmentBootstrapActivationRecoveryRequired({
            attemptId: 'attempt-d',
            expectedPhase: 'publish-intent',
            updatedAt: T5,
          }), 'advanced');
          assert.equal(await scope.markDevelopmentBootstrapActivationRecoveryRequired({
            attemptId: 'attempt-d',
            expectedPhase: 'publish-intent',
            updatedAt: T5,
          }), 'replayed');
          const snapshot = await scope.getDevelopmentBootstrapAttempt('attempt-d');
          assert.ok(snapshot);
          assert.equal(snapshot.state, 'recovery-required');
          assert.equal(
            snapshot.settlement?.kind === 'activation'
              ? snapshot.settlement.activationPhase
              : undefined,
            'publish-intent',
          );
          assert.equal(
            (await scope.getNonterminalDevelopmentBootstrapAttempt())?.attemptId,
            'attempt-d',
          );
        });
        assert.deepEqual((await store.listRecoveryCandidates()).candidates, []);
      } finally {
        await store.close();
      }
    });
  });

  it('returns mixed-case reporters in canonical en-US order', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      try {
        await store.withProjectScope('project-order', async scope => {
          await scope.putDevelopmentBootstrapAttempt({
            attemptId: 'attempt-order',
            createdAt: T0,
            expiresAt: EXPIRES,
            manifestJson: '{"manifest":"order"}',
            manifestSha256: SHA_A,
            projectId: 'project-order',
            sourceHostMemberId: 'member-a',
          });
          await scope.putDevelopmentBootstrapReport({
            attemptId: 'attempt-order',
            capturedAt: T1,
            createdAt: T1,
            reportJson: '{"reporter":"upper"}',
            reportSha256: SHA_A,
            reporterMemberId: 'member-A',
          });
          await scope.putDevelopmentBootstrapReport({
            attemptId: 'attempt-order',
            capturedAt: T1,
            createdAt: T1,
            reportJson: '{"reporter":"lower"}',
            reportSha256: SHA_B,
            reporterMemberId: 'member-a',
          });

          const attempt = await scope.getDevelopmentBootstrapAttempt('attempt-order');
          assert.deepEqual(
            attempt?.reports.map(report => report.reporterMemberId),
            ['member-a', 'member-A'],
          );
        });
      } finally {
        await store.close();
      }
    });
  });

  it('serializes live attempts while unrelated Projects continue', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const store = coordination(database);
      const firstAttempt = {
        attemptId: 'attempt-concurrent-a',
        createdAt: T0,
        expiresAt: EXPIRES,
        manifestJson: '{"manifest":"concurrent-a"}',
        manifestSha256: SHA_A,
        projectId: 'project-concurrent',
        sourceHostMemberId: 'member-a',
      } as const;
      const lease = await store.acquireProjectLease('project-concurrent');
      try {
        await lease.withProjectScope(async scope => {
          assert.equal(
            await scope.putDevelopmentBootstrapAttempt(firstAttempt),
            'created',
          );
        });

        let sameProjectSettled = false;
        const sameProject = store.withProjectScope(
          'project-concurrent',
          scope => scope.putDevelopmentBootstrapAttempt({
            ...firstAttempt,
            attemptId: 'attempt-concurrent-b',
            manifestJson: '{"manifest":"concurrent-b"}',
          }),
        ).then(
          value => {
            sameProjectSettled = true;
            return { value } as const;
          },
          (error: unknown) => {
            sameProjectSettled = true;
            return { error } as const;
          },
        );
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(sameProjectSettled, false);

        assert.equal(await store.withProjectScope(
          'project-unrelated',
          scope => scope.putDevelopmentBootstrapAttempt({
            ...firstAttempt,
            attemptId: 'attempt-unrelated',
            manifestJson: '{"manifest":"unrelated"}',
            projectId: 'project-unrelated',
          }),
        ), 'created');

        await lease.close();
        const result = await sameProject;
        assert.ok('error' in result);
        assert.ok(result.error instanceof CoordinationError);
        assert.equal(result.error.code, 'state-conflict');
      } finally {
        await lease.close().catch(() => undefined);
        await store.close();
      }
    });
  });

  it('rolls back a journal when its recovery candidate cannot be claimed', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const store = coordination(database);
      const runtime = new Client({ connectionString: database.runtimeUrl });
      try {
        await store.withProjectScope('project-stale', async scope => {
          await scope.putDevelopmentBootstrapAttempt({
            attemptId: 'attempt-stale',
            createdAt: T0,
            expiresAt: EXPIRES,
            manifestJson: '{"manifest":"stale"}',
            manifestSha256: SHA_A,
            projectId: 'project-stale',
            sourceHostMemberId: 'member-a',
          });
          await scope.putDevelopmentBootstrapUpload({
            attemptId: 'attempt-stale',
            byteCount: 1024,
            createdAt: T1,
            sha256: SHA_A,
            stagingArtifactKey: 'artifact-stale',
            validationMarkerSha256: SHA_B,
          });
          await scope.transitionDevelopmentBootstrapAttempt({
            attemptId: 'attempt-stale',
            expectedBundleState: 'uploaded',
            expectedState: 'collecting',
            nextBundleState: 'uploaded',
            nextState: 'validating',
            updatedAt: T2,
          });
          await scope.transitionDevelopmentBootstrapAttempt({
            attemptId: 'attempt-stale',
            expectedBundleState: 'uploaded',
            expectedState: 'validating',
            nextBundleState: 'validated',
            nextState: 'ready',
            updatedAt: T3,
          });
        });
        await runtime.connect();
        await runtime.query(
          `INSERT INTO claudian_cloud.recovery_candidates (
             kind, project_id, operation_id, scheduled_at, created_at
           ) VALUES ('activation', 'project-stale', 'stale-operation', $1, $1)`,
          [T4],
        );

        await expectCoordinationError(
          store.withProjectScope('project-stale', scope => (
            scope.beginDevelopmentBootstrapActivation({
              attemptId: 'attempt-stale',
              journalJson: '{"target":"repository-stale"}',
              operationId: 'activation-stale',
              scheduledAt: T5,
            })
          )),
          'state-conflict',
        );
        await store.withProjectScope('project-stale', async scope => {
          const snapshot = await scope.getDevelopmentBootstrapAttempt('attempt-stale');
          assert.ok(snapshot);
          assert.equal(snapshot.state, 'ready');
          assert.equal(snapshot.settlement, undefined);
        });
      } finally {
        await runtime.end();
        await store.close();
      }
    });
  });
});
