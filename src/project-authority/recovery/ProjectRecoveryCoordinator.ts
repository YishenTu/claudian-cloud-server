import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  RecoveryCandidate,
  RecoveryCandidateCatalog,
  RecoveryCandidateKind,
  UnknownRecoveryCandidate,
} from '../../coordination/DevelopmentBootstrapPersistence.js';
import type {
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
} from '../../coordination/ProjectCoordination.js';
import {
  ProjectAcceptCoordinatorError,
} from '../acceptance/ProjectAcceptCoordinator.js';
import {
  ProjectRecoveryError,
  type ProjectRecoveryPort,
} from '../admission/ProjectWriteAdmission.js';
import {
  ProjectActivationCoordinatorError,
} from '../lifecycle/ProjectActivationCoordinator.js';
import type {
  ProjectLifecycleRecoveryPort,
} from '../lifecycle/ProjectLifecycleRecoveryDispatcher.js';

export interface ProjectRecoveryCoordinatorOptions {
  readonly accept: ProjectRecoveryPort;
  readonly activation: ProjectRecoveryPort;
  readonly catalog: RecoveryCandidateCatalog;
  readonly creation?: ProjectRecoveryPort;
  readonly isolation: ProjectRecoveryIsolationCoordination;
  readonly lifecycle?: ProjectLifecycleRecoveryPort;
  readonly leave?: ProjectRecoveryPort;
  readonly membership?: ProjectRecoveryPort;
  readonly removal?: ProjectRecoveryPort;
}

export interface ProjectRecoveryIsolationCoordination {
  acquireProjectLease(
    projectId: CollabProjectId,
    options?: AcquireProjectLeaseOptions,
  ): Promise<PinnedProjectLease>;
}

function isIsolatedRecovery(error: unknown): boolean {
  return (
    error instanceof ProjectAcceptCoordinatorError
    && error.code === 'recovery-required'
  ) || (
    error instanceof ProjectActivationCoordinatorError
    && error.code === 'recovery-required'
  ) || (
    error instanceof ProjectRecoveryError
    && error.code === 'recovery-required'
  );
}

function unsupportedRecoveryKind(_kind: RecoveryCandidateKind): never {
  throw new ProjectRecoveryError('dependency-failed');
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

const RECOVERY_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

export class ProjectRecoveryCoordinator implements ProjectRecoveryPort {
  readonly #accept: ProjectRecoveryPort;
  readonly #activation: ProjectRecoveryPort;
  readonly #catalog: RecoveryCandidateCatalog;
  readonly #creation: ProjectRecoveryPort | undefined;
  readonly #isolation: ProjectRecoveryIsolationCoordination;
  readonly #lifecycle: ProjectLifecycleRecoveryPort | undefined;
  readonly #leave: ProjectRecoveryPort | undefined;
  readonly #membership: ProjectRecoveryPort | undefined;
  readonly #removal: ProjectRecoveryPort | undefined;
  #closed = false;

  constructor(options: ProjectRecoveryCoordinatorOptions) {
    this.#accept = options.accept;
    this.#activation = options.activation;
    this.#catalog = options.catalog;
    this.#creation = options.creation;
    this.#isolation = options.isolation;
    this.#lifecycle = options.lifecycle;
    this.#leave = options.leave;
    this.#membership = options.membership;
    this.#removal = options.removal;
  }

  async recoverProject(projectId: CollabProjectId): Promise<void> {
    this.#assertOpen();
    try {
      await this.#creation?.recoverProject(projectId);
      this.#assertOpen();
      await this.#membership?.recoverProject(projectId);
      this.#assertOpen();
      await this.#leave?.recoverProject(projectId);
      this.#assertOpen();
      await this.#removal?.recoverProject(projectId);
      this.#assertOpen();
      await this.#activation.recoverProject(projectId);
      this.#assertOpen();
      await this.#accept.recoverProject(projectId);
      this.#assertOpen();
      await this.#lifecycle?.recoverProject(projectId);
    } catch (error: unknown) {
      if (error instanceof ProjectRecoveryError) throw error;
      if (isIsolatedRecovery(error)) {
        throw new ProjectRecoveryError('recovery-required');
      }
      throw new ProjectRecoveryError('dependency-failed');
    }
  }

  async recoverAll(): Promise<void> {
    let after;
    for (;;) {
      this.#assertOpen();
      const page = await this.#catalog.listRecoveryCandidates(
        after === undefined ? undefined : { after },
      );
      for (const candidate of page.candidates) {
        this.#assertOpen();
        try {
          await this.#recoverCandidate(candidate);
        } catch (error: unknown) {
          if (!isIsolatedRecovery(error)) throw error;
        }
      }
      if (page.nextCursor === undefined) return;
      after = page.nextCursor;
    }
  }

  close(): void {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new ProjectRecoveryError('closed');
  }

  #owner(kind: RecoveryCandidateKind): ProjectRecoveryPort {
    switch (kind) {
      case 'accept': return this.#accept;
      case 'activation': return this.#activation;
      case 'create-project': {
        if (this.#creation === undefined) return unsupportedRecoveryKind(kind);
        return this.#creation;
      }
      case 'join-project': {
        if (this.#membership === undefined) return unsupportedRecoveryKind(kind);
        return this.#membership;
      }
      case 'remove-member': {
        if (this.#removal === undefined) return unsupportedRecoveryKind(kind);
        return this.#removal;
      }
      case 'leave': {
        if (this.#leave === undefined) return unsupportedRecoveryKind(kind);
        return this.#leave;
      }
    }
    return unsupportedRecoveryKind(kind);
  }

  #recoverCandidate(candidate: RecoveryCandidate): Promise<void> {
    switch (candidate.kind) {
      case 'accept':
      case 'activation':
      case 'create-project':
      case 'join-project':
      case 'remove-member':
        return this.#owner(candidate.kind).recoverProject(candidate.projectId);
      case 'leave':
        if (this.#leave !== undefined) {
          return this.#leave.recoverProject(candidate.projectId);
        }
        if (this.#lifecycle === undefined) return unsupportedRecoveryKind(
          candidate.kind,
        );
        return this.#lifecycle.recoverCandidate(candidate);
      case 'authority-transfer':
      case 'backup':
      case 'delete':
      case 'export':
      case 'retire':
        if (this.#lifecycle === undefined) return unsupportedRecoveryKind(
          candidate.kind,
        );
        return this.#lifecycle.recoverCandidate(candidate);
      case 'unknown':
        return this.#isolateUnknownCandidate(candidate);
      default: {
        const forwardCandidate = candidate as unknown as {
          readonly kind: string;
          readonly operationId: string;
          readonly projectId: string;
          readonly scheduledAt: string;
        };
        return this.#isolateUnknownCandidate(Object.freeze({
          kind: 'unknown',
          operationId: forwardCandidate.operationId,
          projectId: forwardCandidate.projectId,
          scheduledAt: forwardCandidate.scheduledAt,
          unrecognizedKind: forwardCandidate.kind,
        }));
      }
    }
  }

  async #isolateUnknownCandidate(
    candidate: UnknownRecoveryCandidate,
  ): Promise<void> {
    if (
      !isCollabProjectId(candidate.projectId)
      || !isCollabOpaqueId(candidate.operationId)
      || !canonicalTimestamp(candidate.scheduledAt)
      || !RECOVERY_KIND_PATTERN.test(candidate.unrecognizedKind)
    ) {
      throw new ProjectRecoveryError('dependency-failed');
    }
    let lease: PinnedProjectLease;
    try {
      lease = await this.#isolation.acquireProjectLease(candidate.projectId);
    } catch {
      throw new ProjectRecoveryError('dependency-failed');
    }
    let failure: ProjectRecoveryError | undefined;
    let outcome: 'isolated' | 'stale' | undefined;
    try {
      this.#assertOpen();
      outcome = await lease.withProjectScope(async scope => {
        const result = await scope.isolateProjectRecovery({
          expectedRecoveryCandidate: {
            kind: candidate.unrecognizedKind,
            operationId: candidate.operationId,
            projectId: candidate.projectId,
            scheduledAt: candidate.scheduledAt,
          },
        });
        if (result === 'stale') return 'stale';
        const isolated = await scope.getProject();
        if (isolated?.serviceState !== 'recovery-required') {
          throw new ProjectRecoveryError('dependency-failed');
        }
        return 'isolated';
      });
    } catch (error: unknown) {
      failure = error instanceof ProjectRecoveryError
        ? error
        : new ProjectRecoveryError('dependency-failed');
    }
    try {
      await lease.close();
    } catch {
      failure = new ProjectRecoveryError('dependency-failed');
    }
    if (failure !== undefined) throw failure;
    if (outcome === 'stale') return;
    if (outcome === 'isolated') {
      throw new ProjectRecoveryError('recovery-required');
    }
    throw new ProjectRecoveryError('dependency-failed');
  }
}
