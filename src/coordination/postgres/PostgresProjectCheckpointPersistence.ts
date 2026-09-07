import { createHash } from 'node:crypto';

import {
  COLLAB_CHECKPOINT_PORTABLE_RECORD_KINDS,
  COLLAB_PROJECT_BACKUP_RECORD_KINDS,
  COLLAB_PROTOCOL_VERSION,
  collabControlOperationCodec,
  collabMemberRef,
  collabProjectBackupIdempotencyRecordId,
  decodeCollabAuthorityRelinquishmentProof,
  decodeCollabAuthorityTransferStatus,
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
  type CollabProjectBackupInactiveRepositoryPublication,
  type CollabProjectBackupRecord,
} from '@claudian-collab/protocol';
import type { QueryResultRow } from 'pg';

import { CoordinationError } from '../CoordinationError.js';
import { frameBackupProtectedSecretEnvelope } from '../backupProtectedSecretEnvelope.js';
import type {
  ProjectCheckpointPersistence,
  ProjectCheckpointRecord,
  ReadProjectCheckpointRecordsInput,
  TerminalProjectContinuityRecord,
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

const INACTIVE_PUBLICATION_KEYS = [
  'artifactKey',
  'bundleByteCount',
  'bundleSha256',
  'objectFormat',
  'operationId',
  'placementGeneration',
  'projectId',
  'publicationMarkerSha256',
  'refs',
  'repositoryStorageKey',
  'status',
  'storageNodeId',
  'validationMarkerSha256',
] as const;

function canonicalInactivePublication(
  value: string,
): CollabProjectBackupInactiveRepositoryPublication {
  const parsed = parsedJson(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return dependencyFailure();
  }
  const source = parsed as Record<string, unknown>;
  if (
    Object.keys(source).sort().join('\0')
      !== [...INACTIVE_PUBLICATION_KEYS].sort().join('\0')
    || !Array.isArray(source.refs)
  ) return dependencyFailure();
  const refs = source.refs.map((value: unknown): Readonly<Record<string, unknown>> => {
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== 'name\0oid'
    ) return dependencyFailure();
    const ref = value as Record<string, unknown>;
    return Object.freeze({ name: ref.name, oid: ref.oid });
  });
  return Object.freeze({
    artifactKey: source.artifactKey,
    bundleByteCount: source.bundleByteCount,
    bundleSha256: source.bundleSha256,
    objectFormat: source.objectFormat,
    operationId: source.operationId,
    placementGeneration: source.placementGeneration,
    projectId: source.projectId,
    publicationMarkerSha256: source.publicationMarkerSha256,
    refs: Object.freeze(refs),
    repositoryStorageKey: source.repositoryStorageKey,
    status: source.status,
    storageNodeId: source.storageNodeId,
    validationMarkerSha256: source.validationMarkerSha256,
  }) as unknown as CollabProjectBackupInactiveRepositoryPublication;
}

function completedLanToCloudResultSha256(input: Readonly<{
  readonly batch_revision: string | null;
  readonly batch_sha256: string | null;
  readonly checkpoint_sha256: string | null;
  readonly operation_id: string;
  readonly project_id: string;
  readonly relinquishment_proof_json: string | null;
  readonly source_authority_generation: string | null;
  readonly source_authority_kind: 'cloud' | 'lan' | null;
  readonly target_authority_generation: string | null;
  readonly target_authority_kind: 'cloud' | 'lan' | null;
  readonly target_url: string | null;
  readonly transfer_created_at: Date | null;
  readonly transfer_expires_at: Date | null;
  readonly updated_at: Date;
}>): string {
  if (
    input.batch_revision === null
    || input.batch_sha256 === null
    || input.checkpoint_sha256 === null
    || input.relinquishment_proof_json === null
    || input.source_authority_generation === null
    || input.source_authority_kind !== 'lan'
    || input.target_authority_generation === null
    || input.target_authority_kind !== 'cloud'
    || input.target_url === null
    || input.transfer_created_at === null
    || input.transfer_expires_at === null
  ) return dependencyFailure();
  try {
    const status = decodeCollabAuthorityTransferStatus({
      batchRevision: safeInteger(input.batch_revision),
      batchSha256: input.batch_sha256,
      checkpointSha256: input.checkpoint_sha256,
      createdAt: iso(input.transfer_created_at),
      direction: 'lan-to-cloud',
      expiresAt: iso(input.transfer_expires_at),
      phase: 'completed',
      projectId: input.project_id,
      relinquishmentProof: decodeCollabAuthorityRelinquishmentProof(
        parsedJson(input.relinquishment_proof_json),
      ),
      sourceAuthority: Object.freeze({
        generation: safeInteger(input.source_authority_generation),
        kind: input.source_authority_kind,
      }),
      state: 'completed',
      targetAuthority: Object.freeze({
        generation: safeInteger(input.target_authority_generation),
        kind: input.target_authority_kind,
      }),
      targetUrl: input.target_url,
      transferId: input.operation_id,
      updatedAt: iso(input.updated_at),
    });
    return createHash('sha256').update(JSON.stringify(status)).digest('hex');
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
    profile: CollabCheckpointProfile,
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
          profile,
        );
      if (Buffer.byteLength(encoded, 'utf8') > this.#maximumBytes) {
        resourceLimit();
      }
      return profile === 'backup'
        ? decodeCollabProjectBackupCheckpointCoordinationNdjson(encoded)
        : decodeCollabProjectCheckpointCoordinationNdjson(
          encoded,
          profile,
        ) as readonly CollabCheckpointPortableRecord[];
    } catch (error: unknown) {
      if (error instanceof CoordinationError) throw error;
      return invalidRecord();
    }
  }

  terminal(): readonly TerminalProjectContinuityRecord[] {
    const allowed = new Set<string>([
      'lifecycle-journal',
      'protected-claim-envelope',
      'terminal-principal',
      'terminal-responder',
      'terminal-responder-replay',
      'tombstone',
      'transfer-receipt-key',
      'transfer-redemption-receipt',
    ]);
    const sorted = [...this.#records].sort((left, right) => (
      (KIND_ORDER.get(left.kind) ?? Number.MAX_SAFE_INTEGER)
        - (KIND_ORDER.get(right.kind) ?? Number.MAX_SAFE_INTEGER)
      || left.recordId.localeCompare(right.recordId, 'en-US')
    ));
    if (sorted.length === 0 || sorted.some(record => !allowed.has(record.kind))) {
      invalidRecord();
    }
    if (Buffer.byteLength(
      `${sorted.map(record => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    ) > this.#maximumBytes) resourceLimit();
    return Object.freeze(sorted as readonly TerminalProjectContinuityRecord[]);
  }
}

const MAXIMUM_CHECKPOINT_QUERY_PAGE_ROWS = 256;

export class PostgresProjectCheckpointPersistence
implements ProjectCheckpointPersistence {
  readonly #projectId: string;
  readonly #query: ProjectQuery;
  #nextCursor = 0;

  constructor(projectId: string, query: ProjectQuery) {
    if (!IDENTITY_PATTERN.test(projectId)) invalidRecord();
    this.#projectId = projectId;
    this.#query = query;
  }

  async readProjectCheckpointRecords(
    input: ReadProjectCheckpointRecordsInput,
  ): Promise<readonly ProjectCheckpointRecord[]> {
    if (
      (input.excludedOperationId !== undefined
        && !isCollabOpaqueId(input.excludedOperationId))
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

  async readTerminalProjectContinuityRecords(input: Readonly<{
    readonly maximumCoordinationBytes: number;
  }>): Promise<readonly TerminalProjectContinuityRecord[]> {
    const records = new BoundedCheckpointRecords(input.maximumCoordinationBytes);
    await this.#readLifecycle(records, undefined);
    await this.#readTransferReceiptKeys(records, undefined);
    await this.#readTransferRedemptionReceipts(records, undefined);
    await this.#readTerminalResponders(records);
    await this.#readProtectedEnvelopes(records);
    await this.#readTombstone(records);
    return records.terminal();
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

    await this.#readMembershipIdempotencyTombstones(records);
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
      readonly invitation_id: string | null;
      readonly invitation_revision: string | null;
      readonly invitation_state: string | null;
      readonly invitation_terminal_at: Date | null;
      readonly member_id: string;
      readonly operation: CollabControlOperation;
      readonly request_fingerprint: string;
      readonly response_json: unknown;
    }>(
      `SELECT result.created_at, result.idempotency_key, result.member_id,
              result.operation, result.request_fingerprint,
              result.response_json, invitation.invitation_id,
              invitation.revision AS invitation_revision,
              invitation.state AS invitation_state,
              invitation.terminal_at AS invitation_terminal_at
         FROM claudian_cloud.idempotency_results AS result
         LEFT JOIN claudian_cloud.project_invitations AS invitation
           ON result.operation = 'revokeProjectInvitation'
          AND invitation.project_id = result.project_id
          AND invitation.invitation_id = result.response_json ->> 'invitationId'
        WHERE result.project_id = $1
        ORDER BY result.member_id, result.operation, result.idempotency_key`,
      [this.#projectId],
      records,
    )) {
      let responseJson: string;
      try {
        const response = row.operation === 'revokeProjectInvitation'
          ? this.#revokedInvitationResponse(row)
          : row.response_json;
        responseJson = JSON.stringify(
          collabControlOperationCodec(row.operation).decodeResponse(
            response,
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
    await this.#readMembershipRecoveries(records, input.excludedOperationId);
    await this.#readAuthorityTransferRecovery(records, input.excludedOperationId);
    await this.#readTransferredClaims(records, input.excludedOperationId);
    await this.#readTransferReceiptKeys(records, input.excludedOperationId);
    await this.#readTransferBatchReceipts(records, input.excludedOperationId);
    await this.#readTransferRedemptionReceipts(records, input.excludedOperationId);
    await this.#readTerminalResponders(records);
    await this.#readLeaveReplays(records, input.excludedOperationId);
    await this.#readInvitations(records);
    await this.#readTransferredClaimOverrides(records);
    await this.#readManagerResponsibilityOffers(records);
    await this.#readSecretReplayTombstones(records);
    await this.#readProtectedEnvelopes(records);
    await this.#readTombstone(records);

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

  #revokedInvitationResponse(row: Readonly<{
    readonly invitation_id: string | null;
    readonly invitation_revision: string | null;
    readonly invitation_state: string | null;
    readonly invitation_terminal_at: Date | null;
    readonly response_json: unknown;
  }>): unknown {
    if (
      typeof row.response_json !== 'object'
      || row.response_json === null
      || Array.isArray(row.response_json)
      || Object.keys(row.response_json).length !== 1
      || !Object.hasOwn(row.response_json, 'invitationId')
      || typeof (row.response_json as Record<string, unknown>).invitationId !== 'string'
      || row.invitation_id
        !== (row.response_json as Record<string, unknown>).invitationId
      || row.invitation_state !== 'revoked'
      || row.invitation_terminal_at === null
      || row.invitation_revision === null
    ) return dependencyFailure();
    return Object.freeze({
      invitationId: row.invitation_id,
      projectId: this.#projectId,
      revision: safeInteger(row.invitation_revision),
      revokedAt: iso(row.invitation_terminal_at),
      state: 'revoked',
    });
  }

  async #readMembershipIdempotencyTombstones(
    records: BoundedCheckpointRecords,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly actor_member_id: string;
      readonly compacted_at: Date;
      readonly idempotency_key: string;
      readonly operation:
        | 'acknowledgeManagerResponsibility'
        | 'cancelManagerResponsibilityOffer'
        | 'createManagerResponsibilityOffer'
        | 'declineManagerResponsibility'
        | 'promoteManager';
      readonly request_fingerprint: string;
    }>(
      `SELECT actor_member_id, compacted_at, idempotency_key, operation,
              request_fingerprint
         FROM claudian_cloud.project_membership_idempotency_tombstones
        WHERE project_id = $1
        ORDER BY actor_member_id, operation, idempotency_key`,
      [this.#projectId],
      records,
    )) {
      records.push(Object.freeze({
        kind: 'membership-idempotency-tombstone',
        recordId: `${row.operation}:${row.actor_member_id}:${row.idempotency_key}`,
        revision: 1,
        value: Object.freeze({
          actorMemberId: row.actor_member_id,
          compactedAt: iso(row.compacted_at),
          idempotencyKey: row.idempotency_key,
          operation: row.operation,
          projectId: this.#projectId,
          requestFingerprint: row.request_fingerprint,
        }),
      }));
    }
  }

  async #readInvitations(records: BoundedCheckpointRecords): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly associated_data_sha256: string | null;
      readonly ciphertext: string | null;
      readonly created_at: Date;
      readonly envelope_created_at: Date | null;
      readonly envelope_expires_at: Date | null;
      readonly expires_at: Date;
      readonly idempotency_key: string;
      readonly invitation_id: string;
      readonly issued_by_member_id: string;
      readonly key_id: string | null;
      readonly key_version: string | null;
      readonly nonce: string | null;
      readonly request_fingerprint: string;
      readonly revision: string;
      readonly secret_replay_expires_at: Date;
      readonly secret_sha256: string;
      readonly state: 'active' | 'expired' | 'redeemed' | 'redeeming' | 'revoked';
      readonly tag: string | null;
      readonly terminal_at: Date | null;
    }>(
      `SELECT invitation.associated_data_sha256,
              invitation.ciphertext,
              invitation.envelope_created_at,
              invitation.envelope_expires_at,
              invitation.key_id,
              invitation.key_version,
              invitation.nonce,
              invitation.tag,
              invitation.created_at,
              invitation.expires_at,
              invitation.idempotency_key,
              invitation.invitation_id,
              invitation.issued_by_member_id,
              invitation.request_fingerprint,
              invitation.revision,
              invitation.secret_replay_expires_at,
              invitation.secret_sha256,
              invitation.state,
              invitation.terminal_at
         FROM (
           SELECT source.*,
                  envelope.associated_data_sha256,
                  envelope.ciphertext,
                  envelope.created_at AS envelope_created_at,
                  envelope.expires_at AS envelope_expires_at,
                  envelope.key_id,
                  envelope.key_version,
                  envelope.nonce,
                  envelope.tag
             FROM claudian_cloud.project_invitations AS source
             LEFT JOIN claudian_cloud.protected_invitation_envelopes AS envelope
               USING (project_id, invitation_id)
            WHERE source.project_id = $1
         ) AS invitation
        ORDER BY invitation.invitation_id`,
      [this.#projectId],
      records,
    )) {
      records.push(Object.freeze({
        kind: 'project-invitation',
        recordId: row.invitation_id,
        revision: safeInteger(row.revision),
        value: Object.freeze({
          createdAt: iso(row.created_at),
          expiresAt: iso(row.expires_at),
          idempotencyKey: row.idempotency_key,
          invitationId: row.invitation_id,
          issuedByMemberId: row.issued_by_member_id,
          projectId: this.#projectId,
          requestFingerprint: row.request_fingerprint,
          revision: safeInteger(row.revision),
          secretReplayExpiresAt: iso(row.secret_replay_expires_at),
          secretSha256: row.secret_sha256,
          state: row.state,
          terminalAt: row.terminal_at === null ? null : iso(row.terminal_at),
        }),
      }));
      const envelopeFields = [
        row.associated_data_sha256,
        row.ciphertext,
        row.envelope_created_at,
        row.envelope_expires_at,
        row.key_id,
        row.key_version,
        row.nonce,
        row.tag,
      ];
      if (envelopeFields.every(value => value === null)) continue;
      if (envelopeFields.some(value => value === null)) dependencyFailure();
      if (
        iso(row.envelope_created_at as Date) !== iso(row.created_at)
        || iso(row.envelope_expires_at as Date) !== iso(row.expires_at)
      ) dependencyFailure();
      records.push(Object.freeze({
        kind: 'protected-invitation-envelope',
        recordId: row.invitation_id,
        revision: 1,
        value: Object.freeze({
          associatedDataSha256: row.associated_data_sha256 as string,
          ciphertext: frameBackupProtectedSecretEnvelope({
            ciphertext: row.ciphertext as string,
            keyVersion: safeInteger(row.key_version as string),
            tag: row.tag as string,
          }),
          createdAt: iso(row.envelope_created_at as Date),
          expiresAt: iso(row.secret_replay_expires_at),
          invitationId: row.invitation_id,
          keyId: row.key_id as string,
          nonce: row.nonce as string,
          projectId: this.#projectId,
        }),
      }));
    }
  }

  async #readManagerResponsibilityOffers(
    records: BoundedCheckpointRecords,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly acknowledged_at: Date | null;
      readonly expires_at: Date;
      readonly idempotency_key: string;
      readonly manager_set_generation_at_offer: string;
      readonly offered_at: Date;
      readonly offer_id: string;
      readonly purpose: 'manager-leave' | 'manager-promotion';
      readonly request_fingerprint: string;
      readonly revision: string;
      readonly source_manager_member_id: string;
      readonly state: 'acknowledged' | 'cancelled' | 'consumed' | 'declined' | 'expired' | 'offered';
      readonly target_member_id: string;
      readonly target_membership_revision_at_offer: string;
      readonly terminal_at: Date | null;
    }>(
      `SELECT acknowledged_at, expires_at, idempotency_key,
              manager_set_generation_at_offer, offered_at, offer_id, purpose,
              request_fingerprint, revision, source_manager_member_id, state,
              target_member_id, target_membership_revision_at_offer,
              terminal_at
         FROM claudian_cloud.manager_responsibility_offers
        WHERE project_id = $1
        ORDER BY offer_id`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'manager-responsibility-offer',
      recordId: row.offer_id,
      revision: safeInteger(row.revision),
      value: Object.freeze({
        acknowledgedAt: row.acknowledged_at === null
          ? null
          : iso(row.acknowledged_at),
        expiresAt: iso(row.expires_at),
        idempotencyKey: row.idempotency_key,
        managerSetGenerationAtOffer: safeInteger(
          row.manager_set_generation_at_offer,
        ),
        offeredAt: iso(row.offered_at),
        offerId: row.offer_id,
        projectId: this.#projectId,
        purpose: row.purpose,
        requestFingerprint: row.request_fingerprint,
        revision: safeInteger(row.revision),
        sourceManagerMemberId: row.source_manager_member_id,
        state: row.state,
        targetMemberId: row.target_member_id,
        targetMembershipRevisionAtOffer: safeInteger(
          row.target_membership_revision_at_offer,
        ),
        terminalAt: row.terminal_at === null ? null : iso(row.terminal_at),
      }),
    }));
  }

  async #readTransferredClaimOverrides(
    records: BoundedCheckpointRecords,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly associated_data_sha256: string | null;
      readonly claim_generation: string;
      readonly claim_sha256: string;
      readonly ciphertext: string | null;
      readonly created_at: Date;
      readonly envelope_created_at: Date | null;
      readonly envelope_expires_at: Date | null;
      readonly expires_at: Date;
      readonly idempotency_key: string;
      readonly key_id: string | null;
      readonly key_version: string | null;
      readonly manager_member_id: string;
      readonly member_id: string;
      readonly nonce: string | null;
      readonly redemption_receipt_id: string | null;
      readonly request_fingerprint: string;
      readonly secret_replay_expires_at: Date;
      readonly state: 'active' | 'expired' | 'redeemed' | 'revoked' | 'superseded';
      readonly superseded_claim_sha256: string;
      readonly tag: string | null;
      readonly target_principal_id: string | null;
      readonly transfer_id: string;
      readonly updated_at: Date;
    }>(
      `SELECT override.associated_data_sha256,
              override.ciphertext,
              override.envelope_created_at,
              override.envelope_expires_at,
              override.key_id,
              override.key_version,
              override.nonce,
              override.tag,
              override.claim_generation,
              override.claim_sha256,
              override.created_at,
              override.expires_at,
              override.idempotency_key,
              override.manager_member_id,
              override.member_id,
              override.redemption_receipt_id,
              override.request_fingerprint,
              override.secret_replay_expires_at,
              override.state,
              override.superseded_claim_sha256,
              override.target_principal_id,
              override.transfer_id,
              override.updated_at
         FROM (
           SELECT source.*,
                  envelope.associated_data_sha256,
                  envelope.ciphertext,
                  envelope.created_at AS envelope_created_at,
                  envelope.expires_at AS envelope_expires_at,
                  envelope.key_id,
                  envelope.key_version,
                  envelope.nonce,
                  envelope.tag
             FROM claudian_cloud.transferred_membership_claim_overrides AS source
             LEFT JOIN claudian_cloud.protected_claim_override_envelopes AS envelope
               USING (project_id, transfer_id, member_id, claim_generation)
            WHERE source.project_id = $1
         ) AS override
        ORDER BY override.transfer_id, override.member_id,
                 override.claim_generation`,
      [this.#projectId],
      records,
    )) {
      const claimGeneration = safeInteger(row.claim_generation);
      const identity = `${row.transfer_id}:${row.member_id}:${String(claimGeneration)}`;
      records.push(Object.freeze({
        kind: 'transferred-membership-claim-override',
        recordId: identity,
        revision: 1,
        value: Object.freeze({
          claimGeneration,
          claimSha256: row.claim_sha256,
          createdAt: iso(row.created_at),
          expiresAt: iso(row.expires_at),
          idempotencyKey: row.idempotency_key,
          managerMemberId: row.manager_member_id,
          memberId: row.member_id,
          projectId: this.#projectId,
          redemptionReceiptId: row.redemption_receipt_id,
          requestFingerprint: row.request_fingerprint,
          secretReplayExpiresAt: iso(row.secret_replay_expires_at),
          state: row.state,
          supersededClaimSha256: row.superseded_claim_sha256,
          targetPrincipalId: row.target_principal_id,
          transferId: row.transfer_id,
          updatedAt: iso(row.updated_at),
        }),
      }));
      const envelopeFields = [
        row.associated_data_sha256,
        row.ciphertext,
        row.envelope_created_at,
        row.envelope_expires_at,
        row.key_id,
        row.key_version,
        row.nonce,
        row.tag,
      ];
      if (envelopeFields.every(value => value === null)) continue;
      if (envelopeFields.some(value => value === null)) dependencyFailure();
      records.push(Object.freeze({
        kind: 'protected-claim-override-envelope',
        recordId: identity,
        revision: 1,
        value: Object.freeze({
          associatedDataSha256: row.associated_data_sha256 as string,
          ciphertext: frameBackupProtectedSecretEnvelope({
            ciphertext: row.ciphertext as string,
            keyVersion: safeInteger(row.key_version as string),
            tag: row.tag as string,
          }),
          claimGeneration,
          createdAt: iso(row.envelope_created_at as Date),
          expiresAt: iso(row.envelope_expires_at as Date),
          keyId: row.key_id as string,
          memberId: row.member_id,
          nonce: row.nonce as string,
          projectId: this.#projectId,
          transferId: row.transfer_id,
        }),
      }));
    }
  }

  async #readSecretReplayTombstones(
    records: BoundedCheckpointRecords,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly actor_member_id: string;
      readonly expired_at: Date;
      readonly idempotency_key: string;
      readonly operation: 'createProjectInvitation' | 'reissueTransferredMembershipClaim';
      readonly request_fingerprint: string;
    }>(
      `SELECT actor_member_id, expired_at, idempotency_key, operation,
              request_fingerprint
         FROM claudian_cloud.secret_replay_tombstones
        WHERE project_id = $1
        ORDER BY actor_member_id, operation, idempotency_key`,
      [this.#projectId],
      records,
    )) records.push(Object.freeze({
      kind: 'secret-replay-tombstone',
      recordId: `${row.operation}:${row.actor_member_id}:${row.idempotency_key}`,
      revision: 1,
      value: Object.freeze({
        actorMemberId: row.actor_member_id,
        expiredAt: iso(row.expired_at),
        idempotencyKey: row.idempotency_key,
        operation: row.operation,
        projectId: this.#projectId,
        requestFingerprint: row.request_fingerprint,
      }),
    }));
  }

  async #readTombstone(records: BoundedCheckpointRecords): Promise<void> {
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
  }

  async #readLifecycle(
    records: BoundedCheckpointRecords,
    excludedOperationId: string | undefined,
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
      readonly kind:
        | 'authority-transfer'
        | 'backup'
        | 'create-project'
        | 'delete'
        | 'export'
        | 'join-project'
        | 'leave'
        | 'remove-member'
        | 'retire';
      readonly operation_id: string;
      readonly phase: string;
      readonly project_id: string;
      readonly recovery_from_phase: string | null;
      readonly relinquishment_proof_json: string | null;
      readonly request_fingerprint: string;
      readonly result_sha256: string | null;
      readonly scheduled_at: Date;
      readonly source_authority_generation: string | null;
      readonly source_authority_kind: 'cloud' | 'lan' | null;
      readonly state: 'active' | 'cancelled' | 'completed' | 'recovery-required';
      readonly target_authority_generation: string | null;
      readonly target_authority_kind: 'cloud' | 'lan' | null;
      readonly target_url: string | null;
      readonly transfer_created_at: Date | null;
      readonly transfer_expires_at: Date | null;
      readonly updated_at: Date;
    }>(
      `SELECT lifecycle.actor_member_id, lifecycle.batch_revision,
              lifecycle.batch_sha256, lifecycle.checkpoint_sha256,
              lifecycle.created_at, lifecycle.direction,
              lifecycle.expected_authority_generation,
              lifecycle.expected_personal_ref_oid, lifecycle.idempotency_key,
              lifecycle.kind, lifecycle.operation_id, lifecycle.phase,
              lifecycle.project_id, lifecycle.recovery_from_phase,
              transfer.relinquishment_proof_json,
              lifecycle.request_fingerprint, lifecycle.result_sha256,
              lifecycle.scheduled_at, transfer.source_authority_generation,
              transfer.source_authority_kind, lifecycle.state,
              transfer.target_authority_generation,
              transfer.target_authority_kind, transfer.target_url,
              transfer.created_at AS transfer_created_at,
              transfer.expires_at AS transfer_expires_at,
              lifecycle.updated_at
         FROM claudian_cloud.project_lifecycle_journals AS lifecycle
         LEFT JOIN claudian_cloud.authority_transfer_recovery AS transfer
           ON transfer.project_id = lifecycle.project_id
          AND transfer.transfer_id = lifecycle.operation_id
        WHERE lifecycle.project_id = $1
          AND ($2::text IS NULL OR lifecycle.operation_id <> $2)
        ORDER BY lifecycle.operation_id`,
      [this.#projectId, excludedOperationId ?? null],
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
        expectedPersonalRefOid: row.kind === 'remove-member'
          ? null
          : row.expected_personal_ref_oid,
        idempotencyKey: row.idempotency_key,
        operationId: row.operation_id,
        operationKind: row.kind,
        phase: row.phase,
        projectId: this.#projectId,
        recoveryFromPhase: row.recovery_from_phase,
        requestFingerprint: row.request_fingerprint,
        resultSha256: row.result_sha256 ?? (
          row.kind === 'authority-transfer'
            && row.direction === 'lan-to-cloud'
            && row.phase === 'completed'
            && row.state === 'completed'
            ? completedLanToCloudResultSha256(row)
            : null
        ),
        scheduledAt: iso(row.scheduled_at),
        state: row.state,
        updatedAt: iso(row.updated_at),
      }),
    }));
  }

  async #readMembershipRecoveries(
    records: BoundedCheckpointRecords,
    excludedOperationId: string | undefined,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly authority_generation: string;
      readonly idempotency_key: string;
      readonly initial_commit_oid: string;
      readonly member_id: string;
      readonly operation_id: string;
      readonly personal_ref: string;
      readonly plan_sha256: string;
      readonly prepared_at: Date;
      readonly principal_id: string;
      readonly publication_marker_sha256: string;
      readonly request_fingerprint: string;
      readonly response_json: string;
      readonly updated_at: Date;
    }>(
      `SELECT project.authority_generation,
              journal.idempotency_key,
              journal.initial_commit_oid,
              journal.member_id,
              journal.operation_id,
              journal.personal_ref,
              journal.plan_sha256,
              journal.prepared_at,
              journal.principal_id,
              journal.publication_marker_sha256,
              journal.request_fingerprint,
              journal.response_json,
              journal.updated_at
         FROM claudian_cloud.cloud_project_creation_journals AS journal
         JOIN claudian_cloud.projects AS project USING (project_id)
         JOIN claudian_cloud.project_principal_bindings AS binding
           ON binding.project_id = journal.project_id
          AND binding.principal_id = journal.principal_id
          AND binding.member_id = journal.member_id
          AND binding.state = 'active'
        WHERE journal.project_id = $1
          AND journal.phase = 'completed'
          AND ($2::text IS NULL OR journal.operation_id <> $2)
        ORDER BY journal.operation_id`,
      [this.#projectId, excludedOperationId ?? null],
      records,
    )) {
      const responseJson = this.#canonicalResponse(
        'createCloudProject',
        row.response_json,
      );
      const resultSha256 = createHash('sha256').update(responseJson).digest('hex');
      this.#pushCompletedMembershipLifecycle(records, {
        actorMemberId: null,
        createdAt: row.prepared_at,
        expectedAuthorityGeneration: safeInteger(row.authority_generation),
        idempotencyKey: row.idempotency_key,
        operationId: row.operation_id,
        operationKind: 'create-project',
        requestFingerprint: row.request_fingerprint,
        resultSha256,
        updatedAt: row.updated_at,
      });
      records.push(Object.freeze({
        kind: 'project-membership-recovery',
        recordId: row.operation_id,
        revision: 1,
        value: Object.freeze({
          expectedMainOid: row.initial_commit_oid,
          expectedPersonalRefOid: row.initial_commit_oid,
          invitationId: null,
          memberId: row.member_id,
          operationId: row.operation_id,
          operationKind: 'create-project',
          principalSha256: createHash('sha256')
            .update(row.principal_id)
            .digest('hex'),
          projectId: this.#projectId,
          publicationMarkerSha256: row.publication_marker_sha256,
          repositoryPlanSha256: row.plan_sha256,
          requestFingerprint: row.request_fingerprint,
        }),
      }));
      this.#pushIdempotencyRecord(records, {
        createdAt: row.prepared_at,
        idempotencyKey: row.idempotency_key,
        memberId: row.member_id,
        operation: 'createCloudProject',
        requestFingerprint: row.request_fingerprint,
        responseJson,
      });
    }

    for await (const row of this.#queryRows<{
      readonly authority_generation: string;
      readonly expected_main_oid: string;
      readonly idempotency_key: string;
      readonly invitation_id: string;
      readonly member_id: string;
      readonly operation_id: string;
      readonly prepared_at: Date;
      readonly principal_sha256: string;
      readonly request_fingerprint: string;
      readonly response_json: string;
      readonly updated_at: Date;
    }>(
      `SELECT project.authority_generation,
              journal.expected_main_oid,
              journal.idempotency_key,
              journal.invitation_id,
              journal.member_id,
              journal.operation_id,
              journal.prepared_at,
              journal.principal_sha256,
              journal.request_fingerprint,
              journal.response_json,
              journal.updated_at
         FROM claudian_cloud.cloud_project_join_journals AS journal
         JOIN claudian_cloud.projects AS project USING (project_id)
         JOIN claudian_cloud.project_principal_bindings AS binding
           ON binding.project_id = journal.project_id
          AND binding.principal_id = journal.principal_id
          AND binding.member_id = journal.member_id
          AND binding.state = 'active'
        WHERE journal.project_id = $1
          AND journal.phase = 'completed'
          AND ($2::text IS NULL OR journal.operation_id <> $2)
        ORDER BY journal.operation_id`,
      [this.#projectId, excludedOperationId ?? null],
      records,
    )) {
      const responseJson = this.#canonicalResponse(
        'joinCloudProject',
        row.response_json,
      );
      const decoded = collabControlOperationCodec('joinCloudProject')
        .decodeResponse(parsedJson(responseJson));
      const resultSha256 = createHash('sha256').update(responseJson).digest('hex');
      this.#pushCompletedMembershipLifecycle(records, {
        actorMemberId: null,
        createdAt: row.prepared_at,
        expectedAuthorityGeneration: safeInteger(row.authority_generation),
        idempotencyKey: row.idempotency_key,
        operationId: row.operation_id,
        operationKind: 'join-project',
        requestFingerprint: row.request_fingerprint,
        resultSha256,
        updatedAt: row.updated_at,
      });
      records.push(Object.freeze({
        kind: 'project-membership-recovery',
        recordId: row.operation_id,
        revision: 1,
        value: Object.freeze({
          expectedMainOid: row.expected_main_oid,
          expectedPersonalRefOid: row.expected_main_oid,
          invitationId: row.invitation_id,
          memberId: row.member_id,
          operationId: row.operation_id,
          operationKind: 'join-project',
          principalSha256: row.principal_sha256,
          projectId: this.#projectId,
          publicationMarkerSha256: null,
          repositoryPlanSha256: null,
          requestFingerprint: row.request_fingerprint,
        }),
      }));
      this.#pushIdempotencyRecord(records, {
        createdAt: row.prepared_at,
        idempotencyKey: row.idempotency_key,
        memberId: decoded.memberId,
        operation: 'joinCloudProject',
        requestFingerprint: row.request_fingerprint,
        responseJson,
      });
    }

    for await (const row of this.#queryRows<{
      readonly actor_member_id: string;
      readonly expected_main_oid: string;
      readonly expected_personal_ref_oid: string;
      readonly idempotency_key: string;
      readonly lifecycle_result_sha256: string;
      readonly operation_id: string;
      readonly prepared_at: Date;
      readonly request_fingerprint: string;
      readonly response_json: string;
      readonly target_member_id: string;
    }>(
      `SELECT removal.actor_member_id,
              project.expected_main_oid,
              removal.expected_personal_ref_oid,
              removal.idempotency_key,
              lifecycle.result_sha256 AS lifecycle_result_sha256,
              removal.operation_id,
              removal.prepared_at,
              removal.request_fingerprint,
              removal.response_json,
              removal.target_member_id
         FROM claudian_cloud.project_member_removal_journals AS removal
         JOIN claudian_cloud.project_lifecycle_journals AS lifecycle
           USING (project_id, operation_id)
         JOIN claudian_cloud.projects AS project USING (project_id)
        WHERE removal.project_id = $1
          AND removal.phase = 'completed'
          AND lifecycle.state = 'completed'
          AND ($2::text IS NULL OR removal.operation_id <> $2)
        ORDER BY removal.operation_id`,
      [this.#projectId, excludedOperationId ?? null],
      records,
    )) {
      const responseJson = this.#canonicalResponse('removeMember', row.response_json);
      const resultSha256 = createHash('sha256').update(responseJson).digest('hex');
      if (resultSha256 !== row.lifecycle_result_sha256) dependencyFailure();
      records.push(Object.freeze({
        kind: 'project-membership-recovery',
        recordId: row.operation_id,
        revision: 1,
        value: Object.freeze({
          expectedMainOid: row.expected_main_oid,
          expectedPersonalRefOid: row.expected_personal_ref_oid,
          invitationId: null,
          memberId: row.target_member_id,
          operationId: row.operation_id,
          operationKind: 'remove-member',
          principalSha256: null,
          projectId: this.#projectId,
          publicationMarkerSha256: null,
          repositoryPlanSha256: null,
          requestFingerprint: row.request_fingerprint,
        }),
      }));
      this.#pushIdempotencyRecord(records, {
        createdAt: row.prepared_at,
        idempotencyKey: row.idempotency_key,
        memberId: row.actor_member_id,
        operation: 'removeMember',
        requestFingerprint: row.request_fingerprint,
        responseJson,
      });
    }
  }

  #canonicalResponse(
    operation: CollabControlOperation,
    responseJson: string,
  ): string {
    try {
      return JSON.stringify(
        collabControlOperationCodec(operation).decodeResponse(
          parsedJson(responseJson),
        ),
      );
    } catch {
      return dependencyFailure();
    }
  }

  #pushCompletedMembershipLifecycle(
    records: BoundedCheckpointRecords,
    input: Readonly<{
      readonly actorMemberId: string | null;
      readonly createdAt: Date;
      readonly expectedAuthorityGeneration: number;
      readonly idempotencyKey: string;
      readonly operationId: string;
      readonly operationKind: 'create-project' | 'join-project';
      readonly requestFingerprint: string;
      readonly resultSha256: string;
      readonly updatedAt: Date;
    }>,
  ): void {
    records.push(Object.freeze({
      kind: 'lifecycle-journal',
      recordId: input.operationId,
      revision: 1,
      value: Object.freeze({
        actorMemberId: input.actorMemberId,
        batchRevision: null,
        batchSha256: null,
        checkpointSha256: null,
        createdAt: iso(input.createdAt),
        direction: null,
        expectedAuthorityGeneration: input.expectedAuthorityGeneration,
        expectedPersonalRefOid: null,
        idempotencyKey: input.idempotencyKey,
        operationId: input.operationId,
        operationKind: input.operationKind,
        phase: 'completed',
        projectId: this.#projectId,
        recoveryFromPhase: null,
        requestFingerprint: input.requestFingerprint,
        resultSha256: input.resultSha256,
        scheduledAt: iso(input.createdAt),
        state: 'completed',
        updatedAt: iso(input.updatedAt),
      }),
    }));
  }

  #pushIdempotencyRecord(
    records: BoundedCheckpointRecords,
    input: Readonly<{
      readonly createdAt: Date;
      readonly idempotencyKey: string;
      readonly memberId: string;
      readonly operation: CollabControlOperation;
      readonly requestFingerprint: string;
      readonly responseJson: string;
    }>,
  ): void {
    const value = Object.freeze({
      createdAt: iso(input.createdAt),
      idempotencyKey: input.idempotencyKey,
      memberId: input.memberId,
      operation: input.operation,
      projectId: this.#projectId,
      requestFingerprint: input.requestFingerprint,
      responseJson: input.responseJson,
    });
    records.push(Object.freeze({
      kind: 'idempotency-result',
      recordId: collabProjectBackupIdempotencyRecordId(value),
      revision: 1,
      value,
    }));
  }

  async #readAuthorityTransferRecovery(
    records: BoundedCheckpointRecords,
    excludedOperationId: string | undefined,
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
        WHERE project_id = $1
          AND ($2::text IS NULL OR transfer_id <> $2)
        ORDER BY transfer_id`,
      [this.#projectId, excludedOperationId ?? null],
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
            : canonicalInactivePublication(row.inactive_publication_json),
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
    excludedOperationId: string | undefined,
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
        WHERE project_id = $1
          AND ($2::text IS NULL OR transfer_id <> $2)
          AND batch_revision = (
            SELECT lifecycle.batch_revision
              FROM claudian_cloud.project_lifecycle_journals AS lifecycle
             WHERE lifecycle.project_id = transferred_membership_claims.project_id
               AND lifecycle.operation_id = transferred_membership_claims.transfer_id
          )
        ORDER BY transfer_id, member_id`,
      [this.#projectId, excludedOperationId ?? null],
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
    excludedOperationId: string | undefined,
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
        WHERE project_id = $1
          AND ($2::text IS NULL OR transfer_id <> $2)
        ORDER BY transfer_id, receipt_key_id`,
      [this.#projectId, excludedOperationId ?? null],
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
    excludedOperationId: string | undefined,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly receipt_json: string;
      readonly transfer_id: string;
    }>(
      `SELECT receipt_json, transfer_id
         FROM claudian_cloud.transfer_claim_batch_receipts
        WHERE project_id = $1
          AND ($2::text IS NULL OR transfer_id <> $2)
        ORDER BY transfer_id`,
      [this.#projectId, excludedOperationId ?? null],
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
    excludedOperationId: string | undefined,
  ): Promise<void> {
    for await (const row of this.#queryRows<{
      readonly acknowledged_at: Date | null;
      readonly member_id: string;
      readonly receipt_json: string;
      readonly transfer_id: string;
    }>(
      `SELECT acknowledged_at, member_id, receipt_json, transfer_id
         FROM claudian_cloud.transfer_redemption_receipts
        WHERE project_id = $1
          AND ($2::text IS NULL OR transfer_id <> $2)
        ORDER BY transfer_id, member_id`,
      [this.#projectId, excludedOperationId ?? null],
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
    excludedOperationId: string | undefined,
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
      readonly response_json: string;
      readonly result_sha256: string | null;
      readonly state: 'completed' | 'recovering';
    }>(
      `SELECT completed_at, created_at, expected_personal_ref_oid,
              expires_at, intent_id, member_id, operation_id,
              principal_sha256, request_fingerprint, response_json,
              result_sha256, state
         FROM claudian_cloud.leave_former_principal_replays
        WHERE project_id = $1
          AND ($2::text IS NULL OR operation_id <> $2)
        ORDER BY operation_id`,
      [this.#projectId, excludedOperationId ?? null],
      records,
    )) {
      if (row.state !== 'completed') dependencyFailure();
      const responseJson = this.#canonicalResponse('leaveProject', row.response_json);
      if (
        row.result_sha256 !== createHash('sha256').update(responseJson).digest('hex')
      ) dependencyFailure();
      records.push(Object.freeze({
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
      this.#pushIdempotencyRecord(records, {
        createdAt: row.created_at,
        idempotencyKey: row.intent_id,
        memberId: row.member_id,
        operation: 'leaveProject',
        requestFingerprint: row.request_fingerprint,
        responseJson,
      });
    }
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
    if (rowCount === 0) return;
    const pageSize = maximumRowBytes === 0
      ? MAXIMUM_CHECKPOINT_QUERY_PAGE_ROWS
      : Math.max(1, Math.min(
          MAXIMUM_CHECKPOINT_QUERY_PAGE_ROWS,
          Math.floor(records.maximumBytes / maximumRowBytes),
        ));
    const cursor = `checkpoint_rows_${String(this.#nextCursor++)}`;
    await this.#query(
      `DECLARE ${cursor} NO SCROLL CURSOR WITHOUT HOLD FOR ${sql}`,
      values,
    );
    try {
      let consumed = 0;
      while (consumed < rowCount) {
        const rows = await this.#query<Row>(
          `FETCH FORWARD ${String(pageSize)} FROM ${cursor}`,
          [],
        );
        if (
          rows.length === 0
          || rows.length > pageSize
          || rows.length > rowCount - consumed
        ) dependencyFailure();
        consumed += rows.length;
        for (const row of rows) yield row;
      }
    } finally {
      await this.#query(`CLOSE ${cursor}`, []);
    }
  }
}
