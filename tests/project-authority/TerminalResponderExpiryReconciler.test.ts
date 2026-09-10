import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TerminalResponderExpiryReconciler } from '../../src/project-authority/lifecycle/retire/TerminalResponderExpiryReconciler.js';

const NOW = '2026-08-27T00:00:00.000Z';

describe('TerminalResponderExpiryReconciler', () => {
  it('expires only due responders through the exact one-shot owner', async () => {
    const expired: unknown[] = [];
    const reconciler = new TerminalResponderExpiryReconciler({
      catalog: {
        listTerminalResponders: () => Promise.resolve({
          nextCursor: undefined,
          responders: [
            {
              expiresAt: '2026-08-26T23:59:59.000Z',
              operationId: 'transfer-terminal-due',
              operationKind: 'authority-transfer',
              projectId: 'project-terminal-expiry',
            },
            {
              expiresAt: '2026-08-28T00:00:00.000Z',
              operationId: 'retire-terminal-future',
              operationKind: 'retire',
              projectId: 'project-terminal-expiry',
            },
          ],
        }),
      },
      clock: () => new Date(NOW),
      expiry: {
        expire: input => {
          expired.push(input);
          return Promise.resolve('expired');
        },
      },
    });

    await reconciler.reconcileAll();
    assert.deepEqual(expired, [{
      operationId: 'transfer-terminal-due',
      operationKind: 'authority-transfer',
      projectId: 'project-terminal-expiry',
      removedAt: NOW,
    }]);
  });

});
