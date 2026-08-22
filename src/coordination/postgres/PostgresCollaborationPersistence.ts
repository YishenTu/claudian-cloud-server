import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_LIMITS,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  type CollabChangeRequest,
  type CollabComment,
  type CollabMemberId,
  type CollabRequestTicketOperation,
  type CollabRequestTicketRelation,
  type CollabTicketAcceptedRelation,
  type CollabTicketComment,
  type CollabTicketStatus,
  type CollabTicketSummary,
  type CollabProjectId,
} from '@claudian/collab-protocol';
import type { QueryResultRow } from 'pg';

import type {
  ChangeCollaborationTicketStatusInput,
  CollaborationIdempotencyIdentity,
  CollaborationIdempotencyLookup,
  CollaborationIdempotencyPersistence,
  CollaborationIdempotencyStoreResult,
  CollaborationKeysetCursor,
  CollaborationPage,
  CollaborationProjectPersistence,
  CollaborationRequestPersistence,
  CollaborationSnapshotPersistence,
  CollaborationSnapshotReadResult,
  CollaborationTicketDetailBase,
  CollaborationTicketListCursor,
  CollaborationTicketPersistence,
  CreateCollaborationRequestCommentInput,
  CreateCollaborationRequestInput,
  CreateCollaborationTicketCommentInput,
  CreateCollaborationTicketInput,
  ReplaceCollaborationTicketMentionsInput,
  ReplacePendingCollaborationRelationsInput,
  UpdateCollaborationTicketInput,
  UpdateOpenCollaborationRequestInput,
} from '../CollaborationPersistence.js';
import { CoordinationError } from '../CoordinationError.js';

type ProjectQuery = <Row extends QueryResultRow>(
  text: string,
  values: readonly unknown[],
) => Promise<readonly Row[]>;

interface RequestRow {
  readonly comment_count: string;
  readonly created_at: Date;
  readonly description: string;
  readonly first_base_oid: string;
  readonly latest_head_oid: string;
  readonly member_id: string;
  readonly merged_oid: string | null;
  readonly request_id: string;
  readonly revision: string;
  readonly status: string;
  readonly updated_at: Date;
}

interface RelationRow {
  readonly accepted_at: Date | null;
  readonly accepted_merge_oid: string | null;
  readonly commit_oid: string;
  readonly kind: string;
  readonly relation_id: string;
  readonly request_id: string;
  readonly state: string;
  readonly ticket_id: string;
  readonly ticket_number: string;
  readonly ticket_revision: string;
  readonly ticket_title: string;
}

interface RequestCommentRow {
  readonly author_member_id: string;
  readonly body: string;
  readonly comment_id: string;
  readonly created_at: Date;
  readonly request_id: string;
}

interface TicketRow {
  readonly accepted_relation_count: string;
  readonly author_member_id: string;
  readonly closed_at: Date | null;
  readonly closed_by_member_id: string | null;
  readonly comment_count: string;
  readonly created_at: Date;
  readonly revision: string;
  readonly status: string;
  readonly ticket_id: string;
  readonly ticket_number: string;
  readonly title: string;
  readonly updated_at: Date;
}

interface TicketCommentRow {
  readonly author_member_id: string;
  readonly body: string;
  readonly comment_id: string;
  readonly created_at: Date;
  readonly ticket_id: string;
}

interface IdempotencyRow {
  readonly request_fingerprint: string;
  readonly response_json: unknown;
}

const REQUEST_OPERATIONS = new Set<CollabRequestTicketOperation>([
  'acceptRequest',
  'closeTicket',
  'createComment',
  'createTicket',
  'createTicketComment',
  'ensureMyRequest',
  'getRequest',
  'getTicket',
  'listRequestComments',
  'listTicketAcceptedRelations',
  'listTicketComments',
  'listTickets',
  'reopenTicket',
  'updateMyRequestMetadata',
  'updateTicketContent',
]);
const RELATION_KINDS = new Set(['references', 'resolves']);
const TICKET_STATUSES = new Set(['all', 'closed', 'open']);
const MENTION_SOURCE_KINDS = new Set(['comment', 'description']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function invalidRecord(): never {
  throw new CoordinationError('invalid-record');
}

function dependencyFailure(): never {
  throw new CoordinationError('dependency-failed');
}

function stateConflict(): never {
  throw new CoordinationError('state-conflict');
}

function isoTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalidRecord();
  }
  return value;
}

function dateIso(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) dependencyFailure();
  return value.toISOString();
}

function safeInteger(value: string, minimum = 0): number {
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded) || decoded < minimum) dependencyFailure();
  return decoded;
}

function positiveInput(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) invalidRecord();
  return value;
}

function opaqueId(value: string): string {
  if (!isCollabOpaqueId(value)) invalidRecord();
  return value;
}

function memberId(value: string): CollabMemberId {
  if (!isCollabMemberId(value)) invalidRecord();
  return value;
}

function gitOid(value: string): string {
  if (!isCollabGitOid(value)) invalidRecord();
  return value;
}

function boundedText(value: string, maximum: number, allowEmpty = false): string {
  if (
    (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, 'utf8') > maximum
  ) {
    invalidRecord();
  }
  return value;
}

function boundedUtf16Text(value: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum) invalidRecord();
  return value;
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    dependencyFailure();
  }
  return Object.freeze(value as Readonly<Record<string, unknown>>);
}

function requestComment(row: RequestCommentRow): CollabComment {
  if (
    !isCollabOpaqueId(row.comment_id)
    || !isCollabOpaqueId(row.request_id)
    || !isCollabMemberId(row.author_member_id)
    || row.body.length === 0
  ) {
    dependencyFailure();
  }
  return Object.freeze({
    authorMemberId: row.author_member_id,
    body: row.body,
    createdAt: dateIso(row.created_at),
    id: row.comment_id,
    requestId: row.request_id,
  });
}

function ticketComment(row: TicketCommentRow): CollabTicketComment {
  if (
    !isCollabOpaqueId(row.comment_id)
    || !isCollabOpaqueId(row.ticket_id)
    || !isCollabMemberId(row.author_member_id)
    || row.body.length === 0
  ) {
    dependencyFailure();
  }
  return Object.freeze({
    authorMemberId: row.author_member_id,
    body: row.body,
    createdAt: dateIso(row.created_at),
    id: row.comment_id,
    ticketId: row.ticket_id,
  });
}

function ticketSummary(row: TicketRow): CollabTicketSummary {
  const status = row.status;
  const closedAt = row.closed_at === null ? undefined : dateIso(row.closed_at);
  if (
    !isCollabOpaqueId(row.ticket_id)
    || !isCollabMemberId(row.author_member_id)
    || (status !== 'open' && status !== 'closed')
    || row.title.length === 0
    || (
      row.closed_by_member_id !== null
      && !isCollabMemberId(row.closed_by_member_id)
    )
    || (status === 'open' && (closedAt !== undefined || row.closed_by_member_id !== null))
    || (status === 'closed' && (closedAt === undefined || row.closed_by_member_id === null))
  ) {
    dependencyFailure();
  }
  return Object.freeze({
    acceptedRelationCount: safeInteger(row.accepted_relation_count),
    authorMemberId: row.author_member_id,
    commentCount: safeInteger(row.comment_count),
    createdAt: dateIso(row.created_at),
    id: row.ticket_id,
    number: safeInteger(row.ticket_number, 1),
    revision: safeInteger(row.revision, 1),
    status,
    title: row.title,
    updatedAt: dateIso(row.updated_at),
    ...(closedAt === undefined
      ? {}
      : { closedAt, closedByMemberId: row.closed_by_member_id as CollabMemberId }),
  });
}

function acceptedRelation(row: RelationRow): CollabTicketAcceptedRelation {
  const acceptedMergeOid = row.accepted_merge_oid;
  if (
    !isCollabOpaqueId(row.relation_id)
    || !isCollabOpaqueId(row.request_id)
    || !isCollabGitOid(row.commit_oid)
    || !isCollabGitOid(acceptedMergeOid ?? '')
    || (row.kind !== 'references' && row.kind !== 'resolves')
    || row.state !== 'accepted'
    || row.accepted_at === null
  ) {
    dependencyFailure();
  }
  return Object.freeze({
    acceptedAt: dateIso(row.accepted_at),
    acceptedMergeOid: acceptedMergeOid as string,
    commitOid: row.commit_oid,
    id: row.relation_id,
    kind: row.kind,
    requestId: row.request_id,
  });
}

function requestRelation(row: RelationRow): CollabRequestTicketRelation {
  if (
    !isCollabOpaqueId(row.relation_id)
    || !isCollabOpaqueId(row.ticket_id)
    || !isCollabGitOid(row.commit_oid)
    || (row.kind !== 'references' && row.kind !== 'resolves')
    || (row.state !== 'pending' && row.state !== 'accepted')
    || row.ticket_title.length === 0
  ) {
    dependencyFailure();
  }
  return Object.freeze({
    commitOid: row.commit_oid,
    id: row.relation_id,
    kind: row.kind,
    state: row.state,
    ticketId: row.ticket_id,
    ticketNumber: safeInteger(row.ticket_number, 1),
    ticketRevision: safeInteger(row.ticket_revision, 1),
    ticketTitle: row.ticket_title,
  });
}

const REQUEST_SELECT = `SELECT
  request.request_id,
  request.member_id,
  request.status,
  request.first_base_oid,
  request.latest_head_oid,
  request.merged_oid,
  request.description,
  request.revision,
  request.created_at,
  request.updated_at,
  (
    SELECT COUNT(*)
      FROM claudian_cloud.request_comments comment
     WHERE comment.project_id = request.project_id
       AND comment.request_id = request.request_id
  ) AS comment_count
FROM claudian_cloud.change_requests request`;

const RELATION_SELECT = `SELECT
  relation.relation_id,
  relation.request_id,
  relation.ticket_id,
  relation.commit_oid,
  relation.kind,
  relation.state,
  relation.accepted_at,
  relation.accepted_merge_oid,
  ticket.ticket_number,
  ticket.title AS ticket_title,
  ticket.revision AS ticket_revision
FROM claudian_cloud.request_ticket_relations relation
JOIN claudian_cloud.tickets ticket
  ON ticket.project_id = relation.project_id
 AND ticket.ticket_id = relation.ticket_id`;

const TICKET_SELECT = `SELECT
  ticket.ticket_number,
  ticket.ticket_id,
  ticket.title,
  ticket.status,
  ticket.author_member_id,
  ticket.revision,
  ticket.comment_count,
  ticket.created_at,
  ticket.updated_at,
  ticket.closed_at,
  ticket.closed_by_member_id,
  (
    SELECT COUNT(*)
      FROM claudian_cloud.request_ticket_relations relation
     WHERE relation.project_id = ticket.project_id
       AND relation.ticket_id = ticket.ticket_id
       AND relation.state = 'accepted'
  ) AS accepted_relation_count
FROM claudian_cloud.tickets ticket`;

class PostgresCollaborationRequests implements CollaborationRequestPersistence {
  readonly #projectId: CollabProjectId;
  readonly #query: ProjectQuery;

  constructor(projectId: CollabProjectId, query: ProjectQuery) {
    this.#projectId = projectId;
    this.#query = query;
  }

  async create(input: CreateCollaborationRequestInput): Promise<CollabChangeRequest> {
    opaqueId(input.requestId);
    memberId(input.memberId);
    gitOid(input.firstBaseOid);
    gitOid(input.latestHeadOid);
    boundedText(input.description, COLLAB_LIMITS.maxRequestDescriptionBytes, true);
    isoTimestamp(input.createdAt);
    const rows = await this.#query<{ readonly request_id: string }>(
      `INSERT INTO claudian_cloud.change_requests (
         project_id, request_id, member_id, status, first_base_oid,
         latest_head_oid, merged_oid, description, revision,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'open', $4, $5, NULL, $6, 1,
                 $7::timestamptz, $7::timestamptz)
       RETURNING request_id`,
      [
        this.#projectId,
        input.requestId,
        input.memberId,
        input.firstBaseOid,
        input.latestHeadOid,
        input.description,
        input.createdAt,
      ],
    );
    if (rows[0]?.request_id !== input.requestId) dependencyFailure();
    return (await this.find(input.requestId)) ?? dependencyFailure();
  }

  async createComment(
    input: CreateCollaborationRequestCommentInput,
  ): Promise<Readonly<{ readonly comment: CollabComment; readonly request: CollabChangeRequest }>> {
    opaqueId(input.commentId);
    opaqueId(input.requestId);
    memberId(input.authorMemberId);
    boundedText(input.body, COLLAB_LIMITS.maxCommentBytes);
    isoTimestamp(input.createdAt);
    const rows = await this.#query<RequestCommentRow>(
      `INSERT INTO claudian_cloud.request_comments (
         project_id, comment_id, request_id, author_member_id, body, created_at
       )
       SELECT $1::varchar(64), $2, request.request_id, $3, $4, $5::timestamptz
         FROM claudian_cloud.change_requests request
        WHERE request.project_id = $1::varchar(64)
          AND request.request_id = $6
          AND request.status = 'open'
          AND (
            SELECT COUNT(*)
              FROM claudian_cloud.request_comments comment
             WHERE comment.project_id = request.project_id
               AND comment.request_id = request.request_id
          ) < $7
       RETURNING comment_id, request_id, author_member_id, body, created_at`,
      [
        this.#projectId,
        input.commentId,
        input.authorMemberId,
        input.body,
        input.createdAt,
        input.requestId,
        COLLAB_LIMITS.maxRequestComments,
      ],
    );
    const row = rows[0];
    if (row === undefined) stateConflict();
    if (!await this.touchOpen(input.requestId, input.createdAt)) stateConflict();
    const request = await this.find(input.requestId);
    if (request === undefined) dependencyFailure();
    return Object.freeze({ comment: requestComment(row), request });
  }

  async find(requestId: string): Promise<CollabChangeRequest | undefined> {
    opaqueId(requestId);
    const rows = await this.#query<RequestRow>(
      `${REQUEST_SELECT}
       WHERE request.project_id = $1 AND request.request_id = $2`,
      [this.#projectId, requestId],
    );
    return rows[0] === undefined ? undefined : this.#decode(rows[0]);
  }

  async findOpenByMember(member: CollabMemberId): Promise<CollabChangeRequest | undefined> {
    memberId(member);
    const rows = await this.#query<RequestRow>(
      `${REQUEST_SELECT}
       WHERE request.project_id = $1
         AND request.member_id = $2
         AND request.status = 'open'`,
      [this.#projectId, member],
    );
    return rows[0] === undefined ? undefined : this.#decode(rows[0]);
  }

  async listComments(
    requestId: string,
    options: Readonly<{
      readonly after?: CollaborationKeysetCursor;
      readonly limit: number;
    }>,
  ): Promise<CollaborationPage<CollabComment>> {
    opaqueId(requestId);
    positiveInput(options.limit);
    const after = options.after;
    if (after !== undefined) {
      opaqueId(after.id);
      isoTimestamp(after.createdAt);
    }
    const rows = await this.#query<RequestCommentRow>(
      `SELECT comment_id, request_id, author_member_id, body, created_at
         FROM claudian_cloud.request_comments
        WHERE project_id = $1
          AND request_id = $2
          AND (
            $3::timestamptz IS NULL
            OR created_at > $3::timestamptz
            OR (created_at = $3::timestamptz AND comment_id > $4)
          )
        ORDER BY created_at, comment_id
        LIMIT $5`,
      [
        this.#projectId,
        requestId,
        after?.createdAt ?? null,
        after?.id ?? '',
        options.limit + 1,
      ],
    );
    return page(rows.map(requestComment), options.limit, value => ({
      createdAt: value.createdAt,
      id: value.id,
    }));
  }

  async replacePendingRelations(
    input: ReplacePendingCollaborationRelationsInput,
  ): Promise<readonly CollabRequestTicketRelation[]> {
    opaqueId(input.requestId);
    memberId(input.actorMemberId);
    gitOid(input.commitOid);
    isoTimestamp(input.updatedAt);
    if (input.relations.length > COLLAB_LIMITS.maxRequestTicketRelations) invalidRecord();
    const desired = new Map<string, (typeof input.relations)[number]>();
    for (const relation of input.relations) {
      opaqueId(relation.relationId);
      opaqueId(relation.ticketId);
      if (
        !RELATION_KINDS.has(relation.kind)
        || desired.has(relation.ticketId)
      ) {
        invalidRecord();
      }
      desired.set(relation.ticketId, relation);
    }
    const existing = await this.#listRelations(input.requestId);
    if (existing.some(relation => relation.state === 'accepted')) stateConflict();
    for (const relation of existing) {
      const next = desired.get(relation.ticketId);
      if (next === undefined) {
        await this.#query(
          `DELETE FROM claudian_cloud.request_ticket_relations
            WHERE project_id = $1 AND relation_id = $2 AND state = 'pending'`,
          [this.#projectId, relation.id],
        );
        continue;
      }
      desired.delete(relation.ticketId);
      await this.#query(
        `UPDATE claudian_cloud.request_ticket_relations
            SET kind = $3,
                commit_oid = $4,
                updated_at = $5::timestamptz
          WHERE project_id = $1 AND relation_id = $2 AND state = 'pending'`,
        [
          this.#projectId,
          relation.id,
          next.kind,
          input.commitOid,
          input.updatedAt,
        ],
      );
    }
    for (const relation of desired.values()) {
      const rows = await this.#query<{ readonly relation_id: string }>(
        `INSERT INTO claudian_cloud.request_ticket_relations (
           project_id, relation_id, request_id, ticket_id, commit_oid,
           kind, state, created_by_member_id, created_at, updated_at,
           accepted_at, accepted_merge_oid
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'pending', $7,
           $8::timestamptz, $8::timestamptz, NULL, NULL
         )
         RETURNING relation_id`,
        [
          this.#projectId,
          relation.relationId,
          input.requestId,
          relation.ticketId,
          input.commitOid,
          relation.kind,
          input.actorMemberId,
          input.updatedAt,
        ],
      );
      if (rows[0]?.relation_id !== relation.relationId) dependencyFailure();
    }
    return this.#listRelations(input.requestId);
  }

  async touchOpen(requestId: string, updatedAt: string): Promise<boolean> {
    opaqueId(requestId);
    isoTimestamp(updatedAt);
    const rows = await this.#query<{ readonly request_id: string }>(
      `UPDATE claudian_cloud.change_requests
          SET updated_at = $3::timestamptz
        WHERE project_id = $1 AND request_id = $2 AND status = 'open'
       RETURNING request_id`,
      [this.#projectId, requestId, updatedAt],
    );
    return rows[0]?.request_id === requestId;
  }

  async updateOpen(
    input: UpdateOpenCollaborationRequestInput,
  ): Promise<CollabChangeRequest | undefined> {
    opaqueId(input.requestId);
    positiveInput(input.expectedRevision);
    gitOid(input.latestHeadOid);
    boundedText(input.description, COLLAB_LIMITS.maxRequestDescriptionBytes, true);
    isoTimestamp(input.updatedAt);
    const rows = await this.#query<{ readonly request_id: string }>(
      `UPDATE claudian_cloud.change_requests
          SET latest_head_oid = $4,
              description = $5,
              revision = revision + 1,
              updated_at = $6::timestamptz
        WHERE project_id = $1
          AND request_id = $2
          AND status = 'open'
          AND revision = $3
          AND revision < 9007199254740991
       RETURNING request_id`,
      [
        this.#projectId,
        input.requestId,
        input.expectedRevision,
        input.latestHeadOid,
        input.description,
        input.updatedAt,
      ],
    );
    return rows[0] === undefined ? undefined : this.find(input.requestId);
  }

  async listOpen(limit: number): Promise<readonly CollabChangeRequest[]> {
    positiveInput(limit);
    const rows = await this.#query<RequestRow>(
      `${REQUEST_SELECT}
       WHERE request.project_id = $1 AND request.status = 'open'
       ORDER BY request.request_id
       LIMIT $2`,
      [this.#projectId, limit],
    );
    const requests: CollabChangeRequest[] = [];
    for (const row of rows) requests.push(await this.#decode(row));
    return Object.freeze(requests.sort((left, right) => (
      left.id.localeCompare(right.id, 'en-US')
    )));
  }

  async #decode(row: RequestRow): Promise<CollabChangeRequest> {
    if (
      !isCollabOpaqueId(row.request_id)
      || !isCollabMemberId(row.member_id)
      || !isCollabGitOid(row.first_base_oid)
      || !isCollabGitOid(row.latest_head_oid)
      || (row.merged_oid !== null && !isCollabGitOid(row.merged_oid))
      || !['discarded', 'merged', 'open'].includes(row.status)
    ) {
      dependencyFailure();
    }
    const status = row.status as CollabChangeRequest['status'];
    const relations = await this.#listRelations(row.request_id);
    return Object.freeze({
      commentCount: safeInteger(row.comment_count),
      createdAt: dateIso(row.created_at),
      description: row.description,
      firstBaseOid: row.first_base_oid,
      id: row.request_id,
      latestHeadOid: row.latest_head_oid,
      memberId: row.member_id,
      ...(row.merged_oid === null ? {} : { mergedOid: row.merged_oid }),
      revision: safeInteger(row.revision, 1),
      status,
      ticketRelations: relations,
      updatedAt: dateIso(row.updated_at),
    });
  }

  async #listRelations(requestId: string): Promise<readonly CollabRequestTicketRelation[]> {
    const rows = await this.#query<RelationRow>(
      `${RELATION_SELECT}
       WHERE relation.project_id = $1 AND relation.request_id = $2
       ORDER BY ticket.ticket_number, relation.relation_id`,
      [this.#projectId, requestId],
    );
    return Object.freeze(rows.map(requestRelation));
  }
}

class PostgresCollaborationTickets implements CollaborationTicketPersistence {
  readonly #projectId: CollabProjectId;
  readonly #query: ProjectQuery;

  constructor(projectId: CollabProjectId, query: ProjectQuery) {
    this.#projectId = projectId;
    this.#query = query;
  }

  async changeStatus(
    input: ChangeCollaborationTicketStatusInput,
  ): Promise<CollabTicketSummary | undefined> {
    opaqueId(input.ticketId);
    memberId(input.actorMemberId);
    positiveInput(input.expectedRevision);
    isoTimestamp(input.updatedAt);
    const rows = await this.#query<{ readonly ticket_id: string }>(
      `UPDATE claudian_cloud.tickets
          SET status = $4,
              revision = revision + 1,
              updated_at = $5::timestamptz,
              closed_at = CASE WHEN $4 = 'closed' THEN $5::timestamptz ELSE NULL END,
              closed_by_member_id = CASE WHEN $4 = 'closed' THEN $6 ELSE NULL END
        WHERE project_id = $1
          AND ticket_id = $2
          AND revision = $3
          AND revision < 9007199254740991
          AND status <> $4
       RETURNING ticket_id`,
      [
        this.#projectId,
        input.ticketId,
        input.expectedRevision,
        input.status,
        input.updatedAt,
        input.actorMemberId,
      ],
    );
    return rows[0] === undefined ? undefined : this.find(input.ticketId);
  }

  async create(input: CreateCollaborationTicketInput): Promise<CollabTicketSummary> {
    opaqueId(input.ticketId);
    memberId(input.authorMemberId);
    boundedUtf16Text(input.title, COLLAB_LIMITS.maxTicketTitleUtf16);
    boundedText(input.body, COLLAB_LIMITS.maxTicketBodyBytes);
    isoTimestamp(input.createdAt);
    const rows = await this.#query<{ readonly ticket_id: string }>(
      `INSERT INTO claudian_cloud.tickets (
         project_id, ticket_id, ticket_number, title, body, status,
         author_member_id, revision, comment_count, created_at, updated_at,
         closed_at, closed_by_member_id
       ) VALUES (
         $1::varchar(64),
         $2,
         (SELECT COALESCE(MAX(ticket_number), 0) + 1
            FROM claudian_cloud.tickets
           WHERE project_id = $1::varchar(64)),
         $3,
         $4,
         'open',
         $5,
         1,
         0,
         $6::timestamptz,
         $6::timestamptz,
         NULL,
         NULL
       )
       RETURNING ticket_id`,
      [
        this.#projectId,
        input.ticketId,
        input.title,
        input.body,
        input.authorMemberId,
        input.createdAt,
      ],
    );
    if (rows[0]?.ticket_id !== input.ticketId) dependencyFailure();
    return (await this.find(input.ticketId)) ?? dependencyFailure();
  }

  async createComment(
    input: CreateCollaborationTicketCommentInput,
  ): Promise<Readonly<{ readonly comment: CollabTicketComment; readonly ticket: CollabTicketSummary }>> {
    opaqueId(input.commentId);
    opaqueId(input.ticketId);
    memberId(input.authorMemberId);
    boundedText(input.body, COLLAB_LIMITS.maxTicketCommentBytes);
    isoTimestamp(input.createdAt);
    const rows = await this.#query<TicketCommentRow>(
      `INSERT INTO claudian_cloud.ticket_comments (
         project_id, comment_id, ticket_id, author_member_id, body, created_at
       )
       SELECT $1::varchar(64), $2, ticket.ticket_id, $3, $4, $5::timestamptz
         FROM claudian_cloud.tickets ticket
        WHERE ticket.project_id = $1::varchar(64)
          AND ticket.ticket_id = $6
          AND ticket.comment_count < $7
       RETURNING comment_id, ticket_id, author_member_id, body, created_at`,
      [
        this.#projectId,
        input.commentId,
        input.authorMemberId,
        input.body,
        input.createdAt,
        input.ticketId,
        COLLAB_LIMITS.maxTicketComments,
      ],
    );
    const commentRow = rows[0];
    if (commentRow === undefined) stateConflict();
    const updated = await this.#query<{ readonly ticket_id: string }>(
      `UPDATE claudian_cloud.tickets
          SET comment_count = comment_count + 1,
              revision = revision + 1,
              updated_at = $3::timestamptz
        WHERE project_id = $1
          AND ticket_id = $2
          AND comment_count < $4
          AND revision < 9007199254740991
       RETURNING ticket_id`,
      [this.#projectId, input.ticketId, input.createdAt, COLLAB_LIMITS.maxTicketComments],
    );
    if (updated[0]?.ticket_id !== input.ticketId) stateConflict();
    const ticket = await this.find(input.ticketId);
    if (ticket === undefined) dependencyFailure();
    return Object.freeze({ comment: ticketComment(commentRow), ticket });
  }

  async find(ticketId: string): Promise<CollabTicketSummary | undefined> {
    opaqueId(ticketId);
    const rows = await this.#query<TicketRow>(
      `${TICKET_SELECT}
       WHERE ticket.project_id = $1 AND ticket.ticket_id = $2`,
      [this.#projectId, ticketId],
    );
    return rows[0] === undefined ? undefined : ticketSummary(rows[0]);
  }

  async findDetailBase(
    ticketId: string,
  ): Promise<CollaborationTicketDetailBase | undefined> {
    const ticket = await this.find(ticketId);
    if (ticket === undefined) return undefined;
    const rows = await this.#query<{ readonly body: string }>(
      `SELECT body
         FROM claudian_cloud.tickets
        WHERE project_id = $1 AND ticket_id = $2`,
      [this.#projectId, ticketId],
    );
    const body = rows[0]?.body;
    if (body === undefined) dependencyFailure();
    boundedText(body, COLLAB_LIMITS.maxTicketBodyBytes);
    return Object.freeze({ body, ticket });
  }

  async findByNumber(ticketNumber: number): Promise<CollabTicketSummary | undefined> {
    positiveInput(ticketNumber);
    const rows = await this.#query<TicketRow>(
      `${TICKET_SELECT}
       WHERE ticket.project_id = $1 AND ticket.ticket_number = $2`,
      [this.#projectId, ticketNumber],
    );
    return rows[0] === undefined ? undefined : ticketSummary(rows[0]);
  }

  async findByNumbers(ticketNumbers: readonly number[]): Promise<readonly CollabTicketSummary[]> {
    if (ticketNumbers.length === 0) return Object.freeze([]);
    const unique = [...new Set(ticketNumbers.map(positiveInput))];
    const rows = await this.#query<TicketRow>(
      `${TICKET_SELECT}
       WHERE ticket.project_id = $1 AND ticket.ticket_number = ANY($2::bigint[])
       ORDER BY ticket.ticket_number`,
      [this.#projectId, unique],
    );
    return Object.freeze(rows.map(ticketSummary));
  }

  async hasPendingResolve(ticketId: string): Promise<boolean> {
    opaqueId(ticketId);
    const rows = await this.#query<{ readonly relation_id: string }>(
      `SELECT relation_id
         FROM claudian_cloud.request_ticket_relations
        WHERE project_id = $1
          AND ticket_id = $2
          AND state = 'pending'
          AND kind = 'resolves'
        LIMIT 1`,
      [this.#projectId, ticketId],
    );
    return rows[0] !== undefined;
  }

  async list(options: Readonly<{
    readonly after?: CollaborationTicketListCursor;
    readonly limit: number;
    readonly status: CollabTicketStatus | 'all';
  }>): Promise<readonly CollabTicketSummary[]> {
    positiveInput(options.limit);
    if (!TICKET_STATUSES.has(options.status)) invalidRecord();
    const after = options.after;
    if (after !== undefined) {
      positiveInput(after.ticketNumber);
      isoTimestamp(after.updatedAt);
    }
    const rows = await this.#query<TicketRow>(
      `${TICKET_SELECT}
       WHERE ticket.project_id = $1
         AND ($2::text = 'all' OR ticket.status = $2)
         AND (
           $3::timestamptz IS NULL
           OR ticket.updated_at < $3::timestamptz
           OR (
             ticket.updated_at = $3::timestamptz
             AND ticket.ticket_number < $4
           )
         )
       ORDER BY ticket.updated_at DESC, ticket.ticket_number DESC
       LIMIT $5`,
      [
        this.#projectId,
        options.status,
        after?.updatedAt ?? null,
        after?.ticketNumber ?? 0,
        options.limit,
      ],
    );
    return Object.freeze(rows.map(ticketSummary));
  }

  async listAcceptedRelations(
    ticketId: string,
    options: Readonly<{
      readonly after?: CollaborationKeysetCursor;
      readonly limit: number;
    }>,
  ): Promise<CollaborationPage<CollabTicketAcceptedRelation>> {
    opaqueId(ticketId);
    positiveInput(options.limit);
    const after = options.after;
    if (after !== undefined) {
      opaqueId(after.id);
      isoTimestamp(after.createdAt);
    }
    const rows = await this.#query<RelationRow>(
      `${RELATION_SELECT}
       WHERE relation.project_id = $1
         AND relation.ticket_id = $2
         AND relation.state = 'accepted'
         AND (
           $3::timestamptz IS NULL
           OR relation.accepted_at > $3::timestamptz
           OR (relation.accepted_at = $3::timestamptz AND relation.relation_id > $4)
         )
       ORDER BY relation.accepted_at, relation.relation_id
       LIMIT $5`,
      [
        this.#projectId,
        ticketId,
        after?.createdAt ?? null,
        after?.id ?? '',
        options.limit + 1,
      ],
    );
    return page(rows.map(acceptedRelation), options.limit, value => ({
      createdAt: value.acceptedAt,
      id: value.id,
    }));
  }

  async listComments(
    ticketId: string,
    options: Readonly<{
      readonly after?: CollaborationKeysetCursor;
      readonly limit: number;
    }>,
  ): Promise<CollaborationPage<CollabTicketComment>> {
    opaqueId(ticketId);
    positiveInput(options.limit);
    const after = options.after;
    if (after !== undefined) {
      opaqueId(after.id);
      isoTimestamp(after.createdAt);
    }
    const rows = await this.#query<TicketCommentRow>(
      `SELECT comment_id, ticket_id, author_member_id, body, created_at
         FROM claudian_cloud.ticket_comments
        WHERE project_id = $1
          AND ticket_id = $2
          AND (
            $3::timestamptz IS NULL
            OR created_at > $3::timestamptz
            OR (created_at = $3::timestamptz AND comment_id > $4)
          )
        ORDER BY created_at, comment_id
        LIMIT $5`,
      [
        this.#projectId,
        ticketId,
        after?.createdAt ?? null,
        after?.id ?? '',
        options.limit + 1,
      ],
    );
    return page(rows.map(ticketComment), options.limit, value => ({
      createdAt: value.createdAt,
      id: value.id,
    }));
  }

  async replaceMentions(input: ReplaceCollaborationTicketMentionsInput): Promise<void> {
    opaqueId(input.ticketId);
    opaqueId(input.sourceId);
    isoTimestamp(input.createdAt);
    if (
      !MENTION_SOURCE_KINDS.has(input.sourceKind)
      || (input.sourceKind === 'description' && input.sourceId !== input.ticketId)
    ) {
      invalidRecord();
    }
    const unique = new Set(input.mentionedMemberIds);
    if (unique.size !== input.mentionedMemberIds.length) invalidRecord();
    for (const mentionedMemberId of unique) memberId(mentionedMemberId);
    await this.#query(
      `DELETE FROM claudian_cloud.ticket_mentions
        WHERE project_id = $1
          AND ticket_id = $2
          AND source_kind = $3
          AND source_id = $4`,
      [this.#projectId, input.ticketId, input.sourceKind, input.sourceId],
    );
    for (const mentionedMemberId of unique) {
      await this.#query(
        `INSERT INTO claudian_cloud.ticket_mentions (
           project_id, ticket_id, mentioned_member_id,
           source_kind, source_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [
          this.#projectId,
          input.ticketId,
          mentionedMemberId,
          input.sourceKind,
          input.sourceId,
          input.createdAt,
        ],
      );
    }
  }

  async updateContent(
    input: UpdateCollaborationTicketInput,
  ): Promise<CollabTicketSummary | undefined> {
    opaqueId(input.ticketId);
    positiveInput(input.expectedRevision);
    boundedUtf16Text(input.title, COLLAB_LIMITS.maxTicketTitleUtf16);
    boundedText(input.body, COLLAB_LIMITS.maxTicketBodyBytes);
    isoTimestamp(input.updatedAt);
    const rows = await this.#query<{ readonly ticket_id: string }>(
      `UPDATE claudian_cloud.tickets
          SET title = $4,
              body = $5,
              revision = revision + 1,
              updated_at = $6::timestamptz
        WHERE project_id = $1
          AND ticket_id = $2
          AND revision = $3
          AND revision < 9007199254740991
       RETURNING ticket_id`,
      [
        this.#projectId,
        input.ticketId,
        input.expectedRevision,
        input.title,
        input.body,
        input.updatedAt,
      ],
    );
    return rows[0] === undefined ? undefined : this.find(input.ticketId);
  }

  async countOpen(): Promise<number> {
    const rows = await this.#query<{ readonly count: string }>(
      `SELECT COUNT(*) AS count
         FROM claudian_cloud.tickets
        WHERE project_id = $1 AND status = 'open'`,
      [this.#projectId],
    );
    return rows[0] === undefined ? dependencyFailure() : safeInteger(rows[0].count);
  }

  async listHighlights(limit: number): Promise<readonly CollabTicketSummary[]> {
    positiveInput(limit);
    const rows = await this.#query<TicketRow>(
      `${TICKET_SELECT}
       WHERE ticket.project_id = $1 AND ticket.status = 'open'
       ORDER BY ticket.updated_at DESC, ticket.ticket_id
       LIMIT $2`,
      [this.#projectId, limit],
    );
    return Object.freeze(rows.map(ticketSummary).sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt, 'en-US')
      || left.id.localeCompare(right.id, 'en-US')
    )));
  }
}

class PostgresCollaborationIdempotency
implements CollaborationIdempotencyPersistence {
  readonly #projectId: CollabProjectId;
  readonly #query: ProjectQuery;

  constructor(projectId: CollabProjectId, query: ProjectQuery) {
    this.#projectId = projectId;
    this.#query = query;
  }

  async find(input: CollaborationIdempotencyIdentity): Promise<CollaborationIdempotencyLookup> {
    this.#validate(input);
    const rows = await this.#query<IdempotencyRow>(
      `SELECT request_fingerprint, response_json
         FROM claudian_cloud.idempotency_results
        WHERE project_id = $1
          AND member_id = $2
          AND operation = $3
          AND idempotency_key = $4`,
      [this.#projectId, input.memberId, input.operation, input.idempotencyKey],
    );
    const row = rows[0];
    if (row === undefined) return Object.freeze({ kind: 'missing' as const });
    if (row.request_fingerprint !== input.requestFingerprint) {
      return Object.freeze({ kind: 'conflict' as const });
    }
    return Object.freeze({
      kind: 'replay' as const,
      response: responseRecord(row.response_json),
    });
  }

  async store(
    input: CollaborationIdempotencyIdentity & Readonly<{
      readonly createdAt: string;
      readonly response: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<CollaborationIdempotencyStoreResult> {
    this.#validate(input);
    isoTimestamp(input.createdAt);
    let serialized: string;
    try {
      serialized = JSON.stringify(input.response);
    } catch {
      invalidRecord();
    }
    if (Buffer.byteLength(serialized, 'utf8') > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) {
      invalidRecord();
    }
    const rows = await this.#query<{ readonly response_json: unknown }>(
      `INSERT INTO claudian_cloud.idempotency_results (
         project_id, member_id, operation, idempotency_key,
         request_fingerprint, response_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT (project_id, member_id, operation, idempotency_key)
       DO NOTHING
       RETURNING response_json`,
      [
        this.#projectId,
        input.memberId,
        input.operation,
        input.idempotencyKey,
        input.requestFingerprint,
        serialized,
        input.createdAt,
      ],
    );
    if (rows[0] !== undefined) {
      return Object.freeze({
        kind: 'stored' as const,
        response: responseRecord(rows[0].response_json),
      });
    }
    const existing = await this.find(input);
    if (existing.kind === 'missing') dependencyFailure();
    return existing;
  }

  #validate(input: CollaborationIdempotencyIdentity): void {
    memberId(input.memberId);
    opaqueId(input.idempotencyKey);
    if (
      !REQUEST_OPERATIONS.has(input.operation)
      || !SHA256_PATTERN.test(input.requestFingerprint)
    ) {
      invalidRecord();
    }
  }
}

class PostgresCollaborationSnapshot implements CollaborationSnapshotPersistence {
  readonly #requests: PostgresCollaborationRequests;
  readonly #tickets: PostgresCollaborationTickets;

  constructor(
    requests: PostgresCollaborationRequests,
    tickets: PostgresCollaborationTickets,
  ) {
    this.#requests = requests;
    this.#tickets = tickets;
  }

  async read(): Promise<CollaborationSnapshotReadResult> {
    const openRequests = await this.#requests.listOpen(
      COLLAB_CLOUD_BINDING_LIMITS.maxCloudOpenRequests + 1,
    );
    if (openRequests.length > COLLAB_CLOUD_BINDING_LIMITS.maxCloudOpenRequests) {
      return Object.freeze({ kind: 'too-large' as const });
    }
    const openTicketCount = await this.#tickets.countOpen();
    const ticketHighlights = await this.#tickets.listHighlights(
      COLLAB_CLOUD_BINDING_LIMITS.maxCloudTicketHighlights,
    );
    const snapshot = Object.freeze({
      openRequests,
      openTicketCount,
      ticketHighlights,
    });
    if (
      Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
      > COLLAB_CLOUD_BINDING_LIMITS.maxCloudSnapshotUtf8Bytes
    ) {
      return Object.freeze({ kind: 'too-large' as const });
    }
    return Object.freeze({ kind: 'snapshot' as const, snapshot });
  }
}

function page<T>(
  values: readonly T[],
  limit: number,
  cursor: (value: T) => CollaborationKeysetCursor,
): CollaborationPage<T> {
  const hasMore = values.length > limit;
  const items = Object.freeze(values.slice(0, limit));
  return Object.freeze({
    items,
    nextCursor: hasMore && items.length > 0
      ? Object.freeze(cursor(items[items.length - 1] as T))
      : undefined,
  });
}

export class PostgresCollaborationPersistence
implements CollaborationProjectPersistence {
  readonly idempotency: CollaborationIdempotencyPersistence;
  readonly requests: PostgresCollaborationRequests;
  readonly snapshot: CollaborationSnapshotPersistence;
  readonly tickets: PostgresCollaborationTickets;

  constructor(projectId: CollabProjectId, query: ProjectQuery) {
    this.idempotency = new PostgresCollaborationIdempotency(projectId, query);
    this.requests = new PostgresCollaborationRequests(projectId, query);
    this.tickets = new PostgresCollaborationTickets(projectId, query);
    this.snapshot = new PostgresCollaborationSnapshot(this.requests, this.tickets);
  }
}
