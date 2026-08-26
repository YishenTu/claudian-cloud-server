import type {
  CollabAuthorityRelinquishmentProof,
  CollabAuthorityTransferStatus,
  CollabCheckpointAuthority,
  CollabCheckpointPortableRecord,
  CollabCheckpointProtectedClaimEnvelopeRecord,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabProjectId,
  CollabTransferredMembershipClaimCustodyReceipt,
  CollabTransferredMembershipRedemptionReceipt,
} from '@claudian-collab/protocol';

import type {
  PersistenceAdvanceResult,
  PersistencePutResult,
} from './DevelopmentBootstrapPersistence.js';

export type ProjectLifecycleKind =
  | 'authority-transfer'
  | 'backup'
  | 'delete'
  | 'export'
  | 'leave'
  | 'retire';

export type ProjectLifecycleState =
  | 'active'
  | 'cancelled'
  | 'completed'
  | 'recovery-required';

export interface LanToCloudProjectActivationInput {
  readonly activatedAt: CollabIsoTimestamp;
  readonly authorityGeneration: number;
  readonly hostMemberId: CollabMemberId;
  readonly hostPrincipalId: string;
  readonly placementGeneration: number;
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
  readonly transferId: string;
}

export interface StageLanToCloudProjectInput {
  readonly authorityGeneration: number;
  readonly checkpointSha256: string;
  readonly records: readonly CollabCheckpointPortableRecord[];
  readonly stagedAt: CollabIsoTimestamp;
  readonly transferId: string;
}

export interface DiscardLanToCloudProjectStageInput {
  readonly authorityGeneration: number;
  readonly stageSha256: string | undefined;
  readonly transferId: string;
}

export interface PutProjectLifecycleJournalInput {
  readonly actorMemberId: CollabMemberId | undefined;
  readonly createdAt: CollabIsoTimestamp;
  readonly direction: 'cloud-to-lan' | 'lan-to-cloud' | undefined;
  readonly expectedAuthorityGeneration: number;
  readonly expectedPersonalRefOid?: string;
  readonly idempotencyKey: string;
  readonly kind: ProjectLifecycleKind;
  readonly operationId: string;
  readonly phase: string;
  readonly projectId: CollabProjectId;
  readonly requestFingerprint: string;
  readonly scheduledAt: CollabIsoTimestamp;
}

export interface ProjectLifecycleJournalRecord
  extends PutProjectLifecycleJournalInput {
  readonly batchRevision: number | undefined;
  readonly batchSha256: string | undefined;
  readonly checkpointSha256: string | undefined;
  readonly recoveryFromPhase: string | undefined;
  readonly resultSha256: string | undefined;
  readonly state: ProjectLifecycleState;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface AdvanceProjectLifecycleJournalInput {
  readonly batchRevision?: number;
  readonly batchSha256?: string;
  readonly checkpointSha256?: string;
  readonly expectedPhase: string;
  readonly expectedState: ProjectLifecycleState;
  readonly nextPhase: string;
  readonly nextState: ProjectLifecycleState;
  readonly operationId: string;
  readonly recoveryFromPhase?: string;
  readonly resultSha256?: string;
  readonly scheduledAt: CollabIsoTimestamp;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface TransferredMembershipClaimInput {
  readonly batchRevision: number;
  readonly checkpointSha256: string;
  readonly claimSha256: string;
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly memberId: CollabMemberId;
  readonly transferId: string;
}

export interface TransferredMembershipClaimRecord
  extends TransferredMembershipClaimInput {
  readonly operationIntentId: string | undefined;
  readonly redemptionReceiptId: string | undefined;
  readonly state: 'redeemed' | 'revoked' | 'unclaimed';
  readonly targetPrincipalId: string | undefined;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface TransferredMembershipClaimReplacement {
  readonly claimSha256: string;
  readonly expiresAt: CollabIsoTimestamp;
  readonly memberId: CollabMemberId;
}

export interface RotateTransferredMembershipClaimsInput {
  readonly checkpointSha256: string;
  readonly expectedBatchRevision: number;
  readonly expectedBatchSha256: string;
  readonly nextBatchRevision: number;
  readonly nextBatchSha256: string;
  readonly replacements: readonly TransferredMembershipClaimReplacement[];
  readonly rotatedAt: CollabIsoTimestamp;
  readonly scheduledAt: CollabIsoTimestamp;
  readonly transferId: string;
}

export interface RevokeTransferredMembershipClaimsInput {
  readonly batchRevision: number;
  readonly batchSha256: string;
  readonly checkpointSha256: string;
  readonly revokedAt: CollabIsoTimestamp;
  readonly transferId: string;
}

export interface DeleteTransferredMembershipClaimsInput {
  readonly batchRevision: number;
  readonly batchSha256: string;
  readonly checkpointSha256: string;
  readonly transferId: string;
}

export interface RedeemTransferredMembershipClaimInput {
  readonly claimSha256: string;
  readonly memberId: CollabMemberId;
  readonly operationIntentId: string;
  readonly receipt: CollabTransferredMembershipRedemptionReceipt;
  readonly targetPrincipalId: string;
  readonly transferId: string;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface TransferReceiptKeyInput {
  readonly createdAt: CollabIsoTimestamp;
  readonly publicKey: string;
  readonly receiptKeyId: string;
  readonly transferId: string;
}

export type ProtectedClaimEnvelopeInput = Readonly<
  CollabCheckpointProtectedClaimEnvelopeRecord['value'] & {
    readonly createdAt: CollabIsoTimestamp;
  }
>;

export interface ScrubProtectedClaimEnvelopeInput {
  readonly acknowledgedAt: CollabIsoTimestamp;
  readonly memberId: CollabMemberId;
  readonly receipt: CollabTransferredMembershipRedemptionReceipt;
  readonly transferId: string;
}

export interface ReplaceProtectedClaimEnvelopesInput {
  readonly expectedClaims: readonly Readonly<{
    readonly claimSha256: string;
    readonly memberId: CollabMemberId;
  }>[];
  readonly replacements: readonly ProtectedClaimEnvelopeInput[];
  readonly transferId: string;
}

export interface DeleteProtectedClaimEnvelopesInput {
  readonly checkpointSha256: string;
  readonly transferId: string;
}

export interface RenewProtectedClaimEnvelopesInput {
  readonly expiresAt: CollabIsoTimestamp;
  readonly transferId: string;
}

export type ProtectedClaimScrubResult = 'replayed' | 'scrubbed';

export interface TerminalPrincipalInput {
  readonly memberId: CollabMemberId;
  readonly principalId: string;
}

interface TerminalResponderBaseInput {
  readonly createdAt: CollabIsoTimestamp;
  readonly eligiblePrincipals: readonly TerminalPrincipalInput[];
  readonly expiresAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly responseJson: string;
  readonly responseSha256: string;
}

export type TerminalResponderInput = TerminalResponderBaseInput & (
  | Readonly<{
    readonly operationKind: 'authority-transfer';
    readonly replayAuthorization: Readonly<{
      readonly memberId: CollabMemberId;
      readonly requestSha256: string;
    }>;
  }>
  | Readonly<{
    readonly operationKind: 'retire';
    readonly replayAuthorization?: undefined;
  }>
);

export type TerminalResponderRecord = TerminalResponderInput & Readonly<{
  readonly acknowledgements: readonly Readonly<TerminalPrincipalInput & {
    acknowledgedAt: CollabIsoTimestamp;
  }>[];
}>;

export interface AcknowledgeTerminalResponderInput extends TerminalPrincipalInput {
  readonly acknowledgedAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly operationKind: 'authority-transfer' | 'retire';
}

export interface RemoveTerminalResponderInput {
  readonly expectedExpiresAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly operationKind: 'authority-transfer' | 'retire';
  readonly removedAt: CollabIsoTimestamp;
}

export interface ProjectPrincipalBindingInput {
  readonly boundAt: CollabIsoTimestamp;
  readonly memberId: CollabMemberId;
  readonly principalId: string;
}

export interface ProjectPrincipalBindingRecord extends ProjectPrincipalBindingInput {
  readonly revokedAt: CollabIsoTimestamp | undefined;
  readonly state: 'active' | 'revoked';
}

export interface RevokeProjectPrincipalBindingInput {
  readonly memberId: CollabMemberId;
  readonly principalId: string;
  readonly revokedAt: CollabIsoTimestamp;
}

export interface AuthorityTransferRecoveryInput {
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly sourceAuthority: CollabCheckpointAuthority;
  readonly sourceHostMemberId: CollabMemberId | undefined;
  readonly targetAuthority: CollabCheckpointAuthority;
  readonly targetHostMemberId: CollabMemberId | undefined;
  readonly targetUrl: string;
  readonly transferId: string;
}

export interface AuthorityTransferRecoveryEvidenceInput {
  readonly cancellationRequestSha256?: string;
  readonly expectedUpdatedAt: CollabIsoTimestamp;
  readonly inactivePublicationJson?: string;
  readonly nextExpiresAt?: CollabIsoTimestamp;
  readonly relinquishmentProof?: CollabAuthorityRelinquishmentProof;
  readonly sourceProof?: string;
  readonly sourceReopenSha256?: string;
  readonly stageSha256?: string;
  readonly targetActivationProof?: string;
  readonly targetActivationRequestSha256?: string;
  readonly targetProof?: string;
  readonly transferId: string;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface AuthorityTransferRecoveryRecord
  extends AuthorityTransferRecoveryInput {
  readonly cancellationRequestSha256: string | undefined;
  readonly inactivePublicationJson: string | undefined;
  readonly relinquishmentProof: CollabAuthorityRelinquishmentProof | undefined;
  readonly sourceProof: string | undefined;
  readonly sourceReopenSha256: string | undefined;
  readonly stageSha256: string | undefined;
  readonly targetActivationProof: string | undefined;
  readonly targetActivationRequestSha256: string | undefined;
  readonly targetProof: string | undefined;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface LeaveFormerPrincipalReplayInput {
  readonly createdAt: CollabIsoTimestamp;
  readonly expectedPersonalRefOid: string;
  readonly expiresAt: CollabIsoTimestamp;
  readonly intentId: string;
  readonly memberId: CollabMemberId;
  readonly operationId: string;
  readonly principalId: string;
  readonly requestFingerprint: string;
}

export interface LeaveFormerPrincipalReplayRecord {
  readonly completedAt: CollabIsoTimestamp | undefined;
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly expectedPersonalRefOid: string;
  readonly intentId: string;
  readonly memberId: CollabMemberId;
  readonly operationId: string;
  readonly resultSha256: string | undefined;
  readonly state: 'recovering' | 'completed';
}

export interface CompleteLeaveFormerPrincipalReplayInput
  extends Omit<LeaveFormerPrincipalReplayInput, 'createdAt' | 'expiresAt'> {
  readonly completedAt: CollabIsoTimestamp;
  readonly resultSha256: string;
}

export interface CompleteLeaveFormerPrincipalReplayRecoveryInput {
  readonly completedAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly resultSha256: string;
}

export interface SettleLeaveMembershipInput {
  readonly expectedMembershipRevision: bigint;
  readonly leftAt: CollabIsoTimestamp;
  readonly memberId: CollabMemberId;
  readonly operationId: string;
}

export type SettleLeaveMembershipResult =
  | 'last-manager'
  | 'replayed'
  | 'settled';

export interface CleanupTerminalArtifactsInput {
  readonly operationId: string;
  readonly operationKind: 'authority-transfer' | 'retire';
}

export interface RemoveProjectCoordinationContentInput {
  readonly operationId: string;
  readonly scheduledAt: CollabIsoTimestamp;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface TerminalResponderCatalogEntry {
  readonly expiresAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly operationKind: 'authority-transfer' | 'retire';
  readonly projectId: CollabProjectId;
}

export type TerminalResponderCatalogCursor = TerminalResponderCatalogEntry;

export interface TerminalResponderCatalogPage {
  readonly nextCursor: TerminalResponderCatalogCursor | undefined;
  readonly responders: readonly TerminalResponderCatalogEntry[];
}

export interface ListTerminalRespondersOptions {
  readonly after?: TerminalResponderCatalogCursor;
  readonly limit?: number;
}

export interface TerminalResponderCatalog {
  listTerminalResponders(
    options?: ListTerminalRespondersOptions,
  ): Promise<TerminalResponderCatalogPage>;
}

export interface ProjectTombstoneInput {
  readonly authorityGeneration: number;
  readonly projectId: CollabProjectId;
  readonly resultSha256: string;
  readonly retiredAt: CollabIsoTimestamp;
  readonly terminalExpiresAt: CollabIsoTimestamp;
  readonly terminalOperationId: string;
  readonly terminalOperationKind: 'authority-transfer' | 'retire';
}

export type ProjectDeletionPhase =
  | 'completed'
  | 'coordination-removed'
  | 'repository-delete-intent'
  | 'repository-removed'
  | 'tombstoned'
  | 'traffic-denied';

export interface ProjectDeletionIntentInput {
  readonly authorizationSha256: string;
  readonly authorizedMemberId: CollabMemberId;
  readonly createdAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly placementGeneration: number;
  readonly reason: 'cloud-to-lan' | 'retire';
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
  readonly terminalOperationId: string;
  readonly terminalOperationKind: 'authority-transfer' | 'retire';
}

export interface ProjectDeletionIntentRecord extends ProjectDeletionIntentInput {
  readonly phase: ProjectDeletionPhase;
  readonly resultSha256: string | undefined;
  readonly updatedAt: CollabIsoTimestamp;
}

export type ProjectBackupState = 'captured' | 'published' | 'verified';

export interface ProjectBackupCatalogInput {
  readonly authorityGeneration: number;
  readonly authorityVolumeIdentity: string;
  readonly backupId: string;
  readonly checkpointSha256: string;
  readonly coordinationSchemaVersion: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly placementGeneration: number;
  readonly serverBuild: string;
}

export interface ProjectBackupCatalogRecord extends ProjectBackupCatalogInput {
  readonly publishedAt: CollabIsoTimestamp | undefined;
  readonly state: ProjectBackupState;
  readonly verifiedAt: CollabIsoTimestamp | undefined;
}

export interface AdvanceProjectBackupCatalogInput {
  readonly backupId: string;
  readonly expectedState: ProjectBackupState;
  readonly nextState: ProjectBackupState;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface PortabilityLifecyclePersistenceReader {
  findProjectPrincipalBinding(
    principalId: string,
  ): Promise<ProjectPrincipalBindingRecord | undefined>;
  listActiveProjectPrincipalBindings(): Promise<readonly ProjectPrincipalBindingRecord[]>;
  getAuthorityTransferRecovery(
    transferId: string,
  ): Promise<AuthorityTransferRecoveryRecord | undefined>;
  getAuthorityTransferStatus(
    transferId: string,
  ): Promise<CollabAuthorityTransferStatus | undefined>;
  getBackupCatalogEntry(
    backupId: string,
  ): Promise<ProjectBackupCatalogRecord | undefined>;
  getDeletionIntent(
    operationId: string,
  ): Promise<ProjectDeletionIntentRecord | undefined>;
  getLifecycleJournal(
    operationId: string,
  ): Promise<ProjectLifecycleJournalRecord | undefined>;
  getLeaveFormerPrincipalReplay(
    operationId: string,
  ): Promise<LeaveFormerPrincipalReplayRecord | undefined>;
  getNonterminalLifecycleJournal(): Promise<
    ProjectLifecycleJournalRecord | undefined
  >;
  getProjectTombstone(): Promise<ProjectTombstoneInput | undefined>;
  getProtectedClaimEnvelope(
    transferId: string,
    memberId: CollabMemberId,
  ): Promise<ProtectedClaimEnvelopeInput | undefined>;
  getTerminalResponder(
    operationKind: 'authority-transfer' | 'retire',
    operationId: string,
  ): Promise<TerminalResponderRecord | undefined>;
  getTransferClaimBatchReceipt(
    transferId: string,
  ): Promise<CollabTransferredMembershipClaimCustodyReceipt | undefined>;
  getTransferReceiptKey(
    transferId: string,
    receiptKeyId: string,
  ): Promise<TransferReceiptKeyInput | undefined>;
  getTransferredMembershipClaim(
    transferId: string,
    memberId: CollabMemberId,
  ): Promise<TransferredMembershipClaimRecord | undefined>;
  findTransferredMembershipClaimBySha256(
    transferId: string,
    claimSha256: string,
  ): Promise<TransferredMembershipClaimRecord | undefined>;
}

export interface PortabilityLifecyclePersistence
  extends PortabilityLifecyclePersistenceReader {
  activateLanToCloudProject(
    input: LanToCloudProjectActivationInput,
  ): Promise<PersistencePutResult>;
  acknowledgeTerminalResponder(
    input: AcknowledgeTerminalResponderInput,
  ): Promise<PersistenceAdvanceResult>;
  advanceBackupCatalogEntry(
    input: AdvanceProjectBackupCatalogInput,
  ): Promise<PersistenceAdvanceResult>;
  advanceAuthorityTransferRecoveryEvidence(
    input: AuthorityTransferRecoveryEvidenceInput,
  ): Promise<PersistenceAdvanceResult>;
  advanceLifecycleJournal(
    input: AdvanceProjectLifecycleJournalInput,
  ): Promise<PersistenceAdvanceResult>;
  bindProjectPrincipal(
    input: ProjectPrincipalBindingInput,
  ): Promise<PersistencePutResult>;
  completeLeaveFormerPrincipalReplay(
    input: CompleteLeaveFormerPrincipalReplayInput,
  ): Promise<PersistenceAdvanceResult>;
  completeLeaveFormerPrincipalReplayRecovery(
    input: CompleteLeaveFormerPrincipalReplayRecoveryInput,
  ): Promise<PersistenceAdvanceResult>;
  cleanupTerminalArtifacts(
    input: CleanupTerminalArtifactsInput,
  ): Promise<PersistenceAdvanceResult>;
  deleteProtectedClaimEnvelopes(
    input: DeleteProtectedClaimEnvelopesInput,
  ): Promise<PersistenceAdvanceResult>;
  deleteTransferredMembershipClaims(
    input: DeleteTransferredMembershipClaimsInput,
  ): Promise<PersistenceAdvanceResult>;
  discardLanToCloudProjectStage(
    input: DiscardLanToCloudProjectStageInput,
  ): Promise<PersistenceAdvanceResult>;
  findLeaveFormerPrincipalReplay(
    input: Omit<LeaveFormerPrincipalReplayInput, 'createdAt' | 'expiresAt'> & {
      readonly requestedAt: CollabIsoTimestamp;
    },
  ): Promise<LeaveFormerPrincipalReplayRecord | undefined>;
  putAuthorityTransferRecovery(
    input: AuthorityTransferRecoveryInput,
  ): Promise<PersistencePutResult>;
  putBackupCatalogEntry(
    input: ProjectBackupCatalogInput,
  ): Promise<PersistencePutResult>;
  putClaimBatchReceipt(
    receipt: CollabTransferredMembershipClaimCustodyReceipt,
  ): Promise<PersistencePutResult>;
  putDeletionIntent(
    input: ProjectDeletionIntentInput,
  ): Promise<PersistencePutResult>;
  putLifecycleJournal(
    input: PutProjectLifecycleJournalInput,
  ): Promise<PersistencePutResult>;
  putLeaveFormerPrincipalReplay(
    input: LeaveFormerPrincipalReplayInput,
  ): Promise<PersistencePutResult>;
  putProjectTombstone(
    input: ProjectTombstoneInput,
  ): Promise<PersistencePutResult>;
  putProtectedClaimEnvelope(
    input: ProtectedClaimEnvelopeInput,
  ): Promise<PersistencePutResult>;
  putTerminalResponder(
    input: TerminalResponderInput,
  ): Promise<PersistencePutResult>;
  putTransferReceiptKey(
    input: TransferReceiptKeyInput,
  ): Promise<PersistencePutResult>;
  putTransferredMembershipClaim(
    input: TransferredMembershipClaimInput,
  ): Promise<PersistencePutResult>;
  removeTerminalResponder(
    input: RemoveTerminalResponderInput,
  ): Promise<PersistenceAdvanceResult>;
  removeProjectCoordinationContent(
    input: RemoveProjectCoordinationContentInput,
  ): Promise<PersistenceAdvanceResult>;
  replaceProtectedClaimEnvelopes(
    input: ReplaceProtectedClaimEnvelopesInput,
  ): Promise<PersistenceAdvanceResult>;
  renewProtectedClaimEnvelopes(
    input: RenewProtectedClaimEnvelopesInput,
  ): Promise<PersistenceAdvanceResult>;
  redeemTransferredMembershipClaim(
    input: RedeemTransferredMembershipClaimInput,
  ): Promise<CollabTransferredMembershipRedemptionReceipt>;
  revokeTransferredMembershipClaims(
    input: RevokeTransferredMembershipClaimsInput,
  ): Promise<PersistenceAdvanceResult>;
  revokeProjectPrincipal(
    input: RevokeProjectPrincipalBindingInput,
  ): Promise<PersistenceAdvanceResult>;
  rotateTransferredMembershipClaims(
    input: RotateTransferredMembershipClaimsInput,
  ): Promise<PersistenceAdvanceResult>;
  scrubProtectedClaimEnvelope(
    input: ScrubProtectedClaimEnvelopeInput,
  ): Promise<ProtectedClaimScrubResult>;
  settleLeaveMembership(
    input: SettleLeaveMembershipInput,
  ): Promise<SettleLeaveMembershipResult>;
  stageLanToCloudProject(
    input: StageLanToCloudProjectInput,
  ): Promise<PersistencePutResult>;
}
