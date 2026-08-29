import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import { COLLAB_CHECKPOINT_ARTIFACT_LIMITS } from '@claudian-collab/protocol';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresEnvironmentRestorePersistence } from '../../../src/coordination/postgres/PostgresEnvironmentRestorePersistence.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { PostgresTerminalProjectContinuityCatalog } from '../../../src/coordination/postgres/PostgresTerminalProjectContinuityCatalog.js';
import type { TerminalProjectContinuityRecord } from '../../../src/coordination/ProjectCheckpointPersistence.js';
import { withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('PostgresTerminalProjectContinuityCatalog', () => {
  it('enumerates a schema-9 tombstone after its responder is absent', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).applyThrough(9);
      const seed = new Client({ connectionString: database.migrationUrl });
      try {
        await seed.connect();
        await seed.query('BEGIN');
        await seed.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        await seed.query(
          `INSERT INTO claudian_cloud.project_lifecycle_journals (
             project_id, operation_id, kind, direction, phase,
             recovery_from_phase, state, expected_authority_generation,
             actor_member_id, idempotency_key, request_fingerprint,
             checkpoint_sha256, batch_revision, batch_sha256, result_sha256,
             scheduled_at, created_at, updated_at, expected_personal_ref_oid
           ) VALUES (
             $1, 'retire-one', 'retire', NULL, 'completed', NULL, 'completed',
             4, 'member-manager', 'retire-idempotency', $2, NULL, NULL, NULL,
             $3, $4, $4, $4, NULL
           )`,
          [PROJECT_ID, 'b'.repeat(64), 'a'.repeat(64), '2026-08-29T00:00:00.000Z'],
        );
        await seed.query(
          `INSERT INTO claudian_cloud.project_tombstones (
             project_id, authority_generation, terminal_operation_kind,
             terminal_operation_id, result_sha256, retired_at,
             terminal_expires_at
           ) VALUES ($1, 4, 'retire', 'retire-one', $2, $3, $4)`,
          [
            PROJECT_ID,
            'a'.repeat(64),
            '2026-08-29T00:00:00.000Z',
            '2026-09-29T00:00:00.000Z',
          ],
        );
        await seed.query('COMMIT');
      } finally {
        await seed.end();
      }

      const catalog = new PostgresTerminalProjectContinuityCatalog({
        connectionString: database.migrationUrl,
        expectedAuthorityVolumeId: database.authorityVolumeId,
        expectedSchemaVersion: 9,
      });
      assert.deepEqual(await catalog.list({
        limit: 100,
        signal: new AbortController().signal,
      }), {
        nextCursor: undefined,
        projectIds: [PROJECT_ID],
      });

      const coordination = new PostgresCoordination({
        ordinaryPoolMax: 2,
        pinnedPoolMax: 1,
        projectLockTimeoutMs: 2_000,
        reservedPoolMax: 1,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 2_000,
      });
      let records: readonly TerminalProjectContinuityRecord[] = [];
      try {
        await assert.rejects(
          coordination.listTerminalProjectContinuity(),
          error => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, 'coordination.error.schema-incompatible');
            return true;
          },
        );
        const lease = await coordination.acquireProjectLease(PROJECT_ID);
        try {
          records = await lease.withProjectScope(scope => (
            scope.checkpoint.readTerminalProjectContinuityRecords({
              maximumCoordinationBytes:
                COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
            })
          ), { snapshot: 'repeatable-read' });
        } finally {
          await lease.close();
        }
      } finally {
        await coordination.close();
      }
      assert.deepEqual(records.map(record => record.kind), [
        'lifecycle-journal',
        'tombstone',
      ]);

      await withPostgresTestDatabase(async target => {
        const restore = new PostgresEnvironmentRestorePersistence({
          connectionString: target.migrationUrl,
        });
        const signal = new AbortController().signal;
        const operationId = 'restore-schema-nine-terminal';
        await restore.createDatabase({
          authorityId: 'authority-source',
          authorityVolumeId: target.authorityVolumeId,
          authorityVolumeIdentity: 'authority-volume-target',
          coordinationSchemaVersion: 9,
          operationId,
          restoreEpoch: 2,
          signal,
        });
        await restore.importTerminalProject({
          operationId,
          projectId: PROJECT_ID,
          records,
          restoreEpoch: 2,
          signal,
        });
        await restore.publishAuthority({
          catalog: {
            authorityId: 'authority-source',
            authorityVolumeIdentity: 'authority-volume-source',
            coordinationSchemaVersion: 9,
            createdAt: '2026-08-29T00:00:00.000Z',
            maximumServerBuild: 'cloud-build-one',
            minimumServerBuild: 'cloud-build-one',
            projects: [],
            repositoryFormatVersion: 1,
          },
          operationId,
          repositories: [],
          restoreEpoch: 2,
          signal,
        });
        await restore.verifyRestoredTerminalProject({
          operationId,
          projectId: PROJECT_ID,
          records,
          restoreEpoch: 2,
          signal,
        });
      });
    });
  });

  it('rejects a migration credential for another schema-9 authority', async () => {
    await withPostgresTestDatabase(async authority => {
      await new PostgresMigrator({
        connectionString: authority.migrationUrl,
      }).applyThrough(9);
      await withPostgresTestDatabase(async foreign => {
        await new PostgresMigrator({
          connectionString: foreign.migrationUrl,
        }).applyThrough(9);
        const catalog = new PostgresTerminalProjectContinuityCatalog({
          connectionString: foreign.migrationUrl,
          expectedAuthorityVolumeId: authority.authorityVolumeId,
          expectedSchemaVersion: 9,
        });

        await assert.rejects(catalog.list({
          limit: 100,
          signal: new AbortController().signal,
        }));
      });
    });
  });
});
