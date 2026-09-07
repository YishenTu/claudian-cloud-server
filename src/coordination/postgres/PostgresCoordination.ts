import {
  COLLAB_LIMITS,
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_PROTOCOL_VERSION,
  decodeCollabCloudProjectEventMessage,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabMemberId,
  type CollabCloudProjectEvent,
  type CollabProjectId,
} from '@claudian-collab/protocol';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import {
  type DevelopmentBootstrapAttemptLocator,
  type ExpiredDevelopmentBootstrapAttempt,
  type ExpiredDevelopmentBootstrapAttemptCatalog,
  type ExpiredDevelopmentBootstrapAttemptCursor,
  type ExpiredDevelopmentBootstrapAttemptPage,
  type ListExpiredDevelopmentBootstrapAttemptsOptions,
  type ListRecoveryCandidatesOptions,
  type RecoveryCandidate,
  type RecoveryCandidateCatalog,
  type RecoveryCandidateCursor,
  type RecoveryCandidateKind,
  type RecoveryCandidatePage,
} from '../DevelopmentBootstrapPersistence.js';
import {
  type AdvanceProjectAuthorityStateInput,
  type IsolateProjectRecoveryInput,
  type ProjectRecord,
  type ProjectServiceState,
} from '../ProjectPersistence.js';
import type {
  ListTerminalRespondersOptions,
  TerminalResponderCatalog,
  TerminalResponderCatalogCursor,
  TerminalResponderCatalogEntry,
  TerminalResponderCatalogPage,
} from '../PortabilityLifecyclePersistence.js';
import type {
  AppendProjectEvent,
  ProjectEventReplayFacts,
  PruneProjectEventsOptions,
  ReadProjectEventsOptions,
} from '../ProjectEventPersistence.js';
import type {
  AcquireProjectLeaseOptions,
  ActiveRepositoryPlacementPage,
  DevelopmentBootstrapUploadLease,
  ListActiveRepositoryPlacementsOptions,
  PinnedProjectLease,
  ProjectMembershipRecord,
  ProjectReadScope,
  ProjectScope,
  ProjectSnapshotMembershipRecord,
  TerminalProjectContinuityCatalog,
  TerminalProjectContinuityPage,
} from '../ProjectCoordination.js';
import type {
  CloudProjectCreationLease,
  CloudProjectCreationPersistence,
} from '../CloudProjectCreationPersistence.js';
export type {
  AcquireProjectLeaseOptions,
  ActiveRepositoryPlacementPage,
  DevelopmentBootstrapUploadLease,
  ListActiveRepositoryPlacementsOptions,
  PinnedProjectLease,
  ProjectMembershipRecord,
  ProjectReadScope,
  ProjectScope,
  ProjectSnapshotMembershipRecord,
  TerminalProjectContinuityCatalog,
  TerminalProjectContinuityPage,
} from '../ProjectCoordination.js';
import {
  assertRepositoryPlacementLease,
  createRepositoryPlacementLease,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from '../../repositories/RepositoryPlacement.js';
import { CoordinationError } from '../CoordinationError.js';
import {
  developmentBootstrapUploadLockKey,
  projectLockKey,
} from '../ProjectLockKey.js';
import { PostgresDevelopmentBootstrapPersistence } from './PostgresDevelopmentBootstrapPersistence.js';
import { PostgresAcceptPersistence } from './PostgresAcceptPersistence.js';
import { PostgresCollaborationPersistence } from './PostgresCollaborationPersistence.js';
import { PostgresPortabilityLifecyclePersistence } from './PostgresPortabilityLifecyclePersistence.js';
import { PostgresProjectCheckpointPersistence } from './PostgresProjectCheckpointPersistence.js';
import { PostgresCloudProjectCreationPersistence } from './PostgresCloudProjectCreationPersistence.js';
import { PostgresProjectMembershipPersistence } from './PostgresProjectMembershipPersistence.js';
import {
  CURRENT_POSTGRES_SCHEMA,
  isCurrentPostgresSchema,
  type PostgresSchemaMetadata,
} from './PostgresSchema.js';

export interface PostgresCoordinationOptions {
  readonly onProjectEventCommitted?: (projectId: CollabProjectId) => void;
  readonly ordinaryPoolMax: number;
  readonly pinnedPoolMax: number;
  readonly projectLockTimeoutMs: number;
  readonly reservedPoolMax: number;
  readonly runtimeConnectionString: string;
  readonly shutdownTimeoutMs: number;
}

interface MembershipRow {
  readonly activated_at?: Date;
  readonly created_at?: Date;
  readonly display_name: string;
  readonly member_id: string;
  readonly revision: string;
  readonly role: string;
  readonly status: string;
  readonly updated_at?: Date;
}

interface PlacementRow {
  readonly active: boolean;
  readonly generation: string;
  readonly project_id: string;
  readonly repository_storage_key: string;
  readonly storage_node_id: string;
}

interface ProjectRow {
  readonly activated_at: Date;
  readonly authority_generation: string;
  readonly authority_state_revision: string;
  readonly created_at: Date;
  readonly expected_main_oid: string;
  readonly manager_set_generation: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly service_state: string;
}

interface ProjectEventRow {
  readonly kind: string;
  readonly occurred_at: Date;
  readonly payload: unknown;
  readonly project_id: string;
  readonly sequence: string;
}

interface ProjectEventSequenceRow {
  readonly current_sequence: string;
  readonly retained_from_sequence: string;
}

interface RecoveryCandidateRow {
  readonly kind: string;
  readonly operation_id: string;
  readonly project_id: string;
  readonly scheduled_at: Date;
}

interface TerminalResponderCatalogRow {
  readonly expires_at: Date;
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly project_id: string;
}

interface BootstrapAttemptRouteRow {
  readonly project_id: string | null;
}

interface ExpiredBootstrapAttemptRow {
  readonly attempt_id: string;
  readonly expires_at: Date;
  readonly project_id: string;
}

type MarkBroken = () => void;

const LOCK_RETRY_INTERVAL_MS = 5;
const RUNTIME_ROLE = 'claudian_cloud_runtime';
const AUTHORITY_VOLUME_ID_PATTERN = /^[0-9a-f]{32}$/u;
const RECOVERY_CANDIDATE_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const RECOVERY_CANDIDATE_KINDS: ReadonlySet<RecoveryCandidateKind> = new Set([
  'accept',
  'activation',
  'authority-transfer',
  'backup',
  'create-project',
  'delete',
  'export',
  'join-project',
  'leave',
  'remove-member',
  'retire',
]);
const PROJECT_SERVICE_STATES: ReadonlySet<ProjectServiceState> = new Set([
  'active',
  'deleted',
  'deleting',
  'maintenance',
  'read-only-transition',
  'recovery-required',
]);

function dependencyFailure(): CoordinationError {
  return new CoordinationError('dependency-failed');
}

function safeSequence(value: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw dependencyFailure();
  }
  return sequence;
}

function projectEvent(row: ProjectEventRow): CollabCloudProjectEvent {
  const sequence = safeSequence(row.sequence);
  if (
    sequence < 1
    || !isCollabProjectId(row.project_id)
    || !(row.occurred_at instanceof Date)
    || Number.isNaN(row.occurred_at.valueOf())
  ) {
    throw dependencyFailure();
  }
  try {
    const decoded = decodeCollabCloudProjectEventMessage({
      kind: row.kind,
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload,
      projectId: row.project_id,
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sequence,
    });
    if (decoded.kind === 'snapshot.required') throw dependencyFailure();
    return decoded;
  } catch {
    throw dependencyFailure();
  }
}

function handleIdlePoolError(_error: Error): void {
  // pg removes the failed idle client; the next operation reconnects or fails safely.
}

function validateRecoveryCursor(cursor: RecoveryCandidateCursor): void {
  if (
    !RECOVERY_CANDIDATE_KIND_PATTERN.test(cursor.kind)
    || !isCollabProjectId(cursor.projectId)
    || !isCollabOpaqueId(cursor.operationId)
    || Number.isNaN(Date.parse(cursor.scheduledAt))
    || new Date(cursor.scheduledAt).toISOString() !== cursor.scheduledAt
  ) {
    throw new CoordinationError('invalid-record');
  }
}

function recoveryCandidate(row: RecoveryCandidateRow): RecoveryCandidate {
  if (
    !RECOVERY_CANDIDATE_KIND_PATTERN.test(row.kind)
    || !isCollabProjectId(row.project_id)
    || !isCollabOpaqueId(row.operation_id)
    || !(row.scheduled_at instanceof Date)
    || Number.isNaN(row.scheduled_at.valueOf())
  ) {
    throw dependencyFailure();
  }
  const identity = {
    operationId: row.operation_id,
    projectId: row.project_id,
    scheduledAt: row.scheduled_at.toISOString(),
  } as const;
  if (RECOVERY_CANDIDATE_KINDS.has(row.kind as RecoveryCandidateKind)) {
    return Object.freeze({
      ...identity,
      kind: row.kind as RecoveryCandidateKind,
    });
  }
  return Object.freeze({
    ...identity,
    kind: 'unknown',
    unrecognizedKind: row.kind,
  });
}

function recoveryCursor(row: RecoveryCandidateRow): RecoveryCandidateCursor {
  if (
    !RECOVERY_CANDIDATE_KIND_PATTERN.test(row.kind)
    || !isCollabProjectId(row.project_id)
    || !isCollabOpaqueId(row.operation_id)
    || !(row.scheduled_at instanceof Date)
    || Number.isNaN(row.scheduled_at.valueOf())
  ) {
    throw dependencyFailure();
  }
  return Object.freeze({
    kind: row.kind,
    operationId: row.operation_id,
    projectId: row.project_id,
    scheduledAt: row.scheduled_at.toISOString(),
  });
}

function validateTerminalResponderCursor(
  cursor: TerminalResponderCatalogCursor,
): void {
  const operationKind: string = cursor.operationKind;
  if (
    !isCollabProjectId(cursor.projectId)
    || !isCollabOpaqueId(cursor.operationId)
    || (operationKind !== 'authority-transfer' && operationKind !== 'retire')
    || Number.isNaN(Date.parse(cursor.expiresAt))
    || new Date(cursor.expiresAt).toISOString() !== cursor.expiresAt
  ) throw new CoordinationError('invalid-record');
}

function terminalResponderCatalogEntry(
  row: TerminalResponderCatalogRow,
): TerminalResponderCatalogEntry {
  if (
    !isCollabProjectId(row.project_id)
    || !isCollabOpaqueId(row.operation_id)
    || (row.operation_kind !== 'authority-transfer' && row.operation_kind !== 'retire')
    || !(row.expires_at instanceof Date)
    || Number.isNaN(row.expires_at.valueOf())
  ) throw dependencyFailure();
  return Object.freeze({
    expiresAt: row.expires_at.toISOString(),
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    projectId: row.project_id,
  });
}

function validateIsoTimestamp(value: string): void {
  if (
    Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new CoordinationError('invalid-record');
  }
}

function validateExpiredAttemptCursor(
  cursor: ExpiredDevelopmentBootstrapAttemptCursor,
): void {
  validateIsoTimestamp(cursor.expiresAt);
  if (
    !isCollabProjectId(cursor.projectId)
    || !isCollabOpaqueId(cursor.attemptId)
  ) {
    throw new CoordinationError('invalid-record');
  }
}

function expiredAttempt(
  row: ExpiredBootstrapAttemptRow,
): ExpiredDevelopmentBootstrapAttempt {
  if (
    !isCollabProjectId(row.project_id)
    || !isCollabOpaqueId(row.attempt_id)
    || !(row.expires_at instanceof Date)
    || Number.isNaN(row.expires_at.valueOf())
  ) {
    throw dependencyFailure();
  }
  return Object.freeze({
    attemptId: row.attempt_id,
    expiresAt: row.expires_at.toISOString(),
    projectId: row.project_id,
  });
}

class CheckedOutPoolClient {
  readonly client: PoolClient;
  readonly #onRelease: () => void;
  #broken = false;
  #released = false;

  constructor(client: PoolClient, onRelease: () => void) {
    this.client = client;
    this.#onRelease = onRelease;
    this.client.on('error', this.#handleClientError);
  }

  isBroken(): boolean {
    return this.#broken;
  }

  release(destroy = false): void {
    if (this.#released) return;
    this.#released = true;
    this.#onRelease();
    const shouldDestroy = destroy || this.#broken;
    if (shouldDestroy) this.client.connection.stream.destroy();
    try {
      this.client.release(shouldDestroy);
    } finally {
      this.client.removeListener('error', this.#handleClientError);
    }
  }

  readonly markBroken = (): void => {
    this.#broken = true;
  };

  readonly #handleClientError = (_error: Error): void => {
    this.#broken = true;
  };
}

class CheckedOutPoolClients {
  readonly #clients = new Set<CheckedOutPoolClient>();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  adopt(client: PoolClient): CheckedOutPoolClient {
    const checkedOut = new CheckedOutPoolClient(client, () => {
      this.#clients.delete(checkedOut);
    });
    if (this.#closed) {
      try {
        checkedOut.release(true);
      } catch {
        // The closed owner cannot return this client to a pool.
      }
      throw new CoordinationError('closed');
    }
    this.#clients.add(checkedOut);
    return checkedOut;
  }

  close(): boolean {
    if (this.#closed) return true;
    this.#closed = true;
    let succeeded = true;
    for (const client of [...this.#clients]) {
      try {
        client.release(true);
      } catch {
        succeeded = false;
      }
    }
    return succeeded;
  }
}

function ensureProjectId(projectId: CollabProjectId): bigint {
  return projectLockKey(projectId);
}

async function safeQuery<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: readonly unknown[],
  markBroken: MarkBroken,
): Promise<readonly Row[]> {
  try {
    const result = await client.query<Row>(text, [...values]);
    return result.rows;
  } catch {
    markBroken();
    throw dependencyFailure();
  }
}

async function delayUntilRetry(
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) throw new CoordinationError('cancelled');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CoordinationError('busy');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => {
      finish(() => reject(new CoordinationError('cancelled')));
    };
    const timer = setTimeout(
      () => finish(resolve),
      Math.min(LOCK_RETRY_INTERVAL_MS, remaining),
    );
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

async function acquireAdvisoryLock(
  client: PoolClient,
  lockKey: bigint,
  transactionScoped: boolean,
  deadline: number,
  signal: AbortSignal | undefined,
  markBroken: MarkBroken,
): Promise<void> {
  const functionName = transactionScoped
    ? 'pg_try_advisory_xact_lock'
    : 'pg_try_advisory_lock';
  for (;;) {
    if (signal?.aborted === true) throw new CoordinationError('cancelled');
    const rows = await safeQuery<{ readonly acquired: boolean }>(
      client,
      `SELECT ${functionName}($1::bigint) AS acquired`,
      [lockKey.toString()],
      markBroken,
    );
    if (rows[0]?.acquired === true) return;
    await delayUntilRetry(deadline, signal);
  }
}

async function checkout(
  pool: Pool,
  deadline: number,
  signal: AbortSignal | undefined,
  checkedOutClients: CheckedOutPoolClients,
): Promise<CheckedOutPoolClient> {
  if (signal?.aborted === true) throw new CoordinationError('cancelled');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CoordinationError('busy');

  return new Promise<CheckedOutPoolClient>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => {
      finish(() => reject(new CoordinationError('cancelled')));
    };
    const timer = setTimeout(
      () => finish(() => reject(new CoordinationError('busy'))),
      remaining,
    );
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });

    void pool.connect().then(
      client => {
        let checkedOut: CheckedOutPoolClient;
        try {
          checkedOut = checkedOutClients.adopt(client);
        } catch (error: unknown) {
          finish(() => reject(
            error instanceof Error ? error : dependencyFailure(),
          ));
          return;
        }
        if (settled) {
          try {
            checkedOut.release();
          } catch {
            // The original timeout or cancellation remains authoritative.
          }
          return;
        }
        finish(() => resolve(checkedOut));
      },
      () => finish(() => reject(
        checkedOutClients.closed
          ? new CoordinationError('closed')
          : dependencyFailure(),
      )),
    );
    if (signal?.aborted === true) onAbort();
  });
}

class PostgresProjectScope
  extends PostgresDevelopmentBootstrapPersistence
  implements ProjectScope {
  readonly accept: PostgresAcceptPersistence;
  readonly collaboration: PostgresCollaborationPersistence;
  readonly portability: PostgresPortabilityLifecyclePersistence;
  readonly checkpoint: PostgresProjectCheckpointPersistence;
  readonly membership: PostgresProjectMembershipPersistence;
  readonly #client: PoolClient;
  readonly #markBroken: MarkBroken;
  readonly #projectId: CollabProjectId;
  #projectEventAppended = false;

  constructor(
    client: PoolClient,
    projectId: CollabProjectId,
    markBroken: MarkBroken,
  ) {
    const query = <Row extends QueryResultRow>(
      text: string,
      values: readonly unknown[],
    ): Promise<readonly Row[]> => safeQuery<Row>(client, text, values, markBroken);
    super(
      projectId,
      query,
    );
    this.collaboration = new PostgresCollaborationPersistence(
      projectId,
      query,
    );
    this.accept = new PostgresAcceptPersistence({
      appendProjectEvent: event => this.appendProjectEvent(event),
      collaboration: this.collaboration,
      projectId,
      query,
    });
    this.portability = new PostgresPortabilityLifecyclePersistence(
      projectId,
      query,
    );
    this.checkpoint = new PostgresProjectCheckpointPersistence(
      projectId,
      query,
    );
    this.membership = new PostgresProjectMembershipPersistence(projectId, query);
    this.#client = client;
    this.#projectId = projectId;
    this.#markBroken = markBroken;
  }

  async appendProjectEvent(
    event: AppendProjectEvent,
  ): Promise<CollabCloudProjectEvent> {
    this.assertActive();
    validateIsoTimestamp(event.occurredAt);
    let validated: CollabCloudProjectEvent;
    try {
      const decoded = decodeCollabCloudProjectEventMessage({
        ...event,
        projectId: this.#projectId,
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        sequence: 1,
      });
      if (decoded.kind === 'snapshot.required') {
        throw new CoordinationError('invalid-record');
      }
      validated = decoded;
    } catch (error: unknown) {
      if (error instanceof CoordinationError) throw error;
      throw new CoordinationError('invalid-record');
    }
    const sequences = await safeQuery<{ readonly current_sequence: string }>(
      this.#client,
      `INSERT INTO claudian_cloud.project_event_sequences (
         project_id, current_sequence, updated_at
       ) VALUES ($1, 1, $2::timestamptz)
       ON CONFLICT (project_id) DO UPDATE
         SET current_sequence =
               claudian_cloud.project_event_sequences.current_sequence + 1,
             updated_at = EXCLUDED.updated_at
         WHERE claudian_cloud.project_event_sequences.current_sequence
               < 9007199254740991
       RETURNING current_sequence`,
      [this.#projectId, validated.occurredAt],
      this.#markBroken,
    );
    const sequence = sequences[0] === undefined
      ? undefined
      : safeSequence(sequences[0].current_sequence);
    if (sequence === undefined || sequence < 1) {
      throw new CoordinationError('state-conflict');
    }
    const rows = await safeQuery<ProjectEventRow>(
      this.#client,
      `INSERT INTO claudian_cloud.project_events (
         project_id, sequence, kind, payload, occurred_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
       RETURNING project_id, sequence, kind, payload, occurred_at`,
      [
        this.#projectId,
        sequence,
        validated.kind,
        JSON.stringify(validated.payload),
        validated.occurredAt,
      ],
      this.#markBroken,
    );
    const row = rows[0];
    if (row === undefined) throw dependencyFailure();
    await this.pruneProjectEvents({ now: validated.occurredAt });
    this.#projectEventAppended = true;
    return projectEvent(row);
  }

  didAppendProjectEvent(): boolean {
    return this.#projectEventAppended;
  }

  async getProjectEventSequence(): Promise<number> {
    this.assertActive();
    const rows = await safeQuery<{ readonly current_sequence: string }>(
      this.#client,
      `SELECT current_sequence
         FROM claudian_cloud.project_event_sequences
        WHERE project_id = $1`,
      [this.#projectId],
      this.#markBroken,
    );
    return rows[0] === undefined ? 0 : safeSequence(rows[0].current_sequence);
  }

  async pruneProjectEvents(options: PruneProjectEventsOptions): Promise<number> {
    this.assertActive();
    validateIsoTimestamp(options.now);
    const rows = await safeQuery<{ readonly sequence: string }>(
      this.#client,
      `DELETE FROM claudian_cloud.project_events AS event
        USING claudian_cloud.project_event_sequences AS counter
        WHERE event.project_id = $1
          AND counter.project_id = event.project_id
          AND event.sequence <= counter.current_sequence - $2
          AND event.occurred_at < $3::timestamptz - ($4 * interval '1 day')
       RETURNING event.sequence`,
      [
        this.#projectId,
        COLLAB_CLOUD_BINDING_LIMITS.minRetainedEventCount,
        options.now,
        COLLAB_CLOUD_BINDING_LIMITS.minEventRetentionDays,
      ],
      this.#markBroken,
    );
    return rows.length;
  }

  async readProjectEvents(
    options: ReadProjectEventsOptions,
  ): Promise<ProjectEventReplayFacts> {
    this.assertActive();
    if (
      !Number.isSafeInteger(options.afterSequence)
      || options.afterSequence < 0
      || !Number.isSafeInteger(options.limit)
      || options.limit < 1
      || options.limit > COLLAB_CLOUD_BINDING_LIMITS.maxEventReplay
    ) {
      throw new CoordinationError('invalid-record');
    }
    const facts = await safeQuery<ProjectEventSequenceRow>(
      this.#client,
      `SELECT counter.current_sequence,
              COALESCE((
                SELECT event.sequence
                  FROM claudian_cloud.project_events AS event
                 WHERE event.project_id = counter.project_id
                 ORDER BY event.sequence
                 LIMIT 1
              ), counter.current_sequence + 1)
                AS retained_from_sequence
         FROM claudian_cloud.project_event_sequences AS counter
        WHERE counter.project_id = $1`,
      [this.#projectId],
      this.#markBroken,
    );
    const fact = facts[0];
    const latestSequence = fact === undefined
      ? 0
      : safeSequence(fact.current_sequence);
    const retainedFromSequence = fact === undefined
      ? 1
      : safeSequence(fact.retained_from_sequence);
    const rows = await safeQuery<ProjectEventRow>(
      this.#client,
      `SELECT project_id, sequence, kind, payload, occurred_at
         FROM claudian_cloud.project_events
        WHERE project_id = $1 AND sequence > $2
        ORDER BY sequence
        LIMIT $3`,
      [this.#projectId, options.afterSequence, options.limit],
      this.#markBroken,
    );
    return Object.freeze({
      events: Object.freeze(rows.map(projectEvent)),
      latestSequence,
      retainedFromSequence,
    });
  }

  async findMembership(
    memberId: CollabMemberId,
  ): Promise<ProjectMembershipRecord | undefined> {
    this.assertActive();
    if (!isCollabMemberId(memberId)) {
      throw new CoordinationError('invalid-member');
    }
    const rows = await safeQuery<MembershipRow>(
      this.#client,
      `SELECT display_name, member_id, role, status, revision
         FROM claudian_cloud.project_memberships
        WHERE project_id = $1 AND member_id = $2`,
      [this.#projectId, memberId],
      this.#markBroken,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (
      !isCollabMemberId(row.member_id)
      || row.display_name.length === 0
      || row.display_name.length > COLLAB_LIMITS.maxMemberDisplayNameUtf16
      || (row.role !== 'manager' && row.role !== 'member')
      || !['active', 'left', 'pending', 'revoked'].includes(row.status)
    ) {
      throw dependencyFailure();
    }
    return Object.freeze({
      displayName: row.display_name,
      memberId: row.member_id,
      revision: BigInt(row.revision),
      role: row.role,
      status: row.status as ProjectMembershipRecord['status'],
    });
  }

  async listMemberships(): Promise<readonly ProjectMembershipRecord[]> {
    this.assertActive();
    const rows = await safeQuery<MembershipRow>(
      this.#client,
      `SELECT display_name, member_id, role, status, revision
         FROM claudian_cloud.project_memberships
        WHERE project_id = $1
        ORDER BY member_id`,
      [this.#projectId],
      this.#markBroken,
    );
    return Object.freeze(rows.map(row => {
      const revision = BigInt(row.revision);
      if (
        !isCollabMemberId(row.member_id)
        || row.display_name.length === 0
        || row.display_name.length > COLLAB_LIMITS.maxMemberDisplayNameUtf16
        || (row.role !== 'manager' && row.role !== 'member')
        || !['active', 'left', 'pending', 'revoked'].includes(row.status)
        || revision < 0n
      ) {
        throw dependencyFailure();
      }
      return Object.freeze({
        displayName: row.display_name,
        memberId: row.member_id,
        revision,
        role: row.role,
        status: row.status as ProjectMembershipRecord['status'],
      });
    }));
  }

  async listActiveSnapshotMemberships(): Promise<
    readonly ProjectSnapshotMembershipRecord[]
  > {
    this.assertActive();
    const rows = await safeQuery<MembershipRow>(
      this.#client,
      `SELECT display_name, member_id, role, status, revision,
              created_at, updated_at, activated_at
         FROM claudian_cloud.project_memberships
        WHERE project_id = $1 AND status = 'active'
        ORDER BY member_id
        LIMIT $2`,
      [
        this.#projectId,
        COLLAB_CLOUD_BINDING_LIMITS.maxCloudProjectMembers + 1,
      ],
      this.#markBroken,
    );
    return Object.freeze(rows.map(row => {
      const revision = BigInt(row.revision);
      if (
        !isCollabMemberId(row.member_id)
        || row.display_name.length === 0
        || row.display_name.length > COLLAB_LIMITS.maxMemberDisplayNameUtf16
        || (row.role !== 'manager' && row.role !== 'member')
        || row.status !== 'active'
        || revision < 0n
        || !(row.created_at instanceof Date)
        || Number.isNaN(row.created_at.valueOf())
        || !(row.updated_at instanceof Date)
        || Number.isNaN(row.updated_at.valueOf())
        || !(row.activated_at instanceof Date)
        || Number.isNaN(row.activated_at.valueOf())
        || row.updated_at < row.created_at
        || row.activated_at < row.created_at
      ) {
        throw dependencyFailure();
      }
      return Object.freeze({
        activatedAt: row.activated_at.toISOString(),
        createdAt: row.created_at.toISOString(),
        displayName: row.display_name,
        memberId: row.member_id,
        revision,
        role: row.role,
        status: 'active' as const,
      });
    }));
  }

  async findDevelopmentActorMember(
    actorId: string,
  ): Promise<CollabMemberId | undefined> {
    this.assertActive();
    if (!isCollabMemberId(actorId)) {
      throw new CoordinationError('invalid-member');
    }
    const rows = await safeQuery<{ readonly member_id: string }>(
      this.#client,
      `SELECT member_id
         FROM claudian_cloud.development_actor_mappings
        WHERE project_id = $1 AND actor_id = $2`,
      [this.#projectId, actorId],
      this.#markBroken,
    );
    const memberId = rows[0]?.member_id;
    if (memberId === undefined) return undefined;
    if (!isCollabMemberId(memberId)) throw dependencyFailure();
    return memberId;
  }

  async findPrincipalMember(
    requestedPrincipalId: string,
  ): Promise<CollabMemberId | undefined> {
    this.assertActive();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestedPrincipalId)) {
      throw new CoordinationError('invalid-record');
    }
    const rows = await safeQuery<{ readonly member_id: string }>(
      this.#client,
      `SELECT member_id
         FROM claudian_cloud.project_principal_bindings
        WHERE project_id = $1 AND principal_id = $2 AND state = 'active'`,
      [this.#projectId, requestedPrincipalId],
      this.#markBroken,
    );
    const boundMemberId = rows[0]?.member_id;
    if (boundMemberId === undefined) return undefined;
    if (!isCollabMemberId(boundMemberId)) throw dependencyFailure();
    return boundMemberId;
  }

  async getProject(): Promise<ProjectRecord | undefined> {
    this.assertActive();
    const rows = await safeQuery<ProjectRow>(
      this.#client,
      `SELECT project_id,
              project_name,
              authority_generation,
              authority_state_revision,
              manager_set_generation,
              expected_main_oid,
              service_state,
              created_at,
              activated_at
         FROM claudian_cloud.projects
        WHERE project_id = $1`,
      [this.#projectId],
      this.#markBroken,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const managerSetGeneration = Number(row.manager_set_generation);
    const authorityGeneration = Number(row.authority_generation);
    const authorityStateRevision = Number(row.authority_state_revision);
    if (
      row.project_id !== this.#projectId
      || row.project_name.length === 0
      || !Number.isSafeInteger(managerSetGeneration)
      || managerSetGeneration < 0
      || !Number.isSafeInteger(authorityGeneration)
      || authorityGeneration < 1
      || !Number.isSafeInteger(authorityStateRevision)
      || authorityStateRevision < 1
      || !isCollabGitOid(row.expected_main_oid)
      || !PROJECT_SERVICE_STATES.has(row.service_state as ProjectServiceState)
      || !(row.created_at instanceof Date)
      || Number.isNaN(row.created_at.valueOf())
      || !(row.activated_at instanceof Date)
      || Number.isNaN(row.activated_at.valueOf())
    ) {
      throw dependencyFailure();
    }
    return Object.freeze({
      activatedAt: row.activated_at.toISOString(),
      authorityGeneration,
      authorityStateRevision,
      createdAt: row.created_at.toISOString(),
      expectedMainOid: row.expected_main_oid,
      managerSetGeneration,
      projectId: row.project_id,
      projectName: row.project_name,
      serviceState: row.service_state as ProjectRecord['serviceState'],
    });
  }

  async advanceProjectAuthorityState(
    input: AdvanceProjectAuthorityStateInput,
  ): Promise<'advanced' | 'replayed'> {
    this.assertActive();
    if (
      !Number.isSafeInteger(input.expectedAuthorityGeneration)
      || input.expectedAuthorityGeneration < 1
      || !Number.isSafeInteger(input.expectedAuthorityStateRevision)
      || input.expectedAuthorityStateRevision < 1
      || !Number.isSafeInteger(input.nextAuthorityGeneration)
      || (
        input.nextAuthorityGeneration !== input.expectedAuthorityGeneration
        && input.nextAuthorityGeneration !== input.expectedAuthorityGeneration + 1
      )
      || !PROJECT_SERVICE_STATES.has(input.expectedServiceState)
      || !PROJECT_SERVICE_STATES.has(input.nextServiceState)
      || (
        input.expectedAuthorityGeneration === input.nextAuthorityGeneration
        && input.expectedServiceState === input.nextServiceState
      )
    ) {
      throw new CoordinationError('invalid-record');
    }
    const rows = await safeQuery<{ readonly project_id: string }>(
      this.#client,
      `UPDATE claudian_cloud.projects
          SET authority_generation = $5,
              authority_state_revision = authority_state_revision + 1,
              service_state = $6
        WHERE project_id = $1
          AND authority_generation = $2
          AND service_state = $3
          AND authority_state_revision = $4
       RETURNING project_id`,
      [
        this.#projectId,
        input.expectedAuthorityGeneration,
        input.expectedServiceState,
        input.expectedAuthorityStateRevision,
        input.nextAuthorityGeneration,
        input.nextServiceState,
      ],
      this.#markBroken,
    );
    const project = await this.getProject();
    if (
      project?.authorityGeneration !== input.nextAuthorityGeneration
      || project.serviceState !== input.nextServiceState
      || project.authorityStateRevision !== input.expectedAuthorityStateRevision + 1
    ) {
      throw new CoordinationError('state-conflict');
    }
    if (
      input.nextServiceState === 'deleting'
      || input.nextServiceState === 'deleted'
    ) {
      await safeQuery(
        this.#client,
        `DELETE FROM claudian_cloud.active_repository_placement_catalog
          WHERE project_id = $1`,
        [this.#projectId],
        this.#markBroken,
      );
    }
    return rows.length === 1 ? 'advanced' : 'replayed';
  }

  async isolateProjectRecovery(
    input: IsolateProjectRecoveryInput,
  ): Promise<'advanced' | 'replayed' | 'stale'> {
    this.assertActive();
    const candidate = input.expectedRecoveryCandidate;
    validateRecoveryCursor(candidate);
    if (candidate.projectId !== this.#projectId) {
      throw new CoordinationError('invalid-record');
    }
    const candidateRows = await safeQuery<{ readonly operation_id: string }>(
      this.#client,
      `SELECT operation_id
         FROM claudian_cloud.recovery_candidates
        WHERE kind = $1
          AND project_id = $2
          AND operation_id = $3
          AND scheduled_at = $4
        FOR UPDATE`,
      [
        candidate.kind,
        this.#projectId,
        candidate.operationId,
        candidate.scheduledAt,
      ],
      this.#markBroken,
    );
    if (candidateRows.length === 0) return 'stale';
    if (candidateRows.length !== 1) throw new CoordinationError('state-conflict');

    const current = await this.getProject();
    if (current === undefined || current.serviceState === 'deleted') {
      throw new CoordinationError('state-conflict');
    }
    let result: 'advanced' | 'replayed';
    let expectedRevision = current.authorityStateRevision;
    if (current.serviceState === 'recovery-required') {
      result = 'replayed';
    } else {
      const rows = await safeQuery<{ readonly project_id: string }>(
        this.#client,
        `UPDATE claudian_cloud.projects
            SET authority_state_revision = authority_state_revision + 1,
                service_state = 'recovery-required'
          WHERE project_id = $1
            AND authority_generation = $2
            AND authority_state_revision = $3
            AND service_state = $4
         RETURNING project_id`,
        [
          this.#projectId,
          current.authorityGeneration,
          current.authorityStateRevision,
          current.serviceState,
        ],
        this.#markBroken,
      );
      if (rows.length !== 1) throw new CoordinationError('state-conflict');
      expectedRevision += 1;
      result = 'advanced';
    }
    await safeQuery(
      this.#client,
      `DELETE FROM claudian_cloud.active_repository_placement_catalog
        WHERE project_id = $1`,
      [this.#projectId],
      this.#markBroken,
    );
    const project = await this.getProject();
    const activeCatalogRows = await safeQuery<{ readonly project_id: string }>(
      this.#client,
      `SELECT project_id
         FROM claudian_cloud.active_repository_placement_catalog
        WHERE project_id = $1`,
      [this.#projectId],
      this.#markBroken,
    );
    if (
      project?.authorityGeneration !== current.authorityGeneration
      || project.authorityStateRevision !== expectedRevision
      || project.serviceState !== 'recovery-required'
      || activeCatalogRows.length !== 0
    ) {
      throw new CoordinationError('state-conflict');
    }
    return result;
  }

  async getRepositoryPlacement(): Promise<RepositoryPlacementLease | undefined> {
    this.assertActive();
    const rows = await safeQuery<PlacementRow>(
      this.#client,
      `SELECT project_id,
              storage_node_id,
              repository_storage_key,
              generation,
              active
         FROM claudian_cloud.repository_placements
        WHERE project_id = $1 AND active`,
      [this.#projectId],
      this.#markBroken,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const generation = Number(row.generation);
    return createRepositoryPlacementLease({
      active: row.active,
      generation,
      projectId: row.project_id,
      repositoryStorageKey: row.repository_storage_key,
      storageNodeId: row.storage_node_id,
    });
  }

}

async function rollback(
  client: PoolClient,
  markBroken: MarkBroken,
): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    markBroken();
  }
}

async function runProjectTransaction<T>(
  client: PoolClient,
  projectId: CollabProjectId,
  operation: (scope: ProjectScope) => Promise<T>,
  options: {
    readonly deadline: number;
    readonly lockKey: bigint | undefined;
    readonly markBroken: MarkBroken;
    readonly onProjectEventCommitted: ((projectId: CollabProjectId) => void)
      | undefined;
    readonly readOnlySnapshot?: boolean;
    readonly signal: AbortSignal | undefined;
  },
): Promise<T> {
  let transactionStarted = false;
  try {
    await safeQuery(
      client,
      options.readOnlySnapshot === true
        ? 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN',
      [],
      options.markBroken,
    );
    transactionStarted = true;
    if (options.lockKey !== undefined) {
      await acquireAdvisoryLock(
        client,
        options.lockKey,
        true,
        options.deadline,
        options.signal,
        options.markBroken,
      );
    }
    await safeQuery(
      client,
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [projectId],
      options.markBroken,
    );
    const scope = new PostgresProjectScope(client, projectId, options.markBroken);
    let value: T;
    let projectEventAppended = false;
    try {
      value = await operation(scope);
      projectEventAppended = scope.didAppendProjectEvent();
    } finally {
      scope.deactivate();
    }
    await safeQuery(client, 'COMMIT', [], options.markBroken);
    transactionStarted = false;
    if (projectEventAppended) {
      try {
        options.onProjectEventCommitted?.(projectId);
      } catch {
        // The committed transaction remains authoritative if notification fails.
      }
    }
    return value;
  } catch (error: unknown) {
    if (transactionStarted) await rollback(client, options.markBroken);
    if (options.signal?.aborted) throw new CoordinationError('cancelled');
    throw error;
  }
}

async function runCloudProjectCreationTransaction<T>(
  client: PoolClient,
  projectId: CollabProjectId,
  operation: (persistence: CloudProjectCreationPersistence) => Promise<T>,
  markBroken: MarkBroken,
): Promise<T> {
  let transactionStarted = false;
  try {
    await safeQuery(client, 'BEGIN', [], markBroken);
    transactionStarted = true;
    await safeQuery(
      client,
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [projectId],
      markBroken,
    );
    const persistence = new PostgresCloudProjectCreationPersistence(
      <Row extends QueryResultRow>(text: string, values: readonly unknown[]) => (
        safeQuery<Row>(client, text, values, markBroken)
      ),
      projectId,
    );
    const value = await operation(persistence);
    await safeQuery(client, 'COMMIT', [], markBroken);
    transactionStarted = false;
    return value;
  } catch (error: unknown) {
    if (transactionStarted) await rollback(client, markBroken);
    throw error;
  }
}

function projectReadScope(scope: PostgresProjectScope): ProjectReadScope {
  const accept = Object.freeze({
    get: operationId => scope.accept.get(operationId),
    getNonterminal: () => scope.accept.getNonterminal(),
  } satisfies ProjectReadScope['accept']);
  type CollaborationRead = ProjectReadScope['collaboration'];
  const idempotency: CollaborationRead['idempotency'] = {
    find: input => scope.collaboration.idempotency.find(input),
  };
  const requests: CollaborationRead['requests'] = {
    find: requestId => scope.collaboration.requests.find(requestId),
    findOpenByMember: memberId => (
      scope.collaboration.requests.findOpenByMember(memberId)
    ),
    listComments: (requestId, options) => (
      scope.collaboration.requests.listComments(requestId, options)
    ),
  };
  const snapshot: CollaborationRead['snapshot'] = {
    read: () => scope.collaboration.snapshot.read(),
  };
  const tickets: CollaborationRead['tickets'] = {
    find: ticketId => scope.collaboration.tickets.find(ticketId),
    findByNumber: ticketNumber => (
      scope.collaboration.tickets.findByNumber(ticketNumber)
    ),
    findByNumbers: ticketNumbers => (
      scope.collaboration.tickets.findByNumbers(ticketNumbers)
    ),
    findDetailBase: ticketId => (
      scope.collaboration.tickets.findDetailBase(ticketId)
    ),
    hasPendingResolve: ticketId => (
      scope.collaboration.tickets.hasPendingResolve(ticketId)
    ),
    list: options => scope.collaboration.tickets.list(options),
    listAcceptedRelations: (ticketId, options) => (
      scope.collaboration.tickets.listAcceptedRelations(ticketId, options)
    ),
    listComments: (ticketId, options) => (
      scope.collaboration.tickets.listComments(ticketId, options)
    ),
  };
  const collaboration: CollaborationRead = Object.freeze({
    idempotency: Object.freeze(idempotency),
    requests: Object.freeze(requests),
    snapshot: Object.freeze(snapshot),
    tickets: Object.freeze(tickets),
  });
  return Object.freeze({
    accept,
    collaboration,
    findDevelopmentActorMember: actorId => scope.findDevelopmentActorMember(actorId),
    findPrincipalMember: principalId => scope.findPrincipalMember(principalId),
    findMembership: memberId => scope.findMembership(memberId),
    getNonterminalDevelopmentBootstrapAttempt: () => (
      scope.getNonterminalDevelopmentBootstrapAttempt()
    ),
    getProject: () => scope.getProject(),
    getProjectEventSequence: () => scope.getProjectEventSequence(),
    getRepositoryPlacement: () => scope.getRepositoryPlacement(),
    listActiveSnapshotMemberships: () => scope.listActiveSnapshotMemberships(),
    membership: Object.freeze({
      getNonterminalJoin: () => scope.membership.getNonterminalJoin(),
    }),
    portability: Object.freeze({
      getNonterminalLifecycleJournal: () => (
        scope.portability.getNonterminalLifecycleJournal()
      ),
    }),
    readProjectEvents: options => scope.readProjectEvents(options),
  } satisfies ProjectReadScope);
}

async function runProjectReadTransaction<T>(
  client: PoolClient,
  projectId: CollabProjectId,
  operation: (scope: ProjectReadScope) => Promise<T>,
  markBroken: MarkBroken,
): Promise<T> {
  let transactionStarted = false;
  try {
    await safeQuery(
      client,
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      [],
      markBroken,
    );
    transactionStarted = true;
    await safeQuery(
      client,
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [projectId],
      markBroken,
    );
    const scope = new PostgresProjectScope(client, projectId, markBroken);
    let value: T;
    try {
      value = await operation(projectReadScope(scope));
    } finally {
      scope.deactivate();
    }
    await safeQuery(client, 'COMMIT', [], markBroken);
    transactionStarted = false;
    return value;
  } catch (error: unknown) {
    if (transactionStarted) await rollback(client, markBroken);
    throw error;
  }
}

class PostgresPinnedProjectLease implements PinnedProjectLease {
  readonly #checkedOutClient: CheckedOutPoolClient;
  readonly #client: PoolClient;
  readonly #lockKey: bigint;
  readonly #onProjectEventCommitted: ((projectId: CollabProjectId) => void)
    | undefined;
  readonly #projectId: CollabProjectId;
  #activeOperation: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #transferred = false;
  #transactionActive = false;

  constructor(
    checkedOutClient: CheckedOutPoolClient,
    projectId: CollabProjectId,
    lockKey: bigint,
    onProjectEventCommitted: ((projectId: CollabProjectId) => void) | undefined,
  ) {
    this.#checkedOutClient = checkedOutClient;
    this.#client = checkedOutClient.client;
    this.#projectId = projectId;
    this.#lockKey = lockKey;
    this.#onProjectEventCommitted = onProjectEventCommitted;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = this.#transferred
        ? Promise.resolve()
        : this.#finishClose();
    }
    return this.#closePromise;
  }

  async withProjectScope<T>(
    operation: (scope: ProjectScope) => Promise<T>,
    options: Readonly<{
      readonly signal?: AbortSignal;
      readonly snapshot?: 'repeatable-read';
    }> = {},
  ): Promise<T> {
    if (this.#closed) throw new CoordinationError('closed');
    if (this.#checkedOutClient.isBroken()) throw dependencyFailure();
    if (this.#transactionActive) throw new CoordinationError('lease-busy');
    this.#transactionActive = true;
    if (options.signal?.aborted) {
      this.#transactionActive = false;
      throw new CoordinationError('cancelled');
    }
    const onAbort = (): void => this.#checkedOutClient.release(true);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const transaction = runProjectTransaction(
      this.#client,
      this.#projectId,
      operation,
      {
        deadline: Number.POSITIVE_INFINITY,
        lockKey: undefined,
        markBroken: this.#checkedOutClient.markBroken,
        onProjectEventCommitted: this.#onProjectEventCommitted,
        readOnlySnapshot: options.snapshot === 'repeatable-read',
        signal: options.signal,
      },
    );
    this.#activeOperation = transaction.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await transaction;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.#transactionActive = false;
      this.#activeOperation = undefined;
    }
  }

  async withCreationScope<T>(
    operation: (persistence: CloudProjectCreationPersistence) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) throw new CoordinationError('closed');
    if (this.#checkedOutClient.isBroken()) throw dependencyFailure();
    if (this.#transactionActive) throw new CoordinationError('lease-busy');
    this.#transactionActive = true;
    const transaction = runCloudProjectCreationTransaction(
      this.#client,
      this.#projectId,
      operation,
      this.#checkedOutClient.markBroken,
    );
    this.#activeOperation = transaction.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await transaction;
    } finally {
      this.#transactionActive = false;
      this.#activeOperation = undefined;
    }
  }

  async drainDevelopmentBootstrapUploads(attemptId: string): Promise<void> {
    if (this.#closed || this.#transferred) throw new CoordinationError('closed');
    if (this.#checkedOutClient.isBroken()) throw dependencyFailure();
    if (this.#transactionActive) throw new CoordinationError('lease-busy');
    const uploadLockKey = developmentBootstrapUploadLockKey(
      this.#projectId,
      attemptId,
    );
    for (;;) {
      const rows = await safeQuery<{ readonly acquired: boolean }>(
        this.#client,
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [uploadLockKey.toString()],
        this.#checkedOutClient.markBroken,
      );
      if (rows[0]?.acquired === true) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, LOCK_RETRY_INTERVAL_MS);
        timer.unref();
      });
      if (this.#checkedOutClient.isBroken()) {
        throw dependencyFailure();
      }
    }
    const rows = await safeQuery<{ readonly unlocked: boolean }>(
      this.#client,
      'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
      [uploadLockKey.toString()],
      this.#checkedOutClient.markBroken,
    );
    if (rows[0]?.unlocked !== true) throw dependencyFailure();
  }

  async handoffToDevelopmentBootstrapUpload(
    attemptId: string,
  ): Promise<DevelopmentBootstrapUploadLease> {
    if (this.#closed || this.#transferred) throw new CoordinationError('closed');
    if (this.#checkedOutClient.isBroken()) throw dependencyFailure();
    if (this.#transactionActive) throw new CoordinationError('lease-busy');
    const uploadLockKey = developmentBootstrapUploadLockKey(
      this.#projectId,
      attemptId,
    );
    let sharedAcquired = false;
    try {
      await safeQuery(
        this.#client,
        'SELECT pg_advisory_lock_shared($1::bigint)',
        [uploadLockKey.toString()],
        this.#checkedOutClient.markBroken,
      );
      sharedAcquired = true;
      const rows = await safeQuery<{ readonly unlocked: boolean }>(
        this.#client,
        'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
        [this.#lockKey.toString()],
        this.#checkedOutClient.markBroken,
      );
      if (rows[0]?.unlocked !== true) throw dependencyFailure();
      this.#transferred = true;
      this.#closed = true;
      return new PostgresDevelopmentBootstrapUploadLease(
        this.#checkedOutClient,
        uploadLockKey,
      );
    } catch (error: unknown) {
      if (sharedAcquired) {
        try {
          await this.#client.query(
            'SELECT pg_advisory_unlock_shared($1::bigint)',
            [uploadLockKey.toString()],
          );
        } catch {
          this.#checkedOutClient.markBroken();
        }
      }
      throw error;
    }
  }

  async #finishClose(): Promise<void> {
    await this.#activeOperation;
    let releasedCleanly = false;
    try {
      if (this.#checkedOutClient.isBroken()) throw dependencyFailure();
      const rows = await safeQuery<{ readonly unlocked: boolean }>(
        this.#client,
        'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
        [this.#lockKey.toString()],
        this.#checkedOutClient.markBroken,
      );
      if (rows[0]?.unlocked !== true) {
        this.#checkedOutClient.markBroken();
        throw dependencyFailure();
      }
      releasedCleanly = true;
    } finally {
      try {
        this.#checkedOutClient.release(!releasedCleanly);
      } catch {
        this.#checkedOutClient.markBroken();
      }
    }
    if (this.#checkedOutClient.isBroken()) throw dependencyFailure();
  }
}

class PostgresDevelopmentBootstrapUploadLease
implements DevelopmentBootstrapUploadLease {
  readonly #checkedOutClient: CheckedOutPoolClient;
  readonly #client: PoolClient;
  readonly #lockKey: bigint;
  #closePromise: Promise<void> | undefined;

  constructor(checkedOutClient: CheckedOutPoolClient, lockKey: bigint) {
    this.#checkedOutClient = checkedOutClient;
    this.#client = checkedOutClient.client;
    this.#lockKey = lockKey;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#finishClose();
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    let releasedCleanly = false;
    try {
      if (this.#checkedOutClient.isBroken()) throw dependencyFailure();
      const rows = await safeQuery<{ readonly unlocked: boolean }>(
        this.#client,
        'SELECT pg_advisory_unlock_shared($1::bigint) AS unlocked',
        [this.#lockKey.toString()],
        this.#checkedOutClient.markBroken,
      );
      if (rows[0]?.unlocked !== true) {
        this.#checkedOutClient.markBroken();
        throw dependencyFailure();
      }
      releasedCleanly = true;
    } finally {
      this.#checkedOutClient.release(!releasedCleanly);
    }
    if (this.#checkedOutClient.isBroken()) throw dependencyFailure();
  }
}

export class PostgresCoordination
  implements DevelopmentBootstrapAttemptLocator,
  ExpiredDevelopmentBootstrapAttemptCatalog, RecoveryCandidateCatalog,
  RepositoryPlacementValidator, TerminalProjectContinuityCatalog,
  TerminalResponderCatalog {
  readonly #checkedOutClients = new CheckedOutPoolClients();
  readonly #ordinaryPool: Pool;
  readonly #onProjectEventCommitted: ((projectId: CollabProjectId) => void)
    | undefined;
  readonly #pinnedPool: Pool;
  readonly #projectLockTimeoutMs: number;
  readonly #reservedPool: Pool;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: PostgresCoordinationOptions) {
    this.#onProjectEventCommitted = options.onProjectEventCommitted;
    this.#projectLockTimeoutMs = options.projectLockTimeoutMs;
    const dependencyTimeoutMs = Math.min(
      options.projectLockTimeoutMs,
      Math.max(1, Math.floor(options.shutdownTimeoutMs / 2)),
    );
    const common = {
      allowExitOnIdle: true,
      connectionString: options.runtimeConnectionString,
      connectionTimeoutMillis: dependencyTimeoutMs,
      idleTimeoutMillis: 30_000,
      query_timeout: dependencyTimeoutMs,
      statement_timeout: dependencyTimeoutMs,
    } as const;
    this.#ordinaryPool = new Pool({
      ...common,
      application_name: 'claudian-cloud-ordinary',
      max: options.ordinaryPoolMax,
    });
    this.#ordinaryPool.on('error', handleIdlePoolError);
    this.#pinnedPool = new Pool({
      ...common,
      application_name: 'claudian-cloud-pinned',
      max: options.pinnedPoolMax,
    });
    this.#pinnedPool.on('error', handleIdlePoolError);
    this.#reservedPool = new Pool({
      ...common,
      application_name: 'claudian-cloud-reserved',
      max: options.reservedPoolMax,
    });
    this.#reservedPool.on('error', handleIdlePoolError);
  }

  acquireProjectLease(
    projectId: CollabProjectId,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<PinnedProjectLease> {
    if (this.#closed) return Promise.reject(new CoordinationError('closed'));
    const lockKey = ensureProjectId(projectId);
    return this.#acquirePinnedLease(projectId, lockKey, options.signal);
  }

  acquireCloudProjectCreationLease(
    projectId: CollabProjectId,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<CloudProjectCreationLease> {
    if (this.#closed) return Promise.reject(new CoordinationError('closed'));
    const lockKey = ensureProjectId(projectId);
    return this.#acquirePinnedLease(projectId, lockKey, options.signal);
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      const clientsClosed = this.#checkedOutClients.close();
      this.#closePromise = Promise.allSettled([
        this.#ordinaryPool.end(),
        this.#pinnedPool.end(),
        this.#reservedPool.end(),
      ]).then(results => {
        if (
          !clientsClosed
          || results.some(result => result.status === 'rejected')
        ) {
          throw dependencyFailure();
        }
      });
    }
    return this.#closePromise;
  }

  async listRecoveryCandidates(
    options: ListRecoveryCandidatesOptions = {},
  ): Promise<RecoveryCandidatePage> {
    this.#assertOpen();
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new CoordinationError('invalid-record');
    }
    const after = options.after;
    if (after !== undefined) validateRecoveryCursor(after);

    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#reservedPool,
      deadline,
      undefined,
      this.#checkedOutClients,
    );
    try {
      const rows = after === undefined
        ? await safeQuery<RecoveryCandidateRow>(
          checkedOut.client,
          `SELECT kind, project_id, operation_id, scheduled_at
             FROM claudian_cloud.recovery_candidates
            ORDER BY scheduled_at, kind, project_id, operation_id
            LIMIT $1`,
          [limit + 1],
          checkedOut.markBroken,
        )
        : await safeQuery<RecoveryCandidateRow>(
          checkedOut.client,
          `SELECT kind, project_id, operation_id, scheduled_at
             FROM claudian_cloud.recovery_candidates
            WHERE (scheduled_at, kind, project_id, operation_id)
                > ($1::timestamptz, $2, $3, $4)
            ORDER BY scheduled_at, kind, project_id, operation_id
            LIMIT $5`,
          [
            after.scheduledAt,
            after.kind,
            after.projectId,
            after.operationId,
            limit + 1,
          ],
          checkedOut.markBroken,
        );
      const pageRows = rows.slice(0, limit);
      const candidates = Object.freeze(pageRows.map(recoveryCandidate));
      const last = pageRows.at(-1);
      const nextCursor = rows.length > limit && last !== undefined
        ? recoveryCursor(last)
        : undefined;
      return Object.freeze({ candidates, nextCursor });
    } finally {
      checkedOut.release();
    }
  }

  async listTerminalResponders(
    options: ListTerminalRespondersOptions = {},
  ): Promise<TerminalResponderCatalogPage> {
    this.#assertOpen();
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new CoordinationError('invalid-record');
    }
    const after = options.after;
    if (after !== undefined) validateTerminalResponderCursor(after);
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#reservedPool,
      deadline,
      undefined,
      this.#checkedOutClients,
    );
    try {
      const rows = after === undefined
        ? await safeQuery<TerminalResponderCatalogRow>(
          checkedOut.client,
          `SELECT project_id, operation_kind, operation_id, expires_at
             FROM claudian_cloud.project_terminal_responder_catalog
            ORDER BY expires_at, project_id, operation_kind, operation_id
            LIMIT $1`,
          [limit + 1],
          checkedOut.markBroken,
        )
        : await safeQuery<TerminalResponderCatalogRow>(
          checkedOut.client,
          `SELECT project_id, operation_kind, operation_id, expires_at
             FROM claudian_cloud.project_terminal_responder_catalog
            WHERE (expires_at, project_id, operation_kind, operation_id)
                > ($1::timestamptz, $2, $3, $4)
            ORDER BY expires_at, project_id, operation_kind, operation_id
            LIMIT $5`,
          [
            after.expiresAt,
            after.projectId,
            after.operationKind,
            after.operationId,
            limit + 1,
          ],
          checkedOut.markBroken,
        );
      const pageRows = rows.slice(0, limit);
      const responders = Object.freeze(pageRows.map(terminalResponderCatalogEntry));
      const last = pageRows.at(-1);
      const nextCursor = rows.length > limit && last !== undefined
        ? terminalResponderCatalogEntry(last)
        : undefined;
      return Object.freeze({ nextCursor, responders });
    } finally {
      checkedOut.release();
    }
  }

  async listTerminalProjectContinuity(options: Readonly<{
    readonly after?: CollabProjectId;
    readonly limit?: number;
  }> = {}): Promise<TerminalProjectContinuityPage> {
    this.#assertOpen();
    const limit = options.limit ?? 100;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 100
      || (options.after !== undefined && !isCollabProjectId(options.after))
    ) throw new CoordinationError('invalid-record');
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#reservedPool,
      deadline,
      undefined,
      this.#checkedOutClients,
    );
    try {
      const catalog = await safeQuery<{ readonly relation: string | null }>(
        checkedOut.client,
        `SELECT to_regclass(
           'claudian_cloud.project_terminal_continuity_catalog'
         )::text AS relation`,
        [],
        checkedOut.markBroken,
      );
      if (
        catalog[0]?.relation
          !== 'claudian_cloud.project_terminal_continuity_catalog'
      ) throw new CoordinationError('schema-incompatible');
      const rows = await safeQuery<{ readonly project_id: string }>(
        checkedOut.client,
        `SELECT project_id
           FROM claudian_cloud.project_terminal_continuity_catalog
          WHERE ($1::varchar IS NULL OR project_id > $1)
          ORDER BY project_id
          LIMIT $2`,
        [options.after ?? null, limit + 1],
        checkedOut.markBroken,
      );
      const page = rows.slice(0, limit);
      const projectIds = Object.freeze(page.map(row => row.project_id));
      return Object.freeze({
        nextCursor: rows.length > limit ? projectIds.at(-1) : undefined,
        projectIds,
      });
    } finally {
      checkedOut.release();
    }
  }

  async listActiveRepositoryPlacements(
    options: ListActiveRepositoryPlacementsOptions = {},
  ): Promise<ActiveRepositoryPlacementPage> {
    this.#assertOpen();
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new CoordinationError('invalid-record');
    }
    if (options.after !== undefined && !isCollabProjectId(options.after)) {
      throw new CoordinationError('invalid-record');
    }
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#reservedPool,
      deadline,
      undefined,
      this.#checkedOutClients,
    );
    try {
      const rows = await safeQuery<PlacementRow>(
        checkedOut.client,
        `SELECT project_id,
                storage_node_id,
                repository_storage_key,
                generation,
                true AS active
           FROM claudian_cloud.active_repository_placement_catalog
          WHERE $1::varchar IS NULL OR project_id > $1
          ORDER BY project_id
          LIMIT $2`,
        [options.after ?? null, limit + 1],
        checkedOut.markBroken,
      );
      const pageRows = rows.slice(0, limit);
      const placements = Object.freeze(pageRows.map(row => (
        createRepositoryPlacementLease({
          active: row.active,
          generation: Number(row.generation),
          projectId: row.project_id,
          repositoryStorageKey: row.repository_storage_key,
          storageNodeId: row.storage_node_id,
        })
      )));
      const last = placements.at(-1);
      return Object.freeze({
        nextCursor: rows.length > limit ? last?.projectId : undefined,
        placements,
      });
    } finally {
      checkedOut.release();
    }
  }

  async listExpiredDevelopmentBootstrapAttempts(
    options: ListExpiredDevelopmentBootstrapAttemptsOptions,
  ): Promise<ExpiredDevelopmentBootstrapAttemptPage> {
    this.#assertOpen();
    validateIsoTimestamp(options.expiredBefore);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new CoordinationError('invalid-record');
    }
    const after = options.after;
    if (after !== undefined) validateExpiredAttemptCursor(after);

    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#reservedPool,
      deadline,
      undefined,
      this.#checkedOutClients,
    );
    try {
      const rows = after === undefined
        ? await safeQuery<ExpiredBootstrapAttemptRow>(
          checkedOut.client,
          `SELECT project_id, attempt_id, expires_at
             FROM claudian_cloud.development_bootstrap_expiry_candidates
            WHERE expires_at <= $1
            ORDER BY expires_at, project_id, attempt_id
            LIMIT $2`,
          [options.expiredBefore, limit + 1],
          checkedOut.markBroken,
        )
        : await safeQuery<ExpiredBootstrapAttemptRow>(
          checkedOut.client,
          `SELECT project_id, attempt_id, expires_at
             FROM claudian_cloud.development_bootstrap_expiry_candidates
            WHERE expires_at <= $1
              AND (expires_at, project_id, attempt_id)
                  > ($2::timestamptz, $3, $4)
            ORDER BY expires_at, project_id, attempt_id
            LIMIT $5`,
          [
            options.expiredBefore,
            after.expiresAt,
            after.projectId,
            after.attemptId,
            limit + 1,
          ],
          checkedOut.markBroken,
        );
      const pageRows = rows.slice(0, limit);
      const attempts = Object.freeze(pageRows.map(expiredAttempt));
      const last = pageRows.at(-1);
      const nextCursor = rows.length > limit && last !== undefined
        ? expiredAttempt(last)
        : undefined;
      return Object.freeze({ attempts, nextCursor });
    } finally {
      checkedOut.release();
    }
  }

  async findDevelopmentBootstrapProject(
    attemptId: string,
  ): Promise<CollabProjectId | undefined> {
    this.#assertOpen();
    if (!isCollabOpaqueId(attemptId)) {
      throw new CoordinationError('invalid-record');
    }
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#reservedPool,
      deadline,
      undefined,
      this.#checkedOutClients,
    );
    try {
      const rows = await safeQuery<BootstrapAttemptRouteRow>(
        checkedOut.client,
        `SELECT claudian_cloud.find_development_bootstrap_project($1)
              AS project_id`,
        [attemptId],
        checkedOut.markBroken,
      );
      const projectId = rows[0]?.project_id;
      if (projectId === null || projectId === undefined) return undefined;
      if (!isCollabProjectId(projectId)) throw dependencyFailure();
      return projectId;
    } finally {
      checkedOut.release();
    }
  }

  async isCurrent(placement: RepositoryPlacementLease): Promise<boolean> {
    assertRepositoryPlacementLease(placement);
    const current = await this.#withReadScope(
      placement.projectId,
      scope => scope.getRepositoryPlacement(),
    );
    return current !== undefined
      && current.projectId === placement.projectId
      && current.storageNodeId === placement.storageNodeId
      && current.repositoryStorageKey === placement.repositoryStorageKey
      && current.generation === placement.generation;
  }

  async verifySchemaCompatibility(): Promise<number> {
    this.#assertOpen();
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#reservedPool,
      deadline,
      undefined,
      this.#checkedOutClients,
    );
    const client = checkedOut.client;
    try {
      const role = await safeQuery<{ readonly role_name: string }>(
        client,
        'SELECT current_user AS role_name',
        [],
        checkedOut.markBroken,
      );
      if (role[0]?.role_name !== RUNTIME_ROLE) {
        throw new CoordinationError('schema-incompatible');
      }
      const relation = await safeQuery<{ readonly relation: string | null }>(
        client,
        "SELECT to_regclass('claudian_cloud.schema_metadata')::text AS relation",
        [],
        checkedOut.markBroken,
      );
      if (relation[0]?.relation === null) {
        throw new CoordinationError('schema-incompatible');
      }
      const rows = await safeQuery<PostgresSchemaMetadata>(
        client,
        `SELECT singleton, version, checksum
           FROM claudian_cloud.schema_metadata`,
        [],
        checkedOut.markBroken,
      );
      if (!isCurrentPostgresSchema(rows)) {
        throw new CoordinationError('schema-incompatible');
      }
      return CURRENT_POSTGRES_SCHEMA.version;
    } finally {
      checkedOut.release();
    }
  }

  async verifyAuthorityVolumeId(expected: string): Promise<void> {
    this.#assertOpen();
    if (!AUTHORITY_VOLUME_ID_PATTERN.test(expected)) {
      throw new CoordinationError('authority-volume-mismatch');
    }
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#reservedPool,
      deadline,
      undefined,
      this.#checkedOutClients,
    );
    try {
      const rows = await safeQuery<{ readonly authority_volume_id: string | null }>(
        checkedOut.client,
        `SELECT current_setting(
                  'claudian_cloud.authority_volume_id',
                  true
                ) AS authority_volume_id`,
        [],
        checkedOut.markBroken,
      );
      if (rows[0]?.authority_volume_id !== expected) {
        throw new CoordinationError('authority-volume-mismatch');
      }
    } finally {
      checkedOut.release();
    }
  }

  async withProjectScope<T>(
    projectId: CollabProjectId,
    operation: (scope: ProjectScope) => Promise<T>,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<T> {
    this.#assertOpen();
    const lockKey = ensureProjectId(projectId);
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#ordinaryPool,
      deadline,
      options.signal,
      this.#checkedOutClients,
    );
    const client = checkedOut.client;
    try {
      return await runProjectTransaction(client, projectId, operation, {
        deadline,
        lockKey,
        markBroken: checkedOut.markBroken,
        onProjectEventCommitted: this.#onProjectEventCommitted,
        signal: options.signal,
      });
    } finally {
      checkedOut.release();
    }
  }

  async withProjectReadScope<T>(
    projectId: CollabProjectId,
    operation: (scope: ProjectReadScope) => Promise<T>,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<T> {
    this.#assertOpen();
    ensureProjectId(projectId);
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#ordinaryPool,
      deadline,
      options.signal,
      this.#checkedOutClients,
    );
    try {
      return await runProjectReadTransaction(
        checkedOut.client,
        projectId,
        operation,
        checkedOut.markBroken,
      );
    } finally {
      checkedOut.release();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new CoordinationError('closed');
  }

  async #acquirePinnedLease(
    projectId: CollabProjectId,
    lockKey: bigint,
    signal: AbortSignal | undefined,
  ): Promise<PostgresPinnedProjectLease> {
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#pinnedPool,
      deadline,
      signal,
      this.#checkedOutClients,
    );
    const client = checkedOut.client;
    let acquired = false;
    try {
      await acquireAdvisoryLock(
        client,
        lockKey,
        false,
        deadline,
        signal,
        checkedOut.markBroken,
      );
      acquired = true;
      if (signal?.aborted === true) throw new CoordinationError('cancelled');
      if (this.#closed) throw new CoordinationError('closed');
      return new PostgresPinnedProjectLease(
        checkedOut,
        projectId,
        lockKey,
        this.#onProjectEventCommitted,
      );
    } catch (error: unknown) {
      if (acquired) {
        try {
          const result = await client.query<{ readonly unlocked: boolean }>(
            'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
            [lockKey.toString()],
          );
          if (result.rows[0]?.unlocked !== true) checkedOut.markBroken();
        } catch {
          checkedOut.markBroken();
        }
      }
      checkedOut.release();
      throw error;
    }
  }

  async #withReadScope<T>(
    projectId: CollabProjectId,
    operation: (scope: ProjectScope) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    ensureProjectId(projectId);
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const checkedOut = await checkout(
      this.#ordinaryPool,
      deadline,
      undefined,
      this.#checkedOutClients,
    );
    const client = checkedOut.client;
    try {
      return await runProjectTransaction(client, projectId, operation, {
        deadline,
        lockKey: undefined,
        markBroken: checkedOut.markBroken,
        onProjectEventCommitted: this.#onProjectEventCommitted,
        signal: undefined,
      });
    } finally {
      checkedOut.release();
    }
  }
}
