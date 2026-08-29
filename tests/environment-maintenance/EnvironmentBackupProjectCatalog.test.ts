import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnvironmentBackupProjectCatalog } from '../../src/environment-maintenance/commands/EnvironmentBackupProjectCatalog.js';

describe('EnvironmentBackupProjectCatalog', () => {
  it('uses the offline bridge only for terminal enumeration when provided', async () => {
    const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const signal = new AbortController().signal;
    const catalog = new EnvironmentBackupProjectCatalog({
      coordination: {
        acquireProjectLease: () => assert.fail('unexpected lease'),
        listActiveRepositoryPlacements: () => assert.fail('unexpected active list'),
        listTerminalProjectContinuity: () => assert.fail('unexpected runtime list'),
      },
      terminalCatalog: {
        list: input => {
          assert.deepEqual(input, {
            limit: 100,
            signal,
          });
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
