import type {
  CollabGitOid,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabOperationId,
  CollabProjectId,
  CollabRole,
  DevelopmentBootstrapActivationPhase,
  DevelopmentBootstrapAttemptState,
  DevelopmentBootstrapBundleState,
  DevelopmentBootstrapCancellationPhase,
} from '@claudian-collab/protocol';

export type PersistencePutResult = 'created' | 'replayed';
export type PersistenceAdvanceResult = 'advanced' | 'replayed';

export interface DevelopmentBootstrapAttemptInput {
  readonly attemptId: string;
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly manifestJson: string;
  readonly manifestSha256: string;
  readonly projectId: CollabProjectId;
  readonly sourceHostMemberId: CollabMemberId;
}

export interface DevelopmentBootstrapReportInput {
  readonly attemptId: string;
  readonly capturedAt: CollabIsoTimestamp;
  readonly createdAt: CollabIsoTimestamp;
  readonly reportJson: string;
  readonly reportSha256: string;
  readonly reporterMemberId: CollabMemberId;
}

export interface DevelopmentBootstrapUploadInput {
  readonly attemptId: string;
  readonly byteCount: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly sha256: string;
  readonly stagingArtifactKey: string;
  readonly validationMarkerSha256: string;
}

export interface DevelopmentBootstrapAttemptTransition {
  readonly attemptId: string;
  readonly expectedBundleState: DevelopmentBootstrapBundleState;
  readonly expectedState: DevelopmentBootstrapAttemptState;
  readonly nextBundleState: DevelopmentBootstrapBundleState;
  readonly nextState: DevelopmentBootstrapAttemptState;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface DevelopmentBootstrapActivationInput {
  readonly attemptId: string;
  readonly journalJson: string;
  readonly operationId: CollabOperationId;
  readonly scheduledAt: CollabIsoTimestamp;
}

export interface DevelopmentBootstrapCancellationInput {
  readonly attemptId: string;
  readonly expectedState: DevelopmentBootstrapAttemptState;
  readonly journalJson: string;
  readonly operationId: CollabOperationId;
  readonly scheduledAt: CollabIsoTimestamp;
}

export interface DevelopmentBootstrapActivationAdvance {
  readonly attemptId: string;
  readonly expectedPhase: DevelopmentBootstrapActivationPhase;
  readonly nextPhase: DevelopmentBootstrapActivationPhase;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface DevelopmentBootstrapActivationRecoveryRequired {
  readonly attemptId: string;
  readonly expectedPhase: DevelopmentBootstrapActivationPhase;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface DevelopmentBootstrapCancellationAdvance {
  readonly attemptId: string;
  readonly expectedPhase: DevelopmentBootstrapCancellationPhase;
  readonly nextPhase: DevelopmentBootstrapCancellationPhase;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface DevelopmentBootstrapMemberActivation {
  readonly activatedAt: CollabIsoTimestamp;
  readonly createdAt: CollabIsoTimestamp;
  readonly displayName: string;
  readonly memberId: CollabMemberId;
  readonly role: CollabRole;
}

export interface DevelopmentBootstrapProjectActivation {
  readonly activatedAt: CollabIsoTimestamp;
  readonly attemptId: string;
  readonly expectedMainOid: CollabGitOid;
  readonly managerSetGeneration: number;
  readonly members: readonly [
    DevelopmentBootstrapMemberActivation,
    DevelopmentBootstrapMemberActivation,
  ];
  readonly projectCreatedAt: CollabIsoTimestamp;
  readonly projectName: string;
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
}

export interface DevelopmentBootstrapReportRecord {
  readonly capturedAt: CollabIsoTimestamp;
  readonly createdAt: CollabIsoTimestamp;
  readonly reportJson: string;
  readonly reportSha256: string;
  readonly reporterMemberId: CollabMemberId;
}

export interface DevelopmentBootstrapUploadRecord {
  readonly byteCount: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly sha256: string;
  readonly stagingArtifactKey: string;
  readonly state: 'uploaded' | 'validated';
  readonly updatedAt: CollabIsoTimestamp;
  readonly validationMarkerSha256: string;
}

export type DevelopmentBootstrapSettlementRecord = Readonly<{
  attemptId: string;
  journalJson: string;
  operationId: CollabOperationId;
  updatedAt: CollabIsoTimestamp;
} & (
  | {
    activationPhase: DevelopmentBootstrapActivationPhase;
    kind: 'activation';
  }
  | {
    cancellationPhase: DevelopmentBootstrapCancellationPhase;
    kind: 'cancellation';
  }
)>;

export interface DevelopmentBootstrapAttemptRecord {
  readonly attemptId: string;
  readonly bundleState: DevelopmentBootstrapBundleState;
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly manifestJson: string;
  readonly manifestSha256: string;
  readonly projectId: CollabProjectId;
  readonly reports: readonly DevelopmentBootstrapReportRecord[];
  readonly settlement: DevelopmentBootstrapSettlementRecord | undefined;
  readonly sourceHostMemberId: CollabMemberId;
  readonly state: DevelopmentBootstrapAttemptState;
  readonly updatedAt: CollabIsoTimestamp;
  readonly upload: DevelopmentBootstrapUploadRecord | undefined;
}

export interface DevelopmentBootstrapProjectPersistence {
  advanceDevelopmentBootstrapActivation(
    input: DevelopmentBootstrapActivationAdvance,
  ): Promise<PersistenceAdvanceResult>;
  advanceDevelopmentBootstrapCancellation(
    input: DevelopmentBootstrapCancellationAdvance,
  ): Promise<PersistenceAdvanceResult>;
  beginDevelopmentBootstrapActivation(
    input: DevelopmentBootstrapActivationInput,
  ): Promise<PersistencePutResult>;
  beginDevelopmentBootstrapCancellation(
    input: DevelopmentBootstrapCancellationInput,
  ): Promise<PersistencePutResult>;
  getDevelopmentBootstrapAttempt(
    attemptId: string,
  ): Promise<DevelopmentBootstrapAttemptRecord | undefined>;
  getDevelopmentBootstrapRecoveryAttempt(
    operationId: CollabOperationId,
  ): Promise<DevelopmentBootstrapAttemptRecord | undefined>;
  getActiveDevelopmentBootstrapAttempt(): Promise<
    DevelopmentBootstrapAttemptRecord | undefined
  >;
  getNonterminalDevelopmentBootstrapAttempt(): Promise<
    DevelopmentBootstrapAttemptRecord | undefined
  >;
  insertActivatedDevelopmentProject(
    input: DevelopmentBootstrapProjectActivation,
  ): Promise<PersistencePutResult>;
  markDevelopmentBootstrapActivationRecoveryRequired(
    input: DevelopmentBootstrapActivationRecoveryRequired,
  ): Promise<PersistenceAdvanceResult>;
  putDevelopmentBootstrapAttempt(
    input: DevelopmentBootstrapAttemptInput,
  ): Promise<PersistencePutResult>;
  putDevelopmentBootstrapReport(
    input: DevelopmentBootstrapReportInput,
  ): Promise<PersistencePutResult>;
  putDevelopmentBootstrapUpload(
    input: DevelopmentBootstrapUploadInput,
  ): Promise<PersistencePutResult>;
  transitionDevelopmentBootstrapAttempt(
    input: DevelopmentBootstrapAttemptTransition,
  ): Promise<PersistenceAdvanceResult>;
}

export interface DevelopmentBootstrapAttemptLocator {
  findDevelopmentBootstrapProject(
    attemptId: string,
  ): Promise<CollabProjectId | undefined>;
}

export interface ExpiredDevelopmentBootstrapAttempt {
  readonly attemptId: string;
  readonly expiresAt: CollabIsoTimestamp;
  readonly projectId: CollabProjectId;
}

export type ExpiredDevelopmentBootstrapAttemptCursor =
  ExpiredDevelopmentBootstrapAttempt;

export interface ExpiredDevelopmentBootstrapAttemptPage {
  readonly attempts: readonly ExpiredDevelopmentBootstrapAttempt[];
  readonly nextCursor: ExpiredDevelopmentBootstrapAttemptCursor | undefined;
}

export interface ListExpiredDevelopmentBootstrapAttemptsOptions {
  readonly after?: ExpiredDevelopmentBootstrapAttemptCursor;
  readonly expiredBefore: CollabIsoTimestamp;
  readonly limit?: number;
}

export interface ExpiredDevelopmentBootstrapAttemptCatalog {
  listExpiredDevelopmentBootstrapAttempts(
    options: ListExpiredDevelopmentBootstrapAttemptsOptions,
  ): Promise<ExpiredDevelopmentBootstrapAttemptPage>;
}

export type RecoveryCandidateKind =
  | 'accept'
  | 'activation'
  | 'authority-transfer'
  | 'backup'
  | 'delete'
  | 'export'
  | 'leave'
  | 'retire';

export interface KnownRecoveryCandidate {
  readonly kind: RecoveryCandidateKind;
  readonly operationId: CollabOperationId;
  readonly projectId: CollabProjectId;
  readonly scheduledAt: CollabIsoTimestamp;
}

export interface UnknownRecoveryCandidate {
  readonly kind: 'unknown';
  readonly operationId: CollabOperationId;
  readonly projectId: CollabProjectId;
  readonly scheduledAt: CollabIsoTimestamp;
  readonly unrecognizedKind: string;
}

export type RecoveryCandidate = KnownRecoveryCandidate | UnknownRecoveryCandidate;

export interface RecoveryCandidateCursor {
  readonly kind: string;
  readonly operationId: CollabOperationId;
  readonly projectId: CollabProjectId;
  readonly scheduledAt: CollabIsoTimestamp;
}

export interface RecoveryCandidatePage {
  readonly candidates: readonly RecoveryCandidate[];
  readonly nextCursor: RecoveryCandidateCursor | undefined;
}

export interface ListRecoveryCandidatesOptions {
  readonly after?: RecoveryCandidateCursor;
  readonly limit?: number;
}

export interface RecoveryCandidateCatalog {
  listRecoveryCandidates(
    options?: ListRecoveryCandidatesOptions,
  ): Promise<RecoveryCandidatePage>;
}
