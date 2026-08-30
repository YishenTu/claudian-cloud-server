import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProjectMembershipExpiryReconciler } from '../../src/project-authority/membership/ProjectMembershipExpiryReconciler.js';

describe('ProjectMembershipExpiryReconciler', () => {
  it('reconciles every active Project through its write lane and drains on close', async () => {
    const reconciled: Array<{ now: string; projectId: string }> = [];
    const closed: string[] = [];
    const scheduled: Array<{ delayMs: number; operation: () => void }> = [];
    const reconciler = new ProjectMembershipExpiryReconciler({
      clock: () => new Date('2026-08-30T00:00:00.000Z'),
      coordination: {
        acquireProjectLease: projectId => Promise.resolve({
          close: () => {
            closed.push(projectId);
            return Promise.resolve();
          },
          withProjectScope: async operation => await operation({
            membership: {
              reconcileExpirations: now => {
                reconciled.push({ now, projectId });
                return Promise.resolve();
              },
            },
          }),
        }),
        listActiveRepositoryPlacements: options => Promise.resolve(
          options?.after === undefined
            ? {
                nextCursor: 'project-a',
                placements: [{ projectId: 'project-a' }],
              }
            : {
                nextCursor: undefined,
                placements: [{ projectId: 'project-b' }],
              },
        ),
      },
      schedule: (operation, delayMs) => {
        scheduled.push({ delayMs, operation });
        return () => undefined;
      },
    });

    reconciler.start();
    assert.equal(scheduled[0]?.delayMs, 60_000);
    scheduled[0].operation();
    await new Promise(resolve => setImmediate(resolve));
    await reconciler.close();

    assert.deepEqual(reconciled, [
      { now: '2026-08-30T00:00:00.000Z', projectId: 'project-a' },
      { now: '2026-08-30T00:00:00.000Z', projectId: 'project-b' },
    ]);
    assert.deepEqual(closed, ['project-a', 'project-b']);
  });
});
