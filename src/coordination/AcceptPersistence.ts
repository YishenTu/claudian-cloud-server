import type {
  AcceptResponse,
  CollabGitOid,
  CollabIdempotencyKey,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabOperationId,
  CollabProjectId,
  CollabRequestId,
  CollabTicketCommitRelationKind,
  CollabTicketId,
  CollabTicketRelationId,
} from '@claudian-collab/protocol';

export type AcceptJournalActivePhase =
  | 'prepared'
  | 'result-persisted'
  | 'main-updated';

export type AcceptJournalPhase =
  | AcceptJournalActivePhase
  | 'completed'
  | 'recovery-required';

export interface AcceptPlacementPlan {
  readonly generation: number;
  readonly projectId: CollabProjectId;
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
}

export interface AcceptRelationPlan {
  readonly commitOid: CollabGitOid;
  readonly kind: CollabTicketCommitRelationKind;
  readonly relationId: CollabTicketRelationId;
  readonly ticketId: CollabTicketId;
  readonly ticketRevision: number;
}

export interface AcceptMergeCommitPlan {
  readonly authorEmail: string;
  readonly authorName: string;
  readonly committerEmail: string;
  readonly committerName: string;
  readonly message: string;
  readonly parents: readonly [CollabGitOid, CollabGitOid];
  readonly timezone: '+0000';
  readonly treeOid: CollabGitOid;
}

interface AcceptPrepareCommon {
  readonly actorMemberId: CollabMemberId;
  readonly expectedHeadOid: CollabGitOid;
  readonly expectedMainOid: CollabGitOid;
  readonly expectedRequestRevision: number;
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly mainRef: 'refs/heads/main';
  readonly objectFormat: 'sha1' | 'sha256';
  readonly operationId: CollabOperationId;
  readonly personalRef: string;
  readonly placement: AcceptPlacementPlan;
  readonly preparedAt: CollabIsoTimestamp;
  readonly relations: readonly AcceptRelationPlan[];
  readonly requestFingerprint: string;
  readonly requestId: CollabRequestId;
  readonly requestMemberId: CollabMemberId;
}

export type PrepareAcceptInput = AcceptPrepareCommon & (
  | Readonly<{
    readonly commit: AcceptMergeCommitPlan;
    readonly resultKind: 'merge';
  }>
  | Readonly<{
    readonly commit?: undefined;
    readonly resultKind: 'contained';
  }>
);

export type AcceptJournalRecord = PrepareAcceptInput & Readonly<{
  readonly phase: AcceptJournalPhase;
  readonly recoveryFromPhase: AcceptJournalActivePhase | undefined;
  readonly resultOid: CollabGitOid | undefined;
  readonly updatedAt: CollabIsoTimestamp;
}>;

export interface PersistAcceptResultInput {
  readonly expectedPhase: 'prepared';
  readonly operationId: CollabOperationId;
  readonly resultOid: CollabGitOid;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface MarkAcceptMainUpdatedInput {
  readonly expectedPhase: 'result-persisted';
  readonly operationId: CollabOperationId;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface MarkAcceptRecoveryRequiredInput {
  readonly expectedPhase: AcceptJournalActivePhase;
  readonly operationId: CollabOperationId;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface CompleteAcceptInput {
  readonly completedAt: CollabIsoTimestamp;
  readonly operationId: CollabOperationId;
}

export type AcceptPrepareResult = 'created' | 'replayed';
export type AcceptAdvanceResult = 'advanced' | 'replayed';

export interface AcceptPersistenceReader {
  get(operationId: CollabOperationId): Promise<AcceptJournalRecord | undefined>;
  getNonterminal(): Promise<AcceptJournalRecord | undefined>;
}

export interface AcceptPersistence extends AcceptPersistenceReader {
  complete(input: CompleteAcceptInput): Promise<AcceptResponse>;
  markMainUpdated(input: MarkAcceptMainUpdatedInput): Promise<AcceptAdvanceResult>;
  markRecoveryRequired(
    input: MarkAcceptRecoveryRequiredInput,
  ): Promise<AcceptAdvanceResult>;
  persistResult(input: PersistAcceptResultInput): Promise<AcceptAdvanceResult>;
  prepare(input: PrepareAcceptInput): Promise<AcceptPrepareResult>;
}
