import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { getgid, getuid } from 'node:process';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  isCollabOpaqueId,
} from '@claudian-collab/protocol';

import { EnvironmentBackupCatalogVerifierError } from './EnvironmentBackupCatalog.js';
import type { EnvironmentBackupCatalogDocumentSource } from './PublishedEnvironmentBackupSource.js';
import type { EnvironmentRestoreTerminalProject } from './EnvironmentRestoreCoordinator.js';

export interface FileEnvironmentBackupCatalogSourceOptions {
  readonly catalogRoot: string;
  readonly maximumCatalogBytes?: number;
}

const DEFAULT_MAXIMUM_CATALOG_BYTES = 2 * 1024 * 1024;

function fail(): never {
  throw new EnvironmentBackupCatalogVerifierError('dependency-failed');
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new EnvironmentBackupCatalogVerifierError('cancelled');
  }
}

function runtimeIdentity(): Readonly<{ readonly gid: bigint; readonly uid: bigint }> {
  const uid = getuid?.();
  const gid = getgid?.();
  if (uid === undefined || gid === undefined) return fail();
  return Object.freeze({ gid: BigInt(gid), uid: BigInt(uid) });
}

/** Reads only private, bounded catalog documents from one fixed operator root. */
export class FileEnvironmentBackupCatalogSource
implements EnvironmentBackupCatalogDocumentSource {
  readonly #catalogRoot: string;
  readonly #maximumCatalogBytes: number;

  constructor(options: FileEnvironmentBackupCatalogSourceOptions) {
    const maximumCatalogBytes = options.maximumCatalogBytes
      ?? DEFAULT_MAXIMUM_CATALOG_BYTES;
    if (
      !isAbsolute(options.catalogRoot)
      || normalize(options.catalogRoot) !== options.catalogRoot
      || parse(options.catalogRoot).root === options.catalogRoot
      || !Number.isSafeInteger(maximumCatalogBytes)
      || maximumCatalogBytes <= 0
      || maximumCatalogBytes > DEFAULT_MAXIMUM_CATALOG_BYTES
    ) throw new TypeError('file-environment-backup-catalog.options-invalid');
    this.#catalogRoot = options.catalogRoot;
    this.#maximumCatalogBytes = maximumCatalogBytes;
  }

  async readCatalog(input: Readonly<{
    readonly catalogId: string;
    readonly signal: AbortSignal;
  }>): Promise<unknown> {
    if (!isCollabOpaqueId(input.catalogId)) {
      throw new EnvironmentBackupCatalogVerifierError('invalid-backup');
    }
    assertNotAborted(input.signal);
    const identity = runtimeIdentity();
    const file = join(
      this.#catalogRoot,
      `${Buffer.from(input.catalogId, 'utf8').toString('hex')}.json`,
    );
    try {
      const [root, catalog] = await Promise.all([
        lstat(this.#catalogRoot, { bigint: true }),
        lstat(file, { bigint: true }),
      ]);
      if (
        !root.isDirectory()
        || root.isSymbolicLink()
        || root.uid !== identity.uid
        || root.gid !== identity.gid
        || Number(root.mode & 0o777n) !== 0o700
        || !catalog.isFile()
        || catalog.isSymbolicLink()
        || catalog.uid !== identity.uid
        || catalog.gid !== identity.gid
        || Number(catalog.mode & 0o777n) !== 0o600
        || catalog.size > BigInt(this.#maximumCatalogBytes)
      ) return fail();
      const value = await readFile(file, 'utf8');
      assertNotAborted(input.signal);
      if (Buffer.byteLength(value, 'utf8') > this.#maximumCatalogBytes) {
        return fail();
      }
      return JSON.parse(value) as unknown;
    } catch (error: unknown) {
      if (error instanceof EnvironmentBackupCatalogVerifierError) throw error;
      return fail();
    }
  }

  readTerminalArtifact(input: Readonly<{
    readonly signal: AbortSignal;
    readonly terminalProject: EnvironmentRestoreTerminalProject;
  }>): Promise<string> {
    const project = Buffer.from(
      input.terminalProject.projectId,
      'utf8',
    ).toString('hex');
    const file = join(
      this.#catalogRoot,
      `${project}.${input.terminalProject.artifactSha256}.terminal.json`,
    );
    return this.#readPrivateText(
      file,
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
      input.signal,
    );
  }

  async #readPrivateText(
    file: string,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<string> {
    assertNotAborted(signal);
    const identity = runtimeIdentity();
    try {
      const [root, artifact] = await Promise.all([
        lstat(this.#catalogRoot, { bigint: true }),
        lstat(file, { bigint: true }),
      ]);
      if (
        !root.isDirectory()
        || root.isSymbolicLink()
        || root.uid !== identity.uid
        || root.gid !== identity.gid
        || Number(root.mode & 0o777n) !== 0o700
        || !artifact.isFile()
        || artifact.isSymbolicLink()
        || artifact.uid !== identity.uid
        || artifact.gid !== identity.gid
        || Number(artifact.mode & 0o777n) !== 0o600
        || artifact.size <= 0n
        || artifact.size > BigInt(maximumBytes)
      ) return fail();
      const value = await readFile(file, 'utf8');
      assertNotAborted(signal);
      if (Buffer.byteLength(value, 'utf8') > maximumBytes) return fail();
      return value;
    } catch (error: unknown) {
      if (error instanceof EnvironmentBackupCatalogVerifierError) throw error;
      return fail();
    }
  }
}
