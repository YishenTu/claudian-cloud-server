import { dirname } from 'node:path';

import { COLLAB_CHECKPOINT_ARTIFACT_LIMITS } from '@claudian-collab/protocol';

import type { ClaimCustodyKeyringConfig } from '../config/ClaimCustodyKeyringConfig.js';
import type { ServerConfig } from '../config/ServerConfig.js';
import type { PostgresCoordination } from '../coordination/postgres/PostgresCoordination.js';
import { EnvironmentBackupMetadataSource } from '../environment-maintenance/commands/EnvironmentBackupMetadataSource.js';
import { FileEnvironmentRestoreState } from '../environment-maintenance/restore/FileEnvironmentRestoreState.js';
import { ProductionCheckpointStaging } from '../onboarding/production/ProductionCheckpointStaging.js';
import { ProjectCheckpointCoordinator } from '../project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import { AuthorityTransferControlDispatcher } from '../project-authority/lifecycle/AuthorityTransferControlDispatcher.js';
import { AuthorityTransferRecoveryDispatcher } from '../project-authority/lifecycle/AuthorityTransferRecoveryDispatcher.js';
import { AuthorityTransferArtifactAuthority } from '../project-authority/lifecycle/AuthorityTransferArtifactAuthority.js';
import { CloudAuthorityTransferCheckpoint } from '../project-authority/lifecycle/cloud-to-lan/CloudAuthorityTransferCheckpoint.js';
import { CloudToLanTransferCoordinator } from '../project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
import { ProjectAuthoritySourceFence } from '../project-authority/lifecycle/cloud-to-lan/ProjectAuthoritySourceFence.js';
import { XChaCha20ClaimCustody } from '../project-authority/lifecycle/cloud-to-lan/XChaCha20ClaimCustody.js';
import { DeletionCoordinator } from '../project-authority/lifecycle/delete/DeletionCoordinator.js';
import { LanToCloudProjectActivation } from '../project-authority/lifecycle/lan-to-cloud/LanToCloudProjectActivation.js';
import { LanToCloudTransferCoordinator } from '../project-authority/lifecycle/lan-to-cloud/LanToCloudTransferCoordinator.js';
import type { LeaveCoordinator } from '../project-authority/lifecycle/leave/LeaveCoordinator.js';
import {
  ProductionAuthorityTransferTrust,
  KeyringAuthorityTransferSigner,
} from '../project-authority/lifecycle/ProductionAuthorityTransferCryptography.js';
import {
  ProjectLifecycleRecoveryDispatcher,
  type ProjectLifecycleRecoveryOwner,
} from '../project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import { RetireCoordinator } from '../project-authority/lifecycle/retire/RetireCoordinator.js';
import { TerminalResponderExpiry } from '../project-authority/lifecycle/retire/TerminalResponderExpiry.js';
import type { ProjectMemberRemovalCoordinator } from '../project-authority/membership/ProjectMemberRemovalCoordinator.js';
import type { RepositoryCheckpointAuthority } from '../repositories/RepositoryCheckpointAuthority.js';
import type { GitBundleImporter } from '../repositories/GitBundleImporter.js';
import { CheckpointStreamAdmission } from '../resource-admission/CheckpointStreamAdmission.js';
import { CloudLifecycleControlAdapter } from '../server/control/CloudLifecycleControl.js';
import {
  ComposedCloudLifecycleRuntime,
  type CloudLifecycleRuntime,
} from './CloudLifecycleRuntime.js';
import { TerminalResponderExpiryReconciler } from './TerminalResponderExpiryReconciler.js';
import { ProjectLifecycleRecoveryReconciler } from './ProjectLifecycleRecoveryReconciler.js';

export interface ProductionCloudLifecycleRuntimeOptions {
  readonly config: ServerConfig;
  readonly coordination: PostgresCoordination;
  readonly keyring: ClaimCustodyKeyringConfig;
  readonly leave: LeaveCoordinator;
  readonly importer: GitBundleImporter;
  readonly removal: ProjectMemberRemovalCoordinator;
  readonly repository: RepositoryCheckpointAuthority;
}

function checkpointAdmission(config: ServerConfig): CheckpointStreamAdmission {
  return new CheckpointStreamAdmission({
    capacityTimeoutMs: config.gitAdmission.queueTimeoutMs,
    freeSpaceFloorBytes: config.developmentBootstrap.stagingFreeSpaceFloorBytes,
    maxConcurrentStreams: 2,
    maxConcurrentStreamsPerProject: 1,
    maxStagingAttempts: 2,
    maxStagingAttemptsPerProject: 1,
    maximumCoordinationBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
    maximumManifestBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
    maximumRepositoryBundleBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
    queueMax: 2,
    queueMaxPerProject: 1,
    queueTimeoutMs: config.gitAdmission.queueTimeoutMs,
    stagingReservationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
    stagingRoot: config.developmentBootstrap.stagingRoot,
  });
}

const unavailableOnlineMaintenanceOwner: ProjectLifecycleRecoveryOwner = Object.freeze({
  recover: () => Promise.reject(
    new Error('production-cloud-lifecycle-runtime.offline-maintenance-required'),
  ),
});

/** Constructs every online lifecycle owner around the serving process's stores. */
export function createProductionCloudLifecycleRuntime(
  options: ProductionCloudLifecycleRuntimeOptions,
): CloudLifecycleRuntime {
  const admission = checkpointAdmission(options.config);
  const staging = new ProductionCheckpointStaging({
    admission,
    idleTimeoutMs: options.config.developmentBootstrap.uploadIdleTimeoutMs,
    stagingRoot: options.config.developmentBootstrap.stagingRoot,
    totalTimeoutMs: options.config.developmentBootstrap.uploadDeadlineMs,
  });
  const checkpoint = new ProjectCheckpointCoordinator({
    repository: options.importer,
    repositoryCapture: options.repository,
    staging,
  });
  const metadata = new EnvironmentBackupMetadataSource({
    state: {
      inspect: () => new FileEnvironmentRestoreState({
        authorityRoot: dirname(options.config.repository.root),
      }).inspectSettled(),
    },
  });
  const signer = new KeyringAuthorityTransferSigner(options.keyring);
  const trust = new ProductionAuthorityTransferTrust();
  const deletion = new DeletionCoordinator({
    coordination: options.coordination,
    repository: options.repository,
  });
  const lanToCloud = new LanToCloudTransferCoordinator({
    deletion,
    activation: new LanToCloudProjectActivation(),
    checkpoint,
    coordination: options.coordination,
    receiptSigner: signer,
    relinquishmentTrust: trust,
    repository: options.repository,
    staging,
  });
  const cloudToLan = new CloudToLanTransferCoordinator({
    checkpoint: new CloudAuthorityTransferCheckpoint({
      checkpoint,
      metadata,
      repository: options.repository,
    }),
    coordination: options.coordination,
    custody: new XChaCha20ClaimCustody({
      activeKeyId: options.keyring.activeEncryptionKeyId,
      keys: options.keyring.encryptionKeys,
    }),
    environmentIdentity: {
      read: () => metadata.read().then(value => value.authorityVolumeIdentity),
    },
    relinquishmentSigner: signer,
    repository: options.repository,
    sourceFence: new ProjectAuthoritySourceFence(),
    targetTrust: trust,
  });
  const transfer = new AuthorityTransferControlDispatcher({
    cloudToLan,
    lanToCloud,
  });
  const retire = new RetireCoordinator({
    coordination: options.coordination,
    repository: options.repository,
  });
  const recovery = new ProjectLifecycleRecoveryDispatcher({
    coordination: options.coordination,
    owners: {
      authorityTransfer: new AuthorityTransferRecoveryDispatcher({
        cloudToLan,
        lanToCloud,
      }),
      backup: unavailableOnlineMaintenanceOwner,
      deletion,
      export: unavailableOnlineMaintenanceOwner,
      leave: options.leave,
      removal: options.removal,
      retire,
    },
  });
  const expiry = new TerminalResponderExpiryReconciler({
    catalog: options.coordination,
    expiry: new TerminalResponderExpiry({ coordination: options.coordination }),
    intervalMs: 60_000,
  });
  const recoveryReconciler = new ProjectLifecycleRecoveryReconciler({
    catalog: options.coordination,
    intervalMs: 60_000,
    recovery,
  });
  const control = new CloudLifecycleControlAdapter({
    cloudToLan,
    lanToCloud,
    retire,
    transfer,
  });
  return new ComposedCloudLifecycleRuntime({
    artifacts: new AuthorityTransferArtifactAuthority({
      downloadTransfer: cloudToLan,
      staging,
      uploadTransfer: lanToCloud,
    }),
    closeOrder: [
      cloudToLan,
      lanToCloud,
      checkpoint,
      staging,
      admission,
      retire,
      deletion,
    ],
    control,
    expiry,
    recovery,
    recoveryReconciler,
  });
}
