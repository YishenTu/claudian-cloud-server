import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCapacityReport,
  decodeCapacityReport,
  serializeCapacityReport,
  type CapacityObservation,
} from './CapacityReport.js';

function acceptedObservation(): CapacityObservation {
  return {
    durationMs: 60 * 60 * 1_000,
    economicalTuningExhausted: false,
    imageBuild: 'a'.repeat(40),
    integrity: {
      crossProjectLeakCount: 0,
      leakedResourceCount: 0,
      protectedRefDivergenceCount: 0,
      unresolvedJournalBypassCount: 0,
    },
    latency: {
      control: { count: 1_833, p95Ms: 180, p99Ms: 620 },
      databasePoolWait: { count: 1_833, p95Ms: 45 },
      eventInvalidation: { count: 659, p95Ms: 900 },
      gitQueueWait: { count: 791, p95Ms: 1_200 },
    },
    machine: {
      logicalCpuCount: 2,
      memoryBytes: 4 * 1024 ** 3,
      repositoryVolumeBytes: 80 * 1024 ** 3,
      storageKind: 'local-ssd',
    },
    operations: {
      backupDurationMs: 20 * 60 * 1_000,
      backupIntervalMs: 24 * 60 * 60 * 1_000,
      largestProjectGitProcessingPercent: 8,
      largestProjectStoragePercent: 4,
      projectGitProcessingThresholdBreachWindows: 0,
      projectGitProcessingWindows: 2,
      projectStorageThresholdBreachWindows: 0,
      projectStorageWindows: 3,
      restoreDurationMs: 90 * 60 * 1_000,
      restoreObjectiveMs: 8 * 60 * 60 * 1_000,
    },
    profile: 'single-host',
    requests: {
      admissionRejected: 20,
      overloadProbeRetryable: true,
      ordinaryAdmissionRejected: 20,
      ordinaryRetryableAdmissionRejected: 20,
      ordinaryTotal: 2_661,
      retryableAdmissionRejected: 20,
      total: 2_674,
      unexpected5xx: 2,
    },
    resources: {
      minimumRepositoryFreePercent: 52,
      peakAccepts: 1,
      peakAdmittedGitRequests: 6,
      peakCloneRequests: 1,
      peakControlRequests: 32,
      peakFetchRequests: 3,
      peakGitChildCpuPercent: 70,
      peakGitChildRssBytes: 256 * 1024 ** 2,
      peakGitChildren: 2,
      peakMemoryPercent: 62,
      peakOrdinaryPostgresTransactions: 8,
      peakPerProjectGitReads: 2,
      peakPerProjectQueuedRequests: 4,
      peakPinnedProjectLeaseConnections: 2,
      peakPublishes: 2,
      peakPushRequests: 2,
      peakReservedRecoveryConnections: 2,
      peakSubscriptions: 50,
      sustainedCpuPercent: 58,
      swapBytes: 0,
    },
    scenario: 'one-hour-mixed',
    seedSha256: 'b'.repeat(64),
    startedAt: '2026-08-29T00:00:00.000Z',
    workload: {
      memberships: 240,
      projects: 100,
      repositoryBytes: 12 * 1024 ** 3,
      subscriptions: 50,
    },
    workloadSha256: 'c'.repeat(64),
  };
}

describe('safe capacity report', () => {
  it('accepts the complete single-host envelope and emits canonical aggregate evidence', () => {
    const report = buildCapacityReport(acceptedObservation());

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.evaluation.status, 'accepted');
    assert.equal(report.evaluation.sharding.decision, 'not-recommended');
    assert.deepEqual(report.evaluation.failedThresholds, []);
    assert.deepEqual(
      decodeCapacityReport(JSON.parse(serializeCapacityReport(report))),
      report,
    );
    assert.equal(Object.isFrozen(report.operations), true);
    assert.equal(Object.isFrozen(report.evaluation.failedThresholds), true);
    assert.throws(() => {
      (report.resources as { sustainedCpuPercent: number }).sustainedCpuPercent = 99;
    }, TypeError);
  });

  it('requires economical tuning before a generic threshold miss recommends sharding', () => {
    const observation = acceptedObservation();
    const tuningRequired = buildCapacityReport({
      ...observation,
      latency: {
        ...observation.latency,
        control: { count: observation.latency.control.count, p95Ms: 251, p99Ms: 620 },
      },
    });
    const exhausted = buildCapacityReport({
      ...observation,
      economicalTuningExhausted: true,
      latency: {
        ...observation.latency,
        control: { count: observation.latency.control.count, p95Ms: 251, p99Ms: 620 },
      },
    });

    assert.equal(tuningRequired.evaluation.status, 'tuning-required');
    assert.equal(tuningRequired.evaluation.sharding.decision, 'not-recommended');
    assert.equal(exhausted.evaluation.status, 'rejected');
    assert.equal(exhausted.evaluation.sharding.decision, 'not-recommended');
    assert.deepEqual(exhausted.evaluation.sharding.triggers, []);

    const gitExhausted = buildCapacityReport({
      ...observation,
      economicalTuningExhausted: true,
      latency: {
        ...observation.latency,
        gitQueueWait: { count: observation.latency.gitQueueWait.count, p95Ms: 5_001 },
      },
    });
    assert.equal(gitExhausted.evaluation.sharding.decision, 'discovery-required');
    assert.deepEqual(gitExhausted.evaluation.sharding.triggers, [
      'git-queue-missed-after-economical-tuning',
    ]);
  });

  it('starts sharding discovery only at an accepted explicit trigger', () => {
    const observation = acceptedObservation();
    const report = buildCapacityReport({
      ...observation,
      operations: {
        ...observation.operations,
        largestProjectStoragePercent: 10.01,
        projectStorageThresholdBreachWindows: 2,
      },
    });

    assert.equal(report.evaluation.sharding.decision, 'discovery-required');
    assert.deepEqual(report.evaluation.sharding.triggers, [
      'single-project-storage-share',
    ]);

    const oneWindow = buildCapacityReport({
      ...observation,
      operations: {
        ...observation.operations,
        largestProjectStoragePercent: 10.01,
        projectStorageThresholdBreachWindows: 1,
      },
    });
    assert.equal(oneWindow.evaluation.sharding.decision, 'not-recommended');
  });

  it('fails closed on unsafe, unknown, contradictory, or non-finite evidence', () => {
    const report = buildCapacityReport(acceptedObservation());
    const unsafe = structuredClone(report) as unknown as Record<string, unknown>;
    unsafe['projectName'] = 'private-project-content';
    assert.throws(() => decodeCapacityReport(unsafe), /capacity-report-invalid/);

    const nonFinite = structuredClone(report) as unknown as Record<string, unknown>;
    const resources = nonFinite['resources'] as Record<string, unknown>;
    resources['sustainedCpuPercent'] = Number.NaN;
    assert.throws(() => decodeCapacityReport(nonFinite), /capacity-report-invalid/);

    const contradictory = structuredClone(report) as unknown as Record<string, unknown>;
    const evaluation = contradictory['evaluation'] as Record<string, unknown>;
    evaluation['status'] = 'rejected';
    assert.throws(() => decodeCapacityReport(contradictory), /capacity-report-invalid/);

    const invalidPercentiles = acceptedObservation();
    assert.throws(() => buildCapacityReport({
      ...invalidPercentiles,
      latency: {
        ...invalidPercentiles.latency,
        control: { count: invalidPercentiles.latency.control.count, p95Ms: 700, p99Ms: 600 },
      },
    }), /capacity-report-invalid/);
    assert.throws(() => buildCapacityReport({
      ...acceptedObservation(),
      durationMs: 59 * 60 * 1_000,
    }), /capacity-report-invalid/);
    assert.throws(() => buildCapacityReport({
      ...acceptedObservation(),
      latency: {
        ...acceptedObservation().latency,
        control: { count: 0, p95Ms: 180, p99Ms: 620 },
      },
    }), /capacity-report-invalid/);
    assert.throws(() => buildCapacityReport({
      ...acceptedObservation(),
      requests: {
        ...acceptedObservation().requests,
        admissionRejected: 2_000,
        ordinaryAdmissionRejected: 2_000,
        ordinaryRetryableAdmissionRejected: 2_000,
        retryableAdmissionRejected: 2_000,
        unexpected5xx: 1_000,
      },
    }), /capacity-report-invalid/);
    assert.throws(() => buildCapacityReport({
      ...acceptedObservation(),
      requests: {
        ...acceptedObservation().requests,
        admissionRejected: 1,
        ordinaryAdmissionRejected: 0,
        ordinaryRetryableAdmissionRejected: 0,
        retryableAdmissionRejected: 1,
      },
    }), /capacity-report-invalid/);
    assert.throws(() => buildCapacityReport({
      ...acceptedObservation(),
      requests: {
        ...acceptedObservation().requests,
        admissionRejected: 20,
        ordinaryAdmissionRejected: 0,
        ordinaryRetryableAdmissionRejected: 0,
        retryableAdmissionRejected: 20,
      },
    }), /capacity-report-invalid/);
    assert.throws(() => buildCapacityReport({
      ...acceptedObservation(),
      operations: {
        ...acceptedObservation().operations,
        largestProjectStoragePercent: 100,
        projectStorageThresholdBreachWindows: 0,
      },
    }), /capacity-report-invalid/);

    const serialized = serializeCapacityReport(report);
    assert.doesNotMatch(serialized, /private-project|path|credential|token|content/i);
  });

  it('rejects integrity, process-bound, retryability, and resource-ceiling failures', () => {
    const observation = acceptedObservation();
    const report = buildCapacityReport({
      ...observation,
      integrity: {
        ...observation.integrity,
        leakedResourceCount: 1,
      },
      requests: {
        ...observation.requests,
        admissionRejected: 21,
      },
      resources: {
        ...observation.resources,
        peakGitChildren: 3,
        swapBytes: 4096,
      },
    });

    assert.equal(report.evaluation.status, 'rejected');
    assert.deepEqual(report.evaluation.failedThresholds, [
      'all-overload-rejections-retryable',
      'no-leaked-resources',
      'no-swap',
      'running-git-children',
    ]);

    const noOverload = buildCapacityReport({
      ...observation,
      requests: {
        ...observation.requests,
        admissionRejected: 0,
        overloadProbeRetryable: false,
        ordinaryAdmissionRejected: 0,
        ordinaryRetryableAdmissionRejected: 0,
        retryableAdmissionRejected: 0,
      },
    });
    assert.equal(noOverload.evaluation.status, 'rejected');
    assert.ok(noOverload.evaluation.failedThresholds.includes(
      'all-overload-rejections-retryable',
    ));
    assert.ok(noOverload.evaluation.failedThresholds.includes(
      'capacity-overload-probe-retryable',
    ));
  });

  it('binds the lower-A machine and keeps free reserve distinct from repository share', () => {
    const observation = acceptedObservation();
    const wrongMachine = buildCapacityReport({
      ...observation,
      machine: {
        ...observation.machine,
        logicalCpuCount: 4,
        memoryBytes: 8 * 1024 ** 3,
      },
    });
    assert.equal(wrongMachine.evaluation.status, 'rejected');
    assert.deepEqual(wrongMachine.evaluation.failedThresholds, [
      'machine-logical-cpus',
      'machine-memory-envelope',
    ]);

    const reserveMiss = buildCapacityReport({
      ...observation,
      resources: {
        ...observation.resources,
        minimumRepositoryFreePercent: 39,
      },
    });
    assert.equal(reserveMiss.evaluation.status, 'tuning-required');
    assert.deepEqual(reserveMiss.evaluation.sharding.triggers, []);

    const repositoryShare = buildCapacityReport({
      ...observation,
      machine: {
        ...observation.machine,
        repositoryVolumeBytes: 20 * 1024 ** 3,
      },
    });
    assert.deepEqual(repositoryShare.evaluation.sharding.triggers, [
      'repository-data-share',
    ]);
  });

  it('requires every provisional single-host admission ceiling and child resource evidence', () => {
    const observation = acceptedObservation();
    const report = buildCapacityReport({
      ...observation,
      resources: {
        ...observation.resources,
        peakAdmittedGitRequests: 5,
        peakCloneRequests: 0,
        peakControlRequests: 31,
        peakFetchRequests: 2,
        peakGitChildCpuPercent: 0,
        peakGitChildRssBytes: 0,
        peakOrdinaryPostgresTransactions: 7,
        peakPerProjectGitReads: 1,
        peakPerProjectQueuedRequests: 3,
        peakPinnedProjectLeaseConnections: 1,
        peakPushRequests: 1,
        peakReservedRecoveryConnections: 1,
      },
    });

    assert.equal(report.evaluation.status, 'rejected');
    for (const threshold of [
      'admitted-git-requests',
      'clone-requests',
      'control-requests-in-flight',
      'fetch-requests',
      'git-child-resource-observed',
      'ordinary-postgres-transactions',
      'per-project-git-reads',
      'per-project-queued-requests',
      'pinned-project-lease-connections',
      'push-requests',
      'reserved-recovery-connections',
    ] as const) {
      assert.ok(report.evaluation.failedThresholds.includes(threshold));
    }
  });
});
