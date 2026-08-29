import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  link,
  lstat,
  open,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { getgid, getuid } from 'node:process';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import {
  createEnvironmentBackupCatalog,
  type CreatedEnvironmentBackupCatalog,
} from '../restore/EnvironmentBackupCatalog.js';
import {
  createTerminalProjectContinuityArtifact,
  type TerminalProjectContinuityArtifact,
} from '../restore/TerminalProjectContinuityArtifact.js';

export type EnvironmentBackupCatalogPublicationErrorCode =
  | 'publication-conflict'
  | 'storage-unavailable';

export class EnvironmentBackupCatalogPublicationError extends Error {
  readonly code: EnvironmentBackupCatalogPublicationErrorCode;

  constructor(code: EnvironmentBackupCatalogPublicationErrorCode) {
    super(`environment-backup-catalog-publication.error.${code}`);
    this.name = 'EnvironmentBackupCatalogPublicationError';
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

export interface FileEnvironmentBackupCatalogPublicationOptions {
  readonly catalogRoot: string;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAXIMUM_CATALOG_BYTES = 1024 * 1024;

function fail(code: EnvironmentBackupCatalogPublicationErrorCode): never {
  throw new EnvironmentBackupCatalogPublicationError(code);
}

function missing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

function exists(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'EEXIST';
}

function runtimeIdentity(): Readonly<{ readonly gid: bigint; readonly uid: bigint }> {
  const uid = getuid?.();
  const gid = getgid?.();
  if (uid === undefined || gid === undefined) return fail('storage-unavailable');
  return Object.freeze({ gid: BigInt(gid), uid: BigInt(uid) });
}

function privateDirectory(stat: BigIntStats): boolean {
  const identity = runtimeIdentity();
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.uid === identity.uid
    && stat.gid === identity.gid
    && Number(stat.mode & 0o777n) === PRIVATE_DIRECTORY_MODE;
}

function privateFile(stat: BigIntStats, maximumBytes: number): boolean {
  const identity = runtimeIdentity();
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === identity.uid
    && stat.gid === identity.gid
    && Number(stat.mode & 0o777n) === PRIVATE_FILE_MODE
    && stat.size > 0n
    && stat.size <= BigInt(maximumBytes);
}

function exactPublication(
  value: CreatedEnvironmentBackupCatalog,
): CreatedEnvironmentBackupCatalog {
  const catalog = value.catalog;
  if (catalog.minimumServerBuild !== catalog.maximumServerBuild) {
    return fail('publication-conflict');
  }
  try {
    const canonical = createEnvironmentBackupCatalog({
      authorityId: catalog.authorityId,
      authorityVolumeIdentity: catalog.authorityVolumeIdentity,
      catalogId: catalog.catalogId,
      coordinationSchemaVersion: catalog.coordinationSchemaVersion,
      createdAt: catalog.createdAt,
      projects: catalog.projects,
      repositoryFormatVersion: catalog.repositoryFormatVersion,
      restoreEpoch: catalog.restoreEpoch,
      serverBuild: catalog.minimumServerBuild,
      terminalProjects: catalog.terminalProjects,
    });
    if (
      canonical.catalog.catalogSha256 !== catalog.catalogSha256
      || canonical.json !== value.json
      || Buffer.byteLength(value.json, 'utf8') > MAXIMUM_CATALOG_BYTES
    ) return fail('publication-conflict');
    return canonical;
  } catch (error: unknown) {
    if (error instanceof EnvironmentBackupCatalogPublicationError) throw error;
    return fail('publication-conflict');
  }
}

export class FileEnvironmentBackupCatalogPublication {
  readonly #catalogRoot: string;

  constructor(options: FileEnvironmentBackupCatalogPublicationOptions) {
    if (
      !isAbsolute(options.catalogRoot)
      || normalize(options.catalogRoot) !== options.catalogRoot
      || parse(options.catalogRoot).root === options.catalogRoot
    ) throw new TypeError('file-environment-backup-publication.options-invalid');
    this.#catalogRoot = options.catalogRoot;
  }

  async publish(
    value: CreatedEnvironmentBackupCatalog,
  ): Promise<'published' | 'replayed'> {
    const canonical = exactPublication(value);
    const filename = `${Buffer.from(
      canonical.catalog.catalogId,
      'utf8',
    ).toString('hex')}.json`;
    return this.#publishExact(filename, canonical.json, MAXIMUM_CATALOG_BYTES);
  }

  async publishTerminalProject(
    value: TerminalProjectContinuityArtifact,
  ): Promise<'published' | 'replayed'> {
    if (!isCollabProjectId(value.projectId)) return fail('publication-conflict');
    let canonical: TerminalProjectContinuityArtifact;
    try {
      canonical = createTerminalProjectContinuityArtifact(
        value.projectId,
        value.records,
      );
    } catch {
      return fail('publication-conflict');
    }
    if (canonical.json !== value.json || canonical.sha256 !== value.sha256) {
      return fail('publication-conflict');
    }
    const project = Buffer.from(canonical.projectId, 'utf8').toString('hex');
    const filename = `${project}.${canonical.sha256}.terminal.json`;
    return this.#publishExact(
      filename,
      canonical.json,
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
    );
  }

  async #publishExact(
    filename: string,
    expected: string,
    maximumBytes: number,
  ): Promise<'published' | 'replayed'> {
    const path = join(this.#catalogRoot, filename);
    const part = join(this.#catalogRoot, `.${filename}.${randomUUID()}.part`);
    let handle: FileHandle | undefined;
    let partCreated = false;
    let result: 'published' | 'replayed' | undefined;
    let failure: unknown;
    try {
      const root = await lstat(this.#catalogRoot, { bigint: true });
      if (!privateDirectory(root)) fail('storage-unavailable');
      const replay = await this.#matches(path, expected, maximumBytes);
      if (replay !== undefined) {
        result = replay;
      } else {
        handle = await open(
          part,
          constants.O_CREAT
            | constants.O_EXCL
            | constants.O_NOFOLLOW
            | constants.O_WRONLY,
          PRIVATE_FILE_MODE,
        );
        partCreated = true;
        await handle.writeFile(expected, { encoding: 'utf8' });
        await handle.sync();
        const written = await handle.stat({ bigint: true });
        if (
          !privateFile(written, maximumBytes)
          || written.size !== BigInt(Buffer.byteLength(expected, 'utf8'))
        ) fail('storage-unavailable');
        await handle.close();
        handle = undefined;
        try {
          await link(part, path);
        } catch (error: unknown) {
          if (!exists(error)) throw error;
          if (await this.#matches(path, expected, maximumBytes) !== 'replayed') {
            fail('publication-conflict');
          }
          result = 'replayed';
        }
        if (result === undefined) {
          await this.#syncRoot();
          if (await this.#matches(path, expected, maximumBytes) !== 'replayed') {
            fail('storage-unavailable');
          }
          result = 'published';
        }
      }
    } catch (error: unknown) {
      failure = error;
    }
    try {
      await handle?.close();
      if (partCreated) await rm(part, { force: true });
    } catch (error: unknown) {
      failure = error;
    }
    if (failure instanceof EnvironmentBackupCatalogPublicationError) {
      throw failure;
    }
    if (failure !== undefined || result === undefined) {
      return fail('storage-unavailable');
    }
    return result;
  }

  async #matches(
    path: string,
    expected: string,
    maximumBytes: number,
  ): Promise<'replayed' | undefined> {
    let handle: FileHandle | undefined;
    let failure: unknown;
    let result: 'replayed' | undefined;
    let settled = false;
    try {
      handle = await open(path, constants.O_NOFOLLOW | constants.O_RDONLY);
      const opened = await handle.stat({ bigint: true });
      if (!privateFile(opened, maximumBytes)) {
        fail('publication-conflict');
      }
      const actual = await handle.readFile({ encoding: 'utf8' });
      const current = await lstat(path, { bigint: true });
      if (
        !privateFile(current, maximumBytes)
        || current.dev !== opened.dev
        || current.ino !== opened.ino
        || actual !== expected
      ) fail('publication-conflict');
      result = 'replayed';
      settled = true;
    } catch (error: unknown) {
      if (missing(error)) settled = true;
      else failure = error;
    }
    try {
      await handle?.close();
    } catch (error: unknown) {
      failure = error;
    }
    if (failure instanceof EnvironmentBackupCatalogPublicationError) {
      throw failure;
    }
    if (failure !== undefined || !settled) {
      return fail('storage-unavailable');
    }
    return result;
  }

  async #syncRoot(): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.#catalogRoot,
        constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      await handle.sync();
    } finally {
      await handle?.close();
    }
  }
}
