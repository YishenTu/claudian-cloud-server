import type {
  CollabMemberId,
  CollabProjectId,
} from '@claudian/collab-protocol';

import type { DevelopmentBootstrapProjectPersistence } from './DevelopmentBootstrapPersistence.js';
import type { ProjectPersistence } from './ProjectPersistence.js';
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

export interface ProjectScope
  extends DevelopmentBootstrapProjectPersistence, ProjectPersistence {
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
  withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>): Promise<T>;
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
