import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { TextDecoder } from 'node:util';
import { getHeapStatistics } from 'node:v8';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CHECKPOINT_PROFILES,
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
  CollabError,
  decodeCollabProjectCheckpointCoordinationNdjson,
  decodeCollabProjectCheckpointManifest,
  encodeCollabProjectCheckpointManifestCanonicalJson,
  encodeCollabProjectCheckpointManifestDigestInput,
  isCollabOpaqueId,
  isCollabProjectId,
  validateCollabProjectCheckpointConsistency,
  type CollabCheckpointAuthority,
  type CollabCheckpointBackupRecord,
  type CollabCheckpointProfile,
  type CollabCloudAuthorityTransferArtifact,
  type CollabProjectCheckpointManifest,
} from '@claudian-collab/protocol';

import {
  ProductionCheckpointStagingError,
  type PreparedProductionCheckpointAttempt,
  type ProductionCheckpointStagingPort,
  type StagedProductionCheckpointArtifact,
} from '../../onboarding/production/ProductionCheckpointStaging.js';
import {
  GitBundleImportError,
  type RepositoryCheckpointStagingPort,
  type ValidatedRepositoryCheckpoint,
} from '../../repositories/GitBundleImporter.js';

export type ProjectCheckpointCoordinatorErrorCode =
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'invalid-checkpoint'
  | 'resource-limit'
  | 'storage-unavailable'
  | 'timeout';

export class ProjectCheckpointCoordinatorError extends Error {
  readonly code: ProjectCheckpointCoordinatorErrorCode;
  readonly retryable: boolean;

  constructor(code: ProjectCheckpointCoordinatorErrorCode) {
    super(`project-checkpoint-coordinator.error.${code}`);
    this.name = 'ProjectCheckpointCoordinatorError';
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

export interface ValidateStagedProjectCheckpointInput {
  readonly attempt: PreparedProductionCheckpointAttempt;
  readonly expectedProfile: CollabCheckpointProfile;
  readonly expectedSourceAuthority: CollabCheckpointAuthority;
  readonly expectedTargetAuthority: CollabCheckpointAuthority | null;
  readonly signal?: AbortSignal;
}

export interface ValidatedProjectCheckpoint {
  readonly attempt: PreparedProductionCheckpointAttempt;
  readonly manifest: CollabProjectCheckpointManifest;
  readonly records: readonly CollabCheckpointBackupRecord[];
  readonly repository: ValidatedRepositoryCheckpoint;
}

export interface ProjectCheckpointCoordinatorOptions {
  readonly maximumConcurrentCoordinationValidations?: number;
  readonly maximumCoordinationBytes?: number;
  readonly repository: RepositoryCheckpointStagingPort;
  readonly staging: Pick<
    ProductionCheckpointStagingPort,
    'discardAttempt' | 'inspectAttempt' | 'readArtifact'
  >;
}

interface ValidationInputSnapshot {
  readonly attempt: PreparedProductionCheckpointAttempt;
  readonly expectedProfile: CollabCheckpointProfile;
  readonly expectedSourceAuthority: CollabCheckpointAuthority;
  readonly expectedTargetAuthority: CollabCheckpointAuthority | null;
  readonly signal: AbortSignal | undefined;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STREAM_BUFFER_BYTES = 64 * 1024;
const COORDINATION_HEAP_AMPLIFICATION = 12;
const COORDINATION_HEAP_BUDGET_DIVISOR = 2;

function fail(code: ProjectCheckpointCoordinatorErrorCode): never {
  throw new ProjectCheckpointCoordinatorError(code);
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function sameAuthority(
  left: CollabCheckpointAuthority | null,
  right: CollabCheckpointAuthority | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.generation === right.generation
      && left.kind === right.kind;
}

function snapshotAuthority(value: CollabCheckpointAuthority): CollabCheckpointAuthority {
  const kind: unknown = value.kind;
  const snapshot = Object.freeze({
    generation: value.generation,
    kind,
  });
  if (
    !Number.isSafeInteger(snapshot.generation)
    || snapshot.generation <= 0
    || (kind !== 'cloud' && kind !== 'lan')
  ) {
    fail('invalid-checkpoint');
  }
  return snapshot as CollabCheckpointAuthority;
}

function snapshotAttempt(
  value: PreparedProductionCheckpointAttempt,
): PreparedProductionCheckpointAttempt {
  const snapshot = Object.freeze({
    attemptKey: value.attemptKey,
    expiresAt: value.expiresAt,
    operationId: value.operationId,
    projectId: value.projectId,
  });
  if (
    !SHA256_PATTERN.test(snapshot.attemptKey)
    || !isCollabOpaqueId(snapshot.operationId)
    || !isCollabProjectId(snapshot.projectId)
  ) {
    fail('invalid-checkpoint');
  }
  return snapshot;
}

function snapshotInput(
  input: ValidateStagedProjectCheckpointInput,
): ValidationInputSnapshot {
  try {
    const attempt = snapshotAttempt(input.attempt);
    const expectedProfile = input.expectedProfile;
    const expectedSourceAuthority = snapshotAuthority(
      input.expectedSourceAuthority,
    );
    const target = input.expectedTargetAuthority;
    const expectedTargetAuthority = target === null
      ? null
      : snapshotAuthority(target);
    const signal = input.signal;
    if (!COLLAB_CHECKPOINT_PROFILES.some(profile => profile === expectedProfile)) {
      fail('invalid-checkpoint');
    }
    return Object.freeze({
      attempt,
      expectedProfile,
      expectedSourceAuthority,
      expectedTargetAuthority,
      signal,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectCheckpointCoordinatorError) throw error;
    return fail('invalid-checkpoint');
  }
}

function exactAttempt(
  left: PreparedProductionCheckpointAttempt,
  right: PreparedProductionCheckpointAttempt,
): boolean {
  return left.attemptKey === right.attemptKey
    && left.expiresAt === right.expiresAt
    && left.operationId === right.operationId
    && left.projectId === right.projectId;
}

function artifactLimit(name: CollabCloudAuthorityTransferArtifact): number {
  switch (name) {
    case 'checkpoint.json':
      return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes;
    case 'coordination.ndjson':
      return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes;
    case 'repository.bundle':
      return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes;
  }
}

function snapshotArtifacts(
  artifacts: readonly StagedProductionCheckpointArtifact[],
  attempt: PreparedProductionCheckpointAttempt,
): ReadonlyMap<
  CollabCloudAuthorityTransferArtifact,
  StagedProductionCheckpointArtifact
> {
  if (artifacts.length !== COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.length) {
    fail('invalid-checkpoint');
  }
  const result = new Map<
    CollabCloudAuthorityTransferArtifact,
    StagedProductionCheckpointArtifact
  >();
  for (const artifact of artifacts) {
    const snapshot = Object.freeze({
      attemptKey: artifact.attemptKey,
      byteCount: artifact.byteCount,
      name: artifact.name,
      operationId: artifact.operationId,
      projectId: artifact.projectId,
      sha256: artifact.sha256,
    });
    if (
      !COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.some(name => name === snapshot.name)
      || snapshot.attemptKey !== attempt.attemptKey
      || snapshot.operationId !== attempt.operationId
      || snapshot.projectId !== attempt.projectId
      || !Number.isSafeInteger(snapshot.byteCount)
      || snapshot.byteCount <= 0
      || snapshot.byteCount > artifactLimit(snapshot.name)
      || !SHA256_PATTERN.test(snapshot.sha256)
      || result.has(snapshot.name)
    ) {
      fail('invalid-checkpoint');
    }
    result.set(snapshot.name, snapshot);
  }
  if (COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.some(name => !result.has(name))) {
    fail('invalid-checkpoint');
  }
  return result;
}

function decodeManifestJson(value: string): CollabProjectCheckpointManifest {
  try {
    return decodeCollabProjectCheckpointManifest(JSON.parse(value) as unknown);
  } catch {
    return fail('invalid-checkpoint');
  }
}

function snapshotRepository(
  value: ValidatedRepositoryCheckpoint,
  attempt: PreparedProductionCheckpointAttempt,
  artifact: StagedProductionCheckpointArtifact,
  manifest: CollabProjectCheckpointManifest,
): ValidatedRepositoryCheckpoint {
  try {
    const bundleInputDisposition: unknown = value.bundleInputDisposition;
    if (
      bundleInputDisposition !== 'consumed'
      && bundleInputDisposition !== 'replayed'
    ) {
      fail('invalid-checkpoint');
    }
    const refs = value.refs.map(ref => Object.freeze({
      name: ref.name,
      oid: ref.oid,
    }));
    const snapshot = Object.freeze({
      artifactKey: value.artifactKey,
      bundleByteCount: value.bundleByteCount,
      bundleInputDisposition,
      bundleSha256: value.bundleSha256,
      markerSha256: value.markerSha256,
      objectFormat: value.objectFormat,
      operationId: value.operationId,
      projectId: value.projectId,
      refs: Object.freeze(refs),
    });
    if (
      !SHA256_PATTERN.test(snapshot.artifactKey)
      || !SHA256_PATTERN.test(snapshot.markerSha256)
      || snapshot.bundleByteCount !== artifact.byteCount
      || snapshot.bundleSha256 !== artifact.sha256
      || snapshot.objectFormat !== manifest.gitObjectFormat
      || snapshot.operationId !== attempt.operationId
      || snapshot.projectId !== attempt.projectId
      || snapshot.refs.length !== manifest.refs.length
      || snapshot.refs.some((ref, index) => {
        const expected = manifest.refs.at(index);
        return expected === undefined
          || ref.name !== expected.name
          || ref.oid !== expected.oid;
      })
    ) {
      fail('invalid-checkpoint');
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof ProjectCheckpointCoordinatorError) throw error;
    return fail('invalid-checkpoint');
  }
}

function mapDependency(
  error: unknown,
  signal: AbortSignal,
): never {
  if (error instanceof ProjectCheckpointCoordinatorError) throw error;
  if (signal.aborted) {
    return fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
  }
  if (error instanceof ProductionCheckpointStagingError) {
    switch (error.code) {
      case 'busy': return fail('busy');
      case 'cancelled': return fail('cancelled');
      case 'closed': return fail('closed');
      case 'storage-unavailable': return fail('storage-unavailable');
      case 'timeout': return fail('timeout');
      default: return fail('invalid-checkpoint');
    }
  }
  if (error instanceof GitBundleImportError) {
    switch (error.code) {
      case 'busy': return fail('busy');
      case 'cancelled': return fail('cancelled');
      case 'closed': return fail('closed');
      case 'git-unavailable': return fail('storage-unavailable');
      case 'process-failed': return fail('storage-unavailable');
      case 'storage-unavailable': return fail('storage-unavailable');
      case 'timeout': return fail('timeout');
      case 'unsupported-git': return fail('storage-unavailable');
      default: return fail('invalid-checkpoint');
    }
  }
  if (error instanceof CollabError) return fail('invalid-checkpoint');
  return fail('storage-unavailable');
}

function invalidRepositoryStaging(error: unknown): boolean {
  if (error instanceof GitBundleImportError) {
    return error.code === 'artifact-conflict'
      || error.code === 'artifact-invalid'
      || error.code === 'digest-mismatch'
      || error.code === 'repository-invalid'
      || error.code === 'repository-limit';
  }
  if (error instanceof ProductionCheckpointStagingError) {
    return error.code === 'artifact-conflict'
      || error.code === 'digest-mismatch'
      || error.code === 'expired'
      || error.code === 'input-limit'
      || error.code === 'invalid-attempt';
  }
  return error instanceof ProjectCheckpointCoordinatorError
    && error.code === 'invalid-checkpoint';
}

function safePumpFailure(error: unknown): Error {
  return error instanceof ProductionCheckpointStagingError
      || error instanceof ProjectCheckpointCoordinatorError
    ? error
    : new ProjectCheckpointCoordinatorError('storage-unavailable');
}

export class ProjectCheckpointCoordinator {
  readonly #controllers = new Set<AbortController>();
  readonly #maximumConcurrentCoordinationValidations: number;
  readonly #maximumCoordinationBytes: number;
  readonly #repository: RepositoryCheckpointStagingPort;
  readonly #running = new Set<Promise<void>>();
  readonly #staging: ProjectCheckpointCoordinatorOptions['staging'];
  #activeCoordinationValidations = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ProjectCheckpointCoordinatorOptions) {
    const maximumConcurrentCoordinationValidations =
      options.maximumConcurrentCoordinationValidations ?? 1;
    const heapBudgetBytes = Math.floor(
      getHeapStatistics().heap_size_limit / COORDINATION_HEAP_BUDGET_DIVISOR,
    );
    const defaultMaximumCoordinationBytes = Math.min(
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
      Math.floor(
        heapBudgetBytes
          / COORDINATION_HEAP_AMPLIFICATION
          / maximumConcurrentCoordinationValidations,
      ),
    );
    const maximumCoordinationBytes = options.maximumCoordinationBytes
      ?? defaultMaximumCoordinationBytes;
    if (
      !Number.isSafeInteger(maximumConcurrentCoordinationValidations)
      || maximumConcurrentCoordinationValidations <= 0
      || !Number.isSafeInteger(maximumCoordinationBytes)
      || maximumCoordinationBytes <= 0
      || maximumCoordinationBytes
        > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes
      || maximumCoordinationBytes
        * maximumConcurrentCoordinationValidations
        * COORDINATION_HEAP_AMPLIFICATION
        > heapBudgetBytes
    ) {
      throw new TypeError('project-checkpoint-coordinator.options-invalid');
    }
    this.#maximumConcurrentCoordinationValidations =
      maximumConcurrentCoordinationValidations;
    this.#maximumCoordinationBytes = maximumCoordinationBytes;
    this.#repository = options.repository;
    this.#staging = options.staging;
  }

  get maximumCoordinationBytes(): number {
    return this.#maximumCoordinationBytes;
  }

  validateStaged(
    input: ValidateStagedProjectCheckpointInput,
  ): Promise<ValidatedProjectCheckpoint> {
    let snapshot: ValidationInputSnapshot;
    try {
      snapshot = snapshotInput(input);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#run(snapshot.signal, signal => (
      this.#validateStaged(snapshot, signal)
    ));
  }

  validateStagedWithRepository(
    input: ValidateStagedProjectCheckpointInput,
    repository: ValidatedRepositoryCheckpoint,
  ): Promise<ValidatedProjectCheckpoint> {
    let snapshot: ValidationInputSnapshot;
    try {
      snapshot = snapshotInput(input);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#run(snapshot.signal, signal => (
      this.#validateStaged(snapshot, signal, repository)
    ));
  }

  discard(
    checkpoint: ValidatedProjectCheckpoint,
    signal?: AbortSignal,
  ): Promise<void> {
    let attempt: PreparedProductionCheckpointAttempt;
    let operationId: string;
    let projectId: string;
    try {
      attempt = snapshotAttempt(checkpoint.attempt);
      operationId = checkpoint.repository.operationId;
      projectId = checkpoint.repository.projectId;
      if (
        operationId !== attempt.operationId
        || projectId !== attempt.projectId
        || checkpoint.manifest.operationId !== attempt.operationId
        || checkpoint.manifest.projectId !== attempt.projectId
      ) {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProjectCheckpointCoordinatorError
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#discardAttempt(attempt, signal);
  }

  discardAttempt(
    input: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<void> {
    let attempt: PreparedProductionCheckpointAttempt;
    try {
      attempt = snapshotAttempt(input);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProjectCheckpointCoordinatorError
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#discardAttempt(attempt, signal);
  }

  #discardAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#run(signal, async operationSignal => {
      try {
        await this.#repository.discardCheckpoint({
          operationId: attempt.operationId,
          projectId: attempt.projectId,
        });
        await this.#staging.discardAttempt(attempt, operationSignal);
      } catch (error: unknown) {
        mapDependency(error, operationSignal);
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort('closed');
      this.#closePromise = Promise.allSettled([...this.#running]).then(
        () => undefined,
      );
    }
    return this.#closePromise;
  }

  #run<Result>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new ProjectCheckpointCoordinatorError('closed'));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort('cancelled');
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted === true) onAbort();
    this.#controllers.add(controller);
    const result = Promise.resolve().then(() => operation(controller.signal));
    const tracked = result.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    void tracked.finally(() => {
      externalSignal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      this.#running.delete(tracked);
    });
    return result;
  }

  async #validateStaged(
    input: ValidationInputSnapshot,
    signal: AbortSignal,
    expectedRepository?: ValidatedRepositoryCheckpoint,
  ): Promise<ValidatedProjectCheckpoint> {
    let coordinationValidationOwned = false;
    try {
      const inspected = await this.#staging.inspectAttempt(
        input.attempt,
        signal,
      );
      if (!exactAttempt(inspected.attempt, input.attempt)) {
        fail('invalid-checkpoint');
      }
      const artifacts = snapshotArtifacts(inspected.artifacts, input.attempt);
      const manifestFact = artifacts.get('checkpoint.json');
      const coordinationFact = artifacts.get('coordination.ndjson');
      const repositoryFact = artifacts.get('repository.bundle');
      if (
        manifestFact === undefined
        || coordinationFact === undefined
        || repositoryFact === undefined
      ) {
        fail('invalid-checkpoint');
      }
      if (coordinationFact.byteCount > this.#maximumCoordinationBytes) {
        fail('resource-limit');
      }
      const manifestJson = await this.#readTextArtifact(
        input.attempt,
        manifestFact,
        signal,
      );
      const manifest = deepFreeze(decodeManifestJson(manifestJson));
      if (
        encodeCollabProjectCheckpointManifestCanonicalJson(manifest)
          !== manifestJson
        || sha256(encodeCollabProjectCheckpointManifestDigestInput(manifest))
          !== manifest.manifestSha256
        || manifest.projectId !== input.attempt.projectId
        || manifest.operationId !== input.attempt.operationId
        || manifest.profile !== input.expectedProfile
        || !sameAuthority(
          manifest.sourceAuthority,
          input.expectedSourceAuthority,
        )
        || !sameAuthority(
          manifest.targetAuthority,
          input.expectedTargetAuthority,
        )
      ) {
        fail('invalid-checkpoint');
      }
      for (const fact of [coordinationFact, repositoryFact]) {
        const expected = manifest.artifacts.find(item => item.name === fact.name);
        if (
          expected?.byteCount !== fact.byteCount
          || expected.sha256 !== fact.sha256
        ) {
          fail('invalid-checkpoint');
        }
      }
      if (
        this.#activeCoordinationValidations
        >= this.#maximumConcurrentCoordinationValidations
      ) {
        fail('busy');
      }
      this.#activeCoordinationValidations += 1;
      coordinationValidationOwned = true;
      const coordinationJson = await this.#readTextArtifact(
        input.attempt,
        coordinationFact,
        signal,
      );
      const records = deepFreeze(validateCollabProjectCheckpointConsistency(
        manifest,
        decodeCollabProjectCheckpointCoordinationNdjson(
          coordinationJson,
          manifest.profile,
        ),
      ));
      let importedRepository: ValidatedRepositoryCheckpoint;
      if (expectedRepository === undefined) {
        try {
          importedRepository = await this.#importRepository(
            input.attempt,
            repositoryFact,
            manifest,
            signal,
          );
        } catch (error: unknown) {
          if (invalidRepositoryStaging(error)) {
            await this.#repository.discardCheckpoint({
              operationId: input.attempt.operationId,
              projectId: input.attempt.projectId,
            });
          }
          throw error;
        }
      } else {
        importedRepository = expectedRepository;
      }
      let repository: ValidatedRepositoryCheckpoint;
      try {
        repository = snapshotRepository(
          importedRepository,
          input.attempt,
          repositoryFact,
          manifest,
        );
      } catch (error: unknown) {
        if (expectedRepository === undefined) {
          try {
            await this.#repository.discardCheckpoint({
              operationId: input.attempt.operationId,
              projectId: input.attempt.projectId,
            });
          } catch (cleanupError: unknown) {
            return mapDependency(cleanupError, signal);
          }
        }
        throw error;
      }
      return Object.freeze({
        attempt: input.attempt,
        manifest,
        records,
        repository,
      });
    } catch (error: unknown) {
      return mapDependency(error, signal);
    } finally {
      if (coordinationValidationOwned) {
        this.#activeCoordinationValidations -= 1;
      }
    }
  }

  async #readTextArtifact(
    attempt: PreparedProductionCheckpointAttempt,
    artifact: StagedProductionCheckpointArtifact,
    signal: AbortSignal,
  ): Promise<string> {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    await this.#staging.readArtifact({
      artifact,
      attempt,
      onChunk: chunk => {
        byteCount += chunk.length;
        if (byteCount > artifact.byteCount || byteCount > artifactLimit(artifact.name)) {
          fail('invalid-checkpoint');
        }
        chunks.push(Buffer.from(chunk));
      },
      signal,
    });
    if (byteCount !== artifact.byteCount) fail('invalid-checkpoint');
    const bytes = Buffer.concat(chunks, byteCount);
    if (sha256(bytes) !== artifact.sha256) fail('invalid-checkpoint');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return fail('invalid-checkpoint');
    }
  }

  async #importRepository(
    attempt: PreparedProductionCheckpointAttempt,
    artifact: StagedProductionCheckpointArtifact,
    manifest: CollabProjectCheckpointManifest,
    signal: AbortSignal,
  ): Promise<ValidatedRepositoryCheckpoint> {
    const body = new PassThrough({ highWaterMark: STREAM_BUFFER_BYTES });
    body.on('error', () => undefined);
    const pumpController = new AbortController();
    const pumpSignal = AbortSignal.any([signal, pumpController.signal]);
    const pumpState: {
      failure: Error | undefined;
      settled: boolean;
    } = { failure: undefined, settled: false };
    const pump = this.#staging.readArtifact({
      artifact,
      attempt,
      onChunk: async chunk => {
        if (!body.write(chunk)) {
          await once(body, 'drain', { signal: pumpSignal });
        }
      },
      signal: pumpSignal,
    }).then(
      () => {
        pumpState.settled = true;
        body.end();
      },
      (error: unknown) => {
        pumpState.failure = safePumpFailure(error);
        pumpState.settled = true;
        body.destroy(pumpState.failure);
      },
    );
    try {
      let imported: ValidatedRepositoryCheckpoint | undefined;
      let importFailure: Error | undefined;
      try {
        imported = await this.#repository.importCheckpoint({
          body,
          expectedByteCount: artifact.byteCount,
          expectedSha256: artifact.sha256,
          objectFormat: manifest.gitObjectFormat,
          operationId: attempt.operationId,
          projectId: attempt.projectId,
          refs: manifest.refs,
          signal,
        });
      } catch (error: unknown) {
        importFailure = error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('storage-unavailable');
      }
      const verifiedReplay = imported?.bundleInputDisposition === 'replayed';
      const importerReturnedEarly = imported?.bundleInputDisposition === 'consumed'
        && !pumpState.settled;
      const pumpFailedBeforeImport = pumpState.failure !== undefined;
      if (!pumpState.settled) {
        if (importerReturnedEarly) {
          body.resume();
        } else {
          pumpController.abort('cancelled');
          body.destroy(new ProjectCheckpointCoordinatorError('cancelled'));
        }
      }
      await pump;
      if (signal.aborted) {
        fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
      }
      if (
        pumpState.failure !== undefined
        && pumpFailedBeforeImport
        && !verifiedReplay
      ) {
        throw pumpState.failure;
      }
      if (importFailure !== undefined) throw importFailure;
      if (pumpState.failure !== undefined && !verifiedReplay) {
        throw pumpState.failure;
      }
      if (importerReturnedEarly) fail('invalid-checkpoint');
      if (imported === undefined) fail('storage-unavailable');
      return imported;
    } finally {
      if (!pumpState.settled) {
        pumpController.abort('cancelled');
        body.destroy(new ProjectCheckpointCoordinatorError('cancelled'));
      } else {
        body.destroy();
      }
      await pump.catch(() => undefined);
    }
  }
}
