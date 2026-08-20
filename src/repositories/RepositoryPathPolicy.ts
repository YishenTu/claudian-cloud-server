import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { getuid } from 'node:process';

import {
  assertRepositoryPlacementLease,
  RepositoryPlacementError,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from './RepositoryPlacement.js';

export interface RepositoryPathPolicyOptions {
  readonly placementValidator: RepositoryPlacementValidator;
  readonly repositoryRoot: string;
  readonly storageNodeId: string;
}

export interface ResolvedRepositoryLocation {
  readonly placement: RepositoryPlacementLease;
  readonly repositoryPath: string;
}

interface RootIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly realPath: string;
}

function rootUnavailable(): never {
  throw new RepositoryPlacementError('repository-root-unavailable');
}

function pathInvalid(): never {
  throw new RepositoryPlacementError('repository-path-invalid');
}

function sameRoot(left: RootIdentity, right: RootIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.realPath === right.realPath;
}

function isContained(root: string, candidate: string): boolean {
  const descendant = relative(root, candidate);
  return descendant.length > 0
    && descendant !== '..'
    && !descendant.startsWith(`..${sep}`)
    && !isAbsolute(descendant);
}

export class RepositoryPathPolicy {
  readonly #placementValidator: RepositoryPlacementValidator;
  readonly #repositoryRoot: string;
  readonly #storageNodeId: string;
  #acceptedRoot: RootIdentity | undefined;

  constructor(options: RepositoryPathPolicyOptions) {
    this.#placementValidator = options.placementValidator;
    this.#repositoryRoot = options.repositoryRoot;
    this.#storageNodeId = options.storageNodeId;
  }

  async resolveExisting(
    placement: RepositoryPlacementLease,
  ): Promise<ResolvedRepositoryLocation> {
    await this.revalidate(placement);

    const root = await this.#acceptRoot();

    const repositoryPath = resolve(
      this.#repositoryRoot,
      placement.repositoryStorageKey,
    );
    if (
      normalize(repositoryPath) !== repositoryPath
      || !isContained(this.#repositoryRoot, repositoryPath)
    ) {
      pathInvalid();
    }

    let repositoryRealPath: string;
    try {
      const entry = await lstat(repositoryPath);
      if (!entry.isDirectory() || entry.isSymbolicLink()) pathInvalid();
      repositoryRealPath = await realpath(repositoryPath);
    } catch (error: unknown) {
      if (error instanceof RepositoryPlacementError) throw error;
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
      if (code === 'ENOENT') {
        throw new RepositoryPlacementError('repository-not-found');
      }
      pathInvalid();
    }

    if (!isContained(root.realPath, repositoryRealPath)) pathInvalid();
    const verifiedRoot = await this.#inspectRoot();
    if (!sameRoot(root, verifiedRoot)) rootUnavailable();

    return Object.freeze({
      placement,
      repositoryPath,
    });
  }

  async revalidate(placement: RepositoryPlacementLease): Promise<void> {
    assertRepositoryPlacementLease(placement);
    if (placement.storageNodeId !== this.#storageNodeId) {
      throw new RepositoryPlacementError('wrong-storage-node');
    }
    let current: boolean;
    try {
      current = await this.#placementValidator.isCurrent(placement);
    } catch {
      throw new RepositoryPlacementError('placement-unavailable');
    }
    if (!current) throw new RepositoryPlacementError('stale-placement');
  }

  async verifyRoot(): Promise<void> {
    await this.#acceptRoot();
  }

  async #acceptRoot(): Promise<RootIdentity> {
    const root = await this.#inspectRoot();
    if (this.#acceptedRoot === undefined) this.#acceptedRoot = root;
    else if (!sameRoot(this.#acceptedRoot, root)) rootUnavailable();
    return root;
  }

  async #inspectRoot(): Promise<RootIdentity> {
    if (
      !isAbsolute(this.#repositoryRoot)
      || normalize(this.#repositoryRoot) !== this.#repositoryRoot
    ) {
      rootUnavailable();
    }
    try {
      const entry = await lstat(this.#repositoryRoot, { bigint: true });
      const currentUid = getuid?.();
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || currentUid === undefined
        || entry.uid !== BigInt(currentUid)
      ) {
        rootUnavailable();
      }
      await access(this.#repositoryRoot, constants.R_OK | constants.X_OK);
      return Object.freeze({
        device: entry.dev,
        inode: entry.ino,
        realPath: await realpath(this.#repositoryRoot),
      });
    } catch (error: unknown) {
      if (error instanceof RepositoryPlacementError) throw error;
      rootUnavailable();
    }
  }
}
