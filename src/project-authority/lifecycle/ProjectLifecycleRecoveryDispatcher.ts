import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  RecoveryCandidate,
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
}

export type ProjectLifecycleRecoveryOutcome =
  | 'settled'
  | 'waiting-for-external-proof';

export interface ProjectLifecycleRecoveryOwner {
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
    return this.#withProjectLease(snapshot.projectId, async lease => {
      const journal = await lease.withProjectScope(scope => (
        scope.portability.getLifecycleJournal(snapshot.operationId)
      ));
      if (journal === undefined) fail('dependency-failed');
      exactJournal(journal, snapshot);
      await this.#recover(lease, journal);
    });
  }

  recoverProject(projectId: CollabProjectId): Promise<void> {
    if (!isCollabProjectId(projectId)) {
      return Promise.reject(new ProjectRecoveryError('dependency-failed'));
    }
    return this.#withProjectLease(projectId, async lease => {
      const journal = await lease.withProjectScope(scope => (
        scope.portability.getNonterminalLifecycleJournal()
      ));
      if (journal === undefined) return;
      exactJournal(journal, { projectId });
      const outcome = await this.#recover(lease, journal);
      if (outcome === 'waiting-for-external-proof') {
        fail('recovery-required');
      }
    });
  }

  close(): void {
    this.#closed = true;
  }

  async #recover(
    lease: PinnedProjectLease,
    initial: ProjectLifecycleJournalRecord,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    let journal = initial;
    const seen = new Set<string>();
    for (
      let index = 0;
      index < MAXIMUM_LIFECYCLE_JOURNALS_PER_RECOVERY;
      index += 1
    ) {
      if (seen.has(journal.operationId)) fail('dependency-failed');
      seen.add(journal.operationId);
      if (journal.state === 'recovery-required') fail('recovery-required');
      if (journal.state !== 'cancelled' && journal.state !== 'completed') {
        const outcome = await this.#owner(journal.kind).recover(Object.freeze({
          journal,
          lease,
        }));
        const settled = await lease.withProjectScope(scope => (
          scope.portability.getLifecycleJournal(journal.operationId)
        ));
        if (settled === undefined) fail('dependency-failed');
        exactJournal(settled, journal);
        if (settled.state === 'recovery-required') fail('recovery-required');
        if (outcome === 'waiting-for-external-proof') {
          if (
            settled.state === 'cancelled'
            || settled.state === 'completed'
            || settled.operationId !== journal.operationId
          ) fail('dependency-failed');
          return 'waiting-for-external-proof';
        }
        if (settled.state !== 'cancelled' && settled.state !== 'completed') {
          fail('dependency-failed');
        }
        journal = settled;
      }
      const successor = await lease.withProjectScope(scope => (
        scope.portability.getNonterminalLifecycleJournal()
      ));
      if (successor === undefined) return 'settled';
      exactJournal(successor, { projectId: initial.projectId });
      if (
        successor.kind !== 'delete'
        || !permitsDeletionSuccessor(journal)
      ) {
        fail('dependency-failed');
      }
      journal = successor;
    }
    fail('dependency-failed');
  }

  async #withProjectLease(
    projectId: CollabProjectId,
    operation: (lease: PinnedProjectLease) => Promise<void>,
  ): Promise<void> {
    if (this.#isClosed()) fail('closed');
    let lease: PinnedProjectLease;
    try {
      lease = await this.#coordination.acquireProjectLease(projectId);
    } catch (error: unknown) {
      if (error instanceof ProjectRecoveryError) throw error;
      return fail(this.#isClosed() ? 'closed' : 'dependency-failed');
    }
    let failure: Error | undefined;
    try {
      if (this.#isClosed()) fail('closed');
      await operation(lease);
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
