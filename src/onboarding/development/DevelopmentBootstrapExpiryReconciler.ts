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
  readonly settlement: DevelopmentBootstrapSettlementPort;
}

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
  readonly #settlement: DevelopmentBootstrapSettlementPort;

  constructor(options: DevelopmentBootstrapExpiryReconcilerOptions) {
    this.#catalog = options.catalog;
    this.#clock = options.clock ?? (() => new Date());
    this.#settlement = options.settlement;
  }

  async reconcileAll(signal?: AbortSignal): Promise<void> {
    const expiredBefore = timestamp(this.#clock);
    let after;
    for (;;) {
      if (signal?.aborted) return;
      const page = await this.#catalog.listExpiredDevelopmentBootstrapAttempts({
        ...(after === undefined ? {} : { after }),
        expiredBefore,
      });
      for (const attempt of page.attempts) {
        if (signal?.aborted) return;
        await this.#settlement.expire({
          attemptId: attempt.attemptId,
          projectId: attempt.projectId,
        });
      }
      if (page.nextCursor === undefined) return;
      after = page.nextCursor;
    }
  }

}
