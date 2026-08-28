import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { getuid } from 'node:process';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabCloudAuthorityTransferArtifact,
  type CollabIsoTimestamp,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import {
  type CheckpointStagingReservation,
  CheckpointStreamAdmissionError,
  type CheckpointStreamAdmission,
  type CheckpointStreamPermit,
} from '../../resource-admission/CheckpointStreamAdmission.js';

export type ProductionCheckpointStagingErrorCode =
  | 'artifact-conflict'
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'digest-mismatch'
  | 'expired'
  | 'input-limit'
  | 'invalid-attempt'
  | 'storage-unavailable'
  | 'timeout';

export class ProductionCheckpointStagingError extends Error {
  readonly code: ProductionCheckpointStagingErrorCode;
  readonly retryable: boolean;

  constructor(code: ProductionCheckpointStagingErrorCode) {
    super(`production-checkpoint-staging.error.${code}`);
    this.name = 'ProductionCheckpointStagingError';
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

export interface PrepareProductionCheckpointAttemptInput {
  readonly expiresAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
}

export interface PreparedProductionCheckpointAttempt
  extends PrepareProductionCheckpointAttemptInput {
  readonly attemptKey: string;
}

export interface StagedProductionCheckpointArtifact {
  readonly attemptKey: string;
  readonly byteCount: number;
  readonly name: CollabCloudAuthorityTransferArtifact;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly sha256: string;
}

export interface ReceiveProductionCheckpointArtifactInput {
  readonly artifact: CollabCloudAuthorityTransferArtifact;
  readonly attempt: PreparedProductionCheckpointAttempt;
  readonly body: AsyncIterable<unknown>;
  readonly expectedByteCount: number;
  readonly expectedSha256: string;
  readonly signal?: AbortSignal;
}

export interface ReadProductionCheckpointArtifactInput {
  readonly artifact: StagedProductionCheckpointArtifact;
  readonly attempt: PreparedProductionCheckpointAttempt;
  readonly onChunk: (
    chunk: Buffer,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

export interface InspectedProductionCheckpointAttempt {
  readonly artifacts: readonly StagedProductionCheckpointArtifact[];
  readonly attempt: PreparedProductionCheckpointAttempt;
}

export interface ProductionCheckpointStagingPort {
  discardAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'>;
  expireAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    expiredBefore: CollabIsoTimestamp,
    signal?: AbortSignal,
  ): Promise<'expired' | 'replayed' | 'retained'>;
  inspectAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<InspectedProductionCheckpointAttempt>;
  prepareAttempt(
    input: PrepareProductionCheckpointAttemptInput,
    signal?: AbortSignal,
  ): Promise<PreparedProductionCheckpointAttempt>;
  readArtifact(input: ReadProductionCheckpointArtifactInput): Promise<void>;
  receiveArtifact(
    input: ReceiveProductionCheckpointArtifactInput,
  ): Promise<StagedProductionCheckpointArtifact>;
}

export interface ProductionCheckpointDeliveryCursor {
  readonly expiresAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
}

export interface ProductionCheckpointDeliveryPage {
  readonly deliveries: readonly PreparedProductionCheckpointAttempt[];
  readonly nextCursor: ProductionCheckpointDeliveryCursor | undefined;
}

export interface ProductionCheckpointDeliveryCatalogPort {
  listDueAttemptDeliveries(
    options: Readonly<{
      readonly after?: ProductionCheckpointDeliveryCursor;
      readonly expiredBefore: CollabIsoTimestamp;
      readonly limit?: number;
    }>,
    signal?: AbortSignal,
  ): Promise<ProductionCheckpointDeliveryPage>;
  registerAttemptDelivery(
    input: Readonly<{
      readonly attempt: PreparedProductionCheckpointAttempt;
      readonly expiresAt: CollabIsoTimestamp;
    }>,
    signal?: AbortSignal,
  ): Promise<'registered' | 'replayed'>;
}

export interface ProductionCheckpointStagingOptions {
  readonly admission: CheckpointStreamAdmission;
  readonly clock?: () => Date;
  readonly idleTimeoutMs: number;
  readonly stagingRoot: string;
  readonly syncDirectory?: (path: string) => Promise<void>;
  readonly totalTimeoutMs: number;
}

interface AttemptPaths {
  readonly attempt: string;
  readonly deliveryMarker: string;
  readonly deliveryMarkerPart: string;
  readonly ownerMarker: string;
  readonly ownerMarkerPart: string;
  readonly productionRoot: string;
}

interface ArtifactPaths {
  readonly artifact: string;
  readonly artifactPart: string;
  readonly marker: string;
  readonly markerPart: string;
}

interface ActiveAttemptOperation {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

const ATTEMPT_MARKER = '.claudian-cloud-production-attempt.json';
const ATTEMPT_SCHEMA_VERSION = 1;
const ARTIFACT_MARKER_SCHEMA_VERSION = 1;
const DELIVERY_MARKER = '.claudian-cloud-production-delivery.json';
const DELIVERY_SCHEMA_VERSION = 1;
const ARTIFACT_READ_BUFFER_BYTES = 64 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAXIMUM_MARKER_BYTES = 64 * 1024;
const MAXIMUM_STREAM_SETTLEMENT_MS = 1_000;
const PRODUCTION_DIRECTORY = 'production';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function fail(code: ProductionCheckpointStagingErrorCode): never {
  throw new ProductionCheckpointStagingError(code);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

function isArtifact(value: unknown): value is CollabCloudAuthorityTransferArtifact {
  return typeof value === 'string'
    && COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.some(artifact => artifact === value);
}

function artifactLimit(artifact: CollabCloudAuthorityTransferArtifact): number {
  switch (artifact) {
    case 'checkpoint.json':
      return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes;
    case 'coordination.ndjson':
      return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes;
    case 'repository.bundle':
      return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes;
  }
}

function canonicalTimestamp(value: unknown): value is CollabIsoTimestamp {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function attemptKey(projectId: string, operationId: string): string {
  return createHash('sha256')
    .update(`production-checkpoint\0${projectId}\0${operationId}`, 'utf8')
    .digest('hex');
}

function assertRoot(path: string): void {
  if (
    !isAbsolute(path)
    || normalize(path) !== path
    || parse(path).root === path
  ) {
    throw new TypeError('production-checkpoint-staging.options-invalid');
  }
}

function assertOptions(options: ProductionCheckpointStagingOptions): void {
  assertRoot(options.stagingRoot);
  if (
    !Number.isSafeInteger(options.idleTimeoutMs)
    || options.idleTimeoutMs <= 0
    || options.idleTimeoutMs
      > COLLAB_CLOUD_BINDING_LIMITS.uploadIdleTimeoutMs
    || !Number.isSafeInteger(options.totalTimeoutMs)
    || options.totalTimeoutMs <= 0
    || options.totalTimeoutMs > COLLAB_CLOUD_BINDING_LIMITS.uploadDeadlineMs
    || typeof options.admission.acquire !== 'function'
    || (options.clock !== undefined && typeof options.clock !== 'function')
    || (options.syncDirectory !== undefined
      && typeof options.syncDirectory !== 'function')
  ) {
    throw new TypeError('production-checkpoint-staging.options-invalid');
  }
}

function assertPrepareInput(
  input: PrepareProductionCheckpointAttemptInput,
): void {
  if (
    !isCollabProjectId(input.projectId)
    || !isCollabOpaqueId(input.operationId)
    || !canonicalTimestamp(input.expiresAt)
  ) {
    fail('invalid-attempt');
  }
}

function assertAttempt(
  attempt: PreparedProductionCheckpointAttempt,
): void {
  assertPrepareInput(attempt);
  if (
    !SHA256_PATTERN.test(attempt.attemptKey)
    || attempt.attemptKey !== attemptKey(attempt.projectId, attempt.operationId)
  ) {
    fail('invalid-attempt');
  }
}

function freezeAttempt(
  input: PrepareProductionCheckpointAttemptInput,
): PreparedProductionCheckpointAttempt {
  return Object.freeze({
    attemptKey: attemptKey(input.projectId, input.operationId),
    expiresAt: input.expiresAt,
    operationId: input.operationId,
    projectId: input.projectId,
  });
}

export function productionCheckpointAttemptIdentity(
  input: PrepareProductionCheckpointAttemptInput,
): PreparedProductionCheckpointAttempt {
  return freezeAttempt(snapshotPrepareInput(input));
}

function snapshotPrepareInput(
  input: PrepareProductionCheckpointAttemptInput,
): PrepareProductionCheckpointAttemptInput {
  const snapshot = Object.freeze({
    expiresAt: input.expiresAt,
    operationId: input.operationId,
    projectId: input.projectId,
  });
  assertPrepareInput(snapshot);
  return snapshot;
}

function snapshotAttempt(
  input: PreparedProductionCheckpointAttempt,
): PreparedProductionCheckpointAttempt {
  const snapshot = Object.freeze({
    attemptKey: input.attemptKey,
    expiresAt: input.expiresAt,
    operationId: input.operationId,
    projectId: input.projectId,
  });
  assertAttempt(snapshot);
  return snapshot;
}

function snapshotArtifact(
  input: StagedProductionCheckpointArtifact,
  attempt: PreparedProductionCheckpointAttempt,
): StagedProductionCheckpointArtifact {
  const snapshot = Object.freeze({
    attemptKey: input.attemptKey,
    byteCount: input.byteCount,
    name: input.name,
    operationId: input.operationId,
    projectId: input.projectId,
    sha256: input.sha256,
  });
  assertArtifact(snapshot, attempt);
  return snapshot;
}

function attemptMarkerJson(
  attempt: PreparedProductionCheckpointAttempt,
): string {
  return `${JSON.stringify({
    attemptKey: attempt.attemptKey,
    expiresAt: attempt.expiresAt,
    operationId: attempt.operationId,
    projectId: attempt.projectId,
    schemaVersion: ATTEMPT_SCHEMA_VERSION,
  })}\n`;
}

function deliveryMarkerJson(
  attempt: PreparedProductionCheckpointAttempt,
  expiresAt: CollabIsoTimestamp,
): string {
  return `${JSON.stringify({
    attemptKey: attempt.attemptKey,
    expiresAt,
    operationId: attempt.operationId,
    projectId: attempt.projectId,
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    storageExpiresAt: attempt.expiresAt,
  })}\n`;
}

function parseDeliveryMarker(json: string): Readonly<{
  readonly delivery: PreparedProductionCheckpointAttempt;
  readonly stored: PreparedProductionCheckpointAttempt;
}> {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail('artifact-conflict');
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',')
        !== 'attemptKey,expiresAt,operationId,projectId,schemaVersion,storageExpiresAt'
      || record.schemaVersion !== DELIVERY_SCHEMA_VERSION
      || typeof record.attemptKey !== 'string'
      || typeof record.expiresAt !== 'string'
      || typeof record.operationId !== 'string'
      || typeof record.projectId !== 'string'
      || typeof record.storageExpiresAt !== 'string'
      || !canonicalTimestamp(record.expiresAt)
      || !canonicalTimestamp(record.storageExpiresAt)
    ) fail('artifact-conflict');
    const delivery = productionCheckpointAttemptIdentity({
      expiresAt: record.expiresAt,
      operationId: record.operationId,
      projectId: record.projectId,
    });
    const stored = productionCheckpointAttemptIdentity({
      expiresAt: record.storageExpiresAt,
      operationId: record.operationId,
      projectId: record.projectId,
    });
    if (
      delivery.attemptKey !== record.attemptKey
      || stored.attemptKey !== record.attemptKey
      || delivery.expiresAt >= stored.expiresAt
      || deliveryMarkerJson(stored, delivery.expiresAt) !== json
    ) fail('artifact-conflict');
    return Object.freeze({ delivery, stored });
  } catch (error: unknown) {
    if (error instanceof ProductionCheckpointStagingError) throw error;
    return fail('artifact-conflict');
  }
}

function deliveryCursorAfter(
  delivery: PreparedProductionCheckpointAttempt,
  after: ProductionCheckpointDeliveryCursor | undefined,
): boolean {
  if (after === undefined) return true;
  return compareDeliveryIdentity(delivery, after) > 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDeliveryIdentity(
  left: ProductionCheckpointDeliveryCursor,
  right: ProductionCheckpointDeliveryCursor,
): number {
  return compareText(left.expiresAt, right.expiresAt)
    || compareText(left.projectId, right.projectId)
    || compareText(left.operationId, right.operationId);
}

function artifactMarkerJson(
  artifact: StagedProductionCheckpointArtifact,
): string {
  return `${JSON.stringify({
    attemptKey: artifact.attemptKey,
    byteCount: artifact.byteCount,
    name: artifact.name,
    operationId: artifact.operationId,
    projectId: artifact.projectId,
    schemaVersion: ARTIFACT_MARKER_SCHEMA_VERSION,
    sha256: artifact.sha256,
  })}\n`;
}

function assertPrivateFileEntry(
  entry: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): void {
  const uid = getuid?.();
  if (
    !entry.isFile()
    || typeof entry.mode !== 'number'
    || typeof entry.uid !== 'number'
    || (entry.mode & 0o077) !== 0
    || (uid !== undefined && entry.uid !== uid)
  ) {
    fail('artifact-conflict');
  }
}

function paths(
  stagingRoot: string,
  projectId: string,
  operationId: string,
): AttemptPaths {
  const productionRoot = join(stagingRoot, PRODUCTION_DIRECTORY);
  const attempt = join(productionRoot, attemptKey(projectId, operationId));
  return Object.freeze({
    attempt,
    deliveryMarker: join(attempt, DELIVERY_MARKER),
    deliveryMarkerPart: join(attempt, `.${DELIVERY_MARKER}.part`),
    ownerMarker: join(attempt, ATTEMPT_MARKER),
    ownerMarkerPart: join(attempt, `.${ATTEMPT_MARKER}.part`),
    productionRoot,
  });
}

function artifactPaths(
  attempt: string,
  artifact: CollabCloudAuthorityTransferArtifact,
): ArtifactPaths {
  return Object.freeze({
    artifact: join(attempt, artifact),
    artifactPart: join(attempt, `.${artifact}.part`),
    marker: join(attempt, `.${artifact}.receipt.json`),
    markerPart: join(attempt, `.${artifact}.receipt.json.part`),
  });
}

export function productionCheckpointAttemptPath(
  stagingRoot: string,
  projectId: string,
  operationId: string,
): string {
  assertRoot(stagingRoot);
  if (!isCollabProjectId(projectId) || !isCollabOpaqueId(operationId)) {
    throw new TypeError('production-checkpoint-staging.path-invalid');
  }
  return paths(stagingRoot, projectId, operationId).attempt;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertPrivateDirectoryEntry(
  entry: Awaited<ReturnType<typeof lstat>>,
): void {
  const uid = getuid?.();
  if (
    !entry.isDirectory()
    || entry.isSymbolicLink()
    || typeof entry.mode !== 'number'
    || typeof entry.uid !== 'number'
    || (entry.mode & 0o077) !== 0
    || (uid !== undefined && entry.uid !== uid)
  ) {
    fail('artifact-conflict');
  }
}

async function privateDirectoryExists(path: string): Promise<boolean> {
  try {
    assertPrivateDirectoryEntry(await lstat(path));
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    if (error instanceof ProductionCheckpointStagingError) throw error;
    return fail('storage-unavailable');
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  if (!await privateDirectoryExists(path)) fail('storage-unavailable');
}

async function containIteratorSettlement(
  iterator: AsyncIterator<unknown>,
  timeoutMs: number,
): Promise<void> {
  let settlement: Promise<void>;
  try {
    if (iterator.return === undefined) return;
    settlement = Promise.resolve(iterator.return()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settlement,
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readBoundedText(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const entry = await handle.stat();
    if (
      entry.size <= 0
      || entry.size > MAXIMUM_MARKER_BYTES
    ) {
      fail('artifact-conflict');
    }
    assertPrivateFileEntry(entry);
    return await handle.readFile('utf8');
  } catch (error: unknown) {
    if (error instanceof ProductionCheckpointStagingError) throw error;
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    if (hasErrorCode(error, 'ELOOP')) fail('artifact-conflict');
    return fail('storage-unavailable');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    fail('storage-unavailable');
  }
}

async function removeOwnedFile(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) fail('artifact-conflict');
    await rm(path);
  } catch (error: unknown) {
    if (error instanceof ProductionCheckpointStagingError) throw error;
    if (hasErrorCode(error, 'ENOENT')) return;
    fail('storage-unavailable');
  }
}

async function writeMarker(
  path: string,
  partPath: string,
  json: string,
  parent: string,
  synchronizeDirectory: (path: string) => Promise<void>,
): Promise<void> {
  await removeOwnedFile(partPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(partPath, 'wx', FILE_MODE);
    await handle.writeFile(json, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(partPath, path);
    await synchronizeDirectory(parent);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(partPath, { force: true }).catch(() => undefined);
    if (error instanceof ProductionCheckpointStagingError) throw error;
    fail('storage-unavailable');
  }
}

function parseArtifactMarker(
  json: string,
  attempt: PreparedProductionCheckpointAttempt,
  name: CollabCloudAuthorityTransferArtifact,
): StagedProductionCheckpointArtifact {
  try {
    const value: unknown = JSON.parse(json);
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
    ) {
      fail('artifact-conflict');
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',')
        !== 'attemptKey,byteCount,name,operationId,projectId,schemaVersion,sha256'
      || record.schemaVersion !== ARTIFACT_MARKER_SCHEMA_VERSION
      || record.attemptKey !== attempt.attemptKey
      || record.operationId !== attempt.operationId
      || record.projectId !== attempt.projectId
      || record.name !== name
      || !Number.isSafeInteger(record.byteCount)
      || typeof record.byteCount !== 'number'
      || record.byteCount <= 0
      || record.byteCount > artifactLimit(name)
      || typeof record.sha256 !== 'string'
      || !SHA256_PATTERN.test(record.sha256)
    ) {
      fail('artifact-conflict');
    }
    const artifact = Object.freeze({
      attemptKey: attempt.attemptKey,
      byteCount: record.byteCount,
      name,
      operationId: attempt.operationId,
      projectId: attempt.projectId,
      sha256: record.sha256,
    });
    if (artifactMarkerJson(artifact) !== json) fail('artifact-conflict');
    return artifact;
  } catch (error: unknown) {
    if (error instanceof ProductionCheckpointStagingError) throw error;
    fail('artifact-conflict');
  }
}

function assertArtifact(
  artifact: StagedProductionCheckpointArtifact,
  attempt: PreparedProductionCheckpointAttempt,
): void {
  if (
    artifact.attemptKey !== attempt.attemptKey
    || artifact.operationId !== attempt.operationId
    || artifact.projectId !== attempt.projectId
    || !isArtifact(artifact.name)
    || !Number.isSafeInteger(artifact.byteCount)
    || artifact.byteCount <= 0
    || artifact.byteCount > artifactLimit(artifact.name)
    || !SHA256_PATTERN.test(artifact.sha256)
  ) {
    fail('invalid-attempt');
  }
}

function mapAdmission(error: CheckpointStreamAdmissionError): never {
  switch (error.code) {
    case 'busy':
      return fail('busy');
    case 'cancelled':
      return fail('cancelled');
    case 'closed':
      return fail('closed');
    case 'input-limit':
      return fail('input-limit');
    case 'invalid-request':
      return fail('invalid-attempt');
    case 'storage-unavailable':
      return fail('storage-unavailable');
  }
}

function abortError(signal: AbortSignal): ProductionCheckpointStagingError {
  return new ProductionCheckpointStagingError(
    signal.reason === 'closed' ? 'closed' : 'cancelled',
  );
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

export class ProductionCheckpointStaging
implements ProductionCheckpointDeliveryCatalogPort, ProductionCheckpointStagingPort {
  readonly #activeAttempts = new Map<string, ActiveAttemptOperation>();
  readonly #admission: CheckpointStreamAdmission;
  readonly #clock: () => Date;
  readonly #controllers = new Set<AbortController>();
  readonly #controlTails = new Map<string, Promise<void>>();
  readonly #idleTimeoutMs: number;
  readonly #attemptReservations = new Map<string, CheckpointStagingReservation>();
  readonly #retainedAttempts = new Set<string>();
  readonly #running = new Set<Promise<void>>();
  readonly #settlingAttempts = new Set<string>();
  readonly #stagingRoot: string;
  readonly #streamSettlementTimeoutMs: number;
  readonly #syncDirectory: (path: string) => Promise<void>;
  readonly #totalTimeoutMs: number;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ProductionCheckpointStagingOptions) {
    assertOptions(options);
    this.#admission = options.admission;
    this.#clock = options.clock ?? (() => new Date());
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#stagingRoot = options.stagingRoot;
    this.#streamSettlementTimeoutMs = Math.min(
      options.idleTimeoutMs,
      MAXIMUM_STREAM_SETTLEMENT_MS,
    );
    this.#syncDirectory = options.syncDirectory ?? syncDirectory;
    this.#totalTimeoutMs = options.totalTimeoutMs;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort('closed');
      void this.#releaseReservationsAfterQuiescence().catch(() => undefined);
      this.#closePromise = this.#drainClose();
    }
    return this.#closePromise;
  }

  releaseAttemptReservation(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<void> {
    let snapshot: PreparedProductionCheckpointAttempt;
    try {
      snapshot = snapshotAttempt(attempt);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProductionCheckpointStagingError
          ? error
          : new ProductionCheckpointStagingError('invalid-attempt'),
      );
    }
    return this.#runOperation(signal, operationSignal => (
      this.#withAttemptControl(
        snapshot.attemptKey,
        operationSignal,
        async () => {
          if (
            this.#activeAttempts.has(snapshot.attemptKey)
            || this.#retainedAttempts.has(snapshot.attemptKey)
            || this.#settlingAttempts.has(snapshot.attemptKey)
          ) fail('busy');
          this.#releaseAttemptReservation(snapshot.attemptKey);
          await Promise.resolve();
        },
      )
    ));
  }

  registerAttemptDelivery(
    input: Readonly<{
      readonly attempt: PreparedProductionCheckpointAttempt;
      readonly expiresAt: CollabIsoTimestamp;
    }>,
    signal?: AbortSignal,
  ): Promise<'registered' | 'replayed'> {
    let attempt: PreparedProductionCheckpointAttempt;
    let expiresAt: CollabIsoTimestamp;
    try {
      attempt = snapshotAttempt(input.attempt);
      expiresAt = input.expiresAt;
      if (
        !canonicalTimestamp(expiresAt)
        || expiresAt >= attempt.expiresAt
      ) fail('invalid-attempt');
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProductionCheckpointStagingError
          ? error
          : new ProductionCheckpointStagingError('invalid-attempt'),
      );
    }
    return this.#runOperation(signal, operationSignal => (
      this.#withAttemptControl(
        attempt.attemptKey,
        operationSignal,
        async () => {
          const attemptPaths = await this.#assertOwnedAttempt(
            attempt,
            operationSignal,
          );
          const expected = deliveryMarkerJson(attempt, expiresAt);
          const existing = await readBoundedText(attemptPaths.deliveryMarker);
          if (existing !== undefined) {
            if (existing !== expected) fail('artifact-conflict');
            await removeOwnedFile(attemptPaths.deliveryMarkerPart);
            await this.#synchronizeDirectory(attemptPaths.attempt);
            return 'replayed' as const;
          }
          const partial = await readBoundedText(attemptPaths.deliveryMarkerPart);
          if (partial !== undefined) {
            if (partial !== expected) fail('artifact-conflict');
            assertNotAborted(operationSignal);
            await rename(
              attemptPaths.deliveryMarkerPart,
              attemptPaths.deliveryMarker,
            ).catch(() => fail('storage-unavailable'));
            await this.#synchronizeDirectory(attemptPaths.attempt);
            return 'replayed' as const;
          }
          await writeMarker(
            attemptPaths.deliveryMarker,
            attemptPaths.deliveryMarkerPart,
            expected,
            attemptPaths.attempt,
            this.#synchronizeDirectory.bind(this),
          );
          return 'registered' as const;
        },
      )
    ));
  }

  listDueAttemptDeliveries(
    options: Readonly<{
      readonly after?: ProductionCheckpointDeliveryCursor;
      readonly expiredBefore: CollabIsoTimestamp;
      readonly limit?: number;
    }>,
    signal?: AbortSignal,
  ): Promise<ProductionCheckpointDeliveryPage> {
    let expiredBefore: CollabIsoTimestamp;
    let after: ProductionCheckpointDeliveryCursor | undefined;
    let limit: number;
    try {
      expiredBefore = options.expiredBefore;
      const inputAfter = options.after;
      after = inputAfter === undefined ? undefined : Object.freeze({
        expiresAt: inputAfter.expiresAt,
        operationId: inputAfter.operationId,
        projectId: inputAfter.projectId,
      });
      limit = options.limit ?? 100;
      if (
        !canonicalTimestamp(expiredBefore)
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > 100
        || (
          after !== undefined
          && (
            !canonicalTimestamp(after.expiresAt)
            || !isCollabOpaqueId(after.operationId)
            || !isCollabProjectId(after.projectId)
          )
        )
      ) fail('invalid-attempt');
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProductionCheckpointStagingError
          ? error
          : new ProductionCheckpointStagingError('invalid-attempt'),
      );
    }
    return this.#runOperation(signal, async operationSignal => {
      assertNotAborted(operationSignal);
      await assertPrivateDirectory(this.#stagingRoot);
      const productionRoot = join(this.#stagingRoot, PRODUCTION_DIRECTORY);
      if (!await privateDirectoryExists(productionRoot)) {
        return Object.freeze({
          deliveries: Object.freeze([]),
          nextCursor: undefined,
        });
      }
      const deliveries: PreparedProductionCheckpointAttempt[] = [];
      let directory: Awaited<ReturnType<typeof opendir>> | undefined;
      try {
        directory = await opendir(productionRoot);
        for await (const directoryEntry of directory) {
          const entry = directoryEntry.name;
          assertNotAborted(operationSignal);
          if (!SHA256_PATTERN.test(entry)) fail('artifact-conflict');
          const attemptRoot = join(productionRoot, entry);
          await assertPrivateDirectory(attemptRoot);
          const attemptPaths = Object.freeze({
            attempt: attemptRoot,
            deliveryMarker: join(attemptRoot, DELIVERY_MARKER),
            deliveryMarkerPart: join(attemptRoot, `.${DELIVERY_MARKER}.part`),
            ownerMarker: join(attemptRoot, ATTEMPT_MARKER),
            ownerMarkerPart: join(attemptRoot, `.${ATTEMPT_MARKER}.part`),
            productionRoot,
          });
          let marker = await readBoundedText(attemptPaths.deliveryMarker);
          if (marker === undefined) {
            const partial = await readBoundedText(
              attemptPaths.deliveryMarkerPart,
            );
            if (partial === undefined) continue;
            const parsed = parseDeliveryMarker(partial);
            if (
              parsed.stored.attemptKey !== entry
              || await readBoundedText(attemptPaths.ownerMarker)
                !== attemptMarkerJson(parsed.stored)
            ) fail('artifact-conflict');
            assertNotAborted(operationSignal);
            await rename(
              attemptPaths.deliveryMarkerPart,
              attemptPaths.deliveryMarker,
            ).catch(() => fail('storage-unavailable'));
            await this.#synchronizeDirectory(attemptRoot);
            marker = partial;
          }
          const parsed = parseDeliveryMarker(marker);
          if (
            parsed.stored.attemptKey !== entry
            || await readBoundedText(attemptPaths.ownerMarker)
              !== attemptMarkerJson(parsed.stored)
          ) fail('artifact-conflict');
          if (
            parsed.delivery.expiresAt <= expiredBefore
            && deliveryCursorAfter(parsed.delivery, after)
          ) {
            deliveries.push(parsed.delivery);
            deliveries.sort(compareDeliveryIdentity);
            if (deliveries.length > limit + 1) deliveries.pop();
          }
        }
      } catch (error: unknown) {
        if (error instanceof ProductionCheckpointStagingError) throw error;
        return fail('storage-unavailable');
      }
      const page = deliveries.slice(0, limit);
      const last = page.at(-1);
      return Object.freeze({
        deliveries: Object.freeze(page),
        nextCursor: deliveries.length > limit && last !== undefined
          ? Object.freeze({
            expiresAt: last.expiresAt,
            operationId: last.operationId,
            projectId: last.projectId,
          })
          : undefined,
      });
    });
  }

  async #drainClose(): Promise<void> {
    const deadline = Date.now() + this.#streamSettlementTimeoutMs;
    while (this.#running.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail('timeout');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.#running]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new ProductionCheckpointStagingError('timeout'));
            }, remaining);
            timeout.unref();
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
    this.#releaseAllAttemptReservations();
  }

  async #releaseReservationsAfterQuiescence(): Promise<void> {
    while (this.#running.size > 0) {
      await Promise.allSettled([...this.#running]);
    }
    this.#releaseAllAttemptReservations();
  }

  #releaseAllAttemptReservations(): void {
    for (const reservation of this.#attemptReservations.values()) {
      reservation.release();
    }
    this.#attemptReservations.clear();
  }

  prepareAttempt(
    input: PrepareProductionCheckpointAttemptInput,
    signal?: AbortSignal,
  ): Promise<PreparedProductionCheckpointAttempt> {
    let snapshot: PrepareProductionCheckpointAttemptInput;
    try {
      snapshot = snapshotPrepareInput(input);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProductionCheckpointStagingError
          ? error
          : new ProductionCheckpointStagingError('invalid-attempt'),
      );
    }
    return this.#runOperation(signal, operationSignal => {
      return this.#withAttemptControl(
        attemptKey(snapshot.projectId, snapshot.operationId),
        operationSignal,
        async () => {
          const attempt = freezeAttempt(snapshot);
          this.#assertNotExpired(attempt);
          await this.#ensureAttemptReservation(attempt, operationSignal);
          return this.#prepareAttempt(snapshot, operationSignal);
        },
      );
    });
  }

  async #prepareAttempt(
    input: PrepareProductionCheckpointAttemptInput,
    signal: AbortSignal,
  ): Promise<PreparedProductionCheckpointAttempt> {
    const attempt = freezeAttempt(input);
    if (input.expiresAt <= this.#timestamp()) fail('expired');
    const attemptPaths = paths(
      this.#stagingRoot,
      input.projectId,
      input.operationId,
    );
    await this.#ensureProductionRoot(attemptPaths, signal);
    const exists = await privateDirectoryExists(attemptPaths.attempt);
    if (!exists) {
      assertNotAborted(signal);
      try {
        await mkdir(attemptPaths.attempt, { mode: DIRECTORY_MODE });
        await this.#synchronizeDirectory(attemptPaths.productionRoot);
      } catch (error: unknown) {
        if (!hasErrorCode(error, 'EEXIST')) fail('storage-unavailable');
      }
    }
    await assertPrivateDirectory(attemptPaths.attempt);
    const expected = attemptMarkerJson(attempt);
    const existing = await readBoundedText(attemptPaths.ownerMarker);
    if (existing !== undefined) {
      if (existing !== expected) fail('artifact-conflict');
      await removeOwnedFile(attemptPaths.ownerMarkerPart);
      await this.#synchronizeDirectory(attemptPaths.attempt);
      return attempt;
    }
    const entries = await this.#readDirectory(attemptPaths.attempt);
    const markerPart = await readBoundedText(attemptPaths.ownerMarkerPart);
    if (markerPart !== undefined) {
      if (
        entries.length !== 1
        || entries[0] !== `.${ATTEMPT_MARKER}.part`
        || markerPart !== expected
      ) {
        fail('artifact-conflict');
      }
      assertNotAborted(signal);
      try {
        await rename(
          attemptPaths.ownerMarkerPart,
          attemptPaths.ownerMarker,
        );
        await this.#synchronizeDirectory(attemptPaths.attempt);
      } catch (error: unknown) {
        if (error instanceof ProductionCheckpointStagingError) throw error;
        fail('storage-unavailable');
      }
      return attempt;
    }
    if (entries.length !== 0) fail('artifact-conflict');
    assertNotAborted(signal);
    await writeMarker(
      attemptPaths.ownerMarker,
      attemptPaths.ownerMarkerPart,
      expected,
      attemptPaths.attempt,
      path => this.#synchronizeDirectory(path),
    );
    return attempt;
  }

  receiveArtifact(
    input: ReceiveProductionCheckpointArtifactInput,
  ): Promise<StagedProductionCheckpointArtifact> {
    try {
      const attempt = snapshotAttempt(input.attempt);
      const artifact = input.artifact;
      const expectedByteCount = input.expectedByteCount;
      const expectedSha256 = input.expectedSha256;
      const body = input.body;
      const iteratorFactory = body[Symbol.asyncIterator];
      const externalSignal = input.signal;
      if (
        !isArtifact(artifact)
        || !Number.isSafeInteger(expectedByteCount)
        || expectedByteCount <= 0
        || expectedByteCount > artifactLimit(artifact)
        || !SHA256_PATTERN.test(expectedSha256)
        || typeof iteratorFactory !== 'function'
      ) {
        fail('invalid-attempt');
      }
      const bodySnapshot = Object.freeze({
        [Symbol.asyncIterator]: iteratorFactory.bind(body),
      });
      const snapshot = Object.freeze({
        artifact,
        attempt,
        body: bodySnapshot,
        expectedByteCount,
        expectedSha256,
        ...(externalSignal === undefined ? {} : { signal: externalSignal }),
      });
      return this.#runAttemptOperation(
        attempt,
        externalSignal,
        signal => this.#receiveArtifact(snapshot, signal),
      );
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProductionCheckpointStagingError
          ? error
          : new ProductionCheckpointStagingError('invalid-attempt'),
      );
    }
  }

  async #receiveArtifact(
    input: ReceiveProductionCheckpointArtifactInput,
    signal: AbortSignal,
  ): Promise<StagedProductionCheckpointArtifact> {
    this.#assertNotExpired(input.attempt);
    let permit: CheckpointStreamPermit | undefined;
    try {
      try {
        permit = await this.#admission.acquire({
          artifact: input.artifact,
          direction: 'upload',
          expectedByteCount: input.expectedByteCount,
          operationId: input.attempt.operationId,
          projectId: input.attempt.projectId,
          signal,
        });
      } catch (error: unknown) {
        if (error instanceof CheckpointStreamAdmissionError) mapAdmission(error);
        return fail('storage-unavailable');
      }
      const attemptPaths = await this.#assertOwnedAttempt(
        input.attempt,
        signal,
      );
      const target = artifactPaths(attemptPaths.attempt, input.artifact);
      const fact = Object.freeze({
        attemptKey: input.attempt.attemptKey,
        byteCount: input.expectedByteCount,
        name: input.artifact,
        operationId: input.attempt.operationId,
        projectId: input.attempt.projectId,
        sha256: input.expectedSha256,
      });
      const markerJson = artifactMarkerJson(fact);
      const existingMarker = await readBoundedText(target.marker);
      if (existingMarker !== undefined) {
        if (existingMarker !== markerJson) fail('artifact-conflict');
        await this.#verifyArtifactFile(target.artifact, fact, signal);
        await removeOwnedFile(target.markerPart);
        await removeOwnedFile(target.artifactPart);
        await this.#synchronizeDirectory(attemptPaths.attempt);
        return fact;
      }
      if (await pathExists(target.artifact)) {
        await this.#verifyArtifactFile(target.artifact, fact, signal);
        await writeMarker(
          target.marker,
          target.markerPart,
          markerJson,
          attemptPaths.attempt,
          path => this.#synchronizeDirectory(path),
        );
        return fact;
      }
      await removeOwnedFile(target.artifactPart);
      const deadline = Date.now() + this.#totalTimeoutMs;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      const digest = createHash('sha256');
      let byteCount = 0;
      let iterator: AsyncIterator<unknown> | undefined;
      try {
        try {
          iterator = input.body[Symbol.asyncIterator]();
          if (typeof iterator.next !== 'function') fail('input-limit');
        } catch (error: unknown) {
          if (error instanceof ProductionCheckpointStagingError) throw error;
          fail('input-limit');
        }
        handle = await open(target.artifactPart, 'wx', FILE_MODE);
        for (;;) {
          const next = await this.#raceDeadline(iterator.next(), signal, deadline);
          if (next.done) break;
          if (
            !(next.value instanceof Uint8Array)
            || !ArrayBuffer.isView(next.value)
          ) {
            fail('input-limit');
          }
          const chunkBytes = next.value.byteLength;
          if (chunkBytes === 0) continue;
          if (chunkBytes > input.expectedByteCount - byteCount) {
            fail('input-limit');
          }
          const chunk = Buffer.from(next.value);
          if (chunk.length !== chunkBytes) fail('input-limit');
          permit.consume(chunkBytes);
          byteCount += chunkBytes;
          digest.update(chunk);
          await handle.writeFile(chunk);
        }
        if (byteCount !== input.expectedByteCount) fail('input-limit');
        if (digest.digest('hex') !== input.expectedSha256) {
          fail('digest-mismatch');
        }
        assertNotAborted(signal);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(target.artifactPart, target.artifact);
        await this.#synchronizeDirectory(attemptPaths.attempt);
        await writeMarker(
          target.marker,
          target.markerPart,
          markerJson,
          attemptPaths.attempt,
          path => this.#synchronizeDirectory(path),
        );
        return fact;
      } catch (error: unknown) {
        await handle?.close().catch(() => undefined);
        if (iterator !== undefined) {
          await containIteratorSettlement(
            iterator,
            this.#streamSettlementTimeoutMs,
          );
        }
        await rm(target.artifactPart, { force: true }).catch(() => undefined);
        await this.#synchronizeDirectory(attemptPaths.attempt).catch(
          () => undefined,
        );
        if (error instanceof ProductionCheckpointStagingError) throw error;
        if (error instanceof CheckpointStreamAdmissionError) mapAdmission(error);
        assertNotAborted(signal);
        return fail('storage-unavailable');
      }
    } finally {
      permit?.release();
    }
  }

  inspectAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<InspectedProductionCheckpointAttempt> {
    let snapshot: PreparedProductionCheckpointAttempt;
    try {
      snapshot = snapshotAttempt(attempt);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProductionCheckpointStagingError
          ? error
          : new ProductionCheckpointStagingError('invalid-attempt'),
      );
    }
    return this.#runAttemptOperation(
      snapshot,
      signal,
      operationSignal => {
        return this.#withAttemptControl(
          snapshot.attemptKey,
          operationSignal,
          () => this.#inspectAttempt(snapshot, operationSignal),
        );
      },
    );
  }

  async #inspectAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal: AbortSignal,
  ): Promise<InspectedProductionCheckpointAttempt> {
    const attemptPaths = await this.#assertOwnedAttempt(attempt, signal);
    const artifacts: StagedProductionCheckpointArtifact[] = [];
    for (const name of COLLAB_PROJECT_CHECKPOINT_ARTIFACTS) {
      assertNotAborted(signal);
      const target = artifactPaths(attemptPaths.attempt, name);
      const marker = await readBoundedText(target.marker);
      if (marker === undefined) {
        if (await pathExists(target.artifact)) fail('artifact-conflict');
        continue;
      }
      const artifact = parseArtifactMarker(marker, attempt, name);
      await this.#assertArtifactFileSize(target.artifact, artifact.byteCount);
      artifacts.push(artifact);
    }
    return Object.freeze({
      artifacts: Object.freeze(artifacts),
      attempt,
    });
  }

  readArtifact(input: ReadProductionCheckpointArtifactInput): Promise<void> {
    try {
      const attempt = snapshotAttempt(input.attempt);
      const artifact = snapshotArtifact(input.artifact, attempt);
      const onChunk = input.onChunk;
      const externalSignal = input.signal;
      if (typeof onChunk !== 'function') fail('invalid-attempt');
      const snapshot = Object.freeze({
        artifact,
        attempt,
        onChunk,
        ...(externalSignal === undefined ? {} : { signal: externalSignal }),
      });
      return this.#runAttemptOperation(
        attempt,
        externalSignal,
        signal => this.#readArtifact(snapshot, signal),
      );
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProductionCheckpointStagingError
          ? error
          : new ProductionCheckpointStagingError('invalid-attempt'),
      );
    }
  }

  async #readArtifact(
    input: ReadProductionCheckpointArtifactInput,
    signal: AbortSignal,
  ): Promise<void> {
    this.#assertNotExpired(input.attempt);
    let permit: CheckpointStreamPermit | undefined;
    try {
      try {
        permit = await this.#admission.acquire({
          artifact: input.artifact.name,
          direction: 'download',
          expectedByteCount: input.artifact.byteCount,
          operationId: input.attempt.operationId,
          projectId: input.attempt.projectId,
          signal,
        });
      } catch (error: unknown) {
        if (error instanceof CheckpointStreamAdmissionError) mapAdmission(error);
        fail('storage-unavailable');
      }
      const attemptPaths = await this.#assertOwnedAttempt(
        input.attempt,
        signal,
      );
      const target = artifactPaths(
        attemptPaths.attempt,
        input.artifact.name,
      );
      const marker = await readBoundedText(target.marker);
      if (marker !== artifactMarkerJson(input.artifact)) {
        fail('artifact-conflict');
      }
      const deadline = Date.now() + this.#totalTimeoutMs;
      const deliveryController = new AbortController();
      const onOperationAbort = (): void => {
        deliveryController.abort(signal.reason);
      };
      signal.addEventListener('abort', onOperationAbort, { once: true });
      if (signal.aborted) onOperationAbort();
      let delivery: Promise<void> | undefined;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(
          target.artifact,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        await this.#hashOpenFile(
          handle,
          input.artifact,
          signal,
          deadline,
        );
        const digest = createHash('sha256');
        let position = 0;
        while (position < input.artifact.byteCount) {
          assertNotAborted(signal);
          const buffer = Buffer.allocUnsafe(Math.min(
            ARTIFACT_READ_BUFFER_BYTES,
            input.artifact.byteCount - position,
          ));
          const result = await this.#raceDeadline(
            handle.read(buffer, 0, buffer.length, position),
            signal,
            deadline,
          );
          if (result.bytesRead <= 0) fail('artifact-conflict');
          const chunk = buffer.subarray(0, result.bytesRead);
          permit.consume(chunk.length);
          digest.update(chunk);
          delivery = Promise.resolve().then(() => (
            input.onChunk(chunk, deliveryController.signal)
          ));
          try {
            await this.#raceDeadline(delivery, signal, deadline);
          } catch (error: unknown) {
            deliveryController.abort(
              error instanceof ProductionCheckpointStagingError
                && error.code === 'timeout'
                ? 'timeout'
                : signal.reason ?? 'failed',
            );
            const settled = await this.#settleDelivery(delivery);
            if (!settled) {
              this.#retainDelivery(
                input.attempt.attemptKey,
                delivery,
                permit,
              );
              permit = undefined;
            }
            throw error;
          }
          delivery = undefined;
          position += chunk.length;
        }
        if (digest.digest('hex') !== input.artifact.sha256) {
          fail('artifact-conflict');
        }
        await this.#assertOpenFileSize(handle, input.artifact.byteCount);
      } catch (error: unknown) {
        if (error instanceof ProductionCheckpointStagingError) throw error;
        if (error instanceof CheckpointStreamAdmissionError) mapAdmission(error);
        assertNotAborted(signal);
        if (hasErrorCode(error, 'ELOOP')) fail('artifact-conflict');
        fail('storage-unavailable');
      } finally {
        signal.removeEventListener('abort', onOperationAbort);
        await handle?.close().catch(() => undefined);
      }
    } finally {
      permit?.release();
    }
  }

  discardAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    let snapshot: PreparedProductionCheckpointAttempt;
    try {
      snapshot = snapshotAttempt(attempt);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProductionCheckpointStagingError
          ? error
          : new ProductionCheckpointStagingError('invalid-attempt'),
      );
    }
    return this.#runOperation(signal, async operationSignal => {
      return this.#withAttemptControl(
        snapshot.attemptKey,
        operationSignal,
        async () => {
          this.#settlingAttempts.add(snapshot.attemptKey);
          try {
            const active = this.#activeAttempts.get(snapshot.attemptKey);
            if (active !== undefined) {
              active.controller.abort('cancelled');
              await active.settled;
            }
            if (this.#retainedAttempts.has(snapshot.attemptKey)) fail('busy');
            const result = await this.#discardAttempt(
              snapshot,
              operationSignal,
            );
            this.#releaseAttemptReservation(snapshot.attemptKey);
            return result;
          } finally {
            this.#settlingAttempts.delete(snapshot.attemptKey);
          }
        },
      );
    });
  }

  async #discardAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    const attemptPaths = paths(
      this.#stagingRoot,
      attempt.projectId,
      attempt.operationId,
    );
    await assertPrivateDirectory(this.#stagingRoot);
    if (!await privateDirectoryExists(attemptPaths.productionRoot)) {
      await this.#synchronizeDirectory(this.#stagingRoot);
      return 'replayed';
    }
    if (!await privateDirectoryExists(attemptPaths.attempt)) {
      await this.#synchronizeDirectory(attemptPaths.productionRoot);
      return 'replayed';
    }
    let marker = await readBoundedText(attemptPaths.ownerMarker);
    if (marker === undefined) {
      const markerPart = await readBoundedText(attemptPaths.ownerMarkerPart);
      if (markerPart === undefined) {
        const entries = await this.#readDirectory(attemptPaths.attempt);
        if (entries.length !== 0) fail('artifact-conflict');
        assertNotAborted(signal);
        await this.#removeEmptyAttempt(attemptPaths);
        return 'removed';
      }
      const entries = await this.#readDirectory(attemptPaths.attempt);
      if (
        entries.length !== 1
        || entries[0] !== `.${ATTEMPT_MARKER}.part`
        || markerPart !== attemptMarkerJson(attempt)
      ) {
        fail('artifact-conflict');
      }
      assertNotAborted(signal);
      try {
        await rename(
          attemptPaths.ownerMarkerPart,
          attemptPaths.ownerMarker,
        );
        await this.#synchronizeDirectory(attemptPaths.attempt);
      } catch (error: unknown) {
        if (error instanceof ProductionCheckpointStagingError) throw error;
        fail('storage-unavailable');
      }
      marker = markerPart;
    }
    if (marker !== attemptMarkerJson(attempt)) fail('artifact-conflict');
    const allowed = new Set<string>([
      ATTEMPT_MARKER,
      `.${ATTEMPT_MARKER}.part`,
      DELIVERY_MARKER,
      `.${DELIVERY_MARKER}.part`,
    ]);
    for (const name of COLLAB_PROJECT_CHECKPOINT_ARTIFACTS) {
      const target = artifactPaths(attemptPaths.attempt, name);
      for (const path of [
        target.artifact,
        target.artifactPart,
        target.marker,
        target.markerPart,
      ]) {
        allowed.add(path.slice(attemptPaths.attempt.length + 1));
      }
    }
    const entries = await this.#readDirectory(attemptPaths.attempt);
    if (entries.some(entry => !allowed.has(entry))) fail('artifact-conflict');
    for (const name of COLLAB_PROJECT_CHECKPOINT_ARTIFACTS) {
      const target = artifactPaths(attemptPaths.attempt, name);
      for (const path of [
        target.artifactPart,
        target.artifact,
        target.markerPart,
        target.marker,
      ]) {
        assertNotAborted(signal);
        await removeOwnedFile(path);
      }
    }
    for (const path of [
      attemptPaths.deliveryMarkerPart,
      attemptPaths.deliveryMarker,
    ]) {
      assertNotAborted(signal);
      await removeOwnedFile(path);
    }
    await removeOwnedFile(attemptPaths.ownerMarkerPart);
    await this.#synchronizeDirectory(attemptPaths.attempt);
    const remaining = await this.#readDirectory(attemptPaths.attempt);
    if (
      remaining.length !== 1
      || remaining[0] !== ATTEMPT_MARKER
    ) {
      fail('artifact-conflict');
    }
    assertNotAborted(signal);
    await removeOwnedFile(attemptPaths.ownerMarker);
    await this.#synchronizeDirectory(attemptPaths.attempt);
    await this.#removeEmptyAttempt(attemptPaths);
    return 'removed';
  }

  expireAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    expiredBefore: CollabIsoTimestamp,
    signal?: AbortSignal,
  ): Promise<'expired' | 'replayed' | 'retained'> {
    let snapshot: PreparedProductionCheckpointAttempt;
    try {
      snapshot = snapshotAttempt(attempt);
      if (!canonicalTimestamp(expiredBefore)) fail('invalid-attempt');
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProductionCheckpointStagingError
          ? error
          : new ProductionCheckpointStagingError('invalid-attempt'),
      );
    }
    return this.#runOperation(signal, operationSignal => (
      this.#withAttemptControl(
        snapshot.attemptKey,
        operationSignal,
        async () => {
          if (snapshot.expiresAt > expiredBefore) return 'retained';
          this.#settlingAttempts.add(snapshot.attemptKey);
          try {
            const active = this.#activeAttempts.get(snapshot.attemptKey);
            if (active !== undefined) {
              active.controller.abort('cancelled');
              await active.settled;
            }
            if (this.#retainedAttempts.has(snapshot.attemptKey)) fail('busy');
            const result = await this.#discardAttempt(
              snapshot,
              operationSignal,
            );
            this.#releaseAttemptReservation(snapshot.attemptKey);
            return result === 'removed' ? 'expired' : 'replayed';
          } finally {
            this.#settlingAttempts.delete(snapshot.attemptKey);
          }
        },
      )
    ));
  }

  #runOperation<Result>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new ProductionCheckpointStagingError('closed'));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort('cancelled');
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted === true) onAbort();
    this.#controllers.add(controller);
    const result = Promise.resolve().then(() => operation(controller.signal));
    const finalized = result.finally(() => {
      externalSignal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      this.#running.delete(tracked);
    });
    const tracked = finalized.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    return finalized;
  }

  #runAttemptOperation<Result>(
    attempt: PreparedProductionCheckpointAttempt,
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new ProductionCheckpointStagingError('closed'));
    }
    if (this.#activeAttempts.has(attempt.attemptKey)) {
      return Promise.reject(new ProductionCheckpointStagingError('busy'));
    }
    if (this.#settlingAttempts.has(attempt.attemptKey)) {
      return Promise.reject(new ProductionCheckpointStagingError('busy'));
    }
    if (this.#retainedAttempts.has(attempt.attemptKey)) {
      return Promise.reject(new ProductionCheckpointStagingError('busy'));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort('cancelled');
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted === true) onAbort();
    this.#controllers.add(controller);
    const result = Promise.resolve().then(() => operation(controller.signal));
    const finalized = result.finally(() => {
      externalSignal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      this.#running.delete(tracked);
      if (this.#activeAttempts.get(attempt.attemptKey) === active) {
        this.#activeAttempts.delete(attempt.attemptKey);
      }
    });
    const tracked = finalized.then(() => undefined, () => undefined);
    const active = Object.freeze({ controller, settled: tracked });
    this.#activeAttempts.set(attempt.attemptKey, active);
    this.#running.add(tracked);
    return finalized;
  }

  async #settleDelivery(delivery: Promise<void>): Promise<boolean> {
    let settled = false;
    const observed = delivery.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        observed,
        new Promise<void>(resolve => {
          timeout = setTimeout(resolve, this.#streamSettlementTimeoutMs);
          timeout.unref();
        }),
      ]);
      return settled;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  #retainDelivery(
    attemptKey: string,
    delivery: Promise<void>,
    permit: CheckpointStreamPermit,
  ): void {
    this.#retainedAttempts.add(attemptKey);
    const tracked = delivery.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.#retainedAttempts.delete(attemptKey);
      this.#running.delete(tracked);
      permit.release();
    });
    this.#running.add(tracked);
  }

  async #ensureAttemptReservation(
    attempt: PreparedProductionCheckpointAttempt,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#attemptReservations.has(attempt.attemptKey)) return;
    let reservation: CheckpointStagingReservation;
    try {
      reservation = await this.#admission.reserveAttempt({
        operationId: attempt.operationId,
        projectId: attempt.projectId,
        signal,
      });
    } catch (error: unknown) {
      if (error instanceof CheckpointStreamAdmissionError) mapAdmission(error);
      fail('storage-unavailable');
    }
    this.#attemptReservations.set(attempt.attemptKey, reservation);
  }

  #releaseAttemptReservation(attemptKey: string): void {
    const reservation = this.#attemptReservations.get(attemptKey);
    if (reservation === undefined) return;
    this.#attemptReservations.delete(attemptKey);
    reservation.release();
  }

  async #ensureProductionRoot(
    attemptPaths: AttemptPaths,
    signal: AbortSignal,
  ): Promise<void> {
    await assertPrivateDirectory(this.#stagingRoot);
    if (!await privateDirectoryExists(attemptPaths.productionRoot)) {
      assertNotAborted(signal);
      try {
        await mkdir(attemptPaths.productionRoot, { mode: DIRECTORY_MODE });
        await this.#synchronizeDirectory(this.#stagingRoot);
      } catch (error: unknown) {
        if (!hasErrorCode(error, 'EEXIST')) fail('storage-unavailable');
      }
    }
    await assertPrivateDirectory(attemptPaths.productionRoot);
  }

  async #assertOwnedAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal: AbortSignal,
  ): Promise<AttemptPaths> {
    assertAttempt(attempt);
    assertNotAborted(signal);
    await assertPrivateDirectory(this.#stagingRoot);
    const attemptPaths = paths(
      this.#stagingRoot,
      attempt.projectId,
      attempt.operationId,
    );
    await assertPrivateDirectory(attemptPaths.productionRoot);
    await assertPrivateDirectory(attemptPaths.attempt);
    const marker = await readBoundedText(attemptPaths.ownerMarker);
    if (marker !== attemptMarkerJson(attempt)) fail('artifact-conflict');
    return attemptPaths;
  }

  async #verifyArtifactFile(
    path: string,
    artifact: StagedProductionCheckpointArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.#totalTimeoutMs;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      await this.#hashOpenFile(handle, artifact, signal, deadline);
    } catch (error: unknown) {
      if (error instanceof ProductionCheckpointStagingError) throw error;
      assertNotAborted(signal);
      if (hasErrorCode(error, 'ELOOP')) fail('artifact-conflict');
      fail('storage-unavailable');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #hashOpenFile(
    handle: Awaited<ReturnType<typeof open>>,
    artifact: StagedProductionCheckpointArtifact,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    await this.#assertOpenFileSize(handle, artifact.byteCount);
    const digest = createHash('sha256');
    let position = 0;
    while (position < artifact.byteCount) {
      assertNotAborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(
        ARTIFACT_READ_BUFFER_BYTES,
        artifact.byteCount - position,
      ));
      const result = await this.#raceDeadline(
        handle.read(buffer, 0, buffer.length, position),
        signal,
        deadline,
      );
      if (result.bytesRead <= 0) fail('artifact-conflict');
      digest.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    if (digest.digest('hex') !== artifact.sha256) fail('artifact-conflict');
    await this.#assertOpenFileSize(handle, artifact.byteCount);
  }

  async #assertArtifactFileSize(path: string, expected: number): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      await this.#assertOpenFileSize(handle, expected);
    } catch (error: unknown) {
      if (error instanceof ProductionCheckpointStagingError) throw error;
      if (hasErrorCode(error, 'ELOOP') || hasErrorCode(error, 'ENOENT')) {
        fail('artifact-conflict');
      }
      fail('storage-unavailable');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #assertOpenFileSize(
    handle: Awaited<ReturnType<typeof open>>,
    expected: number,
  ): Promise<void> {
    const entry = await handle.stat();
    assertPrivateFileEntry(entry);
    if (entry.size !== expected) fail('artifact-conflict');
  }

  async #withAttemptControl<Result>(
    key: string,
    signal: AbortSignal,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#controlTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.#controlTails.set(key, tail);
    try {
      await this.#raceCancellation(previous, signal);
      assertNotAborted(signal);
      return await operation();
    } finally {
      release();
      if (this.#controlTails.get(key) === tail) this.#controlTails.delete(key);
    }
  }

  async #raceCancellation<Result>(
    operation: Promise<Result>,
    signal: AbortSignal,
  ): Promise<Result> {
    assertNotAborted(signal);
    let abortListener: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(abortError(signal));
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

  async #raceDeadline<Result>(
    operation: Promise<Result>,
    signal: AbortSignal,
    deadline: number,
  ): Promise<Result> {
    assertNotAborted(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('timeout');
    let abortListener: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(abortError(signal));
          signal.addEventListener('abort', abortListener, { once: true });
          if (signal.aborted) abortListener();
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new ProductionCheckpointStagingError('timeout'));
          }, Math.min(this.#idleTimeoutMs, remaining));
          timeout.unref();
        }),
      ]);
    } finally {
      if (abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener);
      }
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async #removeEmptyAttempt(attemptPaths: AttemptPaths): Promise<void> {
    try {
      await rmdir(attemptPaths.attempt);
      await this.#synchronizeDirectory(attemptPaths.productionRoot);
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        await this.#synchronizeDirectory(attemptPaths.productionRoot);
        return;
      }
      fail('storage-unavailable');
    }
  }

  async #readDirectory(path: string): Promise<string[]> {
    try {
      return (await readdir(path, { encoding: 'utf8' }))
        .sort((left, right) => left.localeCompare(right, 'en-US'));
    } catch {
      fail('storage-unavailable');
    }
  }

  async #synchronizeDirectory(path: string): Promise<void> {
    try {
      await this.#syncDirectory(path);
    } catch {
      fail('storage-unavailable');
    }
  }

  #assertNotExpired(attempt: PreparedProductionCheckpointAttempt): void {
    if (attempt.expiresAt <= this.#timestamp()) fail('expired');
  }

  #timestamp(): CollabIsoTimestamp {
    const value = this.#clock();
    if (Number.isNaN(value.valueOf())) {
      throw new TypeError('production-checkpoint-staging.clock-invalid');
    }
    return value.toISOString();
  }
}
