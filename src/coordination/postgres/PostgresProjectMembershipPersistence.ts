import {
  COLLAB_PROJECT_MEMBERSHIP_LIMITS,
  collabControlOperationCodec,
  collabMemberRef,
  decodeCollabTransferredMembershipRedemptionReceipt,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabManagerResponsibilityOffer,
  type CollabTransferredMembershipRedemptionReceipt,
  type JoinCloudProjectResponse,
  type RemoveMemberResponse,
} from '@claudian-collab/protocol';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import type {
  InsertClaimOverrideInput,
  RevokeClaimRowInput,
  ImportedTransferClaimRecord,
  TransferredMembershipClaimRecord,
  ApplyMemberExitInput,
  InsertResponsibilityOfferInput,
  TransitionResponsibilityOfferInput,
  MemberAdministrationFacts,
  ManagerRoleChangeInput,
  InsertProjectInvitationInput,
  ProjectInvitationRecord,
  ProjectMembershipPersistence,
  ProtectedInvitationEnvelope,
  RevokeInvitationRowInput,
  PrepareProjectJoinInput,
  ProjectJoinJournal,
  ProjectMemberRemovalJournal,
  EffectiveTransferredMembershipClaim,
  ProtectedClaimOverrideEnvelope,
  TransferredMembershipClaimOverrideRecord,
} from '../ProjectMembershipPersistence.js';
import { CoordinationError } from '../CoordinationError.js';

type ProjectQuery = <Row extends QueryResultRow>(
  text: string,
  values: readonly unknown[],
) => Promise<readonly Row[]>;

interface InvitationRow {
  readonly associated_data_sha256: string | null;
  readonly ciphertext: string | null;
  readonly created_at: Date;
  readonly encryption_algorithm: string | null;
  readonly expires_at: Date;
  readonly idempotency_key: string;
  readonly invitation_id: string;
  readonly issued_by_member_id: string;
  readonly key_id: string | null;
  readonly key_version: string | null;
  readonly nonce: string | null;
  readonly project_id: string;
  readonly request_fingerprint: string;
  readonly revision: string;
  readonly secret_replay_expires_at: Date;
  readonly secret_sha256: string;
  readonly state: string;
  readonly tag: string | null;
  readonly terminal_at: Date | null;
}

interface JoinRow {
  readonly display_name: string;
  readonly expected_main_oid: string;
  readonly idempotency_key: string;
  readonly invitation_id: string;
  readonly invitation_revision: string;
  readonly manager_set_generation: string;
  readonly member_id: string;
  readonly operation_id: string;
  readonly personal_ref: string;
  readonly phase: string;
  readonly placement_generation: string;
  readonly prepared_at: Date;
  readonly principal_id: string;
  readonly principal_sha256: string;
  readonly project_id: string;
  readonly repository_storage_key: string;
  readonly request_fingerprint: string;
  readonly response_json: string | null;
  readonly secret_sha256: string;
  readonly storage_node_id: string;
  readonly updated_at: Date;
}

interface ManagerResponsibilityOfferRow {
  readonly acknowledged_at: Date | null;
  readonly expires_at: Date;
  readonly manager_set_generation_at_offer: string;
  readonly offered_at: Date;
  readonly offer_id: string;
  readonly purpose: string;
  readonly request_fingerprint: string;
  readonly revision: string;
  readonly source_manager_member_id: string;
  readonly state: string;
  readonly target_member_id: string;
  readonly target_membership_revision_at_offer: string;
  readonly terminal_at: Date | null;
}

interface MembershipAdministrationReplayRow {
  readonly request_fingerprint: string;
  readonly response_json: unknown;
}

interface ProjectMemberRow {
  readonly binding_state: string;
  readonly claim_expires_at: Date | null;
  readonly claim_state: string | null;
  readonly override_claim_generation: string | null;
  readonly override_state: string | null;
  readonly display_name: string;
  readonly member_id: string;
  readonly revision: string;
  readonly role: string;
}

interface ClaimOverrideRow {
  readonly associated_data_sha256: string | null;
  readonly claim_generation: string;
  readonly claim_sha256: string;
  readonly ciphertext: string | null;
  readonly created_at: Date;
  readonly encryption_algorithm: string | null;
  readonly expires_at: Date;
  readonly idempotency_key: string;
  readonly key_id: string | null;
  readonly key_version: string | null;
  readonly manager_member_id: string;
  readonly member_id: string;
  readonly nonce: string | null;
  readonly operation_intent_id: string | null;
  readonly project_id: string;
  readonly redemption_receipt_id: string | null;
  readonly request_fingerprint: string;
  readonly secret_replay_expires_at: Date;
  readonly state: string;
  readonly superseded_claim_sha256: string;
  readonly tag: string | null;
  readonly target_principal_id: string | null;
  readonly transfer_id: string;
  readonly updated_at: Date;
}

interface RemovalRow {
  readonly actor_member_id: string;
  readonly expected_manager_set_generation: string;
  readonly expected_personal_ref_oid: string;
  readonly expected_target_membership_revision: string;
  readonly idempotency_key: string;
  readonly operation_id: string;
  readonly personal_ref: string;
  readonly phase: string;
  readonly placement_generation: string;
  readonly prepared_at: Date;
  readonly project_id: string;
  readonly repository_storage_key: string;
  readonly request_fingerprint: string;
  readonly response_json: string | null;
  readonly storage_node_id: string;
  readonly target_member_id: string;
  readonly updated_at: Date;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

function dependencyFailure(): never {
  throw new CoordinationError('dependency-failed');
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    return dependencyFailure();
  }
  return value.toISOString();
}

function invitation(row: InvitationRow): ProjectInvitationRecord {
  const revision = Number(row.revision);
  if (
    !isCollabProjectId(row.project_id)
    || !isCollabOpaqueId(row.invitation_id)
    || !isCollabMemberId(row.issued_by_member_id)
    || !isCollabOpaqueId(row.idempotency_key)
    || !SHA256_PATTERN.test(row.request_fingerprint)
    || !SHA256_PATTERN.test(row.secret_sha256)
    || !Number.isSafeInteger(revision)
    || revision <= 0
    || !['active', 'redeeming', 'redeemed', 'revoked', 'expired'].includes(row.state)
  ) return dependencyFailure();
  const createdAt = timestamp(row.created_at);
  const expiresAt = timestamp(row.expires_at);
  const secretReplayExpiresAt = timestamp(row.secret_replay_expires_at);
  const terminalAt = row.terminal_at === null ? null : timestamp(row.terminal_at);
  const noEnvelope = row.key_id === null
    && row.key_version === null
    && row.nonce === null
    && row.ciphertext === null
    && row.tag === null
    && row.associated_data_sha256 === null
    && row.encryption_algorithm === null;
  let envelope: ProtectedInvitationEnvelope | undefined;
  if (!noEnvelope) {
    const keyVersion = Number(row.key_version);
    if (
      row.encryption_algorithm !== 'xchacha20-poly1305'
      || row.key_id === null
      || !isCollabOpaqueId(row.key_id)
      || !Number.isSafeInteger(keyVersion)
      || keyVersion <= 0
      || row.nonce === null
      || !BASE64URL_PATTERN.test(row.nonce)
      || row.ciphertext === null
      || !BASE64URL_PATTERN.test(row.ciphertext)
      || row.tag === null
      || !BASE64URL_PATTERN.test(row.tag)
      || row.associated_data_sha256 === null
      || !SHA256_PATTERN.test(row.associated_data_sha256)
    ) return dependencyFailure();
    envelope = Object.freeze({
      algorithm: row.encryption_algorithm,
      associatedDataSha256: row.associated_data_sha256,
      ciphertext: row.ciphertext,
      createdAt,
      expiresAt,
      invitationId: row.invitation_id,
      keyId: row.key_id,
      keyVersion,
      nonce: row.nonce,
      projectId: row.project_id,
      tag: row.tag,
    });
  }
  return Object.freeze({
    createdAt,
    envelope,
    expiresAt,
    idempotencyKey: row.idempotency_key,
    invitationId: row.invitation_id,
    issuedByMemberId: row.issued_by_member_id,
    projectId: row.project_id,
    requestFingerprint: row.request_fingerprint,
    revision,
    secretReplayExpiresAt,
    secretSha256: row.secret_sha256,
    state: row.state as ProjectInvitationRecord['state'],
    terminalAt,
  });
}

function joinJournal(row: JoinRow): ProjectJoinJournal {
  const invitationRevision = Number(row.invitation_revision);
  const managerSetGeneration = Number(row.manager_set_generation);
  const placementGeneration = Number(row.placement_generation);
  if (
    !isCollabProjectId(row.project_id)
    || !isCollabOpaqueId(row.operation_id)
    || !isCollabOpaqueId(row.idempotency_key)
    || !isCollabOpaqueId(row.invitation_id)
    || !isCollabMemberId(row.member_id)
    || row.personal_ref !== collabMemberRef(row.member_id)
    || !isCollabGitOid(row.expected_main_oid)
    || !Number.isSafeInteger(invitationRevision)
    || invitationRevision < 1
    || !Number.isSafeInteger(managerSetGeneration)
    || managerSetGeneration < 1
    || !Number.isSafeInteger(placementGeneration)
    || placementGeneration < 1
    || !SHA256_PATTERN.test(row.principal_sha256)
    || !SHA256_PATTERN.test(row.request_fingerprint)
    || !SHA256_PATTERN.test(row.secret_sha256)
    || !['prepared', 'membership-pending', 'personal-ref-created',
      'membership-active', 'completed'].includes(row.phase)
  ) return dependencyFailure();
  let response;
  if (row.response_json !== null) {
    try {
      response = collabControlOperationCodec('joinCloudProject').decodeResponse(
        JSON.parse(row.response_json) as unknown,
      );
    } catch {
      return dependencyFailure();
    }
  }
  return Object.freeze({
    displayName: row.display_name,
    expectedMainOid: row.expected_main_oid,
    idempotencyKey: row.idempotency_key,
    invitationId: row.invitation_id,
    invitationRevision,
    managerSetGeneration,
    memberId: row.member_id,
    operationId: row.operation_id,
    personalRef: row.personal_ref,
    phase: row.phase as ProjectJoinJournal['phase'],
    placementGeneration,
    preparedAt: timestamp(row.prepared_at),
    principalId: row.principal_id,
    principalSha256: row.principal_sha256,
    projectId: row.project_id,
    repositoryStorageKey: row.repository_storage_key,
    requestFingerprint: row.request_fingerprint,
    response,
    secretSha256: row.secret_sha256,
    storageNodeId: row.storage_node_id,
    updatedAt: timestamp(row.updated_at),
  });
}

function managerResponsibilityOffer(
  row: ManagerResponsibilityOfferRow,
): CollabManagerResponsibilityOffer {
  const revision = Number(row.revision);
  const managerSetGenerationAtOffer = Number(row.manager_set_generation_at_offer);
  const targetMembershipRevisionAtOffer = Number(
    row.target_membership_revision_at_offer,
  );
  if (
    !Number.isSafeInteger(revision)
    || revision < 1
    || !Number.isSafeInteger(managerSetGenerationAtOffer)
    || managerSetGenerationAtOffer < 1
    || !Number.isSafeInteger(targetMembershipRevisionAtOffer)
    || targetMembershipRevisionAtOffer < 1
  ) return dependencyFailure();
  try {
    return collabControlOperationCodec('getManagerResponsibilityOffer')
      .decodeResponse({
        offer: {
          acknowledgedAt: row.acknowledged_at === null
            ? null
            : timestamp(row.acknowledged_at),
          expiresAt: timestamp(row.expires_at),
          managerSetGenerationAtOffer,
          offeredAt: timestamp(row.offered_at),
          offerId: row.offer_id,
          purpose: row.purpose,
          revision,
          sourceManagerMemberId: row.source_manager_member_id,
          state: row.state,
          targetMemberId: row.target_member_id,
          targetMembershipRevisionAtOffer,
          terminalAt: row.terminal_at === null ? null : timestamp(row.terminal_at),
        },
      }).offer;
  } catch {
    return dependencyFailure();
  }
}

function claimOverride(row: ClaimOverrideRow): TransferredMembershipClaimOverrideRecord {
  const claimGeneration = Number(row.claim_generation);
  if (
    !isCollabProjectId(row.project_id)
    || !isCollabOpaqueId(row.transfer_id)
    || !isCollabMemberId(row.member_id)
    || !isCollabMemberId(row.manager_member_id)
    || !isCollabOpaqueId(row.idempotency_key)
    || !Number.isSafeInteger(claimGeneration)
    || claimGeneration < 1
    || !SHA256_PATTERN.test(row.claim_sha256)
    || !SHA256_PATTERN.test(row.superseded_claim_sha256)
    || !SHA256_PATTERN.test(row.request_fingerprint)
    || !['active', 'expired', 'redeemed', 'revoked', 'superseded'].includes(row.state)
  ) return dependencyFailure();
  const createdAt = timestamp(row.created_at);
  const expiresAt = timestamp(row.expires_at);
  let envelope: ProtectedClaimOverrideEnvelope | undefined;
  const noEnvelope = row.encryption_algorithm === null
    && row.key_id === null
    && row.key_version === null
    && row.nonce === null
    && row.ciphertext === null
    && row.tag === null
    && row.associated_data_sha256 === null;
  if (!noEnvelope) {
    const keyVersion = Number(row.key_version);
    if (
      row.encryption_algorithm !== 'xchacha20-poly1305'
      || row.key_id === null
      || !isCollabOpaqueId(row.key_id)
      || !Number.isSafeInteger(keyVersion)
      || keyVersion < 1
      || row.nonce === null
      || !BASE64URL_PATTERN.test(row.nonce)
      || row.ciphertext === null
      || !BASE64URL_PATTERN.test(row.ciphertext)
      || row.tag === null
      || !BASE64URL_PATTERN.test(row.tag)
      || row.associated_data_sha256 === null
      || !SHA256_PATTERN.test(row.associated_data_sha256)
    ) return dependencyFailure();
    envelope = Object.freeze({
      algorithm: row.encryption_algorithm,
      associatedDataSha256: row.associated_data_sha256,
      ciphertext: row.ciphertext,
      claimGeneration,
      createdAt,
      expiresAt,
      keyId: row.key_id,
      keyVersion,
      memberId: row.member_id,
      nonce: row.nonce,
      projectId: row.project_id,
      tag: row.tag,
      transferId: row.transfer_id,
    });
  }
  return Object.freeze({
    claimGeneration,
    claimSha256: row.claim_sha256,
    createdAt,
    envelope,
    expiresAt,
    idempotencyKey: row.idempotency_key,
    managerMemberId: row.manager_member_id,
    memberId: row.member_id,
    operationIntentId: row.operation_intent_id,
    projectId: row.project_id,
    redemptionReceiptId: row.redemption_receipt_id,
    requestFingerprint: row.request_fingerprint,
    secretReplayExpiresAt: timestamp(row.secret_replay_expires_at),
    state: row.state as TransferredMembershipClaimOverrideRecord['state'],
    supersededClaimSha256: row.superseded_claim_sha256,
    targetPrincipalId: row.target_principal_id,
    transferId: row.transfer_id,
    updatedAt: timestamp(row.updated_at),
  });
}

function removalJournal(row: RemovalRow): ProjectMemberRemovalJournal {
  const expectedManagerSetGeneration = Number(row.expected_manager_set_generation);
  const expectedTargetMembershipRevision = Number(
    row.expected_target_membership_revision,
  );
  const placementGeneration = Number(row.placement_generation);
  if (
    !isCollabProjectId(row.project_id)
    || !isCollabOpaqueId(row.operation_id)
    || !isCollabMemberId(row.actor_member_id)
    || !isCollabMemberId(row.target_member_id)
    || row.actor_member_id === row.target_member_id
    || !isCollabOpaqueId(row.idempotency_key)
    || !SHA256_PATTERN.test(row.request_fingerprint)
    || !isCollabGitOid(row.expected_personal_ref_oid)
    || row.personal_ref !== collabMemberRef(row.target_member_id)
    || !Number.isSafeInteger(expectedManagerSetGeneration)
    || expectedManagerSetGeneration < 1
    || !Number.isSafeInteger(expectedTargetMembershipRevision)
    || expectedTargetMembershipRevision < 1
    || !Number.isSafeInteger(placementGeneration)
    || placementGeneration < 1
    || !['prepared', 'membership-revoked', 'personal-ref-removed', 'completed']
      .includes(row.phase)
  ) return dependencyFailure();
  let response: RemoveMemberResponse | undefined;
  if (row.response_json !== null) {
    try {
      response = collabControlOperationCodec('removeMember').decodeResponse(
        JSON.parse(row.response_json) as unknown,
      );
    } catch {
      return dependencyFailure();
    }
  }
  return Object.freeze({
    actorMemberId: row.actor_member_id,
    expectedManagerSetGeneration,
    expectedPersonalRefOid: row.expected_personal_ref_oid,
    expectedTargetMembershipRevision,
    idempotencyKey: row.idempotency_key,
    operationId: row.operation_id,
    personalRef: row.personal_ref,
    phase: row.phase as ProjectMemberRemovalJournal['phase'],
    placementGeneration,
    preparedAt: timestamp(row.prepared_at),
    projectId: row.project_id,
    repositoryStorageKey: row.repository_storage_key,
    requestFingerprint: row.request_fingerprint,
    response,
    storageNodeId: row.storage_node_id,
    targetMemberId: row.target_member_id,
    updatedAt: timestamp(row.updated_at),
  });
}

const SELECT_JOIN = `SELECT project_id, operation_id, phase, principal_id,
       principal_sha256, idempotency_key, request_fingerprint, invitation_id,
       invitation_revision, secret_sha256, member_id, display_name,
       personal_ref, expected_main_oid, manager_set_generation,
       storage_node_id, repository_storage_key, placement_generation,
       response_json, prepared_at, updated_at
  FROM claudian_cloud.cloud_project_join_journals`;

const SELECT_REMOVAL = `SELECT project_id, operation_id, actor_member_id,
       target_member_id, idempotency_key, request_fingerprint,
       expected_target_membership_revision, expected_manager_set_generation,
       expected_personal_ref_oid, personal_ref, storage_node_id,
       repository_storage_key, placement_generation, phase, response_json,
       prepared_at, updated_at
  FROM claudian_cloud.project_member_removal_journals`;

const SELECT_INVITATION = `SELECT invitation.project_id,
       invitation.invitation_id,
       invitation.issued_by_member_id,
       invitation.idempotency_key,
       invitation.request_fingerprint,
       invitation.secret_sha256,
       invitation.state,
       invitation.revision,
       invitation.created_at,
       invitation.expires_at,
       invitation.secret_replay_expires_at,
       invitation.terminal_at,
       envelope.encryption_algorithm,
       envelope.key_id,
       envelope.key_version,
       envelope.nonce,
       envelope.ciphertext,
       envelope.tag,
       envelope.associated_data_sha256
  FROM claudian_cloud.project_invitations AS invitation
  LEFT JOIN claudian_cloud.protected_invitation_envelopes AS envelope
    ON envelope.project_id = invitation.project_id
   AND envelope.invitation_id = invitation.invitation_id`;

const SELECT_MANAGER_RESPONSIBILITY_OFFER = `SELECT offer_id,
       source_manager_member_id, target_member_id, purpose, state, revision,
       manager_set_generation_at_offer, target_membership_revision_at_offer,
       offered_at, expires_at, acknowledged_at, terminal_at, request_fingerprint
  FROM claudian_cloud.manager_responsibility_offers`;

const SELECT_CLAIM_OVERRIDE = `SELECT override.project_id,
       override.transfer_id, override.member_id, override.claim_generation,
       override.superseded_claim_sha256, override.claim_sha256,
       override.manager_member_id, override.idempotency_key,
       override.request_fingerprint, override.state,
       override.target_principal_id, override.operation_intent_id,
       override.redemption_receipt_id, override.created_at,
       override.expires_at, override.secret_replay_expires_at,
       override.updated_at, envelope.encryption_algorithm,
       envelope.key_id, envelope.key_version, envelope.nonce,
       envelope.ciphertext, envelope.tag, envelope.associated_data_sha256
  FROM claudian_cloud.transferred_membership_claim_overrides AS override
  LEFT JOIN claudian_cloud.protected_claim_override_envelopes AS envelope
    ON envelope.project_id = override.project_id
   AND envelope.transfer_id = override.transfer_id
   AND envelope.member_id = override.member_id
   AND envelope.claim_generation = override.claim_generation`;

export class PostgresProjectMembershipPersistence
  implements ProjectMembershipPersistence {
  readonly #projectId: string;
  readonly #query: ProjectQuery;

  constructor(projectId: string, query: ProjectQuery) {
    this.#projectId = projectId;
    this.#query = query;
  }

  async getRemoval(operationId: string) {
    if (!isCollabOpaqueId(operationId)) return dependencyFailure();
    const rows = await this.#query<RemovalRow>(
      `${SELECT_REMOVAL}
        WHERE project_id = $1 AND operation_id = $2`,
      [this.#projectId, operationId],
    );
    if (rows.length > 1) return dependencyFailure();
    return rows[0] === undefined ? undefined : removalJournal(rows[0]);
  }

  async getNonterminalRemoval() {
    const rows = await this.#query<RemovalRow>(
      `${SELECT_REMOVAL}
        WHERE project_id = $1 AND phase <> 'completed'`,
      [this.#projectId],
    );
    if (rows.length > 1) return dependencyFailure();
    return rows[0] === undefined ? undefined : removalJournal(rows[0]);
  }

  async insertRemoval(
    input: Omit<ProjectMemberRemovalJournal, 'phase' | 'response' | 'updatedAt'>,
    authorityGeneration: number,
  ): Promise<ProjectMemberRemovalJournal> {
    const lifecycle = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.project_lifecycle_journals (
         project_id, operation_id, kind, direction, phase, recovery_from_phase,
         state, expected_authority_generation, actor_member_id, idempotency_key,
         request_fingerprint, checkpoint_sha256, batch_revision, batch_sha256,
         result_sha256, scheduled_at, created_at, updated_at,
         expected_personal_ref_oid
       ) VALUES (
         $1, $2, 'remove-member', NULL, 'prepared', NULL, 'active', $3,
         $4, $5, $6, NULL, NULL, NULL, NULL, $7, $7, $7, $8
       ) RETURNING operation_id`,
      [
        this.#projectId,
        input.operationId,
        authorityGeneration,
        input.actorMemberId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.preparedAt,
        input.expectedPersonalRefOid,
      ],
    );
    if (lifecycle.length !== 1) return dependencyFailure();
    const inserted = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.project_member_removal_journals (
         project_id, operation_id, actor_member_id, target_member_id,
         idempotency_key, request_fingerprint,
         expected_target_membership_revision, expected_manager_set_generation,
         expected_personal_ref_oid, personal_ref, storage_node_id,
         repository_storage_key, placement_generation, phase, response_json,
         prepared_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         'prepared', NULL, $14, $14
       ) RETURNING operation_id`,
      [
        this.#projectId,
        input.operationId,
        input.actorMemberId,
        input.targetMemberId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.expectedTargetMembershipRevision,
        input.expectedManagerSetGeneration,
        input.expectedPersonalRefOid,
        input.personalRef,
        input.storageNodeId,
        input.repositoryStorageKey,
        input.placementGeneration,
        input.preparedAt,
      ],
    );
    if (inserted.length !== 1) return dependencyFailure();
    await this.#query(
      `INSERT INTO claudian_cloud.recovery_candidates (
         kind, project_id, operation_id, scheduled_at, created_at
       ) VALUES ('remove-member', $1, $2, $3, $3)`,
      [this.#projectId, input.operationId, input.preparedAt],
    );
    const journal = await this.getRemoval(input.operationId);
    return journal === undefined
      ? dependencyFailure()
      : journal;
  }

  async readMemberExitFacts(memberId: string) {
    const rows = await this.#query<{
      readonly manager_set_generation: string;
      readonly manager_count: string;
      readonly role: 'manager' | 'member';
      readonly status: 'active' | 'left' | 'pending' | 'revoked';
      readonly revision: string;
      readonly left_at: Date | null;
    }>(
      `SELECT project.manager_set_generation, membership.role, membership.status,
              membership.revision, membership.left_at,
              (SELECT count(*)::text FROM claudian_cloud.project_memberships AS manager
                WHERE manager.project_id = project.project_id
                  AND manager.role = 'manager' AND manager.status = 'active') AS manager_count
         FROM claudian_cloud.projects AS project
         JOIN claudian_cloud.project_memberships AS membership
           ON membership.project_id = project.project_id AND membership.member_id = $2
        WHERE project.project_id = $1
        FOR UPDATE OF project, membership`,
      [this.#projectId, memberId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const requests = await this.#query<{ readonly request_id: string }>(
      `SELECT request_id FROM claudian_cloud.change_requests
        WHERE project_id = $1 AND member_id = $2 AND status = 'open' FOR UPDATE`,
      [this.#projectId, memberId],
    );
    if (requests.length > 1) return dependencyFailure();
    return Object.freeze({
      activeManagerCount: BigInt(row.manager_count),
      leftAt: row.left_at === null ? null : timestamp(row.left_at),
      managerSetGeneration: Number(row.manager_set_generation),
      openRequestId: requests[0]?.request_id ?? null,
      revision: BigInt(row.revision),
      role: row.role,
      status: row.status,
    });
  }

  async applyMemberExit(input: ApplyMemberExitInput): Promise<void> {
    if (input.successor !== undefined) {
      const promoted = await this.#query<{ readonly member_id: string }>(
        `UPDATE claudian_cloud.project_memberships
            SET role = 'manager', revision = revision + 1, updated_at = $3::timestamptz
          WHERE project_id = $1 AND member_id = $2 AND status = 'active'
            AND role = 'member' AND revision = $4 RETURNING member_id`,
        [this.#projectId, input.successor.memberId, input.exitedAt, input.successor.membershipRevision],
      );
      const consumed = await this.#query<{ readonly offer_id: string }>(
        `UPDATE claudian_cloud.manager_responsibility_offers
            SET state = 'consumed', revision = revision + 1, terminal_at = $3::timestamptz
          WHERE project_id = $1 AND offer_id = $2 AND state = 'acknowledged'
            AND revision = $4 RETURNING offer_id`,
        [this.#projectId, input.successor.offerId, input.exitedAt, input.successor.offerRevision],
      );
      if (promoted.length !== 1 || consumed.length !== 1) throw new CoordinationError('state-conflict');
    }
    if (input.advanceManagerSet) {
      const updated = await this.#query<{ readonly project_id: string }>(
        `UPDATE claudian_cloud.projects SET manager_set_generation = manager_set_generation + 1
          WHERE project_id = $1 AND manager_set_generation = $2 RETURNING project_id`,
        [this.#projectId, input.expectedManagerSetGeneration],
      );
      if (updated.length !== 1) throw new CoordinationError('state-conflict');
    }
    const exited = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.project_memberships
          SET status = $5, revision = revision + 1, updated_at = $4::timestamptz,
              left_at = CASE WHEN $5 = 'left' THEN $4::timestamptz ELSE left_at END,
              revoked_at = CASE WHEN $5 = 'revoked' THEN $4::timestamptz ELSE revoked_at END
        WHERE project_id = $1 AND member_id = $2 AND status = 'active' AND revision = $3
       RETURNING member_id`,
      [this.#projectId, input.memberId, input.expectedMembershipRevision.toString(), input.exitedAt, input.status],
    );
    if (exited.length !== 1) throw new CoordinationError('state-conflict');
    await this.#query(
      `UPDATE claudian_cloud.project_principal_bindings
          SET state = 'revoked', revoked_at = $3::timestamptz
        WHERE project_id = $1 AND member_id = $2 AND state IN ('active', 'pending')`,
      [this.#projectId, input.memberId, input.exitedAt],
    );
    await this.#removeUnretainedSourceEnvelopes({ memberId: input.memberId });
    await this.#query(
      `DELETE FROM claudian_cloud.protected_claim_override_envelopes
        WHERE project_id = $1 AND member_id = $2`,
      [this.#projectId, input.memberId],
    );
    await this.#query(
      `UPDATE claudian_cloud.transferred_membership_claims
          SET state = 'revoked', target_principal_id = NULL,
              operation_intent_id = NULL, redemption_receipt_id = NULL,
              updated_at = $3::timestamptz
        WHERE project_id = $1 AND member_id = $2
          AND state IN ('unclaimed', 'redeemed')`,
      [this.#projectId, input.memberId, input.exitedAt],
    );
    await this.#query(
      `UPDATE claudian_cloud.transferred_membership_claim_overrides
          SET state = 'revoked', target_principal_id = NULL,
              operation_intent_id = NULL, redemption_receipt_id = NULL,
              updated_at = $3::timestamptz
        WHERE project_id = $1 AND member_id = $2
          AND state IN ('active', 'redeemed')`,
      [this.#projectId, input.memberId, input.exitedAt],
    );
    await this.#query(
      `UPDATE claudian_cloud.change_requests
          SET status = 'discarded', revision = revision + 1,
              updated_at = $3::timestamptz
        WHERE project_id = $1 AND member_id = $2 AND status = 'open'`,
      [this.#projectId, input.memberId, input.exitedAt],
    );
    await this.#query(
      `DELETE FROM claudian_cloud.ticket_mentions
        WHERE project_id = $1 AND mentioned_member_id = $2`,
      [this.#projectId, input.memberId],
    );
    await this.#query(
      `UPDATE claudian_cloud.manager_responsibility_offers
          SET state = 'cancelled', revision = revision + 1,
              terminal_at = $3::timestamptz
        WHERE project_id = $1 AND state IN ('offered', 'acknowledged')
          AND (
            source_manager_member_id = $2 OR target_member_id = $2
            OR manager_set_generation_at_offer = $4
          )`,
      [
        this.#projectId,
        input.memberId,
        input.exitedAt,
        input.advanceManagerSet
          ? input.expectedManagerSetGeneration
          : -1,
      ],
    );
  }

  async recordRemovalSettlement(input: Readonly<{
    readonly operationId: string;
    readonly response: RemoveMemberResponse;
  }>): Promise<void> {
    const advanced = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.project_member_removal_journals
          SET phase = 'membership-revoked', response_json = $3,
              updated_at = $4::timestamptz
        WHERE project_id = $1 AND operation_id = $2 AND phase = 'prepared'
       RETURNING operation_id`,
      [this.#projectId, input.operationId, JSON.stringify(input.response), input.response.removedAt],
    );
    if (advanced.length !== 1) return dependencyFailure();
    await this.#query(
      `UPDATE claudian_cloud.project_lifecycle_journals
          SET phase = 'membership-revoked', updated_at = $3::timestamptz
        WHERE project_id = $1 AND operation_id = $2 AND kind = 'remove-member'
          AND phase = 'prepared' AND state = 'active'`,
      [this.#projectId, input.operationId, input.response.removedAt],
    );
  }

  async advanceRemoval(input: Readonly<{
    readonly expectedPhase: 'membership-revoked' | 'prepared';
    readonly nextPhase: 'membership-revoked' | 'personal-ref-removed';
    readonly operationId: string;
    readonly updatedAt: string;
  }>) {
    const rows = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.project_member_removal_journals
          SET phase = $4, updated_at = $5::timestamptz
        WHERE project_id = $1 AND operation_id = $2 AND phase = $3
       RETURNING operation_id`,
      [
        this.#projectId,
        input.operationId,
        input.expectedPhase,
        input.nextPhase,
        input.updatedAt,
      ],
    );
    const stored = await this.getRemoval(input.operationId);
    if (stored?.phase !== input.nextPhase) return dependencyFailure();
    await this.#query(
      `UPDATE claudian_cloud.project_lifecycle_journals
          SET phase = $4, updated_at = $5::timestamptz
        WHERE project_id = $1 AND operation_id = $2 AND phase = $3
          AND kind = 'remove-member' AND state = 'active'`,
      [
        this.#projectId,
        input.operationId,
        input.expectedPhase,
        input.nextPhase,
        input.updatedAt,
      ],
    );
    return rows.length === 1 ? 'advanced' as const : 'replayed' as const;
  }

  async completeRemoval(input: Readonly<{
    readonly completedAt: string;
    readonly operationId: string;
  }>) {
    const journal = await this.getRemoval(input.operationId);
    if (journal?.response === undefined) return dependencyFailure();
    if (journal.phase !== 'personal-ref-removed' && journal.phase !== 'completed') {
      return dependencyFailure();
    }
    const resultSha256 = createHash('sha256')
      .update(JSON.stringify(journal.response), 'utf8')
      .digest('hex');
    if (journal.phase === 'personal-ref-removed') {
      const rows = await this.#query<{ readonly operation_id: string }>(
        `UPDATE claudian_cloud.project_member_removal_journals
            SET phase = 'completed', updated_at = $3::timestamptz
          WHERE project_id = $1 AND operation_id = $2
            AND phase = 'personal-ref-removed'
         RETURNING operation_id`,
        [this.#projectId, input.operationId, input.completedAt],
      );
      if (rows.length !== 1) return dependencyFailure();
      await this.#query(
        `UPDATE claudian_cloud.project_lifecycle_journals
            SET phase = 'completed', state = 'completed', result_sha256 = $3,
                updated_at = $4::timestamptz
          WHERE project_id = $1 AND operation_id = $2
            AND kind = 'remove-member' AND phase = 'personal-ref-removed'
            AND state = 'active'`,
        [this.#projectId, input.operationId, resultSha256, input.completedAt],
      );
      await this.#query(
        `DELETE FROM claudian_cloud.recovery_candidates
          WHERE kind = 'remove-member' AND project_id = $1 AND operation_id = $2`,
        [this.#projectId, input.operationId],
      );
    }
    return journal.response;
  }

  async findInvitationForJoin(invitationId: string, now: string) {
    await this.expireInvitations(now);
    return this.readInvitationRecord(invitationId);
  }

  async findJoinByPrincipal(principalId: string, idempotencyKey: string) {
    const rows = await this.#query<JoinRow>(
      `${SELECT_JOIN}
        WHERE project_id = $1 AND principal_id = $2 AND idempotency_key = $3`,
      [this.#projectId, principalId, idempotencyKey],
    );
    return rows[0] === undefined ? undefined : joinJournal(rows[0]);
  }

  async findJoinByPrincipalOperation(operationId: string) {
    const rows = await this.#query<JoinRow>(
      `${SELECT_JOIN}
        WHERE project_id = $1 AND operation_id = $2`,
      [this.#projectId, operationId],
    );
    return rows[0] === undefined ? undefined : joinJournal(rows[0]);
  }

  async getNonterminalJoin() {
    const rows = await this.#query<JoinRow>(
      `${SELECT_JOIN}
        WHERE project_id = $1 AND phase <> 'completed'`,
      [this.#projectId],
    );
    if (rows.length > 1) return dependencyFailure();
    return rows[0] === undefined ? undefined : joinJournal(rows[0]);
  }

  async readPrincipalBindingState(principalId: string): Promise<string | undefined> {
    const rows = await this.#query<{ readonly state: string }>(
      `SELECT state FROM claudian_cloud.project_principal_bindings WHERE project_id = $1 AND principal_id = $2`,
      [this.#projectId, principalId],
    );
    return rows[0]?.state;
  }

  async insertJoin(input: PrepareProjectJoinInput) {
    const reserved = await this.#query<{ readonly invitation_id: string }>(
      `UPDATE claudian_cloud.project_invitations
          SET state = 'redeeming', revision = revision + 1
        WHERE project_id = $1 AND invitation_id = $2
          AND revision = $3 AND state = 'active'
          AND secret_sha256 = $4 AND expires_at > $5
        RETURNING invitation_id`,
      [
        this.#projectId,
        input.invitationId,
        input.invitationRevision,
        input.secretSha256,
        input.preparedAt,
      ],
    );
    if (reserved.length !== 1) throw new CoordinationError('state-conflict');
    await this.#query(
      `INSERT INTO claudian_cloud.cloud_project_join_journals (
         project_id, operation_id, phase, principal_id, principal_sha256,
         idempotency_key, request_fingerprint, invitation_id,
         invitation_revision, secret_sha256, member_id, display_name,
         personal_ref, expected_main_oid, manager_set_generation,
         storage_node_id, repository_storage_key, placement_generation,
         response_json, prepared_at, updated_at
       ) VALUES (
         $1, $2, 'prepared', $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, NULL, $18, $18
       )`,
      [
        this.#projectId,
        input.operationId,
        input.principalId,
        input.principalSha256,
        input.idempotencyKey,
        input.requestFingerprint,
        input.invitationId,
        input.invitationRevision,
        input.secretSha256,
        input.memberId,
        input.displayName,
        input.personalRef,
        input.expectedMainOid,
        input.managerSetGeneration,
        input.storageNodeId,
        input.repositoryStorageKey,
        input.placementGeneration,
        input.preparedAt,
      ],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.recovery_candidates (
         kind, project_id, operation_id, scheduled_at, created_at
       ) VALUES ('join-project', $1, $2, $3, $3)`,
      [this.#projectId, input.operationId, input.preparedAt],
    );
    const journal = await this.findJoinByPrincipalOperation(input.operationId);
    if (journal === undefined) return dependencyFailure();
    return journal;
  }

  async advanceJoin(input: Readonly<{
    readonly expectedPhase: 'prepared' | 'membership-pending';
    readonly nextPhase: 'membership-pending' | 'personal-ref-created';
    readonly operationId: string;
    readonly updatedAt: string;
  }>): Promise<'advanced' | 'replayed'> {
    const journal = await this.findJoinByPrincipalOperation(input.operationId);
    if (journal === undefined) throw new CoordinationError('state-conflict');
    if (journal.phase === input.nextPhase) return 'replayed';
    if (journal.phase !== input.expectedPhase) {
      throw new CoordinationError('state-conflict');
    }
    if (input.nextPhase === 'membership-pending') {
      await this.#query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, display_name, role, status, revision,
           created_at, updated_at, activated_at, revoked_at, left_at
         ) VALUES ($1, $2, $3, 'member', 'pending', 1, $4, $4, NULL, NULL, NULL)`,
        [this.#projectId, journal.memberId, journal.displayName, journal.preparedAt],
      );
      await this.#query(
        `INSERT INTO claudian_cloud.project_principal_bindings (
           project_id, principal_id, member_id, state, bound_at, revoked_at
         ) VALUES ($1, $2, $3, 'pending', $4, NULL)`,
        [this.#projectId, journal.principalId, journal.memberId, journal.preparedAt],
      );
    }
    const rows = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.cloud_project_join_journals
          SET phase = $4, updated_at = $5
        WHERE project_id = $1 AND operation_id = $2 AND phase = $3
        RETURNING operation_id`,
      [
        this.#projectId,
        input.operationId,
        input.expectedPhase,
        input.nextPhase,
        input.updatedAt,
      ],
    );
    if (rows.length !== 1) throw new CoordinationError('state-conflict');
    return 'advanced';
  }

  async activateJoin(input: Readonly<{
    readonly joinedAt: string;
    readonly operationId: string;
    readonly response: JoinCloudProjectResponse;
  }>): Promise<'activated' | 'replayed'> {
    const journal = await this.findJoinByPrincipalOperation(input.operationId);
    if (journal?.phase === 'membership-active' || journal?.phase === 'completed') {
      return 'replayed';
    }
    if (journal?.phase !== 'personal-ref-created') {
      throw new CoordinationError('state-conflict');
    }
    const membership = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.project_memberships
          SET status = 'active', revision = 2, updated_at = $3, activated_at = $3
        WHERE project_id = $1 AND member_id = $2
          AND status = 'pending' AND revision = 1
        RETURNING member_id`,
      [this.#projectId, journal.memberId, input.joinedAt],
    );
    const binding = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.project_principal_bindings
          SET state = 'active'
        WHERE project_id = $1 AND principal_id = $2 AND member_id = $3
          AND state = 'pending'
        RETURNING member_id`,
      [this.#projectId, journal.principalId, journal.memberId],
    );
    const invitationRows = await this.#query<{ readonly invitation_id: string }>(
      `UPDATE claudian_cloud.project_invitations
          SET state = 'redeemed', revision = revision + 1, terminal_at = $3
        WHERE project_id = $1 AND invitation_id = $2 AND state = 'redeeming'
        RETURNING invitation_id`,
      [this.#projectId, journal.invitationId, input.joinedAt],
    );
    if (membership.length !== 1 || binding.length !== 1 || invitationRows.length !== 1) {
      throw new CoordinationError('state-conflict');
    }
    const rows = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.cloud_project_join_journals
          SET phase = 'membership-active', response_json = $3, updated_at = $4
        WHERE project_id = $1 AND operation_id = $2
          AND phase = 'personal-ref-created'
        RETURNING operation_id`,
      [
        this.#projectId,
        input.operationId,
        JSON.stringify(input.response),
        input.joinedAt,
      ],
    );
    if (rows.length !== 1) throw new CoordinationError('state-conflict');
    return 'activated';
  }

  async completeJoin(input: Readonly<{
    readonly completedAt: string;
    readonly operationId: string;
  }>) {
    const before = await this.findJoinByPrincipalOperation(input.operationId);
    if (before?.phase === 'membership-active') {
      await this.#query(
        `UPDATE claudian_cloud.cloud_project_join_journals
            SET phase = 'completed', updated_at = $3
          WHERE project_id = $1 AND operation_id = $2
            AND phase = 'membership-active'`,
        [this.#projectId, input.operationId, input.completedAt],
      );
      await this.#query(
        `DELETE FROM claudian_cloud.recovery_candidates
          WHERE kind = 'join-project' AND project_id = $1 AND operation_id = $2`,
        [this.#projectId, input.operationId],
      );
    } else if (before?.phase !== 'completed') {
      throw new CoordinationError('state-conflict');
    }
    const completed = await this.findJoinByPrincipalOperation(input.operationId);
    if (completed?.phase !== 'completed' || completed.response === undefined) {
      return dependencyFailure();
    }
    return completed.response;
  }

  async findSecretReplayTombstone(actorMemberId: string, operation: string, idempotencyKey: string): Promise<string | undefined> {
    const rows = await this.#query<{ readonly request_fingerprint: string }>(
      `SELECT request_fingerprint FROM claudian_cloud.secret_replay_tombstones
        WHERE project_id = $1 AND actor_member_id = $2 AND operation = $3 AND idempotency_key = $4`,
      [this.#projectId, actorMemberId, operation, idempotencyKey],
    );
    return rows[0]?.request_fingerprint;
  }

  async readMembershipReservationCount(): Promise<bigint> {
    const capacity = await this.#query<{ readonly reserved: string }>(
      `SELECT
         (SELECT COUNT(*)
            FROM claudian_cloud.project_memberships
           WHERE project_id = $1 AND status IN ('active', 'pending'))
       + (SELECT COUNT(*)
            FROM claudian_cloud.project_invitations AS invitation
           WHERE invitation.project_id = $1
             AND invitation.state IN ('active', 'redeeming')
             AND (
               invitation.state = 'active'
               OR NOT EXISTS (
                 SELECT 1
                   FROM claudian_cloud.cloud_project_join_journals AS join_journal
                   JOIN claudian_cloud.project_memberships AS pending_membership
                     ON pending_membership.project_id = join_journal.project_id
                    AND pending_membership.member_id = join_journal.member_id
                    AND pending_membership.status = 'pending'
                  WHERE join_journal.project_id = invitation.project_id
                    AND join_journal.invitation_id = invitation.invitation_id
                    AND join_journal.phase IN (
                      'membership-pending',
                      'personal-ref-created'
                    )
               )
             )) AS reserved`,
      [this.#projectId],
    );
    if (capacity[0] === undefined) return dependencyFailure();
    return BigInt(capacity[0].reserved);
  }

  async insertInvitation(input: InsertProjectInvitationInput) {
    await this.#query(
      `INSERT INTO claudian_cloud.project_invitations (
         project_id, invitation_id, issued_by_member_id, idempotency_key,
         request_fingerprint, secret_sha256, state, revision, created_at,
         expires_at, secret_replay_expires_at, terminal_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 1, $7, $8, $9, NULL)`,
      [
        this.#projectId,
        input.invitationId,
        input.issuedByMemberId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.secretSha256,
        input.createdAt,
        input.expiresAt,
        input.secretReplayExpiresAt,
      ],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.protected_invitation_envelopes (
         project_id, invitation_id, encryption_algorithm, key_id, key_version,
         nonce, ciphertext, tag, associated_data_sha256, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        this.#projectId,
        input.invitationId,
        input.envelope.algorithm,
        input.envelope.keyId,
        input.envelope.keyVersion,
        input.envelope.nonce,
        input.envelope.ciphertext,
        input.envelope.tag,
        input.envelope.associatedDataSha256,
        input.createdAt,
        input.expiresAt,
      ],
    );
    const record = await this.readInvitationRecord(input.invitationId);
    if (record === undefined) return dependencyFailure();
    return record;
  }

  async readInvitations() {
    const rows = await this.#query<InvitationRow>(
      `${SELECT_INVITATION}
        WHERE invitation.project_id = $1
        ORDER BY invitation.invitation_id
        LIMIT $2`,
      [this.#projectId, COLLAB_PROJECT_MEMBERSHIP_LIMITS.maxProjectInvitations],
    );
    return Object.freeze(rows.map(invitation));
  }

  async reconcileExpirations(now: string): Promise<void> {
    if (Number.isNaN(Date.parse(now))) throw new CoordinationError('invalid-record');
    await this.expireInvitations(now);
    await this.expireClaimOverrides(now);
    await this.scrubClaimOverrideEnvelopes(now);
    await this.expireResponsibilityOffers(now);
    await this.#compactTerminalOffers(now);
  }

  async relinquishCloudMembershipAuthorities(input: Readonly<{
    readonly relinquishedAt: string;
    readonly retainedOutgoingTransferId: string;
  }>): Promise<'advanced' | 'replayed'> {
    if (
      Number.isNaN(Date.parse(input.relinquishedAt))
      || !isCollabOpaqueId(input.retainedOutgoingTransferId)
    ) throw new CoordinationError('invalid-record');
    const invitationEnvelopes = await this.#query<{ readonly project_id: string }>(
      `DELETE FROM claudian_cloud.protected_invitation_envelopes
        WHERE project_id = $1
      RETURNING project_id`,
      [this.#projectId],
    );
    const invitations = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.project_invitations
          SET state = 'revoked', revision = revision + 1, terminal_at = $2
        WHERE project_id = $1 AND state IN ('active', 'redeeming')
      RETURNING project_id`,
      [this.#projectId, input.relinquishedAt],
    );
    const offers = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.manager_responsibility_offers
          SET state = 'cancelled', revision = revision + 1, terminal_at = $2
        WHERE project_id = $1 AND state IN ('offered', 'acknowledged')
      RETURNING project_id`,
      [this.#projectId, input.relinquishedAt],
    );
    const overrideEnvelopes = await this.#query<{ readonly project_id: string }>(
      `DELETE FROM claudian_cloud.protected_claim_override_envelopes
        WHERE project_id = $1
      RETURNING project_id`,
      [this.#projectId],
    );
    const overrides = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.transferred_membership_claim_overrides
          SET state = 'revoked', updated_at = $2
        WHERE project_id = $1 AND state = 'active'
      RETURNING project_id`,
      [this.#projectId, input.relinquishedAt],
    );
    const sourceEnvelopes = await this.#removeUnretainedSourceEnvelopes({
      retainedOutgoingTransferId: input.retainedOutgoingTransferId,
    });
    const sourceClaims = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.transferred_membership_claims
          SET state = 'revoked', updated_at = $2
        WHERE project_id = $1 AND transfer_id <> $3 AND state = 'unclaimed'
      RETURNING project_id`,
      [
        this.#projectId,
        input.relinquishedAt,
        input.retainedOutgoingTransferId,
      ],
    );
    return [
      invitationEnvelopes,
      invitations,
      offers,
      overrideEnvelopes,
      overrides,
      sourceEnvelopes,
      sourceClaims,
    ].some(rows => rows.length > 0) ? 'advanced' : 'replayed';
  }

  async #removeUnretainedSourceEnvelopes(input:
    | Readonly<{ readonly memberId: string }>
    | Readonly<{ readonly retainedOutgoingTransferId: string }>
  ) {
    return this.#query<{ readonly project_id: string }>(
      `DELETE FROM claudian_cloud.source_protected_claim_envelopes AS envelope
        WHERE envelope.project_id = $1
          AND ($2::text IS NULL OR envelope.member_id = $2)
          AND ($3::text IS NULL OR envelope.transfer_id <> $3)
          AND NOT EXISTS (
            SELECT 1 FROM claudian_cloud.project_tombstones AS tombstone
             WHERE tombstone.project_id = envelope.project_id
               AND tombstone.terminal_operation_id = envelope.transfer_id
               AND tombstone.terminal_operation_kind = 'authority-transfer'
          )
      RETURNING envelope.project_id`,
      [this.#projectId, 'memberId' in input ? input.memberId : null,
        'retainedOutgoingTransferId' in input ? input.retainedOutgoingTransferId : null],
    );
  }

  async revokeInvitationRow(input: RevokeInvitationRowInput) {
    const rows = await this.#query<{ readonly invitation_id: string }>(
      `UPDATE claudian_cloud.project_invitations
          SET state = 'revoked', revision = revision + 1, terminal_at = $4
        WHERE project_id = $1 AND invitation_id = $2
          AND state = 'active' AND revision = $3
        RETURNING invitation_id`,
      [
        this.#projectId,
        input.invitationId,
        input.expectedInvitationRevision,
        input.revokedAt,
      ],
    );
    if (rows.length !== 1) throw new CoordinationError('state-conflict');
    const record = await this.readInvitationRecord(input.invitationId);
    if (record === undefined) return dependencyFailure();
    return record;
  }

  async hasLiveMemberBinding(memberId: string): Promise<boolean> {
    const rows = await this.#query<{ readonly member_id: string }>(
      `SELECT member_id FROM claudian_cloud.project_principal_bindings
        WHERE project_id = $1 AND member_id = $2 AND state IN ('active', 'pending') LIMIT 1`,
      [this.#projectId, memberId],
    );
    return rows.length !== 0;
  }

  async readClaimOverrideIssuance(actorMemberId: string, idempotencyKey: string) {
    const rows = await this.#query<ClaimOverrideRow>(
      `${SELECT_CLAIM_OVERRIDE} WHERE override.project_id = $1 AND override.manager_member_id = $2 AND override.idempotency_key = $3`,
      [this.#projectId, actorMemberId, idempotencyKey],
    );
    return rows[0] === undefined ? undefined : claimOverride(rows[0]);
  }

  async readHighestClaimOverride(transferId: string, memberId: string) {
    const rows = await this.#query<ClaimOverrideRow>(
      `${SELECT_CLAIM_OVERRIDE} WHERE override.project_id = $1 AND override.transfer_id = $2 AND override.member_id = $3
        ORDER BY override.claim_generation DESC LIMIT 1`,
      [this.#projectId, transferId, memberId],
    );
    return rows[0] === undefined ? undefined : claimOverride(rows[0]);
  }

  async insertClaimOverride(input: InsertClaimOverrideInput) {
    if (input.expectedClaimGeneration > 0) {
      await this.#query(
        `UPDATE claudian_cloud.transferred_membership_claim_overrides
            SET state = 'superseded', updated_at = $5
          WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3
            AND claim_generation = $4 AND state = 'active'`,
        [
          this.#projectId,
          input.transferId,
          input.memberId,
          input.expectedClaimGeneration,
          input.createdAt,
        ],
      );
    }
    await this.#query(
      `INSERT INTO claudian_cloud.transferred_membership_claim_overrides (
         project_id, transfer_id, member_id, claim_generation,
         superseded_claim_sha256, claim_sha256, manager_member_id,
         idempotency_key, request_fingerprint, state, target_principal_id,
         operation_intent_id, redemption_receipt_id, created_at, expires_at,
         secret_replay_expires_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NULL, NULL, NULL,
         $10, $11, $12, $10
       )`,
      [
        this.#projectId,
        input.transferId,
        input.memberId,
        input.claimGeneration,
        input.supersededClaimSha256,
        input.claimSha256,
        input.managerMemberId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.createdAt,
        input.expiresAt,
        input.secretReplayExpiresAt,
      ],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.protected_claim_override_envelopes (
         project_id, transfer_id, member_id, claim_generation,
         encryption_algorithm, key_id, key_version, nonce, ciphertext, tag,
         associated_data_sha256, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        this.#projectId,
        input.transferId,
        input.memberId,
        input.claimGeneration,
        input.envelope.algorithm,
        input.envelope.keyId,
        input.envelope.keyVersion,
        input.envelope.nonce,
        input.envelope.ciphertext,
        input.envelope.tag,
        input.envelope.associatedDataSha256,
        input.createdAt,
        input.expiresAt,
      ],
    );
    const record = await this.readClaimOverride(
      input.transferId,
      input.memberId,
      input.claimGeneration,
    );
    if (record === undefined) return dependencyFailure();
    return record;
  }

  async revokeClaimRow(input: RevokeClaimRowInput): Promise<void> {
    let revoked: readonly QueryResultRow[];
    if (input.claimGeneration === 0) {
      revoked = await this.#query<{ readonly member_id: string }>(
        `UPDATE claudian_cloud.transferred_membership_claims
            SET state = 'revoked', updated_at = $5
          WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3
            AND claim_sha256 = $4 AND state = 'unclaimed' AND expires_at > $5
         RETURNING member_id`,
        [
          this.#projectId,
          input.transferId,
          input.memberId,
          input.claimSha256,
          input.revokedAt,
        ],
      );
    } else {
      revoked = await this.#query<{ readonly member_id: string }>(
        `UPDATE claudian_cloud.transferred_membership_claim_overrides
            SET state = 'revoked', updated_at = $6
          WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3
            AND claim_generation = $4 AND claim_sha256 = $5
            AND state = 'active' AND expires_at > $6
         RETURNING member_id`,
        [
          this.#projectId,
          input.transferId,
          input.memberId,
          input.claimGeneration,
          input.claimSha256,
          input.revokedAt,
        ],
      );
    }
    if (revoked.length !== 1) throw new CoordinationError('state-conflict');
  }

  async readTransferredClaimByDigest(
    transferId: string,
    claimSha256: string,
  ): Promise<TransferredMembershipClaimRecord | undefined> {
    const overrides = await this.#query<{
      readonly checkpoint_sha256: string;
      readonly claim_generation: string;
      readonly claim_sha256: string;
      readonly expires_at: Date;
      readonly member_id: string;
      readonly operation_intent_id: string | null;
      readonly redemption_receipt_id: string | null;
      readonly state: string;
      readonly target_principal_id: string | null;
      readonly transfer_id: string;
      readonly updated_at: Date;
    }>(
      `SELECT override.transfer_id, override.member_id,
              override.claim_generation, override.claim_sha256,
              override.state, override.target_principal_id,
              override.operation_intent_id, override.redemption_receipt_id,
              override.expires_at, override.updated_at,
              original.checkpoint_sha256
         FROM claudian_cloud.transferred_membership_claim_overrides AS override
         JOIN LATERAL (
           SELECT claim.checkpoint_sha256
             FROM claudian_cloud.transferred_membership_claims AS claim
            WHERE claim.project_id = override.project_id
              AND claim.transfer_id = override.transfer_id
              AND claim.member_id = override.member_id
            ORDER BY claim.batch_revision DESC
            LIMIT 1
         ) AS original ON true
        WHERE override.project_id = $1 AND override.transfer_id = $2
          AND override.claim_sha256 = $3
`,
      [this.#projectId, transferId, claimSha256],
    );
    const override = overrides[0];
    if (override !== undefined) {
      return Object.freeze({
        checkpointSha256: override.checkpoint_sha256,
        claimGeneration: Number(override.claim_generation),
        claimSha256: override.claim_sha256,
        expiresAt: timestamp(override.expires_at),
        kind: 'override' as const,
        memberId: override.member_id,
        operationIntentId: override.operation_intent_id,
        redemptionReceiptId: override.redemption_receipt_id,
        state: override.state,
        targetPrincipalId: override.target_principal_id,
        transferId: override.transfer_id,
        updatedAt: timestamp(override.updated_at),
      });
    }
    const originals = await this.#query<{
      readonly checkpoint_sha256: string;
      readonly claim_sha256: string;
      readonly expires_at: Date;
      readonly member_id: string;
      readonly operation_intent_id: string | null;
      readonly redemption_receipt_id: string | null;
      readonly state: string;
      readonly target_principal_id: string | null;
      readonly transfer_id: string;
      readonly updated_at: Date;
    }>(
      `SELECT claim.transfer_id, claim.member_id, claim.checkpoint_sha256,
              claim.claim_sha256, claim.state, claim.target_principal_id,
              claim.operation_intent_id, claim.redemption_receipt_id,
              claim.expires_at, claim.updated_at
         FROM claudian_cloud.transferred_membership_claims AS claim
        WHERE claim.project_id = $1 AND claim.transfer_id = $2
          AND claim.claim_sha256 = $3
        ORDER BY claim.batch_revision DESC
        LIMIT 1`,
      [this.#projectId, transferId, claimSha256],
    );
    const original = originals[0];
    if (original === undefined) return undefined;
    return Object.freeze({
      checkpointSha256: original.checkpoint_sha256,
      claimGeneration: 0,
      claimSha256: original.claim_sha256,
      expiresAt: timestamp(original.expires_at),
      kind: 'original' as const,
      memberId: original.member_id,
      operationIntentId: original.operation_intent_id,
      redemptionReceiptId: original.redemption_receipt_id,
      state: original.state,
      targetPrincipalId: original.target_principal_id,
      transferId: original.transfer_id,
      updatedAt: timestamp(original.updated_at),
    });
  }

  async recordClaimOverrideRedemption(input: Readonly<{
    readonly claim: EffectiveTransferredMembershipClaim;
    readonly operationIntentId: string;
    readonly receipt: CollabTransferredMembershipRedemptionReceipt;
    readonly targetPrincipalId: string;
    readonly updatedAt: string;
  }>): Promise<CollabTransferredMembershipRedemptionReceipt> {
    const receipt = decodeCollabTransferredMembershipRedemptionReceipt(input.receipt);
    if (
      input.claim.kind !== 'override'
      || receipt.projectId !== this.#projectId
      || receipt.transferId !== input.claim.transferId
      || receipt.memberId !== input.claim.memberId
      || receipt.claimSha256 !== input.claim.claimSha256
      || receipt.checkpointSha256 !== input.claim.checkpointSha256
      || receipt.operationIntentId !== input.operationIntentId
      || receipt.redeemedAt !== input.updatedAt
    ) throw new CoordinationError('invalid-record');
    await this.#query(
      `INSERT INTO claudian_cloud.transfer_redemption_receipts (
         project_id, transfer_id, member_id, receipt_id, claim_sha256,
         operation_intent_id, receipt_key_id, receipt_json, redeemed_at,
         acknowledged_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
       ON CONFLICT (project_id, transfer_id, member_id) DO NOTHING`,
      [
        this.#projectId,
        input.claim.transferId,
        input.claim.memberId,
        receipt.receiptId,
        input.claim.claimSha256,
        input.operationIntentId,
        receipt.receiptKeyId,
        JSON.stringify(receipt),
        input.updatedAt,
      ],
    );
    const updated = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.transferred_membership_claim_overrides
          SET state = 'redeemed', target_principal_id = $6,
              operation_intent_id = $7, redemption_receipt_id = $8,
              updated_at = $9
        WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3
          AND claim_generation = $4 AND claim_sha256 = $5
          AND state = 'active' AND expires_at > $9
       RETURNING member_id`,
      [
        this.#projectId,
        input.claim.transferId,
        input.claim.memberId,
        input.claim.claimGeneration,
        input.claim.claimSha256,
        input.targetPrincipalId,
        input.operationIntentId,
        receipt.receiptId,
        input.updatedAt,
      ],
    );
    const storedRows = await this.#query<{
      readonly receipt_json: string;
    }>(
      `SELECT receipt_json
         FROM claudian_cloud.transfer_redemption_receipts
        WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3`,
      [this.#projectId, input.claim.transferId, input.claim.memberId],
    );
    let storedReceipt: CollabTransferredMembershipRedemptionReceipt;
    try {
      storedReceipt = decodeCollabTransferredMembershipRedemptionReceipt(
        JSON.parse(storedRows[0]?.receipt_json ?? '') as unknown,
      );
    } catch {
      throw new CoordinationError('state-conflict');
    }
    if (!isDeepStrictEqual(storedReceipt, receipt)) {
      throw new CoordinationError('state-conflict');
    }
    const bindingRows = await this.#query<{
      readonly member_id: string;
      readonly state: string;
    }>(
      `SELECT member_id, state
         FROM claudian_cloud.project_principal_bindings
        WHERE project_id = $1 AND principal_id = $2`,
      [this.#projectId, input.targetPrincipalId],
    );
    const binding = bindingRows[0];
    if (binding === undefined) {
      await this.#query(
        `INSERT INTO claudian_cloud.project_principal_bindings (
           project_id, principal_id, member_id, state, bound_at, revoked_at
         ) VALUES ($1, $2, $3, 'active', $4, NULL)`,
        [
          this.#projectId,
          input.targetPrincipalId,
          input.claim.memberId,
          input.updatedAt,
        ],
      );
    } else if (
      binding.state !== 'active'
      || binding.member_id !== input.claim.memberId
    ) {
      throw new CoordinationError('state-conflict');
    }
    if (updated.length === 0) {
      const replay = await this.readClaimOverride(
        input.claim.transferId,
        input.claim.memberId,
        input.claim.claimGeneration,
      );
      if (
        replay?.state !== 'redeemed'
        || replay.claimSha256 !== input.claim.claimSha256
        || replay.targetPrincipalId !== input.targetPrincipalId
        || replay.operationIntentId !== input.operationIntentId
        || replay.redemptionReceiptId !== receipt.receiptId
      ) throw new CoordinationError('state-conflict');
    } else if (updated.length !== 1) {
      throw new CoordinationError('state-conflict');
    }
    return storedReceipt;
  }

  async countActiveManagers(): Promise<bigint> {
    const rows = await this.#query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM claudian_cloud.project_memberships
        WHERE project_id = $1 AND role = 'manager' AND status = 'active'`,
      [this.#projectId],
    );
    if (rows[0] === undefined) return dependencyFailure();
    return BigInt(rows[0].count);
  }

  async applyManagerRoleChange(input: ManagerRoleChangeInput): Promise<void> {
    const membership = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.project_memberships
          SET role = $5, revision = revision + 1, updated_at = $4
        WHERE project_id = $1 AND member_id = $2 AND status = 'active'
          AND role = $6 AND revision = $3 RETURNING member_id`,
      [this.#projectId, input.memberId, input.expectedMembershipRevision,
        input.changedAt, input.role, input.role === 'manager' ? 'member' : 'manager'],
    );
    const project = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.projects SET manager_set_generation = manager_set_generation + 1
        WHERE project_id = $1 AND manager_set_generation = $2 RETURNING project_id`,
      [this.#projectId, input.expectedManagerSetGeneration],
    );
    if (membership.length !== 1 || project.length !== 1) throw new CoordinationError('state-conflict');
    if (input.consumeOffer !== undefined) {
      const offer = await this.#query<{ readonly offer_id: string }>(
        `UPDATE claudian_cloud.manager_responsibility_offers
            SET state = 'consumed', revision = revision + 1, terminal_at = $4
          WHERE project_id = $1 AND offer_id = $2 AND state = 'acknowledged'
            AND revision = $3 RETURNING offer_id`,
        [this.#projectId, input.consumeOffer.offerId, input.consumeOffer.revision, input.changedAt],
      );
      if (offer.length !== 1) throw new CoordinationError('state-conflict');
    }
    await this.#cancelSupersededOffers(input.expectedManagerSetGeneration, input.changedAt, input.consumeOffer?.offerId);
  }

  async insertResponsibilityOffer(input: InsertResponsibilityOfferInput): Promise<CollabManagerResponsibilityOffer> {
    const inserted = await this.#query<ManagerResponsibilityOfferRow>(
      `INSERT INTO claudian_cloud.manager_responsibility_offers (
         project_id, offer_id, source_manager_member_id, target_member_id,
         purpose, state, revision, manager_set_generation_at_offer,
         target_membership_revision_at_offer, idempotency_key,
         request_fingerprint, offered_at, expires_at,
         acknowledged_at, terminal_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'offered', 1, $6, $7, $8, $9,
         $10, $11, NULL, NULL
       )
       RETURNING offer_id, source_manager_member_id, target_member_id,
                 purpose, state, revision, manager_set_generation_at_offer,
                 target_membership_revision_at_offer, offered_at, expires_at,
                 acknowledged_at, terminal_at, request_fingerprint`,
      [
        this.#projectId,
        input.offerId,
        input.actorMemberId,
        input.targetMemberId,
        input.purpose,
        input.expectedManagerSetGeneration,
        input.expectedTargetMembershipRevision,
        input.idempotencyKey,
        input.requestFingerprint,
        input.offeredAt,
        input.expiresAt,
      ],
    );
    const insertedOffer = inserted[0];
    if (inserted.length !== 1 || insertedOffer === undefined) {
      return dependencyFailure();
    }
    return managerResponsibilityOffer(insertedOffer);
  }

  async transitionResponsibilityOffer(input: TransitionResponsibilityOfferInput): Promise<CollabManagerResponsibilityOffer> {
    const rows = await this.#query<ManagerResponsibilityOfferRow>(
      `UPDATE claudian_cloud.manager_responsibility_offers
          SET state = $3,
              revision = revision + 1,
              acknowledged_at = CASE WHEN $3 = 'acknowledged'
                THEN $5 ELSE acknowledged_at END,
              terminal_at = CASE WHEN $3 IN ('declined', 'cancelled')
                THEN $5 ELSE terminal_at END
        WHERE project_id = $1 AND offer_id = $2 AND revision = $4
       RETURNING offer_id, source_manager_member_id, target_member_id,
                 purpose, state, revision, manager_set_generation_at_offer,
                 target_membership_revision_at_offer, offered_at, expires_at,
                 acknowledged_at, terminal_at, request_fingerprint`,
      [
        this.#projectId,
        input.offerId,
        input.nextState,
        input.expectedOfferRevision,
        input.transitionedAt,
      ],
    );
    const transitionedOffer = rows[0];
    if (rows.length !== 1 || transitionedOffer === undefined) {
      throw new CoordinationError('state-conflict');
    }
    return managerResponsibilityOffer(transitionedOffer);
  }

  async readResponsibilityOffer(offerId: string) {
    const rows = await this.#query<ManagerResponsibilityOfferRow>(
      `${SELECT_MANAGER_RESPONSIBILITY_OFFER}
        WHERE project_id = $1 AND offer_id = $2`,
      [this.#projectId, offerId],
    );
    return rows[0] === undefined
      ? undefined
      : managerResponsibilityOffer(rows[0]);
  }

  async readCurrentResponsibilityOffers() {
    const rows = await this.#query<ManagerResponsibilityOfferRow>(
      `${SELECT_MANAGER_RESPONSIBILITY_OFFER}
        WHERE project_id = $1
          AND state IN ('offered', 'acknowledged')
        ORDER BY offer_id
        LIMIT $2`,
      [
        this.#projectId,
        COLLAB_PROJECT_MEMBERSHIP_LIMITS.maxCurrentManagerOffers,
      ],
    );
    return Object.freeze(rows.map(managerResponsibilityOffer));
  }

  async findConflictingResponsibilityOffer(input: Readonly<{
    readonly actorMemberId: string;
    readonly targetMemberId: string;
  }>): Promise<string | undefined> {
    const currentOffers = await this.#query<{ readonly offer_id: string }>(
      `SELECT offer_id
         FROM claudian_cloud.manager_responsibility_offers
        WHERE project_id = $1 AND state IN ('offered', 'acknowledged')
          AND (
            source_manager_member_id = $2
            OR target_member_id = $3
          )
        LIMIT 1`,
      [
        this.#projectId,
        input.actorMemberId,
        input.targetMemberId,
      ],
    );
    return currentOffers[0]?.offer_id;
  }

  async readMemberAdministrationFacts(): Promise<readonly MemberAdministrationFacts[]> {
    const rows = await this.#query<ProjectMemberRow>(
      `SELECT membership.member_id,
              membership.display_name,
              membership.role,
              membership.revision,
              CASE WHEN EXISTS (
                SELECT 1
                  FROM claudian_cloud.project_principal_bindings AS binding
                 WHERE binding.project_id = membership.project_id
                   AND binding.member_id = membership.member_id
                   AND binding.state = 'active'
              ) THEN 'bound' ELSE 'unbound' END AS binding_state,
              claim.state AS claim_state,
              claim.expires_at AS claim_expires_at,
              override.claim_generation AS override_claim_generation,
              override.state AS override_state
         FROM claudian_cloud.project_memberships AS membership
         JOIN claudian_cloud.projects AS project
           ON project.project_id = membership.project_id
         LEFT JOIN LATERAL (
           SELECT original.transfer_id, original.state, original.expires_at
             FROM claudian_cloud.transferred_membership_claims AS original
             JOIN claudian_cloud.project_lifecycle_journals AS transfer
               ON transfer.project_id = original.project_id
              AND transfer.operation_id = original.transfer_id
              AND transfer.kind = 'authority-transfer'
              AND transfer.direction = 'lan-to-cloud'
              AND transfer.state = 'completed'
              AND transfer.batch_revision = original.batch_revision
              AND transfer.expected_authority_generation + 1
                = project.authority_generation
            WHERE original.project_id = membership.project_id
              AND original.member_id = membership.member_id
         ) AS claim ON true
         LEFT JOIN LATERAL (
           SELECT candidate.state, candidate.claim_generation
             FROM claudian_cloud.transferred_membership_claim_overrides AS candidate
            WHERE candidate.project_id = membership.project_id
              AND candidate.transfer_id = claim.transfer_id
              AND candidate.member_id = membership.member_id
            ORDER BY candidate.claim_generation DESC
            LIMIT 1
         ) AS override ON true
        WHERE membership.project_id = $1 AND membership.status = 'active'
        ORDER BY membership.member_id
        LIMIT $2`,
      [this.#projectId, COLLAB_PROJECT_MEMBERSHIP_LIMITS.maxProjectMembers],
    );
    return rows.map(row => ({
      bindingState: row.binding_state,
      claimExpiresAt: row.claim_expires_at === null ? null : timestamp(row.claim_expires_at),
      claimState: row.claim_state,
      displayName: row.display_name,
      memberId: row.member_id,
      overrideClaimGeneration: row.override_claim_generation === null ? null : Number(row.override_claim_generation),
      overrideState: row.override_state,
      revision: Number(row.revision),
      role: row.role,
    }));
  }

  async findMembershipResult(actorMemberId: string, operation: string, idempotencyKey: string) {
    const rows = await this.#query<MembershipAdministrationReplayRow>(
      `SELECT request_fingerprint, response_json
         FROM claudian_cloud.idempotency_results
        WHERE project_id = $1 AND member_id = $2
          AND operation = $3 AND idempotency_key = $4`,
      [this.#projectId, actorMemberId, operation, idempotencyKey],
    );
    const row = rows[0];
    return row === undefined ? undefined : { requestFingerprint: row.request_fingerprint, response: row.response_json };
  }

  async hasMembershipResultTombstone(actorMemberId: string, operation: string, idempotencyKey: string) {
    const tombstones = await this.#query<{ readonly idempotency_key: string }>(
      `SELECT idempotency_key
         FROM claudian_cloud.project_membership_idempotency_tombstones
        WHERE project_id = $1 AND actor_member_id = $2
          AND operation = $3 AND idempotency_key = $4`,
      [this.#projectId, actorMemberId, operation, idempotencyKey],
    );
    return tombstones.length !== 0;
  }

  async storeMembershipResult(
    actorMemberId: string,
    operation: string,
    idempotencyKey: string,
    requestFingerprint: string,
    response: object,
    createdAt: string,
  ): Promise<void> {
    const rows = await this.#query<{ readonly idempotency_key: string }>(
      `INSERT INTO claudian_cloud.idempotency_results (
         project_id, member_id, operation, idempotency_key,
         request_fingerprint, response_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING idempotency_key`,
      [
        this.#projectId,
        actorMemberId,
        operation,
        idempotencyKey,
        requestFingerprint,
        JSON.stringify(response),
        createdAt,
      ],
    );
    if (rows.length !== 1) return dependencyFailure();
  }

  async expireResponsibilityOffers(now: string): Promise<void> {
    await this.#query(
      `UPDATE claudian_cloud.manager_responsibility_offers
          SET state = 'expired', revision = revision + 1,
              terminal_at = expires_at
        WHERE project_id = $1
          AND state IN ('offered', 'acknowledged')
          AND expires_at <= $2`,
      [this.#projectId, now],
    );
  }

  async #compactTerminalOffers(now: string): Promise<void> {
    await this.#query(
      `WITH due_offers AS MATERIALIZED (
         SELECT offer.project_id, offer.offer_id,
                offer.source_manager_member_id,
                offer.target_member_id, offer.revision,
                offer.idempotency_key, offer.request_fingerprint,
                offer.terminal_at + ($2::bigint * interval '1 millisecond')
                  AS compacted_at
           FROM claudian_cloud.manager_responsibility_offers AS offer
          WHERE offer.project_id = $1
            AND offer.terminal_at IS NOT NULL
            AND offer.terminal_at
              + ($2::bigint * interval '1 millisecond') <= $3
          FOR UPDATE
       ), due_results AS MATERIALIZED (
         SELECT result.project_id, result.member_id AS actor_member_id,
                result.operation, result.idempotency_key,
                result.request_fingerprint, offer.offer_id,
                offer.compacted_at
           FROM claudian_cloud.idempotency_results AS result
           JOIN due_offers AS offer
             ON result.project_id = offer.project_id
            AND (
              (
                result.operation IN (
                  'createManagerResponsibilityOffer',
                  'acknowledgeManagerResponsibility',
                  'declineManagerResponsibility',
                  'cancelManagerResponsibilityOffer'
                )
                AND result.response_json #>> '{offer,offerId}' = offer.offer_id
              )
              OR (
                result.operation = 'promoteManager'
                AND result.member_id = offer.source_manager_member_id
                AND result.created_at = offer.compacted_at
                  - ($2::bigint * interval '1 millisecond')
                AND result.response_json ->> 'promotedMemberId'
                  = offer.target_member_id
                AND (result.response_json ->> 'offerRevision')::bigint
                  = offer.revision
              )
            )
       ), due_identities AS MATERIALIZED (
         SELECT offer.project_id,
                offer.source_manager_member_id AS actor_member_id,
                'createManagerResponsibilityOffer'::text AS operation,
                offer.idempotency_key, offer.request_fingerprint,
                offer.offer_id, offer.compacted_at
           FROM due_offers AS offer
         UNION
         SELECT result.project_id, result.actor_member_id,
                result.operation, result.idempotency_key,
                result.request_fingerprint, result.offer_id,
                result.compacted_at
           FROM due_results AS result
       ), inserted AS (
         INSERT INTO claudian_cloud.project_membership_idempotency_tombstones (
           project_id, actor_member_id, operation, idempotency_key,
           request_fingerprint, compacted_at
         )
         SELECT project_id, actor_member_id, operation, idempotency_key,
                request_fingerprint, compacted_at
           FROM due_identities
         ON CONFLICT (project_id, actor_member_id, operation, idempotency_key)
           DO NOTHING
         RETURNING project_id, actor_member_id, operation, idempotency_key
       ), deleted_results AS (
         DELETE FROM claudian_cloud.idempotency_results AS result
          USING due_results, inserted
          WHERE result.project_id = due_results.project_id
            AND result.member_id = due_results.actor_member_id
            AND result.operation = due_results.operation
            AND result.idempotency_key = due_results.idempotency_key
            AND inserted.project_id = due_results.project_id
            AND inserted.actor_member_id = due_results.actor_member_id
            AND inserted.operation = due_results.operation
            AND inserted.idempotency_key = due_results.idempotency_key
       )
       DELETE FROM claudian_cloud.manager_responsibility_offers AS offer
        USING due_offers
        WHERE offer.project_id = due_offers.project_id
          AND offer.offer_id = due_offers.offer_id
          AND NOT EXISTS (
            SELECT 1
              FROM due_identities AS identity
             WHERE identity.offer_id = due_offers.offer_id
               AND NOT EXISTS (
                 SELECT 1
                   FROM inserted
                  WHERE inserted.project_id = identity.project_id
                    AND inserted.actor_member_id = identity.actor_member_id
                    AND inserted.operation = identity.operation
                    AND inserted.idempotency_key = identity.idempotency_key
               )
          )`,
      [
        this.#projectId,
        COLLAB_PROJECT_MEMBERSHIP_LIMITS.managerResponsibilityOfferRetentionMs,
        now,
      ],
    );
  }

  async #cancelSupersededOffers(
    previousManagerSetGeneration: number,
    transitionedAt: string,
    exceptOfferId?: string,
  ): Promise<void> {
    await this.#query(
      `UPDATE claudian_cloud.manager_responsibility_offers
          SET state = 'cancelled', revision = revision + 1, terminal_at = $3
        WHERE project_id = $1
          AND manager_set_generation_at_offer = $2
          AND state IN ('offered', 'acknowledged')
          AND ($4::text IS NULL OR offer_id <> $4)`,
      [
        this.#projectId,
        previousManagerSetGeneration,
        transitionedAt,
        exceptOfferId ?? null,
      ],
    );
  }

  async readCurrentTransferClaim(memberId: string): Promise<ImportedTransferClaimRecord | undefined> {
    const rows = await this.#query<{
      readonly original_claim_sha256: string;
      readonly original_expires_at: Date;
      readonly original_state: string;
      readonly transfer_id: string;
    }>(
      `SELECT original.transfer_id,
              original.claim_sha256 AS original_claim_sha256,
              original.state AS original_state,
              original.expires_at AS original_expires_at
         FROM claudian_cloud.project_memberships AS membership
         JOIN claudian_cloud.projects AS project
           ON project.project_id = membership.project_id
         JOIN LATERAL (
           SELECT claim.transfer_id, claim.claim_sha256, claim.state,
                  claim.expires_at
             FROM claudian_cloud.transferred_membership_claims AS claim
             JOIN claudian_cloud.project_lifecycle_journals AS transfer
               ON transfer.project_id = claim.project_id
              AND transfer.operation_id = claim.transfer_id
              AND transfer.kind = 'authority-transfer'
              AND transfer.direction = 'lan-to-cloud'
              AND transfer.state = 'completed'
              AND transfer.batch_revision = claim.batch_revision
              AND transfer.expected_authority_generation + 1
                = project.authority_generation
            WHERE claim.project_id = membership.project_id
              AND claim.member_id = membership.member_id
         ) AS original ON true
        WHERE membership.project_id = $1 AND membership.member_id = $2
`,
      [this.#projectId, memberId],
    );
    const row = rows[0];
    return row === undefined ? undefined : Object.freeze({ claimSha256: row.original_claim_sha256, expiresAt: timestamp(row.original_expires_at), state: row.original_state, transferId: row.transfer_id });
  }

  async readClaimOverride(
    transferId: string,
    memberId: string,
    claimGeneration: number,
  ): Promise<TransferredMembershipClaimOverrideRecord | undefined> {
    const rows = await this.#query<ClaimOverrideRow>(
      `${SELECT_CLAIM_OVERRIDE}
        WHERE override.project_id = $1 AND override.transfer_id = $2
          AND override.member_id = $3 AND override.claim_generation = $4`,
      [this.#projectId, transferId, memberId, claimGeneration],
    );
    return rows[0] === undefined ? undefined : claimOverride(rows[0]);
  }

  async expireClaimOverrides(now: string): Promise<void> {
    await this.#query(
      `UPDATE claudian_cloud.transferred_membership_claim_overrides
          SET state = 'expired', updated_at = expires_at
        WHERE project_id = $1 AND state = 'active' AND expires_at <= $2`,
      [this.#projectId, now],
    );
  }

  async scrubClaimOverrideEnvelopes(now: string): Promise<void> {
    await this.#query(
      `INSERT INTO claudian_cloud.secret_replay_tombstones (
         project_id, actor_member_id, operation, idempotency_key,
         request_fingerprint, expired_at
       ) SELECT project_id, manager_member_id,
                'reissueTransferredMembershipClaim', idempotency_key,
                request_fingerprint, secret_replay_expires_at
           FROM claudian_cloud.transferred_membership_claim_overrides
          WHERE project_id = $1 AND secret_replay_expires_at <= $2
       ON CONFLICT DO NOTHING`,
      [this.#projectId, now],
    );
    await this.#query(
      `DELETE FROM claudian_cloud.protected_claim_override_envelopes AS envelope
        USING claudian_cloud.transferred_membership_claim_overrides AS override
        WHERE envelope.project_id = override.project_id
          AND envelope.transfer_id = override.transfer_id
          AND envelope.member_id = override.member_id
          AND envelope.claim_generation = override.claim_generation
          AND envelope.project_id = $1
          AND override.secret_replay_expires_at <= $2`,
      [this.#projectId, now],
    );
  }

  async expireInvitations(now: string): Promise<void> {
    await this.#query(
      `UPDATE claudian_cloud.project_invitations
          SET state = 'expired', revision = revision + 1, terminal_at = expires_at
        WHERE project_id = $1 AND state = 'active' AND expires_at <= $2`,
      [this.#projectId, now],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.secret_replay_tombstones (
         project_id, actor_member_id, operation, idempotency_key,
         request_fingerprint, expired_at
       ) SELECT project_id, issued_by_member_id, 'createProjectInvitation',
                idempotency_key, request_fingerprint, secret_replay_expires_at
           FROM claudian_cloud.project_invitations
          WHERE project_id = $1 AND secret_replay_expires_at <= $2
       ON CONFLICT DO NOTHING`,
      [this.#projectId, now],
    );
    await this.#query(
      `DELETE FROM claudian_cloud.protected_invitation_envelopes AS envelope
        USING claudian_cloud.project_invitations AS invitation
        WHERE envelope.project_id = invitation.project_id
          AND envelope.invitation_id = invitation.invitation_id
          AND envelope.project_id = $1
          AND invitation.secret_replay_expires_at <= $2`,
      [this.#projectId, now],
    );
  }

  async readInvitationIssuance(actorMemberId: string, idempotencyKey: string) {
    const rows = await this.#query<InvitationRow>(
      `${SELECT_INVITATION}
        WHERE invitation.project_id = $1
          AND invitation.issued_by_member_id = $2
          AND invitation.idempotency_key = $3`,
      [this.#projectId, actorMemberId, idempotencyKey],
    );
    return rows[0] === undefined ? undefined : invitation(rows[0]);
  }

  async readInvitationRecord(invitationId: string) {
    const rows = await this.#query<InvitationRow>(
      `${SELECT_INVITATION}
        WHERE invitation.project_id = $1 AND invitation.invitation_id = $2`,
      [this.#projectId, invitationId],
    );
    return rows[0] === undefined ? undefined : invitation(rows[0]);
  }
}
