import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CollabError } from '@claudian-collab/protocol';

import {
  AuthorityTransferDirectionResolverAdapter,
} from '../../src/server/control/AuthorityTransferDirectionResolver.js';

describe('AuthorityTransferDirectionResolverAdapter', () => {
  it('reads only the immutable journal direction under the Project lease', async () => {
    const calls: string[] = [];
    const resolver = new AuthorityTransferDirectionResolverAdapter({
      acquireProjectLease: projectId => {
        calls.push(`acquire:${projectId}`);
        return Promise.resolve({
          close: () => {
            calls.push('close');
            return Promise.resolve();
          },
          drainDevelopmentBootstrapUploads: () => Promise.resolve(),
          handoffToDevelopmentBootstrapUpload: () => Promise.reject(new Error('unused')),
          withProjectScope: operation => operation({
            portability: {
              getLifecycleJournal: (operationId: string) => {
                calls.push(`journal:${operationId}`);
                return Promise.resolve({
                  direction: 'lan-to-cloud',
                  kind: 'authority-transfer',
                  operationId,
                  projectId: 'project-direction-resolver',
                });
              },
            },
          } as never),
        });
      },
    });

    assert.equal(await resolver.resolve({
      principalId: 'member-ignored-for-routing',
      projectId: 'project-direction-resolver',
      transferId: 'transfer-direction-resolver',
    }), 'lan-to-cloud');
    assert.deepEqual(calls, [
      'acquire:project-direction-resolver',
      'journal:transfer-direction-resolver',
      'close',
    ]);
  });

  it('maps absent or non-transfer journals to one safe not-found result', async () => {
    const resolver = new AuthorityTransferDirectionResolverAdapter({
      acquireProjectLease: () => Promise.resolve({
        close: () => Promise.resolve(),
        drainDevelopmentBootstrapUploads: () => Promise.resolve(),
        handoffToDevelopmentBootstrapUpload: () => Promise.reject(new Error('unused')),
        withProjectScope: operation => operation({
          portability: {
            getLifecycleJournal: () => Promise.resolve(undefined),
          },
        } as never),
      }),
    });
    await assert.rejects(resolver.resolve({
      principalId: 'member-manager',
      projectId: 'project-direction-resolver',
      transferId: 'transfer-missing',
    }), (error: unknown) => (
      error instanceof CollabError && error.code === 'authority-transfer-not-found'
    ));
  });
});
