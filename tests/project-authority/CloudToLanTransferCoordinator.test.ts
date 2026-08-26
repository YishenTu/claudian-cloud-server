/* eslint-disable @typescript-eslint/no-this-alias, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  decodeCollabAuthorityTransferStatus,
  decodeCollabTransferredMembershipClaimBatch,
  encodeCollabProtectedClaimAssociatedData,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
  type CollabAuthorityTransferStatus,
  type CollabMemberId,
  type CollabTransferredMembershipClaimCustodyReceipt,
  type CollabTransferredMembershipRedemptionReceipt,
  type CancelProjectAuthorityTransferRequest,
} from '@claudian-collab/protocol';

import type {
  AcknowledgeTerminalResponderInput,
  AdvanceProjectLifecycleJournalInput,
  AuthorityTransferRecoveryEvidenceInput,
  AuthorityTransferRecoveryInput,
  AuthorityTransferRecoveryRecord,
  PortabilityLifecyclePersistence,
  ProjectDeletionIntentInput,
  ProjectLifecycleJournalRecord,
  ProjectPrincipalBindingRecord,
  ProjectTombstoneInput,
  ProtectedClaimEnvelopeInput,
  PutProjectLifecycleJournalInput,
  RenewProtectedClaimEnvelopesInput,
  ScrubProtectedClaimEnvelopeInput,
  TerminalResponderInput,
  TerminalResponderRecord,
  TransferReceiptKeyInput,
} from '../../src/coordination/PortabilityLifecyclePersistence.js';
import type {
  PinnedProjectLease,
  ProjectMembershipRecord,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import type {
  AdvanceProjectAuthorityStateInput,
  ProjectRecord,
} from '../../src/coordination/ProjectPersistence.js';
import type { RepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';
import {
  RepositoryCheckpointError,
} from '../../src/repositories/RepositoryCheckpointAuthority.js';
import {
  CloudToLanTransferCoordinator,
  CloudToLanTransferCoordinatorError,
  type CloudToLanCheckpointCapturePort,
  type CloudToLanClaimCustodyPort,
  type CloudToLanSourceFencePort,
  type CloudToLanTargetTrustPort,
} from '../../src/project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';

const PROJECT_ID = 'project-cloud-to-lan';
const MANAGER_ID = 'member-manager';
const TARGET_ID = 'member-target';
const OFFLINE_ID = 'member-offline';
const MANAGER_PRINCIPAL = 'principal:manager';
const TARGET_PRINCIPAL = 'principal:target';
const OFFLINE_PRINCIPAL = 'principal:offline';
const TARGET_URL = 'https://lan.example.test';
const CHECKPOINT_SHA = '1'.repeat(64);
const STAGE_SHA = '2'.repeat(64);
const MAIN_OID = '3'.repeat(40);
const CREATED_AT = '2026-08-27T00:00:00.000Z';
const EXPIRES_AT = '2026-09-26T00:00:00.000Z';
const PUBLIC_KEY = Buffer.alloc(32, 8).toString('base64url');
const SIGNATURE = Buffer.alloc(64, 9).toString('base64url');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function member(
  memberId: CollabMemberId,
  role: 'manager' | 'member',
): ProjectMembershipRecord {
  return Object.freeze({
    displayName: memberId,
    memberId,
    revision: 1n,
    role,
    status: 'active',
  });
}

function binding(
  memberId: CollabMemberId,
  principalId: string,
): ProjectPrincipalBindingRecord {
  return Object.freeze({
    boundAt: CREATED_AT,
    memberId,
    principalId,
    revokedAt: undefined,
    state: 'active',
  });
}

class MemoryState {
  readonly bindings = new Map<string, ProjectPrincipalBindingRecord>();
  readonly deletionJournals = new Map<string, ProjectLifecycleJournalRecord>();
  readonly envelopes = new Map<CollabMemberId, ProtectedClaimEnvelopeInput>();
  readonly keys = new Map<string, TransferReceiptKeyInput>();
  readonly members = new Map<CollabMemberId, ProjectMembershipRecord>();
  custodyReceipt: CollabTransferredMembershipClaimCustodyReceipt | undefined;
  deletionIntent: ProjectDeletionIntentInput | undefined;
  failNextJournalPhase: string | undefined;
  journal: ProjectLifecycleJournalRecord | undefined;
  placement: RepositoryPlacementLease = Object.freeze({
    active: true,
    generation: 7,
    projectId: PROJECT_ID,
    repositoryStorageKey: 'repository_cloud_to_lan',
    storageNodeId: 'local',
  });
  project: ProjectRecord = Object.freeze({
    activatedAt: CREATED_AT,
    authorityGeneration: 4,
    authorityStateRevision: 1,
    createdAt: CREATED_AT,
    expectedMainOid: MAIN_OID,
    managerSetGeneration: 1,
    projectId: PROJECT_ID,
    projectName: 'Cloud to LAN',
    serviceState: 'active',
  });
  recovery: AuthorityTransferRecoveryRecord | undefined;
  responder: TerminalResponderRecord | undefined;
  tombstone: ProjectTombstoneInput | undefined;

  constructor(singleMember = false) {
    if (singleMember) {
      this.members.set(TARGET_ID, member(TARGET_ID, 'manager'));
      this.bindings.set(TARGET_PRINCIPAL, binding(TARGET_ID, TARGET_PRINCIPAL));
    } else {
      this.members.set(MANAGER_ID, member(MANAGER_ID, 'manager'));
      this.members.set(TARGET_ID, member(TARGET_ID, 'member'));
      this.members.set(OFFLINE_ID, member(OFFLINE_ID, 'member'));
      this.bindings.set(MANAGER_PRINCIPAL, binding(MANAGER_ID, MANAGER_PRINCIPAL));
      this.bindings.set(TARGET_PRINCIPAL, binding(TARGET_ID, TARGET_PRINCIPAL));
      this.bindings.set(OFFLINE_PRINCIPAL, binding(OFFLINE_ID, OFFLINE_PRINCIPAL));
    }
  }

  portability(): PortabilityLifecyclePersistence {
    const state = this;
    return {
      async putLifecycleJournal(input: PutProjectLifecycleJournalInput) {
        const record = Object.freeze({
          ...input,
          batchRevision: undefined,
          batchSha256: undefined,
          checkpointSha256: undefined,
          recoveryFromPhase: undefined,
          resultSha256: undefined,
          state: 'active' as const,
          updatedAt: input.createdAt,
        });
        if (input.kind === 'delete') {
          state.deletionJournals.set(input.operationId, record);
        } else if (state.journal === undefined) {
          state.journal = record;
        }
        return 'created' as const;
      },
      async getLifecycleJournal(operationId: string) {
        return state.journal?.operationId === operationId
          ? state.journal
          : state.deletionJournals.get(operationId);
      },
      async getNonterminalLifecycleJournal() {
        return [...state.deletionJournals.values()].find(value => value.state === 'active')
          ?? (state.journal?.state === 'active' ? state.journal : undefined);
      },
      async advanceLifecycleJournal(input: AdvanceProjectLifecycleJournalInput) {
        if (state.failNextJournalPhase === input.nextPhase) {
          state.failNextJournalPhase = undefined;
          throw new Error('injected-journal-advance-failure');
        }
        const current = state.journal?.operationId === input.operationId
          ? state.journal
          : state.deletionJournals.get(input.operationId);
        assert.ok(current);
        if (current.phase === input.nextPhase && current.state === input.nextState) {
          return 'replayed' as const;
        }
        assert.equal(current.phase, input.expectedPhase);
        assert.equal(current.state, input.expectedState);
        const advanced = Object.freeze({
          ...current,
          batchRevision: input.batchRevision ?? current.batchRevision,
          batchSha256: input.batchSha256 ?? current.batchSha256,
          checkpointSha256: input.checkpointSha256 ?? current.checkpointSha256,
          phase: input.nextPhase,
          recoveryFromPhase: input.recoveryFromPhase,
          resultSha256: input.resultSha256 ?? current.resultSha256,
          scheduledAt: input.scheduledAt,
          state: input.nextState,
          updatedAt: input.updatedAt,
        });
        if (state.journal?.operationId === input.operationId) state.journal = advanced;
        else state.deletionJournals.set(input.operationId, advanced);
        return 'advanced' as const;
      },
      async putAuthorityTransferRecovery(input: AuthorityTransferRecoveryInput) {
        state.recovery ??= Object.freeze({
          ...input,
          cancellationRequestSha256: undefined,
          inactivePublicationJson: undefined,
          relinquishmentProof: undefined,
          sourceProof: undefined,
          sourceReopenSha256: undefined,
          stageSha256: undefined,
          targetActivationProof: undefined,
          targetActivationRequestSha256: undefined,
          targetProof: undefined,
          updatedAt: input.createdAt,
        });
        return 'created' as const;
      },
      async getAuthorityTransferRecovery() {
        return state.recovery;
      },
      async advanceAuthorityTransferRecoveryEvidence(
        input: AuthorityTransferRecoveryEvidenceInput,
      ) {
        const current = state.recovery;
        assert.ok(current);
        assert.equal(current.updatedAt, input.expectedUpdatedAt);
        state.recovery = Object.freeze({
          ...current,
          cancellationRequestSha256: current.cancellationRequestSha256
            ?? input.cancellationRequestSha256,
          inactivePublicationJson: current.inactivePublicationJson
            ?? input.inactivePublicationJson,
          expiresAt: input.nextExpiresAt ?? current.expiresAt,
          relinquishmentProof: current.relinquishmentProof
            ?? input.relinquishmentProof,
          sourceProof: current.sourceProof ?? input.sourceProof,
          sourceReopenSha256: current.sourceReopenSha256
            ?? input.sourceReopenSha256,
          stageSha256: current.stageSha256 ?? input.stageSha256,
          targetActivationProof: current.targetActivationProof
            ?? input.targetActivationProof,
          targetActivationRequestSha256: current.targetActivationRequestSha256
            ?? input.targetActivationRequestSha256,
          targetProof: current.targetProof ?? input.targetProof,
          updatedAt: input.updatedAt,
        });
        return 'advanced' as const;
      },
      async getAuthorityTransferStatus() {
        if (state.journal === undefined || state.recovery === undefined) return undefined;
        return decodeCollabAuthorityTransferStatus({
          batchRevision: state.journal.batchRevision ?? null,
          batchSha256: state.journal.batchSha256 ?? null,
          checkpointSha256: state.journal.checkpointSha256 ?? null,
          createdAt: state.recovery.createdAt,
          direction: 'cloud-to-lan',
          expiresAt: state.recovery.expiresAt,
          phase: state.journal.phase,
          projectId: state.journal.projectId,
          relinquishmentProof: state.recovery.relinquishmentProof ?? null,
          sourceAuthority: state.recovery.sourceAuthority,
          state: state.journal.state === 'completed' || state.journal.state === 'cancelled'
            ? state.journal.state
            : 'active',
          targetAuthority: state.recovery.targetAuthority,
          targetUrl: state.recovery.targetUrl,
          transferId: state.recovery.transferId,
          updatedAt: state.journal.updatedAt,
        });
      },
      async findProjectPrincipalBinding(principalId: string) {
        return state.bindings.get(principalId);
      },
      async listActiveProjectPrincipalBindings() {
        return [...state.bindings.values()].filter(value => value.state === 'active');
      },
      async putTransferReceiptKey(input: TransferReceiptKeyInput) {
        state.keys.set(input.receiptKeyId, input);
        return 'created' as const;
      },
      async getTransferReceiptKey(_transferId: string, receiptKeyId: string) {
        return state.keys.get(receiptKeyId);
      },
      async putProtectedClaimEnvelope(input: ProtectedClaimEnvelopeInput) {
        state.envelopes.set(input.memberId, input);
        return 'created' as const;
      },
      async getProtectedClaimEnvelope(_transferId: string, memberId: CollabMemberId) {
        return state.envelopes.get(memberId);
      },
      async deleteProtectedClaimEnvelopes() {
        const result = state.envelopes.size === 0 ? 'replayed' : 'advanced';
        state.envelopes.clear();
        return result as 'advanced' | 'replayed';
      },
      async renewProtectedClaimEnvelopes(input: RenewProtectedClaimEnvelopesInput) {
        let advanced = false;
        for (const [memberId, envelope] of state.envelopes) {
          if (envelope.expiresAt === input.expiresAt) continue;
          state.envelopes.set(memberId, Object.freeze({
            ...envelope,
            expiresAt: input.expiresAt,
          }));
          advanced = true;
        }
        return advanced ? 'advanced' as const : 'replayed' as const;
      },
      async scrubProtectedClaimEnvelope(input: ScrubProtectedClaimEnvelopeInput) {
        const existed = state.envelopes.delete(input.memberId);
        return existed ? 'scrubbed' as const : 'replayed' as const;
      },
      async putClaimBatchReceipt(input: CollabTransferredMembershipClaimCustodyReceipt) {
        state.custodyReceipt ??= input;
        assert.deepEqual(state.custodyReceipt, input);
        return 'created' as const;
      },
      async getTransferClaimBatchReceipt() {
        return state.custodyReceipt;
      },
      async putTerminalResponder(input: TerminalResponderInput) {
        state.responder ??= Object.freeze({ ...input, acknowledgements: Object.freeze([]) });
        return 'created' as const;
      },
      async getTerminalResponder() {
        return state.responder;
      },
      async acknowledgeTerminalResponder(input: AcknowledgeTerminalResponderInput) {
        assert.ok(state.responder);
        const existing = state.responder.acknowledgements.find(value => (
          value.memberId === input.memberId
          && value.principalId === input.principalId
        ));
        if (existing !== undefined) return 'replayed' as const;
        state.responder = Object.freeze({
          ...state.responder,
          acknowledgements: Object.freeze([
            ...state.responder.acknowledgements,
            Object.freeze({
              acknowledgedAt: input.acknowledgedAt,
              memberId: input.memberId,
              principalId: input.principalId,
            }),
          ]),
          eligiblePrincipals: Object.freeze(
            state.responder.eligiblePrincipals.filter(value => (
              value.memberId !== input.memberId
              || value.principalId !== input.principalId
            )),
          ),
        });
        return 'advanced' as const;
      },
      async putProjectTombstone(input: ProjectTombstoneInput) {
        state.tombstone ??= input;
        return 'created' as const;
      },
      async getProjectTombstone() {
        return state.tombstone;
      },
      async putDeletionIntent(input: ProjectDeletionIntentInput) {
        state.deletionIntent ??= input;
        return 'created' as const;
      },
      async getDeletionIntent() {
        return undefined;
      },
    } as unknown as PortabilityLifecyclePersistence;
  }

  scope(): ProjectScope {
    const state = this;
    return {
      portability: this.portability(),
      async getProject() {
        return state.project;
      },
      async findMembership(memberId: CollabMemberId) {
        return state.members.get(memberId);
      },
      async listMemberships() {
        return [...state.members.values()];
      },
      async getRepositoryPlacement() {
        return state.placement;
      },
      async advanceProjectAuthorityState(input: AdvanceProjectAuthorityStateInput) {
        assert.equal(state.project.authorityGeneration, input.expectedAuthorityGeneration);
        assert.equal(state.project.authorityStateRevision, input.expectedAuthorityStateRevision);
        assert.equal(state.project.serviceState, input.expectedServiceState);
        state.project = Object.freeze({
          ...state.project,
          authorityGeneration: input.nextAuthorityGeneration,
          authorityStateRevision: state.project.authorityStateRevision + 1,
          serviceState: input.nextServiceState,
        });
        return 'advanced' as const;
      },
    } as unknown as ProjectScope;
  }
}

class MemoryLease implements PinnedProjectLease {
  readonly #state: MemoryState;

  constructor(state: MemoryState) {
    this.#state = state;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  drainDevelopmentBootstrapUploads(): Promise<void> {
    return Promise.resolve();
  }

  handoffToDevelopmentBootstrapUpload(): Promise<never> {
    return Promise.reject(new Error('not-supported'));
  }

  withProjectScope<Result>(
    operation: (scope: ProjectScope) => Promise<Result>,
  ): Promise<Result> {
    return operation(this.#state.scope());
  }
}

class Harness {
  readonly claims = new Map<string, string>();
  readonly checkpoint: CloudToLanCheckpointCapturePort;
  readonly custody: CloudToLanClaimCustodyPort;
  readonly fence: CloudToLanSourceFencePort;
  readonly lifecycleOrder: string[] = [];
  readonly state: MemoryState;
  readonly targetTrust: CloudToLanTargetTrustPort;
  captureFailures = 0;
  cleanupFailures = 0;
  discardFailures = 0;
  relinquishCalls = 0;
  relinquishFailures = 0;
  repositoryAvailable = true;
  repositoryVerifications = 0;
  signerFailures = 0;
  targetActivationVerifications = 0;

  constructor(singleMember = false) {
    this.state = new MemoryState(singleMember);
    this.checkpoint = {
      capture: async input => {
        if (this.captureFailures > 0) {
          this.captureFailures -= 1;
          throw new Error('capture-failed');
        }
        return Object.freeze({
          checkpointSha256: CHECKPOINT_SHA,
          operationId: input.operationId,
          projectId: input.projectId,
        });
      },
      discard: async () => {
        if (this.discardFailures > 0) {
          this.discardFailures -= 1;
          throw new Error('discard-failed');
        }
        return 'removed';
      },
    };
    this.custody = {
      seal: async input => {
        this.claims.set(input.associatedData.claimSha256, input.claim);
        return Object.freeze({
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
        });
      },
      open: async envelope => {
        const claim = this.claims.get(envelope.associatedData.claimSha256);
        assert.ok(claim);
        return claim;
      },
    };
    this.fence = {
      quiesce: async () => undefined,
      relinquish: async () => {
        this.relinquishCalls += 1;
        if (this.relinquishFailures > 0) {
          this.relinquishFailures -= 1;
          throw new Error('relinquish-failed');
        }
      },
      reopen: async () => undefined,
    };
    this.targetTrust = {
      verifyAcceptance: async input => Object.freeze({
        principalId: input.principalId,
        projectId: input.request.projectId,
        receiptKeyId: 'receipt-key-target',
        receiptPublicKey: PUBLIC_KEY,
        targetAuthority: input.targetAuthority,
        targetHostMemberId: input.request.targetHostMemberId,
        targetUrl: input.targetUrl,
        transferId: input.request.transferId,
      }),
      verifyStaged: async () => undefined,
      verifyActivation: async () => {
        this.targetActivationVerifications += 1;
      },
      verifyRedemptionReceipt: async input => {
        assert.equal(input.receiptPublicKey, PUBLIC_KEY);
      },
      invalidateAndClean: async () => {
        if (this.cleanupFailures > 0) {
          this.cleanupFailures -= 1;
          throw new Error('target-unreachable');
        }
        return Object.freeze({ cleanupSha256: '7'.repeat(64) });
      },
    };
  }

  coordinator(startAt: string = CREATED_AT): CloudToLanTransferCoordinator {
    let tick = Date.parse(startAt);
    return new CloudToLanTransferCoordinator({
      checkpoint: this.checkpoint,
      clock: () => new Date(tick += 1_000),
      coordination: {
        acquireProjectLease: async () => {
          this.lifecycleOrder.push('lease');
          return new MemoryLease(this.state);
        },
      },
      custody: this.custody,
      custodyReceiptIdFactory: () => 'custody-receipt',
      deletionOperationIdFactory: () => 'delete-transfer',
      environmentIdentity: 'environment-test',
      relinquishmentIntentIdFactory: () => 'relinquishment-intent',
      relinquishmentSigner: {
        sign: async () => {
          if (this.signerFailures > 0) {
            this.signerFailures -= 1;
            throw new Error('signer-failed');
          }
          return SIGNATURE;
        },
      },
      repository: {
        reserveExactRepositoryOperation: async projectId => {
          this.lifecycleOrder.push('reserve');
          return Object.freeze({ async close() {}, projectId });
        },
        verifyExactRepository: async () => {
          this.lifecycleOrder.push('verify');
          this.repositoryVerifications += 1;
          if (!this.repositoryAvailable) {
            throw new RepositoryCheckpointError('storage-unavailable');
          }
        },
      },
      sourceFence: this.fence,
      targetTrust: this.targetTrust,
    });
  }
}

async function begin(
  coordinator: CloudToLanTransferCoordinator,
  input: Readonly<{
    readonly principalId?: string;
    readonly targetHostMemberId?: CollabMemberId;
  }> = {},
): Promise<CollabAuthorityTransferStatus> {
  return coordinator.begin({
    expiresAt: EXPIRES_AT,
    principalId: input.principalId ?? MANAGER_PRINCIPAL,
    request: {
      expectedAuthorityGeneration: 4,
      idempotencyKey: 'begin-intent',
      projectId: PROJECT_ID,
      targetHostMemberId: input.targetHostMemberId ?? TARGET_ID,
      targetUrl: TARGET_URL,
    },
  });
}

async function accept(
  coordinator: CloudToLanTransferCoordinator,
  transferId: string,
): Promise<CollabAuthorityTransferStatus> {
  return coordinator.acceptTarget({
    principalId: TARGET_PRINCIPAL,
    request: {
      idempotencyKey: 'accept-intent',
      projectId: PROJECT_ID,
      targetHostMemberId: TARGET_ID,
      targetProof: Buffer.alloc(32, 1).toString('base64url'),
      transferId,
    },
  });
}

function claimBatch(
  transferId: string,
  claims: readonly Readonly<{ readonly claim: string; readonly memberId: CollabMemberId }>[],
  expiresAt: string = EXPIRES_AT,
) {
  const withoutDigest = {
    batchRevision: 1,
    batchSha256: '0'.repeat(64),
    checkpointSha256: CHECKPOINT_SHA,
    claims: [...claims].sort((left, right) => (
      left.memberId.localeCompare(right.memberId, 'en-US')
    )),
    expiresAt,
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

function stageRequest(
  transferId: string,
  batch = claimBatch(transferId, [
    { claim: Buffer.alloc(32, 1).toString('base64url'), memberId: MANAGER_ID },
    { claim: Buffer.alloc(32, 2).toString('base64url'), memberId: OFFLINE_ID },
  ]),
) {
  return {
    checkpointSha256: CHECKPOINT_SHA,
    claimBatch: batch,
    idempotencyKey: 'stage-intent',
    projectId: PROJECT_ID,
    stageSha256: STAGE_SHA,
    targetAuthority: { generation: 5, kind: 'lan' as const },
    targetProof: Buffer.alloc(32, 3).toString('base64url'),
    transferId,
  };
}

async function stage(
  coordinator: CloudToLanTransferCoordinator,
  transferId: string,
) {
  return coordinator.reportTargetStaged({
    principalId: TARGET_PRINCIPAL,
    request: stageRequest(transferId),
  });
}

function activationRequest(
  transferId: string,
  relinquishmentProof: NonNullable<CollabAuthorityTransferStatus['relinquishmentProof']>,
  input: Readonly<{
    readonly idempotencyKey?: string;
    readonly targetActivationProof?: string;
  }> = {},
) {
  return {
    idempotencyKey: input.idempotencyKey ?? 'activation-intent',
    projectId: PROJECT_ID,
    relinquishmentProof,
    targetActivationProof: input.targetActivationProof
      ?? Buffer.alloc(32, 6).toString('base64url'),
    transferId,
  };
}

describe('CloudToLanTransferCoordinator', () => {
  it('moves one authority forward, retains exact claims, and creates deletion handoff', async () => {
    const harness = new Harness();
    const coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    assert.equal(begun.phase, 'collecting-readiness');
    assert.equal(begun.transferId.startsWith('transfer_'), true);

    const accepted = await accept(coordinator, begun.transferId);
    assert.equal(accepted.phase, 'checkpoint-captured');
    assert.equal(harness.state.project.serviceState, 'read-only-transition');

    const custody = await stage(coordinator, begun.transferId);
    assert.equal(custody.custodyAuthority.kind, 'cloud');
    assert.equal(custody.submittedByMemberId, TARGET_ID);
    assert.deepEqual([...harness.state.envelopes.keys()].sort(), [
      MANAGER_ID,
      OFFLINE_ID,
    ]);
    assert.equal(harness.state.journal?.phase, 'cloud-relinquished');
    assert.equal(harness.state.project.authorityGeneration, 5);
    assert.equal(harness.state.project.serviceState, 'deleting');

    await assert.rejects(
      coordinator.getClaim({
        principalId: TARGET_PRINCIPAL,
        request: { projectId: PROJECT_ID, transferId: begun.transferId },
      }),
      (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
        && error.code === 'authorization-denied',
    );
    const offlineClaim = await coordinator.getClaim({
      principalId: OFFLINE_PRINCIPAL,
      request: { projectId: PROJECT_ID, transferId: begun.transferId },
    });
    assert.equal(offlineClaim.memberId, OFFLINE_ID);

    const proof = harness.state.recovery?.relinquishmentProof;
    assert.ok(proof);
    const completed = await coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: {
        idempotencyKey: 'activation-intent',
        projectId: PROJECT_ID,
        relinquishmentProof: proof,
        targetActivationProof: Buffer.alloc(32, 6).toString('base64url'),
        transferId: begun.transferId,
      },
    });
    assert.equal(completed.phase, 'completed');
    assert.equal(completed.state, 'completed');
    assert.equal(harness.state.deletionIntent?.reason, 'cloud-to-lan');
    assert.equal(harness.state.deletionIntent?.placementGeneration, 7);
    assert.equal(harness.state.deletionJournals.get('delete-transfer')?.phase, 'traffic-denied');
    assert.equal(harness.state.responder?.eligiblePrincipals.length, 3);
    assert.equal(harness.targetActivationVerifications, 1);
    assert.equal(harness.repositoryVerifications, 1);

    harness.state.bindings.clear();
    harness.state.recovery = undefined;
    assert.equal((await coordinator.getStatus({
      principalId: OFFLINE_PRINCIPAL,
      request: { projectId: PROJECT_ID, transferId: begun.transferId },
    })).state, 'completed');
    await assert.rejects(coordinator.confirmTargetActive({
      principalId: OFFLINE_PRINCIPAL,
      request: {
        idempotencyKey: 'activation-intent',
        projectId: PROJECT_ID,
        relinquishmentProof: proof,
        targetActivationProof: Buffer.alloc(32, 6).toString('base64url'),
        transferId: begun.transferId,
      },
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'authorization-denied');
    await assert.rejects(coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: {
        idempotencyKey: 'activation-intent',
        projectId: PROJECT_ID,
        relinquishmentProof: proof,
        targetActivationProof: Buffer.alloc(32, 7).toString('base64url'),
        transferId: begun.transferId,
      },
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'state-conflict');
    assert.equal((await coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: {
        idempotencyKey: 'activation-intent',
        projectId: PROJECT_ID,
        relinquishmentProof: proof,
        targetActivationProof: Buffer.alloc(32, 6).toString('base64url'),
        transferId: begun.transferId,
      },
    })).state, 'completed');
    const afterDeletionClaim = await coordinator.getClaim({
      principalId: OFFLINE_PRINCIPAL,
      request: { projectId: PROJECT_ID, transferId: begun.transferId },
    });
    const envelope = harness.state.envelopes.get(OFFLINE_ID);
    assert.ok(envelope);
    const receipt: CollabTransferredMembershipRedemptionReceipt = {
      checkpointSha256: CHECKPOINT_SHA,
      claimSha256: envelope.associatedData.claimSha256,
      memberId: OFFLINE_ID,
      operationIntentId: 'claim-intent',
      projectId: PROJECT_ID,
      receiptId: 'redemption-receipt',
      receiptKeyId: 'receipt-key-target',
      redeemedAt: '2026-08-28T00:00:00.000Z',
      signature: SIGNATURE,
      signatureAlgorithm: 'ed25519',
      targetAuthorityGeneration: 5,
      transferId: begun.transferId,
    };
    assert.equal(afterDeletionClaim.claim, offlineClaim.claim);
    assert.equal((await coordinator.acknowledgeRedemption({
      principalId: OFFLINE_PRINCIPAL,
      request: {
        idempotencyKey: 'ack-intent',
        projectId: PROJECT_ID,
        receipt,
        transferId: begun.transferId,
      },
    })).memberId, OFFLINE_ID);
    assert.equal(harness.state.envelopes.has(OFFLINE_ID), false);
    assert.deepEqual(harness.state.responder?.acknowledgements, [{
      acknowledgedAt: '2026-08-28T00:00:00.001Z',
      memberId: OFFLINE_ID,
      principalId: OFFLINE_PRINCIPAL,
    }]);
    assert.equal(harness.state.responder?.eligiblePrincipals.some(value => (
      value.principalId === OFFLINE_PRINCIPAL
    )), false);
    await assert.rejects(coordinator.getStatus({
      principalId: OFFLINE_PRINCIPAL,
      request: { projectId: PROJECT_ID, transferId: begun.transferId },
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'authorization-denied');
    assert.deepEqual(await coordinator.acknowledgeRedemption({
      principalId: OFFLINE_PRINCIPAL,
      request: {
        idempotencyKey: 'ack-intent',
        projectId: PROJECT_ID,
        receipt,
        transferId: begun.transferId,
      },
    }), {
      acknowledgedAt: '2026-08-28T00:00:00.001Z',
      memberId: OFFLINE_ID,
      projectId: PROJECT_ID,
      receiptId: 'redemption-receipt',
      transferId: begun.transferId,
    });
  });

  it('proves exact repository presence before Cloud-to-LAN deletion intent', async () => {
    const harness = new Harness();
    const coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    await accept(coordinator, begun.transferId);
    await stage(coordinator, begun.transferId);
    const proof = harness.state.recovery?.relinquishmentProof;
    assert.ok(proof);
    harness.repositoryAvailable = false;
    harness.lifecycleOrder.length = 0;
    const request = activationRequest(begun.transferId, proof);

    await assert.rejects(coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request,
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'dependency-failed');
    assert.deepEqual(harness.lifecycleOrder.slice(0, 3), [
      'reserve',
      'lease',
      'verify',
    ]);
    assert.equal(harness.state.journal?.phase, 'lan-activated');
    assert.equal(harness.state.deletionIntent, undefined);

    harness.repositoryAvailable = true;
    const completed = await coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request,
    });
    assert.equal(completed.phase, 'completed');
    const deletionIntent = harness.state.deletionIntent as
      | ProjectDeletionIntentInput
      | undefined;
    assert.equal(deletionIntent?.reason, 'cloud-to-lan');
  });

  it('records the canonical empty claim batch for a single target Host', async () => {
    const harness = new Harness(true);
    const coordinator = harness.coordinator();
    const begun = await begin(coordinator, {
      principalId: TARGET_PRINCIPAL,
      targetHostMemberId: TARGET_ID,
    });
    await accept(coordinator, begun.transferId);
    const batch = claimBatch(begun.transferId, []);
    await assert.rejects(coordinator.reportTargetStaged({
      principalId: TARGET_PRINCIPAL,
      request: stageRequest(begun.transferId, decodeCollabTransferredMembershipClaimBatch({
        ...batch,
        batchSha256: 'f'.repeat(64),
      })),
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'state-conflict');
    const receipt = await coordinator.reportTargetStaged({
      principalId: TARGET_PRINCIPAL,
      request: stageRequest(begun.transferId, batch),
    });
    assert.equal(batch.claims.length, 0);
    assert.equal(receipt.batchSha256, batch.batchSha256);
    assert.equal(harness.state.envelopes.size, 0);
    assert.ok(harness.state.custodyReceipt);
  });

  it('completes with protected custody for an active unbound Member', async () => {
    const harness = new Harness();
    harness.state.bindings.delete(OFFLINE_PRINCIPAL);
    const coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    await accept(coordinator, begun.transferId);
    await stage(coordinator, begun.transferId);
    const proof = harness.state.recovery?.relinquishmentProof;
    assert.ok(proof);

    const completed = await coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: {
        idempotencyKey: 'activation-with-unbound-member',
        projectId: PROJECT_ID,
        relinquishmentProof: proof,
        targetActivationProof: Buffer.alloc(32, 6).toString('base64url'),
        transferId: begun.transferId,
      },
    });

    assert.equal(completed.state, 'completed');
    assert.ok(harness.state.envelopes.has(OFFLINE_ID));
    assert.deepEqual(harness.state.responder?.eligiblePrincipals.map(value => (
      value.memberId
    )).sort(), [MANAGER_ID, TARGET_ID]);
  });

  it('recovers target restart, lost custody response, and lost activation completion', async () => {
    const harness = new Harness();
    harness.captureFailures = 1;
    let coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    await assert.rejects(accept(coordinator, begun.transferId));
    assert.equal(harness.state.journal?.phase, 'cloud-quiesced');

    coordinator = harness.coordinator();
    const relinquishedJournal = harness.state.journal as ProjectLifecycleJournalRecord;
    assert.equal(
      await coordinator.reserveRecovery(PROJECT_ID, relinquishedJournal),
      undefined,
    );
    assert.equal(await coordinator.recover({
      journal: relinquishedJournal,
      lease: new MemoryLease(harness.state),
    }), 'waiting-for-external-proof');
    assert.equal(harness.state.journal?.phase, 'checkpoint-captured');

    harness.relinquishFailures = 1;
    await assert.rejects(stage(coordinator, begun.transferId));
    const receipt = harness.state.custodyReceipt;
    assert.ok(receipt);
    assert.equal(harness.state.journal?.phase, 'cloud-relinquished');
    assert.equal((await coordinator.getStatus({
      principalId: MANAGER_PRINCIPAL,
      request: { projectId: PROJECT_ID, transferId: begun.transferId },
    })).phase, 'cloud-relinquished');
    await assert.rejects(coordinator.cancel({
      principalId: MANAGER_PRINCIPAL,
      request: {
        expectedPhase: 'claims-retained',
        idempotencyKey: 'ambiguous-relinquishment-cancel',
        projectId: PROJECT_ID,
        transferId: begun.transferId,
      },
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'state-conflict');

    coordinator = harness.coordinator();
    assert.equal(await coordinator.recover({
      journal: harness.state.journal as ProjectLifecycleJournalRecord,
      lease: new MemoryLease(harness.state),
    }), 'waiting-for-external-proof');
    assert.equal(harness.state.journal?.phase, 'cloud-relinquished');
    assert.deepEqual(await stage(coordinator, begun.transferId), receipt);

    harness.discardFailures = 1;
    const proof = harness.state.recovery?.relinquishmentProof;
    assert.ok(proof);
    await assert.rejects(coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: {
        idempotencyKey: 'activate-restart',
        projectId: PROJECT_ID,
        relinquishmentProof: proof,
        targetActivationProof: Buffer.alloc(32, 6).toString('base64url'),
        transferId: begun.transferId,
      },
    }));
    assert.equal(harness.state.journal?.phase, 'lan-activated');
    coordinator = harness.coordinator();
    const activatedJournal = harness.state.journal as ProjectLifecycleJournalRecord;
    const recoveryReservation = await coordinator.reserveRecovery(
      PROJECT_ID,
      activatedJournal,
    );
    assert.ok(recoveryReservation);
    assert.equal(await coordinator.recover({
      journal: activatedJournal,
      lease: new MemoryLease(harness.state),
      repositoryReservation: recoveryReservation,
    }), 'settled');
    await recoveryReservation.close();
    assert.equal(harness.state.journal?.phase, 'completed');
  });

  it('cancels every expired pre-cutover recovery without signing or relinquishing', async () => {
    for (const stoppedPhase of ['target-staged', 'claims-retained'] as const) {
      const harness = new Harness();
      let coordinator = harness.coordinator();
      const begun = await begin(coordinator);
      await accept(coordinator, begun.transferId);
      if (stoppedPhase === 'target-staged') {
        harness.state.failNextJournalPhase = 'claims-retained';
      } else {
        harness.signerFailures = 1;
      }
      await assert.rejects(stage(coordinator, begun.transferId));
      assert.equal(harness.state.journal?.phase, stoppedPhase);
      assert.equal(harness.state.recovery?.relinquishmentProof, undefined);

      coordinator = harness.coordinator(EXPIRES_AT);
      assert.equal(await coordinator.recover({
        journal: harness.state.journal as ProjectLifecycleJournalRecord,
        lease: new MemoryLease(harness.state),
      }), 'settled');
      assert.equal(harness.state.journal?.phase, 'cancelled');
      assert.equal(harness.state.project.authorityGeneration, 4);
      assert.equal(harness.state.project.serviceState, 'active');
      assert.equal(harness.relinquishCalls, 0);
    }
  });

  it('rechecks expiry before signing a relinquishment proof', async () => {
    const harness = new Harness();
    let coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    await accept(coordinator, begun.transferId);

    coordinator = harness.coordinator('2026-09-25T23:59:58.500Z');
    await assert.rejects(stage(coordinator, begun.transferId),
      (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
        && error.code === 'expired');
    assert.equal(harness.state.journal?.phase, 'claims-retained');
    assert.equal(harness.state.recovery?.relinquishmentProof, undefined);
    assert.equal(harness.relinquishCalls, 0);

    coordinator = harness.coordinator(EXPIRES_AT);
    assert.equal(await coordinator.recover({
      journal: harness.state.journal as ProjectLifecycleJournalRecord,
      lease: new MemoryLease(harness.state),
    }), 'settled');
    assert.equal(harness.state.journal?.phase, 'cancelled');
  });

  it('binds lost activation completion to the exact request and renews terminal expiry', async () => {
    const harness = new Harness();
    let coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    await accept(coordinator, begun.transferId);
    await stage(coordinator, begun.transferId);
    const proof = harness.state.recovery?.relinquishmentProof;
    assert.ok(proof);
    const originalRequest = activationRequest(begun.transferId, proof, {
      idempotencyKey: 'activation-before-expiry',
    });

    harness.discardFailures = 1;
    coordinator = harness.coordinator('2026-09-25T23:59:58.000Z');
    await assert.rejects(coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: originalRequest,
    }));
    assert.equal(harness.state.journal?.phase, 'lan-activated');

    coordinator = harness.coordinator(EXPIRES_AT);
    await assert.rejects(coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: activationRequest(begun.transferId, proof, {
        idempotencyKey: 'changed-after-lost-completion',
      }),
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'state-conflict');

    const completed = await coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: originalRequest,
    });
    assert.equal(completed.state, 'completed');
    assert.equal(Date.parse(completed.expiresAt) > Date.parse(completed.updatedAt), true);
    assert.equal(harness.state.responder?.expiresAt, completed.expiresAt);
  });

  it('revalidates the canonical batch and stage digest on custody replay', async () => {
    const harness = new Harness();
    const coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    await accept(coordinator, begun.transferId);
    const originalBatch = claimBatch(begun.transferId, [
      { claim: Buffer.alloc(32, 1).toString('base64url'), memberId: MANAGER_ID },
      { claim: Buffer.alloc(32, 2).toString('base64url'), memberId: OFFLINE_ID },
    ]);
    const receipt = await coordinator.reportTargetStaged({
      principalId: TARGET_PRINCIPAL,
      request: stageRequest(begun.transferId, originalBatch),
    });

    const alteredBatch = decodeCollabTransferredMembershipClaimBatch({
      ...originalBatch,
      claims: originalBatch.claims.map(item => item.memberId === OFFLINE_ID
        ? { ...item, claim: Buffer.alloc(32, 7).toString('base64url') }
        : item),
    });
    await assert.rejects(coordinator.reportTargetStaged({
      principalId: TARGET_PRINCIPAL,
      request: stageRequest(begun.transferId, alteredBatch),
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'state-conflict');
    await assert.rejects(coordinator.reportTargetStaged({
      principalId: TARGET_PRINCIPAL,
      request: {
        ...stageRequest(begun.transferId, originalBatch),
        stageSha256: '8'.repeat(64),
      },
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'state-conflict');
    assert.deepEqual(harness.state.custodyReceipt, receipt);
  });

  it('recovers forward when target activation arrives after transfer expiry', async () => {
    const harness = new Harness();
    let coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    await accept(coordinator, begun.transferId);
    await stage(coordinator, begun.transferId);
    const proof = harness.state.recovery?.relinquishmentProof;
    assert.ok(proof);

    coordinator = harness.coordinator(EXPIRES_AT);
    const completed = await coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: {
        idempotencyKey: 'late-activation-intent',
        projectId: PROJECT_ID,
        relinquishmentProof: proof,
        targetActivationProof: Buffer.alloc(32, 6).toString('base64url'),
        transferId: begun.transferId,
      },
    });

    assert.equal(completed.phase, 'completed');
    assert.equal(completed.state, 'completed');
    assert.equal(Date.parse(completed.expiresAt) > Date.parse(completed.updatedAt), true);
    assert.equal(harness.state.tombstone?.terminalExpiresAt, completed.expiresAt);
    const claim = await coordinator.getClaim({
      principalId: OFFLINE_PRINCIPAL,
      request: { projectId: PROJECT_ID, transferId: begun.transferId },
    });
    assert.equal(claim.expiresAt, completed.expiresAt);
  });

  it('keeps Cloud fenced until exact target invalidation permits cancellation', async () => {
    const harness = new Harness();
    const coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    const accepted = await accept(coordinator, begun.transferId);
    harness.cleanupFailures = 1;
    assert.equal(accepted.phase, 'checkpoint-captured');
    const request: CancelProjectAuthorityTransferRequest = {
      expectedPhase: 'checkpoint-captured',
      idempotencyKey: 'cancel-intent',
      projectId: PROJECT_ID,
      transferId: begun.transferId,
    };
    await assert.rejects(coordinator.cancel({
      principalId: MANAGER_PRINCIPAL,
      request,
    }));
    assert.equal(harness.state.journal?.phase, 'cancel-intent');
    assert.equal(harness.state.project.serviceState, 'read-only-transition');
    assert.equal(await coordinator.recover({
      journal: harness.state.journal as ProjectLifecycleJournalRecord,
      lease: new MemoryLease(harness.state),
    }), 'settled');
    assert.equal(harness.state.journal?.phase, 'cancelled');
    assert.equal(harness.state.project.serviceState, 'active');
    assert.equal(harness.state.project.authorityGeneration, 4);
  });

  it('fails closed for non-Manager, wrong target, incomplete batch, and post-cutover cancel', async () => {
    const harness = new Harness();
    const coordinator = harness.coordinator();
    await assert.rejects(
      begin(coordinator, { principalId: OFFLINE_PRINCIPAL }),
      (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
        && error.code === 'authorization-denied',
    );
    const begun = await begin(coordinator);
    await assert.rejects(coordinator.acceptTarget({
      principalId: OFFLINE_PRINCIPAL,
      request: {
        idempotencyKey: 'wrong-target',
        projectId: PROJECT_ID,
        targetHostMemberId: TARGET_ID,
        targetProof: Buffer.alloc(32, 1).toString('base64url'),
        transferId: begun.transferId,
      },
    }));
    await accept(coordinator, begun.transferId);
    const exact = claimBatch(begun.transferId, [
      { claim: Buffer.alloc(32, 1).toString('base64url'), memberId: MANAGER_ID },
      { claim: Buffer.alloc(32, 2).toString('base64url'), memberId: OFFLINE_ID },
    ]);
    await assert.rejects(coordinator.reportTargetStaged({
      principalId: TARGET_PRINCIPAL,
      request: stageRequest(begun.transferId, decodeCollabTransferredMembershipClaimBatch({
        ...exact,
        claims: exact.claims.map(item => item.memberId === OFFLINE_ID
          ? { ...item, claim: Buffer.alloc(32, 4).toString('base64url') }
          : item),
      })),
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'state-conflict');
    for (const expiresAt of [
      '2026-09-25T00:00:00.000Z',
      '2026-09-27T00:00:00.000Z',
    ]) {
      await assert.rejects(coordinator.reportTargetStaged({
        principalId: TARGET_PRINCIPAL,
        request: stageRequest(begun.transferId, claimBatch(
          begun.transferId,
          exact.claims,
          expiresAt,
        )),
      }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
        && error.code === 'state-conflict');
    }
    await assert.rejects(coordinator.getClaim({
      principalId: OFFLINE_PRINCIPAL,
      request: { projectId: PROJECT_ID, transferId: begun.transferId },
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'state-conflict');
    const incomplete = claimBatch(begun.transferId, [{
      claim: Buffer.alloc(32, 1).toString('base64url'),
      memberId: MANAGER_ID,
    }]);
    await assert.rejects(coordinator.reportTargetStaged({
      principalId: TARGET_PRINCIPAL,
      request: stageRequest(begun.transferId, incomplete),
    }));
    await stage(coordinator, begun.transferId);
    await assert.rejects(coordinator.cancel({
      principalId: MANAGER_PRINCIPAL,
      request: {
        expectedPhase: 'claims-retained',
        idempotencyKey: 'too-late',
        projectId: PROJECT_ID,
        transferId: begun.transferId,
      },
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'state-conflict');
  });

  it('removes former-principal terminal access at expiry', async () => {
    const harness = new Harness();
    let coordinator = harness.coordinator();
    const begun = await begin(coordinator);
    await accept(coordinator, begun.transferId);
    await stage(coordinator, begun.transferId);
    const proof = harness.state.recovery?.relinquishmentProof;
    assert.ok(proof);
    await coordinator.confirmTargetActive({
      principalId: TARGET_PRINCIPAL,
      request: {
        idempotencyKey: 'activation-before-terminal-expiry',
        projectId: PROJECT_ID,
        relinquishmentProof: proof,
        targetActivationProof: Buffer.alloc(32, 6).toString('base64url'),
        transferId: begun.transferId,
      },
    });
    harness.state.recovery = undefined;
    coordinator = harness.coordinator(EXPIRES_AT);

    await assert.rejects(coordinator.getStatus({
      principalId: OFFLINE_PRINCIPAL,
      request: { projectId: PROJECT_ID, transferId: begun.transferId },
    }), (error: unknown) => error instanceof CloudToLanTransferCoordinatorError
      && error.code === 'authorization-denied');
  });
});
