import {
  COLLAB_MAIN_REF,
  collabMemberRef,
  type CollabProjectId,
} from '@claudian/collab-protocol';

import type {
  ActiveRepositoryPlacementPage,
  PinnedProjectLease,
  ProjectMembershipRecord,
} from '../../coordination/ProjectCoordination.js';
import type {
  ExpectedRepositoryRef,
  RepositoryIntegrityResult,
} from '../../repositories/GitRepositoryAuthority.js';
import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

export interface ActiveRepositoryIntegrityCoordination {
  acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
  listActiveRepositoryPlacements(options?: Readonly<{
    after?: CollabProjectId;
    limit?: number;
  }>): Promise<ActiveRepositoryPlacementPage>;
}

export interface ActiveRepositoryIntegrityRepository {
  verifyIntegrity(
    placement: RepositoryPlacementLease,
    options: Readonly<{ expectedRefs: readonly ExpectedRepositoryRef[] }>,
  ): Promise<RepositoryIntegrityResult>;
}

export interface ActiveRepositoryIntegrityGateOptions {
  readonly coordination: ActiveRepositoryIntegrityCoordination;
  readonly repository: ActiveRepositoryIntegrityRepository;
}

function samePlacement(
  left: RepositoryPlacementLease,
  right: RepositoryPlacementLease,
): boolean {
  return left.generation === right.generation
    && left.projectId === right.projectId
    && left.repositoryStorageKey === right.repositoryStorageKey
    && left.storageNodeId === right.storageNodeId;
}

function expectedMemberRefs(
  memberships: readonly ProjectMembershipRecord[],
): readonly ExpectedRepositoryRef[] {
  if (
    memberships.length !== 2
    || memberships.some(membership => membership.status !== 'active')
    || memberships.every(membership => membership.role !== 'manager')
  ) {
    throw new Error('active-repository-integrity.invalid-authority-state');
  }
  return memberships.map(membership => Object.freeze({
    name: collabMemberRef(membership.memberId),
  }));
}

export class ActiveRepositoryIntegrityGate {
  readonly #coordination: ActiveRepositoryIntegrityCoordination;
  readonly #repository: ActiveRepositoryIntegrityRepository;

  constructor(options: ActiveRepositoryIntegrityGateOptions) {
    this.#coordination = options.coordination;
    this.#repository = options.repository;
  }

  async verifyAll(): Promise<void> {
    let after: CollabProjectId | undefined;
    do {
      const page = await this.#coordination.listActiveRepositoryPlacements({
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });
      for (const placement of page.placements) {
        await this.#verifyPlacement(placement);
      }
      after = page.nextCursor;
    } while (after !== undefined);
  }

  async #verifyPlacement(catalogPlacement: RepositoryPlacementLease): Promise<void> {
    const lease = await this.#coordination.acquireProjectLease(
      catalogPlacement.projectId,
    );
    try {
      const authority = await lease.withProjectScope(async scope => {
        const project = await scope.getProject();
        const placement = await scope.getRepositoryPlacement();
        const memberships = await scope.listMemberships();
        if (
          project?.serviceState !== 'active'
          || placement === undefined
          || !samePlacement(placement, catalogPlacement)
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
      await this.#repository.verifyIntegrity(authority.placement, {
        expectedRefs: authority.expectedRefs,
      });
    } finally {
      await lease.close();
    }
  }
}
