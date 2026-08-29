import { createHash } from 'node:crypto';
import {
  setImmediate as yieldToEventLoop,
  setTimeout as wait,
} from 'node:timers/promises';

import {
  digestCapacityWorkload,
  isCapacityOperationEvent,
  isIssuedCapacityWorkload,
  type CapacityWorkload,
  type CapacityWorkloadEvent,
} from './CapacityWorkload.js';

export interface CapacityWorkloadClock {
  nowMs(): number;
  waitUntil(targetMs: number, signal: AbortSignal): Promise<void>;
}

export interface CapacityRunCompletion {
  readonly completedEventCount: number;
  readonly completedSequenceSha256: string;
  readonly workloadSha256: string;
}

const issuedCompletions = new WeakSet<CapacityRunCompletion>();

export interface CapacityResourceObservation {
  readonly accepts: number;
  readonly admittedGitRequests: number;
  readonly atMs: number;
  readonly cloneRequests: number;
  readonly controlRequests: number;
  readonly eventSequence: number;
  readonly fetchRequests: number;
  readonly gitChildren: number;
  readonly ordinaryPostgresTransactions: number;
  readonly perProjectGitReads: number;
  readonly perProjectQueuedRequests: number;
  readonly pinnedProjectLeaseConnections: number;
  readonly publishes: number;
  readonly pushRequests: number;
  readonly reservedRecoveryConnections: number;
  readonly subscriptions: number;
}

const issuedResourceObservations = new WeakMap<
  CapacityResourceObservation,
  { readonly eventSequence: number; readonly workload: CapacityWorkload }
>();
const activeResourceObservations = new WeakSet<CapacityResourceObservation>();

export interface RunCapacityWorkloadOptions {
  readonly clock?: CapacityWorkloadClock;
  readonly execute: (
    event: CapacityWorkloadEvent,
    signal: AbortSignal,
    resourceObservation: CapacityResourceObservation | null,
  ) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly workload: CapacityWorkload;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

class SystemCapacityWorkloadClock implements CapacityWorkloadClock {
  nowMs(): number {
    return performance.now();
  }

  async waitUntil(targetMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('capacity-workload-run-failed');
    const remainingMs = Math.max(0, targetMs - performance.now());
    await wait(remainingMs, undefined, { signal });
  }
}

function expectedSequences(workload: CapacityWorkload): readonly number[] {
  if (!isIssuedCapacityWorkload(workload)
    || workload.events.length === 0
    || workload.durationMs <= 0) {
    throw new Error('capacity-workload-run-failed');
  }
  const sequences = workload.events.map(event => event.sequence).sort((left, right) => (
    left - right
  ));
  if (sequences.some((sequence, index) => sequence !== index)
    || workload.events.some((event, index, events) => (
      event.atMs < 0
      || event.atMs > workload.durationMs
      || (event.atMs === workload.durationMs && event.kind !== 'resource-sample')
      || (index > 0 && (events[index - 1]?.atMs ?? event.atMs) > event.atMs)
    ))
    || workload.events.some(event => {
      if (event.kind !== 'resource-sample') return false;
      return (event.probeKind === null) !== (event.ceilingProbeSequences.length === 0)
        || new Set(event.ceilingProbeSequences).size !== event.ceilingProbeSequences.length
        || event.ceilingProbeSequences.some(sequence => {
          const probe = workload.events.find(candidate => candidate.sequence === sequence);
          return probe === undefined
            || !isCapacityOperationEvent(probe)
            || probe.resourceClaims === null
            || probe.atMs !== event.atMs
            || probe.sequence >= event.sequence;
        });
    })
    || workload.events.some(event => {
      if (event.kind !== 'process-restart') return false;
      const interrupted = workload.events.find(candidate => (
        candidate.sequence === event.interruptedSequence
      ));
      return interrupted === undefined
        || interrupted.kind !== event.interruptedKind
        || interrupted.projectOrdinal !== event.projectOrdinal
        || interrupted.atMs >= event.atMs;
    })) {
    throw new Error('capacity-workload-run-failed');
  }
  return Object.freeze(sequences);
}

function expectedCapacityRunCompletion(
  workload: CapacityWorkload,
): CapacityRunCompletion {
  const sequences = expectedSequences(workload);
  return Object.freeze({
    completedEventCount: sequences.length,
    completedSequenceSha256: sha256(JSON.stringify(sequences)),
    workloadSha256: digestCapacityWorkload(workload),
  });
}

export function isCapacityRunCompletionForWorkload(
  completion: CapacityRunCompletion,
  workload: CapacityWorkload,
): boolean {
  const expected = expectedCapacityRunCompletion(workload);
  return issuedCompletions.has(completion)
    && completion.completedEventCount === expected.completedEventCount
    && completion.completedSequenceSha256 === expected.completedSequenceSha256
    && completion.workloadSha256 === expected.workloadSha256;
}

export function isCapacityResourceObservationForEvent(
  observation: CapacityResourceObservation,
  workload: CapacityWorkload,
  eventSequence: number,
): boolean {
  const issued = issuedResourceObservations.get(observation);
  return activeResourceObservations.has(observation)
    && issued?.workload === workload
    && issued.eventSequence === eventSequence;
}

function resourceObservation(
  event: Extract<CapacityWorkloadEvent, { readonly kind: 'resource-sample' }>,
  workload: CapacityWorkload,
  activeSequences: ReadonlySet<number>,
): CapacityResourceObservation {
  const observation: Record<keyof Omit<
    CapacityResourceObservation,
    'atMs' | 'eventSequence'
  >, number> = {
    accepts: 0,
    admittedGitRequests: 0,
    cloneRequests: 0,
    controlRequests: 0,
    fetchRequests: 0,
    gitChildren: 0,
    ordinaryPostgresTransactions: 0,
    perProjectGitReads: 0,
    perProjectQueuedRequests: 0,
    pinnedProjectLeaseConnections: 0,
    publishes: 0,
    pushRequests: 0,
    reservedRecoveryConnections: 0,
    subscriptions: 0,
  };
  const readsByProject = new Map<number, number>();
  const queuedByProject = new Map<number, number>();
  for (const sequence of event.ceilingProbeSequences) {
    const operation = workload.events.find(candidate => candidate.sequence === sequence);
    if (!activeSequences.has(sequence)
      || operation === undefined
      || !isCapacityOperationEvent(operation)
      || operation.resourceClaims === null) {
      throw new Error('capacity-workload-run-failed');
    }
    for (const key of Object.keys(observation) as Array<keyof typeof observation>) {
      const value = operation.resourceClaims[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('capacity-workload-run-failed');
      }
      if (key !== 'perProjectGitReads' && key !== 'perProjectQueuedRequests') {
        observation[key] += value;
      }
    }
    readsByProject.set(
      operation.projectOrdinal,
      (readsByProject.get(operation.projectOrdinal) ?? 0)
        + (operation.resourceClaims.perProjectGitReads ?? 0),
    );
    queuedByProject.set(
      operation.projectOrdinal,
      (queuedByProject.get(operation.projectOrdinal) ?? 0)
        + (operation.resourceClaims.perProjectQueuedRequests ?? 0),
    );
  }
  observation.perProjectGitReads = Math.max(0, ...readsByProject.values());
  observation.perProjectQueuedRequests = Math.max(0, ...queuedByProject.values());
  const issued = Object.freeze({
    ...observation,
    atMs: event.atMs,
    eventSequence: event.sequence,
  });
  issuedResourceObservations.set(issued, { eventSequence: event.sequence, workload });
  activeResourceObservations.add(issued);
  return issued;
}

export async function runCapacityWorkload(
  options: RunCapacityWorkloadOptions,
): Promise<CapacityRunCompletion> {
  const expected = expectedCapacityRunCompletion(options.workload);
  const clock = options.clock ?? new SystemCapacityWorkloadClock();
  const internalAbort = new AbortController();
  const signal = options.signal === undefined
    ? internalAbort.signal
    : AbortSignal.any([options.signal, internalAbort.signal]);
  const startedAtMs = clock.nowMs();
  const completedSequences: number[] = [];
  const activeSequences = new Set<number>();
  const inFlight = new Set<Promise<void>>();
  let failed = false;

  const dispatch = (event: CapacityWorkloadEvent): void => {
    let observation: CapacityResourceObservation | null = null;
    const operation = Promise.resolve()
      .then(() => {
        if (event.kind === 'process-restart') {
          if (!activeSequences.has(event.interruptedSequence)) {
            throw new Error('capacity-workload-run-failed');
          }
        } else {
          if (event.kind === 'resource-sample') {
            observation = resourceObservation(event, options.workload, activeSequences);
          }
          activeSequences.add(event.sequence);
        }
        return options.execute(event, signal, observation);
      })
      .then(() => {
        completedSequences.push(event.sequence);
      })
      .catch(() => {
        failed = true;
        internalAbort.abort();
      })
      .finally(() => {
        if (observation !== null) activeResourceObservations.delete(observation);
        if (event.kind !== 'process-restart') {
          activeSequences.delete(event.sequence);
        }
        inFlight.delete(operation);
      });
    inFlight.add(operation);
  };

  try {
    let index = 0;
    while (index < options.workload.events.length) {
      if (signal.aborted) throw new Error('capacity-workload-run-failed');
      const event = options.workload.events[index];
      if (event === undefined) throw new Error('capacity-workload-run-failed');
      await clock.waitUntil(startedAtMs + event.atMs, signal);
      const atMs = event.atMs;
      const sameInstantEvents: CapacityWorkloadEvent[] = [];
      while (index < options.workload.events.length
        && options.workload.events[index]?.atMs === atMs) {
        const sameInstantEvent = options.workload.events[index];
        if (sameInstantEvent === undefined) throw new Error('capacity-workload-run-failed');
        sameInstantEvents.push(sameInstantEvent);
        index += 1;
      }
      for (const sameInstantEvent of sameInstantEvents) {
        if (sameInstantEvent.kind !== 'resource-sample') dispatch(sameInstantEvent);
      }
      if (sameInstantEvents.some(candidate => candidate.kind === 'resource-sample')) {
        await yieldToEventLoop(undefined, { signal });
        for (const sameInstantEvent of sameInstantEvents) {
          if (sameInstantEvent.kind === 'resource-sample') dispatch(sameInstantEvent);
        }
      }
      await yieldToEventLoop(undefined, { signal });
    }
    await Promise.all(inFlight);
  } catch {
    failed = true;
    internalAbort.abort();
    await Promise.allSettled(inFlight);
  }

  const actualSequences = completedSequences.sort((left, right) => left - right);
  if (failed
    || actualSequences.length !== expected.completedEventCount
    || sha256(JSON.stringify(actualSequences)) !== expected.completedSequenceSha256) {
    throw new Error('capacity-workload-run-failed');
  }
  const completion = Object.freeze({ ...expected });
  issuedCompletions.add(completion);
  return completion;
}
