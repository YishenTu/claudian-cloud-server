import type {
  CollabMemberId,
  CollabProjectId,
} from '@claudian-collab/protocol';

import type { DevelopmentBootstrapProjectPersistence } from './DevelopmentBootstrapPersistence.js';
import type {
  AcceptPersistence,
  AcceptPersistenceReader,
} from './AcceptPersistence.js';
import type {
  CollaborationProjectPersistence,
  CollaborationReadPersistence,
} from './CollaborationPersistence.js';
import type {
  ProjectEventPersistence,
  ProjectEventReader,
} from './ProjectEventPersistence.js';
import type {
  ProjectPersistence,
  ProjectPersistenceReader,
} from './ProjectPersistence.js';
import type { PortabilityLifecyclePersistence } from './PortabilityLifecyclePersistence.js';
import type { ProjectCheckpointPersistence } from './ProjectCheckpointPersistence.js';
import type { RepositoryPlacementLease } from '../repositories/RepositoryPlacement.js';

export interface AcquireProjectLeaseOptions {
  readonly signal?: AbortSignal;
}

export interface ProjectMembershipRecord {
  readonly displayName: string;
  readonly memberId: CollabMemberId;
  readonly revision: bigint;
  readonly role: 'manager' | 'member';
  readonly status: 'active' | 'left' | 'pending' | 'revoked';
}

export interface ProjectSnapshotMembershipRecord extends ProjectMembershipRecord {
  readonly activatedAt: string;
  readonly createdAt: string;
  readonly status: 'active';
}

export interface ProjectReadScope
  extends Pick<
    DevelopmentBootstrapProjectPersistence,
    'getNonterminalDevelopmentBootstrapAttempt'
  >,
  ProjectEventReader,
  ProjectPersistenceReader {
  readonly accept: AcceptPersistenceReader;
  readonly collaboration: CollaborationReadPersistence;
  findMembership(memberId: CollabMemberId): Promise<ProjectMembershipRecord | undefined>;
  getRepositoryPlacement(): Promise<RepositoryPlacementLease | undefined>;
  listActiveSnapshotMemberships(): Promise<readonly ProjectSnapshotMembershipRecord[]>;
}

export interface ProjectScope
  extends DevelopmentBootstrapProjectPersistence,
  ProjectEventPersistence,
  ProjectPersistence {
  readonly accept: AcceptPersistence;
  readonly collaboration: CollaborationProjectPersistence;
  readonly checkpoint: ProjectCheckpointPersistence;
  readonly portability: PortabilityLifecyclePersistence;
  findMembership(memberId: CollabMemberId): Promise<ProjectMembershipRecord | undefined>;
  getRepositoryPlacement(): Promise<RepositoryPlacementLease | undefined>;
  listMemberships(): Promise<readonly ProjectMembershipRecord[]>;
}

export interface PinnedProjectLease {
  close(): Promise<void>;
  drainDevelopmentBootstrapUploads(attemptId: string): Promise<void>;
  handoffToDevelopmentBootstrapUpload(
    attemptId: string,
  ): Promise<DevelopmentBootstrapUploadLease>;
  withProjectScope<T>(
    operation: (scope: ProjectScope) => Promise<T>,
    options?: Readonly<{
      readonly signal?: AbortSignal;
      readonly snapshot?: 'repeatable-read';
    }>,
  ): Promise<T>;
}

export interface DevelopmentBootstrapUploadLease {
  close(): Promise<void>;
}

export interface ActiveRepositoryPlacementPage {
  readonly nextCursor: CollabProjectId | undefined;
  readonly placements: readonly RepositoryPlacementLease[];
}

export interface ListActiveRepositoryPlacementsOptions {
  readonly after?: CollabProjectId;
  readonly limit?: number;
}

export interface TerminalProjectContinuityPage {
  readonly nextCursor: CollabProjectId | undefined;
  readonly projectIds: readonly CollabProjectId[];
}

export interface TerminalProjectContinuityCatalog {
  listTerminalProjectContinuity(options?: Readonly<{
    readonly after?: CollabProjectId;
    readonly limit?: number;
  }>): Promise<TerminalProjectContinuityPage>;
}
