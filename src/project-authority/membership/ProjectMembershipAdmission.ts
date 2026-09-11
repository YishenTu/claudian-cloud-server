import { COLLAB_PROJECT_MEMBERSHIP_LIMITS, type CollabIsoTimestamp, type CollabIdempotencyKey, type CollabMemberId, type CollabProjectId } from '@claudian-collab/protocol';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import type { ProjectScope } from '../../coordination/ProjectCoordination.js';
import type { ProjectInvitationRecord, ProtectedInvitationEnvelope, PrepareProjectJoinInput, ProjectJoinJournal } from '../../coordination/ProjectMembershipPersistence.js';

export interface CreateProjectInvitationInput
  extends Omit<ProjectInvitationRecord, 'revision' | 'state'> {
  readonly envelope: ProtectedInvitationEnvelope;
  readonly expectedManagerSetGeneration: number;
}

export interface RevokeProjectInvitationInput {
  readonly actorMemberId: CollabMemberId;
  readonly expectedInvitationRevision: number;
  readonly expectedManagerSetGeneration: number;
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly invitationId: string;
  readonly projectId: CollabProjectId;
  readonly requestFingerprint: string;
  readonly revokedAt: CollabIsoTimestamp;
}

export interface ProjectInvitationOperations {
  createInvitation(
    input: CreateProjectInvitationInput,
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
    input: RevokeProjectInvitationInput,
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

export interface ProjectJoinAdmission {
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

export class ProjectMembershipAdmission implements ProjectInvitationOperations, ProjectJoinAdmission {
  constructor(private readonly scope: ProjectScope) {}

  async createInvitation(input: CreateProjectInvitationInput): ReturnType<ProjectInvitationOperations['createInvitation']> {
    const persistence = this.scope.membership;
    await persistence.expireInvitations(input.createdAt);
    const tombstone = await persistence.findSecretReplayTombstone(input.issuedByMemberId, 'createProjectInvitation', input.idempotencyKey);
    if (tombstone !== undefined) return { status: tombstone === input.requestFingerprint ? 'replay-expired' : 'conflict' };
    const existing = await persistence.readInvitationIssuance(input.issuedByMemberId, input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== input.requestFingerprint) return { status: 'conflict' };
      return existing.envelope === undefined ? { status: 'replay-expired' } : { record: existing, status: 'replayed' };
    }
    const generation = await this.managerGeneration(input.issuedByMemberId);
    if (generation !== undefined && generation > input.expectedManagerSetGeneration) return { status: 'permanently-stale' };
    if (generation !== input.expectedManagerSetGeneration) return { status: 'stale-generation' };
    if (await persistence.readMembershipReservationCount() >= BigInt(COLLAB_PROJECT_MEMBERSHIP_LIMITS.maxProjectMembers)) return { status: 'quota' };
    return { record: await persistence.insertInvitation(input), status: 'created' };
  }

  async listInvitations(now: string): ReturnType<ProjectInvitationOperations['listInvitations']> {
    await this.scope.membership.expireInvitations(now);
    const project = await this.scope.getProject();
    if (project === undefined) throw new CoordinationError('dependency-failed');
    return Object.freeze({ invitations: await this.scope.membership.readInvitations(), managerSetGeneration: project.managerSetGeneration });
  }

  async revokeInvitation(input: RevokeProjectInvitationInput): ReturnType<ProjectInvitationOperations['revokeInvitation']> {
    const persistence = this.scope.membership;
    await persistence.expireInvitations(input.revokedAt);
    const replay = await persistence.findMembershipResult(input.actorMemberId, 'revokeProjectInvitation', input.idempotencyKey);
    if (replay !== undefined) {
      if (replay.requestFingerprint !== input.requestFingerprint) return { status: 'conflict' };
      const record = await persistence.readInvitationRecord(input.invitationId);
      return record === undefined ? { status: 'conflict' } : { record, status: 'replayed' };
    }
    const generation = await this.managerGeneration(input.actorMemberId);
    if (generation !== undefined && generation > input.expectedManagerSetGeneration) return { status: 'permanently-stale' };
    if (generation !== input.expectedManagerSetGeneration) return { status: 'stale-generation' };
    const current = await persistence.readInvitationRecord(input.invitationId);
    if (current === undefined || current.state !== 'active' || current.revision !== input.expectedInvitationRevision) {
      return { status: current !== undefined && current.revision > input.expectedInvitationRevision ? 'permanently-stale' : 'stale-invitation' };
    }
    const record = await persistence.revokeInvitationRow(input);
    await persistence.storeMembershipResult(input.actorMemberId, 'revokeProjectInvitation', input.idempotencyKey, input.requestFingerprint, { invitationId: input.invitationId }, input.revokedAt);
    return { record, status: 'revoked' };
  }

  async prepareJoin(input: PrepareProjectJoinInput): ReturnType<ProjectJoinAdmission['prepareJoin']> {
    const persistence = this.scope.membership;
    const existing = await persistence.findJoinByPrincipal(input.principalId, input.idempotencyKey);
    if (existing !== undefined) return existing.requestFingerprint === input.requestFingerprint ? { journal: existing, status: 'replayed' } : { status: 'conflict' };
    const binding = await persistence.readPrincipalBindingState(input.principalId);
    if (binding === 'revoked') return { status: 'revoked' };
    if (binding !== undefined) return { status: 'already-bound' };
    const project = await this.scope.getProject();
    const placement = await this.scope.getRepositoryPlacement();
    if (project === undefined || project.serviceState !== 'active' || placement === undefined
      || project.expectedMainOid !== input.expectedMainOid || project.managerSetGeneration !== input.managerSetGeneration
      || placement.storageNodeId !== input.storageNodeId || placement.repositoryStorageKey !== input.repositoryStorageKey
      || placement.generation !== input.placementGeneration) return { status: 'conflict' };
    if (await persistence.readMembershipReservationCount() > BigInt(COLLAB_PROJECT_MEMBERSHIP_LIMITS.maxProjectMembers)) return { status: 'quota' };
    const invitation = await persistence.readInvitationRecord(input.invitationId);
    if (invitation === undefined || invitation.state !== 'active' || invitation.revision !== input.invitationRevision
      || invitation.secretSha256 !== input.secretSha256 || Date.parse(invitation.expiresAt) <= Date.parse(input.preparedAt)) return { status: 'invitation-invalid' };
    return { journal: await persistence.insertJoin(input), status: 'created' };
  }

  private async managerGeneration(memberId: string): Promise<number | undefined> {
    const project = await this.scope.getProject();
    const actor = await this.scope.findMembership(memberId);
    return actor?.status === 'active' && actor.role === 'manager' ? project?.managerSetGeneration : undefined;
  }
}
