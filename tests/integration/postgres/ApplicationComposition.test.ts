import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  after,
  before,
  describe,
  it,
} from 'node:test';

import { Client } from 'pg';

import { createApplication } from '../../../src/composition/createApplication.js';
import type { ServerConfig } from '../../../src/config/ServerConfig.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { SafeLogger } from '../../../src/observability/SafeLogger.js';
import {
  acquirePostgresTestDatabase,
  type PostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';

interface LoggedEvent {
  readonly context: Readonly<Record<string, unknown>>;
  readonly event: string;
}

function config(options: {
  readonly gitExecutable?: string;
  readonly httpPort?: number;
  readonly postgresUrl: string;
  readonly repositoryRoot: string;
}): ServerConfig {
  return Object.freeze({
    developmentBootstrap: Object.freeze({
      attemptTtlMs: 86_400_000,
      maxBundleBytes: 1_073_741_824,
      maxConcurrentUploads: 1,
      maxRepositoryBytes: 1_073_741_824,
      maxUploadsPerAttempt: 1,
      queueMax: 4,
      queueTimeoutMs: 10_000,
      stagingFreeSpaceFloorBytes: 1_073_741_824,
      stagingReservationBytes: 2_147_483_648,
      stagingRoot: `${options.repositoryRoot}-staging`,
      uploadDeadlineMs: 900_000,
      uploadIdleTimeoutMs: 30_000,
    }),
    gitAdmission: Object.freeze({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 6,
      queueMaxPerProject: 4,
      queueTimeoutMs: 1_000,
    }),
    http: Object.freeze({
      host: '127.0.0.1' as const,
      port: options.httpPort ?? 0,
    }),
    postgres: Object.freeze({
      ordinaryPoolMax: 2,
      pinnedPoolMax: 1,
      projectLockTimeoutMs: 1_000,
      reservedPoolMax: 1,
      url: options.postgresUrl,
    }),
    repository: Object.freeze({
      gitExecutable: options.gitExecutable ?? GIT_EXECUTABLE,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 64 * 1_024,
      root: options.repositoryRoot,
      storageNodeId: 'test-node',
    }),
    shutdownTimeoutMs: 1_000,
  });
}

function logger(lines: string[]): SafeLogger {
  return new SafeLogger({
    now: () => new Date('2026-08-21T00:00:00.000Z'),
    write: line => lines.push(line),
  });
}

function events(lines: readonly string[]): readonly LoggedEvent[] {
  return lines.map(line => JSON.parse(line) as LoggedEvent);
}

async function cloudConnectionCount(adminUrl: string): Promise<number> {
  const client = new Client({ connectionString: adminUrl });
  try {
    await client.connect();
    const result = await client.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name LIKE 'claudian-cloud-%'`,
    );
    return Number(result.rows[0]?.count);
  } finally {
    await client.end();
  }
}

async function waitForNoCloudConnections(adminUrl: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await cloudConnectionCount(adminUrl) === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('application-test-postgres-connection-survived');
}

async function writeExecutable(
  root: string,
  name: string,
  body: string,
): Promise<string> {
  const executable = join(root, name);
  await writeFile(executable, `#!/bin/sh\n${body}\n`);
  await chmod(executable, 0o755);
  return executable;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error('application-test-file-timeout');
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('application-test-process-survived');
}

async function waitForBlockedSchemaQuery(client: Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query<{
      readonly application_name: string;
      readonly state: string;
      readonly wait_event_type: string | null;
    }>(
      `SELECT application_name, state, wait_event_type
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = 'claudian-cloud-reserved'`,
    );
    if (result.rows.some(row => row.wait_event_type === 'Lock')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('application-test-schema-query-not-blocked');
}

async function settleBeforeTest(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('application-test-shutdown-timeout')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function removeSeededProject(
  database: PostgresTestDatabase,
  projectId: string,
): Promise<void> {
  const cleanup = new Client({ connectionString: database.migrationUrl });
  try {
    await cleanup.connect();
    await cleanup.query('BEGIN');
    await cleanup.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [projectId],
    );
    for (const relation of [
      'active_repository_placement_catalog',
      'development_actor_mappings',
      'project_memberships',
      'repository_placements',
      'projects',
    ]) {
      await cleanup.query(
        `DELETE FROM claudian_cloud.${relation} WHERE project_id = $1`,
        [projectId],
      );
    }
    await cleanup.query('COMMIT');
  } catch (error: unknown) {
    await cleanup.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await cleanup.end();
  }
}

describe('application composition', { concurrency: false }, () => {
  let authorityRoot: string;
  let database: PostgresTestDatabase;
  let repositoryRoot: string;

  before(async () => {
    database = await acquirePostgresTestDatabase();
    await new PostgresMigrator({
      connectionString: database.migrationUrl,
    }).apply();
    authorityRoot = await mkdtemp(join(tmpdir(), 'claudian-app-authority-'));
    repositoryRoot = join(authorityRoot, 'repositories');
    await mkdir(repositoryRoot, { mode: 0o700 });
    await mkdir(`${repositoryRoot}-staging`, { mode: 0o700 });
    await writeFile(
      join(authorityRoot, '.authority-volume-id'),
      `${database.authorityVolumeId}\n`,
      { mode: 0o600 },
    );
  });

  after(async () => {
    await rm(authorityRoot, { force: true, recursive: true });
    await database.close();
  });

  it('fails closed on an incompatible schema and releases every pool', async () => {
    const emptyDatabase = await acquirePostgresTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'claudian-app-empty-schema-'));
    const lines: string[] = [];
    try {
      const application = createApplication({
        config: config({
          postgresUrl: emptyDatabase.runtimeUrl,
          repositoryRoot: root,
        }),
        logger: logger(lines),
      });

      await assert.rejects(application.start(), /application\.error\.startup-failed/);
      await application.close();
      await application.close();

      assert.equal(await cloudConnectionCount(emptyDatabase.adminUrl), 0);
      assert.deepEqual(events(lines).map(value => ({
        context: value.context,
        event: value.event,
      })), [
        {
          context: {},
          event: 'server.starting',
        },
        {
          context: { reason: 'schema-incompatible' },
          event: 'server.startup-failed',
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await emptyDatabase.close();
    }
  });

  it('closes every initialized owner when HTTP admission cannot start', async () => {
    const occupied = createServer();
    occupied.listen({ host: '127.0.0.1', port: 0 });
    await once(occupied, 'listening');
    const address = occupied.address();
    if (address === null || typeof address === 'string') {
      throw new Error('application-test-listener-unavailable');
    }
    const lines: string[] = [];
    const application = createApplication({
      config: config({
        httpPort: address.port,
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
      }),
      logger: logger(lines),
    });
    try {
      await assert.rejects(application.start(), /application\.error\.startup-failed/);
      await application.close();
      assert.equal(await cloudConnectionCount(database.adminUrl), 0);
      assert.match(JSON.stringify(events(lines)), /http-listen-failed/);
    } finally {
      await application.close();
      await new Promise<void>((resolve, reject) => {
        occupied.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('fails closed when the authority volume no longer matches PostgreSQL', async () => {
    const marker = join(authorityRoot, '.authority-volume-id');
    const lines: string[] = [];
    await writeFile(marker, `${'f'.repeat(32)}\n`, { mode: 0o600 });
    const application = createApplication({
      config: config({
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
      }),
      logger: logger(lines),
    });
    try {
      await assert.rejects(
        application.start(),
        /application\.error\.startup-failed/,
      );
      assert.match(JSON.stringify(events(lines)), /authority-volume-mismatch/);
      assert.equal(await cloudConnectionCount(database.adminUrl), 0);
    } finally {
      await application.close();
      await writeFile(marker, `${database.authorityVolumeId}\n`, { mode: 0o600 });
    }
  });

  it('settles abandoned expired bootstrap attempts before publishing readiness', async () => {
    const seed = new PostgresCoordination({
      ordinaryPoolMax: 2,
      pinnedPoolMax: 1,
      projectLockTimeoutMs: 1_000,
      reservedPoolMax: 1,
      runtimeConnectionString: database.runtimeUrl,
      shutdownTimeoutMs: 1_000,
    });
    await seed.withProjectScope('project-expired-startup', scope => (
      scope.putDevelopmentBootstrapAttempt({
        attemptId: 'attempt-expired-startup',
        createdAt: '2026-08-18T00:00:00.000Z',
        expiresAt: '2026-08-19T00:00:00.000Z',
        manifestJson: '{"manifest":"expired"}',
        manifestSha256: 'a'.repeat(64),
        projectId: 'project-expired-startup',
        sourceHostMemberId: 'member-expired-startup',
      })
    ));
    await seed.close();

    const application = createApplication({
      config: config({
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
      }),
      logger: logger([]),
    });
    await application.start();
    await application.close();

    const inspection = new PostgresCoordination({
      ordinaryPoolMax: 2,
      pinnedPoolMax: 1,
      projectLockTimeoutMs: 1_000,
      reservedPoolMax: 1,
      runtimeConnectionString: database.runtimeUrl,
      shutdownTimeoutMs: 1_000,
    });
    try {
      await inspection.withProjectScope('project-expired-startup', async scope => {
        const attempt = await scope.getDevelopmentBootstrapAttempt(
          'attempt-expired-startup',
        );
        assert.ok(attempt);
        assert.equal(attempt.state, 'cancelled');
        assert.ok(attempt.settlement);
        assert.equal(attempt.settlement.kind, 'cancellation');
        assert.equal(attempt.settlement.cancellationPhase, 'cancelled');
      });
    } finally {
      await inspection.close();
    }
  });

  it('keeps readiness closed when an active repository no longer has exact refs', async () => {
    const projectId = 'project-active-corrupt';
    const repositoryStorageKey = 'repository_active_corrupt';
    const projectDirectory = join(
      repositoryRoot,
      Buffer.from(projectId, 'utf8').toString('hex'),
    );
    const repositoryPath = join(projectDirectory, repositoryStorageKey);
    const work = join(authorityRoot, 'active-corrupt-work');
    const seed = new Client({ connectionString: database.migrationUrl });
    let application: ReturnType<typeof createApplication> | undefined;
    try {
      await seed.connect();
      await execFileAsync(GIT_EXECUTABLE, ['init', '--initial-branch=main', work]);
      await execFileAsync(GIT_EXECUTABLE, ['config', 'user.email', 'test@example.invalid'], {
        cwd: work,
      });
      await execFileAsync(GIT_EXECUTABLE, ['config', 'user.name', 'Test User'], {
        cwd: work,
      });
      await writeFile(join(work, 'file.txt'), 'content\n');
      await execFileAsync(GIT_EXECUTABLE, ['add', 'file.txt'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'fixture'], { cwd: work });
      const main = await execFileAsync(GIT_EXECUTABLE, ['rev-parse', 'HEAD'], {
        cwd: work,
        encoding: 'utf8',
      });
      const mainOid = main.stdout.trim();
      await execFileAsync(GIT_EXECUTABLE, ['branch', 'members/member-active-a'], {
        cwd: work,
      });
      await execFileAsync(GIT_EXECUTABLE, ['branch', 'members/member-active-b'], {
        cwd: work,
      });
      await mkdir(projectDirectory);
      await execFileAsync(GIT_EXECUTABLE, ['clone', '--bare', work, repositoryPath]);
      await seed.query('BEGIN');
      await seed.query(
        "SELECT set_config('claudian_cloud.project_id', $1, true)",
        [projectId],
      );
      await seed.query(
        `INSERT INTO claudian_cloud.projects (
           project_id, project_name, manager_set_generation,
           expected_main_oid, service_state, created_at, activated_at
         ) VALUES ($1, 'Active corrupt project', 0, $2, 'active', $3, $3)`,
        [projectId, mainOid, '2026-08-21T00:00:00.000Z'],
      );
      for (const [memberId, displayName, role] of [[
        'member-active-a', 'Alice', 'manager',
      ], [
        'member-active-b', 'Bob', 'member',
      ]] as const) {
        await seed.query(
          `INSERT INTO claudian_cloud.project_memberships (
             project_id, member_id, display_name, role, status, revision,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'active', 1, $5, $5)`,
          [projectId, memberId, displayName, role, '2026-08-21T00:00:00.000Z'],
        );
      }
      await seed.query(
        `INSERT INTO claudian_cloud.repository_placements (
           project_id, storage_node_id, repository_storage_key, generation,
           active, created_at, updated_at
         ) VALUES ($1, 'test-node', $2, 1, true, $3, $3)`,
        [projectId, repositoryStorageKey, '2026-08-21T00:00:00.000Z'],
      );
      await seed.query(
        `INSERT INTO claudian_cloud.active_repository_placement_catalog (
           project_id, storage_node_id, repository_storage_key, generation
         ) VALUES ($1, 'test-node', $2, 1)`,
        [projectId, repositoryStorageKey],
      );
      await seed.query('COMMIT');
      await execFileAsync(GIT_EXECUTABLE, [
        '--git-dir',
        repositoryPath,
        'update-ref',
        '-d',
        'refs/heads/members/member-active-b',
      ]);

      const lines: string[] = [];
      application = createApplication({
        config: config({
          postgresUrl: database.runtimeUrl,
          repositoryRoot,
        }),
        logger: logger(lines),
      });
      await assert.rejects(
        application.start(),
        /application\.error\.startup-failed/u,
      );
      assert.match(JSON.stringify(events(lines)), /repository-corrupt/u);
    } finally {
      await application?.close().catch(() => undefined);
      await seed.end().catch(() => undefined);
      await removeSeededProject(database, projectId);
      await rm(work, { force: true, recursive: true });
      await rm(projectDirectory, { force: true, recursive: true });
    }
  });

  it('rejects an invalid repository root before Git and sanitizes the failure', async () => {
    const executableRoot = await mkdtemp(join(tmpdir(), 'claudian-app-root-check-'));
    const marker = join(executableRoot, 'spawned.marker');
    const executable = await writeExecutable(
      executableRoot,
      'fake-git',
      `printf spawned > '${marker}'\nprintf 'git version 2.39.0\\n'`,
    );
    const missingRoot = join(executableRoot, 'missing-repositories');
    const lines: string[] = [];
    try {
      const application = createApplication({
        config: config({
          gitExecutable: executable,
          postgresUrl: database.runtimeUrl,
          repositoryRoot: missingRoot,
        }),
        logger: logger(lines),
      });

      await assert.rejects(application.start(), /application\.error\.startup-failed/);
      await application.close();

      await assert.rejects(access(marker), { code: 'ENOENT' });
      assert.equal(await cloudConnectionCount(database.adminUrl), 0);
      const encoded = JSON.stringify(events(lines));
      assert.match(encoded, /repository-unavailable/);
      assert.doesNotMatch(encoded, new RegExp(executableRoot));
    } finally {
      await rm(executableRoot, { force: true, recursive: true });
    }
  });

  it('keeps readiness false until PostgreSQL, root, and Git checks pass', async () => {
    const executableRoot = await mkdtemp(join(tmpdir(), 'claudian-app-delayed-git-'));
    const marker = join(executableRoot, 'started.marker');
    const release = join(executableRoot, 'release.marker');
    const executable = await writeExecutable(
      executableRoot,
      'fake-git',
      `printf started > '${marker}'
while [ ! -f '${release}' ]; do sleep 0.01; done
printf 'git version 2.39.0\\n'`,
    );
    const lines: string[] = [];
    const application = createApplication({
      config: config({
        gitExecutable: executable,
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
      }),
      logger: logger(lines),
    });
    try {
      const starting = application.start();
      let startupSettled = false;
      void starting.then(
        () => {
          startupSettled = true;
        },
        () => {
          startupSettled = true;
        },
      );
      await waitForFile(marker);
      assert.equal(startupSettled, false);

      await writeFile(release, 'release');
      const address = await starting;
      const response = await fetch(
        `http://${address.host}:${String(address.port)}/readyz`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ready' });

      await application.close();
      await application.close();
      assert.equal(await cloudConnectionCount(database.adminUrl), 0);
      assert.deepEqual(
        events(lines).map(value => value.event),
        [
          'server.starting',
          'server.listening',
          'server.stopping',
          'server.stopped',
        ],
      );
    } finally {
      await application.close();
      await rm(executableRoot, { force: true, recursive: true });
    }
  });

  it('terminates an active startup Git child within the shutdown budget', async () => {
    const executableRoot = await mkdtemp(join(tmpdir(), 'claudian-app-closing-git-'));
    const marker = join(executableRoot, 'pid.marker');
    const executable = await writeExecutable(
      executableRoot,
      'fake-git',
      `printf '%s' "$$" > '${marker}'
trap '' TERM
while :; do sleep 1; done`,
    );
    const application = createApplication({
      config: config({
        gitExecutable: executable,
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
      }),
      logger: logger([]),
    });
    let pid: number | undefined;
    try {
      const starting = application.start();
      await waitForFile(marker);
      pid = Number(await import('node:fs/promises').then(fs => fs.readFile(marker, 'utf8')));

      const startedAt = Date.now();
      const closing = application.close();
      await assert.rejects(
        application.start(),
        /application\.error\.closed/,
      );
      await assert.rejects(starting, /application\.error\.startup-failed/);
      await closing;

      assert.equal(Date.now() - startedAt < 1_000, true);
      await waitForProcessExit(pid);
      assert.equal(await cloudConnectionCount(database.adminUrl), 0);
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The Git process is expected to be absent.
        }
      }
      await application.close();
      await rm(executableRoot, { force: true, recursive: true });
    }
  });

  it('terminates a blocked startup schema query within the shutdown budget', async () => {
    const blocker = new Client({ connectionString: database.adminUrl });
    const lines: string[] = [];
    const baseConfig = config({
      postgresUrl: database.runtimeUrl,
      repositoryRoot,
    });
    const application = createApplication({
      config: Object.freeze({
        ...baseConfig,
        postgres: Object.freeze({
          ...baseConfig.postgres,
          projectLockTimeoutMs: 60_000,
        }),
        shutdownTimeoutMs: 500,
      }),
      logger: logger(lines),
    });
    let closing: Promise<void> | undefined;
    try {
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'LOCK TABLE claudian_cloud.schema_migrations IN ACCESS EXCLUSIVE MODE',
      );

      const starting = application.start();
      const startupFailure = assert.rejects(
        starting,
        /application\.error\.startup-failed/,
      );
      await waitForBlockedSchemaQuery(blocker);

      const startedAt = Date.now();
      closing = application.close();
      await settleBeforeTest(closing, 1_000);
      await startupFailure;

      assert.equal(Date.now() - startedAt < 1_000, true);
      await waitForNoCloudConnections(database.adminUrl);
      assert.deepEqual(
        events(lines).map(value => value.event),
        ['server.starting', 'server.stopping', 'server.stopped'],
      );
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end().catch(() => undefined);
      await closing?.catch(() => undefined);
      await application.close().catch(() => undefined);
    }
  });

  it('rejects unsupported Git without exposing dependency output', async () => {
    const executableRoot = await mkdtemp(join(tmpdir(), 'claudian-app-unsupported-git-'));
    const executable = await writeExecutable(
      executableRoot,
      'fake-git',
      'printf "git version 2.38.5 private-version-sentinel\\n"',
    );
    const lines: string[] = [];
    try {
      const application = createApplication({
        config: config({
          gitExecutable: executable,
          postgresUrl: database.runtimeUrl,
          repositoryRoot,
        }),
        logger: logger(lines),
      });

      await assert.rejects(application.start(), /application\.error\.startup-failed/);
      await application.close();

      const encoded = JSON.stringify(events(lines));
      assert.match(encoded, /unsupported-git/);
      assert.doesNotMatch(encoded, /2\.38\.5|private-version-sentinel/);
      assert.doesNotMatch(encoded, new RegExp(executableRoot));
      assert.equal(await cloudConnectionCount(database.adminUrl), 0);
    } finally {
      await rm(executableRoot, { force: true, recursive: true });
    }
  });

  it('starts with the real Git executable after all checks', async () => {
    const application = createApplication({
      config: config({
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
      }),
      logger: logger([]),
    });
    try {
      const version = await execFileAsync(GIT_EXECUTABLE, ['--version']);
      assert.match(version.stdout, /^git version /);
      const address = await application.start();
      const ready = await fetch(
        `http://${address.host}:${String(address.port)}/readyz`,
      );
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: 'ready' });
    } finally {
      await application.close();
    }
  });
});
