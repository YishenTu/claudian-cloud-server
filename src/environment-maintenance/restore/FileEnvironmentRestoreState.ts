import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import {
  open,
  lstat,
  readFile,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { getgid, getuid } from 'node:process';

import { flock } from 'fs-ext-extra-prebuilt';

import {
  ENVIRONMENT_RESTORE_PHASES,
  ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
  EnvironmentRestoreCoordinatorError,
  decodeEnvironmentRestoreJournal,
  encodeEnvironmentRestoreJournal,
  type EnvironmentRestoreJournal,
  type EnvironmentRestorePairInspection,
  type EnvironmentRestoreStateInspection,
  type EnvironmentRestoreStatePort,
} from './EnvironmentRestoreCoordinator.js';

export interface FileEnvironmentRestoreStateOptions {
  readonly authorityRoot: string;
  readonly removeFile?: (path: string) => Promise<void>;
}

const JOURNAL_FILE = '.environment-restore-journal.json';
const LOCK_FILE = '.environment-restore-state.lock';
const MARKER_FILE = '.authority-volume-id';
const REMOVAL_FILE = '.environment-restore-removal.json';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const VOLUME_ID_PATTERN = /^[0-9a-f]{32}\n?$/u;

function fail(): never {
  throw new EnvironmentRestoreCoordinatorError('recovery-required');
}

function missing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

function runtimeIdentity(): Readonly<{ readonly gid: bigint; readonly uid: bigint }> {
  const uid = getuid?.();
  const gid = getgid?.();
  if (uid === undefined || gid === undefined) fail();
  return Object.freeze({ gid: BigInt(gid), uid: BigInt(uid) });
}

interface RestoreLockLease {
  readonly device: bigint;
  readonly handle: FileHandle;
  readonly inode: bigint;
}

function applyLock(handle: FileHandle, operation: 'exnb' | 'un'): Promise<void> {
  return new Promise((resolve, reject) => {
    flock(handle.fd, operation, error => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function assertOperationSignal(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  throw new EnvironmentRestoreCoordinatorError(
    signal.reason === 'closed' ? 'closed' : 'cancelled',
  );
}

function validJournalPart(
  current: EnvironmentRestoreJournal,
  part: EnvironmentRestoreJournal,
): boolean {
  if (Date.parse(part.updatedAt) < Date.parse(current.updatedAt)) return false;
  const currentIndex = ENVIRONMENT_RESTORE_PHASES.indexOf(current.phase);
  const partIndex = ENVIRONMENT_RESTORE_PHASES.indexOf(part.phase);
  if (partIndex === currentIndex) {
    if (
      encodeEnvironmentRestoreJournal(current)
      === encodeEnvironmentRestoreJournal(part)
    ) return true;
    if (
      current.cleanupRequestedAt !== undefined
      || part.cleanupRequestedAt === undefined
    ) return false;
    return encodeEnvironmentRestoreJournal({
      ...current,
      cleanupRequestedAt: part.cleanupRequestedAt,
      updatedAt: part.updatedAt,
    }) === encodeEnvironmentRestoreJournal(part);
  }
  if (
    partIndex !== currentIndex + 1
  ) return false;
  const recoversPublishedAuthority = current.phase === 'repositories-published'
    && current.cleanupRequestedAt !== undefined
    && part.phase === 'authority-published'
    && part.cleanupRequestedAt === undefined;
  if (
    !recoversPublishedAuthority
    && (
      current.cleanupRequestedAt !== undefined
      || part.cleanupRequestedAt !== undefined
    )
  ) return false;
  const currentWithoutCleanup = { ...current };
  Reflect.deleteProperty(currentWithoutCleanup, 'cleanupRequestedAt');
  const expected = Object.freeze({
    ...(recoversPublishedAuthority ? currentWithoutCleanup : current),
    phase: part.phase,
    updatedAt: part.updatedAt,
    ...(part.phase === 'database-created'
      ? { databaseIdentity: part.databaseIdentity }
      : {}),
    ...(part.phase === 'repositories-staged'
      ? { repositories: part.repositories }
      : {}),
  });
  return encodeEnvironmentRestoreJournal(expected)
    === encodeEnvironmentRestoreJournal(part);
}

export class FileEnvironmentRestoreState implements EnvironmentRestoreStatePort {
  readonly #authorityRoot: string;
  readonly #journal: string;
  readonly #journalPart: string;
  readonly #lock: string;
  readonly #lockContext = new AsyncLocalStorage<{
    active: boolean;
    lease: RestoreLockLease;
  }>();
  readonly #marker: string;
  readonly #markerPart: string;
  readonly #removal: string;
  readonly #removalPart: string;
  readonly #removeFile: (path: string) => Promise<void>;

  constructor(options: FileEnvironmentRestoreStateOptions) {
    if (
      !isAbsolute(options.authorityRoot)
      || normalize(options.authorityRoot) !== options.authorityRoot
      || parse(options.authorityRoot).root === options.authorityRoot
      || (options.removeFile !== undefined
        && typeof options.removeFile !== 'function')
    ) throw new TypeError('environment-restore-state.options-invalid');
    this.#authorityRoot = options.authorityRoot;
    this.#journal = join(options.authorityRoot, JOURNAL_FILE);
    this.#journalPart = `${this.#journal}.part`;
    this.#lock = join(options.authorityRoot, LOCK_FILE);
    this.#marker = join(options.authorityRoot, MARKER_FILE);
    this.#markerPart = `${this.#marker}.part`;
    this.#removal = join(options.authorityRoot, REMOVAL_FILE);
    this.#removalPart = `${this.#removal}.part`;
    this.#removeFile = options.removeFile ?? (path => rm(path, { force: true }));
  }

  runExclusive<Result>(
    operation: () => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> {
    return this.#withLock(operation, signal);
  }

  async inspect(signal?: AbortSignal): Promise<EnvironmentRestoreStateInspection> {
    return this.#withLock(async () => {
      const journal = await this.#readJournal();
      const pair = await this.#readPair(journal);
      return Object.freeze({ journal, pair });
    }, signal);
  }

  async inspectSettled(
    signal?: AbortSignal,
  ): Promise<EnvironmentRestoreStateInspection> {
    assertOperationSignal(signal);
    await this.#assertPrivateRoot();
    const [journalPart, markerPart, removal, removalPart] = await Promise.all([
      this.#readPrivateText(
        this.#journalPart,
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      ),
      this.#readPrivateText(this.#markerPart, 64),
      this.#readPrivateText(
        this.#removal,
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      ),
      this.#readPrivateText(
        this.#removalPart,
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      ),
    ]);
    if (
      journalPart !== undefined
      || markerPart !== undefined
      || removal !== undefined
      || removalPart !== undefined
    ) fail();
    const journal = await this.#readSettledJournal();
    const pair = await this.#readSettledPair(journal);
    assertOperationSignal(signal);
    return Object.freeze({ journal, pair });
  }

  async create(
    journal: EnvironmentRestoreJournal,
  ): Promise<EnvironmentRestoreJournal> {
    return this.#withLock(async () => {
      const encoded = encodeEnvironmentRestoreJournal(journal);
      const current = await this.#readJournal();
      if (current !== undefined) {
        if (encodeEnvironmentRestoreJournal(current) !== encoded) fail();
        return current;
      }
      if ((await this.#readPair(undefined)) !== 'absent') fail();
      await this.#writeAtomic(
        this.#journal,
        this.#journalPart,
        encoded,
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      );
      return (await this.#readJournal()) ?? fail();
    });
  }

  async advance(input: Readonly<{
    readonly expectedPhase: EnvironmentRestoreJournal['phase'];
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal> {
    return this.#withLock(() => this.#advanceUnlocked(input));
  }

  async #advanceUnlocked(input: Readonly<{
    readonly expectedPhase: EnvironmentRestoreJournal['phase'];
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal> {
    const next = decodeEnvironmentRestoreJournal(input.next);
    const current = (await this.#readJournal()) ?? fail();
    if (current.phase === next.phase) {
      if (encodeEnvironmentRestoreJournal(current)
        !== encodeEnvironmentRestoreJournal(next)) fail();
      return current;
    }
    const currentIndex = ENVIRONMENT_RESTORE_PHASES.indexOf(current.phase);
    const nextIndex = ENVIRONMENT_RESTORE_PHASES.indexOf(next.phase);
    if (
      current.phase !== input.expectedPhase
      || nextIndex !== currentIndex + 1
      || current.operationId !== next.operationId
      || current.catalogSha256 !== next.catalogSha256
      || current.authorityVolumeId !== next.authorityVolumeId
      || !validJournalPart(current, next)
    ) fail();
    await this.#writeAtomic(
      this.#journal,
      this.#journalPart,
      encodeEnvironmentRestoreJournal(next),
      ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
    );
    return (await this.#readJournal()) ?? fail();
  }

  async preparePair(input: Readonly<{
    readonly authorityVolumeId: string;
    readonly expectedPhase: 'repositories-staged';
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal> {
    return this.#withLock(async () => {
      const current = (await this.#readJournal()) ?? fail();
      if (
        current.phase !== input.expectedPhase
        || current.authorityVolumeId !== input.authorityVolumeId
        || input.next.phase !== 'pair-prepared'
      ) fail();
      const markerValue = `${input.authorityVolumeId}\n`;
      const pair = await this.#readPair(current);
      if (pair === 'ambiguous') fail();
      if (pair === 'absent') {
        await this.#writeAtomic(
          this.#marker,
          this.#markerPart,
          markerValue,
          64,
        );
      } else if (pair.authorityVolumeId !== input.authorityVolumeId) {
        fail();
      } else {
        const marker = await this.#readPrivateText(this.#marker, 64);
        const part = await this.#readPrivateText(this.#markerPart, 64);
        if (marker === undefined && part === markerValue) {
          await rename(this.#markerPart, this.#marker);
          await this.#syncRoot();
        } else if (marker !== markerValue) {
          fail();
        } else if (part !== undefined) {
          if (part !== markerValue) fail();
          await this.#removeFile(this.#markerPart);
          await this.#syncRoot();
        }
      }
      return this.#advanceUnlocked({
        expectedPhase: input.expectedPhase,
        next: input.next,
      });
    });
  }

  async requestCleanup(input: Readonly<{
    readonly expectedPhase: EnvironmentRestoreJournal['phase'];
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal> {
    return this.#withLock(async () => {
      const current = (await this.#readJournal()) ?? fail();
      const next = decodeEnvironmentRestoreJournal(input.next);
      if (
        current.phase !== input.expectedPhase
        || next.phase !== current.phase
        || current.operationId !== next.operationId
        || current.catalogSha256 !== next.catalogSha256
        || current.authorityVolumeId !== next.authorityVolumeId
        || current.cleanupRequestedAt !== undefined
        || next.cleanupRequestedAt === undefined
        || ENVIRONMENT_RESTORE_PHASES.indexOf(current.phase)
          >= ENVIRONMENT_RESTORE_PHASES.indexOf('authority-published')
        || !validJournalPart(current, next)
      ) fail();
      await this.#writeAtomic(
        this.#journal,
        this.#journalPart,
        encodeEnvironmentRestoreJournal(next),
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      );
      return (await this.#readJournal()) ?? fail();
    });
  }

  async recoverPublishedAuthority(input: Readonly<{
    readonly expectedPhase: 'repositories-published';
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal> {
    return this.#withLock(async () => {
      const current = (await this.#readJournal()) ?? fail();
      const next = decodeEnvironmentRestoreJournal(input.next);
      if (
        current.phase !== input.expectedPhase
        || current.cleanupRequestedAt === undefined
        || next.phase !== 'authority-published'
        || next.cleanupRequestedAt !== undefined
        || current.operationId !== next.operationId
        || current.catalogSha256 !== next.catalogSha256
        || current.authorityVolumeId !== next.authorityVolumeId
        || !validJournalPart(current, next)
      ) fail();
      await this.#writeAtomic(
        this.#journal,
        this.#journalPart,
        encodeEnvironmentRestoreJournal(next),
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      );
      return (await this.#readJournal()) ?? fail();
    });
  }

  async remove(input: Readonly<{
    readonly expectedCatalogSha256: string;
    readonly operationId: string;
    readonly phase: EnvironmentRestoreJournal['phase'];
  }>): Promise<'removed'> {
    return this.#withLock(async () => {
      const current = (await this.#readJournal()) ?? fail();
      if (
        current.catalogSha256 !== input.expectedCatalogSha256
        || current.operationId !== input.operationId
        || current.phase !== input.phase
        || current.cleanupRequestedAt === undefined
        || ENVIRONMENT_RESTORE_PHASES.indexOf(current.phase)
          >= ENVIRONMENT_RESTORE_PHASES.indexOf('authority-published')
      ) fail();
      const pair = await this.#readPair(current);
      if (pair === 'ambiguous') fail();
      if (
        typeof pair === 'object'
        && pair.authorityVolumeId !== current.authorityVolumeId
      ) fail();
      await this.#writeAtomic(
        this.#removal,
        this.#removalPart,
        encodeEnvironmentRestoreJournal(current),
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      );
      await this.#finishRemoval();
      return 'removed' as const;
    });
  }

  async #withLock<Result>(
    operation: () => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> {
    const inherited = this.#lockContext.getStore();
    assertOperationSignal(signal);
    if (inherited?.active === true) {
      await this.#assertLockOwned(inherited.lease);
      assertOperationSignal(signal);
      const result = await operation();
      await this.#assertLockOwned(inherited.lease);
      return result;
    }
    await this.#assertPrivateRoot();
    const lease = await this.#acquireLock();
    const lockContext = { active: true, lease };
    try {
      return await this.#lockContext.run(lockContext, async () => {
        await this.#recoverRemoval();
        await this.#assertLockOwned(lease);
        assertOperationSignal(signal);
        const result = await operation();
        await this.#assertLockOwned(lease);
        return result;
      });
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    } finally {
      lockContext.active = false;
      await this.#releaseLock(lease);
    }
  }

  async #acquireLock(): Promise<RestoreLockLease> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.#lock,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      const stat = await handle.stat({ bigint: true });
      this.#assertPrivateLockFile(stat);
      const lease = Object.freeze({
        device: stat.dev,
        handle,
        inode: stat.ino,
      });
      await applyLock(handle, 'exnb');
      await this.#assertLockOwned(lease);
      return lease;
    } catch (error: unknown) {
      await handle?.close();
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    }
  }

  #assertPrivateLockFile(stat: BigIntStats): void {
    const identity = runtimeIdentity();
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.uid !== identity.uid
      || stat.gid !== identity.gid
      || Number(stat.mode & 0o777n) !== PRIVATE_FILE_MODE
    ) {
      fail();
    }
  }

  async #assertLockOwned(expected: RestoreLockLease): Promise<void> {
    try {
      const [handleStat, pathStat] = await Promise.all([
        expected.handle.stat({ bigint: true }),
        lstat(this.#lock, { bigint: true }),
      ]);
      this.#assertPrivateLockFile(handleStat);
      this.#assertPrivateLockFile(pathStat);
      if (
        handleStat.dev !== expected.device
        || handleStat.ino !== expected.inode
        || pathStat.dev !== expected.device
        || pathStat.ino !== expected.inode
      ) fail();
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    }
  }

  async #releaseLock(expected: RestoreLockLease): Promise<void> {
    try {
      await this.#assertLockOwned(expected);
      await applyLock(expected.handle, 'un');
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    } finally {
      await expected.handle.close();
    }
  }

  async #recoverRemoval(): Promise<void> {
    const intent = await this.#readRemovalIntent();
    if (intent === undefined) return;
    const current = await this.#readJournal();
    if (
      current !== undefined
      && encodeEnvironmentRestoreJournal(current)
        !== encodeEnvironmentRestoreJournal(intent)
    ) fail();
    const pair = await this.#readPair(intent);
    if (
      pair === 'ambiguous'
      || (typeof pair === 'object'
        && pair.authorityVolumeId !== intent.authorityVolumeId)
    ) fail();
    await this.#finishRemoval();
  }

  async #readRemovalIntent(): Promise<EnvironmentRestoreJournal | undefined> {
    const [intentText, partText] = await Promise.all([
      this.#readPrivateText(
        this.#removal,
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      ),
      this.#readPrivateText(
        this.#removalPart,
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      ),
    ]);
    if (intentText === undefined && partText === undefined) return undefined;
    if (
      intentText !== undefined
      && partText !== undefined
      && intentText !== partText
    ) fail();
    let intent: EnvironmentRestoreJournal;
    try {
      intent = decodeEnvironmentRestoreJournal(
        JSON.parse(intentText ?? partText ?? fail()),
      );
    } catch {
      fail();
    }
    if (
      intent.cleanupRequestedAt === undefined
      || ENVIRONMENT_RESTORE_PHASES.indexOf(intent.phase)
        >= ENVIRONMENT_RESTORE_PHASES.indexOf('authority-published')
    ) fail();
    if (intentText === undefined) {
      await rename(this.#removalPart, this.#removal);
      await this.#syncRoot();
    } else if (partText !== undefined) {
      await this.#removeFile(this.#removalPart);
      await this.#syncRoot();
    }
    return intent;
  }

  async #finishRemoval(): Promise<void> {
    await this.#removeFile(this.#markerPart);
    await this.#removeFile(this.#marker);
    await this.#syncRoot();
    await this.#removeFile(this.#journalPart);
    await this.#removeFile(this.#journal);
    await this.#syncRoot();
    await this.#removeFile(this.#removalPart);
    await this.#removeFile(this.#removal);
    await this.#syncRoot();
  }

  async #assertPrivateRoot(): Promise<void> {
    try {
      const identity = runtimeIdentity();
      const stat = await lstat(this.#authorityRoot, { bigint: true });
      if (
        !stat.isDirectory()
        || stat.isSymbolicLink()
        || stat.uid !== identity.uid
        || stat.gid !== identity.gid
        || Number(stat.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE
      ) fail();
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      fail();
    }
  }

  async #readJournal(): Promise<EnvironmentRestoreJournal | undefined> {
    const [currentText, partText] = await Promise.all([
      this.#readPrivateText(
        this.#journal,
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      ),
      this.#readPrivateText(
        this.#journalPart,
        ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
      ),
    ]);
    let current: EnvironmentRestoreJournal | undefined;
    let part: EnvironmentRestoreJournal | undefined;
    try {
      current = currentText === undefined
        ? undefined
        : decodeEnvironmentRestoreJournal(JSON.parse(currentText));
      part = partText === undefined
        ? undefined
        : decodeEnvironmentRestoreJournal(JSON.parse(partText));
    } catch {
      fail();
    }
    if (part === undefined) return current;
    if (current === undefined && part.phase !== 'validated') fail();
    if (current !== undefined && !validJournalPart(current, part)) fail();
    await rename(this.#journalPart, this.#journal);
    await this.#syncRoot();
    return part;
  }

  async #readSettledJournal(): Promise<EnvironmentRestoreJournal | undefined> {
    const currentText = await this.#readPrivateText(
      this.#journal,
      ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES,
    );
    if (currentText === undefined) return undefined;
    try {
      return decodeEnvironmentRestoreJournal(JSON.parse(currentText));
    } catch {
      return fail();
    }
  }

  async #readSettledPair(
    journal: EnvironmentRestoreJournal | undefined,
  ): Promise<EnvironmentRestorePairInspection> {
    const marker = await this.#readPrivateText(this.#marker, 64);
    if (marker === undefined) return 'absent';
    if (!VOLUME_ID_PATTERN.test(marker)) return 'ambiguous';
    const authorityVolumeId = marker.trim();
    if (
      journal !== undefined
      && authorityVolumeId !== journal.authorityVolumeId
    ) return 'ambiguous';
    return Object.freeze({ authorityVolumeId });
  }

  async #readPair(
    journal: EnvironmentRestoreJournal | undefined,
  ): Promise<EnvironmentRestorePairInspection> {
    const [marker, part] = await Promise.all([
      this.#readPrivateText(this.#marker, 64),
      this.#readPrivateText(this.#markerPart, 64),
    ]);
    if (marker === undefined && part === undefined) return 'absent';
    if (
      (marker !== undefined && !VOLUME_ID_PATTERN.test(marker))
      || (part !== undefined && !VOLUME_ID_PATTERN.test(part))
      || (marker !== undefined && part !== undefined && marker !== part)
    ) return 'ambiguous';
    const authorityVolumeId = (marker ?? part)?.trim();
    if (
      authorityVolumeId === undefined
      || (journal !== undefined
        && authorityVolumeId !== journal.authorityVolumeId)
    ) return 'ambiguous';
    return Object.freeze({ authorityVolumeId });
  }

  async #readPrivateText(
    path: string,
    maximumBytes: number,
  ): Promise<string | undefined> {
    try {
      const identity = runtimeIdentity();
      const stat = await lstat(path, { bigint: true });
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.uid !== identity.uid
        || stat.gid !== identity.gid
        || Number(stat.mode & 0o777n) !== PRIVATE_FILE_MODE
        || stat.size > BigInt(maximumBytes)
      ) fail();
      const value = await readFile(path, 'utf8');
      if (Buffer.byteLength(value, 'utf8') > maximumBytes) fail();
      return value;
    } catch (error: unknown) {
      if (missing(error)) return undefined;
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      fail();
    }
  }

  async #writeAtomic(
    target: string,
    part: string,
    value: string,
    maximumBytes: number,
  ): Promise<void> {
    if (Buffer.byteLength(value, 'utf8') > maximumBytes) fail();
    const existingPart = await this.#readPrivateText(part, maximumBytes);
    if (existingPart !== undefined && existingPart !== value) fail();
    if (existingPart === undefined) {
      let handle;
      try {
        handle = await open(part, 'wx', PRIVATE_FILE_MODE);
        await handle.writeFile(value, 'utf8');
        await handle.sync();
      } catch (error: unknown) {
        if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
        fail();
      } finally {
        await handle?.close();
      }
    }
    try {
      await rename(part, target);
      await this.#syncRoot();
    } catch {
      fail();
    }
  }

  async #syncRoot(): Promise<void> {
    let handle;
    try {
      handle = await open(this.#authorityRoot, 'r');
      await handle.sync();
    } catch {
      fail();
    } finally {
      await handle?.close();
    }
  }
}
