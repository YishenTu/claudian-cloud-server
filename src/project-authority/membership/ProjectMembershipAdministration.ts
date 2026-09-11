import { collabControlOperationCodec, isCollabMemberId, type CollabManagerResponsibilityOffer, type CollabManagerResponsibilityOfferResponse, type CollabMemberId, type CollabIdempotencyKey, type CollabProjectId, type CollabIsoTimestamp, type CollabManagerResponsibilityPurpose, type CollabRole, type PromoteManagerResponse, type DemoteManagerResponse, type ListProjectMembersResponse } from '@claudian-collab/protocol';
import type { ProjectScope } from '../../coordination/ProjectCoordination.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import { readMembershipOperationReplay } from './membershipOperationReplay.js';

function dependencyFailure(): never { throw new CoordinationError('dependency-failed'); }

export type MembershipAdministrationStatus =
  | 'authorization-denied'
  | 'conflict'
  | 'created'
  | 'final-manager'
  | 'permanently-stale'
  | 'replayed'
  | 'stale';

export interface ProjectMembershipAdministrationOperations {
  createManagerResponsibilityOffer(input: Readonly<{
    readonly actorMemberId: CollabMemberId;
    readonly expectedManagerSetGeneration: number;
    readonly expectedTargetMembershipRevision: number;
    readonly expiresAt: CollabIsoTimestamp;
    readonly idempotencyKey: CollabIdempotencyKey;
    readonly offerId: string;
    readonly offeredAt: CollabIsoTimestamp;
    readonly projectId: CollabProjectId;
    readonly purpose: CollabManagerResponsibilityPurpose;
    readonly requestFingerprint: string;
    readonly targetMemberId: CollabMemberId;
  }>): Promise<Readonly<{
    readonly response?: CollabManagerResponsibilityOfferResponse;
    readonly status: MembershipAdministrationStatus;
  }>>;
  demoteManager(input: Readonly<{
    readonly actorMemberId: CollabMemberId;
    readonly demotedAt: CollabIsoTimestamp;
    readonly expectedManagerSetGeneration: number;
    readonly expectedTargetMembershipRevision: number;
    readonly idempotencyKey: CollabIdempotencyKey;
    readonly projectId: CollabProjectId;
    readonly requestFingerprint: string;
    readonly targetMemberId: CollabMemberId;
  }>): Promise<Readonly<{
    readonly response?: DemoteManagerResponse;
    readonly status: MembershipAdministrationStatus;
  }>>;
  getManagerResponsibilityOffer(input: Readonly<{
    readonly actorMemberId: CollabMemberId;
    readonly actorRole: CollabRole;
    readonly now: CollabIsoTimestamp;
    readonly offerId: string;
  }>): Promise<CollabManagerResponsibilityOffer | undefined>;
  listCurrentManagerResponsibilityOffers(input: Readonly<{
    readonly actorMemberId: CollabMemberId;
    readonly actorRole: CollabRole;
    readonly now: CollabIsoTimestamp;
  }>): Promise<readonly CollabManagerResponsibilityOffer[]>;
  listProjectMembers(input: Readonly<{
    readonly actorRole: CollabRole;
    readonly now: CollabIsoTimestamp;
  }>): Promise<ListProjectMembersResponse>;
  promoteManager(input: Readonly<{
    readonly actorMemberId: CollabMemberId;
    readonly expectedManagerSetGeneration: number;
    readonly expectedOfferRevision: number;
    readonly expectedTargetMembershipRevision: number;
    readonly idempotencyKey: CollabIdempotencyKey;
    readonly managerResponsibilityOfferId: string;
    readonly projectId: CollabProjectId;
    readonly promotedAt: CollabIsoTimestamp;
    readonly requestFingerprint: string;
    readonly targetMemberId: CollabMemberId;
  }>): Promise<Readonly<{
    readonly response?: PromoteManagerResponse;
    readonly status: MembershipAdministrationStatus;
  }>>;
  transitionManagerResponsibilityOffer(input: Readonly<{
    readonly actorMemberId: CollabMemberId;
    readonly actorRole: CollabRole;
    readonly expectedOfferRevision: number;
    readonly idempotencyKey: CollabIdempotencyKey;
    readonly nextState: 'acknowledged' | 'cancelled' | 'declined';
    readonly offerId: string;
    readonly operation:
      | 'acknowledgeManagerResponsibility'
      | 'cancelManagerResponsibilityOffer'
      | 'declineManagerResponsibility';
    readonly requestFingerprint: string;
    readonly transitionedAt: CollabIsoTimestamp;
  }>): Promise<Readonly<{
    readonly response?: CollabManagerResponsibilityOfferResponse;
    readonly status: MembershipAdministrationStatus;
  }>>;
}

export class ProjectMembershipAdministration implements ProjectMembershipAdministrationOperations {
  constructor(private readonly scope: ProjectScope, private readonly projectId: string) {}
  async createManagerResponsibilityOffer(input: Readonly<{
    readonly actorMemberId: string;
    readonly expectedManagerSetGeneration: number;
    readonly expectedTargetMembershipRevision: number;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
    readonly offerId: string;
    readonly offeredAt: string;
    readonly projectId: string;
    readonly purpose: 'manager-promotion' | 'manager-leave';
    readonly requestFingerprint: string;
    readonly targetMemberId: string;
  }>): ReturnType<ProjectMembershipAdministrationOperations['createManagerResponsibilityOffer']> {
    const replay = await this.#administrationReplay<
      CollabManagerResponsibilityOfferResponse
    >(
      input.actorMemberId,
      'createManagerResponsibilityOffer',
      input.idempotencyKey,
      input.requestFingerprint,
      value => collabControlOperationCodec(
        'createManagerResponsibilityOffer',
      ).decodeResponse(value),
    );
    if (replay !== undefined) return replay;
    await this.scope.membership.expireResponsibilityOffers(input.offeredAt);
    const fact = await this.#managerFacts(input.actorMemberId, input.targetMemberId);
    if (fact?.sourceIsManager !== true) {
      return { status: 'authorization-denied' as const };
    }
    if (
      fact.managerSetGeneration > input.expectedManagerSetGeneration
      || Number(fact.revision) > input.expectedTargetMembershipRevision
    ) return { status: 'permanently-stale' as const };
    if (
      fact.managerSetGeneration !== input.expectedManagerSetGeneration
      || Number(fact.revision) !== input.expectedTargetMembershipRevision
      || fact.status !== 'active'
      || fact.role !== 'member'
      || input.actorMemberId === input.targetMemberId
    ) return { status: 'stale' as const };
    if (await this.scope.membership.findConflictingResponsibilityOffer(input) !== undefined) return { status: 'stale' as const };
    const insertedOffer = await this.scope.membership.insertResponsibilityOffer(input);
    const response = collabControlOperationCodec(
      'createManagerResponsibilityOffer',
    ).decodeResponse({ offer: insertedOffer });
    await this.scope.membership.storeMembershipResult(
      input.actorMemberId,
      'createManagerResponsibilityOffer',
      input.idempotencyKey,
      input.requestFingerprint,
      response,
      input.offeredAt,
    );
    return {
      response,
      status: 'created' as const,
    };
  }

  async promoteManager(input: Readonly<{
    readonly actorMemberId: string;
    readonly expectedManagerSetGeneration: number;
    readonly expectedOfferRevision: number;
    readonly expectedTargetMembershipRevision: number;
    readonly idempotencyKey: string;
    readonly managerResponsibilityOfferId: string;
    readonly projectId: string;
    readonly promotedAt: string;
    readonly requestFingerprint: string;
    readonly targetMemberId: string;
  }>): ReturnType<ProjectMembershipAdministrationOperations['promoteManager']> {
    const replay = await this.#administrationReplay<PromoteManagerResponse>(
      input.actorMemberId,
      'promoteManager',
      input.idempotencyKey,
      input.requestFingerprint,
      value => collabControlOperationCodec('promoteManager').decodeResponse(value),
    );
    if (replay !== undefined) return replay;
    await this.scope.membership.expireResponsibilityOffers(input.promotedAt);
    const fact = await this.#managerFacts(input.actorMemberId, input.targetMemberId);
    if (fact?.sourceIsManager !== true) {
      return { status: 'authorization-denied' as const };
    }
    if (
      fact.managerSetGeneration > input.expectedManagerSetGeneration
      || Number(fact.revision) > input.expectedTargetMembershipRevision
    ) return { status: 'permanently-stale' as const };
    if (
      fact.managerSetGeneration !== input.expectedManagerSetGeneration
      || Number(fact.revision) !== input.expectedTargetMembershipRevision
      || fact.status !== 'active'
      || fact.role !== 'member'
    ) return { status: 'stale' as const };
    const offer = await this.scope.membership.readResponsibilityOffer(input.managerResponsibilityOfferId);
    if (offer !== undefined && offer.revision > input.expectedOfferRevision) {
      return { status: 'permanently-stale' as const };
    }
    if (
      offer === undefined
      || offer.sourceManagerMemberId !== input.actorMemberId
      || offer.targetMemberId !== input.targetMemberId
      || offer.purpose !== 'manager-promotion'
      || offer.state !== 'acknowledged'
      || offer.revision !== input.expectedOfferRevision
      || offer.managerSetGenerationAtOffer
        !== input.expectedManagerSetGeneration
      || offer.targetMembershipRevisionAtOffer
        !== input.expectedTargetMembershipRevision
    ) return { status: 'stale' as const };
    await this.scope.membership.applyManagerRoleChange({
      changedAt: input.promotedAt,
      expectedManagerSetGeneration: input.expectedManagerSetGeneration,
      expectedMembershipRevision: input.expectedTargetMembershipRevision,
      memberId: input.targetMemberId,
      role: 'manager',
      consumeOffer: { offerId: input.managerResponsibilityOfferId, revision: input.expectedOfferRevision },
    });
    const response = collabControlOperationCodec('promoteManager').decodeResponse({
      managerSetGeneration: input.expectedManagerSetGeneration + 1,
      membershipRevision: input.expectedTargetMembershipRevision + 1,
      offerRevision: input.expectedOfferRevision + 1,
      projectId: this.projectId,
      promotedMemberId: input.targetMemberId,
    });
    await this.scope.membership.storeMembershipResult(
      input.actorMemberId,
      'promoteManager',
      input.idempotencyKey,
      input.requestFingerprint,
      response,
      input.promotedAt,
    );
    return { response, status: 'created' as const };
  }

  async demoteManager(input: Readonly<{
    readonly actorMemberId: string;
    readonly demotedAt: string;
    readonly expectedManagerSetGeneration: number;
    readonly expectedTargetMembershipRevision: number;
    readonly idempotencyKey: string;
    readonly projectId: string;
    readonly requestFingerprint: string;
    readonly targetMemberId: string;
  }>): ReturnType<ProjectMembershipAdministrationOperations['demoteManager']> {
    const replay = await this.#administrationReplay<DemoteManagerResponse>(
      input.actorMemberId,
      'demoteManager',
      input.idempotencyKey,
      input.requestFingerprint,
      value => collabControlOperationCodec('demoteManager').decodeResponse(value),
    );
    if (replay !== undefined) return replay;
    const fact = await this.#managerFacts(input.actorMemberId, input.targetMemberId);
    if (fact?.sourceIsManager !== true || input.actorMemberId === input.targetMemberId) {
      return { status: 'authorization-denied' as const };
    }
    if (
      fact.managerSetGeneration > input.expectedManagerSetGeneration
      || Number(fact.revision) > input.expectedTargetMembershipRevision
    ) return { status: 'permanently-stale' as const };
    if (await this.scope.membership.countActiveManagers() <= 1n) return { status: 'final-manager' as const };
    if (
      fact.managerSetGeneration !== input.expectedManagerSetGeneration
      || Number(fact.revision) !== input.expectedTargetMembershipRevision
      || fact.status !== 'active'
      || fact.role !== 'manager'
    ) return { status: 'stale' as const };
    await this.scope.membership.applyManagerRoleChange({
      changedAt: input.demotedAt,
      expectedManagerSetGeneration: input.expectedManagerSetGeneration,
      expectedMembershipRevision: input.expectedTargetMembershipRevision,
      memberId: input.targetMemberId,
      role: 'member',
    });
    const response = collabControlOperationCodec('demoteManager').decodeResponse({
      demotedMemberId: input.targetMemberId,
      managerSetGeneration: input.expectedManagerSetGeneration + 1,
      membershipRevision: input.expectedTargetMembershipRevision + 1,
      projectId: this.projectId,
    });
    await this.scope.membership.storeMembershipResult(
      input.actorMemberId,
      'demoteManager',
      input.idempotencyKey,
      input.requestFingerprint,
      response,
      input.demotedAt,
    );
    return { response, status: 'created' as const };
  }

  async transitionManagerResponsibilityOffer(input: Readonly<{
    readonly actorMemberId: string;
    readonly actorRole: 'manager' | 'member';
    readonly expectedOfferRevision: number;
    readonly idempotencyKey: string;
    readonly nextState: 'acknowledged' | 'cancelled' | 'declined';
    readonly offerId: string;
    readonly operation:
      | 'acknowledgeManagerResponsibility'
      | 'cancelManagerResponsibilityOffer'
      | 'declineManagerResponsibility';
    readonly requestFingerprint: string;
    readonly transitionedAt: string;
  }>): ReturnType<ProjectMembershipAdministrationOperations['transitionManagerResponsibilityOffer']> {
    const replay = await this.#administrationReplay<
      CollabManagerResponsibilityOfferResponse
    >(
      input.actorMemberId,
      input.operation,
      input.idempotencyKey,
      input.requestFingerprint,
      value => collabControlOperationCodec(input.operation).decodeResponse(value),
    );
    if (replay !== undefined) return replay;
    await this.scope.membership.expireResponsibilityOffers(input.transitionedAt);
    const offer = await this.scope.membership.readResponsibilityOffer(input.offerId);
    if (offer === undefined) return { status: 'stale' as const };
    const canTransition = input.nextState === 'cancelled'
      ? input.actorRole === 'manager'
        && offer.sourceManagerMemberId === input.actorMemberId
      : offer.targetMemberId === input.actorMemberId;
    if (!canTransition) return { status: 'authorization-denied' as const };
    if (offer.revision > input.expectedOfferRevision) {
      return { status: 'permanently-stale' as const };
    }
    if (
      offer.revision !== input.expectedOfferRevision
      || (input.nextState === 'cancelled'
        ? !['offered', 'acknowledged'].includes(offer.state)
        : offer.state !== 'offered')
    ) return { status: 'stale' as const };
    const transitionedOffer = await this.scope.membership.transitionResponsibilityOffer(input);
    const response = collabControlOperationCodec(input.operation).decodeResponse({
      offer: transitionedOffer,
    });
    await this.scope.membership.storeMembershipResult(
      input.actorMemberId,
      input.operation,
      input.idempotencyKey,
      input.requestFingerprint,
      response,
      input.transitionedAt,
    );
    return { response, status: 'created' as const };
  }

  async listProjectMembers(input: Readonly<{
    readonly actorRole: 'manager' | 'member';
    readonly now: string;
  }>): Promise<ListProjectMembersResponse> {
    await this.scope.membership.expireClaimOverrides(input.now);
    const project = await this.scope.getProject();
    const managerSetGeneration = project?.managerSetGeneration;
    if (managerSetGeneration === undefined || !Number.isSafeInteger(managerSetGeneration) || managerSetGeneration < 1) return dependencyFailure();
    const rows = await this.scope.membership.readMemberAdministrationFacts();
    const members = rows.map(row => {
      const membershipRevision = row.revision;
      if (
        !isCollabMemberId(row.memberId)
        || !Number.isSafeInteger(membershipRevision)
        || membershipRevision < 1
        || (row.role !== 'manager' && row.role !== 'member')
        || (row.bindingState !== 'bound' && row.bindingState !== 'unbound')
      ) return dependencyFailure();
      let importedClaimState: ListProjectMembersResponse['members'][number]['importedClaimState'];
      if (input.actorRole !== 'manager') {
        importedClaimState = 'hidden';
      } else if (row.overrideState === 'active') {
        importedClaimState = 'override-active';
      } else if (row.overrideState === 'redeemed') {
        importedClaimState = 'redeemed';
      } else if (row.overrideState === 'revoked') {
        importedClaimState = 'revoked';
      } else if (row.overrideState === 'expired') {
        importedClaimState = 'expired';
      } else if (row.overrideState === 'superseded') {
        return dependencyFailure();
      } else if (row.claimState === null) {
        importedClaimState = 'not-applicable';
      } else if (row.claimState === 'redeemed') {
        importedClaimState = 'redeemed';
      } else if (row.claimState === 'revoked') {
        importedClaimState = 'revoked';
      } else if (row.claimState === 'unclaimed' && row.claimExpiresAt !== null) {
        importedClaimState = Date.parse(row.claimExpiresAt) <= Date.parse(input.now)
          ? 'expired'
          : 'original-active';
      } else {
        return dependencyFailure();
      }
      return Object.freeze({
        bindingState: input.actorRole === 'manager'
          ? row.bindingState
          : 'hidden' as const,
        displayName: row.displayName,
        importedClaimGeneration: importedClaimState === 'hidden'
          || importedClaimState === 'not-applicable'
          ? null
          : row.overrideClaimGeneration ?? 0,
        importedClaimState,
        memberId: row.memberId,
        membershipRevision,
        role: row.role,
      });
    });
    return collabControlOperationCodec('listProjectMembers').decodeResponse({
      managerSetGeneration,
      members,
      projectId: this.projectId,
    });
  }

  async listCurrentManagerResponsibilityOffers(input: Parameters<ProjectMembershipAdministrationOperations['listCurrentManagerResponsibilityOffers']>[0]) {
    await this.scope.membership.expireResponsibilityOffers(input.now);
    const offers = await this.scope.membership.readCurrentResponsibilityOffers();
    return offers.filter(offer => input.actorRole === 'manager' || offer.targetMemberId === input.actorMemberId);
  }

  async getManagerResponsibilityOffer(input: Parameters<ProjectMembershipAdministrationOperations['getManagerResponsibilityOffer']>[0]) {
    await this.scope.membership.expireResponsibilityOffers(input.now);
    const offer = await this.scope.membership.readResponsibilityOffer(input.offerId);
    return input.actorRole === 'manager' || offer?.targetMemberId === input.actorMemberId ? offer : undefined;
  }

  async #managerFacts(actorMemberId: string, targetMemberId: string) {
    const project = await this.scope.getProject();
    const target = await this.scope.findMembership(targetMemberId);
    if (project === undefined || target === undefined) return undefined;
    const actor = await this.scope.findMembership(actorMemberId);
    return {
      managerSetGeneration: project.managerSetGeneration,
      revision: target.revision,
      role: target.role,
      sourceIsManager: actor?.status === 'active' && actor.role === 'manager',
      status: target.status,
    };
  }

  #administrationReplay<Response>(actorMemberId: string, operation: string, idempotencyKey: string, requestFingerprint: string, decode: (value: unknown) => Response) {
    return readMembershipOperationReplay(this.scope.membership, actorMemberId, operation, idempotencyKey, requestFingerprint, decode);
  }
}
