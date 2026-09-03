import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { getuid } from 'node:process';

import type {
  CollabGitOid,
  CollabProjectId,
} from '@claudian-collab/protocol';
import {
  collabMemberRef,
  isCollabGitOid,
  isCollabMemberId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import type { CloudProjectCreationCommitPlan } from '../coordination/CloudProjectCreationPersistence.js';
import {
  ResourceAdmissionError,
  type GitChildPermit,
  type ResourceAdmission,
} from '../resource-admission/ResourceAdmission.js';
import {
  GitProcessError,
  GitProcessSupervisor,
} from './GitProcessSupervisor.js';

export interface EmptyProjectPublicationPlan
  extends CloudProjectCreationCommitPlan {
  readonly planSha256: string;
  readonly projectId: CollabProjectId;
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
}

export interface EmptyProjectRepositoryReservation {
  readonly projectId: CollabProjectId;
  close(): Promise<void>;
}

export interface EmptyProjectRepository {
  publish(
    reservation: EmptyProjectRepositoryReservation,
    plan: EmptyProjectPublicationPlan,
  ): Promise<Readonly<{
    readonly publicationMarkerSha256: string;
    readonly status: 'published' | 'replayed';
  }>>;
  reserve(
    projectId: CollabProjectId,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<EmptyProjectRepositoryReservation>;
  verify(
    reservation: EmptyProjectRepositoryReservation,
    plan: EmptyProjectPublicationPlan,
    publicationMarkerSha256: string,
  ): Promise<void>;
}

export type EmptyProjectRepositoryErrorCode =
  | 'cancelled'
  | 'closed'
  | 'invalid-plan'
  | 'state-conflict'
  | 'unavailable';

export class EmptyProjectRepositoryError extends Error {
  readonly code: EmptyProjectRepositoryErrorCode;

  constructor(code: EmptyProjectRepositoryErrorCode) {
    super(`empty-project-repository.error.${code}`);
    this.name = 'EmptyProjectRepositoryError';
    this.code = code;
  }
}

export interface EmptyProjectRepositoryVerification {
  readonly initialCommitOid: CollabGitOid;
  readonly publicationMarkerSha256: string;
}

export interface EmptyProjectRepositoryAuthorityOptions {
  readonly gitExecutable: string;
  readonly operationTimeoutMs: number;
  readonly outputMaxBytes: number;
  readonly repositoryRoot: string;
  readonly resourceAdmission: ResourceAdmission;
  readonly storageNodeId: string;
}

interface ReservationState {
  active: boolean;
  readonly permit: GitChildPermit;
  readonly projectId: CollabProjectId;
}

interface RepositoryPaths {
  readonly canonical: string;
  readonly intent: string;
  readonly marker: string;
  readonly markerPart: string;
  readonly namespace: string;
  readonly staging: string;
  readonly stagingIntent: string;
}

const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const STORAGE_NODE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ZERO_SHA1 = '0'.repeat(40);
const INTENT_FILE = '.claudian-cloud-creation-intent.json';
export const EMPTY_PROJECT_PUBLICATION_MARKER_FILE = '.claudian-cloud-creation.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function fail(code: EmptyProjectRepositoryErrorCode): never {
  throw new EmptyProjectRepositoryError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isContained(parent: string, candidate: string): boolean {
  const descendant = relative(parent, candidate);
  return descendant.length > 0
    && descendant !== '..'
    && !descendant.startsWith(`..${sep}`)
    && !isAbsolute(descendant);
}

function assertOptions(options: EmptyProjectRepositoryAuthorityOptions): void {
  if (
    !isAbsolute(options.repositoryRoot)
    || normalize(options.repositoryRoot) !== options.repositoryRoot
    || parse(options.repositoryRoot).root === options.repositoryRoot
    || !STORAGE_NODE_PATTERN.test(options.storageNodeId)
    || !Number.isSafeInteger(options.operationTimeoutMs)
    || options.operationTimeoutMs <= 0
    || !Number.isSafeInteger(options.outputMaxBytes)
    || options.outputMaxBytes <= 0
  ) {
    throw new TypeError('empty-project-repository.options-invalid');
  }
}

function commitContent(plan: EmptyProjectPublicationPlan): string {
  const timestamp = String(plan.commitTimestampSeconds);
  const identity = `${plan.authorName} <${plan.authorEmail}> ${timestamp} ${plan.timezone}`;
  return `tree ${plan.emptyTreeOid}\nauthor ${identity}\ncommitter ${identity}\n\n${plan.commitMessage}\n`;
}

function gitObjectOid(kind: 'commit', content: string): string {
  const length = String(Buffer.byteLength(content, 'utf8'));
  return createHash('sha1')
    .update(`${kind} ${length}\0`, 'utf8')
    .update(content, 'utf8')
    .digest('hex');
}

function intentJson(plan: EmptyProjectPublicationPlan): string {
  return `${JSON.stringify({
    planSha256: plan.planSha256,
    projectId: plan.projectId,
    repositoryStorageKey: plan.repositoryStorageKey,
    schemaVersion: 1,
    storageNodeId: plan.storageNodeId,
  })}\n`;
}

export type EmptyProjectPublicationMarker = Readonly<Pick<
  EmptyProjectPublicationPlan,
  | 'emptyTreeOid'
  | 'initialCommitOid'
  | 'mainRef'
  | 'objectFormat'
  | 'personalRef'
  | 'planSha256'
  | 'projectId'
  | 'repositoryStorageKey'
  | 'storageNodeId'
>>;

export function emptyProjectPublicationMarkerJson(
  plan: EmptyProjectPublicationMarker,
): string {
  return `${JSON.stringify({
    emptyTreeOid: plan.emptyTreeOid,
    initialCommitOid: plan.initialCommitOid,
    mainRef: plan.mainRef,
    objectFormat: plan.objectFormat,
    personalRef: plan.personalRef,
    planSha256: plan.planSha256,
    projectId: plan.projectId,
    repositoryStorageKey: plan.repositoryStorageKey,
    schemaVersion: 1,
    storageNodeId: plan.storageNodeId,
  })}\n`;
}

function assertPlan(plan: EmptyProjectPublicationPlan): void {
  const memberId = plan.personalRef.startsWith('refs/heads/members/')
    ? plan.personalRef.slice('refs/heads/members/'.length)
    : '';
  if (
    !isCollabProjectId(plan.projectId)
    || !isCollabMemberId(memberId)
    || plan.personalRef !== collabMemberRef(memberId)
    || !Number.isSafeInteger(plan.commitTimestampSeconds)
    || plan.commitTimestampSeconds < 0
    || plan.emptyTreeOid !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    || !isCollabGitOid(plan.initialCommitOid)
    || gitObjectOid('commit', commitContent(plan)) !== plan.initialCommitOid
    || !SHA256_PATTERN.test(plan.planSha256)
    || !STORAGE_KEY_PATTERN.test(plan.repositoryStorageKey)
    || !STORAGE_NODE_PATTERN.test(plan.storageNodeId)
  ) fail('invalid-plan');
}

function paths(root: string, plan: EmptyProjectPublicationPlan): RepositoryPaths {
  const namespace = resolve(
    root,
    Buffer.from(plan.projectId, 'utf8').toString('hex'),
  );
  const canonical = resolve(namespace, plan.repositoryStorageKey);
  const staging = resolve(
    namespace,
    `.${plan.repositoryStorageKey}.creation-${plan.planSha256}`,
  );
  if (
    normalize(namespace) !== namespace
    || !isContained(root, namespace)
    || !isContained(namespace, canonical)
    || !isContained(namespace, staging)
  ) fail('invalid-plan');
  return Object.freeze({
    canonical,
    intent: join(canonical, INTENT_FILE),
    marker: join(canonical, EMPTY_PROJECT_PUBLICATION_MARKER_FILE),
    markerPart: join(
      canonical,
      `.${EMPTY_PROJECT_PUBLICATION_MARKER_FILE}.${plan.planSha256}.part`,
    ),
    namespace,
    staging,
    stagingIntent: join(staging, INTENT_FILE),
  });
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path: string, value: string): Promise<'created' | 'exists'> {
  let handle;
  try {
    handle = await open(path, 'wx', FILE_MODE);
  } catch (error: unknown) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'EEXIST'
    ) return 'exists';
    fail('unavailable');
  }
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } catch {
    fail('unavailable');
  } finally {
    await handle.close().catch(() => undefined);
  }
  return 'created';
}

async function exactFile(path: string, expected: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isFile()
      && !entry.isSymbolicLink()
      && entry.size === Buffer.byteLength(expected, 'utf8')
      && await readFile(path, 'utf8') === expected;
  } catch {
    return false;
  }
}

function mapDependency(error: unknown): never {
  if (error instanceof EmptyProjectRepositoryError) throw error;
  if (error instanceof ResourceAdmissionError) {
    if (error.code === 'cancelled') fail('cancelled');
    if (error.code === 'closed') fail('closed');
    fail('unavailable');
  }
  if (error instanceof GitProcessError) {
    if (error.code === 'cancelled') fail('cancelled');
    if (error.code === 'closed') fail('closed');
    if (error.code === 'repository-corrupt') fail('state-conflict');
    fail('unavailable');
  }
  fail('unavailable');
}

export class EmptyProjectRepositoryAuthority implements EmptyProjectRepository {
  readonly #activeReservations = new Set<ReservationState>();
  readonly #options: EmptyProjectRepositoryAuthorityOptions;
  readonly #reservations = new WeakMap<EmptyProjectRepositoryReservation, ReservationState>();
  readonly #supervisor: GitProcessSupervisor;
  #closed = false;

  constructor(options: EmptyProjectRepositoryAuthorityOptions) {
    assertOptions(options);
    this.#options = options;
    this.#supervisor = new GitProcessSupervisor({
      gitExecutable: options.gitExecutable,
      operationTimeoutMs: options.operationTimeoutMs,
      outputMaxBytes: options.outputMaxBytes,
    });
  }

  async reserve(
    projectId: CollabProjectId,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<EmptyProjectRepositoryReservation> {
    if (this.#closed) fail('closed');
    let permit: GitChildPermit;
    try {
      permit = await this.#options.resourceAdmission.acquireGitChild({
        classification: 'write',
        projectId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error: unknown) {
      mapDependency(error);
    }
    const reservation: EmptyProjectRepositoryReservation = Object.freeze({
      close: (): Promise<void> => {
        const state = this.#reservations.get(reservation);
        if (state?.active === true) {
          state.active = false;
          state.permit.release();
          this.#activeReservations.delete(state);
        }
        return Promise.resolve();
      },
      projectId,
    });
    const state: ReservationState = { active: true, permit, projectId };
    this.#reservations.set(reservation, state);
    this.#activeReservations.add(state);
    return reservation;
  }

  async publish(
    reservation: EmptyProjectRepositoryReservation,
    plan: EmptyProjectPublicationPlan,
  ): Promise<Readonly<{
    readonly publicationMarkerSha256: string;
    readonly status: 'published' | 'replayed';
  }>> {
    try {
      this.#assertReservation(reservation, plan);
      const location = await this.#prepareLocation(plan);
      const expectedMarker = emptyProjectPublicationMarkerJson(plan);
      const replayed = await exactFile(location.marker, expectedMarker);
      await this.#initializeAndWriteObjects(location.canonical, plan);
      await this.#establishRefs(location.canonical, plan);
      await this.#publishMarker(location, expectedMarker);
      await this.#verify(location, plan, sha256(expectedMarker));
      return Object.freeze({
        publicationMarkerSha256: sha256(expectedMarker),
        status: replayed ? 'replayed' as const : 'published' as const,
      });
    } catch (error: unknown) {
      mapDependency(error);
    }
  }

  async verify(
    reservation: EmptyProjectRepositoryReservation,
    plan: EmptyProjectPublicationPlan,
    publicationMarkerSha256: string,
  ): Promise<void> {
    try {
      this.#assertReservation(reservation, plan);
      if (!SHA256_PATTERN.test(publicationMarkerSha256)) fail('invalid-plan');
      const location = paths(this.#options.repositoryRoot, plan);
      await this.#verify(location, plan, publicationMarkerSha256);
    } catch (error: unknown) {
      mapDependency(error);
    }
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const state of this.#activeReservations) {
        state.active = false;
        state.permit.release();
      }
      this.#activeReservations.clear();
    }
    return this.#supervisor.close();
  }

  #assertReservation(
    reservation: EmptyProjectRepositoryReservation,
    plan: EmptyProjectPublicationPlan,
  ): void {
    if (this.#closed) fail('closed');
    assertPlan(plan);
    const state = this.#reservations.get(reservation);
    if (
      state?.active !== true
      || state.projectId !== plan.projectId
      || reservation.projectId !== plan.projectId
      || plan.storageNodeId !== this.#options.storageNodeId
    ) fail('invalid-plan');
  }

  async #verifyRoot(): Promise<string> {
    try {
      const entry = await lstat(this.#options.repositoryRoot, { bigint: true });
      const uid = getuid?.();
      const real = await realpath(this.#options.repositoryRoot);
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || uid === undefined
        || entry.uid !== BigInt(uid)
      ) fail('unavailable');
      return real;
    } catch (error: unknown) {
      if (error instanceof EmptyProjectRepositoryError) throw error;
      fail('unavailable');
    }
  }

  async #prepareLocation(plan: EmptyProjectPublicationPlan): Promise<RepositoryPaths> {
    const root = await this.#verifyRoot();
    const location = paths(root, plan);
    try {
      await mkdir(location.namespace, { mode: DIRECTORY_MODE });
    } catch (error: unknown) {
      if (
        typeof error !== 'object'
        || error === null
        || !('code' in error)
        || error.code !== 'EEXIST'
      ) fail('unavailable');
    }
    const namespaceEntry = await lstat(location.namespace);
    if (!namespaceEntry.isDirectory() || namespaceEntry.isSymbolicLink()) {
      fail('state-conflict');
    }
    const expectedIntent = intentJson(plan);
    let canonicalExists = false;
    try {
      const entry = await lstat(location.canonical);
      canonicalExists = true;
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('state-conflict');
    } catch (error: unknown) {
      if (error instanceof EmptyProjectRepositoryError) throw error;
      if (
        typeof error !== 'object'
        || error === null
        || !('code' in error)
        || error.code !== 'ENOENT'
      ) fail('unavailable');
    }
    if (!canonicalExists) {
      try {
        await mkdir(location.staging, { mode: DIRECTORY_MODE });
      } catch (error: unknown) {
        if (
          typeof error !== 'object'
          || error === null
          || !('code' in error)
          || error.code !== 'EEXIST'
        ) fail('unavailable');
      }
      const stagingEntry = await lstat(location.staging);
      if (!stagingEntry.isDirectory() || stagingEntry.isSymbolicLink()) {
        fail('state-conflict');
      }
      const created = await writeExclusive(location.stagingIntent, expectedIntent);
      if (created === 'exists' && !await exactFile(location.stagingIntent, expectedIntent)) {
        fail('state-conflict');
      }
      await syncDirectory(location.staging);
      try {
        await rename(location.staging, location.canonical);
      } catch {
        if (!await exactFile(location.intent, expectedIntent)) fail('state-conflict');
      }
      await syncDirectory(location.namespace);
    }
    if (!await exactFile(location.intent, expectedIntent)) fail('state-conflict');
    const canonicalReal = await realpath(location.canonical);
    if (!isContained(root, canonicalReal)) fail('state-conflict');
    return location;
  }

  async #initializeAndWriteObjects(
    repository: string,
    plan: EmptyProjectPublicationPlan,
  ): Promise<void> {
    let initialized = false;
    try {
      const result = await this.#supervisor.runCommand({
        arguments: ['rev-parse', '--is-bare-repository'],
        captureOutput: true,
        cwd: repository,
        failureCode: 'repository-corrupt',
      });
      initialized = result.toString('utf8').trim() === 'true';
    } catch (error: unknown) {
      if (!(error instanceof GitProcessError)) throw error;
    }
    if (!initialized) {
      const entries = await readdir(repository);
      if (!entries.every(entry => entry === INTENT_FILE)) fail('state-conflict');
      await this.#supervisor.runCommand({
        arguments: ['init', '--bare', '--object-format=sha1', '.'],
        captureOutput: false,
        cwd: repository,
        failureCode: 'repository-corrupt',
      });
    }
    const format = await this.#supervisor.runCommand({
      arguments: ['rev-parse', '--show-object-format'],
      captureOutput: true,
      cwd: repository,
      failureCode: 'repository-corrupt',
    });
    if (format.toString('utf8').trim() !== plan.objectFormat) fail('state-conflict');
    const tree = await this.#supervisor.runCommand({
      arguments: ['hash-object', '-t', 'tree', '-w', '--stdin'],
      captureOutput: true,
      cwd: repository,
      failureCode: 'repository-corrupt',
      input: Buffer.alloc(0),
    });
    if (tree.toString('utf8').trim() !== plan.emptyTreeOid) fail('state-conflict');
    const commit = await this.#supervisor.runCommand({
      arguments: ['hash-object', '-t', 'commit', '-w', '--stdin'],
      captureOutput: true,
      cwd: repository,
      failureCode: 'repository-corrupt',
      input: commitContent(plan),
    });
    if (commit.toString('utf8').trim() !== plan.initialCommitOid) {
      fail('state-conflict');
    }
  }

  async #readRefs(repository: string): Promise<Map<string, string>> {
    const output = await this.#supervisor.runCommand({
      arguments: ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs'],
      captureOutput: true,
      cwd: repository,
      failureCode: 'repository-corrupt',
    });
    const refs = new Map<string, string>();
    for (const line of output.toString('utf8').split('\n')) {
      if (line.length === 0) continue;
      const [name, oid, extra] = line.split('\0');
      if (name === undefined || oid === undefined || extra !== undefined) {
        fail('state-conflict');
      }
      refs.set(name, oid);
    }
    return refs;
  }

  async #establishRefs(
    repository: string,
    plan: EmptyProjectPublicationPlan,
  ): Promise<void> {
    let refs = await this.#readRefs(repository);
    const expected = new Map([
      [plan.mainRef, plan.initialCommitOid],
      [plan.personalRef, plan.initialCommitOid],
    ]);
    if (
      [...refs].some(([name, oid]) => expected.get(name) !== oid)
      || refs.size > expected.size
    ) fail('state-conflict');
    for (const [name, oid] of expected) {
      if (refs.get(name) === oid) continue;
      try {
        await this.#supervisor.runCommand({
          arguments: ['update-ref', name, oid, ZERO_SHA1],
          captureOutput: false,
          cwd: repository,
          failureCode: 'repository-corrupt',
        });
      } catch (error: unknown) {
        if (!(error instanceof GitProcessError)) throw error;
        refs = await this.#readRefs(repository);
        if (refs.get(name) !== oid) fail('state-conflict');
      }
    }
    refs = await this.#readRefs(repository);
    if (
      refs.size !== expected.size
      || [...expected].some(([name, oid]) => refs.get(name) !== oid)
    ) fail('state-conflict');
  }

  async #publishMarker(
    location: RepositoryPaths,
    expected: string,
  ): Promise<void> {
    if (await exactFile(location.marker, expected)) return;
    try {
      await lstat(location.marker);
      fail('state-conflict');
    } catch (error: unknown) {
      if (error instanceof EmptyProjectRepositoryError) throw error;
      if (
        typeof error !== 'object'
        || error === null
        || !('code' in error)
        || error.code !== 'ENOENT'
      ) fail('unavailable');
    }
    const created = await writeExclusive(location.markerPart, expected);
    if (created === 'exists' && !await exactFile(location.markerPart, expected)) {
      fail('state-conflict');
    }
    try {
      await rename(location.markerPart, location.marker);
    } catch {
      if (!await exactFile(location.marker, expected)) fail('state-conflict');
    }
    await syncDirectory(location.canonical);
  }

  async #verify(
    location: RepositoryPaths,
    plan: EmptyProjectPublicationPlan,
    publicationMarkerSha256: string,
  ): Promise<void> {
    const expectedMarker = emptyProjectPublicationMarkerJson(plan);
    if (
      sha256(expectedMarker) !== publicationMarkerSha256
      || !await exactFile(location.intent, intentJson(plan))
      || !await exactFile(location.marker, expectedMarker)
    ) fail('state-conflict');
    const commit = await this.#supervisor.runCommand({
      arguments: ['cat-file', 'commit', plan.initialCommitOid],
      captureOutput: true,
      cwd: location.canonical,
      failureCode: 'repository-corrupt',
    });
    if (commit.toString('utf8') !== commitContent(plan)) fail('state-conflict');
    const refs = await this.#readRefs(location.canonical);
    if (
      refs.size !== 2
      || refs.get(plan.mainRef) !== plan.initialCommitOid
      || refs.get(plan.personalRef) !== plan.initialCommitOid
    ) fail('state-conflict');
    await this.#supervisor.runIntegrityCheck(location.canonical);
  }
}
