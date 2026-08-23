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
  isCollabOpaqueId,
  isCollabProjectId,
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
  readonly resourceAdmission: ResourceAdmission;
  readonly stagingRoot: string;
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
  readonly attemptMarker: string;
  readonly attemptMarkerPart: string;
  readonly bundle: string;
  readonly bundlePart: string;
  readonly marker: string;
  readonly markerPart: string;
  readonly project: string;
  readonly repository: string;
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

function assertInput(input: ImportGitBundleInput, maximumBundleBytes: number): void {
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
    || input.refs.length !== 3
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
      || (ref.name !== COLLAB_MAIN_REF
        && !ref.name.startsWith(COLLAB_MEMBER_REF_PREFIX))
    ) {
      fail('artifact-invalid');
    }
    if (ref.name.startsWith(COLLAB_MEMBER_REF_PREFIX)) memberRefs += 1;
    previous = ref.name;
  }
  if (input.refs[0]?.name !== COLLAB_MAIN_REF || memberRefs !== 2) {
    fail('artifact-invalid');
  }
}

function artifactKey(projectId: string, attemptId: string): string {
  return createHash('sha256').update(`${projectId}\0${attemptId}`, 'utf8').digest('hex');
}

function attemptMarkerJson(projectId: string, attemptId: string): string {
  return `${JSON.stringify({
    artifactKey: artifactKey(projectId, attemptId),
    attemptId,
    projectId,
    schemaVersion: 1,
  })}\n`;
}

function paths(root: string, projectId: string, attemptId: string): StagingPaths {
  const project = join(root, Buffer.from(projectId, 'utf8').toString('hex'));
  const attempt = join(project, Buffer.from(attemptId, 'utf8').toString('hex'));
  const repository = join(attempt, 'repository');
  return Object.freeze({
    attempt,
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

async function preparePaths(stagingRoot: string, staging: StagingPaths): Promise<void> {
  await assertPrivateDirectory(stagingRoot);
  try {
    await mkdir(staging.project, { mode: DIRECTORY_MODE });
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
      fail('storage-unavailable');
    }
  }
  await assertPrivateDirectory(staging.project);
  try {
    await mkdir(staging.attempt, { mode: DIRECTORY_MODE });
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
      fail('storage-unavailable');
    }
  }
  await assertPrivateDirectory(staging.attempt);
}

async function ensureAttemptMarker(
  staging: StagingPaths,
  projectId: string,
  attemptId: string,
): Promise<void> {
  const json = attemptMarkerJson(projectId, attemptId);
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
  await removeOwnedPartialFile(staging.attemptMarkerPart);
  let handle;
  try {
    handle = await open(staging.attemptMarkerPart, 'wx', FILE_MODE);
    await handle.writeFile(json, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(staging.attemptMarkerPart, staging.attemptMarker);
    await syncDirectory(staging.attempt);
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
): Promise<void> {
  const json = attemptMarkerJson(projectId, attemptId);
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
): ValidationMarker {
  return Object.freeze({
    artifactKey: artifactKey(input.projectId, input.attemptId),
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
  readonly #resourceAdmission: ResourceAdmission;
  readonly #stagingRoot: string;
  readonly #supervisor: GitProcessSupervisor;
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
    this.#resourceAdmission = options.resourceAdmission;
    this.#stagingRoot = options.stagingRoot;
    this.#supervisor = new GitProcessSupervisor({
      gitExecutable: options.gitExecutable,
      operationTimeoutMs: options.operationTimeoutMs,
      outputMaxBytes: options.maximumMetadataOutputBytes,
    });
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
    assertInput(input, this.#maximumBundleBytes);
    if (this.#attemptOperations.has(input.attemptId)) {
      throw new GitBundleImportError('busy');
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort('cancelled');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted === true) onAbort();
    this.#controllers.add(controller);

    const operation = this.#performImport(input, controller.signal);
    const tracked = operation.then(() => undefined, () => undefined);
    const attemptOperation = Object.freeze({ controller, settled: tracked });
    this.#attemptOperations.set(input.attemptId, attemptOperation);
    this.#running.add(tracked);
    void tracked.finally(() => {
      input.signal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      this.#running.delete(tracked);
      if (this.#attemptOperations.get(input.attemptId) === attemptOperation) {
        this.#attemptOperations.delete(input.attemptId);
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
    await this.abortAttempt(input);
    const staging = paths(this.#stagingRoot, input.projectId, input.attemptId);
    await assertPrivateDirectory(this.#stagingRoot);
    try {
      const entry = await lstat(staging.attempt);
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('artifact-conflict');
    } catch (error: unknown) {
      if (error instanceof GitBundleImportError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return 'replayed';
      }
      fail('storage-unavailable');
    }
    await assertPrivateDirectory(staging.project);
    await assertPrivateDirectory(staging.attempt);
    await assertAttemptMarker(staging, input.projectId, input.attemptId);
    try {
      await rm(staging.attempt, { recursive: true });
      await syncDirectory(staging.project);
    } catch {
      fail('storage-unavailable');
    }
    return 'removed';
  }

  async abortAttempt(input: DiscardBootstrapAttemptInput): Promise<void> {
    if (this.#closed) throw new GitBundleImportError('closed');
    if (!isCollabProjectId(input.projectId) || !isCollabOpaqueId(input.attemptId)) {
      fail('artifact-invalid');
    }
    const active = this.#attemptOperations.get(input.attemptId);
    if (active !== undefined) {
      active.controller.abort('cancelled');
      await active.settled;
    }
  }

  async #performImport(
    input: ImportGitBundleInput,
    signal: AbortSignal,
  ): Promise<ValidatedBootstrapRepository> {
    const deadline = Date.now() + this.#uploadTotalTimeoutMs;
    let uploadPermit: BootstrapUploadPermit | undefined;
    let gitPermit: GitChildPermit | undefined;
    try {
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

      const staging = paths(this.#stagingRoot, input.projectId, input.attemptId);
      await preparePaths(this.#stagingRoot, staging);
      await ensureAttemptMarker(staging, input.projectId, input.attemptId);
      const marker = markerFor(input, this.#options);
      const json = markerJson(marker);
      const replay = await this.#readValidatedReplay(
        staging,
        marker,
        json,
        signal,
        deadline,
      );
      if (replay === undefined) {
        await this.#stageBundle(input, staging, signal, deadline);
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
        return replay;
      }
      await this.#validateRepository(input, staging, signal, deadline);
      await this.#writeMarker(staging, json);
      return validatedFact(marker, json);
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
  ): Promise<void> {
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
      return;
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
      await syncDirectory(staging.attempt);
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
        arguments: arguments_,
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

  async #readTrees(
    staging: StagingPaths,
    treeOids: readonly string[],
    oidBytes: number,
    signal: AbortSignal,
    deadline: number,
  ): Promise<ReadonlyMap<string, readonly TreeEntry[]>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('timeout');
    const parser = new StreamingTreeBatchParser({
      expectedOids: treeOids,
      maximumExpandedTreeEntries: this.#maximumExpandedTreeEntries,
      maximumTreeEntries: this.#maximumTreeEntries,
      oidBytes,
    });
    let parserError: unknown;
    try {
      await this.#supervisor.runStreamingCommand({
        arguments: ['cat-file', '--batch'],
        cwd: staging.repository,
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
        signal,
        stdoutMaxBytes: maximumTreeBatchOutputBytes(
          this.#maximumExpandedTreeEntries,
        ),
        timeoutMs: remaining,
      });
      return parser.finish();
    } catch (error: unknown) {
      if (parserError instanceof GitBundleImportError) throw parserError;
      if (error instanceof GitBundleImportError) throw error;
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
  }

  async #verifyRepository(
    input: ImportGitBundleInput,
    staging: StagingPaths,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    await assertPrivateDirectory(staging.repository);
    await this.#verifyGitVersion(signal, deadline);
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
    const importedRefs = parseRefOutput(await this.#run(
      staging,
      ['show-ref', '--heads'],
      { captureOutput: true, deadline, signal },
    ));
    if (!refsEqual(importedRefs, input.refs)) fail('repository-invalid');

    const commitTypes = await this.#run(
      staging,
      ['cat-file', '--batch-check=%(objecttype)'],
      {
        captureOutput: true,
        deadline,
        input: `${input.refs.map(ref => ref.oid).join('\n')}\n`,
        signal,
      },
    );
    if (commitTypes.toString('utf8').trim().split('\n').some(type => type !== 'commit')) {
      fail('repository-invalid');
    }
    const fsck = await this.#run(
      staging,
      ['fsck', '--full', '--strict', '--unreachable', '--no-reflogs', '--no-progress'],
      { captureOutput: true, deadline, signal },
    );
    if (fsck.length !== 0) fail('repository-invalid');

    const inventory = parseInventory(await this.#run(
      staging,
      [
        'cat-file',
        '--batch-all-objects',
        '--unordered',
        '--batch-check=%(objectname) %(objecttype) %(objectsize)',
      ],
      { captureOutput: true, deadline, signal },
    ));
    let repositoryBytes = 0;
    const treeOids: string[] = [];
    for (const object of inventory.values()) {
      repositoryBytes += object.size;
      if (!Number.isSafeInteger(repositoryBytes)) fail('repository-limit');
      if (object.type === 'blob' && object.size > this.#maximumBlobBytes) {
        fail('repository-limit');
      }
      if (object.type === 'tree') treeOids.push(object.oid);
      else if (object.type !== 'blob' && object.type !== 'commit') {
        fail('repository-invalid');
      }
    }
    if (repositoryBytes > this.#maximumRepositoryBytes) fail('repository-limit');

    const rootTrees = (await this.#run(
      staging,
      ['log', '--format=%T', '--all'],
      { captureOutput: true, deadline, signal },
    )).toString('utf8').trim().split('\n').filter(Boolean);
    if (rootTrees.length === 0) fail('repository-invalid');
    const oidBytes = input.objectFormat === 'sha1' ? 20 : 32;
    const trees = await this.#readTrees(
      staging,
      treeOids,
      oidBytes,
      signal,
      deadline,
    );
    await validateTrees(
      rootTrees,
      trees,
      inventory,
      this.#maximumExpandedTreeEntries,
      this.#maximumTreeEntries,
      deadline,
      signal,
      () => this.#closed,
    );
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
      await syncDirectory(staging.repository);
    } catch {
      await handle?.close().catch(() => undefined);
      await rm(staging.markerPart, { force: true }).catch(() => undefined);
      fail('storage-unavailable');
    }
  }
}
