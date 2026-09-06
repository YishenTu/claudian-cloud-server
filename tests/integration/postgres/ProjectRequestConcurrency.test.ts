import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';

import { CollabError, collabMemberRef } from '@claudian-collab/protocol';
import { Client } from 'pg';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { ProjectRequestAuthority } from '../../../src/project-authority/requests/ProjectRequestAuthority.js';
import { ProjectPersonalRefAuthority } from '../../../src/project-authority/writes/ProjectPersonalRefAuthority.js';
import { GitRepositoryAuthority } from '../../../src/repositories/GitRepositoryAuthority.js';
import { createDevelopmentPrincipal } from '../../../src/request-context/RequestPrincipal.js';
import { GitReceiveAdmission } from '../../../src/resource-admission/GitReceiveAdmission.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';
import { withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const CREATED_AT = '2026-08-23T00:00:00.000Z';
const PROJECT_ID = 'project-request-concurrency';
const ACTORS = ['member-alice', 'member-bob'] as const;

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, arguments_, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1_024 * 1_024,
  });
  return result.stdout.trim();
}

async function createRepository(
  root: string,
  repositoryRoot: string,
  projectId = PROJECT_ID,
  suffix = 'primary',
): Promise<Readonly<{
  mainOid: string;
  projectId: string;
  repositoryPath: string;
  repositoryStorageKey: string;
}>> {
  const work = join(root, `work-${suffix}`);
  const repositoryStorageKey = `repository_collaboration_gate_${suffix}`;
  const projectDirectory = join(
    repositoryRoot,
    Buffer.from(projectId, 'utf8').toString('hex'),
  );
  await git(root, ['init', '--initial-branch=main', work]);
  await git(work, ['config', 'user.name', 'Collaboration Gate']);
  await git(work, ['config', 'user.email', 'gate@example.invalid']);
  await writeFile(join(work, 'shared.txt'), 'base\n');
  await git(work, ['add', 'shared.txt']);
  await git(work, ['commit', '-m', 'base']);
  const mainOid = await git(work, ['rev-parse', 'HEAD']);
  for (const actor of ACTORS) {
    await git(work, ['branch', collabMemberRef(actor).slice('refs/heads/'.length)]);
  }
  await mkdir(projectDirectory);
  const repositoryPath = join(projectDirectory, repositoryStorageKey);
  await git(root, [
    'clone',
    '--bare',
    work,
    repositoryPath,
  ]);
  return Object.freeze({ mainOid, projectId, repositoryPath, repositoryStorageKey });
}

async function seedProject(
  client: Client,
  fixture: Readonly<{
    mainOid: string;
    projectId: string;
    repositoryStorageKey: string;
  }>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [fixture.projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation,
         expected_main_oid, service_state, created_at, activated_at
       ) VALUES ($1, 'Collaboration Gate', 1, $2, 'active', $3, $3)`,
      [fixture.projectId, fixture.mainOid, CREATED_AT],
    );
    for (const [index, actor] of ACTORS.entries()) {
      await client.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, display_name, role, status, revision,
           created_at, updated_at, activated_at
         ) VALUES ($1, $2, $2, $3, 'active', 1, $4, $4, $4)`,
        [fixture.projectId, actor, index === 0 ? 'manager' : 'member', CREATED_AT],
      );
      await client.query(
        `INSERT INTO claudian_cloud.development_actor_mappings (
           project_id, actor_id, member_id, created_at
         ) VALUES ($1, $2, $2, $3)`,
        [fixture.projectId, actor, CREATED_AT],
      );
    }
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, 'collaboration-gate-node', $2, 1, true, $3, $3)`,
      [fixture.projectId, fixture.repositoryStorageKey, CREATED_AT],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, 'collaboration-gate-node', $2, 1)`,
      [fixture.projectId, fixture.repositoryStorageKey],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function barrier(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe('Project Request concurrency', () => {
  it('completes Publish and receive advertisement without a Project lock/capacity cycle', { timeout: 20_000 }, async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      const root = await mkdtemp(join(tmpdir(), 'claudian-request-concurrency-'));
      const repositoryRoot = join(root, 'repositories');
      await mkdir(repositoryRoot);
      const fixture = await createRepository(root, repositoryRoot);
      const work = join(root, 'work-primary');
      await writeFile(join(work, 'second.txt'), 'second\n');
      await git(work, ['add', 'second.txt']);
      await git(work, ['commit', '-m', 'second']);
      const headOid = await git(work, ['rev-parse', 'HEAD']);
      await git(work, ['push', fixture.repositoryPath, `HEAD:${collabMemberRef(ACTORS[0])}`]);
      const seed = new Client({ connectionString: database.migrationUrl });
      try {
        await seed.connect();
        await seedProject(seed, fixture);
      } finally {
        await seed.end();
      }
      const store = new PostgresCoordination({
        ordinaryPoolMax: 3, pinnedPoolMax: 3, projectLockTimeoutMs: 3_000,
        reservedPoolMax: 1, runtimeConnectionString: database.runtimeUrl, shutdownTimeoutMs: 2_000,
      });
      const admission = new ResourceAdmission({
        maxChildren: 3, maxChildrenPerProject: 1, queueMax: 6,
        queueMaxPerProject: 4, queueTimeoutMs: 500,
      });
      const repository = new GitRepositoryAuthority({
        gitExecutable: GIT_EXECUTABLE, operationTimeoutMs: 2_000, outputMaxBytes: 1_048_576,
        placementValidator: store, repositoryRoot, resourceAdmission: admission,
        storageNodeId: 'collaboration-gate-node',
        receiveAdmission: new GitReceiveAdmission({
          capacityTimeoutMs: 1_000, freeSpaceFloorBytes: 1,
          maxConcurrentReceives: 2, maxConcurrentReceivesPerProject: 1,
          maximumRequestBytes: 1_048_576, repositoryRoot, reservationBytes: 1_048_576,
        }),
        receivePolicy: {
          maximumBlobBytes: 1_048_576, maximumExpandedTreeEntries: 1_000,
          maximumRepositoryBytes: 67_108_864, maximumTreeEntries: 1_000,
        },
      });
      const receivePreflight = barrier();
      const publishLease = barrier();
      const receiveAttempted = barrier();
      const recovery = { recoverProject: () => Promise.resolve() };
      const personal = new ProjectPersonalRefAuthority({
        coordination: store, recovery,
        repository: {
          advertiseReceivePack: repository.advertiseReceivePack.bind(repository),
          runReceivePack: repository.runReceivePack.bind(repository),
          reserveReceivePack: async (...arguments_) => {
            receivePreflight.resolve();
            await publishLease.promise;
            receiveAttempted.resolve();
            return repository.reserveReceivePack(...arguments_);
          },
        },
      });
      const requests = new ProjectRequestAuthority({
        coordination: {
          withProjectReadScope: store.withProjectReadScope.bind(store),
          acquireProjectLease: async (...arguments_) => {
            const lease = await store.acquireProjectLease(...arguments_);
            publishLease.resolve();
            await receiveAttempted.promise;
            await setImmediate();
            return lease;
          },
        },
        recovery, repository,
      });
      try {
        const actor = createDevelopmentPrincipal(ACTORS[0]);
        const receive = personal.advertiseReceivePack(actor, PROJECT_ID);
        await receivePreflight.promise;
        const request = {
          projectId: PROJECT_ID, idempotencyKey: 'publish-concurrently',
          expectedMainOid: fixture.mainOid, headOid, description: 'Concurrent Publish',
        };
        const [published, advertised] = await Promise.allSettled([
          requests.ensureMyRequest(actor, request), receive,
        ]);
        assert.equal(advertised.status, 'fulfilled');
        assert.ok(advertised.value.length > 0);
        const replay = await requests.ensureMyRequest(actor, request);
        assert.equal(replay.request.status, 'open');
        assert.equal(replay.request.latestHeadOid, headOid);
        assert.equal(published.status, 'fulfilled', 'Publish must not time out behind a receiver waiting for its Project lease');
        assert.deepEqual(published.value, replay);
        const held = await repository.reserveReceivePack(PROJECT_ID);
        try {
          const pending = requests.ensureMyRequest(actor, {
            ...request, idempotencyKey: 'publish-during-shutdown',
          });
          await setImmediate();
          const closed = requests.close();
          await assert.rejects(pending, error => (
            error instanceof CollabError && error.code === 'operation-failed'
          ));
          await closed;
        } finally {
          await held.close();
        }
      } finally {
        publishLease.resolve();
        receiveAttempted.resolve();
        await Promise.all([personal.close(), requests.close()]);
        await repository.close();
        await admission.close();
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
