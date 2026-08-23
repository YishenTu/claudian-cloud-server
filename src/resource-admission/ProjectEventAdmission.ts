import {
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import { ResourceAdmissionError } from './ResourceAdmission.js';

export interface ProjectEventAdmissionOptions {
  readonly maxConnections: number;
  readonly maxConnectionsPerProject: number;
  readonly maxPendingAuthorizations?: number;
}

export interface ProjectEventPermit {
  release(): void;
}

export interface PendingProjectEventPermit {
  promote(projectId: CollabProjectId): ProjectEventPermit;
  release(): void;
}

export class ProjectEventAdmission {
  readonly #activeByProject = new Map<CollabProjectId, number>();
  readonly #maxConnections: number;
  readonly #maxConnectionsPerProject: number;
  readonly #maxPendingAuthorizations: number;
  readonly #closePromise: Promise<void>;
  readonly #resolveClose: () => void;
  #active = 0;
  #closed = false;
  #pending = 0;

  constructor(options: ProjectEventAdmissionOptions) {
    if (
      !Number.isSafeInteger(options.maxConnections)
      || options.maxConnections < 2
      || !Number.isSafeInteger(options.maxConnectionsPerProject)
      || options.maxConnectionsPerProject < 1
      || options.maxConnectionsPerProject >= options.maxConnections
      || (
        options.maxPendingAuthorizations !== undefined
        && (
          !Number.isSafeInteger(options.maxPendingAuthorizations)
          || options.maxPendingAuthorizations < 1
        )
      )
    ) {
      throw new TypeError('project-event-admission.options-invalid');
    }
    this.#maxConnections = options.maxConnections;
    this.#maxConnectionsPerProject = options.maxConnectionsPerProject;
    this.#maxPendingAuthorizations = options.maxPendingAuthorizations
      ?? options.maxConnections;
    let resolveClose!: () => void;
    this.#closePromise = new Promise(resolve => {
      resolveClose = resolve;
    });
    this.#resolveClose = resolveClose;
  }

  acquirePending(): PendingProjectEventPermit {
    if (this.#closed) throw new ResourceAdmissionError('closed');
    if (this.#pending >= this.#maxPendingAuthorizations) {
      throw new ResourceAdmissionError('busy');
    }
    this.#pending += 1;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      this.#pending -= 1;
      this.#resolveCloseIfDrained();
    };
    return Object.freeze({
      promote: (projectId: CollabProjectId): ProjectEventPermit => {
        if (settled) throw new ResourceAdmissionError('closed');
        settle();
        return this.acquire(projectId);
      },
      release: settle,
    });
  }

  acquire(projectId: CollabProjectId): ProjectEventPermit {
    if (this.#closed) throw new ResourceAdmissionError('closed');
    if (!isCollabProjectId(projectId)) {
      throw new ResourceAdmissionError('invalid-project');
    }
    const projectActive = this.#activeByProject.get(projectId) ?? 0;
    if (
      this.#active >= this.#maxConnections
      || projectActive >= this.#maxConnectionsPerProject
    ) {
      throw new ResourceAdmissionError('busy');
    }
    this.#active += 1;
    this.#activeByProject.set(projectId, projectActive + 1);
    let released = false;
    return Object.freeze({
      release: (): void => {
        if (released) return;
        released = true;
        this.#active -= 1;
        const remaining = (this.#activeByProject.get(projectId) ?? 1) - 1;
        if (remaining === 0) this.#activeByProject.delete(projectId);
        else this.#activeByProject.set(projectId, remaining);
        this.#resolveCloseIfDrained();
      },
    });
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#resolveCloseIfDrained();
    }
    return this.#closePromise;
  }

  #resolveCloseIfDrained(): void {
    if (this.#closed && this.#active === 0 && this.#pending === 0) {
      this.#resolveClose();
    }
  }
}
