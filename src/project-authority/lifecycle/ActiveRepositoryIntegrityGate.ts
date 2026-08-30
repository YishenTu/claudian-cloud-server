import {
  COLLAB_MAIN_REF,
  collabMemberRef,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  ActiveRepositoryPlacementPage,
  PinnedProjectLease,
  ProjectMembershipRecord,
} from '../../coordination/ProjectCoordination.js';
import type {
  ExpectedRepositoryRef,
  RepositoryIntegrityResult,
} from '../../repositories/GitRepositoryAuthority.js';
import {
  sameRepositoryPlacement,
  type RepositoryPlacementLease,
} from '../../repositories/RepositoryPlacement.js';

export interface ActiveRepositoryIntegrityCoordination {
  acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
  listActiveRepositoryPlacements(options?: Readonly<{
    after?: CollabProjectId;
    limit?: number;
  }>): Promise<ActiveRepositoryPlacementPage>;
}

export interface ActiveRepositoryIntegrityRepository {
  cleanupReceivePackState(placement: RepositoryPlacementLease): Promise<void>;
  verifyIntegrity(
    placement: RepositoryPlacementLease,
    options: Readonly<{
      expectedRefs: readonly ExpectedRepositoryRef[];
      signal?: AbortSignal;
    }>,
  ): Promise<RepositoryIntegrityResult>;
}

export interface ActiveRepositoryIntegrityGateOptions {
  readonly cleanupReceivePackState?: boolean;
  readonly coordination: ActiveRepositoryIntegrityCoordination;
  readonly repository: ActiveRepositoryIntegrityRepository;
}

function expectedMemberRefs(
  memberships: readonly ProjectMembershipRecord[],
): readonly ExpectedRepositoryRef[] {
  const active = memberships.filter(membership => membership.status === 'active');
  if (
    active.length === 0
    || active.every(membership => membership.role !== 'manager')
  ) {
    throw new Error('active-repository-integrity.invalid-authority-state');
  }
  return active.map(membership => Object.freeze({
    name: collabMemberRef(membership.memberId),
  }));
}

export class ActiveRepositoryIntegrityGate {
  readonly #cleanupReceivePackState: boolean;
  readonly #coordination: ActiveRepositoryIntegrityCoordination;
  readonly #repository: ActiveRepositoryIntegrityRepository;

  constructor(options: ActiveRepositoryIntegrityGateOptions) {
    this.#cleanupReceivePackState = options.cleanupReceivePackState ?? true;
    this.#coordination = options.coordination;
    this.#repository = options.repository;
  }

  async verifyAll(signal?: AbortSignal): Promise<void> {
    let after: CollabProjectId | undefined;
    do {
      signal?.throwIfAborted();
      const page = await this.#coordination.listActiveRepositoryPlacements({
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });
      for (const placement of page.placements) {
        signal?.throwIfAborted();
        await this.#verifyPlacement(placement, signal);
      }
      after = page.nextCursor;
    } while (after !== undefined);
  }

  async #verifyPlacement(
    catalogPlacement: RepositoryPlacementLease,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const lease = await this.#coordination.acquireProjectLease(
      catalogPlacement.projectId,
    );
    try {
      signal?.throwIfAborted();
      const authority = await lease.withProjectScope(async scope => {
        signal?.throwIfAborted();
        const project = await scope.getProject();
        const placement = await scope.getRepositoryPlacement();
        const memberships = await scope.listMemberships();
        if (
          project?.serviceState !== 'active'
          || placement === undefined
          || !sameRepositoryPlacement(placement, catalogPlacement)
        ) {
          throw new Error('active-repository-integrity.invalid-authority-state');
        }
        return Object.freeze({
          expectedRefs: Object.freeze([{
            name: COLLAB_MAIN_REF,
            oid: project.expectedMainOid,
          }, ...expectedMemberRefs(memberships)]),
          placement,
        });
      });
      if (this.#cleanupReceivePackState) {
        await this.#repository.cleanupReceivePackState(authority.placement);
      }
      await this.#repository.verifyIntegrity(authority.placement, {
        expectedRefs: authority.expectedRefs,
        ...(signal === undefined ? {} : { signal }),
      });
    } finally {
      await lease.close();
    }
  }
}
