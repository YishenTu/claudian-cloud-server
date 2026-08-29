import {
  A_TEST_CAPACITY_LIMITS,
  A_TEST_CAPACITY_PROFILE,
} from './CapacityWorkload.js';

export type CapacityScenario = 'eight-hour-soak' | 'one-hour-mixed';

export interface CapacityObservation {
  readonly durationMs: number;
  readonly economicalTuningExhausted: boolean;
  readonly imageBuild: string;
  readonly integrity: {
    readonly crossProjectLeakCount: number;
    readonly leakedResourceCount: number;
    readonly protectedRefDivergenceCount: number;
    readonly unresolvedJournalBypassCount: number;
  };
  readonly latency: {
    readonly control: { readonly count: number; readonly p95Ms: number; readonly p99Ms: number };
    readonly databasePoolWait: { readonly count: number; readonly p95Ms: number };
    readonly eventInvalidation: { readonly count: number; readonly p95Ms: number };
    readonly gitQueueWait: { readonly count: number; readonly p95Ms: number };
  };
  readonly machine: {
    readonly logicalCpuCount: number;
    readonly memoryBytes: number;
    readonly repositoryVolumeBytes: number;
    readonly storageKind: 'local-ssd';
  };
  readonly operations: {
    readonly backupDurationMs: number;
    readonly backupIntervalMs: number;
    readonly largestProjectGitProcessingPercent: number;
    readonly largestProjectStoragePercent: number;
    readonly projectGitProcessingThresholdBreachWindows: number;
    readonly projectGitProcessingWindows: number;
    readonly projectStorageThresholdBreachWindows: number;
    readonly projectStorageWindows: number;
    readonly restoreDurationMs: number;
    readonly restoreObjectiveMs: number;
  };
  readonly profile: 'a-test';
  readonly requests: {
    readonly admissionRejected: number;
    readonly overloadProbeRetryable: boolean;
    readonly ordinaryAdmissionRejected: number;
    readonly ordinaryRetryableAdmissionRejected: number;
    readonly ordinaryTotal: number;
    readonly retryableAdmissionRejected: number;
    readonly total: number;
    readonly unexpected5xx: number;
  };
  readonly resources: {
    readonly minimumRepositoryFreePercent: number;
    readonly peakAccepts: number;
    readonly peakAdmittedGitRequests: number;
    readonly peakCloneRequests: number;
    readonly peakControlRequests: number;
    readonly peakFetchRequests: number;
    readonly peakGitChildCpuPercent: number;
    readonly peakGitChildRssBytes: number;
    readonly peakGitChildren: number;
    readonly peakMemoryPercent: number;
    readonly peakOrdinaryPostgresTransactions: number;
    readonly peakPerProjectGitReads: number;
    readonly peakPerProjectQueuedRequests: number;
    readonly peakPinnedProjectLeaseConnections: number;
    readonly peakPublishes: number;
    readonly peakPushRequests: number;
    readonly peakReservedRecoveryConnections: number;
    readonly peakSubscriptions: number;
    readonly sustainedCpuPercent: number;
    readonly swapBytes: number;
  };
  readonly scenario: CapacityScenario;
  readonly seedSha256: string;
  readonly startedAt: string;
  readonly workload: {
    readonly memberships: number;
    readonly projects: number;
    readonly repositoryBytes: number;
    readonly subscriptions: number;
  };
  readonly workloadSha256: string;
}

export type CapacityThreshold =
  | 'admitted-git-requests'
  | 'all-overload-rejections-retryable'
  | 'capacity-overload-probe-retryable'
  | 'clone-requests'
  | 'concurrent-accepts'
  | 'concurrent-publishes'
  | 'control-requests-in-flight'
  | 'control-p95'
  | 'control-p99'
  | 'database-pool-wait-p95'
  | 'event-invalidation-p95'
  | 'git-queue-wait-p95'
  | 'git-child-resource-observed'
  | 'fetch-requests'
  | 'machine-logical-cpus'
  | 'machine-memory-envelope'
  | 'membership-count'
  | 'no-cross-project-leaks'
  | 'no-leaked-resources'
  | 'no-protected-ref-divergence'
  | 'no-swap'
  | 'no-unresolved-journal-bypass'
  | 'ordinary-admission-rejection-rate'
  | 'ordinary-postgres-transactions'
  | 'peak-memory'
  | 'project-count'
  | 'per-project-git-reads'
  | 'per-project-queued-requests'
  | 'pinned-project-lease-connections'
  | 'push-requests'
  | 'repository-free-reserve'
  | 'repository-size-envelope'
  | 'repository-volume-envelope'
  | 'running-git-children'
  | 'reserved-recovery-connections'
  | 'subscription-count'
  | 'sustained-cpu'
  | 'unexpected-5xx-rate';

export type ShardingTrigger =
  | 'backup-window-share'
  | 'git-queue-missed-after-economical-tuning'
  | 'repository-data-share'
  | 'restore-objective-share'
  | 'single-project-git-processing-share'
  | 'single-project-storage-share';

export interface CapacityEvaluation {
  readonly failedThresholds: readonly CapacityThreshold[];
  readonly sharding: {
    readonly decision: 'discovery-required' | 'not-recommended';
    readonly triggers: readonly ShardingTrigger[];
  };
  readonly status: 'accepted' | 'rejected' | 'tuning-required';
}

export interface CapacityReport extends CapacityObservation {
  readonly evaluation: CapacityEvaluation;
  readonly schemaVersion: 1;
}

const GIBIBYTE = 1024 ** 3;

interface ThresholdResult {
  readonly name: CapacityThreshold;
  readonly passed: boolean;
  readonly safetyCritical: boolean;
}

function percentageRate(count: number, total: number): number {
  return total === 0 ? Number.POSITIVE_INFINITY : count / total;
}

function evaluateThresholds(observation: CapacityObservation): readonly ThresholdResult[] {
  const ordinaryAdmissionRate = percentageRate(
    observation.requests.ordinaryAdmissionRejected,
    observation.requests.ordinaryTotal,
  );
  const unexpected5xxRate = percentageRate(
    observation.requests.unexpected5xx,
    observation.requests.total,
  );
  return Object.freeze([
    {
      name: 'all-overload-rejections-retryable',
      passed: observation.requests.admissionRejected > 0
        && observation.requests.admissionRejected
        === observation.requests.retryableAdmissionRejected,
      safetyCritical: true,
    },
    {
      name: 'capacity-overload-probe-retryable',
      passed: observation.requests.overloadProbeRetryable,
      safetyCritical: true,
    },
    {
      name: 'machine-logical-cpus',
      passed: observation.machine.logicalCpuCount === 2,
      safetyCritical: true,
    },
    {
      name: 'machine-memory-envelope',
      passed: observation.machine.memoryBytes >= 3.5 * GIBIBYTE
        && observation.machine.memoryBytes <= 4.5 * GIBIBYTE,
      safetyCritical: true,
    },
    {
      name: 'repository-volume-envelope',
      passed: observation.machine.repositoryVolumeBytes >= 80 * GIBIBYTE,
      safetyCritical: true,
    },
    {
      name: 'membership-count',
      passed: observation.workload.memberships === A_TEST_CAPACITY_PROFILE.memberships,
      safetyCritical: true,
    },
    {
      name: 'no-cross-project-leaks',
      passed: observation.integrity.crossProjectLeakCount === 0,
      safetyCritical: true,
    },
    {
      name: 'no-leaked-resources',
      passed: observation.integrity.leakedResourceCount === 0,
      safetyCritical: true,
    },
    {
      name: 'no-protected-ref-divergence',
      passed: observation.integrity.protectedRefDivergenceCount === 0,
      safetyCritical: true,
    },
    {
      name: 'no-swap',
      passed: observation.resources.swapBytes === 0,
      safetyCritical: true,
    },
    {
      name: 'no-unresolved-journal-bypass',
      passed: observation.integrity.unresolvedJournalBypassCount === 0,
      safetyCritical: true,
    },
    {
      name: 'project-count',
      passed: observation.workload.projects === A_TEST_CAPACITY_PROFILE.projects,
      safetyCritical: true,
    },
    {
      name: 'repository-size-envelope',
      passed: observation.workload.repositoryBytes >= 6 * GIBIBYTE
        && observation.workload.repositoryBytes <= 20 * GIBIBYTE,
      safetyCritical: true,
    },
    {
      name: 'running-git-children',
      passed: observation.resources.peakGitChildren
        === A_TEST_CAPACITY_LIMITS.runningGitChildren,
      safetyCritical: true,
    },
    {
      name: 'admitted-git-requests',
      passed: observation.resources.peakAdmittedGitRequests
        === A_TEST_CAPACITY_LIMITS.admittedGitRequests,
      safetyCritical: true,
    },
    {
      name: 'clone-requests',
      passed: observation.resources.peakCloneRequests
        === A_TEST_CAPACITY_LIMITS.cloneRequests,
      safetyCritical: true,
    },
    {
      name: 'fetch-requests',
      passed: observation.resources.peakFetchRequests
        === A_TEST_CAPACITY_LIMITS.fetchRequests,
      safetyCritical: true,
    },
    {
      name: 'push-requests',
      passed: observation.resources.peakPushRequests
        === A_TEST_CAPACITY_LIMITS.pushRequests,
      safetyCritical: true,
    },
    {
      name: 'control-requests-in-flight',
      passed: observation.resources.peakControlRequests
        === A_TEST_CAPACITY_LIMITS.controlRequestsInFlight,
      safetyCritical: true,
    },
    {
      name: 'ordinary-postgres-transactions',
      passed: observation.resources.peakOrdinaryPostgresTransactions
        === A_TEST_CAPACITY_LIMITS.ordinaryPostgresTransactions,
      safetyCritical: true,
    },
    {
      name: 'pinned-project-lease-connections',
      passed: observation.resources.peakPinnedProjectLeaseConnections
        === A_TEST_CAPACITY_LIMITS.pinnedProjectLeaseConnections,
      safetyCritical: true,
    },
    {
      name: 'reserved-recovery-connections',
      passed: observation.resources.peakReservedRecoveryConnections
        === A_TEST_CAPACITY_LIMITS.reservedRecoveryConnections,
      safetyCritical: true,
    },
    {
      name: 'per-project-git-reads',
      passed: observation.resources.peakPerProjectGitReads
        === A_TEST_CAPACITY_LIMITS.perProjectGitReads,
      safetyCritical: true,
    },
    {
      name: 'per-project-queued-requests',
      passed: observation.resources.peakPerProjectQueuedRequests
        === A_TEST_CAPACITY_LIMITS.perProjectQueuedRequests,
      safetyCritical: true,
    },
    {
      name: 'git-child-resource-observed',
      passed: observation.resources.peakGitChildCpuPercent > 0
        && observation.resources.peakGitChildRssBytes > 0,
      safetyCritical: true,
    },
    {
      name: 'concurrent-publishes',
      passed: observation.resources.peakPublishes
        === A_TEST_CAPACITY_LIMITS.concurrentPublishes,
      safetyCritical: true,
    },
    {
      name: 'concurrent-accepts',
      passed: observation.resources.peakAccepts
        === A_TEST_CAPACITY_LIMITS.concurrentAccepts,
      safetyCritical: true,
    },
    {
      name: 'subscription-count',
      passed: observation.workload.subscriptions === A_TEST_CAPACITY_PROFILE.subscriptions
        && observation.resources.peakSubscriptions === A_TEST_CAPACITY_PROFILE.subscriptions,
      safetyCritical: true,
    },
    {
      name: 'control-p95',
      passed: observation.latency.control.p95Ms <= 250,
      safetyCritical: false,
    },
    {
      name: 'control-p99',
      passed: observation.latency.control.p99Ms <= 1_000,
      safetyCritical: false,
    },
    {
      name: 'database-pool-wait-p95',
      passed: observation.latency.databasePoolWait.p95Ms <= 100,
      safetyCritical: false,
    },
    {
      name: 'event-invalidation-p95',
      passed: observation.latency.eventInvalidation.p95Ms <= 2_000,
      safetyCritical: false,
    },
    {
      name: 'git-queue-wait-p95',
      passed: observation.latency.gitQueueWait.p95Ms <= 5_000,
      safetyCritical: false,
    },
    {
      name: 'ordinary-admission-rejection-rate',
      passed: ordinaryAdmissionRate <= 0.01,
      safetyCritical: false,
    },
    {
      name: 'peak-memory',
      passed: observation.resources.peakMemoryPercent < 75,
      safetyCritical: false,
    },
    {
      name: 'repository-free-reserve',
      passed: observation.resources.minimumRepositoryFreePercent >= 40,
      safetyCritical: false,
    },
    {
      name: 'sustained-cpu',
      passed: observation.resources.sustainedCpuPercent < 70,
      safetyCritical: false,
    },
    {
      name: 'unexpected-5xx-rate',
      passed: unexpected5xxRate < 0.005,
      safetyCritical: false,
    },
  ]);
}

function shardingTriggers(
  observation: CapacityObservation,
  gitQueueThresholdFailed: boolean,
): readonly ShardingTrigger[] {
  const triggers: ShardingTrigger[] = [];
  if (observation.operations.backupDurationMs > observation.operations.backupIntervalMs / 2) {
    triggers.push('backup-window-share');
  }
  if (observation.workload.repositoryBytes / observation.machine.repositoryVolumeBytes >= 0.6) {
    triggers.push('repository-data-share');
  }
  if (observation.operations.restoreDurationMs > observation.operations.restoreObjectiveMs * 0.75) {
    triggers.push('restore-objective-share');
  }
  if (observation.operations.projectGitProcessingThresholdBreachWindows >= 2) {
    triggers.push('single-project-git-processing-share');
  }
  if (observation.operations.projectStorageThresholdBreachWindows >= 2) {
    triggers.push('single-project-storage-share');
  }
  if (gitQueueThresholdFailed && observation.economicalTuningExhausted) {
    triggers.push('git-queue-missed-after-economical-tuning');
  }
  return Object.freeze(triggers.sort());
}

function evaluateCapacity(observation: CapacityObservation): CapacityEvaluation {
  const thresholds = evaluateThresholds(observation);
  const failed = thresholds.filter(threshold => !threshold.passed);
  const safetyFailed = failed.some(threshold => threshold.safetyCritical);
  const tunableThresholdFailed = failed.some(threshold => !threshold.safetyCritical);
  const triggers = shardingTriggers(
    observation,
    failed.some(threshold => threshold.name === 'git-queue-wait-p95'),
  );
  const status = safetyFailed
    || triggers.length > 0
    || (tunableThresholdFailed && observation.economicalTuningExhausted)
    ? 'rejected'
    : tunableThresholdFailed
      ? 'tuning-required'
      : 'accepted';
  return deepFreeze({
    failedThresholds: failed.map(threshold => threshold.name).sort(),
    sharding: {
      decision: triggers.length === 0 ? 'not-recommended' : 'discovery-required',
      triggers,
    },
    status,
  });
}

function invalid(): never {
  throw new Error('capacity-report-invalid');
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) invalid();
  return record;
}

function finiteNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    invalid();
  }
  return value;
}

function safeInteger(value: unknown): number {
  const decoded = finiteNumber(value);
  if (!Number.isSafeInteger(decoded)) invalid();
  return decoded;
}

function percentage(value: unknown): number {
  return finiteNumber(value, 100);
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function exactString<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid();
  return value as T;
}

function digest(value: unknown, length: number): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${String(length)}}$`).test(value)) {
    invalid();
  }
  return value;
}

function instant(value: unknown): string {
  if (typeof value !== 'string') invalid();
  try {
    if (new Date(value).toISOString() !== value) invalid();
  } catch {
    invalid();
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function decodeObservation(input: Record<string, unknown>): CapacityObservation {
  const integrity = exactObject(input['integrity'], [
    'crossProjectLeakCount', 'leakedResourceCount', 'protectedRefDivergenceCount',
    'unresolvedJournalBypassCount',
  ]);
  const latency = exactObject(input['latency'], [
    'control', 'databasePoolWait', 'eventInvalidation', 'gitQueueWait',
  ]);
  const control = exactObject(latency['control'], ['count', 'p95Ms', 'p99Ms']);
  const databasePoolWait = exactObject(latency['databasePoolWait'], ['count', 'p95Ms']);
  const eventInvalidation = exactObject(latency['eventInvalidation'], ['count', 'p95Ms']);
  const gitQueueWait = exactObject(latency['gitQueueWait'], ['count', 'p95Ms']);
  const machine = exactObject(input['machine'], [
    'logicalCpuCount', 'memoryBytes', 'repositoryVolumeBytes', 'storageKind',
  ]);
  const operations = exactObject(input['operations'], [
    'backupDurationMs', 'backupIntervalMs', 'largestProjectGitProcessingPercent',
    'largestProjectStoragePercent', 'projectGitProcessingThresholdBreachWindows',
    'projectGitProcessingWindows', 'projectStorageThresholdBreachWindows',
    'projectStorageWindows', 'restoreDurationMs',
    'restoreObjectiveMs',
  ]);
  const requests = exactObject(input['requests'], [
    'admissionRejected', 'ordinaryAdmissionRejected', 'ordinaryRetryableAdmissionRejected',
    'ordinaryTotal', 'overloadProbeRetryable', 'retryableAdmissionRejected', 'total',
    'unexpected5xx',
  ]);
  const resources = exactObject(input['resources'], [
    'minimumRepositoryFreePercent', 'peakAccepts', 'peakAdmittedGitRequests',
    'peakCloneRequests', 'peakControlRequests', 'peakFetchRequests',
    'peakGitChildCpuPercent', 'peakGitChildRssBytes', 'peakGitChildren',
    'peakMemoryPercent', 'peakOrdinaryPostgresTransactions', 'peakPerProjectGitReads',
    'peakPerProjectQueuedRequests', 'peakPinnedProjectLeaseConnections', 'peakPublishes',
    'peakPushRequests', 'peakReservedRecoveryConnections', 'peakSubscriptions',
    'sustainedCpuPercent', 'swapBytes',
  ]);
  const workload = exactObject(input['workload'], [
    'memberships', 'projects', 'repositoryBytes', 'subscriptions',
  ]);

  const decoded: CapacityObservation = {
    durationMs: safeInteger(input['durationMs']),
    economicalTuningExhausted: boolean(input['economicalTuningExhausted']),
    imageBuild: digest(input['imageBuild'], 40),
    integrity: {
      crossProjectLeakCount: safeInteger(integrity['crossProjectLeakCount']),
      leakedResourceCount: safeInteger(integrity['leakedResourceCount']),
      protectedRefDivergenceCount: safeInteger(integrity['protectedRefDivergenceCount']),
      unresolvedJournalBypassCount: safeInteger(integrity['unresolvedJournalBypassCount']),
    },
    latency: {
      control: {
        count: safeInteger(control['count']),
        p95Ms: finiteNumber(control['p95Ms']),
        p99Ms: finiteNumber(control['p99Ms']),
      },
      databasePoolWait: {
        count: safeInteger(databasePoolWait['count']),
        p95Ms: finiteNumber(databasePoolWait['p95Ms']),
      },
      eventInvalidation: {
        count: safeInteger(eventInvalidation['count']),
        p95Ms: finiteNumber(eventInvalidation['p95Ms']),
      },
      gitQueueWait: {
        count: safeInteger(gitQueueWait['count']),
        p95Ms: finiteNumber(gitQueueWait['p95Ms']),
      },
    },
    machine: {
      logicalCpuCount: safeInteger(machine['logicalCpuCount']),
      memoryBytes: safeInteger(machine['memoryBytes']),
      repositoryVolumeBytes: safeInteger(machine['repositoryVolumeBytes']),
      storageKind: exactString(machine['storageKind'], ['local-ssd']),
    },
    operations: {
      backupDurationMs: safeInteger(operations['backupDurationMs']),
      backupIntervalMs: safeInteger(operations['backupIntervalMs']),
      largestProjectGitProcessingPercent: percentage(operations['largestProjectGitProcessingPercent']),
      largestProjectStoragePercent: percentage(operations['largestProjectStoragePercent']),
      projectGitProcessingThresholdBreachWindows: safeInteger(
        operations['projectGitProcessingThresholdBreachWindows'],
      ),
      projectGitProcessingWindows: safeInteger(operations['projectGitProcessingWindows']),
      projectStorageThresholdBreachWindows: safeInteger(
        operations['projectStorageThresholdBreachWindows'],
      ),
      projectStorageWindows: safeInteger(operations['projectStorageWindows']),
      restoreDurationMs: safeInteger(operations['restoreDurationMs']),
      restoreObjectiveMs: safeInteger(operations['restoreObjectiveMs']),
    },
    profile: exactString(input['profile'], ['a-test']),
    requests: {
      admissionRejected: safeInteger(requests['admissionRejected']),
      ordinaryAdmissionRejected: safeInteger(requests['ordinaryAdmissionRejected']),
      ordinaryRetryableAdmissionRejected: safeInteger(
        requests['ordinaryRetryableAdmissionRejected'],
      ),
      ordinaryTotal: safeInteger(requests['ordinaryTotal']),
      overloadProbeRetryable: boolean(requests['overloadProbeRetryable']),
      retryableAdmissionRejected: safeInteger(requests['retryableAdmissionRejected']),
      total: safeInteger(requests['total']),
      unexpected5xx: safeInteger(requests['unexpected5xx']),
    },
    resources: {
      minimumRepositoryFreePercent: percentage(resources['minimumRepositoryFreePercent']),
      peakAccepts: safeInteger(resources['peakAccepts']),
      peakAdmittedGitRequests: safeInteger(resources['peakAdmittedGitRequests']),
      peakCloneRequests: safeInteger(resources['peakCloneRequests']),
      peakControlRequests: safeInteger(resources['peakControlRequests']),
      peakFetchRequests: safeInteger(resources['peakFetchRequests']),
      peakGitChildCpuPercent: percentage(resources['peakGitChildCpuPercent']),
      peakGitChildRssBytes: safeInteger(resources['peakGitChildRssBytes']),
      peakGitChildren: safeInteger(resources['peakGitChildren']),
      peakMemoryPercent: percentage(resources['peakMemoryPercent']),
      peakOrdinaryPostgresTransactions: safeInteger(
        resources['peakOrdinaryPostgresTransactions'],
      ),
      peakPerProjectGitReads: safeInteger(resources['peakPerProjectGitReads']),
      peakPerProjectQueuedRequests: safeInteger(resources['peakPerProjectQueuedRequests']),
      peakPinnedProjectLeaseConnections: safeInteger(
        resources['peakPinnedProjectLeaseConnections'],
      ),
      peakPublishes: safeInteger(resources['peakPublishes']),
      peakPushRequests: safeInteger(resources['peakPushRequests']),
      peakReservedRecoveryConnections: safeInteger(
        resources['peakReservedRecoveryConnections'],
      ),
      peakSubscriptions: safeInteger(resources['peakSubscriptions']),
      sustainedCpuPercent: percentage(resources['sustainedCpuPercent']),
      swapBytes: safeInteger(resources['swapBytes']),
    },
    scenario: exactString(input['scenario'], ['eight-hour-soak', 'one-hour-mixed']),
    seedSha256: digest(input['seedSha256'], 64),
    startedAt: instant(input['startedAt']),
    workload: {
      memberships: safeInteger(workload['memberships']),
      projects: safeInteger(workload['projects']),
      repositoryBytes: safeInteger(workload['repositoryBytes']),
      subscriptions: safeInteger(workload['subscriptions']),
    },
    workloadSha256: digest(input['workloadSha256'], 64),
  };
  const expectedSampleCounts = decoded.scenario === 'one-hour-mixed'
      ? {
        control: 1_833,
        eventInvalidation: 659,
        gitQueueWait: 791,
        ordinaryRequests: 2_661,
        requests: 2_674,
      }
    : {
        control: 14_433,
        eventInvalidation: 5_223,
        gitQueueWait: 6_195,
        ordinaryRequests: 20_665,
        requests: 20_678,
      };
  if (decoded.durationMs === 0
    || decoded.machine.logicalCpuCount === 0
    || decoded.machine.memoryBytes === 0
    || decoded.machine.repositoryVolumeBytes === 0
    || decoded.latency.control.count === 0
    || decoded.latency.databasePoolWait.count === 0
    || decoded.latency.eventInvalidation.count === 0
    || decoded.latency.gitQueueWait.count === 0
    || decoded.latency.control.count !== expectedSampleCounts.control
    || decoded.latency.databasePoolWait.count !== expectedSampleCounts.control
    || decoded.latency.eventInvalidation.count !== expectedSampleCounts.eventInvalidation
    || decoded.latency.gitQueueWait.count !== expectedSampleCounts.gitQueueWait
    || decoded.operations.backupIntervalMs === 0
    || decoded.operations.restoreObjectiveMs === 0
    || decoded.operations.projectGitProcessingWindows !== 2
    || decoded.operations.projectStorageWindows !== 3
    || decoded.operations.projectGitProcessingThresholdBreachWindows
      > decoded.operations.projectGitProcessingWindows
    || decoded.operations.projectStorageThresholdBreachWindows
      > decoded.operations.projectStorageWindows
    || (decoded.operations.projectGitProcessingThresholdBreachWindows > 0
      && decoded.operations.largestProjectGitProcessingPercent <= 30)
    || (decoded.operations.largestProjectGitProcessingPercent > 30
      && decoded.operations.projectGitProcessingThresholdBreachWindows === 0)
    || (decoded.operations.projectStorageThresholdBreachWindows > 0
      && decoded.operations.largestProjectStoragePercent <= 10)
    || (decoded.operations.largestProjectStoragePercent > 10
      && decoded.operations.projectStorageThresholdBreachWindows === 0)
    || decoded.requests.total === 0
    || decoded.requests.total !== expectedSampleCounts.requests
    || decoded.requests.ordinaryTotal !== expectedSampleCounts.ordinaryRequests
    || decoded.requests.ordinaryTotal === 0
    || decoded.requests.ordinaryTotal > decoded.requests.total
    || decoded.requests.admissionRejected > decoded.requests.total
    || decoded.requests.retryableAdmissionRejected > decoded.requests.admissionRejected
    || decoded.requests.unexpected5xx > decoded.requests.total
    || decoded.requests.admissionRejected + decoded.requests.unexpected5xx
      > decoded.requests.total
    || decoded.requests.ordinaryAdmissionRejected > decoded.requests.ordinaryTotal
    || decoded.requests.ordinaryAdmissionRejected > decoded.requests.admissionRejected
    || decoded.requests.admissionRejected - decoded.requests.ordinaryAdmissionRejected
      > decoded.requests.total - decoded.requests.ordinaryTotal
    || decoded.requests.ordinaryRetryableAdmissionRejected
      > decoded.requests.ordinaryAdmissionRejected
    || decoded.requests.ordinaryRetryableAdmissionRejected
      > decoded.requests.retryableAdmissionRejected
    || (decoded.requests.overloadProbeRetryable
      && decoded.requests.ordinaryRetryableAdmissionRejected === 0)
    || decoded.requests.ordinaryAdmissionRejected
      - decoded.requests.ordinaryRetryableAdmissionRejected
      > decoded.requests.admissionRejected - decoded.requests.retryableAdmissionRejected
    || decoded.latency.control.p95Ms > decoded.latency.control.p99Ms
    || (decoded.scenario === 'one-hour-mixed' && decoded.durationMs !== 60 * 60 * 1_000)
    || (decoded.scenario === 'eight-hour-soak' && decoded.durationMs !== 8 * 60 * 60 * 1_000)) {
    invalid();
  }
  return deepFreeze(decoded);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const OBSERVATION_KEYS = [
  'durationMs', 'economicalTuningExhausted', 'imageBuild', 'integrity', 'latency', 'machine',
  'operations', 'profile', 'requests', 'resources', 'scenario', 'seedSha256', 'startedAt',
  'workload', 'workloadSha256',
] as const;

export function buildCapacityReport(observation: CapacityObservation): CapacityReport {
  const decoded = decodeObservation(exactObject(observation, OBSERVATION_KEYS));
  return deepFreeze({
    ...decoded,
    evaluation: evaluateCapacity(decoded),
    schemaVersion: 1,
  });
}

export function decodeCapacityReport(input: unknown): CapacityReport {
  const report = exactObject(input, [...OBSERVATION_KEYS, 'evaluation', 'schemaVersion']);
  if (report['schemaVersion'] !== 1) invalid();
  const evaluation = exactObject(report['evaluation'], ['failedThresholds', 'sharding', 'status']);
  const sharding = exactObject(evaluation['sharding'], ['decision', 'triggers']);
  if (!Array.isArray(evaluation['failedThresholds']) || !Array.isArray(sharding['triggers'])) {
    invalid();
  }
  exactString(evaluation['status'], ['accepted', 'rejected', 'tuning-required']);
  exactString(sharding['decision'], ['discovery-required', 'not-recommended']);

  const rawObservation = Object.fromEntries(Object.entries(report).filter(
    ([key]) => key !== 'evaluation' && key !== 'schemaVersion',
  ));
  const expected = buildCapacityReport(rawObservation as unknown as CapacityObservation);
  if (!sameJson(expected.evaluation, evaluation)) invalid();
  return expected;
}

export function serializeCapacityReport(report: CapacityReport): string {
  return JSON.stringify(decodeCapacityReport(report));
}
