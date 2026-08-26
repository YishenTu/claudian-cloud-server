import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  decodeCollabAuthorityTransferStatus,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferStatus,
  type CollabCheckpointBackupRecord,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectCheckpointManifest,
  type CollabTransferredMembershipClaimCustodyReceipt,
  type CollabTransferredMembershipRedemptionReceipt,
  type CancelProjectAuthorityTransferRequest,
} from '@claudian-collab/protocol';

import type {
  AdvanceProjectLifecycleJournalInput,
  AuthorityTransferRecoveryEvidenceInput,
  AuthorityTransferRecoveryInput,
  AuthorityTransferRecoveryRecord,
  DeleteTransferredMembershipClaimsInput,
  DiscardLanToCloudProjectStageInput,
  PortabilityLifecyclePersistence,
  ProjectLifecycleJournalRecord,
  ProjectPrincipalBindingRecord,
  ProjectTombstoneInput,
  PutProjectLifecycleJournalInput,
  RedeemTransferredMembershipClaimInput,
  RevokeTransferredMembershipClaimsInput,
  RotateTransferredMembershipClaimsInput,
  StageLanToCloudProjectInput,
  TransferredMembershipClaimInput,
  TransferredMembershipClaimRecord,
} from '../../src/coordination/PortabilityLifecyclePersistence.js';
import type {
  PinnedProjectLease,
  ProjectMembershipRecord,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import type { PreparedProductionCheckpointAttempt } from '../../src/onboarding/production/ProductionCheckpointStaging.js';
import {
  ProjectCheckpointCoordinatorError,
  type ValidatedProjectCheckpoint,
} from '../../src/project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import {
  LanToCloudTransferCoordinator,
  LanToCloudTransferCoordinatorError,
  type ActivateLanToCloudProjectInput,
  type LanToCloudProjectActivationPort,
  type LanToCloudSourceTrustPort,
  type VerifiedLanToCloudSourceProof,
} from '../../src/project-authority/lifecycle/lan-to-cloud/LanToCloudTransferCoordinator.js';
import type { InactiveRepositoryPublication } from '../../src/repositories/RepositoryCheckpointAuthority.js';

const CREATED_AT = '2026-08-26T00:00:00.000Z';
const EXPIRES_AT = '2026-09-25T00:00:00.000Z';
const PROJECT_ID = 'project-a';
const TRANSFER_ID = 'transfer-a';
const HOST_MEMBER_ID = 'member-host';
const OFFLINE_MEMBER_ID = 'member-offline';
const HOST_PRINCIPAL_ID = 'principal:host';
const OFFLINE_PRINCIPAL_ID = 'principal:offline';
const TARGET_URL = 'https://cloud.example.test';
const MAIN_OID = '1'.repeat(40);
const HOST_OID = '2'.repeat(40);
const OFFLINE_OID = '3'.repeat(40);
const SIGNATURE = Buffer.alloc(64, 7).toString('base64url');
const PUBLIC_KEY = Buffer.alloc(32, 8).toString('base64url');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

class MemoryPortability {
  readonly bindings = new Map<string, ProjectPrincipalBindingRecord>();
  readonly claims = new Map<CollabMemberId, TransferredMembershipClaimRecord>();
  custodyReceipt: CollabTransferredMembershipClaimCustodyReceipt | undefined;
  failAdvanceTo: string | undefined;
  failPublicationPlanPersistence = false;
  journal: ProjectLifecycleJournalRecord | undefined;
  recovery: AuthorityTransferRecoveryRecord | undefined;
  tombstoned = false;
  staged = false;

  stageLanToCloudProject(
    _input: StageLanToCloudProjectInput,
  ): Promise<'created'> {
    assert.equal(this.staged, false);
    this.staged = true;
    return Promise.resolve('created');
  }

  discardLanToCloudProjectStage(
    _input: DiscardLanToCloudProjectStageInput,
  ): Promise<'advanced' | 'replayed'> {
    const result = this.staged ? 'advanced' : 'replayed';
    this.staged = false;
    return Promise.resolve(result);
  }

  putLifecycleJournal(input: PutProjectLifecycleJournalInput): Promise<'created' | 'replayed'> {
    if (this.journal !== undefined) return Promise.resolve('replayed');
    this.journal = Object.freeze({
      ...input,
      batchRevision: undefined,
      batchSha256: undefined,
      checkpointSha256: undefined,
      recoveryFromPhase: undefined,
      resultSha256: undefined,
      state: 'active',
      updatedAt: input.createdAt,
    });
    return Promise.resolve('created');
  }

  getLifecycleJournal(): Promise<ProjectLifecycleJournalRecord | undefined> {
    return Promise.resolve(this.journal);
  }

  advanceLifecycleJournal(input: AdvanceProjectLifecycleJournalInput): Promise<'advanced' | 'replayed'> {
    if (this.failAdvanceTo === input.nextPhase) {
      throw new Error('injected-journal-advance-failure');
    }
    const current = this.journal;
    assert.ok(current);
    if (current.phase === input.nextPhase && current.state === input.nextState) {
      return Promise.resolve('replayed');
    }
    assert.equal(current.phase, input.expectedPhase);
    assert.equal(current.state, input.expectedState);
    this.journal = Object.freeze({
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
    return Promise.resolve('advanced');
  }

  putAuthorityTransferRecovery(input: AuthorityTransferRecoveryInput): Promise<'created' | 'replayed'> {
    if (this.recovery !== undefined) return Promise.resolve('replayed');
    this.recovery = Object.freeze({
      ...input,
      cancellationRequestSha256: undefined,
      inactivePublicationJson: undefined,
      relinquishmentProof: undefined,
      sourceProof: undefined,
      sourceReopenSha256: undefined,
      stageSha256: undefined,
      targetActivationProof: undefined,
      targetProof: undefined,
      updatedAt: input.createdAt,
    });
    return Promise.resolve('created');
  }

  getAuthorityTransferRecovery(): Promise<AuthorityTransferRecoveryRecord | undefined> {
    return Promise.resolve(this.recovery);
  }

  advanceAuthorityTransferRecoveryEvidence(input: AuthorityTransferRecoveryEvidenceInput): Promise<'advanced'> {
    if (
      this.failPublicationPlanPersistence
      && input.inactivePublicationJson !== undefined
    ) {
      throw new Error('injected-publication-plan-persistence-failure');
    }
    const current = this.recovery;
    assert.ok(current);
    assert.equal(current.updatedAt, input.expectedUpdatedAt);
    for (const [stored, incoming] of [
      [current.cancellationRequestSha256, input.cancellationRequestSha256],
      [current.inactivePublicationJson, input.inactivePublicationJson],
      [current.sourceProof, input.sourceProof],
      [current.sourceReopenSha256, input.sourceReopenSha256],
    ] as const) {
      if (stored !== undefined && incoming !== undefined) assert.equal(incoming, stored);
    }
    this.recovery = Object.freeze({
      ...current,
      cancellationRequestSha256: current.cancellationRequestSha256
        ?? input.cancellationRequestSha256,
      inactivePublicationJson: current.inactivePublicationJson
        ?? input.inactivePublicationJson,
      relinquishmentProof: input.relinquishmentProof ?? current.relinquishmentProof,
      sourceProof: current.sourceProof ?? input.sourceProof,
      sourceReopenSha256: current.sourceReopenSha256 ?? input.sourceReopenSha256,
      stageSha256: input.stageSha256 ?? current.stageSha256,
      targetActivationProof: input.targetActivationProof ?? current.targetActivationProof,
      targetProof: input.targetProof ?? current.targetProof,
      updatedAt: input.updatedAt,
    });
    return Promise.resolve('advanced');
  }

  getAuthorityTransferStatus(): Promise<CollabAuthorityTransferStatus | undefined> {
    if (this.journal === undefined || this.recovery === undefined) return Promise.resolve(undefined);
    return Promise.resolve(decodeCollabAuthorityTransferStatus({
      batchRevision: this.journal.batchRevision ?? null,
      batchSha256: this.journal.batchSha256 ?? null,
      checkpointSha256: this.journal.checkpointSha256 ?? null,
      createdAt: this.recovery.createdAt,
      direction: this.journal.direction,
      expiresAt: this.recovery.expiresAt,
      phase: this.journal.phase,
      projectId: this.journal.projectId,
      relinquishmentProof: this.recovery.relinquishmentProof ?? null,
      sourceAuthority: this.recovery.sourceAuthority,
      state: this.journal.state === 'cancelled' || this.journal.state === 'completed'
        ? this.journal.state
        : 'active',
      targetAuthority: this.recovery.targetAuthority,
      targetUrl: this.recovery.targetUrl,
      transferId: this.recovery.transferId,
      updatedAt: this.journal.updatedAt,
    }));
  }

  putTransferReceiptKey(): Promise<'created'> {
    return Promise.resolve('created');
  }

  putTransferredMembershipClaim(input: TransferredMembershipClaimInput): Promise<'created'> {
    this.claims.set(input.memberId, Object.freeze({
      ...input,
      operationIntentId: undefined,
      redemptionReceiptId: undefined,
      state: 'unclaimed',
      targetPrincipalId: undefined,
      updatedAt: input.createdAt,
    }));
    return Promise.resolve('created');
  }

  getTransferredMembershipClaim(
    _transferId: string,
    memberId: CollabMemberId,
  ): Promise<TransferredMembershipClaimRecord | undefined> {
    return Promise.resolve(this.claims.get(memberId));
  }

  findTransferredMembershipClaimBySha256(
    _transferId: string,
    claimSha256: string,
  ): Promise<TransferredMembershipClaimRecord | undefined> {
    return Promise.resolve([...this.claims.values()].find(claim => (
      claim.claimSha256 === claimSha256
    )));
  }

  rotateTransferredMembershipClaims(input: RotateTransferredMembershipClaimsInput): Promise<'advanced'> {
    const journal = this.journal;
    assert.ok(journal);
    assert.equal(journal.batchRevision, input.expectedBatchRevision);
    assert.equal(journal.batchSha256, input.expectedBatchSha256);
    this.claims.clear();
    for (const replacement of input.replacements) {
      this.claims.set(replacement.memberId, Object.freeze({
        batchRevision: input.nextBatchRevision,
        checkpointSha256: input.checkpointSha256,
        claimSha256: replacement.claimSha256,
        createdAt: input.rotatedAt,
        expiresAt: replacement.expiresAt,
        memberId: replacement.memberId,
        operationIntentId: undefined,
        redemptionReceiptId: undefined,
        state: 'unclaimed',
        targetPrincipalId: undefined,
        transferId: input.transferId,
        updatedAt: input.rotatedAt,
      }));
    }
    const current = this.journal;
    assert.ok(current);
    this.journal = Object.freeze({
      ...current,
      batchRevision: input.nextBatchRevision,
      batchSha256: input.nextBatchSha256,
      scheduledAt: input.scheduledAt,
      updatedAt: input.rotatedAt,
    });
    return Promise.resolve('advanced');
  }

  putClaimBatchReceipt(receipt: CollabTransferredMembershipClaimCustodyReceipt): Promise<'created'> {
    this.custodyReceipt = receipt;
    return Promise.resolve('created');
  }

  getTransferClaimBatchReceipt(): Promise<CollabTransferredMembershipClaimCustodyReceipt | undefined> {
    return Promise.resolve(this.custodyReceipt);
  }

  getProjectTombstone(): Promise<ProjectTombstoneInput | undefined> {
    return Promise.resolve(this.tombstoned ? Object.freeze({
      authorityGeneration: 1,
      projectId: PROJECT_ID,
      resultSha256: sha256('retired'),
      retiredAt: CREATED_AT,
      terminalExpiresAt: EXPIRES_AT,
      terminalOperationId: 'retire-operation',
      terminalOperationKind: 'retire',
    }) : undefined);
  }

  redeemTransferredMembershipClaim(input: RedeemTransferredMembershipClaimInput): Promise<CollabTransferredMembershipRedemptionReceipt> {
    const claim = this.claims.get(input.memberId);
    assert.ok(claim);
    if (claim.state === 'redeemed') return Promise.resolve(input.receipt);
    assert.equal(claim.state, 'unclaimed');
    assert.equal(claim.claimSha256, input.claimSha256);
    this.claims.set(input.memberId, Object.freeze({
      ...claim,
      operationIntentId: input.operationIntentId,
      redemptionReceiptId: input.receipt.receiptId,
      state: 'redeemed',
      targetPrincipalId: input.targetPrincipalId,
      updatedAt: input.updatedAt,
    }));
    this.bind(input.targetPrincipalId, input.memberId, input.updatedAt);
    return Promise.resolve(input.receipt);
  }

  revokeTransferredMembershipClaims(input: RevokeTransferredMembershipClaimsInput): Promise<'advanced'> {
    for (const claim of this.claims.values()) {
      if (claim.state === 'revoked') {
        assert.equal(claim.updatedAt, input.revokedAt);
        continue;
      }
      this.claims.set(claim.memberId, Object.freeze({ ...claim, state: 'revoked', updatedAt: input.revokedAt }));
    }
    return Promise.resolve('advanced');
  }

  deleteTransferredMembershipClaims(
    _input: DeleteTransferredMembershipClaimsInput,
  ): Promise<'advanced' | 'replayed'> {
    const result = this.claims.size === 0 ? 'replayed' : 'advanced';
    this.claims.clear();
    return Promise.resolve(result);
  }

  findProjectPrincipalBinding(principalId: string): Promise<ProjectPrincipalBindingRecord | undefined> {
    return Promise.resolve(this.bindings.get(principalId));
  }

  bindProjectPrincipal(input: Readonly<{
    readonly boundAt: CollabIsoTimestamp;
    readonly memberId: CollabMemberId;
    readonly principalId: string;
  }>): Promise<'created'> {
    this.bind(input.principalId, input.memberId, input.boundAt);
    return Promise.resolve('created');
  }

  bind(principalId: string, memberId: CollabMemberId, boundAt: CollabIsoTimestamp): void {
    this.bindings.set(principalId, Object.freeze({
      boundAt,
      memberId,
      principalId,
      revokedAt: undefined,
      state: 'active',
    }));
  }
}

class MemoryCoordination {
  readonly portability = new MemoryPortability();
  readonly members: readonly ProjectMembershipRecord[];
  failMembershipEnumeration = false;
  targetOccupied = false;

  constructor(memberIds: readonly CollabMemberId[]) {
    this.members = Object.freeze(memberIds.map((memberId, index) => Object.freeze({
      displayName: index === 0 ? 'Host' : 'Offline Member',
      memberId,
      revision: 1n,
      role: index === 0 ? 'manager' as const : 'member' as const,
      status: 'active' as const,
    })));
  }

  acquireProjectLease(): Promise<PinnedProjectLease> {
    return Promise.resolve(this.lease());
  }

  lease(): PinnedProjectLease {
    const scope = {
      accept: undefined as never,
      collaboration: undefined as never,
      portability: this.portability as unknown as PortabilityLifecyclePersistence,
      getProject: () => Promise.resolve(this.targetOccupied || this.portability.staged
        ? Object.freeze({
        activatedAt: CREATED_AT,
        authorityGeneration: this.portability.staged ? 2 : 1,
        authorityStateRevision: 1,
        createdAt: CREATED_AT,
        expectedMainOid: MAIN_OID,
        managerSetGeneration: 1,
        projectId: PROJECT_ID,
        projectName: this.portability.staged ? 'Project A' : 'Existing Project',
        serviceState: this.portability.staged ? 'maintenance' as const : 'active' as const,
      }) : undefined),
      listMemberships: () => this.failMembershipEnumeration
        ? Promise.reject(new Error('membership-enumeration-not-allowed'))
        : Promise.resolve(this.members),
    } as unknown as ProjectScope;
    return {
      close: () => Promise.resolve(),
      drainDevelopmentBootstrapUploads: () => Promise.resolve(),
      handoffToDevelopmentBootstrapUpload: () => Promise.reject(new Error('unused')),
      withProjectScope: operation => operation(scope),
    };
  }
}

class MemoryActivation implements LanToCloudProjectActivationPort {
  calls = 0;
  failNext = false;
  receiptKeyIds: string[] = [];
  wait: Promise<void> | undefined;

  async activate(input: ActivateLanToCloudProjectInput): Promise<'activated'> {
    this.calls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('injected-activation-failure');
    }
    if (this.wait !== undefined) await this.wait;
    this.receiptKeyIds.push(input.receiptKeyId);
    const portability = await input.lease.withProjectScope(scope => Promise.resolve(scope.portability));
    assert.ok(input.journal.batchRevision);
    assert.ok(input.journal.batchSha256);
    assert.ok(input.journal.checkpointSha256);
    await portability.bindProjectPrincipal({
      boundAt: input.activatedAt,
      memberId: input.hostMemberId,
      principalId: input.hostPrincipalId,
    });
    await portability.advanceLifecycleJournal({
      batchRevision: input.journal.batchRevision,
      batchSha256: input.journal.batchSha256,
      checkpointSha256: input.journal.checkpointSha256,
      expectedPhase: 'source-relinquished',
      expectedState: 'active',
      nextPhase: 'cloud-activated',
      nextState: 'active',
      operationId: input.journal.operationId,
      scheduledAt: input.activatedAt,
      updatedAt: input.activatedAt,
    });
    return 'activated';
  }
}

class MemoryRepository {
  planCalls = 0;
  publishCalls = 0;
  removeCalls = 0;

  planInactive(): InactiveRepositoryPublication {
    this.planCalls += 1;
    return Object.freeze({
      artifactKey: sha256('artifact'),
      bundleByteCount: 16,
      bundleSha256: sha256('bundle'),
      objectFormat: 'sha1',
      operationId: TRANSFER_ID,
      placementGeneration: 1,
      projectId: PROJECT_ID,
      publicationMarkerSha256: sha256('publication'),
      refs: Object.freeze([
        Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
        Object.freeze({ name: `refs/heads/members/${HOST_MEMBER_ID}`, oid: HOST_OID }),
      ]),
      repositoryStorageKey: 'repo_test',
      status: 'inactive',
      storageNodeId: 'node_test',
      validationMarkerSha256: sha256('validation'),
    });
  }

  publishInactive(): Promise<InactiveRepositoryPublication> {
    this.publishCalls += 1;
    return Promise.resolve(this.planInactive());
  }

  removeOwnedRepository(): Promise<'removed'> {
    this.removeCalls += 1;
    return Promise.resolve('removed');
  }
}

class MemoryStaging {
  discardCalls = 0;
  prepareCalls = 0;

  discardAttempt(): Promise<'removed'> {
    this.discardCalls += 1;
    return Promise.resolve('removed');
  }

  prepareAttempt(
    input: Omit<PreparedProductionCheckpointAttempt, 'attemptKey'>,
  ): Promise<PreparedProductionCheckpointAttempt> {
    this.prepareCalls += 1;
    return Promise.resolve(Object.freeze({
      ...input,
      attemptKey: sha256(`production-checkpoint\0${input.projectId}\0${input.operationId}`),
    }));
  }
}

class MemoryReceiptSigner {
  readonly keys = new Map<string, Readonly<{
    readonly publicKey: string;
    readonly signature: string;
  }>>();
  activeKey: Readonly<{ readonly publicKey: string; readonly receiptKeyId: string }> = Object.freeze({
    publicKey: PUBLIC_KEY,
    receiptKeyId: 'receipt-key',
  });

  constructor() {
    this.keys.set(this.activeKey.receiptKeyId, Object.freeze({
      publicKey: this.activeKey.publicKey,
      signature: SIGNATURE,
    }));
  }

  rotate(): void {
    const receiptKeyId = `receipt-key-${String(this.keys.size + 1)}`;
    const publicKey = Buffer.alloc(32, this.keys.size + 8).toString('base64url');
    const signature = Buffer.alloc(64, this.keys.size + 7).toString('base64url');
    this.activeKey = Object.freeze({ publicKey, receiptKeyId });
    this.keys.set(receiptKeyId, Object.freeze({ publicKey, signature }));
  }

  sign(input: Readonly<{
    readonly receiptKeyId: string;
    readonly signingInput: string;
  }>): Promise<string> {
    assert.ok(input.signingInput.length > 0);
    const key = this.keys.get(input.receiptKeyId);
    assert.ok(key);
    return Promise.resolve(key.signature);
  }
}

function checkpoint(includeOfflineMember: boolean): ValidatedProjectCheckpoint {
  const members: Array<Readonly<{
    memberId: CollabMemberId;
    oid: string;
    role: 'manager' | 'member';
  }>> = [{ memberId: HOST_MEMBER_ID, oid: HOST_OID, role: 'manager' }];
  if (includeOfflineMember) {
    members.push({ memberId: OFFLINE_MEMBER_ID, oid: OFFLINE_OID, role: 'member' });
  }
  const records: CollabCheckpointBackupRecord[] = [Object.freeze({
    kind: 'project',
    recordId: PROJECT_ID,
    revision: 1,
    value: Object.freeze({
      activatedAt: CREATED_AT,
      authorityGeneration: 1,
      createdAt: CREATED_AT,
      expectedMainOid: MAIN_OID,
      managerSetGeneration: 1,
      name: 'Project A',
      projectId: PROJECT_ID,
    }),
  })];
  for (const member of members) {
    records.push(Object.freeze({
      kind: 'member',
      recordId: member.memberId,
      revision: 1,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: member.memberId,
        memberId: member.memberId,
        personalRef: `refs/heads/members/${member.memberId}`,
        projectId: PROJECT_ID,
        revokedAt: null,
        role: member.role,
        status: 'active',
        updatedAt: CREATED_AT,
      }),
    }));
  }
  const manifestSha256 = sha256(`manifest:${String(includeOfflineMember)}`);
  const manifest: CollabProjectCheckpointManifest = Object.freeze({
    artifacts: Object.freeze([
      Object.freeze({
        byteCount: 16,
        name: 'coordination.ndjson',
        sha256: sha256('coordination'),
      }),
      Object.freeze({
        byteCount: 16,
        name: 'repository.bundle',
        sha256: sha256('bundle'),
      }),
    ]),
    coordinationFormatVersion: 1,
    createdAt: CREATED_AT,
    expectedMainOid: MAIN_OID,
    gitObjectFormat: 'sha1',
    manifestSchemaVersion: 1,
    manifestSha256,
    operationId: TRANSFER_ID,
    profile: 'authority-transfer',
    projectId: PROJECT_ID,
    protocolVersion: 6,
    refs: Object.freeze([
      Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
      ...members.map(member => Object.freeze({
        name: `refs/heads/members/${member.memberId}`,
        oid: member.oid,
      })),
    ]),
    sourceAuthority: Object.freeze({ generation: 1, kind: 'lan' }),
    targetAuthority: Object.freeze({ generation: 2, kind: 'cloud' }),
  });
  return Object.freeze({
    attempt: Object.freeze({
      attemptKey: sha256(`production-checkpoint\0${PROJECT_ID}\0${TRANSFER_ID}`),
      expiresAt: EXPIRES_AT,
      operationId: TRANSFER_ID,
      projectId: PROJECT_ID,
    }),
    manifest,
    records: Object.freeze(records),
    repository: Object.freeze({
      artifactKey: sha256('artifact'),
      bundleByteCount: 16,
      bundleInputDisposition: 'consumed',
      bundleSha256: sha256('bundle'),
      markerSha256: sha256('validation'),
      objectFormat: 'sha1',
      operationId: TRANSFER_ID,
      projectId: PROJECT_ID,
      refs: manifest.refs,
    }),
  });
}

interface Fixture {
  readonly activation: MemoryActivation;
  readonly checkpoint: ValidatedProjectCheckpoint;
  readonly coordination: MemoryCoordination;
  readonly coordinator: LanToCloudTransferCoordinator;
  readonly expire: () => void;
  readonly repository: MemoryRepository;
  readonly restart: () => LanToCloudTransferCoordinator;
  readonly signer: MemoryReceiptSigner;
  readonly staging: MemoryStaging;
  readonly loseCheckpoint: () => void;
}

function beginInput(test: Fixture) {
  return {
    expiresAt: EXPIRES_AT,
    principalId: HOST_PRINCIPAL_ID,
    request: {
      checkpointManifestSha256: test.checkpoint.manifest.manifestSha256,
      expectedSourceAuthorityGeneration: 1,
      idempotencyKey: 'intent-begin',
      projectId: PROJECT_ID,
      sourceHostMemberId: HOST_MEMBER_ID,
      sourceProof: 'source-proof',
      targetUrl: TARGET_URL,
      transferId: TRANSFER_ID,
    },
  } as const;
}

function fixture(includeOfflineMember = true): Fixture {
  const validated = checkpoint(includeOfflineMember);
  const coordination = new MemoryCoordination([
    HOST_MEMBER_ID,
    ...(includeOfflineMember ? [OFFLINE_MEMBER_ID] : []),
  ]);
  const activation = new MemoryActivation();
  const repository = new MemoryRepository();
  const staging = new MemoryStaging();
  const signer = new MemoryReceiptSigner();
  let checkpointAvailable = true;
  let now = Date.parse(CREATED_AT);
  let claimSequence = 0;
  const sourceProof: VerifiedLanToCloudSourceProof = Object.freeze({
    checkpointManifestSha256: validated.manifest.manifestSha256,
    projectId: PROJECT_ID,
    sourceAuthorityGeneration: 1,
    sourceHostMemberId: HOST_MEMBER_ID,
    targetAuthorityGeneration: 2,
    targetUrl: TARGET_URL,
    transferId: TRANSFER_ID,
  });
  const trust: LanToCloudSourceTrustPort = {
    verifyRelinquishmentProof: () => Promise.resolve(),
    verifySourceProof: () => Promise.resolve(sourceProof),
  };
  const restart = () => new LanToCloudTransferCoordinator({
      activation,
      checkpoint: {
        discardAttempt: async () => {
          await staging.discardAttempt();
        },
        validateStaged: () => checkpointAvailable
          ? Promise.resolve(validated)
          : Promise.reject(new ProjectCheckpointCoordinatorError('invalid-checkpoint')),
        validateStagedWithRepository: (_input, repositoryCheckpoint) => (
          checkpointAvailable
            ? Promise.resolve(Object.freeze({
                ...validated,
                repository: repositoryCheckpoint,
              }))
            : Promise.reject(new ProjectCheckpointCoordinatorError('invalid-checkpoint'))
        ),
      },
      claimFactory: () => Buffer.from(`claim-${String(claimSequence += 1)}`).toString('base64url'),
      clock: () => new Date(now += 1_000),
      coordination,
      custodyReceiptIdFactory: () => 'custody-receipt',
      receiptIdFactory: () => 'redemption-receipt',
      receiptSigner: signer,
      relinquishmentTrust: trust,
      repository,
      repositoryStorageKeyFactory: () => 'repo_test',
      staging,
    });
  const coordinator = restart();
  const expire = () => {
    now = Date.parse(EXPIRES_AT);
  };
  const loseCheckpoint = () => {
    checkpointAvailable = false;
  };
  return {
    activation,
    checkpoint: validated,
    coordination,
    coordinator,
    expire,
    loseCheckpoint,
    repository,
    restart,
    signer,
    staging,
  };
}

async function beginAndValidate(test: Fixture): Promise<void> {
  const status = await test.coordinator.begin(beginInput(test));
  assert.equal(status.phase, 'source-quiesced');
  const validated = await test.coordinator.completeCheckpoint({
    principalId: HOST_PRINCIPAL_ID,
    projectId: PROJECT_ID,
    transferId: TRANSFER_ID,
  });
  assert.equal(validated.phase, 'checkpoint-validated');
}

async function publishTransfer(test: Fixture) {
  await beginAndValidate(test);
  const batchSha256 = test.coordination.portability.journal?.batchSha256;
  assert.ok(batchSha256);
  const batch = await test.coordinator.rotateClaims({
    principalId: HOST_PRINCIPAL_ID,
    request: {
      expectedBatchRevision: 1,
      expectedBatchSha256: batchSha256,
      idempotencyKey: 'intent-delivery',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    },
  });
  const receipt = await test.coordinator.acknowledgeClaimBatch({
    principalId: HOST_PRINCIPAL_ID,
    request: custodyRequest(batch.batchRevision, batch.batchSha256),
  });
  return { batch, receipt };
}

function custodyRequest(batchRevision: number, batchSha256: string) {
  return {
    batchRevision,
    batchSha256,
    idempotencyKey: 'intent-ack-request',
    operationIntentId: 'intent-ack-operation',
    projectId: PROJECT_ID,
    transferId: TRANSFER_ID,
  };
}

function cancellationRequest(
  expectedPhase: CancelProjectAuthorityTransferRequest['expectedPhase'],
  idempotencyKey: string,
): CancelProjectAuthorityTransferRequest {
  return {
    expectedPhase,
    idempotencyKey,
    projectId: PROJECT_ID,
    transferId: TRANSFER_ID,
  };
}

async function confirmSourceReopened(
  coordinator: LanToCloudTransferCoordinator,
  idempotencyKey: string,
): Promise<CollabAuthorityTransferStatus> {
  return coordinator.cancel({
    principalId: HOST_PRINCIPAL_ID,
    request: cancellationRequest('target-cleaned', idempotencyKey),
  });
}

function relinquishmentProof(
  batchRevision: number,
  batchSha256: string,
  checkpointSha256: string,
): CollabAuthorityRelinquishmentProof {
  return Object.freeze({
    batchRevision,
    batchSha256,
    certificate: SIGNATURE,
    certificateAlgorithm: 'ed25519',
    checkpointSha256,
    committedAt: '2026-08-26T01:00:00.000Z',
    operationIntentId: 'intent-relinquish-operation',
    projectId: PROJECT_ID,
    sourceAuthority: Object.freeze({ generation: 1, kind: 'lan' }),
    sourceHostMemberId: HOST_MEMBER_ID,
    targetAuthority: Object.freeze({ generation: 2, kind: 'cloud' }),
    transferId: TRANSFER_ID,
  });
}

async function assertCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof LanToCloudTransferCoordinatorError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('LanToCloudTransferCoordinator', () => {
  it('exposes safe fixed errors at the Project Authority seam', () => {
    const error = new LanToCloudTransferCoordinatorError('state-conflict');

    assert.deepEqual(error.toJSON(), {
      code: 'state-conflict',
      message: 'lan-to-cloud-transfer.error.state-conflict',
      name: 'LanToCloudTransferCoordinatorError',
      retryable: false,
    });
  });

  it('rotates ambiguous delivery, activates one writer, and binds offline identity exactly', async () => {
    const test = fixture();
    await beginAndValidate(test);
    const initialDigest = test.coordination.portability.journal?.batchSha256;
    assert.ok(initialDigest);
    const initial = await test.coordinator.rotateClaims({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedBatchRevision: 1,
        expectedBatchSha256: initialDigest,
        idempotencyKey: 'intent-rotate-one',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    assert.equal(initial.batchRevision, 1);
    assert.deepEqual(initial.claims.map(claim => claim.memberId), [OFFLINE_MEMBER_ID]);
    const restartedAfterLostBatch = test.restart();
    const rotated = await restartedAfterLostBatch.rotateClaims({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedBatchRevision: initial.batchRevision,
        expectedBatchSha256: initial.batchSha256,
        idempotencyKey: 'intent-rotate-two',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    assert.equal(rotated.batchRevision, 2);
    assert.notEqual(rotated.claims[0]?.claim, initial.claims[0]?.claim);
    const receipt = await restartedAfterLostBatch.acknowledgeClaimBatch({
      principalId: HOST_PRINCIPAL_ID,
      request: custodyRequest(rotated.batchRevision, rotated.batchSha256),
    });
    assert.equal(receipt.batchSha256, rotated.batchSha256);
    assert.equal(test.repository.publishCalls, 1);
    const restartedAfterLostReceipt = test.restart();
    const replayed = await restartedAfterLostReceipt.acknowledgeClaimBatch({
      principalId: HOST_PRINCIPAL_ID,
      request: custodyRequest(rotated.batchRevision, rotated.batchSha256),
    });
    assert.deepEqual(replayed, receipt);
    await assertCode(restartedAfterLostReceipt.acknowledgeClaimBatch({
      principalId: HOST_PRINCIPAL_ID,
      request: custodyRequest(rotated.batchRevision, sha256('wrong-batch')),
    }), 'state-conflict');
    assert.equal(test.coordination.portability.journal?.batchRevision, 2);
    test.signer.rotate();

    const proof = relinquishmentProof(
      rotated.batchRevision,
      rotated.batchSha256,
      rotated.checkpointSha256,
    );
    const completed = await test.restart().commitRelinquishment({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        idempotencyKey: 'intent-relinquish-request',
        projectId: PROJECT_ID,
        proof,
        transferId: TRANSFER_ID,
      },
    });
    assert.equal(completed.phase, 'completed');
    assert.equal(completed.state, 'completed');
    assert.equal(test.activation.calls, 1);
    assert.deepEqual(test.activation.receiptKeyIds, ['receipt-key']);
    assert.equal(
      test.coordination.portability.bindings.get(HOST_PRINCIPAL_ID)?.memberId,
      HOST_MEMBER_ID,
    );
    assert.equal(test.coordination.portability.bindings.has(OFFLINE_PRINCIPAL_ID), false);
    const replayedCompletion = await test.restart().commitRelinquishment({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        idempotencyKey: 'intent-relinquish-request',
        projectId: PROJECT_ID,
        proof,
        transferId: TRANSFER_ID,
      },
    });
    assert.deepEqual(replayedCompletion, completed);
    assert.equal(test.activation.calls, 1);
    await assertCode(test.restart().commitRelinquishment({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        idempotencyKey: 'intent-relinquish-request',
        projectId: PROJECT_ID,
        proof: Object.freeze({ ...proof, certificate: Buffer.alloc(64, 9).toString('base64url') }),
        transferId: TRANSFER_ID,
      },
    }), 'state-conflict');
    await assertCode(test.coordinator.claimMembership({
      principalId: OFFLINE_PRINCIPAL_ID,
      request: {
        claim: initial.claims[0]?.claim ?? '',
        idempotencyKey: 'intent-old-claim',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    }), 'authorization-denied');
    const claim = rotated.claims[0]?.claim;
    assert.ok(claim);
    test.coordination.failMembershipEnumeration = true;
    await assertCode(test.coordinator.claimMembership({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        claim,
        idempotencyKey: 'intent-host-steal',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    }), 'authorization-denied');
    assert.equal(
      test.coordination.portability.bindings.get(HOST_PRINCIPAL_ID)?.memberId,
      HOST_MEMBER_ID,
    );
    const redemption = await test.coordinator.claimMembership({
      principalId: OFFLINE_PRINCIPAL_ID,
      request: {
        claim,
        idempotencyKey: 'intent-claim',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    test.signer.rotate();
    const redemptionReplay = await test.restart().claimMembership({
      principalId: OFFLINE_PRINCIPAL_ID,
      request: {
        claim,
        idempotencyKey: 'intent-claim',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    assert.deepEqual(redemptionReplay, redemption);
    assert.equal(
      test.coordination.portability.bindings.get(OFFLINE_PRINCIPAL_ID)?.memberId,
      OFFLINE_MEMBER_ID,
    );
    await assertCode(test.coordinator.claimMembership({
      principalId: 'principal:attacker',
      request: {
        claim,
        idempotencyKey: 'intent-claim',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    }), 'authorization-denied');
  });

  it('commits the canonical empty batch for a Host-only Project', async () => {
    const test = fixture(false);
    await beginAndValidate(test);
    const batchSha256 = test.coordination.portability.journal?.batchSha256;
    assert.ok(batchSha256);
    const batch = await test.coordinator.rotateClaims({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedBatchRevision: 1,
        expectedBatchSha256: batchSha256,
        idempotencyKey: 'intent-empty',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    assert.deepEqual(batch.claims, []);
    assert.equal(batch.batchRevision, 1);
    const receipt = await test.coordinator.acknowledgeClaimBatch({
      principalId: HOST_PRINCIPAL_ID,
      request: custodyRequest(batch.batchRevision, batch.batchSha256),
    });
    assert.equal(receipt.batchSha256, batch.batchSha256);
    assert.equal(test.coordination.portability.claims.size, 0);
  });

  it('recovers forward after relinquishment and forbids cancellation', async () => {
    const test = fixture();
    await beginAndValidate(test);
    const batchSha256 = test.coordination.portability.journal?.batchSha256;
    assert.ok(batchSha256);
    const batch = await test.coordinator.rotateClaims({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedBatchRevision: 1,
        expectedBatchSha256: batchSha256,
        idempotencyKey: 'intent-delivery',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    await test.coordinator.acknowledgeClaimBatch({
      principalId: HOST_PRINCIPAL_ID,
      request: custodyRequest(batch.batchRevision, batch.batchSha256),
    });
    test.activation.failNext = true;
    await assertCode(test.coordinator.commitRelinquishment({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        idempotencyKey: 'intent-relinquish-request',
        projectId: PROJECT_ID,
        proof: relinquishmentProof(
          batch.batchRevision,
          batch.batchSha256,
          batch.checkpointSha256,
        ),
        transferId: TRANSFER_ID,
      },
    }), 'dependency-failed');
    assert.equal(test.coordination.portability.journal?.phase, 'source-relinquished');
    await assertCode(test.coordinator.cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedPhase: 'repository-published',
        idempotencyKey: 'intent-cancel',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    }), 'state-conflict');
    const journal = test.coordination.portability.journal;
    assert.ok(journal);
    await test.coordinator.recover({ journal, lease: test.coordination.lease() });
    assert.equal(test.coordination.portability.journal.phase, 'completed');
    assert.equal(test.activation.calls, 2);
  });

  it('invalidates claims and removes attempt-owned state before cutover', async () => {
    const test = fixture();
    await beginAndValidate(test);
    const cleaned = await test.coordinator.cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedPhase: 'checkpoint-validated',
        idempotencyKey: 'intent-cancel',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    assert.equal(cleaned.phase, 'target-cleaned');
    assert.equal(cleaned.state, 'active');
    assert.equal(test.repository.removeCalls, 0);
    assert.equal(test.repository.publishCalls, 0);
    assert.equal(test.staging.discardCalls, 1);
    assert.equal(test.coordination.portability.claims.size, 0);
    const cancelled = await confirmSourceReopened(
      test.coordinator,
      'intent-source-reopened',
    );
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.state, 'cancelled');
  });

  it('authorizes source operations only for the proof-bound principal', async () => {
    const test = fixture();
    await test.coordinator.begin({
      expiresAt: EXPIRES_AT,
      principalId: HOST_PRINCIPAL_ID,
      request: {
        checkpointManifestSha256: test.checkpoint.manifest.manifestSha256,
        expectedSourceAuthorityGeneration: 1,
        idempotencyKey: 'intent-begin',
        projectId: PROJECT_ID,
        sourceHostMemberId: HOST_MEMBER_ID,
        sourceProof: 'source-proof',
        targetUrl: TARGET_URL,
        transferId: TRANSFER_ID,
      },
    });
    await assertCode(test.coordinator.completeCheckpoint({
      principalId: 'principal:other',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }), 'authorization-denied');
  });

  it('replays begin with the transfer-pinned receipt key after active-key rotation', async () => {
    const test = fixture();
    await test.coordinator.begin({
      expiresAt: EXPIRES_AT,
      principalId: HOST_PRINCIPAL_ID,
      request: {
        checkpointManifestSha256: test.checkpoint.manifest.manifestSha256,
        expectedSourceAuthorityGeneration: 1,
        idempotencyKey: 'intent-begin',
        projectId: PROJECT_ID,
        sourceHostMemberId: HOST_MEMBER_ID,
        sourceProof: 'source-proof',
        targetUrl: TARGET_URL,
        transferId: TRANSFER_ID,
      },
    });
    test.signer.rotate();
    const replayed = await test.restart().begin({
      expiresAt: EXPIRES_AT,
      principalId: HOST_PRINCIPAL_ID,
      request: {
        checkpointManifestSha256: test.checkpoint.manifest.manifestSha256,
        expectedSourceAuthorityGeneration: 1,
        idempotencyKey: 'intent-begin',
        projectId: PROJECT_ID,
        sourceHostMemberId: HOST_MEMBER_ID,
        sourceProof: 'source-proof',
        targetUrl: TARGET_URL,
        transferId: TRANSFER_ID,
      },
    });
    assert.equal(replayed.phase, 'source-quiesced');
  });

  it('does not allow an expired attempt to advance toward relinquishment', async () => {
    const test = fixture();
    await beginAndValidate(test);
    test.expire();
    const batchSha256 = test.coordination.portability.journal?.batchSha256;
    assert.ok(batchSha256);
    await assertCode(test.coordinator.rotateClaims({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedBatchRevision: 1,
        expectedBatchSha256: batchSha256,
        idempotencyKey: 'intent-expired',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    }), 'expired');
    assert.equal(test.coordination.portability.journal?.phase, 'checkpoint-validated');
  });

  it('cancels safely before a complete checkpoint exists', async () => {
    const test = fixture();
    await test.coordinator.begin({
      expiresAt: EXPIRES_AT,
      principalId: HOST_PRINCIPAL_ID,
      request: {
        checkpointManifestSha256: test.checkpoint.manifest.manifestSha256,
        expectedSourceAuthorityGeneration: 1,
        idempotencyKey: 'intent-begin',
        projectId: PROJECT_ID,
        sourceHostMemberId: HOST_MEMBER_ID,
        sourceProof: 'source-proof',
        targetUrl: TARGET_URL,
        transferId: TRANSFER_ID,
      },
    });
    test.loseCheckpoint();
    const cleaned = await test.coordinator.cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedPhase: 'source-quiesced',
        idempotencyKey: 'intent-cancel-early',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    assert.equal(cleaned.phase, 'target-cleaned');
    assert.equal(test.staging.discardCalls, 1);
    assert.equal(test.repository.publishCalls, 0);
    assert.equal((await confirmSourceReopened(
      test.coordinator,
      'intent-source-reopened-early',
    )).phase, 'cancelled');
  });

  it('cancels an incomplete checkpoint-received attempt without publication', async () => {
    const test = fixture();
    await test.coordinator.begin({
      expiresAt: EXPIRES_AT,
      principalId: HOST_PRINCIPAL_ID,
      request: {
        checkpointManifestSha256: test.checkpoint.manifest.manifestSha256,
        expectedSourceAuthorityGeneration: 1,
        idempotencyKey: 'intent-begin',
        projectId: PROJECT_ID,
        sourceHostMemberId: HOST_MEMBER_ID,
        sourceProof: 'source-proof',
        targetUrl: TARGET_URL,
        transferId: TRANSFER_ID,
      },
    });
    const journal = test.coordination.portability.journal;
    assert.ok(journal);
    await test.coordination.portability.advanceLifecycleJournal({
      expectedPhase: 'source-quiesced',
      expectedState: 'active',
      nextPhase: 'checkpoint-received',
      nextState: 'active',
      operationId: TRANSFER_ID,
      scheduledAt: EXPIRES_AT,
      updatedAt: new Date(Date.parse(journal.updatedAt) + 1).toISOString(),
    });
    test.loseCheckpoint();
    const cleaned = await test.coordinator.cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedPhase: 'checkpoint-received',
        idempotencyKey: 'intent-cancel-partial',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    assert.equal(cleaned.phase, 'target-cleaned');
    assert.equal(test.repository.publishCalls, 0);
    assert.equal(test.staging.discardCalls, 1);
    assert.equal((await confirmSourceReopened(
      test.coordinator,
      'intent-source-reopened-partial',
    )).phase, 'cancelled');
  });

  it('deletes a nonempty claim batch even when checkpoint staging is lost', async () => {
    const test = fixture();
    await beginAndValidate(test);
    test.loseCheckpoint();
    const cleaned = await test.coordinator.cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedPhase: 'checkpoint-validated',
        idempotencyKey: 'intent-cancel-lost-checkpoint',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    assert.equal(cleaned.phase, 'target-cleaned');
    assert.equal(test.coordination.portability.claims.size, 0);
    assert.equal(test.repository.publishCalls, 0);
    assert.equal(test.staging.discardCalls, 1);
    assert.equal((await confirmSourceReopened(
      test.coordinator,
      'intent-source-reopened-lost-checkpoint',
    )).phase, 'cancelled');
  });

  it('cancels claims-retained without creating a publication plan after staging loss', async () => {
    const test = fixture();
    await beginAndValidate(test);
    const batchSha256 = test.coordination.portability.journal?.batchSha256;
    assert.ok(batchSha256);
    const batch = await test.coordinator.rotateClaims({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedBatchRevision: 1,
        expectedBatchSha256: batchSha256,
        idempotencyKey: 'intent-delivery-before-plan-loss',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    test.coordination.portability.failPublicationPlanPersistence = true;
    await assertCode(test.coordinator.acknowledgeClaimBatch({
      principalId: HOST_PRINCIPAL_ID,
      request: custodyRequest(batch.batchRevision, batch.batchSha256),
    }), 'dependency-failed');
    assert.equal(
      test.coordination.portability.journal?.phase,
      'claims-retained',
    );
    assert.equal(
      test.coordination.portability.recovery?.inactivePublicationJson,
      undefined,
    );
    test.coordination.portability.failPublicationPlanPersistence = false;
    test.loseCheckpoint();
    const planCallsBeforeCancellation = test.repository.planCalls;

    const cleaned = await test.restart().cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: cancellationRequest(
        'claims-retained',
        'intent-cancel-claims-retained-without-plan',
      ),
    });

    assert.equal(cleaned.phase, 'target-cleaned');
    assert.equal(test.coordination.portability.claims.size, 0);
    assert.equal(test.repository.planCalls, planCallsBeforeCancellation);
    assert.equal(test.repository.publishCalls, 0);
    assert.equal(test.repository.removeCalls, 0);
    assert.equal(test.staging.discardCalls, 1);
  });

  it('replays exact target cleanup and waits for source reopen proof', async () => {
    const test = fixture();
    await beginAndValidate(test);
    test.coordination.portability.failAdvanceTo = 'target-cleaned';
    await assertCode(test.coordinator.cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedPhase: 'checkpoint-validated',
        idempotencyKey: 'intent-cancel-fault',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    }), 'dependency-failed');
    assert.equal(test.coordination.portability.journal?.phase, 'target-invalidated');
    test.coordination.portability.failAdvanceTo = undefined;
    const replayed = await test.coordinator.cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedPhase: 'checkpoint-validated',
        idempotencyKey: 'intent-cancel-fault',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    assert.equal(replayed.phase, 'target-cleaned');
    const journal = test.coordination.portability.journal;
    assert.ok(journal);
    await test.coordinator.recover({ journal, lease: test.coordination.lease() });
    assert.equal(test.coordination.portability.journal.phase, 'target-cleaned');
    assert.equal((await confirmSourceReopened(
      test.coordinator,
      'intent-source-reopened-fault',
    )).phase, 'cancelled');
  });

  it('removes an already published repository without publishing during cancellation', async () => {
    const test = fixture();
    const { batch, receipt } = await publishTransfer(test);
    assert.equal(test.repository.publishCalls, 1);
    const cleaned = await test.coordinator.cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: cancellationRequest('repository-published', 'intent-cancel-published'),
    });
    assert.equal(cleaned.phase, 'target-cleaned');
    assert.equal(test.repository.publishCalls, 1);
    assert.equal(test.repository.removeCalls, 1);
    assert.equal(test.repository.planCalls >= 2, true);
    const replayedReceipt = await test.restart().acknowledgeClaimBatch({
      principalId: HOST_PRINCIPAL_ID,
      request: custodyRequest(batch.batchRevision, batch.batchSha256),
    });
    assert.deepEqual(replayedReceipt, receipt);
    assert.equal(test.repository.publishCalls, 1);
    test.expire();
    assert.deepEqual(await test.restart().acknowledgeClaimBatch({
      principalId: HOST_PRINCIPAL_ID,
      request: custodyRequest(batch.batchRevision, batch.batchSha256),
    }), receipt);
    assert.equal(test.repository.publishCalls, 1);
  });

  it('replays completed and cancelled begin requests after expiry without restaging', async () => {
    const completedTest = fixture();
    const { batch } = await publishTransfer(completedTest);
    await completedTest.coordinator.commitRelinquishment({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        idempotencyKey: 'intent-relinquish-request',
        projectId: PROJECT_ID,
        proof: relinquishmentProof(
          batch.batchRevision,
          batch.batchSha256,
          batch.checkpointSha256,
        ),
        transferId: TRANSFER_ID,
      },
    });
    const completedPrepareCalls = completedTest.staging.prepareCalls;
    completedTest.expire();
    assert.equal(
      (await completedTest.restart().begin(beginInput(completedTest))).phase,
      'completed',
    );
    assert.equal(completedTest.staging.prepareCalls, completedPrepareCalls);

    const cancelledTest = fixture();
    await beginAndValidate(cancelledTest);
    await cancelledTest.coordinator.cancel({
      principalId: HOST_PRINCIPAL_ID,
      request: cancellationRequest('checkpoint-validated', 'intent-cancel-terminal'),
    });
    await confirmSourceReopened(cancelledTest.coordinator, 'intent-source-terminal');
    const cancelledPrepareCalls = cancelledTest.staging.prepareCalls;
    cancelledTest.expire();
    assert.equal(
      (await cancelledTest.restart().begin(beginInput(cancelledTest))).phase,
      'cancelled',
    );
    assert.equal(cancelledTest.staging.prepareCalls, cancelledPrepareCalls);
  });

  it('recovers completion after checkpoint cleanup and journal failure', async () => {
    const test = fixture();
    const { batch } = await publishTransfer(test);
    test.coordination.portability.failAdvanceTo = 'completed';
    await assertCode(test.coordinator.commitRelinquishment({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        idempotencyKey: 'intent-relinquish-request',
        projectId: PROJECT_ID,
        proof: relinquishmentProof(
          batch.batchRevision,
          batch.batchSha256,
          batch.checkpointSha256,
        ),
        transferId: TRANSFER_ID,
      },
    }), 'dependency-failed');
    assert.equal(test.coordination.portability.journal?.phase, 'cloud-activated');
    test.coordination.portability.failAdvanceTo = undefined;
    test.loseCheckpoint();
    const journal = test.coordination.portability.journal;
    assert.ok(journal);
    await test.restart().recover({ journal, lease: test.coordination.lease() });
    assert.equal(test.coordination.portability.journal.phase, 'completed');
    assert.equal(test.staging.discardCalls, 2);
  });

  it('rejects a new transfer before cutover when the target Project already exists', async () => {
    const test = fixture();
    test.coordination.targetOccupied = true;
    await assertCode(test.coordinator.begin({
      expiresAt: EXPIRES_AT,
      principalId: HOST_PRINCIPAL_ID,
      request: {
        checkpointManifestSha256: test.checkpoint.manifest.manifestSha256,
        expectedSourceAuthorityGeneration: 1,
        idempotencyKey: 'intent-begin',
        projectId: PROJECT_ID,
        sourceHostMemberId: HOST_MEMBER_ID,
        sourceProof: 'source-proof',
        targetUrl: TARGET_URL,
        transferId: TRANSFER_ID,
      },
    }), 'state-conflict');
    assert.equal(test.coordination.portability.journal, undefined);
    assert.equal(test.staging.prepareCalls, 0);
  });

  it('rejects a new transfer for a tombstoned target Project', async () => {
    const test = fixture();
    test.coordination.portability.tombstoned = true;
    await assertCode(test.coordinator.begin({
      expiresAt: EXPIRES_AT,
      principalId: HOST_PRINCIPAL_ID,
      request: {
        checkpointManifestSha256: test.checkpoint.manifest.manifestSha256,
        expectedSourceAuthorityGeneration: 1,
        idempotencyKey: 'intent-begin',
        projectId: PROJECT_ID,
        sourceHostMemberId: HOST_MEMBER_ID,
        sourceProof: 'source-proof',
        targetUrl: TARGET_URL,
        transferId: TRANSFER_ID,
      },
    }), 'state-conflict');
    assert.equal(test.coordination.portability.journal, undefined);
  });

  it('drains recovery before close resolves and rejects later recovery', async () => {
    const test = fixture();
    await beginAndValidate(test);
    const batchSha256 = test.coordination.portability.journal?.batchSha256;
    assert.ok(batchSha256);
    const batch = await test.coordinator.rotateClaims({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        expectedBatchRevision: 1,
        expectedBatchSha256: batchSha256,
        idempotencyKey: 'intent-close-delivery',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    });
    await test.coordinator.acknowledgeClaimBatch({
      principalId: HOST_PRINCIPAL_ID,
      request: custodyRequest(batch.batchRevision, batch.batchSha256),
    });
    test.activation.failNext = true;
    await assertCode(test.coordinator.commitRelinquishment({
      principalId: HOST_PRINCIPAL_ID,
      request: {
        idempotencyKey: 'intent-close-relinquish',
        projectId: PROJECT_ID,
        proof: relinquishmentProof(
          batch.batchRevision,
          batch.batchSha256,
          batch.checkpointSha256,
        ),
        transferId: TRANSFER_ID,
      },
    }), 'dependency-failed');
    let release: (() => void) | undefined;
    test.activation.wait = new Promise(resolve => {
      release = resolve;
    });
    const journal = test.coordination.portability.journal;
    assert.ok(journal);
    const recovery = test.coordinator.recover({
      journal,
      lease: test.coordination.lease(),
    });
    await new Promise(resolve => setImmediate(resolve));
    const close = test.coordinator.close();
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    assert.ok(release);
    release();
    await Promise.all([recovery, close]);
    assert.equal(closed, true);
    await assertCode(test.coordinator.recover({
      journal,
      lease: test.coordination.lease(),
    }), 'closed');
  });
});
