import { CoordinationError } from '../../coordination/CoordinationError.js';
import type { EnvironmentRestorePersistence } from '../../coordination/EnvironmentRestorePersistence.js';
import {
  EnvironmentRestoreCoordinatorError,
  type EnvironmentRestoreCatalog,
  type EnvironmentRestoreCoordinationPort,
  type EnvironmentRestoreRepositoryPublication,
} from './EnvironmentRestoreCoordinator.js';
import type {
  EnvironmentProjectBackupSource,
  EnvironmentTerminalProjectBackupSource,
} from './PublishedEnvironmentBackupSource.js';

export type EnvironmentRestoreCoordinationStoragePort = Omit<
  EnvironmentRestorePersistence,
  'readRestoredContinuity'
>;

export interface EnvironmentRestoreCoordinationAdapterOptions {
  readonly source: EnvironmentProjectBackupSource
    & Partial<EnvironmentTerminalProjectBackupSource>;
  readonly storage: EnvironmentRestoreCoordinationStoragePort;
}

function fail(): never {
  throw new EnvironmentRestoreCoordinatorError('dependency-failed');
}

function translate(error: unknown): never {
  if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
  if (error instanceof CoordinationError) {
    if (error.code === 'cancelled') {
      throw new EnvironmentRestoreCoordinatorError('cancelled');
    }
    if (
      error.code === 'state-conflict'
      || error.code === 'authority-volume-mismatch'
    ) throw new EnvironmentRestoreCoordinatorError('state-conflict');
  }
  return fail();
}

/** Keeps record enumeration and multi-Project replay out of O5 composition. */
export class EnvironmentRestoreCoordinationAdapter
implements EnvironmentRestoreCoordinationPort {
  readonly #source: EnvironmentProjectBackupSource
    & Partial<EnvironmentTerminalProjectBackupSource>;
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

  async assertEmpty(signal: AbortSignal): Promise<void> {
    try {
      await this.#storage.assertEmpty(signal);
    } catch (error: unknown) {
      if (
        error instanceof CoordinationError
        && error.code === 'state-conflict'
      ) throw new EnvironmentRestoreCoordinatorError('non-empty');
      return translate(error);
    }
  }

  async createDatabase(input: Parameters<
    EnvironmentRestoreCoordinationPort['createDatabase']
  >[0]): ReturnType<EnvironmentRestoreCoordinationPort['createDatabase']> {
    try {
      return await this.#storage.createDatabase(input);
    } catch (error: unknown) {
      return translate(error);
    }
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
      for (const terminalProject of input.catalog.terminalProjects) {
        const readTerminal = this.#source.readTerminalProjectBackup;
        const importTerminal = this.#storage.importTerminalProject;
        if (readTerminal === undefined || importTerminal === undefined) {
          return fail();
        }
        const backup = await readTerminal.call(this.#source, {
          signal: input.signal,
          terminalProject,
        });
        await importTerminal.call(this.#storage, {
          operationId: input.operationId,
          projectId: terminalProject.projectId,
          records: backup.records,
          restoreEpoch: input.restoreEpoch,
          signal: input.signal,
        });
      }
    } catch (error: unknown) {
      return translate(error);
    }
  }

  async publishAuthority(input: Parameters<
    EnvironmentRestoreCoordinationPort['publishAuthority']
  >[0]): ReturnType<EnvironmentRestoreCoordinationPort['publishAuthority']> {
    try {
      await this.#storage.publishAuthority(input);
    } catch (error: unknown) {
      return translate(error);
    }
  }

  async classifyOrRemoveRestoreOwnedDatabase(input: Parameters<
    EnvironmentRestoreCoordinationPort['classifyOrRemoveRestoreOwnedDatabase']
  >[0]): ReturnType<
    EnvironmentRestoreCoordinationPort['classifyOrRemoveRestoreOwnedDatabase']
  > {
    try {
      return await this.#storage.classifyOrRemoveRestoreOwnedDatabase(input);
    } catch (error: unknown) {
      return translate(error);
    }
  }

  async verifyDatabaseIdentity(
    expectedAuthorityVolumeId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#storage.verifyDatabaseIdentity(
        expectedAuthorityVolumeId,
        signal,
      );
    } catch (error: unknown) {
      return translate(error);
    }
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
      for (const terminalProject of input.catalog.terminalProjects) {
        const readTerminal = this.#source.readTerminalProjectBackup;
        const verifyTerminal = this.#storage.verifyRestoredTerminalProject;
        if (readTerminal === undefined || verifyTerminal === undefined) {
          return fail();
        }
        const backup = await readTerminal.call(this.#source, {
          signal: input.signal,
          terminalProject,
        });
        await verifyTerminal.call(this.#storage, {
          operationId: input.operationId,
          projectId: terminalProject.projectId,
          records: backup.records,
          restoreEpoch: input.restoreEpoch,
          signal: input.signal,
        });
      }
    } catch (error: unknown) {
      return translate(error);
    }
  }
}
