import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DevelopmentBootstrapExpiryReconciler } from '../../src/onboarding/development/DevelopmentBootstrapExpiryReconciler.js';

describe('DevelopmentBootstrapExpiryReconciler', () => {
  it('reconciles due attempts through their settlement owner', async () => {
    const expirations: Array<{ attemptId: string; projectId: string }> = [];
    const reconciler = new DevelopmentBootstrapExpiryReconciler({
      catalog: {
        listExpiredDevelopmentBootstrapAttempts(options) {
          assert.equal(options.expiredBefore, '2026-08-22T00:00:00.000Z');
          return Promise.resolve({
            attempts: [{
              attemptId: 'attempt-expired',
              expiresAt: '2026-08-21T23:59:59.000Z',
              projectId: 'project-expired',
            }],
            nextCursor: undefined,
          });
        },
      },
      clock: () => new Date('2026-08-22T00:00:00.000Z'),
      settlement: {
        activate: () => Promise.resolve(),
        cancel: () => Promise.resolve(),
        expire: input => {
          expirations.push(input);
          return Promise.resolve();
        },
        getActivationResult: () => Promise.resolve(undefined),
      },
    });

    await reconciler.reconcileAll();

    assert.deepEqual(expirations, [{
      attemptId: 'attempt-expired',
      projectId: 'project-expired',
    }]);
  });
});
