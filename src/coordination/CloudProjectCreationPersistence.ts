import type {
  CollabGitOid,
  CollabIdempotencyKey,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabOperationId,
  CollabProjectId,
  CreateCloudProjectResponse,
} from '@claudian-collab/protocol';

export type CloudProjectCreationActivePhase =
  | 'prepared'
  | 'repository-publication-intent'
  | 'repository-published'
  | 'activated';

export type CloudProjectCreationPhase =
  | CloudProjectCreationActivePhase
  | 'completed';

export interface CloudProjectCreationPlacementPlan {
  readonly active: false;
  readonly generation: 1;
  readonly projectId: CollabProjectId;
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
}

export interface CloudProjectCreationCommitPlan {
  readonly authorEmail: 'cloud@claudian.invalid';
  readonly authorName: 'Claudian Cloud';
  readonly commitMessage: 'Initialize Collab project';
  readonly commitTimestampSeconds: number;
  readonly emptyTreeOid: CollabGitOid;
  readonly initialCommitOid: CollabGitOid;
  readonly mainRef: 'refs/heads/main';
  readonly objectFormat: 'sha1';
  readonly personalRef: string;
  readonly timezone: '+0000';
}

export interface PrepareCloudProjectCreationInput {
  readonly commit: CloudProjectCreationCommitPlan;
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly managerDisplayName: string;
  readonly memberId: CollabMemberId;
  readonly operationId: CollabOperationId;
  readonly placement: CloudProjectCreationPlacementPlan;
  readonly planSha256: string;
  readonly preparedAt: CollabIsoTimestamp;
  readonly principalId: string;
  readonly projectId: CollabProjectId;
  readonly projectName: string;
  readonly requestFingerprint: string;
}

export type CloudProjectCreationJournal = PrepareCloudProjectCreationInput & Readonly<{
  readonly phase: CloudProjectCreationPhase;
  readonly publicationMarkerSha256: string | undefined;
  readonly response: CreateCloudProjectResponse | undefined;
  readonly updatedAt: CollabIsoTimestamp;
}>;

export interface CloudProjectCreationPersistence {
  activate(input: Readonly<{
    readonly activatedAt: CollabIsoTimestamp;
    readonly response: CreateCloudProjectResponse;
  }>): Promise<CreateCloudProjectResponse>;
  complete(completedAt: CollabIsoTimestamp): Promise<CreateCloudProjectResponse>;
  get(): Promise<CloudProjectCreationJournal | undefined>;
  markRepositoryPublicationIntent(
    updatedAt: CollabIsoTimestamp,
  ): Promise<'advanced' | 'replayed'>;
  markRepositoryPublished(input: Readonly<{
    readonly publicationMarkerSha256: string;
    readonly updatedAt: CollabIsoTimestamp;
  }>): Promise<'advanced' | 'replayed'>;
  prepare(
    input: PrepareCloudProjectCreationInput,
  ): Promise<'conflict' | 'created' | 'replayed'>;
}

export interface CloudProjectCreationLease {
  close(): Promise<void>;
  withCreationScope<T>(
    operation: (persistence: CloudProjectCreationPersistence) => Promise<T>,
  ): Promise<T>;
}

export interface CloudProjectCreationCoordination {
  acquireCloudProjectCreationLease(
    projectId: CollabProjectId,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<CloudProjectCreationLease>;
}
