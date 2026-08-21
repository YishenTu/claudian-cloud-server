import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { getuid } from 'node:process';

import {
  isCollabGitOid,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian/collab-protocol';
import type { DevelopmentBootstrapGitRef } from '@claudian/collab-protocol';

import type { ValidatedBootstrapRepository } from './GitBundleImporter.js';
import {
  BootstrapRepositoryIntegrityError,
  type BootstrapRepositoryIntegrityPort,
} from './BootstrapRepositoryIntegrityVerifier.js';

export type RepositoryPublicationErrorCode =
  | 'ambiguous-state'
  | 'closed'
  | 'invalid-publication'
  | 'marker-conflict'
  | 'missing-state'
  | 'repository-invalid'
  | 'storage-unavailable';

export class RepositoryPublicationError extends Error {
  readonly code: RepositoryPublicationErrorCode;

  constructor(code: RepositoryPublicationErrorCode) {
    super(`repository-publication.error.${code}`);
    this.name = 'RepositoryPublicationError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
    });
  }
}

export interface RepositoryPublicationOptions {
  readonly integrityVerifier: BootstrapRepositoryIntegrityPort;
  readonly repositoryRoot: string;
  readonly syncDirectory?: (path: string) => Promise<void>;
  readonly stagingRoot: string;
  readonly storageNodeId: string;
}

export interface PrepareRepositoryPublicationInput {
  readonly generation: 1;
  readonly repository: ValidatedBootstrapRepository;
  readonly repositoryStorageKey: string;
}

export interface PreparedRepositoryPublication {
  readonly artifactKey: string;
  readonly attemptId: string;
  readonly generation: 1;
  readonly markerSha256: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly projectId: string;
  readonly publicationMarkerSha256: string;
  readonly refs: readonly DevelopmentBootstrapGitRef[];
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
  readonly validationMarkerSha256: string;
}

export interface RepositoryPublicationObservation {
  readonly state: 'published' | 'staged';
}

export interface RepositoryPublicationResult {
  readonly publication: PreparedRepositoryPublication;
  readonly status: 'published' | 'replayed';
}

interface PublicationPaths {
  readonly attempt: string;
  readonly attemptMarker: string;
  readonly canonicalProject: string;
  readonly publicationMarker: string;
  readonly publicationMarkerPart: string;
  readonly repository: string;
  readonly stagedRepository: string;
  readonly validationMarker: string;
}

interface RootIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

type PublicationWithoutDigest = Omit<
  PreparedRepositoryPublication,
  'publicationMarkerSha256'
>;

const ATTEMPT_MARKER = '.claudian-cloud-attempt.json';
const VALIDATION_MARKER = '.claudian-cloud-validation.json';
const PUBLICATION_MARKER = '.claudian-cloud-publication.json';
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const STORAGE_NODE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function fail(code: RepositoryPublicationErrorCode): never {
  throw new RepositoryPublicationError(code);
}

function artifactKey(projectId: string, attemptId: string): string {
  return createHash('sha256').update(`${projectId}\0${attemptId}`, 'utf8').digest('hex');
}

function assertRootPath(path: string): void {
  if (
    !isAbsolute(path)
    || normalize(path) !== path
    || parse(path).root === path
  ) {
    throw new TypeError('repository-publication.options-invalid');
  }
}

function assertOptions(options: RepositoryPublicationOptions): void {
  assertRootPath(options.repositoryRoot);
  assertRootPath(options.stagingRoot);
  if (
    options.repositoryRoot === options.stagingRoot
    || dirname(options.repositoryRoot) !== dirname(options.stagingRoot)
    || !STORAGE_NODE_PATTERN.test(options.storageNodeId)
  ) {
    throw new TypeError('repository-publication.options-invalid');
  }
}

function publicationPaths(
  options: RepositoryPublicationOptions,
  projectId: string,
  attemptId: string,
  repositoryStorageKey: string,
): PublicationPaths {
  const projectHex = Buffer.from(projectId, 'utf8').toString('hex');
  const attemptHex = Buffer.from(attemptId, 'utf8').toString('hex');
  const attempt = join(options.stagingRoot, projectHex, attemptHex);
  const stagedRepository = join(attempt, 'repository');
  const canonicalProject = join(options.repositoryRoot, projectHex);
  const repository = join(canonicalProject, repositoryStorageKey);
  return Object.freeze({
    attempt,
    attemptMarker: join(attempt, ATTEMPT_MARKER),
    canonicalProject,
    publicationMarker: join(stagedRepository, PUBLICATION_MARKER),
    publicationMarkerPart: join(stagedRepository, `.${PUBLICATION_MARKER}.part`),
    repository,
    stagedRepository,
    validationMarker: join(stagedRepository, VALIDATION_MARKER),
  });
}

function publicationMarkerJson(publication: PublicationWithoutDigest): string {
  return `${JSON.stringify({
    artifactKey: publication.artifactKey,
    attemptId: publication.attemptId,
    generation: publication.generation,
    markerSha256: publication.markerSha256,
    objectFormat: publication.objectFormat,
    projectId: publication.projectId,
    refs: publication.refs,
    repositoryStorageKey: publication.repositoryStorageKey,
    schemaVersion: 1,
    storageNodeId: publication.storageNodeId,
    validationMarkerSha256: publication.validationMarkerSha256,
  })}\n`;
}

function withoutPublicationDigest(
  publication: PreparedRepositoryPublication,
): PublicationWithoutDigest {
  return Object.freeze({
    artifactKey: publication.artifactKey,
    attemptId: publication.attemptId,
    generation: publication.generation,
    markerSha256: publication.markerSha256,
    objectFormat: publication.objectFormat,
    projectId: publication.projectId,
    refs: publication.refs,
    repositoryStorageKey: publication.repositoryStorageKey,
    storageNodeId: publication.storageNodeId,
    validationMarkerSha256: publication.validationMarkerSha256,
  });
}

function preparedPublication(
  options: RepositoryPublicationOptions,
  input: PrepareRepositoryPublicationInput,
): PreparedRepositoryPublication {
  const repository = input.repository;
  if (
    !isCollabProjectId(repository.projectId)
    || !isCollabOpaqueId(repository.attemptId)
    || repository.artifactKey !== artifactKey(repository.projectId, repository.attemptId)
    || !SHA256_PATTERN.test(repository.markerSha256)
    || repository.refs.length !== 3
    || repository.refs.some(ref => !isCollabGitOid(ref.oid))
    || !STORAGE_KEY_PATTERN.test(input.repositoryStorageKey)
  ) {
    fail('invalid-publication');
  }
  const withoutDigest = Object.freeze({
    artifactKey: repository.artifactKey,
    attemptId: repository.attemptId,
    generation: input.generation,
    markerSha256: repository.markerSha256,
    objectFormat: repository.objectFormat,
    projectId: repository.projectId,
    refs: Object.freeze(repository.refs.map(ref => Object.freeze({ ...ref }))),
    repositoryStorageKey: input.repositoryStorageKey,
    storageNodeId: options.storageNodeId,
    validationMarkerSha256: repository.markerSha256,
  });
  const json = publicationMarkerJson(withoutDigest);
  return Object.freeze({
    ...withoutDigest,
    publicationMarkerSha256: createHash('sha256').update(json, 'utf8').digest('hex'),
  });
}

function assertPrepared(
  options: RepositoryPublicationOptions,
  publication: PreparedRepositoryPublication,
): void {
  if (
    !isCollabProjectId(publication.projectId)
    || !isCollabOpaqueId(publication.attemptId)
    || publication.artifactKey !== artifactKey(
      publication.projectId,
      publication.attemptId,
    )
    || !STORAGE_KEY_PATTERN.test(publication.repositoryStorageKey)
    || publication.storageNodeId !== options.storageNodeId
    || !SHA256_PATTERN.test(publication.markerSha256)
    || publication.markerSha256 !== publication.validationMarkerSha256
    || !SHA256_PATTERN.test(publication.publicationMarkerSha256)
    || publication.refs.length !== 3
    || publication.refs.some(ref => (
      typeof ref.name !== 'string' || !isCollabGitOid(ref.oid)
    ))
  ) {
    fail('invalid-publication');
  }
  if (
    createHash('sha256')
      .update(publicationMarkerJson(withoutPublicationDigest(publication)), 'utf8')
      .digest('hex') !== publication.publicationMarkerSha256
  ) {
    fail('invalid-publication');
  }
}

async function inspectRoot(path: string): Promise<{
  readonly device: bigint;
  readonly inode: bigint;
}> {
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
    return Object.freeze({ device: entry.dev, inode: entry.ino });
  } catch (error: unknown) {
    if (error instanceof RepositoryPublicationError) throw error;
    fail('storage-unavailable');
  }
}

function sameRoot(left: RootIdentity, right: RootIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function syncDirectoryOnDisk(path: string): Promise<void> {
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

async function existsDirectory(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('marker-conflict');
    return true;
  } catch (error: unknown) {
    if (error instanceof RepositoryPublicationError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    fail('storage-unavailable');
  }
}

async function assertFileDigest(path: string, sha256: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) {
      fail('marker-conflict');
    }
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== sha256) fail('marker-conflict');
  } catch (error: unknown) {
    if (error instanceof RepositoryPublicationError) throw error;
    fail('marker-conflict');
  }
}

async function removeOwnedPartialFile(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) fail('marker-conflict');
    await rm(path);
  } catch (error: unknown) {
    if (error instanceof RepositoryPublicationError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    fail('storage-unavailable');
  }
}

async function assertAttemptMarker(
  path: string,
  publication: PreparedRepositoryPublication,
): Promise<void> {
  const expected = `${JSON.stringify({
    artifactKey: publication.artifactKey,
    attemptId: publication.attemptId,
    projectId: publication.projectId,
    schemaVersion: 1,
  })}\n`;
  try {
    const entry = await lstat(path);
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || entry.size !== Buffer.byteLength(expected, 'utf8')
      || await readFile(path, 'utf8') !== expected
    ) {
      fail('marker-conflict');
    }
  } catch (error: unknown) {
    if (error instanceof RepositoryPublicationError) throw error;
    fail('marker-conflict');
  }
}

async function assertPublicationMarkers(
  repository: string,
  publication: PreparedRepositoryPublication,
): Promise<void> {
  await assertFileDigest(
    join(repository, VALIDATION_MARKER),
    publication.validationMarkerSha256,
  );
  const marker = join(repository, PUBLICATION_MARKER);
  await assertFileDigest(marker, publication.publicationMarkerSha256);
  if (
    await readFile(marker, 'utf8')
    !== publicationMarkerJson(withoutPublicationDigest(publication))
  ) {
    fail('marker-conflict');
  }
}

export class RepositoryPublication {
  readonly #directorySync: (path: string) => Promise<void>;
  readonly #integrityVerifier: BootstrapRepositoryIntegrityPort;
  readonly #options: RepositoryPublicationOptions;
  #closed = false;
  #repositoryRootIdentity: RootIdentity | undefined;
  #stagingRootIdentity: RootIdentity | undefined;

  constructor(options: RepositoryPublicationOptions) {
    assertOptions(options);
    this.#options = options;
    this.#directorySync = options.syncDirectory ?? syncDirectoryOnDisk;
    this.#integrityVerifier = options.integrityVerifier;
  }

  close(): void {
    this.#closed = true;
  }

  async verifyCapability(): Promise<Readonly<{ status: 'supported' }>> {
    this.#assertOpen();
    await this.#verifyRoots();
    return Object.freeze({ status: 'supported' as const });
  }

  plan(
    input: PrepareRepositoryPublicationInput,
  ): PreparedRepositoryPublication {
    this.#assertOpen();
    return preparedPublication(this.#options, input);
  }

  async prepare(
    input: PrepareRepositoryPublicationInput,
  ): Promise<PreparedRepositoryPublication> {
    this.#assertOpen();
    const publication = this.plan(input);
    const paths = publicationPaths(
      this.#options,
      publication.projectId,
      publication.attemptId,
      publication.repositoryStorageKey,
    );
    await this.#verifyRoots();
    const staged = await existsDirectory(paths.stagedRepository);
    const published = await existsDirectory(paths.repository);
    if (staged && published) fail('ambiguous-state');
    if (!staged && !published) fail('missing-state');
    if (published) {
      await assertPublicationMarkers(paths.repository, publication);
      await this.#verifyRepository(paths.repository, publication);
      return publication;
    }

    await assertAttemptMarker(paths.attemptMarker, publication);
    await assertFileDigest(paths.validationMarker, publication.validationMarkerSha256);
    await this.#verifyRepository(paths.stagedRepository, publication);
    const json = publicationMarkerJson(withoutPublicationDigest(publication));
    try {
      const entry = await lstat(paths.publicationMarker);
      if (!entry.isFile() || entry.isSymbolicLink()) fail('marker-conflict');
      const existing = await readFile(paths.publicationMarker, 'utf8');
      if (existing !== json) fail('marker-conflict');
      await removeOwnedPartialFile(paths.publicationMarkerPart);
      return publication;
    } catch (error: unknown) {
      if (error instanceof RepositoryPublicationError) throw error;
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        fail('marker-conflict');
      }
    }
    await removeOwnedPartialFile(paths.publicationMarkerPart);
    let handle;
    try {
      handle = await open(paths.publicationMarkerPart, 'wx', FILE_MODE);
      await handle.writeFile(json, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(paths.publicationMarkerPart, paths.publicationMarker);
      await this.#syncDirectory(paths.stagedRepository);
      return publication;
    } catch {
      await handle?.close().catch(() => undefined);
      await rm(paths.publicationMarkerPart, { force: true }).catch(() => undefined);
      fail('storage-unavailable');
    }
  }

  async inspect(
    publication: PreparedRepositoryPublication,
  ): Promise<RepositoryPublicationObservation> {
    this.#assertOpen();
    assertPrepared(this.#options, publication);
    await this.#verifyRoots();
    const paths = publicationPaths(
      this.#options,
      publication.projectId,
      publication.attemptId,
      publication.repositoryStorageKey,
    );
    const staged = await existsDirectory(paths.stagedRepository);
    const published = await existsDirectory(paths.repository);
    if (staged && published) fail('ambiguous-state');
    if (!staged && !published) fail('missing-state');
    const repository = staged ? paths.stagedRepository : paths.repository;
    await assertPublicationMarkers(repository, publication);
    await this.#verifyRepository(repository, publication);
    return Object.freeze({ state: staged ? 'staged' : 'published' });
  }

  async publish(
    publication: PreparedRepositoryPublication,
  ): Promise<RepositoryPublicationResult> {
    const observation = await this.inspect(publication);
    if (observation.state === 'published') {
      const paths = publicationPaths(
        this.#options,
        publication.projectId,
        publication.attemptId,
        publication.repositoryStorageKey,
      );
      await this.#syncPublishedPlacement(paths);
      return Object.freeze({ publication, status: 'replayed' as const });
    }
    const paths = publicationPaths(
      this.#options,
      publication.projectId,
      publication.attemptId,
      publication.repositoryStorageKey,
    );
    try {
      await mkdir(paths.canonicalProject, { mode: DIRECTORY_MODE });
    } catch (error: unknown) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
        fail('storage-unavailable');
      }
    }
    await this.#syncDirectory(this.#options.repositoryRoot);
    await inspectRoot(paths.canonicalProject);
    try {
      await rename(paths.stagedRepository, paths.repository);
    } catch {
      const recovered = await this.inspect(publication).catch(() => undefined);
      if (recovered?.state !== 'published') fail('storage-unavailable');
    }
    await this.#syncPublishedPlacement(paths);
    const published = await this.inspect(publication);
    if (published.state !== 'published') fail('storage-unavailable');
    return Object.freeze({ publication, status: 'published' as const });
  }

  async cleanupAttempt(
    publication: PreparedRepositoryPublication,
  ): Promise<'cleaned' | 'replayed'> {
    const observation = await this.inspect(publication);
    if (observation.state !== 'published') fail('ambiguous-state');
    const paths = publicationPaths(
      this.#options,
      publication.projectId,
      publication.attemptId,
      publication.repositoryStorageKey,
    );
    try {
      await assertAttemptMarker(paths.attemptMarker, publication);
    } catch (error: unknown) {
      if (error instanceof RepositoryPublicationError && error.code === 'marker-conflict') {
        const exists = await existsDirectory(paths.attempt);
        if (!exists) return 'replayed';
      }
      throw error;
    }
    await rm(paths.attempt, { recursive: true });
    await this.#syncDirectory(dirname(paths.attempt));
    return 'cleaned';
  }

  async #syncPublishedPlacement(paths: PublicationPaths): Promise<void> {
    await this.#syncDirectory(this.#options.repositoryRoot);
    if (await existsDirectory(paths.attempt)) {
      await this.#syncDirectory(paths.attempt);
    }
    await this.#syncDirectory(paths.canonicalProject);
  }

  async #syncDirectory(path: string): Promise<void> {
    try {
      await this.#directorySync(path);
    } catch {
      fail('storage-unavailable');
    }
  }

  async #verifyRoots(): Promise<void> {
    const [repositories, staging] = await Promise.all([
      inspectRoot(this.#options.repositoryRoot),
      inspectRoot(this.#options.stagingRoot),
    ]);
    if (repositories.device !== staging.device) fail('storage-unavailable');
    if (this.#repositoryRootIdentity === undefined) {
      this.#repositoryRootIdentity = repositories;
      this.#stagingRootIdentity = staging;
    } else if (
      !sameRoot(this.#repositoryRootIdentity, repositories)
      || this.#stagingRootIdentity === undefined
      || !sameRoot(this.#stagingRootIdentity, staging)
    ) {
      fail('storage-unavailable');
    }
  }

  async #verifyRepository(
    repositoryPath: string,
    publication: PreparedRepositoryPublication,
  ): Promise<void> {
    try {
      await this.#integrityVerifier.verify({
        objectFormat: publication.objectFormat,
        projectId: publication.projectId,
        refs: publication.refs,
        repositoryPath,
      });
    } catch (error: unknown) {
      if (
        error instanceof BootstrapRepositoryIntegrityError
        && error.code === 'repository-invalid'
      ) {
        fail('repository-invalid');
      }
      fail('storage-unavailable');
    }
  }

  #assertOpen(): void {
    if (this.#closed) fail('closed');
  }
}
