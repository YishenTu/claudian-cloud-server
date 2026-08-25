import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import { CoordinationError } from '../../../src/coordination/CoordinationError.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import {
  ActiveRepositoryIntegrityGate,
  type ActiveRepositoryIntegrityRepository,
} from '../../../src/project-authority/lifecycle/ActiveRepositoryIntegrityGate.js';
import {
  ProjectRecoveryCoordinator,
} from '../../../src/project-authority/recovery/ProjectRecoveryCoordinator.js';
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
const EXPIRES = '2026-08-22T00:00:00.000Z';
const SHA = 'a'.repeat(64);

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 2,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 1_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

async function seedActivationCandidate(store: PostgresCoordination): Promise<void> {
  await store.withProjectScope('project-lock', async scope => {
    await scope.putDevelopmentBootstrapAttempt({
      attemptId: 'attempt-lock',
      createdAt: T0,
      expiresAt: EXPIRES,
      manifestJson: '{"manifest":"lock"}',
      manifestSha256: SHA,
      projectId: 'project-lock',
      sourceHostMemberId: 'member-lock',
    });
    await scope.putDevelopmentBootstrapUpload({
      attemptId: 'attempt-lock',
      byteCount: 1024,
      createdAt: T1,
      sha256: SHA,
      stagingArtifactKey: 'artifact-lock',
      validationMarkerSha256: SHA,
    });
    await scope.transitionDevelopmentBootstrapAttempt({
      attemptId: 'attempt-lock',
      expectedBundleState: 'uploaded',
      expectedState: 'collecting',
      nextBundleState: 'uploaded',
      nextState: 'validating',
      updatedAt: T2,
    });
    await scope.transitionDevelopmentBootstrapAttempt({
      attemptId: 'attempt-lock',
      expectedBundleState: 'uploaded',
      expectedState: 'validating',
      nextBundleState: 'validated',
      nextState: 'ready',
      updatedAt: T3,
    });
    await scope.beginDevelopmentBootstrapActivation({
      attemptId: 'attempt-lock',
      journalJson: '{"private":"journal-payload"}',
      operationId: 'activation-lock',
      scheduledAt: T5,
    });
  });
}

async function seedActiveProjects(
  database: PostgresTestDatabase,
  projectIds: readonly string[],
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    for (const projectId of projectIds) {
      await client.query(
        "SELECT set_config('claudian_cloud.project_id', $1, true)",
        [projectId],
      );
      await client.query(
        `INSERT INTO claudian_cloud.projects (
           project_id, project_name, manager_set_generation,
           expected_main_oid, service_state, created_at, activated_at
         ) VALUES ($1, $1, 1, repeat('a', 40), 'active', $2, $2)`,
        [projectId, T0],
      );
      for (const [memberId, role] of [
        [`member-${projectId}-manager`, 'manager'],
        [`member-${projectId}-peer`, 'member'],
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
        `INSERT INTO claudian_cloud.repository_placements (
           project_id, storage_node_id, repository_storage_key, generation,
           active, created_at, updated_at
         ) VALUES ($1, 'node-a', $2, 1, true, $3, $3)`,
        [projectId, `storage-${projectId}`, T0],
      );
      await client.query(
        `INSERT INTO claudian_cloud.active_repository_placement_catalog (
           project_id, storage_node_id, repository_storage_key, generation
         ) VALUES ($1, 'node-a', $2, 1)`,
        [projectId, `storage-${projectId}`],
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

describe('recovery candidate catalog', () => {
  it('removes an isolated unknown Project from startup integrity enumeration', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      await seedActiveProjects(database, ['project-forward', 'project-healthy']);
      const store = coordination(database);
      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        await migration.query(
          `ALTER TABLE claudian_cloud.recovery_candidates
             DROP CONSTRAINT recovery_candidates_kind`,
        );
        await migration.query(
          `INSERT INTO claudian_cloud.recovery_candidates (
             kind, project_id, operation_id, scheduled_at, created_at
           ) VALUES ('future-operation', 'project-forward',
                     'operation-forward', $1, $1)`,
          [T0],
        );
        const recovery = new ProjectRecoveryCoordinator({
          accept: { recoverProject: () => Promise.resolve() },
          activation: { recoverProject: () => Promise.resolve() },
          catalog: store,
          isolation: store,
        });
        await recovery.recoverAll();
        recovery.close();

        await store.withProjectScope('project-forward', async scope => {
          assert.equal(
            (await scope.getProject())?.serviceState,
            'recovery-required',
          );
        });
        assert.deepEqual(
          (await store.listActiveRepositoryPlacements()).placements
            .map(placement => placement.projectId),
          ['project-healthy'],
        );
        const verified: string[] = [];
        const repository: ActiveRepositoryIntegrityRepository = {
          cleanupReceivePackState: placement => {
            verified.push(`cleanup:${placement.projectId}`);
            return Promise.resolve();
          },
          verifyIntegrity: placement => {
            verified.push(`verify:${placement.projectId}`);
            return Promise.resolve({ status: 'valid' });
          },
        };
        await new ActiveRepositoryIntegrityGate({
          coordination: store,
          repository,
        }).verifyAll();
        assert.deepEqual(verified, [
          'cleanup:project-healthy',
          'verify:project-healthy',
        ]);
      } finally {
        await migration.end();
        await store.close();
      }
    });
  });

  it('keeps a healthy Project active when an unknown candidate settles before lease acquisition', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      await seedActiveProjects(database, ['project-forward']);
      const store = coordination(database);
      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        await migration.query(
          `ALTER TABLE claudian_cloud.recovery_candidates
             DROP CONSTRAINT recovery_candidates_kind`,
        );
        await migration.query(
          `INSERT INTO claudian_cloud.recovery_candidates (
             kind, project_id, operation_id, scheduled_at, created_at
           ) VALUES ('future-operation', 'project-forward',
                     'operation-forward', $1, $1)`,
          [T0],
        );
        let settled = false;
        const recovery = new ProjectRecoveryCoordinator({
          accept: { recoverProject: () => Promise.resolve() },
          activation: { recoverProject: () => Promise.resolve() },
          catalog: store,
          isolation: {
            acquireProjectLease: async (projectId, options) => {
              if (!settled) {
                settled = true;
                await migration.query(
                  `DELETE FROM claudian_cloud.recovery_candidates
                    WHERE kind = 'future-operation'
                      AND project_id = 'project-forward'
                      AND operation_id = 'operation-forward'`,
                );
              }
              return store.acquireProjectLease(projectId, options);
            },
          },
        });

        await recovery.recoverAll();
        recovery.close();
        assert.equal(settled, true);
        await store.withProjectScope('project-forward', async scope => {
          assert.equal((await scope.getProject())?.serviceState, 'active');
        });
        assert.deepEqual(
          (await store.listActiveRepositoryPlacements()).placements
            .map(placement => placement.projectId),
          ['project-forward'],
        );
      } finally {
        await migration.end();
        await store.close();
      }
    });
  });

  it('returns a safe sentinel for a forward recovery kind', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const store = coordination(database);
      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        await migration.query(
          `ALTER TABLE claudian_cloud.recovery_candidates
             DROP CONSTRAINT recovery_candidates_kind`,
        );
        await migration.query(
          `INSERT INTO claudian_cloud.recovery_candidates (
             kind, project_id, operation_id, scheduled_at, created_at
           ) VALUES ('future-operation', 'project-forward',
                     'operation-forward', $1, $1)`,
          [T0],
        );

        assert.deepEqual(await store.listRecoveryCandidates(), {
          candidates: [{
            kind: 'unknown',
            operationId: 'operation-forward',
            projectId: 'project-forward',
            scheduledAt: T0,
            unrecognizedKind: 'future-operation',
          }],
          nextCursor: undefined,
        });
      } finally {
        await migration.end();
        await store.close();
      }
    });
  });

  it('enumerates stable 100-row keyset pages containing metadata only', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const store = coordination(database);
      const runtime = new Client({ connectionString: database.runtimeUrl });
      try {
        await seedActivationCandidate(store);
        await runtime.connect();
        await runtime.query(
          `INSERT INTO claudian_cloud.recovery_candidates (
             kind, project_id, operation_id, scheduled_at, created_at
           )
           SELECT 'accept',
                  'project-page-' || lpad(value::text, 3, '0'),
                  'operation-page-' || lpad(value::text, 3, '0'),
                  $1::timestamptz + make_interval(secs => value),
                  $1::timestamptz + make_interval(secs => value)
             FROM generate_series(0, 204) AS value`,
          [T0],
        );

        const first = await store.listRecoveryCandidates();
        assert.equal(first.candidates.length, 100);
        assert.ok(first.nextCursor);
        const second = await store.listRecoveryCandidates({
          after: first.nextCursor,
        });
        assert.equal(second.candidates.length, 100);
        assert.ok(second.nextCursor);
        const third = await store.listRecoveryCandidates({
          after: second.nextCursor,
        });
        assert.equal(third.candidates.length, 6);
        assert.equal(third.nextCursor, undefined);

        const candidates = [
          ...first.candidates,
          ...second.candidates,
          ...third.candidates,
        ];
        assert.equal(candidates.length, 206);
        assert.equal(
          new Set(candidates.map(candidate => (
            `${candidate.kind}/${candidate.projectId}/${candidate.operationId}`
          ))).size,
          candidates.length,
        );
        for (const candidate of candidates) {
          assert.deepEqual(Object.keys(candidate).sort(), [
            'kind',
            'operationId',
            'projectId',
            'scheduledAt',
          ]);
        }
        assert.deepEqual(candidates.at(-1), {
          kind: 'activation',
          operationId: 'activation-lock',
          projectId: 'project-lock',
          scheduledAt: T5,
        });

        await assert.rejects(
          store.listRecoveryCandidates({ limit: 101 }),
          error => {
            assert.ok(error instanceof CoordinationError);
            assert.equal(error.code, 'invalid-record');
            return true;
          },
        );
        await assert.rejects(
          store.listRecoveryCandidates({
            after: {
              kind: 'activation',
              operationId: '../private-operation',
              projectId: 'project-lock',
              scheduledAt: T4,
            },
          }),
          error => {
            assert.ok(error instanceof CoordinationError);
            assert.equal(error.code, 'invalid-record');
            assert.doesNotMatch(JSON.stringify(error), /private-operation/);
            return true;
          },
        );

        const unscopedJournal = await runtime.query(
          `SELECT journal_json
             FROM claudian_cloud.development_bootstrap_settlements`,
        );
        assert.deepEqual(unscopedJournal.rows, []);
        const catalogColumns = await runtime.query<{ readonly column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = 'claudian_cloud'
              AND table_name = 'recovery_candidates'
            ORDER BY ordinal_position`,
        );
        assert.deepEqual(
          catalogColumns.rows.map(row => row.column_name),
          ['kind', 'project_id', 'operation_id', 'scheduled_at', 'created_at'],
        );
      } finally {
        await runtime.end();
        await store.close();
      }
    });
  });

  it('allows duplicate scanners but serializes journal recovery on the canonical Project lock', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const store = coordination(database);
      try {
        await seedActivationCandidate(store);
        const [firstScan, secondScan] = await Promise.all([
          store.listRecoveryCandidates(),
          store.listRecoveryCandidates(),
        ]);
        assert.deepEqual(firstScan, secondScan);
        assert.equal(firstScan.candidates[0]?.projectId, 'project-lock');

        const firstLease = await store.acquireProjectLease('project-lock');
        let secondAcquired = false;
        const secondLeasePromise = store.acquireProjectLease('project-lock')
          .then(lease => {
            secondAcquired = true;
            return lease;
          });
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(secondAcquired, false);

        await firstLease.close();
        const secondLease = await secondLeasePromise;
        try {
          await secondLease.withProjectScope(async scope => {
            const attempt = await scope.getDevelopmentBootstrapAttempt(
              'attempt-lock',
            );
            assert.ok(attempt);
            assert.equal(attempt.projectId, 'project-lock');
            assert.equal(attempt.settlement?.journalJson, '{"private":"journal-payload"}');
          });
        } finally {
          await secondLease.close();
        }
      } finally {
        await store.close();
      }
    });
  });
});
