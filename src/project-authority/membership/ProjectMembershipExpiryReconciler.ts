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
  readonly reconciliationIntervalMs?: number;
  readonly schedule?: (
    operation: () => void,
    delayMs: number,
  ) => () => void;
}

const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;

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
  readonly #reconciliationIntervalMs: number;
  readonly #schedule: NonNullable<ProjectMembershipExpiryReconcilerOptions['schedule']>;
  readonly #controller = new AbortController();
  #active: Promise<void> | undefined;
  #cancelScheduled: (() => void) | undefined;
  #closed = false;
  #started = false;

  constructor(options: ProjectMembershipExpiryReconcilerOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#reconciliationIntervalMs = options.reconciliationIntervalMs
      ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.#reconciliationIntervalMs)
      || this.#reconciliationIntervalMs < 1
    ) throw new TypeError('project-membership-expiry.interval-invalid');
    this.#schedule = options.schedule ?? ((operation, delayMs) => {
      const timer = setTimeout(operation, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  }

  reconcileAll(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('project-membership-expiry.closed'));
    }
    return this.#beginRun();
  }

  start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    this.#scheduleNext();
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#controller.abort('closed');
      this.#cancelScheduled?.();
      this.#cancelScheduled = undefined;
    }
    await this.#active?.catch(() => undefined);
  }

  #beginRun(): Promise<void> {
    if (this.#active !== undefined) return this.#active;
    const active = this.#runOnce();
    this.#active = active;
    void active.finally(() => {
      if (this.#active === active) this.#active = undefined;
    }).catch(() => undefined);
    return active;
  }

  async #runOnce(): Promise<void> {
    const now = timestamp(this.#clock);
    let after: CollabProjectId | undefined;
    do {
      const page = await this.#coordination.listActiveRepositoryPlacements({
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });
      for (const placement of page.placements) {
        if (this.#controller.signal.aborted) return;
        const lease = await this.#coordination.acquireProjectLease(
          placement.projectId,
          { signal: this.#controller.signal },
        );
        try {
          await lease.withProjectScope(scope => (
            scope.membership.reconcileExpirations(now)
          ), { signal: this.#controller.signal });
        } finally {
          await lease.close();
        }
      }
      after = page.nextCursor;
    } while (after !== undefined && !this.#controller.signal.aborted);
  }

  #scheduleNext(): void {
    if (this.#closed) return;
    this.#cancelScheduled = this.#schedule(() => {
      this.#cancelScheduled = undefined;
      if (this.#closed) return;
      const active = this.#beginRun();
      void active.catch(() => undefined).finally(() => this.#scheduleNext());
    }, this.#reconciliationIntervalMs);
  }
}
