import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { getuid } from 'node:process';

import {
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabCheckpointGitRef,
  type CollabCheckpointObjectFormat,
  type CollabProjectId,
  type DevelopmentBootstrapGitRef,
  type DevelopmentBootstrapObjectFormat,
} from '@claudian-collab/protocol';

import {
  BootstrapUploadAdmissionError,
  type BootstrapUploadAdmission,
  type BootstrapUploadPermit,
} from '../resource-admission/BootstrapUploadAdmission.js';
import {
  ResourceAdmissionError,
  type GitChildPermit,
  type ResourceAdmission,
} from '../resource-admission/ResourceAdmission.js';
import {
  GitProcessError,
  GitProcessSupervisor,
} from './GitProcessSupervisor.js';
import {
  DurableTreeRemovalError,
  removeDurableOwnedTree,
} from './DurableTreeRemoval.js';

export type GitBundleImportErrorCode =
  | 'artifact-conflict'
  | 'artifact-invalid'
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'digest-mismatch'
  | 'git-unavailable'
  | 'output-limit'
  | 'process-failed'
  | 'repository-invalid'
  | 'repository-limit'
  | 'storage-unavailable'
  | 'timeout'
  | 'unsupported-git';

export class GitBundleImportError extends Error {
  readonly code: GitBundleImportErrorCode;
  readonly retryable: boolean;

  constructor(code: GitBundleImportErrorCode) {
    super(`git-bundle-import.error.${code}`);
    this.name = 'GitBundleImportError';
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

export interface GitBundleImporterOptions {
  readonly createBundleReadStream?: (
    path: string,
    signal: AbortSignal,
  ) => AsyncIterable<unknown>;
  readonly gitExecutable: string;
  readonly maximumBlobBytes: number;
  readonly maximumBundleBytes: number;
  readonly maximumExpandedTreeEntries: number;
  readonly maximumMetadataOutputBytes: number;
  readonly maximumRepositoryBytes: number;
  readonly maximumTreeEntries: number;
  readonly operationTimeoutMs: number;
  readonly removeTree?: (path: string) => Promise<void>;
  readonly resourceAdmission: ResourceAdmission;
  readonly stagingRoot: string;
  readonly syncDirectory?: (path: string) => Promise<void>;
  readonly uploadAdmission: BootstrapUploadAdmission;
  readonly uploadIdleTimeoutMs: number;
  readonly uploadTotalTimeoutMs: number;
}

export interface ImportGitBundleInput {
  readonly attemptId: string;
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentEncoding: string;
  readonly contentLength?: number;
  readonly contentType: string;
  readonly declaredByteCount: number;
  readonly declaredSha256: string;
  readonly expectedByteCount: number;
  readonly expectedSha256: string;
  readonly objectFormat: DevelopmentBootstrapObjectFormat;
  readonly projectId: CollabProjectId;
  readonly refs: readonly DevelopmentBootstrapGitRef[];
  readonly signal?: AbortSignal;
}

export interface ImportRepositoryCheckpointInput {
  readonly body: AsyncIterable<Uint8Array>;
  readonly expectedByteCount: number;
  readonly expectedSha256: string;
  readonly objectFormat: CollabCheckpointObjectFormat;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly signal?: AbortSignal;
}

export interface ValidatedRepositoryCheckpoint {
  readonly artifactKey: string;
  readonly bundleByteCount: number;
  readonly bundleInputDisposition: 'consumed' | 'replayed';
  readonly bundleSha256: string;
  readonly markerSha256: string;
  readonly objectFormat: CollabCheckpointObjectFormat;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly refs: readonly CollabCheckpointGitRef[];
}

export interface DiscardRepositoryCheckpointInput {
  readonly operationId: string;
  readonly projectId: CollabProjectId;
}

export interface RepositoryCheckpointStagingPort {
  discardCheckpoint(
    input: DiscardRepositoryCheckpointInput,
  ): Promise<'removed' | 'replayed'>;
  importCheckpoint(
    input: ImportRepositoryCheckpointInput,
  ): Promise<ValidatedRepositoryCheckpoint>;
}

export type RepositoryRestoreStagingPort = RepositoryCheckpointStagingPort;

export interface ValidatedBootstrapRepository {
  readonly artifactKey: string;
  readonly attemptId: string;
  readonly bundleByteCount: number;
  readonly bundleSha256: string;
  readonly markerSha256: string;
  readonly objectFormat: DevelopmentBootstrapObjectFormat;
  readonly projectId: CollabProjectId;
  readonly refs: readonly DevelopmentBootstrapGitRef[];
}

export interface DiscardBootstrapAttemptInput {
  readonly attemptId: string;
  readonly projectId: CollabProjectId;
}

interface StagingPaths {
  readonly attempt: string;
  readonly attemptParent: string;
  readonly attemptMarker: string;
  readonly attemptMarkerPart: string;
  readonly bundle: string;
  readonly bundlePart: string;
  readonly marker: string;
  readonly markerPart: string;
  readonly project: string;
  readonly repository: string;
}

type StagingProfile = 'bootstrap' | 'checkpoint';

interface CompletedImport {
  readonly bundleInputDisposition: 'consumed' | 'replayed';
  readonly repository: ValidatedBootstrapRepository;
}

interface ObjectInventoryEntry {
  readonly oid: string;
  readonly size: number;
  readonly type: string;
}

interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

interface ValidationMarker {
  readonly artifactKey: string;
  readonly attemptId: string;
  readonly bundleByteCount: number;
  readonly bundleSha256: string;
  readonly objectFormat: DevelopmentBootstrapObjectFormat;
  readonly policy: {
    readonly maximumBlobBytes: number;
    readonly maximumExpandedTreeEntries: number;
    readonly maximumRepositoryBytes: number;
    readonly maximumTreeEntries: number;
    readonly maximumPathSegmentUtf16: number;
    readonly maximumRepositoryPathUtf16: number;
  };
  readonly projectId: CollabProjectId;
  readonly refs: readonly DevelopmentBootstrapGitRef[];
  readonly schemaVersion: 1;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OBJECT_INVENTORY_LINE = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) ([0-9]+)$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com(?:[1-9¹²³])|lpt(?:[1-9¹²³]))(?:\..*)?$/iu;
const WINDOWS_INVALID_CHARACTER = /[<>:"\\|?*]/u;
const RESERVED_ROOTS = new Set(['.claudian', '.git', 'workspace']);
const VALIDATION_MARKER = '.claudian-cloud-validation.json';
const ATTEMPT_MARKER = '.claudian-cloud-attempt.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAXIMUM_EXPANDED_TREE_ENTRIES = 100_000;
const MAXIMUM_TREE_ENTRY_BYTES = 400;
const MAXIMUM_TREE_BATCH_WRAPPER_BYTES = 82;

function fail(code: GitBundleImportErrorCode): never {
  throw new GitBundleImportError(code);
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('git-bundle-import.options-invalid');
  }
}

function assertOptions(options: GitBundleImporterOptions): void {
  for (const value of [
    options.maximumBlobBytes,
    options.maximumBundleBytes,
    options.maximumExpandedTreeEntries,
    options.maximumMetadataOutputBytes,
    options.maximumRepositoryBytes,
    options.maximumTreeEntries,
    options.operationTimeoutMs,
    options.uploadIdleTimeoutMs,
    options.uploadTotalTimeoutMs,
  ]) {
    assertPositiveInteger(value);
  }
  if (
    (options.createBundleReadStream !== undefined
      && typeof options.createBundleReadStream !== 'function')
    ||
    (options.syncDirectory !== undefined
      && typeof options.syncDirectory !== 'function')
    ||
    (options.removeTree !== undefined && typeof options.removeTree !== 'function')
    ||
    options.maximumBlobBytes > COLLAB_LIMITS.maxBlobBytes
    || options.maximumExpandedTreeEntries > MAXIMUM_EXPANDED_TREE_ENTRIES
    || options.maximumRepositoryBytes < options.maximumBlobBytes
    || options.maximumTreeEntries > 2_000
    || options.uploadIdleTimeoutMs > options.uploadTotalTimeoutMs
    || !isAbsolute(options.stagingRoot)
    || normalize(options.stagingRoot) !== options.stagingRoot
    || parse(options.stagingRoot).root === options.stagingRoot
  ) {
    throw new TypeError('git-bundle-import.options-invalid');
  }
}

function assertInput(
  input: ImportGitBundleInput,
  maximumBundleBytes: number,
  expectedMemberCount?: number,
): void {
  const objectLength = input.objectFormat === 'sha1' ? 40 : 64;
  if (
    !isCollabProjectId(input.projectId)
    || !isCollabOpaqueId(input.attemptId)
    || input.contentEncoding !== 'identity'
    || input.contentType !== 'application/x-git-bundle'
    || !Number.isSafeInteger(input.declaredByteCount)
    || !Number.isSafeInteger(input.expectedByteCount)
    || input.expectedByteCount < 1
    || input.expectedByteCount > maximumBundleBytes
    || input.declaredByteCount !== input.expectedByteCount
    || !SHA256_PATTERN.test(input.declaredSha256)
    || input.declaredSha256 !== input.expectedSha256
    || (input.contentLength !== undefined
      && (!Number.isSafeInteger(input.contentLength)
        || input.contentLength !== input.expectedByteCount))
    || input.refs.length < 2
  ) {
    fail('artifact-invalid');
  }
  let previous = '';
  let memberRefs = 0;
  for (const ref of input.refs) {
    if (
      ref.name.localeCompare(previous, 'en-US') <= 0
      || !isCollabGitOid(ref.oid)
      || ref.oid.length !== objectLength
      || (ref.name !== COLLAB_MAIN_REF && (
        !ref.name.startsWith(COLLAB_MEMBER_REF_PREFIX)
        || !isCollabMemberId(ref.name.slice(COLLAB_MEMBER_REF_PREFIX.length))
      ))
    ) {
      fail('artifact-invalid');
    }
    if (ref.name.startsWith(COLLAB_MEMBER_REF_PREFIX)) memberRefs += 1;
    previous = ref.name;
  }
  if (
    input.refs[0]?.name !== COLLAB_MAIN_REF
    || memberRefs !== input.refs.length - 1
    || (expectedMemberCount !== undefined && memberRefs !== expectedMemberCount)
  ) {
    fail('artifact-invalid');
  }
}

function artifactKey(
  projectId: string,
  attemptId: string,
  profile: StagingProfile,
): string {
  const domain = profile === 'bootstrap' ? '' : 'checkpoint\0';
  return createHash('sha256')
    .update(`${domain}${projectId}\0${attemptId}`, 'utf8')
    .digest('hex');
}

function stagingCleanup(
  projectId: string,
  attemptId: string,
  profile: StagingProfile,
): Readonly<{ cleanupKey: string; markerJson: string }> {
  const markerJson = `${JSON.stringify({
    artifactKey: artifactKey(projectId, attemptId, profile),
    attemptId,
    operationKind: 'staging-cleanup',
    profile,
    projectId,
    schemaVersion: 1,
  })}\n`;
  return Object.freeze({
    cleanupKey: createHash('sha256')
      .update(`staging-cleanup\0${markerJson}`, 'utf8')
      .digest('hex'),
    markerJson,
  });
}

export function repositoryCheckpointAttemptId(
  projectId: string,
  operationId: string,
): string {
  return `checkpoint-${createHash('sha256')
    .update(`${projectId}\0${operationId}`, 'utf8')
    .digest('hex')}`;
}

export function repositoryCheckpointArtifactKey(
  projectId: string,
  operationId: string,
): string {
  return artifactKey(
    projectId,
    repositoryCheckpointAttemptId(projectId, operationId),
    'checkpoint',
  );
}

export function repositoryCheckpointAttemptMarkerJson(
  projectId: string,
  operationId: string,
): string {
  return attemptMarkerJson(
    projectId,
    repositoryCheckpointAttemptId(projectId, operationId),
    'checkpoint',
  );
}

function attemptMarkerJson(
  projectId: string,
  attemptId: string,
  profile: StagingProfile,
): string {
  return `${JSON.stringify({
    artifactKey: artifactKey(projectId, attemptId, profile),
    attemptId,
    ...(profile === 'checkpoint' ? { operationKind: 'checkpoint' } : {}),
    projectId,
    schemaVersion: 1,
  })}\n`;
}

function paths(
  root: string,
  projectId: string,
  attemptId: string,
  profile: StagingProfile,
): StagingPaths {
  const project = join(root, Buffer.from(projectId, 'utf8').toString('hex'));
  const attemptParent = profile === 'bootstrap'
    ? project
    : join(project, 'checkpoint');
  const attempt = join(
    attemptParent,
    Buffer.from(attemptId, 'utf8').toString('hex'),
  );
  const repository = join(attempt, 'repository');
  return Object.freeze({
    attempt,
    attemptParent,
    attemptMarker: join(attempt, ATTEMPT_MARKER),
    attemptMarkerPart: join(attempt, `.${ATTEMPT_MARKER}.part`),
    bundle: join(attempt, 'source.bundle'),
    bundlePart: join(attempt, '.source.bundle.part'),
    marker: join(repository, VALIDATION_MARKER),
    markerPart: join(repository, `.${VALIDATION_MARKER}.part`),
    project,
    repository,
  });
}

export function repositoryCheckpointStagingRepositoryPath(
  stagingRoot: string,
  projectId: string,
  operationId: string,
): string {
  return paths(
    stagingRoot,
    projectId,
    repositoryCheckpointAttemptId(projectId, operationId),
    'checkpoint',
  ).repository;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path, { bigint: true });
    const currentUid = getuid?.();
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || currentUid === undefined
      || entry.uid !== BigInt(currentUid)
    ) {
      fail('storage-unavailable');
    }
    await access(path, 7);
  } catch (error: unknown) {
    if (error instanceof GitBundleImportError) throw error;
    fail('storage-unavailable');
  }
}

async function privateDirectoryExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail('artifact-conflict');
    }
    await assertPrivateDirectory(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof GitBundleImportError) throw error;
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return false;
    }
    fail('storage-unavailable');
  }
}

async function preparePaths(
  stagingRoot: string,
  staging: StagingPaths,
  synchronizeDirectory: (path: string) => Promise<void>,
): Promise<boolean> {
  await assertPrivateDirectory(stagingRoot);
  try {
    await mkdir(staging.project, { mode: DIRECTORY_MODE });
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
      fail('storage-unavailable');
    }
  }
  await assertPrivateDirectory(staging.project);
  await synchronizeDirectory(stagingRoot);
  if (staging.attemptParent !== staging.project) {
    try {
      await mkdir(staging.attemptParent, { mode: DIRECTORY_MODE });
    } catch (error: unknown) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
        fail('storage-unavailable');
      }
    }
    await assertPrivateDirectory(staging.attemptParent);
    await synchronizeDirectory(staging.project);
  }
  let attemptCreated = false;
  try {
    await mkdir(staging.attempt, { mode: DIRECTORY_MODE });
    attemptCreated = true;
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
      fail('storage-unavailable');
    }
  }
  await assertPrivateDirectory(staging.attempt);
  await synchronizeDirectory(staging.attemptParent);
  return attemptCreated;
}

async function ensureAttemptMarker(
  staging: StagingPaths,
  projectId: string,
  attemptId: string,
  profile: StagingProfile,
  allowCreate: boolean,
  synchronizeDirectory: (path: string) => Promise<void>,
): Promise<void> {
  const json = attemptMarkerJson(projectId, attemptId, profile);
  try {
    const entry = await lstat(staging.attemptMarker);
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || entry.size !== Buffer.byteLength(json, 'utf8')
      || await readFile(staging.attemptMarker, 'utf8') !== json
    ) {
      fail('artifact-conflict');
    }
    await removeOwnedPartialFile(staging.attemptMarkerPart);
    return;
  } catch (error: unknown) {
    if (error instanceof GitBundleImportError) throw error;
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
      fail('storage-unavailable');
    }
  }
  if (!allowCreate) fail('artifact-conflict');
  await removeOwnedPartialFile(staging.attemptMarkerPart);
  let handle;
  try {
    handle = await open(staging.attemptMarkerPart, 'wx', FILE_MODE);
    await handle.writeFile(json, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(staging.attemptMarkerPart, staging.attemptMarker);
    await synchronizeDirectory(staging.attempt);
  } catch {
    await handle?.close().catch(() => undefined);
    await rm(staging.attemptMarkerPart, { force: true }).catch(() => undefined);
    fail('storage-unavailable');
  }
}

async function assertAttemptMarker(
  staging: StagingPaths,
  projectId: string,
  attemptId: string,
  profile: StagingProfile,
): Promise<void> {
  const json = attemptMarkerJson(projectId, attemptId, profile);
  try {
    const entry = await lstat(staging.attemptMarker);
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || entry.size !== Buffer.byteLength(json, 'utf8')
      || await readFile(staging.attemptMarker, 'utf8') !== json
    ) {
      fail('artifact-conflict');
    }
  } catch (error: unknown) {
    if (error instanceof GitBundleImportError) throw error;
    fail('artifact-conflict');
  }
}

async function removeOwnedPartialFile(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) fail('artifact-conflict');
    await rm(path);
  } catch (error: unknown) {
    if (error instanceof GitBundleImportError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    fail('storage-unavailable');
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch {
    fail('storage-unavailable');
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function syncFile(path: string): Promise<void> {
  let file;
  try {
    file = await open(path, 'r');
    await file.sync();
  } catch {
    fail('storage-unavailable');
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function mapUploadAdmission(error: BootstrapUploadAdmissionError): GitBundleImportError {
  if (error.code === 'busy') return new GitBundleImportError('busy');
  if (error.code === 'cancelled') return new GitBundleImportError('cancelled');
  if (error.code === 'closed') return new GitBundleImportError('closed');
  return new GitBundleImportError('storage-unavailable');
}

function mapResourceAdmission(error: ResourceAdmissionError): GitBundleImportError {
  if (error.code === 'busy') return new GitBundleImportError('busy');
  if (error.code === 'cancelled') return new GitBundleImportError('cancelled');
  if (error.code === 'closed') return new GitBundleImportError('closed');
  return new GitBundleImportError('artifact-invalid');
}

function mapProcess(error: GitProcessError, closed: boolean): GitBundleImportError {
  if (closed || error.code === 'closed') return new GitBundleImportError('closed');
  if (error.code === 'cancelled') return new GitBundleImportError('cancelled');
  if (error.code === 'timeout') return new GitBundleImportError('timeout');
  if (error.code === 'git-unavailable') return new GitBundleImportError('git-unavailable');
  if (error.code === 'unsupported-git') return new GitBundleImportError('unsupported-git');
  if (error.code === 'output-limit') return new GitBundleImportError('output-limit');
  return new GitBundleImportError('repository-invalid');
}

function abortCode(signal: AbortSignal, closed: boolean): GitBundleImportErrorCode {
  if (closed || signal.reason === 'closed') return 'closed';
  return 'cancelled';
}

function abortRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
  totalDeadline: number,
  closed: () => boolean,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) fail(abortCode(signal, closed()));
  const remaining = totalDeadline - Date.now();
  if (remaining <= 0) fail('timeout');
  return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => finish(() => reject(
      new GitBundleImportError(abortCode(signal, closed())),
    ));
    const timer = setTimeout(
      () => finish(() => reject(new GitBundleImportError('timeout'))),
      Math.min(idleTimeoutMs, remaining),
    );
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
    void iterator.next().then(
      result => finish(() => resolve(result)),
      () => finish(() => reject(new GitBundleImportError('artifact-invalid'))),
    );
    if (signal.aborted) onAbort();
  });
}

async function hashFile(
  path: string,
  signal: AbortSignal,
  deadline: number,
  closed: () => boolean,
  createBundleReadStream: NonNullable<GitBundleImporterOptions['createBundleReadStream']>,
): Promise<{ readonly byteCount: number; readonly sha256: string }> {
  if (signal.aborted) fail(abortCode(signal, closed()));
  const remaining = deadline - Date.now();
  if (remaining <= 0) fail('timeout');
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort('timeout'), remaining);
  timer.unref();
  const digest = createHash('sha256');
  let byteCount = 0;
  try {
    for await (const rawChunk of createBundleReadStream(path, controller.signal)) {
      if (controller.signal.aborted) {
        fail(controller.signal.reason === 'timeout'
          ? 'timeout'
          : abortCode(signal, closed()));
      }
      const chunk: unknown = rawChunk;
      if (!Buffer.isBuffer(chunk)) fail('storage-unavailable');
      byteCount += chunk.length;
      digest.update(chunk);
    }
    if (controller.signal.aborted) {
      fail(controller.signal.reason === 'timeout'
        ? 'timeout'
        : abortCode(signal, closed()));
    }
  } catch (error: unknown) {
    if (error instanceof GitBundleImportError) throw error;
    if (controller.signal.aborted) {
      fail(controller.signal.reason === 'timeout'
        ? 'timeout'
        : abortCode(signal, closed()));
    }
    fail('storage-unavailable');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  return Object.freeze({ byteCount, sha256: digest.digest('hex') });
}

function markerFor(
  input: ImportGitBundleInput,
  options: GitBundleImporterOptions,
  profile: StagingProfile,
): ValidationMarker {
  return Object.freeze({
    artifactKey: artifactKey(input.projectId, input.attemptId, profile),
    attemptId: input.attemptId,
    bundleByteCount: input.expectedByteCount,
    bundleSha256: input.expectedSha256,
    objectFormat: input.objectFormat,
    policy: Object.freeze({
      maximumBlobBytes: options.maximumBlobBytes,
      maximumExpandedTreeEntries: options.maximumExpandedTreeEntries,
      maximumPathSegmentUtf16: COLLAB_LIMITS.maxPathSegmentUtf16,
      maximumRepositoryBytes: options.maximumRepositoryBytes,
      maximumRepositoryPathUtf16: COLLAB_LIMITS.maxRepositoryPathUtf16,
      maximumTreeEntries: options.maximumTreeEntries,
    }),
    projectId: input.projectId,
    refs: Object.freeze(input.refs.map(ref => Object.freeze({ ...ref }))),
    schemaVersion: 1,
  });
}

function markerJson(marker: ValidationMarker): string {
  return `${JSON.stringify(marker)}\n`;
}

function validatedFact(marker: ValidationMarker, json: string): ValidatedBootstrapRepository {
  return Object.freeze({
    artifactKey: marker.artifactKey,
    attemptId: marker.attemptId,
    bundleByteCount: marker.bundleByteCount,
    bundleSha256: marker.bundleSha256,
    markerSha256: createHash('sha256').update(json, 'utf8').digest('hex'),
    objectFormat: marker.objectFormat,
    projectId: marker.projectId,
    refs: marker.refs,
  });
}

function parseRefOutput(output: Buffer): readonly DevelopmentBootstrapGitRef[] {
  const text = output.toString('utf8').trim();
  if (text.length === 0) return [];
  return text.split('\n').map(line => {
    const separator = line.indexOf(' ');
    if (separator <= 0) fail('repository-invalid');
    const oid = line.slice(0, separator);
    const name = line.slice(separator + 1);
    if (!isCollabGitOid(oid) || name.length === 0) fail('repository-invalid');
    return Object.freeze({ name, oid });
  }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
}

function refsEqual(
  actual: readonly DevelopmentBootstrapGitRef[],
  expected: readonly DevelopmentBootstrapGitRef[],
): boolean {
  return actual.length === expected.length && actual.every((ref, index) => {
    const expectedRef = expected[index];
    return expectedRef !== undefined
      && ref.name === expectedRef.name
      && ref.oid === expectedRef.oid;
  });
}

function parseInventory(output: Buffer): ReadonlyMap<string, ObjectInventoryEntry> {
  const entries = new Map<string, ObjectInventoryEntry>();
  const text = output.toString('utf8').trim();
  if (text.length === 0) fail('repository-invalid');
  for (const line of text.split('\n')) {
    const match = OBJECT_INVENTORY_LINE.exec(line);
    const size = Number(match?.[3]);
    const oid = match?.[1];
    const type = match?.[2];
    if (
      oid === undefined
      || type === undefined
      || !Number.isSafeInteger(size)
      || size < 0
      || entries.has(oid)
    ) {
      fail('repository-invalid');
    }
    entries.set(oid, Object.freeze({ oid, size, type }));
  }
  return entries;
}

function maximumTreeBatchOutputBytes(maximumExpandedTreeEntries: number): number {
  return (
    maximumExpandedTreeEntries * MAXIMUM_TREE_ENTRY_BYTES
    + (maximumExpandedTreeEntries + 1) * MAXIMUM_TREE_BATCH_WRAPPER_BYTES
  );
}

function parseTree(body: Buffer, oidBytes: number): readonly TreeEntry[] {
  const entries: TreeEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while (offset < body.length) {
    const modeEnd = body.indexOf(0x20, offset);
    const nameEnd = body.indexOf(0x00, modeEnd + 1);
    if (modeEnd <= offset || nameEnd <= modeEnd || nameEnd + oidBytes > body.length) {
      fail('repository-invalid');
    }
    let name: string;
    try {
      name = decoder.decode(body.subarray(modeEnd + 1, nameEnd));
    } catch {
      fail('repository-invalid');
    }
    entries.push(Object.freeze({
      mode: body.subarray(offset, modeEnd).toString('ascii'),
      name,
      oid: body.subarray(nameEnd + 1, nameEnd + 1 + oidBytes).toString('hex'),
    }));
    offset = nameEnd + 1 + oidBytes;
  }
  return entries;
}

class StreamingTreeBatchParser {
  readonly #expectedOids: readonly string[];
  readonly #maximumExpandedTreeEntries: number;
  readonly #maximumTreeEntries: number;
  readonly #oidBytes: number;
  readonly #trees = new Map<string, readonly TreeEntry[]>();
  #buffer: Buffer = Buffer.alloc(0);
  #expectedIndex = 0;
  #materializedEntries = 0;
  #pending: Readonly<{ oid: string; size: number }> | undefined;

  constructor(options: {
    readonly expectedOids: readonly string[];
    readonly maximumExpandedTreeEntries: number;
    readonly maximumTreeEntries: number;
    readonly oidBytes: number;
  }) {
    this.#expectedOids = options.expectedOids;
    this.#maximumExpandedTreeEntries = options.maximumExpandedTreeEntries;
    this.#maximumTreeEntries = options.maximumTreeEntries;
    this.#oidBytes = options.oidBytes;
  }

  push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0
      ? chunk
      : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#pending === undefined) {
        const headerEnd = this.#buffer.indexOf(0x0a);
        if (headerEnd < 0) {
          if (this.#buffer.length > 128) fail('repository-invalid');
          return;
        }
        const match = OBJECT_INVENTORY_LINE.exec(
          this.#buffer.subarray(0, headerEnd).toString('ascii'),
        );
        const expectedOid = this.#expectedOids[this.#expectedIndex];
        const size = Number(match?.[3]);
        if (
          expectedOid === undefined
          || match?.[1] !== expectedOid
          || match[2] !== 'tree'
          || !Number.isSafeInteger(size)
          || size < 0
        ) {
          fail('repository-invalid');
        }
        this.#pending = { oid: expectedOid, size };
        this.#buffer = this.#buffer.subarray(headerEnd + 1);
      }

      const pending = this.#pending;
      if (this.#buffer.length <= pending.size) return;
      if (this.#buffer[pending.size] !== 0x0a) fail('repository-invalid');
      const entries = parseTree(this.#buffer.subarray(0, pending.size), this.#oidBytes);
      if (entries.length > this.#maximumTreeEntries) fail('repository-limit');
      this.#materializedEntries += entries.length;
      if (this.#materializedEntries > this.#maximumExpandedTreeEntries) {
        fail('repository-limit');
      }
      this.#trees.set(pending.oid, entries);
      this.#expectedIndex += 1;
      this.#pending = undefined;
      this.#buffer = this.#buffer.subarray(pending.size + 1);
      if (this.#buffer.length === 0) return;
    }
  }

  finish(): ReadonlyMap<string, readonly TreeEntry[]> {
    if (
      this.#pending !== undefined
      || this.#buffer.length !== 0
      || this.#expectedIndex !== this.#expectedOids.length
    ) {
      fail('repository-invalid');
    }
    return this.#trees;
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function validateSegment(segment: string): void {
  if (segment.length > COLLAB_LIMITS.maxPathSegmentUtf16) {
    fail('repository-limit');
  }
  if (
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || containsControlCharacter(segment)
    || WINDOWS_INVALID_CHARACTER.test(segment)
    || /[. ]$/u.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment)
    || RESERVED_ROOTS.has(segment.normalize('NFC').toLocaleLowerCase('en-US'))
  ) {
    fail('repository-invalid');
  }
}

async function validateTrees(
  rootTrees: readonly string[],
  trees: ReadonlyMap<string, readonly TreeEntry[]>,
  inventory: ReadonlyMap<string, ObjectInventoryEntry>,
  maximumExpandedTreeEntries: number,
  maximumTreeEntries: number,
  deadline: number,
  signal: AbortSignal,
  isClosed: () => boolean,
): Promise<void> {
  if (signal.aborted) fail(abortCode(signal, isClosed()));
  if (Date.now() > deadline) fail('timeout');
  for (const entries of trees.values()) {
    if (entries.length > maximumTreeEntries) fail('repository-limit');
  }
  let expandedEntries = 0;
  for (const root of rootTrees) {
    const comparisons = new Map<string, string>();
    const stack = [{ oid: root, prefix: '' }];
    while (stack.length > 0) {
      const current = stack.pop() as { readonly oid: string; readonly prefix: string };
      const entries = trees.get(current.oid);
      if (entries === undefined) fail('repository-invalid');
      for (const entry of entries) {
        expandedEntries += 1;
        if (expandedEntries > maximumExpandedTreeEntries) {
          fail('repository-limit');
        }
        if (expandedEntries % 256 === 0) {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (abortRequested(signal)) fail(abortCode(signal, isClosed()));
          if (Date.now() > deadline) fail('timeout');
        }
        validateSegment(entry.name);
        const repositoryPath = current.prefix.length === 0
          ? entry.name
          : `${current.prefix}/${entry.name}`;
        if (repositoryPath.length > COLLAB_LIMITS.maxRepositoryPathUtf16) {
          fail('repository-limit');
        }
        const comparison = repositoryPath.normalize('NFC').toLocaleLowerCase('en-US');
        const previous = comparisons.get(comparison);
        if (previous !== undefined && previous !== repositoryPath) {
          fail('repository-invalid');
        }
        comparisons.set(comparison, repositoryPath);
        const object = inventory.get(entry.oid);
        if (entry.mode === '40000' || entry.mode === '040000') {
          if (object?.type !== 'tree') fail('repository-invalid');
          stack.push({ oid: entry.oid, prefix: repositoryPath });
        } else if (entry.mode === '100644' || entry.mode === '100755') {
          if (object?.type !== 'blob') fail('repository-invalid');
        } else {
          fail('repository-invalid');
        }
      }
    }
  }
}

export interface GitRepositoryContentValidationInput {
  readonly closed: () => boolean;
  readonly deadline: number;
  readonly maximumBlobBytes: number;
  readonly maximumExpandedTreeEntries: number;
  readonly maximumRepositoryBytes: number;
  readonly maximumTreeEntries: number;
  readonly objectFormat: CollabCheckpointObjectFormat;
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly repositoryPath: string;
  readonly signal: AbortSignal;
  readonly supervisor: GitProcessSupervisor;
}

async function runRepositoryValidationCommand(
  input: GitRepositoryContentValidationInput,
  arguments_: readonly string[],
  options: {
    readonly captureOutput?: boolean;
    readonly input?: string;
  } = {},
): Promise<Buffer> {
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) fail('timeout');
  try {
    return await input.supervisor.runCommand({
      arguments: arguments_,
      captureOutput: options.captureOutput ?? false,
      cwd: input.repositoryPath,
      failureCode: 'repository-corrupt',
      ...(options.input === undefined ? {} : { input: options.input }),
      signal: input.signal,
      timeoutMs: remaining,
    });
  } catch (error: unknown) {
    if (error instanceof GitProcessError) {
      throw mapProcess(error, input.closed());
    }
    fail('process-failed');
  }
}

async function readRepositoryTrees(
  input: GitRepositoryContentValidationInput,
  treeOids: readonly string[],
  oidBytes: number,
): Promise<ReadonlyMap<string, readonly TreeEntry[]>> {
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) fail('timeout');
  const parser = new StreamingTreeBatchParser({
    expectedOids: treeOids,
    maximumExpandedTreeEntries: input.maximumExpandedTreeEntries,
    maximumTreeEntries: input.maximumTreeEntries,
    oidBytes,
  });
  let parserError: unknown;
  try {
    await input.supervisor.runStreamingCommand({
      arguments: ['cat-file', '--batch'],
      cwd: input.repositoryPath,
      failureCode: 'repository-corrupt',
      input: `${treeOids.join('\n')}\n`,
      onStdoutChunk: chunk => {
        try {
          parser.push(chunk);
        } catch (error: unknown) {
          parserError = error;
          throw error;
        }
      },
      signal: input.signal,
      stdoutMaxBytes: maximumTreeBatchOutputBytes(
        input.maximumExpandedTreeEntries,
      ),
      timeoutMs: remaining,
    });
    return parser.finish();
  } catch (error: unknown) {
    if (parserError instanceof GitBundleImportError) throw parserError;
    if (error instanceof GitBundleImportError) throw error;
    if (error instanceof GitProcessError) {
      throw mapProcess(error, input.closed());
    }
    fail('process-failed');
  }
}

export async function verifyGitRepositoryContent(
  input: GitRepositoryContentValidationInput,
): Promise<void> {
  await assertPrivateDirectory(input.repositoryPath);
  const versionRemaining = input.deadline - Date.now();
  if (versionRemaining <= 0) fail('timeout');
  try {
    await input.supervisor.verifyVersion(input.signal, versionRemaining);
  } catch (error: unknown) {
    if (error instanceof GitProcessError) {
      throw mapProcess(error, input.closed());
    }
    fail('git-unavailable');
  }
  const objectFormat = await runRepositoryValidationCommand(
    input,
    ['rev-parse', '--show-object-format'],
    { captureOutput: true },
  );
  if (objectFormat.toString('utf8').trim() !== input.objectFormat) {
    fail('repository-invalid');
  }
  const importedRefs = parseRefOutput(await runRepositoryValidationCommand(
    input,
    ['show-ref'],
    { captureOutput: true },
  ));
  if (!refsEqual(importedRefs, input.refs)) fail('repository-invalid');

  const commitTypes = await runRepositoryValidationCommand(
    input,
    ['cat-file', '--batch-check=%(objecttype)'],
    {
      captureOutput: true,
      input: `${input.refs.map(ref => ref.oid).join('\n')}\n`,
    },
  );
  if (
    commitTypes.toString('utf8').trim().split('\n')
      .some(type => type !== 'commit')
  ) {
    fail('repository-invalid');
  }
  const fsck = await runRepositoryValidationCommand(
    input,
    ['fsck', '--full', '--strict', '--unreachable', '--no-reflogs', '--no-progress'],
    { captureOutput: true },
  );
  if (fsck.length !== 0) fail('repository-invalid');

  const inventory = parseInventory(await runRepositoryValidationCommand(
    input,
    [
      'cat-file',
      '--batch-all-objects',
      '--unordered',
      '--batch-check=%(objectname) %(objecttype) %(objectsize)',
    ],
    { captureOutput: true },
  ));
  let repositoryBytes = 0;
  const treeOids: string[] = [];
  for (const object of inventory.values()) {
    repositoryBytes += object.size;
    if (!Number.isSafeInteger(repositoryBytes)) fail('repository-limit');
    if (object.type === 'blob' && object.size > input.maximumBlobBytes) {
      fail('repository-limit');
    }
    if (object.type === 'tree') treeOids.push(object.oid);
    else if (object.type !== 'blob' && object.type !== 'commit') {
      fail('repository-invalid');
    }
  }
  if (repositoryBytes > input.maximumRepositoryBytes) {
    fail('repository-limit');
  }

  const rootTrees = (await runRepositoryValidationCommand(
    input,
    ['log', '--format=%T', '--all'],
    { captureOutput: true },
  )).toString('utf8').trim().split('\n').filter(Boolean);
  if (rootTrees.length === 0) fail('repository-invalid');
  const trees = await readRepositoryTrees(
    input,
    treeOids,
    input.objectFormat === 'sha1' ? 20 : 32,
  );
  await validateTrees(
    rootTrees,
    trees,
    inventory,
    input.maximumExpandedTreeEntries,
    input.maximumTreeEntries,
    input.deadline,
    input.signal,
    input.closed,
  );
}

export class GitBundleImporter {
  readonly #createBundleReadStream: NonNullable<
    GitBundleImporterOptions['createBundleReadStream']
  >;
  readonly #maximumBlobBytes: number;
  readonly #maximumBundleBytes: number;
  readonly #maximumExpandedTreeEntries: number;
  readonly #maximumRepositoryBytes: number;
  readonly #maximumTreeEntries: number;
  readonly #options: GitBundleImporterOptions;
  readonly #removeTree: (path: string) => Promise<void>;
  readonly #resourceAdmission: ResourceAdmission;
  readonly #stagingRoot: string;
  readonly #supervisor: GitProcessSupervisor;
  readonly #syncDirectory: (path: string) => Promise<void>;
  readonly #uploadAdmission: BootstrapUploadAdmission;
  readonly #uploadIdleTimeoutMs: number;
  readonly #uploadTotalTimeoutMs: number;
  readonly #controllers = new Set<AbortController>();
  readonly #running = new Set<Promise<void>>();
  readonly #attemptOperations = new Map<string, Readonly<{
    controller: AbortController;
    settled: Promise<void>;
  }>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: GitBundleImporterOptions) {
    assertOptions(options);
    this.#createBundleReadStream = options.createBundleReadStream
      ?? ((path, signal) => createReadStream(path, {
        highWaterMark: 64 * 1024,
        signal,
      }));
    this.#maximumBlobBytes = options.maximumBlobBytes;
    this.#maximumBundleBytes = options.maximumBundleBytes;
    this.#maximumExpandedTreeEntries = options.maximumExpandedTreeEntries;
    this.#maximumRepositoryBytes = options.maximumRepositoryBytes;
    this.#maximumTreeEntries = options.maximumTreeEntries;
    this.#options = options;
    this.#removeTree = options.removeTree
      ?? (path => rm(path, { recursive: true }));
    this.#resourceAdmission = options.resourceAdmission;
    this.#stagingRoot = options.stagingRoot;
    this.#supervisor = new GitProcessSupervisor({
      gitExecutable: options.gitExecutable,
      operationTimeoutMs: options.operationTimeoutMs,
      outputMaxBytes: options.maximumMetadataOutputBytes,
    });
    const synchronizeDirectory = options.syncDirectory ?? syncDirectory;
    this.#syncDirectory = async path => {
      try {
        await synchronizeDirectory(path);
      } catch (error: unknown) {
        if (error instanceof GitBundleImportError) throw error;
        fail('storage-unavailable');
      }
    };
    this.#uploadAdmission = options.uploadAdmission;
    this.#uploadIdleTimeoutMs = options.uploadIdleTimeoutMs;
    this.#uploadTotalTimeoutMs = options.uploadTotalTimeoutMs;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort('closed');
      this.#closePromise = Promise.allSettled([
        this.#supervisor.close(),
        ...this.#running,
      ]).then(() => undefined);
    }
    return this.#closePromise;
  }

  async importBundle(
    input: ImportGitBundleInput,
  ): Promise<ValidatedBootstrapRepository> {
    if (this.#closed) throw new GitBundleImportError('closed');
    assertInput(input, this.#maximumBundleBytes, 2);
    return (await this.#startImport(input, true, 'bootstrap')).repository;
  }

  async importCheckpoint(
    input: ImportRepositoryCheckpointInput,
  ): Promise<ValidatedRepositoryCheckpoint> {
    if (this.#closed) throw new GitBundleImportError('closed');
    if (
      !isCollabProjectId(input.projectId)
      || !isCollabOpaqueId(input.operationId)
    ) {
      fail('artifact-invalid');
    }
    const commonInput: ImportGitBundleInput = {
      attemptId: repositoryCheckpointAttemptId(
        input.projectId,
        input.operationId,
      ),
      body: input.body,
      contentEncoding: 'identity',
      contentLength: input.expectedByteCount,
      contentType: 'application/x-git-bundle',
      declaredByteCount: input.expectedByteCount,
      declaredSha256: input.expectedSha256,
      expectedByteCount: input.expectedByteCount,
      expectedSha256: input.expectedSha256,
      objectFormat: input.objectFormat,
      projectId: input.projectId,
      refs: input.refs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    assertInput(commonInput, this.#maximumBundleBytes);
    const completed = await this.#startImport(
      commonInput,
      false,
      'checkpoint',
    );
    const validated = completed.repository;
    return Object.freeze({
      artifactKey: validated.artifactKey,
      bundleByteCount: validated.bundleByteCount,
      bundleInputDisposition: completed.bundleInputDisposition,
      bundleSha256: validated.bundleSha256,
      markerSha256: validated.markerSha256,
      objectFormat: validated.objectFormat,
      operationId: input.operationId,
      projectId: validated.projectId,
      refs: validated.refs,
    });
  }

  discardCheckpoint(
    input: DiscardRepositoryCheckpointInput,
  ): Promise<'removed' | 'replayed'> {
    if (this.#closed) {
      return Promise.reject(new GitBundleImportError('closed'));
    }
    if (
      !isCollabProjectId(input.projectId)
      || !isCollabOpaqueId(input.operationId)
    ) {
      return Promise.reject(new GitBundleImportError('artifact-invalid'));
    }
    return this.#trackOperation(this.#discardAttempt({
      attemptId: repositoryCheckpointAttemptId(
        input.projectId,
        input.operationId,
      ),
      projectId: input.projectId,
    }, 'checkpoint'));
  }

  #trackOperation<Result>(operation: Promise<Result>): Promise<Result> {
    const tracked = operation.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    void tracked.finally(() => this.#running.delete(tracked));
    return operation;
  }

  #startImport(
    input: ImportGitBundleInput,
    acquireUploadPermit: boolean,
    profile: StagingProfile,
  ): Promise<CompletedImport> {
    const operationKey = artifactKey(
      input.projectId,
      input.attemptId,
      profile,
    );
    if (this.#attemptOperations.has(operationKey)) {
      return Promise.reject(new GitBundleImportError('busy'));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort('cancelled');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted === true) onAbort();
    this.#controllers.add(controller);

    const operation = this.#performImport(
      input,
      controller.signal,
      acquireUploadPermit,
      profile,
    );
    const tracked = operation.then(() => undefined, () => undefined);
    const attemptOperation = Object.freeze({ controller, settled: tracked });
    this.#attemptOperations.set(operationKey, attemptOperation);
    this.#running.add(tracked);
    void tracked.finally(() => {
      input.signal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      this.#running.delete(tracked);
      if (this.#attemptOperations.get(operationKey) === attemptOperation) {
        this.#attemptOperations.delete(operationKey);
      }
    });
    return operation;
  }

  async discardAttempt(
    input: DiscardBootstrapAttemptInput,
  ): Promise<'removed' | 'replayed'> {
    if (this.#closed) throw new GitBundleImportError('closed');
    if (!isCollabProjectId(input.projectId) || !isCollabOpaqueId(input.attemptId)) {
      fail('artifact-invalid');
    }
    return this.#trackOperation(this.#discardAttempt(input, 'bootstrap'));
  }

  async #discardAttempt(
    input: DiscardBootstrapAttemptInput,
    profile: StagingProfile,
  ): Promise<'removed' | 'replayed'> {
    await this.#abortAttempt(input, profile);
    const staging = paths(
      this.#stagingRoot,
      input.projectId,
      input.attemptId,
      profile,
    );
    await assertPrivateDirectory(this.#stagingRoot);
    if (!await privateDirectoryExists(staging.project)) {
      await this.#syncDirectory(this.#stagingRoot);
      return 'replayed';
    }
    if (
      staging.attemptParent !== staging.project
      && !await privateDirectoryExists(staging.attemptParent)
    ) {
      await this.#syncDirectory(staging.project);
      return 'replayed';
    }
    const cleanup = stagingCleanup(input.projectId, input.attemptId, profile);
    try {
      return await removeDurableOwnedTree({
        assertTargetOwned: () => assertAttemptMarker(
          staging,
          input.projectId,
          input.attemptId,
          profile,
        ),
        cleanupKey: cleanup.cleanupKey,
        markerJson: cleanup.markerJson,
        parentPath: staging.attemptParent,
        removeTree: this.#removeTree,
        syncDirectory: this.#syncDirectory,
        targetPath: staging.attempt,
      });
    } catch (error: unknown) {
      if (error instanceof GitBundleImportError) throw error;
      if (
        error instanceof DurableTreeRemovalError
        && error.code === 'conflict'
      ) {
        fail('artifact-conflict');
      }
      fail('storage-unavailable');
    }
  }

  async abortAttempt(input: DiscardBootstrapAttemptInput): Promise<void> {
    if (this.#closed) throw new GitBundleImportError('closed');
    if (!isCollabProjectId(input.projectId) || !isCollabOpaqueId(input.attemptId)) {
      fail('artifact-invalid');
    }
    await this.#abortAttempt(input, 'bootstrap');
  }

  async #abortAttempt(
    input: DiscardBootstrapAttemptInput,
    profile: StagingProfile,
  ): Promise<void> {
    const active = this.#attemptOperations.get(artifactKey(
      input.projectId,
      input.attemptId,
      profile,
    ));
    if (active !== undefined) {
      active.controller.abort('cancelled');
      await active.settled;
    }
  }

  async #performImport(
    input: ImportGitBundleInput,
    signal: AbortSignal,
    acquireUploadPermit: boolean,
    profile: StagingProfile,
  ): Promise<CompletedImport> {
    const deadline = Date.now() + this.#uploadTotalTimeoutMs;
    let uploadPermit: BootstrapUploadPermit | undefined;
    let gitPermit: GitChildPermit | undefined;
    try {
      if (acquireUploadPermit) {
        try {
          uploadPermit = await this.#uploadAdmission.acquire({
            attemptId: input.attemptId,
            signal,
          });
        } catch (error: unknown) {
          if (error instanceof BootstrapUploadAdmissionError) {
            throw mapUploadAdmission(error);
          }
          fail('storage-unavailable');
        }
      }

      const staging = paths(
        this.#stagingRoot,
        input.projectId,
        input.attemptId,
        profile,
      );
      const attemptCreated = await preparePaths(
        this.#stagingRoot,
        staging,
        this.#syncDirectory,
      );
      await ensureAttemptMarker(
        staging,
        input.projectId,
        input.attemptId,
        profile,
        attemptCreated,
        this.#syncDirectory,
      );
      const marker = markerFor(input, this.#options, profile);
      const json = markerJson(marker);
      const replay = await this.#readValidatedReplay(
        staging,
        marker,
        json,
        signal,
        deadline,
      );
      let bundleInputDisposition: ValidatedRepositoryCheckpoint['bundleInputDisposition']
        = 'replayed';
      if (replay === undefined) {
        bundleInputDisposition = await this.#stageBundle(
          input,
          staging,
          signal,
          deadline,
        );
      }
      try {
        gitPermit = await this.#resourceAdmission.acquireGitChild({
          classification: 'write',
          projectId: input.projectId,
          signal,
        });
      } catch (error: unknown) {
        if (error instanceof ResourceAdmissionError) {
          throw mapResourceAdmission(error);
        }
        fail('process-failed');
      }
      if (replay !== undefined) {
        await this.#verifyRepository(input, staging, signal, deadline);
        await this.#hardenRepository(staging);
        return Object.freeze({
          bundleInputDisposition: 'replayed',
          repository: replay,
        });
      }
      await this.#validateRepository(input, staging, signal, deadline);
      await this.#writeMarker(staging, json);
      return Object.freeze({
        bundleInputDisposition,
        repository: validatedFact(marker, json),
      });
    } finally {
      gitPermit?.release();
      uploadPermit?.release();
    }
  }

  async #readValidatedReplay(
    staging: StagingPaths,
    marker: ValidationMarker,
    json: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<ValidatedBootstrapRepository | undefined> {
    let existingMarker: string;
    try {
      const [markerEntry, bundleEntry] = await Promise.all([
        lstat(staging.marker),
        lstat(staging.bundle),
      ]);
      if (
        !markerEntry.isFile()
        || markerEntry.isSymbolicLink()
        || markerEntry.size !== Buffer.byteLength(json, 'utf8')
        || !bundleEntry.isFile()
        || bundleEntry.isSymbolicLink()
      ) {
        fail('artifact-conflict');
      }
      existingMarker = await readFile(staging.marker, 'utf8');
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      fail('artifact-conflict');
    }
    if (existingMarker !== json) fail('artifact-conflict');
    const actual = await hashFile(
      staging.bundle,
      signal,
      deadline,
      () => this.#closed,
      this.#createBundleReadStream,
    );
    if (
      actual.byteCount !== marker.bundleByteCount
      || actual.sha256 !== marker.bundleSha256
    ) {
      fail('artifact-conflict');
    }
    return validatedFact(marker, json);
  }

  async #stageBundle(
    input: ImportGitBundleInput,
    staging: StagingPaths,
    signal: AbortSignal,
    deadline: number,
  ): Promise<ValidatedRepositoryCheckpoint['bundleInputDisposition']> {
    try {
      const existing = await lstat(staging.bundle);
      if (
        !existing.isFile()
        || existing.isSymbolicLink()
        || existing.size !== input.expectedByteCount
      ) {
        fail('artifact-conflict');
      }
      const digest = await hashFile(
        staging.bundle,
        signal,
        deadline,
        () => this.#closed,
        this.#createBundleReadStream,
      );
      if (digest.sha256 !== input.expectedSha256) fail('artifact-conflict');
      return 'replayed';
    } catch (error: unknown) {
      if (error instanceof GitBundleImportError) throw error;
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        fail('storage-unavailable');
      }
    }

    await rm(staging.bundlePart, { force: true }).catch(() => {
      fail('storage-unavailable');
    });
    let handle;
    const iterator = input.body[Symbol.asyncIterator]();
    try {
      handle = await open(staging.bundlePart, 'wx', FILE_MODE);
      const digest = createHash('sha256');
      let byteCount = 0;
      for (;;) {
        const next = await nextChunk(
          iterator,
          signal,
          this.#uploadIdleTimeoutMs,
          deadline,
          () => this.#closed,
        );
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) fail('artifact-invalid');
        byteCount += next.value.byteLength;
        if (
          byteCount > input.expectedByteCount
          || byteCount > this.#maximumBundleBytes
        ) {
          fail('repository-limit');
        }
        await handle.writeFile(next.value);
        digest.update(next.value);
        if (Date.now() > deadline) fail('timeout');
      }
      if (byteCount !== input.expectedByteCount) fail('artifact-invalid');
      if (digest.digest('hex') !== input.expectedSha256) fail('digest-mismatch');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(staging.bundlePart, FILE_MODE);
      await rename(staging.bundlePart, staging.bundle);
      await this.#syncDirectory(staging.attempt);
      return 'consumed';
    } catch (error: unknown) {
      await iterator.return?.().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      await rm(staging.bundlePart, { force: true }).catch(() => undefined);
      if (error instanceof GitBundleImportError) throw error;
      fail('storage-unavailable');
    }
  }

  async #run(
    staging: StagingPaths,
    arguments_: readonly string[],
    options: {
      readonly captureOutput?: boolean;
      readonly deadline: number;
      readonly input?: string;
      readonly signal: AbortSignal;
    },
  ): Promise<Buffer> {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) fail('timeout');
    try {
      return await this.#supervisor.runCommand({
        arguments: [
          '-c',
          'core.fsync=all',
          '-c',
          'core.fsyncMethod=fsync',
          ...arguments_,
        ],
        captureOutput: options.captureOutput ?? false,
        cwd: staging.repository,
        failureCode: 'repository-corrupt',
        ...(options.input === undefined ? {} : { input: options.input }),
        signal: options.signal,
        timeoutMs: remaining,
      });
    } catch (error: unknown) {
      if (error instanceof GitProcessError) throw mapProcess(error, this.#closed);
      fail('process-failed');
    }
  }

  async #verifyGitVersion(signal: AbortSignal, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('timeout');
    try {
      await this.#supervisor.verifyVersion(signal, remaining);
    } catch (error: unknown) {
      if (error instanceof GitProcessError) throw mapProcess(error, this.#closed);
      fail('git-unavailable');
    }
  }

  async #validateRepository(
    input: ImportGitBundleInput,
    staging: StagingPaths,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    if (signal.aborted) fail(abortCode(signal, this.#closed));
    try {
      await rm(staging.repository, { force: true, recursive: true });
      await mkdir(staging.repository, { mode: DIRECTORY_MODE });
      await assertPrivateDirectory(staging.repository);
    } catch (error: unknown) {
      if (error instanceof GitBundleImportError) throw error;
      fail('storage-unavailable');
    }
    await this.#verifyGitVersion(signal, deadline);
    await this.#run(staging, [
      'init',
      '--quiet',
      '--bare',
      `--object-format=${input.objectFormat}`,
      '.',
    ], { deadline, signal });
    const objectFormat = await this.#run(
      staging,
      ['rev-parse', '--show-object-format'],
      { captureOutput: true, deadline, signal },
    );
    if (objectFormat.toString('utf8').trim() !== input.objectFormat) {
      fail('repository-invalid');
    }
    await this.#run(staging, ['bundle', 'verify', '../source.bundle'], { deadline, signal });
    const bundleRefs = parseRefOutput(await this.#run(
      staging,
      ['bundle', 'list-heads', '../source.bundle'],
      { captureOutput: true, deadline, signal },
    ));
    if (!refsEqual(bundleRefs, input.refs)) fail('repository-invalid');

    const refspecs = input.refs.map(ref => `${ref.name}:${ref.name}`).join('\n');
    await this.#run(
      staging,
      ['fetch', '--quiet', '--no-tags', '../source.bundle', '--stdin'],
      { deadline, input: `${refspecs}\n`, signal },
    );
    await this.#verifyRepository(input, staging, signal, deadline);
    try {
      await rm(join(staging.repository, 'hooks'), { force: true, recursive: true });
      await mkdir(join(staging.repository, 'hooks'), { mode: DIRECTORY_MODE });
      await chmod(join(staging.repository, 'config'), FILE_MODE);
    } catch {
      fail('storage-unavailable');
    }
    await this.#hardenRepository(staging);
  }

  async #hardenRepository(staging: StagingPaths): Promise<void> {
    await syncFile(join(staging.repository, 'config'));
    await this.#syncDirectory(join(staging.repository, 'hooks'));
    await this.#syncDirectory(staging.repository);
    await this.#syncDirectory(staging.attempt);
  }

  async #verifyRepository(
    input: ImportGitBundleInput,
    staging: StagingPaths,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    await this.#run(staging, ['bundle', 'verify', '../source.bundle'], { deadline, signal });
    const bundleRefs = parseRefOutput(await this.#run(
      staging,
      ['bundle', 'list-heads', '../source.bundle'],
      { captureOutput: true, deadline, signal },
    ));
    if (!refsEqual(bundleRefs, input.refs)) fail('repository-invalid');
    await verifyGitRepositoryContent({
      closed: () => this.#closed,
      deadline,
      maximumBlobBytes: this.#maximumBlobBytes,
      maximumExpandedTreeEntries: this.#maximumExpandedTreeEntries,
      maximumRepositoryBytes: this.#maximumRepositoryBytes,
      maximumTreeEntries: this.#maximumTreeEntries,
      objectFormat: input.objectFormat,
      refs: input.refs,
      repositoryPath: staging.repository,
      signal,
      supervisor: this.#supervisor,
    });
  }

  async #writeMarker(staging: StagingPaths, json: string): Promise<void> {
    let handle;
    try {
      handle = await open(staging.markerPart, 'wx', FILE_MODE);
      await handle.writeFile(json, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(staging.markerPart, staging.marker);
      await this.#syncDirectory(staging.repository);
    } catch {
      await handle?.close().catch(() => undefined);
      await rm(staging.markerPart, { force: true }).catch(() => undefined);
      fail('storage-unavailable');
    }
  }
}
