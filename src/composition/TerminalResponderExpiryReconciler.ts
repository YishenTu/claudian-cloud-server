import type {
  TerminalResponderCatalog,
  TerminalResponderCatalogCursor,
} from '../coordination/PortabilityLifecyclePersistence.js';
import type { TerminalResponderExpiry } from '../project-authority/lifecycle/retire/TerminalResponderExpiry.js';

export interface TerminalResponderExpiryReconcilerOptions {
  readonly catalog: TerminalResponderCatalog;
  readonly clock?: () => Date;
  readonly expiry: Pick<TerminalResponderExpiry, 'expire'>;
  readonly intervalMs: number;
  readonly onBackgroundFailure?: () => void;
}

export class TerminalResponderExpiryReconciler {
  readonly #catalog: TerminalResponderCatalog;
  readonly #clock: () => Date;
  readonly #expiry: Pick<TerminalResponderExpiry, 'expire'>;
  readonly #intervalMs: number;
  readonly #onBackgroundFailure: () => void;
  #closed = false;
  #running: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TerminalResponderExpiryReconcilerOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new TypeError('terminal-responder-expiry-reconciler.options-invalid');
    }
    this.#catalog = options.catalog;
    this.#clock = options.clock ?? (() => new Date());
    this.#expiry = options.expiry;
    this.#intervalMs = options.intervalMs;
    this.#onBackgroundFailure = options.onBackgroundFailure ?? (() => undefined);
  }

  reconcileAll(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('terminal-responder-expiry-reconciler.closed'));
    }
    return this.#beginRun(false);
  }

  start(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      if (this.#running !== undefined) return;
      void this.#beginRun(true);
    }, this.#intervalMs);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      if (this.#timer !== undefined) clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#running;
  }

  #beginRun(background: boolean): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    const running = this.#runOnce();
    this.#running = running;
    void running.then(
      () => {
        if (this.#running === running) this.#running = undefined;
      },
      () => {
        if (background) this.#onBackgroundFailure();
        if (this.#running === running) this.#running = undefined;
      },
    );
    return running;
  }

  async #runOnce(): Promise<void> {
    const observed = this.#clock();
    if (Number.isNaN(observed.valueOf())) {
      throw new Error('terminal-responder-expiry-reconciler.clock-invalid');
    }
    const removedAt = observed.toISOString();
    let after: TerminalResponderCatalogCursor | undefined;
    for (;;) {
      const page = await this.#catalog.listTerminalResponders({
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });
      for (const responder of page.responders) {
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
