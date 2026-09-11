import type {
  CollabGitOid,
  CollabIdempotencyKey,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabProjectId,
  CollabProjectInvitationState,
  CollabManagerResponsibilityOffer,
  CollabManagerResponsibilityPurpose,
  RemoveMemberResponse,
  CollabTransferredMembershipRedemptionReceipt,
  JoinCloudProjectResponse,
} from '@claudian-collab/protocol';

import type { ProtectedSecretCustodyEnvelope } from '../project-authority/lifecycle/ProtectedSecretCustody.js';

export interface ProtectedInvitationEnvelope
  extends ProtectedSecretCustodyEnvelope {
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly invitationId: string;
  readonly projectId: CollabProjectId;
}

export interface ProjectInvitationRecord {
  readonly createdAt: CollabIsoTimestamp;
  readonly envelope: ProtectedInvitationEnvelope | undefined;
  readonly expiresAt: CollabIsoTimestamp;
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly invitationId: string;
  readonly issuedByMemberId: CollabMemberId;
  readonly projectId: CollabProjectId;
  readonly requestFingerprint: string;
  readonly revision: number;
  readonly secretReplayExpiresAt: CollabIsoTimestamp;
  readonly secretSha256: string;
  readonly state: CollabProjectInvitationState;
  readonly terminalAt: CollabIsoTimestamp | null;
}

export interface InsertProjectInvitationInput extends Omit<ProjectInvitationRecord, 'revision' | 'state'> {
  readonly envelope: ProtectedInvitationEnvelope;
}
export interface RevokeInvitationRowInput {
  readonly invitationId: string;
  readonly expectedInvitationRevision: number;
  readonly revokedAt: CollabIsoTimestamp;
}

export type ProjectJoinPhase =
  | 'prepared'
  | 'membership-pending'
  | 'personal-ref-created'
  | 'membership-active'
  | 'completed';

export interface ProjectJoinJournal {
  readonly displayName: string;
  readonly expectedMainOid: CollabGitOid;
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly invitationId: string;
  readonly invitationRevision: number;
  readonly managerSetGeneration: number;
  readonly memberId: CollabMemberId;
  readonly operationId: string;
  readonly personalRef: string;
  readonly phase: ProjectJoinPhase;
  readonly placementGeneration: number;
  readonly preparedAt: CollabIsoTimestamp;
  readonly principalId: string;
  readonly principalSha256: string;
  readonly projectId: CollabProjectId;
  readonly repositoryStorageKey: string;
  readonly requestFingerprint: string;
  readonly response: JoinCloudProjectResponse | undefined;
  readonly secretSha256: string;
  readonly storageNodeId: string;
  readonly updatedAt: CollabIsoTimestamp;
}

export type PrepareProjectJoinInput = Omit<
  ProjectJoinJournal,
  'phase' | 'response' | 'updatedAt'
>;

export interface ProjectJoinPersistence {
  activateJoin(input: Readonly<{
    readonly joinedAt: CollabIsoTimestamp;
    readonly operationId: string;
    readonly response: JoinCloudProjectResponse;
  }>): Promise<'activated' | 'replayed'>;
  advanceJoin(input: Readonly<{
    readonly expectedPhase: Extract<
      ProjectJoinPhase,
      'prepared' | 'membership-pending'
    >;
    readonly nextPhase: Extract<
      ProjectJoinPhase,
      'membership-pending' | 'personal-ref-created'
    >;
    readonly operationId: string;
    readonly updatedAt: CollabIsoTimestamp;
  }>): Promise<'advanced' | 'replayed'>;
  completeJoin(input: Readonly<{
    readonly completedAt: CollabIsoTimestamp;
    readonly operationId: string;
  }>): Promise<JoinCloudProjectResponse>;
  findInvitationForJoin(
    invitationId: string,
    now: CollabIsoTimestamp,
  ): Promise<ProjectInvitationRecord | undefined>;
  findJoinByPrincipal(
    principalId: string,
    idempotencyKey: CollabIdempotencyKey,
  ): Promise<ProjectJoinJournal | undefined>;
  findJoinByPrincipalOperation(
    operationId: string,
  ): Promise<ProjectJoinJournal | undefined>;
  getNonterminalJoin(): Promise<ProjectJoinJournal | undefined>;
  readPrincipalBindingState(principalId: string): Promise<string | undefined>;
  insertJoin(input: PrepareProjectJoinInput): Promise<ProjectJoinJournal>;
}

export interface ProjectInvitationPersistence {
  expireInvitations(now: CollabIsoTimestamp): Promise<void>;
  findSecretReplayTombstone(actorMemberId: CollabMemberId, operation: string, idempotencyKey: CollabIdempotencyKey): Promise<string | undefined>;
  insertInvitation(input: InsertProjectInvitationInput): Promise<ProjectInvitationRecord>;
  readInvitationIssuance(actorMemberId: CollabMemberId, idempotencyKey: CollabIdempotencyKey): Promise<ProjectInvitationRecord | undefined>;
  readInvitationRecord(invitationId: string): Promise<ProjectInvitationRecord | undefined>;
  readInvitations(): Promise<readonly ProjectInvitationRecord[]>;
  readMembershipReservationCount(): Promise<bigint>;
  revokeInvitationRow(input: RevokeInvitationRowInput): Promise<ProjectInvitationRecord>;
}

export interface ProjectMembershipExpiryPersistence {
  reconcileExpirations(now: CollabIsoTimestamp): Promise<void>;
}

export interface ProjectCloudMembershipRelinquishmentPersistence {
  relinquishCloudMembershipAuthorities(input: Readonly<{
    readonly relinquishedAt: CollabIsoTimestamp;
    readonly retainedOutgoingTransferId: string;
  }>): Promise<'advanced' | 'replayed'>;
}

export interface InsertResponsibilityOfferInput {
  readonly actorMemberId: CollabMemberId;
  readonly targetMemberId: CollabMemberId;
  readonly expectedManagerSetGeneration: number;
  readonly expectedTargetMembershipRevision: number;
  readonly expiresAt: CollabIsoTimestamp;
  readonly offeredAt: CollabIsoTimestamp;
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly offerId: string;
  readonly purpose: CollabManagerResponsibilityPurpose;
  readonly requestFingerprint: string;
}
export interface TransitionResponsibilityOfferInput {
  readonly expectedOfferRevision: number;
  readonly nextState: 'acknowledged' | 'cancelled' | 'declined';
  readonly offerId: string;
  readonly transitionedAt: CollabIsoTimestamp;
}
export interface ManagerRoleChangeInput {
  readonly changedAt: CollabIsoTimestamp;
  readonly consumeOffer?: Readonly<{ readonly offerId: string; readonly revision: number }>;
  readonly expectedManagerSetGeneration: number;
  readonly expectedMembershipRevision: number;
  readonly memberId: CollabMemberId;
  readonly role: 'manager' | 'member';
}
export interface MemberAdministrationFacts {
  readonly bindingState: string;
  readonly claimExpiresAt: CollabIsoTimestamp | null;
  readonly claimState: string | null;
  readonly displayName: string;
  readonly memberId: CollabMemberId;
  readonly overrideClaimGeneration: number | null;
  readonly overrideState: string | null;
  readonly revision: number;
  readonly role: string;
}
export interface ProjectMembershipAdministrationPersistence {
  countActiveManagers(): Promise<bigint>;
  applyManagerRoleChange(input: ManagerRoleChangeInput): Promise<void>;
  expireClaimOverrides(now: CollabIsoTimestamp): Promise<void>;
  expireResponsibilityOffers(now: CollabIsoTimestamp): Promise<void>;
  findConflictingResponsibilityOffer(input: Readonly<{ readonly actorMemberId: CollabMemberId; readonly targetMemberId: CollabMemberId }>): Promise<string | undefined>;
  insertResponsibilityOffer(input: InsertResponsibilityOfferInput): Promise<CollabManagerResponsibilityOffer>;
  readCurrentResponsibilityOffers(): Promise<readonly CollabManagerResponsibilityOffer[]>;
  readMemberAdministrationFacts(): Promise<readonly MemberAdministrationFacts[]>;
  readResponsibilityOffer(offerId: string): Promise<CollabManagerResponsibilityOffer | undefined>;
  transitionResponsibilityOffer(input: TransitionResponsibilityOfferInput): Promise<CollabManagerResponsibilityOffer>;
}
export interface ProjectMembershipResultPersistence {
  findMembershipResult(actorMemberId: CollabMemberId, operation: string, idempotencyKey: CollabIdempotencyKey): Promise<Readonly<{ readonly requestFingerprint: string; readonly response: unknown }> | undefined>;
  hasMembershipResultTombstone(actorMemberId: CollabMemberId, operation: string, idempotencyKey: CollabIdempotencyKey): Promise<boolean>;
  storeMembershipResult(actorMemberId: CollabMemberId, operation: string, idempotencyKey: CollabIdempotencyKey, requestFingerprint: string, response: object, createdAt: CollabIsoTimestamp): Promise<void>;
}

export interface ProtectedClaimOverrideEnvelope
  extends ProtectedSecretCustodyEnvelope {
  readonly claimGeneration: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly memberId: CollabMemberId;
  readonly projectId: CollabProjectId;
  readonly transferId: string;
}

export interface TransferredMembershipClaimOverrideRecord {
  readonly claimGeneration: number;
  readonly claimSha256: string;
  readonly createdAt: CollabIsoTimestamp;
  readonly envelope: ProtectedClaimOverrideEnvelope | undefined;
  readonly expiresAt: CollabIsoTimestamp;
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly managerMemberId: CollabMemberId;
  readonly memberId: CollabMemberId;
  readonly operationIntentId: string | null;
  readonly projectId: CollabProjectId;
  readonly redemptionReceiptId: string | null;
  readonly requestFingerprint: string;
  readonly secretReplayExpiresAt: CollabIsoTimestamp;
  readonly state: 'active' | 'expired' | 'redeemed' | 'revoked' | 'superseded';
  readonly supersededClaimSha256: string;
  readonly targetPrincipalId: string | null;
  readonly transferId: string;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface ImportedMembershipClaimFacts {
  readonly claimGeneration: number;
  readonly claimSha256: string;
  readonly memberId: CollabMemberId;
  readonly transferId: string;
}

export interface EffectiveTransferredMembershipClaim {
  readonly checkpointSha256: string;
  readonly claimGeneration: number;
  readonly claimSha256: string;
  readonly expiresAt: CollabIsoTimestamp;
  readonly kind: 'original' | 'override';
  readonly memberId: CollabMemberId;
  readonly operationIntentId: string | null;
  readonly redemptionReceiptId: string | null;
  readonly state: 'active' | 'redeemed';
  readonly targetPrincipalId: string | null;
  readonly transferId: string;
  readonly updatedAt: CollabIsoTimestamp;
}

export type InsertClaimOverrideInput = Readonly<{
    readonly managerMemberId: CollabMemberId;
    readonly claimGeneration: number;
    readonly claimSha256: string;
    readonly createdAt: CollabIsoTimestamp;
    readonly envelope: ProtectedClaimOverrideEnvelope;
    readonly expectedClaimGeneration: number;
    readonly expiresAt: CollabIsoTimestamp;
    readonly idempotencyKey: CollabIdempotencyKey;
    readonly memberId: CollabMemberId;
    readonly requestFingerprint: string;
    readonly secretReplayExpiresAt: CollabIsoTimestamp;
    readonly supersededClaimSha256: string;
    readonly transferId: string;
  }>;
export interface ImportedTransferClaimRecord {
  readonly claimSha256: string;
  readonly expiresAt: CollabIsoTimestamp;
  readonly state: string;
  readonly transferId: string;
}
export interface TransferredMembershipClaimRecord extends Omit<EffectiveTransferredMembershipClaim, 'state'> {
  readonly state: string;
}
export interface RevokeClaimRowInput {
  readonly claimGeneration: number;
  readonly claimSha256: string;
  readonly memberId: CollabMemberId;
  readonly revokedAt: CollabIsoTimestamp;
  readonly transferId: string;
}
export interface ProjectTransferredMembershipClaimAdministrationPersistence {
  hasLiveMemberBinding(memberId: CollabMemberId): Promise<boolean>;
  insertClaimOverride(input: InsertClaimOverrideInput): Promise<TransferredMembershipClaimOverrideRecord>;
  readClaimOverrideIssuance(actorMemberId: CollabMemberId, idempotencyKey: CollabIdempotencyKey): Promise<TransferredMembershipClaimOverrideRecord | undefined>;
  readClaimOverride(transferId: string, memberId: CollabMemberId, claimGeneration: number): Promise<TransferredMembershipClaimOverrideRecord | undefined>;
  readHighestClaimOverride(transferId: string, memberId: CollabMemberId): Promise<TransferredMembershipClaimOverrideRecord | undefined>;
  readCurrentTransferClaim(memberId: CollabMemberId): Promise<ImportedTransferClaimRecord | undefined>;
  readTransferredClaimByDigest(transferId: string, claimSha256: string): Promise<TransferredMembershipClaimRecord | undefined>;
  revokeClaimRow(input: RevokeClaimRowInput): Promise<void>;
  scrubClaimOverrideEnvelopes(now: CollabIsoTimestamp): Promise<void>;
  recordClaimOverrideRedemption(input: Readonly<{
    readonly claim: EffectiveTransferredMembershipClaim;
    readonly operationIntentId: string;
    readonly receipt: CollabTransferredMembershipRedemptionReceipt;
    readonly targetPrincipalId: string;
    readonly updatedAt: CollabIsoTimestamp;
  }>): Promise<CollabTransferredMembershipRedemptionReceipt>;
}

export type ProjectMemberRemovalPhase =
  | 'prepared'
  | 'membership-revoked'
  | 'personal-ref-removed'
  | 'completed';

export interface ProjectMemberRemovalJournal {
  readonly actorMemberId: CollabMemberId;
  readonly expectedManagerSetGeneration: number;
  readonly expectedPersonalRefOid: CollabGitOid;
  readonly expectedTargetMembershipRevision: number;
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly operationId: string;
  readonly personalRef: string;
  readonly phase: ProjectMemberRemovalPhase;
  readonly placementGeneration: number;
  readonly preparedAt: CollabIsoTimestamp;
  readonly projectId: CollabProjectId;
  readonly repositoryStorageKey: string;
  readonly requestFingerprint: string;
  readonly response: RemoveMemberResponse | undefined;
  readonly storageNodeId: string;
  readonly targetMemberId: CollabMemberId;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface ProjectMemberRemovalPersistence {
  advanceRemoval(input: Readonly<{
    readonly expectedPhase: Extract<
      ProjectMemberRemovalPhase,
      'membership-revoked' | 'prepared'
    >;
    readonly nextPhase: Extract<
      ProjectMemberRemovalPhase,
      'membership-revoked' | 'personal-ref-removed'
    >;
    readonly operationId: string;
    readonly updatedAt: CollabIsoTimestamp;
  }>): Promise<'advanced' | 'replayed'>;
  completeRemoval(input: Readonly<{
    readonly completedAt: CollabIsoTimestamp;
    readonly operationId: string;
  }>): Promise<RemoveMemberResponse>;
  getNonterminalRemoval(): Promise<ProjectMemberRemovalJournal | undefined>;
  getRemoval(operationId: string): Promise<ProjectMemberRemovalJournal | undefined>;
  insertRemoval(input: Omit<
    ProjectMemberRemovalJournal,
    'phase' | 'response' | 'updatedAt'
  >, authorityGeneration: number): Promise<ProjectMemberRemovalJournal>;
  recordRemovalSettlement(input: Readonly<{
    readonly operationId: string;
    readonly response: RemoveMemberResponse;
  }>): Promise<void>;

}

export interface ProjectMembershipPersistence
  extends ProjectInvitationPersistence,
  ProjectCloudMembershipRelinquishmentPersistence,
  ProjectJoinPersistence,
  ProjectMembershipAdministrationPersistence,
  ProjectMembershipResultPersistence,
  ProjectMembershipExpiryPersistence,
  ProjectMemberRemovalPersistence,
  ProjectMemberExitPersistence,
  ProjectTransferredMembershipClaimAdministrationPersistence {}

export interface MemberExitFacts {
  readonly activeManagerCount: bigint;
  readonly leftAt: CollabIsoTimestamp | null;
  readonly managerSetGeneration: number;
  readonly openRequestId: string | null;
  readonly revision: bigint;
  readonly role: 'manager' | 'member';
  readonly status: 'active' | 'left' | 'pending' | 'revoked';
}

export interface ApplyMemberExitInput {
  readonly advanceManagerSet: boolean;
  readonly exitedAt: CollabIsoTimestamp;
  readonly expectedManagerSetGeneration: number;
  readonly expectedMembershipRevision: bigint;
  readonly memberId: CollabMemberId;
  readonly status: 'left' | 'revoked';
  readonly successor?: Readonly<{
    readonly memberId: CollabMemberId;
    readonly membershipRevision: number;
    readonly offerId: string;
    readonly offerRevision: number;
  }>;
}

export interface ProjectMemberExitPersistence {
  applyMemberExit(input: ApplyMemberExitInput): Promise<void>;
  readMemberExitFacts(memberId: CollabMemberId): Promise<MemberExitFacts | undefined>;
}
