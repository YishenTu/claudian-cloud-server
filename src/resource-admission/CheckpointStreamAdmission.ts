import { statfs } from 'node:fs/promises';
import { isAbsolute, normalize, parse } from 'node:path';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabCloudAuthorityTransferArtifact,
  type CollabProjectId,
} from '@claudian-collab/protocol';

export type CheckpointStreamDirection = 'download' | 'upload';

export type CheckpointStreamAdmissionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'input-limit'
  | 'invalid-request'
  | 'storage-unavailable';

export class CheckpointStreamAdmissionError extends Error {
  readonly code: CheckpointStreamAdmissionErrorCode;
  readonly retryable: boolean;

  constructor(code: CheckpointStreamAdmissionErrorCode) {
    super(`checkpoint-stream-admission.error.${code}`);
    this.name = 'CheckpointStreamAdmissionError';
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

export interface CheckpointStreamPermit {
  consume(bytes: number): void;
  release(): void;
}

export interface CheckpointStagingReservation {
  release(): void;
}

export interface ReserveCheckpointStagingOptions {
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly signal?: AbortSignal;
}

export interface AcquireCheckpointStreamOptions {
  readonly artifact: CollabCloudAuthorityTransferArtifact;
  readonly direction: CheckpointStreamDirection;
  readonly expectedByteCount: number;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly signal?: AbortSignal;
}

export interface CheckpointStreamAdmissionOptions {
  readonly capacityTimeoutMs: number;
  readonly freeSpaceFloorBytes: number;
  readonly maxConcurrentStreams: number;
  readonly maxConcurrentStreamsPerProject: number;
  readonly maxStagingAttempts: number;
  readonly maxStagingAttemptsPerProject: number;
  readonly maximumCoordinationBytes?: number;
  readonly maximumManifestBytes?: number;
  readonly maximumRepositoryBundleBytes?: number;
  readonly queueMax: number;
  readonly queueMaxPerProject: number;
  readonly queueTimeoutMs: number;
  readonly stagingReservationBytes: number;
  readonly stagingRoot: string;
}

export interface CheckpointStreamAdmissionDependencies {
  readonly availableBytes?: (stagingRoot: string) => Promise<bigint>;
}

interface ArtifactLimits {
  readonly 'checkpoint.json': number;
  readonly 'coordination.ndjson': number;
  readonly 'repository.bundle': number;
}

interface NormalizedOptions extends CheckpointStreamAdmissionOptions {
  readonly maximumCoordinationBytes: number;
  readonly maximumManifestBytes: number;
  readonly maximumRepositoryBundleBytes: number;
}

interface Waiter {
  readonly artifact: CollabCloudAuthorityTransferArtifact;
  readonly controller: AbortController;
  readonly direction: CheckpointStreamDirection;
  readonly expectedByteCount: number;
  readonly key: string;
  readonly projectId: CollabProjectId;
  readonly reject: (error: CheckpointStreamAdmissionError) => void;
  readonly resolve: (permit: CheckpointStreamPermit) => void;
  readonly signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  settled: boolean;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

interface AttemptReservationRecord {
  readonly projectId: CollabProjectId;
  releaseRequested: boolean;
}

function fail(code: CheckpointStreamAdmissionErrorCode): never {
  throw new CheckpointStreamAdmissionError(code);
}

function operationKey(projectId: string, operationId: string): string {
  return `${projectId}\0${operationId}`;
}

function isArtifact(value: unknown): value is CollabCloudAuthorityTransferArtifact {
  return typeof value === 'string'
    && COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.some(artifact => artifact === value);
}

function isDirection(value: unknown): value is CheckpointStreamDirection {
  return value === 'download' || value === 'upload';
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeOptions(
  options: CheckpointStreamAdmissionOptions,
): NormalizedOptions {
  const normalized = {
    ...options,
    maximumCoordinationBytes: options.maximumCoordinationBytes
      ?? COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
    maximumManifestBytes: options.maximumManifestBytes
      ?? COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
    maximumRepositoryBundleBytes: options.maximumRepositoryBundleBytes
      ?? COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
  };
  const integers = [
    normalized.capacityTimeoutMs,
    normalized.freeSpaceFloorBytes,
    normalized.maxConcurrentStreams,
    normalized.maxConcurrentStreamsPerProject,
    normalized.maxStagingAttempts,
    normalized.maxStagingAttemptsPerProject,
    normalized.maximumCoordinationBytes,
    normalized.maximumManifestBytes,
    normalized.maximumRepositoryBundleBytes,
    normalized.queueMax,
    normalized.queueMaxPerProject,
    normalized.queueTimeoutMs,
    normalized.stagingReservationBytes,
  ];
  const maximumAttemptBytes =
    normalized.maximumCoordinationBytes
    + normalized.maximumManifestBytes
    + normalized.maximumRepositoryBundleBytes;
  if (
    integers.some(value => !positiveInteger(value))
    || normalized.maxConcurrentStreamsPerProject
      >= normalized.maxConcurrentStreams
    || normalized.maxStagingAttemptsPerProject
      >= normalized.maxStagingAttempts
    || normalized.queueMaxPerProject >= normalized.queueMax
    || normalized.maximumCoordinationBytes
      > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes
    || normalized.maximumManifestBytes
      > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes
    || normalized.maximumRepositoryBundleBytes
      > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes
    || normalized.stagingReservationBytes < maximumAttemptBytes
    || normalized.stagingReservationBytes
      > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes
    || !isAbsolute(normalized.stagingRoot)
    || normalize(normalized.stagingRoot) !== normalized.stagingRoot
    || parse(normalized.stagingRoot).root === normalized.stagingRoot
  ) {
    throw new TypeError('checkpoint-stream-admission.options-invalid');
  }
  return normalized;
}

async function availableStagingBytes(stagingRoot: string): Promise<bigint> {
  const statistics = await statfs(stagingRoot, { bigint: true });
  return statistics.bavail * statistics.bsize;
}

export class CheckpointStreamAdmission {
  readonly #activeByProject = new Map<CollabProjectId, number>();
  readonly #attemptReservationClaims = new Set<string>();
  readonly #attemptReservationControllers = new Set<AbortController>();
  readonly #attemptReservationCountByProject = new Map<CollabProjectId, number>();
  readonly #attemptReservations = new Map<string, AttemptReservationRecord>();
  readonly #artifactLimits: ArtifactLimits;
  readonly #attemptsInFlight = new Set<string>();
  readonly #availableBytes: (stagingRoot: string) => Promise<bigint>;
  readonly #capacityTimeoutMs: number;
  readonly #closePromise: Promise<void>;
  readonly #freeSpaceFloorBytes: bigint;
  readonly #maxConcurrentStreams: number;
  readonly #maxConcurrentStreamsPerProject: number;
  readonly #maxStagingAttempts: number;
  readonly #maxStagingAttemptsPerProject: number;
  readonly #queue: Waiter[] = [];
  readonly #queueMax: number;
  readonly #queueMaxPerProject: number;
  readonly #queuedByProject = new Map<CollabProjectId, number>();
  readonly #queueTimeoutMs: number;
  readonly #resolveClose: () => void;
  readonly #stagingReservationBytes: bigint;
  readonly #stagingRoot: string;
  #active = 0;
  #closed = false;
  #draining = false;
  #reservedBytes = 0n;

  constructor(
    options: CheckpointStreamAdmissionOptions,
    dependencies: CheckpointStreamAdmissionDependencies = {},
  ) {
    const normalized = normalizeOptions(options);
    this.#artifactLimits = {
      'checkpoint.json': normalized.maximumManifestBytes,
      'coordination.ndjson': normalized.maximumCoordinationBytes,
      'repository.bundle': normalized.maximumRepositoryBundleBytes,
    };
    this.#availableBytes = dependencies.availableBytes ?? availableStagingBytes;
    this.#capacityTimeoutMs = normalized.capacityTimeoutMs;
    this.#freeSpaceFloorBytes = BigInt(normalized.freeSpaceFloorBytes);
    this.#maxConcurrentStreams = normalized.maxConcurrentStreams;
    this.#maxConcurrentStreamsPerProject =
      normalized.maxConcurrentStreamsPerProject;
    this.#maxStagingAttempts = normalized.maxStagingAttempts;
    this.#maxStagingAttemptsPerProject =
      normalized.maxStagingAttemptsPerProject;
    this.#queueMax = normalized.queueMax;
    this.#queueMaxPerProject = normalized.queueMaxPerProject;
    this.#queueTimeoutMs = normalized.queueTimeoutMs;
    this.#stagingReservationBytes = BigInt(
      normalized.stagingReservationBytes,
    );
    this.#stagingRoot = normalized.stagingRoot;
    let resolveClose!: () => void;
    this.#closePromise = new Promise(resolve => {
      resolveClose = resolve;
    });
    this.#resolveClose = resolveClose;
  }

  reserveAttempt(
    options: ReserveCheckpointStagingOptions,
  ): Promise<CheckpointStagingReservation> {
    if (this.#closed) {
      return Promise.reject(new CheckpointStreamAdmissionError('closed'));
    }
    let snapshot: ReserveCheckpointStagingOptions;
    try {
      const operationId = options.operationId;
      const projectId = options.projectId;
      const signal = options.signal;
      if (
        !isCollabProjectId(projectId)
        || !isCollabOpaqueId(operationId)
      ) {
        fail('invalid-request');
      }
      snapshot = Object.freeze({
        operationId,
        projectId,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof CheckpointStreamAdmissionError
          ? error
          : new CheckpointStreamAdmissionError('invalid-request'),
      );
    }
    if (snapshot.signal?.aborted === true) {
      return Promise.reject(new CheckpointStreamAdmissionError('cancelled'));
    }
    const key = operationKey(snapshot.projectId, snapshot.operationId);
    const projectReservations = this.#attemptReservationCountByProject.get(
      snapshot.projectId,
    ) ?? 0;
    if (
      this.#attemptReservationClaims.has(key)
      || this.#attemptReservationClaims.size >= this.#maxStagingAttempts
      || projectReservations >= this.#maxStagingAttemptsPerProject
    ) {
      return Promise.reject(new CheckpointStreamAdmissionError('busy'));
    }
    this.#attemptReservationClaims.add(key);
    this.#attemptReservationCountByProject.set(
      snapshot.projectId,
      projectReservations + 1,
    );
    return this.#reserveAttempt(snapshot, key);
  }

  async #reserveAttempt(
    options: ReserveCheckpointStagingOptions,
    key: string,
  ): Promise<CheckpointStagingReservation> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(
      new CheckpointStreamAdmissionError('cancelled'),
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
    this.#attemptReservationControllers.add(controller);
    let retained = false;
    let capacityTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      capacityTimeout = setTimeout(() => {
        controller.abort(
          new CheckpointStreamAdmissionError('storage-unavailable'),
        );
      }, this.#capacityTimeoutMs);
      capacityTimeout.unref();
      let availableBytes: bigint;
      try {
        availableBytes = await this.#raceCancellation(
          this.#availableBytes(this.#stagingRoot),
          controller.signal,
        );
        if (availableBytes < 0n) {
          throw new TypeError('invalid available bytes');
        }
      } catch (error: unknown) {
        throw error instanceof CheckpointStreamAdmissionError
          ? error
          : new CheckpointStreamAdmissionError('storage-unavailable');
      }
      if (this.#closed) fail('closed');
      if (
        availableBytes < this.#freeSpaceFloorBytes
          + this.#reservedBytes
          + this.#stagingReservationBytes
      ) {
        fail('busy');
      }
      const record: AttemptReservationRecord = {
        projectId: options.projectId,
        releaseRequested: false,
      };
      this.#attemptReservations.set(key, record);
      this.#reservedBytes += this.#stagingReservationBytes;
      retained = true;
      let released = false;
      return Object.freeze({
        release: (): void => {
          if (released) return;
          released = true;
          record.releaseRequested = true;
          if (!this.#attemptsInFlight.has(key)) {
            this.#finalizeAttemptReservation(key, record);
          }
        },
      });
    } finally {
      if (capacityTimeout !== undefined) clearTimeout(capacityTimeout);
      options.signal?.removeEventListener('abort', onAbort);
      this.#attemptReservationControllers.delete(controller);
      if (!retained) {
        this.#removeAttemptReservationClaim(key, options.projectId);
      }
      this.#settleClose();
    }
  }

  acquire(
    options: AcquireCheckpointStreamOptions,
  ): Promise<CheckpointStreamPermit> {
    if (this.#closed) {
      return Promise.reject(new CheckpointStreamAdmissionError('closed'));
    }
    try {
      const signal = options.signal;
      const snapshot = Object.freeze({
        artifact: options.artifact,
        direction: options.direction,
        expectedByteCount: options.expectedByteCount,
        operationId: options.operationId,
        projectId: options.projectId,
        ...(signal === undefined ? {} : { signal }),
      });
      if (
        !isCollabProjectId(snapshot.projectId)
        || !isCollabOpaqueId(snapshot.operationId)
        || !isArtifact(snapshot.artifact)
        || !isDirection(snapshot.direction)
        || !positiveInteger(snapshot.expectedByteCount)
        || snapshot.expectedByteCount
          > this.#artifactLimits[snapshot.artifact]
      ) {
        fail('invalid-request');
      }
      if (snapshot.signal?.aborted === true) fail('cancelled');
      const key = operationKey(snapshot.projectId, snapshot.operationId);
      const reservation = this.#attemptReservations.get(key);
      const projectQueued = this.#queuedByProject.get(snapshot.projectId) ?? 0;
      if (
        reservation === undefined
        || reservation.releaseRequested
        || this.#attemptsInFlight.has(key)
        || this.#queue.length >= this.#queueMax
        || projectQueued >= this.#queueMaxPerProject
      ) {
        fail('busy');
      }
      return this.#enqueue(snapshot, key);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof CheckpointStreamAdmissionError
          ? error
          : new CheckpointStreamAdmissionError('invalid-request'),
      );
    }
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const controller of this.#attemptReservationControllers) {
        controller.abort(new CheckpointStreamAdmissionError('closed'));
      }
      for (const waiter of [...this.#queue]) {
        this.#removeAndReject(
          waiter,
          new CheckpointStreamAdmissionError('closed'),
        );
      }
      this.#settleClose();
    }
    return this.#closePromise;
  }

  #enqueue(
    options: AcquireCheckpointStreamOptions,
    key: string,
  ): Promise<CheckpointStreamPermit> {
    let resolve!: (permit: CheckpointStreamPermit) => void;
    let reject!: (error: CheckpointStreamAdmissionError) => void;
    const promise = new Promise<CheckpointStreamPermit>((resolve_, reject_) => {
      resolve = resolve_;
      reject = reject_;
    });
    const waiter: Waiter = {
      abortListener: undefined,
      artifact: options.artifact,
      controller: new AbortController(),
      direction: options.direction,
      expectedByteCount: options.expectedByteCount,
      key,
      projectId: options.projectId,
      reject,
      resolve,
      settled: false,
      signal: options.signal,
      timeout: undefined,
    };
    this.#attemptsInFlight.add(key);
    this.#queue.push(waiter);
    this.#queuedByProject.set(
      waiter.projectId,
      (this.#queuedByProject.get(waiter.projectId) ?? 0) + 1,
    );
    waiter.timeout = setTimeout(() => {
      this.#removeAndReject(
        waiter,
        new CheckpointStreamAdmissionError('busy'),
      );
      this.#kickDrain();
    }, this.#queueTimeoutMs);
    waiter.timeout.unref();
    if (waiter.signal !== undefined) {
      waiter.abortListener = () => {
        this.#removeAndReject(
          waiter,
          new CheckpointStreamAdmissionError('cancelled'),
        );
        this.#kickDrain();
      };
      waiter.signal.addEventListener('abort', waiter.abortListener, {
        once: true,
      });
      if (waiter.signal.aborted) waiter.abortListener();
    }
    this.#kickDrain();
    return promise;
  }

  #kickDrain(): void {
    if (!this.#closed && !this.#draining) this.#drainQueue();
  }

  #drainQueue(): void {
    if (this.#closed || this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#isClosed() && this.#active < this.#maxConcurrentStreams) {
        const index = this.#queue.findIndex(waiter => (
          !waiter.settled
          && (this.#activeByProject.get(waiter.projectId) ?? 0)
            < this.#maxConcurrentStreamsPerProject
        ));
        if (index < 0) return;
        const waiter = this.#queue[index];
        if (waiter === undefined) return;
        if (waiter.settled) continue;
        this.#removeWaiter(waiter, true);
        this.#active += 1;
        const projectActive = this.#activeByProject.get(waiter.projectId) ?? 0;
        this.#activeByProject.set(waiter.projectId, projectActive + 1);
        waiter.resolve(this.#createPermit(waiter));
      }
    } finally {
      this.#draining = false;
      this.#settleClose();
      if (
        !this.#isClosed()
        && this.#active < this.#maxConcurrentStreams
        && this.#queue.some(waiter => (
          !waiter.settled
          && (this.#activeByProject.get(waiter.projectId) ?? 0)
            < this.#maxConcurrentStreamsPerProject
        ))
      ) {
        this.#kickDrain();
      }
    }
  }

  #createPermit(waiter: Waiter): CheckpointStreamPermit {
    let consumed = 0;
    let released = false;
    return Object.freeze({
      consume: (bytes: number): void => {
        if (
          released
          || !positiveInteger(bytes)
          || consumed > waiter.expectedByteCount - bytes
        ) {
          fail('input-limit');
        }
        consumed += bytes;
      },
      release: (): void => {
        if (released) return;
        released = true;
        this.#active -= 1;
        const projectActive =
          (this.#activeByProject.get(waiter.projectId) ?? 1) - 1;
        if (projectActive === 0) this.#activeByProject.delete(waiter.projectId);
        else this.#activeByProject.set(waiter.projectId, projectActive);
        this.#attemptsInFlight.delete(waiter.key);
        const reservation = this.#attemptReservations.get(waiter.key);
        if (reservation?.releaseRequested === true) {
          this.#finalizeAttemptReservation(waiter.key, reservation);
        }
        this.#settleClose();
        this.#kickDrain();
      },
    });
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  #removeAndReject(
    waiter: Waiter,
    error: CheckpointStreamAdmissionError,
  ): void {
    if (!this.#removeWaiter(waiter, false)) return;
    waiter.controller.abort(error);
    waiter.reject(error);
  }

  #removeWaiter(waiter: Waiter, retainAttempt: boolean): boolean {
    if (waiter.settled) return false;
    const index = this.#queue.indexOf(waiter);
    if (index < 0) return false;
    this.#queue.splice(index, 1);
    waiter.settled = true;
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
    const projectQueued =
      (this.#queuedByProject.get(waiter.projectId) ?? 1) - 1;
    if (projectQueued === 0) this.#queuedByProject.delete(waiter.projectId);
    else this.#queuedByProject.set(waiter.projectId, projectQueued);
    if (!retainAttempt) {
      this.#attemptsInFlight.delete(waiter.key);
      const reservation = this.#attemptReservations.get(waiter.key);
      if (reservation?.releaseRequested === true) {
        this.#finalizeAttemptReservation(waiter.key, reservation);
      }
    }
    return true;
  }

  #finalizeAttemptReservation(
    key: string,
    record: AttemptReservationRecord,
  ): void {
    if (this.#attemptReservations.get(key) !== record) return;
    this.#attemptReservations.delete(key);
    this.#reservedBytes -= this.#stagingReservationBytes;
    this.#removeAttemptReservationClaim(key, record.projectId);
    this.#settleClose();
  }

  #removeAttemptReservationClaim(
    key: string,
    projectId: CollabProjectId,
  ): void {
    if (!this.#attemptReservationClaims.delete(key)) return;
    const projectReservations =
      (this.#attemptReservationCountByProject.get(projectId) ?? 1) - 1;
    if (projectReservations === 0) {
      this.#attemptReservationCountByProject.delete(projectId);
    } else {
      this.#attemptReservationCountByProject.set(
        projectId,
        projectReservations,
      );
    }
  }

  async #raceCancellation<Result>(
    operation: Promise<Result>,
    signal: AbortSignal,
  ): Promise<Result> {
    if (signal.aborted) {
      throw signal.reason instanceof CheckpointStreamAdmissionError
        ? signal.reason
        : new CheckpointStreamAdmissionError('cancelled');
    }
    let abortListener: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(
            signal.reason instanceof CheckpointStreamAdmissionError
              ? signal.reason
              : new CheckpointStreamAdmissionError('cancelled'),
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
    if (
      this.#closed
      && this.#active === 0
      && this.#queue.length === 0
      && this.#attemptReservations.size === 0
      && this.#attemptReservationControllers.size === 0
      && !this.#draining
    ) {
      this.#resolveClose();
    }
  }
}
