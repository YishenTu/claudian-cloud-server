import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { encodeCollabProtectedClaimAssociatedData } from '@claudian-collab/protocol';
import { Client } from 'pg';

import { CoordinationError } from '../../../src/coordination/CoordinationError.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { CLOUD_PROJECT_MEMBERSHIP_SCHEMA } from '../../../src/coordination/postgres/PostgresSchema.js';
import { LeaveCoordinator } from '../../../src/project-authority/lifecycle/leave/LeaveCoordinator.js';
import { RetireCoordinator } from '../../../src/project-authority/lifecycle/retire/RetireCoordinator.js';
import { DeletionCoordinator } from '../../../src/project-authority/lifecycle/delete/DeletionCoordinator.js';
import { TerminalResponderExpiry } from '../../../src/project-authority/lifecycle/retire/TerminalResponderExpiry.js';
import { createTrustedIngressPrincipal } from '../../../src/request-context/IngressPrincipal.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const T0 = '2026-08-25T00:00:00.000Z';
const T1 = '2026-08-25T00:01:00.000Z';
const T2 = '2026-08-25T00:02:00.000Z';
const T3 = '2026-08-25T00:03:00.000Z';
const EXPIRES = '2026-09-24T00:00:00.000Z';
const CHECKPOINT_SHA = 'a'.repeat(64);
const BATCH_SHA = 'b'.repeat(64);
const CLAIM_SHA = 'c'.repeat(64);
const RESULT_SHA = 'd'.repeat(64);
const AUTHORIZATION_SHA = 'e'.repeat(64);

function leaveResponse(projectId: string, memberId: string) {
  return Object.freeze({
    discardedRequestId: null,
    leftAt: T1,
    managerSetGeneration: 1,
    memberId,
    projectId,
    promotedSuccessorMemberId: null,
    status: 'left' as const,
  });
}

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 3,
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
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('claudian_cloud.project_id', $1, true)`,
      [projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation, expected_main_oid,
         service_state, created_at, activated_at
       ) VALUES (
         $1, 'Portable Project', 1, repeat('a', 40), 'active',
         $2::timestamptz, $2::timestamptz
       )`,
      [projectId, T0],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

async function seedMembership(
  database: PostgresTestDatabase,
  projectId: string,
  memberId: string,
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('claudian_cloud.project_id', $1, true)`,
      [projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, role, status, revision, display_name,
         created_at, updated_at
       ) VALUES ($1, $2, 'member', 'active', 1, 'Offline Member',
                 $3::timestamptz, $3::timestamptz)`,
      [projectId, memberId, T0],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

async function seedPlacement(
  database: PostgresTestDatabase,
  projectId: string,
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('claudian_cloud.project_id', $1, true)`,
      [projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, 'local', 'repository_authority_state', 1, true,
                 $2::timestamptz, $2::timestamptz)`,
      [projectId, T0],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, 'local', 'repository_authority_state', 1)`,
      [projectId],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

async function expectStateConflict(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof CoordinationError);
    assert.equal(error.code, 'state-conflict');
    return true;
  });
}

async function expectInvalidRecord(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof CoordinationError);
    assert.equal(error.code, 'invalid-record');
    return true;
  });
}

const PROJECT_TABLES = Object.freeze([
  'authority_transfer_recovery',
  'leave_former_principal_replays',
  'project_backup_catalog',
  'project_deletion_intents',
  'project_lifecycle_journals',
  'project_principal_bindings',
  'project_terminal_acknowledgements',
  'project_terminal_responders',
  'project_tombstones',
  'source_protected_claim_envelopes',
  'transfer_claim_batch_receipts',
  'transfer_receipt_keys',
  'transfer_redemption_receipts',
  'transferred_membership_claims',
]);

describe('portability lifecycle persistence', () => {
  it('applies lifecycle schemas with authority generation and forced Project RLS', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        const history = await migration.query<{
          readonly checksum: string;
          readonly name: string;
          readonly state: string;
          readonly version: number;
        }>(
          `SELECT version, name, checksum, state
             FROM claudian_cloud.schema_migrations
            ORDER BY version`,
        );
        assert.deepEqual(history.rows.at(-1), {
          ...CLOUD_PROJECT_MEMBERSHIP_SCHEMA,
          state: 'applied',
        });

        const projectColumns = await migration.query<{
          readonly column_default: string | null;
          readonly column_name: string;
          readonly is_nullable: string;
        }>(
          `SELECT column_name, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema = 'claudian_cloud'
              AND table_name = 'projects'
              AND column_name = ANY($1::text[])
            ORDER BY column_name`,
          [['authority_generation', 'authority_state_revision']],
        );
        assert.deepEqual(projectColumns.rows, [
          {
            column_default: '1',
            column_name: 'authority_generation',
            is_nullable: 'NO',
          },
          {
            column_default: '1',
            column_name: 'authority_state_revision',
            is_nullable: 'NO',
          },
        ]);
        const membershipColumns = await migration.query<{
          readonly column_name: string;
          readonly is_nullable: string;
        }>(
          `SELECT column_name, is_nullable
             FROM information_schema.columns
            WHERE table_schema = 'claudian_cloud'
              AND table_name = 'project_memberships'
              AND column_name = ANY($1::text[])
            ORDER BY column_name`,
          [['activated_at', 'revoked_at']],
        );
        assert.deepEqual(membershipColumns.rows, [
          { column_name: 'activated_at', is_nullable: 'YES' },
          { column_name: 'revoked_at', is_nullable: 'YES' },
        ]);

        const relations = await migration.query<{
          readonly force_rls: boolean;
          readonly relation: string;
          readonly row_security: boolean;
        }>(
          `SELECT c.relname AS relation,
                  c.relrowsecurity AS row_security,
                  c.relforcerowsecurity AS force_rls
             FROM pg_catalog.pg_class AS c
             JOIN pg_catalog.pg_namespace AS n
               ON n.oid = c.relnamespace
            WHERE n.nspname = 'claudian_cloud'
              AND c.relname = ANY($1::text[])
            ORDER BY c.relname`,
          [PROJECT_TABLES],
        );
        assert.deepEqual(
          relations.rows,
          PROJECT_TABLES.map(relation => ({
            force_rls: true,
            relation,
            row_security: true,
          })),
        );
      } finally {
        await migration.end();
      }
    });
  });

  it('advances service state and authority generation through exact CAS', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-authority-state');
      await seedPlacement(database, 'project-authority-state');
      let store = coordination(database);
      try {
        await store.withProjectScope('project-authority-state', async scope => {
          assert.equal(await scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: 1,
            expectedAuthorityStateRevision: 1,
            expectedServiceState: 'active',
            nextAuthorityGeneration: 1,
            nextServiceState: 'read-only-transition',
          }), 'advanced');
          assert.equal(await scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: 1,
            expectedAuthorityStateRevision: 1,
            expectedServiceState: 'active',
            nextAuthorityGeneration: 1,
            nextServiceState: 'read-only-transition',
          }), 'replayed');
          assert.equal(await scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: 1,
            expectedAuthorityStateRevision: 2,
            expectedServiceState: 'read-only-transition',
            nextAuthorityGeneration: 1,
            nextServiceState: 'active',
          }), 'advanced');
          await expectStateConflict(scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: 1,
            expectedAuthorityStateRevision: 1,
            expectedServiceState: 'active',
            nextAuthorityGeneration: 1,
            nextServiceState: 'read-only-transition',
          }));
          assert.equal(await scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: 1,
            expectedAuthorityStateRevision: 3,
            expectedServiceState: 'active',
            nextAuthorityGeneration: 1,
            nextServiceState: 'read-only-transition',
          }), 'advanced');
          assert.equal(await scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: 1,
            expectedAuthorityStateRevision: 4,
            expectedServiceState: 'read-only-transition',
            nextAuthorityGeneration: 2,
            nextServiceState: 'active',
          }), 'advanced');
          await expectInvalidRecord(scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: 2,
            expectedAuthorityStateRevision: 5,
            expectedServiceState: 'active',
            nextAuthorityGeneration: 4,
            nextServiceState: 'deleting',
          }));
          assert.equal(await scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: 2,
            expectedAuthorityStateRevision: 5,
            expectedServiceState: 'active',
            nextAuthorityGeneration: 2,
            nextServiceState: 'deleting',
          }), 'advanced');
        });
      } finally {
        await store.close();
      }

      store = coordination(database);
      try {
        assert.equal(
          (await store.listActiveRepositoryPlacements()).placements.some(
            placement => placement.projectId === 'project-authority-state',
          ),
          false,
        );
        await store.withProjectScope('project-authority-state', async scope => {
          assert.deepEqual(await scope.getProject(), {
            activatedAt: T0,
            authorityGeneration: 2,
            authorityStateRevision: 6,
            createdAt: T0,
            expectedMainOid: 'a'.repeat(40),
            managerSetGeneration: 1,
            projectId: 'project-authority-state',
            projectName: 'Portable Project',
            serviceState: 'deleting',
          });
          assert.equal(await scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: 2,
            expectedAuthorityStateRevision: 6,
            expectedServiceState: 'deleting',
            nextAuthorityGeneration: 2,
            nextServiceState: 'deleted',
          }), 'advanced');
        });
      } finally {
        await store.close();
      }
    });
  });

  it('constructs an ordinary read facade with lifecycle fences but no mutations', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      try {
        await store.withProjectReadScope('project-read-facade', scope => {
          const dynamic = scope as unknown as Record<string, unknown>;
          assert.equal(
            typeof (dynamic.portability as Record<string, unknown>)
              .getNonterminalLifecycleJournal,
            'function',
          );
          assert.equal(
            (dynamic.portability as Record<string, unknown>).putLifecycleJournal,
            undefined,
          );
          assert.equal(
            typeof (dynamic.membership as Record<string, unknown>).getNonterminalJoin,
            'function',
          );
          assert.equal(
            (dynamic.membership as Record<string, unknown>).prepareJoin,
            undefined,
          );
          assert.equal(dynamic.advanceProjectAuthorityState, undefined);
          assert.equal(dynamic.appendProjectEvent, undefined);
          assert.equal(
            (scope.collaboration.requests as unknown as Record<string, unknown>).create,
            undefined,
          );
          assert.equal(
            (scope.accept as unknown as Record<string, unknown>).prepare,
            undefined,
          );
          return Promise.resolve();
        });
      } finally {
        await store.close();
      }
    });
  });

  it('rejects malformed recovery cursor kinds before pagination', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      try {
        await expectInvalidRecord(store.listRecoveryCandidates({
          after: {
            kind: 'UNKNOWN' as 'delete',
            operationId: 'operation-one',
            projectId: 'project-cursor',
            scheduledAt: T0,
          },
        }));
      } finally {
        await store.close();
      }
    });
  });

  it('persists lifecycle phase CAS and recovery metadata through restart', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      let store = coordination(database);
      const journal = {
        actorMemberId: 'member-manager',
        createdAt: T0,
        direction: 'lan-to-cloud' as const,
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-transfer-one',
        kind: 'authority-transfer' as const,
        operationId: 'transfer-one',
        phase: 'collecting-readiness',
        projectId: 'project-portable',
        requestFingerprint: 'f'.repeat(64),
        scheduledAt: T0,
      };
      try {
        await store.withProjectScope(journal.projectId, async scope => {
          assert.equal(await scope.portability.putLifecycleJournal(journal), 'created');
          assert.equal(await scope.portability.putLifecycleJournal(journal), 'replayed');
          await expectStateConflict(scope.portability.putLifecycleJournal({
            ...journal,
            requestFingerprint: '0'.repeat(64),
          }));
          assert.equal(await scope.portability.advanceLifecycleJournal({
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'collecting-readiness',
            expectedState: 'active',
            nextPhase: 'source-quiesced',
            nextState: 'active',
            operationId: journal.operationId,
            scheduledAt: T1,
            updatedAt: T1,
          }), 'advanced');
          assert.equal(await scope.portability.advanceLifecycleJournal({
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'collecting-readiness',
            expectedState: 'active',
            nextPhase: 'source-quiesced',
            nextState: 'active',
            operationId: journal.operationId,
            scheduledAt: T1,
            updatedAt: T1,
          }), 'replayed');
          assert.deepEqual(
            await scope.portability.getNonterminalLifecycleJournal(),
            await scope.portability.getLifecycleJournal(journal.operationId),
          );
          await expectStateConflict(scope.portability.advanceLifecycleJournal({
            expectedPhase: 'checkpoint-received',
            expectedState: 'active',
            nextPhase: 'claims-retained',
            nextState: 'active',
            operationId: journal.operationId,
            scheduledAt: T2,
            updatedAt: T2,
          }));
        });

        assert.deepEqual(await store.listRecoveryCandidates(), {
          candidates: [{
            kind: 'authority-transfer',
            operationId: journal.operationId,
            projectId: journal.projectId,
            scheduledAt: T1,
          }],
          nextCursor: undefined,
        });
      } finally {
        await store.close();
      }

      store = coordination(database);
      try {
        await store.withProjectScope(journal.projectId, async scope => {
          assert.deepEqual(await scope.portability.getLifecycleJournal(
            journal.operationId,
          ), {
            ...journal,
            checkpointSha256: CHECKPOINT_SHA,
            batchRevision: undefined,
            batchSha256: undefined,
            phase: 'source-quiesced',
            recoveryFromPhase: undefined,
            resultSha256: undefined,
            scheduledAt: T1,
            state: 'active',
            updatedAt: T1,
          });
        });
        await store.withProjectScope(journal.projectId, async scope => {
          assert.equal(await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'source-quiesced',
            expectedState: 'active',
            nextPhase: 'completed',
            nextState: 'completed',
            operationId: journal.operationId,
            resultSha256: RESULT_SHA,
            scheduledAt: T2,
            updatedAt: T2,
          }), 'advanced');
          assert.equal(
            await scope.portability.getNonterminalLifecycleJournal(),
            undefined,
          );
          await expectStateConflict(scope.portability.advanceLifecycleJournal({
            expectedPhase: 'completed',
            expectedState: 'completed',
            nextPhase: 'completed',
            nextState: 'completed',
            operationId: journal.operationId,
            resultSha256: '0'.repeat(64),
            scheduledAt: T3,
            updatedAt: T3,
          }));
        });
        assert.deepEqual(await store.listRecoveryCandidates(), {
          candidates: [],
          nextCursor: undefined,
        });
      } finally {
        await store.close();
      }
    });
  });

  it('scopes lifecycle idempotency by actor and operation kind', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      try {
        await store.withProjectScope('project-idempotency', async scope => {
          const transfer = {
            actorMemberId: 'member-manager',
            createdAt: T0,
            direction: 'lan-to-cloud' as const,
            expectedAuthorityGeneration: 1,
            idempotencyKey: 'shared-intent',
            kind: 'authority-transfer' as const,
            operationId: 'transfer-idempotency',
            phase: 'requested',
            projectId: 'project-idempotency',
            requestFingerprint: '1'.repeat(64),
            scheduledAt: T0,
          };
          assert.equal(
            await scope.portability.putLifecycleJournal(transfer),
            'created',
          );
          assert.equal(await scope.portability.advanceLifecycleJournal({
            expectedPhase: transfer.phase,
            expectedState: 'active',
            nextPhase: 'completed',
            nextState: 'completed',
            operationId: transfer.operationId,
            scheduledAt: T1,
            updatedAt: T1,
          }), 'advanced');

          assert.equal(await scope.portability.putLifecycleJournal({
            ...transfer,
            createdAt: T1,
            direction: undefined,
            kind: 'retire',
            operationId: 'retire-idempotency',
            requestFingerprint: '2'.repeat(64),
            scheduledAt: T1,
          }), 'created');
          assert.equal(await scope.portability.advanceLifecycleJournal({
            expectedPhase: transfer.phase,
            expectedState: 'active',
            nextPhase: 'completed',
            nextState: 'completed',
            operationId: 'retire-idempotency',
            scheduledAt: T2,
            updatedAt: T2,
          }), 'advanced');

          const backup = {
            actorMemberId: undefined,
            createdAt: T2,
            direction: undefined,
            expectedAuthorityGeneration: 1,
            idempotencyKey: 'operator-backup',
            kind: 'backup' as const,
            operationId: 'backup-idempotency-one',
            phase: 'captured',
            projectId: 'project-idempotency',
            requestFingerprint: '3'.repeat(64),
            scheduledAt: T2,
          };
          assert.equal(await scope.portability.putLifecycleJournal(backup), 'created');
          assert.equal(await scope.portability.advanceLifecycleJournal({
            expectedPhase: backup.phase,
            expectedState: 'active',
            nextPhase: 'completed',
            nextState: 'completed',
            operationId: backup.operationId,
            scheduledAt: T3,
            updatedAt: T3,
          }), 'advanced');
          await expectStateConflict(scope.portability.putLifecycleJournal({
            ...backup,
            createdAt: T3,
            operationId: 'backup-idempotency-two',
            scheduledAt: T3,
          }));

          const projectExport = {
            ...backup,
            createdAt: T3,
            idempotencyKey: 'operator-export',
            kind: 'export' as const,
            operationId: 'export-idempotency-one',
            phase: 'captured',
            requestFingerprint: '4'.repeat(64),
            scheduledAt: T3,
          };
          assert.equal(
            await scope.portability.putLifecycleJournal(projectExport),
            'created',
          );
        });
        assert.deepEqual(
          (await store.listRecoveryCandidates()).candidates.at(-1),
          {
            kind: 'export',
            operationId: 'export-idempotency-one',
            projectId: 'project-idempotency',
            scheduledAt: T3,
          },
        );
      } finally {
        await store.close();
      }
    });
  });

  it('persists typed transfer recovery facts and proofs through restart', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      let store = coordination(database);
      const projectId = 'project-transfer-recovery';
      const transferId = 'transfer-recovery';
      const sourceAuthority = { generation: 4, kind: 'cloud' as const };
      const targetAuthority = { generation: 5, kind: 'lan' as const };
      const recovery = {
        createdAt: T0,
        expiresAt: EXPIRES,
        sourceAuthority,
        sourceHostMemberId: undefined,
        targetAuthority,
        targetHostMemberId: 'member-target',
        targetUrl: 'https://lan.example.test',
        transferId,
      };
      const relinquishmentProof = {
        batchRevision: 1,
        batchSha256: BATCH_SHA,
        certificate: 'A'.repeat(86),
        certificateAlgorithm: 'ed25519' as const,
        checkpointSha256: CHECKPOINT_SHA,
        committedAt: T2,
        operationIntentId: 'relinquishment-intent',
        projectId,
        sourceAuthority,
        sourceHostMemberId: null,
        targetAuthority,
        transferId,
      };
      try {
        await store.withProjectScope(projectId, async scope => {
          assert.equal(await scope.portability.putLifecycleJournal({
            actorMemberId: 'member-manager',
            createdAt: T0,
            direction: 'cloud-to-lan',
            expectedAuthorityGeneration: 4,
            idempotencyKey: 'transfer-recovery-intent',
            kind: 'authority-transfer',
            operationId: transferId,
            phase: 'collecting-readiness',
            projectId,
            requestFingerprint: '9'.repeat(64),
            scheduledAt: T0,
          }), 'created');
          assert.equal(
            await scope.portability.putAuthorityTransferRecovery(recovery),
            'created',
          );
          assert.equal(await scope.portability.advanceAuthorityTransferRecoveryEvidence({
            expectedUpdatedAt: T0,
            stageSha256: '8'.repeat(64),
            targetProof: 'target-stage-proof',
            transferId,
            updatedAt: T1,
          }), 'advanced');
          assert.equal(await scope.portability.advanceLifecycleJournal({
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'collecting-readiness',
            expectedState: 'active',
            nextPhase: 'target-staged',
            nextState: 'active',
            operationId: transferId,
            scheduledAt: T1,
            updatedAt: T1,
          }), 'advanced');
          assert.equal(await scope.portability.advanceAuthorityTransferRecoveryEvidence({
            expectedUpdatedAt: T1,
            relinquishmentProof,
            targetActivationProof: 'target-activation-proof',
            targetActivationRequestSha256: AUTHORIZATION_SHA,
            transferId,
            updatedAt: T2,
          }), 'advanced');
          assert.equal(await scope.portability.advanceLifecycleJournal({
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'target-staged',
            expectedState: 'active',
            nextPhase: 'cloud-relinquished',
            nextState: 'active',
            operationId: transferId,
            scheduledAt: T2,
            updatedAt: T2,
          }), 'advanced');
        });
      } finally {
        await store.close();
      }

      store = coordination(database);
      try {
        await store.withProjectScope(projectId, async scope => {
          assert.deepEqual(await scope.portability.getAuthorityTransferRecovery(
            transferId,
          ), {
            ...recovery,
            cancellationRequestSha256: undefined,
            inactivePublicationJson: undefined,
            relinquishmentProof,
            sourceProof: undefined,
            sourceReopenSha256: undefined,
            stageSha256: '8'.repeat(64),
            targetActivationProof: 'target-activation-proof',
            targetActivationRequestSha256: AUTHORIZATION_SHA,
            targetProof: 'target-stage-proof',
            updatedAt: T2,
          });
          assert.deepEqual(await scope.portability.getAuthorityTransferStatus(transferId), {
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            createdAt: T0,
            direction: 'cloud-to-lan',
            expiresAt: EXPIRES,
            phase: 'cloud-relinquished',
            projectId,
            relinquishmentProof,
            sourceAuthority,
            state: 'active',
            targetAuthority,
            targetUrl: recovery.targetUrl,
            transferId,
            updatedAt: T2,
          });
          await expectStateConflict(
            scope.portability.advanceAuthorityTransferRecoveryEvidence({
              expectedUpdatedAt: T2,
              targetProof: 'different-target-proof',
              transferId,
              updatedAt: T3,
            }),
          );
        });
      } finally {
        await store.close();
      }
    });
  });

  it('persists exact LAN cancellation evidence and deletes target claim hashes', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      const projectId = 'project-lan-cancellation';
      const transferId = 'transfer-lan-cancellation';
      const cancellationRequestSha256 = '6'.repeat(64);
      const sourceReopenSha256 = '7'.repeat(64);
      const inactivePublicationJson = '{"status":"inactive"}';
      try {
        await store.withProjectScope(projectId, async scope => {
          await scope.portability.putLifecycleJournal({
            actorMemberId: 'member-host',
            createdAt: T0,
            direction: 'lan-to-cloud',
            expectedAuthorityGeneration: 1,
            idempotencyKey: 'intent-lan-cancellation',
            kind: 'authority-transfer',
            operationId: transferId,
            phase: 'checkpoint-received',
            projectId,
            requestFingerprint: '5'.repeat(64),
            scheduledAt: EXPIRES,
          });
          await scope.portability.putAuthorityTransferRecovery({
            createdAt: T0,
            expiresAt: EXPIRES,
            sourceAuthority: { generation: 1, kind: 'lan' },
            sourceHostMemberId: 'member-host',
            targetAuthority: { generation: 2, kind: 'cloud' },
            targetHostMemberId: undefined,
            targetUrl: 'https://cloud.example.test',
            transferId,
          });
          await scope.portability.advanceAuthorityTransferRecoveryEvidence({
            expectedUpdatedAt: T0,
            sourceProof: 'source-proof',
            transferId,
            updatedAt: T1,
          });
          await scope.portability.advanceLifecycleJournal({
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'checkpoint-received',
            expectedState: 'active',
            nextPhase: 'checkpoint-validated',
            nextState: 'active',
            operationId: transferId,
            scheduledAt: EXPIRES,
            updatedAt: T1,
          });
          await scope.portability.putTransferredMembershipClaim({
            batchRevision: 1,
            checkpointSha256: CHECKPOINT_SHA,
            claimSha256: CLAIM_SHA,
            createdAt: T1,
            expiresAt: EXPIRES,
            memberId: 'member-offline',
            transferId,
          });
          await scope.portability.advanceAuthorityTransferRecoveryEvidence({
            cancellationRequestSha256,
            expectedUpdatedAt: T1,
            inactivePublicationJson,
            transferId,
            updatedAt: T2,
          });
          await scope.portability.advanceLifecycleJournal({
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'checkpoint-validated',
            expectedState: 'active',
            nextPhase: 'target-invalidated',
            nextState: 'active',
            operationId: transferId,
            scheduledAt: EXPIRES,
            updatedAt: T2,
          });
          assert.equal(await scope.portability.deleteTransferredMembershipClaims({
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            transferId,
          }), 'advanced');
          assert.equal(await scope.portability.deleteTransferredMembershipClaims({
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            transferId,
          }), 'replayed');
          assert.equal(
            await scope.portability.findTransferredMembershipClaimBySha256(
              transferId,
              CLAIM_SHA,
            ),
            undefined,
          );
          await scope.portability.advanceAuthorityTransferRecoveryEvidence({
            expectedUpdatedAt: T2,
            sourceReopenSha256,
            transferId,
            updatedAt: T3,
          });
          assert.deepEqual(await scope.portability.getAuthorityTransferRecovery(
            transferId,
          ), {
            cancellationRequestSha256,
            createdAt: T0,
            expiresAt: EXPIRES,
            inactivePublicationJson,
            relinquishmentProof: undefined,
            sourceAuthority: { generation: 1, kind: 'lan' },
            sourceHostMemberId: 'member-host',
            sourceProof: 'source-proof',
            sourceReopenSha256,
            stageSha256: undefined,
            targetActivationProof: undefined,
            targetActivationRequestSha256: undefined,
            targetAuthority: { generation: 2, kind: 'cloud' },
            targetHostMemberId: undefined,
            targetProof: undefined,
            targetUrl: 'https://cloud.example.test',
            transferId,
            updatedAt: T3,
          });
          await expectStateConflict(
            scope.portability.advanceAuthorityTransferRecoveryEvidence({
              cancellationRequestSha256: '8'.repeat(64),
              expectedUpdatedAt: T3,
              transferId,
              updatedAt: new Date(Date.parse(T3) + 1_000).toISOString(),
            }),
          );
        });
      } finally {
        await store.close();
      }
    });
  });

  it('limits Leave recovery to the exact revoked former principal', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const projectId = 'project-leave-replay';
      const memberId = 'member-leaving';
      await seedProject(database, projectId);
      await seedMembership(database, projectId, memberId);
      let store = coordination(database);
      const locator = {
        createdAt: T1,
        expectedPersonalRefOid: '9'.repeat(40),
        expiresAt: EXPIRES,
        intentId: 'leave-intent',
        memberId,
        operationId: 'leave-operation',
        principalId: 'principal:leaving',
        requestFingerprint: '7'.repeat(64),
        response: leaveResponse(projectId, memberId),
      };
      try {
        await store.withProjectScope(projectId, async scope => {
          assert.equal(await scope.portability.bindProjectPrincipal({
            boundAt: T0,
            memberId,
            principalId: locator.principalId,
          }), 'created');
          assert.equal(await scope.portability.putLifecycleJournal({
            actorMemberId: memberId,
            createdAt: T0,
            direction: undefined,
            expectedAuthorityGeneration: 1,
            expectedPersonalRefOid: locator.expectedPersonalRefOid,
            idempotencyKey: locator.intentId,
            kind: 'leave',
            operationId: locator.operationId,
            phase: 'prepared',
            projectId,
            requestFingerprint: locator.requestFingerprint,
            scheduledAt: T0,
          }), 'created');
          assert.equal(
            await scope.portability.putLeaveFormerPrincipalReplay(locator),
            'created',
          );
          assert.equal(await scope.portability.revokeProjectPrincipal({
            memberId,
            principalId: locator.principalId,
            revokedAt: T1,
          }), 'advanced');
          assert.equal(await scope.findPrincipalMember(locator.principalId), undefined);
          assert.equal(await scope.portability.findLeaveFormerPrincipalReplay({
            ...locator,
            requestFingerprint: '8'.repeat(64),
            requestedAt: T2,
          }), undefined);
          assert.deepEqual(await scope.portability.findLeaveFormerPrincipalReplay({
            intentId: locator.intentId,
            memberId,
            operationId: locator.operationId,
            principalId: locator.principalId,
            requestFingerprint: locator.requestFingerprint,
            expectedPersonalRefOid: locator.expectedPersonalRefOid,
            requestedAt: T2,
          }), {
            completedAt: undefined,
            createdAt: T1,
            expiresAt: EXPIRES,
            expectedPersonalRefOid: locator.expectedPersonalRefOid,
            intentId: locator.intentId,
            memberId,
            operationId: locator.operationId,
            response: locator.response,
            resultSha256: undefined,
            state: 'recovering',
          });
          assert.equal(await scope.portability.findLeaveFormerPrincipalReplay({
            intentId: locator.intentId,
            memberId,
            operationId: locator.operationId,
            principalId: 'principal:other',
            requestFingerprint: locator.requestFingerprint,
            expectedPersonalRefOid: locator.expectedPersonalRefOid,
            requestedAt: T2,
          }), undefined);
          assert.equal(await scope.portability.completeLeaveFormerPrincipalReplay({
            completedAt: T2,
            intentId: locator.intentId,
            memberId,
            operationId: locator.operationId,
            principalId: locator.principalId,
            requestFingerprint: locator.requestFingerprint,
            expectedPersonalRefOid: locator.expectedPersonalRefOid,
            resultSha256: RESULT_SHA,
          }), 'advanced');
        });
      } finally {
        await store.close();
      }
      store = coordination(database);
      try {
        await store.withProjectScope(projectId, async scope => {
          assert.deepEqual(await scope.portability.findLeaveFormerPrincipalReplay({
            intentId: locator.intentId,
            memberId,
            operationId: locator.operationId,
            principalId: locator.principalId,
            requestFingerprint: locator.requestFingerprint,
            expectedPersonalRefOid: locator.expectedPersonalRefOid,
            requestedAt: T3,
          }), {
            completedAt: T2,
            createdAt: T1,
            expiresAt: EXPIRES,
            expectedPersonalRefOid: locator.expectedPersonalRefOid,
            intentId: locator.intentId,
            memberId,
            operationId: locator.operationId,
            response: locator.response,
            resultSha256: RESULT_SHA,
            state: 'completed',
          });
        });
      } finally {
        await store.close();
      }
    });
  });

  it('settles Leave membership and all principal bindings through exact replay', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const projectId = 'project-leave-settlement';
      const memberId = 'member-leaving';
      const principalId = 'principal:leaving';
      const operationId = 'leave-settlement';
      await seedProject(database, projectId);
      await seedMembership(database, projectId, memberId);
      const store = coordination(database);
      try {
        await store.withProjectScope(projectId, async scope => {
          await scope.portability.bindProjectPrincipal({
            boundAt: T0,
            memberId,
            principalId,
          });
          await scope.portability.putLifecycleJournal({
            actorMemberId: memberId,
            createdAt: T0,
            direction: undefined,
            expectedAuthorityGeneration: 1,
            expectedPersonalRefOid: '9'.repeat(40),
            idempotencyKey: 'leave-settlement-intent',
            kind: 'leave',
            operationId,
            phase: 'prepared',
            projectId,
            requestFingerprint: '7'.repeat(64),
            scheduledAt: T0,
          });
          await scope.portability.putLeaveFormerPrincipalReplay({
            createdAt: T1,
            expectedPersonalRefOid: '9'.repeat(40),
            expiresAt: EXPIRES,
            intentId: 'leave-settlement-intent',
            memberId,
            operationId,
            principalId,
            requestFingerprint: '7'.repeat(64),
            response: leaveResponse(projectId, memberId),
          });
          assert.deepEqual(await scope.portability.settleLeaveMembership({
            expectedManagerSetGeneration: 1,
            expectedMembershipRevision: 1n,
            expectedOfferRevision: null,
            leftAt: T1,
            managerResponsibilityOfferId: null,
            memberId,
            operationId,
          }), {
            response: leaveResponse(projectId, memberId),
            status: 'settled',
          });
          await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'prepared',
            expectedState: 'active',
            nextPhase: 'membership-left',
            nextState: 'active',
            operationId,
            scheduledAt: T0,
            updatedAt: T1,
          });
          assert.deepEqual(await scope.findMembership(memberId), {
            displayName: 'Offline Member',
            memberId,
            revision: 2n,
            role: 'member',
            status: 'left',
          });
          assert.equal(
            (await scope.portability.findProjectPrincipalBinding(principalId))?.state,
            'revoked',
          );
          assert.deepEqual(await scope.portability.settleLeaveMembership({
            expectedManagerSetGeneration: 1,
            expectedMembershipRevision: 1n,
            expectedOfferRevision: null,
            leftAt: T1,
            managerResponsibilityOfferId: null,
            memberId,
            operationId,
          }), {
            response: leaveResponse(projectId, memberId),
            status: 'replayed',
          });
        });
      } finally {
        await store.close();
      }
    });
  });

  it('scopes equal Leave idempotency keys to their exact membership actors', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const projectId = 'project-leave-actor-scope';
      const actors = [
        { memberId: 'member-leaving-a', oid: '8'.repeat(40),
          principalId: 'principal:leaving-a' },
        { memberId: 'member-leaving-b', oid: '9'.repeat(40),
          principalId: 'principal:leaving-b' },
      ] as const;
      await seedProject(database, projectId);
      await seedPlacement(database, projectId);
      for (const actor of actors) {
        await seedMembership(database, projectId, actor.memberId);
      }
      const store = coordination(database);
      try {
        await store.withProjectScope(projectId, async scope => {
          for (const actor of actors) {
            await scope.portability.bindProjectPrincipal({
              boundAt: T0,
              memberId: actor.memberId,
              principalId: actor.principalId,
            });
          }
        });
        const removed = new Set<string>();
        const leave = new LeaveCoordinator({
          clock: () => new Date(T1),
          coordination: store,
          repository: {
            reserveExactRepositoryOperation() {
              return Promise.resolve({ async close() {}, projectId });
            },
            verifyExactPersonalRef(_reservation, input) {
              assert.equal(
                actors.some(actor => (
                  input.personalRef.endsWith(actor.memberId)
                  && input.expectedOid === actor.oid
                )),
                true,
              );
              return Promise.resolve();
            },
            deleteExactPersonalRef(_reservation, input) {
              removed.add(input.personalRef);
              return Promise.resolve('deleted');
            },
          },
        });
        const results = [];
        for (const actor of actors) {
          results.push(await leave.leave(
            createTrustedIngressPrincipal({
              principalId: actor.principalId,
              providerId: 'test',
            }),
            {
              expectedManagerSetGeneration: 1,
              expectedMembershipRevision: 1,
              expectedOfferRevision: null,
              expectedPersonalRefOid: actor.oid,
              idempotencyKey: 'shared-leave-intent',
              managerResponsibilityOfferId: null,
              projectId,
            },
          ));
        }
        assert.deepEqual(results.map(result => result.memberId), [
          actors[0].memberId,
          actors[1].memberId,
        ]);
        assert.equal(removed.size, 2);
      } finally {
        await store.close();
      }
    });
  });

  it('atomically terminalizes Retire and creates one deletion handoff', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const projectId = 'project-retire-settlement';
      const memberId = 'member-manager';
      const principalId = 'principal:manager';
      await seedProject(database, projectId);
      await seedMembership(database, projectId, memberId);
      await seedPlacement(database, projectId);
      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        await migration.query('BEGIN');
        await migration.query(
          `SELECT set_config('claudian_cloud.project_id', $1, true)`,
          [projectId],
        );
        await migration.query(
          `UPDATE claudian_cloud.project_memberships
              SET role = 'manager'
            WHERE project_id = $1 AND member_id = $2`,
          [projectId, memberId],
        );
        await migration.query('COMMIT');
      } finally {
        await migration.end();
      }
      const store = coordination(database);
      try {
        await store.withProjectScope(projectId, async scope => {
          await scope.portability.bindProjectPrincipal({
            boundAt: T0,
            memberId,
            principalId,
          });
        });
        const coordinator = new RetireCoordinator({
          clock: () => new Date(T1),
          coordination: store,
          repository: {
            reserveExactRepositoryOperation() {
              return Promise.resolve({ async close() {}, projectId });
            },
            async verifyExactRepository() {},
          },
        });
        const request = {
          expectedAuthorityGeneration: 1,
          expectedMainOid: 'a'.repeat(40),
          idempotencyKey: 'retire-settlement-intent',
          projectId,
        };
        const result = await coordinator.retire({ principalId, request });
        assert.deepEqual(
          await coordinator.retire({ principalId, request }),
          result,
        );
        const acknowledgement = await coordinator.acknowledge({
          principalId,
          request: {
            idempotencyKey: 'retire-acknowledgement',
            projectId,
            retirementId: result.retirementId,
          },
        });
        assert.equal(acknowledgement.retirementId, result.retirementId);
        assert.deepEqual(
          await coordinator.retire({ principalId, request }),
          result,
        );
        let deletionAuthorization: string | undefined;
        let deletionOperationId: string | undefined;
        await store.withProjectScope(projectId, async scope => {
          const project = await scope.getProject();
          const retirement = await scope.portability.getLifecycleJournal(
            result.retirementId,
          );
          const deletion = await scope.portability.getNonterminalLifecycleJournal();
          const intent = deletion === undefined
            ? undefined
            : await scope.portability.getDeletionIntent(deletion.operationId);
          const responder = await scope.portability.getTerminalResponder(
            'retire',
            result.retirementId,
          );
          assert.ok(project);
          assert.ok(retirement);
          assert.ok(deletion);
          assert.ok(intent);
          assert.ok(responder);
          assert.equal(project.serviceState, 'deleting');
          assert.equal(retirement.state, 'completed');
          assert.equal(retirement.phase, 'completed');
          assert.equal(deletion.kind, 'delete');
          assert.equal(deletion.phase, 'traffic-denied');
          assert.equal(intent.reason, 'retire');
          assert.equal(responder.acknowledgements.length, 1);
          deletionAuthorization = intent.authorizationSha256;
          deletionOperationId = intent.operationId;
        });
        assert.ok(deletionAuthorization);
        assert.ok(deletionOperationId);
        const exactDeletionAuthorization = deletionAuthorization;
        const exactDeletionOperationId = deletionOperationId;
        const expiry = new TerminalResponderExpiry({ coordination: store });
        assert.equal(await expiry.expire({
          operationId: result.retirementId,
          operationKind: 'retire',
          projectId,
          removedAt: T3,
        }), 'expired');
        await store.withProjectScope(projectId, async scope => {
          assert.equal(
            await scope.portability.getTerminalResponder(
              'retire',
              result.retirementId,
            ),
            undefined,
          );
          assert.equal(
            (await scope.portability.getProjectTombstone())?.terminalOperationId,
            result.retirementId,
          );
          assert.equal(
            (await scope.portability.getLifecycleJournal(
              exactDeletionOperationId,
            ))?.phase,
            'traffic-denied',
          );
        });
        let repositoryRemovals = 0;
        const deletionCoordinator = new DeletionCoordinator({
          clock: () => new Date(T2),
          coordination: store,
          repository: {
            reserveExactRepositoryOperation() {
              return Promise.resolve({ async close() {}, projectId });
            },
            async verifyExactRepository() {},
            removeExactRepository(_reservation, identity) {
              assert.equal(identity.projectId, projectId);
              repositoryRemovals += 1;
              return Promise.resolve('removed');
            },
          },
        });
        assert.equal(await deletionCoordinator.resumeAuthorized({
          authorizationSha256: exactDeletionAuthorization,
          operationId: exactDeletionOperationId,
          projectId,
        }), 'settled');
        assert.equal(repositoryRemovals, 1);
        await store.withProjectScope(projectId, async scope => {
          assert.equal(await scope.getProject(), undefined);
          assert.equal(
            (await scope.portability.getLifecycleJournal(
              exactDeletionOperationId,
            ))?.state,
            'completed',
          );
          assert.equal(
            (await scope.portability.getProjectTombstone())?.terminalOperationId,
            result.retirementId,
          );
        });
      } finally {
        await store.close();
      }
    });
  });

  it('separates target claim hashes from protected source custody', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seedProject(database, 'project-claims');
      await seedMembership(database, 'project-claims', 'member-offline');
      const store = coordination(database);
      try {
        await store.withProjectScope('project-claims', async scope => {
          await scope.portability.putLifecycleJournal({
            actorMemberId: 'member-manager',
            createdAt: T0,
            direction: 'cloud-to-lan',
            expectedAuthorityGeneration: 4,
            idempotencyKey: 'intent-transfer-claims',
            kind: 'authority-transfer',
            operationId: 'transfer-claims',
            phase: 'target-staged',
            projectId: 'project-claims',
            requestFingerprint: 'f'.repeat(64),
            scheduledAt: T0,
          });
          assert.equal(await scope.portability.advanceLifecycleJournal({
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'target-staged',
            expectedState: 'active',
            nextPhase: 'claims-retained',
            nextState: 'active',
            operationId: 'transfer-claims',
            scheduledAt: T0,
            updatedAt: T0,
          }), 'advanced');
          const targetClaim = {
            batchRevision: 1,
            checkpointSha256: CHECKPOINT_SHA,
            claimSha256: CLAIM_SHA,
            createdAt: T0,
            expiresAt: EXPIRES,
            memberId: 'member-offline',
            transferId: 'transfer-claims',
          };
          assert.equal(
            await scope.portability.putTransferredMembershipClaim(targetClaim),
            'created',
          );
          assert.equal(
            await scope.portability.putTransferredMembershipClaim(targetClaim),
            'replayed',
          );
          assert.deepEqual(
            await scope.portability.findTransferredMembershipClaimBySha256(
              targetClaim.transferId,
              targetClaim.claimSha256,
            ),
            await scope.portability.getTransferredMembershipClaim(
              targetClaim.transferId,
              targetClaim.memberId,
            ),
          );
          assert.equal(
            await scope.portability.findTransferredMembershipClaimBySha256(
              targetClaim.transferId,
              '9'.repeat(64),
            ),
            undefined,
          );

          const receiptKey = {
            createdAt: T0,
            publicKey: 'A'.repeat(43),
            receiptKeyId: 'receipt-key-one',
            transferId: 'transfer-claims',
          };
          assert.equal(await scope.portability.putTransferReceiptKey(receiptKey), 'created');
          const receipt = {
            checkpointSha256: CHECKPOINT_SHA,
            claimSha256: CLAIM_SHA,
            memberId: targetClaim.memberId,
            operationIntentId: 'redeem-intent-one',
            projectId: 'project-claims',
            receiptId: 'redemption-one',
            receiptKeyId: receiptKey.receiptKeyId,
            redeemedAt: T1,
            signature: 'A'.repeat(86),
            signatureAlgorithm: 'ed25519' as const,
            targetAuthorityGeneration: 5,
            transferId: targetClaim.transferId,
          };
          await expectInvalidRecord(
            scope.portability.redeemTransferredMembershipClaim({
              claimSha256: CLAIM_SHA,
              memberId: targetClaim.memberId,
              operationIntentId: receipt.operationIntentId,
              receipt: { ...receipt, checkpointSha256: 'b'.repeat(64) },
              targetPrincipalId: 'principal:offline',
              transferId: targetClaim.transferId,
              updatedAt: T1,
            }),
          );
          await expectInvalidRecord(
            scope.portability.redeemTransferredMembershipClaim({
              claimSha256: CLAIM_SHA,
              memberId: targetClaim.memberId,
              operationIntentId: receipt.operationIntentId,
              receipt: { ...receipt, targetAuthorityGeneration: 999 },
              targetPrincipalId: 'principal:offline',
              transferId: targetClaim.transferId,
              updatedAt: T1,
            }),
          );
          assert.deepEqual(await scope.portability.redeemTransferredMembershipClaim({
            claimSha256: CLAIM_SHA,
            memberId: targetClaim.memberId,
            operationIntentId: receipt.operationIntentId,
            receipt,
            targetPrincipalId: 'principal:offline',
            transferId: targetClaim.transferId,
            updatedAt: T1,
          }), receipt);
          assert.deepEqual(await scope.portability.redeemTransferredMembershipClaim({
            claimSha256: CLAIM_SHA,
            memberId: targetClaim.memberId,
            operationIntentId: receipt.operationIntentId,
            receipt,
            targetPrincipalId: 'principal:offline',
            transferId: targetClaim.transferId,
            updatedAt: T1,
          }), receipt);
          assert.deepEqual(
            await scope.portability.findProjectPrincipalBinding('principal:offline'),
            {
              boundAt: T1,
              memberId: targetClaim.memberId,
              principalId: 'principal:offline',
              revokedAt: undefined,
              state: 'active',
            },
          );
          assert.deepEqual(
            await scope.portability.listActiveProjectPrincipalBindings(),
            [{
              boundAt: T1,
              memberId: targetClaim.memberId,
              principalId: 'principal:offline',
              revokedAt: undefined,
              state: 'active',
            }],
          );
          assert.equal(
            await scope.findPrincipalMember('principal:offline'),
            targetClaim.memberId,
          );
          await expectStateConflict(scope.portability.redeemTransferredMembershipClaim({
            claimSha256: CLAIM_SHA,
            memberId: targetClaim.memberId,
            operationIntentId: receipt.operationIntentId,
            receipt,
            targetPrincipalId: 'principal:other',
            transferId: targetClaim.transferId,
            updatedAt: T1,
          }));

          const associatedData = {
            authorityGeneration: 4,
            checkpointSha256: CHECKPOINT_SHA,
            claimSha256: CLAIM_SHA,
            envelopeVersion: 1 as const,
            environmentIdentity: 'environment-one',
            memberId: targetClaim.memberId,
            projectId: 'project-claims',
            transferId: targetClaim.transferId,
          };
          const protectedEnvelope = {
            associatedData,
            associatedDataSha256: createHash('sha256')
              .update(encodeCollabProtectedClaimAssociatedData(associatedData))
              .digest('hex'),
            ciphertext: 'AQ',
            createdAt: T0,
            encryptionAlgorithm: 'xchacha20-poly1305' as const,
            expiresAt: EXPIRES,
            keyId: 'claim-key-one',
            keyVersion: 1,
            memberId: targetClaim.memberId,
            nonce: 'A'.repeat(32),
            receiptKeyId: receiptKey.receiptKeyId,
            tag: 'A'.repeat(22),
            transferId: targetClaim.transferId,
          };
          assert.equal(
            await scope.portability.putProtectedClaimEnvelope(protectedEnvelope),
            'created',
          );
          await expectInvalidRecord(scope.portability.putProtectedClaimEnvelope({
            ...protectedEnvelope,
            associatedDataSha256: '9'.repeat(64),
          }));
          assert.deepEqual(
            await scope.portability.getProtectedClaimEnvelope(
              targetClaim.transferId,
              targetClaim.memberId,
            ),
            protectedEnvelope,
          );
          await expectInvalidRecord(scope.portability.scrubProtectedClaimEnvelope({
            acknowledgedAt: T2,
            memberId: targetClaim.memberId,
            receipt: { ...receipt, checkpointSha256: 'b'.repeat(64) },
            transferId: targetClaim.transferId,
          }));
          assert.equal(await scope.portability.scrubProtectedClaimEnvelope({
            acknowledgedAt: T2,
            memberId: targetClaim.memberId,
            receipt,
            transferId: targetClaim.transferId,
          }), 'scrubbed');
          assert.equal(await scope.portability.scrubProtectedClaimEnvelope({
            acknowledgedAt: T2,
            memberId: targetClaim.memberId,
            receipt,
            transferId: targetClaim.transferId,
          }), 'replayed');
          assert.equal(await scope.portability.getProtectedClaimEnvelope(
            targetClaim.transferId,
            targetClaim.memberId,
          ), undefined);
          const terminalStatus = {
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            createdAt: T0,
            direction: 'cloud-to-lan' as const,
            expiresAt: EXPIRES,
            phase: 'completed' as const,
            projectId: 'project-claims',
            relinquishmentProof: {
              batchRevision: 1,
              batchSha256: BATCH_SHA,
              certificate: 'A'.repeat(86),
              certificateAlgorithm: 'ed25519' as const,
              checkpointSha256: CHECKPOINT_SHA,
              committedAt: T1,
              operationIntentId: 'relinquishment-claims',
              projectId: 'project-claims',
              sourceAuthority: { generation: 4, kind: 'cloud' as const },
              sourceHostMemberId: null,
              targetAuthority: { generation: 5, kind: 'lan' as const },
              transferId: targetClaim.transferId,
            },
            sourceAuthority: { generation: 4, kind: 'cloud' as const },
            state: 'completed' as const,
            targetAuthority: { generation: 5, kind: 'lan' as const },
            targetUrl: 'https://lan.example.test',
            transferId: targetClaim.transferId,
            updatedAt: T2,
          };
          const terminalJson = JSON.stringify(terminalStatus);
          assert.equal(await scope.portability.putTerminalResponder({
            createdAt: T2,
            eligiblePrincipals: [{
              memberId: targetClaim.memberId,
              principalId: 'principal:offline',
            }],
            expiresAt: EXPIRES,
            operationId: targetClaim.transferId,
            operationKind: 'authority-transfer',
            replayAuthorization: {
              memberId: targetClaim.memberId,
              requestSha256: AUTHORIZATION_SHA,
            },
            responseJson: terminalJson,
            responseSha256: createHash('sha256').update(terminalJson).digest('hex'),
          }), 'created');
          assert.deepEqual((await scope.portability.getTerminalResponder(
            'authority-transfer',
            targetClaim.transferId,
          )), {
            acknowledgements: [{
              acknowledgedAt: T2,
              memberId: targetClaim.memberId,
              principalId: 'principal:offline',
            }],
            createdAt: T2,
            eligiblePrincipals: [],
            expiresAt: EXPIRES,
            operationId: targetClaim.transferId,
            operationKind: 'authority-transfer',
            replayAuthorization: {
              memberId: targetClaim.memberId,
              requestSha256: AUTHORIZATION_SHA,
            },
            responseJson: terminalJson,
            responseSha256: createHash('sha256').update(terminalJson).digest('hex'),
          });
          const pendingAssociatedData = {
            ...associatedData,
            claimSha256: '8'.repeat(64),
            memberId: 'member-pending',
          };
          const pendingEnvelope = {
            ...protectedEnvelope,
            associatedData: pendingAssociatedData,
            associatedDataSha256: createHash('sha256')
              .update(encodeCollabProtectedClaimAssociatedData(pendingAssociatedData))
              .digest('hex'),
            ciphertext: 'Ag',
            memberId: 'member-pending',
          };
          assert.equal(
            await scope.portability.putProtectedClaimEnvelope(pendingEnvelope),
            'created',
          );
          await expectStateConflict(scope.portability.deleteProtectedClaimEnvelopes({
            checkpointSha256: '9'.repeat(64),
            transferId: targetClaim.transferId,
          }));
          assert.equal(await scope.portability.deleteProtectedClaimEnvelopes({
            checkpointSha256: CHECKPOINT_SHA,
            transferId: targetClaim.transferId,
          }), 'advanced');
          assert.equal(await scope.portability.deleteProtectedClaimEnvelopes({
            checkpointSha256: CHECKPOINT_SHA,
            transferId: targetClaim.transferId,
          }), 'replayed');
        });
      } finally {
        await store.close();
      }
    });
  });

  it('keeps imported claim overrides monotonic and resolves one effective redemption authority', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const projectId = 'project-claim-overrides';
      const transferId = 'transfer-claim-overrides';
      const importedMemberId = 'member-imported-override';
      const managerMemberId = 'member-claim-manager';
      await seedProject(database, projectId);
      await seedMembership(database, projectId, importedMemberId);
      await seedMembership(database, projectId, managerMemberId);
      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        await migration.query('BEGIN');
        await migration.query(
          `SELECT set_config('claudian_cloud.project_id', $1, true)`,
          [projectId],
        );
        await migration.query(
          `UPDATE claudian_cloud.project_memberships
              SET role = 'manager'
            WHERE project_id = $1 AND member_id = $2`,
          [projectId, managerMemberId],
        );
        await migration.query(
          `INSERT INTO claudian_cloud.project_lifecycle_journals (
             project_id, operation_id, kind, direction, phase,
             recovery_from_phase, state, expected_authority_generation,
             actor_member_id, idempotency_key, request_fingerprint,
             checkpoint_sha256, batch_revision, batch_sha256, result_sha256,
             scheduled_at, created_at, updated_at
           ) VALUES (
             $1, $2, 'authority-transfer', 'lan-to-cloud', 'completed', NULL,
             'completed', 4, $3, 'claim-override-transfer-key', $4,
             $5, 1, $6, NULL, $7, $7, $7
           )`,
          [
            projectId,
            transferId,
            managerMemberId,
            '8'.repeat(64),
            CHECKPOINT_SHA,
            BATCH_SHA,
            T0,
          ],
        );
        await migration.query('COMMIT');
      } finally {
        await migration.end();
      }
      const store = coordination(database);
      try {
        await store.withProjectScope(projectId, async scope => {
          await scope.portability.putTransferredMembershipClaim({
            batchRevision: 1,
            checkpointSha256: CHECKPOINT_SHA,
            claimSha256: CLAIM_SHA,
            createdAt: T0,
            expiresAt: EXPIRES,
            memberId: importedMemberId,
            transferId,
          });
          const original = (await scope.membership.listProjectMembers({
            actorRole: 'manager',
            now: T1,
          })).members.find(member => member.memberId === importedMemberId);
          assert.equal(original?.importedClaimState, 'original-active');
          assert.equal(original.importedClaimGeneration, 0);
          const redacted = (await scope.membership.listProjectMembers({
            actorRole: 'member',
            now: T1,
          })).members.find(member => member.memberId === importedMemberId);
          assert.equal(redacted?.importedClaimState, 'hidden');
          assert.equal(redacted.importedClaimGeneration, null);
          assert.deepEqual(
            await scope.membership.getImportedMembershipClaimFacts(
              importedMemberId,
              T1,
            ),
            {
              claimGeneration: 0,
              claimSha256: CLAIM_SHA,
              memberId: importedMemberId,
              transferId,
            },
          );
          const firstDigest = '1'.repeat(64);
          const firstExpires = new Date(
            Date.parse(T1) + 30 * 24 * 60 * 60 * 1_000,
          ).toISOString();
          const first = {
            actorMemberId: managerMemberId,
            claimGeneration: 1,
            claimSha256: firstDigest,
            createdAt: T1,
            envelope: {
              algorithm: 'xchacha20-poly1305' as const,
              associatedDataSha256: '2'.repeat(64),
              ciphertext: Buffer.alloc(43, 2).toString('base64url'),
              claimGeneration: 1,
              createdAt: T1,
              expiresAt: firstExpires,
              keyId: 'claim-override-key',
              keyVersion: 1,
              memberId: importedMemberId,
              nonce: Buffer.alloc(24, 3).toString('base64url'),
              projectId,
              tag: Buffer.alloc(16, 4).toString('base64url'),
              transferId,
            },
            expectedClaimGeneration: 0,
            expectedManagerSetGeneration: 1,
            expectedMembershipRevision: 1,
            expiresAt: firstExpires,
            idempotencyKey: 'claim-override-first',
            memberId: importedMemberId,
            projectId,
            requestFingerprint: '3'.repeat(64),
            secretReplayExpiresAt: firstExpires,
            transferId,
          };
          assert.equal((await scope.membership.reissueTransferredMembershipClaim(
            first,
          )).status, 'created');
          const overridden = (await scope.membership.listProjectMembers({
            actorRole: 'manager',
            now: T1,
          })).members.find(member => member.memberId === importedMemberId);
          assert.equal(overridden?.importedClaimState, 'override-active');
          assert.equal(overridden.importedClaimGeneration, 1);
          assert.equal((await scope.membership.reissueTransferredMembershipClaim(
            first,
          )).status, 'replayed');
          assert.equal(await scope.membership.resolveEffectiveTransferredMembershipClaim(
            transferId,
            CLAIM_SHA,
            T2,
          ), undefined);
          assert.equal((await scope.membership.resolveEffectiveTransferredMembershipClaim(
            transferId,
            firstDigest,
            T2,
          ))?.claimGeneration, 1);
          assert.equal((await scope.membership.revokeTransferredMembershipClaim({
            actorMemberId: managerMemberId,
            expectedClaimGeneration: 1,
            expectedManagerSetGeneration: 1,
            expectedMembershipRevision: 1,
            idempotencyKey: 'claim-override-revoke',
            memberId: importedMemberId,
            projectId,
            requestFingerprint: '4'.repeat(64),
            revokedAt: T2,
          })).status, 'created');

          const secondDigest = '5'.repeat(64);
          const revoked = (await scope.membership.listProjectMembers({
            actorRole: 'manager',
            now: T2,
          })).members.find(member => member.memberId === importedMemberId);
          assert.equal(revoked?.importedClaimState, 'revoked');
          assert.equal(revoked.importedClaimGeneration, 1);
          const secondExpires = new Date(
            Date.parse(T3) + 30 * 24 * 60 * 60 * 1_000,
          ).toISOString();
          const second = {
            ...first,
            claimGeneration: 2,
            claimSha256: secondDigest,
            createdAt: T3,
            envelope: {
              ...first.envelope,
              associatedDataSha256: '6'.repeat(64),
              claimGeneration: 2,
              createdAt: T3,
              expiresAt: secondExpires,
            },
            expectedClaimGeneration: 1,
            expiresAt: secondExpires,
            idempotencyKey: 'claim-override-second',
            requestFingerprint: '7'.repeat(64),
            secretReplayExpiresAt: secondExpires,
          };
          assert.equal((await scope.membership.reissueTransferredMembershipClaim(
            second,
          )).status, 'created');
          assert.equal(await scope.membership.resolveEffectiveTransferredMembershipClaim(
            transferId,
            firstDigest,
            T3,
          ), undefined);
          const effective = await scope.membership
            .resolveEffectiveTransferredMembershipClaim(
              transferId,
              secondDigest,
              T3,
            );
          assert.ok(effective);
          assert.equal(effective.kind, 'override');
          await scope.portability.putTransferReceiptKey({
            createdAt: T0,
            publicKey: 'A'.repeat(43),
            receiptKeyId: 'claim-override-receipt-key',
            transferId,
          });
          const redeemedAt = '2026-08-25T00:04:00.000Z';
          const receipt = {
            checkpointSha256: CHECKPOINT_SHA,
            claimSha256: secondDigest,
            memberId: importedMemberId,
            operationIntentId: 'claim-override-redemption-intent',
            projectId,
            receiptId: 'claim-override-redemption-receipt',
            receiptKeyId: 'claim-override-receipt-key',
            redeemedAt,
            signature: 'A'.repeat(86),
            signatureAlgorithm: 'ed25519' as const,
            targetAuthorityGeneration: 5,
            transferId,
          };
          assert.deepEqual(
            await scope.membership.redeemTransferredMembershipClaimOverride({
              claim: effective,
              operationIntentId: receipt.operationIntentId,
              receipt,
              targetPrincipalId: 'principal:claim-override',
              updatedAt: redeemedAt,
            }),
            receipt,
          );
          const redeemed = (await scope.membership.listProjectMembers({
            actorRole: 'manager',
            now: redeemedAt,
          })).members.find(member => (
            member.memberId === importedMemberId
          ));
          assert.equal(redeemed?.importedClaimState, 'redeemed');
          assert.equal(redeemed.importedClaimGeneration, 2);
        });
      } finally {
        await store.close();
      }
    });
  });

  it('rotates complete claim batches and permanently revokes older revisions', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      const transferId = 'transfer-rotation';
      const projectId = 'project-rotation';
      const batchOneSha = '1'.repeat(64);
      const batchTwoSha = '2'.repeat(64);
      const initialClaims = [
        { claimSha256: '3'.repeat(64), memberId: 'member-a' },
        { claimSha256: '4'.repeat(64), memberId: 'member-b' },
      ] as const;
      const replacements = [
        { claimSha256: '5'.repeat(64), expiresAt: EXPIRES, memberId: 'member-a' },
        { claimSha256: '6'.repeat(64), expiresAt: EXPIRES, memberId: 'member-b' },
      ] as const;
      try {
        await store.withProjectScope(projectId, async scope => {
          await scope.portability.putLifecycleJournal({
            actorMemberId: 'member-manager',
            createdAt: T0,
            direction: 'lan-to-cloud',
            expectedAuthorityGeneration: 3,
            idempotencyKey: 'intent-rotation',
            kind: 'authority-transfer',
            operationId: transferId,
            phase: 'checkpoint-validated',
            projectId,
            requestFingerprint: '7'.repeat(64),
            scheduledAt: T0,
          });
          assert.equal(await scope.portability.advanceLifecycleJournal({
            batchRevision: 1,
            batchSha256: batchOneSha,
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'checkpoint-validated',
            expectedState: 'active',
            nextPhase: 'claims-retained',
            nextState: 'active',
            operationId: transferId,
            scheduledAt: T0,
            updatedAt: T0,
          }), 'advanced');
          for (const claim of initialClaims) {
            assert.equal(await scope.portability.putTransferredMembershipClaim({
              batchRevision: 1,
              checkpointSha256: CHECKPOINT_SHA,
              claimSha256: claim.claimSha256,
              createdAt: T0,
              expiresAt: EXPIRES,
              memberId: claim.memberId,
              transferId,
            }), 'created');
          }
          const rotation = {
            checkpointSha256: CHECKPOINT_SHA,
            expectedBatchRevision: 1,
            expectedBatchSha256: batchOneSha,
            nextBatchRevision: 2,
            nextBatchSha256: batchTwoSha,
            replacements,
            rotatedAt: T1,
            scheduledAt: T1,
            transferId,
          };
          assert.equal(
            await scope.portability.rotateTransferredMembershipClaims(rotation),
            'advanced',
          );
          assert.equal(
            await scope.portability.rotateTransferredMembershipClaims(rotation),
            'replayed',
          );
          await expectStateConflict(
            scope.portability.rotateTransferredMembershipClaims({
              ...rotation,
              replacements: [
                { ...replacements[0], claimSha256: '8'.repeat(64) },
                replacements[1],
              ],
            }),
          );
          assert.deepEqual(
            await scope.portability.getTransferredMembershipClaim(
              transferId,
              'member-a',
            ),
            {
              batchRevision: 2,
              checkpointSha256: CHECKPOINT_SHA,
              claimSha256: replacements[0].claimSha256,
              createdAt: T1,
              expiresAt: EXPIRES,
              memberId: 'member-a',
              operationIntentId: undefined,
              redemptionReceiptId: undefined,
              state: 'unclaimed',
              targetPrincipalId: undefined,
              transferId,
              updatedAt: T1,
            },
          );
          const custodyReceipt = {
            batchRevision: 2,
            batchSha256: batchTwoSha,
            checkpointSha256: CHECKPOINT_SHA,
            committedAt: T2,
            custodyAuthority: { generation: 3, kind: 'lan' as const },
            operationIntentId: 'custody-intent',
            projectId,
            receiptId: 'custody-receipt',
            submittedByMemberId: 'member-manager',
            targetAuthorityGeneration: 4,
            transferId,
          };
          assert.equal(
            await scope.portability.putClaimBatchReceipt(custodyReceipt),
            'created',
          );
          await expectStateConflict(scope.portability.advanceLifecycleJournal({
            batchRevision: 3,
            batchSha256: '9'.repeat(64),
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'claims-retained',
            expectedState: 'active',
            nextPhase: 'repository-published',
            nextState: 'active',
            operationId: transferId,
            scheduledAt: T2,
            updatedAt: T2,
          }));
          await expectStateConflict(scope.portability.advanceLifecycleJournal({
            checkpointSha256: '9'.repeat(64),
            expectedPhase: 'claims-retained',
            expectedState: 'active',
            nextPhase: 'repository-published',
            nextState: 'active',
            operationId: transferId,
            scheduledAt: T2,
            updatedAt: T2,
          }));
          await expectStateConflict(
            scope.portability.rotateTransferredMembershipClaims({
              ...rotation,
              expectedBatchRevision: 2,
              expectedBatchSha256: batchTwoSha,
              nextBatchRevision: 3,
              nextBatchSha256: '9'.repeat(64),
              rotatedAt: T2,
              scheduledAt: T2,
            }),
          );
          assert.equal(await scope.portability.revokeTransferredMembershipClaims({
            batchRevision: 2,
            batchSha256: batchTwoSha,
            checkpointSha256: CHECKPOINT_SHA,
            revokedAt: T2,
            transferId,
          }), 'advanced');
          assert.equal(await scope.portability.revokeTransferredMembershipClaims({
            batchRevision: 2,
            batchSha256: batchTwoSha,
            checkpointSha256: CHECKPOINT_SHA,
            revokedAt: T2,
            transferId,
          }), 'replayed');
        });

        const runtime = new Client({ connectionString: database.runtimeUrl });
        try {
          await runtime.connect();
          await runtime.query('BEGIN');
          await runtime.query(
            `SELECT set_config('claudian_cloud.project_id', $1, true)`,
            [projectId],
          );
          const claims = await runtime.query<{
            readonly batch_revision: string;
            readonly member_id: string;
            readonly state: string;
            readonly updated_at: Date;
          }>(
            `SELECT batch_revision, member_id, state, updated_at
               FROM claudian_cloud.transferred_membership_claims
              ORDER BY batch_revision, member_id`,
          );
          assert.deepEqual(claims.rows.map(row => ({
            batchRevision: Number(row.batch_revision),
            memberId: row.member_id,
            state: row.state,
            updatedAt: row.updated_at.toISOString(),
          })), [
            { batchRevision: 1, memberId: 'member-a', state: 'revoked', updatedAt: T1 },
            { batchRevision: 1, memberId: 'member-b', state: 'revoked', updatedAt: T1 },
            { batchRevision: 2, memberId: 'member-a', state: 'revoked', updatedAt: T2 },
            { batchRevision: 2, memberId: 'member-b', state: 'revoked', updatedAt: T2 },
          ]);
          await runtime.query('ROLLBACK');
        } finally {
          await runtime.end();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('replaces uncommitted protected claim custody as one complete set', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      const projectId = 'project-envelope-rotation';
      const transferId = 'transfer-envelope-rotation';
      try {
        await store.withProjectScope(projectId, async scope => {
          await scope.portability.putLifecycleJournal({
            actorMemberId: 'member-manager',
            createdAt: T0,
            direction: 'cloud-to-lan',
            expectedAuthorityGeneration: 4,
            idempotencyKey: 'intent-envelope-rotation',
            kind: 'authority-transfer',
            operationId: transferId,
            phase: 'checkpoint-captured',
            projectId,
            requestFingerprint: '1'.repeat(64),
            scheduledAt: T0,
          });
          await scope.portability.advanceLifecycleJournal({
            checkpointSha256: CHECKPOINT_SHA,
            expectedPhase: 'checkpoint-captured',
            expectedState: 'active',
            nextPhase: 'target-staged',
            nextState: 'active',
            operationId: transferId,
            scheduledAt: T0,
            updatedAt: T0,
          });
          const receiptKey = {
            createdAt: T0,
            publicKey: 'A'.repeat(43),
            receiptKeyId: 'receipt-key-envelope-rotation',
            transferId,
          };
          await scope.portability.putTransferReceiptKey(receiptKey);
          const envelope = (claimSha256: string, ciphertext: string) => {
            const associatedData = {
              authorityGeneration: 4,
              checkpointSha256: CHECKPOINT_SHA,
              claimSha256,
              envelopeVersion: 1 as const,
              environmentIdentity: 'environment-envelope-rotation',
              memberId: 'member-offline',
              projectId,
              transferId,
            };
            return {
              associatedData,
              associatedDataSha256: createHash('sha256')
                .update(encodeCollabProtectedClaimAssociatedData(associatedData))
                .digest('hex'),
              ciphertext,
              createdAt: T0,
              encryptionAlgorithm: 'xchacha20-poly1305' as const,
              expiresAt: EXPIRES,
              keyId: 'claim-key-envelope-rotation',
              keyVersion: 1,
              memberId: 'member-offline',
              nonce: 'A'.repeat(32),
              receiptKeyId: receiptKey.receiptKeyId,
              tag: 'A'.repeat(22),
              transferId,
            };
          };
          const initial = envelope('2'.repeat(64), 'AQ');
          const replacement = envelope('3'.repeat(64), 'Ag');
          assert.equal(
            await scope.portability.putProtectedClaimEnvelope(initial),
            'created',
          );
          const rotation = {
            expectedClaims: [{
              claimSha256: initial.associatedData.claimSha256,
              memberId: initial.memberId,
            }],
            replacements: [replacement],
            transferId,
          };
          assert.equal(
            await scope.portability.replaceProtectedClaimEnvelopes(rotation),
            'advanced',
          );
          assert.equal(
            await scope.portability.replaceProtectedClaimEnvelopes(rotation),
            'replayed',
          );
          assert.deepEqual(
            await scope.portability.getProtectedClaimEnvelope(
              transferId,
              'member-offline',
            ),
            replacement,
          );
          await expectStateConflict(scope.portability.replaceProtectedClaimEnvelopes({
            ...rotation,
            replacements: [envelope('4'.repeat(64), 'Aw')],
          }));
        });
      } finally {
        await store.close();
      }
    });
  });

  it('accepts only exact terminal cloud-to-LAN transfer responses', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      const projectId = 'project-transfer-terminal';
      const transferId = 'transfer-terminal';
      try {
        await store.withProjectScope(projectId, async scope => {
          const activeResponse = {
            batchRevision: null,
            batchSha256: null,
            checkpointSha256: CHECKPOINT_SHA,
            createdAt: T0,
            direction: 'cloud-to-lan' as const,
            expiresAt: EXPIRES,
            phase: 'target-staged' as const,
            projectId,
            relinquishmentProof: null,
            sourceAuthority: { generation: 4, kind: 'cloud' as const },
            state: 'active' as const,
            targetAuthority: { generation: 5, kind: 'lan' as const },
            targetUrl: 'https://lan.example.test',
            transferId,
            updatedAt: T1,
          };
          const activeJson = JSON.stringify(activeResponse);
          await expectInvalidRecord(scope.portability.putTerminalResponder({
            createdAt: T0,
            eligiblePrincipals: [{
              memberId: 'member-manager',
              principalId: 'principal:manager',
            }],
            expiresAt: EXPIRES,
            operationId: transferId,
            operationKind: 'authority-transfer',
            replayAuthorization: {
              memberId: 'member-manager',
              requestSha256: AUTHORIZATION_SHA,
            },
            responseJson: activeJson,
            responseSha256: createHash('sha256').update(activeJson).digest('hex'),
          }));

          const sourceAuthority = { generation: 4, kind: 'cloud' as const };
          const targetAuthority = { generation: 5, kind: 'lan' as const };
          const relinquishmentProof = {
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            certificate: 'A'.repeat(86),
            certificateAlgorithm: 'ed25519' as const,
            checkpointSha256: CHECKPOINT_SHA,
            committedAt: T1,
            operationIntentId: 'relinquishment-intent',
            projectId,
            sourceAuthority,
            sourceHostMemberId: null,
            targetAuthority,
            transferId,
          };
          const completedResponse = {
            batchRevision: 1,
            batchSha256: BATCH_SHA,
            checkpointSha256: CHECKPOINT_SHA,
            createdAt: T0,
            direction: 'cloud-to-lan' as const,
            expiresAt: EXPIRES,
            phase: 'completed' as const,
            projectId,
            relinquishmentProof,
            sourceAuthority,
            state: 'completed' as const,
            targetAuthority,
            targetUrl: 'https://lan.example.test',
            transferId,
            updatedAt: T2,
          };
          const responseJson = JSON.stringify(completedResponse);
          const responder = {
            createdAt: T2,
            eligiblePrincipals: [{
              memberId: 'member-manager',
              principalId: 'principal:manager',
            }],
            expiresAt: EXPIRES,
            operationId: transferId,
            operationKind: 'authority-transfer' as const,
            replayAuthorization: {
              memberId: 'member-manager',
              requestSha256: AUTHORIZATION_SHA,
            },
            responseJson,
            responseSha256: createHash('sha256').update(responseJson).digest('hex'),
          };
          assert.equal(await scope.portability.putTerminalResponder(responder), 'created');
          assert.equal(await scope.portability.putTerminalResponder(responder), 'replayed');
          await expectStateConflict(scope.portability.putTerminalResponder({
            ...responder,
            eligiblePrincipals: [
              ...responder.eligiblePrincipals,
              {
                memberId: 'member-added',
                principalId: 'principal:added',
              },
            ],
          }));
          assert.deepEqual(
            (await scope.portability.getTerminalResponder(
              responder.operationKind,
              responder.operationId,
            ))?.eligiblePrincipals,
            responder.eligiblePrincipals,
          );
          await expectInvalidRecord(scope.portability.putTerminalResponder({
            ...responder,
            expiresAt: T3,
          }));
        });
      } finally {
        await store.close();
      }
    });
  });

  it('persists terminal, deletion, tombstone, and backup continuity facts', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      try {
        await store.withProjectScope('project-terminal', async scope => {
          const retirementResult = {
            acknowledgementRequired: true as const,
            kind: 'project-retired' as const,
            projectId: 'project-terminal',
            retiredAt: T0,
            retirementId: 'retirement-one',
            terminalExpiresAt: EXPIRES,
          };
          const responseJson = JSON.stringify(retirementResult);
          const responder = {
            createdAt: T0,
            eligiblePrincipals: [{
              memberId: 'member-manager',
              principalId: 'principal:manager',
            }],
            expiresAt: EXPIRES,
            operationId: 'retirement-one',
            operationKind: 'retire' as const,
            responseJson,
            responseSha256: createHash('sha256').update(responseJson).digest('hex'),
          };
          assert.equal(await scope.portability.putTerminalResponder(responder), 'created');
          assert.equal(await scope.portability.acknowledgeTerminalResponder({
            acknowledgedAt: T1,
            memberId: 'member-manager',
            operationId: responder.operationId,
            operationKind: responder.operationKind,
            principalId: 'principal:manager',
          }), 'advanced');
          assert.equal(await scope.portability.putTerminalResponder(responder), 'replayed');

          const tombstone = {
            authorityGeneration: 8,
            projectId: 'project-terminal',
            resultSha256: responder.responseSha256,
            retiredAt: T2,
            terminalExpiresAt: EXPIRES,
            terminalOperationId: responder.operationId,
            terminalOperationKind: responder.operationKind,
          };
          assert.equal(await scope.portability.putProjectTombstone(tombstone), 'created');
          assert.deepEqual(await scope.portability.getProjectTombstone(), tombstone);

          assert.equal(await scope.portability.putLifecycleJournal({
            actorMemberId: 'member-manager',
            createdAt: T0,
            direction: undefined,
            expectedAuthorityGeneration: 8,
            idempotencyKey: 'delete-intent-one',
            kind: 'delete',
            operationId: 'delete-one',
            phase: 'traffic-denied',
            projectId: 'project-terminal',
            requestFingerprint: AUTHORIZATION_SHA,
            scheduledAt: T0,
          }), 'created');

          const deletion = {
            authorizationSha256: AUTHORIZATION_SHA,
            authorizedMemberId: 'member-manager',
            createdAt: T0,
            operationId: 'delete-one',
            placementGeneration: 8,
            reason: 'retire' as const,
            repositoryStorageKey: 'repository-terminal',
            storageNodeId: 'node-one',
            terminalOperationId: responder.operationId,
            terminalOperationKind: responder.operationKind,
          };
          assert.equal(await scope.portability.removeTerminalResponder({
            expectedExpiresAt: responder.expiresAt,
            operationId: responder.operationId,
            operationKind: responder.operationKind,
            removedAt: T1,
          }), 'advanced');
          await expectStateConflict(scope.portability.putDeletionIntent(deletion));
          assert.equal(await scope.portability.putTerminalResponder(responder), 'created');
          assert.equal(await scope.portability.acknowledgeTerminalResponder({
            acknowledgedAt: T1,
            memberId: 'member-manager',
            operationId: responder.operationId,
            operationKind: responder.operationKind,
            principalId: 'principal:manager',
          }), 'advanced');
          assert.equal(await scope.portability.putDeletionIntent(deletion), 'created');
          assert.equal(await scope.portability.removeTerminalResponder({
            expectedExpiresAt: responder.expiresAt,
            operationId: responder.operationId,
            operationKind: responder.operationKind,
            removedAt: T1,
          }), 'advanced');
          assert.equal(await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'traffic-denied',
            expectedState: 'active',
            nextPhase: 'repository-delete-intent',
            nextState: 'active',
            operationId: deletion.operationId,
            scheduledAt: T1,
            updatedAt: T1,
          }), 'advanced');

          const backup = {
            authorityGeneration: 8,
            authorityVolumeIdentity: 'volume:one',
            backupId: 'backup-one',
            checkpointSha256: CHECKPOINT_SHA,
            coordinationSchemaVersion: 6,
            createdAt: T0,
            placementGeneration: 8,
            serverBuild: 'build-one',
          };
          assert.equal(await scope.portability.putBackupCatalogEntry(backup), 'created');
          assert.equal(await scope.portability.advanceBackupCatalogEntry({
            backupId: backup.backupId,
            expectedState: 'captured',
            nextState: 'verified',
            updatedAt: T2,
          }), 'advanced');
          assert.equal(await scope.portability.advanceBackupCatalogEntry({
            backupId: backup.backupId,
            expectedState: 'verified',
            nextState: 'published',
            updatedAt: T3,
          }), 'advanced');
        });

        const runtime = new Client({ connectionString: database.runtimeUrl });
        try {
          await runtime.connect();
          for (const relation of PROJECT_TABLES) {
            assert.deepEqual((await runtime.query(
              `SELECT * FROM claudian_cloud.${relation}`,
            )).rows, []);
          }
        } finally {
          await runtime.end();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('removes Project content while preserving the exact deletion partition', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const projectId = 'project-delete-content';
      await seedProject(database, projectId);
      await seedMembership(database, projectId, 'member-manager');
      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        await migration.query('BEGIN');
        await migration.query(
          `SELECT set_config('claudian_cloud.project_id', $1, true)`,
          [projectId],
        );
        await migration.query(
          `INSERT INTO claudian_cloud.repository_placements (
             project_id, storage_node_id, repository_storage_key, generation,
             active, created_at, updated_at
           ) VALUES ($1, 'node-delete', 'repository-delete', 3, true,
                     $2::timestamptz, $2::timestamptz)`,
          [projectId, T0],
        );
        await migration.query(
          `INSERT INTO claudian_cloud.active_repository_placement_catalog (
             project_id, storage_node_id, repository_storage_key, generation
           ) VALUES ($1, 'node-delete', 'repository-delete', 3)`,
          [projectId],
        );
        await migration.query(
          `INSERT INTO claudian_cloud.project_invitations (
             project_id, invitation_id, issued_by_member_id, idempotency_key,
             request_fingerprint, secret_sha256, state, revision, created_at,
             expires_at, secret_replay_expires_at, terminal_at
           ) VALUES (
             $1, 'invitation-delete-content', 'member-manager',
             'invitation-delete-key', $2, $3, 'active', 1, $4, $5, $6, NULL
           )`,
          [
            projectId,
            '2'.repeat(64),
            '3'.repeat(64),
            T0,
            '2026-08-26T00:00:00.000Z',
            EXPIRES,
          ],
        );
        await migration.query(
          `INSERT INTO claudian_cloud.protected_invitation_envelopes (
             project_id, invitation_id, encryption_algorithm, key_id,
             key_version, nonce, ciphertext, tag, associated_data_sha256,
             created_at, expires_at
           ) VALUES (
             $1, 'invitation-delete-content', 'xchacha20-poly1305',
             'membership-delete-key', 1, $2, $3, $4, $5, $6, $7
           )`,
          [
            projectId,
            Buffer.alloc(24, 1).toString('base64url'),
            Buffer.from('deletion-invitation').toString('base64url'),
            Buffer.alloc(16, 2).toString('base64url'),
            '1'.repeat(64),
            T0,
            '2026-08-26T00:00:00.000Z',
          ],
        );
        await migration.query('COMMIT');
      } finally {
        await migration.end();
      }

      const store = coordination(database);
      try {
        await store.withProjectScope(projectId, async scope => {
          const retirementId = 'retirement-delete-content';
          const retirementResult = {
            acknowledgementRequired: true as const,
            kind: 'project-retired' as const,
            projectId,
            retiredAt: T0,
            retirementId,
            terminalExpiresAt: EXPIRES,
          };
          const responseJson = JSON.stringify(retirementResult);
          const responseSha256 = createHash('sha256')
            .update(responseJson)
            .digest('hex');
          assert.equal(await scope.portability.bindProjectPrincipal({
            boundAt: T0,
            memberId: 'member-manager',
            principalId: 'principal:manager',
          }), 'created');
          assert.equal(await scope.portability.putTerminalResponder({
            createdAt: T0,
            eligiblePrincipals: [{
              memberId: 'member-manager',
              principalId: 'principal:manager',
            }],
            expiresAt: EXPIRES,
            operationId: retirementId,
            operationKind: 'retire',
            responseJson,
            responseSha256,
          }), 'created');
          assert.equal(await scope.portability.putProjectTombstone({
            authorityGeneration: 1,
            projectId,
            resultSha256: responseSha256,
            retiredAt: T0,
            terminalExpiresAt: EXPIRES,
            terminalOperationId: retirementId,
            terminalOperationKind: 'retire',
          }), 'created');
          assert.equal(await scope.portability.putLifecycleJournal({
            actorMemberId: 'member-manager',
            createdAt: T0,
            direction: undefined,
            expectedAuthorityGeneration: 1,
            idempotencyKey: 'delete-content-intent',
            kind: 'delete',
            operationId: 'delete-content-operation',
            phase: 'traffic-denied',
            projectId,
            requestFingerprint: AUTHORIZATION_SHA,
            scheduledAt: T0,
          }), 'created');
          const deletion = {
            authorizationSha256: AUTHORIZATION_SHA,
            authorizedMemberId: 'member-manager',
            createdAt: T0,
            operationId: 'delete-content-operation',
            placementGeneration: 3,
            reason: 'retire' as const,
            repositoryStorageKey: 'repository-delete',
            storageNodeId: 'node-delete',
            terminalOperationId: retirementId,
            terminalOperationKind: 'retire' as const,
          };
          assert.equal(await scope.portability.putDeletionIntent(deletion), 'created');
          assert.equal(await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'traffic-denied',
            expectedState: 'active',
            nextPhase: 'repository-delete-intent',
            nextState: 'active',
            operationId: deletion.operationId,
            scheduledAt: T1,
            updatedAt: T1,
          }), 'advanced');
          assert.equal(await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'repository-delete-intent',
            expectedState: 'active',
            nextPhase: 'repository-removed',
            nextState: 'active',
            operationId: deletion.operationId,
            scheduledAt: T2,
            updatedAt: T2,
          }), 'advanced');
          assert.equal(await scope.portability.removeProjectCoordinationContent({
            operationId: deletion.operationId,
            scheduledAt: T3,
            updatedAt: T3,
          }), 'advanced');
          assert.equal(await scope.portability.removeProjectCoordinationContent({
            operationId: deletion.operationId,
            scheduledAt: T3,
            updatedAt: T3,
          }), 'replayed');
          assert.equal(await scope.getProject(), undefined);
          assert.equal(
            await scope.portability.findProjectPrincipalBinding('principal:manager'),
            undefined,
          );
          assert.equal(
            (await scope.portability.getDeletionIntent(deletion.operationId))?.phase,
            'coordination-removed',
          );
          assert.equal(
            (await scope.portability.getTerminalResponder('retire', retirementId))
              ?.responseSha256,
            createHash('sha256').update(responseJson).digest('hex'),
          );
          assert.equal(
            (await scope.portability.getProjectTombstone())?.resultSha256,
            responseSha256,
          );
          assert.equal(await scope.portability.removeTerminalResponder({
            expectedExpiresAt: EXPIRES,
            operationId: retirementId,
            operationKind: 'retire',
            removedAt: EXPIRES,
          }), 'advanced');
          assert.equal(await scope.portability.removeTerminalResponder({
            expectedExpiresAt: EXPIRES,
            operationId: retirementId,
            operationKind: 'retire',
            removedAt: EXPIRES,
          }), 'replayed');
          assert.equal(
            await scope.portability.getTerminalResponder('retire', retirementId),
            undefined,
          );
          assert.equal(
            (await scope.portability.getDeletionIntent(deletion.operationId))?.phase,
            'coordination-removed',
          );
          assert.equal(
            (await scope.portability.getProjectTombstone())?.resultSha256,
            responseSha256,
          );
        });
        assert.deepEqual(await store.listTerminalProjectContinuity(), {
          nextCursor: undefined,
          projectIds: [projectId],
        });
      } finally {
        await store.close();
      }
    });
  });

  it('enumerates and expires codec-validated terminal responders', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      const responders = [
        { operationId: 'retirement-catalog-a', projectId: 'project-catalog-a' },
        { operationId: 'retirement-catalog-b', projectId: 'project-catalog-b' },
      ] as const;
      try {
        for (const responder of responders) {
          await store.withProjectScope(responder.projectId, async scope => {
            const result = {
              acknowledgementRequired: true as const,
              kind: 'project-retired' as const,
              projectId: responder.projectId,
              retiredAt: T0,
              retirementId: responder.operationId,
              terminalExpiresAt: EXPIRES,
            };
            const responseJson = JSON.stringify(result);
            assert.equal(await scope.portability.putTerminalResponder({
              createdAt: T0,
              eligiblePrincipals: [{
                memberId: 'member-manager',
                principalId: `principal:${responder.projectId}`,
              }],
              expiresAt: EXPIRES,
              operationId: responder.operationId,
              operationKind: 'retire',
              responseJson,
              responseSha256: createHash('sha256').update(responseJson).digest('hex'),
            }), 'created');
            await expectInvalidRecord(scope.portability.putTerminalResponder({
              createdAt: T0,
              eligiblePrincipals: [{
                memberId: 'member-manager',
                principalId: `principal:${responder.projectId}`,
              }],
              expiresAt: EXPIRES,
              operationId: `invalid-${responder.operationId}`,
              operationKind: 'retire',
              responseJson: '{"claim":"must-not-persist"}',
              responseSha256: createHash('sha256')
                .update('{"claim":"must-not-persist"}')
                .digest('hex'),
            }));
          });
        }
        const first = await store.listTerminalResponders({ limit: 1 });
        assert.deepEqual(first, {
          nextCursor: {
            expiresAt: EXPIRES,
            operationId: responders[0].operationId,
            operationKind: 'retire',
            projectId: responders[0].projectId,
          },
          responders: [{
            expiresAt: EXPIRES,
            operationId: responders[0].operationId,
            operationKind: 'retire',
            projectId: responders[0].projectId,
          }],
        });
        assert.deepEqual(await store.listTerminalResponders({
          after: first.nextCursor,
          limit: 1,
        }), {
          nextCursor: undefined,
          responders: [{
            expiresAt: EXPIRES,
            operationId: responders[1].operationId,
            operationKind: 'retire',
            projectId: responders[1].projectId,
          }],
        });
        await expectInvalidRecord(store.listTerminalResponders({
          after: {
            expiresAt: EXPIRES,
            operationId: responders[0].operationId,
            operationKind: 'unknown' as 'retire',
            projectId: responders[0].projectId,
          },
        }));
        await store.withProjectScope(responders[0].projectId, async scope => {
          await expectStateConflict(scope.portability.removeTerminalResponder({
            expectedExpiresAt: EXPIRES,
            operationId: responders[0].operationId,
            operationKind: 'retire',
            removedAt: T1,
          }));
          assert.equal(await scope.portability.removeTerminalResponder({
            expectedExpiresAt: EXPIRES,
            operationId: responders[0].operationId,
            operationKind: 'retire',
            removedAt: EXPIRES,
          }), 'advanced');
          assert.equal(await scope.portability.removeTerminalResponder({
            expectedExpiresAt: EXPIRES,
            operationId: responders[0].operationId,
            operationKind: 'retire',
            removedAt: EXPIRES,
          }), 'replayed');
        });
        assert.deepEqual(await store.listTerminalResponders(), {
          nextCursor: undefined,
          responders: [{
            expiresAt: EXPIRES,
            operationId: responders[1].operationId,
            operationKind: 'retire',
            projectId: responders[1].projectId,
          }],
        });
        await store.withProjectScope(responders[1].projectId, async scope => {
          assert.equal(await scope.portability.acknowledgeTerminalResponder({
            acknowledgedAt: T1,
            memberId: 'member-manager',
            operationId: responders[1].operationId,
            operationKind: 'retire',
            principalId: `principal:${responders[1].projectId}`,
          }), 'advanced');
          assert.equal(await scope.portability.removeTerminalResponder({
            expectedExpiresAt: EXPIRES,
            operationId: responders[1].operationId,
            operationKind: 'retire',
            removedAt: T2,
          }), 'advanced');
        });
        assert.deepEqual(await store.listTerminalResponders(), {
          nextCursor: undefined,
          responders: [],
        });
      } finally {
        await store.close();
      }
    });
  });

  it('isolates overlapping lifecycle, claim, deletion, and backup identities', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const store = coordination(database);
      const projects = [
        { claimSha256: '1'.repeat(64), projectId: 'project-isolated-a' },
        { claimSha256: '2'.repeat(64), projectId: 'project-isolated-b' },
      ] as const;
      try {
        for (const project of projects) {
          await store.withProjectScope(project.projectId, async scope => {
            assert.equal(await scope.portability.putLifecycleJournal({
              actorMemberId: 'member-manager',
              createdAt: T0,
              direction: 'lan-to-cloud',
              expectedAuthorityGeneration: 1,
              idempotencyKey: 'shared-intent',
              kind: 'authority-transfer',
              operationId: 'shared-transfer',
              phase: 'collecting-readiness',
              projectId: project.projectId,
              requestFingerprint: project.claimSha256,
              scheduledAt: T0,
            }), 'created');
            assert.equal(await scope.portability.advanceLifecycleJournal({
              batchRevision: 1,
              batchSha256: project.claimSha256,
              checkpointSha256: CHECKPOINT_SHA,
              expectedPhase: 'collecting-readiness',
              expectedState: 'active',
              nextPhase: 'claims-retained',
              nextState: 'active',
              operationId: 'shared-transfer',
              scheduledAt: T0,
              updatedAt: T0,
            }), 'advanced');
            assert.equal(await scope.portability.putTransferredMembershipClaim({
              batchRevision: 1,
              checkpointSha256: CHECKPOINT_SHA,
              claimSha256: project.claimSha256,
              createdAt: T0,
              expiresAt: EXPIRES,
              memberId: 'shared-member',
              transferId: 'shared-transfer',
            }), 'created');
            assert.equal(await scope.portability.putBackupCatalogEntry({
              authorityGeneration: 1,
              authorityVolumeIdentity: 'volume:shared',
              backupId: 'shared-backup',
              checkpointSha256: project.claimSha256,
              coordinationSchemaVersion: 6,
              createdAt: T0,
              placementGeneration: 1,
              serverBuild: 'build-shared',
            }), 'created');
          });
        }

        for (const project of projects) {
          await store.withProjectScope(project.projectId, async scope => {
            assert.equal((await scope.portability.getLifecycleJournal(
              'shared-transfer',
            ))?.projectId, project.projectId);
            assert.equal((await scope.portability.getTransferredMembershipClaim(
              'shared-transfer',
              'shared-member',
            ))?.claimSha256, project.claimSha256);
            assert.equal((await scope.portability.findTransferredMembershipClaimBySha256(
              'shared-transfer',
              project.claimSha256,
            ))?.memberId, 'shared-member');
            assert.equal(
              await scope.portability.findTransferredMembershipClaimBySha256(
                'shared-transfer',
                project.claimSha256 === '1'.repeat(64)
                  ? '2'.repeat(64)
                  : '1'.repeat(64),
              ),
              undefined,
            );
            assert.equal((await scope.portability.getBackupCatalogEntry(
              'shared-backup',
            ))?.checkpointSha256, project.claimSha256);
          });
        }
      } finally {
        await store.close();
      }
    });
  });
});
