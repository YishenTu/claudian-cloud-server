import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

describe('main process with foundation dependencies', () => {
  it('publishes readiness and shuts down cleanly on SIGTERM', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({
        connectionString: database.migrationUrl,
      }).apply();
      const repositoryRoot = await mkdtemp(join(tmpdir(), 'claudian-main-repositories-'));
      const port = await findAvailablePort();
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
        cwd: process.cwd(),
        env: {
          ...baseEnvironment(),
          CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
          CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
          CLAUDIAN_CLOUD_PORT: String(port),
          CLAUDIAN_CLOUD_POSTGRES_URL: database.runtimeUrl,
          CLAUDIAN_CLOUD_REPOSITORY_ROOT: repositoryRoot,
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
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await rm(repositoryRoot, { force: true, recursive: true });
      }
    }, {});
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
