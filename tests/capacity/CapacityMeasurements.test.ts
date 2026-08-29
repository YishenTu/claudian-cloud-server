import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CapacityMeasurements,
  type CapacityResourceSample,
} from './CapacityMeasurements.js';
import {
  createCapacityWorkload,
  emitsCapacityProjectInvalidation,
  isCapacityControlOperation,
  isCapacityGitOperation,
  isCapacityOperationEvent,
  type CapacityOperationEvent,
  type CapacityWorkload,
  type CapacityWorkloadEvent,
} from './CapacityWorkload.js';
import {
  runCapacityWorkload,
  type CapacityResourceObservation,
  type CapacityWorkloadClock,
} from './CapacityWorkloadRunner.js';
import { createFaultAwareCapacityExecutor } from './FaultAwareCapacityExecutor.js';

const GIBIBYTE = 1024 ** 3;

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

function createMeasurements(workload: CapacityWorkload, imageBuild = 'c'.repeat(40)): CapacityMeasurements {
  return new CapacityMeasurements({
    backupIntervalMs: 24 * 60 * 60 * 1_000,
    economicalTuningExhausted: false,
    imageBuild,
    machine: {
      logicalCpuCount: 2,
      memoryBytes: 4 * GIBIBYTE,
      repositoryVolumeBytes: 80 * GIBIBYTE,
      storageKind: 'local-ssd',
    },
    restoreObjectiveMs: 8 * 60 * 60 * 1_000,
    startedAt: '2026-08-29T01:00:00.000Z',
    workload,
  });
}

function resourceSampleForEvent(
  event: Extract<CapacityWorkloadEvent, { readonly kind: 'resource-sample' }>,
  observation: CapacityResourceObservation,
): CapacityResourceSample {
  const peak = event.probeKind === 'capacity-envelope';
  return {
    accepts: observation.accepts,
    admittedGitRequests: observation.admittedGitRequests,
    atMs: event.atMs,
    cloneRequests: observation.cloneRequests,
    controlRequests: observation.controlRequests,
    eventSequence: event.sequence,
    fetchRequests: observation.fetchRequests,
    gitChildCpuPercent: observation.gitChildren > 0 ? 70 : 0,
    gitChildRssBytes: observation.gitChildren > 0 ? 256 * 1024 ** 2 : 0,
    gitChildren: observation.gitChildren,
    memoryPercent: peak ? 65 : 55,
    ordinaryPostgresTransactions: observation.ordinaryPostgresTransactions,
    perProjectGitReads: observation.perProjectGitReads,
    perProjectQueuedRequests: observation.perProjectQueuedRequests,
    pinnedProjectLeaseConnections: observation.pinnedProjectLeaseConnections,
    publishes: observation.publishes,
    pushRequests: observation.pushRequests,
    repositoryFreePercent: peak ? 50 : 60,
    reservedRecoveryConnections: observation.reservedRecoveryConnections,
    rollingFifteenMinuteCpuPercent: peak ? 60 : 50,
    subscriptions: observation.subscriptions,
    swapBytes: 0,
  };
}

function recordCompleteProjectMeasurements(
  measurements: CapacityMeasurements,
  workload: CapacityWorkload,
  overrides?: {
    readonly gitProcessingMsInWindow?: (
      project: CapacityWorkload['projects'][number],
      endAtMs: number,
    ) => number;
    readonly storageBytes?: (
      project: CapacityWorkload['projects'][number],
      atMs: number,
    ) => number;
  },
): void {
  for (const atMs of workload.measurement.projectStorageSnapshotAtMs) {
    for (const project of workload.projects) {
      measurements.recordProjectStorageSnapshot({
        atMs,
        opaqueProjectId: project.opaqueProjectId,
        storageBytes: overrides?.storageBytes?.(project, atMs) ?? project.repositoryBytes,
      });
    }
  }
  for (const endAtMs of workload.measurement.projectGitProcessingWindowEndAtMs) {
    for (const project of workload.projects) {
      measurements.recordProjectGitProcessingWindow({
        endAtMs,
        gitProcessingMsInWindow: overrides?.gitProcessingMsInWindow?.(
          project,
          endAtMs,
        ) ?? 100,
        opaqueProjectId: project.opaqueProjectId,
      });
    }
  }
}

async function recordRequiredEvidence(
  measurements: CapacityMeasurements,
  workload: CapacityWorkload,
  overrides?: {
    readonly gitQueueWaitMs?: (
      event: CapacityOperationEvent,
      childOrdinal: number,
    ) => number;
    readonly outcome?: (event: CapacityOperationEvent) => (
      'nonretryable-overload' | 'retryable-overload' | 'success' | 'unexpected-5xx'
    );
    readonly skipGitQueueWait?: (
      event: CapacityOperationEvent,
      childOrdinal: number,
    ) => boolean;
  },
): Promise<void> {
  measurements.recordBackupDuration(10 * 60 * 1_000);
  measurements.recordRestoreDuration(60 * 60 * 1_000);
  const execute = createFaultAwareCapacityExecutor(workload, (event, observation) => {
    if (event.kind === 'resource-sample') {
      assert.ok(observation);
      measurements.recordResourceSample(
        resourceSampleForEvent(event, observation),
        observation,
      );
      return;
    }
    if (!isCapacityOperationEvent(event)) return;
    measurements.recordRequest({
      controlLatencyMs: isCapacityControlOperation(event) ? 200 : null,
      eventSequence: event.sequence,
      outcome: overrides?.outcome?.(event) ?? (
        event.overloadProbe ? 'retryable-overload' : 'success'
      ),
      trafficClass: event.trafficClass,
    });
    if (isCapacityControlOperation(event)) {
      measurements.recordDatabasePoolWait({
        durationMs: 20,
        eventSequence: event.sequence,
      });
    }
    if (emitsCapacityProjectInvalidation(event)) {
      measurements.recordEventInvalidation({
        durationMs: 500,
        eventSequence: event.sequence,
      });
    }
    if (isCapacityGitOperation(event)) {
      for (let childOrdinal = 0; childOrdinal < event.gitChildCount; childOrdinal += 1) {
        if (overrides?.skipGitQueueWait?.(event, childOrdinal) === true) continue;
        measurements.recordGitQueueWait({
          childOrdinal,
          durationMs: overrides?.gitQueueWaitMs?.(event, childOrdinal) ?? 1_000,
          eventSequence: event.sequence,
        });
      }
    }
  });
  const completion = await runCapacityWorkload({
    clock: new VirtualClock(),
    execute,
    signal: AbortSignal.timeout(1_000),
    workload,
  });
  measurements.recordRunCompletion(completion);
}

describe('capacity measurement aggregation', () => {
  it('reduces exact timeline evidence into one accepted report without Project identifiers', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-seed',
    });
    const measurements = createMeasurements(workload);

    await recordRequiredEvidence(measurements, workload);
    recordCompleteProjectMeasurements(measurements, workload);

    const report = measurements.buildReport();
    const firstProject = workload.projects[0];
    assert.ok(firstProject);

    assert.equal(report.evaluation.status, 'accepted');
    assert.equal(
      report.requests.total,
      workload.events.filter(isCapacityOperationEvent).length,
    );
    assert.equal(
      report.latency.control.count,
      workload.events.filter(isCapacityControlOperation).length,
    );
    assert.equal(report.latency.databasePoolWait.count, report.latency.control.count);
    assert.equal(
      report.latency.eventInvalidation.count,
      workload.events.filter(emitsCapacityProjectInvalidation).length,
    );
    assert.equal(
      report.latency.gitQueueWait.count,
      workload.events.filter(isCapacityOperationEvent).reduce(
        (total, event) => total + event.gitChildCount,
        0,
      ),
    );
    assert.equal(report.latency.control.p95Ms, 200);
    assert.equal(report.latency.control.p99Ms, 200);
    assert.equal(report.requests.admissionRejected, 1);
    assert.equal(report.requests.ordinaryAdmissionRejected, 1);
    assert.equal(report.requests.retryableAdmissionRejected, 1);
    assert.equal(report.requests.overloadProbeRetryable, true);
    assert.equal(report.resources.sustainedCpuPercent, 60);
    assert.equal(report.resources.peakMemoryPercent, 65);
    assert.equal(report.resources.minimumRepositoryFreePercent, 50);
    assert.equal(report.resources.peakGitChildren, 2);
    assert.equal(report.operations.projectGitProcessingWindows, 2);
    assert.equal(report.operations.projectStorageWindows, 3);
    assert.match(report.workloadSha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(firstProject.opaqueProjectId));
  });

  it('counts only fixed integrity, traffic classes, and request outcomes', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-failure-seed',
    });
    const measurements = createMeasurements(workload, 'd'.repeat(40));

    await recordRequiredEvidence(measurements, workload, {
      outcome: event => event.overloadProbe ? 'nonretryable-overload' : 'success',
    });
    const firstProject = workload.projects[0];
    assert.ok(firstProject);
    recordCompleteProjectMeasurements(measurements, workload, {
      gitProcessingMsInWindow: project => project === firstProject ? 100 : 1,
    });
    measurements.recordIntegrityFailure('cross-project-leak');
    measurements.recordIntegrityFailure('unresolved-journal-bypass');

    const report = measurements.buildReport();

    assert.equal(report.evaluation.status, 'rejected');
    assert.equal(report.integrity.crossProjectLeakCount, 1);
    assert.equal(report.integrity.unresolvedJournalBypassCount, 1);
    assert.equal(report.requests.admissionRejected, 1);
    assert.equal(report.requests.ordinaryAdmissionRejected, 1);
    assert.equal(report.requests.retryableAdmissionRejected, 0);
    assert.equal(report.requests.overloadProbeRetryable, false);
    assert.deepEqual(report.evaluation.sharding.triggers, [
      'single-project-git-processing-share',
    ]);
  });

  it('accepts measured repository growth instead of equating live bytes with the seed', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-growth-seed',
    });
    const measurements = createMeasurements(workload, 'e'.repeat(40));
    await recordRequiredEvidence(measurements, workload);
    const lastAtMs = workload.measurement.projectStorageSnapshotAtMs.at(-1);
    assert.ok(lastAtMs !== undefined);
    const firstProject = workload.projects[0];
    assert.ok(firstProject);
    recordCompleteProjectMeasurements(measurements, workload, {
      gitProcessingMsInWindow: () => 1,
      storageBytes: (project, atMs) => project.repositoryBytes
        + (project === firstProject && atMs === lastAtMs ? 1 : 0),
    });

    const report = measurements.buildReport();
    const seededBytes = workload.projects.reduce(
      (total, project) => total + project.repositoryBytes,
      0,
    );
    assert.equal(report.workload.repositoryBytes, seededBytes + 1);
    assert.equal(report.evaluation.status, 'accepted');
  });

  it('carries observed unexpected failures into report evaluation', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-unexpected-failure-seed',
    });
    const measurements = createMeasurements(workload);
    const unexpectedSequences = new Set(workload.events
      .filter((event): event is CapacityOperationEvent => (
        isCapacityOperationEvent(event)
        && event.trafficClass === 'ordinary'
        && !event.overloadProbe
      ))
      .slice(0, 20)
      .map(event => event.sequence));
    await recordRequiredEvidence(measurements, workload, {
      outcome: event => event.overloadProbe
        ? 'retryable-overload'
        : unexpectedSequences.has(event.sequence) ? 'unexpected-5xx' : 'success',
    });
    recordCompleteProjectMeasurements(measurements, workload);

    const report = measurements.buildReport();
    assert.equal(report.requests.unexpected5xx, 20);
    assert.equal(report.evaluation.status, 'tuning-required');
    assert.ok(report.evaluation.failedThresholds.includes('unexpected-5xx-rate'));
  });

  it('rejects missing cadence, completion, or Project-window evidence', () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-incomplete-seed',
    });
    const measurements = createMeasurements(workload, 'f'.repeat(40));
    const controlEvent = workload.events.find(isCapacityControlOperation);
    const invalidationEvent = workload.events.find(emitsCapacityProjectInvalidation);
    const gitEvent = workload.events.find(isCapacityGitOperation);
    assert.ok(controlEvent);
    assert.ok(invalidationEvent);
    assert.ok(gitEvent);
    measurements.recordRequest({
      controlLatencyMs: 1,
      eventSequence: controlEvent.sequence,
      outcome: 'success',
      trafficClass: 'ordinary',
    });
    measurements.recordDatabasePoolWait({
      durationMs: 1,
      eventSequence: controlEvent.sequence,
    });
    measurements.recordEventInvalidation({
      durationMs: 1,
      eventSequence: invalidationEvent.sequence,
    });
    measurements.recordGitQueueWait({
      childOrdinal: 0,
      durationMs: 1,
      eventSequence: gitEvent.sequence,
    });
    measurements.recordBackupDuration(1);
    measurements.recordRestoreDuration(1);
    const firstProject = workload.projects[0];
    assert.ok(firstProject);
    measurements.recordProjectStorageSnapshot({
      atMs: 0,
      opaqueProjectId: firstProject.opaqueProjectId,
      storageBytes: firstProject.repositoryBytes,
    });

    assert.throws(() => measurements.buildReport(), /capacity-measurement-invalid/);
  });

  it('rejects a structurally copied completion that was not issued by the runner', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-forged-completion-seed',
    });
    const completion = await runCapacityWorkload({
      clock: new VirtualClock(),
      execute: createFaultAwareCapacityExecutor(workload),
      signal: AbortSignal.timeout(1_000),
      workload,
    });
    const measurements = createMeasurements(workload, '2'.repeat(40));

    assert.throws(() => measurements.recordRunCompletion({ ...completion }), (
      /capacity-measurement-invalid/
    ));
    measurements.recordRunCompletion(completion);
  });

  it('does not treat one dominant Git interval as repeated dominance', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-one-git-window-seed',
    });
    const measurements = createMeasurements(workload, '1'.repeat(40));
    await recordRequiredEvidence(measurements, workload);
    const firstProject = workload.projects[0];
    const firstWindowEnd = workload.measurement.projectGitProcessingWindowEndAtMs[0];
    assert.ok(firstProject);
    assert.ok(firstWindowEnd !== undefined);
    recordCompleteProjectMeasurements(measurements, workload, {
      gitProcessingMsInWindow: (project, endAtMs) => (
        project === firstProject && endAtMs === firstWindowEnd ? 100 : 1
      ),
    });

    const report = measurements.buildReport();
    assert.equal(report.operations.projectGitProcessingThresholdBreachWindows, 1);
    assert.equal(report.evaluation.status, 'accepted');
    assert.deepEqual(report.evaluation.sharding.triggers, []);
  });

  it('rejects caller relabeling and pre-run or contradictory resource samples', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-authority-seed',
    });
    const ordinary = workload.events.find(event => (
      isCapacityOperationEvent(event) && event.trafficClass === 'ordinary'
    ));
    const firstSample = workload.events.find(event => event.kind === 'resource-sample');
    assert.ok(ordinary && isCapacityOperationEvent(ordinary));
    assert.ok(firstSample?.kind === 'resource-sample');
    assert.throws(() => createMeasurements({ ...workload }), /capacity-measurement-invalid/);
    const measurements = createMeasurements(workload);
    const forgedObservation = {
      accepts: 0,
      admittedGitRequests: 0,
      atMs: firstSample.atMs,
      cloneRequests: 0,
      controlRequests: 0,
      eventSequence: firstSample.sequence,
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
    } satisfies CapacityResourceObservation;

    assert.throws(() => measurements.recordRequest({
      controlLatencyMs: isCapacityControlOperation(ordinary) ? 1 : null,
      eventSequence: ordinary.sequence,
      outcome: 'success',
      trafficClass: 'fault-injection',
    }), /capacity-measurement-invalid/);
    assert.throws(() => measurements.recordResourceSample({
      ...resourceSampleForEvent(firstSample, forgedObservation),
    }, forgedObservation), /capacity-measurement-invalid/);

    let contradictionChecked = false;
    let expiredEvidence: {
      readonly event: Extract<CapacityWorkloadEvent, { readonly kind: 'resource-sample' }>;
      readonly observation: CapacityResourceObservation;
    } | undefined;
    const execute = createFaultAwareCapacityExecutor(workload, (event, observation) => {
      if (event.kind !== 'resource-sample') return;
      assert.ok(observation);
      expiredEvidence ??= { event, observation };
      const sample = resourceSampleForEvent(event, observation);
      if (!contradictionChecked && event.probeKind === 'capacity-envelope') {
        assert.throws(() => measurements.recordResourceSample({
          ...sample,
          admittedGitRequests: sample.admittedGitRequests - 1,
        }, observation), /capacity-measurement-invalid/);
        contradictionChecked = true;
      }
      measurements.recordResourceSample(sample, observation);
    });
    await runCapacityWorkload({
      clock: new VirtualClock(),
      execute,
      signal: AbortSignal.timeout(1_000),
      workload,
    });
    assert.equal(contradictionChecked, true);
    const expired = expiredEvidence;
    assert.ok(expired);
    const lateMeasurements = createMeasurements(workload);
    assert.throws(() => lateMeasurements.recordResourceSample(
      resourceSampleForEvent(expired.event, expired.observation),
      expired.observation,
    ), /capacity-measurement-invalid/);
  });

  it('includes Git children owned by Accept, backup, transfer, and recovery work', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-all-git-children-seed',
    });
    const measurements = createMeasurements(workload);
    const directKinds = new Set(['git-clone', 'git-fetch', 'git-push']);
    await recordRequiredEvidence(measurements, workload, {
      gitQueueWaitMs: event => directKinds.has(event.kind) ? 1_000 : 6_000,
    });
    recordCompleteProjectMeasurements(measurements, workload);

    const report = measurements.buildReport();
    assert.equal(report.latency.gitQueueWait.p95Ms, 6_000);
    assert.equal(report.evaluation.status, 'tuning-required');
    assert.ok(workload.events.some(event => (
      isCapacityOperationEvent(event)
      && ['accept', 'backup', 'recovery-verification'].includes(event.kind)
      && event.gitChildCount > 0
    )));
  });

  it('requires the eventual child wait for a queued envelope request', async () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'measurement-queued-envelope-child-seed',
    });
    const queued = workload.events.find(event => (
      isCapacityOperationEvent(event)
      && (event.resourceClaims?.perProjectQueuedRequests ?? 0) > 0
    ));
    assert.ok(queued && isCapacityOperationEvent(queued));
    const measurements = createMeasurements(workload);
    await recordRequiredEvidence(measurements, workload, {
      skipGitQueueWait: event => event === queued,
    });
    recordCompleteProjectMeasurements(measurements, workload);

    assert.throws(() => measurements.buildReport(), /capacity-measurement-invalid/);
  });
});
