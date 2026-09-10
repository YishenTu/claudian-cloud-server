import type { ProjectLifecycleRecoveryPort } from '../project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import type { CloudLifecycleControl } from '../server/control/ProjectLifecycleRoutes.js';
import type { AuthorityTransferArtifactAuthority } from '../server/transfer/AuthorityTransferArtifactRoutes.js';
import type { PeriodicReconciliation } from './PeriodicReconciliation.js';

/**
 * A complete lifecycle runtime is the composition gate for both lifecycle
 * capabilities. Partial owners must not be adapted to this interface.
 */
export interface CloudLifecycleRuntime {
  readonly artifacts: AuthorityTransferArtifactAuthority;
  readonly control: CompleteCloudLifecycleControl;
  readonly recovery: ProjectLifecycleRecoveryPort;
  close(timeoutMs: number): Promise<void>;
  reconcileAll(): Promise<void>;
  start(): void;
}

export type CompleteCloudLifecycleControl = CloudLifecycleControl & Required<
  Pick<CloudLifecycleControl, 'getRetirementTerminal'>
>;

export interface CloudLifecycleCloseOwner {
  close(): Promise<void> | void;
}

export interface ComposedCloudLifecycleRuntimeOptions {
  readonly artifacts: AuthorityTransferArtifactAuthority;
  readonly closeOrder: readonly CloudLifecycleCloseOwner[];
  readonly control: CompleteCloudLifecycleControl;
  readonly expiry: Pick<
    PeriodicReconciliation,
    'close' | 'reconcileAll' | 'start'
  >;
  readonly recovery: ProjectLifecycleRecoveryPort & CloudLifecycleCloseOwner;
}

export class ComposedCloudLifecycleRuntime implements CloudLifecycleRuntime {
  readonly artifacts: AuthorityTransferArtifactAuthority;
  readonly control: CompleteCloudLifecycleControl;
  readonly recovery: ProjectLifecycleRecoveryPort;
  readonly #closeOrder: readonly CloudLifecycleCloseOwner[];
  readonly #expiry: ComposedCloudLifecycleRuntimeOptions['expiry'];
  readonly #recoveryOwner: ComposedCloudLifecycleRuntimeOptions['recovery'];
  #closePromise: Promise<void> | undefined;

  constructor(options: ComposedCloudLifecycleRuntimeOptions) {
    this.artifacts = options.artifacts;
    this.control = options.control;
    this.recovery = options.recovery;
    this.#closeOrder = Object.freeze([...options.closeOrder]);
    this.#expiry = options.expiry;
    this.#recoveryOwner = options.recovery;
  }

  async reconcileAll(): Promise<void> {
    await this.#expiry.reconcileAll();
  }

  start(): void {
    this.#expiry.start();
  }

  close(timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new TypeError('cloud-lifecycle-runtime.timeout-invalid'));
    }
    this.#closePromise ??= this.#close(timeoutMs);
    return this.#closePromise;
  }

  async #close(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let failed = false;
    for (const owner of [
      this.#expiry,
      this.#recoveryOwner,
      ...this.#closeOrder,
    ]) {
      if (!await closeOwnerBefore(owner, deadline)) failed = true;
    }
    if (failed) throw new Error('cloud-lifecycle-runtime.close-failed');
  }
}

async function closeOwnerBefore(
  owner: CloudLifecycleCloseOwner,
  deadline: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(() => owner.close());
  try {
    return await Promise.race([
      operation.then(() => true, () => false),
      new Promise<false>(resolve => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), false);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
