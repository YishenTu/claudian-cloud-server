import type {
  CancelProjectAuthorityTransferRequest,
  CollabAuthorityTransferDirection,
  CollabAuthorityTransferStatus,
  GetProjectAuthorityTransferRequest,
} from '@claudian-collab/protocol';

import {
  CloudToLanTransferCoordinatorError,
  type CloudToLanTransferCoordinator,
} from './cloud-to-lan/CloudToLanTransferCoordinator.js';
import {
  LanToCloudTransferCoordinatorError,
  type LanToCloudTransferCoordinator,
} from './lan-to-cloud/LanToCloudTransferCoordinator.js';

export type AuthorityTransferControlDispatcherErrorCode =
  | 'aborted'
  | 'authorization-denied'
  | 'closed'
  | 'dependency-failed'
  | 'recovery-required';

export class AuthorityTransferControlDispatcherError extends Error {
  readonly code: AuthorityTransferControlDispatcherErrorCode;

  constructor(code: AuthorityTransferControlDispatcherErrorCode) {
    super(`authority-transfer-control-dispatcher.error.${code}`);
    this.name = 'AuthorityTransferControlDispatcherError';
    this.code = code;
  }
}

type TransferControlOwner = Pick<
  CloudToLanTransferCoordinator | LanToCloudTransferCoordinator,
  'cancel' | 'getStatus'
>;

export interface AuthorityTransferControlDispatcherOptions {
  readonly cloudToLan: TransferControlOwner;
  readonly lanToCloud: TransferControlOwner;
}

export interface GetAuthorityTransferStatusInput {
  readonly principalId: string;
  readonly request: GetProjectAuthorityTransferRequest;
}

export interface CancelAuthorityTransferInput {
  readonly principalId: string;
  readonly request: CancelProjectAuthorityTransferRequest;
  readonly signal: AbortSignal;
}

interface AuthorizedTransfer {
  readonly direction: CollabAuthorityTransferDirection;
  readonly status: CollabAuthorityTransferStatus;
}

function fail(code: AuthorityTransferControlDispatcherErrorCode): never {
  throw new AuthorityTransferControlDispatcherError(code);
}

function dependencyFailure(
  result: PromiseRejectedResult,
): AuthorityTransferControlDispatcherErrorCode | undefined {
  const error: unknown = result.reason as unknown;
  if (
    !(error instanceof CloudToLanTransferCoordinatorError)
    && !(error instanceof LanToCloudTransferCoordinatorError)
  ) return 'dependency-failed';
  if (error.code === 'closed') return 'closed';
  if (error.code === 'dependency-failed') return 'dependency-failed';
  return undefined;
}

function requestAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Owns the shared direction-neutral transfer reads and cancellations. Each
 * candidate read enters its direction owner's canonical Project lane and
 * applies that owner's authorization rules before direction is selected.
 */
export class AuthorityTransferControlDispatcher {
  readonly #cloudToLan: TransferControlOwner;
  readonly #lanToCloud: TransferControlOwner;

  constructor(options: AuthorityTransferControlDispatcherOptions) {
    this.#cloudToLan = options.cloudToLan;
    this.#lanToCloud = options.lanToCloud;
  }

  async getStatus(
    input: GetAuthorityTransferStatusInput,
  ): Promise<CollabAuthorityTransferStatus> {
    return (await this.#resolveAuthorized(input)).status;
  }

  async cancel(input: CancelAuthorityTransferInput): Promise<CollabAuthorityTransferStatus> {
    if (requestAborted(input.signal)) return fail('aborted');
    const authorized = await this.#resolveAuthorized(input);
    if (requestAborted(input.signal)) return fail('aborted');
    const owner = authorized.direction === 'cloud-to-lan'
      ? this.#cloudToLan
      : this.#lanToCloud;
    return owner.cancel({
      principalId: input.principalId,
      request: input.request,
    });
  }

  async #resolveAuthorized(
    input: GetAuthorityTransferStatusInput,
  ): Promise<AuthorizedTransfer> {
    const [cloudToLan, lanToCloud] = await Promise.allSettled([
      this.#cloudToLan.getStatus(input),
      this.#lanToCloud.getStatus(input),
    ]);
    const authorized: AuthorizedTransfer[] = [];
    if (cloudToLan.status === 'fulfilled') {
      authorized.push({ direction: 'cloud-to-lan', status: cloudToLan.value });
    }
    if (lanToCloud.status === 'fulfilled') {
      authorized.push({ direction: 'lan-to-cloud', status: lanToCloud.value });
    }
    const exact = authorized[0];
    if (authorized.length === 1 && exact !== undefined) return exact;
    if (authorized.length > 1) return fail('recovery-required');

    const dependency = [cloudToLan, lanToCloud]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(dependencyFailure)
      .find(code => code === 'closed' || code === 'dependency-failed');
    if (dependency !== undefined) return fail(dependency);

    // Unknown Projects/transfers and unrelated principals deliberately share
    // one result so authorization never becomes an existence oracle.
    return fail('authorization-denied');
  }
}
