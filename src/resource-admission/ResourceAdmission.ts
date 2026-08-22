import {
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian/collab-protocol';

export type GitOperationClassification = 'read' | 'write';

export type ResourceAdmissionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'invalid-project';

export class ResourceAdmissionError extends Error {
  readonly code: ResourceAdmissionErrorCode;
  readonly retryable: boolean;

  constructor(code: ResourceAdmissionErrorCode) {
    super(`resource-admission.error.${code}`);
    this.name = 'ResourceAdmissionError';
    this.code = code;
    this.retryable = code === 'busy';
  }

  toJSON(): Readonly<Record<string, boolean | string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
      retryable: this.retryable,
    });
  }
}

export interface GitChildPermit {
  release(): void;
}

export interface AcquireGitChildOptions {
  readonly classification: GitOperationClassification;
  readonly projectId: CollabProjectId;
  readonly signal?: AbortSignal;
}

export interface ResourceAdmissionOptions {
  readonly maxChildren: number;
  readonly maxChildrenPerProject: number;
  readonly maxQueuedReads?: number;
  readonly maxQueuedWrites?: number;
  readonly maxReadChildren?: number;
  readonly maxWriteChildren?: number;
  readonly queueMax: number;
  readonly queueMaxPerProject: number;
  readonly queueTimeoutMs: number;
}

interface ClassificationCount {
  read: number;
  write: number;
}

interface Waiter {
  readonly classification: GitOperationClassification;
  readonly projectId: CollabProjectId;
  readonly reject: (error: ResourceAdmissionError) => void;
  readonly resolve: (permit: GitChildPermit) => void;
  readonly signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  settled: boolean;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

function total(count: ClassificationCount): number {
  return count.read + count.write;
}

interface NormalizedResourceAdmissionOptions extends ResourceAdmissionOptions {
  readonly maxQueuedReads: number;
  readonly maxQueuedWrites: number;
  readonly maxReadChildren: number;
  readonly maxWriteChildren: number;
}

function normalizeOptions(
  options: ResourceAdmissionOptions,
): NormalizedResourceAdmissionOptions {
  const normalized = {
    ...options,
    maxQueuedReads: options.maxQueuedReads ?? options.queueMax - 1,
    maxQueuedWrites: options.maxQueuedWrites ?? options.queueMax - 1,
    maxReadChildren: options.maxReadChildren ?? options.maxChildren - 1,
    maxWriteChildren: options.maxWriteChildren ?? options.maxChildren - 1,
  };
  const integers = [
    normalized.maxChildren,
    normalized.maxChildrenPerProject,
    normalized.maxQueuedReads,
    normalized.maxQueuedWrites,
    normalized.maxReadChildren,
    normalized.maxWriteChildren,
    normalized.queueMax,
    normalized.queueMaxPerProject,
    normalized.queueTimeoutMs,
  ];
  if (
    integers.some(value => !Number.isSafeInteger(value) || value <= 0)
    || normalized.maxChildrenPerProject >= normalized.maxChildren
    || normalized.maxReadChildren >= normalized.maxChildren
    || normalized.maxWriteChildren >= normalized.maxChildren
    || normalized.maxQueuedReads >= normalized.queueMax
    || normalized.maxQueuedWrites >= normalized.queueMax
    || normalized.queueMaxPerProject >= normalized.queueMax
  ) {
    throw new TypeError('resource-admission.options-invalid');
  }
  return normalized;
}

export class ResourceAdmission {
  readonly #maxChildren: number;
  readonly #maxChildrenPerProject: number;
  readonly #maxQueued: ClassificationCount;
  readonly #maxActive: ClassificationCount;
  readonly #queueMax: number;
  readonly #queueMaxPerProject: number;
  readonly #queueTimeoutMs: number;
  readonly #active: ClassificationCount = { read: 0, write: 0 };
  readonly #activeByProject = new Map<CollabProjectId, ClassificationCount>();
  readonly #queuedByProject = new Map<CollabProjectId, number>();
  readonly #queued: ClassificationCount = { read: 0, write: 0 };
  readonly #queue: Waiter[] = [];
  readonly #closePromise: Promise<void>;
  readonly #resolveClose: () => void;
  #closed = false;

  constructor(options: ResourceAdmissionOptions) {
    const normalized = normalizeOptions(options);
    this.#maxChildren = normalized.maxChildren;
    this.#maxChildrenPerProject = normalized.maxChildrenPerProject;
    this.#maxQueued = {
      read: normalized.maxQueuedReads,
      write: normalized.maxQueuedWrites,
    };
    this.#maxActive = {
      read: normalized.maxReadChildren,
      write: normalized.maxWriteChildren,
    };
    this.#queueMax = normalized.queueMax;
    this.#queueMaxPerProject = normalized.queueMaxPerProject;
    this.#queueTimeoutMs = normalized.queueTimeoutMs;

    let resolveClose!: () => void;
    this.#closePromise = new Promise(resolve => {
      resolveClose = resolve;
    });
    this.#resolveClose = resolveClose;
  }

  acquireGitChild(options: AcquireGitChildOptions): Promise<GitChildPermit> {
    if (this.#closed) {
      return Promise.reject(new ResourceAdmissionError('closed'));
    }
    if (!isCollabProjectId(options.projectId)) {
      return Promise.reject(new ResourceAdmissionError('invalid-project'));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new ResourceAdmissionError('cancelled'));
    }

    if (this.#canGrant(options.projectId, options.classification)) {
      return Promise.resolve(this.#createPermit(
        options.projectId,
        options.classification,
      ));
    }

    const projectQueueCount = this.#queuedByProject.get(options.projectId) ?? 0;
    if (
      this.#queue.length >= this.#queueMax
      || this.#queued[options.classification] >= this.#maxQueued[options.classification]
      || projectQueueCount >= this.#queueMaxPerProject
    ) {
      return Promise.reject(new ResourceAdmissionError('busy'));
    }

    return this.#enqueue(options);
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const waiter of [...this.#queue]) {
        this.#removeAndReject(waiter, new ResourceAdmissionError('closed'));
      }
      if (total(this.#active) === 0) this.#resolveClose();
    }
    return this.#closePromise;
  }

  #enqueue(options: AcquireGitChildOptions): Promise<GitChildPermit> {
    let resolve!: (permit: GitChildPermit) => void;
    let reject!: (error: ResourceAdmissionError) => void;
    const promise = new Promise<GitChildPermit>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const waiter: Waiter = {
      abortListener: undefined,
      classification: options.classification,
      projectId: options.projectId,
      reject,
      resolve,
      settled: false,
      signal: options.signal,
      timeout: undefined,
    };
    this.#queue.push(waiter);
    this.#queued[options.classification] += 1;
    this.#queuedByProject.set(
      options.projectId,
      (this.#queuedByProject.get(options.projectId) ?? 0) + 1,
    );

    waiter.timeout = setTimeout(() => {
      this.#removeAndReject(waiter, new ResourceAdmissionError('busy'));
      this.#drainQueue();
    }, this.#queueTimeoutMs);
    waiter.timeout.unref();

    if (options.signal !== undefined) {
      waiter.abortListener = () => {
        this.#removeAndReject(waiter, new ResourceAdmissionError('cancelled'));
        this.#drainQueue();
      };
      options.signal.addEventListener('abort', waiter.abortListener, { once: true });
      if (options.signal.aborted) waiter.abortListener();
    }

    this.#drainQueue();
    return promise;
  }

  #canGrant(
    projectId: CollabProjectId,
    classification: GitOperationClassification,
  ): boolean {
    const projectActive = this.#activeByProject.get(projectId);
    return total(this.#active) < this.#maxChildren
      && this.#active[classification] < this.#maxActive[classification]
      && (projectActive === undefined || total(projectActive) < this.#maxChildrenPerProject);
  }

  #createPermit(
    projectId: CollabProjectId,
    classification: GitOperationClassification,
  ): GitChildPermit {
    this.#active[classification] += 1;
    const projectCount = this.#activeByProject.get(projectId)
      ?? { read: 0, write: 0 };
    projectCount[classification] += 1;
    this.#activeByProject.set(projectId, projectCount);

    let released = false;
    return Object.freeze({
      release: (): void => {
        if (released) return;
        released = true;
        this.#active[classification] -= 1;
        projectCount[classification] -= 1;
        if (total(projectCount) === 0) this.#activeByProject.delete(projectId);
        if (this.#closed) {
          if (total(this.#active) === 0) this.#resolveClose();
        } else {
          this.#drainQueue();
        }
      },
    });
  }

  #drainQueue(): void {
    if (this.#closed) return;
    while (total(this.#active) < this.#maxChildren) {
      const index = this.#queue.findIndex(waiter => (
        !waiter.settled && this.#canGrant(waiter.projectId, waiter.classification)
      ));
      if (index < 0) return;
      const waiter = this.#queue[index];
      if (waiter === undefined) return;
      this.#queue.splice(index, 1);
      this.#settleWaiter(waiter);
      if (waiter.signal?.aborted === true) {
        waiter.reject(new ResourceAdmissionError('cancelled'));
        continue;
      }
      waiter.resolve(this.#createPermit(waiter.projectId, waiter.classification));
    }
  }

  #removeAndReject(waiter: Waiter, error: ResourceAdmissionError): void {
    if (waiter.settled) return;
    const index = this.#queue.indexOf(waiter);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#settleWaiter(waiter);
    waiter.reject(error);
  }

  #settleWaiter(waiter: Waiter): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.#queued[waiter.classification] -= 1;
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
    const count = (this.#queuedByProject.get(waiter.projectId) ?? 1) - 1;
    if (count === 0) this.#queuedByProject.delete(waiter.projectId);
    else this.#queuedByProject.set(waiter.projectId, count);
  }
}
