import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProjectLifecycleRecoveryReconciler } from '../../src/composition/ProjectLifecycleRecoveryReconciler.js';

describe('ProjectLifecycleRecoveryReconciler', () => {
  it('periodically drives available lifecycle recovery and coalesces a slow pass', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const catalog = { listRecoveryCandidates: () => Promise.reject(new Error('unused')) };
    const reconciler = new ProjectLifecycleRecoveryReconciler({
      catalog,
      intervalMs: 5,
      recovery: {
        recoverAvailable: async received => {
          assert.equal(received, catalog);
          calls += 1;
          await blocked;
        },
      },
    });

    reconciler.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    const closing = reconciler.close();
    assert.equal(calls, 1);
    release();
    await closing;
  });

  it('runs one foreground recovery pass before readiness', async () => {
    let recovered = false;
    const reconciler = new ProjectLifecycleRecoveryReconciler({
      catalog: { listRecoveryCandidates: () => Promise.reject(new Error('unused')) },
      intervalMs: 60_000,
      recovery: {
        recoverAvailable: () => {
          recovered = true;
          return Promise.resolve();
        },
      },
    });

    await reconciler.reconcileAll();
    assert.equal(recovered, true);
    await reconciler.close();
  });
});
