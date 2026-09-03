import { createHash } from 'node:crypto';

import {
  COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
  COLLAB_PROJECT_BACKUP_COORDINATION_FORMAT_VERSION,
  COLLAB_PROJECT_COORDINATION_FORMAT_VERSION,
  COLLAB_PROTOCOL_VERSION,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabCheckpointGitRef,
  type CollabCheckpointProfile,
  type CollabIsoTimestamp,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../coordination/CoordinationError.js';
import type {
  ProjectBackupCatalogRecord,
  ProjectLifecycleJournalRecord,
} from '../../coordination/PortabilityLifecyclePersistence.js';
import type {
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
  ProjectScope,
} from '../../coordination/ProjectCoordination.js';
import type {
  ProjectCheckpointSnapshotMetadata,
} from '../../coordination/ProjectCheckpointPersistence.js';
import {
  sameRepositoryPlacement,
  type RepositoryPlacementLease,
} from '../../repositories/RepositoryPlacement.js';
import {
  ProjectRecoveryError,
  type ProjectRecoveryPort,
} from '../admission/ProjectWriteAdmission.js';
import type {
  ProjectLifecycleRecoveryOwner,
  ProjectLifecycleRecoveryOutcome,
  RecoverProjectLifecycleInput,
} from '../lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import {
  ProjectCheckpointCoordinatorError,
  type CapturedOutboundProjectCheckpoint,
  type OutboundProjectCheckpointReservation,
  type OutboundProjectCheckpointProgress,
  type ProjectCheckpointCoordinator,
  type OutboundProjectCheckpointRecord,
} from './ProjectCheckpointCoordinator.js';

type BackupExportProfile = Extract<CollabCheckpointProfile, 'backup' | 'export'>;

export type BackupExportCoordinatorErrorCode =
  | 'cancelled'
  | 'closed'
  | 'dependency-failed'
  | 'invalid-checkpoint'
  | 'recovery-required'
  | 'resource-limit'
  | 'state-conflict'
  | 'timeout';

export class BackupExportCoordinatorError extends Error {
  readonly code: BackupExportCoordinatorErrorCode;
  readonly retryable: boolean;

  constructor(code: BackupExportCoordinatorErrorCode) {
    super(`backup-export-coordinator.error.${code}`);
    this.name = 'BackupExportCoordinatorError';
    this.code = code;
    this.retryable = code === 'dependency-failed' || code === 'timeout';
  }

  toJSON(): Readonly<Record<string, boolean | string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
      retryable: this.retryable,
    });
  }
}

export interface BackupExportCoordination {
  acquireProjectLease(
    projectId: CollabProjectId,
    options?: AcquireProjectLeaseOptions,
  ): Promise<PinnedProjectLease>;
}

export interface BackupExportCheckpointSnapshot {
  readonly records: readonly OutboundProjectCheckpointRecord[];
  readonly refs: readonly CollabCheckpointGitRef[];
}

export interface BackupExportCheckpointSource {
  /**
   * Returns the exact fenced snapshot for this operation. The current
   * backup/export journal is represented by the checkpoint manifest and must
   * not be serialized into its own coordination stream.
   */
  snapshot(input: Readonly<{
    readonly lease: PinnedProjectLease;
    readonly operationId: string;
    readonly profile: BackupExportProfile;
    readonly projectId: CollabProjectId;
    readonly repositoryReservation: OutboundProjectCheckpointReservation;
    readonly signal: AbortSignal;
    readonly snapshotAt: CollabIsoTimestamp;
  }>): Promise<BackupExportCheckpointSnapshot>;
}

export interface BackupExportMetadata
  extends Omit<
    ProjectCheckpointSnapshotMetadata,
    'maximumServerBuild' | 'minimumServerBuild'
  > {
  readonly serverBuild: string;
}

export interface BackupExportCoordinatorOptions {
  readonly checkpoint: Pick<
    ProjectCheckpointCoordinator,
    | 'captureOutbound'
    | 'discardOutboundOperation'
    | 'listDueOutboundDeliveries'
    | 'publishOutbound'
    | 'readOutboundRecords'
    | 'readPublishedOutboundRecords'
    | 'releaseOutbound'
    | 'releaseOutboundOperation'
    | 'registerOutboundDelivery'
    | 'reserveOutbound'
    | 'verifyOutboundOperation'
  >;
  readonly clock?: () => Date;
  readonly coordination: BackupExportCoordination;
  readonly metadata: BackupExportMetadata;
  readonly recovery: ProjectRecoveryPort;
  readonly source: BackupExportCheckpointSource;
}

export interface CreateBackupExportInput {
  readonly expiresAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly profile: BackupExportProfile;
  readonly projectId: CollabProjectId;
  readonly signal?: AbortSignal;
}

export interface CancelBackupExportInput {
  readonly operationId: string;
  readonly profile: BackupExportProfile;
  readonly projectId: CollabProjectId;
  readonly signal?: AbortSignal;
}

export interface BackupExportResult {
  readonly checkpointSha256: string;
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly profile: BackupExportProfile;
  readonly projectId: CollabProjectId;
  /** The local checkpoint/delivery artifact is published; restore is unproven. */
  readonly state: 'published';
}

export interface SettleExportDeliveryInput {
  readonly expiredBefore?: CollabIsoTimestamp;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly reason: 'cancelled' | 'completed' | 'expired';
  readonly signal?: AbortSignal;
}

export interface ReconcileExpiredExportDeliveriesInput {
  readonly expiredBefore: CollabIsoTimestamp;
  readonly signal?: AbortSignal;
}

interface CreateSnapshot extends Omit<CreateBackupExportInput, 'signal'> {
  readonly signal: AbortSignal | undefined;
}

interface CancelSnapshot extends Omit<CancelBackupExportInput, 'signal'> {
  readonly signal: AbortSignal | undefined;
}

interface ExactCheckpointContext {
  readonly placement: RepositoryPlacementLease;
  readonly project: Readonly<{
    readonly authorityGeneration: number;
    readonly authorityStateRevision: number;
    readonly expectedMainOid: string;
    readonly serviceState: 'maintenance';
  }>;
}

const ACTIVE_PHASES = Object.freeze([
  'prepared',
  'coordination-captured',
  'repository-captured',
  'checkpoint-verified',
  'artifact-published',
] as const);
const ACTIVE_PHASE_INDEX = new Map<string, number>(
  ACTIVE_PHASES.map((phase, index) => [phase, index]),
);
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CHECKPOINT_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1_000;

function fail(code: BackupExportCoordinatorErrorCode): never {
  throw new BackupExportCoordinatorError(code);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    fail(signal.reason === 'closed'
      ? 'closed'
      : signal.reason === 'timeout' ? 'timeout' : 'cancelled');
  }
}

function isTimeoutFailure(error: unknown, signal: AbortSignal): boolean {
  return signal.reason === 'timeout'
    || error instanceof BackupExportCoordinatorError && error.code === 'timeout';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function durablePreparedFingerprint(input: Readonly<{
  readonly authorityGeneration: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly expectedMainOid: string;
  readonly expiresAt: CollabIsoTimestamp;
  readonly metadata: BackupExportMetadata;
  readonly operationId: string;
  readonly placement: RepositoryPlacementLease;
  readonly profile: BackupExportProfile;
  readonly projectId: CollabProjectId;
}>): string {
  return sha256(JSON.stringify({
    authorityGeneration: input.authorityGeneration,
    coordinationFormatVersion: input.profile === 'backup'
      ? COLLAB_PROJECT_BACKUP_COORDINATION_FORMAT_VERSION
      : COLLAB_PROJECT_COORDINATION_FORMAT_VERSION,
    createdAt: input.createdAt,
    expectedMainOid: input.expectedMainOid,
    expiresAt: input.expiresAt,
    manifestSchemaVersion: COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
    metadata: input.profile === 'backup' ? Object.freeze({
      authorityId: input.metadata.authorityId,
      authorityVolumeIdentity: input.metadata.authorityVolumeIdentity,
      coordinationSchemaVersion: input.metadata.coordinationSchemaVersion,
      repositoryFormatVersion: input.metadata.repositoryFormatVersion,
      restoreEpoch: input.metadata.restoreEpoch,
    }) : undefined,
    operationId: input.operationId,
    placementGeneration: input.placement.generation,
    profile: input.profile,
    projectId: input.projectId,
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    repositoryStorageKey: input.placement.repositoryStorageKey,
    storageNodeId: input.placement.storageNodeId,
  }));
}

function timestamp(value: unknown): value is CollabIsoTimestamp {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function clockTimestamp(clock: () => Date): CollabIsoTimestamp {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    return fail('dependency-failed');
  }
  return value.toISOString();
}

function snapshotInput(input: CreateBackupExportInput): CreateSnapshot {
  const expiresAt = input.expiresAt;
  const operationId = input.operationId;
  const profile: unknown = input.profile;
  const projectId = input.projectId;
  if (
    !timestamp(expiresAt)
    || !isCollabOpaqueId(operationId)
    || (profile !== 'backup' && profile !== 'export')
    || !isCollabProjectId(projectId)
  ) {
    fail('state-conflict');
  }
  return Object.freeze({
    expiresAt,
    operationId,
    profile: profile as BackupExportProfile,
    projectId,
    signal: input.signal,
  });
}

function snapshotCancellation(input: CancelBackupExportInput): CancelSnapshot {
  const snapshot = Object.freeze({
    operationId: input.operationId,
    profile: input.profile as unknown,
    projectId: input.projectId,
    signal: input.signal,
  });
  if (
    !isCollabOpaqueId(snapshot.operationId)
    || (snapshot.profile !== 'backup' && snapshot.profile !== 'export')
    || !isCollabProjectId(snapshot.projectId)
  ) fail('state-conflict');
  return Object.freeze({
    ...snapshot,
    profile: snapshot.profile as BackupExportProfile,
  });
}

function assertOptions(options: BackupExportCoordinatorOptions): void {
  if (
    typeof options.checkpoint.captureOutbound !== 'function'
    || typeof options.checkpoint.discardOutboundOperation !== 'function'
    || typeof options.checkpoint.listDueOutboundDeliveries !== 'function'
    || typeof options.checkpoint.publishOutbound !== 'function'
    || typeof options.checkpoint.readOutboundRecords !== 'function'
    || typeof options.checkpoint.readPublishedOutboundRecords !== 'function'
    || typeof options.checkpoint.releaseOutbound !== 'function'
    || typeof options.checkpoint.releaseOutboundOperation !== 'function'
    || typeof options.checkpoint.registerOutboundDelivery !== 'function'
    || typeof options.checkpoint.reserveOutbound !== 'function'
    || typeof options.checkpoint.verifyOutboundOperation !== 'function'
    || typeof options.coordination.acquireProjectLease !== 'function'
    || typeof options.recovery.recoverProject !== 'function'
    || typeof options.source.snapshot !== 'function'
    || !IDENTITY_PATTERN.test(options.metadata.authorityId)
    || !IDENTITY_PATTERN.test(options.metadata.authorityVolumeIdentity)
    || !Number.isSafeInteger(options.metadata.coordinationSchemaVersion)
    || options.metadata.coordinationSchemaVersion <= 0
    || !Number.isSafeInteger(options.metadata.repositoryFormatVersion)
    || options.metadata.repositoryFormatVersion <= 0
    || !Number.isSafeInteger(options.metadata.restoreEpoch)
    || options.metadata.restoreEpoch <= 0
    || options.metadata.serverBuild.length === 0
    || Buffer.byteLength(options.metadata.serverBuild, 'utf8') > 128
  ) {
    throw new TypeError('backup-export-coordinator.options-invalid');
  }
}

function mapError(error: unknown, signal: AbortSignal): never {
  if (error instanceof BackupExportCoordinatorError) throw error;
  if (signal.aborted) {
    return fail(signal.reason === 'closed'
      ? 'closed'
      : signal.reason === 'timeout' ? 'timeout' : 'cancelled');
  }
  if (error instanceof ProjectCheckpointCoordinatorError) {
    switch (error.code) {
      case 'cancelled': return fail('cancelled');
      case 'closed': return fail('closed');
      case 'invalid-checkpoint': return fail('invalid-checkpoint');
      case 'resource-limit': return fail('resource-limit');
      default: return fail('dependency-failed');
    }
  }
  if (error instanceof ProjectRecoveryError) {
    if (error.code === 'recovery-required') return fail('recovery-required');
    if (error.code === 'closed') return fail('closed');
    return fail('dependency-failed');
  }
  if (error instanceof CoordinationError) {
    if (error.code === 'cancelled') return fail('cancelled');
    if (error.code === 'closed') return fail('closed');
    if (
      error.code === 'invalid-project'
      || error.code === 'invalid-record'
      || error.code === 'state-conflict'
    ) return fail('state-conflict');
    return fail('dependency-failed');
  }
  return fail('dependency-failed');
}

function exactJournal(
  journal: ProjectLifecycleJournalRecord,
  expected: Readonly<{
    readonly operationId: string;
    readonly profile: BackupExportProfile;
    readonly projectId: CollabProjectId;
    readonly expiresAt?: CollabIsoTimestamp;
  }>,
): void {
  if (
    journal.direction !== undefined
    || journal.kind !== expected.profile
    || journal.operationId !== expected.operationId
    || journal.projectId !== expected.projectId
    || (
      expected.expiresAt !== undefined
      && journal.scheduledAt !== expected.expiresAt
    )
  ) fail('state-conflict');
}

export class BackupExportCoordinator implements ProjectLifecycleRecoveryOwner {
  readonly #checkpoint: BackupExportCoordinatorOptions['checkpoint'];
  readonly #clock: () => Date;
  readonly #controllers = new Set<AbortController>();
  readonly #coordination: BackupExportCoordination;
  readonly #metadata: BackupExportMetadata;
  readonly #recovery: ProjectRecoveryPort;
  readonly #running = new Set<Promise<void>>();
  readonly #source: BackupExportCheckpointSource;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: BackupExportCoordinatorOptions) {
    assertOptions(options);
    this.#checkpoint = options.checkpoint;
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#metadata = Object.freeze({ ...options.metadata });
    this.#recovery = options.recovery;
    this.#source = options.source;
  }

  create(input: CreateBackupExportInput): Promise<BackupExportResult> {
    let snapshot: CreateSnapshot;
    try {
      snapshot = snapshotInput(input);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new BackupExportCoordinatorError('state-conflict'),
      );
    }
    return this.#track(
      snapshot.signal,
      signal => this.#create(snapshot, signal),
      false,
    );
  }

  cancel(input: CancelBackupExportInput): Promise<'cancelled'> {
    let snapshot: CancelSnapshot;
    try {
      snapshot = snapshotCancellation(input);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new BackupExportCoordinatorError('state-conflict'),
      );
    }
    return this.#track(snapshot.signal, signal => this.#cancel(snapshot, signal));
  }

  settleExportDelivery(
    input: SettleExportDeliveryInput,
  ): Promise<'removed'> {
    const operationId = input.operationId;
    const projectId = input.projectId;
    const reason: unknown = input.reason;
    const expiredBefore = input.expiredBefore;
    if (
      !isCollabOpaqueId(operationId)
      || !isCollabProjectId(projectId)
      || (reason !== 'cancelled' && reason !== 'completed' && reason !== 'expired')
      || (reason === 'expired' && !timestamp(expiredBefore))
      || (reason !== 'expired' && expiredBefore !== undefined)
    ) {
      return Promise.reject(new BackupExportCoordinatorError('state-conflict'));
    }
    return this.#track(input.signal, async signal => {
      let lease: PinnedProjectLease | undefined;
      try {
        lease = await this.#coordination.acquireProjectLease(projectId, { signal });
        const journal = await lease.withProjectScope(scope => (
          scope.portability.getLifecycleJournal(operationId)
        ));
        if (
          journal === undefined
          || journal.kind !== 'export'
          || journal.projectId !== projectId
          || journal.operationId !== operationId
          || journal.phase !== 'completed'
          || journal.state !== 'completed'
        ) fail('state-conflict');
        this.#result(journal, journal.scheduledAt);
        if (
          reason === 'expired'
          && expiredBefore !== undefined
          && journal.scheduledAt > expiredBefore
        ) fail('state-conflict');
        await this.#checkpoint.discardOutboundOperation({
          expiresAt: journal.scheduledAt,
          operationId,
          profile: 'export',
          projectId,
        }, signal);
        return 'removed' as const;
      } finally {
        await lease?.close();
      }
    });
  }

  reconcileExpiredExportDeliveries(
    input: ReconcileExpiredExportDeliveriesInput,
  ): Promise<Readonly<{ readonly removed: number }>> {
    if (!timestamp(input.expiredBefore)) {
      return Promise.reject(new BackupExportCoordinatorError('state-conflict'));
    }
    return this.#track(input.signal, async signal => {
      let after;
      let removed = 0;
      for (;;) {
        const page = await this.#checkpoint.listDueOutboundDeliveries({
          ...(after === undefined ? {} : { after }),
          expiredBefore: input.expiredBefore,
          limit: 100,
        }, signal);
        for (const delivery of page.deliveries) {
          if (await this.#settleDueExportDelivery(delivery, signal)) {
            removed += 1;
          }
        }
        if (page.nextCursor === undefined) break;
        after = page.nextCursor;
      }
      return Object.freeze({ removed });
    });
  }

  reserveRecovery(
    projectId: CollabProjectId,
  ): Promise<OutboundProjectCheckpointReservation> {
    if (this.#closed) {
      return Promise.reject(new BackupExportCoordinatorError('closed'));
    }
    return this.#checkpoint.reserveOutbound(projectId).catch((error: unknown) => {
      return mapError(error, new AbortController().signal);
    });
  }

  recover(
    input: RecoverProjectLifecycleInput,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    if (input.journal.kind !== 'backup' && input.journal.kind !== 'export') {
      return Promise.reject(new BackupExportCoordinatorError('state-conflict'));
    }
    const profile = input.journal.kind;
    return this.#track(undefined, async signal => {
      exactJournal(input.journal, {
        operationId: input.journal.operationId,
        profile,
        projectId: input.journal.projectId,
      });
      const reservation = input.repositoryReservation;
      if (reservation === undefined) fail('recovery-required');
      try {
        if (input.journal.phase === 'cancel-intent') {
          await this.#settleCancellation(input.lease, input.journal, signal);
        } else if (
          input.journal.phase !== 'artifact-published'
          && Date.parse(input.journal.scheduledAt)
            <= Date.parse(clockTimestamp(this.#clock))
        ) {
          const cancellation = await this.#requestCancellation(
            input.lease,
            input.journal,
          );
          await this.#settleCancellation(input.lease, cancellation, signal);
        } else {
          await this.#advanceWithinAttemptBudget(
            input.lease,
            input.journal,
            input.journal.scheduledAt,
            signal,
            reservation as OutboundProjectCheckpointReservation,
          );
        }
        return 'settled' as const;
      } catch (error: unknown) {
        if (isTimeoutFailure(error, signal)) {
          await this.#settleTimedOutOperation(input.lease, {
            operationId: input.journal.operationId,
            profile,
            projectId: input.journal.projectId,
          });
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort('closed');
      this.#closePromise = Promise.allSettled([...this.#running]).then(
        () => undefined,
      );
    }
    return this.#closePromise;
  }

  #track<Result>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Result>,
    timeoutFromInvocation = true,
  ): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new BackupExportCoordinatorError('closed'));
    }
    const controller = new AbortController();
    const timeout = timeoutFromInvocation
      ? setTimeout(
        () => controller.abort('timeout'),
        CHECKPOINT_ATTEMPT_TIMEOUT_MS,
      )
      : undefined;
    timeout?.unref();
    const onAbort = (): void => controller.abort('cancelled');
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted === true) onAbort();
    this.#controllers.add(controller);
    const running = Promise.resolve().then(() => {
      if (controller.signal.aborted) {
        assertNotAborted(controller.signal);
      }
      return operation(controller.signal);
    }).catch((error: unknown) => mapError(error, controller.signal));
    const tracked = running.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    void tracked.finally(() => {
      externalSignal?.removeEventListener('abort', onAbort);
      if (timeout !== undefined) clearTimeout(timeout);
      this.#controllers.delete(controller);
      this.#running.delete(tracked);
    });
    return running;
  }

  async #advanceWithinAttemptBudget(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    expiresAt: CollabIsoTimestamp,
    signal: AbortSignal,
    reservation: OutboundProjectCheckpointReservation,
  ): Promise<BackupExportResult> {
    if (journal.state !== 'active') {
      return await this.#advance(
        lease,
        journal,
        expiresAt,
        signal,
        reservation,
      );
    }
    let remaining = CHECKPOINT_ATTEMPT_TIMEOUT_MS;
    if (journal.phase !== 'artifact-published') {
      if (!timestamp(journal.createdAt)) fail('state-conflict');
      remaining = Math.min(
        CHECKPOINT_ATTEMPT_TIMEOUT_MS,
        Date.parse(journal.createdAt) + CHECKPOINT_ATTEMPT_TIMEOUT_MS
          - Date.parse(clockTimestamp(this.#clock)),
      );
    }
    if (remaining <= 0) fail('timeout');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), remaining);
    timeout.unref();
    const attemptSignal = AbortSignal.any([signal, controller.signal]);
    try {
      return await this.#advance(
        lease,
        journal,
        expiresAt,
        attemptSignal,
        reservation,
      );
    } catch (error: unknown) {
      if (controller.signal.reason === 'timeout') fail('timeout');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #create(
    input: CreateSnapshot,
    signal: AbortSignal,
  ): Promise<BackupExportResult> {
    await this.#waitForRecovery(input.projectId, signal);
    const reservation = await this.#checkpoint.reserveOutbound(
      input.projectId,
      signal,
    );
    let lease: PinnedProjectLease | undefined;
    try {
      lease = await this.#coordination.acquireProjectLease(
        input.projectId,
        { signal },
      );
      assertNotAborted(signal);
      let journal = await lease.withProjectScope(scope => (
        scope.portability.getLifecycleJournal(input.operationId)
      ));
      assertNotAborted(signal);
      if (journal === undefined) {
        journal = await this.#prepare(lease, input);
      } else {
        exactJournal(journal, input);
      }
      return await this.#advanceWithinAttemptBudget(
        lease,
        journal,
        input.expiresAt,
        signal,
        reservation,
      );
    } catch (error: unknown) {
      if (isTimeoutFailure(error, signal) && lease !== undefined) {
        const staleLease = lease;
        lease = undefined;
        try {
          await this.#settleTimedOutCreate(staleLease, input);
        } catch {
          throw error;
        }
      }
      throw error;
    } finally {
      try {
        await lease?.close();
      } finally {
        await reservation.close();
      }
    }
  }

  async #settleTimedOutCreate(
    lease: PinnedProjectLease,
    input: CreateSnapshot,
  ): Promise<void> {
    await this.#settleTimedOutOperation(lease, input);
  }

  async #settleTimedOutOperation(
    staleLease: PinnedProjectLease,
    expected: Readonly<{
      readonly expiresAt?: CollabIsoTimestamp;
      readonly operationId: string;
      readonly profile: BackupExportProfile;
      readonly projectId: CollabProjectId;
    }>,
  ): Promise<void> {
    const cleanupSignal = new AbortController().signal;
    await staleLease.close().catch(() => undefined);
    let lease: PinnedProjectLease | undefined;
    try {
      lease = await this.#coordination.acquireProjectLease(
        expected.projectId,
        { signal: cleanupSignal },
      );
      let journal = await lease.withProjectScope(scope => (
        scope.portability.getLifecycleJournal(expected.operationId)
      ));
      if (journal === undefined) return;
      exactJournal(journal, expected);
      if (journal.state === 'cancelled' || journal.state === 'completed') return;
      if (journal.state === 'recovery-required') fail('recovery-required');
      if (journal.phase === 'artifact-published') {
        return;
      }
      if (journal.phase !== 'cancel-intent') {
        journal = await this.#requestCancellation(lease, journal);
      }
      await this.#settleCancellation(lease, journal, cleanupSignal);
    } finally {
      await lease?.close();
    }
  }

  async #settleDueExportDelivery(
    delivery: Readonly<{
      readonly expiresAt: CollabIsoTimestamp;
      readonly operationId: string;
      readonly projectId: CollabProjectId;
    }>,
    signal: AbortSignal,
  ): Promise<boolean> {
    let lease: PinnedProjectLease | undefined;
    try {
      lease = await this.#coordination.acquireProjectLease(
        delivery.projectId,
        { signal },
      );
      const authority = await lease.withProjectScope(async scope => (
        Object.freeze({
          journal: await scope.portability.getLifecycleJournal(
            delivery.operationId,
          ),
          tombstone: await scope.portability.getProjectTombstone(),
        })
      ));
      if (authority.journal !== undefined) {
        exactJournal(authority.journal, {
          expiresAt: delivery.expiresAt,
          operationId: delivery.operationId,
          profile: 'export',
          projectId: delivery.projectId,
        });
        if (
          authority.journal.state === 'active'
          || authority.journal.state === 'recovery-required'
        ) return false;
        if (authority.journal.state !== 'completed') fail('state-conflict');
        this.#result(authority.journal, delivery.expiresAt);
      } else if (authority.tombstone === undefined) {
        fail('state-conflict');
      }
      await this.#checkpoint.discardOutboundOperation({
        expiresAt: delivery.expiresAt,
        operationId: delivery.operationId,
        profile: 'export',
        projectId: delivery.projectId,
      }, signal);
      return true;
    } finally {
      await lease?.close();
    }
  }

  async #cancel(
    input: CancelSnapshot,
    signal: AbortSignal,
  ): Promise<'cancelled'> {
    const reservation = await this.#checkpoint.reserveOutbound(
      input.projectId,
      signal,
    );
    let lease: PinnedProjectLease | undefined;
    try {
      lease = await this.#coordination.acquireProjectLease(
        input.projectId,
        { signal },
      );
      assertNotAborted(signal);
      let journal = await lease.withProjectScope(scope => (
        scope.portability.getLifecycleJournal(input.operationId)
      ));
      assertNotAborted(signal);
      if (journal === undefined) fail('state-conflict');
      exactJournal(journal, input);
      if (journal.state === 'cancelled') return 'cancelled';
      if (journal.state === 'completed') fail('state-conflict');
      if (journal.state === 'recovery-required') fail('recovery-required');
      if (journal.phase === 'artifact-published') {
        await this.#advance(
          lease,
          journal,
          journal.scheduledAt,
          signal,
          reservation,
        );
        return fail('state-conflict');
      }
      if (journal.phase !== 'cancel-intent') {
        journal = await this.#requestCancellation(lease, journal);
      }
      await this.#settleCancellation(lease, journal, signal);
      return 'cancelled';
    } finally {
      try {
        await lease?.close();
      } finally {
        await reservation.close();
      }
    }
  }

  async #prepare(
    lease: PinnedProjectLease,
    input: CreateSnapshot,
  ): Promise<ProjectLifecycleJournalRecord> {
    const createdAt = clockTimestamp(this.#clock);
    if (Date.parse(input.expiresAt) <= Date.parse(createdAt)) {
      return fail('state-conflict');
    }
    return lease.withProjectScope(async scope => {
      const accept = await scope.accept.getNonterminal();
      const bootstrap = await scope.getNonterminalDevelopmentBootstrapAttempt();
      const existing = await scope.portability.getNonterminalLifecycleJournal();
      if (
        accept !== undefined
        || bootstrap !== undefined
        || existing !== undefined
      ) fail('recovery-required');
      const project = await scope.getProject();
      const placement = await scope.getRepositoryPlacement();
      if (
        project?.serviceState !== 'active'
        || placement?.active !== true
        || placement.projectId !== input.projectId
      ) fail('state-conflict');
      const requestFingerprint = durablePreparedFingerprint({
        authorityGeneration: project.authorityGeneration,
        createdAt,
        expectedMainOid: project.expectedMainOid,
        expiresAt: input.expiresAt,
        metadata: this.#metadata,
        operationId: input.operationId,
        placement,
        profile: input.profile,
        projectId: input.projectId,
      });
      await scope.portability.putLifecycleJournal({
        actorMemberId: undefined,
        createdAt,
        direction: undefined,
        expectedAuthorityGeneration: project.authorityGeneration,
        idempotencyKey: input.operationId,
        kind: input.profile,
        operationId: input.operationId,
        phase: 'prepared',
        projectId: input.projectId,
        requestFingerprint,
        scheduledAt: input.expiresAt,
      });
      await scope.advanceProjectAuthorityState({
        expectedAuthorityGeneration: project.authorityGeneration,
        expectedAuthorityStateRevision: project.authorityStateRevision,
        expectedServiceState: 'active',
        nextAuthorityGeneration: project.authorityGeneration,
        nextServiceState: 'maintenance',
      });
      const journal = await scope.portability.getLifecycleJournal(
        input.operationId,
      );
      if (journal === undefined) fail('dependency-failed');
      exactJournal(journal, input);
      if (journal.requestFingerprint !== requestFingerprint) {
        fail('state-conflict');
      }
      return journal;
    });
  }

  async #waitForRecovery(
    projectId: CollabProjectId,
    signal: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    const recovery = this.#recovery.recoverProject(projectId);
    let abortListener: (() => void) | undefined;
    try {
      await Promise.race([
        recovery,
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(new BackupExportCoordinatorError(
            signal.reason === 'closed'
              ? 'closed'
              : signal.reason === 'timeout' ? 'timeout' : 'cancelled',
          ));
          signal.addEventListener('abort', abortListener, { once: true });
          if (signal.aborted) abortListener();
        }),
      ]);
    } finally {
      if (abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  async #advance(
    lease: PinnedProjectLease,
    initial: ProjectLifecycleJournalRecord,
    expiresAt: CollabIsoTimestamp,
    signal: AbortSignal,
    repositoryReservation: OutboundProjectCheckpointReservation,
  ): Promise<BackupExportResult> {
    let journal = initial;
    if (journal.state === 'completed') return this.#result(journal, expiresAt);
    if (journal.state !== 'active') fail('state-conflict');
    const profile = journal.kind;
    if (profile !== 'backup' && profile !== 'export') fail('state-conflict');
    if (!ACTIVE_PHASE_INDEX.has(journal.phase)) fail('state-conflict');
    const context = await this.#context(lease, journal);
    if (journal.phase === 'artifact-published') {
      try {
        const publishedRecords = await this.#checkpoint
          .readPublishedOutboundRecords({
            expectedProfile: profile,
            expiresAt,
            operationId: journal.operationId,
            projectId: journal.projectId,
          }, repositoryReservation, signal);
        await this.#assertPublishedArtifact(
          lease,
          journal,
          context,
          publishedRecords,
        );
        const checkpointSha256 = journal.checkpointSha256;
        if (checkpointSha256 === undefined) fail('invalid-checkpoint');
        await this.#checkpoint.verifyOutboundOperation({
          expectedCheckpointSha256: checkpointSha256,
          expectedProfile: profile,
          expectedSourceAuthority: Object.freeze({
            generation: journal.expectedAuthorityGeneration,
            kind: 'cloud',
          }),
          expiresAt,
          operationId: journal.operationId,
          projectId: journal.projectId,
        }, repositoryReservation, signal);
        if (profile === 'export') {
          await this.#checkpoint.registerOutboundDelivery({
            expiresAt,
            operationId: journal.operationId,
            projectId: journal.projectId,
          }, signal);
        }
      } catch (error: unknown) {
        if (
          (error instanceof ProjectCheckpointCoordinatorError
            && error.code === 'invalid-checkpoint')
          || (error instanceof BackupExportCoordinatorError
            && (error.code === 'invalid-checkpoint'
              || error.code === 'state-conflict'))
        ) {
          await this.#markRecoveryRequired(lease, journal, context);
          return fail('recovery-required');
        }
        throw error;
      }
      await this.#checkpoint.releaseOutboundOperation({
        expiresAt,
        operationId: journal.operationId,
        profile,
        projectId: journal.projectId,
      }, signal);
      journal = await this.#complete(lease, journal, context);
      return this.#result(journal, expiresAt);
    }
    const snapshot = await this.#source.snapshot({
      lease,
      operationId: journal.operationId,
      profile,
      projectId: journal.projectId,
      repositoryReservation,
      signal,
      snapshotAt: journal.createdAt,
    });
    const records = journal.phase === 'prepared'
      ? snapshot.records
      : await this.#checkpoint.readOutboundRecords({
        expectedProfile: profile,
        expiresAt,
        operationId: journal.operationId,
        projectId: journal.projectId,
      }, repositoryReservation, signal);
    if (journal.phase === 'prepared') {
      this.#assertSnapshotMetadata(records, profile, journal.projectId);
    }
    const checkpoint = await this.#checkpoint.captureOutbound({
      createdAt: journal.createdAt,
      expiresAt,
      expectedMainOid: context.project.expectedMainOid,
      onProgress: (phase, checkpointSha256) => this.#recordProgress(
        lease,
        journal,
        context,
        phase,
        checkpointSha256,
      ).then(next => {
        journal = next;
      }),
      operationId: journal.operationId,
      placement: context.placement,
      profile,
      projectId: journal.projectId,
      records,
      refs: snapshot.refs,
      signal,
      sourceAuthority: Object.freeze({
        generation: journal.expectedAuthorityGeneration,
        kind: 'cloud' as const,
      }),
    }, repositoryReservation);
    journal = await this.#exactJournal(lease, journal.operationId, profile);
    if (
      journal.phase !== 'checkpoint-verified'
      && journal.phase !== 'artifact-published'
      && journal.phase !== 'completed'
    ) fail('recovery-required');
    if (
      journal.checkpointSha256 !== checkpoint.manifest.manifestSha256
      || !SHA256_PATTERN.test(checkpoint.manifest.manifestSha256)
    ) fail('invalid-checkpoint');
    if (journal.phase === 'checkpoint-verified') {
      await this.#checkpoint.publishOutbound(
        checkpoint,
        repositoryReservation,
        signal,
      );
      journal = await this.#publish(lease, journal, context, checkpoint);
    }
    if (journal.phase === 'artifact-published') {
      if (profile === 'export') {
        await this.#checkpoint.registerOutboundDelivery({
          expiresAt,
          operationId: journal.operationId,
          projectId: journal.projectId,
        }, signal);
      }
      await this.#checkpoint.releaseOutbound(checkpoint, signal);
      journal = await this.#complete(lease, journal, context);
    }
    if (journal.state !== 'completed' || journal.phase !== 'completed') {
      fail('recovery-required');
    }
    return this.#result(journal, expiresAt);
  }

  async #recordProgress(
    lease: PinnedProjectLease,
    observed: ProjectLifecycleJournalRecord,
    context: ExactCheckpointContext,
    phase: OutboundProjectCheckpointProgress,
    checkpointSha256: string | undefined,
  ): Promise<ProjectLifecycleJournalRecord> {
    const current = await this.#exactJournal(
      lease,
      observed.operationId,
      observed.kind as BackupExportProfile,
    );
    const currentIndex = ACTIVE_PHASE_INDEX.get(current.phase);
    const nextIndex = ACTIVE_PHASE_INDEX.get(phase);
    if (currentIndex === undefined || nextIndex === undefined) {
      return fail('state-conflict');
    }
    if (currentIndex >= nextIndex) {
      if (
        phase === 'checkpoint-verified'
        && checkpointSha256 !== undefined
        && current.checkpointSha256 !== checkpointSha256
      ) fail('invalid-checkpoint');
      return current;
    }
    if (nextIndex !== currentIndex + 1) fail('state-conflict');
    const updatedAt = clockTimestamp(this.#clock);
    await lease.withProjectScope(async scope => {
      await this.#revalidateContext(scope, current, context);
      await scope.portability.advanceLifecycleJournal({
        ...(checkpointSha256 === undefined ? {} : { checkpointSha256 }),
        expectedPhase: current.phase,
        expectedState: 'active',
        nextPhase: phase,
        nextState: 'active',
        operationId: current.operationId,
        scheduledAt: current.scheduledAt,
        updatedAt,
      });
    });
    return this.#exactJournal(
      lease,
      current.operationId,
      current.kind as BackupExportProfile,
    );
  }

  #assertSnapshotMetadata(
    records: readonly OutboundProjectCheckpointRecord[],
    profile: BackupExportProfile,
    projectId: CollabProjectId,
  ): void {
    if (profile === 'export') return;
    const metadata = this.#backupMetadata(records, projectId);
    if (
      metadata.authorityId !== this.#metadata.authorityId
      || metadata.authorityVolumeIdentity
        !== this.#metadata.authorityVolumeIdentity
      || metadata.coordinationSchemaVersion
        !== this.#metadata.coordinationSchemaVersion
      || metadata.repositoryFormatVersion
        !== this.#metadata.repositoryFormatVersion
      || metadata.restoreEpoch !== this.#metadata.restoreEpoch
      || metadata.serverBuild !== this.#metadata.serverBuild
    ) fail('invalid-checkpoint');
  }

  #backupMetadata(
    records: readonly OutboundProjectCheckpointRecord[],
    projectId: CollabProjectId,
  ): BackupExportMetadata {
    const schemas = records.filter(record => record.kind === 'schema-catalog');
    const servers = records.filter(
      record => record.kind === 'server-compatibility',
    );
    const volumes = records.filter(
      record => record.kind === 'authority-volume-pair',
    );
    const schema = schemas[0];
    const server = servers[0];
    const volume = volumes[0];
    if (
      schemas.length !== 1
      || servers.length !== 1
      || volumes.length !== 1
      || schema === undefined
      || server === undefined
      || volume === undefined
      || schema.value.projectId !== projectId
      || server.value.projectId !== projectId
      || server.value.minimumBuild !== server.value.maximumBuild
      || volume.value.projectId !== projectId
    ) fail('invalid-checkpoint');
    return Object.freeze({
      authorityId: volume.value.authorityId,
      authorityVolumeIdentity: volume.value.authorityVolumeIdentity,
      coordinationSchemaVersion: schema.value.coordinationSchemaVersion,
      repositoryFormatVersion: schema.value.repositoryFormatVersion,
      restoreEpoch: volume.value.restoreEpoch,
      serverBuild: server.value.minimumBuild,
    });
  }

  async #publish(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    context: ExactCheckpointContext,
    checkpoint: CapturedOutboundProjectCheckpoint,
  ): Promise<ProjectLifecycleJournalRecord> {
    const checkpointSha256 = journal.checkpointSha256;
    if (checkpointSha256 === undefined) fail('invalid-checkpoint');
    const backupMetadata = journal.kind === 'backup'
      ? this.#backupMetadata(checkpoint.records, journal.projectId)
      : undefined;
    const result = this.#result(journal, journal.scheduledAt);
    const resultSha256 = sha256(JSON.stringify(result));
    const updatedAt = clockTimestamp(this.#clock);
    await lease.withProjectScope(async scope => {
      await this.#revalidateContext(scope, journal, context);
      if (journal.kind === 'backup') {
        const exactMetadata = backupMetadata ?? fail('invalid-checkpoint');
        let catalog = await scope.portability.getBackupCatalogEntry(
          journal.operationId,
        );
        if (catalog === undefined) {
          await scope.portability.putBackupCatalogEntry({
            authorityGeneration: journal.expectedAuthorityGeneration,
            authorityVolumeIdentity: exactMetadata.authorityVolumeIdentity,
            backupId: journal.operationId,
            checkpointSha256,
            coordinationSchemaVersion:
              exactMetadata.coordinationSchemaVersion,
            createdAt: journal.createdAt,
            placementGeneration: context.placement.generation,
            serverBuild: exactMetadata.serverBuild,
          });
          catalog = await scope.portability.getBackupCatalogEntry(
            journal.operationId,
          );
        }
        this.#exactCatalog(
          catalog,
          journal,
          context,
          checkpointSha256,
          exactMetadata,
        );
        catalog = await this.#advanceCatalog(
          scope,
          catalog,
          'verified',
          updatedAt,
        );
        await this.#advanceCatalog(
          scope,
          catalog,
          'published',
          updatedAt,
        );
      }
      await scope.portability.advanceLifecycleJournal({
        expectedPhase: 'checkpoint-verified',
        expectedState: 'active',
        nextPhase: 'artifact-published',
        nextState: 'active',
        operationId: journal.operationId,
        resultSha256,
        scheduledAt: journal.scheduledAt,
        updatedAt,
      });
    });
    if (checkpoint.manifest.manifestSha256 !== checkpointSha256) {
      fail('invalid-checkpoint');
    }
    return this.#exactJournal(
      lease,
      journal.operationId,
      journal.kind as BackupExportProfile,
    );
  }

  async #advanceCatalog(
    scope: ProjectScope,
    catalog: ProjectBackupCatalogRecord | undefined,
    nextState: 'published' | 'verified',
    updatedAt: CollabIsoTimestamp,
  ): Promise<ProjectBackupCatalogRecord> {
    if (catalog === undefined) fail('dependency-failed');
    if (catalog.state === nextState || catalog.state === 'published') return catalog;
    const expectedState = nextState === 'verified' ? 'captured' : 'verified';
    if (catalog.state !== expectedState) fail('state-conflict');
    await scope.portability.advanceBackupCatalogEntry({
      backupId: catalog.backupId,
      expectedState,
      nextState,
      updatedAt,
    });
    const advanced = await scope.portability.getBackupCatalogEntry(
      catalog.backupId,
    );
    if (advanced?.state !== nextState) fail('dependency-failed');
    return advanced;
  }

  #exactCatalog(
    catalog: ProjectBackupCatalogRecord | undefined,
    journal: ProjectLifecycleJournalRecord,
    context: ExactCheckpointContext,
    checkpointSha256: string,
    metadata?: BackupExportMetadata,
  ): asserts catalog is ProjectBackupCatalogRecord {
    if (
      catalog === undefined
      || catalog.authorityGeneration !== journal.expectedAuthorityGeneration
      || catalog.backupId !== journal.operationId
      || catalog.checkpointSha256 !== checkpointSha256
      || catalog.createdAt !== journal.createdAt
      || catalog.placementGeneration !== context.placement.generation
      || (
        metadata !== undefined
        && (
          catalog.authorityVolumeIdentity
            !== metadata.authorityVolumeIdentity
          || catalog.coordinationSchemaVersion
            !== metadata.coordinationSchemaVersion
          || catalog.serverBuild !== metadata.serverBuild
        )
      )
    ) fail('state-conflict');
  }

  async #assertPublishedArtifact(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    context: ExactCheckpointContext,
    records: readonly OutboundProjectCheckpointRecord[],
  ): Promise<void> {
    if (journal.kind !== 'backup') return;
    const checkpointSha256 = journal.checkpointSha256;
    if (checkpointSha256 === undefined) fail('invalid-checkpoint');
    const catalog = await lease.withProjectScope(scope => (
      scope.portability.getBackupCatalogEntry(journal.operationId)
    ));
    this.#exactCatalog(
      catalog,
      journal,
      context,
      checkpointSha256,
      this.#backupMetadata(records, journal.projectId),
    );
    if (
      catalog.state !== 'published'
      || catalog.publishedAt === undefined
      || catalog.verifiedAt === undefined
    ) fail('state-conflict');
  }

  async #settleCancellation(
    lease: PinnedProjectLease,
    observed: ProjectLifecycleJournalRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const journal = await this.#exactJournal(
      lease,
      observed.operationId,
      observed.kind as BackupExportProfile,
    );
    if (journal.state === 'cancelled') return;
    if (journal.state === 'recovery-required') fail('recovery-required');
    if (journal.state !== 'active' || journal.phase !== 'cancel-intent') {
      fail('state-conflict');
    }
    const context = await this.#context(lease, journal);
    try {
      await this.#checkpoint.discardOutboundOperation({
        expiresAt: journal.scheduledAt,
        operationId: journal.operationId,
        profile: journal.kind as BackupExportProfile,
        projectId: journal.projectId,
      }, signal);
    } catch (error: unknown) {
      if (
        error instanceof ProjectCheckpointCoordinatorError
        && error.code === 'invalid-checkpoint'
      ) {
        const updatedAt = clockTimestamp(this.#clock);
        await lease.withProjectScope(async scope => {
          await this.#revalidateContext(scope, journal, context);
          await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'cancel-intent',
            expectedState: 'active',
            nextPhase: 'cancel-intent',
            nextState: 'recovery-required',
            operationId: journal.operationId,
            recoveryFromPhase: 'cancel-intent',
            scheduledAt: journal.scheduledAt,
            updatedAt,
          });
        });
        return fail('recovery-required');
      }
      throw error;
    }
    const updatedAt = clockTimestamp(this.#clock);
    await lease.withProjectScope(async scope => {
      const project = await this.#revalidateContext(scope, journal, context);
      await scope.portability.advanceLifecycleJournal({
        expectedPhase: 'cancel-intent',
        expectedState: 'active',
        nextPhase: 'cancelled',
        nextState: 'cancelled',
        operationId: journal.operationId,
        scheduledAt: journal.scheduledAt,
        updatedAt,
      });
      await scope.advanceProjectAuthorityState({
        expectedAuthorityGeneration: project.authorityGeneration,
        expectedAuthorityStateRevision: project.authorityStateRevision,
        expectedServiceState: 'maintenance',
        nextAuthorityGeneration: project.authorityGeneration,
        nextServiceState: 'active',
      });
    });
  }

  async #requestCancellation(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
  ): Promise<ProjectLifecycleJournalRecord> {
    if (
      journal.state !== 'active'
      || journal.phase === 'artifact-published'
      || journal.phase === 'completed'
      || journal.phase === 'cancelled'
    ) fail('state-conflict');
    if (journal.phase === 'cancel-intent') return journal;
    const context = await this.#context(lease, journal);
    const updatedAt = clockTimestamp(this.#clock);
    await lease.withProjectScope(async scope => {
      await this.#revalidateContext(scope, journal, context);
      await scope.portability.advanceLifecycleJournal({
        expectedPhase: journal.phase,
        expectedState: 'active',
        nextPhase: 'cancel-intent',
        nextState: 'active',
        operationId: journal.operationId,
        scheduledAt: journal.scheduledAt,
        updatedAt,
      });
    });
    return this.#exactJournal(
      lease,
      journal.operationId,
      journal.kind as BackupExportProfile,
    );
  }

  async #markRecoveryRequired(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    context: ExactCheckpointContext,
  ): Promise<void> {
    const updatedAt = clockTimestamp(this.#clock);
    await lease.withProjectScope(async scope => {
      await this.#revalidateContext(scope, journal, context);
      await scope.portability.advanceLifecycleJournal({
        expectedPhase: journal.phase,
        expectedState: 'active',
        nextPhase: journal.phase,
        nextState: 'recovery-required',
        operationId: journal.operationId,
        recoveryFromPhase: journal.phase,
        scheduledAt: journal.scheduledAt,
        updatedAt,
      });
    });
  }

  async #complete(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    context: ExactCheckpointContext,
  ): Promise<ProjectLifecycleJournalRecord> {
    const resultSha256 = journal.resultSha256;
    if (resultSha256 === undefined) fail('state-conflict');
    this.#result(journal, journal.scheduledAt);
    const updatedAt = clockTimestamp(this.#clock);
    await lease.withProjectScope(async scope => {
      const project = await this.#revalidateContext(scope, journal, context);
      await scope.portability.advanceLifecycleJournal({
        expectedPhase: 'artifact-published',
        expectedState: 'active',
        nextPhase: 'completed',
        nextState: 'completed',
        operationId: journal.operationId,
        resultSha256,
        scheduledAt: journal.scheduledAt,
        updatedAt,
      });
      await scope.advanceProjectAuthorityState({
        expectedAuthorityGeneration: project.authorityGeneration,
        expectedAuthorityStateRevision: project.authorityStateRevision,
        expectedServiceState: 'maintenance',
        nextAuthorityGeneration: project.authorityGeneration,
        nextServiceState: 'active',
      });
    });
    return this.#exactJournal(
      lease,
      journal.operationId,
      journal.kind as BackupExportProfile,
    );
  }

  async #context(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
  ): Promise<ExactCheckpointContext> {
    return lease.withProjectScope(async scope => {
      const project = await scope.getProject();
      const placement = await scope.getRepositoryPlacement();
      if (
        project?.serviceState !== 'maintenance'
        || project.authorityGeneration !== journal.expectedAuthorityGeneration
        || placement?.active !== true
        || placement.projectId !== journal.projectId
      ) fail('state-conflict');
      if (journal.requestFingerprint !== durablePreparedFingerprint({
        authorityGeneration: project.authorityGeneration,
        createdAt: journal.createdAt,
        expectedMainOid: project.expectedMainOid,
        expiresAt: journal.scheduledAt,
        metadata: this.#metadata,
        operationId: journal.operationId,
        placement,
        profile: journal.kind as BackupExportProfile,
        projectId: journal.projectId,
      })) fail('state-conflict');
      return Object.freeze({
        placement,
        project: Object.freeze({
          authorityGeneration: project.authorityGeneration,
          authorityStateRevision: project.authorityStateRevision,
          expectedMainOid: project.expectedMainOid,
          serviceState: 'maintenance' as const,
        }),
      });
    });
  }

  async #revalidateContext(
    scope: ProjectScope,
    journal: ProjectLifecycleJournalRecord,
    context: ExactCheckpointContext,
  ) {
    const project = await scope.getProject();
    const placement = await scope.getRepositoryPlacement();
    if (
      project?.serviceState !== 'maintenance'
      || project.authorityGeneration !== journal.expectedAuthorityGeneration
      || project.authorityStateRevision !== context.project.authorityStateRevision
      || placement === undefined
      || !sameRepositoryPlacement(placement, context.placement)
    ) fail('state-conflict');
    return project;
  }

  async #exactJournal(
    lease: PinnedProjectLease,
    operationId: string,
    profile: BackupExportProfile,
  ): Promise<ProjectLifecycleJournalRecord> {
    const journal = await lease.withProjectScope(scope => (
      scope.portability.getLifecycleJournal(operationId)
    ));
    if (journal === undefined) fail('dependency-failed');
    exactJournal(journal, {
      operationId,
      profile,
      projectId: journal.projectId,
    });
    return journal;
  }

  #result(
    journal: ProjectLifecycleJournalRecord,
    expiresAt: CollabIsoTimestamp,
  ): BackupExportResult {
    const checkpointSha256 = journal.checkpointSha256;
    if (checkpointSha256 === undefined) fail('invalid-checkpoint');
    if (journal.kind !== 'backup' && journal.kind !== 'export') {
      fail('state-conflict');
    }
    const result = Object.freeze({
      checkpointSha256,
      createdAt: journal.createdAt,
      expiresAt,
      operationId: journal.operationId,
      profile: journal.kind,
      projectId: journal.projectId,
      state: 'published' as const,
    });
    if (
      journal.resultSha256 !== undefined
      && journal.resultSha256 !== sha256(JSON.stringify(result))
    ) fail('state-conflict');
    return result;
  }
}
