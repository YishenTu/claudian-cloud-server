import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import type { PrepareCloudProjectCreationInput } from '../../../src/coordination/CloudProjectCreationPersistence.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const T0 = '2026-08-30T01:02:03.000Z';
const PROJECT_ID = 'project_cloud_empty';
const MEMBER_ID = 'member_initial_manager';
const MAIN = '6b1a12d6d3b4714801617caa850adf32f9858bf5';
const PLAN: PrepareCloudProjectCreationInput = Object.freeze({
  commit: Object.freeze({
    authorEmail: 'cloud@claudian.invalid',
    authorName: 'Claudian Cloud',
    commitMessage: 'Initialize Collab project',
    commitTimestampSeconds: 1788051723,
    emptyTreeOid: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    initialCommitOid: MAIN,
    mainRef: 'refs/heads/main',
    objectFormat: 'sha1',
    personalRef: `refs/heads/members/${MEMBER_ID}`,
    timezone: '+0000',
  }),
  idempotencyKey: 'create_project_key',
  managerDisplayName: 'Initial Manager',
  memberId: MEMBER_ID,
  operationId: 'create_project_operation',
  placement: Object.freeze({
    active: false,
    generation: 1,
    projectId: PROJECT_ID,
    repositoryStorageKey: 'repo_cloud_empty',
    storageNodeId: 'node-a',
  }),
  planSha256: 'eee9ec8ba7ad10983660a70ec3b417f3f64079b4be6c4bcfe928d0e25d8b3b72',
  preparedAt: T0,
  principalId: 'principal_operator_asserted',
  projectId: PROJECT_ID,
  projectName: 'Empty Cloud Project',
  requestFingerprint: 'c'.repeat(64),
});

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 4,
    pinnedPoolMax: 3,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

function withProject(
  projectId: string,
  projectName: string,
  repositoryStorageKey: string,
): PrepareCloudProjectCreationInput {
  const candidate = {
    ...PLAN,
    placement: {
      ...PLAN.placement,
      projectId,
      repositoryStorageKey,
    },
    projectId,
    projectName,
  };
  return Object.freeze({
    ...candidate,
    planSha256: createHash('sha256').update(JSON.stringify({
      commit: candidate.commit,
      createdAt: candidate.preparedAt,
      managerDisplayName: candidate.managerDisplayName,
      memberId: candidate.memberId,
      placement: candidate.placement,
      principalId: candidate.principalId,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
    }), 'utf8').digest('hex'),
  });
}

describe('Postgres Cloud Project creation persistence', () => {
  it('scopes equal creation operation IDs to their Projects', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({
        connectionString: database.migrationUrl,
      }).apply();
      const store = coordination(database);
      const secondProjectId = 'project_cloud_empty_two';
      try {
        for (const plan of [
          PLAN,
          withProject(
            secondProjectId,
            'Second Empty Cloud Project',
            'repo_cloud_empty_two',
          ),
        ]) {
          const lease = await store.acquireCloudProjectCreationLease(plan.projectId);
          try {
            assert.equal(
              await lease.withCreationScope(persistence => persistence.prepare(plan)),
              'created',
            );
          } finally {
            await lease.close();
          }
        }
      } finally {
        await store.close();
      }
    });
  });

  it('keeps prepared authority invisible and atomically activates its exact facts', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({
        connectionString: database.migrationUrl,
      }).apply();
      const store = coordination(database);
      try {
        const lease = await store.acquireCloudProjectCreationLease(PROJECT_ID);
        try {
          assert.equal(
            await lease.withCreationScope(persistence => persistence.prepare(PLAN)),
            'created',
          );
          assert.equal(
            (await lease.withCreationScope(persistence => persistence.get()))?.phase,
            'prepared',
          );
          await lease.withCreationScope(persistence => (
            persistence.markRepositoryPublicationIntent(T0)
          ));
          await lease.withCreationScope(persistence => (
            persistence.markRepositoryPublished({
              publicationMarkerSha256: 'd'.repeat(64),
              updatedAt: T0,
            })
          ));
          const response = {
            createdAt: T0,
            mainOid: MAIN,
            managerSetGeneration: 1 as const,
            memberId: MEMBER_ID,
            membershipRevision: 2 as const,
            personalRef: `refs/heads/members/${MEMBER_ID}`,
            projectId: PROJECT_ID,
            role: 'manager' as const,
          };
          assert.deepEqual(
            await lease.withCreationScope(persistence => persistence.activate({
              activatedAt: T0,
              response,
            })),
            response,
          );
          assert.deepEqual(
            await lease.withCreationScope(persistence => persistence.complete(T0)),
            response,
          );
        } finally {
          await lease.close();
        }

        const client = new Client({ connectionString: database.migrationUrl });
        try {
          await client.connect();
          await client.query('BEGIN');
          await client.query(
            "SELECT set_config('claudian_cloud.project_id', $1, true)",
            [PROJECT_ID],
          );
          const result = await client.query<{
            readonly binding_state: string;
            readonly candidate_count: string;
            readonly membership_revision: string;
            readonly membership_status: string;
            readonly placement_active: boolean;
            readonly service_state: string;
          }>(`SELECT p.service_state,
                    m.status AS membership_status,
                    m.revision AS membership_revision,
                    b.state AS binding_state,
                    r.active AS placement_active,
                    (SELECT count(*)::text
                       FROM claudian_cloud.recovery_candidates c
                      WHERE c.project_id = p.project_id) AS candidate_count
               FROM claudian_cloud.projects p
               JOIN claudian_cloud.project_memberships m USING (project_id)
               JOIN claudian_cloud.project_principal_bindings b USING (project_id, member_id)
               JOIN claudian_cloud.repository_placements r USING (project_id)
              WHERE p.project_id = $1`, [PROJECT_ID]);
          assert.deepEqual(result.rows, [{
            binding_state: 'active',
            candidate_count: '0',
            membership_revision: '2',
            membership_status: 'active',
            placement_active: true,
            service_state: 'active',
          }]);
          await client.query('COMMIT');
        } finally {
          await client.end();
        }
      } finally {
        await store.close();
      }
    });
  });
});
