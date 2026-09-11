import { ProjectMembershipAdministration } from './ProjectMembershipAdministration.js';
import {
  collabControlOperationCodec,
  isCollabMemberId,
  isCollabOpaqueId,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type LeaveProjectResponse,
  type RemoveMemberResponse,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../coordination/CoordinationError.js';
import type { ProjectScope } from '../../coordination/ProjectCoordination.js';
import type {
  ApplyMemberExitInput,
  MemberExitFacts,
  ProjectMemberRemovalJournal,
} from '../../coordination/ProjectMembershipPersistence.js';
import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

type RemovalAdmissionInput = Pick<ProjectMemberRemovalJournal,
  'actorMemberId' | 'targetMemberId' | 'expectedManagerSetGeneration' | 'expectedTargetMembershipRevision'>;
type RemovalRejection = 'authorization-denied' | 'conflict' | 'final-manager' | 'permanently-stale' | 'stale';

export interface SettleLeaveMembershipInput {
  readonly expectedManagerSetGeneration: number;
  readonly expectedMembershipRevision: bigint;
  readonly expectedOfferRevision: number | null;
  readonly leftAt: CollabIsoTimestamp;
  readonly managerResponsibilityOfferId: string | null;
  readonly memberId: CollabMemberId;
  readonly operationId: string;
}

export type SettleLeaveMembershipResult = Readonly<{
  readonly response?: LeaveProjectResponse;
  readonly status: 'last-manager' | 'replayed' | 'settled' | 'stale';
}>;

export class ProjectMembershipSettlement {
  constructor(
    private readonly scope: ProjectScope,
    private readonly projectId: string,
  ) {}

  async admitRemoval(input: RemovalAdmissionInput, expectedPlacement?: Readonly<{
    readonly generation: number;
    readonly repositoryStorageKey: string;
    readonly storageNodeId: string;
  }>): Promise<Readonly<{
    readonly authorityGeneration: number;
    readonly placement: RepositoryPlacementLease;
    readonly status: 'accepted';
  }> | Readonly<{ readonly status: RemovalRejection }>> {
    const actor = await this.scope.findMembership(input.actorMemberId);
    const target = await this.scope.membership.readMemberExitFacts(input.targetMemberId);
    const project = await this.scope.getProject();
    const placement = await this.scope.getRepositoryPlacement();
    if (actor?.status !== 'active' || actor.role !== 'manager' || input.actorMemberId === input.targetMemberId
      || target === undefined || project === undefined || placement === undefined) return { status: 'authorization-denied' };
    if (target.managerSetGeneration > input.expectedManagerSetGeneration || target.revision > BigInt(input.expectedTargetMembershipRevision)) {
      return { status: 'permanently-stale' };
    }
    if (project.serviceState !== 'active' || target.status !== 'active'
      || target.revision !== BigInt(input.expectedTargetMembershipRevision)
      || target.managerSetGeneration !== input.expectedManagerSetGeneration
      || (expectedPlacement !== undefined && (placement.generation !== expectedPlacement.generation
        || placement.repositoryStorageKey !== expectedPlacement.repositoryStorageKey
        || placement.storageNodeId !== expectedPlacement.storageNodeId))) return { status: 'stale' };
    if (target.role === 'manager' && target.activeManagerCount <= 1n) return { status: 'final-manager' };
    return { authorityGeneration: project.authorityGeneration, placement, status: 'accepted' };
  }

  async prepareRemoval(input: Omit<ProjectMemberRemovalJournal, 'phase' | 'response' | 'updatedAt'>): Promise<Readonly<{
    readonly journal?: ProjectMemberRemovalJournal;
    readonly status: RemovalRejection | 'created' | 'replayed';
  }>> {
    const existing = await this.scope.membership.getRemoval(input.operationId);
    if (existing !== undefined) {
      const exact = existing.actorMemberId === input.actorMemberId
        && existing.targetMemberId === input.targetMemberId
        && existing.idempotencyKey === input.idempotencyKey
        && existing.requestFingerprint === input.requestFingerprint
        && existing.expectedTargetMembershipRevision === input.expectedTargetMembershipRevision
        && existing.expectedManagerSetGeneration === input.expectedManagerSetGeneration
        && existing.expectedPersonalRefOid === input.expectedPersonalRefOid
        && existing.personalRef === input.personalRef
        && existing.storageNodeId === input.storageNodeId
        && existing.repositoryStorageKey === input.repositoryStorageKey
        && existing.placementGeneration === input.placementGeneration;
      return exact ? { journal: existing, status: 'replayed' } : { status: 'conflict' };
    }
    const admitted = await this.admitRemoval(input, {
      generation: input.placementGeneration,
      repositoryStorageKey: input.repositoryStorageKey,
      storageNodeId: input.storageNodeId,
    });
    if (admitted.status !== 'accepted') return admitted;
    if (await this.scope.portability.getNonterminalLifecycleJournal() !== undefined) return { status: 'conflict' };
    return { journal: await this.scope.membership.insertRemoval(input, admitted.authorityGeneration), status: 'created' };
  }

  async settleRemoval(input: Readonly<{
    readonly operationId: string;
    readonly removedAt: string;
  }>): Promise<Readonly<{
    readonly response?: RemoveMemberResponse;
    readonly status: 'replayed' | 'settled' | 'stale';
  }>> {
    const journal = await this.scope.membership.getRemoval(input.operationId);
    if (journal === undefined) throw new CoordinationError('dependency-failed');
    if (journal.phase !== 'prepared') {
      if (journal.response === undefined) throw new CoordinationError('dependency-failed');
      return { response: journal.response, status: 'replayed' };
    }
    const actor = await this.scope.findMembership(journal.actorMemberId);
    const fact = await this.scope.membership.readMemberExitFacts(journal.targetMemberId);
    if (
      actor?.role !== 'manager'
      || actor.status !== 'active'
      || fact?.status !== 'active'
      || fact.revision !== BigInt(journal.expectedTargetMembershipRevision)
      || fact.managerSetGeneration !== journal.expectedManagerSetGeneration
      || (fact.role === 'manager' && fact.activeManagerCount <= 1n)
    ) return { status: 'stale' };
    const response = collabControlOperationCodec('removeMember').decodeResponse({
      discardedRequestId: fact.openRequestId,
      managerSetGeneration: fact.managerSetGeneration + (fact.role === 'manager' ? 1 : 0),
      memberId: journal.targetMemberId,
      projectId: this.projectId,
      removedAt: input.removedAt,
      status: 'revoked',
    });
    await this.scope.membership.applyMemberExit({
      advanceManagerSet: fact.role === 'manager',
      exitedAt: input.removedAt,
      expectedManagerSetGeneration: fact.managerSetGeneration,
      expectedMembershipRevision: fact.revision,
      memberId: journal.targetMemberId,
      status: 'revoked',
    });
    await this.scope.membership.recordRemovalSettlement({ operationId: journal.operationId, response });
    return { response, status: 'settled' };
  }

  async decideLeaveSuccession(
    input: Pick<SettleLeaveMembershipInput, 'memberId' | 'managerResponsibilityOfferId' | 'expectedOfferRevision' | 'expectedManagerSetGeneration' | 'leftAt'>,
    fact: Pick<MemberExitFacts, 'role' | 'activeManagerCount'>,
  ): Promise<Readonly<{
    readonly status: 'accepted' | 'last-manager' | 'stale';
    readonly successor?: ApplyMemberExitInput['successor'];
  }>> {
    if (fact.role !== 'manager' || fact.activeManagerCount > 1n) {
      return { status: input.managerResponsibilityOfferId === null && input.expectedOfferRevision === null ? 'accepted' : 'stale' };
    }
    if (fact.activeManagerCount !== 1n || input.managerResponsibilityOfferId === null || input.expectedOfferRevision === null) {
      return { status: 'last-manager' };
    }
    const offer = await new ProjectMembershipAdministration(this.scope, this.projectId).getManagerResponsibilityOffer({
      actorMemberId: input.memberId,
      actorRole: 'manager',
      now: input.leftAt,
      offerId: input.managerResponsibilityOfferId,
    });
    if (
      offer === undefined
      || offer.sourceManagerMemberId !== input.memberId
      || offer.purpose !== 'manager-leave'
      || offer.state !== 'acknowledged'
      || offer.revision !== input.expectedOfferRevision
      || offer.managerSetGenerationAtOffer !== input.expectedManagerSetGeneration
      || Date.parse(offer.expiresAt) <= Date.parse(input.leftAt)
    ) return { status: 'last-manager' };
    const successor = await this.scope.findMembership(offer.targetMemberId);
    if (successor?.status !== 'active' || successor.role !== 'member' || successor.revision !== BigInt(offer.targetMembershipRevisionAtOffer)) {
      return { status: 'last-manager' };
    }
    return { status: 'accepted', successor: {
      memberId: offer.targetMemberId,
      membershipRevision: offer.targetMembershipRevisionAtOffer,
      offerId: input.managerResponsibilityOfferId,
      offerRevision: input.expectedOfferRevision,
    } };
  }

  async settleLeaveMembership(input: SettleLeaveMembershipInput): Promise<SettleLeaveMembershipResult> {
    if (
      !isCollabOpaqueId(input.operationId)
      || !isCollabMemberId(input.memberId)
      || Number.isNaN(Date.parse(input.leftAt))
      || new Date(input.leftAt).toISOString() !== input.leftAt
      || input.expectedMembershipRevision < 1n
      || !Number.isSafeInteger(input.expectedManagerSetGeneration)
      || input.expectedManagerSetGeneration < 1
      || (input.managerResponsibilityOfferId === null
        ? input.expectedOfferRevision !== null
        : !isCollabOpaqueId(input.managerResponsibilityOfferId)
          || input.expectedOfferRevision === null
          || !Number.isSafeInteger(input.expectedOfferRevision)
          || input.expectedOfferRevision < 1)
    ) throw new CoordinationError('invalid-record');
    const journal = await this.scope.portability.getLifecycleJournal(input.operationId);
    if (journal?.kind !== 'leave' || journal.actorMemberId !== input.memberId || journal.state !== 'active'
      || (journal.phase !== 'prepared' && journal.phase !== 'membership-left')) {
      throw new CoordinationError('state-conflict');
    }
    if (journal.phase === 'membership-left') {
      const replay = await this.scope.portability.getLeaveFormerPrincipalReplay(input.operationId);
      if (replay === undefined) throw new CoordinationError('dependency-failed');
      return { response: replay.response, status: 'replayed' };
    }
    const fact = await this.scope.membership.readMemberExitFacts(input.memberId);
    if (fact === undefined) throw new CoordinationError('state-conflict');
    if (fact.managerSetGeneration !== input.expectedManagerSetGeneration || fact.status !== 'active'
      || fact.revision !== input.expectedMembershipRevision || fact.leftAt !== null) return { status: 'stale' };
    if (fact.role === 'manager' && fact.activeManagerCount < 1n) throw new CoordinationError('dependency-failed');
    const decision = await this.decideLeaveSuccession(input, fact);
    if (decision.status !== 'accepted') return { status: decision.status };
    const response = collabControlOperationCodec('leaveProject').decodeResponse({
      discardedRequestId: fact.openRequestId,
      leftAt: input.leftAt,
      managerSetGeneration: fact.managerSetGeneration + (fact.role === 'manager' ? 1 : 0),
      memberId: input.memberId,
      projectId: this.projectId,
      promotedSuccessorMemberId: decision.successor?.memberId ?? null,
      status: 'left',
    });
    await this.scope.membership.applyMemberExit({
      advanceManagerSet: fact.role === 'manager',
      exitedAt: input.leftAt,
      expectedManagerSetGeneration: fact.managerSetGeneration,
      expectedMembershipRevision: fact.revision,
      memberId: input.memberId,
      status: 'left',
      ...(decision.successor === undefined ? {} : { successor: decision.successor }),
    });
    return { response, status: 'settled' };
  }
}
