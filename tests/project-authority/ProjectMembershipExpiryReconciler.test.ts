import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProjectMembershipExpiryReconciler } from '../../src/project-authority/membership/ProjectMembershipExpiryReconciler.js';

describe('ProjectMembershipExpiryReconciler', () => {
  it('reconciles every active Project through its write lane', async () => {
    const reconciled: Array<{ now: string; projectId: string }> = [];
    const closed: string[] = [];
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
    });

    await reconciler.reconcileAll();

    assert.deepEqual(reconciled, [
      { now: '2026-08-30T00:00:00.000Z', projectId: 'project-a' },
      { now: '2026-08-30T00:00:00.000Z', projectId: 'project-b' },
    ]);
    assert.deepEqual(closed, ['project-a', 'project-b']);
  });
});
