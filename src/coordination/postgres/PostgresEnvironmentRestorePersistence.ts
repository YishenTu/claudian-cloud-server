import { createHash } from 'node:crypto';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  decodeCollabProjectBackupCheckpointCoordinationNdjson,
  encodeCollabProjectBackupCheckpointCoordinationNdjson,
  isCollabOpaqueId,
  type CollabProjectBackupRecord,
  type CollabProjectId,
} from '@claudian-collab/protocol';
import { Client, type QueryResultRow } from 'pg';

import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../../config/PostgresSchemaCompatibility.js';
import { CoordinationError } from '../CoordinationError.js';
import type {
  EnvironmentRestorePersistence,
  EnvironmentRestorePersistenceCatalog,
  EnvironmentRestorePersistenceProject,
  EnvironmentRestorePersistenceRepository,
} from '../EnvironmentRestorePersistence.js';
import { PostgresMigrator } from './PostgresMigrator.js';
import { PostgresProjectCheckpointPersistence } from './PostgresProjectCheckpointPersistence.js';

export interface PostgresEnvironmentRestorePersistenceOptions {
  readonly connectionString: string;
}

interface RestoreFenceRow {
  readonly authority_id: string;
  readonly authority_volume_id: string;
  readonly authority_volume_identity: string;
  readonly coordination_schema_version: number;
  readonly operation_id: string;
  readonly restore_epoch: string;
  readonly state: 'published' | 'staged';
}

interface RestoreDatabaseIdentity {
  readonly authority_volume_id: string | null;
}

interface RestoreSchemaState {
  readonly canonical_schema: string | null;
  readonly fence_relation: string | null;
  readonly restore_schema: string | null;
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESTORE_LOCK_NAMESPACE = 1_665_883_532;
const RESTORE_LOCK_KEY = 2;
const RESTORE_DEPENDENCY_TIMEOUT_MS = 300_000;
const MIGRATION_ROLE = 'claudian_cloud_migration';
const MAXIMUM_RESTORE_COORDINATION_BYTES =
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes;
const CONTINUITY_KINDS = new Set<CollabProjectBackupRecord['kind']>([
  'protected-claim-envelope',
  'terminal-principal',
  'terminal-responder',
  'terminal-responder-replay',
  'transfer-claim-batch-receipt',
  'transfer-receipt-key',
  'transfer-redemption-receipt',
  'transferred-membership-claim',
]);

const CREATE_FENCE_SQL = `
CREATE SCHEMA claudian_cloud_restore AUTHORIZATION claudian_cloud_migration;
REVOKE ALL ON SCHEMA claudian_cloud_restore FROM PUBLIC;

CREATE TABLE claudian_cloud_restore.database_fence (
  singleton boolean PRIMARY KEY DEFAULT true,
  operation_id varchar(128) NOT NULL,
  authority_id varchar(128) NOT NULL,
  authority_volume_id varchar(128) NOT NULL,
  authority_volume_identity varchar(128) NOT NULL,
  coordination_schema_version integer NOT NULL,
  restore_epoch bigint NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'staged',
  CONSTRAINT database_fence_singleton CHECK (singleton),
  CONSTRAINT database_fence_operation_id CHECK (
    operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT database_fence_authority_id CHECK (
    authority_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT database_fence_authority_volume_id CHECK (
    authority_volume_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT database_fence_authority_volume_identity CHECK (
    authority_volume_identity ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT database_fence_coordination_schema_version CHECK (
    coordination_schema_version > 0
  ),
  CONSTRAINT database_fence_restore_epoch CHECK (restore_epoch > 0),
  CONSTRAINT database_fence_state CHECK (state IN ('staged', 'published'))
);

REVOKE ALL ON claudian_cloud_restore.database_fence FROM PUBLIC;
`;

function fail(code: 'cancelled' | 'dependency-failed' | 'state-conflict'): never {
  throw new CoordinationError(code);
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) fail('cancelled');
}

function validIdentity(value: string): boolean {
  return IDENTITY_PATTERN.test(value);
}

function exactFence(
  row: RestoreFenceRow | undefined,
  expected: Readonly<{
    readonly authorityId: string;
    readonly authorityVolumeId: string;
    readonly authorityVolumeIdentity: string;
    readonly coordinationSchemaVersion: number;
    readonly operationId: string;
    readonly restoreEpoch: number;
  }>,
): boolean {
  return row !== undefined
    && row.authority_id === expected.authorityId
    && row.authority_volume_id === expected.authorityVolumeId
    && row.authority_volume_identity === expected.authorityVolumeIdentity
    && row.coordination_schema_version === expected.coordinationSchemaVersion
    && row.operation_id === expected.operationId
    && Number(row.restore_epoch) === expected.restoreEpoch;
}

function canonicalRecords(
  records: readonly CollabProjectBackupRecord[],
): readonly CollabProjectBackupRecord[] {
  try {
    const encoded = encodeCollabProjectBackupCheckpointCoordinationNdjson(records);
    if (Buffer.byteLength(encoded, 'utf8') > MAXIMUM_RESTORE_COORDINATION_BYTES) {
      fail('state-conflict');
    }
    return decodeCollabProjectBackupCheckpointCoordinationNdjson(encoded);
  } catch (error: unknown) {
    if (error instanceof CoordinationError) throw error;
    return fail('state-conflict');
  }
}

function exactRecord<Kind extends CollabProjectBackupRecord['kind']>(
  records: readonly CollabProjectBackupRecord[],
  kind: Kind,
): Extract<CollabProjectBackupRecord, { readonly kind: Kind }> {
  const matches = records.filter((record): record is Extract<
    CollabProjectBackupRecord,
    { readonly kind: Kind }
  > => record.kind === kind);
  if (matches.length !== 1) fail('state-conflict');
  return matches[0] ?? fail('state-conflict');
}

async function schemaState(client: Client): Promise<RestoreSchemaState> {
  const result = await client.query<RestoreSchemaState>(
    `SELECT to_regnamespace('claudian_cloud')::text AS canonical_schema,
            to_regnamespace('claudian_cloud_restore')::text AS restore_schema,
            to_regclass('claudian_cloud_restore.database_fence')::text
              AS fence_relation`,
  );
  return result.rows[0] ?? fail('dependency-failed');
}

async function databaseIdentity(client: Client): Promise<string> {
  const result = await client.query<RestoreDatabaseIdentity>(
    `SELECT current_setting(
              'claudian_cloud.authority_volume_id',
              true
            ) AS authority_volume_id`,
  );
  return result.rows[0]?.authority_volume_id ?? fail('dependency-failed');
}

async function verifyRole(client: Client): Promise<void> {
  const result = await client.query<{ readonly role_name: string }>(
    'SELECT current_user AS role_name',
  );
  if (result.rows[0]?.role_name !== MIGRATION_ROLE) fail('dependency-failed');
}

export class PostgresEnvironmentRestorePersistence
implements EnvironmentRestorePersistence {
  readonly #connectionString: string;

  constructor(options: PostgresEnvironmentRestorePersistenceOptions) {
    if (options.connectionString.length === 0) {
      throw new TypeError('postgres-environment-restore.options-invalid');
    }
    this.#connectionString = options.connectionString;
  }

  async assertEmpty(signal: AbortSignal): Promise<void> {
    assertActive(signal);
    await this.#withClient(signal, async client => {
      const state = await schemaState(client);
      if (state.canonical_schema !== null || state.restore_schema !== null) {
        fail('state-conflict');
      }
    });
  }

  async createDatabase(input: Readonly<{
    readonly authorityId: string;
    readonly authorityVolumeId: string;
    readonly authorityVolumeIdentity: string;
    readonly coordinationSchemaVersion: number;
    readonly operationId: string;
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<Readonly<{ readonly authorityVolumeId: string }>> {
    assertActive(input.signal);
    if (
      !validIdentity(input.authorityId)
      || !validIdentity(input.authorityVolumeId)
      || !validIdentity(input.authorityVolumeIdentity)
      || !validIdentity(input.operationId)
      || input.coordinationSchemaVersion !== CURRENT_POSTGRES_SCHEMA_VERSION
      || !Number.isSafeInteger(input.restoreEpoch)
      || input.restoreEpoch <= 0
    ) fail('state-conflict');

    await this.#withClient(input.signal, async client => {
      await client.query('BEGIN');
      try {
        await client.query(
          'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
          [RESTORE_LOCK_NAMESPACE, RESTORE_LOCK_KEY],
        );
        assertActive(input.signal);
        if (await databaseIdentity(client) !== input.authorityVolumeId) {
          fail('state-conflict');
        }
        const state = await schemaState(client);
        if (state.restore_schema === null) {
          if (state.canonical_schema !== null) fail('state-conflict');
          await client.query(CREATE_FENCE_SQL);
          await client.query(
            `INSERT INTO claudian_cloud_restore.database_fence (
               singleton,
               operation_id,
               authority_id,
               authority_volume_id,
               authority_volume_identity,
               coordination_schema_version,
               restore_epoch,
               state
             ) VALUES (true, $1, $2, $3, $4, $5, $6, 'staged')`,
            [
              input.operationId,
              input.authorityId,
              input.authorityVolumeId,
              input.authorityVolumeIdentity,
              input.coordinationSchemaVersion,
              input.restoreEpoch,
            ],
          );
        } else {
          if (state.fence_relation === null) fail('state-conflict');
          const existing = await client.query<RestoreFenceRow>(
            `SELECT operation_id, authority_id, authority_volume_id,
                    authority_volume_identity, coordination_schema_version,
                    restore_epoch, state
               FROM claudian_cloud_restore.database_fence`,
          );
          if (
            existing.rows.length !== 1
            || !exactFence(existing.rows[0], input)
          ) fail('state-conflict');
        }
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });

    try {
      await new PostgresMigrator({
        connectionString: this.#connectionString,
      }).apply(input.signal);
    } catch (error: unknown) {
      if (error instanceof CoordinationError) throw error;
      if (input.signal.aborted) fail('cancelled');
      fail('dependency-failed');
    }
    assertActive(input.signal);
    return Object.freeze({ authorityVolumeId: input.authorityVolumeId });
  }

  async importProject(input: Readonly<{
    readonly operationId: string;
    readonly project: EnvironmentRestorePersistenceProject;
    readonly records: readonly CollabProjectBackupRecord[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void> {
    assertActive(input.signal);
    const records = canonicalRecords(input.records);
    const projectRecord = exactRecord(records, 'project');
    const sourcePlacement = exactRecord(records, 'repository-placement');
    const schemaCatalog = exactRecord(records, 'schema-catalog');
    const authorityPair = exactRecord(records, 'authority-volume-pair');
    const serverCompatibility = exactRecord(records, 'server-compatibility');
    if (
      !validIdentity(input.operationId)
      || !isCollabOpaqueId(input.project.backupId)
      || input.project.projectId !== projectRecord.value.projectId
      || input.project.authorityGeneration
        !== projectRecord.value.authorityGeneration
      || sourcePlacement.value.projectId !== input.project.projectId
      || sourcePlacement.value.placementGeneration
        !== input.project.placementGeneration
      || schemaCatalog.value.projectId !== input.project.projectId
      || schemaCatalog.value.coordinationSchemaVersion
        !== CURRENT_POSTGRES_SCHEMA_VERSION
      || authorityPair.value.projectId !== input.project.projectId
      || authorityPair.value.restoreEpoch + 1 !== input.restoreEpoch
    ) fail('state-conflict');
    const supportedKinds = new Set<CollabProjectBackupRecord['kind']>([
      'authority-volume-pair',
      'authority-transfer-recovery',
      'cloud-event',
      'cloud-event-cursor',
      'idempotency-result',
      'leave-former-principal-replay',
      'lifecycle-journal',
      'member',
      'principal-binding',
      'project',
      'protected-claim-envelope',
      'request',
      'request-comment',
      'repository-placement',
      'schema-catalog',
      'server-compatibility',
      'terminal-principal',
      'terminal-responder',
      'terminal-responder-replay',
      'ticket',
      'ticket-comment',
      'ticket-mention',
      'ticket-relation',
      'tombstone',
      'transfer-claim-batch-receipt',
      'transfer-redemption-receipt',
      'transfer-receipt-key',
      'transferred-membership-claim',
    ]);
    if (records.some(record => !supportedKinds.has(record.kind))) {
      fail('state-conflict');
    }

    const assertImportedRecords = async (
      client: Client,
      fence: RestoreFenceRow,
    ): Promise<void> => {
      await client.query(
        `INSERT INTO claudian_cloud.repository_placements (
           project_id, storage_node_id, repository_storage_key, generation,
           active, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, true, $5, $5)`,
        [
          input.project.projectId,
          sourcePlacement.value.nodeId,
          sourcePlacement.value.repositoryIdentity,
          sourcePlacement.value.placementGeneration,
          projectRecord.value.createdAt,
        ],
      );
      const checkpoint = new PostgresProjectCheckpointPersistence(
        input.project.projectId,
        async <Row extends QueryResultRow>(
          sql: string,
          values: readonly unknown[],
        ): Promise<readonly Row[]> => (
          (await client.query<Row>(sql, [...values])).rows
        ),
      );
      const restored = await checkpoint.readProjectCheckpointRecords({
        excludedOperationId: input.project.backupId,
        maximumCoordinationBytes: MAXIMUM_RESTORE_COORDINATION_BYTES,
        metadata: Object.freeze({
          authorityId: authorityPair.value.authorityId,
          authorityVolumeIdentity: fence.authority_volume_identity,
          coordinationSchemaVersion:
            schemaCatalog.value.coordinationSchemaVersion,
          maximumServerBuild: serverCompatibility.value.maximumBuild,
          minimumServerBuild: serverCompatibility.value.minimumBuild,
          repositoryFormatVersion:
            schemaCatalog.value.repositoryFormatVersion,
          restoreEpoch: input.restoreEpoch,
        }),
        profile: 'backup',
        snapshotAt: exactRecord(records, 'cloud-event-cursor').value.updatedAt,
      });
      const expected = canonicalRecords(records.map(record => (
        record.kind === 'authority-volume-pair'
          ? Object.freeze({
              ...record,
              value: Object.freeze({
                ...record.value,
                authorityVolumeIdentity:
                  fence.authority_volume_identity,
                restoreEpoch: input.restoreEpoch,
              }),
            })
          : record
      )));
      if (JSON.stringify(restored) !== JSON.stringify(expected)) {
        fail('state-conflict');
      }
      const removedPlacement = await client.query(
        `DELETE FROM claudian_cloud.repository_placements
          WHERE project_id = $1`,
        [input.project.projectId],
      );
      if (removedPlacement.rowCount !== 1) fail('state-conflict');
    };

    await this.#withClient(input.signal, async client => {
      await client.query('BEGIN');
      try {
        const fence = await this.#lockExactFence(client, {
          operationId: input.operationId,
          projectId: input.project.projectId,
          restoreEpoch: input.restoreEpoch,
        }, input.signal);
        if (
          fence.state !== 'staged'
          || fence.authority_id !== authorityPair.value.authorityId
          || fence.coordination_schema_version
            !== schemaCatalog.value.coordinationSchemaVersion
        ) fail('state-conflict');
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [input.project.projectId],
        );
        const existingProject = await client.query(
          `SELECT project_id
             FROM claudian_cloud.projects
            WHERE project_id = $1`,
          [input.project.projectId],
        );
        if (existingProject.rows.length === 1) {
          await assertImportedRecords(client, fence);
          await client.query('COMMIT');
          return;
        }
        if (existingProject.rows.length !== 0) fail('state-conflict');
        await client.query(
          `INSERT INTO claudian_cloud.projects (
             project_id, project_name, manager_set_generation,
             expected_main_oid, service_state, created_at, activated_at,
             authority_generation, authority_state_revision
           ) VALUES ($1, $2, $3, $4, 'maintenance', $5, $6, $7, $8)
           ON CONFLICT (project_id) DO NOTHING`,
          [
            projectRecord.value.projectId,
            projectRecord.value.name,
            projectRecord.value.managerSetGeneration,
            projectRecord.value.expectedMainOid,
            projectRecord.value.createdAt,
            projectRecord.value.activatedAt,
            projectRecord.value.authorityGeneration,
            projectRecord.revision,
          ],
        );
        for (const record of records) {
          if (record.kind !== 'terminal-responder') continue;
          const operationKind = record.value.operation === 'retireProject'
            ? 'retire'
            : 'authority-transfer';
          const replay = records.find(candidate => (
            candidate.kind === 'terminal-responder-replay'
            && candidate.value.operationId === record.value.operationId
          ));
          await client.query(
            `INSERT INTO claudian_cloud.project_terminal_responders (
               project_id, operation_kind, operation_id, response_sha256,
               response_json, expires_at, created_at, updated_at,
               replay_member_id, replay_request_sha256
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9)
             ON CONFLICT (project_id, operation_kind, operation_id) DO NOTHING`,
            [
              record.value.projectId,
              operationKind,
              record.value.operationId,
              createHash('sha256').update(record.value.responseJson).digest('hex'),
              record.value.responseJson,
              record.value.expiresAt,
              projectRecord.value.createdAt,
              replay?.kind === 'terminal-responder-replay'
                ? replay.value.memberId
                : null,
              replay?.kind === 'terminal-responder-replay'
                ? replay.value.requestSha256
                : null,
            ],
          );
          await client.query(
            `INSERT INTO claudian_cloud.project_terminal_responder_catalog (
               project_id, operation_kind, operation_id, expires_at, created_at
             ) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (project_id, operation_kind, operation_id) DO NOTHING`,
            [
              record.value.projectId,
              operationKind,
              record.value.operationId,
              record.value.expiresAt,
              projectRecord.value.createdAt,
            ],
          );
        }
        for (const record of records) {
          if (record.kind === 'member') {
            await client.query(
              `INSERT INTO claudian_cloud.project_memberships (
                 project_id, member_id, display_name, role, status, revision,
                 created_at, updated_at, activated_at, revoked_at, left_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (project_id, member_id) DO NOTHING`,
              [
                record.value.projectId,
                record.value.memberId,
                record.value.displayName,
                record.value.role,
                record.value.status,
                record.revision,
                record.value.createdAt,
                record.value.updatedAt,
                record.value.activatedAt,
                record.value.status === 'revoked'
                  ? record.value.revokedAt
                  : null,
                record.value.status === 'left'
                  ? record.value.revokedAt
                  : null,
              ],
            );
          } else if (record.kind === 'request') {
            await client.query(
              `INSERT INTO claudian_cloud.change_requests (
                 project_id, request_id, member_id, status, first_base_oid,
                 latest_head_oid, merged_oid, description, revision,
                 created_at, updated_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (project_id, request_id) DO NOTHING`,
              [
                record.value.projectId,
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
          } else if (record.kind === 'request-comment') {
            await client.query(
              `INSERT INTO claudian_cloud.request_comments (
                 project_id, comment_id, request_id, author_member_id, body,
                 created_at
               ) VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (project_id, comment_id) DO NOTHING`,
              [
                record.value.projectId,
                record.value.commentId,
                record.value.requestId,
                record.value.authorMemberId,
                record.value.body,
                record.value.createdAt,
              ],
            );
          } else if (record.kind === 'ticket') {
            const commentCount = records.filter(candidate => (
              candidate.kind === 'ticket-comment'
              && candidate.value.ticketId === record.value.ticketId
            )).length;
            await client.query(
              `INSERT INTO claudian_cloud.tickets (
                 project_id, ticket_id, ticket_number, title, body, status,
                 author_member_id, revision, comment_count, created_at,
                 updated_at, closed_at, closed_by_member_id
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
               )
               ON CONFLICT (project_id, ticket_id) DO NOTHING`,
              [
                record.value.projectId,
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
          } else if (record.kind === 'ticket-comment') {
            await client.query(
              `INSERT INTO claudian_cloud.ticket_comments (
                 project_id, comment_id, ticket_id, author_member_id, body,
                 created_at
               ) VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (project_id, comment_id) DO NOTHING`,
              [
                record.value.projectId,
                record.value.commentId,
                record.value.ticketId,
                record.value.authorMemberId,
                record.value.body,
                record.value.createdAt,
              ],
            );
          } else if (record.kind === 'ticket-relation') {
            await client.query(
              `INSERT INTO claudian_cloud.request_ticket_relations (
                 project_id, relation_id, request_id, ticket_id, commit_oid,
                 kind, state, created_by_member_id, created_at, updated_at,
                 accepted_at, accepted_merge_oid
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
               )
               ON CONFLICT (project_id, relation_id) DO NOTHING`,
              [
                record.value.projectId,
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
          } else if (record.kind === 'ticket-mention') {
            await client.query(
              `INSERT INTO claudian_cloud.ticket_mentions (
                 project_id, ticket_id, mentioned_member_id, source_kind,
                 source_id, created_at
               ) VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (
                 project_id, ticket_id, source_kind, source_id,
                 mentioned_member_id
               ) DO NOTHING`,
              [
                record.value.projectId,
                record.value.ticketId,
                record.value.mentionedMemberId,
                record.value.sourceKind,
                record.value.sourceId,
                record.value.createdAt,
              ],
            );
          } else if (record.kind === 'cloud-event') {
            await client.query(
              `INSERT INTO claudian_cloud.project_events (
                 project_id, sequence, kind, payload, occurred_at
               ) VALUES ($1, $2, $3, $4::jsonb, $5)
               ON CONFLICT (project_id, sequence) DO NOTHING`,
              [
                record.value.event.projectId,
                record.value.event.sequence,
                record.value.event.kind,
                JSON.stringify(record.value.event.payload),
                record.value.event.occurredAt,
              ],
            );
          } else if (
            record.kind === 'cloud-event-cursor'
            && record.value.currentSequence > 0
          ) {
            await client.query(
              `INSERT INTO claudian_cloud.project_event_sequences (
                 project_id, current_sequence, updated_at
               ) VALUES ($1, $2, $3)
               ON CONFLICT (project_id) DO NOTHING`,
              [
                record.value.projectId,
                record.value.currentSequence,
                record.value.updatedAt,
              ],
            );
          } else if (record.kind === 'idempotency-result') {
            await client.query(
              `INSERT INTO claudian_cloud.idempotency_results (
                 project_id, member_id, operation, idempotency_key,
                 request_fingerprint, response_json, created_at
               ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
               ON CONFLICT (
                 project_id, member_id, operation, idempotency_key
               ) DO NOTHING`,
              [
                record.value.projectId,
                record.value.memberId,
                record.value.operation,
                record.value.idempotencyKey,
                record.value.requestFingerprint,
                record.value.responseJson,
                record.value.createdAt,
              ],
            );
          } else if (record.kind === 'principal-binding') {
            await client.query(
              `INSERT INTO claudian_cloud.project_principal_bindings (
                 project_id, principal_id, member_id, state, bound_at,
                 revoked_at
               ) VALUES ($1, $2, $3, 'active', $4, NULL)
               ON CONFLICT (project_id, principal_id) DO NOTHING`,
              [
                record.value.projectId,
                record.value.principalId,
                record.value.memberId,
                record.value.boundAt,
              ],
            );
          } else if (record.kind === 'lifecycle-journal') {
            await client.query(
              `INSERT INTO claudian_cloud.project_lifecycle_journals (
                 project_id, operation_id, kind, direction, phase,
                 recovery_from_phase, state, expected_authority_generation,
                 actor_member_id, idempotency_key, request_fingerprint,
                 checkpoint_sha256, batch_revision, batch_sha256,
                 result_sha256, scheduled_at, created_at, updated_at,
                 expected_personal_ref_oid
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18, $19
               )
               ON CONFLICT (project_id, operation_id) DO NOTHING`,
              [
                record.value.projectId,
                record.value.operationId,
                record.value.operationKind,
                record.value.direction,
                record.value.phase,
                record.value.recoveryFromPhase,
                record.value.state,
                record.value.expectedAuthorityGeneration,
                record.value.actorMemberId,
                record.value.idempotencyKey,
                record.value.requestFingerprint,
                record.value.checkpointSha256,
                record.value.batchRevision,
                record.value.batchSha256,
                record.value.resultSha256,
                record.value.scheduledAt,
                record.value.createdAt,
                record.value.updatedAt,
                record.value.expectedPersonalRefOid,
              ],
            );
            if (
              record.value.state === 'active'
              || record.value.state === 'recovery-required'
            ) {
              await client.query(
                `INSERT INTO claudian_cloud.recovery_candidates (
                   kind, project_id, operation_id, scheduled_at, created_at
                 ) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (kind, project_id) DO NOTHING`,
                [
                  record.value.operationKind,
                  record.value.projectId,
                  record.value.operationId,
                  record.value.scheduledAt,
                  record.value.createdAt,
                ],
              );
            }
          } else if (record.kind === 'authority-transfer-recovery') {
            await client.query(
              `INSERT INTO claudian_cloud.authority_transfer_recovery (
                 project_id, transfer_id, source_authority_kind,
                 source_authority_generation, target_authority_kind,
                 target_authority_generation, source_host_member_id,
                 target_host_member_id, target_url, expires_at, source_proof,
                 target_proof, stage_sha256, target_activation_proof,
                 relinquishment_proof_json, created_at, updated_at,
                 cancellation_request_sha256, source_reopen_sha256,
                 inactive_publication_json,
                 target_activation_request_sha256
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18, $19, $20, $21
               )
               ON CONFLICT (project_id, transfer_id) DO NOTHING`,
              [
                record.value.projectId,
                record.value.transferId,
                record.value.sourceAuthority.kind,
                record.value.sourceAuthority.generation,
                record.value.targetAuthority.kind,
                record.value.targetAuthority.generation,
                record.value.sourceHostMemberId,
                record.value.targetHostMemberId,
                record.value.targetUrl,
                record.value.expiresAt,
                record.value.sourceEvidence === null
                  ? null
                  : JSON.stringify(record.value.sourceEvidence),
                record.value.targetEvidence === null
                  ? null
                  : JSON.stringify(record.value.targetEvidence),
                record.value.stageSha256,
                record.value.targetActivationProof,
                record.value.relinquishmentProof === null
                  ? null
                  : JSON.stringify(record.value.relinquishmentProof),
                record.value.createdAt,
                record.value.updatedAt,
                record.value.cancellationRequestSha256,
                record.value.sourceReopenSha256,
                record.value.inactivePublication === null
                  ? null
                  : JSON.stringify(record.value.inactivePublication),
                record.value.targetActivationRequestSha256,
              ],
            );
          } else if (record.kind === 'transferred-membership-claim') {
            await client.query(
              `INSERT INTO claudian_cloud.transferred_membership_claims (
                 project_id, transfer_id, member_id, batch_revision,
                 checkpoint_sha256, claim_sha256, state,
                 target_principal_id, operation_intent_id,
                 redemption_receipt_id, expires_at, created_at, updated_at
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
               )
               ON CONFLICT (
                 project_id, transfer_id, batch_revision, member_id
               ) DO NOTHING`,
              [
                record.value.projectId,
                record.value.transferId,
                record.value.memberId,
                record.value.batchRevision,
                record.value.checkpointSha256,
                record.value.claimSha256,
                record.value.state,
                record.value.targetPrincipalId,
                record.value.operationIntentId,
                record.value.redemptionReceiptId,
                record.value.expiresAt,
                record.value.createdAt,
                record.value.updatedAt,
              ],
            );
          } else if (record.kind === 'transfer-receipt-key') {
            await client.query(
              `INSERT INTO claudian_cloud.transfer_receipt_keys (
                 project_id, transfer_id, receipt_key_id,
                 signature_algorithm, public_key, created_at
               ) VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (
                 project_id, transfer_id, receipt_key_id
               ) DO NOTHING`,
              [
                record.value.projectId,
                record.value.transferId,
                record.value.receiptKeyId,
                record.value.signatureAlgorithm,
                record.value.receiptPublicKey,
                record.value.createdAt,
              ],
            );
          } else if (record.kind === 'transfer-claim-batch-receipt') {
            const receipt = record.value.receipt;
            await client.query(
              `INSERT INTO claudian_cloud.transfer_claim_batch_receipts (
                 project_id, transfer_id, batch_revision, batch_sha256,
                 checkpoint_sha256, operation_intent_id,
                 submitted_by_member_id, custody_authority_kind,
                 custody_authority_generation, receipt_id, receipt_json,
                 committed_at
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
               )
               ON CONFLICT (project_id, transfer_id) DO NOTHING`,
              [
                receipt.projectId,
                receipt.transferId,
                receipt.batchRevision,
                receipt.batchSha256,
                receipt.checkpointSha256,
                receipt.operationIntentId,
                receipt.submittedByMemberId,
                receipt.custodyAuthority.kind,
                receipt.custodyAuthority.generation,
                receipt.receiptId,
                JSON.stringify(receipt),
                receipt.committedAt,
              ],
            );
          } else if (record.kind === 'transfer-redemption-receipt') {
            const receipt = record.value.receipt;
            await client.query(
              `INSERT INTO claudian_cloud.transfer_redemption_receipts (
                 project_id, transfer_id, member_id, receipt_id,
                 claim_sha256, operation_intent_id, receipt_key_id,
                 receipt_json, redeemed_at, acknowledged_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (project_id, transfer_id, member_id) DO NOTHING`,
              [
                record.value.projectId,
                receipt.transferId,
                receipt.memberId,
                receipt.receiptId,
                receipt.claimSha256,
                receipt.operationIntentId,
                receipt.receiptKeyId,
                JSON.stringify(receipt),
                receipt.redeemedAt,
                record.value.acknowledgedAt,
              ],
            );
          } else if (record.kind === 'terminal-principal') {
            await client.query(
              `INSERT INTO claudian_cloud.project_terminal_acknowledgements (
                 project_id, operation_kind, operation_id, principal_id,
                 member_id, acknowledged_at
               ) VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (
                 project_id, operation_kind, operation_id, member_id
               ) DO NOTHING`,
              [
                record.value.projectId,
                record.value.operationKind,
                record.value.operationId,
                record.value.principalId,
                record.value.memberId,
                record.value.acknowledgedAt,
              ],
            );
          } else if (record.kind === 'leave-former-principal-replay') {
            await client.query(
              `INSERT INTO claudian_cloud.leave_former_principal_replays (
                 project_id, operation_id, principal_sha256, member_id,
                 intent_id, request_fingerprint, state, result_sha256,
                 created_at, completed_at, expires_at,
                 expected_personal_ref_oid
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
               )
               ON CONFLICT (project_id, operation_id) DO NOTHING`,
              [
                record.value.projectId,
                record.value.operationId,
                record.value.principalSha256,
                record.value.memberId,
                record.value.intentId,
                record.value.requestFingerprint,
                record.value.state,
                record.value.resultSha256,
                record.value.createdAt,
                record.value.completedAt,
                record.value.expiresAt,
                record.value.expectedPersonalRefOid,
              ],
            );
          } else if (record.kind === 'protected-claim-envelope') {
            const associatedData = record.value.associatedData;
            await client.query(
              `INSERT INTO claudian_cloud.source_protected_claim_envelopes (
                 project_id, transfer_id, member_id, claim_sha256,
                 checkpoint_sha256, environment_identity,
                 authority_generation, envelope_version,
                 encryption_algorithm, key_id, key_version, receipt_key_id,
                 associated_data_sha256, nonce, ciphertext, tag, expires_at,
                 created_at
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18
               )
               ON CONFLICT (project_id, transfer_id, member_id) DO NOTHING`,
              [
                associatedData.projectId,
                record.value.transferId,
                record.value.memberId,
                associatedData.claimSha256,
                associatedData.checkpointSha256,
                associatedData.environmentIdentity,
                associatedData.authorityGeneration,
                associatedData.envelopeVersion,
                record.value.encryptionAlgorithm,
                record.value.keyId,
                record.value.keyVersion,
                record.value.receiptKeyId,
                record.value.associatedDataSha256,
                record.value.nonce,
                record.value.ciphertext,
                record.value.tag,
                record.value.expiresAt,
                projectRecord.value.createdAt,
              ],
            );
          } else if (record.kind === 'tombstone') {
            const transferTerminal = records.find(candidate => (
              candidate.kind === 'terminal-responder'
              && candidate.value.operation === 'getProjectAuthorityTransfer'
            ));
            const retireTerminal = records.find(candidate => (
              candidate.kind === 'terminal-responder'
              && candidate.value.operation === 'retireProject'
            ));
            const terminal = transferTerminal ?? retireTerminal;
            let association: Readonly<{
              operationId: string;
              operationKind: 'authority-transfer' | 'retire';
              resultSha256: string;
            }>;
            if (terminal?.kind === 'terminal-responder') {
              association = Object.freeze({
                operationId: terminal.value.operationId,
                operationKind: terminal.value.operation === 'retireProject'
                  ? 'retire'
                  : 'authority-transfer',
                resultSha256: createHash('sha256')
                  .update(terminal.value.responseJson)
                  .digest('hex'),
              });
            } else {
              const lifecycleCandidates: Array<Readonly<{
                operationId: string;
                operationKind: 'authority-transfer' | 'retire';
                resultSha256: string;
              }>> = [];
              for (const candidate of records) {
                if (
                  candidate.kind !== 'lifecycle-journal'
                  || candidate.value.state !== 'completed'
                  || candidate.value.resultSha256 === null
                  || candidate.value.updatedAt !== record.value.retiredAt
                ) continue;
                if (
                  candidate.value.operationKind === 'retire'
                  && candidate.value.expectedAuthorityGeneration
                    === record.value.authorityGeneration
                ) {
                  lifecycleCandidates.push(Object.freeze({
                    operationId: candidate.value.operationId,
                    operationKind: 'retire',
                    resultSha256: candidate.value.resultSha256,
                  }));
                } else if (
                  candidate.value.operationKind === 'authority-transfer'
                ) {
                  const recovery = records.find(recoveryCandidate => (
                    recoveryCandidate.kind === 'authority-transfer-recovery'
                    && recoveryCandidate.value.transferId
                      === candidate.value.operationId
                  ));
                  if (
                    recovery?.kind === 'authority-transfer-recovery'
                    && recovery.value.targetAuthority.generation
                      === record.value.authorityGeneration
                  ) {
                    lifecycleCandidates.push(Object.freeze({
                      operationId: candidate.value.operationId,
                      operationKind: 'authority-transfer',
                      resultSha256: candidate.value.resultSha256,
                    }));
                  }
                }
              }
              const lifecycleAssociation = lifecycleCandidates.length === 1
                ? lifecycleCandidates[0]
                : undefined;
              if (lifecycleAssociation === undefined) fail('state-conflict');
              association = lifecycleAssociation;
            }
            await client.query(
              `INSERT INTO claudian_cloud.project_tombstones (
                 project_id, authority_generation, terminal_operation_kind,
                 terminal_operation_id, result_sha256, retired_at,
                 terminal_expires_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (project_id) DO NOTHING`,
              [
                record.value.projectId,
                record.value.authorityGeneration,
                association.operationKind,
                association.operationId,
                association.resultSha256,
                record.value.retiredAt,
                record.value.terminalExpiresAt,
              ],
            );
          }
        }
        await assertImportedRecords(client, fence);
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async publishAuthority(input: Readonly<{
    readonly catalog: EnvironmentRestorePersistenceCatalog;
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestorePersistenceRepository[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void> {
    assertActive(input.signal);
    if (
      input.repositories.length !== input.catalog.projects.length
      || new Set(input.repositories.map(repository => repository.projectId)).size
        !== input.repositories.length
    ) fail('state-conflict');
    await this.#withClient(input.signal, async client => {
      await client.query('BEGIN');
      try {
        const fence = await this.#lockExactFence(client, {
          authorityId: input.catalog.authorityId,
          coordinationSchemaVersion: input.catalog.coordinationSchemaVersion,
          operationId: input.operationId,
          restoreEpoch: input.restoreEpoch,
        }, input.signal);
        for (const project of input.catalog.projects) {
          const repository = input.repositories.find(candidate => (
            candidate.projectId === project.projectId
          ));
          if (
            repository === undefined
            || repository.operationId !== input.operationId
            || repository.placementGeneration
              !== project.placementGeneration + 1
          ) fail('state-conflict');
          await client.query(
            "SELECT set_config('claudian_cloud.project_id', $1, true)",
            [project.projectId],
          );
          await client.query(
            `INSERT INTO claudian_cloud.repository_placements (
               project_id, storage_node_id, repository_storage_key,
               generation, active, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, true, $5, $5)
             ON CONFLICT (project_id) DO NOTHING`,
            [
              project.projectId,
              repository.storageNodeId,
              repository.repositoryStorageKey,
              repository.placementGeneration,
              input.catalog.createdAt,
            ],
          );
          const placement = await client.query<{
            readonly active: boolean;
            readonly generation: string;
            readonly repository_storage_key: string;
            readonly storage_node_id: string;
          }>(
            `SELECT active, generation, repository_storage_key, storage_node_id
               FROM claudian_cloud.repository_placements
              WHERE project_id = $1`,
            [project.projectId],
          );
          const exact = placement.rows[0];
          if (
            placement.rows.length !== 1
            || exact?.active !== true
            || Number(exact.generation) !== repository.placementGeneration
            || exact.repository_storage_key !== repository.repositoryStorageKey
            || exact.storage_node_id !== repository.storageNodeId
          ) fail('state-conflict');
          await client.query(
            `INSERT INTO claudian_cloud.active_repository_placement_catalog (
               project_id, storage_node_id, repository_storage_key, generation
             ) VALUES ($1, $2, $3, $4)
             ON CONFLICT (project_id) DO NOTHING`,
            [
              project.projectId,
              repository.storageNodeId,
              repository.repositoryStorageKey,
              repository.placementGeneration,
            ],
          );
          const catalogPlacement = await client.query<{
            readonly generation: string;
            readonly repository_storage_key: string;
            readonly storage_node_id: string;
          }>(
            `SELECT generation, repository_storage_key, storage_node_id
               FROM claudian_cloud.active_repository_placement_catalog
              WHERE project_id = $1`,
            [project.projectId],
          );
          const exactCatalog = catalogPlacement.rows[0];
          if (
            catalogPlacement.rows.length !== 1
            || Number(exactCatalog?.generation)
              !== repository.placementGeneration
            || exactCatalog?.repository_storage_key
              !== repository.repositoryStorageKey
            || exactCatalog.storage_node_id !== repository.storageNodeId
          ) fail('state-conflict');
          const published = await client.query(
            `UPDATE claudian_cloud.projects
                SET service_state = 'active'
              WHERE project_id = $1
                AND service_state IN ('maintenance', 'active')
                AND authority_generation = $2
              RETURNING project_id`,
            [project.projectId, project.authorityGeneration],
          );
          if (published.rowCount !== 1) fail('state-conflict');
        }
        if (fence.state === 'staged') {
          const advanced = await client.query(
            `UPDATE claudian_cloud_restore.database_fence
                SET state = 'published'
              WHERE singleton = true AND state = 'staged'`,
          );
          if (advanced.rowCount !== 1) fail('state-conflict');
        }
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async verifyRestoredProject(input: Readonly<{
    readonly operationId: string;
    readonly project: EnvironmentRestorePersistenceProject;
    readonly records: readonly CollabProjectBackupRecord[];
    readonly repository: EnvironmentRestorePersistenceRepository;
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void> {
    assertActive(input.signal);
    const source = canonicalRecords(input.records);
    const schemaCatalog = exactRecord(source, 'schema-catalog');
    const serverCompatibility = exactRecord(source, 'server-compatibility');
    const authorityPair = exactRecord(source, 'authority-volume-pair');
    const sourcePlacement = exactRecord(source, 'repository-placement');
    const fence = await this.#readExactPublishedFence({
      authorityId: authorityPair.value.authorityId,
      coordinationSchemaVersion: schemaCatalog.value.coordinationSchemaVersion,
      operationId: input.operationId,
      restoreEpoch: input.restoreEpoch,
      signal: input.signal,
    });
    const restored = await this.#readProjectBackup({
      excludedOperationId: input.project.backupId,
      maximumServerBuild: serverCompatibility.value.maximumBuild,
      minimumServerBuild: serverCompatibility.value.minimumBuild,
      projectId: input.project.projectId,
      repositoryFormatVersion: schemaCatalog.value.repositoryFormatVersion,
      signal: input.signal,
      snapshotAt: exactRecord(source, 'cloud-event-cursor').value.updatedAt,
    });
    const expected = canonicalRecords(source.map(record => {
      if (record.kind === 'repository-placement') return Object.freeze({
        ...sourcePlacement,
        revision: input.repository.placementGeneration,
        value: Object.freeze({
          nodeId: input.repository.storageNodeId,
          placementGeneration: input.repository.placementGeneration,
          projectId: input.project.projectId,
          repositoryIdentity: input.repository.repositoryStorageKey,
        }),
      });
      if (record.kind === 'authority-volume-pair') return Object.freeze({
        ...authorityPair,
        value: Object.freeze({
          ...authorityPair.value,
          authorityVolumeIdentity: fence.authority_volume_identity,
          restoreEpoch: input.restoreEpoch,
        }),
      });
      return record;
    }));
    if (JSON.stringify(restored) !== JSON.stringify(expected)) {
      fail('state-conflict');
    }
  }

  async readRestoredContinuity(
    project: EnvironmentRestorePersistenceProject,
    signal: AbortSignal,
  ): Promise<readonly CollabProjectBackupRecord[]> {
    const records = await this.#readProjectBackup({
      excludedOperationId: project.backupId,
      maximumServerBuild: 'restore-continuity',
      minimumServerBuild: 'restore-continuity',
      projectId: project.projectId,
      repositoryFormatVersion: 1,
      signal,
      snapshotAt: new Date(0).toISOString(),
    });
    return Object.freeze(records.filter(record => CONTINUITY_KINDS.has(record.kind)));
  }

  async classifyOrRemoveRestoreOwnedDatabase(input: Readonly<{
    readonly authorityVolumeId: string;
    readonly operationId: string;
    readonly signal: AbortSignal;
  }>): Promise<'authority-published' | 'removed' | 'replayed'> {
    assertActive(input.signal);
    if (
      !validIdentity(input.authorityVolumeId)
      || !validIdentity(input.operationId)
    ) fail('state-conflict');
    return this.#withClient(input.signal, async client => {
      await client.query('BEGIN');
      try {
        await client.query(
          'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
          [RESTORE_LOCK_NAMESPACE, RESTORE_LOCK_KEY],
        );
        assertActive(input.signal);
        if (await databaseIdentity(client) !== input.authorityVolumeId) {
          fail('state-conflict');
        }
        const state = await schemaState(client);
        if (
          state.canonical_schema === null
          && state.restore_schema === null
        ) {
          await client.query('COMMIT');
          return 'replayed';
        }
        if (state.fence_relation === null) fail('state-conflict');
        const existing = await client.query<RestoreFenceRow>(
          `SELECT operation_id, authority_id, authority_volume_id,
                  authority_volume_identity, coordination_schema_version,
                  restore_epoch, state
             FROM claudian_cloud_restore.database_fence
            FOR UPDATE`,
        );
        const fence = existing.rows[0];
        if (
          existing.rows.length !== 1
          || fence?.operation_id !== input.operationId
          || fence.authority_volume_id !== input.authorityVolumeId
        ) fail('state-conflict');
        if (fence.state === 'published') {
          await client.query('COMMIT');
          return 'authority-published';
        }
        if (state.canonical_schema !== null) {
          await client.query('DROP SCHEMA claudian_cloud CASCADE');
        }
        await client.query('DROP SCHEMA claudian_cloud_restore CASCADE');
        await client.query('COMMIT');
        return 'removed';
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async verifyDatabaseIdentity(
    expectedAuthorityVolumeId: string,
    signal: AbortSignal,
  ): Promise<void> {
    assertActive(signal);
    if (!validIdentity(expectedAuthorityVolumeId)) fail('state-conflict');
    await this.#withClient(signal, async client => {
      if (await databaseIdentity(client) !== expectedAuthorityVolumeId) {
        fail('state-conflict');
      }
    });
  }

  async #lockExactFence(
    client: Client,
    expected: Readonly<{
      readonly authorityId?: string;
      readonly authorityVolumeIdentity?: string;
      readonly coordinationSchemaVersion?: number;
      readonly operationId: string;
      readonly projectId?: CollabProjectId;
      readonly restoreEpoch: number;
    }>,
    signal: AbortSignal,
  ): Promise<RestoreFenceRow> {
    void expected.projectId;
    await client.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [RESTORE_LOCK_NAMESPACE, RESTORE_LOCK_KEY],
    );
    assertActive(signal);
    const state = await schemaState(client);
    if (
      state.canonical_schema === null
      || state.fence_relation === null
    ) fail('state-conflict');
    const result = await client.query<RestoreFenceRow>(
      `SELECT operation_id, authority_id, authority_volume_id,
              authority_volume_identity, coordination_schema_version,
              restore_epoch, state
         FROM claudian_cloud_restore.database_fence
        FOR UPDATE`,
    );
    const fence = result.rows[0];
    if (
      result.rows.length !== 1
      || fence === undefined
      || fence.operation_id !== expected.operationId
      || Number(fence.restore_epoch) !== expected.restoreEpoch
      || (
        expected.authorityId !== undefined
        && fence.authority_id !== expected.authorityId
      )
      || (
        expected.authorityVolumeIdentity !== undefined
        && fence.authority_volume_identity
          !== expected.authorityVolumeIdentity
      )
      || (
        expected.coordinationSchemaVersion !== undefined
        && fence.coordination_schema_version
          !== expected.coordinationSchemaVersion
      )
      || await databaseIdentity(client) !== fence.authority_volume_id
    ) fail('state-conflict');
    return fence;
  }

  async #readExactPublishedFence(input: Readonly<{
    readonly authorityId: string;
    readonly coordinationSchemaVersion: number;
    readonly operationId: string;
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<RestoreFenceRow> {
    return this.#withClient(input.signal, async client => {
      const state = await schemaState(client);
      if (
        state.canonical_schema === null
        || state.fence_relation === null
      ) fail('state-conflict');
      const result = await client.query<RestoreFenceRow>(
        `SELECT operation_id, authority_id, authority_volume_id,
                authority_volume_identity, coordination_schema_version,
                restore_epoch, state
           FROM claudian_cloud_restore.database_fence`,
      );
      const fence = result.rows[0];
      if (
        result.rows.length !== 1
        || fence === undefined
        || fence.state !== 'published'
        || fence.operation_id !== input.operationId
        || fence.authority_id !== input.authorityId
        || fence.coordination_schema_version
          !== input.coordinationSchemaVersion
        || Number(fence.restore_epoch) !== input.restoreEpoch
        || await databaseIdentity(client) !== fence.authority_volume_id
      ) fail('state-conflict');
      return fence;
    });
  }

  async #readProjectBackup(input: Readonly<{
    readonly excludedOperationId: string;
    readonly maximumServerBuild: string;
    readonly minimumServerBuild: string;
    readonly projectId: CollabProjectId;
    readonly repositoryFormatVersion: number;
    readonly signal: AbortSignal;
    readonly snapshotAt: string;
  }>): Promise<readonly CollabProjectBackupRecord[]> {
    return this.#withClient(input.signal, async client => {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [input.projectId],
        );
        const fenceResult = await client.query<RestoreFenceRow>(
          `SELECT operation_id, authority_id, authority_volume_id,
                  authority_volume_identity, coordination_schema_version,
                  restore_epoch, state
             FROM claudian_cloud_restore.database_fence`,
        );
        const fence = fenceResult.rows[0];
        if (fenceResult.rows.length !== 1 || fence === undefined) {
          fail('state-conflict');
        }
        const checkpoint = new PostgresProjectCheckpointPersistence(
          input.projectId,
          async <Row extends QueryResultRow>(
            sql: string,
            values: readonly unknown[],
          ): Promise<readonly Row[]> => (
            (await client.query<Row>(sql, [...values])).rows
          ),
        );
        const records = await checkpoint.readProjectCheckpointRecords({
          excludedOperationId: input.excludedOperationId,
          maximumCoordinationBytes: MAXIMUM_RESTORE_COORDINATION_BYTES,
          metadata: Object.freeze({
            authorityId: fence.authority_id,
            authorityVolumeIdentity: fence.authority_volume_identity,
            coordinationSchemaVersion: fence.coordination_schema_version,
            maximumServerBuild: input.maximumServerBuild,
            minimumServerBuild: input.minimumServerBuild,
            repositoryFormatVersion: input.repositoryFormatVersion,
            restoreEpoch: Number(fence.restore_epoch),
          }),
          profile: 'backup',
          snapshotAt: input.snapshotAt,
        });
        await client.query('COMMIT');
        return records as readonly CollabProjectBackupRecord[];
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async #withClient<Result>(
    signal: AbortSignal,
    operation: (client: Client) => Promise<Result>,
  ): Promise<Result> {
    assertActive(signal);
    const client = new Client({
      application_name: 'claudian-cloud-environment-restore',
      connectionString: this.#connectionString,
      connectionTimeoutMillis: RESTORE_DEPENDENCY_TIMEOUT_MS,
      idle_in_transaction_session_timeout: RESTORE_DEPENDENCY_TIMEOUT_MS,
      lock_timeout: RESTORE_DEPENDENCY_TIMEOUT_MS,
      query_timeout: RESTORE_DEPENDENCY_TIMEOUT_MS,
      statement_timeout: RESTORE_DEPENDENCY_TIMEOUT_MS,
    });
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= client.end().catch(() => undefined);
      return closePromise;
    };
    const onAbort = (): void => { void close(); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      await client.connect();
      assertActive(signal);
      await verifyRole(client);
      const result = await operation(client);
      assertActive(signal);
      return result;
    } catch (error: unknown) {
      if (error instanceof CoordinationError) throw error;
      if (signal.aborted) return fail('cancelled');
      return fail('dependency-failed');
    } finally {
      signal.removeEventListener('abort', onAbort);
      await close();
    }
  }
}
