import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OperationDrain,
  OperationDrainClosedError,
} from '../../src/project-authority/OperationDrain.js';

describe('OperationDrain', () => {
  it('aborts and awaits every admitted operation before close resolves', async () => {
    const drain = new OperationDrain();
    let release: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered: (() => void) | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let observedSignal: AbortSignal | undefined;
    const operation = drain.run({}, async signal => {
      observedSignal = signal;
      entered?.();
      await barrier;
    });
    await started;

    let closed = false;
    const closing = drain.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(observedSignal?.aborted, true);
    assert.equal(closed, false);
    release?.();
    await Promise.all([operation, closing]);
    assert.equal(closed, true);
    await assert.rejects(
      drain.run({}, () => Promise.resolve()),
      OperationDrainClosedError,
    );
  });
});
