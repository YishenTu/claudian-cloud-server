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
  readonly shutdownTimeoutMs: number;
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

function handleIdlePoolError(_error: Error): void {
  // pg removes the failed idle client; the next operation reconnects or fails safely.
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
  readonly #checkedOutClient: CheckedOutPoolClient;
  readonly #client: PoolClient;
  readonly #lockKey: bigint;
  readonly #projectId: CollabProjectId;
  #activeOperation: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #transactionActive = false;

  constructor(
    checkedOutClient: CheckedOutPoolClient,
    projectId: CollabProjectId,
    lockKey: bigint,
  ) {
    this.#checkedOutClient = checkedOutClient;
    this.#client = checkedOutClient.client;
    this.#projectId = projectId;
    this.#lockKey = lockKey;
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
    if (this.#checkedOutClient.isBroken()) throw dependencyFailure();
    if (this.#transactionActive) throw new CoordinationError('lease-busy');
    this.#transactionActive = true;
    const transaction = runProjectTransaction(
      this.#client,
      this.#projectId,
      operation,
      {
        deadline: Number.POSITIVE_INFINITY,
        lockKey: undefined,
        markBroken: this.#checkedOutClient.markBroken,
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

export class PostgresCoordination implements RepositoryPlacementValidator {
  readonly #checkedOutClients = new CheckedOutPoolClients();
  readonly #ordinaryPool: Pool;
  readonly #pinnedPool: Pool;
  readonly #projectLockTimeoutMs: number;
  readonly #reservedPool: Pool;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: PostgresCoordinationOptions) {
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
        "SELECT to_regclass('claudian_cloud.schema_migrations')::text AS relation",
        [],
        checkedOut.markBroken,
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
        checkedOut.markBroken,
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
        signal: options.signal,
      });
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
  ): Promise<PinnedProjectLease> {
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
      return new PostgresPinnedProjectLease(checkedOut, projectId, lockKey);
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
        signal: undefined,
      });
    } finally {
      checkedOut.release();
    }
  }
}
