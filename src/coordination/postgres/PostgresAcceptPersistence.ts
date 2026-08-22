import { isDeepStrictEqual } from 'node:util';

import {
  COLLAB_MAIN_REF,
  collabControlOperationCodec,
  collabMemberRef,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type AcceptResponse,
  type CollabOperationId,
  type CollabProjectId,
} from '@claudian/collab-protocol';
import type { QueryResultRow } from 'pg';

import type {
  AcceptAdvanceResult,
  AcceptJournalActivePhase,
  AcceptJournalPhase,
  AcceptJournalRecord,
  AcceptPersistence,
  AcceptPrepareResult,
  AcceptRelationPlan,
  CompleteAcceptInput,
  MarkAcceptMainUpdatedInput,
  MarkAcceptRecoveryRequiredInput,
  PersistAcceptResultInput,
  PrepareAcceptInput,
} from '../AcceptPersistence.js';
import type { CollaborationProjectPersistence } from '../CollaborationPersistence.js';
import { CoordinationError } from '../CoordinationError.js';
import type { AppendProjectEvent } from '../ProjectEventPersistence.js';
import { createRepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

type ProjectQuery = <Row extends QueryResultRow>(
  text: string,
  values: readonly unknown[],
) => Promise<readonly Row[]>;

interface AcceptJournalRow {
  readonly actor_member_id: string;
  readonly author_email: string | null;
  readonly author_name: string | null;
  readonly commit_message: Buffer | null;
  readonly commit_timezone: string | null;
  readonly committer_email: string | null;
  readonly committer_name: string | null;
  readonly expected_head_oid: string;
  readonly expected_main_oid: string;
  readonly expected_request_revision: string;
  readonly first_parent_oid: string | null;
  readonly idempotency_key: string;
  readonly main_ref: string;
  readonly object_format: string;
  readonly operation_id: string;
  readonly personal_ref: string;
  readonly phase: string;
  readonly placement_generation: string;
  readonly prepared_at: Date;
  readonly project_id: string;
  readonly recovery_from_phase: string | null;
  readonly repository_storage_key: string;
  readonly request_fingerprint: string;
  readonly request_id: string;
  readonly request_member_id: string;
  readonly result_kind: string;
  readonly result_oid: string | null;
  readonly second_parent_oid: string | null;
  readonly storage_node_id: string;
  readonly tree_oid: string | null;
  readonly updated_at: Date;
}

interface AcceptRelationRow {
  readonly commit_oid: string;
  readonly kind: string;
  readonly relation_id: string;
  readonly ticket_id: string;
  readonly ticket_revision: string;
}

interface ProjectFenceRow {
  readonly expected_main_oid: string;
  readonly generation: string;
  readonly repository_storage_key: string;
  readonly service_state: string;
  readonly storage_node_id: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ACTIVE_PHASES = new Set<AcceptJournalActivePhase>([
  'prepared',
  'result-persisted',
  'main-updated',
]);
const PHASES = new Set<AcceptJournalPhase>([
  ...ACTIVE_PHASES,
  'completed',
  'recovery-required',
]);
const AUTHOR_NAME = 'Claudian Collab';
const AUTHOR_EMAIL = 'collab@claudian.local';

function invalidRecord(): never {
  throw new CoordinationError('invalid-record');
}

function dependencyFailure(): never {
  throw new CoordinationError('dependency-failed');
}

function stateConflict(): never {
  throw new CoordinationError('state-conflict');
}

function inputTimestamp(value: string, wholeSecond = false): string {
  if (
    Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
    || (wholeSecond && new Date(value).getUTCMilliseconds() !== 0)
  ) {
    invalidRecord();
  }
  return value;
}

function dateIso(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    dependencyFailure();
  }
  return value.toISOString();
}

function safePositiveInteger(value: string): number {
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded) || decoded < 1) dependencyFailure();
  return decoded;
}

function assertOidForFormat(value: string, format: 'sha1' | 'sha256'): void {
  if (
    !isCollabGitOid(value)
    || value.length !== (format === 'sha1' ? 40 : 64)
  ) {
    invalidRecord();
  }
}

function relationOrder(
  left: AcceptRelationPlan,
  right: AcceptRelationPlan,
): number {
  return left.relationId < right.relationId
    ? -1
    : left.relationId > right.relationId ? 1 : 0;
}

function canonicalPrepare(input: PrepareAcceptInput): PrepareAcceptInput {
  if (
    !isCollabMemberId(input.actorMemberId)
    || !isCollabMemberId(input.requestMemberId)
    || !isCollabOpaqueId(input.requestId)
    || !isCollabOpaqueId(input.operationId)
    || !isCollabOpaqueId(input.idempotencyKey)
    || !SHA256_PATTERN.test(input.requestFingerprint)
    || !Number.isSafeInteger(input.expectedRequestRevision)
    || input.expectedRequestRevision < 1
    || input.personalRef !== collabMemberRef(input.requestMemberId)
  ) {
    invalidRecord();
  }
  assertOidForFormat(input.expectedMainOid, input.objectFormat);
  assertOidForFormat(input.expectedHeadOid, input.objectFormat);
  inputTimestamp(input.preparedAt, true);
  try {
    createRepositoryPlacementLease({
      active: true,
      ...input.placement,
    });
  } catch {
    invalidRecord();
  }

  const relationIds = new Set<string>();
  const ticketIds = new Set<string>();
  const relations = Object.freeze(input.relations.map(relation => {
    if (
      !isCollabOpaqueId(relation.relationId)
      || !isCollabOpaqueId(relation.ticketId)
      || !Number.isSafeInteger(relation.ticketRevision)
      || relation.ticketRevision < 1
      || relationIds.has(relation.relationId)
      || ticketIds.has(relation.ticketId)
    ) {
      invalidRecord();
    }
    assertOidForFormat(relation.commitOid, input.objectFormat);
    relationIds.add(relation.relationId);
    ticketIds.add(relation.ticketId);
    return Object.freeze({ ...relation });
  }).sort(relationOrder));

  const common = {
    actorMemberId: input.actorMemberId,
    expectedHeadOid: input.expectedHeadOid,
    expectedMainOid: input.expectedMainOid,
    expectedRequestRevision: input.expectedRequestRevision,
    idempotencyKey: input.idempotencyKey,
    mainRef: COLLAB_MAIN_REF,
    objectFormat: input.objectFormat,
    operationId: input.operationId,
    personalRef: input.personalRef,
    placement: Object.freeze({ ...input.placement }),
    preparedAt: input.preparedAt,
    relations,
    requestFingerprint: input.requestFingerprint,
    requestId: input.requestId,
    requestMemberId: input.requestMemberId,
  } as const;

  if (input.resultKind === 'contained') {
    return Object.freeze({ ...common, resultKind: 'contained' as const });
  }
  const commit = input.commit;
  if (
    commit.authorName !== AUTHOR_NAME
    || commit.authorEmail !== AUTHOR_EMAIL
    || commit.committerName !== AUTHOR_NAME
    || commit.committerEmail !== AUTHOR_EMAIL
    || commit.message !== `Accept request ${input.requestId}\n`
    || commit.parents[0] !== input.expectedMainOid
    || commit.parents[1] !== input.expectedHeadOid
  ) {
    invalidRecord();
  }
  assertOidForFormat(commit.treeOid, input.objectFormat);
  return Object.freeze({
    ...common,
    commit: Object.freeze({
      ...commit,
      parents: Object.freeze([
        commit.parents[0],
        commit.parents[1],
      ] as const),
    }),
    resultKind: 'merge' as const,
  });
}

function decodeRelation(
  row: AcceptRelationRow,
  objectFormat: 'sha1' | 'sha256',
): AcceptRelationPlan {
  const ticketRevision = safePositiveInteger(row.ticket_revision);
  if (
    !isCollabOpaqueId(row.relation_id)
    || !isCollabOpaqueId(row.ticket_id)
    || (row.kind !== 'references' && row.kind !== 'resolves')
  ) {
    dependencyFailure();
  }
  try {
    assertOidForFormat(row.commit_oid, objectFormat);
  } catch {
    dependencyFailure();
  }
  return Object.freeze({
    commitOid: row.commit_oid,
    kind: row.kind,
    relationId: row.relation_id,
    ticketId: row.ticket_id,
    ticketRevision,
  });
}

function decodeJournal(
  row: AcceptJournalRow,
  relationRows: readonly AcceptRelationRow[],
): AcceptJournalRecord {
  const objectFormat = row.object_format;
  const phase = row.phase;
  const recoveryFromPhase = row.recovery_from_phase;
  if (
    !isCollabProjectId(row.project_id)
    || !isCollabOpaqueId(row.operation_id)
    || !PHASES.has(phase as AcceptJournalPhase)
    || (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    || (
      recoveryFromPhase !== null
      && !ACTIVE_PHASES.has(recoveryFromPhase as AcceptJournalActivePhase)
    )
    || (phase === 'recovery-required') !== (recoveryFromPhase !== null)
  ) {
    dependencyFailure();
  }
  const relations = Object.freeze(
    relationRows.map(relation => decodeRelation(relation, objectFormat)),
  );
  let plan: PrepareAcceptInput;
  try {
    const common = {
      actorMemberId: row.actor_member_id,
      expectedHeadOid: row.expected_head_oid,
      expectedMainOid: row.expected_main_oid,
      expectedRequestRevision: safePositiveInteger(row.expected_request_revision),
      idempotencyKey: row.idempotency_key,
      mainRef: row.main_ref as 'refs/heads/main',
      objectFormat,
      operationId: row.operation_id,
      personalRef: row.personal_ref,
      placement: {
        generation: safePositiveInteger(row.placement_generation),
        projectId: row.project_id,
        repositoryStorageKey: row.repository_storage_key,
        storageNodeId: row.storage_node_id,
      },
      preparedAt: dateIso(row.prepared_at),
      relations,
      requestFingerprint: row.request_fingerprint,
      requestId: row.request_id,
      requestMemberId: row.request_member_id,
    } as const;
    if (row.result_kind === 'contained') {
      plan = canonicalPrepare({ ...common, resultKind: 'contained' });
    } else if (
      row.result_kind === 'merge'
      && row.tree_oid !== null
      && row.first_parent_oid !== null
      && row.second_parent_oid !== null
      && row.author_name !== null
      && row.author_email !== null
      && row.committer_name !== null
      && row.committer_email !== null
      && row.commit_timezone === '+0000'
      && Buffer.isBuffer(row.commit_message)
    ) {
      plan = canonicalPrepare({
        ...common,
        commit: {
          authorEmail: row.author_email,
          authorName: row.author_name,
          committerEmail: row.committer_email,
          committerName: row.committer_name,
          message: row.commit_message.toString('utf8'),
          parents: [row.first_parent_oid, row.second_parent_oid],
          timezone: '+0000',
          treeOid: row.tree_oid,
        },
        resultKind: 'merge',
      });
    } else {
      dependencyFailure();
    }
  } catch (error: unknown) {
    if (error instanceof CoordinationError) dependencyFailure();
    throw error;
  }
  const resultOid = row.result_oid ?? undefined;
  if (resultOid !== undefined) {
    try {
      assertOidForFormat(resultOid, objectFormat);
    } catch {
      dependencyFailure();
    }
  }
  return Object.freeze({
    ...plan,
    phase: phase as AcceptJournalPhase,
    recoveryFromPhase: recoveryFromPhase as AcceptJournalActivePhase | null
      ?? undefined,
    resultOid,
    updatedAt: dateIso(row.updated_at),
  });
}

function decodeAcceptResponse(value: unknown): AcceptResponse {
  try {
    return collabControlOperationCodec('acceptRequest').decodeResponse(value);
  } catch {
    dependencyFailure();
  }
}

export interface PostgresAcceptPersistenceOptions {
  readonly appendProjectEvent: (
    event: AppendProjectEvent,
  ) => Promise<unknown>;
  readonly collaboration: CollaborationProjectPersistence;
  readonly projectId: CollabProjectId;
  readonly query: ProjectQuery;
}

export class PostgresAcceptPersistence implements AcceptPersistence {
  readonly #appendProjectEvent: (
    event: AppendProjectEvent,
  ) => Promise<unknown>;
  readonly #collaboration: CollaborationProjectPersistence;
  readonly #projectId: CollabProjectId;
  readonly #query: ProjectQuery;

  constructor(options: PostgresAcceptPersistenceOptions) {
    this.#appendProjectEvent = options.appendProjectEvent;
    this.#collaboration = options.collaboration;
    this.#projectId = options.projectId;
    this.#query = options.query;
  }

  async get(operationId: CollabOperationId): Promise<AcceptJournalRecord | undefined> {
    if (!isCollabOpaqueId(operationId)) invalidRecord();
    const rows = await this.#query<AcceptJournalRow>(
      `SELECT project_id, operation_id, phase, recovery_from_phase, result_kind,
              actor_member_id, request_member_id, request_id, idempotency_key,
              request_fingerprint, expected_request_revision, expected_main_oid,
              expected_head_oid, main_ref, personal_ref, object_format,
              storage_node_id, repository_storage_key, placement_generation,
              prepared_at, tree_oid, first_parent_oid, second_parent_oid,
              author_name, author_email, committer_name, committer_email,
              commit_timezone, commit_message, result_oid, updated_at
         FROM claudian_cloud.accept_journals
        WHERE project_id = $1 AND operation_id = $2`,
      [this.#projectId, operationId],
    );
    if (rows.length > 1) dependencyFailure();
    const row = rows[0];
    if (row === undefined) return undefined;
    const relationRows = await this.#query<AcceptRelationRow>(
      `SELECT relation_id, ticket_id, ticket_revision, commit_oid, kind
         FROM claudian_cloud.accept_journal_relations
        WHERE project_id = $1 AND operation_id = $2
        ORDER BY relation_id`,
      [this.#projectId, operationId],
    );
    return decodeJournal(row, relationRows);
  }

  async getNonterminal(): Promise<AcceptJournalRecord | undefined> {
    const rows = await this.#query<{ readonly operation_id: string }>(
      `SELECT operation_id
         FROM claudian_cloud.accept_journals
        WHERE project_id = $1 AND phase <> 'completed'
        ORDER BY operation_id
        LIMIT 2`,
      [this.#projectId],
    );
    if (rows.length > 1) dependencyFailure();
    const operationId = rows[0]?.operation_id;
    if (operationId === undefined) return undefined;
    return this.get(operationId);
  }

  async prepare(input: PrepareAcceptInput): Promise<AcceptPrepareResult> {
    const plan = canonicalPrepare(input);
    if (plan.placement.projectId !== this.#projectId) invalidRecord();
    const existing = await this.get(plan.operationId);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, {
        ...plan,
        phase: existing.phase,
        recoveryFromPhase: existing.recoveryFromPhase,
        resultOid: existing.resultOid,
        updatedAt: existing.updatedAt,
      })) stateConflict();
      if (ACTIVE_PHASES.has(existing.phase as AcceptJournalActivePhase)) {
        await this.#scheduleRecovery(
          plan.operationId,
          existing.updatedAt,
          plan.preparedAt,
        );
      }
      return 'replayed';
    }
    if (await this.getNonterminal() !== undefined) stateConflict();
    await this.#assertLivePrepareFences(plan);

    const commit = plan.resultKind === 'merge' ? plan.commit : undefined;
    const rows = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.accept_journals (
         project_id, operation_id, phase, recovery_from_phase, result_kind,
         actor_member_id, request_member_id, request_id, idempotency_key,
         request_fingerprint, expected_request_revision, expected_main_oid,
         expected_head_oid, main_ref, personal_ref, object_format,
         storage_node_id, repository_storage_key, placement_generation,
         prepared_at, tree_oid, first_parent_oid, second_parent_oid,
         author_name, author_email, committer_name, committer_email,
         commit_timezone, commit_message, result_oid, created_at, updated_at
       ) VALUES (
         $1, $2, 'prepared', NULL, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17, $18::timestamptz,
         $19, $20, $21, $22, $23, $24, $25, $26, $27::bytea,
         NULL, $18::timestamptz, $18::timestamptz
       )
       RETURNING operation_id`,
      [
        this.#projectId,
        plan.operationId,
        plan.resultKind,
        plan.actorMemberId,
        plan.requestMemberId,
        plan.requestId,
        plan.idempotencyKey,
        plan.requestFingerprint,
        plan.expectedRequestRevision,
        plan.expectedMainOid,
        plan.expectedHeadOid,
        plan.mainRef,
        plan.personalRef,
        plan.objectFormat,
        plan.placement.storageNodeId,
        plan.placement.repositoryStorageKey,
        plan.placement.generation,
        plan.preparedAt,
        commit?.treeOid ?? null,
        commit?.parents[0] ?? null,
        commit?.parents[1] ?? null,
        commit?.authorName ?? null,
        commit?.authorEmail ?? null,
        commit?.committerName ?? null,
        commit?.committerEmail ?? null,
        commit?.timezone ?? null,
        commit === undefined ? null : Buffer.from(commit.message, 'utf8'),
      ],
    );
    if (rows.length !== 1) dependencyFailure();
    for (const relation of plan.relations) {
      const relationRows = await this.#query<{ readonly relation_id: string }>(
        `INSERT INTO claudian_cloud.accept_journal_relations (
           project_id, operation_id, request_id, relation_id, ticket_id,
           ticket_revision, commit_oid, kind
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING relation_id`,
        [
          this.#projectId,
          plan.operationId,
          plan.requestId,
          relation.relationId,
          relation.ticketId,
          relation.ticketRevision,
          relation.commitOid,
          relation.kind,
        ],
      );
      if (relationRows.length !== 1) dependencyFailure();
    }
    await this.#scheduleRecovery(plan.operationId, plan.preparedAt, plan.preparedAt);
    return 'created';
  }

  async persistResult(input: PersistAcceptResultInput): Promise<AcceptAdvanceResult> {
    if (!isCollabOpaqueId(input.operationId) || !isCollabGitOid(input.resultOid)) {
      invalidRecord();
    }
    inputTimestamp(input.updatedAt);
    const journal = await this.get(input.operationId);
    if (journal === undefined) stateConflict();
    try {
      assertOidForFormat(input.resultOid, journal.objectFormat);
    } catch {
      invalidRecord();
    }
    if (journal.resultKind === 'contained' && input.resultOid !== journal.expectedMainOid) {
      stateConflict();
    }
    if (
      journal.phase === 'result-persisted'
      && journal.resultOid === input.resultOid
      && journal.updatedAt === input.updatedAt
    ) {
      await this.#scheduleRecovery(input.operationId, input.updatedAt, journal.preparedAt);
      return 'replayed';
    }
    if (journal.phase !== input.expectedPhase || input.updatedAt < journal.updatedAt) {
      stateConflict();
    }
    const rows = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.accept_journals
          SET phase = 'result-persisted', result_oid = $3,
              updated_at = $4::timestamptz
        WHERE project_id = $1 AND operation_id = $2 AND phase = 'prepared'
          AND result_oid IS NULL
       RETURNING operation_id`,
      [this.#projectId, input.operationId, input.resultOid, input.updatedAt],
    );
    if (rows.length !== 1) stateConflict();
    await this.#scheduleRecovery(input.operationId, input.updatedAt, journal.preparedAt);
    return 'advanced';
  }

  async markMainUpdated(
    input: MarkAcceptMainUpdatedInput,
  ): Promise<AcceptAdvanceResult> {
    if (!isCollabOpaqueId(input.operationId)) invalidRecord();
    inputTimestamp(input.updatedAt);
    const journal = await this.get(input.operationId);
    if (journal === undefined) stateConflict();
    if (journal.phase === 'main-updated' && journal.updatedAt === input.updatedAt) {
      await this.#scheduleRecovery(input.operationId, input.updatedAt, journal.preparedAt);
      return 'replayed';
    }
    if (
      journal.phase !== input.expectedPhase
      || journal.resultOid === undefined
      || input.updatedAt < journal.updatedAt
    ) {
      stateConflict();
    }
    const rows = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.accept_journals
          SET phase = 'main-updated', updated_at = $3::timestamptz
        WHERE project_id = $1 AND operation_id = $2
          AND phase = 'result-persisted' AND result_oid IS NOT NULL
       RETURNING operation_id`,
      [this.#projectId, input.operationId, input.updatedAt],
    );
    if (rows.length !== 1) stateConflict();
    await this.#scheduleRecovery(input.operationId, input.updatedAt, journal.preparedAt);
    return 'advanced';
  }

  async markRecoveryRequired(
    input: MarkAcceptRecoveryRequiredInput,
  ): Promise<AcceptAdvanceResult> {
    if (!ACTIVE_PHASES.has(input.expectedPhase)) invalidRecord();
    if (!isCollabOpaqueId(input.operationId)) invalidRecord();
    inputTimestamp(input.updatedAt);
    const journal = await this.get(input.operationId);
    if (journal === undefined) stateConflict();
    let result: AcceptAdvanceResult;
    if (
      journal.phase === 'recovery-required'
      && journal.recoveryFromPhase === input.expectedPhase
      && journal.updatedAt === input.updatedAt
    ) {
      result = 'replayed';
    } else {
      if (journal.phase !== input.expectedPhase || input.updatedAt < journal.updatedAt) {
        stateConflict();
      }
      const rows = await this.#query<{ readonly operation_id: string }>(
        `UPDATE claudian_cloud.accept_journals
            SET phase = 'recovery-required', recovery_from_phase = $3,
                updated_at = $4::timestamptz
          WHERE project_id = $1 AND operation_id = $2 AND phase = $3
         RETURNING operation_id`,
        [this.#projectId, input.operationId, input.expectedPhase, input.updatedAt],
      );
      if (rows.length !== 1) stateConflict();
      result = 'advanced';
    }
    const projects = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.projects
          SET service_state = 'recovery-required'
        WHERE project_id = $1
          AND service_state IN ('active', 'recovery-required')
       RETURNING project_id`,
      [this.#projectId],
    );
    if (projects.length !== 1) stateConflict();
    await this.#query(
      `DELETE FROM claudian_cloud.active_repository_placement_catalog
        WHERE project_id = $1`,
      [this.#projectId],
    );
    await this.#removeRecoveryCandidate(input.operationId);
    return result;
  }

  async complete(input: CompleteAcceptInput): Promise<AcceptResponse> {
    if (!isCollabOpaqueId(input.operationId)) invalidRecord();
    inputTimestamp(input.completedAt);
    const journal = await this.get(input.operationId);
    if (journal === undefined) stateConflict();
    if (journal.phase === 'completed') return this.#replayResponse(journal);
    if (
      journal.phase !== 'main-updated'
      || journal.resultOid === undefined
      || input.completedAt < journal.updatedAt
    ) {
      stateConflict();
    }
    await this.#assertLiveCompletionFences(journal);

    const acceptedRelations = await this.#query<{ readonly relation_id: string }>(
      `UPDATE claudian_cloud.request_ticket_relations AS relation
          SET state = 'accepted', updated_at = $3::timestamptz,
              accepted_at = $3::timestamptz, accepted_merge_oid = $4
         FROM claudian_cloud.accept_journal_relations AS journal
        WHERE journal.project_id = $1 AND journal.operation_id = $2
          AND relation.project_id = journal.project_id
          AND relation.relation_id = journal.relation_id
          AND relation.request_id = journal.request_id
          AND relation.ticket_id = journal.ticket_id
          AND relation.commit_oid = journal.commit_oid
          AND relation.kind = journal.kind
          AND relation.state = 'pending'
       RETURNING relation.relation_id`,
      [this.#projectId, input.operationId, input.completedAt, journal.resultOid],
    );
    if (acceptedRelations.length !== journal.relations.length) stateConflict();

    const resolvingRelations = journal.relations.filter(
      relation => relation.kind === 'resolves',
    );
    const closedTickets = await this.#query<{ readonly ticket_id: string }>(
      `UPDATE claudian_cloud.tickets AS ticket
          SET status = 'closed', revision = ticket.revision + 1,
              updated_at = $3::timestamptz, closed_at = $3::timestamptz,
              closed_by_member_id = $4
         FROM claudian_cloud.accept_journal_relations AS journal
        WHERE journal.project_id = $1 AND journal.operation_id = $2
          AND journal.kind = 'resolves'
          AND ticket.project_id = journal.project_id
          AND ticket.ticket_id = journal.ticket_id
          AND ticket.status = 'open'
          AND ticket.revision = journal.ticket_revision
       RETURNING ticket.ticket_id`,
      [this.#projectId, input.operationId, input.completedAt, journal.actorMemberId],
    );
    if (closedTickets.length !== resolvingRelations.length) stateConflict();

    const requests = await this.#query<{ readonly request_id: string }>(
      `UPDATE claudian_cloud.change_requests
          SET status = 'merged', merged_oid = $4, updated_at = $5::timestamptz
        WHERE project_id = $1 AND request_id = $2 AND member_id = $3
          AND status = 'open' AND revision = $6
          AND latest_head_oid = $7
       RETURNING request_id`,
      [
        this.#projectId,
        journal.requestId,
        journal.requestMemberId,
        journal.resultOid,
        input.completedAt,
        journal.expectedRequestRevision,
        journal.expectedHeadOid,
      ],
    );
    if (requests.length !== 1) stateConflict();

    const projects = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.projects
          SET expected_main_oid = $3
        WHERE project_id = $1 AND expected_main_oid = $2
          AND service_state = 'active'
       RETURNING project_id`,
      [this.#projectId, journal.expectedMainOid, journal.resultOid],
    );
    if (projects.length !== 1) stateConflict();

    const request = await this.#collaboration.requests.find(journal.requestId);
    if (request === undefined) dependencyFailure();
    const response = decodeAcceptResponse({
      mainOid: journal.resultOid,
      mergeCommitOid: journal.resultOid,
      request,
    });
    this.#assertResponseMatchesJournal(response, journal, input.completedAt);
    const identity = {
      idempotencyKey: journal.idempotencyKey,
      memberId: journal.actorMemberId,
      operation: 'acceptRequest' as const,
      requestFingerprint: journal.requestFingerprint,
    };
    const stored = await this.#collaboration.idempotency.store({
      ...identity,
      createdAt: input.completedAt,
      response: response as unknown as Readonly<Record<string, unknown>>,
    });
    if (
      stored.kind === 'conflict'
      || !isDeepStrictEqual(decodeAcceptResponse(stored.response), response)
    ) {
      stateConflict();
    }
    await this.#appendProjectEvent({
      kind: 'main.updated',
      occurredAt: input.completedAt,
      payload: {
        mainOid: journal.resultOid,
        requestId: journal.requestId,
      },
    });
    const completed = await this.#query<{ readonly operation_id: string }>(
      `UPDATE claudian_cloud.accept_journals
          SET phase = 'completed', updated_at = $3::timestamptz
        WHERE project_id = $1 AND operation_id = $2 AND phase = 'main-updated'
       RETURNING operation_id`,
      [this.#projectId, input.operationId, input.completedAt],
    );
    if (completed.length !== 1) stateConflict();
    await this.#removeRecoveryCandidate(input.operationId);
    return response;
  }

  async #assertLivePrepareFences(plan: PrepareAcceptInput): Promise<void> {
    const fences = await this.#query<ProjectFenceRow>(
      `SELECT project.expected_main_oid, project.service_state,
              placement.storage_node_id, placement.repository_storage_key,
              placement.generation
         FROM claudian_cloud.projects AS project
         JOIN claudian_cloud.repository_placements AS placement
           ON placement.project_id = project.project_id AND placement.active
        WHERE project.project_id = $1`,
      [this.#projectId],
    );
    const fence = fences[0];
    if (
      fences.length !== 1
      || fence === undefined
      || fence.service_state !== 'active'
      || fence.expected_main_oid !== plan.expectedMainOid
      || fence.storage_node_id !== plan.placement.storageNodeId
      || fence.repository_storage_key !== plan.placement.repositoryStorageKey
      || safePositiveInteger(fence.generation) !== plan.placement.generation
    ) {
      stateConflict();
    }
    const request = await this.#collaboration.requests.find(plan.requestId);
    if (
      request === undefined
      || request.status !== 'open'
      || request.memberId !== plan.requestMemberId
      || request.latestHeadOid !== plan.expectedHeadOid
      || request.revision !== plan.expectedRequestRevision
      || request.ticketRelations.length !== plan.relations.length
    ) {
      stateConflict();
    }
    const actualRelations = [...request.ticketRelations].sort((left, right) => (
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    ));
    for (const [index, relation] of plan.relations.entries()) {
      const actual = actualRelations[index];
      if (
        actual === undefined
        || actual.id !== relation.relationId
        || actual.ticketId !== relation.ticketId
        || actual.ticketRevision !== relation.ticketRevision
        || actual.commitOid !== relation.commitOid
        || actual.kind !== relation.kind
        || actual.state !== 'pending'
      ) {
        stateConflict();
      }
    }
  }

  async #assertLiveCompletionFences(journal: AcceptJournalRecord): Promise<void> {
    const fences = await this.#query<ProjectFenceRow>(
      `SELECT project.expected_main_oid, project.service_state,
              placement.storage_node_id, placement.repository_storage_key,
              placement.generation
         FROM claudian_cloud.projects AS project
         JOIN claudian_cloud.repository_placements AS placement
           ON placement.project_id = project.project_id AND placement.active
        WHERE project.project_id = $1`,
      [this.#projectId],
    );
    const fence = fences[0];
    if (
      fences.length !== 1
      || fence === undefined
      || fence.service_state !== 'active'
      || fence.expected_main_oid !== journal.expectedMainOid
      || fence.storage_node_id !== journal.placement.storageNodeId
      || fence.repository_storage_key !== journal.placement.repositoryStorageKey
      || safePositiveInteger(fence.generation) !== journal.placement.generation
    ) {
      stateConflict();
    }
    const request = await this.#collaboration.requests.find(journal.requestId);
    if (
      request === undefined
      || request.status !== 'open'
      || request.memberId !== journal.requestMemberId
      || request.latestHeadOid !== journal.expectedHeadOid
      || request.revision !== journal.expectedRequestRevision
      || request.ticketRelations.length !== journal.relations.length
    ) {
      stateConflict();
    }
    const actualRelations = [...request.ticketRelations].sort((left, right) => (
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    ));
    for (const [index, relation] of journal.relations.entries()) {
      const actual = actualRelations[index];
      if (
        actual === undefined
        || actual.id !== relation.relationId
        || actual.ticketId !== relation.ticketId
        || actual.ticketRevision !== relation.ticketRevision
        || actual.commitOid !== relation.commitOid
        || actual.kind !== relation.kind
        || actual.state !== 'pending'
      ) {
        stateConflict();
      }
    }
  }

  async #replayResponse(journal: AcceptJournalRecord): Promise<AcceptResponse> {
    const replay = await this.#collaboration.idempotency.find({
      idempotencyKey: journal.idempotencyKey,
      memberId: journal.actorMemberId,
      operation: 'acceptRequest',
      requestFingerprint: journal.requestFingerprint,
    });
    if (replay.kind !== 'replay') dependencyFailure();
    const response = decodeAcceptResponse(replay.response);
    this.#assertResponseMatchesJournal(response, journal, journal.updatedAt);
    return response;
  }

  #assertResponseMatchesJournal(
    response: AcceptResponse,
    journal: AcceptJournalRecord,
    expectedUpdatedAt: string,
  ): void {
    if (
      journal.resultOid === undefined
      || response.mainOid !== journal.resultOid
      || response.mergeCommitOid !== journal.resultOid
      || response.request.id !== journal.requestId
      || response.request.memberId !== journal.requestMemberId
      || response.request.status !== 'merged'
      || response.request.mergedOid !== journal.resultOid
      || response.request.latestHeadOid !== journal.expectedHeadOid
      || response.request.revision !== journal.expectedRequestRevision
      || response.request.updatedAt !== expectedUpdatedAt
      || response.request.ticketRelations.length !== journal.relations.length
    ) {
      dependencyFailure();
    }
    const responseRelations = new Map(
      response.request.ticketRelations.map(relation => [relation.id, relation]),
    );
    for (const relation of journal.relations) {
      const responseRelation = responseRelations.get(relation.relationId);
      if (
        responseRelation === undefined
        || responseRelation.ticketId !== relation.ticketId
        || responseRelation.ticketRevision !== (
          relation.kind === 'resolves'
            ? relation.ticketRevision + 1
            : relation.ticketRevision
        )
        || responseRelation.commitOid !== relation.commitOid
        || responseRelation.kind !== relation.kind
        || responseRelation.state !== 'accepted'
      ) {
        dependencyFailure();
      }
    }
  }

  async #scheduleRecovery(
    operationId: CollabOperationId,
    scheduledAt: string,
    createdAt: string,
  ): Promise<void> {
    const rows = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.recovery_candidates (
         kind, project_id, operation_id, scheduled_at, created_at
       ) VALUES ('accept', $1, $2, $3::timestamptz, $4::timestamptz)
       ON CONFLICT (kind, project_id) DO UPDATE
         SET scheduled_at = EXCLUDED.scheduled_at
       WHERE claudian_cloud.recovery_candidates.operation_id = EXCLUDED.operation_id
       RETURNING operation_id`,
      [this.#projectId, operationId, scheduledAt, createdAt],
    );
    if (rows.length !== 1 || rows[0]?.operation_id !== operationId) stateConflict();
  }

  async #removeRecoveryCandidate(operationId: CollabOperationId): Promise<void> {
    await this.#query(
      `DELETE FROM claudian_cloud.recovery_candidates
        WHERE kind = 'accept' AND project_id = $1 AND operation_id = $2`,
      [this.#projectId, operationId],
    );
  }
}
