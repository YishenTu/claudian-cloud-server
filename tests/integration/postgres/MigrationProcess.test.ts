import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it } from 'node:test';

import { withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => !key.startsWith('CLAUDIAN_CLOUD_')),
  );
}

async function runMigration(postgresUrl: string): Promise<ProcessResult> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/migrate.ts'], {
    cwd: process.cwd(),
    env: {
      ...baseEnvironment(),
      CLAUDIAN_CLOUD_POSTGRES_URL: postgresUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => stdout.push(String(chunk)));
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  const [exitCode] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  return Object.freeze({
    exitCode,
    stderr: stderr.join(''),
    stdout: stdout.join(''),
  });
}

describe('migration process', () => {
  it('applies migrations only through the migration entry point', async () => {
    await withPostgresTestDatabase(async database => {
      const result = await runMigration(database.migrationUrl);
      assert.deepEqual(result, {
        exitCode: 0,
        stderr: '',
        stdout: '',
      });
    }, {});
  });

  it('reports dependency failure without connection or credential context', async () => {
    const credential = 'migration-process-secret-sentinel';
    const result = await runMigration(
      `postgresql://migration:${credential}@127.0.0.1:1/cloud`,
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'claudian-cloud-server bootstrap failure\n');
    assert.doesNotMatch(result.stderr, new RegExp(credential));
    assert.doesNotMatch(result.stderr, /postgresql:|ECONNREFUSED|127\.0\.0\.1/);
  });
});
