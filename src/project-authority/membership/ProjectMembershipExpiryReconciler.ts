import type {
  CollabIsoTimestamp,
  CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  ProjectMembershipExpiryPersistence,
} from '../../coordination/ProjectMembershipPersistence.js';

interface MembershipExpiryLease {
  close(): Promise<void>;
  withProjectScope<Result>(
    operation: (scope: Readonly<{
      readonly membership: ProjectMembershipExpiryPersistence;
    }>) => Promise<Result>,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<Result>;
}

export interface ProjectMembershipExpiryReconcilerOptions {
  readonly clock?: () => Date;
  readonly coordination: Readonly<{
    acquireProjectLease(
      projectId: CollabProjectId,
      options?: Readonly<{ readonly signal?: AbortSignal }>,
    ): Promise<MembershipExpiryLease>;
    listActiveRepositoryPlacements(options?: Readonly<{
      readonly after?: CollabProjectId;
      readonly limit?: number;
    }>): Promise<Readonly<{
      readonly nextCursor: CollabProjectId | undefined;
      readonly placements: readonly Readonly<{
        readonly projectId: CollabProjectId;
      }>[];
    }>>;
  }>;
}

function timestamp(clock: () => Date): CollabIsoTimestamp {
  const value = clock();
  if (Number.isNaN(value.valueOf())) {
    throw new TypeError('project-membership-expiry.clock-invalid');
  }
  return value.toISOString();
}

export class ProjectMembershipExpiryReconciler {
  readonly #clock: () => Date;
  readonly #coordination: ProjectMembershipExpiryReconcilerOptions['coordination'];
  constructor(options: ProjectMembershipExpiryReconcilerOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
  }

  async reconcileAll(signal?: AbortSignal): Promise<void> {
    const now = timestamp(this.#clock);
    let after: CollabProjectId | undefined;
    do {
      const page = await this.#coordination.listActiveRepositoryPlacements({
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });
      for (const placement of page.placements) {
        if (signal?.aborted) return;
        const lease = await this.#coordination.acquireProjectLease(
          placement.projectId,
          signal === undefined ? {} : { signal },
        );
        try {
          await lease.withProjectScope(scope => (
            scope.membership.reconcileExpirations(now)
          ), signal === undefined ? {} : { signal });
        } finally {
          await lease.close();
        }
      }
      after = page.nextCursor;
    } while (after !== undefined && !signal?.aborted);
  }

}
