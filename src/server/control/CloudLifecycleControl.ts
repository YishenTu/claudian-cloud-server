import {
  CollabError,
  type AcceptCloudToLanTransferTargetRequest,
  type AcknowledgeTransferredMembershipClaimBatchRequest,
  type AcknowledgeTransferredMembershipClaimRedemptionRequest,
  type BeginCloudToLanTransferRequest,
  type BeginLanToCloudTransferRequest,
  type CancelProjectAuthorityTransferRequest,
  type ClaimTransferredMembershipRequest,
  type CollabControlOperationMap,
  type CollabProjectRetirementAcknowledgementRequest,
  type CollabProjectRetirementRequest,
  type CommitLanToCloudRelinquishmentRequest,
  type ConfirmCloudToLanTargetActiveRequest,
  type GetProjectAuthorityTransferRequest,
  type GetTransferredMembershipClaimRequest,
  type ReportCloudToLanTargetStagedRequest,
  type RotateTransferredMembershipClaimsRequest,
} from '@claudian-collab/protocol';

import {
  AuthorityTransferControlDispatcherError,
  type AuthorityTransferControlDispatcher,
} from '../../project-authority/lifecycle/AuthorityTransferControlDispatcher.js';
import {
  CloudToLanTransferCoordinatorError,
  type CloudToLanTransferCoordinator,
} from '../../project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
import {
  LanToCloudTransferCoordinatorError,
  type LanToCloudTransferCoordinator,
} from '../../project-authority/lifecycle/lan-to-cloud/LanToCloudTransferCoordinator.js';
import {
  RetireCoordinatorError,
  type RetireCoordinator,
} from '../../project-authority/lifecycle/retire/RetireCoordinator.js';
import type {
  CloudLifecycleControl,
  CloudLifecycleOperation,
  CloudLifecycleOperationContext,
} from './ProjectLifecycleRoutes.js';

type LanToCloudControl = Pick<
  LanToCloudTransferCoordinator,
  | 'acknowledgeClaimBatch'
  | 'begin'
  | 'claimMembership'
  | 'commitRelinquishment'
  | 'rotateClaims'
>;

type CloudToLanControl = Pick<
  CloudToLanTransferCoordinator,
  | 'acceptTarget'
  | 'acknowledgeRedemption'
  | 'begin'
  | 'confirmTargetActive'
  | 'getClaim'
  | 'reportTargetStaged'
>;

type RetireControl = Pick<RetireCoordinator, 'acknowledge' | 'retire'>;

type AuthorityTransferControl = Pick<
  AuthorityTransferControlDispatcher,
  'cancel' | 'getStatus'
>;

export interface CloudLifecycleControlAdapterOptions {
  readonly cloudToLan: CloudToLanControl;
  readonly lanToCloud: LanToCloudControl;
  readonly retire: RetireControl;
  readonly transfer: AuthorityTransferControl;
}

function requestFailure(
  operation: CloudLifecycleOperation,
  error: unknown,
): CollabError {
  const code = error instanceof LanToCloudTransferCoordinatorError
    || error instanceof CloudToLanTransferCoordinatorError
    || error instanceof RetireCoordinatorError
    || error instanceof AuthorityTransferControlDispatcherError
    ? error.code
    : undefined;
  switch (code) {
    case 'authorization-denied':
      return new CollabError({
        code: operation === 'claimTransferredMembership'
          ? 'membership-claim-invalid'
          : 'authorization-denied',
        recoveryActions: ['request-access'],
      });
    case 'expired':
      return new CollabError({
        code: operation === 'retireProject'
          || operation === 'acknowledgeProjectRetirement'
          ? 'project-retired'
          : operation === 'claimTransferredMembership'
          || operation === 'getTransferredMembershipClaim'
          ? 'membership-claim-expired'
          : 'authority-transfer-stale',
      });
    case 'aborted':
      return new CollabError({
        code: 'operation-timeout',
        recoveryActions: ['retry'],
      });
    case 'cancelled':
      return new CollabError({ code: 'authority-transfer-cancellation-forbidden' });
    case 'recovery-required':
      return new CollabError({
        code: 'authority-not-synchronized',
        recoveryActions: ['retry'],
      });
    case 'state-conflict':
      return new CollabError({
        code: operation === 'retireProject'
          || operation === 'acknowledgeProjectRetirement'
          ? 'project-retired'
          : 'authority-transfer-stale',
      });
    case 'closed':
    case 'dependency-failed':
    case 'invalid-checkpoint':
      return new CollabError({ code: 'operation-failed', recoveryActions: ['retry'] });
    default:
      return error instanceof CollabError
        ? error
        : new CollabError({ code: 'operation-failed' });
  }
}

export class CloudLifecycleControlAdapter implements CloudLifecycleControl {
  readonly #cloudToLan: CloudToLanControl;
  readonly #lanToCloud: LanToCloudControl;
  readonly #retire: RetireControl;
  readonly #transfer: AuthorityTransferControl;

  constructor(options: CloudLifecycleControlAdapterOptions) {
    this.#cloudToLan = options.cloudToLan;
    this.#lanToCloud = options.lanToCloud;
    this.#retire = options.retire;
    this.#transfer = options.transfer;
  }

  execute<Operation extends CloudLifecycleOperation>(
    operation: Operation,
    context: CloudLifecycleOperationContext<Operation>,
  ): Promise<CollabControlOperationMap[Operation]['response']> {
    if (context.signal.aborted) {
      return Promise.reject(new CollabError({
        code: 'operation-timeout',
        recoveryActions: ['retry'],
      }));
    }
    const result = this.#execute(
      operation,
      context as CloudLifecycleOperationContext<CloudLifecycleOperation>,
    ).catch((error: unknown) => Promise.reject(requestFailure(operation, error)));
    return result as Promise<CollabControlOperationMap[Operation]['response']>;
  }

  async #execute(
    operation: CloudLifecycleOperation,
    context: CloudLifecycleOperationContext<CloudLifecycleOperation>,
  ): Promise<unknown> {
    const principalId = context.principalId;
    switch (operation) {
      case 'beginLanToCloudTransfer':
        return this.#lanToCloud.begin({
          principalId,
          request: context.request as BeginLanToCloudTransferRequest,
        });
      case 'rotateTransferredMembershipClaims':
        return this.#lanToCloud.rotateClaims({
          principalId,
          request: context.request as RotateTransferredMembershipClaimsRequest,
        });
      case 'acknowledgeTransferredMembershipClaimBatch':
        return this.#lanToCloud.acknowledgeClaimBatch({
          principalId,
          request: context.request as AcknowledgeTransferredMembershipClaimBatchRequest,
        });
      case 'claimTransferredMembership':
        return this.#lanToCloud.claimMembership({
          principalId,
          request: context.request as ClaimTransferredMembershipRequest,
        });
      case 'commitLanToCloudRelinquishment':
        return this.#lanToCloud.commitRelinquishment({
          principalId,
          request: context.request as CommitLanToCloudRelinquishmentRequest,
        });
      case 'beginCloudToLanTransfer':
        return this.#cloudToLan.begin({
          principalId,
          request: context.request as BeginCloudToLanTransferRequest,
        });
      case 'acceptCloudToLanTransferTarget':
        return this.#cloudToLan.acceptTarget({
          principalId,
          request: context.request as AcceptCloudToLanTransferTargetRequest,
        });
      case 'reportCloudToLanTargetStaged':
        return this.#cloudToLan.reportTargetStaged({
          principalId,
          request: context.request as ReportCloudToLanTargetStagedRequest,
        });
      case 'confirmCloudToLanTargetActive':
        return this.#cloudToLan.confirmTargetActive({
          principalId,
          request: context.request as ConfirmCloudToLanTargetActiveRequest,
        });
      case 'getTransferredMembershipClaim':
        return this.#cloudToLan.getClaim({
          principalId,
          request: context.request as GetTransferredMembershipClaimRequest,
        });
      case 'acknowledgeTransferredMembershipClaimRedemption':
        return this.#cloudToLan.acknowledgeRedemption({
          principalId,
          request: context.request as AcknowledgeTransferredMembershipClaimRedemptionRequest,
        });
      case 'getProjectAuthorityTransfer': {
        const request = context.request as GetProjectAuthorityTransferRequest;
        return this.#transfer.getStatus({ principalId, request });
      }
      case 'cancelProjectAuthorityTransfer': {
        const request = context.request as CancelProjectAuthorityTransferRequest;
        return this.#transfer.cancel({
          principalId,
          request,
          signal: context.signal,
        });
      }
      case 'retireProject':
        return this.#retire.retire({
          principalId,
          request: context.request as CollabProjectRetirementRequest,
        });
      case 'acknowledgeProjectRetirement':
        return this.#retire.acknowledge({
          principalId,
          request: context.request as CollabProjectRetirementAcknowledgementRequest,
        });
    }
  }
}
