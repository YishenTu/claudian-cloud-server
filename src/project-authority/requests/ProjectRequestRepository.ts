import type {
  CollabGitOid,
  CollabMemberId,
  CollabProjectId,
  CollabReviewCondition,
} from '@claudian-collab/protocol';

import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

export type ProjectRequestRepositoryErrorCode =
  | 'cancelled'
  | 'head-not-pushed'
  | 'stale-main'
  | 'state-conflict'
  | 'unavailable';

export class ProjectRequestRepositoryError extends Error {
  readonly code: ProjectRequestRepositoryErrorCode;

  constructor(code: ProjectRequestRepositoryErrorCode) {
    super(`project-request-repository.error.${code}`);
    this.name = 'ProjectRequestRepositoryError';
    this.code = code;
  }
}

export interface ProjectRequestInspection {
  readonly currentMainOid: CollabGitOid;
  readonly reviewCondition: CollabReviewCondition;
  readonly reviewedHeadOid: CollabGitOid;
}

export interface ProjectRequestInspectionInput {
  readonly expectedMainOid: CollabGitOid;
  readonly firstBaseOid: CollabGitOid;
  readonly latestHeadOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly placement: RepositoryPlacementLease;
  readonly projectId: CollabProjectId;
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal: AbortSignal;
}

export interface ProjectRequestHeadValidationInput {
  readonly expectedMainOid: CollabGitOid;
  readonly headOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly placement: RepositoryPlacementLease;
  readonly projectId: CollabProjectId;
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal: AbortSignal;
}

export interface ProjectRequestRepository {
  inspectRequest(input: ProjectRequestInspectionInput): Promise<ProjectRequestInspection>;
  withRequestHeadValidation<T>(
    projectId: CollabProjectId,
    operation: (validateHead: (input: ProjectRequestHeadValidationInput) => Promise<void>) => Promise<T>,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<T>;
}
