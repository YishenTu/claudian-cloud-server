import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TerminalResponderExpiryReconciler } from '../../src/composition/TerminalResponderExpiryReconciler.js';

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
      intervalMs: 60_000,
    });

    await reconciler.reconcileAll();
    assert.deepEqual(expired, [{
      operationId: 'transfer-terminal-due',
      operationKind: 'authority-transfer',
      projectId: 'project-terminal-expiry',
      removedAt: NOW,
    }]);
    await reconciler.close();
  });

  it('coalesces periodic work and waits for the active pass during close', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const reconciler = new TerminalResponderExpiryReconciler({
      catalog: {
        listTerminalResponders: async () => {
          calls += 1;
          await blocked;
          return { nextCursor: undefined, responders: [] };
        },
      },
      clock: () => new Date(NOW),
      expiry: { expire: () => Promise.resolve('replayed') },
      intervalMs: 5,
    });
    reconciler.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    const closing = reconciler.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(closed, true);
  });

  it('coalesces a foreground pass and waits for it during close', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const reconciler = new TerminalResponderExpiryReconciler({
      catalog: {
        listTerminalResponders: async () => {
          calls += 1;
          await blocked;
          return { nextCursor: undefined, responders: [] };
        },
      },
      clock: () => new Date(NOW),
      expiry: { expire: () => Promise.resolve('replayed') },
      intervalMs: 60_000,
    });

    const first = reconciler.reconcileAll();
    const second = reconciler.reconcileAll();
    const closing = reconciler.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    assert.equal(closed, false);
    release();
    await Promise.all([first, second, closing]);
    assert.equal(closed, true);
  });
});
