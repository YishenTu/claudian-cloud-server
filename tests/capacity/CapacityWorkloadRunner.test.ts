import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createCapacityWorkload,
} from './CapacityWorkload.js';
import {
  runCapacityWorkload,
  type CapacityWorkloadClock,
} from './CapacityWorkloadRunner.js';
import { createFaultAwareCapacityExecutor } from './FaultAwareCapacityExecutor.js';

class VirtualClock implements CapacityWorkloadClock {
  #nowMs = 0;

  nowMs(): number {
    return this.#nowMs;
  }

  waitUntil(targetMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('virtual-clock-aborted'));
    this.#nowMs = targetMs;
    return Promise.resolve();
  }
}

describe('capacity workload runner', () => {
  it('executes the complete timeline and preserves same-instant concurrency', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'runner-replay-seed',
    });
    const active = new Map<string, number>();
    const peaks = new Map<string, number>();
    const executeFaultAware = createFaultAwareCapacityExecutor(workload);
    let probeObservedAtSample = false;

    const completion = await runCapacityWorkload({
      clock: new VirtualClock(),
      execute: async (event, signal, observation) => {
        if (event.kind === 'resource-sample' && event.probeKind === 'capacity-envelope') {
          probeObservedAtSample = active.get('control-read') === 32
            && observation?.controlRequests === 32;
        }
        const current = (active.get(event.kind) ?? 0) + 1;
        active.set(event.kind, current);
        peaks.set(event.kind, Math.max(peaks.get(event.kind) ?? 0, current));
        try {
          await executeFaultAware(event, signal, observation);
        } finally {
          active.set(event.kind, (active.get(event.kind) ?? 1) - 1);
        }
      },
      workload,
    });

    assert.equal(completion.completedEventCount, workload.events.length);
    assert.match(completion.completedSequenceSha256, /^[0-9a-f]{64}$/);
    assert.match(completion.workloadSha256, /^[0-9a-f]{64}$/);
    assert.equal(probeObservedAtSample, true);
    assert.equal(peaks.get('control-read'), 33);
    assert.equal(peaks.get('git-clone'), 1);
    assert.equal(peaks.get('git-fetch'), 3);
    assert.equal(peaks.get('git-push'), 2);
    assert.equal(peaks.get('publish'), 2);
    assert.equal(peaks.get('accept'), 1);
  });

  it('cancels undispatched work and exposes only one fixed failure', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'runner-failure-seed',
    });

    await assert.rejects(runCapacityWorkload({
      clock: new VirtualClock(),
      execute: event => event.kind === 'backup'
        ? Promise.reject(new Error('private-project-content'))
        : Promise.resolve(),
      workload,
    }), error => {
      assert.match(String(error), /capacity-workload-run-failed/);
      assert.doesNotMatch(String(error), /private-project-content/);
      return true;
    });
  });

  it('dispatches a later restart while its scheduled operation remains in flight', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'runner-interruption-seed',
    });
    const restart = workload.events.find(event => (
      event.kind === 'process-restart' && event.interruptedKind === 'git-push'
    ));
    if (restart?.kind !== 'process-restart') assert.fail('restart missing');
    let restartObserved = false;
    const execute = createFaultAwareCapacityExecutor(workload, event => {
      if (event === restart) restartObserved = true;
    });

    await runCapacityWorkload({
      clock: new VirtualClock(),
      execute,
      signal: AbortSignal.timeout(1_000),
      workload,
    });

    assert.equal(restartObserved, true);
  });

  it('rejects a fault plan when the matching operation already completed', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'runner-missed-fault-seed',
    });

    await assert.rejects(runCapacityWorkload({
      clock: new VirtualClock(),
      execute: () => Promise.resolve(),
      workload,
    }), /capacity-workload-run-failed/);
  });

  it('rejects a structurally cloned workload outside the canonical generator', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'runner-forged-workload-seed',
    });
    const forged = { ...workload };

    await assert.rejects(runCapacityWorkload({
      clock: new VirtualClock(),
      execute: createFaultAwareCapacityExecutor(workload),
      workload: forged,
    }), /capacity-workload-run-failed/);
  });

  it('rejects a ceiling constituent that completes before its linked sample', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'runner-missed-probe-seed',
    });
    const sample = workload.events.find(event => (
      event.kind === 'resource-sample' && event.probeKind === 'capacity-envelope'
    ));
    assert.ok(sample?.kind === 'resource-sample');
    const releasedSequence = sample.ceilingProbeSequences[0];
    assert.ok(releasedSequence !== undefined);
    const faultAware = createFaultAwareCapacityExecutor(workload);

    await assert.rejects(runCapacityWorkload({
      clock: new VirtualClock(),
      execute: (event, signal, observation) => event.sequence === releasedSequence
        ? Promise.resolve()
        : faultAware(event, signal, observation),
      signal: AbortSignal.timeout(1_000),
      workload,
    }), /capacity-workload-run-failed/);
  });

  it('does not let an older same-kind Project operation satisfy an exact restart', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'runner-interruption-seed',
    });
    const restart = workload.events.find(event => (
      event.kind === 'process-restart' && event.interruptedKind === 'git-push'
    ));
    if (restart?.kind !== 'process-restart') assert.fail('restart missing');
    const wrongTarget = workload.events
      .filter(event => event.kind === restart.interruptedKind
        && event.projectOrdinal === restart.projectOrdinal
        && event.sequence !== restart.interruptedSequence
        && event.atMs < restart.atMs)
      .at(-1);
    assert.ok(wrongTarget);
    const executor = createFaultAwareCapacityExecutor(
      workload,
      undefined,
      new Map([[restart.sequence, wrongTarget.sequence]]),
    );

    await assert.rejects(runCapacityWorkload({
      clock: new VirtualClock(),
      execute: executor,
      signal: AbortSignal.timeout(1_000),
      workload,
    }), /capacity-workload-run-failed/);
  });
});
