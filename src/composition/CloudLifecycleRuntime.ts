import type { ProjectLifecycleRecoveryPort } from '../project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import type { CloudLifecycleControl } from '../server/control/ProjectLifecycleRoutes.js';
import type { AuthorityTransferArtifactAuthority } from '../server/transfer/AuthorityTransferArtifactRoutes.js';
import type { TerminalResponderExpiryReconciler } from './TerminalResponderExpiryReconciler.js';

/**
 * A complete lifecycle runtime is the composition gate for both lifecycle
 * capabilities. Partial owners must not be adapted to this interface.
 */
export interface CloudLifecycleRuntime {
  readonly artifacts: AuthorityTransferArtifactAuthority;
  readonly control: CloudLifecycleControl;
  readonly recovery: ProjectLifecycleRecoveryPort;
  close(): Promise<void>;
  reconcileAll(): Promise<void>;
  start(): void;
}

export interface CloudLifecycleCloseOwner {
  close(): Promise<void> | void;
}

export interface ComposedCloudLifecycleRuntimeOptions {
  readonly artifacts: AuthorityTransferArtifactAuthority;
  readonly closeOrder: readonly CloudLifecycleCloseOwner[];
  readonly control: CloudLifecycleControl;
  readonly expiry: Pick<
    TerminalResponderExpiryReconciler,
    'close' | 'reconcileAll' | 'start'
  >;
  readonly recovery: ProjectLifecycleRecoveryPort & CloudLifecycleCloseOwner;
}

export class ComposedCloudLifecycleRuntime implements CloudLifecycleRuntime {
  readonly artifacts: AuthorityTransferArtifactAuthority;
  readonly control: CloudLifecycleControl;
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

  reconcileAll(): Promise<void> {
    return this.#expiry.reconcileAll();
  }

  start(): void {
    this.#expiry.start();
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    let failed = false;
    for (const owner of [
      this.#expiry,
      this.#recoveryOwner,
      ...this.#closeOrder,
    ]) {
      try {
        await owner.close();
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('cloud-lifecycle-runtime.close-failed');
  }
}
