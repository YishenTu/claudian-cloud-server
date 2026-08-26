import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ComposedCloudLifecycleRuntime } from '../../src/composition/CloudLifecycleRuntime.js';

describe('ComposedCloudLifecycleRuntime', () => {
  it('reconciles before scheduling and closes in the declared owner order', async () => {
    const calls: string[] = [];
    const runtime = new ComposedCloudLifecycleRuntime({
      artifacts: {
        download: () => Promise.reject(new Error('unused')),
        upload: () => Promise.reject(new Error('unused')),
      },
      closeOrder: [
        { close: () => { calls.push('transfer-owners'); } },
        { close: () => { calls.push('checkpoint-owners'); } },
      ],
      control: { execute: () => Promise.reject(new Error('unused')) },
      expiry: {
        close: () => {
          calls.push('expiry-close');
          return Promise.resolve();
        },
        reconcileAll: () => {
          calls.push('reconcile');
          return Promise.resolve();
        },
        start: () => { calls.push('expiry-start'); },
      },
      recovery: {
        close: () => { calls.push('recovery-close'); },
        recoverCandidate: () => Promise.resolve(),
        recoverProject: () => Promise.resolve(),
      },
    });

    await runtime.reconcileAll();
    runtime.start();
    await runtime.close();
    await runtime.close();
    assert.deepEqual(calls, [
      'reconcile',
      'expiry-start',
      'expiry-close',
      'recovery-close',
      'transfer-owners',
      'checkpoint-owners',
    ]);
  });
});
