import { createHash } from 'node:crypto';

import {
  COLLAB_CHECKPOINT_PORTABLE_RECORD_KINDS,
  COLLAB_PROJECT_BACKUP_RECORD_KINDS,
  COLLAB_PROTOCOL_VERSION,
  collabControlOperationCodec,
  collabMemberRef,
  collabProjectBackupIdempotencyRecordId,
  decodeCollabAuthorityRelinquishmentProof,
  decodeCollabCloudProjectEventMessage,
  decodeCollabProjectBackupCheckpointCoordinationNdjson,
  decodeCollabProjectCheckpointCoordinationNdjson,
  encodeCollabProjectBackupCheckpointCoordinationNdjson,
  encodeCollabProjectCheckpointCoordinationNdjson,
  encodeCollabProtectedClaimAssociatedData,
  isCollabOpaqueId,
  type CollabCheckpointPortableRecord,
  type CollabCheckpointProfile,
  type CollabControlOperation,
  type CollabIsoTimestamp,
  type CollabProjectBackupRecord,
} from '@claudian-collab/protocol';
import type { QueryResultRow } from 'pg';

import { CoordinationError } from '../CoordinationError.js';
import type {
  ProjectCheckpointPersistence,
  ProjectCheckpointRecord,
  ReadProjectCheckpointRecordsInput,
} from '../ProjectCheckpointPersistence.js';

type ProjectQuery = <Row extends QueryResultRow>(
  sql: string,
  values: readonly unknown[],
) => Promise<readonly Row[]>;

const KIND_ORDER = new Map<string, number>(
  COLLAB_PROJECT_BACKUP_RECORD_KINDS.map((kind, index) => [kind, index]),
);
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function invalidRecord(): never {
  throw new CoordinationError('invalid-record');
}

function dependencyFailure(): never {
  throw new CoordinationError('dependency-failed');
}

function resourceLimit(): never {
  throw new CoordinationError('resource-limit');
}

function safeInteger(value: string | number, allowZero = false): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < (allowZero ? 0 : 1)
  ) dependencyFailure();
  return parsed;
}

function iso(value: Date): CollabIsoTimestamp {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    dependencyFailure();
  }
  return value.toISOString();
}

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return dependencyFailure();
  }
}

function recordId(kind: string, identity: string): string {
  const direct = `${kind}:${identity}`;
  if (direct.length <= 128 && IDENTITY_PATTERN.test(direct)) return direct;
  return `${kind}:${createHash('sha256').update(identity).digest('hex')}`;
}

class BoundedCheckpointRecords {
  readonly #maximumBytes: number;
  readonly #records: ProjectCheckpointRecord[] = [];
  #byteCount = 0;

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      invalidRecord();
    }
    this.#maximumBytes = maximumBytes;
  }

  get maximumBytes(): number {
    return this.#maximumBytes;
  }

  assertIntermediateBytes(byteCount: number): void {
    if (!Number.isSafeInteger(byteCount) || byteCount > this.#maximumBytes) {
      resourceLimit();
    }
  }

  push(...records: readonly ProjectCheckpointRecord[]): number {
    for (const record of records) {
      const encodedBytes = Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
      if (this.#byteCount > this.#maximumBytes - encodedBytes) resourceLimit();
      this.#byteCount += encodedBytes;
      this.#records.push(record);
    }
    return this.#records.length;
  }

  canonical(
    profile: Extract<CollabCheckpointProfile, 'backup' | 'export'>,
  ): readonly ProjectCheckpointRecord[] {
    const allowed = new Set<string>(profile === 'backup'
      ? COLLAB_PROJECT_BACKUP_RECORD_KINDS
      : COLLAB_CHECKPOINT_PORTABLE_RECORD_KINDS);
    const sorted = [...this.#records].sort((left, right) => (
      (KIND_ORDER.get(left.kind) ?? Number.MAX_SAFE_INTEGER)
        - (KIND_ORDER.get(right.kind) ?? Number.MAX_SAFE_INTEGER)
      || left.recordId.localeCompare(right.recordId, 'en-US')
    ));
    if (sorted.some(record => !allowed.has(record.kind))) invalidRecord();
    try {
      const encoded = profile === 'backup'
        ? encodeCollabProjectBackupCheckpointCoordinationNdjson(
          sorted as readonly CollabProjectBackupRecord[],
        )
        : encodeCollabProjectCheckpointCoordinationNdjson(
          sorted as readonly CollabCheckpointPortableRecord[],
          'export',
        );
      if (Buffer.byteLength(encoded, 'utf8') > this.#maximumBytes) {
        resourceLimit();
      }
      return profile === 'backup'
        ? decodeCollabProjectBackupCheckpointCoordinationNdjson(encoded)
        : decodeCollabProjectCheckpointCoordinationNdjson(
          encoded,
          'export',
        ) as readonly CollabCheckpointPortableRecord[];
    } catch (error: unknown) {
      if (error instanceof CoordinationError) throw error;
      return invalidRecord();
    }
  }
}

const MAXIMUM_CHECKPOINT_QUERY_PAGE_ROWS = 256;

export class PostgresProjectCheckpointPersistence
implements ProjectCheckpointPersistence {
  readonly #projectId: string;
  readonly #query: ProjectQuery;

  constructor(projectId: string, query: ProjectQuery) {
    if (!IDENTITY_PATTERN.test(projectId)) invalidRecord();
    this.#projectId = projectId;
    this.#query = query;
  }

  async readProjectCheckpointRecords(
    input: ReadProjectCheckpointRecordsInput,
  ): Promise<readonly ProjectCheckpointRecord[]> {
    if (
      !isCollabOpaqueId(input.excludedOperationId)
      || !IDENTITY_PATTERN.test(input.metadata.authorityId)
      || !IDENTITY_PATTERN.test(input.metadata.authorityVolumeIdentity)
      || !Number.isSafeInteger(input.metadata.coordinationSchemaVersion)
      || input.metadata.coordinationSchemaVersion < 1
      || !Number.isSafeInteger(input.metadata.repositoryFormatVersion)
      || input.metadata.repositoryFormatVersion < 1
      || !Number.isSafeInteger(input.metadata.restoreEpoch)
      || input.metadata.restoreEpoch < 1
      || input.metadata.minimumServerBuild.length === 0
      || input.metadata.maximumServerBuild.length === 0
      || !Number.isSafeInteger(input.maximumCoordinationBytes)
      || input.maximumCoordinationBytes <= 0
      || new Date(input.snapshotAt).toISOString() !== input.snapshotAt
    ) invalidRecord();

    const records = new BoundedCheckpointRecords(input.maximumCoordinationBytes);
    await this.#readPortable(records);
    if (input.profile === 'backup') await this.#readBackup(records, input);
    return records.canonical(input.profile);
  }

  async #readPortable(records: BoundedCheckpointRecords): Promise<void> {
    const projects = await this.#query<{
      readonly activated_at: Date;
      readonly authority_generation: string;
      readonly authority_state_revision: string;
      readonly created_at: Date;
      readonly expected_main_oid: string;
      readonly manager_set_generation: string;
      readonly project_name: string;
    }>(
      `SELECT activated_at, authority_generation, authority_state_revision,
              created_at, expected_main_oid, manager_set_generation, project_name
         FROM claudian_cloud.projects
        WHERE project_id = $1`,
      [this.#projectId],
    );
    const project = projects[0];
    if (project === undefined || projects.length !== 1) dependencyFailure();
    records.push(Object.freeze({
      kind: 'project',
      recordId: this.#projectId,
      revision: safeInteger(project.authority_state_revision),
      value: Object.freeze({
        activatedAt: iso(project.activated_at),
        authorityGeneration: safeInteger(project.authority_generation),
        createdAt: iso(project.created_at),
        expectedMainOid: project.expected_main_oid,
        managerSetGeneration: safeInteger(project.manager_set_generation, true),
        name: project.project_name,
        projectId: this.#projectId,
      }),
    }));

    for await (const member of this.#queryRows<{
      readonly activated_at: Date | null;
      readonly created_at: Date;
      readonly display_name: string;
      readonly left_at: Date | null;
      readonly member_id: string;
      readonly revision: string;
      readonly revoked_at: Date | null;
      readonly role: 'manager' | 'member';
      readonly status: 'active' | 'left' | 'revoked';
      readonly updated_at: Date;
    }>(
      `SELECT activated_at, created_at, display_name, left_at, member_id,
              revision, revoked_at, role, status, updated_at
         FROM claudian_cloud.project_memberships
        WHERE project_id = $1 AND status <> 'pending'
        ORDER BY member_id`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'member',
      recordId: member.member_id,
      revision: safeInteger(member.revision),
      value: Object.freeze({
        activatedAt: member.activated_at === null ? null : iso(member.activated_at),
        createdAt: iso(member.created_at),
        displayName: member.display_name,
        memberId: member.member_id,
        personalRef: collabMemberRef(member.member_id),
        projectId: this.#projectId,
        role: member.role,
        status: member.status,
        revokedAt: member.status === 'active'
          ? null
          : member.status === 'left'
            ? member.left_at === null ? dependencyFailure() : iso(member.left_at)
            : member.revoked_at === null
              ? dependencyFailure()
              : iso(member.revoked_at),
        updatedAt: iso(member.updated_at),
      }),
    }));

    for await (const request of this.#queryRows<{
      readonly created_at: Date;
      readonly description: string;
      readonly first_base_oid: string;
      readonly latest_head_oid: string;
      readonly member_id: string;
      readonly merged_oid: string | null;
      readonly request_id: string;
      readonly revision: string;
      readonly status: 'discarded' | 'merged' | 'open';
      readonly updated_at: Date;
    }>(
      `SELECT created_at, description, first_base_oid, latest_head_oid,
              member_id, merged_oid, request_id, revision, status, updated_at
         FROM claudian_cloud.change_requests
        WHERE project_id = $1
        ORDER BY request_id`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'request',
      recordId: request.request_id,
      revision: safeInteger(request.revision),
      value: Object.freeze({
        createdAt: iso(request.created_at),
        description: request.description,
        firstBaseOid: request.first_base_oid,
        latestHeadOid: request.latest_head_oid,
        memberId: request.member_id,
        mergedOid: request.merged_oid,
        projectId: this.#projectId,
        requestId: request.request_id,
        status: request.status,
        updatedAt: iso(request.updated_at),
      }),
    }));

    for await (const comment of this.#queryRows<{
      readonly author_member_id: string;
      readonly body: string;
      readonly comment_id: string;
      readonly created_at: Date;
      readonly request_id: string;
    }>(
      `SELECT author_member_id, body, comment_id, created_at, request_id
         FROM claudian_cloud.request_comments
        WHERE project_id = $1
        ORDER BY comment_id`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'request-comment',
      recordId: comment.comment_id,
      revision: 1,
      value: Object.freeze({
        authorMemberId: comment.author_member_id,
        body: comment.body,
        commentId: comment.comment_id,
        createdAt: iso(comment.created_at),
        projectId: this.#projectId,
        requestId: comment.request_id,
      }),
    }));

    for await (const ticket of this.#queryRows<{
      readonly author_member_id: string;
      readonly body: string;
      readonly closed_at: Date | null;
      readonly closed_by_member_id: string | null;
      readonly created_at: Date;
      readonly revision: string;
      readonly status: 'closed' | 'open';
      readonly ticket_id: string;
      readonly ticket_number: string;
      readonly title: string;
      readonly updated_at: Date;
    }>(
      `SELECT author_member_id, body, closed_at, closed_by_member_id, created_at,
              revision, status, ticket_id, ticket_number, title, updated_at
         FROM claudian_cloud.tickets
        WHERE project_id = $1
        ORDER BY ticket_id`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'ticket',
      recordId: ticket.ticket_id,
      revision: safeInteger(ticket.revision),
      value: Object.freeze({
        authorMemberId: ticket.author_member_id,
        body: ticket.body,
        closedAt: ticket.closed_at === null ? null : iso(ticket.closed_at),
        closedByMemberId: ticket.closed_by_member_id,
        createdAt: iso(ticket.created_at),
        number: safeInteger(ticket.ticket_number),
        projectId: this.#projectId,
        status: ticket.status,
        ticketId: ticket.ticket_id,
        title: ticket.title,
        updatedAt: iso(ticket.updated_at),
      }),
    }));

    for await (const comment of this.#queryRows<{
      readonly author_member_id: string;
      readonly body: string;
      readonly comment_id: string;
      readonly created_at: Date;
      readonly ticket_id: string;
    }>(
      `SELECT author_member_id, body, comment_id, created_at, ticket_id
         FROM claudian_cloud.ticket_comments
        WHERE project_id = $1
        ORDER BY comment_id`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'ticket-comment',
      recordId: comment.comment_id,
      revision: 1,
      value: Object.freeze({
        authorMemberId: comment.author_member_id,
        body: comment.body,
        commentId: comment.comment_id,
        createdAt: iso(comment.created_at),
        projectId: this.#projectId,
        ticketId: comment.ticket_id,
      }),
    }));

    for await (const relation of this.#queryRows<{
      readonly accepted_at: Date | null;
      readonly accepted_merge_oid: string | null;
      readonly commit_oid: string;
      readonly created_at: Date;
      readonly created_by_member_id: string;
      readonly kind: 'references' | 'resolves';
      readonly relation_id: string;
      readonly request_id: string;
      readonly state: 'accepted' | 'pending';
      readonly ticket_id: string;
      readonly updated_at: Date;
    }>(
      `SELECT accepted_at, accepted_merge_oid, commit_oid, created_at,
              created_by_member_id, kind, relation_id, request_id, state,
              ticket_id, updated_at
         FROM claudian_cloud.request_ticket_relations
        WHERE project_id = $1
        ORDER BY relation_id`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'ticket-relation',
      recordId: relation.relation_id,
      revision: 1,
      value: Object.freeze({
        acceptedAt: relation.accepted_at === null ? null : iso(relation.accepted_at),
        acceptedMergeOid: relation.accepted_merge_oid,
        commitOid: relation.commit_oid,
        createdAt: iso(relation.created_at),
        createdByMemberId: relation.created_by_member_id,
        kind: relation.kind,
        projectId: this.#projectId,
        relationId: relation.relation_id,
        requestId: relation.request_id,
        state: relation.state,
        ticketId: relation.ticket_id,
        updatedAt: iso(relation.updated_at),
      }),
    }));

    for await (const mention of this.#queryRows<{
      readonly created_at: Date;
      readonly mentioned_member_id: string;
      readonly source_id: string;
      readonly source_kind: 'comment' | 'description';
      readonly ticket_id: string;
    }>(
      `SELECT created_at, mentioned_member_id, source_id, source_kind, ticket_id
         FROM claudian_cloud.ticket_mentions
        WHERE project_id = $1
        ORDER BY ticket_id, source_kind, source_id, mentioned_member_id`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'ticket-mention',
      recordId: recordId('ticket-mention', [
        mention.ticket_id,
        mention.source_kind,
        mention.source_id,
        mention.mentioned_member_id,
      ].join('\0')),
      revision: 1,
      value: Object.freeze({
        createdAt: iso(mention.created_at),
        mentionedMemberId: mention.mentioned_member_id,
        projectId: this.#projectId,
        sourceId: mention.source_id,
        sourceKind: mention.source_kind,
        ticketId: mention.ticket_id,
      }),
    }));
  }

  async #readBackup(
    records: BoundedCheckpointRecords,
    input: ReadProjectCheckpointRecordsInput,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly kind: string;
      readonly occurred_at: Date;
      readonly payload: unknown;
      readonly sequence: string;
    }>(
      `SELECT kind, occurred_at, payload, sequence
         FROM claudian_cloud.project_events
        WHERE project_id = $1
        ORDER BY sequence`,
      [this.#projectId],
      records,
    )) {
      const sequence = safeInteger(row.sequence);
      let event;
      try {
        event = decodeCollabCloudProjectEventMessage({
          kind: row.kind,
          occurredAt: iso(row.occurred_at),
          payload: row.payload,
          projectId: this.#projectId,
          protocolVersion: COLLAB_PROTOCOL_VERSION,
          sequence,
        });
      } catch {
        return dependencyFailure();
      }
      if (event.kind === 'snapshot.required') dependencyFailure();
      records.push(Object.freeze({
        kind: 'cloud-event',
        recordId: String(sequence).padStart(20, '0'),
        revision: sequence,
        value: Object.freeze({ event }),
      }));
    }
    const cursors = await this.#query<{
      readonly current_sequence: string;
      readonly updated_at: Date;
    }>(
      `SELECT current_sequence, updated_at
         FROM claudian_cloud.project_event_sequences
        WHERE project_id = $1`,
      [this.#projectId],
    );
    const cursor = cursors[0];
    const currentSequence = cursor === undefined
      ? 0
      : safeInteger(cursor.current_sequence);
    records.push(Object.freeze({
      kind: 'cloud-event-cursor',
      recordId: this.#projectId,
      revision: Math.max(1, currentSequence),
      value: Object.freeze({
        currentSequence,
        projectId: this.#projectId,
        updatedAt: cursor === undefined ? input.snapshotAt : iso(cursor.updated_at),
      }),
    }));

    for await (const row of this.#queryRows<{
      readonly created_at: Date;
      readonly idempotency_key: string;
      readonly member_id: string;
      readonly operation: CollabControlOperation;
      readonly request_fingerprint: string;
      readonly response_json: unknown;
    }>(
      `SELECT created_at, idempotency_key, member_id, operation,
              request_fingerprint, response_json
         FROM claudian_cloud.idempotency_results
        WHERE project_id = $1
        ORDER BY member_id, operation, idempotency_key`,
      [this.#projectId],
      records,
    )) {
      let responseJson: string;
      try {
        responseJson = JSON.stringify(
          collabControlOperationCodec(row.operation).decodeResponse(
            row.response_json,
          ),
        );
      } catch {
        return dependencyFailure();
      }
      const value = Object.freeze({
        createdAt: iso(row.created_at),
        idempotencyKey: row.idempotency_key,
        memberId: row.member_id,
        operation: row.operation,
        projectId: this.#projectId,
        requestFingerprint: row.request_fingerprint,
        responseJson,
      });
      records.push(Object.freeze({
        kind: 'idempotency-result',
        recordId: collabProjectBackupIdempotencyRecordId(value),
        revision: 1,
        value,
      }));
    }

    for await (const row of this.#queryRows<{
      readonly bound_at: Date;
      readonly member_id: string;
      readonly principal_id: string;
    }>(
      `SELECT bound_at, member_id, principal_id
         FROM claudian_cloud.project_principal_bindings
        WHERE project_id = $1 AND state = 'active'
        ORDER BY principal_id`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'principal-binding',
      recordId: row.member_id,
      revision: 1,
      value: Object.freeze({
        boundAt: iso(row.bound_at),
        memberId: row.member_id,
        principalId: row.principal_id,
        projectId: this.#projectId,
      }),
    }));

    const placements = await this.#query<{
      readonly generation: string;
      readonly repository_storage_key: string;
      readonly storage_node_id: string;
    }>(
      `SELECT generation, repository_storage_key, storage_node_id
         FROM claudian_cloud.repository_placements
        WHERE project_id = $1 AND active = true`,
      [this.#projectId],
    );
    const placement = placements[0];
    if (placement === undefined || placements.length !== 1) dependencyFailure();
    records.push(Object.freeze({
      kind: 'repository-placement',
      recordId: recordId('repository-placement', this.#projectId),
      revision: safeInteger(placement.generation),
      value: Object.freeze({
        nodeId: placement.storage_node_id,
        placementGeneration: safeInteger(placement.generation),
        projectId: this.#projectId,
        repositoryIdentity: placement.repository_storage_key,
      }),
    }));

    await this.#readLifecycle(records, input.excludedOperationId);
    await this.#readAuthorityTransferRecovery(records, input.excludedOperationId);
    await this.#readTransferredClaims(records, input.excludedOperationId);
    await this.#readTransferReceiptKeys(records, input.excludedOperationId);
    await this.#readTransferBatchReceipts(records, input.excludedOperationId);
    await this.#readTransferRedemptionReceipts(records, input.excludedOperationId);
    await this.#readTerminalResponders(records);
    await this.#readLeaveReplays(records, input.excludedOperationId);
    await this.#readProtectedEnvelopes(records);
    const tombstones = await this.#query<{
      readonly authority_generation: string;
      readonly retired_at: Date;
      readonly terminal_expires_at: Date;
    }>(
      `SELECT authority_generation, retired_at, terminal_expires_at
         FROM claudian_cloud.project_tombstones
        WHERE project_id = $1`,
      [this.#projectId],
    );
    const tombstone = tombstones[0];
    if (tombstone !== undefined) records.push(Object.freeze({
        kind: 'tombstone',
      recordId: this.#projectId,
      revision: 1,
      value: Object.freeze({
        authorityGeneration: safeInteger(tombstone.authority_generation),
        projectId: this.#projectId,
        retiredAt: iso(tombstone.retired_at),
        terminalExpiresAt: iso(tombstone.terminal_expires_at),
      }),
    }));

    records.push(
      Object.freeze({
        kind: 'schema-catalog',
        recordId: this.#projectId,
        revision: 1,
        value: Object.freeze({
          coordinationSchemaVersion: input.metadata.coordinationSchemaVersion,
          projectId: this.#projectId,
          repositoryFormatVersion: input.metadata.repositoryFormatVersion,
        }),
      }),
      Object.freeze({
        kind: 'server-compatibility',
        recordId: this.#projectId,
        revision: 1,
        value: Object.freeze({
          maximumBuild: input.metadata.maximumServerBuild,
          minimumBuild: input.metadata.minimumServerBuild,
          projectId: this.#projectId,
        }),
      }),
      Object.freeze({
        kind: 'authority-volume-pair',
        recordId: this.#projectId,
        revision: 1,
        value: Object.freeze({
          authorityId: input.metadata.authorityId,
          authorityVolumeIdentity: input.metadata.authorityVolumeIdentity,
          projectId: this.#projectId,
          restoreEpoch: input.metadata.restoreEpoch,
        }),
      }),
    );
  }

  async #readLifecycle(
    records: BoundedCheckpointRecords,
    excludedOperationId: string,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly actor_member_id: string | null;
      readonly batch_revision: string | null;
      readonly batch_sha256: string | null;
      readonly checkpoint_sha256: string | null;
      readonly created_at: Date;
      readonly direction: 'cloud-to-lan' | 'lan-to-cloud' | null;
      readonly expected_authority_generation: string;
      readonly expected_personal_ref_oid: string | null;
      readonly idempotency_key: string;
      readonly kind: 'authority-transfer' | 'backup' | 'delete' | 'export' | 'leave' | 'retire';
      readonly operation_id: string;
      readonly phase: string;
      readonly recovery_from_phase: string | null;
      readonly request_fingerprint: string;
      readonly result_sha256: string | null;
      readonly scheduled_at: Date;
      readonly state: 'active' | 'cancelled' | 'completed' | 'recovery-required';
      readonly updated_at: Date;
    }>(
      `SELECT actor_member_id, batch_revision, batch_sha256,
              checkpoint_sha256, created_at, direction,
              expected_authority_generation, expected_personal_ref_oid,
              idempotency_key, kind, operation_id, phase,
              recovery_from_phase, request_fingerprint, result_sha256,
              scheduled_at, state, updated_at
         FROM claudian_cloud.project_lifecycle_journals
        WHERE project_id = $1 AND operation_id <> $2
        ORDER BY operation_id`,
      [this.#projectId, excludedOperationId],
      records,
    )) records.push(Object.freeze({
      kind: 'lifecycle-journal',
      recordId: row.operation_id,
      revision: 1,
      value: Object.freeze({
        actorMemberId: row.actor_member_id,
        batchRevision: row.batch_revision === null
          ? null
          : safeInteger(row.batch_revision),
        batchSha256: row.batch_sha256,
        checkpointSha256: row.checkpoint_sha256,
        createdAt: iso(row.created_at),
        direction: row.direction,
        expectedAuthorityGeneration: safeInteger(row.expected_authority_generation),
        expectedPersonalRefOid: row.expected_personal_ref_oid,
        idempotencyKey: row.idempotency_key,
        operationId: row.operation_id,
        operationKind: row.kind,
        phase: row.phase,
        projectId: this.#projectId,
        recoveryFromPhase: row.recovery_from_phase,
        requestFingerprint: row.request_fingerprint,
        resultSha256: row.result_sha256,
        scheduledAt: iso(row.scheduled_at),
        state: row.state,
        updatedAt: iso(row.updated_at),
      }),
    }));
  }

  async #readAuthorityTransferRecovery(
    records: BoundedCheckpointRecords,
    excludedOperationId: string,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly cancellation_request_sha256: string | null;
      readonly created_at: Date;
      readonly expires_at: Date;
      readonly inactive_publication_json: string | null;
      readonly relinquishment_proof_json: string | null;
      readonly source_authority_generation: string;
      readonly source_authority_kind: 'cloud' | 'lan';
      readonly source_host_member_id: string | null;
      readonly source_proof: string | null;
      readonly source_reopen_sha256: string | null;
      readonly stage_sha256: string | null;
      readonly target_activation_proof: string | null;
      readonly target_activation_request_sha256: string | null;
      readonly target_authority_generation: string;
      readonly target_authority_kind: 'cloud' | 'lan';
      readonly target_host_member_id: string | null;
      readonly target_proof: string | null;
      readonly target_url: string;
      readonly transfer_id: string;
      readonly updated_at: Date;
    }>(
      `SELECT cancellation_request_sha256, created_at, expires_at,
              inactive_publication_json, relinquishment_proof_json,
              source_authority_generation, source_authority_kind,
              source_host_member_id, source_proof, source_reopen_sha256,
              stage_sha256, target_activation_proof,
              target_activation_request_sha256, target_authority_generation,
              target_authority_kind, target_host_member_id, target_proof,
              target_url, transfer_id, updated_at
         FROM claudian_cloud.authority_transfer_recovery
        WHERE project_id = $1 AND transfer_id <> $2
        ORDER BY transfer_id`,
      [this.#projectId, excludedOperationId],
      records,
    )) {
      let relinquishmentProof = null;
      if (row.relinquishment_proof_json !== null) {
        try {
          relinquishmentProof = decodeCollabAuthorityRelinquishmentProof(
            parsedJson(row.relinquishment_proof_json),
          );
        } catch {
          return dependencyFailure();
        }
      }
      records.push(Object.freeze({
        kind: 'authority-transfer-recovery',
        recordId: row.transfer_id,
        revision: 1,
        value: Object.freeze({
          cancellationRequestSha256: row.cancellation_request_sha256,
          createdAt: iso(row.created_at),
          expiresAt: iso(row.expires_at),
          inactivePublication: row.inactive_publication_json === null
            ? null
            : parsedJson(row.inactive_publication_json),
          projectId: this.#projectId,
          relinquishmentProof,
          sourceAuthority: Object.freeze({
            generation: safeInteger(row.source_authority_generation),
            kind: row.source_authority_kind,
          }),
          sourceHostMemberId: row.source_host_member_id,
          sourceEvidence: row.source_proof === null
            ? null
            : parsedJson(row.source_proof),
          sourceReopenSha256: row.source_reopen_sha256,
          stageSha256: row.stage_sha256,
          targetActivationProof: row.target_activation_proof,
          targetActivationRequestSha256: row.target_activation_request_sha256,
          targetAuthority: Object.freeze({
            generation: safeInteger(row.target_authority_generation),
            kind: row.target_authority_kind,
          }),
          targetHostMemberId: row.target_host_member_id,
          targetEvidence: row.target_proof === null
            ? null
            : parsedJson(row.target_proof),
          targetUrl: row.target_url,
          transferId: row.transfer_id,
          updatedAt: iso(row.updated_at),
        }),
      }) as CollabProjectBackupRecord);
    }
  }

  async #readTransferredClaims(
    records: BoundedCheckpointRecords,
    excludedOperationId: string,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly batch_revision: string;
      readonly checkpoint_sha256: string;
      readonly claim_sha256: string;
      readonly created_at: Date;
      readonly expires_at: Date;
      readonly member_id: string;
      readonly operation_intent_id: string | null;
      readonly redemption_receipt_id: string | null;
      readonly state: 'redeemed' | 'revoked' | 'unclaimed';
      readonly target_principal_id: string | null;
      readonly transfer_id: string;
      readonly updated_at: Date;
    }>(
      `SELECT batch_revision, checkpoint_sha256, claim_sha256, created_at,
              expires_at, member_id, operation_intent_id,
              redemption_receipt_id, state, target_principal_id,
              transfer_id, updated_at
         FROM claudian_cloud.transferred_membership_claims
        WHERE project_id = $1 AND transfer_id <> $2
        ORDER BY transfer_id, member_id`,
      [this.#projectId, excludedOperationId],
      records,
    )) records.push(Object.freeze({
      kind: 'transferred-membership-claim',
      recordId: `${row.transfer_id}:${row.member_id}`,
      revision: 1,
      value: Object.freeze({
        batchRevision: safeInteger(row.batch_revision),
        checkpointSha256: row.checkpoint_sha256,
        claimSha256: row.claim_sha256,
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
        memberId: row.member_id,
        operationIntentId: row.operation_intent_id,
        projectId: this.#projectId,
        redemptionReceiptId: row.redemption_receipt_id,
        state: row.state,
        targetPrincipalId: row.target_principal_id,
        transferId: row.transfer_id,
        updatedAt: iso(row.updated_at),
      }),
    }));
  }

  async #readTransferReceiptKeys(
    records: BoundedCheckpointRecords,
    excludedOperationId: string,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly created_at: Date;
      readonly public_key: string;
      readonly receipt_key_id: string;
      readonly signature_algorithm: 'ed25519';
      readonly transfer_id: string;
    }>(
      `SELECT created_at, public_key, receipt_key_id, signature_algorithm,
              transfer_id
         FROM claudian_cloud.transfer_receipt_keys
        WHERE project_id = $1 AND transfer_id <> $2
        ORDER BY transfer_id, receipt_key_id`,
      [this.#projectId, excludedOperationId],
      records,
    )) records.push(Object.freeze({
      kind: 'transfer-receipt-key',
      recordId: `${row.transfer_id}:${row.receipt_key_id}`,
      revision: 1,
      value: Object.freeze({
        createdAt: iso(row.created_at),
        projectId: this.#projectId,
        receiptKeyId: row.receipt_key_id,
        receiptPublicKey: row.public_key,
        receiptPublicKeyEncoding: 'base64url-raw' as const,
        signatureAlgorithm: row.signature_algorithm,
        transferId: row.transfer_id,
      }),
    }));
  }

  async #readTransferBatchReceipts(
    records: BoundedCheckpointRecords,
    excludedOperationId: string,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly receipt_json: string;
      readonly transfer_id: string;
    }>(
      `SELECT receipt_json, transfer_id
         FROM claudian_cloud.transfer_claim_batch_receipts
        WHERE project_id = $1 AND transfer_id <> $2
        ORDER BY transfer_id`,
      [this.#projectId, excludedOperationId],
      records,
    )) records.push(Object.freeze({
      kind: 'transfer-claim-batch-receipt',
      recordId: row.transfer_id,
      revision: 1,
      value: Object.freeze({ receipt: parsedJson(row.receipt_json) }),
    }) as CollabProjectBackupRecord);
  }

  async #readTransferRedemptionReceipts(
    records: BoundedCheckpointRecords,
    excludedOperationId: string,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly acknowledged_at: Date | null;
      readonly member_id: string;
      readonly receipt_json: string;
      readonly transfer_id: string;
    }>(
      `SELECT acknowledged_at, member_id, receipt_json, transfer_id
         FROM claudian_cloud.transfer_redemption_receipts
        WHERE project_id = $1 AND transfer_id <> $2
        ORDER BY transfer_id, member_id`,
      [this.#projectId, excludedOperationId],
      records,
    )) records.push(Object.freeze({
      kind: 'transfer-redemption-receipt',
      recordId: `${row.transfer_id}:${row.member_id}`,
      revision: 1,
      value: Object.freeze({
        acknowledgedAt: row.acknowledged_at === null
          ? null
          : iso(row.acknowledged_at),
        projectId: this.#projectId,
        receipt: parsedJson(row.receipt_json),
      }),
    }) as CollabProjectBackupRecord);
  }

  async #readTerminalResponders(
    records: BoundedCheckpointRecords,
  ): Promise<void> {
    for await (const responder of this.#queryRows<{
      readonly expires_at: Date;
      readonly operation_id: string;
      readonly operation_kind: 'authority-transfer' | 'retire';
      readonly replay_member_id: string | null;
      readonly replay_request_sha256: string | null;
      readonly response_json: string;
    }>(
      `SELECT expires_at, operation_id, operation_kind, replay_member_id,
              replay_request_sha256, response_json
         FROM claudian_cloud.project_terminal_responders
        WHERE project_id = $1
        ORDER BY operation_kind, operation_id`,
      [this.#projectId],
      records,
    )) {
      const acknowledgements: Array<Readonly<{
        readonly acknowledgedAt: CollabIsoTimestamp;
        readonly memberId: string;
        readonly principalId: string;
      }>> = [];
      const eligibleMemberIds: string[] = [];
      let principalBytes = 0;
      for await (const principal of this.#queryRows<{
        readonly acknowledged_at: Date | null;
        readonly member_id: string;
        readonly principal_id: string;
      }>(
        `SELECT acknowledged_at, member_id, principal_id
           FROM claudian_cloud.project_terminal_acknowledgements
          WHERE project_id = $1 AND operation_kind = $2 AND operation_id = $3
          ORDER BY member_id`,
        [this.#projectId, responder.operation_kind, responder.operation_id],
        records,
      )) {
        eligibleMemberIds.push(principal.member_id);
        const acknowledgement = principal.acknowledged_at === null
          ? undefined
          : Object.freeze({
              acknowledgedAt: iso(principal.acknowledged_at),
              memberId: principal.member_id,
              principalId: principal.principal_id,
            });
        if (acknowledgement !== undefined) acknowledgements.push(acknowledgement);
        records.push(Object.freeze({
          kind: 'terminal-principal',
          recordId: `${responder.operation_id}:${principal.member_id}`,
          revision: 1,
          value: Object.freeze({
            acknowledgedAt: principal.acknowledged_at === null
              ? null
              : iso(principal.acknowledged_at),
            memberId: principal.member_id,
            operationId: responder.operation_id,
            operationKind: responder.operation_kind,
            principalId: principal.principal_id,
            projectId: this.#projectId,
          }),
        }));
        principalBytes += Buffer.byteLength(
          JSON.stringify({ acknowledgement, memberId: principal.member_id }),
          'utf8',
        );
        records.assertIntermediateBytes(principalBytes);
      }
      records.push(Object.freeze({
        kind: 'terminal-responder',
        recordId: responder.operation_id,
        revision: 1,
        value: Object.freeze({
          acknowledgements: Object.freeze(acknowledgements),
          eligibleMemberIds: Object.freeze(eligibleMemberIds),
          expiresAt: iso(responder.expires_at),
          operation: responder.operation_kind === 'retire'
            ? 'retireProject' as const
            : 'getProjectAuthorityTransfer' as const,
          operationId: responder.operation_id,
          projectId: this.#projectId,
          responseJson: responder.response_json,
        }),
      }));
      if (responder.operation_kind === 'authority-transfer') {
        if (
          responder.replay_member_id === null
          || responder.replay_request_sha256 === null
        ) dependencyFailure();
        records.push(Object.freeze({
          kind: 'terminal-responder-replay',
          recordId: responder.operation_id,
          revision: 1,
          value: Object.freeze({
            memberId: responder.replay_member_id,
            operationId: responder.operation_id,
            projectId: this.#projectId,
            requestSha256: responder.replay_request_sha256,
          }),
        }));
      } else if (
        responder.replay_member_id !== null
        || responder.replay_request_sha256 !== null
      ) dependencyFailure();
    }
  }

  async #readLeaveReplays(
    records: BoundedCheckpointRecords,
    excludedOperationId: string,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly completed_at: Date | null;
      readonly created_at: Date;
      readonly expected_personal_ref_oid: string;
      readonly expires_at: Date;
      readonly intent_id: string;
      readonly member_id: string;
      readonly operation_id: string;
      readonly principal_sha256: string;
      readonly request_fingerprint: string;
      readonly result_sha256: string | null;
      readonly state: 'completed' | 'recovering';
    }>(
      `SELECT completed_at, created_at, expected_personal_ref_oid,
              expires_at, intent_id, member_id, operation_id,
              principal_sha256, request_fingerprint, result_sha256, state
         FROM claudian_cloud.leave_former_principal_replays
        WHERE project_id = $1 AND operation_id <> $2
        ORDER BY operation_id`,
      [this.#projectId, excludedOperationId],
      records,
    )) records.push(Object.freeze({
      kind: 'leave-former-principal-replay',
      recordId: row.operation_id,
      revision: 1,
      value: Object.freeze({
        completedAt: row.completed_at === null ? null : iso(row.completed_at),
        createdAt: iso(row.created_at),
        expectedPersonalRefOid: row.expected_personal_ref_oid,
        expiresAt: iso(row.expires_at),
        intentId: row.intent_id,
        memberId: row.member_id,
        operationId: row.operation_id,
        principalSha256: row.principal_sha256,
        projectId: this.#projectId,
        requestFingerprint: row.request_fingerprint,
        resultSha256: row.result_sha256,
        state: row.state,
      }),
    }));
  }

  async #readProtectedEnvelopes(
    records: BoundedCheckpointRecords,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly associated_data_sha256: string;
      readonly authority_generation: string;
      readonly checkpoint_sha256: string;
      readonly ciphertext: string;
      readonly claim_sha256: string;
      readonly encryption_algorithm: 'xchacha20-poly1305';
      readonly environment_identity: string;
      readonly envelope_version: 1;
      readonly expires_at: Date;
      readonly key_id: string;
      readonly key_version: number;
      readonly member_id: string;
      readonly nonce: string;
      readonly receipt_key_id: string;
      readonly tag: string;
      readonly transfer_id: string;
    }>(
      `SELECT associated_data_sha256, authority_generation, checkpoint_sha256,
              ciphertext, claim_sha256, encryption_algorithm,
              environment_identity, envelope_version, expires_at, key_id,
              key_version, member_id, nonce, receipt_key_id, tag, transfer_id
         FROM claudian_cloud.source_protected_claim_envelopes
        WHERE project_id = $1
        ORDER BY transfer_id, member_id`,
      [this.#projectId],
      records,
    )) {
      const associatedData = Object.freeze({
        authorityGeneration: safeInteger(row.authority_generation),
        checkpointSha256: row.checkpoint_sha256,
        claimSha256: row.claim_sha256,
        envelopeVersion: row.envelope_version,
        environmentIdentity: row.environment_identity,
        memberId: row.member_id,
        projectId: this.#projectId,
        transferId: row.transfer_id,
      });
      if (
        createHash('sha256')
          .update(encodeCollabProtectedClaimAssociatedData(associatedData))
          .digest('hex') !== row.associated_data_sha256
      ) dependencyFailure();
      records.push(Object.freeze({
        kind: 'protected-claim-envelope',
        recordId: `${row.transfer_id}:${row.member_id}`,
        revision: 1,
        value: Object.freeze({
          associatedData,
          associatedDataSha256: row.associated_data_sha256,
          ciphertext: row.ciphertext,
          encryptionAlgorithm: row.encryption_algorithm,
          expiresAt: iso(row.expires_at),
          keyId: row.key_id,
          keyVersion: safeInteger(row.key_version),
          memberId: row.member_id,
          nonce: row.nonce,
          receiptKeyId: row.receipt_key_id,
          tag: row.tag,
          transferId: row.transfer_id,
        }),
      }));
    }
  }

  async *#queryRows<Row extends QueryResultRow>(
    sql: string,
    values: readonly unknown[],
    records: BoundedCheckpointRecords,
  ): AsyncGenerator<Row> {
    const statistics = await this.#query<{
      readonly maximum_row_bytes: string;
      readonly row_count: string;
    }>(
      `SELECT COALESCE(
                max(octet_length(row_to_json(checkpoint_row)::text)),
                0
              )::text
                AS maximum_row_bytes,
              count(*)::text AS row_count
         FROM (${sql}) AS checkpoint_row`,
      values,
    );
    const statistic = statistics[0];
    if (statistic === undefined || statistics.length !== 1) dependencyFailure();
    const maximumRowBytes = Number(statistic.maximum_row_bytes);
    const rowCount = Number(statistic.row_count);
    if (
      !Number.isSafeInteger(maximumRowBytes)
      || maximumRowBytes < 0
      || !Number.isSafeInteger(rowCount)
      || rowCount < 0
    ) dependencyFailure();
    if (maximumRowBytes > records.maximumBytes) resourceLimit();
    const pageSize = maximumRowBytes === 0
      ? MAXIMUM_CHECKPOINT_QUERY_PAGE_ROWS
      : Math.max(1, Math.min(
          MAXIMUM_CHECKPOINT_QUERY_PAGE_ROWS,
          Math.floor(records.maximumBytes / maximumRowBytes),
        ));
    for (let offset = 0; offset < rowCount; offset += pageSize) {
      const rows = await this.#query<Row>(
        `${sql}
        LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
        [...values, pageSize, offset],
      );
      if (
        rows.length === 0
        || rows.length > pageSize
        || rows.length > rowCount - offset
      ) dependencyFailure();
      for (const row of rows) yield row;
    }
  }
}
