import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DevelopmentBootstrapExpiryReconciler } from '../../src/onboarding/development/DevelopmentBootstrapExpiryReconciler.js';

describe('DevelopmentBootstrapExpiryReconciler', () => {
  it('continues reconciling expired attempts while the application is running', async () => {
    const expirations: Array<{ attemptId: string; projectId: string }> = [];
    const scheduled: Array<{ delayMs: number; operation: () => void }> = [];
    const cancellations: Array<() => void> = [];
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
      schedule: (operation, delayMs) => {
        const cancellation = () => undefined;
        scheduled.push({ delayMs, operation });
        cancellations.push(cancellation);
        return cancellation;
      },
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

    reconciler.start();
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.delayMs, 60_000);

    scheduled[0].operation();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(expirations, [{
      attemptId: 'attempt-expired',
      projectId: 'project-expired',
    }]);
    assert.equal(scheduled.length, 2);
    await reconciler.close();
  });
});
