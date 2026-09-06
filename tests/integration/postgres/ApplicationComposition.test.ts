import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
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
import { WebSocket } from 'ws';
import {
  collabCloudAuthorityTransferArtifactRoute,
  collabCloudGitRoute,
  collabCloudProjectEventsRoute,
  collabCloudProjectOperationRoute,
  collabMemberRef,
  decodeCollabCloudCapabilityDocument,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudSuccessEnvelope,
  type CollabCloudJsonOperation,
  type ListProjectMembersResponse,
} from '@claudian-collab/protocol';

import { createApplication } from '../../../src/composition/createApplication.js';
import { ComposedCloudLifecycleRuntime } from '../../../src/composition/CloudLifecycleRuntime.js';
import { TerminalResponderExpiryReconciler } from '../../../src/composition/TerminalResponderExpiryReconciler.js';
import { decodeClaimCustodyKeyring } from '../../../src/config/ClaimCustodyKeyringConfig.js';
import type { ServerConfig } from '../../../src/config/ServerConfig.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
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
  readonly principalProfile?: ServerConfig['principalProfile'];
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
    eventAdmission: Object.freeze({
      maxConnections: 8,
      maxConnectionsPerProject: 4,
      maxPendingAuthorizations: 4,
    }),
    gitAdmission: Object.freeze({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      maxQueuedReads: 5,
      maxQueuedWrites: 5,
      maxReadChildren: 1,
      maxWriteChildren: 1,
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
    principalProfile: options.principalProfile ?? 'private-development',
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

function keyring() {
  const pair = generateKeyPairSync('ed25519');
  return decodeClaimCustodyKeyring({
    activeEncryptionKeyId: 'test-encryption-key',
    activeReceiptKeyId: 'test-receipt-key',
    encryptionKeys: [{
      key: Buffer.alloc(32, 7).toString('base64url'),
      keyId: 'test-encryption-key',
      keyVersion: 1,
    }],
    receiptKeys: [{
      keyId: 'test-receipt-key',
      keyVersion: 1,
      privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' })
        .toString('base64url'),
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' })
        .toString('base64url'),
    }],
    schemaVersion: 1,
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

async function projectOperation(
  baseUrl: string,
  credential: string,
  projectId: string,
  operation: CollabCloudJsonOperation,
  data: unknown,
): Promise<unknown> {
  const route = collabCloudProjectOperationRoute(projectId, operation);
  const response = await fetch(`${baseUrl}${route.target}`, {
    body: JSON.stringify({
      data,
      protocolVersion: 9,
      requestId: `request-${operation}`,
    }),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credential}`,
    },
    method: route.method,
  });
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return decodeCollabCloudSuccessEnvelope(body).data;
}

async function rejectedProjectOperation(
  baseUrl: string,
  credential: string,
  projectId: string,
  operation: CollabCloudJsonOperation,
  data: unknown,
): Promise<void> {
  const route = collabCloudProjectOperationRoute(projectId, operation);
  const response = await fetch(`${baseUrl}${route.target}`, {
    body: JSON.stringify({
      data,
      protocolVersion: 9,
      requestId: `request-rejected-${operation}`,
    }),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credential}`,
    },
    method: route.method,
  });
  assert.notEqual(response.status, 200);
  await response.body?.cancel();
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
    await new PostgresSchemaInitializer({
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
    let lifecycleStarted = false;
    const application = createApplication({
      config: config({
        httpPort: address.port,
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
      }),
      lifecycle: {
        artifacts: {
          download: () => Promise.reject(new Error('unused')),
          upload: () => Promise.reject(new Error('unused')),
        },
        close: () => Promise.resolve(),
        control: {
          execute: () => Promise.reject(new Error('unused')),
          getRetirementTerminal: () => Promise.resolve(null),
        },
        reconcileAll: () => Promise.resolve(),
        recovery: {
          recoverCandidate: () => Promise.resolve(),
          recoverProject: () => Promise.resolve(),
        },
        start: () => { lifecycleStarted = true; },
      },
      logger: logger(lines),
    });
    try {
      await assert.rejects(application.start(), /application\.error\.startup-failed/);
      await application.close();
      assert.equal(await cloudConnectionCount(database.adminUrl), 0);
      assert.equal(lifecycleStarted, false);
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
        'LOCK TABLE claudian_cloud.schema_metadata IN ACCESS EXCLUSIVE MODE',
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
      const createRoute = collabCloudProjectOperationRoute(
        'project-development-membership-disabled',
        'createCloudProject',
      );
      const createResponse = await fetch(
        `http://${address.host}:${String(address.port)}${createRoute.target}`,
        {
          body: '{}',
          headers: {
            'content-type': 'application/json',
            'x-claudian-development-actor': 'development-actor',
          },
          method: createRoute.method,
        },
      );
      assert.equal(createResponse.status, 404);
    } finally {
      await application.close();
    }
  });

  it('advertises lifecycle support only after its complete runtime is ready', async () => {
    const lifecycle: string[] = [];
    const application = createApplication({
      config: config({
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
      }),
      lifecycle: {
        artifacts: {
          download: () => Promise.reject(new Error('unused')),
          upload: () => Promise.reject(new Error('unused')),
        },
        close: () => {
          lifecycle.push('close');
          return Promise.resolve();
        },
        control: {
          execute: () => Promise.reject(new Error('unused')),
          getRetirementTerminal: () => Promise.resolve(null),
        },
        reconcileAll: () => {
          lifecycle.push('reconcile');
          return Promise.resolve();
        },
        recovery: {
          recoverCandidate: () => Promise.resolve(),
          recoverProject: () => Promise.resolve(),
        },
        start: () => lifecycle.push('start'),
      },
      logger: logger([]),
    });
    try {
      const address = await application.start();
      assert.deepEqual(lifecycle, ['reconcile', 'start']);
      const response = await fetch(
        `http://${address.host}:${String(address.port)}/collab/capabilities`,
      );
      assert.equal(response.status, 200);
      const capabilities = decodeCollabCloudCapabilityDocument(
        await response.json(),
      ).capabilities;
      assert.equal(capabilities.includes('authority-transfer'), true);
      assert.equal(capabilities.includes('project-retirement'), true);
    } finally {
      await application.close();
    }
    assert.deepEqual(lifecycle, [
      'reconcile',
      'start',
      'close',
    ]);
  });

  it('selects the production principal binding from the complete runtime config', async () => {
    const baseConfig = config({
      postgresUrl: database.runtimeUrl,
      repositoryRoot,
    });
    const application = createApplication({
      config: Object.freeze({
        ...baseConfig,
        principalProfile: 'vault-credential',
      }),
      keyring: keyring(),
      logger: logger([]),
    });
    try {
      const address = await application.start();
      const response = await fetch(`http://${address.host}:${String(address.port)}/collab/capabilities`);
      assert.equal(response.status, 200);
      const capabilities = decodeCollabCloudCapabilityDocument(await response.json()).capabilities;
      assert.equal(capabilities.includes('development-bootstrap'), false);
      for (const capability of [
        'authority-transfer',
        'cloud-imported-membership-claims',
        'cloud-project-create',
        'cloud-project-invitations',
        'cloud-project-join',
        'cloud-project-leave',
        'cloud-project-manager-responsibility',
        'cloud-project-membership',
        'project-retirement',
      ]) assert.equal(capabilities.includes(capability), true);
    } finally {
      await application.close();
    }
  });

  it('serves one production lifecycle owner to two credential-authenticated Vaults across restart', async () => {
    const projectId = 'project-production-lifecycle';
    const managerCredential = 'a'.repeat(64);
    const targetCredential = 'b'.repeat(64);
    const productionDatabase = await acquirePostgresTestDatabase();
    await new PostgresSchemaInitializer({
      connectionString: productionDatabase.migrationUrl,
    }).apply();
    const productionAuthorityRoot = await mkdtemp(join(
      tmpdir(),
      'claudian-production-composition-',
    ));
    const productionRepositoryRoot = join(productionAuthorityRoot, 'repositories');
    await mkdir(productionRepositoryRoot, { mode: 0o700 });
    await mkdir(`${productionRepositoryRoot}-staging`, { mode: 0o700 });
    await writeFile(
      join(productionAuthorityRoot, '.authority-volume-id'),
      `${productionDatabase.authorityVolumeId}\n`,
      { mode: 0o600 },
    );
    const baseConfig = config({
      postgresUrl: productionDatabase.runtimeUrl,
      repositoryRoot: productionRepositoryRoot,
    });
    const productionConfig: ServerConfig = Object.freeze({
      ...baseConfig,
      principalProfile: 'vault-credential',
    });
    const custody = keyring();
    const logs: string[] = [];
    const application = () => createApplication({
      config: productionConfig,
      keyring: custody,
      logger: logger(logs),
    });
    let running = application();
    try {
      let address = await running.start();
      const created = await projectOperation(
        `http://${address.host}:${String(address.port)}`,
        managerCredential,
        projectId,
        'createCloudProject',
        {
          idempotencyKey: 'create-production-lifecycle',
          managerDisplayName: 'Production Manager',
          projectId,
          projectName: 'Production Lifecycle',
        },
      ) as Readonly<{ readonly memberId: string }>;
      const origin = `http://${address.host}:${String(address.port)}`;
      const claimedPrincipal = 'vault-ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb';
      const snapshotRoute = collabCloudProjectOperationRoute(projectId, 'getProjectSnapshot');
      const gitRoute = collabCloudGitRoute(projectId, 'info-refs', 'git-upload-pack');
      const eventsRoute = collabCloudProjectEventsRoute(projectId, 0);
      const artifactRoute = collabCloudAuthorityTransferArtifactRoute(projectId, 'transfer-unknown', 'download', 'checkpoint.json');
      for (const [headers, status, errorCode] of [
        [{ 'x-claudian-ingress-principal': claimedPrincipal }, 403, 'authentication-failed'],
        [{ authorization: `Bearer ${'d'.repeat(64)}`, 'x-claudian-ingress-principal': claimedPrincipal }, 404, 'project-not-found'],
      ] as const) {
        const snapshot = await fetch(`${origin}${snapshotRoute.target}`, {
          body: JSON.stringify({ data: { projectId }, protocolVersion: 9, requestId: 'credential-isolation' }),
          headers: { ...headers, 'content-type': 'application/json' },
          method: snapshotRoute.method,
        });
        assert.equal(snapshot.status, status);
        assert.equal(decodeCollabCloudErrorEnvelope(await snapshot.json()).error.code, errorCode);
        const git = await fetch(`${origin}${gitRoute.target}`, { headers, method: gitRoute.method });
        assert.equal(git.status, status);
        await git.body?.cancel();
        const socket = new WebSocket(`ws://${address.host}:${String(address.port)}${eventsRoute.target}`, {
          headers, handshakeTimeout: 2_000,
        });
        const [failure] = await once(socket, 'error') as [Error];
        assert.match(failure.message, new RegExp(`Unexpected server response: ${String(status)}`, 'u'));
      }
      const artifact = await fetch(`${origin}${artifactRoute.target}`, {
        headers: { 'x-claudian-ingress-principal': claimedPrincipal }, method: artifactRoute.method,
      });
      assert.equal(artifact.status, 403);
      assert.equal(decodeCollabCloudErrorEnvelope(await artifact.json()).error.code, 'authentication-failed');
      const events = new WebSocket(`ws://${address.host}:${String(address.port)}${eventsRoute.target}`, {
        headers: { authorization: `Bearer ${managerCredential}` }, handshakeTimeout: 2_000,
      });
      await once(events, 'open');
      const eventsClosed = once(events, 'close');
      events.close();
      await eventsClosed;
      const invitation = await projectOperation(
        `http://${address.host}:${String(address.port)}`,
        managerCredential,
        projectId,
        'createProjectInvitation',
        {
          expectedManagerSetGeneration: 1,
          idempotencyKey: 'invite-production-target',
          projectId,
        },
      ) as Readonly<{
        readonly invitationId: string;
        readonly secret: string;
      }>;
      const joined = await projectOperation(
        `http://${address.host}:${String(address.port)}`,
        targetCredential,
        projectId,
        'joinCloudProject',
        {
          displayName: 'Production Target',
          idempotencyKey: 'join-production-target',
          invitationId: invitation.invitationId,
          projectId,
          secret: invitation.secret,
        },
      ) as Readonly<{ readonly memberId: string }>;
      for (const [credential, memberId, role] of [
        [managerCredential, created.memberId, 'manager'],
        [targetCredential, joined.memberId, 'member'],
      ] as const) {
        const snapshot = await projectOperation(
          `http://${address.host}:${String(address.port)}`, credential, projectId, 'getProjectSnapshot', { projectId },
        ) as { readonly currentMember: { readonly id: string; readonly role: string } };
        assert.equal(snapshot.currentMember.id, memberId);
        assert.equal(snapshot.currentMember.role, role);
      }
      const begun = await projectOperation(
        `http://${address.host}:${String(address.port)}`,
        managerCredential,
        projectId,
        'beginCloudToLanTransfer',
        {
          expectedAuthorityGeneration: 1,
          idempotencyKey: 'begin-production-transfer',
          projectId,
          targetHostMemberId: joined.memberId,
          targetUrl: 'https://lan.example.test:8443',
        },
      ) as Readonly<{
        readonly phase: string;
        readonly transferId: string;
      }>;
      assert.equal(begun.phase, 'collecting-readiness');

      await running.close();
      running = application();
      address = await running.start();
      const replay = await projectOperation(
        `http://${address.host}:${String(address.port)}`,
        managerCredential,
        projectId,
        'getProjectAuthorityTransfer',
        { projectId, transferId: begun.transferId },
      ) as Readonly<{ readonly phase: string; readonly transferId: string }>;
      assert.deepEqual(replay, begun);
      const serialized = JSON.stringify(logs);
      for (const secret of [managerCredential, targetCredential, 'd'.repeat(64)]) {
        assert.equal(serialized.includes(secret), false);
      }
    } finally {
      await running.close();
      await rm(productionAuthorityRoot, { force: true, recursive: true });
      await productionDatabase.close();
    }
  });

  it('returns the imported transfer descriptor and replays the durable claim', async () => {
    const database = await acquirePostgresTestDatabase();
    await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
    const authorityRoot = await mkdtemp(join(tmpdir(), 'claudian-reissue-descriptor-'));
    const repositoryRoot = join(authorityRoot, 'repositories');
    await mkdir(repositoryRoot, { mode: 0o700 });
    await mkdir(`${repositoryRoot}-staging`, { mode: 0o700 });
    await writeFile(join(authorityRoot, '.authority-volume-id'), `${database.authorityVolumeId}\n`, { mode: 0o600 });
    const projectId = 'project-reissue-descriptor';
    const transferId = 'transfer-reissue-descriptor';
    const importedMemberId = 'member-reissue-descriptor';
    const managerCredential = 'a'.repeat(64);
    const custody = keyring();
    const running = createApplication({
      config: config({ postgresUrl: database.runtimeUrl, repositoryRoot, principalProfile: 'vault-credential' }),
      keyring: custody,
      logger: logger([]),
    });
    try {
      const address = await running.start();
      const baseUrl = `http://${address.host}:${String(address.port)}`;
      const created = await projectOperation(
        baseUrl, managerCredential, projectId, 'createCloudProject', {
          idempotencyKey: 'create-reissue-project',
          managerDisplayName: 'Reissue Manager',
          projectId,
          projectName: 'Reissue Project',
        },
      ) as Readonly<{ readonly mainOid: string; readonly memberId: string }>;
      const invitation = await projectOperation(
        baseUrl, managerCredential, projectId, 'createProjectInvitation', {
          expectedManagerSetGeneration: 1,
          idempotencyKey: 'reissue-member-invitation',
          projectId,
        },
      ) as Readonly<{ readonly invitationId: string; readonly secret: string }>;
      const ordinaryCredential = 'b'.repeat(64);
      const ordinaryMember = await projectOperation(
        baseUrl, ordinaryCredential, projectId, 'joinCloudProject', {
          displayName: 'Ordinary Member',
          idempotencyKey: 'reissue-member-join',
          invitationId: invitation.invitationId,
          projectId,
          secret: invitation.secret,
        },
      ) as Readonly<{ readonly memberId: string }>;
      // A completed import with logical generation seven and an expired original
      // claim is the accepted SQL fixture; repository placement stays at one.
      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        await migration.query('BEGIN');
        await migration.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [projectId],
        );
        await migration.query(
          `UPDATE claudian_cloud.projects SET authority_generation = 7
             WHERE project_id = $1`,
          [projectId],
        );
        await migration.query(
          `INSERT INTO claudian_cloud.project_memberships (
             project_id, member_id, role, status, revision, display_name,
             created_at, updated_at, activated_at
           ) VALUES ($1, $2, 'member', 'active', 1, 'Imported Member',
                     '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z',
                     '2026-06-01T00:00:00Z')`,
          [projectId, importedMemberId],
        );
        await migration.query(
          `INSERT INTO claudian_cloud.project_lifecycle_journals (
             project_id, operation_id, kind, direction, phase,
             recovery_from_phase, state, expected_authority_generation,
             actor_member_id, idempotency_key, request_fingerprint,
             checkpoint_sha256, batch_revision, batch_sha256, result_sha256,
             scheduled_at, created_at, updated_at
           ) VALUES ($1, $2, 'authority-transfer', 'lan-to-cloud', 'completed',
             NULL, 'completed', 6, $3, 'reissue-import-key', repeat('8', 64),
             repeat('a', 64), 1, repeat('b', 64), NULL,
             '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
          [projectId, transferId, created.memberId],
        );
        await migration.query('COMMIT');
      } finally {
        await migration.end();
      }
      const store = new PostgresCoordination({
        ...config({ postgresUrl: database.runtimeUrl, repositoryRoot }).postgres,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 1_000,
      });
      try {
        const placement = await store.withProjectScope(projectId, async scope => {
          const receiptPublicKey = custody.receiptKeys[0]?.publicKey.export({ format: 'jwk' }).x;
          assert.ok(receiptPublicKey);
          await scope.portability.putTransferReceiptKey({
            createdAt: '2026-06-01T00:00:00.000Z',
            publicKey: receiptPublicKey,
            receiptKeyId: custody.activeReceiptKeyId,
            transferId,
          });
          await scope.portability.putTransferredMembershipClaim({
            batchRevision: 1,
            checkpointSha256: 'a'.repeat(64),
            claimSha256: 'c'.repeat(64),
            createdAt: '2026-06-01T00:00:00.000Z',
            expiresAt: '2026-07-01T00:00:00.000Z',
            memberId: importedMemberId,
            transferId,
          });
          return scope.getRepositoryPlacement();
        });
        assert.ok(placement);
        await execFileAsync(GIT_EXECUTABLE, [
          '--git-dir', join(repositoryRoot, Buffer.from(projectId).toString('hex'), placement.repositoryStorageKey),
          'update-ref', collabMemberRef(importedMemberId), created.mainOid,
        ]);
      } finally {
        await store.close();
      }
      const request = {
        expectedClaimGeneration: 0,
        expectedManagerSetGeneration: 1,
        expectedMembershipRevision: 1,
        idempotencyKey: 'reissue-descriptor-key',
        memberId: importedMemberId,
        projectId,
      };
      const originalMembers = await projectOperation(
        baseUrl, managerCredential, projectId, 'listProjectMembers', { projectId },
      ) as ListProjectMembersResponse;
      const original = originalMembers.members.find(member => member.memberId === importedMemberId);
      assert.equal(original?.importedClaimState, 'expired');
      assert.equal(original.importedClaimGeneration, 0);
      const ordinaryMembers = await projectOperation(
        baseUrl, ordinaryCredential, projectId, 'listProjectMembers', { projectId },
      ) as ListProjectMembersResponse;
      assert.ok(ordinaryMembers.members.every(member => (
        member.importedClaimState === 'hidden' && member.importedClaimGeneration === null
      )));
      await rejectedProjectOperation(
        baseUrl, ordinaryCredential, projectId, 'reissueTransferredMembershipClaim', request,
      );
      await rejectedProjectOperation(
        baseUrl, managerCredential, projectId, 'reissueTransferredMembershipClaim', {
          ...request, memberId: ordinaryMember.memberId,
        },
      );
      const response = await projectOperation(
        baseUrl, managerCredential, projectId, 'reissueTransferredMembershipClaim', request,
      ) as Readonly<{
        readonly claimGeneration: number;
        readonly createdAt: string;
        readonly expiresAt: string;
        readonly memberId: string;
        readonly projectId: string;
        readonly targetAuthorityGeneration: number;
        readonly transferId: string;
      }>;
      assert.equal(response.transferId, transferId);
      assert.equal(response.targetAuthorityGeneration, 7);
      assert.equal(response.projectId, projectId);
      assert.equal(response.memberId, importedMemberId);
      assert.equal(response.claimGeneration, 1);
      assert.equal(Date.parse(response.expiresAt) - Date.parse(response.createdAt), 2_592_000_000);
      assert.deepEqual(await projectOperation(
        baseUrl, managerCredential, projectId, 'reissueTransferredMembershipClaim', request,
      ), response);
      await rejectedProjectOperation(
        baseUrl, 'd'.repeat(64), projectId,
        'reissueTransferredMembershipClaim', request,
      );
      await rejectedProjectOperation(
        baseUrl, managerCredential, projectId, 'reissueTransferredMembershipClaim', {
          ...request, idempotencyKey: 'reissue-stale-key',
        },
      );
      const expiryStore = new PostgresCoordination({
        ...config({ postgresUrl: database.runtimeUrl, repositoryRoot }).postgres,
        runtimeConnectionString: database.runtimeUrl,
        shutdownTimeoutMs: 1_000,
      });
      try {
        const expiredMembers = await expiryStore.withProjectScope(projectId, scope => (
          scope.membership.listProjectMembers({ actorRole: 'manager', now: response.expiresAt })
        ));
        const expired = expiredMembers.members.find(member => member.memberId === importedMemberId);
        assert.equal(expired?.importedClaimState, 'expired');
        assert.equal(expired.importedClaimGeneration, 1);
      } finally {
        await expiryStore.close();
      }
    } finally {
      await running.close();
      await rm(authorityRoot, { force: true, recursive: true });
      await database.close();
    }
  });

  it('joins every Cloud membership group through the real process and restart path', async () => {
    const projectId = 'project-membership-process';
    const otherProjectId = 'project-membership-cross-scope';
    const managerCredential = 'a'.repeat(64);
    const memberACredential = 'b'.repeat(64);
    const memberBCredential = 'c'.repeat(64);
    const custody = keyring();
    const application = () => createApplication({
      config: config({
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
        principalProfile: 'vault-credential',
      }),
      keyring: custody,
      logger: logger([]),
    });
    let running = application();
    try {
      let address = await running.start();
      let baseUrl = `http://${address.host}:${String(address.port)}`;
      const created = await projectOperation(
        baseUrl,
        managerCredential,
        projectId,
        'createCloudProject',
        {
          idempotencyKey: 'create-process-project',
          managerDisplayName: 'Process Manager',
          projectId,
          projectName: 'Membership Process Project',
        },
      ) as Readonly<{ readonly mainOid: string }>;
      const snapshotRoute = collabCloudProjectOperationRoute(
        projectId,
        'getProjectSnapshot',
      );
      const snapshotResponse = await fetch(`${baseUrl}${snapshotRoute.target}`, {
        body: JSON.stringify({
          data: { projectId },
          protocolVersion: 9,
          requestId: 'request-production-snapshot',
        }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${managerCredential}`,
        },
        method: snapshotRoute.method,
      });
      assert.equal(snapshotResponse.status, 200);
      const snapshot: unknown = await snapshotResponse.json();
      assert.equal(
        (decodeCollabCloudSuccessEnvelope(snapshot).data as Readonly<{
          readonly project: Readonly<{ readonly id: string }>;
        }>).project.id,
        projectId,
      );
      const gitRoute = collabCloudGitRoute(
        projectId,
        'info-refs',
        'git-upload-pack',
      );
      const gitResponse = await fetch(`${baseUrl}${gitRoute.target}`, {
        headers: { authorization: `Bearer ${managerCredential}` },
        method: gitRoute.method,
      });
      assert.equal(gitResponse.status, 200);
      await gitResponse.body?.cancel();
      await projectOperation(
        baseUrl,
        'd'.repeat(64),
        otherProjectId,
        'createCloudProject',
        {
          idempotencyKey: 'create-cross-scope-project',
          managerDisplayName: 'Cross Scope Manager',
          projectId: otherProjectId,
          projectName: 'Cross Scope Project',
        },
      );

      const inviteARequest = {
        expectedManagerSetGeneration: 1,
        idempotencyKey: 'invite-process-member-a',
        projectId,
      };
      const invitationA = await projectOperation(
        baseUrl,
        managerCredential,
        projectId,
        'createProjectInvitation',
        inviteARequest,
      ) as Readonly<{
        readonly invitationId: string;
        readonly secret: string;
      }>;
      const memberA = await projectOperation(
        baseUrl,
        memberACredential,
        projectId,
        'joinCloudProject',
        {
          displayName: 'Process Member A',
          idempotencyKey: 'join-process-member-a',
          invitationId: invitationA.invitationId,
          projectId,
          secret: invitationA.secret,
        },
      ) as Readonly<{ readonly memberId: string }>;
      await rejectedProjectOperation(
        baseUrl,
        memberACredential,
        otherProjectId,
        'listProjectMembers',
        { projectId: otherProjectId },
      );

      const invitationB = await projectOperation(
        baseUrl,
        managerCredential,
        projectId,
        'createProjectInvitation',
        {
          expectedManagerSetGeneration: 1,
          idempotencyKey: 'invite-process-member-b',
          projectId,
        },
      ) as Readonly<{
        readonly invitationId: string;
        readonly secret: string;
      }>;
      assert.deepEqual(
        await projectOperation(
          baseUrl,
          managerCredential,
          projectId,
          'createProjectInvitation',
          {
            expectedManagerSetGeneration: 1,
            idempotencyKey: 'invite-process-member-b',
            projectId,
          },
        ),
        invitationB,
      );
      const memberB = await projectOperation(
        baseUrl,
        memberBCredential,
        projectId,
        'joinCloudProject',
        {
          displayName: 'Process Member B',
          idempotencyKey: 'join-process-member-b',
          invitationId: invitationB.invitationId,
          projectId,
          secret: invitationB.secret,
        },
      ) as Readonly<{ readonly memberId: string }>;
      const members = await projectOperation(
        baseUrl,
        managerCredential,
        projectId,
        'listProjectMembers',
        { projectId },
      ) as Readonly<{ readonly members: readonly unknown[] }>;
      assert.equal(members.members.length, 3);

      await rejectedProjectOperation(
        baseUrl,
        managerCredential,
        projectId,
        'reissueTransferredMembershipClaim',
        {
          expectedClaimGeneration: 0,
          expectedManagerSetGeneration: 1,
          expectedMembershipRevision: 2,
          idempotencyKey: 'reissue-ordinary-member',
          memberId: memberA.memberId,
          projectId,
        },
      );
      const offer = await projectOperation(
        baseUrl,
        managerCredential,
        projectId,
        'createManagerResponsibilityOffer',
        {
          expectedManagerSetGeneration: 1,
          expectedTargetMembershipRevision: 2,
          idempotencyKey: 'offer-process-member-a',
          projectId,
          purpose: 'manager-promotion',
          targetMemberId: memberA.memberId,
        },
      ) as Readonly<{ readonly offer: Readonly<{ readonly offerId: string }> }>;
      const acknowledged = await projectOperation(
        baseUrl,
        memberACredential,
        projectId,
        'acknowledgeManagerResponsibility',
        {
          expectedOfferRevision: 1,
          idempotencyKey: 'acknowledge-process-offer',
          offerId: offer.offer.offerId,
          projectId,
        },
      ) as Readonly<{ readonly offer: Readonly<{ readonly revision: number }> }>;
      await projectOperation(
        baseUrl,
        managerCredential,
        projectId,
        'promoteManager',
        {
          expectedManagerSetGeneration: 1,
          expectedOfferRevision: acknowledged.offer.revision,
          expectedTargetMembershipRevision: 2,
          idempotencyKey: 'promote-process-member-a',
          managerResponsibilityOfferId: offer.offer.offerId,
          projectId,
          targetMemberId: memberA.memberId,
        },
      );
      await projectOperation(
        baseUrl,
        managerCredential,
        projectId,
        'demoteManager',
        {
          expectedManagerSetGeneration: 2,
          expectedTargetMembershipRevision: 3,
          idempotencyKey: 'demote-process-member-a',
          projectId,
          targetMemberId: memberA.memberId,
        },
      );
      await projectOperation(
        baseUrl,
        managerCredential,
        projectId,
        'removeMember',
        {
          expectedManagerSetGeneration: 3,
          expectedTargetMembershipRevision: 2,
          idempotencyKey: 'remove-process-member-b',
          projectId,
          targetMemberId: memberB.memberId,
        },
      );
      await projectOperation(
        baseUrl,
        memberACredential,
        projectId,
        'leaveProject',
        {
          expectedManagerSetGeneration: 3,
          expectedMembershipRevision: 4,
          expectedOfferRevision: null,
          expectedPersonalRefOid: created.mainOid,
          idempotencyKey: 'leave-process-member-a',
          managerResponsibilityOfferId: null,
          projectId,
        },
      );

      await running.close();
      running = application();
      address = await running.start();
      baseUrl = `http://${address.host}:${String(address.port)}`;
      assert.deepEqual(
        await projectOperation(
          baseUrl,
          managerCredential,
          projectId,
          'createProjectInvitation',
          inviteARequest,
        ),
        invitationA,
      );
    } finally {
      await running.close();
    }
  });

  it('does not close lifecycle owners beneath foreground startup reconciliation', async () => {
    let entered!: () => void;
    const reconciling = new Promise<void>(resolve => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const closed: string[] = [];
    const expiry = new TerminalResponderExpiryReconciler({
      catalog: {
        listTerminalResponders: async () => {
          entered();
          await blocked;
          return { nextCursor: undefined, responders: [] };
        },
      },
      expiry: { expire: () => Promise.resolve('replayed') },
      intervalMs: 60_000,
    });
    const lifecycle = new ComposedCloudLifecycleRuntime({
      artifacts: {
        download: () => Promise.reject(new Error('unused')),
        upload: () => Promise.reject(new Error('unused')),
      },
      closeOrder: [{ close: () => { closed.push('transfer-owners'); } }],
      control: {
        execute: () => Promise.reject(new Error('unused')),
        getRetirementTerminal: () => Promise.resolve(null),
      },
      expiry,
      recoveryReconciler: {
        close: () => Promise.resolve(),
        reconcileAll: () => Promise.resolve(),
        start: () => undefined,
      },
      recovery: {
        close: () => { closed.push('recovery'); },
        recoverCandidate: () => Promise.resolve(),
        recoverProject: () => Promise.resolve(),
      },
    });
    const application = createApplication({
      config: config({
        postgresUrl: database.runtimeUrl,
        repositoryRoot,
      }),
      lifecycle,
      logger: logger([]),
    });

    const starting = application.start();
    await reconciling;
    const closing = application.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(closed, []);
    release();
    await assert.rejects(starting, /application\.error\.startup-failed/u);
    await closing;
    assert.deepEqual(closed, ['recovery', 'transfer-owners']);
  });
});
