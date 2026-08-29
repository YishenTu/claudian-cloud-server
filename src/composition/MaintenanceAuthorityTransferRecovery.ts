import {
  productionCheckpointAttemptIdentity,
} from '../onboarding/production/ProductionCheckpointStaging.js';
import { AuthorityTransferRecoveryDispatcher } from '../project-authority/lifecycle/AuthorityTransferRecoveryDispatcher.js';
import {
  CloudToLanTransferCoordinator,
  CloudToLanTransferCoordinatorError,
  type CapturedCloudToLanCheckpoint,
  type CloudToLanCheckpointCapturePort,
  type CloudToLanTransferCoordination,
} from '../project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
import { LanToCloudProjectActivation } from '../project-authority/lifecycle/lan-to-cloud/LanToCloudProjectActivation.js';
import {
  LanToCloudPostCutoverRecovery,
  type LanToCloudTransferCoordinatorOptions,
} from '../project-authority/lifecycle/lan-to-cloud/LanToCloudTransferCoordinator.js';
import type {
  ExactRepositoryPresencePort,
  InactiveRepositoryPublicationPort,
} from '../repositories/RepositoryCheckpointAuthority.js';

export interface MaintenanceAuthorityTransferRecoveryOptions {
  readonly checkpoint: LanToCloudTransferCoordinatorOptions['checkpoint'];
  readonly coordination: CloudToLanTransferCoordination;
  readonly environmentIdentity: string;
  readonly repository: ExactRepositoryPresencePort & InactiveRepositoryPublicationPort;
}

export interface MaintenanceAuthorityTransferRecovery {
  readonly owner: AuthorityTransferRecoveryDispatcher;
  close(): Promise<void>;
}

class MaintenanceCloudToLanCheckpoint
implements CloudToLanCheckpointCapturePort {
  readonly #checkpoint: Pick<
    LanToCloudTransferCoordinatorOptions['checkpoint'],
    'discardAttempt'
  >;

  constructor(
    checkpoint: LanToCloudTransferCoordinatorOptions['checkpoint'],
  ) {
    this.#checkpoint = checkpoint;
  }

  capture(): Promise<never> {
    return unavailableCloudToLanDependency();
  }

  async discard(input: CapturedCloudToLanCheckpoint): Promise<'removed'> {
    await this.#checkpoint.discardAttempt(productionCheckpointAttemptIdentity({
      expiresAt: input.expiresAt,
      operationId: input.operationId,
      projectId: input.projectId,
    }));
    return 'removed';
  }
}

function unavailableCloudToLanDependency(): Promise<never> {
  return Promise.reject(new CloudToLanTransferCoordinatorError('dependency-failed'));
}

export function createMaintenanceAuthorityTransferRecovery(
  options: MaintenanceAuthorityTransferRecoveryOptions,
): MaintenanceAuthorityTransferRecovery {
  const cloudToLan = new CloudToLanTransferCoordinator({
    checkpoint: new MaintenanceCloudToLanCheckpoint(options.checkpoint),
    coordination: options.coordination,
    custody: {
      open: unavailableCloudToLanDependency,
      seal: unavailableCloudToLanDependency,
    },
    environmentIdentity: options.environmentIdentity,
    relinquishmentSigner: { sign: unavailableCloudToLanDependency },
    repository: options.repository,
    sourceFence: {
      quiesce: unavailableCloudToLanDependency,
      relinquish: unavailableCloudToLanDependency,
      reopen: unavailableCloudToLanDependency,
    },
    targetTrust: {
      invalidateAndClean: unavailableCloudToLanDependency,
      verifyAcceptance: unavailableCloudToLanDependency,
      verifyActivation: unavailableCloudToLanDependency,
      verifyRedemptionReceipt: unavailableCloudToLanDependency,
      verifyStaged: unavailableCloudToLanDependency,
    },
  });
  return Object.freeze({
    close: () => cloudToLan.close(),
    owner: new AuthorityTransferRecoveryDispatcher({
      cloudToLan,
      lanToCloud: new LanToCloudPostCutoverRecovery({
        activation: new LanToCloudProjectActivation(),
        checkpoint: options.checkpoint,
        repository: options.repository,
      }),
    }),
  });
}
