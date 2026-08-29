import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Client } from 'pg';

import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../../config/PostgresSchemaCompatibility.js';
import {
  ACCEPT_RECOVERY_SCHEMA,
  CLOUD_TO_LAN_TRANSFER_SCHEMA,
  COLLABORATION_SCHEMA,
  DEVELOPMENT_BOOTSTRAP_SCHEMA,
  FOUNDATION_SCHEMA,
  LAN_TO_CLOUD_TRANSFER_SCHEMA,
  PORTABILITY_LIFECYCLE_SCHEMA,
  PROJECT_READ_EVENTS_SCHEMA,
  TERMINAL_CONTINUITY_CATALOG_SCHEMA,
  TERMINAL_PROJECT_LIFECYCLE_SCHEMA,
} from './PostgresSchema.js';

export type PostgresMigrationErrorCode =
  | 'migration-failed'
  | 'migration-nontransactional'
  | 'migration-role-mismatch'
  | 'schema-dirty'
  | 'schema-drift'
  | 'schema-gap'
  | 'schema-newer';

export class PostgresMigrationError extends Error {
  readonly code: PostgresMigrationErrorCode;
  readonly version: number | undefined;

  constructor(code: PostgresMigrationErrorCode, version?: number) {
    super(`postgres.migration.error.${code}`);
    this.name = 'PostgresMigrationError';
    this.code = code;
    this.version = version;
  }

  toJSON(): Readonly<Record<string, number | string>> {
    return this.version === undefined
      ? Object.freeze({
        code: this.code,
        message: this.message,
        name: this.name,
      })
      : Object.freeze({
        code: this.code,
        message: this.message,
        name: this.name,
        version: this.version,
      });
  }
}

export interface PostgresMigratorOptions {
  readonly connectionString: string;
}

export interface PostgresMigrationPlan {
  readonly currentVersion: number;
  readonly targetVersion: number;
}

interface MigrationDefinition {
  readonly checksum: string;
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}

interface MigrationRow {
  readonly checksum: string;
  readonly name: string;
  readonly state: string;
  readonly version: number;
}

const MIGRATION_ROLE = 'claudian_cloud_migration';
const MIGRATION_LOCK_NAMESPACE = 1_665_883_532;
const MIGRATION_LOCK_KEY = 1;
const MIGRATION_DEPENDENCY_TIMEOUT_MS = 300_000;

function migrationStatementTokens(sql: string): readonly (readonly string[])[] {
  const statements: string[][] = [];
  let statement: string[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const character = sql[offset];
    const next = sql[offset + 1];
    if (character === '-' && next === '-') {
      offset += 2;
      while (offset < sql.length && sql[offset] !== '\n') offset += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      offset += 2;
      let depth = 1;
      while (offset < sql.length && depth > 0) {
        if (sql[offset] === '/' && sql[offset + 1] === '*') {
          depth += 1;
          offset += 2;
        } else if (sql[offset] === '*' && sql[offset + 1] === '/') {
          depth -= 1;
          offset += 2;
        } else {
          offset += 1;
        }
      }
      continue;
    }
    if (character === '\'' || character === '"') {
      const quote = character;
      offset += 1;
      while (offset < sql.length) {
        if (sql[offset] !== quote) {
          offset += 1;
          continue;
        }
        if (sql[offset + 1] === quote) {
          offset += 2;
          continue;
        }
        offset += 1;
        break;
      }
      continue;
    }
    if (character === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/
        .exec(sql.slice(offset))?.[0];
      if (delimiter !== undefined) {
        const end = sql.indexOf(delimiter, offset + delimiter.length);
        offset = end === -1 ? sql.length : end + delimiter.length;
        continue;
      }
    }
    if (character === ';') {
      if (statement.length > 0) statements.push(statement);
      statement = [];
      offset += 1;
      continue;
    }
    if (character !== undefined && /[A-Za-z_]/.test(character)) {
      const start = offset;
      offset += 1;
      while (offset < sql.length && /[A-Za-z0-9_$]/.test(sql[offset] ?? '')) {
        offset += 1;
      }
      statement.push(sql.slice(start, offset).toUpperCase());
      continue;
    }
    offset += 1;
  }
  if (statement.length > 0) statements.push(statement);
  return statements;
}

function startsWithTokens(
  statement: readonly string[],
  ...prefix: readonly string[]
): boolean {
  return prefix.every((token, index) => statement[index] === token);
}

export function assertTransactionalMigrationSql(
  sql: string,
  version: number,
): void {
  for (const statement of migrationStatementTokens(sql)) {
    const first = statement[0];
    const transactionControl = first === 'BEGIN'
      || first === 'COMMIT'
      || first === 'END'
      || first === 'ROLLBACK'
      || first === 'ABORT'
      || first === 'SAVEPOINT'
      || startsWithTokens(statement, 'START', 'TRANSACTION')
      || (first === 'SET' && statement.includes('TRANSACTION'))
      || startsWithTokens(statement, 'RELEASE', 'SAVEPOINT')
      || startsWithTokens(statement, 'PREPARE', 'TRANSACTION');
    const nontransactional = first === 'VACUUM'
      || first === 'CHECKPOINT'
      || first === 'DISCARD'
      || startsWithTokens(statement, 'ALTER', 'SYSTEM')
      || startsWithTokens(statement, 'CREATE', 'DATABASE')
      || startsWithTokens(statement, 'DROP', 'DATABASE')
      || startsWithTokens(statement, 'CREATE', 'TABLESPACE')
      || startsWithTokens(statement, 'DROP', 'TABLESPACE')
      || startsWithTokens(statement, 'CREATE', 'SUBSCRIPTION')
      || startsWithTokens(statement, 'DROP', 'SUBSCRIPTION')
      || (
        first === 'CREATE'
        && statement.includes('INDEX')
        && statement.includes('CONCURRENTLY')
      )
      || (
        startsWithTokens(statement, 'DROP', 'INDEX')
        && statement.includes('CONCURRENTLY')
      )
      || first === 'REINDEX'
      || first === 'CLUSTER';
    if (transactionControl || nontransactional) {
      fail('migration-nontransactional', version);
    }
  }
}

const MIGRATION_RESOURCES = Object.freeze([
  Object.freeze({
    checksum: FOUNDATION_SCHEMA.checksum,
    name: FOUNDATION_SCHEMA.name,
    resource: new URL('./migrations/0001_foundation.sql', import.meta.url),
    version: FOUNDATION_SCHEMA.version,
  }),
  Object.freeze({
    checksum: DEVELOPMENT_BOOTSTRAP_SCHEMA.checksum,
    name: DEVELOPMENT_BOOTSTRAP_SCHEMA.name,
    resource: new URL(
      './migrations/0002_development_bootstrap.sql',
      import.meta.url,
    ),
    version: DEVELOPMENT_BOOTSTRAP_SCHEMA.version,
  }),
  Object.freeze({
    checksum: PROJECT_READ_EVENTS_SCHEMA.checksum,
    name: PROJECT_READ_EVENTS_SCHEMA.name,
    resource: new URL(
      './migrations/0003_project_read_events.sql',
      import.meta.url,
    ),
    version: PROJECT_READ_EVENTS_SCHEMA.version,
  }),
  Object.freeze({
    checksum: COLLABORATION_SCHEMA.checksum,
    name: COLLABORATION_SCHEMA.name,
    resource: new URL(
      './migrations/0004_collaboration.sql',
      import.meta.url,
    ),
    version: COLLABORATION_SCHEMA.version,
  }),
  Object.freeze({
    checksum: ACCEPT_RECOVERY_SCHEMA.checksum,
    name: ACCEPT_RECOVERY_SCHEMA.name,
    resource: new URL(
      './migrations/0005_accept_recovery.sql',
      import.meta.url,
    ),
    version: ACCEPT_RECOVERY_SCHEMA.version,
  }),
  Object.freeze({
    checksum: PORTABILITY_LIFECYCLE_SCHEMA.checksum,
    name: PORTABILITY_LIFECYCLE_SCHEMA.name,
    resource: new URL(
      './migrations/0006_portability_lifecycle.sql',
      import.meta.url,
    ),
    version: PORTABILITY_LIFECYCLE_SCHEMA.version,
  }),
  Object.freeze({
    checksum: LAN_TO_CLOUD_TRANSFER_SCHEMA.checksum,
    name: LAN_TO_CLOUD_TRANSFER_SCHEMA.name,
    resource: new URL(
      './migrations/0007_lan_to_cloud_transfer.sql',
      import.meta.url,
    ),
    version: LAN_TO_CLOUD_TRANSFER_SCHEMA.version,
  }),
  Object.freeze({
    checksum: CLOUD_TO_LAN_TRANSFER_SCHEMA.checksum,
    name: CLOUD_TO_LAN_TRANSFER_SCHEMA.name,
    resource: new URL(
      './migrations/0008_cloud_to_lan_transfer.sql',
      import.meta.url,
    ),
    version: CLOUD_TO_LAN_TRANSFER_SCHEMA.version,
  }),
  Object.freeze({
    checksum: TERMINAL_PROJECT_LIFECYCLE_SCHEMA.checksum,
    name: TERMINAL_PROJECT_LIFECYCLE_SCHEMA.name,
    resource: new URL(
      './migrations/0009_terminal_project_lifecycle.sql',
      import.meta.url,
    ),
    version: TERMINAL_PROJECT_LIFECYCLE_SCHEMA.version,
  }),
  Object.freeze({
    checksum: TERMINAL_CONTINUITY_CATALOG_SCHEMA.checksum,
    name: TERMINAL_CONTINUITY_CATALOG_SCHEMA.name,
    resource: new URL(
      './migrations/0010_terminal_continuity_catalog.sql',
      import.meta.url,
    ),
    version: TERMINAL_CONTINUITY_CATALOG_SCHEMA.version,
  }),
]);

const METADATA_SQL = `
CREATE SCHEMA IF NOT EXISTS claudian_cloud AUTHORIZATION claudian_cloud_migration;
REVOKE ALL ON SCHEMA claudian_cloud FROM PUBLIC;
GRANT USAGE ON SCHEMA claudian_cloud TO claudian_cloud_runtime;

CREATE TABLE IF NOT EXISTS claudian_cloud.schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  state text NOT NULL,
  applied_at timestamptz,
  CONSTRAINT schema_migrations_version CHECK (version > 0),
  CONSTRAINT schema_migrations_name CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT schema_migrations_checksum CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT schema_migrations_state CHECK (state IN ('applying', 'applied')),
  CONSTRAINT schema_migrations_applied_at CHECK (
    (state = 'applying' AND applied_at IS NULL)
    OR (state = 'applied' AND applied_at IS NOT NULL)
  )
);

REVOKE ALL ON claudian_cloud.schema_migrations FROM PUBLIC;
GRANT SELECT ON claudian_cloud.schema_migrations TO claudian_cloud_runtime;
`;

async function loadMigrations(): Promise<readonly MigrationDefinition[]> {
  const migrations = await Promise.all(MIGRATION_RESOURCES.map(async resource => {
    const sql = await readFile(resource.resource, 'utf8');
    const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
    if (checksum !== resource.checksum) {
      fail('schema-drift', resource.version);
    }
    assertTransactionalMigrationSql(sql, resource.version);
    return Object.freeze({
      checksum,
      name: resource.name,
      sql,
      version: resource.version,
    });
  }));
  if (
    migrations.length !== CURRENT_POSTGRES_SCHEMA_VERSION
    || migrations.at(-1)?.version !== CURRENT_POSTGRES_SCHEMA_VERSION
  ) {
    fail('schema-drift');
  }
  return Object.freeze(migrations);
}

function fail(code: PostgresMigrationErrorCode, version?: number): never {
  throw new PostgresMigrationError(code, version);
}

async function verifyMigrationRole(client: Client): Promise<void> {
  const result = await client.query<{ readonly role_name: string }>(
    'SELECT current_user AS role_name',
  );
  if (result.rows[0]?.role_name !== MIGRATION_ROLE) {
    fail('migration-role-mismatch');
  }
}

function verifyAppliedMigrations(
  rows: readonly MigrationRow[],
  migrations: readonly MigrationDefinition[],
): number {
  let expectedVersion = 1;
  for (const row of rows) {
    if (row.state !== 'applied') fail('schema-dirty', row.version);
    if (row.version !== expectedVersion) fail('schema-gap', row.version);
    if (row.version > migrations.length) fail('schema-newer', row.version);
    const expected = migrations[row.version - 1];
    if (
      expected === undefined
      || row.name !== expected.name
      || row.checksum !== expected.checksum
    ) {
      fail('schema-drift', row.version);
    }
    expectedVersion += 1;
  }
  return expectedVersion;
}

async function applyMigration(
  client: Client,
  migration: MigrationDefinition,
): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO claudian_cloud.schema_migrations (
         version,
         name,
         checksum,
         state,
         applied_at
       ) VALUES ($1, $2, $3, 'applying', NULL)`,
      [migration.version, migration.name, migration.checksum],
    );
    await client.query(migration.sql);
    await client.query(
      `UPDATE claudian_cloud.schema_migrations
          SET state = 'applied', applied_at = clock_timestamp()
        WHERE version = $1 AND state = 'applying'`,
      [migration.version],
    );
    await client.query('COMMIT');
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Closing the client releases any transaction still owned by the session.
    }
    fail('migration-failed', migration.version);
  }
}

async function ensureMigrationMetadata(client: Client): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query(METADATA_SQL);
    await client.query('COMMIT');
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Closing the client releases any transaction still owned by the session.
    }
    fail('migration-failed');
  }
}

async function readMigrationRows(
  client: Client,
  allowAbsent: boolean,
): Promise<readonly MigrationRow[]> {
  const metadata = await client.query<{
    readonly migration_relation: string | null;
    readonly schema_name: string | null;
  }>(
    `SELECT to_regnamespace('claudian_cloud')::text AS schema_name,
            to_regclass('claudian_cloud.schema_migrations')::text
              AS migration_relation`,
  );
  const state = metadata.rows[0];
  if (state?.schema_name === null) {
    if (allowAbsent) return Object.freeze([]);
    fail('schema-drift');
  }
  if (state?.migration_relation === null) fail('schema-drift');
  const existing = await client.query<MigrationRow>(
    `SELECT version, name, checksum, state
       FROM claudian_cloud.schema_migrations
      ORDER BY version`,
  );
  return existing.rows;
}

export class PostgresMigrator {
  readonly #connectionString: string;

  constructor(options: PostgresMigratorOptions) {
    this.#connectionString = options.connectionString;
  }

  async #run(
    apply: boolean,
    signal?: AbortSignal,
    targetVersion = CURRENT_POSTGRES_SCHEMA_VERSION,
  ): Promise<PostgresMigrationPlan> {
    const client = new Client({
      application_name: 'claudian-cloud-migration',
      connectionString: this.#connectionString,
      connectionTimeoutMillis: MIGRATION_DEPENDENCY_TIMEOUT_MS,
      idle_in_transaction_session_timeout: MIGRATION_DEPENDENCY_TIMEOUT_MS,
      lock_timeout: MIGRATION_DEPENDENCY_TIMEOUT_MS,
      query_timeout: MIGRATION_DEPENDENCY_TIMEOUT_MS,
      statement_timeout: MIGRATION_DEPENDENCY_TIMEOUT_MS,
    });
    let connected = false;
    let locked = false;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= client.end().catch(() => undefined);
      return closePromise;
    };
    const assertActive = (): void => {
      if (signal?.aborted === true) {
        throw new PostgresMigrationError('migration-failed');
      }
    };
    const onAbort = (): void => { void close(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    try {
      const allMigrations = await loadMigrations();
      if (
        !Number.isSafeInteger(targetVersion)
        || targetVersion < 1
        || targetVersion > CURRENT_POSTGRES_SCHEMA_VERSION
      ) fail('schema-drift');
      const migrations = allMigrations.filter(
        migration => migration.version <= targetVersion,
      );
      assertActive();
      await client.connect();
      connected = true;
      assertActive();
      await verifyMigrationRole(client);
      await client.query(
        'SELECT pg_advisory_lock($1::integer, $2::integer)',
        [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY],
      );
      locked = true;
      assertActive();
      if (apply) await ensureMigrationMetadata(client);
      const existing = await readMigrationRows(client, !apply);
      const nextVersion = verifyAppliedMigrations(existing, migrations);
      const currentVersion = nextVersion - 1;
      if (apply) {
        for (const migration of migrations) {
          if (migration.version >= nextVersion) {
            assertActive();
            await applyMigration(client, migration);
          }
        }
      }
      return Object.freeze({
        currentVersion: apply
          ? targetVersion
          : currentVersion,
        targetVersion,
      });
    } catch (error: unknown) {
      if (error instanceof PostgresMigrationError) throw error;
      throw new PostgresMigrationError('migration-failed');
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
      if (connected) {
        await close();
      }
    }
  }

  async apply(signal?: AbortSignal): Promise<void> {
    await this.#run(true, signal);
  }

  async applyThrough(
    targetVersion: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#run(true, signal, targetVersion);
  }

  preflight(signal?: AbortSignal): Promise<PostgresMigrationPlan> {
    return this.#run(false, signal);
  }
}
