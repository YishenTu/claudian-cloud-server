export class OperationDrainClosedError extends Error {
  constructor() {
    super('operation-drain.closed');
    this.name = 'OperationDrainClosedError';
  }
}

export class OperationDrain {
  readonly #controllers = new Set<AbortController>();
  readonly #running = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  run<T>(
    options: Readonly<{ readonly signal?: AbortSignal }>,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new OperationDrainClosedError());
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) controller.abort();
    this.#controllers.add(controller);
    const running = Promise.resolve().then(() => operation(controller.signal));
    const tracked = running.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    void tracked.finally(() => {
      options.signal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      this.#running.delete(tracked);
    });
    return running;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort();
      this.#closePromise = Promise.allSettled([...this.#running]).then(() => undefined);
    }
    return this.#closePromise;
  }
}
