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
  it('starts PostgreSQL 18 locally and reuses explicit CI service URLs', async () => {
    const database = await acquirePostgresTestDatabase({});
    try {
      assert.equal(database.mode, 'container');
      assert.equal(await serverMajor(database.migrationUrl), 18);
      const containersBefore = await managedContainers();

      const external = await acquirePostgresTestDatabase({
        CLAUDIAN_TEST_POSTGRES_ADMIN_URL: database.adminUrl,
        CLAUDIAN_TEST_POSTGRES_MIGRATION_URL: database.migrationUrl,
        CLAUDIAN_TEST_POSTGRES_RUNTIME_URL: database.runtimeUrl,
      });
      assert.equal(external.mode, 'external');
      await external.close();

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
      }, {}),
      /expected-test-failure/,
    );

    assert.deepEqual(await managedContainers(), containersBefore);
  });
});
