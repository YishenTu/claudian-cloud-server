import type {
  CollabGitOid,
  CollabMemberId,
  CollabProjectId,
} from '@claudian-collab/protocol';

import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

export interface ProjectMembershipRefInput {
  readonly expectedOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly placement: RepositoryPlacementLease;
  readonly projectId: CollabProjectId;
  readonly signal?: AbortSignal;
}

export interface ProjectMembershipRepositoryReservation {
  readonly projectId: CollabProjectId;
  close(): Promise<void>;
}

export interface ProjectMembershipRepository {
  reserveMembershipRefOperation(
    projectId: CollabProjectId,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<ProjectMembershipRepositoryReservation>;
  createMemberPersonalRef(
    reservation: ProjectMembershipRepositoryReservation,
    input: ProjectMembershipRefInput,
  ): Promise<'created' | 'replayed'>;
  deleteMemberPersonalRef(
    reservation: ProjectMembershipRepositoryReservation,
    input: ProjectMembershipRefInput,
  ): Promise<'deleted' | 'replayed'>;
}
