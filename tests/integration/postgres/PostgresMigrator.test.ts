import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import {
  PostgresMigrationError,
  PostgresMigrator,
} from '../../../src/coordination/postgres/PostgresMigrator.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const FOUNDATION_CHECKSUM = '895f241bb48e4d7f99e55061118739585c42f0bfb90f30e6068198ac1e9efda2';

async function execute(connectionString: string, sql: string): Promise<void> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function expectMigrationError(
  migrator: PostgresMigrator,
  code: PostgresMigrationError['code'],
  version?: number,
): Promise<void> {
  await assert.rejects(
    migrator.apply(),
    error => {
      assert.ok(error instanceof PostgresMigrationError);
      assert.equal(error.code, code);
      assert.equal(error.version, version);
      assert.doesNotMatch(JSON.stringify(error), /postgresql:|CREATE TABLE|duplicate/i);
      return true;
    },
  );
}

async function verifyMigrationFailureState(database: PostgresTestDatabase): Promise<void> {
  const migrator = new PostgresMigrator({ connectionString: database.migrationUrl });

  await expectMigrationError(
    new PostgresMigrator({ connectionString: database.adminUrl }),
    'migration-role-mismatch',
  );

  await execute(
    database.migrationUrl,
    `CREATE SCHEMA claudian_cloud AUTHORIZATION claudian_cloud_migration;
     CREATE TABLE claudian_cloud.projects (conflict integer);`,
  );
  await expectMigrationError(migrator, 'migration-failed', 1);

  const dirtyClient = new Client({ connectionString: database.migrationUrl });
  try {
    await dirtyClient.connect();
    const result = await dirtyClient.query<{
      readonly applied_at: Date | null;
      readonly state: string;
    }>(
      `SELECT state, applied_at
         FROM claudian_cloud.schema_migrations
        WHERE version = 1`,
    );
    assert.deepEqual(result.rows, [{ applied_at: null, state: 'applying' }]);
  } finally {
    await dirtyClient.end();
  }

  await expectMigrationError(migrator, 'schema-dirty', 1);
  await execute(database.migrationUrl, 'DROP SCHEMA claudian_cloud CASCADE');
}

async function verifyMigrationHistory(database: PostgresTestDatabase): Promise<void> {
  const migrator = new PostgresMigrator({ connectionString: database.migrationUrl });
  await migrator.apply();
  await migrator.apply();

  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    const migration = await client.query<{
      readonly checksum: string;
      readonly name: string;
      readonly state: string;
      readonly version: number;
    }>(
      `SELECT version, name, checksum, state
         FROM claudian_cloud.schema_migrations
        ORDER BY version`,
    );
    assert.deepEqual(migration.rows, [{
      checksum: FOUNDATION_CHECKSUM,
      name: 'foundation',
      state: 'applied',
      version: 1,
    }]);

    const relations = await client.query<{ readonly relation: string }>(
      `SELECT table_name AS relation
         FROM information_schema.tables
        WHERE table_schema = 'claudian_cloud'
        ORDER BY table_name`,
    );
    assert.deepEqual(
      relations.rows.map(row => row.relation),
      [
        'project_memberships',
        'projects',
        'repository_placements',
        'schema_migrations',
      ],
    );

    await client.query(
      `UPDATE claudian_cloud.schema_migrations
          SET checksum = repeat('0', 64)
        WHERE version = 1`,
    );
    await expectMigrationError(migrator, 'schema-drift', 1);
    await client.query(
      `UPDATE claudian_cloud.schema_migrations
          SET checksum = $1
        WHERE version = 1`,
      [FOUNDATION_CHECKSUM],
    );

    await client.query(
      `INSERT INTO claudian_cloud.schema_migrations
        (version, name, checksum, state, applied_at)
       VALUES (2, 'unexpected', repeat('1', 64), 'applied', clock_timestamp())`,
    );
    await expectMigrationError(migrator, 'schema-newer', 2);
    await client.query('DELETE FROM claudian_cloud.schema_migrations WHERE version = 2');

    await client.query('DELETE FROM claudian_cloud.schema_migrations WHERE version = 1');
    await client.query(
      `INSERT INTO claudian_cloud.schema_migrations
        (version, name, checksum, state, applied_at)
       VALUES (2, 'unexpected', repeat('1', 64), 'applied', clock_timestamp())`,
    );
    await expectMigrationError(migrator, 'schema-gap', 2);
    await client.query('DELETE FROM claudian_cloud.schema_migrations WHERE version = 2');
    await client.query(
      `INSERT INTO claudian_cloud.schema_migrations
        (version, name, checksum, state, applied_at)
       VALUES (1, 'foundation', $1, 'applied', clock_timestamp())`,
      [FOUNDATION_CHECKSUM],
    );
  } finally {
    await client.end();
  }
}

async function verifySchemaContract(database: PostgresTestDatabase): Promise<void> {
  const migrationClient = new Client({ connectionString: database.migrationUrl });
  try {
    await migrationClient.connect();
    const rls = await migrationClient.query<{
      readonly forced: boolean;
      readonly relation: string;
      readonly row_security: boolean;
    }>(
      `SELECT c.relname AS relation,
              c.relrowsecurity AS row_security,
              c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'claudian_cloud'
          AND c.relname IN ('projects', 'project_memberships', 'repository_placements')
        ORDER BY c.relname`,
    );
    assert.deepEqual(rls.rows, [
      { forced: true, relation: 'project_memberships', row_security: true },
      { forced: true, relation: 'projects', row_security: true },
      { forced: true, relation: 'repository_placements', row_security: true },
    ]);

    const ownership = await migrationClient.query<{
      readonly owner: string;
      readonly relation: string;
    }>(
      `SELECT c.relname AS relation, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'claudian_cloud'
          AND c.relkind = 'r'
        ORDER BY c.relname`,
    );
    assert.deepEqual(ownership.rows, [
      { owner: 'claudian_cloud_migration', relation: 'project_memberships' },
      { owner: 'claudian_cloud_migration', relation: 'projects' },
      { owner: 'claudian_cloud_migration', relation: 'repository_placements' },
      { owner: 'claudian_cloud_migration', relation: 'schema_migrations' },
    ]);

    const schemaPrivileges = await migrationClient.query<{
      readonly can_create: boolean;
      readonly can_use: boolean;
      readonly owner: string;
    }>(
      `SELECT pg_get_userbyid(n.nspowner) AS owner,
              has_schema_privilege(
                'claudian_cloud_runtime', n.oid, 'USAGE'
              ) AS can_use,
              has_schema_privilege(
                'claudian_cloud_runtime', n.oid, 'CREATE'
              ) AS can_create
         FROM pg_namespace n
        WHERE n.nspname = 'claudian_cloud'`,
    );
    assert.deepEqual(schemaPrivileges.rows, [{
      can_create: false,
      can_use: true,
      owner: 'claudian_cloud_migration',
    }]);

    const tablePrivileges = await migrationClient.query<{
      readonly privilege: string;
      readonly relation: string;
    }>(
      `SELECT table_name AS relation, privilege_type AS privilege
         FROM information_schema.table_privileges
        WHERE table_schema = 'claudian_cloud'
          AND grantee = 'claudian_cloud_runtime'
        ORDER BY table_name, privilege_type`,
    );
    assert.deepEqual(tablePrivileges.rows, [
      { privilege: 'DELETE', relation: 'project_memberships' },
      { privilege: 'INSERT', relation: 'project_memberships' },
      { privilege: 'SELECT', relation: 'project_memberships' },
      { privilege: 'UPDATE', relation: 'project_memberships' },
      { privilege: 'DELETE', relation: 'projects' },
      { privilege: 'INSERT', relation: 'projects' },
      { privilege: 'SELECT', relation: 'projects' },
      { privilege: 'UPDATE', relation: 'projects' },
      { privilege: 'DELETE', relation: 'repository_placements' },
      { privilege: 'INSERT', relation: 'repository_placements' },
      { privilege: 'SELECT', relation: 'repository_placements' },
      { privilege: 'UPDATE', relation: 'repository_placements' },
      { privilege: 'SELECT', relation: 'schema_migrations' },
    ]);

    const policies = await migrationClient.query<{
      readonly policy_name: string;
      readonly relation: string;
    }>(
      `SELECT tablename AS relation, policyname AS policy_name
         FROM pg_policies
        WHERE schemaname = 'claudian_cloud'
        ORDER BY tablename`,
    );
    assert.deepEqual(policies.rows, [
      {
        policy_name: 'project_memberships_project_scope',
        relation: 'project_memberships',
      },
      { policy_name: 'projects_project_scope', relation: 'projects' },
      {
        policy_name: 'repository_placements_project_scope',
        relation: 'repository_placements',
      },
    ]);

    for (const projectId of ['project-a', 'project-b']) {
      await migrationClient.query('BEGIN');
      await migrationClient.query(
        "SELECT set_config('claudian_cloud.project_id', $1, true)",
        [projectId],
      );
      await migrationClient.query(
        `INSERT INTO claudian_cloud.projects (project_id, created_at)
         VALUES ($1, clock_timestamp())`,
        [projectId],
      );
      await migrationClient.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, role, status, revision, created_at, updated_at
         ) VALUES ($1, 'overlapping-member', 'member', 'active', 1, clock_timestamp(), clock_timestamp())`,
        [projectId],
      );
      await migrationClient.query('COMMIT');
    }

    await migrationClient.query('BEGIN');
    await migrationClient.query(
      "SELECT set_config('claudian_cloud.project_id', 'project-a', true)",
    );
    await assert.rejects(
      migrationClient.query(
        `INSERT INTO claudian_cloud.repository_placements (
           project_id, storage_node_id, repository_storage_key, generation,
           active, created_at, updated_at
         ) VALUES ('project-a', 'node-a', 'storage-a', 0, true, clock_timestamp(), clock_timestamp())`,
      ),
      /repository_placements_generation/,
    );
    await migrationClient.query('ROLLBACK');
  } finally {
    await migrationClient.end();
  }

  const runtimeClient = new Client({ connectionString: database.runtimeUrl });
  try {
    await runtimeClient.connect();
    const unscoped = await runtimeClient.query(
      'SELECT project_id FROM claudian_cloud.projects',
    );
    assert.deepEqual(unscoped.rows, []);

    await runtimeClient.query('BEGIN');
    await runtimeClient.query(
      "SELECT set_config('claudian_cloud.project_id', 'project-a', true)",
    );
    const scoped = await runtimeClient.query<{ readonly project_id: string }>(
      'SELECT project_id FROM claudian_cloud.projects ORDER BY project_id',
    );
    assert.deepEqual(scoped.rows, [{ project_id: 'project-a' }]);
    await runtimeClient.query('COMMIT');

    await assert.rejects(
      runtimeClient.query('ALTER TABLE claudian_cloud.projects DISABLE ROW LEVEL SECURITY'),
      /must be owner|permission denied/i,
    );
    await assert.rejects(
      runtimeClient.query('CREATE TABLE claudian_cloud.forbidden (value integer)'),
      /permission denied/i,
    );
  } finally {
    await runtimeClient.end();
  }

  const adminClient = new Client({ connectionString: database.adminUrl });
  try {
    await adminClient.connect();
    const roles = await adminClient.query<{
      readonly bypass_rls: boolean;
      readonly create_db: boolean;
      readonly create_role: boolean;
      readonly role_name: string;
      readonly superuser: boolean;
    }>(
      `SELECT rolname AS role_name,
              rolsuper AS superuser,
              rolcreatedb AS create_db,
              rolcreaterole AS create_role,
              rolbypassrls AS bypass_rls
         FROM pg_roles
        WHERE rolname IN ('claudian_cloud_migration', 'claudian_cloud_runtime')
        ORDER BY rolname`,
    );
    assert.deepEqual(roles.rows, [
      {
        bypass_rls: false,
        create_db: false,
        create_role: false,
        role_name: 'claudian_cloud_migration',
        superuser: false,
      },
      {
        bypass_rls: false,
        create_db: false,
        create_role: false,
        role_name: 'claudian_cloud_runtime',
        superuser: false,
      },
    ]);
  } finally {
    await adminClient.end();
  }
}

describe('PostgresMigrator', () => {
  it('fails closed and establishes the PostgreSQL 18 authority schema', async () => {
    await withPostgresTestDatabase(async database => {
      await verifyMigrationFailureState(database);
      await verifyMigrationHistory(database);
      await verifySchemaContract(database);
    }, {});
  });

  it('sanitizes connection failures', async () => {
    const credential = 'migration-secret-sentinel';
    const migrator = new PostgresMigrator({
      connectionString: `postgresql://migration:${credential}@127.0.0.1:1/cloud`,
    });
    await assert.rejects(
      migrator.apply(),
      error => {
        assert.ok(error instanceof PostgresMigrationError);
        assert.equal(error.code, 'migration-failed');
        assert.doesNotMatch(JSON.stringify(error), new RegExp(credential));
        assert.doesNotMatch(String(error), /ECONNREFUSED|127\.0\.0\.1/);
        return true;
      },
    );
  });
});
