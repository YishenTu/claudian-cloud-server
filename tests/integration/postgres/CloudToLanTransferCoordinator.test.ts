import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  decodeCollabTransferredMembershipClaimBatch,
  encodeCollabProtectedClaimAssociatedData,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
  type CollabTransferredMembershipRedemptionReceipt,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import {
  CloudToLanTransferCoordinator,
  type CloudToLanClaimCustodyPort,
} from '../../../src/project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const PROJECT_ID = 'project-cloud-to-lan-real';
const MANAGER_ID = 'member-manager';
const TARGET_ID = 'member-target';
const OFFLINE_ID = 'member-offline';
const MANAGER_PRINCIPAL = 'principal:manager';
const TARGET_PRINCIPAL = 'principal:target';
const OFFLINE_PRINCIPAL = 'principal:offline';
const T0 = '2026-08-27T00:00:00.000Z';
const EXPIRES_AT = '2026-09-26T00:00:00.000Z';
const CHECKPOINT_SHA = '1'.repeat(64);
const STAGE_SHA = '2'.repeat(64);
const PUBLIC_KEY = Buffer.alloc(32, 8).toString('base64url');
const SIGNATURE = Buffer.alloc(64, 9).toString('base64url');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

async function seed(database: PostgresTestDatabase): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('claudian_cloud.project_id', $1, true)`,
      [PROJECT_ID],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation, expected_main_oid,
         service_state, authority_generation, authority_state_revision,
         created_at, activated_at
       ) VALUES ($1, 'Cloud to LAN Real', 1, repeat('a', 40), 'active', 4, 1,
                 $2::timestamptz, $2::timestamptz)`,
      [PROJECT_ID, T0],
    );
    for (const [memberId, role] of [
      [MANAGER_ID, 'manager'],
      [TARGET_ID, 'member'],
      [OFFLINE_ID, 'member'],
    ] as const) {
      await client.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, role, status, revision, display_name,
           created_at, updated_at, activated_at, revoked_at
         ) VALUES ($1, $2, $3, 'active', 1, $2,
                   $4::timestamptz, $4::timestamptz, $4::timestamptz, NULL)`,
        [PROJECT_ID, memberId, role, T0],
      );
    }
    for (const [memberId, principalId] of [
      [MANAGER_ID, MANAGER_PRINCIPAL],
      [TARGET_ID, TARGET_PRINCIPAL],
      [OFFLINE_ID, OFFLINE_PRINCIPAL],
    ] as const) {
      await client.query(
        `INSERT INTO claudian_cloud.project_principal_bindings (
           project_id, principal_id, member_id, state, bound_at, revoked_at
         ) VALUES ($1, $2, $3, 'active', $4::timestamptz, NULL)`,
        [PROJECT_ID, principalId, memberId, T0],
      );
    }
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, 'local', 'repository_cloud_to_lan_real', 7, true,
                 $2::timestamptz, $2::timestamptz)`,
      [PROJECT_ID, T0],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, 'local', 'repository_cloud_to_lan_real', 7)`,
      [PROJECT_ID],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

function claimBatch(transferId: string) {
  const withoutDigest = {
    batchRevision: 1,
    batchSha256: '0'.repeat(64),
    checkpointSha256: CHECKPOINT_SHA,
    claims: [
      { claim: Buffer.alloc(32, 1).toString('base64url'), memberId: MANAGER_ID },
      { claim: Buffer.alloc(32, 2).toString('base64url'), memberId: OFFLINE_ID },
    ].sort((left, right) => left.memberId.localeCompare(right.memberId, 'en-US')),
    expiresAt: EXPIRES_AT,
    projectId: PROJECT_ID,
    targetAuthorityGeneration: 5,
    transferId,
  };
  return decodeCollabTransferredMembershipClaimBatch({
    ...withoutDigest,
    batchSha256: sha256(encodeCollabTransferredMembershipClaimBatchDigestInput(
      withoutDigest,
    )),
  });
}

function custody(claims: Map<string, string>): CloudToLanClaimCustodyPort {
  return {
    seal: input => {
      claims.set(input.associatedData.claimSha256, input.claim);
      return Promise.resolve(Object.freeze({
        associatedData: input.associatedData,
        associatedDataSha256: sha256(
          encodeCollabProtectedClaimAssociatedData(input.associatedData),
        ),
        ciphertext: Buffer.from(`sealed:${input.associatedData.claimSha256}`).toString(
          'base64url',
        ),
        createdAt: input.createdAt,
        encryptionAlgorithm: 'xchacha20-poly1305',
        expiresAt: input.expiresAt,
        keyId: 'claim-key-current',
        keyVersion: 1,
        memberId: input.associatedData.memberId,
        nonce: Buffer.alloc(24, 4).toString('base64url'),
        receiptKeyId: input.receiptKeyId,
        tag: Buffer.alloc(16, 5).toString('base64url'),
        transferId: input.associatedData.transferId,
      }));
    },
    open: envelope => {
      const claim = claims.get(envelope.associatedData.claimSha256);
      assert.ok(claim);
      return Promise.resolve(claim);
    },
  };
}

describe('Cloud-to-LAN PostgreSQL lifecycle', () => {
  it('commits protected custody, one-way relinquishment, and deletion handoff', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      const claims = new Map<string, string>();
      let tick = Date.parse(T0);
      const coordinator = new CloudToLanTransferCoordinator({
        checkpoint: {
          capture: input => Promise.resolve(Object.freeze({
            checkpointSha256: CHECKPOINT_SHA,
            operationId: input.operationId,
            projectId: input.projectId,
          })),
          discard: () => Promise.resolve('removed'),
        },
        clock: () => new Date(tick += 1_000),
        coordination: store,
        custody: custody(claims),
        custodyReceiptIdFactory: () => 'custody-receipt-real',
        deletionOperationIdFactory: () => 'delete-transfer-real',
        environmentIdentity: 'environment-real',
        relinquishmentIntentIdFactory: () => 'relinquishment-intent-real',
        relinquishmentSigner: { sign: () => Promise.resolve(SIGNATURE) },
        repository: {
          reserveExactRepositoryOperation: projectId => Promise.resolve(Object.freeze({
            async close() {},
            projectId,
          })),
          verifyExactRepository: () => Promise.resolve(),
        },
        sourceFence: {
          quiesce: () => Promise.resolve(),
          relinquish: () => Promise.resolve(),
          reopen: () => Promise.resolve(),
        },
        targetTrust: {
          verifyAcceptance: input => Promise.resolve(Object.freeze({
            principalId: input.principalId,
            projectId: input.request.projectId,
            receiptKeyId: 'receipt-key-target-real',
            receiptPublicKey: PUBLIC_KEY,
            targetAuthority: input.targetAuthority,
            targetHostMemberId: input.request.targetHostMemberId,
            targetUrl: input.targetUrl,
            transferId: input.request.transferId,
          })),
          verifyStaged: () => Promise.resolve(),
          verifyActivation: () => Promise.resolve(),
          verifyRedemptionReceipt: () => Promise.resolve(),
          invalidateAndClean: () => Promise.resolve(Object.freeze({
            cleanupSha256: '7'.repeat(64),
          })),
        },
      });
      try {
        const begun = await coordinator.begin({
          expiresAt: EXPIRES_AT,
          principalId: MANAGER_PRINCIPAL,
          request: {
            expectedAuthorityGeneration: 4,
            idempotencyKey: 'begin-intent-real',
            projectId: PROJECT_ID,
            targetHostMemberId: TARGET_ID,
            targetUrl: 'https://lan.example.test',
          },
        });
        assert.equal((await coordinator.acceptTarget({
          principalId: TARGET_PRINCIPAL,
          request: {
            idempotencyKey: 'accept-intent-real',
            projectId: PROJECT_ID,
            targetHostMemberId: TARGET_ID,
            targetProof: Buffer.alloc(32, 1).toString('base64url'),
            transferId: begun.transferId,
          },
        })).phase, 'checkpoint-captured');
        const batch = claimBatch(begun.transferId);
        const receipt = await coordinator.reportTargetStaged({
          principalId: TARGET_PRINCIPAL,
          request: {
            checkpointSha256: CHECKPOINT_SHA,
            claimBatch: batch,
            idempotencyKey: 'stage-intent-real',
            projectId: PROJECT_ID,
            stageSha256: STAGE_SHA,
            targetAuthority: { generation: 5, kind: 'lan' },
            targetProof: Buffer.alloc(32, 2).toString('base64url'),
            transferId: begun.transferId,
          },
        });
        assert.equal(receipt.batchSha256, batch.batchSha256);
        assert.equal((await coordinator.getStatus({
          principalId: MANAGER_PRINCIPAL,
          request: { projectId: PROJECT_ID, transferId: begun.transferId },
        })).phase, 'cloud-relinquished');
        assert.equal((await store.listActiveRepositoryPlacements()).placements.some(
          placement => placement.projectId === PROJECT_ID,
        ), false);
        const proof = (await coordinator.getStatus({
          principalId: TARGET_PRINCIPAL,
          request: { projectId: PROJECT_ID, transferId: begun.transferId },
        })).relinquishmentProof;
        assert.ok(proof);
        tick = Date.parse(EXPIRES_AT);
        const completed = await coordinator.confirmTargetActive({
          principalId: TARGET_PRINCIPAL,
          request: {
            idempotencyKey: 'activation-intent-real',
            projectId: PROJECT_ID,
            relinquishmentProof: proof,
            targetActivationProof: Buffer.alloc(32, 3).toString('base64url'),
            transferId: begun.transferId,
          },
        });
        assert.equal(completed.state, 'completed');
        assert.equal(Date.parse(completed.expiresAt) > Date.parse(completed.updatedAt), true);
        const managerEnvelope = await store.withProjectScope(
          PROJECT_ID,
          scope => scope.portability.getProtectedClaimEnvelope(
            begun.transferId,
            MANAGER_ID,
          ),
        );
        assert.ok(managerEnvelope);
        const redemptionReceipt: CollabTransferredMembershipRedemptionReceipt = {
          checkpointSha256: CHECKPOINT_SHA,
          claimSha256: managerEnvelope.associatedData.claimSha256,
          memberId: MANAGER_ID,
          operationIntentId: 'claim-intent-real',
          projectId: PROJECT_ID,
          receiptId: 'redemption-receipt-real',
          receiptKeyId: 'receipt-key-target-real',
          redeemedAt: completed.updatedAt,
          signature: SIGNATURE,
          signatureAlgorithm: 'ed25519',
          targetAuthorityGeneration: 5,
          transferId: begun.transferId,
        };
        const acknowledgement = await coordinator.acknowledgeRedemption({
          principalId: MANAGER_PRINCIPAL,
          request: {
            idempotencyKey: 'ack-intent-real',
            projectId: PROJECT_ID,
            receipt: redemptionReceipt,
            transferId: begun.transferId,
          },
        });
        await store.withProjectScope(PROJECT_ID, async scope => {
          assert.equal((await scope.getProject())?.serviceState, 'deleting');
          assert.equal((await scope.portability.getLifecycleJournal(
            'delete-transfer-real',
          ))?.phase, 'traffic-denied');
          assert.equal((await scope.portability.getDeletionIntent(
            'delete-transfer-real',
          ))?.reason, 'cloud-to-lan');
          assert.equal((await scope.portability.getTerminalResponder(
            'authority-transfer',
            begun.transferId,
          ))?.replayAuthorization?.memberId, TARGET_ID);
          assert.equal((await scope.portability.listActiveProjectPrincipalBindings()).length, 3);
          assert.equal(await scope.portability.getProtectedClaimEnvelope(
            begun.transferId,
            TARGET_ID,
          ), undefined);
          assert.ok(await scope.portability.getProtectedClaimEnvelope(
            begun.transferId,
            OFFLINE_ID,
          ));
          const firstDeletionAt = new Date(
            Date.parse(completed.updatedAt) + 1_000,
          ).toISOString();
          const secondDeletionAt = new Date(
            Date.parse(completed.updatedAt) + 2_000,
          ).toISOString();
          const thirdDeletionAt = new Date(
            Date.parse(completed.updatedAt) + 3_000,
          ).toISOString();
          assert.equal(await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'traffic-denied',
            expectedState: 'active',
            nextPhase: 'repository-delete-intent',
            nextState: 'active',
            operationId: 'delete-transfer-real',
            scheduledAt: firstDeletionAt,
            updatedAt: firstDeletionAt,
          }), 'advanced');
          assert.equal(await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'repository-delete-intent',
            expectedState: 'active',
            nextPhase: 'repository-removed',
            nextState: 'active',
            operationId: 'delete-transfer-real',
            scheduledAt: secondDeletionAt,
            updatedAt: secondDeletionAt,
          }), 'advanced');
          assert.equal(await scope.portability.removeProjectCoordinationContent({
            operationId: 'delete-transfer-real',
            scheduledAt: thirdDeletionAt,
            updatedAt: thirdDeletionAt,
          }), 'advanced');
        });
        assert.equal((await coordinator.getStatus({
          principalId: OFFLINE_PRINCIPAL,
          request: { projectId: PROJECT_ID, transferId: begun.transferId },
        })).state, 'completed');
        const offlineClaim = await coordinator.getClaim({
          principalId: OFFLINE_PRINCIPAL,
          request: { projectId: PROJECT_ID, transferId: begun.transferId },
        });
        assert.equal(offlineClaim.expiresAt, completed.expiresAt);
        assert.deepEqual(await coordinator.acknowledgeRedemption({
          principalId: MANAGER_PRINCIPAL,
          request: {
            idempotencyKey: 'ack-intent-real',
            projectId: PROJECT_ID,
            receipt: redemptionReceipt,
            transferId: begun.transferId,
          },
        }), acknowledgement);
      } finally {
        await coordinator.close();
        await store.close();
      }
    });
  });
});
