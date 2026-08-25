import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';

export type DurableTreeRemovalErrorCode = 'conflict' | 'storage-unavailable';

export class DurableTreeRemovalError extends Error {
  readonly code: DurableTreeRemovalErrorCode;

  constructor(code: DurableTreeRemovalErrorCode) {
    super(`durable-tree-removal.error.${code}`);
    this.name = 'DurableTreeRemovalError';
    this.code = code;
  }
}

export interface DurableTreeRemovalInput {
  readonly assertCanContinue?: () => void;
  readonly assertTargetOwned: () => Promise<void>;
  readonly cleanupKey: string;
  readonly markerJson: string;
  readonly parentPath: string;
  readonly removeTree?: (path: string) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<void>;
  readonly targetPath: string;
}

interface CleanupPaths {
  readonly detachedTree: string;
  readonly marker: string;
  readonly markerPart: string;
}

const CLEANUP_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const FILE_MODE = 0o600;
const MAXIMUM_MARKER_BYTES = 64 * 1024;
const removalTails = new Map<string, Promise<void>>();

function fail(code: DurableTreeRemovalErrorCode): never {
  throw new DurableTreeRemovalError(code);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

async function runRemovalExclusive<Result>(
  key: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = removalTails.get(key);
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = (previous ?? Promise.resolve()).then(
    () => gate,
    () => gate,
  );
  removalTails.set(key, tail);
  await previous?.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (removalTails.get(key) === tail) removalTails.delete(key);
  }
}

function cleanupPaths(parentPath: string, cleanupKey: string): CleanupPaths {
  const prefix = `.claudian-cloud-tree-cleanup-${cleanupKey}`;
  return Object.freeze({
    detachedTree: join(parentPath, prefix),
    marker: join(parentPath, `${prefix}.json`),
    markerPart: join(parentPath, `${prefix}.json.part`),
  });
}

function assertInput(input: DurableTreeRemovalInput): void {
  if (
    !isAbsolute(input.parentPath)
    || normalize(input.parentPath) !== input.parentPath
    || !isAbsolute(input.targetPath)
    || normalize(input.targetPath) !== input.targetPath
    || dirname(input.targetPath) !== input.parentPath
    || !CLEANUP_KEY_PATTERN.test(input.cleanupKey)
    || input.markerJson.length === 0
    || !input.markerJson.endsWith('\n')
    || Buffer.byteLength(input.markerJson, 'utf8') > MAXIMUM_MARKER_BYTES
    || typeof input.assertTargetOwned !== 'function'
    || typeof input.syncDirectory !== 'function'
    || (input.assertCanContinue !== undefined
      && typeof input.assertCanContinue !== 'function')
    || (input.removeTree !== undefined && typeof input.removeTree !== 'function')
  ) {
    throw new TypeError('durable-tree-removal.input-invalid');
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('conflict');
    return true;
  } catch (error: unknown) {
    if (error instanceof DurableTreeRemovalError) throw error;
    if (hasErrorCode(error, 'ENOENT')) return false;
    return fail('storage-unavailable');
  }
}

async function readExactMarker(path: string, expected: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const entry = await handle.stat();
    if (
      !entry.isFile()
      || entry.size !== Buffer.byteLength(expected, 'utf8')
      || await handle.readFile('utf8') !== expected
    ) {
      fail('conflict');
    }
    return true;
  } catch (error: unknown) {
    if (error instanceof DurableTreeRemovalError) throw error;
    if (hasErrorCode(error, 'ENOENT')) return false;
    if (hasErrorCode(error, 'ELOOP')) fail('conflict');
    return fail('storage-unavailable');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeOwnedPartial(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) fail('conflict');
    await rm(path);
  } catch (error: unknown) {
    if (error instanceof DurableTreeRemovalError) throw error;
    if (hasErrorCode(error, 'ENOENT')) return;
    fail('storage-unavailable');
  }
}

async function writeMarker(
  paths: CleanupPaths,
  markerJson: string,
  syncDirectory: (path: string) => Promise<void>,
  parentPath: string,
): Promise<void> {
  await removeOwnedPartial(paths.markerPart);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(paths.markerPart, 'wx', FILE_MODE);
    await handle.writeFile(markerJson, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(paths.markerPart, paths.marker);
    await syncDirectory(parentPath);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(paths.markerPart, { force: true }).catch(() => undefined);
    if (error instanceof DurableTreeRemovalError) throw error;
    fail('storage-unavailable');
  }
}

export function removeDurableOwnedTree(
  input: DurableTreeRemovalInput,
): Promise<'removed' | 'replayed'> {
  assertInput(input);
  return runRemovalExclusive(
    `${input.parentPath}\0${input.cleanupKey}`,
    () => removeDurableOwnedTreeExclusive(input),
  );
}

async function removeDurableOwnedTreeExclusive(
  input: DurableTreeRemovalInput,
): Promise<'removed' | 'replayed'> {
  const paths = cleanupPaths(input.parentPath, input.cleanupKey);
  const intentExists = await readExactMarker(paths.marker, input.markerJson);
  let targetExists = await directoryExists(input.targetPath);
  let detachedExists = await directoryExists(paths.detachedTree);
  if (targetExists && detachedExists) fail('conflict');
  if (!intentExists) {
    if (detachedExists) fail('conflict');
    if (!targetExists) {
      await input.syncDirectory(input.parentPath);
      return 'replayed';
    }
    await input.assertTargetOwned();
    input.assertCanContinue?.();
    await writeMarker(
      paths,
      input.markerJson,
      input.syncDirectory,
      input.parentPath,
    );
  } else {
    await removeOwnedPartial(paths.markerPart);
  }

  targetExists = await directoryExists(input.targetPath);
  detachedExists = await directoryExists(paths.detachedTree);
  if (targetExists && detachedExists) fail('conflict');
  if (targetExists) {
    input.assertCanContinue?.();
    try {
      await rename(input.targetPath, paths.detachedTree);
      await input.syncDirectory(input.parentPath);
    } catch (error: unknown) {
      if (error instanceof DurableTreeRemovalError) throw error;
      fail('storage-unavailable');
    }
    detachedExists = true;
  }

  if (detachedExists) {
    input.assertCanContinue?.();
    try {
      await (input.removeTree ?? (path => rm(path, { recursive: true })))(
        paths.detachedTree,
      );
      await input.syncDirectory(input.parentPath);
    } catch (error: unknown) {
      if (error instanceof DurableTreeRemovalError) throw error;
      fail('storage-unavailable');
    }
  } else {
    await input.syncDirectory(input.parentPath);
  }

  try {
    await rm(paths.marker);
    await input.syncDirectory(input.parentPath);
    return 'removed';
  } catch (error: unknown) {
    if (error instanceof DurableTreeRemovalError) throw error;
    fail('storage-unavailable');
  }
}
