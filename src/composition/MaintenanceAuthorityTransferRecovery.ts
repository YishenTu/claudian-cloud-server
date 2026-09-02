import { AuthorityTransferRecoveryDispatcher } from '../project-authority/lifecycle/AuthorityTransferRecoveryDispatcher.js';
import type { CloudToLanTransferCoordinator } from '../project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
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
  readonly cloudToLan: Pick<
    CloudToLanTransferCoordinator,
    'close' | 'recover' | 'reserveRecovery'
  >;
  readonly repository: ExactRepositoryPresencePort & InactiveRepositoryPublicationPort;
}

export interface MaintenanceAuthorityTransferRecovery {
  readonly owner: AuthorityTransferRecoveryDispatcher;
  close(): Promise<void>;
}

/** Wires both complete direction owners for the offline Project recovery gate. */
export function createMaintenanceAuthorityTransferRecovery(
  options: MaintenanceAuthorityTransferRecoveryOptions,
): MaintenanceAuthorityTransferRecovery {
  return Object.freeze({
    close: () => options.cloudToLan.close(),
    owner: new AuthorityTransferRecoveryDispatcher({
      cloudToLan: options.cloudToLan,
      lanToCloud: new LanToCloudPostCutoverRecovery({
        activation: new LanToCloudProjectActivation(),
        checkpoint: options.checkpoint,
        repository: options.repository,
      }),
    }),
  });
}
