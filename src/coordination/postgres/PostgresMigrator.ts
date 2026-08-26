import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Client } from 'pg';

import {
  ACCEPT_RECOVERY_SCHEMA,
  COLLABORATION_SCHEMA,
  DEVELOPMENT_BOOTSTRAP_SCHEMA,
  FOUNDATION_SCHEMA,
  LAN_TO_CLOUD_TRANSFER_SCHEMA,
  PORTABILITY_LIFECYCLE_SCHEMA,
  PROJECT_READ_EVENTS_SCHEMA,
} from './PostgresSchema.js';

export type PostgresMigrationErrorCode =
  | 'migration-failed'
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
    return Object.freeze({
      checksum,
      name: resource.name,
      sql,
      version: resource.version,
    });
  }));
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

  try {
    await client.query('BEGIN');
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

export class PostgresMigrator {
  readonly #connectionString: string;

  constructor(options: PostgresMigratorOptions) {
    this.#connectionString = options.connectionString;
  }

  async apply(): Promise<void> {
    const client = new Client({ connectionString: this.#connectionString });
    let connected = false;
    let locked = false;
    try {
      const migrations = await loadMigrations();
      await client.connect();
      connected = true;
      await verifyMigrationRole(client);
      await client.query(
        'SELECT pg_advisory_lock($1::integer, $2::integer)',
        [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY],
      );
      locked = true;
      await client.query(METADATA_SQL);
      const existing = await client.query<MigrationRow>(
        `SELECT version, name, checksum, state
           FROM claudian_cloud.schema_migrations
          ORDER BY version`,
      );
      const nextVersion = verifyAppliedMigrations(existing.rows, migrations);
      for (const migration of migrations) {
        if (migration.version >= nextVersion) {
          await applyMigration(client, migration);
        }
      }
    } catch (error: unknown) {
      if (error instanceof PostgresMigrationError) throw error;
      throw new PostgresMigrationError('migration-failed');
    } finally {
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
        try {
          await client.end();
        } catch {
          // No raw connection failure may cross the migration boundary.
        }
      }
    }
  }
}
