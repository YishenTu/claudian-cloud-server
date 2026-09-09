import assert from 'node:assert/strict';
import { it } from 'node:test';

import { Client } from 'pg';

import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

it('retains distinct handoff generations under one Project identity', async () => {
  await withPostgresTestDatabase(async database => {
    await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
    const client = new Client({ connectionString: database.migrationUrl });
    const store = new PostgresCoordination({
      ordinaryPoolMax: 2, pinnedPoolMax: 1, reservedPoolMax: 1,
      projectLockTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
      runtimeConnectionString: database.runtimeUrl,
    });
    try {
      await client.connect();
      await client.query('BEGIN');
      await client.query("SELECT set_config('claudian_cloud.project_id', 'cycle-project', true)");
      await client.query(`INSERT INTO claudian_cloud.project_tombstones (
        project_id, authority_generation, terminal_operation_kind, terminal_operation_id,
        result_sha256, retired_at, terminal_expires_at
      ) VALUES
        ('cycle-project', 3, 'authority-transfer', 'handoff-one', repeat('a', 64),
          '2026-09-09T01:00:00Z', '2026-10-09T01:00:00Z'),
        ('cycle-project', 5, 'authority-transfer', 'handoff-two', repeat('b', 64),
          '2026-09-09T02:00:00Z', '2026-10-09T02:00:00Z')`);
      await client.query('COMMIT');
      await store.withProjectScope('cycle-project', async scope => {
        assert.equal((await scope.portability.getProjectTombstone())?.authorityGeneration, 5);
        assert.equal((await scope.portability.getProjectTombstone('handoff-one'))?.authorityGeneration, 3);
        assert.equal((await scope.portability.getProjectTombstone('handoff-two'))?.authorityGeneration, 5);
      });
      await store.withProjectScope('different-project', async scope => {
        assert.equal(await scope.portability.getProjectTombstone('handoff-one'), undefined);
      });
    } finally {
      await client.end();
      await store.close();
    }
  });
});
