import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import {
  ProjectReadAuthority,
  ProjectReadAuthorityError,
} from '../../../src/project-authority/reads/ProjectReadAuthority.js';
import { createDevelopmentIngressPrincipal } from '../../../src/request-context/IngressPrincipal.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';
import { GitRepositoryAuthority } from '../../../src/repositories/GitRepositoryAuthority.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const CREATED = '2026-08-20T00:00:00.000Z';
const ACTIVATED = '2026-08-21T00:00:00.000Z';
const UPDATED = '2026-08-22T00:00:00.000Z';

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 4,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 1_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

describe('Project read authority integration', () => {
  it('binds real repeatable SQL facts to the exact placed Git main', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const root = await mkdtemp(join(tmpdir(), 'claudian-project-read-'));
      const work = join(root, 'work');
      const projectId = 'project-read';
      const repositoryStorageKey = 'repository-read';
      const repositoryPath = join(
        root,
        Buffer.from(projectId, 'utf8').toString('hex'),
        repositoryStorageKey,
      );
      const seed = new Client({ connectionString: database.migrationUrl });
      const store = coordination(database);
      const admission = new ResourceAdmission({
        maxChildren: 2,
        maxChildrenPerProject: 1,
        queueMax: 2,
        queueMaxPerProject: 1,
        queueTimeoutMs: 100,
      });
      const repository = new GitRepositoryAuthority({
        gitExecutable: GIT_EXECUTABLE,
        operationTimeoutMs: 2_000,
        outputMaxBytes: 1024 * 1024,
        placementValidator: store,
        repositoryRoot: root,
        resourceAdmission: admission,
        storageNodeId: 'node-read',
      });
      const authority = new ProjectReadAuthority({
        coordination: store,
        repository,
      });
      try {
        await execFileAsync(GIT_EXECUTABLE, ['init', '--initial-branch=main', work]);
        await execFileAsync(GIT_EXECUTABLE, ['config', 'user.email', 'test@example.invalid'], {
          cwd: work,
        });
        await execFileAsync(GIT_EXECUTABLE, ['config', 'user.name', 'Test User'], {
          cwd: work,
        });
        await writeFile(join(work, 'read.txt'), 'read authority\n');
        await execFileAsync(GIT_EXECUTABLE, ['add', 'read.txt'], { cwd: work });
        await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'fixture'], { cwd: work });
        const oid = (await execFileAsync(GIT_EXECUTABLE, ['rev-parse', 'HEAD'], {
          cwd: work,
          encoding: 'utf8',
        })).stdout.trim();
        await execFileAsync(GIT_EXECUTABLE, ['branch', 'members/member-a'], { cwd: work });
        await execFileAsync(GIT_EXECUTABLE, ['branch', 'members/member-b'], { cwd: work });
        await execFileAsync(GIT_EXECUTABLE, ['clone', '--bare', work, repositoryPath]);

        await seed.connect();
        await seed.query('BEGIN');
        await seed.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [projectId],
        );
        await seed.query(
          `INSERT INTO claudian_cloud.projects (
             project_id, project_name, manager_set_generation,
             expected_main_oid, service_state, created_at, activated_at
           ) VALUES ($1, 'Read integration', 1, $2, 'active', $3, $4)`,
          [projectId, oid, CREATED, ACTIVATED],
        );
        for (const [memberId, displayName, role] of [[
          'member-a', 'Member A', 'manager',
        ], [
          'member-b', 'Member B', 'member',
        ]] as const) {
          await seed.query(
             `INSERT INTO claudian_cloud.project_memberships (
               project_id, member_id, display_name, role, status, revision,
               created_at, updated_at, activated_at
             ) VALUES ($1, $2, $3, $4, 'active', 1, $5, $6, $7)`,
            [projectId, memberId, displayName, role, CREATED, UPDATED, ACTIVATED],
          );
          await seed.query(
            `INSERT INTO claudian_cloud.development_actor_mappings (
               project_id, actor_id, member_id, created_at
             ) VALUES ($1, $2, $2, $3)`,
            [projectId, memberId, ACTIVATED],
          );
        }
        await seed.query(
          `INSERT INTO claudian_cloud.repository_placements (
             project_id, storage_node_id, repository_storage_key, generation,
             active, created_at, updated_at
           ) VALUES ($1, 'node-read', $2, 1, true, $3, $3)`,
          [projectId, repositoryStorageKey, ACTIVATED],
        );
        await seed.query(
          `INSERT INTO claudian_cloud.active_repository_placement_catalog (
             project_id, storage_node_id, repository_storage_key, generation
           ) VALUES ($1, 'node-read', $2, 1)`,
          [projectId, repositoryStorageKey],
        );
        await seed.query('COMMIT');

        const snapshot = await authority.getProjectSnapshot(
          createDevelopmentIngressPrincipal('member-a'),
          projectId,
        );
        assert.equal(snapshot.project.expectedMainOid, oid);
        assert.equal(snapshot.currentMember.createdAt, CREATED);
        assert.equal(snapshot.currentMember.activatedAt, ACTIVATED);
        assert.deepEqual(snapshot.openRequests, []);
        assert.deepEqual(snapshot.ticketHighlights, []);

        await assert.rejects(
          authority.getProjectSnapshot(
            createDevelopmentIngressPrincipal('outsider'),
            projectId,
          ),
          error => error instanceof ProjectReadAuthorityError
            && error.code === 'project-not-found',
        );

        await seed.query('BEGIN');
        await seed.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [projectId],
        );
        await seed.query(
          `UPDATE claudian_cloud.projects
              SET expected_main_oid = repeat('f', 40)
            WHERE project_id = $1`,
          [projectId],
        );
        await seed.query('COMMIT');
        await assert.rejects(
          authority.getProjectSnapshot(
            createDevelopmentIngressPrincipal('member-a'),
            projectId,
          ),
          error => error instanceof ProjectReadAuthorityError
            && error.code === 'dependency-failed',
        );
      } finally {
        await seed.query('ROLLBACK').catch(() => undefined);
        await seed.end().catch(() => undefined);
        await authority.close();
        await repository.close();
        await admission.close();
        await store.close();
        await rm(root, { force: true, recursive: true });
      }
    });
  });
});
