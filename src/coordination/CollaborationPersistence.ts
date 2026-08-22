import type {
  CollabChangeRequest,
  CollabComment,
  CollabGitOid,
  CollabIdempotencyKey,
  CollabMemberId,
  CollabRequestId,
  CollabRequestTicketOperation,
  CollabRequestTicketRelation,
  CollabTicketAcceptedRelation,
  CollabTicketComment,
  CollabTicketCommitRelationKind,
  CollabTicketId,
  CollabTicketStatus,
  CollabTicketSummary,
} from '@claudian/collab-protocol';

export interface CollaborationKeysetCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface CollaborationPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: CollaborationKeysetCursor | undefined;
}

export interface CollaborationTicketListCursor {
  readonly ticketNumber: number;
  readonly updatedAt: string;
}

export interface CollaborationTicketDetailBase {
  readonly body: string;
  readonly ticket: CollabTicketSummary;
}

export interface CreateCollaborationRequestInput {
  readonly createdAt: string;
  readonly description: string;
  readonly firstBaseOid: CollabGitOid;
  readonly latestHeadOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly requestId: CollabRequestId;
}

export interface UpdateOpenCollaborationRequestInput {
  readonly description: string;
  readonly expectedRevision: number;
  readonly latestHeadOid: CollabGitOid;
  readonly requestId: CollabRequestId;
  readonly updatedAt: string;
}

export interface CreateCollaborationRequestCommentInput {
  readonly authorMemberId: CollabMemberId;
  readonly body: string;
  readonly commentId: string;
  readonly createdAt: string;
  readonly requestId: CollabRequestId;
}

export interface PendingCollaborationTicketRelation {
  readonly kind: CollabTicketCommitRelationKind;
  readonly relationId: string;
  readonly ticketId: CollabTicketId;
}

export interface ReplacePendingCollaborationRelationsInput {
  readonly actorMemberId: CollabMemberId;
  readonly commitOid: CollabGitOid;
  readonly relations: readonly PendingCollaborationTicketRelation[];
  readonly requestId: CollabRequestId;
  readonly updatedAt: string;
}

export interface CollaborationRequestReader {
  find(requestId: CollabRequestId): Promise<CollabChangeRequest | undefined>;
  findOpenByMember(
    memberId: CollabMemberId,
  ): Promise<CollabChangeRequest | undefined>;
  listComments(
    requestId: CollabRequestId,
    options: Readonly<{
      readonly after?: CollaborationKeysetCursor;
      readonly limit: number;
    }>,
  ): Promise<CollaborationPage<CollabComment>>;
}

export interface CollaborationRequestPersistence
  extends CollaborationRequestReader {
  create(input: CreateCollaborationRequestInput): Promise<CollabChangeRequest>;
  createComment(
    input: CreateCollaborationRequestCommentInput,
  ): Promise<Readonly<{
    readonly comment: CollabComment;
    readonly request: CollabChangeRequest;
  }>>;
  replacePendingRelations(
    input: ReplacePendingCollaborationRelationsInput,
  ): Promise<readonly CollabRequestTicketRelation[]>;
  touchOpen(requestId: CollabRequestId, updatedAt: string): Promise<boolean>;
  updateOpen(
    input: UpdateOpenCollaborationRequestInput,
  ): Promise<CollabChangeRequest | undefined>;
}

export interface CreateCollaborationTicketInput {
  readonly authorMemberId: CollabMemberId;
  readonly body: string;
  readonly createdAt: string;
  readonly ticketId: CollabTicketId;
  readonly title: string;
}

export interface UpdateCollaborationTicketInput {
  readonly body: string;
  readonly expectedRevision: number;
  readonly ticketId: CollabTicketId;
  readonly title: string;
  readonly updatedAt: string;
}

export interface CreateCollaborationTicketCommentInput {
  readonly authorMemberId: CollabMemberId;
  readonly body: string;
  readonly commentId: string;
  readonly createdAt: string;
  readonly ticketId: CollabTicketId;
}

export interface ChangeCollaborationTicketStatusInput {
  readonly actorMemberId: CollabMemberId;
  readonly expectedRevision: number;
  readonly status: CollabTicketStatus;
  readonly ticketId: CollabTicketId;
  readonly updatedAt: string;
}

export interface ReplaceCollaborationTicketMentionsInput {
  readonly createdAt: string;
  readonly mentionedMemberIds: readonly CollabMemberId[];
  readonly sourceId: string;
  readonly sourceKind: 'comment' | 'description';
  readonly ticketId: CollabTicketId;
}

export interface CollaborationTicketReader {
  find(ticketId: CollabTicketId): Promise<CollabTicketSummary | undefined>;
  findDetailBase(
    ticketId: CollabTicketId,
  ): Promise<CollaborationTicketDetailBase | undefined>;
  findByNumber(ticketNumber: number): Promise<CollabTicketSummary | undefined>;
  findByNumbers(
    ticketNumbers: readonly number[],
  ): Promise<readonly CollabTicketSummary[]>;
  hasPendingResolve(ticketId: CollabTicketId): Promise<boolean>;
  list(
    options: Readonly<{
      readonly after?: CollaborationTicketListCursor;
      readonly limit: number;
      readonly status: CollabTicketStatus | 'all';
    }>,
  ): Promise<readonly CollabTicketSummary[]>;
  listAcceptedRelations(
    ticketId: CollabTicketId,
    options: Readonly<{
      readonly after?: CollaborationKeysetCursor;
      readonly limit: number;
    }>,
  ): Promise<CollaborationPage<CollabTicketAcceptedRelation>>;
  listComments(
    ticketId: CollabTicketId,
    options: Readonly<{
      readonly after?: CollaborationKeysetCursor;
      readonly limit: number;
    }>,
  ): Promise<CollaborationPage<CollabTicketComment>>;
}

export interface CollaborationTicketPersistence
  extends CollaborationTicketReader {
  changeStatus(
    input: ChangeCollaborationTicketStatusInput,
  ): Promise<CollabTicketSummary | undefined>;
  create(input: CreateCollaborationTicketInput): Promise<CollabTicketSummary>;
  createComment(
    input: CreateCollaborationTicketCommentInput,
  ): Promise<Readonly<{
    readonly comment: CollabTicketComment;
    readonly ticket: CollabTicketSummary;
  }>>;
  replaceMentions(input: ReplaceCollaborationTicketMentionsInput): Promise<void>;
  updateContent(
    input: UpdateCollaborationTicketInput,
  ): Promise<CollabTicketSummary | undefined>;
}

export interface CollaborationIdempotencyIdentity {
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly memberId: CollabMemberId;
  readonly operation: CollabRequestTicketOperation;
  readonly requestFingerprint: string;
}

export type CollaborationIdempotencyLookup =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'replay'; readonly response: Readonly<Record<string, unknown>> };

export type CollaborationIdempotencyStoreResult =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'replay'; readonly response: Readonly<Record<string, unknown>> }
  | { readonly kind: 'stored'; readonly response: Readonly<Record<string, unknown>> };

export interface CollaborationIdempotencyReader {
  find(input: CollaborationIdempotencyIdentity): Promise<CollaborationIdempotencyLookup>;
}

export interface CollaborationIdempotencyPersistence
  extends CollaborationIdempotencyReader {
  store(
    input: CollaborationIdempotencyIdentity & Readonly<{
      readonly createdAt: string;
      readonly response: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<CollaborationIdempotencyStoreResult>;
}

export interface CollaborationSnapshot {
  readonly openRequests: readonly CollabChangeRequest[];
  readonly openTicketCount: number;
  readonly ticketHighlights: readonly CollabTicketSummary[];
}

export type CollaborationSnapshotReadResult =
  | { readonly kind: 'snapshot'; readonly snapshot: CollaborationSnapshot }
  | { readonly kind: 'too-large' };

export interface CollaborationSnapshotPersistence {
  read(): Promise<CollaborationSnapshotReadResult>;
}

export interface CollaborationReadPersistence {
  readonly idempotency: CollaborationIdempotencyReader;
  readonly requests: CollaborationRequestReader;
  readonly snapshot: CollaborationSnapshotPersistence;
  readonly tickets: CollaborationTicketReader;
}

export interface CollaborationProjectPersistence
  extends CollaborationReadPersistence {
  readonly idempotency: CollaborationIdempotencyPersistence;
  readonly requests: CollaborationRequestPersistence;
  readonly tickets: CollaborationTicketPersistence;
}
