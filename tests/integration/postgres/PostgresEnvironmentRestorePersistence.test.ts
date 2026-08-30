import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  COLLAB_PROTOCOL_VERSION,
  collabControlOperationCodec,
  decodeCollabAuthorityRelinquishmentProof,
  decodeCollabAuthorityTransferStatus,
  decodeCollabTransferredMembershipClaimCustodyReceipt,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabProjectBackupCheckpointCoordinationNdjson,
  encodeCollabProtectedClaimAssociatedData,
  type CollabProjectBackupRecord,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../../../src/config/PostgresSchemaCompatibility.js';
import { PostgresEnvironmentRestorePersistence } from '../../../src/coordination/postgres/PostgresEnvironmentRestorePersistence.js';
import { frameBackupProtectedSecretEnvelope } from '../../../src/coordination/backupProtectedSecretEnvelope.js';
import { withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

const CREATED_AT = '2026-08-29T00:00:00.000Z';
const EXPIRES_AT = '2026-09-29T00:00:00.000Z';
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_VOLUME_IDENTITY = 'restored-volume-identity-one';
const MAIN_OID = 'a'.repeat(40);
const LEAVE_RESPONSE_JSON = JSON.stringify(
  collabControlOperationCodec('leaveProject').decodeResponse({
    discardedRequestId: null,
    leftAt: EXPIRES_AT,
    managerSetGeneration: 1,
    memberId: 'member-left',
    projectId: PROJECT_ID,
    promotedSuccessorMemberId: null,
    status: 'left',
  }),
);
const LEAVE_RESULT_SHA256 = createHash('sha256')
  .update(LEAVE_RESPONSE_JSON)
  .digest('hex');
const INVITATION_EXPIRES_AT = '2026-08-30T00:00:00.000Z';
const SECRET_REPLAY_EXPIRES_AT = '2026-09-28T00:00:00.000Z';
const MEMBERSHIP_OFFER_RESPONSE_JSON = JSON.stringify(
  collabControlOperationCodec('createManagerResponsibilityOffer')
    .decodeResponse({
      offer: {
        acknowledgedAt: null,
        expiresAt: INVITATION_EXPIRES_AT,
        managerSetGenerationAtOffer: 1,
        offeredAt: CREATED_AT,
        offerId: 'offer-restored',
        purpose: 'manager-promotion',
        revision: 1,
        sourceManagerMemberId: 'member-manager',
        state: 'offered',
        targetMemberId: 'member-offline',
        targetMembershipRevisionAtOffer: 2,
        terminalAt: null,
      },
    }),
);
const REMOVE_RESPONSE_JSON = JSON.stringify(
  collabControlOperationCodec('removeMember').decodeResponse({
    discardedRequestId: null,
    managerSetGeneration: 1,
    memberId: 'member-revoked',
    projectId: PROJECT_ID,
    removedAt: EXPIRES_AT,
    status: 'revoked',
  }),
);
const REMOVE_RESULT_SHA256 = createHash('sha256')
  .update(REMOVE_RESPONSE_JSON)
  .digest('hex');
const CREATE_RESPONSE_JSON = JSON.stringify(
  collabControlOperationCodec('createCloudProject').decodeResponse({
    createdAt: CREATED_AT,
    mainOid: MAIN_OID,
    managerSetGeneration: 1,
    memberId: 'member-manager',
    membershipRevision: 2,
    personalRef: 'refs/heads/members/member-manager',
    projectId: PROJECT_ID,
    role: 'manager',
  }),
);
const CREATE_RESULT_SHA256 = createHash('sha256')
  .update(CREATE_RESPONSE_JSON)
  .digest('hex');
const JOIN_RESPONSE_JSON = JSON.stringify(
  collabControlOperationCodec('joinCloudProject').decodeResponse({
    joinedAt: CREATED_AT,
    mainOid: MAIN_OID,
    managerSetGeneration: 1,
    memberId: 'member-offline',
    membershipRevision: 2,
    personalRef: 'refs/heads/members/member-offline',
    projectId: PROJECT_ID,
    role: 'member',
  }),
);
const JOIN_RESULT_SHA256 = createHash('sha256')
  .update(JOIN_RESPONSE_JSON)
  .digest('hex');
const SOURCE_METADATA = Object.freeze({
  authorityId: 'authority-cloud-one',
  authorityVolumeIdentity: 'volume-identity-one',
  coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
  maximumServerBuild: 'cloud-build-one',
  minimumServerBuild: 'cloud-build-one',
  repositoryFormatVersion: 1,
  restoreEpoch: 3,
});
const TRANSFER_ID = 'transfer-cloud-lan';
const TRANSFER_CHECKPOINT_SHA256 = '8'.repeat(64);
const TRANSFER_BATCH_SHA256 = '9'.repeat(64);
const TRANSFER_ACTIVATION_REQUEST_SHA256 = 'a'.repeat(64);
const RECEIPT_PUBLIC_KEY = Buffer.alloc(32, 3).toString('base64url');
const TRANSFER_PROOF = decodeCollabAuthorityRelinquishmentProof({
  batchRevision: 1,
  batchSha256: TRANSFER_BATCH_SHA256,
  certificate: Buffer.alloc(64, 4).toString('base64url'),
  certificateAlgorithm: 'ed25519',
  checkpointSha256: TRANSFER_CHECKPOINT_SHA256,
  committedAt: CREATED_AT,
  operationIntentId: 'relinquish-cloud-one',
  projectId: PROJECT_ID,
  sourceAuthority: { generation: 4, kind: 'cloud' },
  sourceHostMemberId: null,
  targetAuthority: { generation: 5, kind: 'lan' },
  transferId: TRANSFER_ID,
});
const TRANSFER_BATCH_RECEIPT =
  decodeCollabTransferredMembershipClaimCustodyReceipt({
    batchRevision: 1,
    batchSha256: TRANSFER_BATCH_SHA256,
    checkpointSha256: TRANSFER_CHECKPOINT_SHA256,
    committedAt: CREATED_AT,
    custodyAuthority: { generation: 4, kind: 'cloud' },
    operationIntentId: 'batch-custody-one',
    projectId: PROJECT_ID,
    receiptId: 'batch-receipt-one',
    submittedByMemberId: 'member-manager',
    targetAuthorityGeneration: 5,
    transferId: TRANSFER_ID,
  });
const TRANSFER_STATUS = decodeCollabAuthorityTransferStatus({
  batchRevision: 1,
  batchSha256: TRANSFER_BATCH_SHA256,
  checkpointSha256: TRANSFER_CHECKPOINT_SHA256,
  createdAt: CREATED_AT,
  direction: 'cloud-to-lan',
  expiresAt: EXPIRES_AT,
  phase: 'completed',
  projectId: PROJECT_ID,
  relinquishmentProof: TRANSFER_PROOF,
  sourceAuthority: { generation: 4, kind: 'cloud' },
  state: 'completed',
  targetAuthority: { generation: 5, kind: 'lan' },
  targetUrl: 'https://lan.example.invalid',
  transferId: TRANSFER_ID,
  updatedAt: CREATED_AT,
});
const PROTECTED_ASSOCIATED_DATA = Object.freeze({
  authorityGeneration: 4,
  checkpointSha256: TRANSFER_CHECKPOINT_SHA256,
  claimSha256: 'b'.repeat(64),
  envelopeVersion: 1 as const,
  environmentIdentity: SOURCE_METADATA.authorityVolumeIdentity,
  memberId: 'member-offline',
  projectId: PROJECT_ID,
  transferId: TRANSFER_ID,
});
const LAN_TRANSFER_ID = 'transfer-lan-cloud';
const LAN_CHECKPOINT_SHA256 = 'c'.repeat(64);
const LAN_BATCH_SHA256 = 'd'.repeat(64);
const LAN_CLAIM_SHA256 = 'e'.repeat(64);
const LAN_RECEIPT_PUBLIC_KEY = Buffer.alloc(32, 5).toString('base64url');
const LAN_BATCH_RECEIPT = decodeCollabTransferredMembershipClaimCustodyReceipt({
  batchRevision: 2,
  batchSha256: LAN_BATCH_SHA256,
  checkpointSha256: LAN_CHECKPOINT_SHA256,
  committedAt: CREATED_AT,
  custodyAuthority: { generation: 5, kind: 'lan' },
  operationIntentId: 'batch-custody-lan-one',
  projectId: PROJECT_ID,
  receiptId: 'batch-receipt-lan-one',
  submittedByMemberId: 'member-manager',
  targetAuthorityGeneration: 6,
  transferId: LAN_TRANSFER_ID,
});
const LAN_REDEMPTION_RECEIPT =
  decodeCollabTransferredMembershipRedemptionReceipt({
    checkpointSha256: LAN_CHECKPOINT_SHA256,
    claimSha256: LAN_CLAIM_SHA256,
    memberId: 'member-offline',
    operationIntentId: 'redeem-lan-one',
    projectId: PROJECT_ID,
    receiptId: 'redemption-receipt-lan-one',
    receiptKeyId: 'receipt-key-lan-cloud',
    redeemedAt: CREATED_AT,
    signature: Buffer.alloc(64, 6).toString('base64url'),
    signatureAlgorithm: 'ed25519',
    targetAuthorityGeneration: 6,
    transferId: LAN_TRANSFER_ID,
  });

async function waitForBlockedRestoreLock(client: Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const waiting = await client.query<{ readonly waiting: string }>(
      `SELECT count(*) AS waiting
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = 1665883532
          AND objid = 2
          AND NOT granted`,
    );
    if (waiting.rows[0]?.waiting === '1') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('restore-test-lock-wait-not-observed');
}

async function settleBeforeTest<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('restore-test-operation-timeout')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function minimumBackupRecords() {
  return Object.freeze([
    Object.freeze({
      kind: 'project' as const,
      recordId: PROJECT_ID,
      revision: 7,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        authorityGeneration: 5,
        createdAt: CREATED_AT,
        expectedMainOid: MAIN_OID,
        managerSetGeneration: 1,
        name: 'Restored Project',
        projectId: PROJECT_ID,
      }),
    }),
    Object.freeze({
      kind: 'member' as const,
      recordId: 'member-left',
      revision: 4,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Former Member',
        memberId: 'member-left',
        personalRef: 'refs/heads/members/member-left',
        projectId: PROJECT_ID,
        role: 'member' as const,
        status: 'left' as const,
        revokedAt: EXPIRES_AT,
        updatedAt: EXPIRES_AT,
      }),
    }),
    Object.freeze({
      kind: 'member' as const,
      recordId: 'member-manager',
      revision: 3,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Manager',
        memberId: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        projectId: PROJECT_ID,
        role: 'manager' as const,
        status: 'active' as const,
        revokedAt: null,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'member' as const,
      recordId: 'member-offline',
      revision: 2,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Offline Member',
        memberId: 'member-offline',
        personalRef: 'refs/heads/members/member-offline',
        projectId: PROJECT_ID,
        role: 'member' as const,
        status: 'active' as const,
        revokedAt: null,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'member' as const,
      recordId: 'member-override',
      revision: 2,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Override Member',
        memberId: 'member-override',
        personalRef: 'refs/heads/members/member-override',
        projectId: PROJECT_ID,
        role: 'member' as const,
        status: 'active' as const,
        revokedAt: null,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'member' as const,
      recordId: 'member-revoked',
      revision: 5,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Revoked Member',
        memberId: 'member-revoked',
        personalRef: 'refs/heads/members/member-revoked',
        projectId: PROJECT_ID,
        role: 'member' as const,
        status: 'revoked' as const,
        revokedAt: EXPIRES_AT,
        updatedAt: EXPIRES_AT,
      }),
    }),
    Object.freeze({
      kind: 'request' as const,
      recordId: 'request-one',
      revision: 2,
      value: Object.freeze({
        createdAt: CREATED_AT,
        description: 'Restore request',
        firstBaseOid: MAIN_OID,
        latestHeadOid: MAIN_OID,
        memberId: 'member-manager',
        mergedOid: null,
        projectId: PROJECT_ID,
        requestId: 'request-one',
        status: 'open' as const,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'request-comment' as const,
      recordId: 'request-comment-one',
      revision: 1,
      value: Object.freeze({
        authorMemberId: 'member-manager',
        body: 'Request comment',
        commentId: 'request-comment-one',
        createdAt: CREATED_AT,
        projectId: PROJECT_ID,
        requestId: 'request-one',
      }),
    }),
    Object.freeze({
      kind: 'ticket' as const,
      recordId: 'ticket-one',
      revision: 3,
      value: Object.freeze({
        authorMemberId: 'member-manager',
        body: 'Restore ticket',
        closedAt: null,
        closedByMemberId: null,
        createdAt: CREATED_AT,
        number: 1,
        projectId: PROJECT_ID,
        status: 'open' as const,
        ticketId: 'ticket-one',
        title: 'Restore continuity',
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'ticket-comment' as const,
      recordId: 'ticket-comment-one',
      revision: 1,
      value: Object.freeze({
        authorMemberId: 'member-manager',
        body: 'Ticket comment',
        commentId: 'ticket-comment-one',
        createdAt: CREATED_AT,
        projectId: PROJECT_ID,
        ticketId: 'ticket-one',
      }),
    }),
    Object.freeze({
      kind: 'ticket-relation' as const,
      recordId: 'relation-one',
      revision: 1,
      value: Object.freeze({
        acceptedAt: null,
        acceptedMergeOid: null,
        commitOid: MAIN_OID,
        createdAt: CREATED_AT,
        createdByMemberId: 'member-manager',
        kind: 'references' as const,
        projectId: PROJECT_ID,
        relationId: 'relation-one',
        requestId: 'request-one',
        state: 'pending' as const,
        ticketId: 'ticket-one',
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'ticket-mention' as const,
      recordId: `ticket-mention:${createHash('sha256').update([
        'ticket-one',
        'description',
        'ticket-one',
        'member-manager',
      ].join('\0')).digest('hex')}`,
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        mentionedMemberId: 'member-manager',
        projectId: PROJECT_ID,
        sourceId: 'ticket-one',
        sourceKind: 'description' as const,
        ticketId: 'ticket-one',
      }),
    }),
    Object.freeze({
      kind: 'cloud-event' as const,
      recordId: '00000000000000000001',
      revision: 1,
      value: Object.freeze({
        event: Object.freeze({
          kind: 'main.updated' as const,
          occurredAt: CREATED_AT,
          payload: Object.freeze({ mainOid: MAIN_OID, requestId: 'request-one' }),
          projectId: PROJECT_ID,
          protocolVersion: COLLAB_PROTOCOL_VERSION,
          sequence: 1,
        }),
      }),
    }),
    Object.freeze({
      kind: 'cloud-event-cursor' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        currentSequence: 1,
        projectId: PROJECT_ID,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'idempotency-result' as const,
      recordId: `${PROJECT_ID}:member-left:leaveProject:leave-intent-one`,
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        idempotencyKey: 'leave-intent-one',
        memberId: 'member-left',
        operation: 'leaveProject' as const,
        projectId: PROJECT_ID,
        requestFingerprint: '5'.repeat(64),
        responseJson: LEAVE_RESPONSE_JSON,
      }),
    }),
    Object.freeze({
      kind: 'idempotency-result' as const,
      recordId: `${PROJECT_ID}:member-manager:createCloudProject:create-restored-key`,
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        idempotencyKey: 'create-restored-key',
        memberId: 'member-manager',
        operation: 'createCloudProject' as const,
        projectId: PROJECT_ID,
        requestFingerprint: '2'.repeat(64),
        responseJson: CREATE_RESPONSE_JSON,
      }),
    }),
    Object.freeze({
      kind: 'idempotency-result' as const,
      recordId: `${PROJECT_ID}:member-manager:createManagerResponsibilityOffer:offer-restored-key`,
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        idempotencyKey: 'offer-restored-key',
        memberId: 'member-manager',
        operation: 'createManagerResponsibilityOffer' as const,
        projectId: PROJECT_ID,
        requestFingerprint: '0'.repeat(64),
        responseJson: MEMBERSHIP_OFFER_RESPONSE_JSON,
      }),
    }),
    Object.freeze({
      kind: 'idempotency-result' as const,
      recordId: `${PROJECT_ID}:member-manager:removeMember:remove-restored-key`,
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        idempotencyKey: 'remove-restored-key',
        memberId: 'member-manager',
        operation: 'removeMember' as const,
        projectId: PROJECT_ID,
        requestFingerprint: '9'.repeat(64),
        responseJson: REMOVE_RESPONSE_JSON,
      }),
    }),
    Object.freeze({
      kind: 'idempotency-result' as const,
      recordId: `${PROJECT_ID}:member-manager:retireProject:update-main-one`,
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        idempotencyKey: 'update-main-one',
        memberId: 'member-manager',
        operation: 'retireProject' as const,
        projectId: PROJECT_ID,
        requestFingerprint: '1'.repeat(64),
        responseJson: JSON.stringify({
          acknowledgementRequired: true,
          kind: 'project-retired',
          projectId: PROJECT_ID,
          retiredAt: CREATED_AT,
          retirementId: 'retirement-one',
          terminalExpiresAt: EXPIRES_AT,
        }),
      }),
    }),
    Object.freeze({
      kind: 'idempotency-result' as const,
      recordId: `${PROJECT_ID}:member-offline:joinCloudProject:join-restored-key`,
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        idempotencyKey: 'join-restored-key',
        memberId: 'member-offline',
        operation: 'joinCloudProject' as const,
        projectId: PROJECT_ID,
        requestFingerprint: '3'.repeat(64),
        responseJson: JOIN_RESPONSE_JSON,
      }),
    }),
    Object.freeze({
      kind: 'principal-binding' as const,
      recordId: 'member-manager',
      revision: 1,
      value: Object.freeze({
        boundAt: CREATED_AT,
        memberId: 'member-manager',
        principalId: 'principal:manager',
        projectId: PROJECT_ID,
      }),
    }),
    Object.freeze({
      kind: 'principal-binding' as const,
      recordId: 'member-offline',
      revision: 1,
      value: Object.freeze({
        boundAt: CREATED_AT,
        memberId: 'member-offline',
        principalId: 'principal:offline',
        projectId: PROJECT_ID,
      }),
    }),
    Object.freeze({
      kind: 'repository-placement' as const,
      recordId: `repository-placement:${PROJECT_ID}`,
      revision: 7,
      value: Object.freeze({
        nodeId: 'source-node',
        placementGeneration: 7,
        projectId: PROJECT_ID,
        repositoryIdentity: 'source-repository',
      }),
    }),
    Object.freeze({
      kind: 'lifecycle-journal' as const,
      recordId: 'backup-previous',
      revision: 1,
      value: Object.freeze({
        actorMemberId: null,
        batchRevision: null,
        batchSha256: null,
        checkpointSha256: '2'.repeat(64),
        createdAt: CREATED_AT,
        direction: null,
        expectedAuthorityGeneration: 5,
        expectedPersonalRefOid: null,
        idempotencyKey: 'backup-previous',
        operationId: 'backup-previous',
        operationKind: 'backup' as const,
        phase: 'completed',
        projectId: PROJECT_ID,
        recoveryFromPhase: null,
        requestFingerprint: '3'.repeat(64),
        resultSha256: '4'.repeat(64),
        scheduledAt: CREATED_AT,
        state: 'completed' as const,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'lifecycle-journal' as const,
      recordId: 'create-restored',
      revision: 1,
      value: Object.freeze({
        actorMemberId: null,
        batchRevision: null,
        batchSha256: null,
        checkpointSha256: null,
        createdAt: CREATED_AT,
        direction: null,
        expectedAuthorityGeneration: 5,
        expectedPersonalRefOid: null,
        idempotencyKey: 'create-restored-key',
        operationId: 'create-restored',
        operationKind: 'create-project' as const,
        phase: 'completed',
        projectId: PROJECT_ID,
        recoveryFromPhase: null,
        requestFingerprint: '2'.repeat(64),
        resultSha256: CREATE_RESULT_SHA256,
        scheduledAt: CREATED_AT,
        state: 'completed' as const,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'lifecycle-journal' as const,
      recordId: 'join-restored',
      revision: 1,
      value: Object.freeze({
        actorMemberId: null,
        batchRevision: null,
        batchSha256: null,
        checkpointSha256: null,
        createdAt: CREATED_AT,
        direction: null,
        expectedAuthorityGeneration: 5,
        expectedPersonalRefOid: null,
        idempotencyKey: 'join-restored-key',
        operationId: 'join-restored',
        operationKind: 'join-project' as const,
        phase: 'completed',
        projectId: PROJECT_ID,
        recoveryFromPhase: null,
        requestFingerprint: '3'.repeat(64),
        resultSha256: JOIN_RESULT_SHA256,
        scheduledAt: CREATED_AT,
        state: 'completed' as const,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'lifecycle-journal' as const,
      recordId: 'leave-previous',
      revision: 1,
      value: Object.freeze({
        actorMemberId: 'member-left',
        batchRevision: null,
        batchSha256: null,
        checkpointSha256: null,
        createdAt: CREATED_AT,
        direction: null,
        expectedAuthorityGeneration: 5,
        expectedPersonalRefOid: MAIN_OID,
        idempotencyKey: 'leave-intent-one',
        operationId: 'leave-previous',
        operationKind: 'leave' as const,
        phase: 'completed',
        projectId: PROJECT_ID,
        recoveryFromPhase: null,
        requestFingerprint: '5'.repeat(64),
        resultSha256: LEAVE_RESULT_SHA256,
        scheduledAt: EXPIRES_AT,
        state: 'completed' as const,
        updatedAt: EXPIRES_AT,
      }),
    }),
    Object.freeze({
      kind: 'lifecycle-journal' as const,
      recordId: 'remove-restored',
      revision: 1,
      value: Object.freeze({
        actorMemberId: 'member-manager',
        batchRevision: null,
        batchSha256: null,
        checkpointSha256: null,
        createdAt: CREATED_AT,
        direction: null,
        expectedAuthorityGeneration: 5,
        expectedPersonalRefOid: null,
        idempotencyKey: 'remove-restored-key',
        operationId: 'remove-restored',
        operationKind: 'remove-member' as const,
        phase: 'completed',
        projectId: PROJECT_ID,
        recoveryFromPhase: null,
        requestFingerprint: '9'.repeat(64),
        resultSha256: REMOVE_RESULT_SHA256,
        scheduledAt: CREATED_AT,
        state: 'completed' as const,
        updatedAt: EXPIRES_AT,
      }),
    }),
    Object.freeze({
      kind: 'lifecycle-journal' as const,
      recordId: TRANSFER_ID,
      revision: 1,
      value: Object.freeze({
        actorMemberId: 'member-manager',
        batchRevision: 1,
        batchSha256: TRANSFER_BATCH_SHA256,
        checkpointSha256: TRANSFER_CHECKPOINT_SHA256,
        createdAt: CREATED_AT,
        direction: 'cloud-to-lan' as const,
        expectedAuthorityGeneration: 4,
        expectedPersonalRefOid: null,
        idempotencyKey: 'transfer-cloud-lan-intent',
        operationId: TRANSFER_ID,
        operationKind: 'authority-transfer' as const,
        phase: 'completed',
        projectId: PROJECT_ID,
        recoveryFromPhase: null,
        requestFingerprint: 'c'.repeat(64),
        resultSha256: 'd'.repeat(64),
        scheduledAt: EXPIRES_AT,
        state: 'completed' as const,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'lifecycle-journal' as const,
      recordId: LAN_TRANSFER_ID,
      revision: 1,
      value: Object.freeze({
        actorMemberId: 'member-manager',
        batchRevision: 2,
        batchSha256: LAN_BATCH_SHA256,
        checkpointSha256: LAN_CHECKPOINT_SHA256,
        createdAt: CREATED_AT,
        direction: 'lan-to-cloud' as const,
        expectedAuthorityGeneration: 5,
        expectedPersonalRefOid: null,
        idempotencyKey: 'transfer-lan-cloud-intent',
        operationId: LAN_TRANSFER_ID,
        operationKind: 'authority-transfer' as const,
        phase: 'claims-retained',
        projectId: PROJECT_ID,
        recoveryFromPhase: null,
        requestFingerprint: 'f'.repeat(64),
        resultSha256: null,
        scheduledAt: EXPIRES_AT,
        state: 'active' as const,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'authority-transfer-recovery' as const,
      recordId: TRANSFER_ID,
      revision: 1,
      value: Object.freeze({
        cancellationRequestSha256: null,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        inactivePublication: null,
        projectId: PROJECT_ID,
        relinquishmentProof: TRANSFER_PROOF,
        sourceAuthority: Object.freeze({ generation: 4, kind: 'cloud' as const }),
        sourceHostMemberId: null,
        sourceEvidence: null,
        sourceReopenSha256: null,
        stageSha256: 'e'.repeat(64),
        targetActivationProof: 'AA',
        targetActivationRequestSha256: TRANSFER_ACTIVATION_REQUEST_SHA256,
        targetAuthority: Object.freeze({ generation: 5, kind: 'lan' as const }),
        targetHostMemberId: 'member-manager',
        targetEvidence: Object.freeze({
          acceptanceIntentId: 'accept-cloud-lan-one',
          principalId: 'principal:manager',
          proof: 'AA',
          receiptKeyId: 'receipt-key-cloud-lan',
          receiptPublicKey: RECEIPT_PUBLIC_KEY,
          schemaVersion: 1 as const,
        }),
        targetUrl: 'https://lan.example.invalid',
        transferId: TRANSFER_ID,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'authority-transfer-recovery' as const,
      recordId: LAN_TRANSFER_ID,
      revision: 1,
      value: Object.freeze({
        cancellationRequestSha256: null,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        inactivePublication: null,
        projectId: PROJECT_ID,
        relinquishmentProof: null,
        sourceAuthority: Object.freeze({ generation: 5, kind: 'lan' as const }),
        sourceHostMemberId: 'member-manager',
        sourceEvidence: Object.freeze({
          checkpointManifestSha256: LAN_CHECKPOINT_SHA256,
          principalId: 'principal:manager',
          proof: 'AA',
          receiptKeyId: 'receipt-key-lan-cloud',
          receiptPublicKey: LAN_RECEIPT_PUBLIC_KEY,
          schemaVersion: 1 as const,
        }),
        sourceReopenSha256: null,
        stageSha256: LAN_CHECKPOINT_SHA256,
        targetActivationProof: null,
        targetActivationRequestSha256: null,
        targetAuthority: Object.freeze({ generation: 6, kind: 'cloud' as const }),
        targetHostMemberId: null,
        targetEvidence: null,
        targetUrl: 'https://cloud.example.invalid',
        transferId: LAN_TRANSFER_ID,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'transferred-membership-claim' as const,
      recordId: `${LAN_TRANSFER_ID}:member-offline`,
      revision: 1,
      value: Object.freeze({
        batchRevision: 2,
        checkpointSha256: LAN_CHECKPOINT_SHA256,
        claimSha256: LAN_CLAIM_SHA256,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        memberId: 'member-offline',
        operationIntentId: LAN_REDEMPTION_RECEIPT.operationIntentId,
        projectId: PROJECT_ID,
        redemptionReceiptId: LAN_REDEMPTION_RECEIPT.receiptId,
        state: 'redeemed' as const,
        targetPrincipalId: 'principal:offline',
        transferId: LAN_TRANSFER_ID,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'transferred-membership-claim' as const,
      recordId: `${LAN_TRANSFER_ID}:member-override`,
      revision: 1,
      value: Object.freeze({
        batchRevision: 2,
        checkpointSha256: LAN_CHECKPOINT_SHA256,
        claimSha256: '0'.repeat(64),
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        memberId: 'member-override',
        operationIntentId: null,
        projectId: PROJECT_ID,
        redemptionReceiptId: null,
        state: 'unclaimed' as const,
        targetPrincipalId: null,
        transferId: LAN_TRANSFER_ID,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'transfer-receipt-key' as const,
      recordId: `${TRANSFER_ID}:receipt-key-cloud-lan`,
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        projectId: PROJECT_ID,
        receiptKeyId: 'receipt-key-cloud-lan',
        receiptPublicKey: RECEIPT_PUBLIC_KEY,
        receiptPublicKeyEncoding: 'base64url-raw' as const,
        signatureAlgorithm: 'ed25519' as const,
        transferId: TRANSFER_ID,
      }),
    }),
    Object.freeze({
      kind: 'transfer-receipt-key' as const,
      recordId: `${LAN_TRANSFER_ID}:receipt-key-lan-cloud`,
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        projectId: PROJECT_ID,
        receiptKeyId: 'receipt-key-lan-cloud',
        receiptPublicKey: LAN_RECEIPT_PUBLIC_KEY,
        receiptPublicKeyEncoding: 'base64url-raw' as const,
        signatureAlgorithm: 'ed25519' as const,
        transferId: LAN_TRANSFER_ID,
      }),
    }),
    Object.freeze({
      kind: 'transfer-claim-batch-receipt' as const,
      recordId: TRANSFER_ID,
      revision: 1,
      value: Object.freeze({ receipt: TRANSFER_BATCH_RECEIPT }),
    }),
    Object.freeze({
      kind: 'transfer-claim-batch-receipt' as const,
      recordId: LAN_TRANSFER_ID,
      revision: 1,
      value: Object.freeze({ receipt: LAN_BATCH_RECEIPT }),
    }),
    Object.freeze({
      kind: 'transfer-redemption-receipt' as const,
      recordId: `${LAN_TRANSFER_ID}:member-offline`,
      revision: 1,
      value: Object.freeze({
        acknowledgedAt: null,
        projectId: PROJECT_ID,
        receipt: LAN_REDEMPTION_RECEIPT,
      }),
    }),
    Object.freeze({
      kind: 'terminal-principal' as const,
      recordId: `${TRANSFER_ID}:member-manager`,
      revision: 1,
      value: Object.freeze({
        acknowledgedAt: null,
        memberId: 'member-manager',
        operationId: TRANSFER_ID,
        operationKind: 'authority-transfer' as const,
        principalId: 'principal:manager',
        projectId: PROJECT_ID,
      }),
    }),
    Object.freeze({
      kind: 'terminal-responder-replay' as const,
      recordId: TRANSFER_ID,
      revision: 1,
      value: Object.freeze({
        memberId: 'member-manager',
        operationId: TRANSFER_ID,
        projectId: PROJECT_ID,
        requestSha256: TRANSFER_ACTIVATION_REQUEST_SHA256,
      }),
    }),
    Object.freeze({
      kind: 'leave-former-principal-replay' as const,
      recordId: 'leave-previous',
      revision: 1,
      value: Object.freeze({
        completedAt: EXPIRES_AT,
        createdAt: CREATED_AT,
        expectedPersonalRefOid: MAIN_OID,
        expiresAt: '2026-10-29T00:00:00.000Z',
        intentId: 'leave-intent-one',
        memberId: 'member-left',
        operationId: 'leave-previous',
        principalSha256: '7'.repeat(64),
        projectId: PROJECT_ID,
        requestFingerprint: '5'.repeat(64),
        resultSha256: LEAVE_RESULT_SHA256,
        state: 'completed' as const,
      }),
    }),
    Object.freeze({
      kind: 'project-invitation' as const,
      recordId: 'invitation-join-restored',
      revision: 3,
      value: Object.freeze({
        createdAt: CREATED_AT,
        expiresAt: INVITATION_EXPIRES_AT,
        idempotencyKey: 'invitation-join-key',
        invitationId: 'invitation-join-restored',
        issuedByMemberId: 'member-manager',
        projectId: PROJECT_ID,
        requestFingerprint: '4'.repeat(64),
        revision: 3,
        secretReplayExpiresAt: SECRET_REPLAY_EXPIRES_AT,
        secretSha256: '5'.repeat(64),
        state: 'redeemed' as const,
        terminalAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'project-invitation' as const,
      recordId: 'invitation-restored',
      revision: 2,
      value: Object.freeze({
        createdAt: CREATED_AT,
        expiresAt: INVITATION_EXPIRES_AT,
        idempotencyKey: 'invitation-restored-key',
        invitationId: 'invitation-restored',
        issuedByMemberId: 'member-manager',
        projectId: PROJECT_ID,
        requestFingerprint: 'a'.repeat(64),
        revision: 2,
        secretReplayExpiresAt: SECRET_REPLAY_EXPIRES_AT,
        secretSha256: 'b'.repeat(64),
        state: 'revoked' as const,
        terminalAt: '2026-08-29T00:00:01.000Z',
      }),
    }),
    Object.freeze({
      kind: 'project-invitation' as const,
      recordId: 'invitation-tombstone',
      revision: 2,
      value: Object.freeze({
        createdAt: CREATED_AT,
        expiresAt: INVITATION_EXPIRES_AT,
        idempotencyKey: 'invitation-tombstone-key',
        invitationId: 'invitation-tombstone',
        issuedByMemberId: 'member-manager',
        projectId: PROJECT_ID,
        requestFingerprint: 'c'.repeat(64),
        revision: 2,
        secretReplayExpiresAt: SECRET_REPLAY_EXPIRES_AT,
        secretSha256: 'd'.repeat(64),
        state: 'expired' as const,
        terminalAt: INVITATION_EXPIRES_AT,
      }),
    }),
    Object.freeze({
      kind: 'protected-invitation-envelope' as const,
      recordId: 'invitation-join-restored',
      revision: 1,
      value: Object.freeze({
        associatedDataSha256: '6'.repeat(64),
        ciphertext: frameBackupProtectedSecretEnvelope({
          ciphertext: Buffer.from('join-secret').toString('base64url'),
          keyVersion: 3,
          tag: Buffer.alloc(16, 6).toString('base64url'),
        }),
        createdAt: CREATED_AT,
        expiresAt: SECRET_REPLAY_EXPIRES_AT,
        invitationId: 'invitation-join-restored',
        keyId: 'membership-custody-key',
        nonce: Buffer.alloc(24, 5).toString('base64url'),
        projectId: PROJECT_ID,
      }),
    }),
    Object.freeze({
      kind: 'protected-invitation-envelope' as const,
      recordId: 'invitation-restored',
      revision: 1,
      value: Object.freeze({
        associatedDataSha256: 'c'.repeat(64),
        ciphertext: frameBackupProtectedSecretEnvelope({
          ciphertext: Buffer.from('invitation-secret').toString('base64url'),
          keyVersion: 3,
          tag: Buffer.alloc(16, 8).toString('base64url'),
        }),
        createdAt: CREATED_AT,
        expiresAt: SECRET_REPLAY_EXPIRES_AT,
        invitationId: 'invitation-restored',
        keyId: 'membership-custody-key',
        nonce: Buffer.alloc(24, 7).toString('base64url'),
        projectId: PROJECT_ID,
      }),
    }),
    Object.freeze({
      kind: 'transferred-membership-claim-override' as const,
      recordId: `${LAN_TRANSFER_ID}:member-override:1`,
      revision: 1,
      value: Object.freeze({
        claimGeneration: 1,
        claimSha256: '1'.repeat(64),
        createdAt: CREATED_AT,
        expiresAt: SECRET_REPLAY_EXPIRES_AT,
        idempotencyKey: 'override-restored-key',
        managerMemberId: 'member-manager',
        memberId: 'member-override',
        projectId: PROJECT_ID,
        redemptionReceiptId: null,
        requestFingerprint: 'a'.repeat(64),
        secretReplayExpiresAt: SECRET_REPLAY_EXPIRES_AT,
        state: 'active' as const,
        supersededClaimSha256: '0'.repeat(64),
        targetPrincipalId: null,
        transferId: LAN_TRANSFER_ID,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'protected-claim-override-envelope' as const,
      recordId: `${LAN_TRANSFER_ID}:member-override:1`,
      revision: 1,
      value: Object.freeze({
        associatedDataSha256: 'b'.repeat(64),
        ciphertext: frameBackupProtectedSecretEnvelope({
          ciphertext: Buffer.from('override-secret').toString('base64url'),
          keyVersion: 3,
          tag: Buffer.alloc(16, 4).toString('base64url'),
        }),
        claimGeneration: 1,
        createdAt: CREATED_AT,
        expiresAt: SECRET_REPLAY_EXPIRES_AT,
        keyId: 'membership-custody-key',
        memberId: 'member-override',
        nonce: Buffer.alloc(24, 3).toString('base64url'),
        projectId: PROJECT_ID,
        transferId: LAN_TRANSFER_ID,
      }),
    }),
    Object.freeze({
      kind: 'manager-responsibility-offer' as const,
      recordId: 'offer-restored',
      revision: 2,
      value: Object.freeze({
        acknowledgedAt: null,
        expiresAt: INVITATION_EXPIRES_AT,
        idempotencyKey: 'offer-restored-key',
        managerSetGenerationAtOffer: 1,
        offeredAt: CREATED_AT,
        offerId: 'offer-restored',
        projectId: PROJECT_ID,
        purpose: 'manager-promotion' as const,
        requestFingerprint: '0'.repeat(64),
        revision: 2,
        sourceManagerMemberId: 'member-manager',
        state: 'consumed' as const,
        targetMemberId: 'member-offline',
        targetMembershipRevisionAtOffer: 2,
        terminalAt: '2026-08-29T00:00:01.000Z',
      }),
    }),
    Object.freeze({
      kind: 'membership-idempotency-tombstone' as const,
      recordId: 'cancelManagerResponsibilityOffer:member-manager:compacted-offer-key',
      revision: 1,
      value: Object.freeze({
        actorMemberId: 'member-manager',
        compactedAt: CREATED_AT,
        idempotencyKey: 'compacted-offer-key',
        operation: 'cancelManagerResponsibilityOffer' as const,
        projectId: PROJECT_ID,
        requestFingerprint: '6'.repeat(64),
      }),
    }),
    Object.freeze({
      kind: 'project-membership-recovery' as const,
      recordId: 'create-restored',
      revision: 1,
      value: Object.freeze({
        expectedMainOid: MAIN_OID,
        expectedPersonalRefOid: MAIN_OID,
        invitationId: null,
        memberId: 'member-manager',
        operationId: 'create-restored',
        operationKind: 'create-project' as const,
        principalSha256: createHash('sha256')
          .update('principal:manager')
          .digest('hex'),
        projectId: PROJECT_ID,
        publicationMarkerSha256: '7'.repeat(64),
        repositoryPlanSha256: '8'.repeat(64),
        requestFingerprint: '2'.repeat(64),
      }),
    }),
    Object.freeze({
      kind: 'project-membership-recovery' as const,
      recordId: 'join-restored',
      revision: 1,
      value: Object.freeze({
        expectedMainOid: MAIN_OID,
        expectedPersonalRefOid: MAIN_OID,
        invitationId: 'invitation-join-restored',
        memberId: 'member-offline',
        operationId: 'join-restored',
        operationKind: 'join-project' as const,
        principalSha256: createHash('sha256')
          .update('principal:offline')
          .digest('hex'),
        projectId: PROJECT_ID,
        publicationMarkerSha256: null,
        repositoryPlanSha256: null,
        requestFingerprint: '3'.repeat(64),
      }),
    }),
    Object.freeze({
      kind: 'project-membership-recovery' as const,
      recordId: 'remove-restored',
      revision: 1,
      value: Object.freeze({
        expectedMainOid: MAIN_OID,
        expectedPersonalRefOid: MAIN_OID,
        invitationId: null,
        memberId: 'member-revoked',
        operationId: 'remove-restored',
        operationKind: 'remove-member' as const,
        principalSha256: null,
        projectId: PROJECT_ID,
        publicationMarkerSha256: null,
        repositoryPlanSha256: null,
        requestFingerprint: '9'.repeat(64),
      }),
    }),
    Object.freeze({
      kind: 'secret-replay-tombstone' as const,
      recordId: 'createProjectInvitation:member-manager:invitation-tombstone-key',
      revision: 1,
      value: Object.freeze({
        actorMemberId: 'member-manager',
        expiredAt: SECRET_REPLAY_EXPIRES_AT,
        idempotencyKey: 'invitation-tombstone-key',
        operation: 'createProjectInvitation' as const,
        projectId: PROJECT_ID,
        requestFingerprint: 'c'.repeat(64),
      }),
    }),
    Object.freeze({
      kind: 'terminal-responder' as const,
      recordId: TRANSFER_ID,
      revision: 1,
      value: Object.freeze({
        acknowledgements: Object.freeze([]),
        eligibleMemberIds: Object.freeze(['member-manager']),
        expiresAt: EXPIRES_AT,
        operation: 'getProjectAuthorityTransfer' as const,
        operationId: TRANSFER_ID,
        projectId: PROJECT_ID,
        responseJson: JSON.stringify(TRANSFER_STATUS),
      }),
    }),
    Object.freeze({
      kind: 'protected-claim-envelope' as const,
      recordId: `${TRANSFER_ID}:member-offline`,
      revision: 1,
      value: Object.freeze({
        associatedData: PROTECTED_ASSOCIATED_DATA,
        associatedDataSha256: createHash('sha256')
          .update(encodeCollabProtectedClaimAssociatedData(
            PROTECTED_ASSOCIATED_DATA,
          ))
          .digest('hex'),
        ciphertext: Buffer.from('protected-claim').toString('base64url'),
        encryptionAlgorithm: 'xchacha20-poly1305' as const,
        expiresAt: EXPIRES_AT,
        keyId: 'custody-key-cloud-lan',
        keyVersion: 1,
        memberId: 'member-offline',
        nonce: Buffer.alloc(24, 1).toString('base64url'),
        receiptKeyId: 'receipt-key-cloud-lan',
        tag: Buffer.alloc(16, 2).toString('base64url'),
        transferId: TRANSFER_ID,
      }),
    }),
    Object.freeze({
      kind: 'protected-claim-envelope' as const,
      recordId: `${TRANSFER_ID}:member-override`,
      revision: 1,
      value: Object.freeze({
        associatedData: Object.freeze({
          ...PROTECTED_ASSOCIATED_DATA,
          claimSha256: '2'.repeat(64),
          memberId: 'member-override',
        }),
        associatedDataSha256: createHash('sha256')
          .update(encodeCollabProtectedClaimAssociatedData(Object.freeze({
            ...PROTECTED_ASSOCIATED_DATA,
            claimSha256: '2'.repeat(64),
            memberId: 'member-override',
          })))
          .digest('hex'),
        ciphertext: Buffer.from('protected-override-member').toString('base64url'),
        encryptionAlgorithm: 'xchacha20-poly1305' as const,
        expiresAt: EXPIRES_AT,
        keyId: 'custody-key-cloud-lan',
        keyVersion: 1,
        memberId: 'member-override',
        nonce: Buffer.alloc(24, 7).toString('base64url'),
        receiptKeyId: 'receipt-key-cloud-lan',
        tag: Buffer.alloc(16, 8).toString('base64url'),
        transferId: TRANSFER_ID,
      }),
    }),
    Object.freeze({
      kind: 'tombstone' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        authorityGeneration: 5,
        projectId: PROJECT_ID,
        retiredAt: CREATED_AT,
        terminalExpiresAt: EXPIRES_AT,
      }),
    }),
    Object.freeze({
      kind: 'schema-catalog' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
        projectId: PROJECT_ID,
        repositoryFormatVersion: 1,
      }),
    }),
    Object.freeze({
      kind: 'server-compatibility' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        maximumBuild: SOURCE_METADATA.maximumServerBuild,
        minimumBuild: SOURCE_METADATA.minimumServerBuild,
        projectId: PROJECT_ID,
      }),
    }),
    Object.freeze({
      kind: 'authority-volume-pair' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        authorityId: SOURCE_METADATA.authorityId,
        authorityVolumeIdentity: SOURCE_METADATA.authorityVolumeIdentity,
        projectId: PROJECT_ID,
        restoreEpoch: SOURCE_METADATA.restoreEpoch,
      }),
    }),
  ]);
}

describe('PostgresEnvironmentRestorePersistence', () => {
  it('rejects an old backup schema before creating restore state', async () => {
    await withPostgresTestDatabase(async database => {
      const persistence = new PostgresEnvironmentRestorePersistence({
        connectionString: database.migrationUrl,
      });
      await assert.rejects(persistence.createDatabase({
        authorityId: SOURCE_METADATA.authorityId,
        authorityVolumeId: database.authorityVolumeId,
        authorityVolumeIdentity: TARGET_VOLUME_IDENTITY,
        coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION - 1,
        operationId: 'restore-previous-schema',
        restoreEpoch: SOURCE_METADATA.restoreEpoch + 1,
        signal: new AbortController().signal,
      }));

      const client = new Client({ connectionString: database.migrationUrl });
      try {
        await client.connect();
        const schemas = await client.query<{
          readonly canonical: string | null;
          readonly restore: string | null;
        }>(
          `SELECT to_regnamespace('claudian_cloud')::text AS canonical,
                  to_regnamespace('claudian_cloud_restore')::text AS restore`,
        );
        assert.deepEqual(schemas.rows, [{ canonical: null, restore: null }]);
      } finally {
        await client.end();
      }
    });
  });

  it('creates one private restore fence before migrations and removes only its exact unpublished state', async () => {
    await withPostgresTestDatabase(async database => {
      const persistence = new PostgresEnvironmentRestorePersistence({
        connectionString: database.migrationUrl,
      });
      const signal = new AbortController().signal;
      const createInput = Object.freeze({
        authorityId: 'authority-cloud-one',
        authorityVolumeId: database.authorityVolumeId,
        authorityVolumeIdentity: 'volume-identity-one',
        coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
        operationId: 'restore-operation-one',
        restoreEpoch: 4,
      });

      await persistence.assertEmpty(signal);
      assert.deepEqual(
        await persistence.createDatabase({ ...createInput, signal }),
        { authorityVolumeId: database.authorityVolumeId },
      );
      assert.deepEqual(
        await persistence.createDatabase({ ...createInput, signal }),
        { authorityVolumeId: database.authorityVolumeId },
      );
      await persistence.verifyDatabaseIdentity(database.authorityVolumeId, signal);

      const migration = new Client({ connectionString: database.migrationUrl });
      const runtime = new Client({ connectionString: database.runtimeUrl });
      try {
        await Promise.all([migration.connect(), runtime.connect()]);
        const fence = await migration.query(
          `SELECT authority_id, authority_volume_id,
                  authority_volume_identity, operation_id, restore_epoch, state
             FROM claudian_cloud_restore.database_fence`,
        );
        assert.deepEqual(fence.rows, [{
          authority_id: createInput.authorityId,
          authority_volume_id: database.authorityVolumeId,
          authority_volume_identity: createInput.authorityVolumeIdentity,
          operation_id: createInput.operationId,
          restore_epoch: String(createInput.restoreEpoch),
          state: 'staged',
        }]);
        await assert.rejects(
          runtime.query('SELECT * FROM claudian_cloud_restore.database_fence'),
          /permission denied|does not exist/u,
        );
      } finally {
        await Promise.all([
          migration.end().catch(() => undefined),
          runtime.end().catch(() => undefined),
        ]);
      }

      await assert.rejects(
        persistence.createDatabase({
          ...createInput,
          operationId: 'restore-operation-other',
          signal,
        }),
        (error: unknown) => (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'state-conflict'
        ),
      );

      assert.equal(await persistence.classifyOrRemoveRestoreOwnedDatabase({
        authorityVolumeId: database.authorityVolumeId,
        operationId: createInput.operationId,
        signal,
      }), 'removed');
      assert.equal(await persistence.classifyOrRemoveRestoreOwnedDatabase({
        authorityVolumeId: database.authorityVolumeId,
        operationId: createInput.operationId,
        signal,
      }), 'replayed');
      await persistence.assertEmpty(signal);
    });
  });

  it('cancels a blocked restore lock before creating database state', async () => {
    await withPostgresTestDatabase(async database => {
      const holder = new Client({ connectionString: database.migrationUrl });
      const persistence = new PostgresEnvironmentRestorePersistence({
        connectionString: database.migrationUrl,
      });
      const controller = new AbortController();
      let operation: Promise<unknown> | undefined;
      try {
        await holder.connect();
        await holder.query('BEGIN');
        await holder.query(
          'SELECT pg_advisory_xact_lock(1665883532, 2)',
        );
        operation = persistence.createDatabase({
          authorityId: SOURCE_METADATA.authorityId,
          authorityVolumeId: database.authorityVolumeId,
          authorityVolumeIdentity: TARGET_VOLUME_IDENTITY,
          coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
          operationId: 'restore-operation-cancelled',
          restoreEpoch: SOURCE_METADATA.restoreEpoch + 1,
          signal: controller.signal,
        });
        await waitForBlockedRestoreLock(holder);
        controller.abort();
        const error = await settleBeforeTest(
          operation.then(
            () => undefined,
            (reason: unknown) => reason,
          ),
          1_000,
        );
        assert.ok(error instanceof Error);
        assert.equal('code' in error ? error.code : undefined, 'cancelled');
        const schemas = await holder.query(
          `SELECT to_regnamespace('claudian_cloud')::text AS canonical_schema,
                  to_regnamespace('claudian_cloud_restore')::text
                    AS restore_schema`,
        );
        assert.deepEqual(schemas.rows, [{
          canonical_schema: null,
          restore_schema: null,
        }]);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await operation?.catch(() => undefined);
        await holder.end().catch(() => undefined);
      }
    });
  });

  it('imports a canonical project when its restore ID collides with lifecycle history', async () => {
    await withPostgresTestDatabase(async database => {
      const persistence = new PostgresEnvironmentRestorePersistence({
        connectionString: database.migrationUrl,
      });
      const signal = new AbortController().signal;
      const operationId = TRANSFER_ID;
      const restoreEpoch = SOURCE_METADATA.restoreEpoch + 1;
      const project = Object.freeze({
        authorityGeneration: 5,
        backupId: 'backup-project-one',
        checkpointSha256: 'b'.repeat(64),
        expiresAt: EXPIRES_AT,
        placementGeneration: 7,
        projectId: PROJECT_ID,
      });
      const catalog = Object.freeze({
        ...SOURCE_METADATA,
        catalogId: 'environment-backup-one',
        catalogSha256: 'c'.repeat(64),
        createdAt: CREATED_AT,
        projects: Object.freeze([project]),
      });
      const repository = Object.freeze({
        artifactKey: 'repository-bundle-one',
        bundleByteCount: 1024,
        bundleSha256: 'd'.repeat(64),
        objectFormat: 'sha1' as const,
        operationId,
        placementGeneration: 8,
        projectId: PROJECT_ID,
        publicationMarkerSha256: 'e'.repeat(64),
        refs: Object.freeze([
          Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
          Object.freeze({
            name: 'refs/heads/members/member-manager',
            oid: MAIN_OID,
          }),
        ]),
        repositoryStorageKey: 'restored-repository-one',
        status: 'inactive' as const,
        storageNodeId: 'restore-node',
        validationMarkerSha256: 'f'.repeat(64),
      });
      const records = minimumBackupRecords();
      encodeCollabProjectBackupCheckpointCoordinationNdjson(records);

      await persistence.createDatabase({
        authorityId: catalog.authorityId,
        authorityVolumeId: database.authorityVolumeId,
        authorityVolumeIdentity: TARGET_VOLUME_IDENTITY,
        coordinationSchemaVersion: catalog.coordinationSchemaVersion,
        operationId,
        restoreEpoch,
        signal,
      });
      await persistence.importProject({
        operationId,
        project,
        records,
        restoreEpoch,
        signal,
      });
      await persistence.importProject({
        operationId,
        project,
        records,
        restoreEpoch,
        signal,
      });
      const driftedRecords = records.map(record => (
        record.kind === 'project'
          ? Object.freeze({
              ...record,
              value: Object.freeze({
                ...record.value,
                name: 'Drifted Project',
              }),
            })
          : record
      ));
      await assert.rejects(
        persistence.importProject({
          operationId,
          project,
          records: driftedRecords,
          restoreEpoch,
          signal,
        }),
        (error: unknown) => (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'state-conflict'
        ),
      );
      const additiveRecord: CollabProjectBackupRecord = Object.freeze({
        kind: 'request-comment',
        recordId: 'request-comment-two',
        revision: 1,
        value: Object.freeze({
          authorMemberId: 'member-manager',
          body: 'Additive replay drift',
          commentId: 'request-comment-two',
          createdAt: CREATED_AT,
          projectId: PROJECT_ID,
          requestId: 'request-one',
        }),
      });
      const additiveRecords = records.flatMap<CollabProjectBackupRecord>(record => (
        record.kind === 'request-comment'
          ? [record, additiveRecord]
          : [record]
      ));
      encodeCollabProjectBackupCheckpointCoordinationNdjson(additiveRecords);
      await assert.rejects(
        persistence.importProject({
          operationId,
          project,
          records: additiveRecords,
          restoreEpoch,
          signal,
        }),
        (error: unknown) => (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'state-conflict'
        ),
      );
      await persistence.importProject({
        operationId,
        project,
        records,
        restoreEpoch,
        signal,
      });
      await persistence.publishAuthority({
        catalog,
        operationId,
        repositories: Object.freeze([repository]),
        restoreEpoch,
        signal,
      });
      await persistence.publishAuthority({
        catalog,
        operationId,
        repositories: Object.freeze([repository]),
        restoreEpoch,
        signal,
      });
      await assert.rejects(
        persistence.publishAuthority({
          catalog,
          operationId,
          repositories: Object.freeze([Object.freeze({
            ...repository,
            repositoryStorageKey: 'drifted-repository',
          })]),
          restoreEpoch,
          signal,
        }),
        (error: unknown) => (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'state-conflict'
        ),
      );
      await persistence.verifyRestoredProject({
        operationId,
        project,
        records,
        repository,
        restoreEpoch,
        signal,
      });
      assert.deepEqual(
        await persistence.readRestoredContinuity(project, signal),
        records.filter(record => (
          record.kind === 'protected-claim-envelope'
          || record.kind === 'terminal-principal'
          || record.kind === 'terminal-responder'
          || record.kind === 'terminal-responder-replay'
          || record.kind === 'transfer-claim-batch-receipt'
          || record.kind === 'transfer-receipt-key'
          || record.kind === 'transfer-redemption-receipt'
          || record.kind === 'transferred-membership-claim'
        )),
      );
      assert.equal(await persistence.classifyOrRemoveRestoreOwnedDatabase({
        authorityVolumeId: database.authorityVolumeId,
        operationId,
        signal,
      }), 'authority-published');

      const client = new Client({ connectionString: database.migrationUrl });
      try {
        await client.connect();
        const fence = await client.query(
          `SELECT authority_volume_identity, state
             FROM claudian_cloud_restore.database_fence`,
        );
        assert.deepEqual(fence.rows, [{
          authority_volume_identity: TARGET_VOLUME_IDENTITY,
          state: 'published',
        }]);
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        const activeCatalog = await client.query(
          `SELECT generation, repository_storage_key, storage_node_id
             FROM claudian_cloud.active_repository_placement_catalog
            WHERE project_id = $1`,
          [PROJECT_ID],
        );
        await client.query('COMMIT');
        assert.deepEqual(activeCatalog.rows, [{
          generation: String(repository.placementGeneration),
          repository_storage_key: repository.repositoryStorageKey,
          storage_node_id: repository.storageNodeId,
        }]);
      } finally {
        await client.end();
      }
    });
  });

  it('restores a tombstone after its terminal responder retention expires', async () => {
    await withPostgresTestDatabase(async database => {
      const persistence = new PostgresEnvironmentRestorePersistence({
        connectionString: database.migrationUrl,
      });
      const signal = new AbortController().signal;
      const operationId = 'restore-operation-expired-responder';
      const restoreEpoch = SOURCE_METADATA.restoreEpoch + 1;
      const project = Object.freeze({
        authorityGeneration: 5,
        backupId: 'backup-project-expired-responder',
        checkpointSha256: '1'.repeat(64),
        expiresAt: EXPIRES_AT,
        placementGeneration: 7,
        projectId: PROJECT_ID,
      });
      const records = minimumBackupRecords().filter(record => (
        record.kind !== 'terminal-principal'
        && record.kind !== 'terminal-responder'
        && record.kind !== 'terminal-responder-replay'
      ));
      encodeCollabProjectBackupCheckpointCoordinationNdjson(records);

      await persistence.createDatabase({
        authorityId: SOURCE_METADATA.authorityId,
        authorityVolumeId: database.authorityVolumeId,
        authorityVolumeIdentity: TARGET_VOLUME_IDENTITY,
        coordinationSchemaVersion:
          SOURCE_METADATA.coordinationSchemaVersion,
        operationId,
        restoreEpoch,
        signal,
      });
      await persistence.importProject({
        operationId,
        project,
        records,
        restoreEpoch,
        signal,
      });

      const client = new Client({ connectionString: database.migrationUrl });
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        const tombstone = await client.query(
          `SELECT terminal_operation_kind, terminal_operation_id,
                  result_sha256
             FROM claudian_cloud.project_tombstones
            WHERE project_id = $1`,
          [PROJECT_ID],
        );
        const responders = await client.query(
          `SELECT operation_id
             FROM claudian_cloud.project_terminal_responders
            WHERE project_id = $1`,
          [PROJECT_ID],
        );
        const continuityCatalog = await client.query(
          `SELECT project_id
             FROM claudian_cloud.project_terminal_continuity_catalog
            WHERE project_id = $1`,
          [PROJECT_ID],
        );
        await client.query('COMMIT');
        assert.deepEqual(tombstone.rows, [{
          result_sha256: 'd'.repeat(64),
          terminal_operation_id: TRANSFER_ID,
          terminal_operation_kind: 'authority-transfer',
        }]);
        assert.deepEqual(responders.rows, []);
        assert.deepEqual(continuityCatalog.rows, [{ project_id: PROJECT_ID }]);
      } finally {
        await client.end();
      }
    });
  });

  it('restores retained terminal continuity without recreating a Project', async () => {
    await withPostgresTestDatabase(async database => {
      const persistence = new PostgresEnvironmentRestorePersistence({
        connectionString: database.migrationUrl,
      });
      const signal = new AbortController().signal;
      const operationId = 'restore-terminal-continuity';
      const restoreEpoch = SOURCE_METADATA.restoreEpoch + 1;
      const records = minimumBackupRecords().filter(record => (
        (
          record.kind === 'lifecycle-journal'
          && record.value.operationKind === 'authority-transfer'
        )
        || record.kind === 'protected-claim-envelope'
        || record.kind === 'terminal-principal'
        || record.kind === 'terminal-responder'
        || record.kind === 'terminal-responder-replay'
        || record.kind === 'tombstone'
        || record.kind === 'transfer-receipt-key'
        || record.kind === 'transfer-redemption-receipt'
      ));

      await persistence.createDatabase({
        authorityId: SOURCE_METADATA.authorityId,
        authorityVolumeId: database.authorityVolumeId,
        authorityVolumeIdentity: TARGET_VOLUME_IDENTITY,
        coordinationSchemaVersion: SOURCE_METADATA.coordinationSchemaVersion,
        operationId,
        restoreEpoch,
        signal,
      });
      await persistence.importTerminalProject({
        operationId,
        projectId: PROJECT_ID,
        records,
        restoreEpoch,
        signal,
      });
      await persistence.publishAuthority({
        catalog: Object.freeze({
          ...SOURCE_METADATA,
          createdAt: CREATED_AT,
          projects: Object.freeze([]),
        }),
        operationId,
        repositories: Object.freeze([]),
        restoreEpoch,
        signal,
      });
      await persistence.verifyRestoredTerminalProject({
        operationId,
        projectId: PROJECT_ID,
        records,
        restoreEpoch,
        signal,
      });

      const continuity = await persistence.readRestoredTerminalContinuity(
        PROJECT_ID,
        signal,
      );
      assert.deepEqual(continuity, records.filter(record => (
        record.kind !== 'lifecycle-journal' && record.kind !== 'tombstone'
      )));
      const client = new Client({ connectionString: database.migrationUrl });
      try {
        await client.connect();
        const projects = await client.query(
          'SELECT project_id FROM claudian_cloud.projects WHERE project_id = $1',
          [PROJECT_ID],
        );
        const terminal = await client.query(
          `SELECT project_id
             FROM claudian_cloud.project_terminal_continuity_catalog
            WHERE project_id = $1`,
          [PROJECT_ID],
        );
        assert.deepEqual(projects.rows, []);
        assert.deepEqual(terminal.rows, [{ project_id: PROJECT_ID }]);
      } finally {
        await client.end();
      }
    });
  });
});
