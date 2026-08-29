import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { getgid, getuid } from 'node:process';

import {
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import type { BackupExportResult } from '../../project-authority/checkpoint/BackupExportCoordinator.js';
import type { LifecycleCheckpointPublication } from '../../project-authority/checkpoint/LifecycleCheckpointPublication.js';
import { productionCheckpointAttemptIdentity } from '../../onboarding/production/ProductionCheckpointStaging.js';

export interface FileProjectExportDeliveryOptions {
  readonly publication: Pick<
    LifecycleCheckpointPublication,
    'inspectAttempt' | 'readArtifact'
  >;
  readonly root: string;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function fail(): never {
  throw new Error('file-project-export-delivery.error.storage-unavailable');
}

function exists(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY');
}

function identity(): Readonly<{ readonly gid: bigint; readonly uid: bigint }> {
  const uid = getuid?.();
  const gid = getgid?.();
  if (uid === undefined || gid === undefined) return fail();
  return Object.freeze({ gid: BigInt(gid), uid: BigInt(uid) });
}

function privateDirectory(stat: BigIntStats): boolean {
  const current = identity();
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.uid === current.uid
    && stat.gid === current.gid
    && Number(stat.mode & 0o777n) === DIRECTORY_MODE;
}

function privateFile(stat: BigIntStats, byteCount: number): boolean {
  const current = identity();
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === current.uid
    && stat.gid === current.gid
    && Number(stat.mode & 0o777n) === FILE_MODE
    && stat.size === BigInt(byteCount);
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error: unknown) {
    if (!exists(error)) throw error;
  }
  if (!privateDirectory(await lstat(path, { bigint: true }))) return fail();
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY,
    );
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

/** Copies published server staging into an operator-owned immutable delivery. */
export class FileProjectExportDelivery {
  readonly #publication: FileProjectExportDeliveryOptions['publication'];
  readonly #root: string;

  constructor(options: FileProjectExportDeliveryOptions) {
    if (
      !isAbsolute(options.root)
      || normalize(options.root) !== options.root
      || parse(options.root).root === options.root
    ) throw new TypeError('file-project-export-delivery.options-invalid');
    this.#publication = options.publication;
    this.#root = options.root;
  }

  async deliver(
    input: BackupExportResult & Readonly<{ readonly signal: AbortSignal }>,
  ): Promise<void> {
    if (
      input.profile !== 'export'
      || !isCollabOpaqueId(input.operationId)
      || !isCollabProjectId(input.projectId)
      || !SHA256_PATTERN.test(input.checkpointSha256)
      || input.signal.aborted
    ) return fail();
    const attempt = productionCheckpointAttemptIdentity(input);
    const inspected = await this.#publication.inspectAttempt(
      attempt,
      input.signal,
    );
    if (inspected.attempt.attemptKey !== attempt.attemptKey) return fail();
    const byName = new Map(inspected.artifacts.map(artifact => [
      artifact.name,
      artifact,
    ]));
    if (
      byName.size !== COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.length
      || COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.some(name => !byName.has(name))
    ) return fail();

    if (!privateDirectory(await lstat(this.#root, { bigint: true }))) return fail();
    const delivered = join(this.#root, 'delivered');
    await ensureDirectory(delivered);
    const project = join(delivered, Buffer.from(input.projectId).toString('hex'));
    await ensureDirectory(project);
    const final = join(project, Buffer.from(input.operationId).toString('hex'));
    try {
      await this.#verify(final, byName);
      return;
    } catch (error: unknown) {
      if (!(typeof error === 'object' && error !== null && 'code' in error
        && error.code === 'ENOENT')) throw error;
    }

    const part = join(project, `.${randomUUID()}.part`);
    let partCreated = false;
    try {
      await mkdir(part, { mode: DIRECTORY_MODE });
      partCreated = true;
      if (!privateDirectory(await lstat(part, { bigint: true }))) return fail();
      for (const name of COLLAB_PROJECT_CHECKPOINT_ARTIFACTS) {
        const artifact = byName.get(name) ?? fail();
        const path = join(part, name);
        let handle: FileHandle | undefined;
        let byteCount = 0;
        const hash = createHash('sha256');
        try {
          handle = await open(
            path,
            constants.O_CREAT
              | constants.O_EXCL
              | constants.O_NOFOLLOW
              | constants.O_WRONLY,
            FILE_MODE,
          );
          await this.#publication.readArtifact({
            artifact,
            attempt,
            onChunk: async (chunk, signal) => {
              if (signal.aborted || input.signal.aborted) return fail();
              const offset = byteCount;
              byteCount += chunk.byteLength;
              if (byteCount > artifact.byteCount) return fail();
              hash.update(chunk);
              const activeHandle = handle ?? fail();
              const written = await activeHandle.write(
                chunk,
                0,
                chunk.byteLength,
                offset,
              );
              if (written.bytesWritten !== chunk.byteLength) return fail();
            },
            signal: input.signal,
          });
          await handle.sync();
          const stat = await handle.stat({ bigint: true });
          if (
            byteCount !== artifact.byteCount
            || hash.digest('hex') !== artifact.sha256
            || !privateFile(stat, artifact.byteCount)
          ) return fail();
        } finally {
          await handle?.close();
        }
      }
      await syncDirectory(part);
      try {
        await rename(part, final);
        partCreated = false;
      } catch (error: unknown) {
        if (!exists(error)) throw error;
        await this.#verify(final, byName);
      }
      await syncDirectory(project);
      await this.#verify(final, byName);
    } finally {
      if (partCreated) await rm(part, { force: true, recursive: true });
    }
  }

  async #verify(
    directory: string,
    artifacts: ReadonlyMap<string, Readonly<{
      readonly byteCount: number;
      readonly sha256: string;
    }>>,
  ): Promise<void> {
    if (!privateDirectory(await lstat(directory, { bigint: true }))) return fail();
    const entries = await readdir(directory, { withFileTypes: true });
    if (
      entries.length !== COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.length
      || entries.some(entry => !entry.isFile() || !artifacts.has(entry.name))
    ) return fail();
    for (const name of COLLAB_PROJECT_CHECKPOINT_ARTIFACTS) {
      const artifact = artifacts.get(name) ?? fail();
      const handle = await open(
        join(directory, name),
        constants.O_NOFOLLOW | constants.O_RDONLY,
      );
      try {
        const stat = await handle.stat({ bigint: true });
        if (!privateFile(stat, artifact.byteCount)) return fail();
        const hash = createHash('sha256');
        let byteCount = 0;
        for await (const candidate of handle.createReadStream({ autoClose: false })) {
          if (!Buffer.isBuffer(candidate)) return fail();
          const chunk: Buffer = candidate;
          byteCount += chunk.byteLength;
          if (byteCount > artifact.byteCount) return fail();
          hash.update(chunk);
        }
        if (byteCount !== artifact.byteCount || hash.digest('hex') !== artifact.sha256) {
          return fail();
        }
      } finally {
        await handle.close();
      }
    }
  }
}
