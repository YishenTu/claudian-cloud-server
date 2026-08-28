import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CollabProjectBackupCheckpointManifest,
  CollabProjectCheckpointManifest,
} from '@claudian-collab/protocol';

import type {
  ProjectBackupCatalogInput,
  ProjectBackupCatalogRecord,
  ProjectLifecycleJournalRecord,
} from '../../src/coordination/PortabilityLifecyclePersistence.js';
import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import type {
  ProjectCheckpointRecord,
} from '../../src/coordination/ProjectCheckpointPersistence.js';
import {
  BackupExportCoordinator,
  BackupExportCoordinatorError,
} from '../../src/project-authority/checkpoint/BackupExportCoordinator.js';
import type {
  CaptureOutboundProjectCheckpointInput,
  CapturedOutboundProjectCheckpoint,
  OutboundProjectCheckpointRecord,
} from '../../src/project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import { ProjectCheckpointCoordinatorError } from '../../src/project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

const CREATED_AT = '2026-08-28T00:00:00.000Z';
const EXPIRES_AT = '2026-08-29T00:00:00.000Z';
const MAIN_OID = '1'.repeat(40);
const MEMBER_OID = '2'.repeat(40);
const CHECKPOINT_SHA256 = 'a'.repeat(64);

function sourceRecords(): readonly ProjectCheckpointRecord[] {
  return Object.freeze([
    Object.freeze({
      kind: 'project' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        authorityGeneration: 3,
        createdAt: CREATED_AT,
        expectedMainOid: MAIN_OID,
        managerSetGeneration: 1,
        name: 'Project A',
        projectId: 'project-a',
      }),
    }),
    Object.freeze({
      kind: 'member' as const,
      recordId: 'member-manager',
      revision: 1,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Manager',
        memberId: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        projectId: 'project-a',
        role: 'manager' as const,
        status: 'active' as const,
        revokedAt: null,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'cloud-event-cursor' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        currentSequence: 0,
        projectId: 'project-a',
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'lifecycle-journal' as const,
      recordId: 'backup-previous',
      revision: 1,
      value: Object.freeze({
        actorMemberId: null,
        batchRevision: null,
        batchSha256: null,
        checkpointSha256: '9'.repeat(64),
        createdAt: CREATED_AT,
        direction: null,
        expectedAuthorityGeneration: 3,
        expectedPersonalRefOid: null,
        idempotencyKey: 'backup-previous',
        operationId: 'backup-previous',
        operationKind: 'backup' as const,
        phase: 'completed',
        projectId: 'project-a',
        recoveryFromPhase: null,
        requestFingerprint: '8'.repeat(64),
        resultSha256: '9'.repeat(64),
        scheduledAt: EXPIRES_AT,
        state: 'completed' as const,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'terminal-responder' as const,
      recordId: 'retire-terminal',
      revision: 1,
      value: Object.freeze({
        acknowledgements: Object.freeze([]),
        eligibleMemberIds: Object.freeze(['member-manager']),
        expiresAt: EXPIRES_AT,
        operation: 'retireProject' as const,
        operationId: 'retire-terminal',
        projectId: 'project-a',
        responseJson: '{}',
      }),
    }),
    Object.freeze({
      kind: 'protected-claim-envelope' as const,
      recordId: 'transfer-a:member-manager',
      revision: 1,
      value: Object.freeze({
        associatedData: Object.freeze({
          authorityGeneration: 3,
          checkpointSha256: 'b'.repeat(64),
          claimSha256: 'c'.repeat(64),
          envelopeVersion: 1 as const,
          environmentIdentity: 'environment-a',
          memberId: 'member-manager',
          projectId: 'project-a',
          transferId: 'transfer-a',
        }),
        associatedDataSha256: 'd'.repeat(64),
        ciphertext: 'Y2lwaGVydGV4dA',
        encryptionAlgorithm: 'xchacha20-poly1305' as const,
        expiresAt: EXPIRES_AT,
        keyId: 'custody-key-a',
        keyVersion: 1,
        memberId: 'member-manager',
        nonce: 'e'.repeat(32),
        receiptKeyId: 'receipt-key-a',
        tag: 'f'.repeat(22),
        transferId: 'transfer-a',
      }),
    }),
    Object.freeze({
      kind: 'schema-catalog' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        coordinationSchemaVersion: 9,
        projectId: 'project-a',
        repositoryFormatVersion: 1,
      }),
    }),
    Object.freeze({
      kind: 'server-compatibility' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        maximumBuild: 'cloud-build-a',
        minimumBuild: 'cloud-build-a',
        projectId: 'project-a',
      }),
    }),
    Object.freeze({
      kind: 'authority-volume-pair' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        authorityId: 'authority-a',
        authorityVolumeIdentity: 'authority-volume-a',
        projectId: 'project-a',
        restoreEpoch: 1,
      }),
    }),
  ]);
}

function capturedCheckpoint(
  input: CaptureOutboundProjectCheckpointInput,
): CapturedOutboundProjectCheckpoint {
  const manifest = input.profile === 'backup' ? Object.freeze({
    artifacts: Object.freeze([
      Object.freeze({
        byteCount: 10,
        name: 'coordination.ndjson' as const,
        sha256: '3'.repeat(64),
      }),
      Object.freeze({
        byteCount: 20,
        name: 'repository.bundle' as const,
        sha256: '4'.repeat(64),
      }),
    ]),
    coordinationFormatVersion: 2 as const,
    createdAt: input.createdAt,
    expectedMainOid: MAIN_OID,
    gitObjectFormat: 'sha1' as const,
    manifestSchemaVersion: 1 as const,
    manifestSha256: CHECKPOINT_SHA256,
    operationId: input.operationId,
    profile: 'backup' as const,
    projectId: input.projectId,
    protocolVersion: 6 as const,
    refs: input.refs,
    sourceAuthority: input.sourceAuthority,
    targetAuthority: null,
  }) satisfies CollabProjectBackupCheckpointManifest : Object.freeze({
    artifacts: Object.freeze([
      Object.freeze({
        byteCount: 10,
        name: 'coordination.ndjson' as const,
        sha256: '3'.repeat(64),
      }),
      Object.freeze({
        byteCount: 20,
        name: 'repository.bundle' as const,
        sha256: '4'.repeat(64),
      }),
    ]),
    coordinationFormatVersion: 1 as const,
    createdAt: input.createdAt,
    expectedMainOid: MAIN_OID,
    gitObjectFormat: 'sha1' as const,
    manifestSchemaVersion: 1 as const,
    manifestSha256: CHECKPOINT_SHA256,
    operationId: input.operationId,
    profile: 'export' as const,
    projectId: input.projectId,
    protocolVersion: 6 as const,
    refs: input.refs,
    sourceAuthority: input.sourceAuthority,
    targetAuthority: null,
  }) satisfies CollabProjectCheckpointManifest;
  return Object.freeze({
    attempt: Object.freeze({
      attemptKey: '5'.repeat(64),
      expiresAt: input.expiresAt,
      operationId: input.operationId,
      projectId: input.projectId,
    }),
    manifest,
    records: input.records,
    repository: Object.freeze({
      artifactKey: '6'.repeat(64),
      byteCount: 20,
      objectFormat: 'sha1' as const,
      operationId: input.operationId,
      placementGeneration: input.placement.generation,
      projectId: input.projectId,
      refs: input.refs,
      sha256: '4'.repeat(64),
    }),
  });
}

type FailOnceAt =
  | 'artifact-published'
  | 'checkpoint-verified'
  | 'coordination-captured'
  | 'prepared'
  | 'repository-captured';

function harness(options: Readonly<{
  readonly breakLeaseOnSnapshotAbort?: boolean;
  readonly clock?: () => Date;
  readonly failBrokenPrimaryLeaseClose?: boolean;
  readonly failCancelCleanupOnce?: boolean;
  readonly failLeaseClose?: boolean;
  readonly failOnceAt?: FailOnceAt;
  readonly invalidCancelCleanup?: boolean;
  readonly invalidPublishedArtifact?: boolean;
  readonly priorRecovery?: 'accept' | 'bootstrap';
  readonly profile?: 'backup' | 'export';
  readonly records?: readonly ProjectCheckpointRecord[];
  readonly stallPublishedVerification?: boolean;
  readonly waitForSnapshotAbort?: boolean;
  readonly waitForAbortAt?: FailOnceAt;
  readonly waitForRecovery?: boolean;
}> = {}) {
  const events: string[] = [];
  const admissionEvents: string[] = [];
  const profile = options.profile ?? 'backup';
  let serviceState = 'active' as 'active' | 'maintenance';
  let tombstoned = false;
  let authorityStateRevision = 7;
  let journal: ProjectLifecycleJournalRecord | undefined;
  let backup: ProjectBackupCatalogRecord | undefined;
  let failureConsumed = false;
  let waitForAbortAt = options.waitForAbortAt;
  let waitForAbortConsumed = false;
  let cancelCleanupFailureConsumed = false;
  let captureCalls = 0;
  let leaseAcquisitions = 0;
  let publishedVerifyCalls = 0;
  const publishedVerificationReleases = new Set<() => void>();
  let reservationCloses = 0;
  let sourceCalls = 0;
  let releaseRecoveryGate: (() => void) | undefined;
  const recoveryGate = options.waitForRecovery
    ? new Promise<void>(resolve => { releaseRecoveryGate = resolve; })
    : Promise.resolve();
  let frozenRecords: readonly OutboundProjectCheckpointRecord[] | undefined;
  let dueDeliveries: ReadonlyArray<Readonly<{
    readonly attemptKey: string;
    readonly expiresAt: string;
    readonly operationId: string;
    readonly projectId: string;
  }>> = Object.freeze([]);
  const captureInputs: CaptureOutboundProjectCheckpointInput[] = [];
  let placement = createRepositoryPlacementLease({
    active: true,
    generation: 11,
    projectId: 'project-a',
    repositoryStorageKey: 'repository-a',
    storageNodeId: 'node-a',
  });
  const portability = {
    advanceBackupCatalogEntry(input: Readonly<{
      readonly backupId: string;
      readonly expectedState: ProjectBackupCatalogRecord['state'];
      readonly nextState: ProjectBackupCatalogRecord['state'];
      readonly updatedAt: string;
    }>) {
      assert.ok(backup);
      assert.equal(backup.backupId, input.backupId);
      assert.equal(backup.state, input.expectedState);
      backup = Object.freeze({
        ...backup,
        publishedAt: input.nextState === 'published'
          ? input.updatedAt
          : backup.publishedAt,
        state: input.nextState,
        verifiedAt: input.nextState === 'verified'
          ? input.updatedAt
          : backup.verifiedAt,
      });
      events.push(`catalog:${input.nextState}`);
      return Promise.resolve('advanced' as const);
    },
    advanceLifecycleJournal(input: Readonly<{
      readonly checkpointSha256?: string;
      readonly expectedPhase: string;
      readonly expectedState: ProjectLifecycleJournalRecord['state'];
      readonly nextPhase: string;
      readonly nextState: ProjectLifecycleJournalRecord['state'];
      readonly operationId: string;
      readonly recoveryFromPhase?: string;
      readonly resultSha256?: string;
      readonly scheduledAt: string;
      readonly updatedAt: string;
    }>) {
      assert.ok(journal);
      assert.equal(journal.operationId, input.operationId);
      assert.equal(journal.phase, input.expectedPhase);
      assert.equal(journal.state, input.expectedState);
      journal = Object.freeze({
        ...journal,
        checkpointSha256: input.checkpointSha256 ?? journal.checkpointSha256,
        phase: input.nextPhase,
        recoveryFromPhase: input.recoveryFromPhase,
        resultSha256: input.resultSha256 ?? journal.resultSha256,
        scheduledAt: input.scheduledAt,
        state: input.nextState,
        updatedAt: input.updatedAt,
      });
      events.push(`journal:${input.nextPhase}`);
      return Promise.resolve('advanced' as const);
    },
    getBackupCatalogEntry(backupId: string) {
      return Promise.resolve(backup?.backupId === backupId ? backup : undefined);
    },
    getLifecycleJournal(operationId: string) {
      return Promise.resolve(
        journal?.operationId === operationId ? journal : undefined,
      );
    },
    getNonterminalLifecycleJournal() {
      return Promise.resolve(
        journal?.state === 'active' || journal?.state === 'recovery-required'
          ? journal
          : undefined,
      );
    },
    getProjectTombstone: () => Promise.resolve(
      tombstoned ? Object.freeze({ projectId: 'project-a' }) as never : undefined,
    ),
    putBackupCatalogEntry(input: ProjectBackupCatalogInput) {
      assert.equal(backup, undefined);
      backup = Object.freeze({
        ...input,
        publishedAt: undefined,
        state: 'captured' as const,
        verifiedAt: undefined,
      });
      events.push('catalog:captured');
      return Promise.resolve('created' as const);
    },
    putLifecycleJournal(input: Readonly<{
      readonly actorMemberId: string | undefined;
      readonly createdAt: string;
      readonly direction: undefined;
      readonly expectedAuthorityGeneration: number;
      readonly idempotencyKey: string;
      readonly kind: 'backup' | 'export';
      readonly operationId: string;
      readonly phase: string;
      readonly projectId: string;
      readonly requestFingerprint: string;
      readonly scheduledAt: string;
    }>) {
      assert.equal(journal, undefined);
      journal = Object.freeze({
        ...input,
        batchRevision: undefined,
        batchSha256: undefined,
        checkpointSha256: undefined,
        recoveryFromPhase: undefined,
        resultSha256: undefined,
        state: 'active' as const,
        updatedAt: input.createdAt,
      });
      events.push('journal:prepared');
      return Promise.resolve('created' as const);
    },
  };
  const scope = {
    accept: {
      getNonterminal: () => Promise.resolve(
        options.priorRecovery === 'accept' ? Object.freeze({}) as never : undefined,
      ),
    },
    advanceProjectAuthorityState(input: Readonly<{
      readonly expectedAuthorityGeneration: number;
      readonly expectedAuthorityStateRevision: number;
      readonly expectedServiceState: 'active' | 'maintenance';
      readonly nextAuthorityGeneration: number;
      readonly nextServiceState: 'active' | 'maintenance';
    }>) {
      assert.equal(input.expectedAuthorityGeneration, 3);
      assert.equal(input.nextAuthorityGeneration, 3);
      assert.equal(authorityStateRevision, input.expectedAuthorityStateRevision);
      assert.equal(serviceState, input.expectedServiceState);
      authorityStateRevision += 1;
      serviceState = input.nextServiceState;
      events.push(`service:${serviceState}`);
      return Promise.resolve('advanced' as const);
    },
    getProject() {
      return Promise.resolve(Object.freeze({
        activatedAt: CREATED_AT,
        authorityGeneration: 3,
        authorityStateRevision,
        createdAt: CREATED_AT,
        expectedMainOid: MAIN_OID,
        managerSetGeneration: 1,
        projectId: 'project-a',
        projectName: 'Project A',
        serviceState,
      }));
    },
    getRepositoryPlacement: () => Promise.resolve(placement),
    getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(
      options.priorRecovery === 'bootstrap'
        ? Object.freeze({}) as never
        : undefined,
    ),
    portability,
  } as unknown as ProjectScope;
  let primaryLeaseBroken = false;
  const projectLease = (primary: boolean): PinnedProjectLease => ({
    close: () => options.failLeaseClose
      || primary && primaryLeaseBroken && options.failBrokenPrimaryLeaseClose
      ? Promise.reject(new Error('lease-close-failed'))
      : Promise.resolve(),
    drainDevelopmentBootstrapUploads: () => Promise.resolve(),
    handoffToDevelopmentBootstrapUpload: () => Promise.reject(
      new Error('unexpected-upload-handoff'),
    ),
    withProjectScope: <Value>(operation: (value: ProjectScope) => Promise<Value>) => {
      if (primary && primaryLeaseBroken) {
        return Promise.reject(new Error('lease-client-destroyed'));
      }
      return operation(scope);
    },
  });
  const lease = projectLease(true);
  const records = options.records ?? sourceRecords();
  const failOnce = (phase: FailOnceAt): boolean => {
    if (options.failOnceAt !== phase || failureConsumed) return false;
    failureConsumed = true;
    return true;
  };
  const waitForAbort = (
    phase: FailOnceAt,
    signal: AbortSignal,
  ): Promise<void> => {
    if (waitForAbortAt !== phase || waitForAbortConsumed) {
      return Promise.resolve();
    }
    waitForAbortConsumed = true;
    return new Promise((_resolve, reject) => {
      const onAbort = (): void => reject(new Error('checkpoint-attempt-aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  };
  const checkpoint = {
    async captureOutbound(input: CaptureOutboundProjectCheckpointInput) {
      captureCalls += 1;
      captureInputs.push(input);
      frozenRecords ??= input.records;
      const signal = input.signal;
      assert.ok(signal);
      events.push(`capture:${input.profile}`);
      await input.onProgress('coordination-captured', undefined);
      await waitForAbort('coordination-captured', signal);
      if (failOnce('coordination-captured')) {
        throw new ProjectCheckpointCoordinatorError('storage-unavailable');
      }
      await input.onProgress('repository-captured', undefined);
      await waitForAbort('repository-captured', signal);
      if (failOnce('repository-captured')) {
        throw new ProjectCheckpointCoordinatorError('storage-unavailable');
      }
      await input.onProgress('checkpoint-verified', CHECKPOINT_SHA256);
      await waitForAbort('checkpoint-verified', signal);
      if (failOnce('checkpoint-verified')) {
        throw new ProjectCheckpointCoordinatorError('storage-unavailable');
      }
      return capturedCheckpoint(input);
    },
    discardOutbound() {
      events.push('checkpoint:discarded');
      return Promise.resolve();
    },
    discardOutboundOperation() {
      if (options.invalidCancelCleanup) {
        return Promise.reject(
          new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
        );
      }
      if (options.failCancelCleanupOnce && !cancelCleanupFailureConsumed) {
        cancelCleanupFailureConsumed = true;
        return Promise.reject(
          new ProjectCheckpointCoordinatorError('storage-unavailable'),
        );
      }
      events.push('checkpoint:operation-discarded');
      dueDeliveries = Object.freeze([]);
      return Promise.resolve();
    },
    listDueOutboundDeliveries(input: Readonly<{
      readonly expiredBefore: string;
    }>) {
      return Promise.resolve(Object.freeze({
        deliveries: Object.freeze(dueDeliveries.filter(
          delivery => delivery.expiresAt <= input.expiredBefore,
        )),
        nextCursor: undefined,
      }));
    },
    publishOutbound() {
      events.push('checkpoint:published');
      return Promise.resolve();
    },
    readOutboundRecords() {
      if (frozenRecords === undefined) {
        return Promise.reject(new Error('missing-frozen-records'));
      }
      return Promise.resolve(frozenRecords);
    },
    readPublishedOutboundRecords() {
      if (frozenRecords === undefined) {
        return Promise.reject(new Error('missing-frozen-records'));
      }
      return Promise.resolve(frozenRecords);
    },
    releaseOutbound() {
      if (waitForAbortAt === 'artifact-published') {
        const signal = captureInputs.at(-1)?.signal;
        assert.ok(signal);
        return waitForAbort('artifact-published', signal);
      }
      if (failOnce('artifact-published')) {
        events.push('checkpoint:release-failed');
        return Promise.reject(
          new ProjectCheckpointCoordinatorError('storage-unavailable'),
        );
      }
      events.push('checkpoint:released');
      return Promise.resolve();
    },
    releaseOutboundOperation() {
      events.push('checkpoint:operation-released');
      return Promise.resolve();
    },
    registerOutboundDelivery(input: Readonly<{
      readonly expiresAt: string;
      readonly operationId: string;
      readonly projectId: string;
    }>) {
      const existing = dueDeliveries.find(delivery => (
        delivery.operationId === input.operationId
        && delivery.projectId === input.projectId
      ));
      if (existing !== undefined) return Promise.resolve('replayed' as const);
      dueDeliveries = Object.freeze([...dueDeliveries, Object.freeze({
        attemptKey: '5'.repeat(64),
        ...input,
      })]);
      events.push('checkpoint:delivery-registered');
      return Promise.resolve('registered' as const);
    },
    reserveOutbound(projectId: string) {
      admissionEvents.push('repository-reserved');
      const repositoryReservation = Object.freeze({
        close: () => Promise.resolve(),
        projectId,
      });
      return Promise.resolve(Object.freeze({
        maximumCoordinationBytes: 1024 * 1024,
        close: () => {
          reservationCloses += 1;
          return Promise.resolve();
        },
        projectId,
        repositoryReservation,
      }));
    },
    async verifyOutboundOperation(
      _input: unknown,
      _reservation: unknown,
      signal?: AbortSignal,
    ) {
      publishedVerifyCalls += 1;
      events.push('checkpoint:published-verified');
      if (options.stallPublishedVerification) {
        assert.ok(signal);
        await new Promise<void>((resolve, reject) => {
          const finish = (): void => {
            signal.removeEventListener('abort', onAbort);
            publishedVerificationReleases.delete(release);
          };
          const onAbort = (): void => {
            finish();
            reject(new Error('published-verification-aborted'));
          };
          const release = (): void => {
            finish();
            resolve();
          };
          publishedVerificationReleases.add(release);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      }
      if (waitForAbortAt === 'artifact-published') {
        assert.ok(signal);
        await waitForAbort('artifact-published', signal);
      }
      if (options.invalidPublishedArtifact) {
        throw new ProjectCheckpointCoordinatorError('invalid-checkpoint');
      }
    },
  };
  const source = {
      snapshot(input) {
        sourceCalls += 1;
        assert.equal(serviceState, 'maintenance');
        assert.equal(input.profile, profile);
        if (options.waitForSnapshotAbort || options.waitForAbortAt === 'prepared') {
          return new Promise((_resolve, reject) => {
            const onAbort = (): void => reject(new Error(
              'snapshot-attempt-aborted',
            ));
            if (options.breakLeaseOnSnapshotAbort) {
              input.signal.addEventListener(
                'abort',
                () => { primaryLeaseBroken = true; },
                { once: true },
              );
            }
            input.signal.addEventListener('abort', onAbort, { once: true });
            if (input.signal.aborted) onAbort();
          });
        }
        if (failOnce('prepared')) {
          return Promise.reject(new Error('injected-source-failure'));
        }
        return Promise.resolve(Object.freeze({
          records,
          refs: Object.freeze([
            Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
            Object.freeze({
              name: 'refs/heads/members/member-manager',
              oid: MEMBER_OID,
            }),
          ]),
        }));
      },
    } satisfies ConstructorParameters<typeof BackupExportCoordinator>[0]['source'];
  const createCoordinator = (
    metadata: Readonly<{
      readonly authorityVolumeIdentity?: string;
      readonly serverBuild?: string;
    }> = {},
  ): BackupExportCoordinator => new BackupExportCoordinator({
    checkpoint,
    clock: options.clock ?? (() => new Date(CREATED_AT)),
    coordination: {
      acquireProjectLease: () => {
        admissionEvents.push('project-lease');
        leaseAcquisitions += 1;
        return Promise.resolve(
          options.breakLeaseOnSnapshotAbort && leaseAcquisitions > 1
            ? projectLease(false)
            : lease,
        );
      },
    },
    metadata: Object.freeze({
      authorityId: 'authority-a',
      authorityVolumeIdentity:
        metadata.authorityVolumeIdentity ?? 'authority-volume-a',
      coordinationSchemaVersion: 9,
      repositoryFormatVersion: 1,
      restoreEpoch: 1,
      serverBuild: metadata.serverBuild ?? 'cloud-build-a',
    }),
    recovery: {
      recoverProject: () => {
        admissionEvents.push('recovery');
        return recoveryGate;
      },
    },
    source,
  });
  const coordinator = createCoordinator();
  return {
    admissionEvents,
    coordinator,
    corruptBackup() {
      assert.ok(backup);
      backup = Object.freeze({
        ...backup,
        checkpointSha256: '0'.repeat(64),
      });
    },
    corruptBackupMetadata() {
      assert.ok(backup);
      backup = Object.freeze({
        ...backup,
        serverBuild: 'contradictory-build',
      });
    },
    events,
    get backup() { return backup; },
    get captureCalls() { return captureCalls; },
    captureInputs,
    get journal() { return journal; },
    lease,
    get leaseAcquisitions() { return leaseAcquisitions; },
    get publishedVerifyCalls() { return publishedVerifyCalls; },
    get reservationCloses() { return reservationCloses; },
    releaseRecovery() { releaseRecoveryGate?.(); },
    releasePublishedVerifications() {
      for (const release of [...publishedVerificationReleases]) release();
    },
    restart: createCoordinator,
    get serviceState() { return serviceState; },
    get sourceCalls() { return sourceCalls; },
    replaceProjectWithTombstone() {
      journal = undefined;
      tombstoned = true;
    },
    setWaitForAbortAt(phase: FailOnceAt | undefined) {
      waitForAbortAt = phase;
      waitForAbortConsumed = false;
    },
    replacePlacementGeneration(generation: number) {
      placement = createRepositoryPlacementLease({
        active: true,
        generation,
        projectId: 'project-a',
        repositoryStorageKey: 'repository-a',
        storageNodeId: 'node-a',
      });
    },
  };
}

async function expectCoordinatorError(
  operation: Promise<unknown>,
  code: BackupExportCoordinatorError['code'],
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof BackupExportCoordinatorError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('BackupExportCoordinator', () => {
  it('starts the full attempt budget at durable journal creation', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const test = harness({
      waitForRecovery: true,
      waitForSnapshotAbort: true,
    });
    const pending = test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-delayed-admission',
      profile: 'backup',
      projectId: 'project-a',
    });
    const outcome = pending.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    );
    for (
      let turn = 0;
      !test.admissionEvents.includes('recovery') && turn < 100;
      turn += 1
    ) await Promise.resolve();

    t.mock.timers.tick(4 * 60 * 1_000);
    test.releaseRecovery();
    for (let turn = 0; test.sourceCalls === 0 && turn < 100; turn += 1) {
      await Promise.resolve();
    }
    assert.equal(test.sourceCalls, 1);

    t.mock.timers.tick(60 * 1_000);
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    assert.equal(await Promise.race([
      outcome,
      Promise.resolve('pending' as const),
    ]), 'pending');

    t.mock.timers.tick(4 * 60 * 1_000);
    await expectCoordinatorError(pending, 'timeout');
    assert.equal(test.journal?.state, 'cancelled');
    assert.equal(test.serviceState, 'active');
    await test.coordinator.close();
  });

  it('reacquires the Project lease when snapshot cancellation destroys its client', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const test = harness({
      breakLeaseOnSnapshotAbort: true,
      waitForSnapshotAbort: true,
    });
    const pending = test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-snapshot-timeout',
      profile: 'backup',
      projectId: 'project-a',
    });
    for (let turn = 0; test.sourceCalls === 0 && turn < 100; turn += 1) {
      await Promise.resolve();
    }

    t.mock.timers.tick(5 * 60 * 1_000);
    await expectCoordinatorError(pending, 'timeout');

    assert.equal(test.leaseAcquisitions, 2);
    assert.equal(test.journal?.state, 'cancelled');
    assert.equal(test.serviceState, 'active');
    await test.coordinator.close();
  });

  it('reacquires after the destroyed snapshot lease also fails to close', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const test = harness({
      breakLeaseOnSnapshotAbort: true,
      failBrokenPrimaryLeaseClose: true,
      waitForSnapshotAbort: true,
    });
    const pending = test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-broken-close-timeout',
      profile: 'backup',
      projectId: 'project-a',
    });
    for (let turn = 0; test.sourceCalls === 0 && turn < 100; turn += 1) {
      await Promise.resolve();
    }

    t.mock.timers.tick(5 * 60 * 1_000);
    await expectCoordinatorError(pending, 'timeout');

    assert.equal(test.leaseAcquisitions, 2);
    assert.equal(test.journal?.state, 'cancelled');
    assert.equal(test.serviceState, 'active');
    await test.coordinator.close();
  });

  it('leaves a timed-out published artifact for the next bounded recovery run', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const test = harness({
      failOnceAt: 'artifact-published',
      stallPublishedVerification: true,
    });
    await expectCoordinatorError(test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-published-timeout',
      profile: 'backup',
      projectId: 'project-a',
    }), 'dependency-failed');
    const journal = test.journal;
    assert.ok(journal);
    assert.equal(journal.phase, 'artifact-published');
    const pending = test.coordinator.recover({
      journal,
      lease: test.lease,
      repositoryReservation: await test.coordinator.reserveRecovery(
        'project-a',
      ),
    });
    for (
      let turn = 0;
      test.publishedVerifyCalls === 0 && turn < 1_000;
      turn += 1
    ) await Promise.resolve();
    assert.equal(test.publishedVerifyCalls, 1);

    t.mock.timers.tick(5 * 60 * 1_000);
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    try {
      assert.equal(test.publishedVerifyCalls, 1);
      assert.equal(test.journal.phase, 'artifact-published');
      assert.equal(test.serviceState, 'maintenance');
    } finally {
      test.releasePublishedVerifications();
      await pending.catch(() => undefined);
      await test.coordinator.close();
    }
  });

  it('enforces a non-overridable five-minute attempt budget', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const test = harness({ waitForSnapshotAbort: true });
    const external = new AbortController();
    const pending = test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-timeout',
      profile: 'backup',
      projectId: 'project-a',
      signal: external.signal,
    });
    for (let turn = 0; test.sourceCalls === 0 && turn < 100; turn += 1) {
      await Promise.resolve();
    }
    assert.equal(test.sourceCalls, 1);

    t.mock.timers.tick(5 * 60 * 1_000);
    await Promise.resolve();

    await expectCoordinatorError(pending, 'timeout');
    assert.equal(test.journal?.phase, 'cancelled');
    assert.equal(test.journal.state, 'cancelled');
    assert.equal(test.serviceState, 'active');
    assert.ok(test.events.includes('checkpoint:operation-discarded'));
    await test.coordinator.close();
  });

  it('persists timeout cleanup intent before an ambiguous cleanup retry', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const test = harness({
      failCancelCleanupOnce: true,
      waitForSnapshotAbort: true,
    });
    const pending = test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-timeout-cleanup',
      profile: 'backup',
      projectId: 'project-a',
    });
    for (let turn = 0; test.sourceCalls === 0 && turn < 100; turn += 1) {
      await Promise.resolve();
    }

    t.mock.timers.tick(5 * 60 * 1_000);
    await expectCoordinatorError(pending, 'timeout');

    assert.equal(test.journal?.phase, 'cancel-intent');
    assert.equal(test.journal.state, 'active');
    assert.equal(test.serviceState, 'maintenance');
    await test.coordinator.close();
  });

  it('settles the exact timeout boundary after every durable capture phase', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const phase of [
      'prepared',
      'coordination-captured',
      'repository-captured',
      'checkpoint-verified',
      'artifact-published',
    ] as const) {
      const test = harness({ waitForAbortAt: phase });
      const pending = test.coordinator.create({
        expiresAt: EXPIRES_AT,
        operationId: `backup-timeout-${phase}`,
        profile: 'backup',
        projectId: 'project-a',
      });
      for (let turn = 0; turn < 100; turn += 1) {
        if (
          phase === 'prepared'
            ? test.sourceCalls > 0
            : test.events.includes(
              phase === 'artifact-published'
                ? 'journal:artifact-published'
                : `journal:${phase}`,
            )
        ) break;
        await Promise.resolve();
      }

      t.mock.timers.tick(5 * 60 * 1_000);
      await expectCoordinatorError(pending, 'timeout');

      if (phase === 'artifact-published') {
        const published = test.journal;
        assert.ok(published);
        assert.equal(published.state, 'active');
        assert.equal(published.phase, 'artifact-published');
        assert.equal(test.serviceState, 'maintenance');
        assert.equal(await test.coordinator.recover({
          journal: published,
          lease: test.lease,
          repositoryReservation: await test.coordinator.reserveRecovery(
            'project-a',
          ),
        }), 'settled');
        assert.equal(test.journal.state, 'completed');
        assert.equal(test.serviceState, 'active');
      } else {
        assert.equal(test.journal?.state, 'cancelled');
        assert.equal(test.serviceState, 'active');
      }
      await test.coordinator.close();
    }
  });

  it('settles cleanup with a fresh signal and bounds each forward recovery run', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const phase of [
      'checkpoint-verified',
      'artifact-published',
    ] as const) {
      const test = harness({
        failOnceAt: phase === 'artifact-published'
          ? 'artifact-published'
          : 'repository-captured',
      });
      await expectCoordinatorError(test.coordinator.create({
        expiresAt: EXPIRES_AT,
        operationId: `backup-recovery-timeout-${phase}`,
        profile: 'backup',
        projectId: 'project-a',
      }), 'dependency-failed');
      test.setWaitForAbortAt(phase);
      const journal = test.journal;
      assert.ok(journal);
      const pending = test.coordinator.recover({
        journal,
        lease: test.lease,
        repositoryReservation: await test.coordinator.reserveRecovery(
          'project-a',
        ),
      });
      for (let turn = 0; turn < 100; turn += 1) {
        if (
          phase === 'checkpoint-verified'
            ? test.journal.phase === 'checkpoint-verified'
            : test.events.includes('checkpoint:published-verified')
        ) break;
        await Promise.resolve();
      }

      t.mock.timers.tick(5 * 60 * 1_000);
      await expectCoordinatorError(pending, 'timeout');

      if (phase === 'artifact-published') {
        const published = test.journal;
        assert.equal(published.state, 'active');
        assert.equal(published.phase, 'artifact-published');
        assert.equal(test.serviceState, 'maintenance');
        assert.equal(await test.coordinator.recover({
          journal: published,
          lease: test.lease,
          repositoryReservation: await test.coordinator.reserveRecovery(
            'project-a',
          ),
        }), 'settled');
        assert.equal(test.journal.state, 'completed');
        assert.equal(test.serviceState, 'active');
      } else {
        assert.equal(test.journal.state, 'cancelled');
        assert.equal(test.serviceState, 'active');
      }
      await test.coordinator.close();
    }
  });

  it('inherits only the persisted attempt-budget remainder after restart', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = new Date(CREATED_AT);
    const test = harness({
      clock: () => new Date(now),
      failOnceAt: 'repository-captured',
    });
    await expectCoordinatorError(test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-restart-deadline',
      profile: 'backup',
      projectId: 'project-a',
    }), 'dependency-failed');
    test.setWaitForAbortAt('checkpoint-verified');
    now = new Date('2026-08-28T00:04:59.000Z');
    const journal = test.journal;
    assert.ok(journal);
    const pending = test.coordinator.recover({
      journal,
      lease: test.lease,
      repositoryReservation: await test.coordinator.reserveRecovery(
        'project-a',
      ),
    });
    try {
      for (let turn = 0; turn < 100; turn += 1) {
        if (test.journal.phase === 'checkpoint-verified') break;
        await Promise.resolve();
      }
      t.mock.timers.tick(1_000);
      for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();

      assert.equal(test.journal.state, 'cancelled');
      await expectCoordinatorError(pending, 'timeout');
      assert.equal(test.serviceState, 'active');
    } finally {
      await test.coordinator.close();
      await pending.catch(() => undefined);
    }
  });

  it('does not prepare while an earlier Accept or bootstrap journal exists', async () => {
    for (const priorRecovery of ['accept', 'bootstrap'] as const) {
      const test = harness({ priorRecovery });
      await expectCoordinatorError(test.coordinator.create({
        expiresAt: EXPIRES_AT,
        operationId: 'backup-one',
        profile: 'backup',
        projectId: 'project-a',
      }), 'recovery-required');

      assert.equal(test.captureCalls, 0);
      assert.equal(test.serviceState, 'active');
      await test.coordinator.close();
    }
  });

  it('recovers and cancels frozen attempts after the server build changes', async () => {
    const cancellable = harness({ failOnceAt: 'prepared' });
    await expectCoordinatorError(cancellable.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-build-change-cancel',
      profile: 'backup',
      projectId: 'project-a',
    }), 'dependency-failed');
    await cancellable.coordinator.close();

    const cancellationOwner = cancellable.restart({
      serverBuild: 'cloud-build-b',
    });
    assert.equal(await cancellationOwner.cancel({
      operationId: 'backup-build-change-cancel',
      profile: 'backup',
      projectId: 'project-a',
    }), 'cancelled');
    assert.equal(cancellable.serviceState, 'active');
    await cancellationOwner.close();

    const published = harness({ failOnceAt: 'artifact-published' });
    await expectCoordinatorError(published.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-build-change-published',
      profile: 'backup',
      projectId: 'project-a',
    }), 'dependency-failed');
    await published.coordinator.close();

    const recoveryOwner = published.restart({ serverBuild: 'cloud-build-b' });
    const result = await recoveryOwner.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-build-change-published',
      profile: 'backup',
      projectId: 'project-a',
    });
    assert.equal(result.state, 'published');
    assert.equal(published.serviceState, 'active');
    await recoveryOwner.close();

    const partiallyCaptured = harness({
      failOnceAt: 'coordination-captured',
    });
    await expectCoordinatorError(partiallyCaptured.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-build-change-captured',
      profile: 'backup',
      projectId: 'project-a',
    }), 'dependency-failed');
    await partiallyCaptured.coordinator.close();

    const captureRecoveryOwner = partiallyCaptured.restart({
      serverBuild: 'cloud-build-b',
    });
    assert.equal((await captureRecoveryOwner.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-build-change-captured',
      profile: 'backup',
      projectId: 'project-a',
    })).state, 'published');
    assert.equal(partiallyCaptured.serviceState, 'active');
    assert.equal(partiallyCaptured.backup?.serverBuild, 'cloud-build-a');
    await captureRecoveryOwner.close();
  });

  it('does not enter the Project write lane after caller cancellation', async () => {
    const test = harness();
    const cancellation = new AbortController();
    cancellation.abort();

    await expectCoordinatorError(test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup',
      projectId: 'project-a',
      signal: cancellation.signal,
    }), 'cancelled');

    assert.equal(test.leaseAcquisitions, 0);
    assert.deepEqual(test.events, []);
    await test.coordinator.close();
  });

  it('releases repository capacity when Project lease cleanup fails', async () => {
    const test = harness({ failLeaseClose: true });

    await expectCoordinatorError(test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup',
      projectId: 'project-a',
    }), 'dependency-failed');

    assert.equal(test.reservationCloses, 1);
    await test.coordinator.close();
  });

  it('cancels while waiting to acquire the canonical Project lease', async () => {
    let acquisitionStartedResolve: (() => void) | undefined;
    const acquisitionStarted = new Promise<void>(resolve => {
      acquisitionStartedResolve = resolve;
    });
    const checkpoint = {
      captureOutbound: () => Promise.reject(new Error('unexpected-capture')),
      discardOutboundOperation: () => Promise.reject(
        new Error('unexpected-discard'),
      ),
      listDueOutboundDeliveries: () => Promise.reject(
        new Error('unexpected-delivery-list'),
      ),
      publishOutbound: () => Promise.reject(new Error('unexpected-publish')),
      readOutboundRecords: () => Promise.reject(
        new Error('unexpected-record-read'),
      ),
      readPublishedOutboundRecords: () => Promise.reject(
        new Error('unexpected-published-record-read'),
      ),
      releaseOutbound: () => Promise.reject(new Error('unexpected-release')),
      releaseOutboundOperation: () => Promise.reject(
        new Error('unexpected-operation-release'),
      ),
      registerOutboundDelivery: () => Promise.reject(
        new Error('unexpected-delivery-registration'),
      ),
      reserveOutbound(projectId: string) {
        const repositoryReservation = Object.freeze({
          close: () => Promise.resolve(),
          projectId,
        });
        return Promise.resolve(Object.freeze({
          maximumCoordinationBytes: 1024 * 1024,
          close: () => Promise.resolve(),
          projectId,
          repositoryReservation,
        }));
      },
      verifyOutboundOperation: () => Promise.reject(
        new Error('unexpected-verification'),
      ),
    };
    const coordinator = new BackupExportCoordinator({
      checkpoint,
      coordination: {
        acquireProjectLease(_projectId, options) {
          acquisitionStartedResolve?.();
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new Error('lease-acquisition-cancelled')),
              { once: true },
            );
          });
        },
      },
      metadata: Object.freeze({
        authorityId: 'authority-a',
        authorityVolumeIdentity: 'authority-volume-a',
        coordinationSchemaVersion: 9,
        repositoryFormatVersion: 1,
        restoreEpoch: 1,
        serverBuild: 'cloud-build-a',
      }),
      recovery: {
        recoverProject: () => Promise.resolve(),
      },
      source: {
        snapshot: () => Promise.reject(new Error('unexpected-snapshot')),
      },
    });
    const cancellation = new AbortController();
    const pending = coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup',
      projectId: 'project-a',
      signal: cancellation.signal,
    });
    await acquisitionStarted;
    cancellation.abort();

    await expectCoordinatorError(pending, 'cancelled');
    await coordinator.close();
  });

  it('publishes one locally verified checkpoint without claiming restore completion', async () => {
    const test = harness();

    const result = await test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup',
      projectId: 'project-a',
    });

    assert.deepEqual(result, Object.freeze({
      checkpointSha256: CHECKPOINT_SHA256,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup',
      projectId: 'project-a',
      state: 'published',
    }));
    assert.equal(test.serviceState, 'active');
    assert.equal(test.journal?.phase, 'completed');
    assert.equal(test.journal.state, 'completed');
    assert.equal(test.backup?.state, 'published');
    assert.equal(test.backup.checkpointSha256, CHECKPOINT_SHA256);
    assert.deepEqual(test.admissionEvents.slice(0, 2), [
      'recovery',
      'repository-reserved',
    ]);
    assert.deepEqual(test.events, [
      'journal:prepared',
      'service:maintenance',
      'capture:backup',
      'journal:coordination-captured',
      'journal:repository-captured',
      'journal:checkpoint-verified',
      'checkpoint:published',
      'catalog:captured',
      'catalog:verified',
      'catalog:published',
      'journal:artifact-published',
      'checkpoint:released',
      'journal:completed',
      'service:active',
    ]);
    await test.coordinator.close();
  });

  it('replays failure after every durable capture phase and never republishes', async () => {
    for (const phase of [
      'prepared',
      'coordination-captured',
      'repository-captured',
      'checkpoint-verified',
      'artifact-published',
    ] as const) {
      const test = harness({ failOnceAt: phase });
      const input = {
        expiresAt: EXPIRES_AT,
        operationId: 'backup-one',
        profile: 'backup' as const,
        projectId: 'project-a',
      };

      await expectCoordinatorError(
        test.coordinator.create(input),
        'dependency-failed',
      );
      assert.equal(test.serviceState, 'maintenance');
      const result = await test.coordinator.create(input);
      assert.equal(result.state, 'published');
      assert.equal(test.serviceState, 'active');
      assert.equal(test.backup?.state, 'published');
      assert.equal(
        test.events.filter(event => event === 'catalog:captured').length,
        1,
      );
      if (phase === 'artifact-published') {
        assert.equal(test.captureCalls, 1);
        assert.equal(test.sourceCalls, 1);
        assert.equal(
          test.events.includes('checkpoint:operation-released'),
          true,
        );
        assert.equal(
          test.events.includes('checkpoint:published-verified'),
          true,
        );
      }
      const replayEventCount = test.events.length;
      assert.deepEqual(await test.coordinator.create(input), result);
      assert.equal(test.events.length, replayEventCount);
      await test.coordinator.close();
    }
  });

  it('persists cancel intent before exact cleanup and reopening writes', async () => {
    const test = harness({ failOnceAt: 'repository-captured' });
    const input = {
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup' as const,
      projectId: 'project-a',
    };
    await expectCoordinatorError(
      test.coordinator.create(input),
      'dependency-failed',
    );

    assert.equal(await test.coordinator.cancel({
      operationId: input.operationId,
      profile: input.profile,
      projectId: input.projectId,
    }), 'cancelled');

    assert.equal(test.journal?.phase, 'cancelled');
    assert.equal(test.journal.state, 'cancelled');
    assert.equal(test.serviceState, 'active');
    assert.equal(test.backup, undefined);
    assert.deepEqual(test.events.slice(-4), [
      'journal:cancel-intent',
      'checkpoint:operation-discarded',
      'journal:cancelled',
      'service:active',
    ]);
    assert.equal(await test.coordinator.cancel({
      operationId: input.operationId,
      profile: input.profile,
      projectId: input.projectId,
    }), 'cancelled');
    await test.coordinator.close();
  });

  it('fails closed when the published backup catalog contradicts its journal', async () => {
    const test = harness({ failOnceAt: 'artifact-published' });
    const input = {
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup' as const,
      projectId: 'project-a',
    };
    await expectCoordinatorError(test.coordinator.create(input), 'dependency-failed');
    test.corruptBackup();

    await expectCoordinatorError(test.coordinator.create(input), 'recovery-required');

    assert.equal(test.journal?.phase, 'artifact-published');
    assert.equal(test.journal.state, 'recovery-required');
    assert.equal(test.journal.recoveryFromPhase, 'artifact-published');
    assert.equal(test.serviceState, 'maintenance');
    await test.coordinator.close();
  });

  it('fails closed when the published catalog contradicts frozen records', async () => {
    const test = harness({ failOnceAt: 'artifact-published' });
    const input = {
      expiresAt: EXPIRES_AT,
      operationId: 'backup-catalog-metadata',
      profile: 'backup' as const,
      projectId: 'project-a',
    };
    await expectCoordinatorError(test.coordinator.create(input), 'dependency-failed');
    test.corruptBackupMetadata();

    await expectCoordinatorError(test.coordinator.create(input), 'recovery-required');
    assert.equal(test.serviceState, 'maintenance');
    await test.coordinator.close();
  });

  it('rejects backup metadata that contradicts the catalog authority', async () => {
    const records = sourceRecords().map(record => (
      record.kind === 'server-compatibility'
        ? Object.freeze({
            ...record,
            value: Object.freeze({
              ...record.value,
              maximumBuild: 'different-build',
            }),
          })
        : record
    ));
    const test = harness({ records });

    await expectCoordinatorError(test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup',
      projectId: 'project-a',
    }), 'invalid-checkpoint');

    assert.equal(test.captureCalls, 0);
    assert.equal(test.serviceState, 'maintenance');
    await test.coordinator.close();
  });

  it('isolates a published artifact contradiction before reopening writes', async () => {
    const test = harness({
      failOnceAt: 'artifact-published',
      invalidPublishedArtifact: true,
    });
    const input = {
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup' as const,
      projectId: 'project-a',
    };
    await expectCoordinatorError(test.coordinator.create(input), 'dependency-failed');

    await expectCoordinatorError(test.coordinator.create(input), 'recovery-required');

    assert.equal(test.journal?.phase, 'artifact-published');
    assert.equal(test.journal.state, 'recovery-required');
    assert.equal(test.journal.recoveryFromPhase, 'artifact-published');
    assert.equal(test.serviceState, 'maintenance');
    assert.equal(test.events.includes('checkpoint:operation-released'), false);
    await test.coordinator.close();
  });

  it('pins the exact repository placement when prepared enters maintenance', async () => {
    const test = harness({ failOnceAt: 'coordination-captured' });
    const input = {
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup' as const,
      projectId: 'project-a',
    };
    await expectCoordinatorError(test.coordinator.create(input), 'dependency-failed');
    test.replacePlacementGeneration(12);

    await expectCoordinatorError(test.coordinator.create(input), 'state-conflict');

    assert.equal(test.journal?.phase, 'coordination-captured');
    assert.equal(test.serviceState, 'maintenance');
    await test.coordinator.close();
  });

  it('publishes an export artifact without backup-only catalog or records', async () => {
    const records = sourceRecords().filter(record => (
      record.kind === 'project' || record.kind === 'member'
    ));
    const test = harness({ profile: 'export', records });

    const result = await test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'export-one',
      profile: 'export',
      projectId: 'project-a',
    });

    assert.equal(result.profile, 'export');
    assert.equal(test.backup, undefined);
    assert.deepEqual(
      test.captureInputs[0]?.records.map(record => record.kind),
      ['project', 'member'],
    );
    assert.equal(
      test.events.some(event => event.startsWith('catalog:')),
      false,
    );
    await test.coordinator.close();
  });

  it('removes bounded export delivery after success, cancellation, or expiry', async () => {
    for (const reason of ['completed', 'cancelled', 'expired'] as const) {
      const test = harness({ profile: 'export' });
      await test.coordinator.create({
        expiresAt: EXPIRES_AT,
        operationId: `export-delivery-${reason}`,
        profile: 'export',
        projectId: 'project-a',
      });

      assert.equal(await test.coordinator.settleExportDelivery({
        ...(reason === 'expired'
          ? { expiredBefore: '2026-08-30T00:00:00.000Z' as const }
          : {}),
        operationId: `export-delivery-${reason}`,
        projectId: 'project-a',
        reason,
      }), 'removed');
      assert.equal(await test.coordinator.settleExportDelivery({
        ...(reason === 'expired'
          ? { expiredBefore: '2026-08-30T00:00:00.000Z' as const }
          : {}),
        operationId: `export-delivery-${reason}`,
        projectId: 'project-a',
        reason,
      }), 'removed');
      assert.equal(test.events.filter(
        event => event === 'checkpoint:operation-discarded',
      ).length, 2);
      await test.coordinator.close();
    }
  });

  it('discovers and removes a due export delivery after coordinator restart', async () => {
    const test = harness({ profile: 'export' });
    await test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'export-delivery-restart',
      profile: 'export',
      projectId: 'project-a',
    });
    assert.equal(
      test.events.includes('checkpoint:delivery-registered'),
      true,
    );
    await test.coordinator.close();

    const restarted = test.restart();
    assert.deepEqual(await restarted.reconcileExpiredExportDeliveries({
      expiredBefore: '2030-01-01T00:00:00.000Z',
    }), { removed: 1 });
    assert.deepEqual(await restarted.reconcileExpiredExportDeliveries({
      expiredBefore: '2030-01-01T00:00:00.000Z',
    }), { removed: 0 });
    await restarted.close();
  });

  it('removes a due export delivery after Project content becomes a tombstone', async () => {
    const test = harness({ profile: 'export' });
    await test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'export-delivery-retired',
      profile: 'export',
      projectId: 'project-a',
    });
    await test.coordinator.close();
    test.replaceProjectWithTombstone();

    const restarted = test.restart();
    assert.deepEqual(await restarted.reconcileExpiredExportDeliveries({
      expiredBefore: '2030-01-01T00:00:00.000Z',
    }), { removed: 1 });
    await restarted.close();
  });

  it('retains a due delivery marker until artifact-published recovery completes', async () => {
    const test = harness({
      failOnceAt: 'artifact-published',
      profile: 'export',
    });
    const input = {
      expiresAt: EXPIRES_AT,
      operationId: 'export-delivery-recovery',
      profile: 'export' as const,
      projectId: 'project-a',
    };
    await expectCoordinatorError(test.coordinator.create(input), 'dependency-failed');
    assert.deepEqual(await test.coordinator.reconcileExpiredExportDeliveries({
      expiredBefore: '2030-01-01T00:00:00.000Z',
    }), { removed: 0 });
    assert.equal(test.journal?.phase, 'artifact-published');

    await test.coordinator.create(input);
    assert.deepEqual(await test.coordinator.reconcileExpiredExportDeliveries({
      expiredBefore: '2030-01-01T00:00:00.000Z',
    }), { removed: 1 });
    await test.coordinator.close();
  });

  it('recovers a durable cancel intent after transient cleanup failure', async () => {
    const test = harness({
      failCancelCleanupOnce: true,
      failOnceAt: 'repository-captured',
    });
    const input = {
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup' as const,
      projectId: 'project-a',
    };
    await expectCoordinatorError(
      test.coordinator.create(input),
      'dependency-failed',
    );
    await expectCoordinatorError(test.coordinator.cancel({
      operationId: input.operationId,
      profile: input.profile,
      projectId: input.projectId,
    }), 'dependency-failed');
    assert.equal(test.journal?.phase, 'cancel-intent');
    assert.equal(test.serviceState, 'maintenance');

    await test.coordinator.recover({
      journal: test.journal,
      lease: test.lease,
      repositoryReservation: await test.coordinator.reserveRecovery(
        input.projectId,
      ),
    });

    assert.equal(test.journal.state, 'cancelled');
    assert.equal(test.serviceState, 'active');
    await test.coordinator.close();
  });

  it('cancels expired pre-publication journals during startup recovery', async () => {
    for (const phase of ['prepared', 'repository-captured'] as const) {
      let now = new Date(CREATED_AT);
      const test = harness({
        clock: () => new Date(now),
        failOnceAt: phase,
      });
      await expectCoordinatorError(test.coordinator.create({
        expiresAt: EXPIRES_AT,
        operationId: 'backup-one',
        profile: 'backup',
        projectId: 'project-a',
      }), 'dependency-failed');
      now = new Date('2030-01-01T00:00:00.000Z');
      const journal = test.journal;
      assert.ok(journal);

      await test.coordinator.recover({
        journal,
        lease: test.lease,
        repositoryReservation: await test.coordinator.reserveRecovery(
          'project-a',
        ),
      });

      assert.equal(test.journal.state, 'cancelled');
      assert.equal(test.serviceState, 'active');
      assert.equal(test.events.includes('journal:cancel-intent'), true);
      assert.equal(test.events.includes('checkpoint:operation-discarded'), true);
      await test.coordinator.close();
    }
  });

  it('recovers a published journal after its external delivery expiry', async () => {
    let now = new Date(CREATED_AT);
    const test = harness({
      clock: () => new Date(now),
      failOnceAt: 'artifact-published',
      profile: 'export',
    });
    await expectCoordinatorError(test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'export-one',
      profile: 'export',
      projectId: 'project-a',
    }), 'dependency-failed');
    now = new Date('2030-01-01T00:00:00.000Z');
    const journal = test.journal;
    assert.ok(journal);

    await test.coordinator.recover({
      journal,
      lease: test.lease,
      repositoryReservation: await test.coordinator.reserveRecovery(
        'project-a',
      ),
    });

    assert.equal(test.journal.state, 'completed');
    assert.equal(test.serviceState, 'active');
    assert.equal(test.events.includes('checkpoint:published-verified'), true);
    assert.equal(test.sourceCalls, 1);
    await test.coordinator.close();
  });

  it('isolates ambiguous cancellation cleanup with maintenance still closed', async () => {
    const test = harness({
      failOnceAt: 'repository-captured',
      invalidCancelCleanup: true,
    });
    const input = {
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup' as const,
      projectId: 'project-a',
    };
    await expectCoordinatorError(test.coordinator.create(input), 'dependency-failed');

    await expectCoordinatorError(test.coordinator.cancel({
      operationId: input.operationId,
      profile: input.profile,
      projectId: input.projectId,
    }), 'recovery-required');

    assert.equal(test.journal?.phase, 'cancel-intent');
    assert.equal(test.journal.state, 'recovery-required');
    assert.equal(test.journal.recoveryFromPhase, 'cancel-intent');
    assert.equal(test.serviceState, 'maintenance');
    await test.coordinator.close();
  });

  it('preserves lifecycle, terminal, and protected-envelope continuity in backup', async () => {
    const test = harness();
    await test.coordinator.create({
      expiresAt: EXPIRES_AT,
      operationId: 'backup-one',
      profile: 'backup',
      projectId: 'project-a',
    });

    const captureInput = test.captureInputs[0];
    const backup = test.backup;
    assert.ok(captureInput);
    assert.ok(backup);
    const kinds = captureInput.records.map(record => record.kind);
    assert.ok(kinds.includes('lifecycle-journal'));
    assert.ok(kinds.includes('protected-claim-envelope'));
    assert.ok(kinds.includes('terminal-responder'));
    assert.equal(backup.authorityGeneration, 3);
    assert.equal(backup.placementGeneration, 11);
    await test.coordinator.close();
  });
});
