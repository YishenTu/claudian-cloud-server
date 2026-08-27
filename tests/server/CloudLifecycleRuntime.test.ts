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
      control: {
        execute: () => Promise.reject(new Error('unused')),
        getRetirementTerminal: () => Promise.resolve(null),
      },
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
    await runtime.close(1_000);
    await runtime.close(1_000);
    assert.deepEqual(calls, [
      'reconcile',
      'expiry-start',
      'expiry-close',
      'recovery-close',
      'transfer-owners',
      'checkpoint-owners',
    ]);
  });

  it('attempts every close owner before reporting a sanitized failure', async () => {
    const calls: string[] = [];
    const runtime = new ComposedCloudLifecycleRuntime({
      artifacts: {
        download: () => Promise.reject(new Error('unused')),
        upload: () => Promise.reject(new Error('unused')),
      },
      closeOrder: [
        {
          close: () => {
            calls.push('transfer-owners');
            throw new Error('private-transfer-close-detail');
          },
        },
        { close: () => { calls.push('checkpoint-owners'); } },
      ],
      control: {
        execute: () => Promise.reject(new Error('unused')),
        getRetirementTerminal: () => Promise.resolve(null),
      },
      expiry: {
        close: () => {
          calls.push('expiry-close');
          return Promise.reject(new Error('private-expiry-close-detail'));
        },
        reconcileAll: () => Promise.resolve(),
        start: () => undefined,
      },
      recovery: {
        close: () => {
          calls.push('recovery-close');
          throw new Error('private-recovery-close-detail');
        },
        recoverCandidate: () => Promise.resolve(),
        recoverProject: () => Promise.resolve(),
      },
    });

    const closing = runtime.close(1_000);
    await assert.rejects(closing, /cloud-lifecycle-runtime\.close-failed/u);
    await assert.rejects(runtime.close(1_000), /cloud-lifecycle-runtime\.close-failed/u);
    assert.deepEqual(calls, [
      'expiry-close',
      'recovery-close',
      'transfer-owners',
      'checkpoint-owners',
    ]);
  });

  it('attempts later owners when an earlier close never settles', async () => {
    const calls: string[] = [];
    const runtime = new ComposedCloudLifecycleRuntime({
      artifacts: {
        download: () => Promise.reject(new Error('unused')),
        upload: () => Promise.reject(new Error('unused')),
      },
      closeOrder: [{ close: () => { calls.push('transfer-owners'); } }],
      control: {
        execute: () => Promise.reject(new Error('unused')),
        getRetirementTerminal: () => Promise.resolve(null),
      },
      expiry: {
        close: () => {
          calls.push('expiry-close');
          return new Promise(() => undefined);
        },
        reconcileAll: () => Promise.resolve(),
        start: () => undefined,
      },
      recovery: {
        close: () => { calls.push('recovery-close'); },
        recoverCandidate: () => Promise.resolve(),
        recoverProject: () => Promise.resolve(),
      },
    });

    await assert.rejects(runtime.close(10), /cloud-lifecycle-runtime\.close-failed/u);
    assert.deepEqual(calls, [
      'expiry-close',
      'recovery-close',
      'transfer-owners',
    ]);
  });
});
