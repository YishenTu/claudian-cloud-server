import type { RecoveryCandidateCatalog } from '../coordination/DevelopmentBootstrapPersistence.js';
import type { ProjectLifecycleRecoveryDispatcher } from '../project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';

export interface ProjectLifecycleRecoveryReconcilerOptions {
  readonly catalog: RecoveryCandidateCatalog;
  readonly intervalMs: number;
  readonly onBackgroundFailure?: () => void;
  readonly recovery: Pick<ProjectLifecycleRecoveryDispatcher, 'recoverAvailable'>;
}

/** Periodically retries locally actionable lifecycle recovery while HTTP is online. */
export class ProjectLifecycleRecoveryReconciler {
  readonly #catalog: RecoveryCandidateCatalog;
  readonly #intervalMs: number;
  readonly #onBackgroundFailure: () => void;
  readonly #recovery: ProjectLifecycleRecoveryReconcilerOptions['recovery'];
  #closed = false;
  #running: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ProjectLifecycleRecoveryReconcilerOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new TypeError('project-lifecycle-recovery-reconciler.options-invalid');
    }
    this.#catalog = options.catalog;
    this.#intervalMs = options.intervalMs;
    this.#onBackgroundFailure = options.onBackgroundFailure ?? (() => undefined);
    this.#recovery = options.recovery;
  }

  reconcileAll(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('project-lifecycle-recovery-reconciler.closed'));
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
    const running = this.#recovery.recoverAvailable(this.#catalog);
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
}
