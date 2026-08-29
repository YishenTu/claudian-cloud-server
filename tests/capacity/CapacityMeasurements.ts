import {
  buildCapacityReport,
  type CapacityReport,
} from './CapacityReport.js';
import {
  emitsCapacityProjectInvalidation,
  isCapacityControlOperation,
  isCapacityGitOperation,
  isCapacityOperationEvent,
  isIssuedCapacityWorkload,
  type CapacityRequestOutcome,
  type CapacityTrafficClass,
  type CapacityWorkload,
  type CapacityWorkloadEvent,
} from './CapacityWorkload.js';
import {
  isCapacityRunCompletionForWorkload,
  isCapacityResourceObservationForEvent,
  type CapacityResourceObservation,
  type CapacityRunCompletion,
} from './CapacityWorkloadRunner.js';

export type CapacityIntegrityFailure =
  | 'cross-project-leak'
  | 'leaked-resource'
  | 'protected-ref-divergence'
  | 'unresolved-journal-bypass';

export interface CapacityMeasurementsOptions {
  readonly backupIntervalMs: number;
  readonly economicalTuningExhausted: boolean;
  readonly imageBuild: string;
  readonly machine: {
    readonly logicalCpuCount: number;
    readonly memoryBytes: number;
    readonly repositoryVolumeBytes: number;
    readonly storageKind: 'local-ssd';
  };
  readonly restoreObjectiveMs: number;
  readonly startedAt: string;
  readonly workload: CapacityWorkload;
}

export interface CapacityResourceSample {
  readonly accepts: number;
  readonly admittedGitRequests: number;
  readonly atMs: number;
  readonly cloneRequests: number;
  readonly controlRequests: number;
  readonly fetchRequests: number;
  readonly gitChildCpuPercent: number;
  readonly gitChildRssBytes: number;
  readonly gitChildren: number;
  readonly eventSequence: number;
  readonly memoryPercent: number;
  readonly ordinaryPostgresTransactions: number;
  readonly perProjectGitReads: number;
  readonly perProjectQueuedRequests: number;
  readonly pinnedProjectLeaseConnections: number;
  readonly publishes: number;
  readonly pushRequests: number;
  readonly repositoryFreePercent: number;
  readonly reservedRecoveryConnections: number;
  readonly rollingFifteenMinuteCpuPercent: number;
  readonly subscriptions: number;
  readonly swapBytes: number;
}

interface ProjectGitProcessing {
  readonly gitProcessingMsInWindow: number;
}

interface ProjectStorage {
  readonly storageBytes: number;
}

interface RequestMeasurement {
  readonly controlLatencyMs: number | null;
  readonly overloadProbe: boolean;
  readonly outcome: CapacityRequestOutcome;
  readonly trafficClass: CapacityTrafficClass;
}

function invalid(): never {
  throw new Error('capacity-measurement-invalid');
}

function finiteNumber(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) invalid();
  return value;
}

function safeInteger(value: number): number {
  finiteNumber(value);
  if (!Number.isSafeInteger(value)) invalid();
  return value;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) invalid();
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index] ?? invalid();
}

function maximum(values: readonly number[]): number {
  if (values.length === 0) invalid();
  return Math.max(...values);
}

function minimum(values: readonly number[]): number {
  if (values.length === 0) invalid();
  return Math.min(...values);
}

function share(value: number, total: number): number {
  return total === 0 ? 0 : (value / total) * 100;
}

function expectedResourceSampleEvents(
  workload: CapacityWorkload,
): readonly CapacityWorkloadEvent[] {
  const intervalMs = safeInteger(workload.measurement.resourceSampleIntervalMs);
  if (intervalMs === 0 || workload.durationMs % intervalMs !== 0) invalid();
  const expectedTimes = Array.from(
    { length: workload.durationMs / intervalMs + 1 },
    (_, index) => index * intervalMs,
  );
  const events = workload.events.filter(event => event.kind === 'resource-sample');
  if (events.length !== expectedTimes.length || events.some((event, index) => (
    event.atMs !== expectedTimes[index]
  ))) invalid();
  return Object.freeze(events);
}

export class CapacityMeasurements {
  readonly #backupDurations: number[] = [];
  readonly #databasePoolWaits = new Map<number, number>();
  readonly #eventInvalidationLatencies = new Map<number, number>();
  readonly #eventsBySequence = new Map<number, CapacityWorkload['events'][number]>();
  readonly #gitQueueWaits = new Map<string, number>();
  readonly #integrity = {
    crossProjectLeakCount: 0,
    leakedResourceCount: 0,
    protectedRefDivergenceCount: 0,
    unresolvedJournalBypassCount: 0,
  };
  readonly #options: CapacityMeasurementsOptions;
  readonly #projectGitProcessing = new Map<number, Map<string, ProjectGitProcessing>>();
  readonly #projectStorage = new Map<number, Map<string, ProjectStorage>>();
  readonly #requestMeasurements = new Map<number, RequestMeasurement>();
  readonly #resourceSamples = new Map<number, CapacityResourceSample>();
  readonly #restoreDurations: number[] = [];
  #runCompletion: CapacityRunCompletion | undefined;

  constructor(options: CapacityMeasurementsOptions) {
    if (!isIssuedCapacityWorkload(options.workload)) invalid();
    this.#options = options;
    for (const event of options.workload.events) {
      if (this.#eventsBySequence.has(event.sequence)) invalid();
      this.#eventsBySequence.set(event.sequence, event);
    }
  }

  recordRequest(input: {
    readonly controlLatencyMs: number | null;
    readonly eventSequence: number;
    readonly outcome: CapacityRequestOutcome;
    readonly trafficClass: CapacityTrafficClass;
  }): void {
    if (!(['nonretryable-overload', 'retryable-overload', 'success', 'unexpected-5xx'] as const)
      .includes(input.outcome)
      || !(['fault-injection', 'maintenance', 'ordinary'] as const)
        .includes(input.trafficClass)) {
      invalid();
    }
    const eventSequence = safeInteger(input.eventSequence);
    const event = this.#eventsBySequence.get(eventSequence);
    if (event === undefined
      || !isCapacityOperationEvent(event)
      || input.trafficClass !== event.trafficClass
      || this.#requestMeasurements.has(eventSequence)
      || (isCapacityControlOperation(event) && input.controlLatencyMs === null)
      || (!isCapacityControlOperation(event) && input.controlLatencyMs !== null)) {
      invalid();
    }
    this.#requestMeasurements.set(eventSequence, Object.freeze({
      controlLatencyMs: input.controlLatencyMs === null
        ? null
        : finiteNumber(input.controlLatencyMs),
      overloadProbe: event.overloadProbe,
      outcome: input.outcome,
      trafficClass: input.trafficClass,
    }));
  }

  recordDatabasePoolWait(input: {
    readonly durationMs: number;
    readonly eventSequence: number;
  }): void {
    this.#recordSequenceSample(input, this.#databasePoolWaits, isCapacityControlOperation);
  }

  recordEventInvalidation(input: {
    readonly durationMs: number;
    readonly eventSequence: number;
  }): void {
    this.#recordSequenceSample(
      input,
      this.#eventInvalidationLatencies,
      emitsCapacityProjectInvalidation,
    );
  }

  recordGitQueueWait(input: {
    readonly childOrdinal: number;
    readonly durationMs: number;
    readonly eventSequence: number;
  }): void {
    const eventSequence = safeInteger(input.eventSequence);
    const childOrdinal = safeInteger(input.childOrdinal);
    const event = this.#eventsBySequence.get(eventSequence);
    const key = `${String(eventSequence)}:${String(childOrdinal)}`;
    if (event === undefined
      || !isCapacityOperationEvent(event)
      || !isCapacityGitOperation(event)
      || childOrdinal >= event.gitChildCount
      || this.#gitQueueWaits.has(key)) invalid();
    this.#gitQueueWaits.set(key, finiteNumber(input.durationMs));
  }

  #recordSequenceSample(
    input: { readonly durationMs: number; readonly eventSequence: number },
    target: Map<number, number>,
    accepts: (event: CapacityWorkloadEvent) => boolean,
  ): void {
    const eventSequence = safeInteger(input.eventSequence);
    const event = this.#eventsBySequence.get(eventSequence);
    if (event === undefined || !accepts(event) || target.has(eventSequence)) invalid();
    target.set(eventSequence, finiteNumber(input.durationMs));
  }

  recordResourceSample(
    sample: CapacityResourceSample,
    observation: CapacityResourceObservation,
  ): void {
    const eventSequence = safeInteger(sample.eventSequence);
    const atMs = safeInteger(sample.atMs);
    const event = this.#eventsBySequence.get(eventSequence);
    if (event?.kind !== 'resource-sample'
      || event.atMs !== atMs
      || !isCapacityResourceObservationForEvent(
        observation,
        this.#options.workload,
        eventSequence,
      )
      || this.#resourceSamples.has(eventSequence)) invalid();
    const decoded = Object.freeze({
      accepts: safeInteger(sample.accepts),
      admittedGitRequests: safeInteger(sample.admittedGitRequests),
      atMs,
      cloneRequests: safeInteger(sample.cloneRequests),
      controlRequests: safeInteger(sample.controlRequests),
      fetchRequests: safeInteger(sample.fetchRequests),
      gitChildCpuPercent: finiteNumber(sample.gitChildCpuPercent, 100),
      gitChildRssBytes: safeInteger(sample.gitChildRssBytes),
      gitChildren: safeInteger(sample.gitChildren),
      eventSequence,
      memoryPercent: finiteNumber(sample.memoryPercent, 100),
      ordinaryPostgresTransactions: safeInteger(sample.ordinaryPostgresTransactions),
      perProjectGitReads: safeInteger(sample.perProjectGitReads),
      perProjectQueuedRequests: safeInteger(sample.perProjectQueuedRequests),
      pinnedProjectLeaseConnections: safeInteger(sample.pinnedProjectLeaseConnections),
      publishes: safeInteger(sample.publishes),
      pushRequests: safeInteger(sample.pushRequests),
      repositoryFreePercent: finiteNumber(sample.repositoryFreePercent, 100),
      reservedRecoveryConnections: safeInteger(sample.reservedRecoveryConnections),
      rollingFifteenMinuteCpuPercent: finiteNumber(
        sample.rollingFifteenMinuteCpuPercent,
        100,
      ),
      subscriptions: safeInteger(sample.subscriptions),
      swapBytes: safeInteger(sample.swapBytes),
    });
    if (decoded.accepts !== observation.accepts
      || decoded.admittedGitRequests !== observation.admittedGitRequests
      || decoded.atMs !== observation.atMs
      || decoded.cloneRequests !== observation.cloneRequests
      || decoded.controlRequests !== observation.controlRequests
      || decoded.eventSequence !== observation.eventSequence
      || decoded.fetchRequests !== observation.fetchRequests
      || decoded.gitChildren !== observation.gitChildren
      || decoded.ordinaryPostgresTransactions
        !== observation.ordinaryPostgresTransactions
      || decoded.perProjectGitReads !== observation.perProjectGitReads
      || decoded.perProjectQueuedRequests !== observation.perProjectQueuedRequests
      || decoded.pinnedProjectLeaseConnections
        !== observation.pinnedProjectLeaseConnections
      || decoded.publishes !== observation.publishes
      || decoded.pushRequests !== observation.pushRequests
      || decoded.reservedRecoveryConnections !== observation.reservedRecoveryConnections
      || decoded.subscriptions !== observation.subscriptions) invalid();
    const limits = this.#options.workload.limits;
    if (decoded.accepts > limits.concurrentAccepts
      || decoded.admittedGitRequests > limits.admittedGitRequests
      || decoded.cloneRequests > limits.cloneRequests
      || decoded.controlRequests > limits.controlRequestsInFlight
      || decoded.fetchRequests > limits.fetchRequests
      || decoded.gitChildren > limits.runningGitChildren
      || decoded.ordinaryPostgresTransactions > limits.ordinaryPostgresTransactions
      || decoded.perProjectGitReads > limits.perProjectGitReads
      || decoded.perProjectQueuedRequests > limits.perProjectQueuedRequests
      || decoded.pinnedProjectLeaseConnections > limits.pinnedProjectLeaseConnections
      || decoded.publishes > limits.concurrentPublishes
      || decoded.pushRequests > limits.pushRequests
      || decoded.reservedRecoveryConnections > limits.reservedRecoveryConnections
      || decoded.subscriptions > this.#options.workload.subscribedProjectOrdinals.length
      || decoded.cloneRequests + decoded.fetchRequests + decoded.pushRequests
        !== decoded.admittedGitRequests
      || decoded.gitChildren > decoded.admittedGitRequests
      || decoded.perProjectGitReads > decoded.cloneRequests + decoded.fetchRequests
      || decoded.perProjectQueuedRequests
        > decoded.admittedGitRequests - decoded.gitChildren
      || (decoded.gitChildren > 0
        && (decoded.gitChildCpuPercent === 0 || decoded.gitChildRssBytes === 0))
      || (decoded.gitChildren === 0
        && (decoded.gitChildCpuPercent !== 0 || decoded.gitChildRssBytes !== 0))) invalid();
    if (event.probeKind === 'capacity-envelope' && (
      decoded.accepts !== limits.concurrentAccepts
      || decoded.admittedGitRequests !== limits.admittedGitRequests
      || decoded.cloneRequests !== limits.cloneRequests
      || decoded.controlRequests !== limits.controlRequestsInFlight
      || decoded.fetchRequests !== limits.fetchRequests
      || decoded.gitChildren !== limits.runningGitChildren
      || decoded.ordinaryPostgresTransactions !== limits.ordinaryPostgresTransactions
      || decoded.perProjectGitReads !== limits.perProjectGitReads
      || decoded.perProjectQueuedRequests !== limits.perProjectQueuedRequests
      || decoded.pinnedProjectLeaseConnections !== limits.pinnedProjectLeaseConnections
      || decoded.publishes !== limits.concurrentPublishes
      || decoded.pushRequests !== limits.pushRequests
      || decoded.reservedRecoveryConnections !== limits.reservedRecoveryConnections
    )) invalid();
    if (event.probeKind === 'subscription-storm'
      && decoded.subscriptions
        !== this.#options.workload.subscribedProjectOrdinals.length) invalid();
    this.#resourceSamples.set(eventSequence, decoded);
  }

  recordBackupDuration(durationMs: number): void {
    this.#backupDurations.push(safeInteger(durationMs));
  }

  recordRestoreDuration(durationMs: number): void {
    this.#restoreDurations.push(safeInteger(durationMs));
  }

  recordProjectGitProcessingWindow(input: {
    readonly endAtMs: number;
    readonly gitProcessingMsInWindow: number;
    readonly opaqueProjectId: string;
  }): void {
    const endAtMs = safeInteger(input.endAtMs);
    if (!this.#options.workload.measurement.projectGitProcessingWindowEndAtMs.includes(endAtMs)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.opaqueProjectId)) {
      invalid();
    }
    const window = this.#projectGitProcessing.get(endAtMs)
      ?? new Map<string, ProjectGitProcessing>();
    if (window.has(input.opaqueProjectId)) invalid();
    window.set(input.opaqueProjectId, Object.freeze({
      gitProcessingMsInWindow: finiteNumber(input.gitProcessingMsInWindow),
    }));
    this.#projectGitProcessing.set(endAtMs, window);
  }

  recordProjectStorageSnapshot(input: {
    readonly atMs: number;
    readonly opaqueProjectId: string;
    readonly storageBytes: number;
  }): void {
    const atMs = safeInteger(input.atMs);
    if (!this.#options.workload.measurement.projectStorageSnapshotAtMs.includes(atMs)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.opaqueProjectId)) {
      invalid();
    }
    const snapshot = this.#projectStorage.get(atMs) ?? new Map<string, ProjectStorage>();
    if (snapshot.has(input.opaqueProjectId)) invalid();
    snapshot.set(input.opaqueProjectId, Object.freeze({
      storageBytes: safeInteger(input.storageBytes),
    }));
    this.#projectStorage.set(atMs, snapshot);
  }

  recordRunCompletion(completion: CapacityRunCompletion): void {
    if (this.#runCompletion !== undefined
      || !isCapacityRunCompletionForWorkload(completion, this.#options.workload)) {
      invalid();
    }
    this.#runCompletion = Object.freeze({ ...completion });
  }

  recordIntegrityFailure(failure: CapacityIntegrityFailure): void {
    switch (failure) {
      case 'cross-project-leak':
        this.#integrity.crossProjectLeakCount += 1;
        break;
      case 'leaked-resource':
        this.#integrity.leakedResourceCount += 1;
        break;
      case 'protected-ref-divergence':
        this.#integrity.protectedRefDivergenceCount += 1;
        break;
      case 'unresolved-journal-bypass':
        this.#integrity.unresolvedJournalBypassCount += 1;
        break;
      default:
        invalid();
    }
  }

  buildReport(): CapacityReport {
    const expectedSampleEvents = expectedResourceSampleEvents(this.#options.workload);
    const requestEvents = this.#options.workload.events.filter(isCapacityOperationEvent);
    const controlEvents = requestEvents.filter(isCapacityControlOperation);
    const invalidationEvents = requestEvents.filter(emitsCapacityProjectInvalidation);
    const gitEvents = requestEvents.filter(isCapacityGitOperation);
    const expectedGitChildCount = gitEvents.reduce(
      (total, event) => total + event.gitChildCount,
      0,
    );
    if (this.#requestMeasurements.size !== requestEvents.length
      || this.#databasePoolWaits.size !== controlEvents.length
      || this.#eventInvalidationLatencies.size !== invalidationEvents.length
      || this.#gitQueueWaits.size !== expectedGitChildCount
      || this.#resourceSamples.size !== expectedSampleEvents.length
      || this.#backupDurations.length === 0
      || this.#restoreDurations.length === 0
      || this.#runCompletion === undefined) invalid();
    for (const event of requestEvents) {
      if (!this.#requestMeasurements.has(event.sequence)) invalid();
    }
    for (const event of controlEvents) {
      if (!this.#databasePoolWaits.has(event.sequence)) invalid();
    }
    for (const event of invalidationEvents) {
      if (!this.#eventInvalidationLatencies.has(event.sequence)) invalid();
    }
    for (const event of gitEvents) {
      for (let childOrdinal = 0; childOrdinal < event.gitChildCount; childOrdinal += 1) {
        if (!this.#gitQueueWaits.has(`${String(event.sequence)}:${String(childOrdinal)}`)) {
          invalid();
        }
      }
    }
    for (const event of expectedSampleEvents) {
      if (!this.#resourceSamples.has(event.sequence)) invalid();
    }

    const gitWindows: Array<readonly ProjectGitProcessing[]> = [];
    for (const endAtMs of (
      this.#options.workload.measurement.projectGitProcessingWindowEndAtMs
    )) {
      const window = this.#projectGitProcessing.get(endAtMs);
      if (window === undefined || window.size !== this.#options.workload.projects.length) invalid();
      const ordered: ProjectGitProcessing[] = [];
      for (const project of this.#options.workload.projects) {
        const utilization = window.get(project.opaqueProjectId);
        if (utilization === undefined) invalid();
        ordered.push(utilization);
      }
      gitWindows.push(Object.freeze(ordered));
    }
    if (this.#projectGitProcessing.size !== gitWindows.length) invalid();

    const storageSnapshots: Array<readonly ProjectStorage[]> = [];
    for (const atMs of this.#options.workload.measurement.projectStorageSnapshotAtMs) {
      const snapshot = this.#projectStorage.get(atMs);
      if (snapshot === undefined
        || snapshot.size !== this.#options.workload.projects.length) invalid();
      const ordered: ProjectStorage[] = [];
      for (const project of this.#options.workload.projects) {
        const storage = snapshot.get(project.opaqueProjectId);
        if (storage === undefined) invalid();
        ordered.push(storage);
      }
      storageSnapshots.push(Object.freeze(ordered));
    }
    if (this.#projectStorage.size !== storageSnapshots.length) invalid();

    const storageBreachCounts = this.#options.workload.projects.map(() => 0);
    const gitBreachCounts = this.#options.workload.projects.map(() => 0);
    let largestProjectStoragePercent = 0;
    let largestProjectGitProcessingPercent = 0;
    let repositoryBytes = 0;
    for (const snapshot of storageSnapshots) {
      const storageTotal = snapshot.reduce((total, value) => total + value.storageBytes, 0);
      repositoryBytes = Math.max(repositoryBytes, storageTotal);
      snapshot.forEach((value, index) => {
        const storagePercent = share(value.storageBytes, storageTotal);
        largestProjectStoragePercent = Math.max(largestProjectStoragePercent, storagePercent);
        if (storagePercent > 10) {
          storageBreachCounts[index] = (storageBreachCounts[index] ?? 0) + 1;
        }
      });
    }
    for (const window of gitWindows) {
      const gitTotal = window.reduce(
        (total, value) => total + value.gitProcessingMsInWindow,
        0,
      );
      window.forEach((value, index) => {
        const gitPercent = share(value.gitProcessingMsInWindow, gitTotal);
        largestProjectGitProcessingPercent = Math.max(
          largestProjectGitProcessingPercent,
          gitPercent,
        );
        if (gitPercent > 30) gitBreachCounts[index] = (gitBreachCounts[index] ?? 0) + 1;
      });
    }

    const requestMeasurements = [...this.#requestMeasurements.values()];
    const overloadProbes = requestMeasurements.filter(measurement => (
      measurement.overloadProbe
    ));
    if (overloadProbes.length !== 1) invalid();
    const overloadProbe = overloadProbes[0] ?? invalid();
    const controlLatencies = requestMeasurements.flatMap(measurement => (
      measurement.controlLatencyMs === null ? [] : [measurement.controlLatencyMs]
    ));
    const admissionRejected = requestMeasurements.filter(({ outcome }) => (
      outcome === 'nonretryable-overload' || outcome === 'retryable-overload'
    )).length;
    const retryableAdmissionRejected = requestMeasurements.filter(({ outcome }) => (
      outcome === 'retryable-overload'
    )).length;
    const ordinary = requestMeasurements.filter(({ trafficClass }) => (
      trafficClass === 'ordinary'
    ));
    const ordinaryAdmissionRejected = ordinary.filter(({ outcome }) => (
      outcome === 'nonretryable-overload' || outcome === 'retryable-overload'
    )).length;
    const resourceSamples = [...this.#resourceSamples.values()];
    const rollingCpuSamples = resourceSamples.filter(sample => sample.atMs >= 15 * 60 * 1_000);

    return buildCapacityReport({
      durationMs: this.#options.workload.durationMs,
      economicalTuningExhausted: this.#options.economicalTuningExhausted,
      imageBuild: this.#options.imageBuild,
      integrity: { ...this.#integrity },
      latency: {
        control: {
          count: controlLatencies.length,
          p95Ms: percentile(controlLatencies, 0.95),
          p99Ms: percentile(controlLatencies, 0.99),
        },
        databasePoolWait: {
          count: this.#databasePoolWaits.size,
          p95Ms: percentile([...this.#databasePoolWaits.values()], 0.95),
        },
        eventInvalidation: {
          count: this.#eventInvalidationLatencies.size,
          p95Ms: percentile([...this.#eventInvalidationLatencies.values()], 0.95),
        },
        gitQueueWait: {
          count: this.#gitQueueWaits.size,
          p95Ms: percentile([...this.#gitQueueWaits.values()], 0.95),
        },
      },
      machine: { ...this.#options.machine },
      operations: {
        backupDurationMs: maximum(this.#backupDurations),
        backupIntervalMs: safeInteger(this.#options.backupIntervalMs),
        largestProjectGitProcessingPercent,
        largestProjectStoragePercent,
        projectGitProcessingThresholdBreachWindows: maximum(gitBreachCounts),
        projectGitProcessingWindows: gitWindows.length,
        projectStorageThresholdBreachWindows: maximum(storageBreachCounts),
        projectStorageWindows: storageSnapshots.length,
        restoreDurationMs: maximum(this.#restoreDurations),
        restoreObjectiveMs: safeInteger(this.#options.restoreObjectiveMs),
      },
      profile: this.#options.workload.profile,
      requests: {
        admissionRejected,
        overloadProbeRetryable: overloadProbe.outcome === 'retryable-overload',
        ordinaryAdmissionRejected,
        ordinaryRetryableAdmissionRejected: ordinary.filter(({ outcome }) => (
          outcome === 'retryable-overload'
        )).length,
        ordinaryTotal: ordinary.length,
        retryableAdmissionRejected,
        total: requestMeasurements.length,
        unexpected5xx: requestMeasurements.filter(({ outcome }) => (
          outcome === 'unexpected-5xx'
        )).length,
      },
      resources: {
        minimumRepositoryFreePercent: minimum(resourceSamples.map(
          sample => sample.repositoryFreePercent,
        )),
        peakAccepts: maximum(resourceSamples.map(sample => sample.accepts)),
        peakAdmittedGitRequests: maximum(resourceSamples.map(
          sample => sample.admittedGitRequests,
        )),
        peakCloneRequests: maximum(resourceSamples.map(sample => sample.cloneRequests)),
        peakControlRequests: maximum(resourceSamples.map(sample => sample.controlRequests)),
        peakFetchRequests: maximum(resourceSamples.map(sample => sample.fetchRequests)),
        peakGitChildCpuPercent: maximum(resourceSamples.map(
          sample => sample.gitChildCpuPercent,
        )),
        peakGitChildRssBytes: maximum(resourceSamples.map(
          sample => sample.gitChildRssBytes,
        )),
        peakGitChildren: maximum(resourceSamples.map(sample => sample.gitChildren)),
        peakMemoryPercent: maximum(resourceSamples.map(sample => sample.memoryPercent)),
        peakOrdinaryPostgresTransactions: maximum(resourceSamples.map(
          sample => sample.ordinaryPostgresTransactions,
        )),
        peakPerProjectGitReads: maximum(resourceSamples.map(
          sample => sample.perProjectGitReads,
        )),
        peakPerProjectQueuedRequests: maximum(resourceSamples.map(
          sample => sample.perProjectQueuedRequests,
        )),
        peakPinnedProjectLeaseConnections: maximum(resourceSamples.map(
          sample => sample.pinnedProjectLeaseConnections,
        )),
        peakPublishes: maximum(resourceSamples.map(sample => sample.publishes)),
        peakPushRequests: maximum(resourceSamples.map(sample => sample.pushRequests)),
        peakReservedRecoveryConnections: maximum(resourceSamples.map(
          sample => sample.reservedRecoveryConnections,
        )),
        peakSubscriptions: maximum(resourceSamples.map(sample => sample.subscriptions)),
        sustainedCpuPercent: maximum(rollingCpuSamples.map(
          sample => sample.rollingFifteenMinuteCpuPercent,
        )),
        swapBytes: maximum(resourceSamples.map(sample => sample.swapBytes)),
      },
      scenario: this.#options.workload.scenario,
      seedSha256: this.#options.workload.seedSha256,
      startedAt: this.#options.startedAt,
      workload: {
        memberships: this.#options.workload.projects.reduce(
          (total, project) => total + project.membershipCount,
          0,
        ),
        projects: this.#options.workload.projects.length,
        repositoryBytes,
        subscriptions: this.#options.workload.subscribedProjectOrdinals.length,
      },
      workloadSha256: this.#runCompletion.workloadSha256,
    });
  }
}
