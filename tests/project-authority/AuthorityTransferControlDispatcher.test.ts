import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CloudToLanTransferCoordinatorError } from '../../src/project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
import {
  AuthorityTransferControlDispatcher,
  AuthorityTransferControlDispatcherError,
} from '../../src/project-authority/lifecycle/AuthorityTransferControlDispatcher.js';
import { LanToCloudTransferCoordinatorError } from '../../src/project-authority/lifecycle/lan-to-cloud/LanToCloudTransferCoordinator.js';

const PROJECT_ID = 'project-transfer-dispatcher';
const TRANSFER_ID = 'transfer-transfer-dispatcher';

const getRequest = Object.freeze({
  projectId: PROJECT_ID,
  transferId: TRANSFER_ID,
});

const cancelRequest = Object.freeze({
  expectedPhase: 'target-prepared',
  idempotencyKey: 'cancel-transfer-dispatcher',
  projectId: PROJECT_ID,
  transferId: TRANSFER_ID,
});

function owner(methods: Readonly<Record<string, (...args: never[]) => unknown>>): never {
  return methods as never;
}

function rejectedCode(error: unknown): error is AuthorityTransferControlDispatcherError {
  return error instanceof AuthorityTransferControlDispatcherError
    && error.code === 'authorization-denied';
}

describe('AuthorityTransferControlDispatcher', () => {
  it('makes unknown and unrelated transfers indistinguishable', async () => {
    const unknown = new AuthorityTransferControlDispatcher({
      cloudToLan: owner({
        getStatus: () => Promise.reject(
          new CloudToLanTransferCoordinatorError('recovery-required'),
        ),
      }),
      lanToCloud: owner({
        getStatus: () => Promise.reject(
          new LanToCloudTransferCoordinatorError('recovery-required'),
        ),
      }),
    });
    const unrelated = new AuthorityTransferControlDispatcher({
      cloudToLan: owner({
        getStatus: () => Promise.reject(
          new CloudToLanTransferCoordinatorError('recovery-required'),
        ),
      }),
      lanToCloud: owner({
        getStatus: () => Promise.reject(
          new LanToCloudTransferCoordinatorError('authorization-denied'),
        ),
      }),
    });

    for (const dispatcher of [unknown, unrelated]) {
      await assert.rejects(dispatcher.getStatus({
        principalId: 'principal-unrelated',
        request: getRequest,
      }), rejectedCode);
    }
  });

  it('does not enter cancellation after its authorized direction read is aborted', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    let cancelCalls = 0;
    const dispatcher = new AuthorityTransferControlDispatcher({
      cloudToLan: owner({
        getStatus: () => Promise.reject(
          new CloudToLanTransferCoordinatorError('recovery-required'),
        ),
      }),
      lanToCloud: owner({
        cancel: () => {
          cancelCalls += 1;
          return Promise.resolve({ direction: 'lan-to-cloud' });
        },
        getStatus: async () => {
          await blocked;
          return { direction: 'lan-to-cloud' };
        },
      }),
    });
    const controller = new AbortController();
    const cancelling = dispatcher.cancel({
      principalId: 'principal-source-host',
      request: cancelRequest as never,
      signal: controller.signal,
    });
    controller.abort();
    release();

    await assert.rejects(cancelling, (error: unknown) => (
      error instanceof AuthorityTransferControlDispatcherError
      && error.code === 'aborted'
    ));
    assert.equal(cancelCalls, 0);
  });

  it('dispatches cancellation only to the direction that authorized the read', async () => {
    const calls: string[] = [];
    const status = { direction: 'cloud-to-lan' };
    const dispatcher = new AuthorityTransferControlDispatcher({
      cloudToLan: owner({
        cancel: () => {
          calls.push('cloud.cancel');
          return Promise.resolve(status);
        },
        getStatus: () => {
          calls.push('cloud.getStatus');
          return Promise.resolve(status);
        },
      }),
      lanToCloud: owner({
        cancel: () => {
          calls.push('lan.cancel');
          return Promise.resolve(status);
        },
        getStatus: () => {
          calls.push('lan.getStatus');
          return Promise.reject(
            new LanToCloudTransferCoordinatorError('recovery-required'),
          );
        },
      }),
    });

    assert.equal(await dispatcher.cancel({
      principalId: 'principal-manager',
      request: cancelRequest as never,
      signal: new AbortController().signal,
    }), status);
    assert.deepEqual(calls, [
      'cloud.getStatus',
      'lan.getStatus',
      'cloud.cancel',
    ]);
  });

  it('resolves cancellation direction with the exact strict status request', async () => {
    let cancelled = false;
    const dispatcher = new AuthorityTransferControlDispatcher({
      cloudToLan: owner({
        getStatus: () => Promise.reject(
          new CloudToLanTransferCoordinatorError('recovery-required'),
        ),
      }),
      lanToCloud: owner({
        cancel: () => {
          cancelled = true;
          return Promise.resolve({ direction: 'lan-to-cloud' });
        },
        getStatus: (input: { readonly request: unknown }) => Promise.resolve().then(() => {
          assert.deepEqual(input.request, getRequest);
          return { direction: 'lan-to-cloud' };
        }),
      }),
    });

    await dispatcher.cancel({
      principalId: 'principal-source-host',
      request: cancelRequest as never,
      signal: new AbortController().signal,
    });
    assert.equal(cancelled, true);
  });
});
