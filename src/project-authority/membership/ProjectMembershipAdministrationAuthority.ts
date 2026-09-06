import { createHash, randomUUID } from 'node:crypto';

import {
  COLLAB_PROJECT_MEMBERSHIP_LIMITS,
  CollabError,
  collabControlOperationCodec,
  type CollabManagerResponsibilityOfferResponse,
  type CollabProjectRequest,
  type CreateManagerResponsibilityOfferRequest,
  type DemoteManagerRequest,
  type DemoteManagerResponse,
  type GetManagerResponsibilityOfferRequest,
  type ListCurrentManagerResponsibilityOffersResponse,
  type ListProjectMembersResponse,
  type PromoteManagerRequest,
  type PromoteManagerResponse,
  type TransitionManagerResponsibilityOfferRequest,
} from '@claudian-collab/protocol';

import type { MembershipAdministrationStatus } from '../../coordination/ProjectMembershipPersistence.js';
import { ProjectMutationRejection } from '../ProjectMutationRejection.js';
import type { RequestPrincipal } from '../../request-context/RequestPrincipal.js';
import type { ProjectWriteAdmission } from '../admission/ProjectWriteAdmission.js';

export interface ProjectMembershipAdministrationAuthorityOptions {
  readonly clock?: () => Date;
  readonly offerIdFactory?: () => string;
  readonly writeAdmission: Pick<ProjectWriteAdmission, 'run'>;
}

type TransitionOperation =
  | 'acknowledgeManagerResponsibility'
  | 'cancelManagerResponsibilityOffer'
  | 'declineManagerResponsibility';

function domainError(
  code: ConstructorParameters<typeof CollabError>[0]['code'],
  reason: string,
): CollabError {
  return new CollabError({ code, safeContext: { reason } });
}

function canonicalNow(clock: () => Date): string {
  const value = new Date(clock().valueOf());
  if (Number.isNaN(value.valueOf())) throw new Error('invalid-clock');
  value.setUTCMilliseconds(0);
  return value.toISOString();
}

function plusMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function fingerprint(operation: string, request: object): string {
  return createHash('sha256')
    .update(JSON.stringify({ operation, request }), 'utf8')
    .digest('hex');
}

function mapStatus(status: MembershipAdministrationStatus): never {
  if (status === 'permanently-stale') {
    throw new ProjectMutationRejection({
      code: 'authority-not-synchronized',
      safeContext: { reason: 'membership-expected-state' },
    });
  }
  if (status === 'authorization-denied') {
    throw domainError('authorization-denied', 'membership-administration-denied');
  }
  if (status === 'stale' || status === 'final-manager') {
    throw domainError('authority-not-synchronized', 'membership-expected-state');
  }
  throw domainError('idempotency-conflict', 'membership-idempotency-conflict');
}

export class ProjectMembershipAdministrationAuthority {
  readonly #clock: () => Date;
  readonly #offerIdFactory: () => string;
  readonly #writeAdmission: Pick<ProjectWriteAdmission, 'run'>;

  constructor(options: ProjectMembershipAdministrationAuthorityOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#offerIdFactory = options.offerIdFactory ?? (() => (
      `offer_${randomUUID().replaceAll('-', '')}`
    ));
    this.#writeAdmission = options.writeAdmission;
  }

  listMembers(
    principal: RequestPrincipal,
    request: CollabProjectRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<ListProjectMembersResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      const response = await write.transact(scope => (
        scope.membership.listProjectMembers({
          actorRole: write.role,
          now: canonicalNow(this.#clock),
        })
      ));
      return collabControlOperationCodec('listProjectMembers').decodeResponse(response);
    }, options);
  }

  createOffer(
    principal: RequestPrincipal,
    request: CreateManagerResponsibilityOfferRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabManagerResponsibilityOfferResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      if (write.role !== 'manager') {
        throw domainError('authorization-denied', 'manager-required');
      }
      const offeredAt = canonicalNow(this.#clock);
      const result = await write.transact(scope => (
        scope.membership.createManagerResponsibilityOffer({
          actorMemberId: write.memberId,
          expectedManagerSetGeneration: request.expectedManagerSetGeneration,
          expectedTargetMembershipRevision: request.expectedTargetMembershipRevision,
          expiresAt: plusMilliseconds(
            offeredAt,
            COLLAB_PROJECT_MEMBERSHIP_LIMITS.managerResponsibilityOfferTtlMs,
          ),
          idempotencyKey: request.idempotencyKey,
          offerId: this.#offerIdFactory(),
          offeredAt,
          projectId: request.projectId,
          purpose: request.purpose,
          requestFingerprint: fingerprint('createManagerResponsibilityOffer', request),
          targetMemberId: request.targetMemberId,
        })
      ));
      if (result.status !== 'created' && result.status !== 'replayed') {
        return mapStatus(result.status);
      }
      if (result.response === undefined) return mapStatus('conflict');
      return collabControlOperationCodec('createManagerResponsibilityOffer')
        .decodeResponse(result.response);
    }, options);
  }

  listOffers(
    principal: RequestPrincipal,
    request: CollabProjectRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<ListCurrentManagerResponsibilityOffersResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      const offers = await write.transact(scope => (
        scope.membership.listCurrentManagerResponsibilityOffers({
          actorMemberId: write.memberId,
          actorRole: write.role,
          now: canonicalNow(this.#clock),
        })
      ));
      return collabControlOperationCodec('listCurrentManagerResponsibilityOffers')
        .decodeResponse({ offers, projectId: request.projectId });
    }, options);
  }

  getOffer(
    principal: RequestPrincipal,
    request: GetManagerResponsibilityOfferRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabManagerResponsibilityOfferResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      const offer = await write.transact(scope => (
        scope.membership.getManagerResponsibilityOffer({
          actorMemberId: write.memberId,
          actorRole: write.role,
          now: canonicalNow(this.#clock),
          offerId: request.offerId,
        })
      ));
      if (offer === undefined) {
        throw domainError('authorization-denied', 'membership-offer-unavailable');
      }
      return collabControlOperationCodec('getManagerResponsibilityOffer')
        .decodeResponse({ offer });
    }, options);
  }

  acknowledgeOffer(
    principal: RequestPrincipal,
    request: TransitionManagerResponsibilityOfferRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabManagerResponsibilityOfferResponse> {
    return this.#transition(
      'acknowledgeManagerResponsibility',
      'acknowledged',
      principal,
      request,
      options,
    );
  }

  declineOffer(
    principal: RequestPrincipal,
    request: TransitionManagerResponsibilityOfferRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabManagerResponsibilityOfferResponse> {
    return this.#transition(
      'declineManagerResponsibility',
      'declined',
      principal,
      request,
      options,
    );
  }

  cancelOffer(
    principal: RequestPrincipal,
    request: TransitionManagerResponsibilityOfferRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabManagerResponsibilityOfferResponse> {
    return this.#transition(
      'cancelManagerResponsibilityOffer',
      'cancelled',
      principal,
      request,
      options,
    );
  }

  promote(
    principal: RequestPrincipal,
    request: PromoteManagerRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<PromoteManagerResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      if (write.role !== 'manager') {
        throw domainError('authorization-denied', 'manager-required');
      }
      const promotedAt = canonicalNow(this.#clock);
      const result = await write.transact(async scope => {
        const mutation = await scope.membership.promoteManager({
          actorMemberId: write.memberId,
          expectedManagerSetGeneration: request.expectedManagerSetGeneration,
          expectedOfferRevision: request.expectedOfferRevision,
          expectedTargetMembershipRevision: request.expectedTargetMembershipRevision,
          idempotencyKey: request.idempotencyKey,
          managerResponsibilityOfferId: request.managerResponsibilityOfferId,
          projectId: request.projectId,
          promotedAt,
          requestFingerprint: fingerprint('promoteManager', request),
          targetMemberId: request.targetMemberId,
        });
        if (mutation.response === undefined) return mutation;
        if (mutation.status === 'created') {
          await scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: promotedAt,
            payload: { memberId: request.targetMemberId },
          });
        }
        return mutation;
      });
      if (result.status !== 'created' && result.status !== 'replayed') {
        return mapStatus(result.status);
      }
      if (result.response === undefined) return mapStatus('conflict');
      return collabControlOperationCodec('promoteManager').decodeResponse(result.response);
    }, options);
  }

  demote(
    principal: RequestPrincipal,
    request: DemoteManagerRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<DemoteManagerResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      if (write.role !== 'manager') {
        throw domainError('authorization-denied', 'manager-required');
      }
      const demotedAt = canonicalNow(this.#clock);
      const result = await write.transact(async scope => {
        const mutation = await scope.membership.demoteManager({
          actorMemberId: write.memberId,
          demotedAt,
          expectedManagerSetGeneration: request.expectedManagerSetGeneration,
          expectedTargetMembershipRevision: request.expectedTargetMembershipRevision,
          idempotencyKey: request.idempotencyKey,
          projectId: request.projectId,
          requestFingerprint: fingerprint('demoteManager', request),
          targetMemberId: request.targetMemberId,
        });
        if (mutation.response === undefined) return mutation;
        if (mutation.status === 'created') {
          await scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: demotedAt,
            payload: { memberId: request.targetMemberId },
          });
        }
        return mutation;
      });
      if (result.status !== 'created' && result.status !== 'replayed') {
        return mapStatus(result.status);
      }
      if (result.response === undefined) return mapStatus('conflict');
      return collabControlOperationCodec('demoteManager').decodeResponse(result.response);
    }, options);
  }

  #transition(
    operation: TransitionOperation,
    nextState: 'acknowledged' | 'cancelled' | 'declined',
    principal: RequestPrincipal,
    request: TransitionManagerResponsibilityOfferRequest,
    options: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<CollabManagerResponsibilityOfferResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      const result = await write.transact(scope => (
        scope.membership.transitionManagerResponsibilityOffer({
          actorMemberId: write.memberId,
          actorRole: write.role,
          expectedOfferRevision: request.expectedOfferRevision,
          idempotencyKey: request.idempotencyKey,
          nextState,
          offerId: request.offerId,
          operation,
          requestFingerprint: fingerprint(operation, request),
          transitionedAt: canonicalNow(this.#clock),
        })
      ));
      if (result.status !== 'created' && result.status !== 'replayed') {
        return mapStatus(result.status);
      }
      if (result.response === undefined) return mapStatus('conflict');
      return collabControlOperationCodec(operation).decodeResponse(result.response);
    }, options);
  }
}
