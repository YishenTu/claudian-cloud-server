export interface PeriodicReconciliationOptions {
  readonly intervalMs: number;
  readonly onBackgroundFailure: () => void;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly schedule?: (operation: () => void, delayMs: number) => () => void;
}

/** Owns periodic execution and draining; the supplied operation owns all policy. */
export class PeriodicReconciliation {
  readonly #controller = new AbortController();
  readonly #schedule: NonNullable<PeriodicReconciliationOptions['schedule']>;
  #active: Promise<void> | undefined;
  #cancelScheduled: (() => void) | undefined;
  #started = false;

  constructor(private readonly options: PeriodicReconciliationOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new TypeError('periodic-reconciliation.interval-invalid');
    }
    this.#schedule = options.schedule ?? ((operation, delayMs) => {
      const timer = setTimeout(operation, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  }

  reconcileAll(): Promise<void> {
    return this.#beginRun(false);
  }

  start(): void {
    if (this.#started || this.#controller.signal.aborted) return;
    this.#started = true;
    this.#scheduleNext();
  }

  async close(): Promise<void> {
    this.#controller.abort('closed');
    this.#cancelScheduled?.();
    this.#cancelScheduled = undefined;
    await this.#active?.catch(() => undefined);
  }

  #beginRun(background: boolean): Promise<void> {
    if (this.#controller.signal.aborted) {
      return Promise.reject(new Error('periodic-reconciliation.closed'));
    }
    if (this.#active !== undefined) return this.#active;
    this.#cancelScheduled?.();
    this.#cancelScheduled = undefined;
    const active = Promise.resolve().then(() => this.options.run(this.#controller.signal))
      .catch((error: unknown) => {
        if (background && !this.#controller.signal.aborted) this.options.onBackgroundFailure();
        throw error;
      }).finally(() => {
        if (this.#active === active) this.#active = undefined;
        this.#scheduleNext();
      });
    this.#active = active;
    return active;
  }

  #scheduleNext(): void {
    if (!this.#started || this.#controller.signal.aborted
      || this.#active !== undefined || this.#cancelScheduled !== undefined) return;
    this.#cancelScheduled = this.#schedule(() => {
      this.#cancelScheduled = undefined;
      void this.#beginRun(true).catch(() => undefined);
    }, this.options.intervalMs);
  }
}
