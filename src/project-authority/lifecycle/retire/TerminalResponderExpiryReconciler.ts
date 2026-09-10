import type {
  TerminalResponderCatalog,
  TerminalResponderCatalogCursor,
} from '../../../coordination/PortabilityLifecyclePersistence.js';
import type { TerminalResponderExpiry } from './TerminalResponderExpiry.js';

export interface TerminalResponderExpiryReconcilerOptions {
  readonly catalog: TerminalResponderCatalog;
  readonly clock?: () => Date;
  readonly expiry: Pick<TerminalResponderExpiry, 'expire'>;
}

export class TerminalResponderExpiryReconciler {
  readonly #catalog: TerminalResponderCatalog;
  readonly #clock: () => Date;
  readonly #expiry: Pick<TerminalResponderExpiry, 'expire'>;
  constructor(options: TerminalResponderExpiryReconcilerOptions) {
    this.#catalog = options.catalog;
    this.#clock = options.clock ?? (() => new Date());
    this.#expiry = options.expiry;
  }

  async reconcileAll(signal?: AbortSignal): Promise<void> {
    const observed = this.#clock();
    if (Number.isNaN(observed.valueOf())) {
      throw new Error('terminal-responder-expiry-reconciler.clock-invalid');
    }
    const removedAt = observed.toISOString();
    let after: TerminalResponderCatalogCursor | undefined;
    for (;;) {
      if (signal?.aborted) return;
      const page = await this.#catalog.listTerminalResponders({
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });
      for (const responder of page.responders) {
        if (signal?.aborted) return;
        if (Date.parse(responder.expiresAt) > observed.valueOf()) return;
        await this.#expiry.expire({
          operationId: responder.operationId,
          operationKind: responder.operationKind,
          projectId: responder.projectId,
          removedAt,
        });
      }
      if (page.nextCursor === undefined) return;
      after = page.nextCursor;
    }
  }
}
