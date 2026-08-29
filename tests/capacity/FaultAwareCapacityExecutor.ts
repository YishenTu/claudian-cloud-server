import type {
  CapacityWorkload,
  CapacityWorkloadEvent,
} from './CapacityWorkload.js';
import type { CapacityResourceObservation } from './CapacityWorkloadRunner.js';

export function createFaultAwareCapacityExecutor(
  workload: CapacityWorkload,
  onStart?: (
    event: CapacityWorkloadEvent,
    resourceObservation: CapacityResourceObservation | null,
  ) => void,
  targetOverrides: ReadonlyMap<number, number> = new Map(),
): (
  event: CapacityWorkloadEvent,
  signal: AbortSignal,
  resourceObservation: CapacityResourceObservation | null,
) => Promise<void> {
  const targetToRestart = new Map<number, number>();
  for (const restart of workload.events.filter(event => event.kind === 'process-restart')) {
    targetToRestart.set(
      targetOverrides.get(restart.sequence) ?? restart.interruptedSequence,
      restart.sequence,
    );
  }
  const probeToSample = new Map<number, number>();
  for (const sample of workload.events.filter(event => event.kind === 'resource-sample')) {
    for (const probeSequence of sample.ceilingProbeSequences) {
      probeToSample.set(probeSequence, sample.sequence);
    }
  }
  const releases = new Map<number, Set<() => void>>();

  return async (event, signal, resourceObservation) => {
    onStart?.(event, resourceObservation);
    if (event.kind === 'process-restart' || event.kind === 'resource-sample') {
      const release = releases.get(event.sequence);
      if (release !== undefined) {
        for (const settle of release) settle();
      }
      else if (event.kind === 'process-restart') {
        throw new Error('fault-aware-executor-invalid');
      }
      return;
    }
    const releaseSequence = targetToRestart.get(event.sequence)
      ?? probeToSample.get(event.sequence);
    if (releaseSequence === undefined) return;
    await new Promise<void>((resolve, reject) => {
      const release = releases.get(releaseSequence) ?? new Set<() => void>();
      release.add(resolve);
      releases.set(releaseSequence, release);
      signal.addEventListener('abort', () => {
        reject(new Error('fault-aware-executor-aborted'));
      }, { once: true });
    });
  };
}
