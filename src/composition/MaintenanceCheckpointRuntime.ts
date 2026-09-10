import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_LIMITS,
} from '@claudian-collab/protocol';

import {
  BACKUP_ARTIFACT_ROOT,
  EXPORT_ARTIFACT_ROOT,
} from '../config/MaintenanceCommandConfig.js';
import type { ServerConfig } from '../config/ServerConfig.js';
import { PostgresCoordination } from '../coordination/postgres/PostgresCoordination.js';
import { ProductionCheckpointStaging } from '../onboarding/production/ProductionCheckpointStaging.js';
import { LifecycleCheckpointPublication } from '../project-authority/checkpoint/LifecycleCheckpointPublication.js';
import { ProjectCheckpointCoordinator } from '../project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import { GitBundleImporter } from '../repositories/GitBundleImporter.js';
import { RepositoryCheckpointAuthority } from '../repositories/RepositoryCheckpointAuthority.js';
import { BootstrapUploadAdmission } from '../resource-admission/BootstrapUploadAdmission.js';
import { CheckpointStreamAdmission } from '../resource-admission/CheckpointStreamAdmission.js';
import { ResourceAdmission } from '../resource-admission/ResourceAdmission.js';
import { AuthorityVolumePairVerifier } from './AuthorityVolumePairVerifier.js';

export interface MaintenanceCheckpointRuntime {
  readonly backupPublication: LifecycleCheckpointPublication;
  readonly checkpoint: ProjectCheckpointCoordinator;
  readonly coordination: PostgresCoordination;
  readonly exportPublication: LifecycleCheckpointPublication;
  readonly importer: GitBundleImporter;
  readonly repository: RepositoryCheckpointAuthority;
  readonly resourceAdmission: ResourceAdmission;
  close(): Promise<void>;
  verifyActiveAuthority(): Promise<Readonly<{
    readonly authorityVolumeId: string;
    readonly schemaVersion: number;
  }>>;
}

function checkpointAdmission(
  config: ServerConfig,
  stagingRoot: string,
): CheckpointStreamAdmission {
  return new CheckpointStreamAdmission({
    ...config.checkpointAdmission,
    capacityTimeoutMs: config.gitAdmission.queueTimeoutMs,
    freeSpaceFloorBytes:
      config.developmentBootstrap.stagingFreeSpaceFloorBytes,
    maximumCoordinationBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
    maximumManifestBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
    maximumRepositoryBundleBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
    queueTimeoutMs: config.gitAdmission.queueTimeoutMs,
    stagingReservationBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
    stagingRoot,
  });
}

function staging(
  config: ServerConfig,
  root: string,
  admission: CheckpointStreamAdmission,
): ProductionCheckpointStaging {
  return new ProductionCheckpointStaging({
    admission,
    idleTimeoutMs: config.developmentBootstrap.uploadIdleTimeoutMs,
    stagingRoot: root,
    totalTimeoutMs: config.developmentBootstrap.uploadDeadlineMs,
  });
}

class Runtime implements MaintenanceCheckpointRuntime {
  readonly backupPublication: LifecycleCheckpointPublication;
  readonly checkpoint: ProjectCheckpointCoordinator;
  readonly coordination: PostgresCoordination;
  readonly exportPublication: LifecycleCheckpointPublication;
  readonly importer: GitBundleImporter;
  readonly repository: RepositoryCheckpointAuthority;
  readonly resourceAdmission: ResourceAdmission;
  readonly #authorityPair: AuthorityVolumePairVerifier;
  readonly #backupAdmission: CheckpointStreamAdmission;
  readonly #backupStore: ProductionCheckpointStaging;
  readonly #exportAdmission: CheckpointStreamAdmission;
  readonly #exportStore: ProductionCheckpointStaging;
  readonly #inboundAdmission: CheckpointStreamAdmission;
  readonly #inboundStore: ProductionCheckpointStaging;
  readonly #shutdownTimeoutMs: number;
  readonly #uploadAdmission: BootstrapUploadAdmission;
  #closePromise: Promise<void> | undefined;

  constructor(config: ServerConfig) {
    this.#shutdownTimeoutMs = config.shutdownTimeoutMs;
    this.resourceAdmission = new ResourceAdmission(config.gitAdmission);
    this.coordination = new PostgresCoordination({
      ordinaryPoolMax: config.postgres.ordinaryPoolMax,
      pinnedPoolMax: config.postgres.pinnedPoolMax,
      projectLockTimeoutMs: config.postgres.projectLockTimeoutMs,
      reservedPoolMax: config.postgres.reservedPoolMax,
      runtimeConnectionString: config.postgres.url,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    });
    this.#authorityPair = new AuthorityVolumePairVerifier({
      coordination: this.coordination,
      repositoryRoot: config.repository.root,
      stagingRoot: config.developmentBootstrap.stagingRoot,
    });
    this.#uploadAdmission = new BootstrapUploadAdmission({
      maxConcurrentUploads:
        config.developmentBootstrap.maxConcurrentUploads,
      maxUploadsPerAttempt:
        config.developmentBootstrap.maxUploadsPerAttempt,
      queueMax: config.developmentBootstrap.queueMax,
      queueTimeoutMs: config.developmentBootstrap.queueTimeoutMs,
      stagingFreeSpaceFloorBytes:
        config.developmentBootstrap.stagingFreeSpaceFloorBytes,
      stagingReservationBytes:
        config.developmentBootstrap.stagingReservationBytes,
      stagingRoot: config.developmentBootstrap.stagingRoot,
    });
    this.importer = new GitBundleImporter({
      gitExecutable: config.repository.gitExecutable,
      maximumBlobBytes: COLLAB_LIMITS.maxBlobBytes,
      maximumBundleBytes:
        COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
      maximumExpandedTreeEntries: 100_000,
      maximumMetadataOutputBytes: config.repository.outputMaxBytes,
      maximumRepositoryBytes:
        config.developmentBootstrap.maxRepositoryBytes,
      maximumTreeEntries: COLLAB_LIMITS.maxChangedPaths,
      operationTimeoutMs: config.repository.operationTimeoutMs,
      resourceAdmission: this.resourceAdmission,
      stagingRoot: config.developmentBootstrap.stagingRoot,
      uploadAdmission: this.#uploadAdmission,
      uploadIdleTimeoutMs:
        config.developmentBootstrap.uploadIdleTimeoutMs,
      uploadTotalTimeoutMs:
        config.developmentBootstrap.uploadDeadlineMs,
    });
    this.repository = new RepositoryCheckpointAuthority({
      gitExecutable: config.repository.gitExecutable,
      maximumBlobBytes: COLLAB_LIMITS.maxBlobBytes,
      maximumBundleBytes:
        COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
      maximumExpandedTreeEntries: 100_000,
      maximumRepositoryBytes:
        config.developmentBootstrap.maxRepositoryBytes,
      maximumTreeEntries: COLLAB_LIMITS.maxChangedPaths,
      operationRoot: config.developmentBootstrap.stagingRoot,
      operationTimeoutMs: config.repository.operationTimeoutMs,
      outputMaxBytes: config.repository.outputMaxBytes,
      placementValidator: this.coordination,
      repositoryRoot: config.repository.root,
      resourceAdmission: this.resourceAdmission,
      storageNodeId: config.repository.storageNodeId,
    });
    this.#inboundAdmission = checkpointAdmission(
      config,
      config.developmentBootstrap.stagingRoot,
    );
    this.#backupAdmission = checkpointAdmission(config, BACKUP_ARTIFACT_ROOT);
    this.#exportAdmission = checkpointAdmission(config, EXPORT_ARTIFACT_ROOT);
    this.#inboundStore = staging(
      config,
      config.developmentBootstrap.stagingRoot,
      this.#inboundAdmission,
    );
    this.#backupStore = staging(
      config,
      BACKUP_ARTIFACT_ROOT,
      this.#backupAdmission,
    );
    this.#exportStore = staging(
      config,
      EXPORT_ARTIFACT_ROOT,
      this.#exportAdmission,
    );
    this.backupPublication = new LifecycleCheckpointPublication(
      this.#backupStore,
      'backup',
    );
    this.exportPublication = new LifecycleCheckpointPublication(
      this.#exportStore,
      'export',
    );
    this.checkpoint = new ProjectCheckpointCoordinator({
      publication: {
        backup: this.backupPublication,
        export: this.exportPublication,
      },
      repository: this.importer,
      repositoryCapture: this.repository,
      staging: this.#inboundStore,
    });
  }

  async verifyActiveAuthority(): Promise<Readonly<{
    readonly authorityVolumeId: string;
    readonly schemaVersion: number;
  }>> {
    const schemaVersion = await this.coordination.verifySchemaCompatibility();
    const authorityVolumeId = await this.#authorityPair.verify();
    return Object.freeze({ authorityVolumeId, schemaVersion });
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    const deadline = Date.now() + this.#shutdownTimeoutMs;
    let failed = false;
    if (!await settleOwnersBefore([
      this.checkpoint.close(),
    ], deadline)) failed = true;
    if (!await settleOwnersBefore([
      this.#backupStore.close(),
      this.#exportStore.close(),
      this.#inboundStore.close(),
    ], deadline)) failed = true;
    if (!await settleOwnersBefore([
      this.repository.close(),
      this.importer.close(),
    ], deadline)) failed = true;
    if (!await settleOwnersBefore([
      this.#uploadAdmission.close(),
    ], deadline)) failed = true;
    if (!await settleOwnersBefore([
      this.#backupAdmission.close(),
      this.#exportAdmission.close(),
      this.#inboundAdmission.close(),
    ], deadline)) failed = true;
    if (!await settleOwnersBefore([
      this.resourceAdmission.close(),
    ], deadline)) failed = true;
    if (!await settleOwnersBefore([
      this.coordination.close(),
    ], deadline)) failed = true;
    if (failed) throw new Error('maintenance-checkpoint-runtime.close-failed');
  }
}

async function settleOwnersBefore(
  operations: readonly Promise<unknown>[],
  deadline: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(operations).then(results => (
        results.every(result => result.status === 'fulfilled')
      )),
      new Promise<false>(resolve => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), false);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createMaintenanceCheckpointRuntime(
  config: ServerConfig,
): MaintenanceCheckpointRuntime {
  return new Runtime(config);
}
