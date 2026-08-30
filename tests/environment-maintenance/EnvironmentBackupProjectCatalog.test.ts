import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnvironmentBackupProjectCatalog } from '../../src/environment-maintenance/commands/EnvironmentBackupProjectCatalog.js';

describe('EnvironmentBackupProjectCatalog', () => {
  it('uses runtime coordination for current-schema terminal enumeration', async () => {
    const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const signal = new AbortController().signal;
    const catalog = new EnvironmentBackupProjectCatalog({
      coordination: {
        acquireProjectLease: () => assert.fail('unexpected lease'),
        listActiveRepositoryPlacements: () => assert.fail('unexpected active list'),
        listTerminalProjectContinuity: input => {
          assert.deepEqual(input, { limit: 100 });
          return Promise.resolve({
            nextCursor: undefined,
            projectIds: [projectId],
          });
        },
      },
    });

    assert.deepEqual(await catalog.listTerminal({ signal }), {
      nextCursor: undefined,
      projectIds: [projectId],
    });
  });
});
