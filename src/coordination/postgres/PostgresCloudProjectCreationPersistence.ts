import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  COLLAB_PROJECT_MEMBERSHIP_LIMITS,
  collabControlOperationCodec,
  collabMemberRef,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type CreateCloudProjectResponse,
} from '@claudian-collab/protocol';
import type { QueryResultRow } from 'pg';

import type {
  CloudProjectCreationJournal,
  CloudProjectCreationPersistence,
  CloudProjectCreationPhase,
  PrepareCloudProjectCreationInput,
} from '../CloudProjectCreationPersistence.js';
import { CoordinationError } from '../CoordinationError.js';

type ProjectQuery = <Row extends QueryResultRow>(
  text: string,
  values: readonly unknown[],
) => Promise<readonly Row[]>;

interface CreationJournalRow {
  readonly author_email: string;
  readonly author_name: string;
  readonly commit_message: Buffer;
  readonly commit_timestamp_seconds: string;
  readonly commit_timezone: string;
  readonly empty_tree_oid: string;
  readonly idempotency_key: string;
  readonly initial_commit_oid: string;
  readonly main_ref: string;
  readonly manager_display_name: string;
  readonly member_id: string;
  readonly object_format: string;
  readonly operation_id: string;
  readonly personal_ref: string;
  readonly phase: string;
  readonly placement_generation: string;
  readonly plan_sha256: string;
  readonly prepared_at: Date;
  readonly principal_id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly publication_marker_sha256: string | null;
  readonly repository_storage_key: string;
  readonly request_fingerprint: string;
  readonly response_json: string | null;
  readonly storage_node_id: string;
  readonly updated_at: Date;
}

const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const STORAGE_NODE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PHASES = new Set<CloudProjectCreationPhase>([
  'prepared',
  'repository-publication-intent',
  'repository-published',
  'activated',
  'completed',
]);

function invalidRecord(): never {
  throw new CoordinationError('invalid-record');
}

function dependencyFailure(): never {
  throw new CoordinationError('dependency-failed');
}

function stateConflict(): never {
  throw new CoordinationError('state-conflict');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function gitObjectOid(content: string): string {
  return createHash('sha1')
    .update(`commit ${String(Buffer.byteLength(content, 'utf8'))}\0`, 'utf8')
    .update(content, 'utf8')
    .digest('hex');
}

function commitContent(plan: PrepareCloudProjectCreationInput): string {
  const commit = plan.commit;
  const identity = `${commit.authorName} <${commit.authorEmail}> ${String(commit.commitTimestampSeconds)} ${commit.timezone}`;
  return `tree ${commit.emptyTreeOid}\nauthor ${identity}\ncommitter ${identity}\n\n${commit.commitMessage}\n`;
}

function planDigest(plan: PrepareCloudProjectCreationInput): string {
  return sha256(JSON.stringify({
    commit: plan.commit,
    createdAt: plan.preparedAt,
    managerDisplayName: plan.managerDisplayName,
    memberId: plan.memberId,
    placement: plan.placement,
    principalId: plan.principalId,
    projectId: plan.projectId,
    projectName: plan.projectName,
  }));
}

function exactTimestamp(value: string): string {
  if (
    Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
    || new Date(value).getUTCMilliseconds() !== 0
  ) invalidRecord();
  return value;
}

function rowTimestamp(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    dependencyFailure();
  }
  return value.toISOString();
}

function canonicalPlan(
  input: PrepareCloudProjectCreationInput,
): PrepareCloudProjectCreationInput {
  const projectNameBytes = Buffer.byteLength(input.projectName, 'utf8');
  const displayNameBytes = Buffer.byteLength(input.managerDisplayName, 'utf8');
  if (
    !isCollabProjectId(input.projectId)
    || !isCollabMemberId(input.memberId)
    || !isCollabOpaqueId(input.operationId)
    || !isCollabOpaqueId(input.idempotencyKey)
    || !PRINCIPAL_PATTERN.test(input.principalId)
    || !SHA256_PATTERN.test(input.requestFingerprint)
    || !SHA256_PATTERN.test(input.planSha256)
    || projectNameBytes < 1
    || projectNameBytes > COLLAB_PROJECT_MEMBERSHIP_LIMITS.maxProjectNameUtf8Bytes
    || displayNameBytes < 1
    || displayNameBytes > COLLAB_PROJECT_MEMBERSHIP_LIMITS.maxDisplayNameUtf8Bytes
    || input.placement.projectId !== input.projectId
    || !STORAGE_NODE_PATTERN.test(input.placement.storageNodeId)
    || !STORAGE_KEY_PATTERN.test(input.placement.repositoryStorageKey)
    || input.commit.personalRef !== collabMemberRef(input.memberId)
    || input.commit.emptyTreeOid !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    || !isCollabGitOid(input.commit.initialCommitOid)
    || input.commit.initialCommitOid.length !== 40
    || !Number.isSafeInteger(input.commit.commitTimestampSeconds)
    || input.commit.commitTimestampSeconds < 0
  ) invalidRecord();
  exactTimestamp(input.preparedAt);
  if (
    input.commit.commitTimestampSeconds
      !== Math.floor(new Date(input.preparedAt).valueOf() / 1_000)
    || gitObjectOid(commitContent(input)) !== input.commit.initialCommitOid
    || planDigest(input) !== input.planSha256
  ) invalidRecord();
  return Object.freeze({
    ...input,
    commit: Object.freeze({ ...input.commit }),
    placement: Object.freeze({ ...input.placement }),
  });
}

function decodeResponse(value: unknown): CreateCloudProjectResponse {
  try {
    return collabControlOperationCodec('createCloudProject').decodeResponse(value);
  } catch {
    dependencyFailure();
  }
}

function decodeJournal(row: CreationJournalRow): CloudProjectCreationJournal {
  if (
    !PHASES.has(row.phase as CloudProjectCreationPhase)
    || row.object_format !== 'sha1'
    || row.commit_message.toString('utf8') !== 'Initialize Collab project'
  ) dependencyFailure();
  const preparedAt = rowTimestamp(row.prepared_at);
  const plan = canonicalPlan({
    commit: {
      authorEmail: row.author_email as 'cloud@claudian.invalid',
      authorName: row.author_name as 'Claudian Cloud',
      commitMessage: row.commit_message.toString('utf8') as 'Initialize Collab project',
      commitTimestampSeconds: Number(row.commit_timestamp_seconds),
      emptyTreeOid: row.empty_tree_oid,
      initialCommitOid: row.initial_commit_oid,
      mainRef: row.main_ref as 'refs/heads/main',
      objectFormat: row.object_format,
      personalRef: row.personal_ref,
      timezone: row.commit_timezone as '+0000',
    },
    idempotencyKey: row.idempotency_key,
    managerDisplayName: row.manager_display_name,
    memberId: row.member_id,
    operationId: row.operation_id,
    placement: {
      active: false,
      generation: Number(row.placement_generation) as 1,
      projectId: row.project_id,
      repositoryStorageKey: row.repository_storage_key,
      storageNodeId: row.storage_node_id,
    },
    planSha256: row.plan_sha256,
    preparedAt,
    principalId: row.principal_id,
    projectId: row.project_id,
    projectName: row.project_name,
    requestFingerprint: row.request_fingerprint,
  });
  const response = row.response_json === null
    ? undefined
    : decodeResponse(JSON.parse(row.response_json) as unknown);
  const publicationMarkerSha256 = row.publication_marker_sha256 ?? undefined;
  if (
    (publicationMarkerSha256 !== undefined
      && !SHA256_PATTERN.test(publicationMarkerSha256))
    || (['prepared', 'repository-publication-intent'].includes(row.phase)
      && (publicationMarkerSha256 !== undefined || response !== undefined))
    || (row.phase === 'repository-published'
      && (publicationMarkerSha256 === undefined || response !== undefined))
    || (['activated', 'completed'].includes(row.phase)
      && (publicationMarkerSha256 === undefined || response === undefined))
  ) dependencyFailure();
  return Object.freeze({
    ...plan,
    phase: row.phase as CloudProjectCreationPhase,
    publicationMarkerSha256,
    response,
    updatedAt: rowTimestamp(row.updated_at),
  });
}

function exactResponse(
  plan: PrepareCloudProjectCreationInput,
  response: CreateCloudProjectResponse,
): boolean {
  return response.createdAt === plan.preparedAt
    && response.mainOid === plan.commit.initialCommitOid
    && response.memberId === plan.memberId
    && response.personalRef === plan.commit.personalRef
    && response.projectId === plan.projectId;
}

export class PostgresCloudProjectCreationPersistence
implements CloudProjectCreationPersistence {
  readonly #projectId: string;
  readonly #query: ProjectQuery;

  constructor(query: ProjectQuery, projectId: string) {
    this.#query = query;
    this.#projectId = projectId;
  }

  async get(): Promise<CloudProjectCreationJournal | undefined> {
    const rows = await this.#query<CreationJournalRow>(
      `SELECT project_id, operation_id, phase, principal_id, idempotency_key,
              request_fingerprint, project_name, member_id,
              manager_display_name, personal_ref, object_format,
              empty_tree_oid, initial_commit_oid, commit_timestamp_seconds,
              author_name, author_email, commit_timezone, commit_message,
              main_ref, storage_node_id, repository_storage_key,
              placement_generation, plan_sha256,
              publication_marker_sha256, response_json, prepared_at,
              updated_at
         FROM claudian_cloud.cloud_project_creation_journals
        WHERE project_id = $1`,
      [this.#projectId],
    );
    if (rows.length > 1) dependencyFailure();
    return rows[0] === undefined ? undefined : decodeJournal(rows[0]);
  }

  async prepare(
    input: PrepareCloudProjectCreationInput,
  ): Promise<'conflict' | 'created' | 'replayed'> {
    const plan = canonicalPlan(input);
    if (plan.projectId !== this.#projectId) invalidRecord();
    const existing = await this.get();
    if (existing !== undefined) {
      const existingPlan: PrepareCloudProjectCreationInput = {
        commit: existing.commit,
        idempotencyKey: existing.idempotencyKey,
        managerDisplayName: existing.managerDisplayName,
        memberId: existing.memberId,
        operationId: existing.operationId,
        placement: existing.placement,
        planSha256: existing.planSha256,
        preparedAt: existing.preparedAt,
        principalId: existing.principalId,
        projectId: existing.projectId,
        projectName: existing.projectName,
        requestFingerprint: existing.requestFingerprint,
      };
      return isDeepStrictEqual(existingPlan, plan) ? 'replayed' : 'conflict';
    }
    const project = await this.#query<{ readonly project_id: string }>(
      'SELECT project_id FROM claudian_cloud.projects WHERE project_id = $1',
      [this.#projectId],
    );
    if (project.length !== 0) return 'conflict';

    await this.#query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation,
         expected_main_oid, service_state, created_at, activated_at,
         authority_generation, authority_state_revision
       ) VALUES ($1, $2, 0, $3, 'maintenance', $4, $4, 1, 1)`,
      [plan.projectId, plan.projectName, plan.commit.initialCommitOid, plan.preparedAt],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, display_name, role, status, revision,
         created_at, updated_at, activated_at, revoked_at, left_at
       ) VALUES ($1, $2, $3, 'manager', 'pending', 1,
                 $4, $4, NULL, NULL, NULL)`,
      [plan.projectId, plan.memberId, plan.managerDisplayName, plan.preparedAt],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.project_principal_bindings (
         project_id, principal_id, member_id, state, bound_at, revoked_at
       ) VALUES ($1, $2, $3, 'pending', $4, NULL)`,
      [plan.projectId, plan.principalId, plan.memberId, plan.preparedAt],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, $2, $3, 1, false, $4, $4)`,
      [
        plan.projectId,
        plan.placement.storageNodeId,
        plan.placement.repositoryStorageKey,
        plan.preparedAt,
      ],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.cloud_project_creation_journals (
         project_id, operation_id, phase, principal_id, idempotency_key,
         request_fingerprint, project_name, member_id,
         manager_display_name, personal_ref, object_format, empty_tree_oid,
         initial_commit_oid, commit_timestamp_seconds, author_name,
         author_email, commit_timezone, commit_message, main_ref,
         storage_node_id, repository_storage_key, placement_generation,
         plan_sha256, publication_marker_sha256, response_json,
         prepared_at, updated_at
       ) VALUES (
         $1, $2, 'prepared', $3, $4, $5, $6, $7, $8, $9, 'sha1',
         $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 1,
         $20, NULL, NULL, $21, $21
       )`,
      [
        plan.projectId,
        plan.operationId,
        plan.principalId,
        plan.idempotencyKey,
        plan.requestFingerprint,
        plan.projectName,
        plan.memberId,
        plan.managerDisplayName,
        plan.commit.personalRef,
        plan.commit.emptyTreeOid,
        plan.commit.initialCommitOid,
        plan.commit.commitTimestampSeconds,
        plan.commit.authorName,
        plan.commit.authorEmail,
        plan.commit.timezone,
        Buffer.from(plan.commit.commitMessage, 'utf8'),
        plan.commit.mainRef,
        plan.placement.storageNodeId,
        plan.placement.repositoryStorageKey,
        plan.planSha256,
        plan.preparedAt,
      ],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.recovery_candidates (
         kind, project_id, operation_id, scheduled_at, created_at
       ) VALUES ('create-project', $1, $2, $3, $3)`,
      [plan.projectId, plan.operationId, plan.preparedAt],
    );
    return 'created';
  }

  markRepositoryPublicationIntent(
    updatedAt: string,
  ): Promise<'advanced' | 'replayed'> {
    return this.#advance(
      'prepared',
      'repository-publication-intent',
      exactTimestamp(updatedAt),
    );
  }

  async markRepositoryPublished(input: Readonly<{
    readonly publicationMarkerSha256: string;
    readonly updatedAt: string;
  }>): Promise<'advanced' | 'replayed'> {
    if (!SHA256_PATTERN.test(input.publicationMarkerSha256)) invalidRecord();
    const journal = await this.get();
    if (journal === undefined) stateConflict();
    if (
      ['repository-published', 'activated', 'completed'].includes(journal.phase)
    ) {
      if (journal.publicationMarkerSha256 !== input.publicationMarkerSha256) {
        stateConflict();
      }
      return 'replayed';
    }
    if (journal.phase !== 'repository-publication-intent') stateConflict();
    const rows = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.cloud_project_creation_journals
          SET phase = 'repository-published',
              publication_marker_sha256 = $2,
              updated_at = $3
        WHERE project_id = $1
          AND phase = 'repository-publication-intent'
       RETURNING project_id`,
      [this.#projectId, input.publicationMarkerSha256, exactTimestamp(input.updatedAt)],
    );
    if (rows.length !== 1) stateConflict();
    return 'advanced';
  }

  async activate(input: Readonly<{
    readonly activatedAt: string;
    readonly response: CreateCloudProjectResponse;
  }>): Promise<CreateCloudProjectResponse> {
    const activatedAt = exactTimestamp(input.activatedAt);
    const decoded = decodeResponse(input.response);
    const journal = await this.get();
    if (journal === undefined || !exactResponse(journal, decoded)) {
      invalidRecord();
    }
    if (journal.phase === 'activated' || journal.phase === 'completed') {
      if (journal.response === undefined || !isDeepStrictEqual(journal.response, decoded)) {
        stateConflict();
      }
      return journal.response;
    }
    if (journal.phase !== 'repository-published') stateConflict();

    const project = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.projects
          SET manager_set_generation = 1,
              service_state = 'active',
              activated_at = $2,
              authority_state_revision = 2
        WHERE project_id = $1
          AND manager_set_generation = 0
          AND service_state = 'maintenance'
          AND authority_generation = 1
          AND authority_state_revision = 1
       RETURNING project_id`,
      [this.#projectId, activatedAt],
    );
    const membership = await this.#query<{ readonly member_id: string }>(
      `UPDATE claudian_cloud.project_memberships
          SET status = 'active', revision = 2,
              updated_at = $3, activated_at = $3
        WHERE project_id = $1 AND member_id = $2
          AND status = 'pending' AND revision = 1
       RETURNING member_id`,
      [this.#projectId, journal.memberId, activatedAt],
    );
    const binding = await this.#query<{ readonly principal_id: string }>(
      `UPDATE claudian_cloud.project_principal_bindings
          SET state = 'active'
        WHERE project_id = $1 AND principal_id = $2
          AND member_id = $3 AND state = 'pending'
       RETURNING principal_id`,
      [this.#projectId, journal.principalId, journal.memberId],
    );
    const placement = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.repository_placements
          SET active = true, updated_at = $2
        WHERE project_id = $1 AND generation = 1 AND NOT active
       RETURNING project_id`,
      [this.#projectId, activatedAt],
    );
    if (
      project.length !== 1
      || membership.length !== 1
      || binding.length !== 1
      || placement.length !== 1
    ) stateConflict();
    await this.#query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, $2, $3, 1)`,
      [
        this.#projectId,
        journal.placement.storageNodeId,
        journal.placement.repositoryStorageKey,
      ],
    );
    const rows = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.cloud_project_creation_journals
          SET phase = 'activated', response_json = $2, updated_at = $3
        WHERE project_id = $1 AND phase = 'repository-published'
       RETURNING project_id`,
      [this.#projectId, JSON.stringify(decoded), activatedAt],
    );
    if (rows.length !== 1) stateConflict();
    return decoded;
  }

  async complete(completedAt: string): Promise<CreateCloudProjectResponse> {
    const timestamp = exactTimestamp(completedAt);
    const journal = await this.get();
    if (journal?.response === undefined) stateConflict();
    if (journal.phase === 'completed') return journal.response;
    if (journal.phase !== 'activated') stateConflict();
    const rows = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.cloud_project_creation_journals
          SET phase = 'completed', updated_at = $2
        WHERE project_id = $1 AND phase = 'activated'
       RETURNING project_id`,
      [this.#projectId, timestamp],
    );
    if (rows.length !== 1) stateConflict();
    await this.#query(
      `DELETE FROM claudian_cloud.recovery_candidates
        WHERE kind = 'create-project' AND project_id = $1
          AND operation_id = $2`,
      [this.#projectId, journal.operationId],
    );
    return journal.response;
  }

  async #advance(
    expected: CloudProjectCreationPhase,
    next: CloudProjectCreationPhase,
    updatedAt: string,
  ): Promise<'advanced' | 'replayed'> {
    const journal = await this.get();
    if (journal === undefined) stateConflict();
    const order: readonly CloudProjectCreationPhase[] = [
      'prepared',
      'repository-publication-intent',
      'repository-published',
      'activated',
      'completed',
    ];
    if (order.indexOf(journal.phase) >= order.indexOf(next)) return 'replayed';
    if (journal.phase !== expected) stateConflict();
    const rows = await this.#query<{ readonly project_id: string }>(
      `UPDATE claudian_cloud.cloud_project_creation_journals
          SET phase = $3, updated_at = $4
        WHERE project_id = $1 AND phase = $2
       RETURNING project_id`,
      [this.#projectId, expected, next, updatedAt],
    );
    if (rows.length !== 1) stateConflict();
    return 'advanced';
  }
}
