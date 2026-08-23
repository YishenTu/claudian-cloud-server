import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  RecoveryCandidateCatalog,
  RecoveryCandidateKind,
} from '../../coordination/DevelopmentBootstrapPersistence.js';
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

export interface ProjectRecoveryCoordinatorOptions {
  readonly accept: ProjectRecoveryPort;
  readonly activation: ProjectRecoveryPort;
  readonly catalog: RecoveryCandidateCatalog;
}

function isIsolatedRecovery(error: unknown): boolean {
  return (
    error instanceof ProjectAcceptCoordinatorError
    && error.code === 'recovery-required'
  ) || (
    error instanceof ProjectActivationCoordinatorError
    && error.code === 'recovery-required'
  );
}

function unsupportedRecoveryKind(_kind: never): never {
  throw new ProjectRecoveryError('dependency-failed');
}

export class ProjectRecoveryCoordinator implements ProjectRecoveryPort {
  readonly #accept: ProjectRecoveryPort;
  readonly #activation: ProjectRecoveryPort;
  readonly #catalog: RecoveryCandidateCatalog;
  #closed = false;

  constructor(options: ProjectRecoveryCoordinatorOptions) {
    this.#accept = options.accept;
    this.#activation = options.activation;
    this.#catalog = options.catalog;
  }

  async recoverProject(projectId: CollabProjectId): Promise<void> {
    this.#assertOpen();
    try {
      await this.#activation.recoverProject(projectId);
      this.#assertOpen();
      await this.#accept.recoverProject(projectId);
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
          await this.#owner(candidate.kind).recoverProject(candidate.projectId);
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
    }
    return unsupportedRecoveryKind(kind);
  }
}
