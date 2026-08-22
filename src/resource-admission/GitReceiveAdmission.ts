import { statfs } from 'node:fs/promises';
import { isAbsolute, normalize, parse } from 'node:path';

import {
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian/collab-protocol';

export type GitReceiveAdmissionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'input-limit'
  | 'invalid-project'
  | 'storage-unavailable';

export class GitReceiveAdmissionError extends Error {
  readonly code: GitReceiveAdmissionErrorCode;
  readonly retryable: boolean;

  constructor(code: GitReceiveAdmissionErrorCode) {
    super(`git-receive-admission.error.${code}`);
    this.name = 'GitReceiveAdmissionError';
    this.code = code;
    this.retryable = code === 'busy' || code === 'storage-unavailable';
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

export interface GitReceivePermit {
  consume(bytes: number): void;
  release(): void;
}

export interface GitReceiveAdmissionOptions {
  readonly capacityTimeoutMs: number;
  readonly freeSpaceFloorBytes: number;
  readonly maxConcurrentReceives: number;
  readonly maxConcurrentReceivesPerProject: number;
  readonly maximumRequestBytes: number;
  readonly repositoryRoot: string;
  readonly reservationBytes: number;
}

export interface GitReceiveAdmissionDependencies {
  readonly availableBytes?: (repositoryRoot: string) => Promise<bigint>;
}

function assertOptions(options: GitReceiveAdmissionOptions): void {
  const positiveIntegers = [
    options.capacityTimeoutMs,
    options.freeSpaceFloorBytes,
    options.maxConcurrentReceives,
    options.maxConcurrentReceivesPerProject,
    options.maximumRequestBytes,
    options.reservationBytes,
  ];
  if (
    positiveIntegers.some(value => !Number.isSafeInteger(value) || value <= 0)
    || options.maxConcurrentReceivesPerProject > options.maxConcurrentReceives
    || !isAbsolute(options.repositoryRoot)
    || normalize(options.repositoryRoot) !== options.repositoryRoot
    || parse(options.repositoryRoot).root === options.repositoryRoot
  ) {
    throw new TypeError('git-receive-admission.options-invalid');
  }
}

async function repositoryAvailableBytes(repositoryRoot: string): Promise<bigint> {
  const statistics = await statfs(repositoryRoot, { bigint: true });
  return statistics.bavail * statistics.bsize;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class GitReceiveAdmission {
  readonly #acquisitionControllers = new Set<AbortController>();
  readonly #activeByProject = new Map<CollabProjectId, number>();
  readonly #availableBytes: (repositoryRoot: string) => Promise<bigint>;
  readonly #capacityTimeoutMs: number;
  readonly #freeSpaceFloorBytes: bigint;
  readonly #maxConcurrentReceives: number;
  readonly #maxConcurrentReceivesPerProject: number;
  readonly #maximumRequestBytes: number;
  readonly #repositoryRoot: string;
  readonly #reservationBytes: bigint;
  readonly #closePromise: Promise<void>;
  readonly #resolveClose: () => void;
  #active = 0;
  #closed = false;
  #pending = 0;
  #reservedBytes = 0n;
  #serial = Promise.resolve();

  constructor(
    options: GitReceiveAdmissionOptions,
    dependencies: GitReceiveAdmissionDependencies = {},
  ) {
    assertOptions(options);
    this.#availableBytes = dependencies.availableBytes ?? repositoryAvailableBytes;
    this.#capacityTimeoutMs = options.capacityTimeoutMs;
    this.#freeSpaceFloorBytes = BigInt(options.freeSpaceFloorBytes);
    this.#maxConcurrentReceives = options.maxConcurrentReceives;
    this.#maxConcurrentReceivesPerProject = options.maxConcurrentReceivesPerProject;
    this.#maximumRequestBytes = options.maximumRequestBytes;
    this.#repositoryRoot = options.repositoryRoot;
    this.#reservationBytes = BigInt(options.reservationBytes);
    let resolveClose!: () => void;
    this.#closePromise = new Promise(resolve => { resolveClose = resolve; });
    this.#resolveClose = resolveClose;
  }

  async acquire(options: Readonly<{
    readonly projectId: CollabProjectId;
    readonly signal?: AbortSignal;
  }>): Promise<GitReceivePermit> {
    if (this.#closed) throw new GitReceiveAdmissionError('closed');
    if (!isCollabProjectId(options.projectId)) {
      throw new GitReceiveAdmissionError('invalid-project');
    }
    if (aborted(options.signal)) {
      throw new GitReceiveAdmissionError('cancelled');
    }
    const controller = new AbortController();
    const cancel = (): void => controller.abort(
      new GitReceiveAdmissionError('cancelled'),
    );
    options.signal?.addEventListener('abort', cancel, { once: true });
    this.#acquisitionControllers.add(controller);
    this.#pending += 1;
    const previous = this.#serial;
    let releaseSerial!: () => void;
    const serial = new Promise<void>(resolve => { releaseSerial = resolve; });
    this.#serial = previous.then(() => serial);
    try {
      await this.#raceCancellation(previous, controller.signal);
      this.#assertOpen();
      if (aborted(options.signal)) {
        throw new GitReceiveAdmissionError('cancelled');
      }
      const projectActive = this.#activeByProject.get(options.projectId) ?? 0;
      if (
        this.#active >= this.#maxConcurrentReceives
        || projectActive >= this.#maxConcurrentReceivesPerProject
      ) {
        throw new GitReceiveAdmissionError('busy');
      }
      let available: bigint;
      const capacityTimeout = setTimeout(() => {
        controller.abort(new GitReceiveAdmissionError('storage-unavailable'));
      }, this.#capacityTimeoutMs);
      capacityTimeout.unref();
      try {
        available = await this.#raceCancellation(
          this.#availableBytes(this.#repositoryRoot),
          controller.signal,
        );
        if (available < 0n) throw new TypeError('invalid available bytes');
      } catch (error: unknown) {
        if (error instanceof GitReceiveAdmissionError) throw error;
        throw new GitReceiveAdmissionError('storage-unavailable');
      } finally {
        clearTimeout(capacityTimeout);
      }
      if (aborted(options.signal)) {
        throw new GitReceiveAdmissionError('cancelled');
      }
      if (
        available < this.#freeSpaceFloorBytes
          + this.#reservedBytes
          + this.#reservationBytes
      ) {
        throw new GitReceiveAdmissionError('busy');
      }
      this.#active += 1;
      this.#activeByProject.set(options.projectId, projectActive + 1);
      this.#reservedBytes += this.#reservationBytes;
      return this.#permit(options.projectId);
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      this.#acquisitionControllers.delete(controller);
      controller.abort(new GitReceiveAdmissionError('cancelled'));
      this.#pending -= 1;
      releaseSerial();
      this.#settleClose();
    }
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const controller of this.#acquisitionControllers) {
        controller.abort(new GitReceiveAdmissionError('closed'));
      }
      this.#settleClose();
    }
    return this.#closePromise;
  }

  #permit(projectId: CollabProjectId): GitReceivePermit {
    let consumed = 0;
    let released = false;
    return Object.freeze({
      consume: (bytes: number): void => {
        if (
          released
          || !Number.isSafeInteger(bytes)
          || bytes <= 0
          || consumed > this.#maximumRequestBytes - bytes
        ) {
          throw new GitReceiveAdmissionError('input-limit');
        }
        consumed += bytes;
      },
      release: (): void => {
        if (released) return;
        released = true;
        this.#active -= 1;
        this.#reservedBytes -= this.#reservationBytes;
        const projectActive = (this.#activeByProject.get(projectId) ?? 1) - 1;
        if (projectActive === 0) this.#activeByProject.delete(projectId);
        else this.#activeByProject.set(projectId, projectActive);
        this.#settleClose();
      },
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new GitReceiveAdmissionError('closed');
  }

  async #raceCancellation<T>(
    operation: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      throw signal.reason instanceof GitReceiveAdmissionError
        ? signal.reason
        : new GitReceiveAdmissionError('cancelled');
    }
    let abortListener: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(
            signal.reason instanceof GitReceiveAdmissionError
              ? signal.reason
              : new GitReceiveAdmissionError('cancelled'),
          );
          signal.addEventListener('abort', abortListener, { once: true });
          if (signal.aborted) abortListener();
        }),
      ]);
    } finally {
      if (abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  #settleClose(): void {
    if (this.#closed && this.#active === 0 && this.#pending === 0) {
      this.#resolveClose();
    }
  }
}
