import type {
  CollabGitOid,
  CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  PrepareAcceptInput,
} from '../../coordination/AcceptPersistence.js';
import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

export type ProjectAcceptRepositoryErrorCode =
  | 'cancelled'
  | 'conflicting'
  | 'invalid-plan'
  | 'stale-head'
  | 'stale-main'
  | 'stale-relation'
  | 'state-conflict'
  | 'unsupported-tree'
  | 'unavailable';

export class ProjectAcceptRepositoryError extends Error {
  readonly code: ProjectAcceptRepositoryErrorCode;

  constructor(code: ProjectAcceptRepositoryErrorCode) {
    super(`project-accept-repository.error.${code}`);
    this.name = 'ProjectAcceptRepositoryError';
    this.code = code;
  }
}

export interface InspectProjectAcceptInput {
  readonly expectedHeadOid: CollabGitOid;
  readonly expectedMainOid: CollabGitOid;
  readonly personalRef: string;
  readonly placement: RepositoryPlacementLease;
  readonly projectId: CollabProjectId;
  readonly relationCommitOids: readonly CollabGitOid[];
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal: AbortSignal;
}

export type ProjectAcceptInspection =
  | Readonly<{
    readonly kind: 'contained';
    readonly objectFormat: 'sha1' | 'sha256';
  }>
  | Readonly<{
    readonly kind: 'merge';
    readonly objectFormat: 'sha1' | 'sha256';
    readonly treeOid: CollabGitOid;
  }>;

export type ProjectAcceptResultPlan = PrepareAcceptInput & Readonly<{
  readonly resultOid?: CollabGitOid | undefined;
}>;

export type ProjectAcceptMainPlan = PrepareAcceptInput & Readonly<{
  readonly resultOid: CollabGitOid;
}>;

export interface ProjectAcceptRepositoryReservation {
  readonly projectId: CollabProjectId;
  close(): Promise<void>;
}

export interface ProjectAcceptRepository {
  inspectAccept(
    reservation: ProjectAcceptRepositoryReservation,
    input: InspectProjectAcceptInput,
  ): Promise<ProjectAcceptInspection>;
  materializeAcceptResult(
    reservation: ProjectAcceptRepositoryReservation,
    plan: ProjectAcceptResultPlan,
  ): Promise<CollabGitOid>;
  reserveAccept(
    projectId: CollabProjectId,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<ProjectAcceptRepositoryReservation>;
  settleAcceptMain(
    reservation: ProjectAcceptRepositoryReservation,
    plan: ProjectAcceptMainPlan,
  ): Promise<'advanced' | 'replayed'>;
}
