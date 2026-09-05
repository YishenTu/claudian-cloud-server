import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Client } from 'pg';

import {
  CURRENT_POSTGRES_SCHEMA,
  isCurrentPostgresSchema,
  type PostgresSchemaMetadata,
} from './PostgresSchema.js';

export type PostgresSchemaErrorCode =
  | 'migration-failed'
  | 'migration-role-mismatch'
  | 'schema-incompatible'
  | 'schema-resource-drift';

export class PostgresSchemaError extends Error {
  constructor(readonly code: PostgresSchemaErrorCode) {
    super(`postgres.schema.error.${code}`);
    this.name = 'PostgresSchemaError';
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({ code: this.code, message: this.message, name: this.name });
  }
}

export interface PostgresSchemaInitializerOptions {
  readonly connectionString: string;
}

export interface PostgresSchemaPlan {
  readonly currentVersion: number;
  readonly targetVersion: number;
}

const MIGRATION_ROLE = 'claudian_cloud_migration';
const MIGRATION_LOCK_NAMESPACE = 1_665_883_532;
const MIGRATION_LOCK_KEY = 1;
const MIGRATION_DEPENDENCY_TIMEOUT_MS = 300_000;

const METADATA_SQL = `
CREATE SCHEMA claudian_cloud AUTHORIZATION claudian_cloud_migration;
REVOKE ALL ON SCHEMA claudian_cloud FROM PUBLIC;
GRANT USAGE ON SCHEMA claudian_cloud TO claudian_cloud_runtime;
CREATE TABLE claudian_cloud.schema_metadata (
  singleton boolean PRIMARY KEY CHECK (singleton),
  version integer NOT NULL CHECK (version > 0),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$')
);
REVOKE ALL ON claudian_cloud.schema_metadata FROM PUBLIC;
GRANT SELECT ON claudian_cloud.schema_metadata TO claudian_cloud_runtime;
`;

function fail(code: PostgresSchemaErrorCode): never {
  throw new PostgresSchemaError(code);
}

async function loadSchema(): Promise<string> {
  const sql = await readFile(new URL('./CurrentPostgresSchema.sql', import.meta.url), 'utf8');
  if (createHash('sha256').update(sql, 'utf8').digest('hex') !== CURRENT_POSTGRES_SCHEMA.checksum) {
    fail('schema-resource-drift');
  }
  return sql;
}

async function verifyMigrationRole(client: Client): Promise<void> {
  const result = await client.query<{ readonly role_name: string }>('SELECT current_user AS role_name');
  if (result.rows[0]?.role_name !== MIGRATION_ROLE) fail('migration-role-mismatch');
}

async function connect(client: Client, signal?: AbortSignal): Promise<void> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new PostgresSchemaError('migration-failed'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // pg can leave connect() pending when end() closes an incomplete handshake.
    // The caller closes the owned socket; this race also settles its operation.
    await Promise.race([client.connect(), aborted]);
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

async function initializeSchema(client: Client, sql: string, assertActive: () => void): Promise<void> {
  try {
    await client.query('BEGIN');
    assertActive();
    await client.query(METADATA_SQL);
    assertActive();
    await client.query(sql);
    assertActive();
    await client.query(
      'INSERT INTO claudian_cloud.schema_metadata (singleton, version, checksum) VALUES (true, $1, $2)',
      [CURRENT_POSTGRES_SCHEMA.version, CURRENT_POSTGRES_SCHEMA.checksum],
    );
    assertActive();
    await client.query('COMMIT');
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Closing the connection rolls back any transaction still owned by this session.
    }
    if (error instanceof PostgresSchemaError) throw error;
    fail('migration-failed');
  }
}

export class PostgresSchemaInitializer {
  readonly #connectionString: string;

  constructor(options: PostgresSchemaInitializerOptions) {
    this.#connectionString = options.connectionString;
  }

  async #run(
    apply: boolean,
    signal?: AbortSignal,
  ): Promise<PostgresSchemaPlan> {
    const client = new Client({
      application_name: 'claudian-cloud-migration',
      connectionString: this.#connectionString,
      connectionTimeoutMillis: MIGRATION_DEPENDENCY_TIMEOUT_MS,
      idle_in_transaction_session_timeout: MIGRATION_DEPENDENCY_TIMEOUT_MS,
      lock_timeout: MIGRATION_DEPENDENCY_TIMEOUT_MS,
      query_timeout: MIGRATION_DEPENDENCY_TIMEOUT_MS,
      statement_timeout: MIGRATION_DEPENDENCY_TIMEOUT_MS,
    });
    let locked = false;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= client.end().catch(() => undefined);
      return closePromise;
    };
    const assertActive = (): void => {
      if (signal?.aborted === true) {
        throw new PostgresSchemaError('migration-failed');
      }
    };
    const onAbort = (): void => { void close(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    try {
      const sql = await loadSchema();
      assertActive();
      await connect(client, signal);
      assertActive();
      await verifyMigrationRole(client);
      await client.query(
        'SELECT pg_advisory_lock($1::integer, $2::integer)',
        [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY],
      );
      locked = true;
      assertActive();
      const metadata = await client.query<{ readonly schema_name: string | null; readonly relation: string | null }>(
        `SELECT to_regnamespace('claudian_cloud')::text AS schema_name,
                to_regclass('claudian_cloud.schema_metadata')::text AS relation`,
      );
      if (metadata.rows[0]?.schema_name === null) {
        if (apply) await initializeSchema(client, sql, assertActive);
        return Object.freeze({
          currentVersion: apply ? CURRENT_POSTGRES_SCHEMA.version : 0,
          targetVersion: CURRENT_POSTGRES_SCHEMA.version,
        });
      }
      if (metadata.rows[0]?.relation == null) fail('schema-incompatible');
      const existing = await client.query<PostgresSchemaMetadata>(
        'SELECT singleton, version, checksum FROM claudian_cloud.schema_metadata',
      );
      if (!isCurrentPostgresSchema(existing.rows)) fail('schema-incompatible');
      return Object.freeze({
        currentVersion: CURRENT_POSTGRES_SCHEMA.version,
        targetVersion: CURRENT_POSTGRES_SCHEMA.version,
      });
    } catch (error: unknown) {
      if (error instanceof PostgresSchemaError) throw error;
      throw new PostgresSchemaError('migration-failed');
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (locked) {
        try {
          await client.query(
            'SELECT pg_advisory_unlock($1::integer, $2::integer)',
            [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY],
          );
        } catch {
          // Ending the client releases the session-scoped migration lock.
        }
      }
      await close();
    }
  }

  async apply(signal?: AbortSignal): Promise<void> {
    await this.#run(true, signal);
  }

  preflight(signal?: AbortSignal): Promise<PostgresSchemaPlan> {
    return this.#run(false, signal);
  }
}
