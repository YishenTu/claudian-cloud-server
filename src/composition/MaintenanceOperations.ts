import { dirname } from 'node:path';

import type { CollabProjectId } from '@claudian-collab/protocol';

import {
  loadClaimCustodyKeyring,
  type ClaimCustodyKeyringConfig,
} from '../config/ClaimCustodyKeyringConfig.js';
import {
  BACKUP_CATALOG_ROOT,
  decodeMaintenanceCommandConfig,
  EXPORT_ARTIFACT_ROOT,
  migrationConfigSource,
  serverConfigSource,
} from '../config/MaintenanceCommandConfig.js';
import { decodeMigrationConfig } from '../config/MigrationConfig.js';
import { MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY } from '../config/PostgresSchemaCompatibility.js';
import {
  REPOSITORY_FORMAT_VERSION,
  SERVER_BUILD,
} from '../config/ServerBuild.js';
import {
  decodeServerConfig,
  type ConfigSource,
  type ServerConfig,
} from '../config/ServerConfig.js';
import { PostgresEnvironmentRestorePersistence } from '../coordination/postgres/PostgresEnvironmentRestorePersistence.js';
import { PostgresTerminalProjectContinuityCatalog } from '../coordination/postgres/PostgresTerminalProjectContinuityCatalog.js';
import { EnvironmentBackupCommand } from '../environment-maintenance/commands/EnvironmentBackupCommand.js';
import { EnvironmentBackupMetadataSource } from '../environment-maintenance/commands/EnvironmentBackupMetadataSource.js';
import { EnvironmentBackupProjectCatalog } from '../environment-maintenance/commands/EnvironmentBackupProjectCatalog.js';
import {
  ClaimCustodyKeyReferenceVerifier,
  KeyReferenceCheckingBackupExportSource,
} from '../environment-maintenance/commands/ClaimCustodyKeyReferenceVerifier.js';
import { EnvironmentRestoreCommand } from '../environment-maintenance/commands/EnvironmentRestoreCommand.js';
import { ExportDeliveryExpiryCommand } from '../environment-maintenance/commands/ExportDeliveryExpiryCommand.js';
import { FileEnvironmentBackupCatalogPublication } from '../environment-maintenance/commands/FileEnvironmentBackupCatalogPublication.js';
import { FileProjectExportDelivery } from '../environment-maintenance/commands/FileProjectExportDelivery.js';
import { PostgresEnvironmentRestoreTarget } from '../environment-maintenance/commands/PostgresEnvironmentRestoreTarget.js';
import { ProjectExportCommand } from '../environment-maintenance/commands/ProjectExportCommand.js';
import { ResumeDeletionCommand } from '../environment-maintenance/commands/ResumeDeletionCommand.js';
import { EnvironmentBackupCatalogVerifier } from '../environment-maintenance/restore/EnvironmentBackupCatalog.js';
import { EnvironmentRestoreContinuityVerifier } from '../environment-maintenance/restore/EnvironmentRestoreContinuityVerifier.js';
import { EnvironmentRestoreCoordinationAdapter } from '../environment-maintenance/restore/EnvironmentRestoreCoordinationAdapter.js';
import { EnvironmentRestoreCoordinator } from '../environment-maintenance/restore/EnvironmentRestoreCoordinator.js';
import { EnvironmentRestoreRepositoryAdapter } from '../environment-maintenance/restore/EnvironmentRestoreRepositoryAdapter.js';
import { FileEnvironmentBackupCatalogSource } from '../environment-maintenance/restore/FileEnvironmentBackupCatalogSource.js';
import { FileEnvironmentRestoreState } from '../environment-maintenance/restore/FileEnvironmentRestoreState.js';
import { PublishedEnvironmentBackupSource } from '../environment-maintenance/restore/PublishedEnvironmentBackupSource.js';
import { BackupExportCoordinator } from '../project-authority/checkpoint/BackupExportCoordinator.js';
import { CloudBackupExportCheckpointSource } from '../project-authority/checkpoint/CloudBackupExportCheckpointSource.js';
import { ActiveClaimCustodyKeyReferenceGate } from '../project-authority/lifecycle/ActiveClaimCustodyKeyReferenceGate.js';
import { ActiveRepositoryIntegrityGate } from '../project-authority/lifecycle/ActiveRepositoryIntegrityGate.js';
import {
  ProjectLifecycleRecoveryDispatcher,
} from '../project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import { XChaCha20ClaimCustody } from '../project-authority/lifecycle/cloud-to-lan/XChaCha20ClaimCustody.js';
import { DeletionCoordinator } from '../project-authority/lifecycle/delete/DeletionCoordinator.js';
import { LeaveCoordinator } from '../project-authority/lifecycle/leave/LeaveCoordinator.js';
import { RetireCoordinator } from '../project-authority/lifecycle/retire/RetireCoordinator.js';
import { EnvironmentRestoreRepositoryInspection } from '../repositories/EnvironmentRestoreRepositoryInspection.js';
import { GitRepositoryAuthority } from '../repositories/GitRepositoryAuthority.js';
import {
  createMaintenanceCheckpointRuntime,
  type MaintenanceCheckpointRuntime,
} from './MaintenanceCheckpointRuntime.js';
import { createMaintenanceAuthorityTransferRecovery } from './MaintenanceAuthorityTransferRecovery.js';

export interface MaintenanceOperations {
  backup(signal: AbortSignal): Promise<void>;
  exportProject(signal: AbortSignal): Promise<void>;
  reconcileExports(signal: AbortSignal): Promise<void>;
  recoverProjects(signal: AbortSignal): Promise<void>;
  recoverRestore(signal: AbortSignal): Promise<void>;
  restore(signal: AbortSignal): Promise<void>;
  resumeDelete(signal: AbortSignal): Promise<void>;
  verifyAuthority(signal: AbortSignal): Promise<void>;
  verifyBackup(signal: AbortSignal): Promise<void>;
}

interface EnvironmentRestoreOwners {
  readonly catalog: FileEnvironmentBackupCatalogSource;
  readonly coordinator: EnvironmentRestoreCoordinator;
}

function environmentRestoreOwners(
  runtime: MaintenanceCheckpointRuntime,
  config: ServerConfig,
  keyring: ClaimCustodyKeyringConfig,
  migrationConnectionString: string,
): EnvironmentRestoreOwners {
  const catalog = new FileEnvironmentBackupCatalogSource({
    catalogRoot: BACKUP_CATALOG_ROOT,
  });
  const source = new PublishedEnvironmentBackupSource({
    catalog,
    checkpoint: runtime.checkpoint,
    publication: runtime.backupPublication,
    keyReferences: keyReferenceVerifier(keyring),
  });
  const storage = new PostgresEnvironmentRestorePersistence({
    connectionString: migrationConnectionString,
  });
  return Object.freeze({
    catalog,
    coordinator: new EnvironmentRestoreCoordinator({
      backup: new EnvironmentBackupCatalogVerifier({
        coordinationSchemaCompatibility:
          MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY,
        repositoryFormatVersion: REPOSITORY_FORMAT_VERSION,
        serverBuild: SERVER_BUILD,
        source,
      }),
      continuity: new EnvironmentRestoreContinuityVerifier({
        custody: new XChaCha20ClaimCustody({
          activeKeyId: keyring.activeEncryptionKeyId,
          keys: keyring.encryptionKeys,
        }),
        source,
        storage,
      }),
      coordination: new EnvironmentRestoreCoordinationAdapter({
        source,
        storage,
      }),
      repositories: new EnvironmentRestoreRepositoryAdapter({
        inspection: new EnvironmentRestoreRepositoryInspection({
          repositoryRoot: config.repository.root,
          stagingRoot: config.developmentBootstrap.stagingRoot,
        }),
        publication: runtime.repository,
        source,
        staging: runtime.importer,
      }),
      state: new FileEnvironmentRestoreState({
        authorityRoot: authorityRoot(config),
      }),
    }),
  });
}

export interface CreateMaintenanceOperationsOptions {
  readonly source: ConfigSource;
}

interface BackupExportOwners {
  readonly backup: BackupExportCoordinator;
  readonly deletion: DeletionCoordinator;
  readonly dispatcher: ProjectLifecycleRecoveryDispatcher;
  readonly exportProject: BackupExportCoordinator;
  readonly leave: LeaveCoordinator;
  readonly retire: RetireCoordinator;
  close(): Promise<void>;
}

function authorityRoot(config: ServerConfig): string {
  return dirname(config.repository.root);
}

async function metadata(
  config: ServerConfig,
  coordinationSchemaVersion: number,
): Promise<Readonly<{
  readonly authorityId: string;
  readonly authorityVolumeIdentity: string;
  readonly coordinationSchemaVersion: number;
  readonly repositoryFormatVersion: number;
  readonly restoreEpoch: number;
  readonly serverBuild: string;
}>> {
  const facts = await new EnvironmentBackupMetadataSource({
    state: new FileEnvironmentRestoreState({
      authorityRoot: authorityRoot(config),
    }),
  }).read();
  return Object.freeze({
    ...facts,
    coordinationSchemaVersion,
    repositoryFormatVersion: REPOSITORY_FORMAT_VERSION,
    serverBuild: SERVER_BUILD,
  });
}

function keyReferenceVerifier(
  keyring: ClaimCustodyKeyringConfig,
): ClaimCustodyKeyReferenceVerifier {
  return new ClaimCustodyKeyReferenceVerifier({
    custody: new XChaCha20ClaimCustody({
      activeKeyId: keyring.activeEncryptionKeyId,
      keys: keyring.encryptionKeys,
    }),
    keyring,
  });
}

function backupExportOwners(
  runtime: MaintenanceCheckpointRuntime,
  backupMetadata: Awaited<ReturnType<typeof metadata>>,
  keyring?: ClaimCustodyKeyringConfig,
): BackupExportOwners {
  const source = new CloudBackupExportCheckpointSource({
    metadata: backupMetadata,
    repository: runtime.repository,
  });
  const backupSource = keyring === undefined
    ? source
    : new KeyReferenceCheckingBackupExportSource({
      source,
      verifier: keyReferenceVerifier(keyring),
    });
  const recovery = Object.freeze({
    recoverProject(projectId: CollabProjectId): Promise<void> {
      return dispatcher.recoverProject(projectId);
    },
  });
  const backup = new BackupExportCoordinator({
    checkpoint: runtime.checkpoint,
    coordination: runtime.coordination,
    metadata: backupMetadata,
    recovery,
    source: backupSource,
  });
  const exportProject = new BackupExportCoordinator({
    checkpoint: runtime.checkpoint,
    coordination: runtime.coordination,
    metadata: backupMetadata,
    recovery,
    source,
  });
  const deletion = new DeletionCoordinator({
    coordination: runtime.coordination,
    repository: runtime.repository,
  });
  const leave = new LeaveCoordinator({
    coordination: runtime.coordination,
    repository: runtime.repository,
  });
  const retire = new RetireCoordinator({
    coordination: runtime.coordination,
    repository: runtime.repository,
  });
  const authorityTransfer = createMaintenanceAuthorityTransferRecovery({
    checkpoint: runtime.checkpoint,
    coordination: runtime.coordination,
    environmentIdentity: backupMetadata.authorityVolumeIdentity,
    repository: runtime.repository,
  });
  const dispatcher = new ProjectLifecycleRecoveryDispatcher({
    coordination: runtime.coordination,
    owners: {
      authorityTransfer: authorityTransfer.owner,
      backup,
      deletion,
      export: exportProject,
      leave,
      retire,
    },
  });
  const exactDispatcher = dispatcher;
  return Object.freeze({
    backup,
    deletion,
    dispatcher: exactDispatcher,
    exportProject,
    leave,
    retire,
    async close(): Promise<void> {
      exactDispatcher.close();
      deletion.close();
      leave.close();
      retire.close();
      const results = await Promise.allSettled([
        backup.close(),
        authorityTransfer.close(),
        exportProject.close(),
      ]);
      if (results.some(result => result.status === 'rejected')) {
        throw new Error('maintenance-backup-export-owners.close-failed');
      }
    },
  });
}

async function withRuntime(
  source: ConfigSource,
  operation: (
    runtime: MaintenanceCheckpointRuntime,
    config: ServerConfig,
  ) => Promise<void>,
): Promise<void> {
  const config = decodeServerConfig(serverConfigSource(source));
  const runtime = createMaintenanceCheckpointRuntime(config);
  let failure: unknown;
  try {
    await operation(runtime, config);
  } catch (error: unknown) {
    failure = error;
  }
  try {
    await runtime.close();
  } catch (error: unknown) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure instanceof Error
      ? failure
      : new Error('maintenance-operations.error.dependency-failed');
  }
}

class Operations implements MaintenanceOperations {
  readonly #source: ConfigSource;

  constructor(options: CreateMaintenanceOperationsOptions) {
    this.#source = options.source;
  }

  async backup(signal: AbortSignal): Promise<void> {
    const input = decodeMaintenanceCommandConfig(this.#source, 'backup');
    const keyring = await loadClaimCustodyKeyring();
    await withRuntime(this.#source, async (runtime, config) => {
      const { authorityVolumeId, schemaVersion } =
        await runtime.verifyActiveAuthority();
      const backupMetadata = await metadata(config, schemaVersion);
      const owners = backupExportOwners(runtime, backupMetadata, keyring);
      try {
        const terminalCatalog = schemaVersion
          === MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY.minimumVersion
          ? new PostgresTerminalProjectContinuityCatalog({
              connectionString: decodeMigrationConfig(
                migrationConfigSource(this.#source),
              ).postgresUrl,
              expectedAuthorityVolumeId: authorityVolumeId,
              expectedSchemaVersion: schemaVersion,
            })
          : undefined;
        await new EnvironmentBackupCommand({
          backup: owners.backup,
          catalog: new FileEnvironmentBackupCatalogPublication({
            catalogRoot: BACKUP_CATALOG_ROOT,
          }),
          metadata: backupMetadata,
          projects: new EnvironmentBackupProjectCatalog({
            coordination: runtime.coordination,
            ...(terminalCatalog === undefined ? {} : { terminalCatalog }),
          }),
          recovery: {
            recoverAll: () => owners.dispatcher.recoverAll(runtime.coordination),
          },
          terminalRecords: keyReferenceVerifier(keyring),
        }).run({ catalogId: input.operationId, signal });
      } finally {
        await owners.close();
      }
    });
  }

  async exportProject(signal: AbortSignal): Promise<void> {
    const input = decodeMaintenanceCommandConfig(this.#source, 'export-project');
    if (input.expiresAt === undefined || input.projectId === undefined) {
      throw new Error('maintenance-operations.error.invalid-config');
    }
    const expiresAt = input.expiresAt;
    const projectId = input.projectId;
    await withRuntime(this.#source, async (runtime, config) => {
      const { schemaVersion } = await runtime.verifyActiveAuthority();
      const owners = backupExportOwners(
        runtime,
        await metadata(config, schemaVersion),
      );
      try {
        await new ProjectExportCommand({
          coordinator: owners.exportProject,
          delivery: new FileProjectExportDelivery({
            publication: runtime.exportPublication,
            root: EXPORT_ARTIFACT_ROOT,
          }),
        }).run({
          expiresAt,
          operationId: input.operationId,
          projectId,
          signal,
        });
      } finally {
        await owners.close();
      }
    });
  }

  async reconcileExports(signal: AbortSignal): Promise<void> {
    await withRuntime(this.#source, async (runtime, config) => {
      const { schemaVersion } = await runtime.verifyActiveAuthority();
      const owners = backupExportOwners(
        runtime,
        await metadata(config, schemaVersion),
      );
      try {
        await new ExportDeliveryExpiryCommand({
          coordinator: owners.exportProject,
        }).run(signal);
      } finally {
        await owners.close();
      }
    });
  }

  async recoverProjects(_signal: AbortSignal): Promise<void> {
    const keyring = await loadClaimCustodyKeyring();
    await withRuntime(this.#source, async (runtime, config) => {
      const { schemaVersion } = await runtime.verifyActiveAuthority();
      const owners = backupExportOwners(
        runtime,
        await metadata(config, schemaVersion),
        keyring,
      );
      try {
        await owners.dispatcher.recoverAll(runtime.coordination);
      } finally {
        await owners.close();
      }
    });
  }

  async verifyBackup(signal: AbortSignal): Promise<void> {
    const input = decodeMaintenanceCommandConfig(this.#source, 'verify-backup');
    const keyring = await loadClaimCustodyKeyring();
    const migrationConnectionString = decodeMigrationConfig(
      migrationConfigSource(this.#source),
    ).postgresUrl;
    await withRuntime(this.#source, async (runtime, config) => {
      const owners = environmentRestoreOwners(
        runtime,
        config,
        keyring,
        migrationConnectionString,
      );
      await new EnvironmentRestoreCommand({
        catalog: owners.catalog,
        restore: owners.coordinator,
        target: new PostgresEnvironmentRestoreTarget({
          connectionString: migrationConnectionString,
        }),
      }).run({
        catalogId: input.operationId,
        operationId: input.operationId,
        signal,
      });
    });
  }

  async restore(signal: AbortSignal): Promise<void> {
    const input = decodeMaintenanceCommandConfig(this.#source, 'restore');
    const keyring = await loadClaimCustodyKeyring();
    const migrationConnectionString = decodeMigrationConfig(
      migrationConfigSource(this.#source),
    ).postgresUrl;
    await withRuntime(this.#source, async (runtime, config) => {
      const owners = environmentRestoreOwners(
        runtime,
        config,
        keyring,
        migrationConnectionString,
      );
      await new EnvironmentRestoreCommand({
        catalog: owners.catalog,
        restore: owners.coordinator,
        target: new PostgresEnvironmentRestoreTarget({
          connectionString: migrationConnectionString,
        }),
      }).run({
        catalogId: input.operationId,
        operationId: input.operationId,
        signal,
      });
    });
  }

  async recoverRestore(signal: AbortSignal): Promise<void> {
    const config = decodeServerConfig(serverConfigSource(this.#source));
    const state = new FileEnvironmentRestoreState({
      authorityRoot: authorityRoot(config),
    });
    const inspection = await state.inspect(signal);
    if (inspection.journal === undefined) return;
    const keyring = await loadClaimCustodyKeyring();
    const migrationConnectionString = decodeMigrationConfig(
      migrationConfigSource(this.#source),
    ).postgresUrl;
    await withRuntime(this.#source, async (runtime, exactConfig) => {
      await environmentRestoreOwners(
        runtime,
        exactConfig,
        keyring,
        migrationConnectionString,
      ).coordinator.recover({ signal });
    });
  }

  async resumeDelete(signal: AbortSignal): Promise<void> {
    const input = decodeMaintenanceCommandConfig(this.#source, 'resume-delete');
    if (
      input.authorizationSha256 === undefined
      || input.projectId === undefined
    ) throw new Error('maintenance-operations.error.invalid-config');
    const authorizationSha256 = input.authorizationSha256;
    const projectId = input.projectId;
    await withRuntime(this.#source, async runtime => {
      await runtime.verifyActiveAuthority();
      const deletion = new DeletionCoordinator({
        coordination: runtime.coordination,
        repository: runtime.repository,
      });
      try {
        await new ResumeDeletionCommand({ coordinator: deletion }).run({
          authorizationSha256,
          operationId: input.operationId,
          projectId,
          signal,
        });
      } finally {
        deletion.close();
      }
    });
  }

  async verifyAuthority(signal: AbortSignal): Promise<void> {
    decodeMaintenanceCommandConfig(this.#source, 'verify-authority');
    const keyring = await loadClaimCustodyKeyring();
    await withRuntime(this.#source, async (runtime, config) => {
      const { authorityVolumeId, schemaVersion } =
        await runtime.verifyActiveAuthority();
      const repository = new GitRepositoryAuthority({
        gitExecutable: config.repository.gitExecutable,
        operationTimeoutMs: config.repository.operationTimeoutMs,
        outputMaxBytes: config.repository.outputMaxBytes,
        placementValidator: runtime.coordination,
        repositoryRoot: config.repository.root,
        resourceAdmission: runtime.resourceAdmission,
        storageNodeId: config.repository.storageNodeId,
      });
      try {
        await repository.verifyCapability();
        await new ActiveRepositoryIntegrityGate({
          cleanupReceivePackState: false,
          coordination: runtime.coordination,
          repository,
        }).verifyAll(signal);
        const backupMetadata = await metadata(config, schemaVersion);
        const terminalCatalog = schemaVersion
          === MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY.minimumVersion
          ? new PostgresTerminalProjectContinuityCatalog({
              connectionString: decodeMigrationConfig(
                migrationConfigSource(this.#source),
              ).postgresUrl,
              expectedAuthorityVolumeId: authorityVolumeId,
              expectedSchemaVersion: schemaVersion,
            })
          : undefined;
        await new ActiveClaimCustodyKeyReferenceGate({
          coordination: runtime.coordination,
          metadata: { read: () => Promise.resolve(backupMetadata) },
          ...(terminalCatalog === undefined ? {} : { terminalCatalog }),
          verifier: keyReferenceVerifier(keyring),
        }).verifyAll(signal);
      } finally {
        await repository.close();
      }
    });
  }
}

export function createMaintenanceOperations(
  options: CreateMaintenanceOperationsOptions,
): MaintenanceOperations {
  return new Operations(options);
}
