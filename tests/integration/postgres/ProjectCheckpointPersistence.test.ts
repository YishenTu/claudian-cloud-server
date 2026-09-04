import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  COLLAB_PROJECT_MEMBERSHIP_LIMITS,
  collabControlOperationCodec,
  decodeCollabProjectBackupCheckpointCoordinationNdjson,
  encodeCollabProjectBackupCheckpointCoordinationNdjson,
  type CollabProjectBackupRecord,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const CREATED_AT = '2026-08-28T00:00:00.000Z';
const EXPIRES_AT = '2026-09-28T00:00:00.000Z';
const PROJECT_ID = 'project-checkpoint';

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 2,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

async function seed(database: PostgresTestDatabase): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [PROJECT_ID],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation, expected_main_oid,
         service_state, created_at, activated_at, authority_generation,
         authority_state_revision
       ) VALUES ($1, 'Snapshot Before', 0, $2, 'maintenance', $3, $3, 4, 7)`,
      [PROJECT_ID, 'a'.repeat(40), CREATED_AT],
    );
    await client.query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, display_name, role, status, revision,
         created_at, updated_at, activated_at, revoked_at
       ) VALUES ($1, 'member-manager', 'Manager', 'manager', 'active', 3,
                 $2, $2, $2, NULL)`,
      [PROJECT_ID, CREATED_AT],
    );
    await client.query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, display_name, role, status, revision,
         created_at, updated_at, activated_at, revoked_at, left_at
       ) VALUES
         ($1, 'member-left', 'Left Member', 'member', 'left', 4,
          $2, $3, $2, NULL, $3),
         ($1, 'member-revoked', 'Revoked Member', 'member', 'revoked', 5,
          $2, $3, $2, $3, NULL)`,
      [PROJECT_ID, CREATED_AT, EXPIRES_AT],
    );
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, 'local', 'repository_checkpoint', 5, true, $2, $2)`,
      [PROJECT_ID, CREATED_AT],
    );
    await client.query(
      `INSERT INTO claudian_cloud.idempotency_results (
         project_id, member_id, operation, idempotency_key,
         request_fingerprint, response_json, created_at
       ) VALUES ($1, 'member-manager', 'retireProject', 'retire-idempotency',
                 $2, $3::jsonb, $4)`,
      [
        PROJECT_ID,
        'b'.repeat(64),
        JSON.stringify({
          terminalExpiresAt: EXPIRES_AT,
          retirementId: 'retire-one',
          retiredAt: CREATED_AT,
          projectId: PROJECT_ID,
          kind: 'project-retired',
          acknowledgementRequired: true,
        }),
        CREATED_AT,
      ],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const metadata = Object.freeze({
  authorityId: 'authority-a',
  authorityVolumeIdentity: 'authority-volume-a',
  coordinationSchemaVersion: 9,
  maximumServerBuild: 'cloud-build-a',
  minimumServerBuild: 'cloud-build-a',
  repositoryFormatVersion: 1,
  restoreEpoch: 1,
});

describe('Project checkpoint persistence', () => {
  it('captures completed Removal recovery and exact replay continuity', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const client = new Client({ connectionString: database.migrationUrl });
      const store = coordination(database);
      const responseJson = JSON.stringify(
        collabControlOperationCodec('removeMember').decodeResponse({
          discardedRequestId: null,
          managerSetGeneration: 1,
          memberId: 'member-revoked',
          projectId: PROJECT_ID,
          removedAt: EXPIRES_AT,
          status: 'revoked',
        }),
      );
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        await client.query(
          `UPDATE claudian_cloud.projects
              SET manager_set_generation = 1
            WHERE project_id = $1`,
          [PROJECT_ID],
        );
        await client.query(
          `INSERT INTO claudian_cloud.project_lifecycle_journals (
             project_id, operation_id, kind, direction, phase,
             recovery_from_phase, state, expected_authority_generation,
             actor_member_id, idempotency_key, request_fingerprint,
             checkpoint_sha256, batch_revision, batch_sha256, result_sha256,
             scheduled_at, created_at, updated_at, expected_personal_ref_oid
           ) VALUES (
             $1, 'removal-backup', 'remove-member', NULL, 'completed', NULL,
             'completed', 4, 'member-manager', 'removal-key', $2, NULL, NULL,
             NULL, $3, $4, $4, $5, $6
           )`,
          [
            PROJECT_ID,
            '1'.repeat(64),
            createHash('sha256').update(responseJson).digest('hex'),
            CREATED_AT,
            EXPIRES_AT,
            'a'.repeat(40),
          ],
        );
        await client.query(
          `INSERT INTO claudian_cloud.project_member_removal_journals (
             project_id, operation_id, actor_member_id, target_member_id,
             idempotency_key, request_fingerprint,
             expected_target_membership_revision,
             expected_manager_set_generation, expected_personal_ref_oid,
             personal_ref, storage_node_id, repository_storage_key,
             placement_generation, phase, response_json, prepared_at,
             updated_at
           ) VALUES (
             $1, 'removal-backup', 'member-manager', 'member-revoked',
             'removal-key', $2, 4, 1, $3,
             'refs/heads/members/member-revoked', 'local',
             'repository_checkpoint', 5, 'completed', $4, $5, $6
           )`,
          [
            PROJECT_ID,
            '1'.repeat(64),
            'a'.repeat(40),
            responseJson,
            CREATED_AT,
            EXPIRES_AT,
          ],
        );
        await client.query('COMMIT');

        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          const records = await lease.withProjectScope(scope => (
            scope.checkpoint.readProjectCheckpointRecords({
              excludedOperationId: 'backup-one',
              maximumCoordinationBytes: 1024 * 1024,
              metadata,
              profile: 'backup',
              snapshotAt: EXPIRES_AT,
            })
          ), { snapshot: 'repeatable-read' });
          const lifecycle = records.find(record => (
            record.kind === 'lifecycle-journal'
            && record.value.operationId === 'removal-backup'
          ));
          assert.ok(lifecycle?.kind === 'lifecycle-journal');
          assert.equal(lifecycle.value.expectedPersonalRefOid, null);
          assert.equal(records.some(record => (
            record.kind === 'project-membership-recovery'
            && record.value.operationId === 'removal-backup'
            && record.value.expectedPersonalRefOid === 'a'.repeat(40)
          )), true);
          assert.equal(records.some(record => (
            record.kind === 'idempotency-result'
            && record.value.operation === 'removeMember'
            && record.value.responseJson === responseJson
          )), true);
        } finally {
          await lease.close();
        }
      } finally {
        await client.end().catch(() => undefined);
        await store.close();
      }
    });
  });

  it('captures Cloud membership replay state only in backup v3', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const client = new Client({ connectionString: database.migrationUrl });
      const store = coordination(database);
      const invitationExpiresAt = new Date(
        Date.parse(CREATED_AT) + COLLAB_PROJECT_MEMBERSHIP_LIMITS.invitationTtlMs,
      ).toISOString();
      const replayExpiresAt = new Date(
        Date.parse(CREATED_AT) + COLLAB_PROJECT_MEMBERSHIP_LIMITS.secretReplayTtlMs,
      ).toISOString();
      const terminalAt = new Date(Date.parse(CREATED_AT) + 1_000).toISOString();
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        await client.query(
          `UPDATE claudian_cloud.projects
              SET manager_set_generation = 1, service_state = 'active'
            WHERE project_id = $1`,
          [PROJECT_ID],
        );
        await client.query(
          `INSERT INTO claudian_cloud.project_memberships (
             project_id, member_id, display_name, role, status, revision,
             created_at, updated_at, activated_at, revoked_at, left_at
           ) VALUES ($1, 'member-active', 'Active Member', 'member', 'active', 2,
                     $2, $2, $2, NULL, NULL)`,
          [PROJECT_ID, CREATED_AT],
        );
        await client.query(
          `INSERT INTO claudian_cloud.project_invitations (
             project_id, invitation_id, issued_by_member_id, idempotency_key,
             request_fingerprint, secret_sha256, state, revision, created_at,
             expires_at, secret_replay_expires_at, terminal_at
           ) VALUES ($1, 'invitation-backup', 'member-manager', 'invite-key',
                     $2, $3, 'revoked', 2, $4, $5, $6, $7)`,
          [
            PROJECT_ID,
            'c'.repeat(64),
            'd'.repeat(64),
            CREATED_AT,
            invitationExpiresAt,
            replayExpiresAt,
            terminalAt,
          ],
        );
        await client.query(
          `INSERT INTO claudian_cloud.protected_invitation_envelopes (
             project_id, invitation_id, encryption_algorithm, key_id,
             key_version, nonce, ciphertext, tag, associated_data_sha256,
             created_at, expires_at
           ) VALUES ($1, 'invitation-backup', 'xchacha20-poly1305',
                     'encryption-key', 3, $2, $3, $4, $5, $6, $7)`,
          [
            PROJECT_ID,
            Buffer.alloc(24, 1).toString('base64url'),
            Buffer.from('ciphertext').toString('base64url'),
            Buffer.alloc(16, 2).toString('base64url'),
            'e'.repeat(64),
            CREATED_AT,
            invitationExpiresAt,
          ],
        );
        await client.query(
          `INSERT INTO claudian_cloud.manager_responsibility_offers (
             project_id, offer_id, source_manager_member_id, target_member_id,
             purpose, state, revision, manager_set_generation_at_offer,
             target_membership_revision_at_offer, idempotency_key,
             request_fingerprint, offered_at, expires_at, acknowledged_at,
             terminal_at
           ) VALUES ($1, 'offer-backup', 'member-manager', 'member-active',
                     'manager-promotion', 'offered', 1, 1, 2, 'offer-key',
                     $2, $3, $4, NULL, NULL)`,
          [PROJECT_ID, 'f'.repeat(64), CREATED_AT, invitationExpiresAt],
        );
        await client.query(
          `INSERT INTO claudian_cloud.idempotency_results (
             project_id, member_id, operation, idempotency_key,
             request_fingerprint, response_json, created_at
           ) VALUES ($1, 'member-manager', 'createManagerResponsibilityOffer',
                     'offer-key', $2, $3::jsonb, $4)`,
          [
            PROJECT_ID,
            'f'.repeat(64),
            JSON.stringify({
              offer: {
                acknowledgedAt: null,
                expiresAt: invitationExpiresAt,
                managerSetGenerationAtOffer: 1,
                offeredAt: CREATED_AT,
                offerId: 'offer-backup',
                purpose: 'manager-promotion',
                revision: 1,
                sourceManagerMemberId: 'member-manager',
                state: 'offered',
                targetMemberId: 'member-active',
                targetMembershipRevisionAtOffer: 2,
                terminalAt: null,
              },
            }),
            CREATED_AT,
          ],
        );
        await client.query(
          `INSERT INTO claudian_cloud.project_membership_idempotency_tombstones (
             project_id, actor_member_id, operation, idempotency_key,
             request_fingerprint, compacted_at
           ) VALUES ($1, 'member-manager', 'cancelManagerResponsibilityOffer',
                     'compacted-offer-key', $2, $3)`,
          [PROJECT_ID, '9'.repeat(64), CREATED_AT],
        );
        await client.query('COMMIT');

        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          const backup = await lease.withProjectScope(scope => (
            scope.checkpoint.readProjectCheckpointRecords({
              excludedOperationId: 'backup-one',
              maximumCoordinationBytes: 1024 * 1024,
              metadata,
              profile: 'backup',
              snapshotAt: CREATED_AT,
            })
          ), { snapshot: 'repeatable-read' });
          assert.equal(backup.some(record => (
            record.kind === 'project-invitation'
            && record.value.invitationId === 'invitation-backup'
            && record.value.state === 'revoked'
          )), true);
          const envelope = backup.find(record => (
            record.kind === 'protected-invitation-envelope'
          ));
          assert.ok(envelope?.kind === 'protected-invitation-envelope');
          assert.equal(envelope.value.keyId, 'encryption-key');
          assert.equal(backup.some(record => (
            record.kind === 'manager-responsibility-offer'
            && record.value.offerId === 'offer-backup'
          )), true);
          assert.equal(backup.some(record => (
            record.kind === 'idempotency-result'
            && record.value.operation === 'createManagerResponsibilityOffer'
            && record.value.idempotencyKey === 'offer-key'
          )), true);
          assert.equal(backup.some(record => (
            record.kind === 'membership-idempotency-tombstone'
            && record.value.operation === 'cancelManagerResponsibilityOffer'
            && record.value.idempotencyKey === 'compacted-offer-key'
          )), true);

          const exported = await lease.withProjectScope(scope => (
            scope.checkpoint.readProjectCheckpointRecords({
              excludedOperationId: 'export-one',
              maximumCoordinationBytes: 1024 * 1024,
              metadata,
              profile: 'export',
              snapshotAt: CREATED_AT,
            })
          ), { snapshot: 'repeatable-read' });
          assert.equal(exported.some(record => (
            record.kind === 'project-invitation'
            || record.kind === 'protected-invitation-envelope'
            || record.kind === 'manager-responsibility-offer'
            || record.kind === 'membership-idempotency-tombstone'
          )), false);
        } finally {
          await lease.close();
        }
      } finally {
        await client.end().catch(() => undefined);
        await store.close();
      }
    });
  });

  it('captures the canonical response for a revoked invitation replay fact', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const client = new Client({ connectionString: database.migrationUrl });
      const store = coordination(database);
      const invitationId = 'invitation-revoked-checkpoint';
      const invitationExpiresAt = new Date(
        Date.parse(CREATED_AT) + COLLAB_PROJECT_MEMBERSHIP_LIMITS.invitationTtlMs,
      ).toISOString();
      const replayExpiresAt = new Date(
        Date.parse(CREATED_AT) + COLLAB_PROJECT_MEMBERSHIP_LIMITS.secretReplayTtlMs,
      ).toISOString();
      const revokedAt = new Date(Date.parse(CREATED_AT) + 1_000).toISOString();
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        await client.query(
          `INSERT INTO claudian_cloud.project_invitations (
             project_id, invitation_id, issued_by_member_id, idempotency_key,
             request_fingerprint, secret_sha256, state, revision, created_at,
             expires_at, secret_replay_expires_at, terminal_at
           ) VALUES ($1, $2, 'member-manager', 'invite-revoked-key',
                     $3, $4, 'revoked', 2, $5, $6, $7, $8)`,
          [
            PROJECT_ID,
            invitationId,
            'c'.repeat(64),
            'd'.repeat(64),
            CREATED_AT,
            invitationExpiresAt,
            replayExpiresAt,
            revokedAt,
          ],
        );
        await client.query(
          `INSERT INTO claudian_cloud.protected_invitation_envelopes (
             project_id, invitation_id, encryption_algorithm, key_id,
             key_version, nonce, ciphertext, tag, associated_data_sha256,
             created_at, expires_at
           ) VALUES ($1, $2, 'xchacha20-poly1305', 'encryption-key', 3,
                     $3, $4, $5, $6, $7, $8)`,
          [
            PROJECT_ID,
            invitationId,
            Buffer.alloc(24, 1).toString('base64url'),
            Buffer.from('ciphertext').toString('base64url'),
            Buffer.alloc(16, 2).toString('base64url'),
            'f'.repeat(64),
            CREATED_AT,
            invitationExpiresAt,
          ],
        );
        await client.query(
          `INSERT INTO claudian_cloud.idempotency_results (
             project_id, member_id, operation, idempotency_key,
             request_fingerprint, response_json, created_at
           ) VALUES ($1, 'member-manager', 'revokeProjectInvitation',
                     'revoke-invitation-checkpoint', $2, $3::jsonb, $4)`,
          [
            PROJECT_ID,
            'e'.repeat(64),
            JSON.stringify({ invitationId }),
            revokedAt,
          ],
        );
        await client.query('COMMIT');

        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          const records = await lease.withProjectScope(scope => (
            scope.checkpoint.readProjectCheckpointRecords({
              excludedOperationId: 'backup-one',
              maximumCoordinationBytes: 1024 * 1024,
              metadata,
              profile: 'backup',
              snapshotAt: revokedAt,
            })
          ), { snapshot: 'repeatable-read' });
          const replay = records.find(record => (
            record.kind === 'idempotency-result'
            && record.value.operation === 'revokeProjectInvitation'
            && record.value.idempotencyKey === 'revoke-invitation-checkpoint'
          ));
          assert.ok(replay?.kind === 'idempotency-result');
          assert.equal(replay.value.responseJson, JSON.stringify(
            collabControlOperationCodec('revokeProjectInvitation').decodeResponse({
              invitationId,
              projectId: PROJECT_ID,
              revision: 2,
              revokedAt,
              state: 'revoked',
            }),
          ));
        } finally {
          await lease.close();
        }
      } finally {
        await client.end().catch(() => undefined);
        await store.close();
      }
    });
  });

  it('fails before reading additional tables when the configured artifact ceiling is exceeded', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      const lease = await store.acquireProjectLease(PROJECT_ID);
      try {
        await assert.rejects(
          lease.withProjectScope(scope => (
            scope.checkpoint.readProjectCheckpointRecords({
              excludedOperationId: 'backup-one',
              maximumCoordinationBytes: 1,
              metadata,
              profile: 'backup',
              snapshotAt: CREATED_AT,
            })
          ), { snapshot: 'repeatable-read' }),
          (error: unknown) => (
            typeof error === 'object'
            && error !== null
            && 'code' in error
            && error.code === 'resource-limit'
          ),
        );
      } finally {
        await lease.close();
        await store.close();
      }
    });
  });

  it('pages large rows within the heap budget and rejects their cumulative artifact size', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const writer = new Client({ connectionString: database.migrationUrl });
      const store = coordination(database);
      try {
        await writer.connect();
        await writer.query('BEGIN');
        await writer.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        await writer.query(
          `INSERT INTO claudian_cloud.change_requests (
             project_id, request_id, member_id, status, first_base_oid,
             latest_head_oid, merged_oid, description, revision,
             created_at, updated_at
           ) VALUES ($1, 'request-large', 'member-manager', 'open', $2, $2,
                     NULL, 'Large request', 1, $3, $3)`,
          [PROJECT_ID, 'a'.repeat(40), CREATED_AT],
        );
        for (const suffix of ['one', 'two', 'three']) {
          await writer.query(
            `INSERT INTO claudian_cloud.request_comments (
               project_id, comment_id, request_id, author_member_id, body,
               created_at
             ) VALUES ($1, $2, 'request-large', 'member-manager', $3, $4)`,
            [PROJECT_ID, `comment-${suffix}`, suffix.repeat(4_000), CREATED_AT],
          );
        }
        await writer.query('COMMIT');
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          await assert.rejects(
            lease.withProjectScope(scope => (
              scope.checkpoint.readProjectCheckpointRecords({
                excludedOperationId: 'export-one',
                maximumCoordinationBytes: 25 * 1024,
                metadata,
                profile: 'export',
                snapshotAt: CREATED_AT,
              })
            ), { snapshot: 'repeatable-read' }),
            (error: unknown) => (
              typeof error === 'object'
              && error !== null
              && 'code' in error
              && error.code === 'resource-limit'
            ),
          );
        } finally {
          await lease.close();
        }
      } finally {
        await writer.end().catch(() => undefined);
        await store.close();
      }
    });
  });

  it('round-trips a canonical backup with a zero-event cursor and canonical idempotency JSON', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      const lease = await store.acquireProjectLease(PROJECT_ID);
      try {
        const records = await lease.withProjectScope(scope => (
          scope.checkpoint.readProjectCheckpointRecords({
            excludedOperationId: 'backup-one',
            maximumCoordinationBytes: 1024 * 1024,
            metadata,
            profile: 'backup',
            snapshotAt: CREATED_AT,
          })
        ), { snapshot: 'repeatable-read' });
        const encoded = encodeCollabProjectBackupCheckpointCoordinationNdjson(
          records as readonly CollabProjectBackupRecord[],
        );
        assert.deepEqual(
          decodeCollabProjectBackupCheckpointCoordinationNdjson(encoded),
          records,
        );
        assert.equal(records[0]?.recordId, PROJECT_ID);
        const cursor = records.find(record => record.kind === 'cloud-event-cursor');
        assert.ok(cursor);
        assert.equal(cursor.value.currentSequence, 0);
        assert.equal(cursor.revision, 1);
        const result = records.find(record => record.kind === 'idempotency-result');
        assert.ok(result);
        assert.equal(result.value.responseJson, JSON.stringify({
          acknowledgementRequired: true,
          kind: 'project-retired',
          projectId: PROJECT_ID,
          retiredAt: CREATED_AT,
          retirementId: 'retire-one',
          terminalExpiresAt: EXPIRES_AT,
        }));
        const left = records.find((record): record is Extract<
          CollabProjectBackupRecord,
          { readonly kind: 'member' }
        > => (
          record.kind === 'member' && record.value.memberId === 'member-left'
        ));
        const revoked = records.find((record): record is Extract<
          CollabProjectBackupRecord,
          { readonly kind: 'member' }
        > => (
          record.kind === 'member' && record.value.memberId === 'member-revoked'
        ));
        assert.ok(left);
        assert.ok(revoked);
        assert.equal(left.value.revokedAt, EXPIRES_AT);
        assert.equal(revoked.value.revokedAt, EXPIRES_AT);
      } finally {
        await lease.close();
        await store.close();
      }
    });
  });

  it('captures every lifecycle record when no current operation is excluded', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        await store.withProjectScope(PROJECT_ID, async scope => {
          assert.equal(await scope.portability.putLifecycleJournal({
            actorMemberId: undefined,
            createdAt: CREATED_AT,
            direction: undefined,
            expectedAuthorityGeneration: 4,
            idempotencyKey: 'verify-key-references-idempotency',
            kind: 'backup',
            operationId: 'verify-key-references',
            phase: 'prepared',
            projectId: PROJECT_ID,
            requestFingerprint: 'a'.repeat(64),
            scheduledAt: CREATED_AT,
          }), 'created');
          const records = await scope.checkpoint.readProjectCheckpointRecords({
            maximumCoordinationBytes: 1024 * 1024,
            metadata,
            profile: 'backup',
            snapshotAt: CREATED_AT,
          });
          assert.equal(records.some(record => (
            record.kind === 'lifecycle-journal'
            && record.value.operationId === 'verify-key-references'
          )), true);
        });
      } finally {
        await store.close();
      }
    });
  });

  it('captures terminal responder principals only for backup', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        await store.withProjectScope(PROJECT_ID, async scope => {
          const responseJson = JSON.stringify({
            acknowledgementRequired: true,
            kind: 'project-retired',
            projectId: PROJECT_ID,
            retiredAt: CREATED_AT,
            retirementId: 'retire-continuity',
            terminalExpiresAt: EXPIRES_AT,
          });
          const responseSha256 = createHash('sha256')
            .update(responseJson)
            .digest('hex');
          assert.equal(await scope.portability.putTerminalResponder({
            createdAt: CREATED_AT,
            eligiblePrincipals: [{
              memberId: 'member-manager',
              principalId: 'principal:manager',
            }],
            expiresAt: EXPIRES_AT,
            operationId: 'retire-continuity',
            operationKind: 'retire',
            responseJson,
            responseSha256,
          }), 'created');
          assert.equal(await scope.portability.putProjectTombstone({
            authorityGeneration: 4,
            projectId: PROJECT_ID,
            resultSha256: responseSha256,
            retiredAt: CREATED_AT,
            terminalExpiresAt: EXPIRES_AT,
            terminalOperationId: 'retire-continuity',
            terminalOperationKind: 'retire',
          }), 'created');

          const backup = await scope.checkpoint.readProjectCheckpointRecords({
            excludedOperationId: 'backup-one',
            maximumCoordinationBytes: 1024 * 1024,
            metadata,
            profile: 'backup',
            snapshotAt: CREATED_AT,
          });
          assert.equal(backup.some(record => (
            record.kind === 'terminal-responder'
            && record.value.operationId === 'retire-continuity'
          )), true);
          assert.equal(backup.some(record => (
            record.kind === 'terminal-principal'
            && record.value.operationId === 'retire-continuity'
            && record.value.principalId === 'principal:manager'
          )), true);

          const exported = await scope.checkpoint.readProjectCheckpointRecords({
            excludedOperationId: 'export-one',
            maximumCoordinationBytes: 1024 * 1024,
            metadata,
            profile: 'export',
            snapshotAt: CREATED_AT,
          });
          assert.equal(exported.some(record => (
            record.kind === 'terminal-responder'
          )), false);
        });
      } finally {
        await store.close();
      }
    });
  });

  it('holds one repeatable read snapshot across a concurrent committed change', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      const lease = await store.acquireProjectLease(PROJECT_ID);
      const writer = new Client({ connectionString: database.migrationUrl });
      let releaseSnapshot: (() => void) | undefined;
      const continueSnapshot = new Promise<void>(resolve => {
        releaseSnapshot = resolve;
      });
      let snapshotStarted: (() => void) | undefined;
      const started = new Promise<void>(resolve => {
        snapshotStarted = resolve;
      });
      try {
        await writer.connect();
        const pending = lease.withProjectScope(async scope => {
          assert.equal((await scope.getProject())?.projectName, 'Snapshot Before');
          snapshotStarted?.();
          await continueSnapshot;
          return scope.checkpoint.readProjectCheckpointRecords({
            excludedOperationId: 'backup-one',
            maximumCoordinationBytes: 1024 * 1024,
            metadata,
            profile: 'export',
            snapshotAt: CREATED_AT,
          });
        }, { snapshot: 'repeatable-read' });
        await started;
        await writer.query('BEGIN');
        await writer.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        await writer.query(
          `UPDATE claudian_cloud.projects
              SET project_name = 'Committed After'
            WHERE project_id = $1`,
          [PROJECT_ID],
        );
        await writer.query('COMMIT');
        releaseSnapshot?.();
        const records = await pending;
        const project = records.find(record => record.kind === 'project');
        assert.equal(project?.value.name, 'Snapshot Before');
      } finally {
        releaseSnapshot?.();
        await writer.end();
        await lease.close();
        await store.close();
      }
    });
  });

  it('preserves idempotency results whose member-scoped keys are equal', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const writer = new Client({ connectionString: database.migrationUrl });
      const store = coordination(database);
      try {
        await writer.connect();
        await writer.query('BEGIN');
        await writer.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        await writer.query(
          `INSERT INTO claudian_cloud.idempotency_results (
             project_id, member_id, operation, idempotency_key,
             request_fingerprint, response_json, created_at
           ) VALUES ($1, 'member-left', 'retireProject',
                     'retire-idempotency', $2, $3::jsonb, $4)`,
          [
            PROJECT_ID,
            'c'.repeat(64),
            JSON.stringify({
              terminalExpiresAt: EXPIRES_AT,
              retirementId: 'retire-one',
              retiredAt: CREATED_AT,
              projectId: PROJECT_ID,
              kind: 'project-retired',
              acknowledgementRequired: true,
            }),
            CREATED_AT,
          ],
        );
        await writer.query('COMMIT');
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          const records = await lease.withProjectScope(scope => (
            scope.checkpoint.readProjectCheckpointRecords({
              excludedOperationId: 'backup-one',
              maximumCoordinationBytes: 1024 * 1024,
              metadata,
              profile: 'backup',
              snapshotAt: CREATED_AT,
            })
          ), { snapshot: 'repeatable-read' });
          const results = records.filter(record => (
            record.kind === 'idempotency-result'
            && record.value.idempotencyKey === 'retire-idempotency'
          ));
          assert.equal(results.length, 2);
          assert.equal(new Set(results.map(result => result.recordId)).size, 2);
        } finally {
          await lease.close();
        }
      } finally {
        await writer.end();
        await store.close();
      }
    });
  });
});
