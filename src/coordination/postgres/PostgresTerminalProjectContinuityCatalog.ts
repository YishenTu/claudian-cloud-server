import {
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import {
  CURRENT_POSTGRES_SCHEMA_VERSION,
} from '../../config/PostgresSchemaCompatibility.js';
import { CoordinationError } from '../CoordinationError.js';
import { POSTGRES_SCHEMAS } from './PostgresSchema.js';

export interface PostgresTerminalProjectContinuityCatalogOptions {
  readonly connectionString: string;
  readonly expectedAuthorityVolumeId: string;
  readonly expectedSchemaVersion: number;
}

interface MigrationRow {
  readonly checksum: string;
  readonly name: string;
  readonly state: string;
  readonly version: number;
}

const MIGRATION_ROLE = 'claudian_cloud_migration';
const DEPENDENCY_TIMEOUT_MS = 300_000;
const AUTHORITY_VOLUME_ID_PATTERN = /^[0-9a-f]{32}$/u;

function fail(code: 'cancelled' | 'dependency-failed'): never {
  throw new CoordinationError(code);
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) fail('cancelled');
}

export class PostgresTerminalProjectContinuityCatalog {
  readonly #connectionString: string;
  readonly #expectedAuthorityVolumeId: string;
  readonly #expectedSchemaVersion: number;

  constructor(options: PostgresTerminalProjectContinuityCatalogOptions) {
    if (
      options.connectionString.length === 0
      || !AUTHORITY_VOLUME_ID_PATTERN.test(options.expectedAuthorityVolumeId)
      || options.expectedSchemaVersion
        !== CURRENT_POSTGRES_SCHEMA_VERSION - 1
    ) {
      throw new TypeError(
        'postgres-terminal-project-continuity-catalog.options-invalid',
      );
    }
    this.#connectionString = options.connectionString;
    this.#expectedAuthorityVolumeId = options.expectedAuthorityVolumeId;
    this.#expectedSchemaVersion = options.expectedSchemaVersion;
  }

  async list(input: Readonly<{
    readonly after?: CollabProjectId;
    readonly limit: number;
    readonly signal: AbortSignal;
  }>): Promise<Readonly<{
    readonly nextCursor: CollabProjectId | undefined;
    readonly projectIds: readonly CollabProjectId[];
  }>> {
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > 100
      || (input.after !== undefined && !isCollabProjectId(input.after))
    ) fail('dependency-failed');
    assertActive(input.signal);
    const client = new Client({
      application_name: 'claudian-cloud-terminal-catalog-maintenance',
      connectionString: this.#connectionString,
      connectionTimeoutMillis: DEPENDENCY_TIMEOUT_MS,
      idle_in_transaction_session_timeout: DEPENDENCY_TIMEOUT_MS,
      lock_timeout: DEPENDENCY_TIMEOUT_MS,
      query_timeout: DEPENDENCY_TIMEOUT_MS,
      statement_timeout: DEPENDENCY_TIMEOUT_MS,
    });
    let connected = false;
    let transaction = false;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= client.end().catch(() => undefined);
      return closePromise;
    };
    const onAbort = (): void => { void close(); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    try {
      await client.connect();
      connected = true;
      assertActive(input.signal);
      await client.query('BEGIN');
      transaction = true;
      await client.query(
        'LOCK TABLE claudian_cloud.schema_migrations IN SHARE MODE',
      );
      const role = await client.query<{ readonly role_name: string }>(
        'SELECT current_user AS role_name',
      );
      if (role.rows[0]?.role_name !== MIGRATION_ROLE) {
        fail('dependency-failed');
      }
      const identity = await client.query<{
        readonly authority_volume_id: string | null;
      }>(
        `SELECT current_setting(
                  'claudian_cloud.authority_volume_id',
                  true
                ) AS authority_volume_id`,
      );
      if (
        identity.rows[0]?.authority_volume_id
          !== this.#expectedAuthorityVolumeId
      ) fail('dependency-failed');
      const history = await client.query<MigrationRow>(
        `SELECT version, name, checksum, state
           FROM claudian_cloud.schema_migrations
          ORDER BY version`,
      );
      const expected = POSTGRES_SCHEMAS.slice(0, this.#expectedSchemaVersion);
      if (
        history.rows.length !== expected.length
        || history.rows.some((row, index) => {
          const schema = expected[index];
          return schema === undefined
            || row.version !== schema.version
            || row.name !== schema.name
            || row.checksum !== schema.checksum
            || row.state !== 'applied';
        })
      ) fail('dependency-failed');
      await client.query(
        `ALTER TABLE claudian_cloud.project_tombstones
           NO FORCE ROW LEVEL SECURITY`,
      );
      const rows = await client.query<{ readonly project_id: string }>(
        `SELECT project_id
           FROM claudian_cloud.project_tombstones
          WHERE ($1::varchar IS NULL OR project_id > $1)
          ORDER BY project_id
          LIMIT $2`,
        [input.after ?? null, input.limit + 1],
      );
      assertActive(input.signal);
      const page = rows.rows.slice(0, input.limit);
      if (page.some(row => !isCollabProjectId(row.project_id))) {
        fail('dependency-failed');
      }
      const projectIds = Object.freeze(
        page.map(row => row.project_id),
      );
      return Object.freeze({
        nextCursor: rows.rows.length > input.limit
          ? projectIds.at(-1)
          : undefined,
        projectIds,
      });
    } catch (error: unknown) {
      if (error instanceof CoordinationError) throw error;
      if (input.signal.aborted) fail('cancelled');
      fail('dependency-failed');
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      if (transaction && connected) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      if (connected) await close();
    }
    return fail('dependency-failed');
  }
}
