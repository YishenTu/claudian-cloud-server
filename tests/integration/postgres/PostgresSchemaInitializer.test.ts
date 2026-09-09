import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import {
  PostgresSchemaError,
  PostgresSchemaInitializer,
} from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const CURRENT_CHECKSUM = 'fb19a46a46b4d6ae644cb05d6b2df9d2c21afe0353cb4fc107231d469ee65c94';

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
  migrator: PostgresSchemaInitializer,
  code: PostgresSchemaError['code'],
): Promise<void> {
  await assert.rejects(
    migrator.apply(),
    error => {
      assert.ok(error instanceof PostgresSchemaError);
      assert.equal(error.code, code);
      assert.doesNotMatch(JSON.stringify(error), /postgresql:|CREATE TABLE|duplicate/i);
      return true;
    },
  );
}

async function verifyUnmanagedSchemaRejection(database: PostgresTestDatabase): Promise<void> {
  const migrator = new PostgresSchemaInitializer({ connectionString: database.migrationUrl });

  await expectMigrationError(
    new PostgresSchemaInitializer({ connectionString: database.adminUrl }),
    'migration-role-mismatch',
  );

  await execute(
    database.migrationUrl,
    `CREATE SCHEMA claudian_cloud AUTHORIZATION claudian_cloud_migration;
     CREATE TABLE claudian_cloud.projects (conflict integer);`,
  );
  await expectMigrationError(migrator, 'schema-incompatible');

  const dirtyClient = new Client({ connectionString: database.migrationUrl });
  try {
    await dirtyClient.connect();
    const result = await dirtyClient.query<{ readonly relation: string | null }>(
      `SELECT to_regclass(
         'claudian_cloud.schema_metadata'
       )::text AS relation`,
    );
    assert.deepEqual(result.rows, [{ relation: null }]);
  } finally {
    await dirtyClient.end();
  }

  await expectMigrationError(migrator, 'schema-incompatible');
  await execute(database.migrationUrl, 'DROP SCHEMA claudian_cloud CASCADE');
}

async function verifyCurrentSchema(database: PostgresTestDatabase): Promise<void> {
  const migrator = new PostgresSchemaInitializer({ connectionString: database.migrationUrl });
  await migrator.apply();
  await migrator.apply();

  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    const metadata = await client.query<{ readonly singleton: boolean; readonly version: number; readonly checksum: string; readonly transaction: string }>('SELECT singleton, version, checksum, xmin::text AS transaction FROM claudian_cloud.schema_metadata');
    const transaction = metadata.rows[0]?.transaction;
    assert.deepEqual(metadata.rows, [{ singleton: true, version: 12, checksum: CURRENT_CHECKSUM, transaction }]);
    await migrator.preflight();
    await migrator.apply();
    assert.deepEqual((await client.query('SELECT xmin::text AS transaction FROM claudian_cloud.schema_metadata')).rows, [{ transaction }]);

    const relations = await client.query<{ readonly relation: string }>(
      `SELECT table_name AS relation
         FROM information_schema.tables
        WHERE table_schema = 'claudian_cloud'
        ORDER BY table_name`,
    );
    assert.deepEqual(
      relations.rows.map(row => row.relation),
      [
        'accept_journal_relations',
        'accept_journals',
        'active_repository_placement_catalog',
        'authority_transfer_recovery',
        'change_requests',
        'cloud_project_creation_journals',
        'cloud_project_join_journals',
        'development_actor_mappings',
        'development_bootstrap_attempt_routes',
        'development_bootstrap_attempts',
        'development_bootstrap_expiry_candidates',
        'development_bootstrap_reports',
        'development_bootstrap_settlements',
        'development_bootstrap_uploads',
        'idempotency_results',
        'leave_former_principal_replays',
        'leave_project_request_facts',
        'manager_responsibility_offers',
        'project_backup_catalog',
        'project_deletion_intents',
        'project_event_sequences',
        'project_events',
        'project_invitations',
        'project_lifecycle_journals',
        'project_member_removal_journals',
        'project_membership_idempotency_tombstones',
        'project_memberships',
        'project_principal_bindings',
        'project_terminal_acknowledgements',
        'project_terminal_continuity_catalog',
        'project_terminal_responder_catalog',
        'project_terminal_responders',
        'project_tombstones',
        'projects',
        'protected_claim_override_envelopes',
        'protected_invitation_envelopes',
        'recovery_candidates',
        'repository_placements',
        'request_comments',
        'request_ticket_relations',
        'schema_metadata',
        'secret_replay_tombstones',
        'source_protected_claim_envelopes',
        'ticket_comments',
        'ticket_mentions',
        'tickets',
        'transfer_claim_batch_receipts',
        'transfer_receipt_keys',
        'transfer_redemption_receipts',
        'transferred_membership_claim_overrides',
        'transferred_membership_claims',
      ],
    );

    await client.query(
      `SELECT set_config(
         'claudian_cloud.project_id',
         'project-invalid-terminal',
         false
       )`,
    );
    await assert.rejects(client.query(
      `INSERT INTO claudian_cloud.project_terminal_responders (
         project_id, operation_kind, operation_id, response_sha256,
         response_json, expires_at, created_at, updated_at,
         replay_member_id, replay_request_sha256
       ) VALUES (
         'project-invalid-terminal', 'authority-transfer', 'transfer-invalid',
         repeat('1', 64), '{}', '2026-09-01T00:00:00.000Z',
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL, NULL
       )`,
    ), (error: unknown) => {
      assert.equal(
        (error as Readonly<{ readonly constraint?: unknown }>).constraint,
        'project_terminal_responders_replay',
      );
      return true;
    });

    for (const update of [
      "SET checksum = repeat('0', 64)",
      'SET version = 10',
      'SET version = 13',
    ]) {
      await client.query(`UPDATE claudian_cloud.schema_metadata ${update}`);
      await expectMigrationError(migrator, 'schema-incompatible');
      await assert.rejects(migrator.preflight(), { code: 'schema-incompatible' });
      await client.query('UPDATE claudian_cloud.schema_metadata SET version = 12, checksum = $1', [CURRENT_CHECKSUM]);
    }
    await client.query('DELETE FROM claudian_cloud.schema_metadata');
    await expectMigrationError(migrator, 'schema-incompatible');
    await client.query('INSERT INTO claudian_cloud.schema_metadata VALUES (true, 12, $1)', [CURRENT_CHECKSUM]);
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
          AND c.relname IN (
            'authority_transfer_recovery',
            'cloud_project_creation_journals',
            'cloud_project_join_journals',
            'leave_former_principal_replays',
            'leave_project_request_facts',
            'manager_responsibility_offers',
            'project_event_sequences',
            'project_events',
            'project_invitations',
            'project_lifecycle_journals',
            'project_member_removal_journals',
            'project_membership_idempotency_tombstones',
            'projects',
            'project_memberships',
            'project_principal_bindings',
            'project_terminal_acknowledgements',
            'project_terminal_responders',
            'project_tombstones',
            'project_deletion_intents',
            'project_backup_catalog',
            'protected_claim_override_envelopes',
            'protected_invitation_envelopes',
            'secret_replay_tombstones',
            'source_protected_claim_envelopes',
            'transfer_claim_batch_receipts',
            'transfer_receipt_keys',
            'transfer_redemption_receipts',
            'transferred_membership_claim_overrides',
            'transferred_membership_claims',
            'repository_placements'
          )
        ORDER BY c.relname`,
    );
    assert.deepEqual(rls.rows, [
      { forced: true, relation: 'authority_transfer_recovery', row_security: true },
      { forced: true, relation: 'cloud_project_creation_journals', row_security: true },
      { forced: true, relation: 'cloud_project_join_journals', row_security: true },
      { forced: true, relation: 'leave_former_principal_replays', row_security: true },
      { forced: true, relation: 'leave_project_request_facts', row_security: true },
      { forced: true, relation: 'manager_responsibility_offers', row_security: true },
      { forced: true, relation: 'project_backup_catalog', row_security: true },
      { forced: true, relation: 'project_deletion_intents', row_security: true },
      { forced: true, relation: 'project_event_sequences', row_security: true },
      { forced: true, relation: 'project_events', row_security: true },
      { forced: true, relation: 'project_invitations', row_security: true },
      { forced: true, relation: 'project_lifecycle_journals', row_security: true },
      { forced: true, relation: 'project_member_removal_journals', row_security: true },
      { forced: true, relation: 'project_membership_idempotency_tombstones', row_security: true },
      { forced: true, relation: 'project_memberships', row_security: true },
      { forced: true, relation: 'project_principal_bindings', row_security: true },
      { forced: true, relation: 'project_terminal_acknowledgements', row_security: true },
      { forced: true, relation: 'project_terminal_responders', row_security: true },
      { forced: true, relation: 'project_tombstones', row_security: true },
      { forced: true, relation: 'projects', row_security: true },
      { forced: true, relation: 'protected_claim_override_envelopes', row_security: true },
      { forced: true, relation: 'protected_invitation_envelopes', row_security: true },
      { forced: true, relation: 'repository_placements', row_security: true },
      { forced: true, relation: 'secret_replay_tombstones', row_security: true },
      { forced: true, relation: 'source_protected_claim_envelopes', row_security: true },
      { forced: true, relation: 'transfer_claim_batch_receipts', row_security: true },
      { forced: true, relation: 'transfer_receipt_keys', row_security: true },
      { forced: true, relation: 'transfer_redemption_receipts', row_security: true },
      { forced: true, relation: 'transferred_membership_claim_overrides', row_security: true },
      { forced: true, relation: 'transferred_membership_claims', row_security: true },
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
      { owner: 'claudian_cloud_migration', relation: 'accept_journal_relations' },
      { owner: 'claudian_cloud_migration', relation: 'accept_journals' },
      { owner: 'claudian_cloud_migration', relation: 'active_repository_placement_catalog' },
      { owner: 'claudian_cloud_migration', relation: 'authority_transfer_recovery' },
      { owner: 'claudian_cloud_migration', relation: 'change_requests' },
      { owner: 'claudian_cloud_migration', relation: 'cloud_project_creation_journals' },
      { owner: 'claudian_cloud_migration', relation: 'cloud_project_join_journals' },
      { owner: 'claudian_cloud_migration', relation: 'development_actor_mappings' },
      { owner: 'claudian_cloud_migration', relation: 'development_bootstrap_attempt_routes' },
      { owner: 'claudian_cloud_migration', relation: 'development_bootstrap_attempts' },
      { owner: 'claudian_cloud_migration', relation: 'development_bootstrap_expiry_candidates' },
      { owner: 'claudian_cloud_migration', relation: 'development_bootstrap_reports' },
      { owner: 'claudian_cloud_migration', relation: 'development_bootstrap_settlements' },
      { owner: 'claudian_cloud_migration', relation: 'development_bootstrap_uploads' },
      { owner: 'claudian_cloud_migration', relation: 'idempotency_results' },
      { owner: 'claudian_cloud_migration', relation: 'leave_former_principal_replays' },
      { owner: 'claudian_cloud_migration', relation: 'leave_project_request_facts' },
      { owner: 'claudian_cloud_migration', relation: 'manager_responsibility_offers' },
      { owner: 'claudian_cloud_migration', relation: 'project_backup_catalog' },
      { owner: 'claudian_cloud_migration', relation: 'project_deletion_intents' },
      { owner: 'claudian_cloud_migration', relation: 'project_event_sequences' },
      { owner: 'claudian_cloud_migration', relation: 'project_events' },
      { owner: 'claudian_cloud_migration', relation: 'project_invitations' },
      { owner: 'claudian_cloud_migration', relation: 'project_lifecycle_journals' },
      { owner: 'claudian_cloud_migration', relation: 'project_member_removal_journals' },
      { owner: 'claudian_cloud_migration', relation: 'project_membership_idempotency_tombstones' },
      { owner: 'claudian_cloud_migration', relation: 'project_memberships' },
      { owner: 'claudian_cloud_migration', relation: 'project_principal_bindings' },
      { owner: 'claudian_cloud_migration', relation: 'project_terminal_acknowledgements' },
      { owner: 'claudian_cloud_migration', relation: 'project_terminal_continuity_catalog' },
      { owner: 'claudian_cloud_migration', relation: 'project_terminal_responder_catalog' },
      { owner: 'claudian_cloud_migration', relation: 'project_terminal_responders' },
      { owner: 'claudian_cloud_migration', relation: 'project_tombstones' },
      { owner: 'claudian_cloud_migration', relation: 'projects' },
      { owner: 'claudian_cloud_migration', relation: 'protected_claim_override_envelopes' },
      { owner: 'claudian_cloud_migration', relation: 'protected_invitation_envelopes' },
      { owner: 'claudian_cloud_migration', relation: 'recovery_candidates' },
      { owner: 'claudian_cloud_migration', relation: 'repository_placements' },
      { owner: 'claudian_cloud_migration', relation: 'request_comments' },
      { owner: 'claudian_cloud_migration', relation: 'request_ticket_relations' },
      { owner: 'claudian_cloud_migration', relation: 'schema_metadata' },
      { owner: 'claudian_cloud_migration', relation: 'secret_replay_tombstones' },
      { owner: 'claudian_cloud_migration', relation: 'source_protected_claim_envelopes' },
      { owner: 'claudian_cloud_migration', relation: 'ticket_comments' },
      { owner: 'claudian_cloud_migration', relation: 'ticket_mentions' },
      { owner: 'claudian_cloud_migration', relation: 'tickets' },
      { owner: 'claudian_cloud_migration', relation: 'transfer_claim_batch_receipts' },
      { owner: 'claudian_cloud_migration', relation: 'transfer_receipt_keys' },
      { owner: 'claudian_cloud_migration', relation: 'transfer_redemption_receipts' },
      { owner: 'claudian_cloud_migration', relation: 'transferred_membership_claim_overrides' },
      { owner: 'claudian_cloud_migration', relation: 'transferred_membership_claims' },
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

    const functionPrivileges = await migrationClient.query<{
      readonly name: string;
      readonly owner: string;
      readonly public_can_execute: boolean;
      readonly runtime_can_execute: boolean;
    }>(
      `SELECT p.proname AS name,
              pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege(
                'claudian_cloud_runtime', p.oid, 'EXECUTE'
              ) AS runtime_can_execute,
              EXISTS (
                SELECT 1
                  FROM aclexplode(
                    coalesce(p.proacl, acldefault('f', p.proowner))
                  ) AS acl
                 WHERE acl.grantee = 0
                   AND acl.privilege_type = 'EXECUTE'
              ) AS public_can_execute
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'claudian_cloud'
          AND p.proname IN (
            'register_project_terminal_continuity',
            'remove_project_coordination_content'
          )
        ORDER BY p.proname`,
    );
    assert.deepEqual(functionPrivileges.rows, [
      {
        name: 'register_project_terminal_continuity',
        owner: 'claudian_cloud_migration',
        public_can_execute: false,
        runtime_can_execute: false,
      },
      {
        name: 'remove_project_coordination_content',
        owner: 'claudian_cloud_migration',
        public_can_execute: false,
        runtime_can_execute: true,
      },
    ]);

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
    const privilegesByRelation: Readonly<Record<string, readonly string[]>> = {
      accept_journal_relations: ['INSERT', 'SELECT'],
      accept_journals: ['INSERT', 'SELECT'],
      active_repository_placement_catalog: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      authority_transfer_recovery: ['INSERT', 'SELECT'],
      change_requests: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      cloud_project_creation_journals: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      cloud_project_join_journals: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      development_actor_mappings: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      development_bootstrap_attempts: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      development_bootstrap_expiry_candidates: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      development_bootstrap_reports: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      development_bootstrap_settlements: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      development_bootstrap_uploads: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      idempotency_results: ['DELETE', 'INSERT', 'SELECT'],
      leave_former_principal_replays: ['INSERT', 'SELECT'],
      leave_project_request_facts: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      manager_responsibility_offers: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      project_backup_catalog: ['INSERT', 'SELECT'],
      project_deletion_intents: ['INSERT', 'SELECT'],
      project_event_sequences: ['INSERT', 'SELECT', 'UPDATE'],
      project_events: ['DELETE', 'INSERT', 'SELECT'],
      project_invitations: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      project_lifecycle_journals: ['INSERT', 'SELECT'],
      project_member_removal_journals: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      project_membership_idempotency_tombstones: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      project_memberships: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      project_principal_bindings: ['INSERT', 'SELECT'],
      project_terminal_acknowledgements: ['INSERT', 'SELECT'],
      project_terminal_continuity_catalog: ['SELECT'],
      project_terminal_responder_catalog: ['DELETE', 'INSERT', 'SELECT'],
      project_terminal_responders: ['DELETE', 'INSERT', 'SELECT'],
      project_tombstones: ['INSERT', 'SELECT'],
      projects: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      protected_claim_override_envelopes: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      protected_invitation_envelopes: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      recovery_candidates: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      repository_placements: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      request_comments: ['DELETE', 'INSERT', 'SELECT'],
      request_ticket_relations: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      schema_metadata: ['SELECT'],
      secret_replay_tombstones: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      source_protected_claim_envelopes: ['DELETE', 'INSERT', 'SELECT'],
      ticket_comments: ['DELETE', 'INSERT', 'SELECT'],
      ticket_mentions: ['DELETE', 'INSERT', 'SELECT'],
      tickets: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      transfer_claim_batch_receipts: ['INSERT', 'SELECT'],
      transfer_receipt_keys: ['DELETE', 'INSERT', 'SELECT'],
      transfer_redemption_receipts: ['DELETE', 'INSERT', 'SELECT'],
      transferred_membership_claim_overrides: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      transferred_membership_claims: ['DELETE', 'INSERT', 'SELECT'],
    };
    assert.deepEqual(
      tablePrivileges.rows,
      Object.entries(privilegesByRelation).flatMap(([relation, privileges]) => (
        privileges.map(privilege => ({ privilege, relation }))
      )),
    );

    const columnPrivileges = await migrationClient.query<{
      readonly column_name: string;
      readonly privilege: string;
      readonly relation: string;
    }>(
      `SELECT table_name AS relation, column_name,
              privilege_type AS privilege
         FROM information_schema.column_privileges
        WHERE table_schema = 'claudian_cloud'
          AND grantee = 'claudian_cloud_runtime'
          AND privilege_type = 'UPDATE'
          AND table_name = ANY($1::text[])
        ORDER BY table_name, column_name`,
      [[
        'authority_transfer_recovery',
        'leave_former_principal_replays',
        'project_backup_catalog',
        'project_lifecycle_journals',
        'project_principal_bindings',
        'project_terminal_acknowledgements',
        'transfer_redemption_receipts',
        'transferred_membership_claims',
      ]],
    );
    assert.deepEqual(columnPrivileges.rows, [
      { column_name: 'cancellation_request_sha256', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'expires_at', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'inactive_publication_json', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'relinquishment_proof_json', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'source_proof', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'source_reopen_sha256', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'stage_sha256', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'target_activation_proof', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'target_activation_request_sha256', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'target_proof', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'updated_at', privilege: 'UPDATE', relation: 'authority_transfer_recovery' },
      { column_name: 'completed_at', privilege: 'UPDATE', relation: 'leave_former_principal_replays' },
      { column_name: 'result_sha256', privilege: 'UPDATE', relation: 'leave_former_principal_replays' },
      { column_name: 'state', privilege: 'UPDATE', relation: 'leave_former_principal_replays' },
      { column_name: 'published_at', privilege: 'UPDATE', relation: 'project_backup_catalog' },
      { column_name: 'state', privilege: 'UPDATE', relation: 'project_backup_catalog' },
      { column_name: 'verified_at', privilege: 'UPDATE', relation: 'project_backup_catalog' },
      { column_name: 'batch_revision', privilege: 'UPDATE', relation: 'project_lifecycle_journals' },
      { column_name: 'batch_sha256', privilege: 'UPDATE', relation: 'project_lifecycle_journals' },
      { column_name: 'checkpoint_sha256', privilege: 'UPDATE', relation: 'project_lifecycle_journals' },
      { column_name: 'phase', privilege: 'UPDATE', relation: 'project_lifecycle_journals' },
      { column_name: 'recovery_from_phase', privilege: 'UPDATE', relation: 'project_lifecycle_journals' },
      { column_name: 'result_sha256', privilege: 'UPDATE', relation: 'project_lifecycle_journals' },
      { column_name: 'scheduled_at', privilege: 'UPDATE', relation: 'project_lifecycle_journals' },
      { column_name: 'state', privilege: 'UPDATE', relation: 'project_lifecycle_journals' },
      { column_name: 'updated_at', privilege: 'UPDATE', relation: 'project_lifecycle_journals' },
      { column_name: 'revoked_at', privilege: 'UPDATE', relation: 'project_principal_bindings' },
      { column_name: 'state', privilege: 'UPDATE', relation: 'project_principal_bindings' },
      { column_name: 'acknowledged_at', privilege: 'UPDATE', relation: 'project_terminal_acknowledgements' },
      { column_name: 'acknowledged_at', privilege: 'UPDATE', relation: 'transfer_redemption_receipts' },
      { column_name: 'operation_intent_id', privilege: 'UPDATE', relation: 'transferred_membership_claims' },
      { column_name: 'redemption_receipt_id', privilege: 'UPDATE', relation: 'transferred_membership_claims' },
      { column_name: 'state', privilege: 'UPDATE', relation: 'transferred_membership_claims' },
      { column_name: 'target_principal_id', privilege: 'UPDATE', relation: 'transferred_membership_claims' },
      { column_name: 'updated_at', privilege: 'UPDATE', relation: 'transferred_membership_claims' },
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
        policy_name: 'accept_journal_relations_project_scope',
        relation: 'accept_journal_relations',
      },
      {
        policy_name: 'accept_journals_project_scope',
        relation: 'accept_journals',
      },
      {
        policy_name: 'authority_transfer_recovery_project_scope',
        relation: 'authority_transfer_recovery',
      },
      {
        policy_name: 'change_requests_project_scope',
        relation: 'change_requests',
      },
      {
        policy_name: 'cloud_project_creation_journals_project_scope',
        relation: 'cloud_project_creation_journals',
      },
      {
        policy_name: 'cloud_project_join_journals_project_scope',
        relation: 'cloud_project_join_journals',
      },
      {
        policy_name: 'development_actor_mappings_project_scope',
        relation: 'development_actor_mappings',
      },
      {
        policy_name: 'development_bootstrap_attempts_project_scope',
        relation: 'development_bootstrap_attempts',
      },
      {
        policy_name: 'development_bootstrap_reports_project_scope',
        relation: 'development_bootstrap_reports',
      },
      {
        policy_name: 'development_bootstrap_settlements_project_scope',
        relation: 'development_bootstrap_settlements',
      },
      {
        policy_name: 'development_bootstrap_uploads_project_scope',
        relation: 'development_bootstrap_uploads',
      },
      {
        policy_name: 'idempotency_results_project_scope',
        relation: 'idempotency_results',
      },
      {
        policy_name: 'leave_former_principal_replays_project_scope',
        relation: 'leave_former_principal_replays',
      },
      {
        policy_name: 'leave_project_request_facts_project_scope',
        relation: 'leave_project_request_facts',
      },
      {
        policy_name: 'manager_responsibility_offers_project_scope',
        relation: 'manager_responsibility_offers',
      },
      {
        policy_name: 'project_backup_catalog_project_scope',
        relation: 'project_backup_catalog',
      },
      {
        policy_name: 'project_deletion_intents_project_scope',
        relation: 'project_deletion_intents',
      },
      {
        policy_name: 'project_event_sequences_project_scope',
        relation: 'project_event_sequences',
      },
      {
        policy_name: 'project_events_project_scope',
        relation: 'project_events',
      },
      {
        policy_name: 'project_invitations_project_scope',
        relation: 'project_invitations',
      },
      {
        policy_name: 'project_lifecycle_journals_project_scope',
        relation: 'project_lifecycle_journals',
      },
      {
        policy_name: 'project_member_removal_journals_project_scope',
        relation: 'project_member_removal_journals',
      },
      {
        policy_name: 'project_membership_idempotency_tombstones_project_scope',
        relation: 'project_membership_idempotency_tombstones',
      },
      {
        policy_name: 'project_memberships_project_scope',
        relation: 'project_memberships',
      },
      {
        policy_name: 'project_principal_bindings_project_scope',
        relation: 'project_principal_bindings',
      },
      {
        policy_name: 'project_terminal_acknowledgements_project_scope',
        relation: 'project_terminal_acknowledgements',
      },
      {
        policy_name: 'project_terminal_responders_project_scope',
        relation: 'project_terminal_responders',
      },
      {
        policy_name: 'project_tombstones_project_scope',
        relation: 'project_tombstones',
      },
      { policy_name: 'projects_project_scope', relation: 'projects' },
      {
        policy_name: 'protected_claim_override_envelopes_project_scope',
        relation: 'protected_claim_override_envelopes',
      },
      {
        policy_name: 'protected_invitation_envelopes_project_scope',
        relation: 'protected_invitation_envelopes',
      },
      {
        policy_name: 'repository_placements_project_scope',
        relation: 'repository_placements',
      },
      {
        policy_name: 'request_comments_project_scope',
        relation: 'request_comments',
      },
      {
        policy_name: 'request_ticket_relations_project_scope',
        relation: 'request_ticket_relations',
      },
      {
        policy_name: 'secret_replay_tombstones_project_scope',
        relation: 'secret_replay_tombstones',
      },
      {
        policy_name: 'source_protected_claim_envelopes_project_scope',
        relation: 'source_protected_claim_envelopes',
      },
      {
        policy_name: 'ticket_comments_project_scope',
        relation: 'ticket_comments',
      },
      {
        policy_name: 'ticket_mentions_project_scope',
        relation: 'ticket_mentions',
      },
      { policy_name: 'tickets_project_scope', relation: 'tickets' },
      {
        policy_name: 'transfer_claim_batch_receipts_project_scope',
        relation: 'transfer_claim_batch_receipts',
      },
      {
        policy_name: 'transfer_receipt_keys_project_scope',
        relation: 'transfer_receipt_keys',
      },
      {
        policy_name: 'transfer_redemption_receipts_project_scope',
        relation: 'transfer_redemption_receipts',
      },
      {
        policy_name: 'transferred_membership_claim_overrides_project_scope',
        relation: 'transferred_membership_claim_overrides',
      },
      {
        policy_name: 'transferred_membership_claims_project_scope',
        relation: 'transferred_membership_claims',
      },
    ]);

    for (const projectId of ['project-a', 'project-b']) {
      await migrationClient.query('BEGIN');
      await migrationClient.query(
        "SELECT set_config('claudian_cloud.project_id', $1, true)",
        [projectId],
      );
      await migrationClient.query(
        `INSERT INTO claudian_cloud.projects (
           project_id,
           project_name,
           manager_set_generation,
           expected_main_oid,
           service_state,
           created_at,
           activated_at
         ) VALUES (
           $1, 'Overlapping Project', 1, repeat('a', 40), 'active',
           clock_timestamp(), clock_timestamp()
         )`,
        [projectId],
      );
      await migrationClient.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, display_name, role, status, revision,
           created_at, updated_at
         ) VALUES ($1, 'overlapping-member', 'Overlapping member', 'member', 'active', 1, clock_timestamp(), clock_timestamp())`,
        [projectId],
      );
      await migrationClient.query('COMMIT');
    }

    await migrationClient.query('BEGIN');
    await migrationClient.query(
      "SELECT set_config('claudian_cloud.project_id', 'future.project', true)",
    );
    await migrationClient.query(
      `INSERT INTO claudian_cloud.projects (
         project_id,
         project_name,
         manager_set_generation,
         expected_main_oid,
         service_state,
         created_at,
         activated_at
       ) VALUES (
         'future.project', 'Future Project', 1, repeat('b', 40), 'active',
         clock_timestamp(), clock_timestamp()
       )`,
    );
    await migrationClient.query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, display_name, role, status, revision,
         created_at, updated_at
       ) VALUES (
         'future.project', 'future.member', 'Future member', 'member', 'active', 1,
         clock_timestamp(), clock_timestamp()
       )`,
    );
    await migrationClient.query('ROLLBACK');

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

    await migrationClient.query('BEGIN');
    await migrationClient.query(
      "SELECT set_config('claudian_cloud.project_id', 'project-a', true)",
    );
    await assert.rejects(
      migrationClient.query(
        `INSERT INTO claudian_cloud.repository_placements (
           project_id, storage_node_id, repository_storage_key, generation,
           active, created_at, updated_at
         ) VALUES ('project-a', 'node-a', 'Storage_A', 1, true, clock_timestamp(), clock_timestamp())`,
      ),
      /repository_placements_storage_key_format/,
    );
    await migrationClient.query('ROLLBACK');

    await migrationClient.query('BEGIN');
    await migrationClient.query(
      "SELECT set_config('claudian_cloud.project_id', 'project-a', true)",
    );
    await assert.rejects(
      migrationClient.query(
        `INSERT INTO claudian_cloud.repository_placements (
           project_id, storage_node_id, repository_storage_key, generation,
           active, created_at, updated_at
         ) VALUES ('project-a', 'node-a', 'storage-a', 9007199254740992, true, clock_timestamp(), clock_timestamp())`,
      ),
      /repository_placements_generation/,
    );
    await migrationClient.query('ROLLBACK');

    await migrationClient.query('BEGIN');
    await migrationClient.query(
      "SELECT set_config('claudian_cloud.project_id', 'project-a', true)",
    );
    await migrationClient.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ('project-a', 'node-a', 'shared-storage', 1, true, clock_timestamp(), clock_timestamp())`,
    );
    await migrationClient.query('COMMIT');

    await migrationClient.query('BEGIN');
    await migrationClient.query(
      "SELECT set_config('claudian_cloud.project_id', 'project-b', true)",
    );
    await migrationClient.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ('project-b', 'node-a', 'shared-storage', 1, true, clock_timestamp(), clock_timestamp())`,
    );
    await migrationClient.query('COMMIT');
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

describe('PostgresSchemaInitializer', () => {
  it('initializes one current schema metadata row', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      const client = new Client({ connectionString: database.runtimeUrl });
      try {
        await client.connect();
        const result = await client.query('SELECT singleton, version FROM claudian_cloud.schema_metadata');
        assert.deepEqual(result.rows, [{ singleton: true, version: 12 }]);
      } finally {
        await client.end();
      }
    });
  });

  it('rejects adopted state and atomically establishes the PostgreSQL 18 schema', async () => {
    await withPostgresTestDatabase(async database => {
      await verifyUnmanagedSchemaRejection(database);
      await verifyCurrentSchema(database);
      await verifySchemaContract(database);
    });
  });

  it('rolls back late DDL failure and can retry from an absent schema', async () => {
    await withPostgresTestDatabase(async database => {
      const initializer = new PostgresSchemaInitializer({ connectionString: database.migrationUrl });
      await execute(database.adminUrl, `
        CREATE FUNCTION public.reject_current_schema() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF to_regclass('claudian_cloud.cloud_project_join_journals') IS NOT NULL THEN
            RAISE EXCEPTION 'late-schema-failure';
          END IF;
        END; $$;
        CREATE EVENT TRIGGER reject_current_schema ON ddl_command_end
          EXECUTE FUNCTION public.reject_current_schema();
      `);
      await expectMigrationError(initializer, 'migration-failed');
      const admin = new Client({ connectionString: database.adminUrl });
      try {
        await admin.connect();
        assert.deepEqual((await admin.query("SELECT to_regnamespace('claudian_cloud')::text AS schema")).rows, [{ schema: null }]);
        await admin.query('DROP EVENT TRIGGER reject_current_schema; DROP FUNCTION public.reject_current_schema()');
      } finally {
        await admin.end();
      }
      assert.deepEqual(await initializer.preflight(), { currentVersion: 0, targetVersion: 12 });
      await Promise.all([initializer.apply(), initializer.apply()]);
      assert.deepEqual(await initializer.preflight(), { currentVersion: 12, targetVersion: 12 });
    });
  });

  it('sanitizes connection failures', async () => {
    const credential = 'migration-secret-sentinel';
    const migrator = new PostgresSchemaInitializer({
      connectionString: `postgresql://migration:${credential}@127.0.0.1:1/cloud`,
    });
    await assert.rejects(
      migrator.apply(),
      error => {
        assert.ok(error instanceof PostgresSchemaError);
        assert.equal(error.code, 'migration-failed');
        assert.doesNotMatch(JSON.stringify(error), new RegExp(credential));
        assert.doesNotMatch(String(error), /ECONNREFUSED|127\.0\.0\.1/);
        return true;
      },
    );
  });

  it('cancels a preflight blocked on the migration lock', async () => {
    await withPostgresTestDatabase(async database => {
      const blocker = new Client({ connectionString: database.migrationUrl });
      const controller = new AbortController();
      try {
        await blocker.connect();
        await blocker.query(
          'SELECT pg_advisory_lock($1::integer, $2::integer)',
          [1_665_883_532, 1],
        );
        const preflight = new PostgresSchemaInitializer({
          connectionString: database.migrationUrl,
        }).preflight(controller.signal);
        const deadline = Date.now() + 2_000;
        let waiting = false;
        while (Date.now() < deadline) {
          const result = await blocker.query<{ readonly waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
                WHERE application_name = 'claudian-cloud-migration'
                  AND wait_event = 'advisory'
             ) AS waiting`,
          );
          if (result.rows[0]?.waiting === true) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        controller.abort();
        assert.equal(waiting, true, 'initializer reached the held advisory lock');
        await assert.rejects(preflight, error => {
          assert.ok(error instanceof PostgresSchemaError);
          assert.equal(error.code, 'migration-failed');
          return true;
        });
      } finally {
        await blocker.end();
      }
    });
  });
});
