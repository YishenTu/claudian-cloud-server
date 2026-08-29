import { constants } from 'node:fs';
import type { BigIntStats, Dir } from 'node:fs';
import {
  access,
  lstat,
  open,
  opendir,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, normalize, parse, sep } from 'node:path';
import { getgid, getuid } from 'node:process';

export type RepositoryRestoreInspectionErrorCode =
  | 'cancelled'
  | 'not-empty'
  | 'storage-unavailable';

export class RepositoryRestoreInspectionError extends Error {
  readonly code: RepositoryRestoreInspectionErrorCode;

  constructor(code: RepositoryRestoreInspectionErrorCode) {
    super(`repository-restore-inspection.error.${code}`);
    this.name = 'RepositoryRestoreInspectionError';
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

export interface EnvironmentRestoreRepositoryInspectionOptions {
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
}

interface RootIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface RootPairIdentity {
  readonly repository: RootIdentity;
  readonly staging: RootIdentity;
}

const PRIVATE_DIRECTORY_MODE = 0o700;

function fail(code: RepositoryRestoreInspectionErrorCode): never {
  throw new RepositoryRestoreInspectionError(code);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) fail('cancelled');
}

function assertRootPath(path: string): void {
  if (
    !isAbsolute(path)
    || normalize(path) !== path
    || parse(path).root === path
    || path.endsWith(sep)
  ) {
    throw new TypeError(
      'environment-restore-repository-inspection.options-invalid',
    );
  }
}

function runtimeIdentity(): Readonly<{
  readonly gid: bigint;
  readonly uid: bigint;
}> {
  const uid = getuid?.();
  const gid = getgid?.();
  if (uid === undefined || gid === undefined) fail('storage-unavailable');
  return Object.freeze({ gid: BigInt(gid), uid: BigInt(uid) });
}

function rootIdentity(stat: BigIntStats): RootIdentity {
  const identity = runtimeIdentity();
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== identity.uid
    || stat.gid !== identity.gid
    || Number(stat.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE
  ) fail('storage-unavailable');
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function sameRoot(left: RootIdentity, right: RootIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertCompatiblePair(pair: RootPairIdentity): void {
  if (
    sameRoot(pair.repository, pair.staging)
    || pair.repository.device !== pair.staging.device
  ) fail('storage-unavailable');
}

function samePair(left: RootPairIdentity, right: RootPairIdentity): boolean {
  return sameRoot(left.repository, right.repository)
    && sameRoot(left.staging, right.staging);
}

async function close(handle: FileHandle | undefined): Promise<void> {
  try {
    await handle?.close();
  } catch {
    fail('storage-unavailable');
  }
}

async function closeDirectory(directory: Dir | undefined): Promise<void> {
  try {
    await directory?.close();
  } catch {
    fail('storage-unavailable');
  }
}

/** Proves that canonical and staging repository roots are exact empty stores. */
export class EnvironmentRestoreRepositoryInspection {
  #acceptedPair: RootPairIdentity | undefined;
  readonly #repositoryRoot: string;
  readonly #stagingRoot: string;

  constructor(options: EnvironmentRestoreRepositoryInspectionOptions) {
    assertRootPath(options.repositoryRoot);
    assertRootPath(options.stagingRoot);
    if (
      options.repositoryRoot === options.stagingRoot
      || dirname(options.repositoryRoot) !== dirname(options.stagingRoot)
    ) {
      throw new TypeError(
        'environment-restore-repository-inspection.options-invalid',
      );
    }
    this.#repositoryRoot = options.repositoryRoot;
    this.#stagingRoot = options.stagingRoot;
  }

  async assertEmpty(signal: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    const observed = await this.#inspectPair(signal);
    const confirmed = await this.#inspectPair(signal);
    if (!samePair(observed, confirmed)) fail('storage-unavailable');
    if (
      this.#acceptedPair !== undefined
      && !samePair(this.#acceptedPair, confirmed)
    ) fail('storage-unavailable');
    this.#acceptedPair ??= confirmed;
  }

  async #inspectPair(signal: AbortSignal): Promise<RootPairIdentity> {
    const repository = await this.#assertRootEmpty(
      this.#repositoryRoot,
      signal,
    );
    assertNotAborted(signal);
    const staging = await this.#assertRootEmpty(this.#stagingRoot, signal);
    assertNotAborted(signal);
    const pair = Object.freeze({ repository, staging });
    assertCompatiblePair(pair);
    return pair;
  }

  async #assertRootEmpty(
    path: string,
    signal: AbortSignal,
  ): Promise<RootIdentity> {
    let directory: Dir | undefined;
    let handle: FileHandle | undefined;
    try {
      assertNotAborted(signal);
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      assertNotAborted(signal);
      const opened = rootIdentity(await handle.stat({ bigint: true }));
      assertNotAborted(signal);
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
      assertNotAborted(signal);
      directory = await opendir(path, { bufferSize: 1 });
      assertNotAborted(signal);
      if (await directory.read() !== null) fail('not-empty');
      await closeDirectory(directory);
      directory = undefined;
      assertNotAborted(signal);
      const [stillOpened, current] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]);
      assertNotAborted(signal);
      if (
        !sameRoot(opened, rootIdentity(stillOpened))
        || !sameRoot(opened, rootIdentity(current))
      ) fail('storage-unavailable');
      return opened;
    } catch (error: unknown) {
      if (error instanceof RepositoryRestoreInspectionError) throw error;
      if (signal.aborted) fail('cancelled');
      fail('storage-unavailable');
    } finally {
      await closeDirectory(directory);
      await close(handle);
    }
  }
}
