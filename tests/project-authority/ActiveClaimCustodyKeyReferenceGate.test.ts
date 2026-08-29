import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ActiveClaimCustodyKeyReferenceGate,
} from '../../src/project-authority/lifecycle/ActiveClaimCustodyKeyReferenceGate.js';

const projectId = '11111111-1111-4111-8111-111111111111';

describe('ActiveClaimCustodyKeyReferenceGate', () => {
  it('checks retained terminal continuity without a Project or placement row', async () => {
    const records = [{ kind: 'tombstone', value: { projectId } }];
    const verified: unknown[] = [];
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => Promise.resolve(),
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            checkpoint: {
              readTerminalProjectContinuityRecords: () => Promise.resolve(records),
            },
            getProject: () => Promise.resolve(undefined),
            getRepositoryPlacement: () => Promise.resolve(undefined),
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: [],
        }),
        listTerminalProjectContinuity: () => assert.fail('unexpected runtime list'),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 9,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: 'development',
        }),
      },
      verifier: {
        verify: value => {
          verified.push(value);
          return Promise.resolve();
        },
      },
      terminalCatalog: {
        list: input => {
          assert.ok(input.signal instanceof AbortSignal);
          return Promise.resolve({
            nextCursor: undefined,
            projectIds: [projectId],
          });
        },
      },
    });

    await gate.verifyAll(new AbortController().signal);
    assert.deepEqual(verified, [records]);
  });

  it('checks canonical backup records for every active Project', async () => {
    const verified: unknown[] = [];
    let closed = false;
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => {
            closed = true;
            return Promise.resolve();
          },
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            checkpoint: {
              readProjectCheckpointRecords: (input: {
                readonly excludedOperationId?: string;
                readonly profile: string;
              }) => {
                assert.equal(input.profile, 'backup');
                assert.equal(input.excludedOperationId, undefined);
                return Promise.resolve([{ kind: 'project' }]);
              },
            },
            getProject: () => Promise.resolve({
              projectId,
              serviceState: 'active',
            }),
            getRepositoryPlacement: () => Promise.resolve({
              generation: 1,
              projectId,
              repositoryStorageKey: 'repo-a',
              storageNodeId: 'node-a',
            }),
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: [{
            active: true,
            generation: 1,
            projectId,
            repositoryStorageKey: 'repo-a',
            storageNodeId: 'node-a',
          }],
        }),
        listTerminalProjectContinuity: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [],
        }),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 9,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: '0.0.0',
        }),
      },
      verifier: {
        verify: records => {
          verified.push(records);
          return Promise.resolve();
        },
      },
    });

    await gate.verifyAll(new AbortController().signal);
    assert.deepEqual(verified, [[{ kind: 'project' }]]);
    assert.equal(closed, true);
  });

  it('fails closed when the active placement changes under the lease', async () => {
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => Promise.resolve(),
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            getProject: () => Promise.resolve({ projectId, serviceState: 'active' }),
            getRepositoryPlacement: () => Promise.resolve(undefined),
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: [{
            active: true,
            generation: 1,
            projectId,
            repositoryStorageKey: 'repo-a',
            storageNodeId: 'node-a',
          }],
        }),
        listTerminalProjectContinuity: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [],
        }),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 9,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: '0.0.0',
        }),
      },
      verifier: { verify: () => Promise.resolve() },
    });
    await assert.rejects(
      gate.verifyAll(new AbortController().signal),
      /active-claim-custody-key-reference\.error\.unavailable/u,
    );
  });
});
