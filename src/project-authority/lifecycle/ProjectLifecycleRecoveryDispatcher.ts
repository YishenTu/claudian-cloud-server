import { isDeepStrictEqual } from 'node:util';

import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  RecoveryCandidate,
  RecoveryCandidateCatalog,
} from '../../coordination/DevelopmentBootstrapPersistence.js';
import type {
  ProjectLifecycleJournalRecord,
  ProjectLifecycleKind,
} from '../../coordination/PortabilityLifecyclePersistence.js';
import type {
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
} from '../../coordination/ProjectCoordination.js';
import {
  ProjectRecoveryError,
  type ProjectRecoveryPort,
} from '../admission/ProjectWriteAdmission.js';

export interface RecoverProjectLifecycleInput {
  readonly journal: ProjectLifecycleJournalRecord;
  readonly lease: PinnedProjectLease;
  readonly repositoryReservation?: ProjectLifecycleRecoveryReservation;
  readonly signal?: AbortSignal;
}

export interface ProjectLifecycleRecoveryReservation {
  close(): Promise<void>;
}

export type ProjectLifecycleRecoveryOutcome =
  | 'settled'
  | 'waiting-for-external-proof';

export interface ProjectLifecycleRecoveryOwner {
  reserveRecovery?(
    projectId: CollabProjectId,
    journal: ProjectLifecycleJournalRecord,
  ): Promise<ProjectLifecycleRecoveryReservation | undefined>;
  recover(
    input: RecoverProjectLifecycleInput,
  ): Promise<ProjectLifecycleRecoveryOutcome>;
}

export interface ProjectLifecycleRecoveryOwners {
  readonly authorityTransfer: ProjectLifecycleRecoveryOwner;
  readonly backup: ProjectLifecycleRecoveryOwner;
  readonly deletion: ProjectLifecycleRecoveryOwner;
  readonly export: ProjectLifecycleRecoveryOwner;
  readonly leave: ProjectLifecycleRecoveryOwner;
  readonly retire: ProjectLifecycleRecoveryOwner;
}

export interface ProjectLifecycleRecoveryCoordination {
  acquireProjectLease(
    projectId: CollabProjectId,
    options?: AcquireProjectLeaseOptions,
  ): Promise<PinnedProjectLease>;
}

export interface ProjectLifecycleRecoveryPort extends ProjectRecoveryPort {
  recoverCandidate(candidate: RecoveryCandidate): Promise<void>;
}

export interface ProjectLifecycleRecoveryDispatcherOptions {
  readonly coordination: ProjectLifecycleRecoveryCoordination;
  readonly owners: ProjectLifecycleRecoveryOwners;
}

interface ExactCandidate {
  readonly kind: ProjectLifecycleKind;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly scheduledAt: string;
}

const LIFECYCLE_KINDS = new Set<ProjectLifecycleKind>([
  'authority-transfer',
  'backup',
  'delete',
  'export',
  'leave',
  'retire',
]);
const MAXIMUM_LIFECYCLE_JOURNALS_PER_RECOVERY = 2;

interface RecoveryStepResult {
  readonly journal: ProjectLifecycleJournalRecord;
  readonly outcome: ProjectLifecycleRecoveryOutcome;
}

function fail(code: ProjectRecoveryError['code']): never {
  throw new ProjectRecoveryError(code);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function snapshotCandidate(candidate: RecoveryCandidate): ExactCandidate {
  try {
    const snapshot = Object.freeze({
      kind: candidate.kind,
      operationId: candidate.operationId,
      projectId: candidate.projectId,
      scheduledAt: candidate.scheduledAt,
    });
    if (
      !LIFECYCLE_KINDS.has(snapshot.kind as ProjectLifecycleKind)
      || !isCollabOpaqueId(snapshot.operationId)
      || !isCollabProjectId(snapshot.projectId)
      || !canonicalTimestamp(snapshot.scheduledAt)
    ) {
      fail('dependency-failed');
    }
    return snapshot as ExactCandidate;
  } catch (error: unknown) {
    if (error instanceof ProjectRecoveryError) throw error;
    return fail('dependency-failed');
  }
}

function exactJournal(
  journal: ProjectLifecycleJournalRecord,
  expected: Readonly<{
    readonly kind?: ProjectLifecycleKind;
    readonly operationId?: string;
    readonly projectId: CollabProjectId;
  }>,
): void {
  if (
    journal.projectId !== expected.projectId
    || (expected.kind !== undefined && journal.kind !== expected.kind)
    || (
      expected.operationId !== undefined
      && journal.operationId !== expected.operationId
    )
  ) {
    fail('dependency-failed');
  }
}

function permitsDeletionSuccessor(
  journal: ProjectLifecycleJournalRecord,
): boolean {
  return journal.state === 'completed'
    && (
      journal.kind === 'retire'
      || (
        journal.kind === 'authority-transfer'
        && journal.direction === 'cloud-to-lan'
      )
    );
}

export class ProjectLifecycleRecoveryDispatcher
implements ProjectLifecycleRecoveryPort {
  readonly #coordination: ProjectLifecycleRecoveryCoordination;
  readonly #owners: ProjectLifecycleRecoveryOwners;
  #closed = false;

  constructor(options: ProjectLifecycleRecoveryDispatcherOptions) {
    this.#coordination = options.coordination;
    this.#owners = Object.freeze({ ...options.owners });
  }

  recoverCandidate(candidate: RecoveryCandidate): Promise<void> {
    let snapshot: ExactCandidate;
    try {
      snapshot = snapshotCandidate(candidate);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectRecoveryError('dependency-failed'),
      );
    }
    return this.#recoverCandidate(snapshot);
  }

  recoverProject(projectId: CollabProjectId): Promise<void> {
    if (!isCollabProjectId(projectId)) {
      return Promise.reject(new ProjectRecoveryError('dependency-failed'));
    }
    return this.#drainProject(projectId, true);
  }

  async recoverAll(catalog: RecoveryCandidateCatalog): Promise<void> {
    let after;
    for (;;) {
      if (this.#isClosed()) fail('closed');
      let page;
      try {
        page = await catalog.listRecoveryCandidates(
          after === undefined ? undefined : { after },
        );
      } catch (error: unknown) {
        if (error instanceof ProjectRecoveryError) throw error;
        return fail('dependency-failed');
      }
      for (const candidate of page.candidates) {
        if (this.#isClosed()) fail('closed');
        await this.#recoverCandidate(snapshotCandidate(candidate), true);
      }
      if (page.nextCursor === undefined) return;
      after = page.nextCursor;
    }
  }

  close(): void {
    this.#closed = true;
  }

  async #recoverCandidate(
    snapshot: ExactCandidate,
    rejectWaiting = false,
  ): Promise<void> {
    const observed = await this.#withProjectLease(snapshot.projectId, async lease => {
      const journal = await lease.withProjectScope(scope => (
        scope.portability.getLifecycleJournal(snapshot.operationId)
      ));
      if (journal === undefined) fail('dependency-failed');
      exactJournal(journal, snapshot);
      return journal;
    });
    const recovered = await this.#recoverObserved(observed);
    if (recovered.outcome === 'waiting-for-external-proof') {
      if (rejectWaiting) fail('recovery-required');
      return;
    }
    await this.#drainProject(snapshot.projectId, false, recovered.journal);
  }

  async #drainProject(
    projectId: CollabProjectId,
    rejectWaiting: boolean,
    initialPredecessor?: ProjectLifecycleJournalRecord,
  ): Promise<void> {
    let predecessor = initialPredecessor;
    for (
      let index = 0;
      index < MAXIMUM_LIFECYCLE_JOURNALS_PER_RECOVERY;
      index += 1
    ) {
      const journal = await this.#withProjectLease(projectId, lease => (
        lease.withProjectScope(scope => (
          scope.portability.getNonterminalLifecycleJournal()
        ))
      ));
      if (journal === undefined) return;
      exactJournal(journal, { projectId });
      if (
        predecessor !== undefined
        && (
          journal.kind !== 'delete'
          || !permitsDeletionSuccessor(predecessor)
        )
      ) fail('dependency-failed');
      const recovered = await this.#recoverObserved(journal);
      if (recovered.outcome === 'waiting-for-external-proof') {
        if (rejectWaiting) fail('recovery-required');
        return;
      }
      predecessor = recovered.journal;
    }
    const remaining = await this.#withProjectLease(projectId, lease => (
      lease.withProjectScope(scope => (
        scope.portability.getNonterminalLifecycleJournal()
      ))
    ));
    if (remaining !== undefined) fail('dependency-failed');
  }

  async #recoverObserved(
    observed: ProjectLifecycleJournalRecord,
  ): Promise<RecoveryStepResult> {
    const owner = this.#owner(observed.kind);
    let preflight = observed;
    for (;;) {
      if (preflight.state === 'recovery-required') fail('recovery-required');
      if (preflight.state === 'cancelled' || preflight.state === 'completed') {
        return { journal: preflight, outcome: 'settled' };
      }
      let reservation: ProjectLifecycleRecoveryReservation | undefined;
      try {
        reservation = await owner.reserveRecovery?.(
          preflight.projectId,
          preflight,
        );
        const attempt = await this.#withProjectLease(
          preflight.projectId,
          async lease => {
            const journal = await lease.withProjectScope(scope => (
              scope.portability.getLifecycleJournal(preflight.operationId)
            ));
            if (journal === undefined) fail('dependency-failed');
            exactJournal(journal, preflight);
            if (!isDeepStrictEqual(journal, preflight)) {
              return Object.freeze({ retry: journal });
            }
            if (journal.state === 'recovery-required') fail('recovery-required');
            if (journal.state === 'cancelled' || journal.state === 'completed') {
              return Object.freeze({
                result: Object.freeze({ journal, outcome: 'settled' as const }),
              });
            }
            const outcome = await owner.recover(Object.freeze({
              journal,
              lease,
              ...(reservation === undefined ? {} : {
                repositoryReservation: reservation,
              }),
            }));
            const settled = await lease.withProjectScope(scope => (
              scope.portability.getLifecycleJournal(journal.operationId)
            ));
            if (settled === undefined) fail('dependency-failed');
            exactJournal(settled, journal);
            if (settled.state === 'recovery-required') fail('recovery-required');
            if (outcome === 'waiting-for-external-proof') {
              if (settled.state === 'cancelled' || settled.state === 'completed') {
                fail('dependency-failed');
              }
              return Object.freeze({
                result: Object.freeze({ journal: settled, outcome }),
              });
            }
            if (settled.state !== 'cancelled' && settled.state !== 'completed') {
              fail('dependency-failed');
            }
            return Object.freeze({
              result: Object.freeze({
                journal: settled,
                outcome: 'settled' as const,
              }),
            });
          },
        );
        if ('result' in attempt) return attempt.result;
        preflight = attempt.retry;
      } finally {
        await reservation?.close().catch(() => undefined);
      }
    }
  }

  async #withProjectLease<Result>(
    projectId: CollabProjectId,
    operation: (lease: PinnedProjectLease) => Promise<Result>,
  ): Promise<Result> {
    if (this.#isClosed()) fail('closed');
    let lease: PinnedProjectLease;
    try {
      lease = await this.#coordination.acquireProjectLease(projectId);
    } catch (error: unknown) {
      if (error instanceof ProjectRecoveryError) throw error;
      return fail(this.#isClosed() ? 'closed' : 'dependency-failed');
    }
    let failure: Error | undefined;
    let result: Result | undefined;
    try {
      if (this.#isClosed()) fail('closed');
      result = await operation(lease);
    } catch (error: unknown) {
      failure = error instanceof ProjectRecoveryError
        ? error
        : new ProjectRecoveryError('dependency-failed');
    }
    try {
      await lease.close();
    } catch {
      failure = new ProjectRecoveryError('dependency-failed');
    }
    if (failure !== undefined) throw failure;
    return result as Result;
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  #owner(kind: ProjectLifecycleKind): ProjectLifecycleRecoveryOwner {
    switch (kind) {
      case 'authority-transfer': return this.#owners.authorityTransfer;
      case 'backup': return this.#owners.backup;
      case 'delete': return this.#owners.deletion;
      case 'export': return this.#owners.export;
      case 'leave': return this.#owners.leave;
      case 'retire': return this.#owners.retire;
    }
  }
}
