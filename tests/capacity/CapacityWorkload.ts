import { createHash } from 'node:crypto';

export type CapacityScenario = 'eight-hour-soak' | 'one-hour-mixed';

export const A_TEST_CAPACITY_PROFILE = Object.freeze({
  accounts: 80,
  accepts: 1,
  memberships: 240,
  profile: 'a-test' as const,
  projects: 100,
  publishes: 2,
  runningGitChildren: 2,
  subscriptions: 50,
});

export const A_TEST_CAPACITY_LIMITS = Object.freeze({
  admittedGitRequests: 6,
  cloneRequests: 1,
  concurrentAccepts: A_TEST_CAPACITY_PROFILE.accepts,
  concurrentPublishes: A_TEST_CAPACITY_PROFILE.publishes,
  controlRequestsInFlight: 32,
  fetchRequests: 3,
  ordinaryPostgresTransactions: 8,
  perProjectGitReads: 2,
  perProjectQueuedRequests: 4,
  pinnedProjectLeaseConnections: 2,
  pushRequests: 2,
  reservedRecoveryConnections: 2,
  runningGitChildren: A_TEST_CAPACITY_PROFILE.runningGitChildren,
});

export interface CapacityAccountSeed {
  readonly opaqueAccountId: string;
  readonly ordinal: number;
}

export interface CapacityProjectSeed {
  readonly memberAccountOrdinals: readonly number[];
  readonly membershipCount: number;
  readonly opaqueProjectId: string;
  readonly ordinal: number;
  readonly repositoryBytes: number;
}

interface CapacityEventBase {
  readonly atMs: number;
  readonly projectOrdinal: number;
  readonly sequence: number;
}

export type CapacityTrafficClass = 'fault-injection' | 'maintenance' | 'ordinary';

export type CapacityRequestOutcome =
  | 'nonretryable-overload'
  | 'retryable-overload'
  | 'success'
  | 'unexpected-5xx';

export interface CapacityResourceClaims {
  readonly accepts?: number;
  readonly admittedGitRequests?: number;
  readonly cloneRequests?: number;
  readonly controlRequests?: number;
  readonly fetchRequests?: number;
  readonly gitChildren?: number;
  readonly ordinaryPostgresTransactions?: number;
  readonly perProjectGitReads?: number;
  readonly perProjectQueuedRequests?: number;
  readonly pinnedProjectLeaseConnections?: number;
  readonly publishes?: number;
  readonly pushRequests?: number;
  readonly reservedRecoveryConnections?: number;
  readonly subscriptions?: number;
}

export interface CapacityOperationEvent extends CapacityEventBase {
  readonly kind:
    | 'accept'
    | 'backup'
    | 'cloud-to-lan-transfer'
    | 'control-read'
    | 'control-write'
    | 'git-clone'
    | 'git-fetch'
    | 'git-push'
    | 'lan-to-cloud-transfer'
    | 'publish'
    | 'recovery-verification'
    | 'reconnect';
  readonly gitChildCount: number;
  readonly overloadProbe: boolean;
  readonly resourceClaims: CapacityResourceClaims | null;
  readonly trafficClass: CapacityTrafficClass;
}

export interface CapacityRestartEvent extends CapacityEventBase {
  readonly interruptedSequence: number;
  readonly interruptedKind:
    | 'backup'
    | 'cloud-to-lan-transfer'
    | 'lan-to-cloud-transfer'
    | 'git-push'
    | 'publish'
    | 'accept';
  readonly kind: 'process-restart';
  readonly trafficClass: 'fault-injection';
}

export interface CapacityResourceSampleEvent extends CapacityEventBase {
  readonly ceilingProbeSequences: readonly number[];
  readonly kind: 'resource-sample';
  readonly probeKind: 'capacity-envelope' | 'subscription-storm' | null;
}

export type CapacityWorkloadEvent =
  | CapacityOperationEvent
  | CapacityResourceSampleEvent
  | CapacityRestartEvent;

export function isCapacityOperationEvent(
  event: CapacityWorkloadEvent,
): event is CapacityOperationEvent {
  return event.kind !== 'process-restart' && event.kind !== 'resource-sample';
}

export function isCapacityControlOperation(event: CapacityWorkloadEvent): boolean {
  return event.kind === 'control-read' || event.kind === 'control-write';
}

export function isCapacityGitOperation(event: CapacityWorkloadEvent): boolean {
  return isCapacityOperationEvent(event) && event.gitChildCount > 0;
}

export function emitsCapacityProjectInvalidation(event: CapacityWorkloadEvent): boolean {
  return event.kind === 'accept'
    || event.kind === 'cloud-to-lan-transfer'
    || event.kind === 'control-write'
    || event.kind === 'git-push'
    || event.kind === 'lan-to-cloud-transfer'
    || event.kind === 'publish';
}

export interface CapacityWorkload {
  readonly accounts: readonly CapacityAccountSeed[];
  readonly durationMs: number;
  readonly events: readonly CapacityWorkloadEvent[];
  readonly limits: typeof A_TEST_CAPACITY_LIMITS;
  readonly measurement: {
    readonly projectGitProcessingWindowEndAtMs: readonly number[];
    readonly projectStorageSnapshotAtMs: readonly number[];
    readonly resourceSampleIntervalMs: number;
  };
  readonly profile: 'a-test';
  readonly projects: readonly CapacityProjectSeed[];
  readonly scenario: CapacityScenario;
  readonly seedSha256: string;
  readonly subscribedProjectOrdinals: readonly number[];
}

export interface CreateCapacityWorkloadOptions {
  readonly scenario: CapacityScenario;
  readonly seed: string;
}

const issuedCapacityWorkloads = new WeakSet<CapacityWorkload>();

export function isIssuedCapacityWorkload(workload: CapacityWorkload): boolean {
  return issuedCapacityWorkloads.has(workload);
}

const MEBIBYTE = 1024 ** 2;
const ONE_HOUR_MS = 60 * 60 * 1_000;
const EIGHT_HOURS_MS = 8 * ONE_HOUR_MS;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

class DeterministicRandom {
  readonly #words: Uint32Array;
  #offset = 0;

  constructor(seedSha256: string) {
    this.#words = Uint32Array.from(
      Array.from({ length: 8 }, (_, index) => (
        Number.parseInt(seedSha256.slice(index * 8, (index + 1) * 8), 16)
      )),
    );
  }

  next(): number {
    const index = this.#offset % this.#words.length;
    const current = this.#words[index] ?? 0;
    const mixed = Math.imul(current ^ (this.#offset + 1), 0x9e3779b1) >>> 0;
    this.#words[index] = (
      ((mixed ^ (mixed << 13)) >>> 0)
      ^ (mixed >>> 17)
      ^ ((mixed << 5) >>> 0)
    ) >>> 0;
    this.#offset += 1;
    return (this.#words[index] ?? 0) / 0x1_0000_0000;
  }

  integer(upperExclusive: number): number {
    return Math.floor(this.next() * upperExclusive);
  }
}

function shuffled<T>(values: readonly T[], random: DeterministicRandom): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integer(index + 1);
    const current = result[index];
    const swapped = result[swapIndex];
    if (current === undefined || swapped === undefined) {
      throw new Error('capacity-workload-invalid');
    }
    result[index] = swapped;
    result[swapIndex] = current;
  }
  return result;
}

function createProjects(
  seedSha256: string,
  random: DeterministicRandom,
): readonly CapacityProjectSeed[] {
  const memberships = shuffled([
    ...Array.from({ length: 40 }, () => 3),
    ...Array.from({ length: 60 }, () => 2),
  ], random);
  const repositoryBytes = shuffled([
    ...Array.from({ length: 60 }, () => 64 * MEBIBYTE),
    ...Array.from({ length: 30 }, () => 160 * MEBIBYTE),
    ...Array.from({ length: 8 }, () => 320 * MEBIBYTE),
    ...Array.from({ length: 2 }, () => 640 * MEBIBYTE),
  ], random);
  const accountOrdinals = shuffled(
    Array.from({ length: A_TEST_CAPACITY_PROFILE.accounts }, (_, ordinal) => ordinal),
    random,
  );

  return Object.freeze(Array.from(
    { length: A_TEST_CAPACITY_PROFILE.projects },
    (_, ordinal) => {
      const membershipCount = memberships[ordinal] ?? 0;
      const indexes = [ordinal, ordinal + 29, ordinal + 53];
      const memberAccountOrdinals = Object.freeze(indexes
        .slice(0, membershipCount)
        .map(index => accountOrdinals[index % accountOrdinals.length] ?? invalidWorkload()));
      return Object.freeze({
        memberAccountOrdinals,
        membershipCount,
        opaqueProjectId: `project_${sha256(`${seedSha256}:${String(ordinal)}`).slice(0, 32)}`,
        ordinal,
        repositoryBytes: repositoryBytes[ordinal] ?? 0,
      });
    },
  ));
}

function invalidWorkload(): never {
  throw new Error('capacity-workload-invalid');
}

function createAccounts(seedSha256: string): readonly CapacityAccountSeed[] {
  return Object.freeze(Array.from(
    { length: A_TEST_CAPACITY_PROFILE.accounts },
    (_, ordinal) => Object.freeze({
      opaqueAccountId: `account_${sha256(`account:${seedSha256}:${String(ordinal)}`).slice(0, 32)}`,
      ordinal,
    }),
  ));
}

function createEvents(
  durationMs: number,
  random: DeterministicRandom,
  subscriptions: readonly number[],
): readonly CapacityWorkloadEvent[] {
  const events: CapacityWorkloadEvent[] = [];
  let sequence = 0;
  const maintenanceKinds: readonly CapacityOperationEvent['kind'][] = [
    'backup',
    'cloud-to-lan-transfer',
    'lan-to-cloud-transfer',
    'recovery-verification',
  ];
  const gitChildKinds: readonly CapacityOperationEvent['kind'][] = [
    'accept',
    'backup',
    'cloud-to-lan-transfer',
    'git-clone',
    'git-fetch',
    'git-push',
    'lan-to-cloud-transfer',
    'publish',
    'recovery-verification',
  ];
  const addOperation = <Kind extends CapacityOperationEvent['kind']>(
    atMs: number,
    kind: Kind,
    projectOrdinal = random.integer(A_TEST_CAPACITY_PROFILE.projects),
    trafficClass: CapacityTrafficClass = maintenanceKinds.includes(kind)
      ? 'maintenance'
      : 'ordinary',
    resourceClaims: CapacityResourceClaims | null = null,
    gitChildCount = gitChildKinds.includes(kind) ? 1 : 0,
    overloadProbe = false,
  ): CapacityOperationEvent & { readonly kind: Kind } => {
    const event = Object.freeze({
      atMs,
      gitChildCount,
      kind,
      overloadProbe,
      projectOrdinal,
      resourceClaims: resourceClaims === null
        ? null
        : Object.freeze({ ...resourceClaims }),
      sequence,
      trafficClass,
    });
    events.push(event);
    sequence += 1;
    return event;
  };
  const addResourceSample = (
    atMs: number,
    ceilingProbeSequences: readonly number[],
    probeKind: CapacityResourceSampleEvent['probeKind'],
  ): void => {
    events.push(Object.freeze({
      atMs,
      ceilingProbeSequences: Object.freeze([...ceilingProbeSequences]),
      kind: 'resource-sample',
      probeKind,
      projectOrdinal: 0,
      sequence,
    }));
    sequence += 1;
  };
  const addRestart = (
    atMs: number,
    interrupted: CapacityOperationEvent & {
      readonly kind: CapacityRestartEvent['interruptedKind'];
    },
  ): void => {
    events.push(Object.freeze({
      atMs,
      interruptedKind: interrupted.kind,
      interruptedSequence: interrupted.sequence,
      kind: 'process-restart',
      projectOrdinal: interrupted.projectOrdinal,
      sequence,
      trafficClass: 'fault-injection',
    }));
    sequence += 1;
  };
  const addFaultAndRecovery = (
    restartAtMs: number,
    interrupted: CapacityOperationEvent & {
      readonly kind: CapacityRestartEvent['interruptedKind'];
    },
  ): void => {
    addRestart(restartAtMs, interrupted);
    addOperation(restartAtMs + 5_000, 'recovery-verification', interrupted.projectOrdinal);
  };
  const addCrossProjectPair = (
    atMs: number,
    kind: 'git-fetch' | 'git-push' | 'publish',
  ): void => {
    const firstProject = random.integer(A_TEST_CAPACITY_PROFILE.projects);
    let secondProject = random.integer(A_TEST_CAPACITY_PROFILE.projects);
    if (secondProject === firstProject) {
      secondProject = (secondProject + 1) % A_TEST_CAPACITY_PROFILE.projects;
    }
    addOperation(atMs, kind, firstProject);
    addOperation(atMs, kind, secondProject);
  };

  let controlIndex = 0;
  for (let atMs = 1_000; atMs < durationMs; atMs += 2_000) {
    addOperation(atMs, controlIndex % 5 === 4 ? 'control-write' : 'control-read');
    controlIndex += 1;
  }
  for (let atMs = 3_000; atMs < durationMs; atMs += 15_000) {
    addCrossProjectPair(atMs, 'git-fetch');
  }
  for (let atMs = 10_000; atMs < durationMs; atMs += 60_000) {
    addCrossProjectPair(atMs, 'git-push');
  }
  for (let atMs = 5_000; atMs < durationMs; atMs += 45_000) {
    addCrossProjectPair(atMs, 'publish');
  }
  for (let atMs = 20_000; atMs < durationMs; atMs += 300_000) {
    addOperation(atMs, 'accept');
  }
  const firstTransferAt = Math.floor(durationMs / 3);
  const secondTransferAt = Math.floor((durationMs * 2) / 3);
  const firstProject = random.integer(A_TEST_CAPACITY_PROFILE.projects);
  let secondProject = random.integer(A_TEST_CAPACITY_PROFILE.projects);
  if (secondProject === firstProject) {
    secondProject = (secondProject + 1) % A_TEST_CAPACITY_PROFILE.projects;
  }

  const firstTransfer = addOperation(
    firstTransferAt,
    'lan-to-cloud-transfer',
    firstProject,
    'fault-injection',
  );
  const firstBackup = addOperation(
    firstTransferAt,
    'backup',
    secondProject,
    'fault-injection',
  );
  addFaultAndRecovery(firstTransferAt + 10_000, firstTransfer);
  addFaultAndRecovery(firstTransferAt + 20_000, firstBackup);
  const secondTransfer = addOperation(
    secondTransferAt,
    'cloud-to-lan-transfer',
    secondProject,
    'fault-injection',
  );
  addOperation(secondTransferAt, 'backup', firstProject);
  addFaultAndRecovery(secondTransferAt + 10_000, secondTransfer);

  const addScheduledFault = (
    kind: 'accept' | 'git-push' | 'publish',
    targetAtMs: number,
  ): void => {
    const candidates = events.filter((event): event is CapacityOperationEvent & {
      readonly kind: typeof kind;
    } => (
      event.kind === kind
    ));
    const candidate = candidates.reduce<(typeof candidates)[number] | undefined>(
      (selected, event) => selected === undefined
        || Math.abs(event.atMs - targetAtMs) < Math.abs(selected.atMs - targetAtMs)
        ? event
        : selected,
      undefined,
    );
    if (candidate === undefined) invalidWorkload();
    const candidateIndex = events.indexOf(candidate);
    if (candidateIndex < 0) invalidWorkload();
    const interrupted = Object.freeze({
      ...candidate,
      trafficClass: 'fault-injection' as const,
    });
    events[candidateIndex] = interrupted;
    addFaultAndRecovery(candidate.atMs + 5_000, interrupted);
  };
  addScheduledFault('git-push', Math.floor(durationMs / 6));
  addScheduledFault('publish', Math.floor(durationMs / 2));
  addScheduledFault('accept', Math.floor((durationMs * 5) / 6));

  const ceilingAt = Math.floor(durationMs / 2);
  const ceilingProbeSequences: number[] = [];
  for (let ordinal = 0; ordinal < A_TEST_CAPACITY_LIMITS.controlRequestsInFlight; (
    ordinal += 1
  )) {
    ceilingProbeSequences.push(addOperation(
      ceilingAt,
      'control-read',
      ordinal % A_TEST_CAPACITY_PROFILE.projects,
      'ordinary',
      {
        controlRequests: 1,
        ordinaryPostgresTransactions: ordinal
          < A_TEST_CAPACITY_LIMITS.ordinaryPostgresTransactions ? 1 : 0,
        pinnedProjectLeaseConnections: ordinal
          < A_TEST_CAPACITY_LIMITS.pinnedProjectLeaseConnections ? 1 : 0,
        reservedRecoveryConnections: ordinal
          >= A_TEST_CAPACITY_LIMITS.pinnedProjectLeaseConnections
          && ordinal < A_TEST_CAPACITY_LIMITS.pinnedProjectLeaseConnections
            + A_TEST_CAPACITY_LIMITS.reservedRecoveryConnections ? 1 : 0,
      },
      0,
    ).sequence);
  }
  addOperation(
    ceilingAt,
    'control-read',
    A_TEST_CAPACITY_LIMITS.controlRequestsInFlight,
    'ordinary',
    null,
    0,
    true,
  );
  const gitEnvelope: readonly CapacityOperationEvent['kind'][] = [
    'git-clone',
    'git-fetch',
    'git-fetch',
    'git-fetch',
    'git-push',
    'git-push',
  ];
  gitEnvelope.forEach((kind, ordinal) => {
    ceilingProbeSequences.push(addOperation(
      ceilingAt,
      kind,
      40,
      'ordinary',
      {
        admittedGitRequests: 1,
        cloneRequests: kind === 'git-clone' ? 1 : 0,
        fetchRequests: kind === 'git-fetch' ? 1 : 0,
        gitChildren: ordinal < A_TEST_CAPACITY_LIMITS.runningGitChildren ? 1 : 0,
        perProjectGitReads: ordinal < A_TEST_CAPACITY_LIMITS.perProjectGitReads ? 1 : 0,
        perProjectQueuedRequests: ordinal
          >= A_TEST_CAPACITY_LIMITS.runningGitChildren ? 1 : 0,
        pushRequests: kind === 'git-push' ? 1 : 0,
      },
      1,
    ).sequence);
  });
  for (let ordinal = 0; ordinal < A_TEST_CAPACITY_LIMITS.concurrentPublishes; (
    ordinal += 1
  )) {
    ceilingProbeSequences.push(addOperation(
      ceilingAt,
      'publish',
      50 + ordinal,
      'ordinary',
      { publishes: 1 },
      1,
    ).sequence);
  }
  for (let ordinal = 0; ordinal < A_TEST_CAPACITY_LIMITS.concurrentAccepts; ordinal += 1) {
    ceilingProbeSequences.push(addOperation(
      ceilingAt,
      'accept',
      60 + ordinal,
      'ordinary',
      { accepts: 1 },
      1,
    ).sequence);
  }

  const reconnectAt = Math.floor((durationMs * 3) / 4);
  const reconnectProbeSequences: number[] = [];
  for (const projectOrdinal of subscriptions) {
    reconnectProbeSequences.push(addOperation(
      reconnectAt,
      'reconnect',
      projectOrdinal,
      'ordinary',
      { subscriptions: 1 },
      0,
    ).sequence);
  }
  for (let atMs = 0; atMs <= durationMs; atMs += 60_000) {
    addResourceSample(
      atMs,
      atMs === ceilingAt
        ? ceilingProbeSequences
        : atMs === reconnectAt ? reconnectProbeSequences : [],
      atMs === ceilingAt
        ? 'capacity-envelope'
        : atMs === reconnectAt ? 'subscription-storm' : null,
    );
  }

  events.sort((left, right) => left.atMs - right.atMs || left.sequence - right.sequence);
  return Object.freeze(events);
}

export function createCapacityWorkload(
  options: CreateCapacityWorkloadOptions,
): CapacityWorkload {
  if (options.seed.length === 0 || options.seed.length > 4_096) {
    throw new Error('capacity-workload-invalid');
  }
  const seedSha256 = sha256(options.seed);
  const random = new DeterministicRandom(seedSha256);
  const durationMs = options.scenario === 'one-hour-mixed'
    ? ONE_HOUR_MS
    : EIGHT_HOURS_MS;
  const projects = createProjects(seedSha256, random);
  const subscribedProjectOrdinals = Object.freeze(shuffled(
    projects.map(project => project.ordinal),
    random,
  ).slice(0, A_TEST_CAPACITY_PROFILE.subscriptions));

  const workload: CapacityWorkload = Object.freeze({
    accounts: createAccounts(seedSha256),
    durationMs,
    events: createEvents(durationMs, random, subscribedProjectOrdinals),
    limits: A_TEST_CAPACITY_LIMITS,
    measurement: Object.freeze({
      projectGitProcessingWindowEndAtMs: Object.freeze([
        Math.floor(durationMs / 2),
        durationMs,
      ]),
      projectStorageSnapshotAtMs: Object.freeze([
        0,
        Math.floor(durationMs / 2),
        durationMs,
      ]),
      resourceSampleIntervalMs: 60_000,
    }),
    profile: A_TEST_CAPACITY_PROFILE.profile,
    projects,
    scenario: options.scenario,
    seedSha256,
    subscribedProjectOrdinals,
  });
  issuedCapacityWorkloads.add(workload);
  return workload;
}

export function digestCapacityWorkload(workload: CapacityWorkload): string {
  return sha256(JSON.stringify(workload));
}
