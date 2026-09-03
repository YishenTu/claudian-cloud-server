import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

const MAIN_PROCESS_ENTRY = 'tests/integration/postgres/MainProcessWithKeyring.ts';

describe('main process with foundation dependencies', () => {
  it('publishes readiness and restarts cleanly after SIGTERM', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const authorityRoot = await mkdtemp(join(tmpdir(), 'claudian-main-authority-'));
      const repositoryRoot = join(authorityRoot, 'repositories');
      const stagingRoot = join(authorityRoot, 'repositories-staging');
      await mkdir(repositoryRoot, { mode: 0o700 });
      await mkdir(stagingRoot, { mode: 0o700 });
      await writeFile(
        join(authorityRoot, '.authority-volume-id'),
        `${database.authorityVolumeId}\n`,
        { mode: 0o600 },
      );
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const port = await findAvailablePort();
          const child = spawn(process.execPath, ['--import', 'tsx', MAIN_PROCESS_ENTRY], {
            cwd: process.cwd(),
            env: {
              ...baseEnvironment(),
              CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
              CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
              CLAUDIAN_CLOUD_PORT: String(port),
              CLAUDIAN_CLOUD_POSTGRES_URL: database.runtimeUrl,
              CLAUDIAN_CLOUD_PRINCIPAL_PROFILE: 'private-development',
              CLAUDIAN_CLOUD_REPOSITORY_ROOT: repositoryRoot,
              CLAUDIAN_CLOUD_STAGING_ROOT: stagingRoot,
              CLAUDIAN_CLOUD_STORAGE_NODE_ID: 'test-node',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const stdout: string[] = [];
          const stderr: string[] = [];
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', chunk => stdout.push(String(chunk)));
          child.stderr.on('data', chunk => stderr.push(String(chunk)));

          try {
            await waitForEvent(stdout, 'server.listening');
            const ready = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
            assert.equal(ready.status, 200);
            assert.deepEqual(await ready.json(), { status: 'ready' });

            const startedAt = Date.now();
            child.kill('SIGTERM');
            const [exitCode, signal] = await once(child, 'exit') as [
              number | null,
              NodeJS.Signals | null,
            ];

            assert.equal(Date.now() - startedAt < 2_000, true);
            assert.equal(exitCode, 0);
            assert.equal(signal, null);
            assert.equal(stderr.join(''), '');
            assert.deepEqual(parseEvents(stdout), [
              'server.starting',
              'server.listening',
              'server.stopping',
              'server.stopped',
            ]);
            assert.equal(await cloudConnectionCount(database.adminUrl), 0);
          } finally {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          }
        }
      } finally {
        await rm(authorityRoot, { force: true, recursive: true });
      }
    });
  });

  it('contains an idle PostgreSQL client failure inside coordination', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const authorityRoot = await mkdtemp(join(tmpdir(), 'claudian-main-idle-error-'));
      const repositoryRoot = join(authorityRoot, 'repositories');
      const stagingRoot = join(authorityRoot, 'repositories-staging');
      await mkdir(repositoryRoot, { mode: 0o700 });
      await mkdir(stagingRoot, { mode: 0o700 });
      await writeFile(
        join(authorityRoot, '.authority-volume-id'),
        `${database.authorityVolumeId}\n`,
        { mode: 0o600 },
      );
      const port = await findAvailablePort();
      const child = spawn(process.execPath, ['--import', 'tsx', MAIN_PROCESS_ENTRY], {
        cwd: process.cwd(),
        env: {
          ...baseEnvironment(),
          CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
          CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
          CLAUDIAN_CLOUD_PORT: String(port),
          CLAUDIAN_CLOUD_POSTGRES_URL: database.runtimeUrl,
          CLAUDIAN_CLOUD_PRINCIPAL_PROFILE: 'private-development',
          CLAUDIAN_CLOUD_REPOSITORY_ROOT: repositoryRoot,
          CLAUDIAN_CLOUD_STAGING_ROOT: stagingRoot,
          CLAUDIAN_CLOUD_STORAGE_NODE_ID: 'test-node',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => stdout.push(String(chunk)));
      child.stderr.on('data', chunk => stderr.push(String(chunk)));

      try {
        await waitForEvent(stdout, 'server.listening');
        await terminateApplicationConnection(
          database.adminUrl,
          'claudian-cloud-reserved',
        );
        await new Promise(resolve => setTimeout(resolve, 250));

        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        assert.equal(stderr.join(''), '');
        const ready = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
        assert.equal(ready.status, 200);

        child.kill('SIGTERM');
        const [exitCode, signal] = await once(child, 'exit') as [
          number | null,
          NodeJS.Signals | null,
        ];
        assert.equal(exitCode, 0);
        assert.equal(signal, null);
        assert.deepEqual(parseEvents(stdout), [
          'server.starting',
          'server.listening',
          'server.stopping',
          'server.stopped',
        ]);
        await waitForNoCloudConnections(database.adminUrl);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
        await rm(authorityRoot, { force: true, recursive: true });
      }
    });
  });

  it('stops cleanly when SIGTERM interrupts a blocked startup query', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const authorityRoot = await mkdtemp(join(tmpdir(), 'claudian-main-startup-stop-'));
      const repositoryRoot = join(authorityRoot, 'repositories');
      const stagingRoot = join(authorityRoot, 'repositories-staging');
      await mkdir(repositoryRoot, { mode: 0o700 });
      await mkdir(stagingRoot, { mode: 0o700 });
      await writeFile(
        join(authorityRoot, '.authority-volume-id'),
        `${database.authorityVolumeId}\n`,
        { mode: 0o600 },
      );
      const blocker = new Client({ connectionString: database.adminUrl });
      const port = await findAvailablePort();
      let child: ReturnType<typeof spawn> | undefined;
      const stdout: string[] = [];
      const stderr: string[] = [];

      try {
        await blocker.connect();
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE claudian_cloud.schema_migrations IN ACCESS EXCLUSIVE MODE',
        );
        const spawned = spawn(process.execPath, ['--import', 'tsx', MAIN_PROCESS_ENTRY], {
          cwd: process.cwd(),
          env: {
            ...baseEnvironment(),
            CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
            CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
            CLAUDIAN_CLOUD_PORT: String(port),
            CLAUDIAN_CLOUD_POSTGRES_URL: database.runtimeUrl,
            CLAUDIAN_CLOUD_PRINCIPAL_PROFILE: 'private-development',
            CLAUDIAN_CLOUD_PROJECT_LOCK_TIMEOUT_MS: '1000',
            CLAUDIAN_CLOUD_REPOSITORY_ROOT: repositoryRoot,
            CLAUDIAN_CLOUD_STAGING_ROOT: stagingRoot,
            CLAUDIAN_CLOUD_STORAGE_NODE_ID: 'test-node',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child = spawned;
        spawned.stdout.setEncoding('utf8');
        spawned.stderr.setEncoding('utf8');
        spawned.stdout.on('data', chunk => stdout.push(String(chunk)));
        spawned.stderr.on('data', chunk => stderr.push(String(chunk)));
        await waitForBlockedStartupQuery(blocker);

        const startedAt = Date.now();
        spawned.kill('SIGTERM');
        const [exitCode, signal] = await childExitWithin(spawned, 2_500);

        assert.equal(Date.now() - startedAt < 2_500, true);
        assert.equal(exitCode, 0);
        assert.equal(signal, null);
        assert.equal(stderr.join(''), '');
        assert.deepEqual(parseEvents(stdout), [
          'server.starting',
          'server.stopping',
          'server.stopped',
        ]);
        await waitForNoCloudConnections(database.adminUrl);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end().catch(() => undefined);
        if (
          child !== undefined
          && child.exitCode === null
          && child.signalCode === null
        ) {
          child.kill('SIGKILL');
        }
        await rm(authorityRoot, { force: true, recursive: true });
      }
    });
  });
});

function baseEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => !key.startsWith('CLAUDIAN_CLOUD_')),
  );
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
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await cloudConnectionCount(adminUrl) === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('main-process-postgres-connection-survived');
}

async function terminateApplicationConnection(
  adminUrl: string,
  applicationName: string,
): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  try {
    await client.connect();
    const result = await client.query<{ readonly terminated: boolean }>(
      `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1`,
      [applicationName],
    );
    assert.deepEqual(result.rows, [{ terminated: true }]);
  } finally {
    await client.end();
  }
}

async function waitForBlockedStartupQuery(client: Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query<{ readonly blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = 'claudian-cloud-reserved'
            AND wait_event_type = 'Lock'
       ) AS blocked`,
    );
    if (result.rows[0]?.blocked === true) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('main-process-startup-query-not-blocked');
}

async function childExitWithin(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<[number | null, NodeJS.Signals | null]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('main-process-exit-timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server address unavailable');
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

async function waitForEvent(lines: readonly string[], event: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (parseEvents(lines).includes(event)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${event}`);
}

function parseEvents(chunks: readonly string[]): string[] {
  return chunks.join('')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => (JSON.parse(line) as { readonly event: string }).event);
}
