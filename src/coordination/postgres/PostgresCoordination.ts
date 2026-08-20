import {
  isCollabMemberId,
  type CollabMemberId,
  type CollabProjectId,
} from '@claudian/collab-protocol';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import {
  assertRepositoryPlacementLease,
  createRepositoryPlacementLease,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from '../../repositories/RepositoryPlacement.js';
import { CoordinationError } from '../CoordinationError.js';
import { projectLockKey } from '../ProjectLockKey.js';
import { FOUNDATION_SCHEMA } from './PostgresSchema.js';

export interface PostgresCoordinationOptions {
  readonly ordinaryPoolMax: number;
  readonly pinnedPoolMax: number;
  readonly projectLockTimeoutMs: number;
  readonly reservedPoolMax: number;
  readonly runtimeConnectionString: string;
}

export interface AcquireProjectLeaseOptions {
  readonly signal?: AbortSignal;
}

export interface ProjectMembershipRecord {
  readonly memberId: CollabMemberId;
  readonly revision: bigint;
  readonly role: 'manager' | 'member';
  readonly status: 'active' | 'left' | 'pending' | 'revoked';
}

export interface ProjectScope {
  findMembership(memberId: CollabMemberId): Promise<ProjectMembershipRecord | undefined>;
  getRepositoryPlacement(): Promise<RepositoryPlacementLease | undefined>;
}

export interface PinnedProjectLease {
  close(): Promise<void>;
  withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>): Promise<T>;
}

interface MembershipRow {
  readonly member_id: string;
  readonly revision: string;
  readonly role: string;
  readonly status: string;
}

interface PlacementRow {
  readonly active: boolean;
  readonly generation: string;
  readonly project_id: string;
  readonly repository_storage_key: string;
  readonly storage_node_id: string;
}

interface MigrationRow {
  readonly checksum: string;
  readonly name: string;
  readonly state: string;
  readonly version: number;
}

type MarkBroken = () => void;

const LOCK_RETRY_INTERVAL_MS = 5;
const RUNTIME_ROLE = 'claudian_cloud_runtime';

function dependencyFailure(): CoordinationError {
  return new CoordinationError('dependency-failed');
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
): Promise<PoolClient> {
  if (signal?.aborted === true) throw new CoordinationError('cancelled');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CoordinationError('busy');

  return new Promise<PoolClient>((resolve, reject) => {
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
        if (settled) {
          client.release();
          return;
        }
        finish(() => resolve(client));
      },
      () => finish(() => reject(dependencyFailure())),
    );
    if (signal?.aborted === true) onAbort();
  });
}

class PostgresProjectScope implements ProjectScope {
  readonly #client: PoolClient;
  readonly #markBroken: MarkBroken;
  readonly #projectId: CollabProjectId;
  #active = true;

  constructor(
    client: PoolClient,
    projectId: CollabProjectId,
    markBroken: MarkBroken,
  ) {
    this.#client = client;
    this.#projectId = projectId;
    this.#markBroken = markBroken;
  }

  deactivate(): void {
    this.#active = false;
  }

  async findMembership(
    memberId: CollabMemberId,
  ): Promise<ProjectMembershipRecord | undefined> {
    this.#assertActive();
    if (!isCollabMemberId(memberId)) {
      throw new CoordinationError('invalid-member');
    }
    const rows = await safeQuery<MembershipRow>(
      this.#client,
      `SELECT member_id, role, status, revision
         FROM claudian_cloud.project_memberships
        WHERE project_id = $1 AND member_id = $2`,
      [this.#projectId, memberId],
      this.#markBroken,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (
      !isCollabMemberId(row.member_id)
      || (row.role !== 'manager' && row.role !== 'member')
      || !['active', 'left', 'pending', 'revoked'].includes(row.status)
    ) {
      throw dependencyFailure();
    }
    return Object.freeze({
      memberId: row.member_id,
      revision: BigInt(row.revision),
      role: row.role,
      status: row.status as ProjectMembershipRecord['status'],
    });
  }

  async getRepositoryPlacement(): Promise<RepositoryPlacementLease | undefined> {
    this.#assertActive();
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

  #assertActive(): void {
    if (!this.#active) throw new CoordinationError('closed');
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
    readonly signal: AbortSignal | undefined;
  },
): Promise<T> {
  let transactionStarted = false;
  try {
    await safeQuery(client, 'BEGIN', [], options.markBroken);
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
    try {
      value = await operation(scope);
    } finally {
      scope.deactivate();
    }
    await safeQuery(client, 'COMMIT', [], options.markBroken);
    transactionStarted = false;
    return value;
  } catch (error: unknown) {
    if (transactionStarted) await rollback(client, options.markBroken);
    throw error;
  }
}

class PostgresPinnedProjectLease implements PinnedProjectLease {
  readonly #client: PoolClient;
  readonly #lockKey: bigint;
  readonly #projectId: CollabProjectId;
  #activeOperation: Promise<void> | undefined;
  #broken = false;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #transactionActive = false;

  constructor(
    client: PoolClient,
    projectId: CollabProjectId,
    lockKey: bigint,
  ) {
    this.#client = client;
    this.#projectId = projectId;
    this.#lockKey = lockKey;
    this.#client.on('error', this.#handleClientError);
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = this.#finishClose();
    }
    return this.#closePromise;
  }

  async withProjectScope<T>(
    operation: (scope: ProjectScope) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) throw new CoordinationError('closed');
    if (this.#broken) throw dependencyFailure();
    if (this.#transactionActive) throw new CoordinationError('lease-busy');
    this.#transactionActive = true;
    const transaction = runProjectTransaction(
      this.#client,
      this.#projectId,
      operation,
      {
        deadline: Number.POSITIVE_INFINITY,
        lockKey: undefined,
        markBroken: this.#markBroken,
        signal: undefined,
      },
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

  readonly #handleClientError = (): void => {
    this.#broken = true;
  };

  readonly #markBroken = (): void => {
    this.#broken = true;
  };

  async #finishClose(): Promise<void> {
    await this.#activeOperation;
    let releasedCleanly = false;
    try {
      if (this.#broken) throw dependencyFailure();
      const rows = await safeQuery<{ readonly unlocked: boolean }>(
        this.#client,
        'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
        [this.#lockKey.toString()],
        this.#markBroken,
      );
      if (rows[0]?.unlocked !== true) {
        this.#broken = true;
        throw dependencyFailure();
      }
      releasedCleanly = true;
    } finally {
      this.#client.removeListener('error', this.#handleClientError);
      try {
        this.#client.release(!releasedCleanly);
      } catch {
        this.#broken = true;
      }
    }
    if (this.#broken) throw dependencyFailure();
  }
}

export class PostgresCoordination implements RepositoryPlacementValidator {
  readonly #ordinaryPool: Pool;
  readonly #pinnedPool: Pool;
  readonly #projectLockTimeoutMs: number;
  readonly #reservedPool: Pool;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: PostgresCoordinationOptions) {
    this.#projectLockTimeoutMs = options.projectLockTimeoutMs;
    const common = {
      allowExitOnIdle: true,
      connectionString: options.runtimeConnectionString,
      connectionTimeoutMillis: options.projectLockTimeoutMs,
      idleTimeoutMillis: 30_000,
      query_timeout: options.projectLockTimeoutMs,
      statement_timeout: options.projectLockTimeoutMs,
    } as const;
    this.#ordinaryPool = new Pool({
      ...common,
      application_name: 'claudian-cloud-ordinary',
      max: options.ordinaryPoolMax,
    });
    this.#pinnedPool = new Pool({
      ...common,
      application_name: 'claudian-cloud-pinned',
      max: options.pinnedPoolMax,
    });
    this.#reservedPool = new Pool({
      ...common,
      application_name: 'claudian-cloud-reserved',
      max: options.reservedPoolMax,
    });
  }

  acquireProjectLease(
    projectId: CollabProjectId,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<PinnedProjectLease> {
    if (this.#closed) return Promise.reject(new CoordinationError('closed'));
    const lockKey = ensureProjectId(projectId);
    return this.#acquirePinnedLease(projectId, lockKey, options.signal);
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = Promise.allSettled([
        this.#ordinaryPool.end(),
        this.#pinnedPool.end(),
        this.#reservedPool.end(),
      ]).then(results => {
        if (results.some(result => result.status === 'rejected')) {
          throw dependencyFailure();
        }
      });
    }
    return this.#closePromise;
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

  async verifySchemaCompatibility(): Promise<void> {
    this.#assertOpen();
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const client = await checkout(this.#reservedPool, deadline, undefined);
    let broken = false;
    const markBroken = (): void => {
      broken = true;
    };
    try {
      const role = await safeQuery<{ readonly role_name: string }>(
        client,
        'SELECT current_user AS role_name',
        [],
        markBroken,
      );
      if (role[0]?.role_name !== RUNTIME_ROLE) {
        throw new CoordinationError('schema-incompatible');
      }
      const relation = await safeQuery<{ readonly relation: string | null }>(
        client,
        "SELECT to_regclass('claudian_cloud.schema_migrations')::text AS relation",
        [],
        markBroken,
      );
      if (relation[0]?.relation === null) {
        throw new CoordinationError('schema-incompatible');
      }
      const rows = await safeQuery<MigrationRow>(
        client,
        `SELECT version, name, checksum, state
           FROM claudian_cloud.schema_migrations
          ORDER BY version`,
        [],
        markBroken,
      );
      if (
        rows.length !== 1
        || rows[0]?.version !== FOUNDATION_SCHEMA.version
        || rows[0].name !== FOUNDATION_SCHEMA.name
        || rows[0].checksum !== FOUNDATION_SCHEMA.checksum
        || rows[0].state !== 'applied'
      ) {
        throw new CoordinationError('schema-incompatible');
      }
    } finally {
      client.release(broken);
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
    const client = await checkout(this.#ordinaryPool, deadline, options.signal);
    let broken = false;
    const markBroken = (): void => {
      broken = true;
    };
    try {
      return await runProjectTransaction(client, projectId, operation, {
        deadline,
        lockKey,
        markBroken,
        signal: options.signal,
      });
    } finally {
      client.release(broken);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new CoordinationError('closed');
  }

  async #acquirePinnedLease(
    projectId: CollabProjectId,
    lockKey: bigint,
    signal: AbortSignal | undefined,
  ): Promise<PinnedProjectLease> {
    const deadline = Date.now() + this.#projectLockTimeoutMs;
    const client = await checkout(this.#pinnedPool, deadline, signal);
    let acquired = false;
    let broken = false;
    const markBroken = (): void => {
      broken = true;
    };
    try {
      await acquireAdvisoryLock(
        client,
        lockKey,
        false,
        deadline,
        signal,
        markBroken,
      );
      acquired = true;
      if (signal?.aborted === true) throw new CoordinationError('cancelled');
      if (this.#closed) throw new CoordinationError('closed');
      return new PostgresPinnedProjectLease(client, projectId, lockKey);
    } catch (error: unknown) {
      if (acquired) {
        try {
          const result = await client.query<{ readonly unlocked: boolean }>(
            'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
            [lockKey.toString()],
          );
          if (result.rows[0]?.unlocked !== true) broken = true;
        } catch {
          broken = true;
        }
      }
      client.release(broken);
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
    const client = await checkout(this.#ordinaryPool, deadline, undefined);
    let broken = false;
    const markBroken = (): void => {
      broken = true;
    };
    try {
      return await runProjectTransaction(client, projectId, operation, {
        deadline,
        lockKey: undefined,
        markBroken,
        signal: undefined,
      });
    } finally {
      client.release(broken);
    }
  }
}
