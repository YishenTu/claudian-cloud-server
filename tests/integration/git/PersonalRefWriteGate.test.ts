import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_MAIN_REF,
  collabCloudGitRoute,
  collabMemberRef,
  decodeCollabCloudCapabilityDocument,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import { createApplication, type Application } from '../../../src/composition/createApplication.js';
import type { ServerConfig } from '../../../src/config/ServerConfig.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { SafeLogger } from '../../../src/observability/SafeLogger.js';
import { acquirePostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const CREATED_AT = '2026-08-22T00:00:00.000Z';
const ACTORS = ['member-alice', 'member-bob'] as const;

interface ProjectFixture {
  readonly mainOid: string;
  readonly projectId: string;
  readonly repositoryPath: string;
  readonly repositoryStorageKey: string;
}

interface CheckoutFixture {
  readonly actor: typeof ACTORS[number];
  readonly checkout: string;
  readonly project: ProjectFixture;
}

function config(
  databaseUrl: string,
  repositoryRoot: string,
  stagingRoot: string,
): ServerConfig {
  const maxBundleBytes = 16 * 1_024 * 1_024;
  const maxRepositoryBytes = 64 * 1_024 * 1_024;
  return Object.freeze({
    developmentBootstrap: Object.freeze({
      attemptTtlMs: COLLAB_CLOUD_BINDING_LIMITS.bootstrapAttemptTtlMs,
      maxBundleBytes,
      maxConcurrentUploads: 1,
      maxRepositoryBytes,
      maxUploadsPerAttempt: 1,
      queueMax: 4,
      queueTimeoutMs: 2_000,
      stagingFreeSpaceFloorBytes: 1,
      stagingReservationBytes: maxBundleBytes + maxRepositoryBytes,
      stagingRoot,
      uploadDeadlineMs: 30_000,
      uploadIdleTimeoutMs: 5_000,
    }),
    eventAdmission: Object.freeze({
      maxConnections: 8,
      maxConnectionsPerProject: 4,
      maxPendingAuthorizations: 4,
    }),
    gitAdmission: Object.freeze({
      maxChildren: 3,
      maxChildrenPerProject: 1,
      maxQueuedReads: 5,
      maxQueuedWrites: 5,
      maxReadChildren: 1,
      maxWriteChildren: 2,
      queueMax: 6,
      queueMaxPerProject: 4,
      queueTimeoutMs: 2_000,
    }),
    http: Object.freeze({ host: '127.0.0.1', port: 0 }),
    postgres: Object.freeze({
      ordinaryPoolMax: 2,
      pinnedPoolMax: 2,
      projectLockTimeoutMs: 2_000,
      reservedPoolMax: 1,
      url: databaseUrl,
    }),
    repository: Object.freeze({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 10_000,
      outputMaxBytes: 1_024 * 1_024,
      root: repositoryRoot,
      storageNodeId: 'write-gate-node',
    }),
    shutdownTimeoutMs: 5_000,
  });
}

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, arguments_, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1_024 * 1_024,
  });
  return result.stdout.trim();
}

async function createProject(
  root: string,
  repositoryRoot: string,
  suffix: string,
): Promise<ProjectFixture> {
  const projectId = `project-write-${suffix}`;
  const repositoryStorageKey = `repository_write_${suffix}`;
  const work = join(root, `work-${suffix}`);
  const projectDirectory = join(
    repositoryRoot,
    Buffer.from(projectId, 'utf8').toString('hex'),
  );
  const repositoryPath = join(projectDirectory, repositoryStorageKey);
  await git(root, ['init', '--initial-branch=main', work]);
  await git(work, ['config', 'user.name', `Write Gate ${suffix}`]);
  await git(work, ['config', 'user.email', `${suffix}@example.invalid`]);
  await writeFile(join(work, 'shared.txt'), `base-${suffix}\n`);
  await git(work, ['add', 'shared.txt']);
  await git(work, ['commit', '-m', `base ${suffix}`]);
  const mainOid = await git(work, ['rev-parse', 'HEAD']);
  for (const actor of ACTORS) {
    await git(work, ['branch', `members/${actor}`]);
  }
  await mkdir(projectDirectory);
  await git(root, ['clone', '--bare', work, repositoryPath]);
  return Object.freeze({
    mainOid,
    projectId,
    repositoryPath,
    repositoryStorageKey,
  });
}

async function seedProject(
  client: Client,
  project: ProjectFixture,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [project.projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation,
         expected_main_oid, service_state, created_at, activated_at
       ) VALUES ($1, $2, 1, $3, 'active', $4, $4)`,
      [project.projectId, project.projectId, project.mainOid, CREATED_AT],
    );
    for (const [index, actor] of ACTORS.entries()) {
      await client.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, display_name, role, status, revision,
           created_at, updated_at
         ) VALUES ($1, $2, $2, $3, 'active', 1, $4, $4)`,
        [project.projectId, actor, index === 0 ? 'manager' : 'member', CREATED_AT],
      );
      await client.query(
        `INSERT INTO claudian_cloud.development_actor_mappings (
           project_id, actor_id, member_id, created_at
         ) VALUES ($1, $2, $2, $3)`,
        [project.projectId, actor, CREATED_AT],
      );
    }
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, 'write-gate-node', $2, 1, true, $3, $3)`,
      [project.projectId, project.repositoryStorageKey, CREATED_AT],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, 'write-gate-node', $2, 1)`,
      [project.projectId, project.repositoryStorageKey],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function createCheckout(
  root: string,
  project: ProjectFixture,
  actor: typeof ACTORS[number],
): Promise<CheckoutFixture> {
  const checkout = join(root, `checkout-${project.projectId}-${actor}`);
  const personalRef = collabMemberRef(actor);
  await git(root, [
    'clone',
    '--branch',
    personalRef.slice('refs/heads/'.length),
    project.repositoryPath,
    checkout,
  ]);
  await git(checkout, ['config', 'user.name', actor]);
  await git(checkout, ['config', 'user.email', `${actor}@example.invalid`]);
  return Object.freeze({ actor, checkout, project });
}

async function pushRound(
  fixture: CheckoutFixture,
  baseUrl: string,
  round: number,
): Promise<void> {
  const personalRef = collabMemberRef(fixture.actor);
  const fileName = `${fixture.project.projectId}-${fixture.actor}-${String(round)}.txt`;
  await writeFile(join(fixture.checkout, fileName), `round-${String(round)}\n`);
  await git(fixture.checkout, ['add', fileName]);
  await git(fixture.checkout, ['commit', '-m', `write round ${String(round)}`]);
  const expectedPersonalOid = await git(fixture.checkout, ['rev-parse', 'HEAD']);
  await git(fixture.checkout, [
    '-c',
    `http.extraHeader=X-Claudian-Development-Actor: ${fixture.actor}`,
    'push',
    `${baseUrl}/v2/projects/${fixture.project.projectId}/repository.git`,
    `HEAD:${personalRef}`,
  ]);
  const advertised = await git(fixture.checkout, [
    '-c',
    `http.extraHeader=X-Claudian-Development-Actor: ${fixture.actor}`,
    'ls-remote',
    `${baseUrl}/v2/projects/${fixture.project.projectId}/repository.git`,
    COLLAB_MAIN_REF,
    personalRef,
  ]);
  const refs = new Map(advertised.split('\n').map(line => {
    const [oid, name] = line.split('\t');
    assert.ok(oid !== undefined && name !== undefined);
    return [name, oid] as const;
  }));
  assert.equal(refs.get(COLLAB_MAIN_REF), fixture.project.mainOid);
  assert.equal(refs.get(personalRef), expectedPersonalOid);
}

async function pushRoundConcurrently(
  fixtures: readonly CheckoutFixture[],
  baseUrl: string,
  round: number,
): Promise<void> {
  const results = await Promise.allSettled(
    fixtures.map(fixture => pushRound(fixture, baseUrl, round)),
  );
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      failures.push(reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more concurrent pushes failed');
  }
}

async function receiveAdvertisementStatus(
  baseUrl: string,
  projectId: string,
  actor: string,
): Promise<number> {
  const route = collabCloudGitRoute(projectId, 'info-refs', 'git-receive-pack');
  const response = await fetch(`${baseUrl}${route.target}`, {
    headers: { 'x-claudian-development-actor': actor },
    method: route.method,
  });
  await response.arrayBuffer();
  return response.status;
}

describe('personal ref write gate', { concurrency: false }, () => {
  it('composes two-Project writes, denial, restart cleanup, and reuse', async () => {
    const database = await acquirePostgresTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'claudian-personal-write-gate-'));
    const repositoryRoot = join(root, 'repositories');
    const stagingRoot = join(root, 'staging');
    const seed = new Client({ connectionString: database.migrationUrl });
    let application: Application | undefined;
    try {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await mkdir(repositoryRoot, { mode: 0o700 });
      await mkdir(stagingRoot, { mode: 0o700 });
      await writeFile(
        join(root, '.authority-volume-id'),
        `${database.authorityVolumeId}\n`,
        { mode: 0o600 },
      );
      const projects = await Promise.all(['a', 'b'].map(
        suffix => createProject(root, repositoryRoot, suffix),
      ));
      await seed.connect();
      for (const project of projects) await seedProject(seed, project);
      const applicationConfig = config(database.runtimeUrl, repositoryRoot, stagingRoot);
      application = createApplication({
        config: applicationConfig,
        logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
      });
      const address = await application.start();
      let baseUrl = `http://${address.host}:${String(address.port)}`;
      const capabilitiesResponse = await fetch(`${baseUrl}/collab/capabilities`);
      assert.equal(capabilitiesResponse.status, 200);
      const capabilities = decodeCollabCloudCapabilityDocument(
        await capabilitiesResponse.json(),
      );
      assert.equal(
        capabilities.capabilities.includes('git-receive-pack-personal-ref'),
        true,
      );
      const firstProject = projects[0];
      assert.ok(firstProject !== undefined);
      const checkouts = (await Promise.all(projects.flatMap(project => (
        ACTORS.map(actor => createCheckout(root, project, actor))
      )))).flat();
      await pushRoundConcurrently(checkouts, baseUrl, 1);

      await application.close();
      application = undefined;
      await mkdir(join(
        repositoryRoot,
        '.claudian-receive-pack',
        Buffer.from(firstProject.projectId, 'utf8').toString('hex'),
        'operation-stale',
      ), { recursive: true });
      await mkdir(join(firstProject.repositoryPath, 'objects', 'incoming-stale'));
      application = createApplication({
        config: applicationConfig,
        logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
      });
      const restarted = await application.start();
      baseUrl = `http://${restarted.host}:${String(restarted.port)}`;
      assert.deepEqual(
        await readdir(join(repositoryRoot, '.claudian-receive-pack')),
        [],
      );
      assert.deepEqual(
        (await readdir(join(firstProject.repositoryPath, 'objects')))
          .filter(name => name.startsWith('incoming-')),
        [],
      );
      await pushRoundConcurrently(checkouts, baseUrl, 2);

      const secondProject = projects[1];
      assert.ok(secondProject !== undefined);
      await seed.query('BEGIN');
      await seed.query(
        "SELECT set_config('claudian_cloud.project_id', $1, true)",
        [secondProject.projectId],
      );
      await seed.query(
        `DELETE FROM claudian_cloud.development_actor_mappings
          WHERE project_id = $1 AND actor_id = $2`,
        [secondProject.projectId, ACTORS[0]],
      );
      await seed.query('COMMIT');
      assert.deepEqual(await Promise.all([
        receiveAdvertisementStatus(baseUrl, secondProject.projectId, ACTORS[0]),
        receiveAdvertisementStatus(baseUrl, 'project-write-unknown', ACTORS[0]),
      ]), [404, 404]);
    } finally {
      await seed.query('ROLLBACK').catch(() => undefined);
      await seed.end().catch(() => undefined);
      await application?.close().catch(() => undefined);
      await database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
