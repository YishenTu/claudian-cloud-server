import type {
  CollabIsoTimestamp,
} from '@claudian-collab/protocol';

import type {
  ExpiredDevelopmentBootstrapAttemptCatalog,
} from '../../coordination/DevelopmentBootstrapPersistence.js';
import type {
  DevelopmentBootstrapSettlementPort,
} from './DevelopmentBootstrapProfile.js';

export interface DevelopmentBootstrapExpiryReconcilerOptions {
  readonly catalog: ExpiredDevelopmentBootstrapAttemptCatalog;
  readonly clock?: () => Date;
  readonly reconciliationIntervalMs?: number;
  readonly schedule?: (
    operation: () => void,
    delayMs: number,
  ) => () => void;
  readonly settlement: DevelopmentBootstrapSettlementPort;
}

const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;

function timestamp(clock: () => Date): CollabIsoTimestamp {
  const value = clock();
  if (Number.isNaN(value.valueOf())) {
    throw new TypeError('development-bootstrap-expiry.clock-invalid');
  }
  return value.toISOString();
}

export class DevelopmentBootstrapExpiryReconciler {
  readonly #catalog: ExpiredDevelopmentBootstrapAttemptCatalog;
  readonly #clock: () => Date;
  readonly #reconciliationIntervalMs: number;
  readonly #schedule: NonNullable<DevelopmentBootstrapExpiryReconcilerOptions['schedule']>;
  readonly #settlement: DevelopmentBootstrapSettlementPort;
  #active: Promise<void> | undefined;
  #cancelScheduled: (() => void) | undefined;
  #closed = false;
  #started = false;

  constructor(options: DevelopmentBootstrapExpiryReconcilerOptions) {
    this.#catalog = options.catalog;
    this.#clock = options.clock ?? (() => new Date());
    this.#reconciliationIntervalMs = options.reconciliationIntervalMs
      ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#reconciliationIntervalMs)
      || this.#reconciliationIntervalMs < 1) {
      throw new TypeError('development-bootstrap-expiry.interval-invalid');
    }
    this.#schedule = options.schedule ?? ((operation, delayMs) => {
      const timer = setTimeout(operation, delayMs);
      return () => clearTimeout(timer);
    });
    this.#settlement = options.settlement;
  }

  start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    this.#scheduleNext();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelScheduled?.();
    this.#cancelScheduled = undefined;
    await this.#active?.catch(() => undefined);
  }

  async reconcileAll(): Promise<void> {
    const expiredBefore = timestamp(this.#clock);
    let after;
    for (;;) {
      const page = await this.#catalog.listExpiredDevelopmentBootstrapAttempts({
        ...(after === undefined ? {} : { after }),
        expiredBefore,
      });
      for (const attempt of page.attempts) {
        await this.#settlement.expire({
          attemptId: attempt.attemptId,
          projectId: attempt.projectId,
        });
      }
      if (page.nextCursor === undefined) return;
      after = page.nextCursor;
    }
  }

  #scheduleNext(): void {
    if (this.#closed) return;
    this.#cancelScheduled = this.#schedule(() => {
      this.#cancelScheduled = undefined;
      if (this.#closed) return;
      const active = this.reconcileAll();
      this.#active = active;
      void active.catch(() => undefined).finally(() => {
        if (this.#active === active) this.#active = undefined;
        this.#scheduleNext();
      });
    }, this.#reconciliationIntervalMs);
  }
}
