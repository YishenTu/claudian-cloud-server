import type {
  CollabGitOid,
  CollabIdempotencyKey,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabProjectId,
  CollabProjectInvitationState,
  CollabManagerResponsibilityOffer,
  CollabManagerResponsibilityPurpose,
  CollabRole,
  ListProjectMembersResponse,
  CollabManagerResponsibilityOfferResponse,
  DemoteManagerResponse,
  PromoteManagerResponse,
  RemoveMemberResponse,
  RevokeTransferredMembershipClaimResponse,
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

export interface CreateProjectInvitationPersistenceInput
  extends Omit<ProjectInvitationRecord, 'revision' | 'state'> {
  readonly envelope: ProtectedInvitationEnvelope;
  readonly expectedManagerSetGeneration: number;
}

export interface RevokeProjectInvitationPersistenceInput {
  readonly actorMemberId: CollabMemberId;
  readonly expectedInvitationRevision: number;
  readonly expectedManagerSetGeneration: number;
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly invitationId: string;
  readonly projectId: CollabProjectId;
  readonly requestFingerprint: string;
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
  prepareJoin(
    input: PrepareProjectJoinInput,
  ): Promise<Readonly<{
    readonly journal?: ProjectJoinJournal;
    readonly status:
      | 'already-bound'
      | 'conflict'
      | 'created'
      | 'invitation-invalid'
      | 'quota'
      | 'replayed'
      | 'revoked';
  }>>;
}

export interface ProjectInvitationPersistence {
  createInvitation(
    input: CreateProjectInvitationPersistenceInput,
  ): Promise<Readonly<{
    readonly record?: ProjectInvitationRecord;
    readonly status:
      | 'conflict'
      | 'created'
      | 'permanently-stale'
      | 'quota'
      | 'replayed'
      | 'replay-expired'
      | 'stale-generation';
  }>>;
  listInvitations(now: CollabIsoTimestamp): Promise<Readonly<{
    readonly invitations: readonly ProjectInvitationRecord[];
    readonly managerSetGeneration: number;
  }>>;
  revokeInvitation(
    input: RevokeProjectInvitationPersistenceInput,
  ): Promise<Readonly<{
    readonly record?: ProjectInvitationRecord;
    readonly status:
      | 'conflict'
      | 'permanently-stale'
      | 'replayed'
      | 'revoked'
      | 'stale-generation'
      | 'stale-invitation';
  }>>;
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

export type MembershipAdministrationStatus =
  | 'authorization-denied'
  | 'conflict'
  | 'created'
  | 'final-manager'
  | 'permanently-stale'
  | 'replayed'
  | 'stale';

export interface ProjectMembershipAdministrationPersistence {
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

export interface ProjectTransferredMembershipClaimAdministrationPersistence {
  getImportedMembershipClaimFacts(
    memberId: CollabMemberId,
    now: CollabIsoTimestamp,
  ): Promise<ImportedMembershipClaimFacts | undefined>;
  redeemTransferredMembershipClaimOverride(input: Readonly<{
    readonly claim: EffectiveTransferredMembershipClaim;
    readonly operationIntentId: string;
    readonly receipt: CollabTransferredMembershipRedemptionReceipt;
    readonly targetPrincipalId: string;
    readonly updatedAt: CollabIsoTimestamp;
  }>): Promise<CollabTransferredMembershipRedemptionReceipt>;
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
  prepareRemoval(input: Omit<
    ProjectMemberRemovalJournal,
    'phase' | 'response' | 'updatedAt'
  >): Promise<Readonly<{
    readonly journal?: ProjectMemberRemovalJournal;
    readonly status:
      | 'authorization-denied'
      | 'conflict'
      | 'created'
      | 'final-manager'
      | 'permanently-stale'
      | 'replayed'
      | 'stale';
  }>>;
  settleRemoval(input: Readonly<{
    readonly operationId: string;
    readonly removedAt: CollabIsoTimestamp;
  }>): Promise<Readonly<{
    readonly response?: RemoveMemberResponse;
    readonly status: 'replayed' | 'settled' | 'stale';
  }>>;
}

export interface ProjectMembershipPersistence
  extends ProjectInvitationPersistence,
  ProjectCloudMembershipRelinquishmentPersistence,
  ProjectJoinPersistence,
  ProjectMembershipAdministrationPersistence,
  ProjectMembershipExpiryPersistence,
  ProjectMemberRemovalPersistence,
  ProjectTransferredMembershipClaimAdministrationPersistence {}
