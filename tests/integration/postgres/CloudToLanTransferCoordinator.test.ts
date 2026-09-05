import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  decodeCollabProjectBackupCheckpointCoordinationNdjson,
  decodeCollabTransferredMembershipClaimBatch,
  encodeCollabProjectBackupCheckpointCoordinationNdjson,
  encodeCollabProtectedClaimAssociatedData,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
  type CollabProjectBackupRecord,
  type CollabTransferredMembershipRedemptionReceipt,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { ClaimCustodyKeyReferenceVerifier } from '../../../src/environment-maintenance/commands/ClaimCustodyKeyReferenceVerifier.js';
import { ActiveClaimCustodyKeyReferenceGate } from '../../../src/project-authority/lifecycle/ActiveClaimCustodyKeyReferenceGate.js';
import {
  CloudToLanTransferCoordinator,
  CloudToLanTransferCoordinatorError,
  type CloudToLanClaimCustodyPort,
} from '../../../src/project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';
import { TerminalResponderExpiry } from '../../../src/project-authority/lifecycle/retire/TerminalResponderExpiry.js';

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
      { claim: Buffer.alloc(32, 11).toString('base64url'), memberId: MANAGER_ID },
      { claim: Buffer.alloc(32, 12).toString('base64url'), memberId: OFFLINE_ID },
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
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      const claims = new Map<string, string>();
      let tick = Date.parse(T0) - 1_000;
      const coordinator = new CloudToLanTransferCoordinator({
        checkpoint: {
          capture: input => Promise.resolve(Object.freeze({
            checkpointSha256: CHECKPOINT_SHA,
            expiresAt: input.expiresAt,
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
        relinquishmentSigner: {
          activeKey: Object.freeze({
            publicKey: Buffer.alloc(32, 6).toString('base64url'),
            receiptKeyId: 'receipt-key-source',
          }),
          resolveReceiptKey: () => Promise.resolve(Object.freeze({
            publicKey: Buffer.alloc(32, 6).toString('base64url'),
            receiptKeyId: 'receipt-key-source',
          })),
          sign: () => Promise.resolve(SIGNATURE),
        },
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
          verifyCleanup: () => Promise.resolve(),
          verifyRedemptionReceipt: () => Promise.resolve(),
        },
      });
      try {
        const begun = await coordinator.begin({
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
        const backupRecords = await store.withProjectScope(
          PROJECT_ID,
          scope => scope.checkpoint.readProjectCheckpointRecords({
            excludedOperationId: 'backup-inspection',
            maximumCoordinationBytes: 1024 * 1024,
            metadata: {
              authorityId: 'authority-real',
              authorityVolumeIdentity: 'volume-real',
              coordinationSchemaVersion: 9,
              maximumServerBuild: 'cloud-build-real',
              minimumServerBuild: 'cloud-build-real',
              repositoryFormatVersion: 1,
              restoreEpoch: 1,
            },
            profile: 'backup',
            snapshotAt: T0,
          }),
        );
        const encodedBackup =
          encodeCollabProjectBackupCheckpointCoordinationNdjson(
            backupRecords as readonly CollabProjectBackupRecord[],
          );
        assert.deepEqual(
          decodeCollabProjectBackupCheckpointCoordinationNdjson(encodedBackup),
          backupRecords,
        );
        const backupKinds = new Set(backupRecords.map(record => record.kind));
        for (const kind of [
          'authority-transfer-recovery',
          'lifecycle-journal',
          'protected-claim-envelope',
          'transfer-claim-batch-receipt',
          'transfer-receipt-key',
        ] as const) assert.equal(backupKinds.has(kind), true, kind);
        assert.deepEqual(backupRecords.filter(record => (
          batch.claims.some(claim => JSON.stringify(record).includes(claim.claim))
        )).map(record => record.kind), []);

        const exportRecords = await store.withProjectScope(
          PROJECT_ID,
          scope => scope.checkpoint.readProjectCheckpointRecords({
            excludedOperationId: 'export-inspection',
            maximumCoordinationBytes: 1024 * 1024,
            metadata: {
              authorityId: 'authority-real',
              authorityVolumeIdentity: 'volume-real',
              coordinationSchemaVersion: 9,
              maximumServerBuild: 'cloud-build-real',
              minimumServerBuild: 'cloud-build-real',
              repositoryFormatVersion: 1,
              restoreEpoch: 1,
            },
            profile: 'export',
            snapshotAt: T0,
          }),
        );
        for (const kind of [
          'authority-transfer-recovery',
          'lifecycle-journal',
          'protected-claim-envelope',
          'transfer-claim-batch-receipt',
          'transfer-receipt-key',
        ] as const) {
          assert.equal(
            exportRecords.some(record => record.kind === kind),
            false,
            kind,
          );
        }
        assert.equal((await coordinator.getStatus({
          principalId: MANAGER_PRINCIPAL,
          request: { projectId: PROJECT_ID, transferId: begun.transferId },
        })).phase, 'cloud-relinquished');
        assert.equal((await store.listActiveRepositoryPlacements()).placements.some(
          placement => placement.projectId === PROJECT_ID,
        ), false);
        const restartedStore = coordination(database);
        try {
          const keyGate = new ActiveClaimCustodyKeyReferenceGate({
            coordination: restartedStore,
            metadata: {
              read: () => Promise.resolve({
                authorityId: 'authority-real',
                authorityVolumeIdentity: 'volume-real',
                coordinationSchemaVersion: 11,
                repositoryFormatVersion: 1,
                restoreEpoch: 1,
                serverBuild: 'cloud-build-real',
              }),
            },
            verifier: new ClaimCustodyKeyReferenceVerifier({
              custody: {
                open: () => Promise.reject(new Error('missing-historical-key')),
              },
              keyring: {
                assertReceiptPublicKey: () => undefined,
                assertReferences: ({ encryptionKeyIds }) => {
                  if (encryptionKeyIds.includes('claim-key-current')) {
                    throw new Error('missing-historical-key');
                  }
                },
              },
            }),
          });
          await assert.rejects(
            keyGate.verifyAll(new AbortController().signal),
            /active-claim-custody-key-reference\.error\.unavailable/u,
          );
        } finally {
          await restartedStore.close();
        }
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
        const offlineEnvelope = await store.withProjectScope(
          PROJECT_ID,
          scope => scope.portability.getProtectedClaimEnvelope(
            begun.transferId,
            OFFLINE_ID,
          ),
        );
        assert.ok(offlineEnvelope);
        await coordinator.acknowledgeRedemption({
          principalId: OFFLINE_PRINCIPAL,
          request: {
            idempotencyKey: 'ack-offline-intent-real',
            projectId: PROJECT_ID,
            receipt: {
              checkpointSha256: CHECKPOINT_SHA,
              claimSha256: offlineEnvelope.associatedData.claimSha256,
              memberId: OFFLINE_ID,
              operationIntentId: 'claim-offline-intent-real',
              projectId: PROJECT_ID,
              receiptId: 'redemption-receipt-offline-real',
              receiptKeyId: 'receipt-key-target-real',
              redeemedAt: completed.updatedAt,
              signature: SIGNATURE,
              signatureAlgorithm: 'ed25519',
              targetAuthorityGeneration: 5,
              transferId: begun.transferId,
            },
            transferId: begun.transferId,
          },
        });
        assert.equal(await store.withProjectScope(
          PROJECT_ID,
          scope => scope.portability.getProtectedClaimEnvelope(
            begun.transferId,
            OFFLINE_ID,
          ),
        ), undefined);
        const terminalReferences: unknown[] = [];
        await new ActiveClaimCustodyKeyReferenceGate({
          coordination: store,
          metadata: {
            read: () => Promise.resolve({
              authorityId: 'authority-real',
              authorityVolumeIdentity: 'volume-real',
              coordinationSchemaVersion: 11,
              repositoryFormatVersion: 1,
              restoreEpoch: 1,
              serverBuild: 'cloud-build-real',
            }),
          },
          verifier: new ClaimCustodyKeyReferenceVerifier({
            custody: custody(claims),
            keyring: {
              assertReceiptPublicKey: () => assert.fail(
                'terminal LAN target keys are not Cloud signing keys',
              ),
              assertReferences: references => terminalReferences.push(references),
            },
          }),
        }).verifyAll(new AbortController().signal);
        assert.deepEqual(terminalReferences, [{
          encryptionKeyIds: [],
          receiptKeyIds: [],
        }]);
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

  it('compacts accepted-target cancellation proof into exact terminal replay before backup', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      const claims = new Map<string, string>();
      let tick = Date.parse(T0) - 1_000;
      const coordinator = new CloudToLanTransferCoordinator({
        checkpoint: {
          capture: input => Promise.resolve(Object.freeze({
            checkpointSha256: CHECKPOINT_SHA,
            expiresAt: input.expiresAt,
            operationId: input.operationId,
            projectId: input.projectId,
          })),
          discard: () => Promise.resolve('removed'),
        },
        clock: () => new Date(tick += 1_000),
        coordination: store,
        custody: custody(claims),
        custodyReceiptIdFactory: () => 'custody-receipt-cancelled',
        deletionOperationIdFactory: () => 'delete-transfer-cancelled',
        environmentIdentity: 'environment-real',
        relinquishmentIntentIdFactory: () => 'relinquishment-intent-cancelled',
        relinquishmentSigner: {
          activeKey: Object.freeze({
            publicKey: Buffer.alloc(32, 6).toString('base64url'),
            receiptKeyId: 'receipt-key-source',
          }),
          resolveReceiptKey: () => Promise.resolve(Object.freeze({
            publicKey: Buffer.alloc(32, 6).toString('base64url'),
            receiptKeyId: 'receipt-key-source',
          })),
          sign: () => Promise.resolve(SIGNATURE),
        },
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
          verifyCleanup: () => Promise.resolve(),
          verifyRedemptionReceipt: () => Promise.resolve(),
        },
      });
      try {
        const begun = await coordinator.begin({
          principalId: MANAGER_PRINCIPAL,
          request: {
            expectedAuthorityGeneration: 4,
            idempotencyKey: 'begin-cancelled-real',
            projectId: PROJECT_ID,
            targetHostMemberId: TARGET_ID,
            targetUrl: 'https://lan.example.test',
          },
        });
        await coordinator.acceptTarget({
          principalId: TARGET_PRINCIPAL,
          request: {
            idempotencyKey: 'accept-cancelled-real',
            projectId: PROJECT_ID,
            targetHostMemberId: TARGET_ID,
            targetProof: Buffer.alloc(32, 1).toString('base64url'),
            transferId: begun.transferId,
          },
        });
        await coordinator.getReceiptVerifier({
          principalId: TARGET_PRINCIPAL,
          request: { projectId: PROJECT_ID, transferId: begun.transferId },
        });
        await store.withProjectScope(PROJECT_ID, async scope => {
          assert.deepEqual(
            (await scope.portability.listTransferReceiptKeys(begun.transferId))
              .map(key => key.receiptKeyId),
            ['receipt-key-source', 'receipt-key-target-real'],
          );
        });
        await coordinator.cancel({
          principalId: MANAGER_PRINCIPAL,
          request: {
            expectedPhase: 'checkpoint-captured',
            idempotencyKey: 'cancel-cancelled-real',
            projectId: PROJECT_ID,
            transferId: begun.transferId,
          },
        });
        const cleanupRequest = {
          idempotencyKey: 'cleanup-cancelled-real',
          projectId: PROJECT_ID,
          proof: {
            batchRevision: null,
            batchSha256: null,
            checkpointSha256: CHECKPOINT_SHA,
            cleanupSha256: '7'.repeat(64),
            invalidatedAt: '2026-08-27T00:01:00.000Z',
            operationIntentId: 'cleanup-cancelled-real',
            projectId: PROJECT_ID,
            receiptKeyId: 'receipt-key-target-real',
            signature: SIGNATURE,
            signatureAlgorithm: 'ed25519' as const,
            sourceAuthority: { generation: 4, kind: 'cloud' as const },
            stageSha256: null,
            targetAuthority: { generation: 5, kind: 'lan' as const },
            targetHostMemberId: TARGET_ID,
            transferId: begun.transferId,
          },
          transferId: begun.transferId,
        };
        const cancelled = await coordinator.confirmTargetInvalidated({
          principalId: TARGET_PRINCIPAL,
          request: cleanupRequest,
        });
        assert.equal(cancelled.state, 'cancelled');
        const terminalExpiresAt = await store.withProjectScope(PROJECT_ID, async scope => {
          const recovery = await scope.portability.getAuthorityTransferRecovery(
            begun.transferId,
          );
          assert.ok(recovery?.targetProof);
          assert.equal(Object.hasOwn(
            JSON.parse(recovery.targetProof) as Record<string, unknown>,
            'cleanupProof',
          ), false);
          const responder = await scope.portability.getTerminalResponder(
            'authority-transfer',
            begun.transferId,
          );
          assert.ok(responder);
          assert.equal(responder.replayAuthorization?.memberId, TARGET_ID);
          assert.deepEqual(
            (await scope.portability.listTransferReceiptKeys(begun.transferId))
              .map(key => key.receiptKeyId),
            ['receipt-key-target-real'],
          );
          return responder.expiresAt;
        });
        const backupRecords = await store.withProjectScope(
          PROJECT_ID,
          scope => scope.checkpoint.readProjectCheckpointRecords({
            excludedOperationId: 'backup-after-cancelled-transfer',
            maximumCoordinationBytes: 1024 * 1024,
            metadata: {
              authorityId: 'authority-real',
              authorityVolumeIdentity: 'volume-real',
              coordinationSchemaVersion: 11,
              maximumServerBuild: 'cloud-build-real',
              minimumServerBuild: 'cloud-build-real',
              repositoryFormatVersion: 1,
              restoreEpoch: 1,
            },
            profile: 'backup',
            snapshotAt: cancelled.updatedAt,
          }),
        );
        const encoded = encodeCollabProjectBackupCheckpointCoordinationNdjson(
          backupRecords as readonly CollabProjectBackupRecord[],
        );
        assert.deepEqual(
          decodeCollabProjectBackupCheckpointCoordinationNdjson(encoded),
          backupRecords,
        );
        assert.deepEqual(await coordinator.confirmTargetInvalidated({
          principalId: TARGET_PRINCIPAL,
          request: cleanupRequest,
        }), cancelled);
        await assert.rejects(coordinator.confirmTargetInvalidated({
          principalId: TARGET_PRINCIPAL,
          request: {
            ...cleanupRequest,
            proof: { ...cleanupRequest.proof, cleanupSha256: '8'.repeat(64) },
          },
        }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
          && error.code === 'state-conflict');
        const expiry = new TerminalResponderExpiry({ coordination: store });
        assert.equal(await expiry.expire({
          operationId: begun.transferId,
          operationKind: 'authority-transfer',
          projectId: PROJECT_ID,
          removedAt: terminalExpiresAt,
        }), 'expired');
        await store.withProjectScope(PROJECT_ID, async scope => {
          assert.equal(await scope.portability.getTerminalResponder(
            'authority-transfer',
            begun.transferId,
          ), undefined);
          assert.deepEqual(
            (await scope.portability.listTransferReceiptKeys(begun.transferId))
              .map(key => key.receiptKeyId),
            ['receipt-key-target-real'],
          );
        });
        const postExpiryBackupRecords = await store.withProjectScope(
          PROJECT_ID,
          scope => scope.checkpoint.readProjectCheckpointRecords({
            excludedOperationId: 'backup-after-cancelled-responder-expiry',
            maximumCoordinationBytes: 1024 * 1024,
            metadata: {
              authorityId: 'authority-real',
              authorityVolumeIdentity: 'volume-real',
              coordinationSchemaVersion: 11,
              maximumServerBuild: 'cloud-build-real',
              minimumServerBuild: 'cloud-build-real',
              repositoryFormatVersion: 1,
              restoreEpoch: 1,
            },
            profile: 'backup',
            snapshotAt: terminalExpiresAt,
          }),
        );
        const postExpiryEncoded = encodeCollabProjectBackupCheckpointCoordinationNdjson(
          postExpiryBackupRecords as readonly CollabProjectBackupRecord[],
        );
        assert.deepEqual(
          decodeCollabProjectBackupCheckpointCoordinationNdjson(postExpiryEncoded),
          postExpiryBackupRecords,
        );
        assert.equal(await expiry.expire({
          operationId: begun.transferId,
          operationKind: 'authority-transfer',
          projectId: PROJECT_ID,
          removedAt: terminalExpiresAt,
        }), 'replayed');
      } finally {
        await coordinator.close();
        await store.close();
      }
    });
  });
});
