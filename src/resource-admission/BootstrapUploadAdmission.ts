import { statfs } from 'node:fs/promises';
import { isAbsolute, normalize, parse } from 'node:path';

import { isCollabOpaqueId } from '@claudian-collab/protocol';

export type BootstrapUploadAdmissionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'invalid-attempt'
  | 'storage-unavailable';

export class BootstrapUploadAdmissionError extends Error {
  readonly code: BootstrapUploadAdmissionErrorCode;
  readonly retryable: boolean;

  constructor(code: BootstrapUploadAdmissionErrorCode) {
    super(`bootstrap-upload-admission.error.${code}`);
    this.name = 'BootstrapUploadAdmissionError';
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

export interface BootstrapUploadPermit {
  release(): void;
}

export interface AcquireBootstrapUploadOptions {
  readonly attemptId: string;
  readonly signal?: AbortSignal;
}

export interface BootstrapUploadAdmissionOptions {
  readonly maxConcurrentUploads: number;
  readonly maxUploadsPerAttempt: number;
  readonly queueMax: number;
  readonly queueTimeoutMs: number;
  readonly stagingFreeSpaceFloorBytes: number;
  readonly stagingReservationBytes: number;
  readonly stagingRoot: string;
}

export interface BootstrapUploadAdmissionDependencies {
  readonly availableBytes?: (stagingRoot: string) => Promise<bigint>;
}

interface Waiter {
  readonly attemptId: string;
  readonly reject: (error: BootstrapUploadAdmissionError) => void;
  readonly resolve: (permit: BootstrapUploadPermit) => void;
  readonly signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  settled: boolean;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

function assertOptions(options: BootstrapUploadAdmissionOptions): void {
  const positiveIntegers = [
    options.maxConcurrentUploads,
    options.maxUploadsPerAttempt,
    options.queueMax,
    options.queueTimeoutMs,
    options.stagingFreeSpaceFloorBytes,
    options.stagingReservationBytes,
  ];
  if (
    positiveIntegers.some(value => !Number.isSafeInteger(value) || value <= 0)
    || options.maxUploadsPerAttempt !== 1
    || !isAbsolute(options.stagingRoot)
    || normalize(options.stagingRoot) !== options.stagingRoot
    || parse(options.stagingRoot).root === options.stagingRoot
  ) {
    throw new TypeError('bootstrap-upload-admission.options-invalid');
  }
}

async function availableStagingBytes(stagingRoot: string): Promise<bigint> {
  const statistics = await statfs(stagingRoot, { bigint: true });
  return statistics.bavail * statistics.bsize;
}

export class BootstrapUploadAdmission {
  readonly #availableBytes: (stagingRoot: string) => Promise<bigint>;
  readonly #attemptsInFlight = new Set<string>();
  readonly #maxConcurrentUploads: number;
  readonly #queue: Waiter[] = [];
  readonly #queueMax: number;
  readonly #queueTimeoutMs: number;
  readonly #stagingFreeSpaceFloorBytes: bigint;
  readonly #stagingReservationBytes: bigint;
  readonly #stagingRoot: string;
  readonly #closePromise: Promise<void>;
  readonly #resolveClose: () => void;
  #activeUploads = 0;
  #closed = false;
  #draining = false;
  #reservedBytes = 0n;

  constructor(
    options: BootstrapUploadAdmissionOptions,
    dependencies: BootstrapUploadAdmissionDependencies = {},
  ) {
    assertOptions(options);
    this.#availableBytes = dependencies.availableBytes ?? availableStagingBytes;
    this.#maxConcurrentUploads = options.maxConcurrentUploads;
    this.#queueMax = options.queueMax;
    this.#queueTimeoutMs = options.queueTimeoutMs;
    this.#stagingFreeSpaceFloorBytes = BigInt(
      options.stagingFreeSpaceFloorBytes,
    );
    this.#stagingReservationBytes = BigInt(options.stagingReservationBytes);
    this.#stagingRoot = options.stagingRoot;

    let resolveClose!: () => void;
    this.#closePromise = new Promise(resolve => {
      resolveClose = resolve;
    });
    this.#resolveClose = resolveClose;
  }

  acquire(options: AcquireBootstrapUploadOptions): Promise<BootstrapUploadPermit> {
    if (this.#closed) {
      return Promise.reject(new BootstrapUploadAdmissionError('closed'));
    }
    if (!isCollabOpaqueId(options.attemptId)) {
      return Promise.reject(new BootstrapUploadAdmissionError('invalid-attempt'));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new BootstrapUploadAdmissionError('cancelled'));
    }
    if (
      this.#attemptsInFlight.has(options.attemptId)
      || this.#queue.length >= this.#queueMax
    ) {
      return Promise.reject(new BootstrapUploadAdmissionError('busy'));
    }

    return this.#enqueue(options);
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const waiter of [...this.#queue]) {
        this.#removeAndReject(
          waiter,
          new BootstrapUploadAdmissionError('closed'),
        );
      }
      if (this.#activeUploads === 0) this.#resolveClose();
    }
    return this.#closePromise;
  }

  #enqueue(options: AcquireBootstrapUploadOptions): Promise<BootstrapUploadPermit> {
    let resolve!: (permit: BootstrapUploadPermit) => void;
    let reject!: (error: BootstrapUploadAdmissionError) => void;
    const promise = new Promise<BootstrapUploadPermit>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const waiter: Waiter = {
      abortListener: undefined,
      attemptId: options.attemptId,
      reject,
      resolve,
      settled: false,
      signal: options.signal,
      timeout: undefined,
    };
    this.#attemptsInFlight.add(options.attemptId);
    this.#queue.push(waiter);

    waiter.timeout = setTimeout(() => {
      this.#removeAndReject(waiter, new BootstrapUploadAdmissionError('busy'));
      this.#kickDrain();
    }, this.#queueTimeoutMs);
    waiter.timeout.unref();

    if (options.signal !== undefined) {
      waiter.abortListener = () => {
        this.#removeAndReject(
          waiter,
          new BootstrapUploadAdmissionError('cancelled'),
        );
        this.#kickDrain();
      };
      options.signal.addEventListener('abort', waiter.abortListener, { once: true });
      if (options.signal.aborted) waiter.abortListener();
    }

    this.#kickDrain();
    return promise;
  }

  #kickDrain(): void {
    if (!this.#closed && !this.#draining) void this.#drainQueue();
  }

  async #drainQueue(): Promise<void> {
    if (this.#closed || this.#draining) return;
    this.#draining = true;
    try {
      while (
        !this.#isClosed()
        && this.#activeUploads < this.#maxConcurrentUploads
        && this.#queue.length > 0
      ) {
        const waiter = this.#queue[0];
        if (waiter === undefined) return;

        let availableBytes: bigint;
        try {
          availableBytes = await this.#availableBytes(this.#stagingRoot);
          if (availableBytes < 0n) throw new TypeError('invalid available bytes');
        } catch {
          this.#removeAndReject(
            waiter,
            new BootstrapUploadAdmissionError('storage-unavailable'),
          );
          continue;
        }

        if (this.#waiterNoLongerEligible(waiter)) continue;
        if (waiter.signal?.aborted === true) {
          this.#removeAndReject(
            waiter,
            new BootstrapUploadAdmissionError('cancelled'),
          );
          continue;
        }
        const requiredBytes = this.#stagingFreeSpaceFloorBytes
          + this.#reservedBytes
          + this.#stagingReservationBytes;
        if (availableBytes < requiredBytes) {
          this.#removeAndReject(
            waiter,
            new BootstrapUploadAdmissionError('busy'),
          );
          continue;
        }

        this.#removeWaiter(waiter, true);
        this.#activeUploads += 1;
        this.#reservedBytes += this.#stagingReservationBytes;
        waiter.resolve(this.#createPermit(waiter.attemptId));
      }
    } finally {
      this.#draining = false;
      if (
        !this.#isClosed()
        && this.#activeUploads < this.#maxConcurrentUploads
        && this.#queue.length > 0
      ) {
        this.#kickDrain();
      }
    }
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  #waiterNoLongerEligible(waiter: Waiter): boolean {
    return waiter.settled || this.#closed;
  }

  #createPermit(attemptId: string): BootstrapUploadPermit {
    let released = false;
    return Object.freeze({
      release: (): void => {
        if (released) return;
        released = true;
        this.#activeUploads -= 1;
        this.#reservedBytes -= this.#stagingReservationBytes;
        this.#attemptsInFlight.delete(attemptId);
        if (this.#closed) {
          if (this.#activeUploads === 0) this.#resolveClose();
        } else {
          this.#kickDrain();
        }
      },
    });
  }

  #removeAndReject(
    waiter: Waiter,
    error: BootstrapUploadAdmissionError,
  ): void {
    if (!this.#removeWaiter(waiter, false)) return;
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
    if (!retainAttempt) this.#attemptsInFlight.delete(waiter.attemptId);
    return true;
  }
}
