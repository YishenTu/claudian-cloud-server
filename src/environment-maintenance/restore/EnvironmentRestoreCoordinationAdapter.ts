import type { CollabProjectBackupRecord } from '@claudian-collab/protocol';

import {
  EnvironmentRestoreCoordinatorError,
  type EnvironmentRestoreCatalog,
  type EnvironmentRestoreCoordinationPort,
  type EnvironmentRestoreProject,
  type EnvironmentRestoreRepositoryPublication,
} from './EnvironmentRestoreCoordinator.js';
import type { EnvironmentProjectBackupSource } from './PublishedEnvironmentBackupSource.js';

export interface EnvironmentRestoreCoordinationStoragePort {
  assertEmpty(signal: AbortSignal): Promise<void>;
  createDatabase(input: Readonly<{
    readonly authorityId: string;
    readonly authorityVolumeId: string;
    readonly authorityVolumeIdentity: string;
    readonly coordinationSchemaVersion: number;
    readonly operationId: string;
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<Readonly<{ readonly authorityVolumeId: string }>>;
  importProject(input: Readonly<{
    readonly operationId: string;
    readonly project: EnvironmentRestoreProject;
    readonly records: readonly CollabProjectBackupRecord[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
  publishAuthority(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
  classifyOrRemoveRestoreOwnedDatabase(input: Readonly<{
    readonly authorityVolumeId: string;
    readonly operationId: string;
    readonly signal: AbortSignal;
  }>): Promise<'authority-published' | 'removed' | 'replayed'>;
  verifyDatabaseIdentity(
    expectedAuthorityVolumeId: string,
    signal: AbortSignal,
  ): Promise<void>;
  verifyRestoredProject(input: Readonly<{
    readonly operationId: string;
    readonly project: EnvironmentRestoreProject;
    readonly records: readonly CollabProjectBackupRecord[];
    readonly repository: EnvironmentRestoreRepositoryPublication;
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
}

export interface EnvironmentRestoreCoordinationAdapterOptions {
  readonly source: EnvironmentProjectBackupSource;
  readonly storage: EnvironmentRestoreCoordinationStoragePort;
}

function fail(): never {
  throw new EnvironmentRestoreCoordinatorError('dependency-failed');
}

/** Keeps record enumeration and multi-Project replay out of O5 composition. */
export class EnvironmentRestoreCoordinationAdapter
implements EnvironmentRestoreCoordinationPort {
  readonly #source: EnvironmentProjectBackupSource;
  readonly #storage: EnvironmentRestoreCoordinationStoragePort;

  constructor(options: EnvironmentRestoreCoordinationAdapterOptions) {
    if (
      typeof options.source.readProjectBackup !== 'function'
      || typeof options.storage.assertEmpty !== 'function'
      || typeof options.storage.createDatabase !== 'function'
      || typeof options.storage.importProject !== 'function'
      || typeof options.storage.publishAuthority !== 'function'
      || typeof options.storage.classifyOrRemoveRestoreOwnedDatabase !== 'function'
      || typeof options.storage.verifyDatabaseIdentity !== 'function'
      || typeof options.storage.verifyRestoredProject !== 'function'
    ) throw new TypeError('environment-restore-coordination.options-invalid');
    this.#source = options.source;
    this.#storage = options.storage;
  }

  assertEmpty(signal: AbortSignal): Promise<void> {
    return this.#storage.assertEmpty(signal);
  }

  createDatabase(input: Parameters<
    EnvironmentRestoreCoordinationPort['createDatabase']
  >[0]): ReturnType<EnvironmentRestoreCoordinationPort['createDatabase']> {
    return this.#storage.createDatabase(input);
  }

  async importCoordination(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly operationId: string;
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void> {
    try {
      for (const project of input.catalog.projects) {
        const backup = await this.#source.readProjectBackup({
          project,
          signal: input.signal,
        });
        await this.#storage.importProject({
          operationId: input.operationId,
          project,
          records: backup.records,
          restoreEpoch: input.restoreEpoch,
          signal: input.signal,
        });
      }
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    }
  }

  publishAuthority(input: Parameters<
    EnvironmentRestoreCoordinationPort['publishAuthority']
  >[0]): ReturnType<EnvironmentRestoreCoordinationPort['publishAuthority']> {
    return this.#storage.publishAuthority(input);
  }

  classifyOrRemoveRestoreOwnedDatabase(input: Parameters<
    EnvironmentRestoreCoordinationPort['classifyOrRemoveRestoreOwnedDatabase']
  >[0]): ReturnType<
    EnvironmentRestoreCoordinationPort['classifyOrRemoveRestoreOwnedDatabase']
  > {
    return this.#storage.classifyOrRemoveRestoreOwnedDatabase(input);
  }

  verifyDatabaseIdentity(
    expectedAuthorityVolumeId: string,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#storage.verifyDatabaseIdentity(expectedAuthorityVolumeId, signal);
  }

  async verifyRestored(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void> {
    try {
      for (const project of input.catalog.projects) {
        const repository = input.repositories.find(
          candidate => candidate.projectId === project.projectId,
        ) ?? fail();
        const backup = await this.#source.readProjectBackup({
          project,
          signal: input.signal,
        });
        await this.#storage.verifyRestoredProject({
          operationId: input.operationId,
          project,
          records: backup.records,
          repository,
          restoreEpoch: input.restoreEpoch,
          signal: input.signal,
        });
      }
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    }
  }
}
