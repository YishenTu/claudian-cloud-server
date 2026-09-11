import { collabControlOperationCodec, type CollabIsoTimestamp, type CollabIdempotencyKey, type CollabMemberId, type CollabProjectId, type RevokeTransferredMembershipClaimResponse } from '@claudian-collab/protocol';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import type { ProjectScope } from '../../coordination/ProjectCoordination.js';
import type { ImportedMembershipClaimFacts, EffectiveTransferredMembershipClaim, ProtectedClaimOverrideEnvelope, TransferredMembershipClaimOverrideRecord } from '../../coordination/ProjectMembershipPersistence.js';
import { readMembershipOperationReplay } from './membershipOperationReplay.js';
function dependencyFailure(): never { throw new CoordinationError('dependency-failed'); }

export interface ProjectTransferredMembershipClaimOperations {
  getImportedMembershipClaimFacts(
    memberId: CollabMemberId,
    now: CollabIsoTimestamp,
  ): Promise<ImportedMembershipClaimFacts | undefined>;
  reissueTransferredMembershipClaim(input: Readonly<{
    readonly actorMemberId: CollabMemberId;
    readonly claimGeneration: number;
    readonly claimSha256: string;
    readonly createdAt: CollabIsoTimestamp;
    readonly envelope: ProtectedClaimOverrideEnvelope;
    readonly expectedClaimGeneration: number;
    readonly expectedManagerSetGeneration: number;
    readonly expectedMembershipRevision: number;
    readonly expiresAt: CollabIsoTimestamp;
    readonly idempotencyKey: CollabIdempotencyKey;
    readonly memberId: CollabMemberId;
    readonly projectId: CollabProjectId;
    readonly requestFingerprint: string;
    readonly secretReplayExpiresAt: CollabIsoTimestamp;
    readonly transferId: string;
  }>): Promise<Readonly<{
    readonly record?: TransferredMembershipClaimOverrideRecord;
    readonly status:
      | 'authorization-denied'
      | 'conflict'
      | 'created'
      | 'permanently-stale'
      | 'replayed'
      | 'replay-expired'
      | 'stale';
  }>>;
  resolveEffectiveTransferredMembershipClaim(
    transferId: string,
    claimSha256: string,
    now: CollabIsoTimestamp,
  ): Promise<EffectiveTransferredMembershipClaim | undefined>;
  revokeTransferredMembershipClaim(input: Readonly<{
    readonly actorMemberId: CollabMemberId;
    readonly expectedClaimGeneration: number;
    readonly expectedManagerSetGeneration: number;
    readonly expectedMembershipRevision: number;
    readonly idempotencyKey: CollabIdempotencyKey;
    readonly memberId: CollabMemberId;
    readonly projectId: CollabProjectId;
    readonly requestFingerprint: string;
    readonly revokedAt: CollabIsoTimestamp;
  }>): Promise<Readonly<{
    readonly response?: RevokeTransferredMembershipClaimResponse;
    readonly status:
      | 'authorization-denied'
      | 'conflict'
      | 'created'
      | 'permanently-stale'
      | 'replayed'
      | 'stale';
  }>>;
}

export class ProjectTransferredMembershipClaims {
  constructor(private readonly scope: ProjectScope, private readonly projectId: string) {}

  async getImportedMembershipClaimFacts(memberId: string, now: string): Promise<ImportedMembershipClaimFacts | undefined> {
    await this.scope.membership.expireClaimOverrides(now);
    const facts = await this.#importedClaimFacts(memberId, now);
    return facts === undefined ? undefined : Object.freeze({ claimGeneration: facts.claimGeneration, claimSha256: facts.claimSha256, memberId, transferId: facts.transferId });
  }

  async reissueTransferredMembershipClaim(input: Parameters<ProjectTransferredMembershipClaimOperations['reissueTransferredMembershipClaim']>[0]): ReturnType<ProjectTransferredMembershipClaimOperations['reissueTransferredMembershipClaim']> {
    await this.scope.membership.expireClaimOverrides(input.createdAt);
    await this.scope.membership.scrubClaimOverrideEnvelopes(input.createdAt);
    const tombstone = await this.scope.membership.findSecretReplayTombstone(input.actorMemberId, 'reissueTransferredMembershipClaim', input.idempotencyKey);
    if (tombstone !== undefined) {
      return {
        status: tombstone === input.requestFingerprint
          ? 'replay-expired' as const
          : 'conflict' as const,
      };
    }
    const existing = await this.scope.membership.readClaimOverrideIssuance(input.actorMemberId, input.idempotencyKey);
    if (existing !== undefined) {
      const record = existing;
      if (record.requestFingerprint !== input.requestFingerprint) {
        return { status: 'conflict' as const };
      }
      return record.envelope === undefined
        ? { status: 'replay-expired' as const }
        : { record, status: 'replayed' as const };
    }
    const authorized = await this.#mutationFacts(input.actorMemberId, input.memberId);
    if (authorized?.sourceIsManager !== true) {
      return { status: 'authorization-denied' as const };
    }
    if (
      authorized.managerSetGeneration > input.expectedManagerSetGeneration
      || Number(authorized.revision) > input.expectedMembershipRevision
    ) return { status: 'permanently-stale' as const };
    if (
      authorized.managerSetGeneration !== input.expectedManagerSetGeneration
      || Number(authorized.revision) !== input.expectedMembershipRevision
      || authorized.status !== 'active'
      || !authorized.unbound
    ) return { status: 'stale' as const };
    const current = await this.#importedClaimFacts(input.memberId, input.createdAt);
    if (
      current === undefined
      || current.transferId !== input.transferId
      || current.claimGeneration !== input.expectedClaimGeneration
      || input.claimGeneration !== input.expectedClaimGeneration + 1
    ) return { status: 'stale' as const };
    const record = await this.scope.membership.insertClaimOverride({
      claimGeneration: input.claimGeneration, claimSha256: input.claimSha256, createdAt: input.createdAt, envelope: input.envelope,
      expectedClaimGeneration: input.expectedClaimGeneration, expiresAt: input.expiresAt, idempotencyKey: input.idempotencyKey,
      managerMemberId: input.actorMemberId, memberId: input.memberId, requestFingerprint: input.requestFingerprint,
      secretReplayExpiresAt: input.secretReplayExpiresAt, supersededClaimSha256: current.claimSha256, transferId: input.transferId,
    });
    return { record, status: 'created' as const };
  }

  async revokeTransferredMembershipClaim(input: Parameters<ProjectTransferredMembershipClaimOperations['revokeTransferredMembershipClaim']>[0]): ReturnType<ProjectTransferredMembershipClaimOperations['revokeTransferredMembershipClaim']> {
    const replay = await readMembershipOperationReplay<
      RevokeTransferredMembershipClaimResponse
    >(
      this.scope.membership,
      input.actorMemberId,
      'revokeTransferredMembershipClaim',
      input.idempotencyKey,
      input.requestFingerprint,
      value => collabControlOperationCodec('revokeTransferredMembershipClaim')
        .decodeResponse(value),
    );
    if (replay !== undefined) return replay;
    await this.scope.membership.expireClaimOverrides(input.revokedAt);
    const authorized = await this.#mutationFacts(input.actorMemberId, input.memberId);
    if (authorized?.sourceIsManager !== true) {
      return { status: 'authorization-denied' as const };
    }
    if (
      authorized.managerSetGeneration > input.expectedManagerSetGeneration
      || Number(authorized.revision) > input.expectedMembershipRevision
    ) return { status: 'permanently-stale' as const };
    if (
      authorized.managerSetGeneration !== input.expectedManagerSetGeneration
      || Number(authorized.revision) !== input.expectedMembershipRevision
      || authorized.status !== 'active'
      || !authorized.unbound
    ) return { status: 'stale' as const };
    const current = await this.#importedClaimFacts(input.memberId, input.revokedAt);
    if (
      current === undefined
      || current.claimGeneration !== input.expectedClaimGeneration
      || current.state !== 'active'
    ) return { status: 'stale' as const };
    await this.scope.membership.revokeClaimRow({ ...current, memberId: input.memberId, revokedAt: input.revokedAt });
    const response = collabControlOperationCodec('revokeTransferredMembershipClaim')
      .decodeResponse({
        claimGeneration: current.claimGeneration,
        memberId: input.memberId,
        projectId: this.projectId,
        revokedAt: input.revokedAt,
        state: 'revoked',
      });
    await this.scope.membership.storeMembershipResult(
      input.actorMemberId,
      'revokeTransferredMembershipClaim',
      input.idempotencyKey,
      input.requestFingerprint,
      response,
      input.revokedAt,
    );
    return { response, status: 'created' as const };
  }

  async resolveEffectiveTransferredMembershipClaim(transferId: string, claimSha256: string, now: string): Promise<EffectiveTransferredMembershipClaim | undefined> {
    const persistence = this.scope.membership;
    await persistence.expireClaimOverrides(now);
    const claim = await persistence.readTransferredClaimByDigest(transferId, claimSha256);
    if (claim === undefined) return undefined;
    const highest = await persistence.readHighestClaimOverride(transferId, claim.memberId);
    if (claim.kind === 'override') {
      if (highest?.claimGeneration !== claim.claimGeneration || (claim.state !== 'active' && claim.state !== 'redeemed')) return undefined;
      return Object.freeze({ ...claim, state: claim.state });
    }
    if (highest !== undefined || (claim.state !== 'unclaimed' && claim.state !== 'redeemed')
      || (claim.state === 'unclaimed' && Date.parse(claim.expiresAt) <= Date.parse(now))) return undefined;
    return Object.freeze({ ...claim, state: claim.state === 'unclaimed' ? 'active' : 'redeemed' });
  }

  async #mutationFacts(actorMemberId: string, memberId: string) {
    const project = await this.scope.getProject();
    const target = await this.scope.findMembership(memberId);
    if (project === undefined || target === undefined) return undefined;
    const actor = await this.scope.findMembership(actorMemberId);
    return { managerSetGeneration: project.managerSetGeneration, revision: target.revision, status: target.status,
      sourceIsManager: actor?.status === 'active' && actor.role === 'manager', unbound: !await this.scope.membership.hasLiveMemberBinding(memberId) };
  }

  async #importedClaimFacts(memberId: string, now: string) {
    const target = await this.scope.findMembership(memberId);
    if (target?.status !== 'active' || await this.scope.membership.hasLiveMemberBinding(memberId)) return undefined;
    const original = await this.scope.membership.readCurrentTransferClaim(memberId);
    if (original === undefined) return undefined;
    const override = await this.scope.membership.readHighestClaimOverride(original.transferId, memberId);
    if (override !== undefined) return { claimGeneration: override.claimGeneration, claimSha256: override.claimSha256, state: override.state, transferId: override.transferId };
    if (!/^[a-f0-9]{64}$/u.test(original.claimSha256)) return dependencyFailure();
    if (original.state !== 'unclaimed' && original.state !== 'redeemed' && original.state !== 'revoked') return dependencyFailure();
    const state = original.state === 'unclaimed' ? (Date.parse(original.expiresAt) <= Date.parse(now) ? 'expired' : 'active') : original.state;
    return { claimGeneration: 0, claimSha256: original.claimSha256, state, transferId: original.transferId };
  }
}
