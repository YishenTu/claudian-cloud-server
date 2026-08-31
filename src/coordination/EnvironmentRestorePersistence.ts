import type {
  CollabCheckpointGitRef,
  CollabCheckpointObjectFormat,
  CollabIsoTimestamp,
  CollabProjectBackupRecord,
  CollabProjectId,
} from '@claudian-collab/protocol';

export interface EnvironmentRestorePersistenceProject {
  readonly authorityGeneration: number;
  readonly backupId: string;
  readonly placementGeneration: number;
  readonly projectId: CollabProjectId;
}

export interface EnvironmentRestorePersistenceCatalog {
  readonly authorityId: string;
  readonly authorityVolumeIdentity: string;
  readonly coordinationSchemaVersion: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly maximumServerBuild: string;
  readonly minimumServerBuild: string;
  readonly projects: readonly EnvironmentRestorePersistenceProject[];
  readonly repositoryFormatVersion: number;
}

export interface EnvironmentRestorePersistenceRepository {
  readonly objectFormat: CollabCheckpointObjectFormat;
  readonly operationId: string;
  readonly placementGeneration: number;
  readonly projectId: CollabProjectId;
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
}

export interface EnvironmentRestorePersistence {
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
    readonly project: EnvironmentRestorePersistenceProject;
    readonly records: readonly CollabProjectBackupRecord[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
  importTerminalProject(input: Readonly<{
    readonly operationId: string;
    readonly projectId: CollabProjectId;
    readonly records: readonly CollabProjectBackupRecord[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
  publishAuthority(input: Readonly<{
    readonly catalog: EnvironmentRestorePersistenceCatalog;
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestorePersistenceRepository[];
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
    readonly project: EnvironmentRestorePersistenceProject;
    readonly records: readonly CollabProjectBackupRecord[];
    readonly repository: EnvironmentRestorePersistenceRepository;
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
  readRestoredContinuity(
    project: EnvironmentRestorePersistenceProject,
    signal: AbortSignal,
  ): Promise<readonly CollabProjectBackupRecord[]>;
  readRestoredTerminalContinuity(
    projectId: CollabProjectId,
    signal: AbortSignal,
  ): Promise<readonly CollabProjectBackupRecord[]>;
  verifyRestoredTerminalProject(input: Readonly<{
    readonly operationId: string;
    readonly projectId: CollabProjectId;
    readonly records: readonly CollabProjectBackupRecord[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
}
