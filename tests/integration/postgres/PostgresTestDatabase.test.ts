import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import {
  acquirePostgresTestDatabase,
  POSTGRES_TEST_CONTAINER_LABEL,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);

async function managedContainers(): Promise<readonly string[]> {
  const result = await execFileAsync('docker', [
    'ps',
    '--all',
    '--filter',
    `label=${POSTGRES_TEST_CONTAINER_LABEL}`,
    '--format',
    '{{.Names}}',
  ], { encoding: 'utf8' });
  return result.stdout.trim().split('\n').filter(value => value.length > 0).sort();
}

async function serverMajor(connectionString: string): Promise<number> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query<{ readonly server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num",
    );
    return Math.floor(Number(result.rows[0]?.server_version_num) / 10_000);
  } finally {
    await client.end();
  }
}

describe('PostgresTestDatabase', () => {
  it('uses PostgreSQL 18 and isolates every explicit-service acquisition', async () => {
    const database = await acquirePostgresTestDatabase();
    try {
      assert.equal(await serverMajor(database.migrationUrl), 18);
      const containersBefore = await managedContainers();

      const first = await acquirePostgresTestDatabase({
        CLAUDIAN_TEST_POSTGRES_ADMIN_URL: database.adminUrl,
        CLAUDIAN_TEST_POSTGRES_MIGRATION_URL: database.migrationUrl,
        CLAUDIAN_TEST_POSTGRES_RUNTIME_URL: database.runtimeUrl,
      });
      const second = await acquirePostgresTestDatabase({
        CLAUDIAN_TEST_POSTGRES_ADMIN_URL: database.adminUrl,
        CLAUDIAN_TEST_POSTGRES_MIGRATION_URL: database.migrationUrl,
        CLAUDIAN_TEST_POSTGRES_RUNTIME_URL: database.runtimeUrl,
      });
      try {
        assert.equal(first.mode, 'external');
        assert.equal(second.mode, 'external');
        assert.notEqual(first.adminUrl, database.adminUrl);
        assert.notEqual(second.adminUrl, database.adminUrl);
        assert.notEqual(first.adminUrl, second.adminUrl);

        const firstClient = new Client({ connectionString: first.migrationUrl });
        const secondClient = new Client({ connectionString: second.migrationUrl });
        try {
          await firstClient.connect();
          await firstClient.query('CREATE TABLE isolated_marker (value integer)');
          await secondClient.connect();
          const result = await secondClient.query<{ readonly relation: string | null }>(
            "SELECT to_regclass('public.isolated_marker')::text AS relation",
          );
          assert.equal(result.rows[0]?.relation, null);
        } finally {
          await Promise.allSettled([firstClient.end(), secondClient.end()]);
        }
      } finally {
        await Promise.allSettled([first.close(), second.close()]);
      }

      assert.deepEqual(await managedContainers(), containersBefore);
      assert.equal(await serverMajor(database.runtimeUrl), 18);
    } finally {
      await database.close();
    }
  });

  it('removes its container when the test operation fails', async () => {
    const containersBefore = await managedContainers();

    await assert.rejects(
      withPostgresTestDatabase(async () => {
        await Promise.resolve();
        throw new Error('expected-test-failure');
      }),
      /expected-test-failure/,
    );

    assert.deepEqual(await managedContainers(), containersBefore);
  });
});
