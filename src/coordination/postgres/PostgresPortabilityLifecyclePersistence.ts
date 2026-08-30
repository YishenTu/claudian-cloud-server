import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  collabControlOperationCodec,
  decodeCollabAuthorityRelinquishmentProof,
  decodeCollabAuthorityTransferStatus,
  decodeCollabTransferredMembershipClaimCustodyReceipt,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabProtectedClaimAssociatedData,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferStatus,
  type CollabCheckpointAuthority,
  type CollabCheckpointMemberRecord,
  type CollabCheckpointProjectRecord,
  type CollabTransferredMembershipClaimCustodyReceipt,
  type CollabTransferredMembershipRedemptionReceipt,
} from '@claudian-collab/protocol';
import type { QueryResultRow } from 'pg';

import { CoordinationError } from '../CoordinationError.js';
import type {
  AcknowledgeTerminalResponderInput,
  AuthorityTransferRecoveryEvidenceInput,
  AuthorityTransferRecoveryInput,
  AuthorityTransferRecoveryRecord,
  AdvanceProjectBackupCatalogInput,
  AdvanceProjectLifecycleJournalInput,
  CompleteLeaveFormerPrincipalReplayInput,
  CompleteLeaveFormerPrincipalReplayRecoveryInput,
  CleanupTerminalArtifactsInput,
  DeleteTransferredMembershipClaimsInput,
  DeleteProtectedClaimEnvelopesInput,
  DiscardLanToCloudProjectStageInput,
  LanToCloudProjectActivationInput,
  LeaveFormerPrincipalReplayInput,
  LeaveFormerPrincipalReplayRecord,
  LeaveProjectRequestFacts,
  PortabilityLifecyclePersistence,
  ProjectBackupCatalogInput,
  ProjectBackupCatalogRecord,
  ProjectBackupState,
  ProjectDeletionIntentInput,
  ProjectDeletionIntentRecord,
  ProjectDeletionPhase,
  ProjectLifecycleJournalRecord,
  ProjectLifecycleKind,
  ProjectLifecycleState,
  ProjectPrincipalBindingInput,
  ProjectPrincipalBindingRecord,
  ProjectTombstoneInput,
  ProtectedClaimEnvelopeInput,
  ProtectedClaimScrubResult,
  PutProjectLifecycleJournalInput,
  RemoveProjectCoordinationContentInput,
  RemoveTerminalResponderInput,
  ReplaceProtectedClaimEnvelopesInput,
  RenewProtectedClaimEnvelopesInput,
  RedeemTransferredMembershipClaimInput,
  RevokeTransferredMembershipClaimsInput,
  RevokeProjectPrincipalBindingInput,
  RotateTransferredMembershipClaimsInput,
  ScrubProtectedClaimEnvelopeInput,
  SettleLeaveMembershipInput,
  SettleLeaveMembershipResult,
  StageLanToCloudProjectInput,
  TerminalResponderInput,
  TerminalResponderRecord,
  TransferReceiptKeyInput,
  TransferredMembershipClaimInput,
  TransferredMembershipClaimRecord,
} from '../PortabilityLifecyclePersistence.js';
import type {
  PersistenceAdvanceResult,
  PersistencePutResult,
} from '../DevelopmentBootstrapPersistence.js';

type ProjectQuery = <Row extends QueryResultRow>(
  text: string,
  values: readonly unknown[],
) => Promise<readonly Row[]>;

interface LifecycleJournalRow {
  readonly actor_member_id: string | null;
  readonly batch_revision: string | null;
  readonly batch_sha256: string | null;
  readonly checkpoint_sha256: string | null;
  readonly created_at: Date;
  readonly direction: string | null;
  readonly expected_authority_generation: string;
  readonly expected_personal_ref_oid: string | null;
  readonly idempotency_key: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly phase: string;
  readonly project_id: string;
  readonly recovery_from_phase: string | null;
  readonly request_fingerprint: string;
  readonly result_sha256: string | null;
  readonly scheduled_at: Date;
  readonly state: string;
  readonly updated_at: Date;
}

interface PrincipalBindingRow {
  readonly bound_at: Date;
  readonly member_id: string;
  readonly principal_id: string;
  readonly revoked_at: Date | null;
  readonly state: string;
}

interface AuthorityTransferRecoveryRow {
  readonly cancellation_request_sha256: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly inactive_publication_json: string | null;
  readonly relinquishment_proof_json: string | null;
  readonly source_authority_generation: string;
  readonly source_authority_kind: string;
  readonly source_host_member_id: string | null;
  readonly source_proof: string | null;
  readonly source_reopen_sha256: string | null;
  readonly stage_sha256: string | null;
  readonly target_activation_proof: string | null;
  readonly target_activation_request_sha256: string | null;
  readonly target_authority_generation: string;
  readonly target_authority_kind: string;
  readonly target_host_member_id: string | null;
  readonly target_proof: string | null;
  readonly target_url: string;
  readonly transfer_id: string;
  readonly updated_at: Date;
}

interface LeaveFormerPrincipalReplayRow {
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly expected_personal_ref_oid: string;
  readonly intent_id: string;
  readonly member_id: string;
  readonly operation_id: string;
  readonly result_sha256: string | null;
  readonly response_json: string;
  readonly state: string;
}

interface LeaveProjectRequestFactsRow {
  readonly expected_manager_set_generation: string;
  readonly expected_membership_revision: string;
  readonly expected_offer_revision: string | null;
  readonly manager_responsibility_offer_id: string | null;
  readonly operation_id: string;
  readonly project_id: string;
}

interface ClaimRow {
  readonly batch_revision: string;
  readonly checkpoint_sha256: string;
  readonly claim_sha256: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly member_id: string;
  readonly operation_intent_id: string | null;
  readonly redemption_receipt_id: string | null;
  readonly state: string;
  readonly target_principal_id: string | null;
  readonly transfer_id: string;
  readonly updated_at: Date;
}

interface ProtectedEnvelopeRow {
  readonly associated_data_sha256: string;
  readonly authority_generation: string;
  readonly checkpoint_sha256: string;
  readonly ciphertext: string;
  readonly claim_sha256: string;
  readonly created_at: Date;
  readonly encryption_algorithm: string;
  readonly environment_identity: string;
  readonly envelope_version: number;
  readonly expires_at: Date;
  readonly key_id: string;
  readonly key_version: number;
  readonly member_id: string;
  readonly nonce: string;
  readonly receipt_key_id: string;
  readonly tag: string;
  readonly transfer_id: string;
}

interface TerminalResponderRow {
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly response_json: string;
  readonly response_sha256: string;
  readonly replay_member_id: string | null;
  readonly replay_request_sha256: string | null;
}

interface TerminalPrincipalRow {
  readonly acknowledged_at: Date | null;
  readonly member_id: string;
  readonly principal_id: string;
}

interface DeletionIntentRow {
  readonly authorization_sha256: string;
  readonly authorized_member_id: string;
  readonly created_at: Date;
  readonly operation_id: string;
  readonly phase: string;
  readonly placement_generation: string;
  readonly reason: string;
  readonly repository_storage_key: string;
  readonly result_sha256: string | null;
  readonly storage_node_id: string;
  readonly terminal_operation_id: string;
  readonly terminal_operation_kind: string;
  readonly updated_at: Date;
}

interface BackupCatalogRow {
  readonly authority_generation: string;
  readonly authority_volume_identity: string;
  readonly backup_id: string;
  readonly checkpoint_sha256: string;
  readonly coordination_schema_version: number;
  readonly created_at: Date;
  readonly placement_generation: string;
  readonly published_at: Date | null;
  readonly server_build: string;
  readonly state: string;
  readonly verified_at: Date | null;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PHASE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const LIFECYCLE_KINDS = new Set<ProjectLifecycleKind>([
  'authority-transfer',
  'backup',
  'delete',
  'export',
  'leave',
  'remove-member',
  'retire',
]);
const LIFECYCLE_STATES = new Set<ProjectLifecycleState>([
  'active',
  'cancelled',
  'completed',
  'recovery-required',
]);
const DELETION_PHASES = new Set<ProjectDeletionPhase>([
  'traffic-denied',
  'repository-delete-intent',
  'repository-removed',
  'coordination-removed',
  'tombstoned',
  'completed',
]);
const BACKUP_STATES = new Set<ProjectBackupState>([
  'captured',
  'verified',
  'published',
]);
const DELETION_REASONS = new Set<string>(['cloud-to-lan', 'retire']);
const ENCRYPTION_ALGORITHMS = new Set<string>(['xchacha20-poly1305']);
const ENVELOPE_VERSIONS = new Set<number>([1]);
const TERMINAL_OPERATION_KINDS = new Set<string>(['authority-transfer', 'retire']);

function invalidRecord(): never {
  throw new CoordinationError('invalid-record');
}

function dependencyFailure(): never {
  throw new CoordinationError('dependency-failed');
}

function stateConflict(): never {
  throw new CoordinationError('state-conflict');
}

function timestamp(value: string): CollabIsoTimestamp {
  if (
    Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) invalidRecord();
  return value;
}

function dateIso(value: Date): CollabIsoTimestamp {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    dependencyFailure();
  }
  return value.toISOString();
}

function sha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) invalidRecord();
  return value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) invalidRecord();
  return value;
}

function databasePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) dependencyFailure();
  return parsed;
}

function opaqueId(value: string): string {
  if (!isCollabOpaqueId(value)) invalidRecord();
  return value;
}

function memberId(value: string): CollabMemberId {
  if (!isCollabMemberId(value)) invalidRecord();
  return value;
}

function compareMemberIds(
  left: string,
  right: string,
): number {
  return left.localeCompare(right, 'en-US');
}

function principalId(value: string): string {
  if (!PRINCIPAL_PATTERN.test(value)) invalidRecord();
  return value;
}

function boundedProof(value: string): string {
  const byteCount = Buffer.byteLength(value, 'utf8');
  if (byteCount < 1 || byteCount > 8192) invalidRecord();
  return value;
}

function boundedPublicationJson(value: string): string {
  const byteCount = Buffer.byteLength(value, 'utf8');
  if (byteCount < 2 || byteCount > 262_144) invalidRecord();
  return value;
}

function targetUrl(value: string): string {
  const byteCount = Buffer.byteLength(value, 'utf8');
  if (byteCount < 1 || byteCount > 2048) invalidRecord();
  return value;
}

function checkpointAuthority(
  value: Readonly<{ readonly generation: number; readonly kind: string }>,
): CollabCheckpointAuthority {
  if (
    (value.kind !== 'cloud' && value.kind !== 'lan')
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
  ) invalidRecord();
  return Object.freeze({ generation: value.generation, kind: value.kind });
}

function decodedRelinquishmentProof(
  value: CollabAuthorityRelinquishmentProof,
): CollabAuthorityRelinquishmentProof {
  try {
    return decodeCollabAuthorityRelinquishmentProof(value);
  } catch {
    invalidRecord();
  }
}

function canonicalBase64url(
  value: string,
  minimumBytes: number,
  maximumBytes = minimumBytes,
): string {
  if (!BASE64URL_PATTERN.test(value)) invalidRecord();
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength < minimumBytes
    || decoded.byteLength > maximumBytes
    || decoded.toString('base64url') !== value
  ) invalidRecord();
  return value;
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function lifecycleKind(value: string): ProjectLifecycleKind {
  if (!LIFECYCLE_KINDS.has(value as ProjectLifecycleKind)) dependencyFailure();
  return value as ProjectLifecycleKind;
}

function lifecycleState(value: string): ProjectLifecycleState {
  if (!LIFECYCLE_STATES.has(value as ProjectLifecycleState)) dependencyFailure();
  return value as ProjectLifecycleState;
}

function phase(value: string): string {
  if (!PHASE_PATTERN.test(value)) invalidRecord();
  return value;
}

function leaveResponse(value: string) {
  try {
    return collabControlOperationCodec('leaveProject').decodeResponse(
      JSON.parse(value) as unknown,
    );
  } catch {
    return dependencyFailure();
  }
}

function canonicalJournalInput(
  input: PutProjectLifecycleJournalInput,
  projectId: string,
): PutProjectLifecycleJournalInput {
  if (
    input.projectId !== projectId
    || !isCollabProjectId(input.projectId)
    || !LIFECYCLE_KINDS.has(input.kind)
    || (
      input.kind === 'authority-transfer'
      && input.direction !== 'cloud-to-lan'
      && input.direction !== 'lan-to-cloud'
    )
    || (input.kind !== 'authority-transfer' && input.direction !== undefined)
    || (
      input.kind === 'leave' || input.kind === 'remove-member'
        ? !isCollabGitOid(input.expectedPersonalRefOid)
        : input.expectedPersonalRefOid !== undefined
    )
  ) invalidRecord();
  if (input.actorMemberId !== undefined) memberId(input.actorMemberId);
  return Object.freeze({
    ...input,
    ...(input.expectedPersonalRefOid === undefined
      ? {}
      : { expectedPersonalRefOid: input.expectedPersonalRefOid }),
    expectedAuthorityGeneration: positiveInteger(input.expectedAuthorityGeneration),
    idempotencyKey: opaqueId(input.idempotencyKey),
    operationId: opaqueId(input.operationId),
    phase: phase(input.phase),
    requestFingerprint: sha256(input.requestFingerprint),
    scheduledAt: timestamp(input.scheduledAt),
    createdAt: timestamp(input.createdAt),
  });
}

function lifecycleJournal(row: LifecycleJournalRow): ProjectLifecycleJournalRecord {
  const projectId = row.project_id;
  if (!isCollabProjectId(projectId)) dependencyFailure();
  const direction = row.direction === null
    ? undefined
    : row.direction === 'cloud-to-lan' || row.direction === 'lan-to-cloud'
      ? row.direction
      : dependencyFailure();
  const actorMemberId = row.actor_member_id === null
    ? undefined
    : isCollabMemberId(row.actor_member_id)
      ? row.actor_member_id
      : dependencyFailure();
  const state = lifecycleState(row.state);
  const recoveryFromPhase = optional(row.recovery_from_phase);
  if (
    (state === 'recovery-required') !== (recoveryFromPhase !== undefined)
  ) dependencyFailure();
  return Object.freeze({
    actorMemberId,
    batchRevision: row.batch_revision === null
      ? undefined
      : databasePositiveInteger(row.batch_revision),
    batchSha256: optional(row.batch_sha256),
    checkpointSha256: optional(row.checkpoint_sha256),
    createdAt: dateIso(row.created_at),
    direction,
    expectedAuthorityGeneration: databasePositiveInteger(
      row.expected_authority_generation,
    ),
    ...(row.expected_personal_ref_oid === null
      ? {}
      : { expectedPersonalRefOid: row.expected_personal_ref_oid }),
    idempotencyKey: row.idempotency_key,
    kind: lifecycleKind(row.kind),
    operationId: row.operation_id,
    phase: row.phase,
    projectId,
    recoveryFromPhase,
    requestFingerprint: row.request_fingerprint,
    resultSha256: optional(row.result_sha256),
    scheduledAt: dateIso(row.scheduled_at),
    state,
    updatedAt: dateIso(row.updated_at),
  });
}

function validateAdvance(input: AdvanceProjectLifecycleJournalInput): void {
  opaqueId(input.operationId);
  phase(input.expectedPhase);
  phase(input.nextPhase);
  if (!LIFECYCLE_STATES.has(input.expectedState) || !LIFECYCLE_STATES.has(input.nextState)) {
    invalidRecord();
  }
  if (
    (input.nextState === 'recovery-required')
      !== (input.recoveryFromPhase !== undefined)
  ) invalidRecord();
  if (input.recoveryFromPhase !== undefined) phase(input.recoveryFromPhase);
  if (input.resultSha256 !== undefined) sha256(input.resultSha256);
  if (input.checkpointSha256 !== undefined) sha256(input.checkpointSha256);
  if (input.batchSha256 !== undefined) sha256(input.batchSha256);
  if ((input.batchRevision === undefined) !== (input.batchSha256 === undefined)) {
    invalidRecord();
  }
  if (input.batchRevision !== undefined) positiveInteger(input.batchRevision);
  timestamp(input.scheduledAt);
  timestamp(input.updatedAt);
}

function transferredClaim(row: ClaimRow): TransferredMembershipClaimRecord {
  if (!isCollabMemberId(row.member_id)) dependencyFailure();
  if (!['unclaimed', 'redeemed', 'revoked'].includes(row.state)) dependencyFailure();
  return Object.freeze({
    batchRevision: databasePositiveInteger(row.batch_revision),
    checkpointSha256: row.checkpoint_sha256,
    claimSha256: row.claim_sha256,
    createdAt: dateIso(row.created_at),
    expiresAt: dateIso(row.expires_at),
    memberId: row.member_id,
    operationIntentId: optional(row.operation_intent_id),
    redemptionReceiptId: optional(row.redemption_receipt_id),
    state: row.state as TransferredMembershipClaimRecord['state'],
    targetPrincipalId: optional(row.target_principal_id),
    transferId: row.transfer_id,
    updatedAt: dateIso(row.updated_at),
  });
}

function canonicalClaim(input: TransferredMembershipClaimInput): TransferredMembershipClaimInput {
  opaqueId(input.transferId);
  memberId(input.memberId);
  positiveInteger(input.batchRevision);
  sha256(input.checkpointSha256);
  sha256(input.claimSha256);
  const createdAt = timestamp(input.createdAt);
  const expiresAt = timestamp(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) invalidRecord();
  return Object.freeze({ ...input, createdAt, expiresAt });
}

function decodedRedemptionReceipt(
  value: CollabTransferredMembershipRedemptionReceipt,
): CollabTransferredMembershipRedemptionReceipt {
  try {
    return decodeCollabTransferredMembershipRedemptionReceipt(value);
  } catch {
    invalidRecord();
  }
}

function decodedCustodyReceipt(
  value: CollabTransferredMembershipClaimCustodyReceipt,
): CollabTransferredMembershipClaimCustodyReceipt {
  try {
    return decodeCollabTransferredMembershipClaimCustodyReceipt(value);
  } catch {
    invalidRecord();
  }
}

export class PostgresPortabilityLifecyclePersistence
implements PortabilityLifecyclePersistence {
  readonly #projectId: string;
  readonly #query: ProjectQuery;

  constructor(projectId: string, query: ProjectQuery) {
    if (!isCollabProjectId(projectId)) invalidRecord();
    this.#projectId = projectId;
    this.#query = query;
  }

  async stageLanToCloudProject(
    input: StageLanToCloudProjectInput,
  ): Promise<PersistencePutResult> {
    opaqueId(input.transferId);
    timestamp(input.stagedAt);
    sha256(input.checkpointSha256);
    positiveInteger(input.authorityGeneration);
    const projects = input.records.filter(
      (record): record is CollabCheckpointProjectRecord => record.kind === 'project',
    );
    const members = input.records.filter(
      (record): record is CollabCheckpointMemberRecord => record.kind === 'member',
    );
    const project = projects[0];
    if (
      projects.length !== 1
      || project === undefined
      || project.value.projectId !== this.#projectId
      || input.authorityGeneration !== project.value.authorityGeneration + 1
      || members.length === 0
      || members.every(member => member.value.role !== 'manager'
        || member.value.status !== 'active')
      || input.records.some(record => record.value.projectId !== this.#projectId)
    ) invalidRecord();
    const journal = await this.getLifecycleJournal(input.transferId);
    const recovery = await this.getAuthorityTransferRecovery(input.transferId);
    if (
      journal?.kind !== 'authority-transfer'
      || journal.direction !== 'lan-to-cloud'
      || journal.phase !== 'checkpoint-received'
      || journal.state !== 'active'
      || recovery?.targetAuthority.kind !== 'cloud'
      || recovery.targetAuthority.generation !== input.authorityGeneration
      || recovery.stageSha256 !== undefined
    ) stateConflict();
    const existing = await this.#query<{ readonly project_id: string }>(
      `SELECT project_id
         FROM claudian_cloud.projects
        WHERE project_id = $1`,
      [this.#projectId],
    );
    if (existing[0] !== undefined) stateConflict();

    await this.#query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation,
         expected_main_oid, service_state, created_at, activated_at,
         authority_generation, authority_state_revision
       ) VALUES ($1, $2, $3, $4, 'maintenance', $5, $6, $7, 1)`,
      [
        this.#projectId,
        project.value.name,
        project.value.managerSetGeneration,
        project.value.expectedMainOid,
        project.value.createdAt,
        project.value.activatedAt,
        input.authorityGeneration,
      ],
    );
    for (const member of members) {
      await this.#query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, display_name, role, status, revision,
           created_at, updated_at, activated_at, revoked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          this.#projectId,
          member.value.memberId,
          member.value.displayName,
          member.value.role,
          member.value.status,
          member.revision,
          member.value.createdAt,
          member.value.updatedAt,
          member.value.activatedAt,
          member.value.revokedAt,
        ],
      );
    }
    const insertionOrder = [
      'request',
      'ticket',
      'request-comment',
      'ticket-comment',
      'ticket-relation',
      'ticket-mention',
    ] as const;
    for (const kind of insertionOrder) {
      for (const record of input.records) {
        if (record.kind !== kind) continue;
        switch (record.kind) {
          case 'request':
          await this.#query(
            `INSERT INTO claudian_cloud.change_requests (
               project_id, request_id, member_id, status, first_base_oid,
               latest_head_oid, merged_oid, description, revision,
               created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              this.#projectId,
              record.value.requestId,
              record.value.memberId,
              record.value.status,
              record.value.firstBaseOid,
              record.value.latestHeadOid,
              record.value.mergedOid,
              record.value.description,
              record.revision,
              record.value.createdAt,
              record.value.updatedAt,
            ],
          );
          break;
        case 'request-comment':
          await this.#query(
            `INSERT INTO claudian_cloud.request_comments (
               project_id, comment_id, request_id, author_member_id, body,
               created_at
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              this.#projectId,
              record.value.commentId,
              record.value.requestId,
              record.value.authorMemberId,
              record.value.body,
              record.value.createdAt,
            ],
          );
          break;
        case 'ticket': {
          const commentCount = input.records.filter(comment => (
            comment.kind === 'ticket-comment'
            && comment.value.ticketId === record.value.ticketId
          )).length;
          await this.#query(
            `INSERT INTO claudian_cloud.tickets (
               project_id, ticket_id, ticket_number, title, body, status,
               author_member_id, revision, comment_count, created_at,
               updated_at, closed_at, closed_by_member_id
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
             )`,
            [
              this.#projectId,
              record.value.ticketId,
              record.value.number,
              record.value.title,
              record.value.body,
              record.value.status,
              record.value.authorMemberId,
              record.revision,
              commentCount,
              record.value.createdAt,
              record.value.updatedAt,
              record.value.closedAt,
              record.value.closedByMemberId,
            ],
          );
          break;
        }
        case 'ticket-comment':
          await this.#query(
            `INSERT INTO claudian_cloud.ticket_comments (
               project_id, comment_id, ticket_id, author_member_id, body,
               created_at
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              this.#projectId,
              record.value.commentId,
              record.value.ticketId,
              record.value.authorMemberId,
              record.value.body,
              record.value.createdAt,
            ],
          );
          break;
        case 'ticket-relation':
          await this.#query(
            `INSERT INTO claudian_cloud.request_ticket_relations (
               project_id, relation_id, request_id, ticket_id, commit_oid,
               kind, state, created_by_member_id, created_at, updated_at,
               accepted_at, accepted_merge_oid
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
             )`,
            [
              this.#projectId,
              record.value.relationId,
              record.value.requestId,
              record.value.ticketId,
              record.value.commitOid,
              record.value.kind,
              record.value.state,
              record.value.createdByMemberId,
              record.value.createdAt,
              record.value.updatedAt,
              record.value.acceptedAt,
              record.value.acceptedMergeOid,
            ],
          );
          break;
        case 'ticket-mention':
          await this.#query(
            `INSERT INTO claudian_cloud.ticket_mentions (
               project_id, ticket_id, mentioned_member_id, source_kind,
               source_id, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              this.#projectId,
              record.value.ticketId,
              record.value.mentionedMemberId,
              record.value.sourceKind,
              record.value.sourceId,
              record.value.createdAt,
            ],
          );
          break;
        }
      }
    }
    return 'created';
  }

  async activateLanToCloudProject(
    input: LanToCloudProjectActivationInput,
  ): Promise<PersistencePutResult> {
    opaqueId(input.transferId);
    const activatedAt = timestamp(input.activatedAt);
    positiveInteger(input.authorityGeneration);
    positiveInteger(input.placementGeneration);
    memberId(input.hostMemberId);
    principalId(input.hostPrincipalId);
    if (
      !/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/u.test(input.storageNodeId)
      || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(input.repositoryStorageKey)
    ) invalidRecord();
    const journal = await this.getLifecycleJournal(input.transferId);
    const recovery = await this.getAuthorityTransferRecovery(input.transferId);
    if (
      journal?.kind !== 'authority-transfer'
      || journal.direction !== 'lan-to-cloud'
      || journal.phase !== 'source-relinquished'
      || journal.state !== 'active'
      || journal.checkpointSha256 === undefined
      || journal.batchRevision === undefined
      || journal.batchSha256 === undefined
      || recovery?.targetAuthority.kind !== 'cloud'
      || recovery.targetAuthority.generation !== input.authorityGeneration
      || recovery.relinquishmentProof === undefined
      || recovery.stageSha256 !== journal.checkpointSha256
    ) stateConflict();
    const batchRevision = journal.batchRevision;
    const checkpointSha256 = journal.checkpointSha256;
    const projects = await this.#query<{
      readonly authority_generation: string;
      readonly service_state: string;
    }>(
      `SELECT authority_generation, service_state
         FROM claudian_cloud.projects
        WHERE project_id = $1`,
      [this.#projectId],
    );
    if (
      projects.length !== 1
      || projects[0]?.service_state !== 'maintenance'
      || databasePositiveInteger(projects[0].authority_generation)
        !== input.authorityGeneration
    ) stateConflict();
    const members = await this.#query<{
      readonly member_id: string;
      readonly role: string;
      readonly status: string;
    }>(
      `SELECT member_id, role, status
         FROM claudian_cloud.project_memberships
        WHERE project_id = $1
        ORDER BY member_id`,
      [this.#projectId],
    );
    if (
      !members.some(member => member.member_id === input.hostMemberId
        && member.status === 'active')
      || members.every(member => member.role !== 'manager'
        || member.status !== 'active')
    ) stateConflict();
    const expectedClaimMembers = members
      .filter(member => member.status === 'active'
        && member.member_id !== input.hostMemberId)
      .map(member => member.member_id)
      .sort(compareMemberIds);
    const claims = await this.#query<{
      readonly batch_revision: string;
      readonly checkpoint_sha256: string;
      readonly member_id: string;
      readonly state: string;
    }>(
      `SELECT member_id, batch_revision, checkpoint_sha256, state
         FROM claudian_cloud.transferred_membership_claims
        WHERE project_id = $1 AND transfer_id = $2
        ORDER BY batch_revision, member_id`,
      [this.#projectId, input.transferId],
    );
    const currentClaims = claims
      .filter(claim => (
        databasePositiveInteger(claim.batch_revision) === batchRevision
      ))
      .sort((left, right) => compareMemberIds(left.member_id, right.member_id));
    const historicalClaimsAreRevoked = claims.every(claim => {
      const revision = databasePositiveInteger(claim.batch_revision);
      return revision === batchRevision
        || (revision < batchRevision && claim.state === 'revoked');
    });
    if (
      !historicalClaimsAreRevoked
      || currentClaims.length !== expectedClaimMembers.length
      || currentClaims.some((claim, index) => (
        claim.member_id !== expectedClaimMembers[index]
        || claim.state !== 'unclaimed'
        || claim.checkpoint_sha256 !== checkpointSha256
      ))
    ) stateConflict();
    const unexpectedPublishedState = await this.#query<{ readonly count: string }>(
      `SELECT (
         (SELECT count(*) FROM claudian_cloud.repository_placements
           WHERE project_id = $1)
         + (SELECT count(*) FROM claudian_cloud.project_principal_bindings
           WHERE project_id = $1)
         + (SELECT count(*) FROM claudian_cloud.project_events
           WHERE project_id = $1)
       )::text AS count`,
      [this.#projectId],
    );
    if (unexpectedPublishedState[0]?.count !== '0') stateConflict();
    const promoted = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.projects
          SET service_state = 'active',
              authority_state_revision = authority_state_revision + 1
        WHERE project_id = $1
          AND authority_generation = $2
          AND service_state = 'maintenance'
       RETURNING project_id`,
      [this.#projectId, input.authorityGeneration],
    );
    if (promoted.length !== 1) stateConflict();
    await this.#query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, true, $5, $5)`,
      [
        this.#projectId,
        input.storageNodeId,
        input.repositoryStorageKey,
        input.placementGeneration,
        activatedAt,
      ],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, $2, $3, $4)`,
      [
        this.#projectId,
        input.storageNodeId,
        input.repositoryStorageKey,
        input.placementGeneration,
      ],
    );
    await this.bindProjectPrincipal({
      boundAt: activatedAt,
      memberId: input.hostMemberId,
      principalId: input.hostPrincipalId,
    });
    return 'created';
  }

  async discardLanToCloudProjectStage(
    input: DiscardLanToCloudProjectStageInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.transferId);
    positiveInteger(input.authorityGeneration);
    const stageSha256 = input.stageSha256 === undefined
      ? undefined
      : sha256(input.stageSha256);
    const journal = await this.getLifecycleJournal(input.transferId);
    const recovery = await this.getAuthorityTransferRecovery(input.transferId);
    if (
      journal?.kind !== 'authority-transfer'
      || journal.direction !== 'lan-to-cloud'
      || journal.phase !== 'target-invalidated'
      || journal.state !== 'active'
      || recovery?.targetAuthority.kind !== 'cloud'
      || recovery.targetAuthority.generation !== input.authorityGeneration
      || recovery.stageSha256 !== stageSha256
    ) stateConflict();
    const projects = await this.#query<{
      readonly authority_generation: string;
      readonly service_state: string;
    }>(
      `SELECT authority_generation, service_state
         FROM claudian_cloud.projects
        WHERE project_id = $1`,
      [this.#projectId],
    );
    if (projects.length === 0) return 'replayed';
    if (
      projects.length !== 1
      || projects[0]?.service_state !== 'maintenance'
      || databasePositiveInteger(projects[0].authority_generation)
        !== input.authorityGeneration
    ) stateConflict();
    const forbiddenState = await this.#query<{ readonly count: string }>(
      `SELECT (
         (SELECT count(*) FROM claudian_cloud.repository_placements
           WHERE project_id = $1)
         + (SELECT count(*) FROM claudian_cloud.project_principal_bindings
           WHERE project_id = $1)
         + (SELECT count(*) FROM claudian_cloud.project_events
           WHERE project_id = $1)
       )::text AS count`,
      [this.#projectId],
    );
    if (forbiddenState[0]?.count !== '0') stateConflict();
    for (const relation of [
      'request_ticket_relations',
      'ticket_mentions',
      'ticket_comments',
      'request_comments',
      'tickets',
      'change_requests',
      'project_memberships',
      'projects',
    ]) {
      await this.#query(
        `DELETE FROM claudian_cloud.${relation} WHERE project_id = $1`,
        [this.#projectId],
      );
    }
    return 'advanced';
  }

  async putLifecycleJournal(
    input: PutProjectLifecycleJournalInput,
  ): Promise<PersistencePutResult> {
    const canonical = canonicalJournalInput(input, this.#projectId);
    const active = await this.#query<LifecycleJournalRow>(
      `SELECT *
         FROM claudian_cloud.project_lifecycle_journals
        WHERE project_id = $1
          AND state IN ('active', 'recovery-required')`,
      [this.#projectId],
    );
    if (
      active[0] !== undefined
      && active[0].operation_id !== canonical.operationId
    ) stateConflict();
    const idempotent = await this.#query<{ readonly operation_id: string }>(
      `SELECT operation_id
         FROM claudian_cloud.project_lifecycle_journals
        WHERE project_id = $1
          AND actor_member_id IS NOT DISTINCT FROM $2
          AND kind = $3
          AND idempotency_key = $4`,
      [
        this.#projectId,
        canonical.actorMemberId ?? null,
        canonical.kind,
        canonical.idempotencyKey,
      ],
    );
    if (
      idempotent[0] !== undefined
      && idempotent[0].operation_id !== canonical.operationId
    ) stateConflict();
    const inserted = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.project_lifecycle_journals (
         project_id, operation_id, kind, direction, phase,
         recovery_from_phase, state, expected_authority_generation,
         actor_member_id, idempotency_key, request_fingerprint,
         expected_personal_ref_oid,
         checkpoint_sha256, batch_revision, batch_sha256, result_sha256,
         scheduled_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, NULL, 'active', $6, $7, $8, $9, $10,
         NULL, NULL, NULL, NULL, $11::timestamptz,
         $12::timestamptz, $12::timestamptz
       )
       ON CONFLICT (project_id, operation_id) DO NOTHING
       RETURNING operation_id`,
      [
        this.#projectId,
        canonical.operationId,
        canonical.kind,
        canonical.direction ?? null,
        canonical.phase,
        canonical.expectedAuthorityGeneration,
        canonical.actorMemberId ?? null,
        canonical.idempotencyKey,
        canonical.requestFingerprint,
        canonical.expectedPersonalRefOid ?? null,
        canonical.scheduledAt,
        canonical.createdAt,
      ],
    );
    const record = await this.getLifecycleJournal(canonical.operationId);
    const expected: ProjectLifecycleJournalRecord = {
      ...canonical,
      batchRevision: undefined,
      batchSha256: undefined,
      checkpointSha256: undefined,
      recoveryFromPhase: undefined,
      resultSha256: undefined,
      state: 'active',
      updatedAt: canonical.createdAt,
    };
    if (record === undefined || !isDeepStrictEqual(record, expected)) stateConflict();
    await this.#upsertRecoveryCandidate(
      canonical.kind,
      canonical.operationId,
      canonical.scheduledAt,
      canonical.createdAt,
    );
    return inserted.length === 1 ? 'created' : 'replayed';
  }

  async getLifecycleJournal(
    operationId: string,
  ): Promise<ProjectLifecycleJournalRecord | undefined> {
    opaqueId(operationId);
    const rows = await this.#query<LifecycleJournalRow>(
      `SELECT project_id, operation_id, kind, direction, phase,
              recovery_from_phase, state, expected_authority_generation,
              actor_member_id, idempotency_key, request_fingerprint,
              expected_personal_ref_oid,
              checkpoint_sha256, batch_revision, batch_sha256, result_sha256,
              scheduled_at, created_at, updated_at
         FROM claudian_cloud.project_lifecycle_journals
        WHERE project_id = $1 AND operation_id = $2`,
      [this.#projectId, operationId],
    );
    return rows[0] === undefined ? undefined : lifecycleJournal(rows[0]);
  }

  async getNonterminalLifecycleJournal(): Promise<
    ProjectLifecycleJournalRecord | undefined
  > {
    const rows = await this.#query<LifecycleJournalRow>(
      `SELECT project_id, operation_id, kind, direction, phase,
              recovery_from_phase, state, expected_authority_generation,
              actor_member_id, idempotency_key, request_fingerprint,
              expected_personal_ref_oid,
              checkpoint_sha256, batch_revision, batch_sha256, result_sha256,
              scheduled_at, created_at, updated_at
         FROM claudian_cloud.project_lifecycle_journals
        WHERE project_id = $1 AND state IN ('active', 'recovery-required')
        LIMIT 2`,
      [this.#projectId],
    );
    if (rows.length > 1) stateConflict();
    return rows[0] === undefined ? undefined : lifecycleJournal(rows[0]);
  }

  async advanceLifecycleJournal(
    input: AdvanceProjectLifecycleJournalInput,
  ): Promise<PersistenceAdvanceResult> {
    validateAdvance(input);
    const rows = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.project_lifecycle_journals
          SET phase = $5,
              recovery_from_phase = $6,
              state = $7,
              checkpoint_sha256 = COALESCE(checkpoint_sha256, $8),
              batch_revision = COALESCE(batch_revision, $9),
              batch_sha256 = COALESCE(batch_sha256, $10),
              result_sha256 = COALESCE(result_sha256, $11),
              scheduled_at = $12::timestamptz,
              updated_at = $13::timestamptz
        WHERE project_id = $1
          AND operation_id = $2
          AND phase = $3
          AND state = $4
          AND (
            $8::char(64) IS NULL
            OR checkpoint_sha256 IS NULL
            OR checkpoint_sha256 = $8
          )
          AND (
            $9::bigint IS NULL
            OR batch_revision IS NULL
            OR (batch_revision = $9 AND batch_sha256 = $10)
          )
          AND (
            $11::char(64) IS NULL
            OR result_sha256 IS NULL
            OR result_sha256 = $11
          )
       RETURNING operation_id`,
      [
        this.#projectId,
        input.operationId,
        input.expectedPhase,
        input.expectedState,
        input.nextPhase,
        input.recoveryFromPhase ?? null,
        input.nextState,
        input.checkpointSha256 ?? null,
        input.batchRevision ?? null,
        input.batchSha256 ?? null,
        input.resultSha256 ?? null,
        input.scheduledAt,
        input.updatedAt,
      ],
    );
    const record = await this.getLifecycleJournal(input.operationId);
    if (record === undefined) stateConflict();
    const matchesNext = record.phase === input.nextPhase
      && record.state === input.nextState
      && record.recoveryFromPhase === input.recoveryFromPhase
      && record.scheduledAt === input.scheduledAt
      && record.updatedAt === input.updatedAt
      && (
        input.checkpointSha256 === undefined
        || record.checkpointSha256 === input.checkpointSha256
      )
      && (
        input.batchRevision === undefined
        || record.batchRevision === input.batchRevision
      )
      && (
        input.batchSha256 === undefined
        || record.batchSha256 === input.batchSha256
      )
      && (
        input.resultSha256 === undefined
        || record.resultSha256 === input.resultSha256
      );
    if (!matchesNext) stateConflict();
    if (input.nextState === 'active' || input.nextState === 'recovery-required') {
      await this.#upsertRecoveryCandidate(
        record.kind,
        record.operationId,
        input.scheduledAt,
        record.createdAt,
      );
    } else {
      await this.#query(
        `DELETE FROM claudian_cloud.recovery_candidates
          WHERE kind = $1 AND project_id = $2 AND operation_id = $3`,
        [record.kind, this.#projectId, record.operationId],
      );
    }
    return rows.length === 1 ? 'advanced' : 'replayed';
  }

  async bindProjectPrincipal(
    input: ProjectPrincipalBindingInput,
  ): Promise<PersistencePutResult> {
    const canonical: ProjectPrincipalBindingInput = Object.freeze({
      boundAt: timestamp(input.boundAt),
      memberId: memberId(input.memberId),
      principalId: principalId(input.principalId),
    });
    const membership = await this.#query<{ readonly member_id: string }>(
      `SELECT member_id
         FROM claudian_cloud.project_memberships
        WHERE project_id = $1 AND member_id = $2 AND status = 'active'`,
      [this.#projectId, canonical.memberId],
    );
    if (membership.length !== 1) stateConflict();
    const rows = await this.#query<{ readonly principal_id: string }>(
      `INSERT INTO claudian_cloud.project_principal_bindings (
         project_id, principal_id, member_id, state, bound_at, revoked_at
       ) VALUES ($1, $2, $3, 'active', $4::timestamptz, NULL)
       ON CONFLICT DO NOTHING
       RETURNING principal_id`,
      [
        this.#projectId,
        canonical.principalId,
        canonical.memberId,
        canonical.boundAt,
      ],
    );
    const stored = await this.findProjectPrincipalBinding(canonical.principalId);
    const expected: ProjectPrincipalBindingRecord = Object.freeze({
      ...canonical,
      revokedAt: undefined,
      state: 'active',
    });
    if (stored === undefined || !isDeepStrictEqual(stored, expected)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async findProjectPrincipalBinding(
    requestedPrincipalId: string,
  ): Promise<ProjectPrincipalBindingRecord | undefined> {
    principalId(requestedPrincipalId);
    const rows = await this.#query<PrincipalBindingRow>(
      `SELECT principal_id, member_id, state, bound_at, revoked_at
         FROM claudian_cloud.project_principal_bindings
        WHERE project_id = $1 AND principal_id = $2`,
      [this.#projectId, requestedPrincipalId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (
      !isCollabMemberId(row.member_id)
      || (row.state !== 'active' && row.state !== 'revoked')
      || ((row.state === 'active') !== (row.revoked_at === null))
    ) dependencyFailure();
    return Object.freeze({
      boundAt: dateIso(row.bound_at),
      memberId: row.member_id,
      principalId: row.principal_id,
      revokedAt: row.revoked_at === null ? undefined : dateIso(row.revoked_at),
      state: row.state,
    });
  }

  async listActiveProjectPrincipalBindings(): Promise<
    readonly ProjectPrincipalBindingRecord[]
  > {
    const rows = await this.#query<PrincipalBindingRow>(
      `SELECT principal_id, member_id, state, bound_at, revoked_at
         FROM claudian_cloud.project_principal_bindings
        WHERE project_id = $1 AND state = 'active'
        ORDER BY member_id COLLATE "C", principal_id COLLATE "C"`,
      [this.#projectId],
    );
    return Object.freeze(rows.map(row => {
      if (!isCollabMemberId(row.member_id) || row.revoked_at !== null) {
        dependencyFailure();
      }
      return Object.freeze({
        boundAt: dateIso(row.bound_at),
        memberId: row.member_id,
        principalId: row.principal_id,
        revokedAt: undefined,
        state: 'active' as const,
      });
    }));
  }

  async revokeProjectPrincipal(
    input: RevokeProjectPrincipalBindingInput,
  ): Promise<PersistenceAdvanceResult> {
    const canonical = Object.freeze({
      memberId: memberId(input.memberId),
      principalId: principalId(input.principalId),
      revokedAt: timestamp(input.revokedAt),
    });
    const rows = await this.#query<{ readonly principal_id: string }>(
      `UPDATE claudian_cloud.project_principal_bindings
          SET state = 'revoked', revoked_at = $4::timestamptz
        WHERE project_id = $1 AND principal_id = $2 AND member_id = $3
          AND state = 'active'
       RETURNING principal_id`,
      [
        this.#projectId,
        canonical.principalId,
        canonical.memberId,
        canonical.revokedAt,
      ],
    );
    const stored = await this.findProjectPrincipalBinding(canonical.principalId);
    if (
      stored?.memberId !== canonical.memberId
      || stored.state !== 'revoked'
      || stored.revokedAt !== canonical.revokedAt
    ) stateConflict();
    return rows.length === 1 ? 'advanced' : 'replayed';
  }

  async getLeaveProjectRequestFacts(
    operationId: string,
  ): Promise<LeaveProjectRequestFacts | undefined> {
    const canonicalOperationId = opaqueId(operationId);
    const rows = await this.#query<LeaveProjectRequestFactsRow>(
      `SELECT project_id, operation_id, expected_membership_revision,
              expected_manager_set_generation, manager_responsibility_offer_id,
              expected_offer_revision
         FROM claudian_cloud.leave_project_request_facts
        WHERE project_id = $1 AND operation_id = $2`,
      [this.#projectId, canonicalOperationId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const expectedMembershipRevision = Number(row.expected_membership_revision);
    const expectedManagerSetGeneration = Number(row.expected_manager_set_generation);
    const expectedOfferRevision = row.expected_offer_revision === null
      ? null
      : Number(row.expected_offer_revision);
    if (
      !Number.isSafeInteger(expectedMembershipRevision)
      || expectedMembershipRevision < 1
      || !Number.isSafeInteger(expectedManagerSetGeneration)
      || expectedManagerSetGeneration < 1
      || (
        row.manager_responsibility_offer_id === null
          ? expectedOfferRevision !== null
          : !isCollabOpaqueId(row.manager_responsibility_offer_id)
            || expectedOfferRevision === null
            || !Number.isSafeInteger(expectedOfferRevision)
            || expectedOfferRevision < 1
      )
    ) return dependencyFailure();
    return Object.freeze({
      expectedManagerSetGeneration,
      expectedMembershipRevision,
      expectedOfferRevision,
      managerResponsibilityOfferId: row.manager_responsibility_offer_id,
      operationId: row.operation_id,
      projectId: row.project_id,
    });
  }

  async putLeaveProjectRequestFacts(
    input: LeaveProjectRequestFacts,
  ): Promise<PersistencePutResult> {
    if (input.projectId !== this.#projectId) invalidRecord();
    const operationId = opaqueId(input.operationId);
    if (
      !Number.isSafeInteger(input.expectedMembershipRevision)
      || input.expectedMembershipRevision < 1
      || !Number.isSafeInteger(input.expectedManagerSetGeneration)
      || input.expectedManagerSetGeneration < 1
      || (
        input.managerResponsibilityOfferId === null
          ? input.expectedOfferRevision !== null
          : !isCollabOpaqueId(input.managerResponsibilityOfferId)
            || input.expectedOfferRevision === null
            || !Number.isSafeInteger(input.expectedOfferRevision)
            || input.expectedOfferRevision < 1
      )
    ) invalidRecord();
    const journal = await this.getLifecycleJournal(operationId);
    if (journal?.kind !== 'leave') stateConflict();
    const rows = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.leave_project_request_facts (
         project_id, operation_id, expected_membership_revision,
         expected_manager_set_generation, manager_responsibility_offer_id,
         expected_offer_revision
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, operation_id) DO NOTHING
       RETURNING operation_id`,
      [
        this.#projectId,
        operationId,
        input.expectedMembershipRevision,
        input.expectedManagerSetGeneration,
        input.managerResponsibilityOfferId,
        input.expectedOfferRevision,
      ],
    );
    const stored = await this.getLeaveProjectRequestFacts(operationId);
    if (stored === undefined || !isDeepStrictEqual(stored, input)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async putLeaveFormerPrincipalReplay(
    input: LeaveFormerPrincipalReplayInput,
  ): Promise<PersistencePutResult> {
    const createdAt = timestamp(input.createdAt);
    const expiresAt = timestamp(input.expiresAt);
    const canonical = Object.freeze({
      createdAt,
      expectedPersonalRefOid: input.expectedPersonalRefOid,
      expiresAt,
      intentId: opaqueId(input.intentId),
      memberId: memberId(input.memberId),
      operationId: opaqueId(input.operationId),
      principalId: principalId(input.principalId),
      requestFingerprint: sha256(input.requestFingerprint),
      response: collabControlOperationCodec('leaveProject').decodeResponse(
        input.response,
      ),
    });
    if (!isCollabGitOid(canonical.expectedPersonalRefOid)) invalidRecord();
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) invalidRecord();
    const journal = await this.getLifecycleJournal(canonical.operationId);
    if (
      journal?.kind !== 'leave'
      || journal.actorMemberId !== canonical.memberId
      || journal.idempotencyKey !== canonical.intentId
      || journal.requestFingerprint !== canonical.requestFingerprint
    ) stateConflict();
    const principalSha256 = createHash('sha256')
      .update(canonical.principalId)
      .digest('hex');
    const rows = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.leave_former_principal_replays (
         project_id, operation_id, principal_sha256, member_id, intent_id,
         request_fingerprint, expected_personal_ref_oid, state, result_sha256,
         created_at, completed_at, expires_at, response_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'recovering', NULL,
         $8::timestamptz, NULL, $9::timestamptz, $10
       )
       ON CONFLICT DO NOTHING
       RETURNING operation_id`,
      [
        this.#projectId,
        canonical.operationId,
        principalSha256,
        canonical.memberId,
        canonical.intentId,
        canonical.requestFingerprint,
        canonical.expectedPersonalRefOid,
        canonical.createdAt,
        canonical.expiresAt,
        JSON.stringify(canonical.response),
      ],
    );
    const stored = await this.findLeaveFormerPrincipalReplay({
      expectedPersonalRefOid: canonical.expectedPersonalRefOid,
      intentId: canonical.intentId,
      memberId: canonical.memberId,
      operationId: canonical.operationId,
      principalId: canonical.principalId,
      requestFingerprint: canonical.requestFingerprint,
      requestedAt: canonical.createdAt,
    });
    if (
      stored === undefined
      || stored.createdAt !== canonical.createdAt
      || stored.expiresAt !== canonical.expiresAt
      || stored.expectedPersonalRefOid !== canonical.expectedPersonalRefOid
      || !isDeepStrictEqual(stored.response, canonical.response)
      || stored.state !== 'recovering'
    ) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async getLeaveFormerPrincipalReplay(
    operationId: string,
  ): Promise<LeaveFormerPrincipalReplayRecord | undefined> {
    opaqueId(operationId);
    const rows = await this.#query<LeaveFormerPrincipalReplayRow>(
      `SELECT operation_id, member_id, intent_id, state, result_sha256,
              expected_personal_ref_oid, created_at, completed_at, expires_at,
              response_json
         FROM claudian_cloud.leave_former_principal_replays
        WHERE project_id = $1 AND operation_id = $2`,
      [this.#projectId, operationId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (row.state !== 'recovering' && row.state !== 'completed') dependencyFailure();
    return Object.freeze({
      completedAt: row.completed_at === null ? undefined : dateIso(row.completed_at),
      createdAt: dateIso(row.created_at),
      expectedPersonalRefOid: row.expected_personal_ref_oid,
      expiresAt: dateIso(row.expires_at),
      intentId: row.intent_id,
      memberId: memberId(row.member_id),
      operationId: row.operation_id,
      resultSha256: optional(row.result_sha256),
      response: leaveResponse(row.response_json),
      state: row.state,
    });
  }

  async findLeaveFormerPrincipalReplay(
    input: Omit<
      LeaveFormerPrincipalReplayInput,
      'createdAt' | 'expiresAt' | 'response'
    > & {
      readonly requestedAt: CollabIsoTimestamp;
    },
  ): Promise<LeaveFormerPrincipalReplayRecord | undefined> {
    const operationId = opaqueId(input.operationId);
    const requestedMemberId = memberId(input.memberId);
    const intentId = opaqueId(input.intentId);
    const requestedPrincipalId = principalId(input.principalId);
    const requestFingerprint = sha256(input.requestFingerprint);
    if (!isCollabGitOid(input.expectedPersonalRefOid)) invalidRecord();
    const requestedAt = timestamp(input.requestedAt);
    const principalSha256 = createHash('sha256')
      .update(requestedPrincipalId)
      .digest('hex');
    const rows = await this.#query<LeaveFormerPrincipalReplayRow>(
      `SELECT operation_id, member_id, intent_id, state, result_sha256,
              expected_personal_ref_oid, created_at, completed_at, expires_at,
              response_json
         FROM claudian_cloud.leave_former_principal_replays
        WHERE project_id = $1 AND operation_id = $2
          AND principal_sha256 = $3 AND member_id = $4 AND intent_id = $5
          AND request_fingerprint = $6 AND expected_personal_ref_oid = $7
          AND expires_at > $8::timestamptz`,
      [
        this.#projectId,
        operationId,
        principalSha256,
        requestedMemberId,
        intentId,
        requestFingerprint,
        input.expectedPersonalRefOid,
        requestedAt,
      ],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (row.state !== 'recovering' && row.state !== 'completed') dependencyFailure();
    return Object.freeze({
      completedAt: row.completed_at === null ? undefined : dateIso(row.completed_at),
      createdAt: dateIso(row.created_at),
      expiresAt: dateIso(row.expires_at),
      expectedPersonalRefOid: row.expected_personal_ref_oid,
      intentId: row.intent_id,
      memberId: memberId(row.member_id),
      operationId: row.operation_id,
      resultSha256: optional(row.result_sha256),
      response: leaveResponse(row.response_json),
      state: row.state,
    });
  }

  async completeLeaveFormerPrincipalReplay(
    input: CompleteLeaveFormerPrincipalReplayInput,
  ): Promise<PersistenceAdvanceResult> {
    const completedAt = timestamp(input.completedAt);
    const resultSha256 = sha256(input.resultSha256);
    const exact = {
      intentId: opaqueId(input.intentId),
      memberId: memberId(input.memberId),
      operationId: opaqueId(input.operationId),
      principalId: principalId(input.principalId),
      requestFingerprint: sha256(input.requestFingerprint),
    };
    if (!isCollabGitOid(input.expectedPersonalRefOid)) invalidRecord();
    const principalSha256 = createHash('sha256')
      .update(exact.principalId)
      .digest('hex');
    const rows = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.leave_former_principal_replays
          SET state = 'completed', result_sha256 = $8,
              completed_at = $9::timestamptz
        WHERE project_id = $1 AND operation_id = $2
          AND principal_sha256 = $3 AND member_id = $4 AND intent_id = $5
          AND request_fingerprint = $6 AND expected_personal_ref_oid = $7
          AND state = 'recovering' AND expires_at > $9::timestamptz
       RETURNING operation_id`,
      [
        this.#projectId,
        exact.operationId,
        principalSha256,
        exact.memberId,
        exact.intentId,
        exact.requestFingerprint,
        input.expectedPersonalRefOid,
        resultSha256,
        completedAt,
      ],
    );
    const stored = await this.findLeaveFormerPrincipalReplay({
      ...exact,
      expectedPersonalRefOid: input.expectedPersonalRefOid,
      requestedAt: completedAt,
    });
    if (
      stored?.state !== 'completed'
      || stored.resultSha256 !== resultSha256
      || stored.completedAt !== completedAt
    ) stateConflict();
    return rows.length === 1 ? 'advanced' : 'replayed';
  }

  async completeLeaveFormerPrincipalReplayRecovery(
    input: CompleteLeaveFormerPrincipalReplayRecoveryInput,
  ): Promise<PersistenceAdvanceResult> {
    const operationId = opaqueId(input.operationId);
    const completedAt = timestamp(input.completedAt);
    const resultSha256 = sha256(input.resultSha256);
    const rows = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.leave_former_principal_replays
          SET state = 'completed', result_sha256 = $3,
              completed_at = $4::timestamptz
        WHERE project_id = $1 AND operation_id = $2 AND state = 'recovering'
       RETURNING operation_id`,
      [this.#projectId, operationId, resultSha256, completedAt],
    );
    const stored = await this.getLeaveFormerPrincipalReplay(operationId);
    if (
      stored?.state !== 'completed'
      || stored.resultSha256 !== resultSha256
      || stored.completedAt !== completedAt
    ) stateConflict();
    return rows.length === 1 ? 'advanced' : 'replayed';
  }

  async settleLeaveMembership(
    input: SettleLeaveMembershipInput,
  ): Promise<SettleLeaveMembershipResult> {
    const operationId = opaqueId(input.operationId);
    const requestedMemberId = memberId(input.memberId);
    const leftAt = timestamp(input.leftAt);
    if (
      input.expectedMembershipRevision < 1n
      || !Number.isSafeInteger(input.expectedManagerSetGeneration)
      || input.expectedManagerSetGeneration < 1
      || (
        input.managerResponsibilityOfferId === null
          ? input.expectedOfferRevision !== null
          : !isCollabOpaqueId(input.managerResponsibilityOfferId)
            || input.expectedOfferRevision === null
            || !Number.isSafeInteger(input.expectedOfferRevision)
            || input.expectedOfferRevision < 1
      )
    ) invalidRecord();
    const journal = await this.getLifecycleJournal(operationId);
    if (
      journal?.kind !== 'leave'
      || journal.actorMemberId !== requestedMemberId
      || journal.state !== 'active'
      || (journal.phase !== 'prepared' && journal.phase !== 'membership-left')
    ) stateConflict();
    if (journal.phase === 'membership-left') {
      const replay = await this.getLeaveFormerPrincipalReplay(operationId);
      return replay === undefined
        ? dependencyFailure()
        : { response: replay.response, status: 'replayed' };
    }
    const projects = await this.#query<{
      readonly manager_set_generation: string;
    }>(
      `SELECT manager_set_generation
         FROM claudian_cloud.projects
        WHERE project_id = $1
        FOR UPDATE`,
      [this.#projectId],
    );
    if (
      Number(projects[0]?.manager_set_generation)
      !== input.expectedManagerSetGeneration
    ) return { status: 'stale' };
    const rows = await this.#query<{
      readonly left_at: Date | null;
      readonly revision: string;
      readonly role: string;
      readonly status: string;
    }>(
      `SELECT role, status, revision, left_at
         FROM claudian_cloud.project_memberships
        WHERE project_id = $1 AND member_id = $2
        FOR UPDATE`,
      [this.#projectId, requestedMemberId],
    );
    const membership = rows[0];
    if (membership === undefined) stateConflict();
    if (
      membership.status !== 'active'
      || BigInt(membership.revision) !== input.expectedMembershipRevision
      || (membership.role !== 'manager' && membership.role !== 'member')
      || membership.left_at !== null
    ) return { status: 'stale' };
    let activeManagerCount = 0n;
    if (membership.role === 'manager') {
      const managers = await this.#query<{ readonly manager_count: string }>(
        `SELECT count(*)::text AS manager_count
           FROM claudian_cloud.project_memberships
          WHERE project_id = $1 AND role = 'manager' AND status = 'active'`,
        [this.#projectId],
      );
      if (managers[0] === undefined || BigInt(managers[0].manager_count) < 1n) {
        return dependencyFailure();
      }
      activeManagerCount = BigInt(managers[0].manager_count);
    }
    let promotedSuccessorMemberId: string | null = null;
    if (membership.role === 'member') {
      if (
        input.managerResponsibilityOfferId !== null
        || input.expectedOfferRevision !== null
      ) return { status: 'stale' };
    } else if (activeManagerCount > 1n) {
      if (
        input.managerResponsibilityOfferId !== null
        || input.expectedOfferRevision !== null
      ) return { status: 'stale' };
    } else {
      if (
        input.managerResponsibilityOfferId === null
        || input.expectedOfferRevision === null
      ) return { status: 'last-manager' };
      const offers = await this.#query<{
        readonly expires_at: Date;
        readonly manager_set_generation_at_offer: string;
        readonly purpose: string;
        readonly revision: string;
        readonly source_manager_member_id: string;
        readonly state: string;
        readonly target_member_id: string;
        readonly target_membership_revision_at_offer: string;
      }>(
        `SELECT source_manager_member_id, target_member_id, purpose, state,
                revision, manager_set_generation_at_offer,
                target_membership_revision_at_offer, expires_at
           FROM claudian_cloud.manager_responsibility_offers
          WHERE project_id = $1 AND offer_id = $2
          FOR UPDATE`,
        [this.#projectId, input.managerResponsibilityOfferId],
      );
      const offer = offers[0];
      if (
        offer === undefined
        || offer.source_manager_member_id !== requestedMemberId
        || offer.purpose !== 'manager-leave'
        || offer.state !== 'acknowledged'
        || Number(offer.revision) !== input.expectedOfferRevision
        || Number(offer.manager_set_generation_at_offer)
          !== input.expectedManagerSetGeneration
        || Date.parse(dateIso(offer.expires_at)) <= Date.parse(leftAt)
      ) return { status: 'last-manager' };
      const successors = await this.#query<{
        readonly revision: string;
        readonly role: string;
        readonly status: string;
      }>(
        `SELECT role, status, revision
           FROM claudian_cloud.project_memberships
          WHERE project_id = $1 AND member_id = $2
          FOR UPDATE`,
        [this.#projectId, offer.target_member_id],
      );
      const successor = successors[0];
      if (
        successor?.status !== 'active'
        || successor.role !== 'member'
        || successor.revision !== offer.target_membership_revision_at_offer
      ) return { status: 'last-manager' };
      const promoted = await this.#query<{ readonly member_id: string }>(
        `UPDATE claudian_cloud.project_memberships
            SET role = 'manager', revision = revision + 1,
                updated_at = $3::timestamptz
          WHERE project_id = $1 AND member_id = $2 AND status = 'active'
            AND role = 'member' AND revision = $4
         RETURNING member_id`,
        [
          this.#projectId,
          offer.target_member_id,
          leftAt,
          offer.target_membership_revision_at_offer,
        ],
      );
      if (promoted.length !== 1) return { status: 'stale' };
      promotedSuccessorMemberId = offer.target_member_id;
      const consumed = await this.#query<{ readonly offer_id: string }>(
        `UPDATE claudian_cloud.manager_responsibility_offers
            SET state = 'consumed', revision = revision + 1,
                terminal_at = $3::timestamptz
          WHERE project_id = $1 AND offer_id = $2 AND state = 'acknowledged'
            AND revision = $4
         RETURNING offer_id`,
        [
          this.#projectId,
          input.managerResponsibilityOfferId,
          leftAt,
          input.expectedOfferRevision,
        ],
      );
      if (consumed.length !== 1) return dependencyFailure();
    }
    const openRequests = await this.#query<{ readonly request_id: string }>(
      `SELECT request_id FROM claudian_cloud.change_requests
        WHERE project_id = $1 AND member_id = $2 AND status = 'open'
        FOR UPDATE`,
      [this.#projectId, requestedMemberId],
    );
    if (openRequests.length > 1) return dependencyFailure();
    const nextManagerSetGeneration = input.expectedManagerSetGeneration
      + (membership.role === 'manager' ? 1 : 0);
    if (membership.role === 'manager') {
      const projectUpdated = await this.#query<{ readonly project_id: string }>(
        `UPDATE claudian_cloud.projects
            SET manager_set_generation = manager_set_generation + 1
          WHERE project_id = $1 AND manager_set_generation = $2
         RETURNING project_id`,
        [this.#projectId, input.expectedManagerSetGeneration],
      );
      if (projectUpdated.length !== 1) return { status: 'stale' };
    }
    const updated = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.project_memberships
          SET status = 'left', revision = revision + 1,
              left_at = $4::timestamptz, updated_at = $4::timestamptz
        WHERE project_id = $1 AND member_id = $2 AND status = 'active'
          AND revision = $3
       RETURNING member_id`,
      [
        this.#projectId,
        requestedMemberId,
        input.expectedMembershipRevision.toString(),
        leftAt,
      ],
    );
    if (updated.length !== 1) stateConflict();
    await this.#query(
      `UPDATE claudian_cloud.project_principal_bindings
          SET state = 'revoked', revoked_at = $3::timestamptz
        WHERE project_id = $1 AND member_id = $2 AND state IN ('active', 'pending')`,
      [this.#projectId, requestedMemberId, leftAt],
    );
    await this.#query(
      `DELETE FROM claudian_cloud.source_protected_claim_envelopes
        WHERE project_id = $1 AND member_id = $2`,
      [this.#projectId, requestedMemberId],
    );
    await this.#query(
      `DELETE FROM claudian_cloud.protected_claim_override_envelopes
        WHERE project_id = $1 AND member_id = $2`,
      [this.#projectId, requestedMemberId],
    );
    await this.#query(
      `UPDATE claudian_cloud.transferred_membership_claims
          SET state = 'revoked', target_principal_id = NULL,
              operation_intent_id = NULL, redemption_receipt_id = NULL,
              updated_at = $3::timestamptz
        WHERE project_id = $1 AND member_id = $2
          AND state IN ('unclaimed', 'redeemed')`,
      [this.#projectId, requestedMemberId, leftAt],
    );
    await this.#query(
      `UPDATE claudian_cloud.transferred_membership_claim_overrides
          SET state = 'revoked', target_principal_id = NULL,
              operation_intent_id = NULL, redemption_receipt_id = NULL,
              updated_at = $3::timestamptz
        WHERE project_id = $1 AND member_id = $2
          AND state IN ('active', 'redeemed')`,
      [this.#projectId, requestedMemberId, leftAt],
    );
    await this.#query(
      `UPDATE claudian_cloud.change_requests
          SET status = 'discarded', revision = revision + 1,
              updated_at = $3::timestamptz
        WHERE project_id = $1 AND member_id = $2 AND status = 'open'`,
      [this.#projectId, requestedMemberId, leftAt],
    );
    await this.#query(
      `DELETE FROM claudian_cloud.ticket_mentions
        WHERE project_id = $1 AND mentioned_member_id = $2`,
      [this.#projectId, requestedMemberId],
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
        requestedMemberId,
        leftAt,
        membership.role === 'manager' ? input.expectedManagerSetGeneration : -1,
      ],
    );
    const response = collabControlOperationCodec('leaveProject').decodeResponse({
      discardedRequestId: openRequests[0]?.request_id ?? null,
      leftAt,
      managerSetGeneration: nextManagerSetGeneration,
      memberId: requestedMemberId,
      projectId: this.#projectId,
      promotedSuccessorMemberId,
      status: 'left',
    });
    return { response, status: 'settled' };
  }

  async putAuthorityTransferRecovery(
    input: AuthorityTransferRecoveryInput,
  ): Promise<PersistencePutResult> {
    const canonical = this.#canonicalAuthorityTransferRecovery(input);
    const journal = await this.getLifecycleJournal(canonical.transferId);
    const direction = canonical.sourceAuthority.kind === 'lan'
      ? 'lan-to-cloud'
      : 'cloud-to-lan';
    if (
      journal?.kind !== 'authority-transfer'
      || journal.direction !== direction
      || journal.expectedAuthorityGeneration !== canonical.sourceAuthority.generation
      || journal.createdAt !== canonical.createdAt
    ) stateConflict();
    const rows = await this.#query<{ readonly transfer_id: string }>(
      `INSERT INTO claudian_cloud.authority_transfer_recovery (
         project_id, transfer_id, source_authority_kind,
         source_authority_generation, target_authority_kind,
         target_authority_generation, source_host_member_id,
         target_host_member_id, target_url, expires_at, source_proof,
         target_proof, stage_sha256, target_activation_proof,
         relinquishment_proof_json, cancellation_request_sha256,
         source_reopen_sha256, inactive_publication_json,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         $11::timestamptz, $11::timestamptz
       )
       ON CONFLICT (project_id, transfer_id) DO NOTHING
       RETURNING transfer_id`,
      [
        this.#projectId,
        canonical.transferId,
        canonical.sourceAuthority.kind,
        canonical.sourceAuthority.generation,
        canonical.targetAuthority.kind,
        canonical.targetAuthority.generation,
        canonical.sourceHostMemberId ?? null,
        canonical.targetHostMemberId ?? null,
        canonical.targetUrl,
        canonical.expiresAt,
        canonical.createdAt,
      ],
    );
    const stored = await this.getAuthorityTransferRecovery(canonical.transferId);
    const expected: AuthorityTransferRecoveryRecord = Object.freeze({
      ...canonical,
      cancellationRequestSha256: undefined,
      inactivePublicationJson: undefined,
      relinquishmentProof: undefined,
      sourceProof: undefined,
      sourceReopenSha256: undefined,
      stageSha256: undefined,
      targetActivationProof: undefined,
      targetActivationRequestSha256: undefined,
      targetProof: undefined,
      updatedAt: canonical.createdAt,
    });
    if (stored === undefined || !isDeepStrictEqual(stored, expected)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async getAuthorityTransferRecovery(
    transferId: string,
  ): Promise<AuthorityTransferRecoveryRecord | undefined> {
    opaqueId(transferId);
    const rows = await this.#query<AuthorityTransferRecoveryRow>(
      `SELECT transfer_id, source_authority_kind,
              source_authority_generation, target_authority_kind,
              target_authority_generation, source_host_member_id,
              target_host_member_id, target_url, expires_at, source_proof,
              target_proof, stage_sha256, target_activation_proof,
              target_activation_request_sha256,
              relinquishment_proof_json, cancellation_request_sha256,
              source_reopen_sha256, inactive_publication_json,
              created_at, updated_at
         FROM claudian_cloud.authority_transfer_recovery
        WHERE project_id = $1 AND transfer_id = $2`,
      [this.#projectId, transferId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    let relinquishmentProof: CollabAuthorityRelinquishmentProof | undefined;
    try {
      relinquishmentProof = row.relinquishment_proof_json === null
        ? undefined
        : decodeCollabAuthorityRelinquishmentProof(
          JSON.parse(row.relinquishment_proof_json),
        );
    } catch {
      dependencyFailure();
    }
    return Object.freeze({
      cancellationRequestSha256: optional(row.cancellation_request_sha256),
      createdAt: dateIso(row.created_at),
      expiresAt: dateIso(row.expires_at),
      inactivePublicationJson: optional(row.inactive_publication_json),
      relinquishmentProof,
      sourceAuthority: checkpointAuthority({
        generation: databasePositiveInteger(row.source_authority_generation),
        kind: row.source_authority_kind as CollabCheckpointAuthority['kind'],
      }),
      sourceHostMemberId: row.source_host_member_id === null
        ? undefined
        : memberId(row.source_host_member_id),
      sourceProof: optional(row.source_proof),
      sourceReopenSha256: optional(row.source_reopen_sha256),
      stageSha256: optional(row.stage_sha256),
      targetActivationProof: optional(row.target_activation_proof),
      targetActivationRequestSha256: optional(
        row.target_activation_request_sha256,
      ),
      targetAuthority: checkpointAuthority({
        generation: databasePositiveInteger(row.target_authority_generation),
        kind: row.target_authority_kind as CollabCheckpointAuthority['kind'],
      }),
      targetHostMemberId: row.target_host_member_id === null
        ? undefined
        : memberId(row.target_host_member_id),
      targetProof: optional(row.target_proof),
      targetUrl: row.target_url,
      transferId: row.transfer_id,
      updatedAt: dateIso(row.updated_at),
    });
  }

  async advanceAuthorityTransferRecoveryEvidence(
    input: AuthorityTransferRecoveryEvidenceInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.transferId);
    const expectedUpdatedAt = timestamp(input.expectedUpdatedAt);
    const updatedAt = timestamp(input.updatedAt);
    if (Date.parse(updatedAt) <= Date.parse(expectedUpdatedAt)) invalidRecord();
    const sourceProof = input.sourceProof === undefined
      ? undefined
      : boundedProof(input.sourceProof);
    const cancellationRequestSha256 = input.cancellationRequestSha256 === undefined
      ? undefined
      : sha256(input.cancellationRequestSha256);
    const sourceReopenSha256 = input.sourceReopenSha256 === undefined
      ? undefined
      : sha256(input.sourceReopenSha256);
    const inactivePublicationJson = input.inactivePublicationJson === undefined
      ? undefined
      : boundedPublicationJson(input.inactivePublicationJson);
    const targetProof = input.targetProof === undefined
      ? undefined
      : boundedProof(input.targetProof);
    const targetActivationProof = input.targetActivationProof === undefined
      ? undefined
      : boundedProof(input.targetActivationProof);
    const targetActivationRequestSha256 = input.targetActivationRequestSha256
      === undefined
      ? undefined
      : sha256(input.targetActivationRequestSha256);
    const stageSha256 = input.stageSha256 === undefined
      ? undefined
      : sha256(input.stageSha256);
    const relinquishmentProof = input.relinquishmentProof === undefined
      ? undefined
      : decodedRelinquishmentProof(input.relinquishmentProof);
    const nextExpiresAt = input.nextExpiresAt === undefined
      ? undefined
      : timestamp(input.nextExpiresAt);
    if (
      sourceProof === undefined
      && cancellationRequestSha256 === undefined
      && sourceReopenSha256 === undefined
      && inactivePublicationJson === undefined
      && targetProof === undefined
      && targetActivationProof === undefined
      && targetActivationRequestSha256 === undefined
      && stageSha256 === undefined
      && relinquishmentProof === undefined
      && nextExpiresAt === undefined
    ) invalidRecord();
    const current = await this.getAuthorityTransferRecovery(input.transferId);
    if (current === undefined) stateConflict();
    if (
      nextExpiresAt !== undefined
      && (
        Date.parse(nextExpiresAt) <= Date.parse(current.expiresAt)
        || Date.parse(nextExpiresAt) <= Date.parse(updatedAt)
      )
    ) invalidRecord();
    if (relinquishmentProof !== undefined) {
      const journal = await this.getLifecycleJournal(input.transferId);
      if (
        journal?.kind !== 'authority-transfer'
        || relinquishmentProof.projectId !== this.#projectId
        || relinquishmentProof.transferId !== input.transferId
        || !isDeepStrictEqual(relinquishmentProof.sourceAuthority, current.sourceAuthority)
        || !isDeepStrictEqual(relinquishmentProof.targetAuthority, current.targetAuthority)
        || relinquishmentProof.checkpointSha256 !== journal.checkpointSha256
        || relinquishmentProof.batchRevision !== journal.batchRevision
        || relinquishmentProof.batchSha256 !== journal.batchSha256
        || relinquishmentProof.sourceHostMemberId
          !== (current.sourceHostMemberId ?? null)
      ) invalidRecord();
    }
    const canonicalProofJson = relinquishmentProof === undefined
      ? undefined
      : JSON.stringify(relinquishmentProof);
    const rows = await this.#query<{ readonly transfer_id: string }>(
      `UPDATE claudian_cloud.authority_transfer_recovery
          SET source_proof = COALESCE(source_proof, $4),
              target_proof = COALESCE(target_proof, $5),
              stage_sha256 = COALESCE(stage_sha256, $6),
              target_activation_proof = COALESCE(target_activation_proof, $7),
              relinquishment_proof_json = COALESCE(relinquishment_proof_json, $8),
              cancellation_request_sha256 = COALESCE(
                cancellation_request_sha256,
                $9
              ),
              source_reopen_sha256 = COALESCE(source_reopen_sha256, $10),
              inactive_publication_json = COALESCE(
                inactive_publication_json,
                $11
              ),
              expires_at = COALESCE($12::timestamptz, expires_at),
              target_activation_request_sha256 = COALESCE(
                target_activation_request_sha256,
                $13
              ),
              updated_at = $14::timestamptz
        WHERE project_id = $1 AND transfer_id = $2
          AND updated_at = $3::timestamptz
          AND ($4::text IS NULL OR source_proof IS NULL OR source_proof = $4)
          AND ($5::text IS NULL OR target_proof IS NULL OR target_proof = $5)
          AND ($6::char(64) IS NULL OR stage_sha256 IS NULL OR stage_sha256 = $6)
          AND (
            $7::text IS NULL
            OR target_activation_proof IS NULL
            OR target_activation_proof = $7
          )
          AND (
            $8::text IS NULL
            OR relinquishment_proof_json IS NULL
            OR relinquishment_proof_json = $8
          )
          AND (
            $9::char(64) IS NULL
            OR cancellation_request_sha256 IS NULL
            OR cancellation_request_sha256 = $9
          )
          AND (
            $10::char(64) IS NULL
            OR source_reopen_sha256 IS NULL
            OR source_reopen_sha256 = $10
          )
          AND (
            $11::text IS NULL
            OR inactive_publication_json IS NULL
            OR inactive_publication_json = $11
          )
          AND ($12::timestamptz IS NULL OR expires_at < $12::timestamptz)
          AND (
            $13::char(64) IS NULL
            OR target_activation_request_sha256 IS NULL
            OR target_activation_request_sha256 = $13
          )
       RETURNING transfer_id`,
      [
        this.#projectId,
        input.transferId,
        expectedUpdatedAt,
        sourceProof ?? null,
        targetProof ?? null,
        stageSha256 ?? null,
        targetActivationProof ?? null,
        canonicalProofJson ?? null,
        cancellationRequestSha256 ?? null,
        sourceReopenSha256 ?? null,
        inactivePublicationJson ?? null,
        nextExpiresAt ?? null,
        targetActivationRequestSha256 ?? null,
        updatedAt,
      ],
    );
    const stored = await this.getAuthorityTransferRecovery(input.transferId);
    const expected: AuthorityTransferRecoveryRecord = Object.freeze({
      ...current,
      cancellationRequestSha256: cancellationRequestSha256
        ?? current.cancellationRequestSha256,
      inactivePublicationJson: inactivePublicationJson
        ?? current.inactivePublicationJson,
      expiresAt: nextExpiresAt ?? current.expiresAt,
      relinquishmentProof: relinquishmentProof ?? current.relinquishmentProof,
      sourceProof: sourceProof ?? current.sourceProof,
      sourceReopenSha256: sourceReopenSha256 ?? current.sourceReopenSha256,
      stageSha256: stageSha256 ?? current.stageSha256,
      targetActivationProof: targetActivationProof ?? current.targetActivationProof,
      targetActivationRequestSha256: targetActivationRequestSha256
        ?? current.targetActivationRequestSha256,
      targetProof: targetProof ?? current.targetProof,
      updatedAt,
    });
    if (stored === undefined || !isDeepStrictEqual(stored, expected)) stateConflict();
    return rows.length === 1 ? 'advanced' : 'replayed';
  }

  async getAuthorityTransferStatus(
    transferId: string,
  ): Promise<CollabAuthorityTransferStatus | undefined> {
    const [journal, recovery] = await Promise.all([
      this.getLifecycleJournal(transferId),
      this.getAuthorityTransferRecovery(transferId),
    ]);
    if (journal === undefined && recovery === undefined) return undefined;
    if (
      journal?.kind === 'authority-transfer'
      && journal.state === 'completed'
      && recovery === undefined
    ) {
      if (await this.getTerminalResponder('authority-transfer', transferId) === undefined) {
        dependencyFailure();
      }
      return undefined;
    }
    if (journal?.kind !== 'authority-transfer' || recovery === undefined) {
      dependencyFailure();
    }
    try {
      return decodeCollabAuthorityTransferStatus({
        batchRevision: journal.batchRevision ?? null,
        batchSha256: journal.batchSha256 ?? null,
        checkpointSha256: journal.checkpointSha256 ?? null,
        createdAt: recovery.createdAt,
        direction: journal.direction,
        expiresAt: recovery.expiresAt,
        phase: journal.phase,
        projectId: this.#projectId,
        relinquishmentProof: recovery.relinquishmentProof ?? null,
        sourceAuthority: recovery.sourceAuthority,
        state: journal.state === 'cancelled' || journal.state === 'completed'
          ? journal.state
          : 'active',
        targetAuthority: recovery.targetAuthority,
        targetUrl: recovery.targetUrl,
        transferId,
        updatedAt: journal.updatedAt,
      });
    } catch {
      dependencyFailure();
    }
  }

  async putTransferredMembershipClaim(
    input: TransferredMembershipClaimInput,
  ): Promise<PersistencePutResult> {
    const canonical = canonicalClaim(input);
    if (canonical.batchRevision !== 1) invalidRecord();
    const journal = await this.getLifecycleJournal(canonical.transferId);
    if (
      journal?.kind !== 'authority-transfer'
      || journal.batchRevision !== canonical.batchRevision
      || journal.checkpointSha256 !== canonical.checkpointSha256
      || journal.batchSha256 === undefined
    ) stateConflict();
    const existing = await this.getTransferredMembershipClaim(
      canonical.transferId,
      canonical.memberId,
    );
    const expected: TransferredMembershipClaimRecord = {
      ...canonical,
      operationIntentId: undefined,
      redemptionReceiptId: undefined,
      state: 'unclaimed',
      targetPrincipalId: undefined,
      updatedAt: canonical.createdAt,
    };
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, expected)) stateConflict();
      return 'replayed';
    }
    const rows = await this.#query<{ readonly member_id: string }>(
      `INSERT INTO claudian_cloud.transferred_membership_claims (
         project_id, transfer_id, member_id, batch_revision,
         checkpoint_sha256, claim_sha256, state, target_principal_id,
         operation_intent_id, redemption_receipt_id, expires_at,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'unclaimed', NULL, NULL, NULL,
         $7::timestamptz, $8::timestamptz, $8::timestamptz
       )
       ON CONFLICT (project_id, transfer_id, batch_revision, member_id) DO NOTHING
       RETURNING member_id`,
      [
        this.#projectId,
        canonical.transferId,
        canonical.memberId,
        canonical.batchRevision,
        canonical.checkpointSha256,
        canonical.claimSha256,
        canonical.expiresAt,
        canonical.createdAt,
      ],
    );
    const stored = await this.getTransferredMembershipClaim(
      canonical.transferId,
      canonical.memberId,
    );
    if (stored === undefined || !isDeepStrictEqual(stored, expected)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async removeTerminalResponder(
    input: RemoveTerminalResponderInput,
  ): Promise<PersistenceAdvanceResult> {
    if (!TERMINAL_OPERATION_KINDS.has(input.operationKind)) invalidRecord();
    opaqueId(input.operationId);
    const expectedExpiresAt = timestamp(input.expectedExpiresAt);
    const removedAt = timestamp(input.removedAt);
    const responder = await this.getTerminalResponder(
      input.operationKind,
      input.operationId,
    );
    if (responder === undefined) {
      const catalog = await this.#query<{ readonly operation_id: string }>(
        `SELECT operation_id
           FROM claudian_cloud.project_terminal_responder_catalog
          WHERE project_id = $1 AND operation_kind = $2 AND operation_id = $3`,
        [this.#projectId, input.operationKind, input.operationId],
      );
      if (catalog.length !== 0) dependencyFailure();
      return 'replayed';
    }
    if (responder.expiresAt !== expectedExpiresAt) stateConflict();
    const allAcknowledged = responder.eligiblePrincipals.every(principal => (
      responder.acknowledgements.some(acknowledgement => (
        acknowledgement.memberId === principal.memberId
        && acknowledgement.principalId === principal.principalId
      ))
    ));
    if (!allAcknowledged && Date.parse(removedAt) < Date.parse(expectedExpiresAt)) {
      stateConflict();
    }
    const rows = await this.#query<{ readonly operation_id: string }>(
      `DELETE FROM claudian_cloud.project_terminal_responders
        WHERE project_id = $1 AND operation_kind = $2 AND operation_id = $3
          AND expires_at = $4::timestamptz
          AND (
            $5::timestamptz >= expires_at
            OR NOT EXISTS (
              SELECT 1
                FROM claudian_cloud.project_terminal_acknowledgements AS ack
               WHERE ack.project_id = project_terminal_responders.project_id
                 AND ack.operation_kind = project_terminal_responders.operation_kind
                 AND ack.operation_id = project_terminal_responders.operation_id
                 AND ack.acknowledged_at IS NULL
            )
          )
       RETURNING operation_id`,
      [
        this.#projectId,
        input.operationKind,
        input.operationId,
        expectedExpiresAt,
        removedAt,
      ],
    );
    if (rows.length !== 1) stateConflict();
    return 'advanced';
  }

  async cleanupTerminalArtifacts(
    input: CleanupTerminalArtifactsInput,
  ): Promise<PersistenceAdvanceResult> {
    if (!TERMINAL_OPERATION_KINDS.has(input.operationKind)) invalidRecord();
    const operationId = opaqueId(input.operationId);
    if (
      await this.getTerminalResponder(input.operationKind, operationId)
      !== undefined
    ) stateConflict();
    const tombstone = await this.getProjectTombstone();
    if (
      tombstone?.terminalOperationKind !== input.operationKind
      || tombstone.terminalOperationId !== operationId
    ) stateConflict();
    if (input.operationKind === 'retire') return 'replayed';
    const before = await this.#query<{ readonly row_count: string }>(
      `SELECT (
         (SELECT count(*) FROM claudian_cloud.source_protected_claim_envelopes
           WHERE project_id = $1 AND transfer_id = $2)
         + (SELECT count(*) FROM claudian_cloud.transfer_redemption_receipts
           WHERE project_id = $1 AND transfer_id = $2)
         + (SELECT count(*) FROM claudian_cloud.transfer_receipt_keys
           WHERE project_id = $1 AND transfer_id = $2)
       )::text AS row_count`,
      [this.#projectId, operationId],
    );
    await this.#query(
      `DELETE FROM claudian_cloud.source_protected_claim_envelopes
        WHERE project_id = $1 AND transfer_id = $2`,
      [this.#projectId, operationId],
    );
    await this.#query(
      `DELETE FROM claudian_cloud.transfer_redemption_receipts
        WHERE project_id = $1 AND transfer_id = $2`,
      [this.#projectId, operationId],
    );
    await this.#query(
      `DELETE FROM claudian_cloud.transfer_receipt_keys
        WHERE project_id = $1 AND transfer_id = $2`,
      [this.#projectId, operationId],
    );
    return before[0]?.row_count === '0' ? 'replayed' : 'advanced';
  }

  async getTransferredMembershipClaim(
    transferId: string,
    requestedMemberId: CollabMemberId,
  ): Promise<TransferredMembershipClaimRecord | undefined> {
    opaqueId(transferId);
    memberId(requestedMemberId);
    const rows = await this.#query<ClaimRow>(
      `SELECT transfer_id, member_id, batch_revision, checkpoint_sha256,
              claim_sha256, state, target_principal_id, operation_intent_id,
              redemption_receipt_id, expires_at, created_at, updated_at
        FROM claudian_cloud.transferred_membership_claims
        WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3
        ORDER BY batch_revision DESC
        LIMIT 1`,
      [this.#projectId, transferId, requestedMemberId],
    );
    return rows[0] === undefined ? undefined : transferredClaim(rows[0]);
  }

  async findTransferredMembershipClaimBySha256(
    transferId: string,
    requestedClaimSha256: string,
  ): Promise<TransferredMembershipClaimRecord | undefined> {
    opaqueId(transferId);
    sha256(requestedClaimSha256);
    const rows = await this.#query<ClaimRow>(
      `SELECT transfer_id, member_id, batch_revision, checkpoint_sha256,
              claim_sha256, state, target_principal_id, operation_intent_id,
              redemption_receipt_id, expires_at, created_at, updated_at
         FROM claudian_cloud.transferred_membership_claims
        WHERE project_id = $1 AND transfer_id = $2 AND claim_sha256 = $3`,
      [this.#projectId, transferId, requestedClaimSha256],
    );
    if (rows.length > 1) dependencyFailure();
    return rows[0] === undefined ? undefined : transferredClaim(rows[0]);
  }

  async rotateTransferredMembershipClaims(
    input: RotateTransferredMembershipClaimsInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.transferId);
    positiveInteger(input.expectedBatchRevision);
    positiveInteger(input.nextBatchRevision);
    sha256(input.expectedBatchSha256);
    sha256(input.nextBatchSha256);
    sha256(input.checkpointSha256);
    const rotatedAt = timestamp(input.rotatedAt);
    const scheduledAt = timestamp(input.scheduledAt);
    if (input.nextBatchRevision !== input.expectedBatchRevision + 1) {
      invalidRecord();
    }
    const replacements = [...input.replacements]
      .map(value => Object.freeze({
        claimSha256: sha256(value.claimSha256),
        expiresAt: timestamp(value.expiresAt),
        memberId: memberId(value.memberId),
      }))
      .sort((left, right) => compareMemberIds(left.memberId, right.memberId));
    if (
      replacements.length === 0
      || new Set(replacements.map(value => value.memberId)).size !== replacements.length
      || new Set(replacements.map(value => value.claimSha256)).size !== replacements.length
      || replacements.some(value => Date.parse(value.expiresAt) <= Date.parse(rotatedAt))
    ) invalidRecord();

    const journal = await this.getLifecycleJournal(input.transferId);
    if (journal?.kind !== 'authority-transfer') stateConflict();
    if (
      journal.batchRevision === input.nextBatchRevision
      && journal.batchSha256 === input.nextBatchSha256
      && journal.checkpointSha256 === input.checkpointSha256
    ) {
      const nextClaims = await this.#listClaims(
        input.transferId,
        input.nextBatchRevision,
      );
      const previousClaims = await this.#listClaims(
        input.transferId,
        input.expectedBatchRevision,
      );
      const expectedNext = replacements.map(value => Object.freeze({
        batchRevision: input.nextBatchRevision,
        checkpointSha256: input.checkpointSha256,
        claimSha256: value.claimSha256,
        createdAt: rotatedAt,
        expiresAt: value.expiresAt,
        memberId: value.memberId,
        operationIntentId: undefined,
        redemptionReceiptId: undefined,
        state: 'unclaimed' as const,
        targetPrincipalId: undefined,
        transferId: input.transferId,
        updatedAt: rotatedAt,
      }));
      if (
        !isDeepStrictEqual(nextClaims, expectedNext)
        || previousClaims.length !== replacements.length
        || previousClaims.some(value => (
          value.state !== 'revoked'
          || value.updatedAt !== rotatedAt
        ))
      ) stateConflict();
      return 'replayed';
    }
    if (
      journal.batchRevision !== input.expectedBatchRevision
      || journal.batchSha256 !== input.expectedBatchSha256
      || journal.checkpointSha256 !== input.checkpointSha256
      || (journal.state !== 'active' && journal.state !== 'recovery-required')
      || await this.getTransferClaimBatchReceipt(input.transferId) !== undefined
    ) stateConflict();

    const currentClaims = await this.#listClaims(
      input.transferId,
      input.expectedBatchRevision,
    );
    if (
      currentClaims.length !== replacements.length
      || currentClaims.some((value, index) => (
        value.memberId !== replacements[index]?.memberId
        || value.checkpointSha256 !== input.checkpointSha256
        || value.state !== 'unclaimed'
      ))
    ) stateConflict();
    const revoked = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.transferred_membership_claims
          SET state = 'revoked', updated_at = $4::timestamptz
        WHERE project_id = $1 AND transfer_id = $2 AND batch_revision = $3
          AND state = 'unclaimed'
       RETURNING member_id`,
      [
        this.#projectId,
        input.transferId,
        input.expectedBatchRevision,
        rotatedAt,
      ],
    );
    if (revoked.length !== currentClaims.length) stateConflict();
    for (const replacement of replacements) {
      const inserted = await this.#query<{ readonly member_id: string }>(
        `INSERT INTO claudian_cloud.transferred_membership_claims (
           project_id, transfer_id, member_id, batch_revision,
           checkpoint_sha256, claim_sha256, state, target_principal_id,
           operation_intent_id, redemption_receipt_id, expires_at,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'unclaimed', NULL, NULL, NULL,
           $7::timestamptz, $8::timestamptz, $8::timestamptz
         )
         ON CONFLICT (project_id, transfer_id, batch_revision, member_id)
         DO NOTHING
         RETURNING member_id`,
        [
          this.#projectId,
          input.transferId,
          replacement.memberId,
          input.nextBatchRevision,
          input.checkpointSha256,
          replacement.claimSha256,
          replacement.expiresAt,
          rotatedAt,
        ],
      );
      if (inserted.length !== 1) stateConflict();
    }
    const advanced = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.project_lifecycle_journals
          SET batch_revision = $6, batch_sha256 = $7,
              scheduled_at = $8::timestamptz, updated_at = $9::timestamptz
        WHERE project_id = $1 AND operation_id = $2
          AND checkpoint_sha256 = $3
          AND batch_revision = $4 AND batch_sha256 = $5
          AND kind = 'authority-transfer'
          AND state IN ('active', 'recovery-required')
       RETURNING operation_id`,
      [
        this.#projectId,
        input.transferId,
        input.checkpointSha256,
        input.expectedBatchRevision,
        input.expectedBatchSha256,
        input.nextBatchRevision,
        input.nextBatchSha256,
        scheduledAt,
        rotatedAt,
      ],
    );
    if (advanced.length !== 1) stateConflict();
    await this.#upsertRecoveryCandidate(
      'authority-transfer',
      input.transferId,
      scheduledAt,
      journal.createdAt,
    );
    return 'advanced';
  }

  async revokeTransferredMembershipClaims(
    input: RevokeTransferredMembershipClaimsInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.transferId);
    positiveInteger(input.batchRevision);
    sha256(input.batchSha256);
    sha256(input.checkpointSha256);
    const revokedAt = timestamp(input.revokedAt);
    const journal = await this.getLifecycleJournal(input.transferId);
    if (
      journal?.kind !== 'authority-transfer'
      || journal.batchRevision !== input.batchRevision
      || journal.batchSha256 !== input.batchSha256
      || journal.checkpointSha256 !== input.checkpointSha256
    ) stateConflict();
    const claims = await this.#listClaims(input.transferId, input.batchRevision);
    if (claims.length === 0) stateConflict();
    const rows = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.transferred_membership_claims
          SET state = 'revoked', updated_at = $4::timestamptz
        WHERE project_id = $1 AND transfer_id = $2 AND batch_revision = $3
          AND state = 'unclaimed'
       RETURNING member_id`,
      [this.#projectId, input.transferId, input.batchRevision, revokedAt],
    );
    const stored = await this.#listClaims(input.transferId, input.batchRevision);
    if (stored.some(value => (
      value.state === 'unclaimed'
      || (value.state === 'revoked' && value.updatedAt !== revokedAt)
    ))) stateConflict();
    return rows.length > 0 ? 'advanced' : 'replayed';
  }

  async deleteTransferredMembershipClaims(
    input: DeleteTransferredMembershipClaimsInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.transferId);
    positiveInteger(input.batchRevision);
    sha256(input.batchSha256);
    sha256(input.checkpointSha256);
    const journal = await this.getLifecycleJournal(input.transferId);
    if (
      journal?.kind !== 'authority-transfer'
      || journal.direction !== 'lan-to-cloud'
      || journal.batchRevision !== input.batchRevision
      || journal.batchSha256 !== input.batchSha256
      || journal.checkpointSha256 !== input.checkpointSha256
      || (
        journal.phase !== 'target-invalidated'
        && journal.phase !== 'target-cleaned'
        && journal.phase !== 'source-reopened'
        && journal.phase !== 'cancelled'
      )
    ) stateConflict();
    const contradictory = await this.#query<{ readonly member_id: string }>(
      `SELECT member_id
         FROM claudian_cloud.transferred_membership_claims
        WHERE project_id = $1 AND transfer_id = $2 AND state = 'redeemed'
        LIMIT 1`,
      [this.#projectId, input.transferId],
    );
    if (contradictory.length !== 0) stateConflict();
    const rows = await this.#query<{ readonly member_id: string }>(
      `DELETE FROM claudian_cloud.transferred_membership_claims
        WHERE project_id = $1 AND transfer_id = $2
          AND state IN ('unclaimed', 'revoked')
      RETURNING member_id`,
      [this.#projectId, input.transferId],
    );
    const remaining = await this.#query<{ readonly member_id: string }>(
      `SELECT member_id
         FROM claudian_cloud.transferred_membership_claims
        WHERE project_id = $1 AND transfer_id = $2
        LIMIT 1`,
      [this.#projectId, input.transferId],
    );
    if (remaining.length !== 0) stateConflict();
    return rows.length > 0 ? 'advanced' : 'replayed';
  }

  async putTransferReceiptKey(
    input: TransferReceiptKeyInput,
  ): Promise<PersistencePutResult> {
    opaqueId(input.transferId);
    opaqueId(input.receiptKeyId);
    timestamp(input.createdAt);
    canonicalBase64url(input.publicKey, 32, 64);
    if ((await this.getLifecycleJournal(input.transferId))?.kind !== 'authority-transfer') {
      stateConflict();
    }
    const rows = await this.#query<{ readonly receipt_key_id: string }>(
      `INSERT INTO claudian_cloud.transfer_receipt_keys (
         project_id, transfer_id, receipt_key_id, signature_algorithm,
         public_key, created_at
       ) VALUES ($1, $2, $3, 'ed25519', $4, $5::timestamptz)
       ON CONFLICT (project_id, transfer_id, receipt_key_id) DO NOTHING
       RETURNING receipt_key_id`,
      [
        this.#projectId,
        input.transferId,
        input.receiptKeyId,
        input.publicKey,
        input.createdAt,
      ],
    );
    const stored = await this.getTransferReceiptKey(
      input.transferId,
      input.receiptKeyId,
    );
    if (stored === undefined || !isDeepStrictEqual(stored, input)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async getTransferReceiptKey(
    transferId: string,
    receiptKeyId: string,
  ): Promise<TransferReceiptKeyInput | undefined> {
    opaqueId(transferId);
    opaqueId(receiptKeyId);
    const rows = await this.#query<{
      readonly created_at: Date;
      readonly public_key: string;
      readonly receipt_key_id: string;
      readonly transfer_id: string;
    }>(
      `SELECT transfer_id, receipt_key_id, public_key, created_at
         FROM claudian_cloud.transfer_receipt_keys
        WHERE project_id = $1 AND transfer_id = $2 AND receipt_key_id = $3`,
      [this.#projectId, transferId, receiptKeyId],
    );
    const row = rows[0];
    return row === undefined ? undefined : Object.freeze({
      createdAt: dateIso(row.created_at),
      publicKey: row.public_key,
      receiptKeyId: row.receipt_key_id,
      transferId: row.transfer_id,
    });
  }

  async redeemTransferredMembershipClaim(
    input: RedeemTransferredMembershipClaimInput,
  ): Promise<CollabTransferredMembershipRedemptionReceipt> {
    opaqueId(input.transferId);
    memberId(input.memberId);
    sha256(input.claimSha256);
    opaqueId(input.operationIntentId);
    principalId(input.targetPrincipalId);
    timestamp(input.updatedAt);
    const receipt = decodedRedemptionReceipt(input.receipt);
    if (
      receipt.projectId !== this.#projectId
      || receipt.transferId !== input.transferId
      || receipt.memberId !== input.memberId
      || receipt.claimSha256 !== input.claimSha256
      || receipt.operationIntentId !== input.operationIntentId
      || receipt.redeemedAt !== input.updatedAt
    ) invalidRecord();
    const claim = await this.getTransferredMembershipClaim(
      input.transferId,
      input.memberId,
    );
    const journal = await this.getLifecycleJournal(input.transferId);
    if (
      claim === undefined
      || journal?.kind !== 'authority-transfer'
      || claim.claimSha256 !== input.claimSha256
      || receipt.checkpointSha256 !== claim.checkpointSha256
      || receipt.targetAuthorityGeneration
        !== journal.expectedAuthorityGeneration + 1
    ) invalidRecord();
    const insertedReceipt = await this.#query<{ readonly receipt_id: string }>(
      `INSERT INTO claudian_cloud.transfer_redemption_receipts (
         project_id, transfer_id, member_id, receipt_id, claim_sha256,
         operation_intent_id, receipt_key_id, receipt_json, redeemed_at,
         acknowledged_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, NULL)
       ON CONFLICT (project_id, transfer_id, member_id) DO NOTHING
       RETURNING receipt_id`,
      [
        this.#projectId,
        input.transferId,
        input.memberId,
        receipt.receiptId,
        input.claimSha256,
        input.operationIntentId,
        receipt.receiptKeyId,
        JSON.stringify(receipt),
        receipt.redeemedAt,
      ],
    );
    const updated = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.transferred_membership_claims
          SET state = 'redeemed',
              target_principal_id = $5,
              operation_intent_id = $6,
              redemption_receipt_id = $7,
              updated_at = $8::timestamptz
        WHERE project_id = $1
          AND transfer_id = $2
          AND member_id = $3
          AND claim_sha256 = $4
          AND batch_revision = $9
          AND state = 'unclaimed'
          AND expires_at > $8::timestamptz
       RETURNING member_id`,
      [
        this.#projectId,
        input.transferId,
        input.memberId,
        input.claimSha256,
        input.targetPrincipalId,
        input.operationIntentId,
        receipt.receiptId,
        input.updatedAt,
        claim.batchRevision,
      ],
    );
    if (updated.length === 1) {
      await this.bindProjectPrincipal({
        boundAt: input.updatedAt,
        memberId: input.memberId,
        principalId: input.targetPrincipalId,
      });
      return receipt;
    }
    const replayClaim = await this.getTransferredMembershipClaim(
      input.transferId,
      input.memberId,
    );
    const storedReceipt = await this.#getRedemptionReceipt(
      input.transferId,
      input.memberId,
    );
    if (
      replayClaim?.state !== 'redeemed'
      || replayClaim.claimSha256 !== input.claimSha256
      || replayClaim.targetPrincipalId !== input.targetPrincipalId
      || replayClaim.operationIntentId !== input.operationIntentId
      || replayClaim.redemptionReceiptId !== receipt.receiptId
      || storedReceipt === undefined
      || !isDeepStrictEqual(storedReceipt, receipt)
      || insertedReceipt.length === 1
    ) stateConflict();
    await this.bindProjectPrincipal({
      boundAt: input.updatedAt,
      memberId: input.memberId,
      principalId: input.targetPrincipalId,
    });
    return storedReceipt;
  }

  async putProtectedClaimEnvelope(
    input: ProtectedClaimEnvelopeInput,
  ): Promise<PersistencePutResult> {
    const canonical = this.#canonicalProtectedEnvelope(input);
    const journal = await this.getLifecycleJournal(canonical.transferId);
    if (
      journal?.kind !== 'authority-transfer'
      || journal.checkpointSha256 !== canonical.associatedData.checkpointSha256
      || journal.expectedAuthorityGeneration
        !== canonical.associatedData.authorityGeneration
    ) stateConflict();
    const rows = await this.#query<{ readonly member_id: string }>(
      `INSERT INTO claudian_cloud.source_protected_claim_envelopes (
         project_id, transfer_id, member_id, claim_sha256, checkpoint_sha256,
         environment_identity, authority_generation, envelope_version,
         encryption_algorithm, key_id, key_version, receipt_key_id,
         associated_data_sha256, nonce, ciphertext, tag, expires_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 1, 'xchacha20-poly1305',
         $8, $9, $10, $11, $12, $13, $14, $15::timestamptz,
         $16::timestamptz
       )
       ON CONFLICT (project_id, transfer_id, member_id) DO NOTHING
       RETURNING member_id`,
      [
        this.#projectId,
        canonical.transferId,
        canonical.memberId,
        canonical.associatedData.claimSha256,
        canonical.associatedData.checkpointSha256,
        canonical.associatedData.environmentIdentity,
        canonical.associatedData.authorityGeneration,
        canonical.keyId,
        canonical.keyVersion,
        canonical.receiptKeyId,
        canonical.associatedDataSha256,
        canonical.nonce,
        canonical.ciphertext,
        canonical.tag,
        canonical.expiresAt,
        canonical.createdAt,
      ],
    );
    const stored = await this.getProtectedClaimEnvelope(
      canonical.transferId,
      canonical.memberId,
    );
    if (stored === undefined || !isDeepStrictEqual(stored, canonical)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async getProtectedClaimEnvelope(
    transferId: string,
    requestedMemberId: CollabMemberId,
  ): Promise<ProtectedClaimEnvelopeInput | undefined> {
    opaqueId(transferId);
    memberId(requestedMemberId);
    const rows = await this.#query<ProtectedEnvelopeRow>(
      `SELECT transfer_id, member_id, claim_sha256, checkpoint_sha256,
              environment_identity, authority_generation, envelope_version,
              encryption_algorithm, key_id, key_version, receipt_key_id,
              associated_data_sha256, nonce, ciphertext, tag, expires_at,
              created_at
         FROM claudian_cloud.source_protected_claim_envelopes
        WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3`,
      [this.#projectId, transferId, requestedMemberId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return this.#protectedClaimEnvelope(row);
  }

  async replaceProtectedClaimEnvelopes(
    input: ReplaceProtectedClaimEnvelopesInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.transferId);
    const expectedClaims = [...input.expectedClaims]
      .map(value => Object.freeze({
        claimSha256: sha256(value.claimSha256),
        memberId: memberId(value.memberId),
      }))
      .sort((left, right) => compareMemberIds(left.memberId, right.memberId));
    const replacements = [...input.replacements]
      .map(value => this.#canonicalProtectedEnvelope(value))
      .sort((left, right) => compareMemberIds(left.memberId, right.memberId));
    if (
      expectedClaims.length === 0
      || expectedClaims.length !== replacements.length
      || expectedClaims.some((value, index) => (
        value.memberId !== replacements[index]?.memberId
      ))
      || new Set(expectedClaims.map(value => value.memberId)).size
        !== expectedClaims.length
      || new Set(expectedClaims.map(value => value.claimSha256)).size
        !== expectedClaims.length
      || new Set(replacements.map(value => value.associatedData.claimSha256)).size
        !== replacements.length
      || replacements.some(value => value.transferId !== input.transferId)
    ) invalidRecord();
    const current = await this.#listProtectedClaimEnvelopes(input.transferId);
    if (isDeepStrictEqual(current, replacements)) return 'replayed';
    const currentClaims = current.map(value => Object.freeze({
      claimSha256: value.associatedData.claimSha256,
      memberId: value.memberId,
    }));
    if (
      current.length !== expectedClaims.length
      || !isDeepStrictEqual(currentClaims, expectedClaims)
      || await this.getTransferClaimBatchReceipt(input.transferId) !== undefined
    ) stateConflict();
    const deleted = await this.#query<{ readonly member_id: string }>(
      `DELETE FROM claudian_cloud.source_protected_claim_envelopes
        WHERE project_id = $1 AND transfer_id = $2
       RETURNING member_id`,
      [this.#projectId, input.transferId],
    );
    if (deleted.length !== current.length) stateConflict();
    for (const replacement of replacements) {
      if (await this.putProtectedClaimEnvelope(replacement) !== 'created') {
        stateConflict();
      }
    }
    return 'advanced';
  }

  async deleteProtectedClaimEnvelopes(
    input: DeleteProtectedClaimEnvelopesInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.transferId);
    sha256(input.checkpointSha256);
    const current = await this.#listProtectedClaimEnvelopes(input.transferId);
    if (current.length === 0) return 'replayed';
    if (current.some(value => (
      value.associatedData.checkpointSha256 !== input.checkpointSha256
    ))) stateConflict();
    const deleted = await this.#query<{ readonly member_id: string }>(
      `DELETE FROM claudian_cloud.source_protected_claim_envelopes
        WHERE project_id = $1 AND transfer_id = $2
          AND checkpoint_sha256 = $3
       RETURNING member_id`,
      [this.#projectId, input.transferId, input.checkpointSha256],
    );
    if (deleted.length !== current.length) stateConflict();
    return 'advanced';
  }

  async renewProtectedClaimEnvelopes(
    input: RenewProtectedClaimEnvelopesInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.transferId);
    const expiresAt = timestamp(input.expiresAt);
    const [journal, recovery] = await Promise.all([
      this.getLifecycleJournal(input.transferId),
      this.getAuthorityTransferRecovery(input.transferId),
    ]);
    if (
      journal?.kind !== 'authority-transfer'
      || journal.direction !== 'cloud-to-lan'
      || (journal.phase !== 'lan-activated' && journal.phase !== 'completed')
      || recovery?.expiresAt !== expiresAt
    ) stateConflict();
    const rows = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.source_protected_claim_envelopes
          SET expires_at = $3::timestamptz
        WHERE project_id = $1 AND transfer_id = $2
          AND expires_at < $3::timestamptz
          AND created_at < $3::timestamptz
       RETURNING member_id`,
      [this.#projectId, input.transferId, expiresAt],
    );
    const contradictory = await this.#query<{ readonly member_id: string }>(
      `SELECT member_id
         FROM claudian_cloud.source_protected_claim_envelopes
        WHERE project_id = $1 AND transfer_id = $2
          AND expires_at <> $3::timestamptz
        LIMIT 1`,
      [this.#projectId, input.transferId, expiresAt],
    );
    if (contradictory.length !== 0) stateConflict();
    return rows.length === 0 ? 'replayed' : 'advanced';
  }

  async scrubProtectedClaimEnvelope(
    input: ScrubProtectedClaimEnvelopeInput,
  ): Promise<ProtectedClaimScrubResult> {
    opaqueId(input.transferId);
    memberId(input.memberId);
    timestamp(input.acknowledgedAt);
    const receipt = decodedRedemptionReceipt(input.receipt);
    if (
      receipt.projectId !== this.#projectId
      || receipt.transferId !== input.transferId
      || receipt.memberId !== input.memberId
    ) invalidRecord();
    const envelope = await this.getProtectedClaimEnvelope(
      input.transferId,
      input.memberId,
    );
    if (
      envelope !== undefined
      && (
        receipt.claimSha256 !== envelope.associatedData.claimSha256
        || receipt.checkpointSha256
          !== envelope.associatedData.checkpointSha256
        || receipt.targetAuthorityGeneration
          !== envelope.associatedData.authorityGeneration + 1
      )
    ) invalidRecord();
    const existingReceipt = await this.#getRedemptionReceipt(
      input.transferId,
      input.memberId,
    );
    if (existingReceipt === undefined) {
      if (envelope === undefined) stateConflict();
      await this.#query(
        `INSERT INTO claudian_cloud.transfer_redemption_receipts (
           project_id, transfer_id, member_id, receipt_id, claim_sha256,
           operation_intent_id, receipt_key_id, receipt_json, redeemed_at,
           acknowledged_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9::timestamptz, $10::timestamptz
         )`,
        [
          this.#projectId,
          input.transferId,
          input.memberId,
          receipt.receiptId,
          receipt.claimSha256,
          receipt.operationIntentId,
          receipt.receiptKeyId,
          JSON.stringify(receipt),
          receipt.redeemedAt,
          input.acknowledgedAt,
        ],
      );
    } else if (!isDeepStrictEqual(existingReceipt, receipt)) {
      stateConflict();
    }
    const acknowledged = await this.#query<{ readonly receipt_id: string }>(
      `UPDATE claudian_cloud.transfer_redemption_receipts
          SET acknowledged_at = $4::timestamptz
        WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3
          AND receipt_id = $5
          AND claim_sha256 = $6
          AND (acknowledged_at IS NULL OR acknowledged_at = $4::timestamptz)
       RETURNING receipt_id`,
      [
        this.#projectId,
        input.transferId,
        input.memberId,
        input.acknowledgedAt,
        receipt.receiptId,
        receipt.claimSha256,
      ],
    );
    if (acknowledged.length !== 1) stateConflict();
    const removed = await this.#query<{ readonly member_id: string }>(
      `DELETE FROM claudian_cloud.source_protected_claim_envelopes
        WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3
          AND claim_sha256 = $4
       RETURNING member_id`,
      [this.#projectId, input.transferId, input.memberId, receipt.claimSha256],
    );
    return removed.length === 1 ? 'scrubbed' : 'replayed';
  }

  async putClaimBatchReceipt(
    value: CollabTransferredMembershipClaimCustodyReceipt,
  ): Promise<PersistencePutResult> {
    const receipt = decodedCustodyReceipt(value);
    if (receipt.projectId !== this.#projectId) invalidRecord();
    const journal = await this.getLifecycleJournal(receipt.transferId);
    if (
      journal?.kind !== 'authority-transfer'
      || journal.batchRevision !== receipt.batchRevision
      || journal.batchSha256 !== receipt.batchSha256
      || journal.checkpointSha256 !== receipt.checkpointSha256
      || journal.expectedAuthorityGeneration !== receipt.custodyAuthority.generation
      || receipt.targetAuthorityGeneration !== journal.expectedAuthorityGeneration + 1
    ) stateConflict();
    const receiptJson = JSON.stringify(receipt);
    const rows = await this.#query<{ readonly receipt_id: string }>(
      `INSERT INTO claudian_cloud.transfer_claim_batch_receipts (
         project_id, transfer_id, batch_revision, batch_sha256,
         checkpoint_sha256, operation_intent_id, submitted_by_member_id,
         custody_authority_kind, custody_authority_generation, receipt_id,
         receipt_json, committed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
       ON CONFLICT (project_id, transfer_id) DO NOTHING
       RETURNING receipt_id`,
      [
        this.#projectId,
        receipt.transferId,
        receipt.batchRevision,
        receipt.batchSha256,
        receipt.checkpointSha256,
        receipt.operationIntentId,
        receipt.submittedByMemberId,
        receipt.custodyAuthority.kind,
        receipt.custodyAuthority.generation,
        receipt.receiptId,
        receiptJson,
        receipt.committedAt,
      ],
    );
    const stored = await this.getTransferClaimBatchReceipt(receipt.transferId);
    if (stored === undefined || !isDeepStrictEqual(stored, receipt)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async getTransferClaimBatchReceipt(
    transferId: string,
  ): Promise<CollabTransferredMembershipClaimCustodyReceipt | undefined> {
    opaqueId(transferId);
    const rows = await this.#query<{ readonly receipt_json: string }>(
      `SELECT receipt_json
         FROM claudian_cloud.transfer_claim_batch_receipts
        WHERE project_id = $1 AND transfer_id = $2`,
      [this.#projectId, transferId],
    );
    const value = rows[0]?.receipt_json;
    if (value === undefined) return undefined;
    try {
      return decodeCollabTransferredMembershipClaimCustodyReceipt(JSON.parse(value));
    } catch {
      dependencyFailure();
    }
  }

  async putTerminalResponder(
    input: TerminalResponderInput,
  ): Promise<PersistencePutResult> {
    const canonical = this.#canonicalTerminalResponder(input);
    const existing = await this.getTerminalResponder(
      canonical.operationKind,
      canonical.operationId,
    );
    if (existing !== undefined) {
      const existingPrincipals = [
        ...existing.eligiblePrincipals,
        ...existing.acknowledgements.map(value => ({
          memberId: value.memberId,
          principalId: value.principalId,
        })),
      ].sort((left, right) => compareMemberIds(left.memberId, right.memberId));
      if (!isDeepStrictEqual({
        createdAt: existing.createdAt,
        eligiblePrincipals: existingPrincipals,
        expiresAt: existing.expiresAt,
        operationId: existing.operationId,
        operationKind: existing.operationKind,
        replayAuthorization: existing.replayAuthorization,
        responseJson: existing.responseJson,
        responseSha256: existing.responseSha256,
      }, canonical)) stateConflict();
      return 'replayed';
    }
    const rows = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.project_terminal_responders (
         project_id, operation_kind, operation_id, response_sha256,
         response_json, replay_member_id, replay_request_sha256,
         expires_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8::timestamptz, $9::timestamptz, $9::timestamptz
       )
       ON CONFLICT (project_id, operation_kind, operation_id) DO NOTHING
       RETURNING operation_id`,
      [
        this.#projectId,
        canonical.operationKind,
        canonical.operationId,
        canonical.responseSha256,
        canonical.responseJson,
        canonical.replayAuthorization?.memberId ?? null,
        canonical.replayAuthorization?.requestSha256 ?? null,
        canonical.expiresAt,
        canonical.createdAt,
      ],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.project_terminal_responder_catalog (
         project_id, operation_kind, operation_id, expires_at, created_at
       ) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (project_id, operation_kind, operation_id) DO NOTHING`,
      [
        this.#projectId,
        canonical.operationKind,
        canonical.operationId,
        canonical.expiresAt,
        canonical.createdAt,
      ],
    );
    for (const principal of canonical.eligiblePrincipals) {
      await this.#query(
        `INSERT INTO claudian_cloud.project_terminal_acknowledgements (
           project_id, operation_kind, operation_id, principal_id,
           member_id, acknowledged_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           CASE WHEN $2::text = 'authority-transfer' THEN (
             SELECT receipt.acknowledged_at
               FROM claudian_cloud.transfer_redemption_receipts AS receipt
              WHERE receipt.project_id = $1::varchar(64)
                AND receipt.transfer_id = $3::varchar(128)
                AND receipt.member_id = $5::varchar(64)
           ) ELSE NULL END
         )
         ON CONFLICT (project_id, operation_kind, operation_id, member_id)
         DO NOTHING`,
        [
          this.#projectId,
          canonical.operationKind,
          canonical.operationId,
          principal.principalId,
          principal.memberId,
        ],
      );
    }
    const stored = await this.getTerminalResponder(
      canonical.operationKind,
      canonical.operationId,
    );
    const storedPrincipals = stored === undefined ? [] : [
      ...stored.eligiblePrincipals,
      ...stored.acknowledgements.map(value => ({
        memberId: value.memberId,
        principalId: value.principalId,
      })),
    ].sort((left, right) => compareMemberIds(left.memberId, right.memberId));
    if (
      stored === undefined
      || !isDeepStrictEqual({
        createdAt: stored.createdAt,
        eligiblePrincipals: storedPrincipals,
        expiresAt: stored.expiresAt,
        operationId: stored.operationId,
        operationKind: stored.operationKind,
        replayAuthorization: stored.replayAuthorization,
        responseJson: stored.responseJson,
        responseSha256: stored.responseSha256,
      }, canonical)
    ) stateConflict();
    if (rows.length !== 1) stateConflict();
    return 'created';
  }

  async getTerminalResponder(
    operationKind: 'authority-transfer' | 'retire',
    operationId: string,
  ): Promise<TerminalResponderRecord | undefined> {
    if (!TERMINAL_OPERATION_KINDS.has(operationKind)) {
      invalidRecord();
    }
    opaqueId(operationId);
    const rows = await this.#query<TerminalResponderRow>(
      `SELECT operation_kind, operation_id, response_sha256, response_json,
              replay_member_id, replay_request_sha256, expires_at, created_at
         FROM claudian_cloud.project_terminal_responders
        WHERE project_id = $1 AND operation_kind = $2 AND operation_id = $3`,
      [this.#projectId, operationKind, operationId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const principals = await this.#query<TerminalPrincipalRow>(
      `SELECT principal_id, member_id, acknowledged_at
         FROM claudian_cloud.project_terminal_acknowledgements
        WHERE project_id = $1 AND operation_kind = $2 AND operation_id = $3
        ORDER BY member_id`,
      [this.#projectId, operationKind, operationId],
    );
    const common = {
      createdAt: dateIso(row.created_at),
      eligiblePrincipals: principals.map(principal => ({
        memberId: principal.member_id,
        principalId: principal.principal_id,
      })),
      expiresAt: dateIso(row.expires_at),
      operationId: row.operation_id,
      responseJson: row.response_json,
      responseSha256: row.response_sha256,
    };
    let canonical: TerminalResponderInput;
    if (row.operation_kind === 'authority-transfer') {
      if (row.replay_member_id === null || row.replay_request_sha256 === null) {
        dependencyFailure();
      }
      canonical = this.#canonicalTerminalResponder({
        ...common,
        operationKind: 'authority-transfer',
        replayAuthorization: {
          memberId: row.replay_member_id,
          requestSha256: row.replay_request_sha256,
        },
      });
    } else if (row.operation_kind === 'retire') {
      if (row.replay_member_id !== null || row.replay_request_sha256 !== null) {
        dependencyFailure();
      }
      canonical = this.#canonicalTerminalResponder({
        ...common,
        operationKind: 'retire',
      });
    } else {
      dependencyFailure();
    }
    return Object.freeze({
      acknowledgements: Object.freeze(principals
        .filter(principal => principal.acknowledged_at !== null)
        .map(principal => Object.freeze({
          acknowledgedAt: dateIso(principal.acknowledged_at as Date),
          memberId: principal.member_id,
          principalId: principal.principal_id,
        }))),
      ...canonical,
      eligiblePrincipals: Object.freeze(principals
        .filter(principal => principal.acknowledged_at === null)
        .map(principal => Object.freeze({
          memberId: principal.member_id,
          principalId: principal.principal_id,
        }))),
    });
  }

  async acknowledgeTerminalResponder(
    input: AcknowledgeTerminalResponderInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.operationId);
    memberId(input.memberId);
    principalId(input.principalId);
    timestamp(input.acknowledgedAt);
    const rows = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.project_terminal_acknowledgements
          SET acknowledged_at = $6::timestamptz
        WHERE project_id = $1 AND operation_kind = $2 AND operation_id = $3
          AND principal_id = $4 AND member_id = $5
          AND acknowledged_at IS NULL
       RETURNING member_id`,
      [
        this.#projectId,
        input.operationKind,
        input.operationId,
        input.principalId,
        input.memberId,
        input.acknowledgedAt,
      ],
    );
    if (rows.length === 1) return 'advanced';
    const responder = await this.getTerminalResponder(
      input.operationKind,
      input.operationId,
    );
    const replay = responder?.acknowledgements.some(value => (
      value.memberId === input.memberId
      && value.principalId === input.principalId
      && value.acknowledgedAt === input.acknowledgedAt
    ));
    if (replay !== true) stateConflict();
    return 'replayed';
  }

  async putProjectTombstone(
    input: ProjectTombstoneInput,
  ): Promise<PersistencePutResult> {
    const canonical = this.#canonicalTombstone(input);
    const rows = await this.#query<{ readonly project_id: string }>(
      `INSERT INTO claudian_cloud.project_tombstones (
         project_id, authority_generation, terminal_operation_kind,
         terminal_operation_id, result_sha256, retired_at, terminal_expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (project_id) DO NOTHING
       RETURNING project_id`,
      [
        this.#projectId,
        canonical.authorityGeneration,
        canonical.terminalOperationKind,
        canonical.terminalOperationId,
        canonical.resultSha256,
        canonical.retiredAt,
        canonical.terminalExpiresAt,
      ],
    );
    const stored = await this.getProjectTombstone();
    if (stored === undefined || !isDeepStrictEqual(stored, canonical)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async getProjectTombstone(): Promise<ProjectTombstoneInput | undefined> {
    const rows = await this.#query<{
      readonly authority_generation: string;
      readonly project_id: string;
      readonly result_sha256: string;
      readonly retired_at: Date;
      readonly terminal_expires_at: Date;
      readonly terminal_operation_id: string;
      readonly terminal_operation_kind: string;
    }>(
      `SELECT project_id, authority_generation, terminal_operation_kind,
              terminal_operation_id, result_sha256, retired_at,
              terminal_expires_at
         FROM claudian_cloud.project_tombstones
        WHERE project_id = $1`,
      [this.#projectId],
    );
    const row = rows[0];
    return row === undefined ? undefined : this.#canonicalTombstone({
      authorityGeneration: databasePositiveInteger(row.authority_generation),
      projectId: row.project_id,
      resultSha256: row.result_sha256,
      retiredAt: dateIso(row.retired_at),
      terminalExpiresAt: dateIso(row.terminal_expires_at),
      terminalOperationId: row.terminal_operation_id,
      terminalOperationKind: row.terminal_operation_kind as 'authority-transfer' | 'retire',
    });
  }

  async putDeletionIntent(
    input: ProjectDeletionIntentInput,
  ): Promise<PersistencePutResult> {
    const canonical = this.#canonicalDeletionIntent(input);
    const journal = await this.getLifecycleJournal(canonical.operationId);
    const tombstone = await this.getProjectTombstone();
    const terminalResponder = await this.getTerminalResponder(
      canonical.terminalOperationKind,
      canonical.terminalOperationId,
    );
    if (
      journal?.kind !== 'delete'
      || journal.state !== 'active'
      || journal.phase !== 'traffic-denied'
      || journal.actorMemberId !== canonical.authorizedMemberId
      || journal.requestFingerprint !== canonical.authorizationSha256
      || journal.createdAt !== canonical.createdAt
      || tombstone?.terminalOperationKind !== canonical.terminalOperationKind
      || tombstone.terminalOperationId !== canonical.terminalOperationId
      || terminalResponder?.expiresAt !== tombstone.terminalExpiresAt
      || terminalResponder.responseSha256 !== tombstone.resultSha256
      || (
        canonical.reason === 'retire'
          ? canonical.terminalOperationKind !== 'retire'
          : canonical.terminalOperationKind !== 'authority-transfer'
      )
    ) stateConflict();
    const active = await this.#query<{ readonly operation_id: string }>(
      `SELECT operation_id
         FROM claudian_cloud.project_deletion_intents
        WHERE project_id = $1`,
      [this.#projectId],
    );
    if (active[0] !== undefined && active[0].operation_id !== input.operationId) {
      stateConflict();
    }
    const rows = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.project_deletion_intents (
         project_id, operation_id, reason, authorized_member_id,
         authorization_sha256, storage_node_id, repository_storage_key,
         placement_generation, terminal_operation_kind,
         terminal_operation_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11::timestamptz)
       ON CONFLICT (project_id, operation_id) DO NOTHING
       RETURNING operation_id`,
      [
        this.#projectId,
        canonical.operationId,
        canonical.reason,
        canonical.authorizedMemberId,
        canonical.authorizationSha256,
        canonical.storageNodeId,
        canonical.repositoryStorageKey,
        canonical.placementGeneration,
        canonical.terminalOperationKind,
        canonical.terminalOperationId,
        canonical.createdAt,
      ],
    );
    const stored = await this.getDeletionIntent(canonical.operationId);
    const expected: ProjectDeletionIntentRecord = {
      ...canonical,
      phase: journal.phase,
      resultSha256: undefined,
      updatedAt: journal.updatedAt,
    };
    if (stored === undefined || !isDeepStrictEqual(stored, expected)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async getDeletionIntent(
    operationId: string,
  ): Promise<ProjectDeletionIntentRecord | undefined> {
    opaqueId(operationId);
    const rows = await this.#query<DeletionIntentRow>(
      `SELECT intent.operation_id, intent.reason, journal.phase,
              intent.authorized_member_id, intent.authorization_sha256,
              intent.storage_node_id, intent.repository_storage_key,
              intent.placement_generation, intent.terminal_operation_kind,
              intent.terminal_operation_id, journal.result_sha256,
              intent.created_at, journal.updated_at
         FROM claudian_cloud.project_deletion_intents AS intent
         JOIN claudian_cloud.project_lifecycle_journals AS journal
           ON journal.project_id = intent.project_id
          AND journal.operation_id = intent.operation_id
        WHERE intent.project_id = $1 AND intent.operation_id = $2
          AND journal.kind = 'delete'`,
      [this.#projectId, operationId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (!DELETION_PHASES.has(row.phase as ProjectDeletionPhase)) dependencyFailure();
    const input = this.#canonicalDeletionIntent({
      authorizationSha256: row.authorization_sha256,
      authorizedMemberId: row.authorized_member_id,
      createdAt: dateIso(row.created_at),
      operationId: row.operation_id,
      placementGeneration: databasePositiveInteger(row.placement_generation),
      reason: row.reason as 'cloud-to-lan' | 'retire',
      repositoryStorageKey: row.repository_storage_key,
      storageNodeId: row.storage_node_id,
      terminalOperationId: row.terminal_operation_id,
      terminalOperationKind: row.terminal_operation_kind as 'authority-transfer' | 'retire',
    });
    return Object.freeze({
      ...input,
      phase: row.phase as ProjectDeletionPhase,
      resultSha256: optional(row.result_sha256),
      updatedAt: dateIso(row.updated_at),
    });
  }

  async removeProjectCoordinationContent(
    input: RemoveProjectCoordinationContentInput,
  ): Promise<PersistenceAdvanceResult> {
    const operationId = opaqueId(input.operationId);
    const scheduledAt = timestamp(input.scheduledAt);
    const updatedAt = timestamp(input.updatedAt);
    const intent = await this.getDeletionIntent(operationId);
    const tombstone = await this.getProjectTombstone();
    if (
      intent === undefined
      || tombstone === undefined
      || intent.terminalOperationId !== tombstone.terminalOperationId
      || intent.terminalOperationKind !== tombstone.terminalOperationKind
    ) stateConflict();
    if (intent.phase === 'coordination-removed') {
      await this.#verifyMinimalDeletionPartition(intent);
      return 'replayed';
    }
    if (intent.phase !== 'repository-removed') stateConflict();

    const removed = await this.#query<{ readonly removed: boolean }>(
      `SELECT claudian_cloud.remove_project_coordination_content(
         $1,
         $2,
         $3,
         $4
       ) AS removed`,
      [
        this.#projectId,
        operationId,
        intent.terminalOperationKind,
        intent.terminalOperationId,
      ],
    );
    if (removed[0]?.removed !== true) stateConflict();
    const result = await this.advanceLifecycleJournal({
      expectedPhase: 'repository-removed',
      expectedState: 'active',
      nextPhase: 'coordination-removed',
      nextState: 'active',
      operationId,
      scheduledAt,
      updatedAt,
    });
    await this.#verifyMinimalDeletionPartition({
      ...intent,
      phase: 'coordination-removed',
      updatedAt,
    });
    return result;
  }

  async putBackupCatalogEntry(
    input: ProjectBackupCatalogInput,
  ): Promise<PersistencePutResult> {
    const canonical = this.#canonicalBackup(input);
    const rows = await this.#query<{ readonly backup_id: string }>(
      `INSERT INTO claudian_cloud.project_backup_catalog (
         project_id, backup_id, checkpoint_sha256, authority_generation,
         coordination_schema_version, server_build, authority_volume_identity,
         placement_generation, state, created_at, verified_at, published_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'captured',
                 $9::timestamptz, NULL, NULL)
       ON CONFLICT (project_id, backup_id) DO NOTHING
       RETURNING backup_id`,
      [
        this.#projectId,
        canonical.backupId,
        canonical.checkpointSha256,
        canonical.authorityGeneration,
        canonical.coordinationSchemaVersion,
        canonical.serverBuild,
        canonical.authorityVolumeIdentity,
        canonical.placementGeneration,
        canonical.createdAt,
      ],
    );
    const stored = await this.getBackupCatalogEntry(canonical.backupId);
    const expected: ProjectBackupCatalogRecord = {
      ...canonical,
      publishedAt: undefined,
      state: 'captured',
      verifiedAt: undefined,
    };
    if (stored === undefined || !isDeepStrictEqual(stored, expected)) stateConflict();
    return rows.length === 1 ? 'created' : 'replayed';
  }

  async getBackupCatalogEntry(
    backupId: string,
  ): Promise<ProjectBackupCatalogRecord | undefined> {
    opaqueId(backupId);
    const rows = await this.#query<BackupCatalogRow>(
      `SELECT backup_id, checkpoint_sha256, authority_generation,
              coordination_schema_version, server_build,
              authority_volume_identity, placement_generation, state,
              created_at, verified_at, published_at
         FROM claudian_cloud.project_backup_catalog
        WHERE project_id = $1 AND backup_id = $2`,
      [this.#projectId, backupId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (!BACKUP_STATES.has(row.state as ProjectBackupState)) dependencyFailure();
    const input = this.#canonicalBackup({
      authorityGeneration: databasePositiveInteger(row.authority_generation),
      authorityVolumeIdentity: row.authority_volume_identity,
      backupId: row.backup_id,
      checkpointSha256: row.checkpoint_sha256,
      coordinationSchemaVersion: row.coordination_schema_version,
      createdAt: dateIso(row.created_at),
      placementGeneration: databasePositiveInteger(row.placement_generation),
      serverBuild: row.server_build,
    });
    return Object.freeze({
      ...input,
      publishedAt: row.published_at === null ? undefined : dateIso(row.published_at),
      state: row.state as ProjectBackupState,
      verifiedAt: row.verified_at === null ? undefined : dateIso(row.verified_at),
    });
  }

  async advanceBackupCatalogEntry(
    input: AdvanceProjectBackupCatalogInput,
  ): Promise<PersistenceAdvanceResult> {
    opaqueId(input.backupId);
    if (!BACKUP_STATES.has(input.expectedState) || !BACKUP_STATES.has(input.nextState)) {
      invalidRecord();
    }
    timestamp(input.updatedAt);
    if (
      !(
        (input.expectedState === 'captured' && input.nextState === 'verified')
        || (input.expectedState === 'verified' && input.nextState === 'published')
      )
    ) invalidRecord();
    const rows = await this.#query<{ readonly backup_id: string }>(
      `UPDATE claudian_cloud.project_backup_catalog
          SET state = $4,
              verified_at = CASE
                WHEN $4 = 'verified' THEN $5::timestamptz
                ELSE verified_at
              END,
              published_at = CASE
                WHEN $4 = 'published' THEN $5::timestamptz
                ELSE published_at
              END
        WHERE project_id = $1 AND backup_id = $2 AND state = $3
       RETURNING backup_id`,
      [
        this.#projectId,
        input.backupId,
        input.expectedState,
        input.nextState,
        input.updatedAt,
      ],
    );
    const stored = await this.getBackupCatalogEntry(input.backupId);
    if (
      stored?.state !== input.nextState
      || (input.nextState === 'verified' && stored.verifiedAt !== input.updatedAt)
      || (input.nextState === 'published' && stored.publishedAt !== input.updatedAt)
    ) stateConflict();
    return rows.length === 1 ? 'advanced' : 'replayed';
  }

  async #getRedemptionReceipt(
    transferId: string,
    requestedMemberId: CollabMemberId,
  ): Promise<CollabTransferredMembershipRedemptionReceipt | undefined> {
    const rows = await this.#query<{ readonly receipt_json: string }>(
      `SELECT receipt_json
         FROM claudian_cloud.transfer_redemption_receipts
        WHERE project_id = $1 AND transfer_id = $2 AND member_id = $3`,
      [this.#projectId, transferId, requestedMemberId],
    );
    const value = rows[0]?.receipt_json;
    if (value === undefined) return undefined;
    try {
      return decodeCollabTransferredMembershipRedemptionReceipt(JSON.parse(value));
    } catch {
      dependencyFailure();
    }
  }

  async #listClaims(
    transferId: string,
    batchRevision: number,
  ): Promise<readonly TransferredMembershipClaimRecord[]> {
    const rows = await this.#query<ClaimRow>(
      `SELECT transfer_id, member_id, batch_revision, checkpoint_sha256,
              claim_sha256, state, target_principal_id, operation_intent_id,
              redemption_receipt_id, expires_at, created_at, updated_at
         FROM claudian_cloud.transferred_membership_claims
        WHERE project_id = $1 AND transfer_id = $2 AND batch_revision = $3
        ORDER BY member_id`,
      [this.#projectId, transferId, batchRevision],
    );
    return Object.freeze(rows
      .map(transferredClaim)
      .sort((left, right) => compareMemberIds(left.memberId, right.memberId)));
  }

  async #listProtectedClaimEnvelopes(
    transferId: string,
  ): Promise<readonly ProtectedClaimEnvelopeInput[]> {
    const rows = await this.#query<ProtectedEnvelopeRow>(
      `SELECT transfer_id, member_id, claim_sha256, checkpoint_sha256,
              environment_identity, authority_generation, envelope_version,
              encryption_algorithm, key_id, key_version, receipt_key_id,
              associated_data_sha256, nonce, ciphertext, tag, expires_at,
              created_at
         FROM claudian_cloud.source_protected_claim_envelopes
        WHERE project_id = $1 AND transfer_id = $2
        ORDER BY member_id`,
      [this.#projectId, transferId],
    );
    return Object.freeze(rows
      .map(row => this.#protectedClaimEnvelope(row))
      .sort((left, right) => compareMemberIds(left.memberId, right.memberId)));
  }

  #protectedClaimEnvelope(row: ProtectedEnvelopeRow): ProtectedClaimEnvelopeInput {
    return this.#canonicalProtectedEnvelope({
      associatedData: {
        authorityGeneration: databasePositiveInteger(row.authority_generation),
        checkpointSha256: row.checkpoint_sha256,
        claimSha256: row.claim_sha256,
        envelopeVersion: 1,
        environmentIdentity: row.environment_identity,
        memberId: row.member_id,
        projectId: this.#projectId,
        transferId: row.transfer_id,
      },
      associatedDataSha256: row.associated_data_sha256,
      ciphertext: row.ciphertext,
      createdAt: dateIso(row.created_at),
      encryptionAlgorithm: row.encryption_algorithm as 'xchacha20-poly1305',
      expiresAt: dateIso(row.expires_at),
      keyId: row.key_id,
      keyVersion: row.key_version,
      memberId: row.member_id,
      nonce: row.nonce,
      receiptKeyId: row.receipt_key_id,
      tag: row.tag,
      transferId: row.transfer_id,
    });
  }

  #canonicalProtectedEnvelope(
    input: ProtectedClaimEnvelopeInput,
  ): ProtectedClaimEnvelopeInput {
    opaqueId(input.transferId);
    memberId(input.memberId);
    if (
      !ENCRYPTION_ALGORITHMS.has(input.encryptionAlgorithm)
      || input.associatedData.projectId !== this.#projectId
      || input.associatedData.transferId !== input.transferId
      || input.associatedData.memberId !== input.memberId
      || !ENVELOPE_VERSIONS.has(input.associatedData.envelopeVersion)
    ) invalidRecord();
    let encodedAssociatedData: string;
    try {
      encodedAssociatedData = encodeCollabProtectedClaimAssociatedData(input.associatedData);
    } catch {
      invalidRecord();
    }
    sha256(input.associatedDataSha256);
    if (
      createHash('sha256').update(encodedAssociatedData).digest('hex')
        !== input.associatedDataSha256
    ) invalidRecord();
    sha256(input.associatedData.claimSha256);
    sha256(input.associatedData.checkpointSha256);
    opaqueId(input.keyId);
    opaqueId(input.receiptKeyId);
    positiveInteger(input.keyVersion);
    canonicalBase64url(input.nonce, 24);
    canonicalBase64url(input.tag, 16);
    canonicalBase64url(input.ciphertext, 1, 4096);
    const createdAt = timestamp(input.createdAt);
    const expiresAt = timestamp(input.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) invalidRecord();
    return Object.freeze({ ...input, createdAt, expiresAt });
  }

  #canonicalAuthorityTransferRecovery(
    input: AuthorityTransferRecoveryInput,
  ): AuthorityTransferRecoveryInput {
    opaqueId(input.transferId);
    const sourceAuthority = checkpointAuthority(input.sourceAuthority);
    const targetAuthority = checkpointAuthority(input.targetAuthority);
    if (
      sourceAuthority.kind === targetAuthority.kind
      || targetAuthority.generation !== sourceAuthority.generation + 1
    ) invalidRecord();
    const sourceHostMemberId = input.sourceHostMemberId === undefined
      ? undefined
      : memberId(input.sourceHostMemberId);
    const targetHostMemberId = input.targetHostMemberId === undefined
      ? undefined
      : memberId(input.targetHostMemberId);
    if (
      (
        sourceAuthority.kind === 'lan'
        && (sourceHostMemberId === undefined || targetHostMemberId !== undefined)
      )
      || (
        sourceAuthority.kind === 'cloud'
        && (sourceHostMemberId !== undefined || targetHostMemberId === undefined)
      )
    ) invalidRecord();
    const createdAt = timestamp(input.createdAt);
    const expiresAt = timestamp(input.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) invalidRecord();
    return Object.freeze({
      ...input,
      createdAt,
      expiresAt,
      sourceAuthority,
      sourceHostMemberId,
      targetAuthority,
      targetHostMemberId,
      targetUrl: targetUrl(input.targetUrl),
    });
  }

  #canonicalTerminalResponder(
    input: TerminalResponderInput,
  ): TerminalResponderInput {
    opaqueId(input.operationId);
    if (!TERMINAL_OPERATION_KINDS.has(input.operationKind)) {
      invalidRecord();
    }
    sha256(input.responseSha256);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.responseJson);
    } catch {
      invalidRecord();
    }
    const createdAt = timestamp(input.createdAt);
    const expiresAt = timestamp(input.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) invalidRecord();
    let canonicalResponseJson: string;
    try {
      if (input.operationKind === 'retire') {
        const decoded = collabControlOperationCodec('retireProject')
          .decodeResponse(parsed);
        if (
          decoded.projectId !== this.#projectId
          || decoded.retirementId !== input.operationId
          || decoded.terminalExpiresAt !== expiresAt
        ) invalidRecord();
        canonicalResponseJson = JSON.stringify(decoded);
      } else {
        const decoded = collabControlOperationCodec('getProjectAuthorityTransfer')
          .decodeResponse(parsed);
        if (
          decoded.projectId !== this.#projectId
          || decoded.transferId !== input.operationId
          || decoded.direction !== 'cloud-to-lan'
          || decoded.phase !== 'completed'
          || decoded.state !== 'completed'
          || decoded.expiresAt !== expiresAt
        ) invalidRecord();
        canonicalResponseJson = JSON.stringify(decoded);
      }
    } catch (error: unknown) {
      if (error instanceof CoordinationError) throw error;
      invalidRecord();
    }
    if (
      canonicalResponseJson !== input.responseJson
      || createHash('sha256').update(input.responseJson).digest('hex')
        !== input.responseSha256
    ) invalidRecord();
    const eligiblePrincipals = [...input.eligiblePrincipals]
      .map(value => Object.freeze({
        memberId: memberId(value.memberId),
        principalId: principalId(value.principalId),
      }))
      .sort((left, right) => compareMemberIds(left.memberId, right.memberId));
    if (
      eligiblePrincipals.length === 0
      || new Set(eligiblePrincipals.map(value => value.memberId)).size
        !== eligiblePrincipals.length
      || new Set(eligiblePrincipals.map(value => value.principalId)).size
        !== eligiblePrincipals.length
    ) invalidRecord();
    const replayAuthorization = input.replayAuthorization === undefined
      ? undefined
      : Object.freeze({
          memberId: memberId(input.replayAuthorization.memberId),
          requestSha256: sha256(input.replayAuthorization.requestSha256),
        });
    if (input.operationKind === 'authority-transfer') {
      if (
        replayAuthorization === undefined
        || !eligiblePrincipals.some(value => (
          value.memberId === replayAuthorization.memberId
        ))
      ) invalidRecord();
      return Object.freeze({
        ...input,
        createdAt,
        eligiblePrincipals,
        expiresAt,
        operationKind: 'authority-transfer',
        replayAuthorization,
      });
    }
    if (replayAuthorization !== undefined) invalidRecord();
    return Object.freeze({
      ...input,
      createdAt,
      eligiblePrincipals,
      expiresAt,
      operationKind: 'retire',
      replayAuthorization: undefined,
    });
  }

  #canonicalTombstone(input: ProjectTombstoneInput): ProjectTombstoneInput {
    if (input.projectId !== this.#projectId || !isCollabProjectId(input.projectId)) {
      invalidRecord();
    }
    positiveInteger(input.authorityGeneration);
    opaqueId(input.terminalOperationId);
    if (
      !TERMINAL_OPERATION_KINDS.has(input.terminalOperationKind)
    ) invalidRecord();
    sha256(input.resultSha256);
    const retiredAt = timestamp(input.retiredAt);
    const terminalExpiresAt = timestamp(input.terminalExpiresAt);
    if (Date.parse(terminalExpiresAt) <= Date.parse(retiredAt)) invalidRecord();
    return Object.freeze({ ...input, retiredAt, terminalExpiresAt });
  }

  #canonicalDeletionIntent(
    input: ProjectDeletionIntentInput,
  ): ProjectDeletionIntentInput {
    opaqueId(input.operationId);
    memberId(input.authorizedMemberId);
    sha256(input.authorizationSha256);
    if (!DELETION_REASONS.has(input.reason)) invalidRecord();
    opaqueId(input.terminalOperationId);
    if (!TERMINAL_OPERATION_KINDS.has(input.terminalOperationKind)) invalidRecord();
    positiveInteger(input.placementGeneration);
    if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/u.test(input.storageNodeId)) {
      invalidRecord();
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(input.repositoryStorageKey)) {
      invalidRecord();
    }
    return Object.freeze({ ...input, createdAt: timestamp(input.createdAt) });
  }

  async #verifyMinimalDeletionPartition(
    intent: ProjectDeletionIntentRecord,
  ): Promise<void> {
    const forbidden = await this.#query<{
      readonly relation: string;
      readonly row_count: string;
    }>(
      `SELECT relation, row_count
         FROM (
           SELECT 'projects' AS relation, count(*)::text AS row_count
             FROM claudian_cloud.projects WHERE project_id = $1
           UNION ALL SELECT 'project_memberships', count(*)::text
             FROM claudian_cloud.project_memberships WHERE project_id = $1
           UNION ALL SELECT 'repository_placements', count(*)::text
             FROM claudian_cloud.repository_placements WHERE project_id = $1
           UNION ALL SELECT 'development_actor_mappings', count(*)::text
             FROM claudian_cloud.development_actor_mappings WHERE project_id = $1
           UNION ALL SELECT 'development_bootstrap_attempts', count(*)::text
             FROM claudian_cloud.development_bootstrap_attempts WHERE project_id = $1
           UNION ALL SELECT 'project_events', count(*)::text
             FROM claudian_cloud.project_events WHERE project_id = $1
           UNION ALL SELECT 'change_requests', count(*)::text
             FROM claudian_cloud.change_requests WHERE project_id = $1
           UNION ALL SELECT 'request_comments', count(*)::text
             FROM claudian_cloud.request_comments WHERE project_id = $1
           UNION ALL SELECT 'tickets', count(*)::text
             FROM claudian_cloud.tickets WHERE project_id = $1
           UNION ALL SELECT 'ticket_comments', count(*)::text
             FROM claudian_cloud.ticket_comments WHERE project_id = $1
           UNION ALL SELECT 'request_ticket_relations', count(*)::text
             FROM claudian_cloud.request_ticket_relations WHERE project_id = $1
           UNION ALL SELECT 'ticket_mentions', count(*)::text
             FROM claudian_cloud.ticket_mentions WHERE project_id = $1
           UNION ALL SELECT 'idempotency_results', count(*)::text
             FROM claudian_cloud.idempotency_results WHERE project_id = $1
           UNION ALL SELECT 'cloud_project_creation_journals', count(*)::text
             FROM claudian_cloud.cloud_project_creation_journals
            WHERE project_id = $1
           UNION ALL SELECT 'project_invitations', count(*)::text
             FROM claudian_cloud.project_invitations WHERE project_id = $1
           UNION ALL SELECT 'cloud_project_join_journals', count(*)::text
             FROM claudian_cloud.cloud_project_join_journals WHERE project_id = $1
           UNION ALL SELECT 'protected_invitation_envelopes', count(*)::text
             FROM claudian_cloud.protected_invitation_envelopes
            WHERE project_id = $1
           UNION ALL SELECT 'secret_replay_tombstones', count(*)::text
             FROM claudian_cloud.secret_replay_tombstones WHERE project_id = $1
           UNION ALL SELECT 'project_membership_idempotency_tombstones', count(*)::text
             FROM claudian_cloud.project_membership_idempotency_tombstones
            WHERE project_id = $1
           UNION ALL SELECT 'manager_responsibility_offers', count(*)::text
             FROM claudian_cloud.manager_responsibility_offers
            WHERE project_id = $1
           UNION ALL SELECT 'project_member_removal_journals', count(*)::text
             FROM claudian_cloud.project_member_removal_journals
            WHERE project_id = $1
           UNION ALL SELECT 'transferred_membership_claim_overrides', count(*)::text
             FROM claudian_cloud.transferred_membership_claim_overrides
            WHERE project_id = $1
           UNION ALL SELECT 'protected_claim_override_envelopes', count(*)::text
             FROM claudian_cloud.protected_claim_override_envelopes
            WHERE project_id = $1
           UNION ALL SELECT 'leave_project_request_facts', count(*)::text
             FROM claudian_cloud.leave_project_request_facts WHERE project_id = $1
           UNION ALL SELECT 'accept_journals', count(*)::text
             FROM claudian_cloud.accept_journals WHERE project_id = $1
           UNION ALL SELECT 'project_principal_bindings', count(*)::text
             FROM claudian_cloud.project_principal_bindings WHERE project_id = $1
           UNION ALL SELECT 'authority_transfer_recovery', count(*)::text
             FROM claudian_cloud.authority_transfer_recovery WHERE project_id = $1
           UNION ALL SELECT 'transferred_membership_claims', count(*)::text
             FROM claudian_cloud.transferred_membership_claims WHERE project_id = $1
           UNION ALL SELECT 'transfer_claim_batch_receipts', count(*)::text
             FROM claudian_cloud.transfer_claim_batch_receipts WHERE project_id = $1
           UNION ALL SELECT 'leave_former_principal_replays', count(*)::text
             FROM claudian_cloud.leave_former_principal_replays WHERE project_id = $1
           UNION ALL SELECT 'project_backup_catalog', count(*)::text
             FROM claudian_cloud.project_backup_catalog WHERE project_id = $1
         ) AS counts
        WHERE row_count <> '0'`,
      [this.#projectId],
    );
    if (forbidden.length !== 0) dependencyFailure();

    const continuity = await this.#query<{
      readonly bad_candidate_count: string;
      readonly bad_journal_count: string;
      readonly bad_key_count: string;
      readonly bad_receipt_count: string;
      readonly bad_responder_count: string;
      readonly candidate_count: string;
      readonly deletion_intent_count: string;
      readonly responder_count: string;
      readonly tombstone_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text
            FROM claudian_cloud.recovery_candidates
           WHERE project_id = $1
             AND (kind <> 'delete' OR operation_id <> $2)) AS bad_candidate_count,
         (SELECT count(*)::text
            FROM claudian_cloud.project_lifecycle_journals AS journal
           WHERE journal.project_id = $1
             AND journal.operation_id <> $2
             AND journal.operation_id <> $4
             AND NOT EXISTS (
               SELECT 1
                 FROM claudian_cloud.source_protected_claim_envelopes AS envelope
                WHERE envelope.project_id = journal.project_id
                  AND envelope.transfer_id = journal.operation_id
             )) AS bad_journal_count,
         (SELECT count(*)::text
            FROM claudian_cloud.transfer_receipt_keys AS receipt_key
           WHERE receipt_key.project_id = $1
             AND NOT EXISTS (
               SELECT 1
                 FROM claudian_cloud.source_protected_claim_envelopes AS envelope
                WHERE envelope.project_id = receipt_key.project_id
                  AND envelope.transfer_id = receipt_key.transfer_id
                  AND envelope.receipt_key_id = receipt_key.receipt_key_id
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM claudian_cloud.transfer_redemption_receipts AS receipt
                WHERE receipt.project_id = receipt_key.project_id
                  AND receipt.transfer_id = receipt_key.transfer_id
                  AND receipt.receipt_key_id = receipt_key.receipt_key_id
             )) AS bad_key_count,
         (SELECT count(*)::text
            FROM claudian_cloud.transfer_redemption_receipts AS receipt
           WHERE receipt.project_id = $1
             AND (
               $3 <> 'authority-transfer'
               OR receipt.transfer_id <> $4
               OR receipt.acknowledged_at IS NULL
             )) AS bad_receipt_count,
         (SELECT count(*)::text
            FROM claudian_cloud.project_terminal_responders
           WHERE project_id = $1
             AND (operation_kind, operation_id) <> ($3, $4))
           AS bad_responder_count,
         (SELECT count(*)::text FROM claudian_cloud.recovery_candidates
           WHERE project_id = $1 AND kind = 'delete' AND operation_id = $2)
           AS candidate_count,
         (SELECT count(*)::text FROM claudian_cloud.project_deletion_intents
           WHERE project_id = $1 AND operation_id = $2)
           AS deletion_intent_count,
         (SELECT count(*)::text FROM claudian_cloud.project_terminal_responders
           WHERE project_id = $1 AND operation_kind = $3 AND operation_id = $4)
           AS responder_count,
         (SELECT count(*)::text FROM claudian_cloud.project_tombstones
           WHERE project_id = $1 AND terminal_operation_kind = $3
             AND terminal_operation_id = $4) AS tombstone_count`,
      [
        this.#projectId,
        intent.operationId,
        intent.terminalOperationKind,
        intent.terminalOperationId,
      ],
    );
    const row = continuity[0];
    if (
      row === undefined
      || row.bad_candidate_count !== '0'
      || row.bad_journal_count !== '0'
      || row.bad_key_count !== '0'
      || row.bad_receipt_count !== '0'
      || row.bad_responder_count !== '0'
      || row.candidate_count !== '1'
      || row.deletion_intent_count !== '1'
      || (row.responder_count !== '0' && row.responder_count !== '1')
      || row.tombstone_count !== '1'
    ) dependencyFailure();
  }

  #canonicalBackup(input: ProjectBackupCatalogInput): ProjectBackupCatalogInput {
    opaqueId(input.backupId);
    sha256(input.checkpointSha256);
    positiveInteger(input.authorityGeneration);
    positiveInteger(input.coordinationSchemaVersion);
    positiveInteger(input.placementGeneration);
    if (
      input.serverBuild.length === 0
      || Buffer.byteLength(input.serverBuild, 'utf8') > 128
      || !PRINCIPAL_PATTERN.test(input.authorityVolumeIdentity)
    ) invalidRecord();
    return Object.freeze({ ...input, createdAt: timestamp(input.createdAt) });
  }

  async #upsertRecoveryCandidate(
    kind: ProjectLifecycleKind,
    operationId: string,
    scheduledAt: CollabIsoTimestamp,
    createdAt: CollabIsoTimestamp,
  ): Promise<void> {
    const rows = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.recovery_candidates (
         kind, project_id, operation_id, scheduled_at, created_at
       ) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (kind, project_id) DO UPDATE
         SET scheduled_at = EXCLUDED.scheduled_at
       WHERE claudian_cloud.recovery_candidates.operation_id
             = EXCLUDED.operation_id
       RETURNING operation_id`,
      [kind, this.#projectId, operationId, scheduledAt, createdAt],
    );
    if (rows[0]?.operation_id !== operationId) stateConflict();
  }
}
