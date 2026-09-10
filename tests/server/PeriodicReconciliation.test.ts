import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PeriodicReconciliation } from '../../src/composition/PeriodicReconciliation.js';
import { SafeLogger } from '../../src/observability/SafeLogger.js';

function scheduler() {
  let scheduled: (() => void) | undefined;
  return {
    schedule: (operation: () => void, _delayMs: number) => {
      assert.equal(scheduled, undefined);
      scheduled = operation;
      return () => { scheduled = undefined; };
    },
    fire: () => {
      assert.ok(scheduled);
      const operation = scheduled;
      scheduled = undefined;
      operation();
    },
    get pending() { return scheduled !== undefined; },
  };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe('PeriodicReconciliation', () => {
  it('coalesces foreground work, schedules after settlement, and drains on close', async () => {
    const clock = scheduler();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined;
    let executions = 0;
    const task = new PeriodicReconciliation({
      intervalMs: 10, schedule: clock.schedule,
      onBackgroundFailure: () => assert.fail('unexpected failure'),
      run: async received => { signal = received; executions += 1; await held; },
    });
    const initial = task.reconcileAll();
    task.start();
    await flush();
    assert.equal(clock.pending, false);
    assert.equal(task.reconcileAll(), initial);
    release();
    await initial;
    assert.equal(clock.pending, true);
    clock.fire();
    await flush();
    assert.equal(executions, 2);
    await task.close();
    assert.equal(signal?.aborted, true);
    assert.equal(clock.pending, false);
    await assert.rejects(task.reconcileAll());
  });

  it('reports a failed background pass safely and retries after settlement', async () => {
    const clock = scheduler();
    const output: string[] = [];
    const logger = new SafeLogger({ now: () => new Date(0), write: line => output.push(line) });
    let fault = true;
    let recovered = false;
    const task = new PeriodicReconciliation({
      intervalMs: 10, schedule: clock.schedule,
      onBackgroundFailure: () => logger.error('server.reconciliation-failed', {
        reason: 'project-recovery-failed',
      }),
      run: () => {
        if (fault) throw new Error('private-repository-content-and-credential');
        recovered = true;
        return Promise.resolve();
      },
    });
    task.start();
    clock.fire();
    await flush();
    assert.equal(output.length, 1);
    assert.equal(output.join('').includes('private-repository'), false);
    assert.equal(clock.pending, true);
    fault = false;
    clock.fire();
    await flush();
    assert.equal(recovered, true);
    await task.close();
  });

  it('waits for admitted work after cancelling future passes', async () => {
    const clock = scheduler();
    let release!: () => void;
    let completed = false;
    const task = new PeriodicReconciliation({
      intervalMs: 10, schedule: clock.schedule,
      onBackgroundFailure: () => assert.fail('unexpected failure'),
      run: async () => new Promise<void>(resolve => { release = resolve; }),
    });
    task.start();
    clock.fire();
    await flush();
    const closing = task.close().then(() => { completed = true; });
    await flush();
    assert.equal(completed, false);
    assert.equal(clock.pending, false);
    release();
    await closing;
    assert.equal(completed, true);
  });
});
