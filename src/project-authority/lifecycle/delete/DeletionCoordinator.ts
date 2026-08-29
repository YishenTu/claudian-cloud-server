import { timingSafeEqual } from 'node:crypto';

import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabIsoTimestamp,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../../coordination/CoordinationError.js';
import type {
  ProjectDeletionIntentRecord,
  ProjectLifecycleJournalRecord,
} from '../../../coordination/PortabilityLifecyclePersistence.js';
import type {
  PinnedProjectLease,
} from '../../../coordination/ProjectCoordination.js';
import {
  RepositoryCheckpointError,
  type ExactRepositoryOperationReservation,
  type ExactRepositoryRemovalPort,
} from '../../../repositories/RepositoryCheckpointAuthority.js';
import type {
  ProjectLifecycleRecoveryOutcome,
  ProjectLifecycleRecoveryOwner,
  RecoverProjectLifecycleInput,
} from '../ProjectLifecycleRecoveryDispatcher.js';

export type DeletionCoordinatorErrorCode =
  | 'authorization-denied'
  | 'closed'
  | 'dependency-failed'
  | 'recovery-required'
  | 'state-conflict';

export class DeletionCoordinatorError extends Error {
  readonly code: DeletionCoordinatorErrorCode;
  readonly retryable: boolean;

  constructor(code: DeletionCoordinatorErrorCode) {
    super(`deletion-coordinator.error.${code}`);
    this.name = 'DeletionCoordinatorError';
    this.code = code;
    this.retryable = code === 'dependency-failed';
  }
}

export interface DeletionCoordinatorOptions {
  readonly clock?: () => Date;
  readonly coordination: Readonly<{
    acquireProjectLease(
      projectId: CollabProjectId,
      options?: Readonly<{ readonly signal?: AbortSignal }>,
    ): Promise<PinnedProjectLease>;
  }>;
  readonly repository: ExactRepositoryRemovalPort;
}

export interface ResumeAuthorizedDeletionInput {
  readonly authorizationSha256: string;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly signal?: AbortSignal;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_PHASES = 8;

function fail(code: DeletionCoordinatorErrorCode): never {
  throw new DeletionCoordinatorError(code);
}

function exactDigest(left: string, right: string): boolean {
  return SHA256_PATTERN.test(left)
    && SHA256_PATTERN.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function mapDependency(error: unknown): never {
  if (error instanceof DeletionCoordinatorError) throw error;
  if (error instanceof CoordinationError) {
    if (error.code === 'closed') return fail('closed');
    if (error.code === 'state-conflict' || error.code === 'invalid-record') {
      return fail('state-conflict');
    }
  }
  if (error instanceof RepositoryCheckpointError) {
    if (error.code === 'closed') return fail('closed');
    if (error.code === 'placement-rejected' || error.code === 'repository-invalid') {
      return fail('recovery-required');
    }
  }
  return fail('dependency-failed');
}

function nextTimestamp(clock: () => Date, after: CollabIsoTimestamp): CollabIsoTimestamp {
  const observed = clock();
  if (Number.isNaN(observed.valueOf())) return fail('dependency-failed');
  return new Date(Math.max(observed.valueOf(), Date.parse(after) + 1)).toISOString();
}

export class DeletionCoordinator implements ProjectLifecycleRecoveryOwner {
  readonly #clock: () => Date;
  readonly #coordination: DeletionCoordinatorOptions['coordination'];
  readonly #repository: ExactRepositoryRemovalPort;
  #closed = false;

  constructor(options: DeletionCoordinatorOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#repository = options.repository;
  }

  close(): void {
    this.#closed = true;
  }

  reserveRecovery(
    projectId: CollabProjectId,
  ): Promise<ExactRepositoryOperationReservation> {
    if (this.#closed) return Promise.reject(new DeletionCoordinatorError('closed'));
    return this.#repository.reserveExactRepositoryOperation(projectId);
  }

  async resumeAuthorized(
    input: ResumeAuthorizedDeletionInput,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    if (
      this.#closed
      || !isCollabProjectId(input.projectId)
      || !isCollabOpaqueId(input.operationId)
      || !SHA256_PATTERN.test(input.authorizationSha256)
      || input.signal?.aborted === true
    ) {
      return this.#closed ? fail('closed') : fail('authorization-denied');
    }
    let reservation: ExactRepositoryOperationReservation;
    try {
      reservation = await this.#repository.reserveExactRepositoryOperation(
      input.projectId,
      input.signal,
      );
    } catch (error: unknown) {
      return mapDependency(error);
    }
    let lease: PinnedProjectLease;
    try {
      lease = await this.#coordination.acquireProjectLease(
        input.projectId,
        input.signal === undefined ? {} : { signal: input.signal },
      );
    } catch (error: unknown) {
      await reservation.close().catch(() => undefined);
      return mapDependency(error);
    }
    try {
      const facts = await lease.withProjectScope(async scope => ({
        intent: await scope.portability.getDeletionIntent(input.operationId),
        journal: await scope.portability.getLifecycleJournal(input.operationId),
      }));
      if (
        facts.intent === undefined
        || facts.journal === undefined
        || !exactDigest(facts.intent.authorizationSha256, input.authorizationSha256)
      ) return fail('authorization-denied');
      return await this.recover({
        journal: facts.journal,
        lease,
        repositoryReservation: reservation,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error: unknown) {
      return mapDependency(error);
    } finally {
      await lease.close().catch(() => undefined);
      await reservation.close().catch(() => undefined);
    }
  }

  async recover(
    input: RecoverProjectLifecycleInput,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    if (this.#closed) return fail('closed');
    const reservation = input.repositoryReservation;
    if (reservation === undefined) return fail('recovery-required');
    let journal = input.journal;
    if (journal.kind !== 'delete') return fail('state-conflict');
    try {
      for (let step = 0; step < MAXIMUM_PHASES; step += 1) {
        if (input.signal?.aborted === true) return fail('closed');
        if (journal.state === 'completed' && journal.phase === 'completed') {
          return 'settled';
        }
        if (journal.state !== 'active') return fail('recovery-required');
        const intent = await input.lease.withProjectScope(scope => (
          scope.portability.getDeletionIntent(journal.operationId)
        ));
        this.#assertIntent(journal, intent);
        if (journal.phase === 'traffic-denied') {
          await this.#advance(input.lease, journal, 'repository-delete-intent');
        } else if (journal.phase === 'repository-delete-intent') {
          await this.#repository.removeExactRepository(
            reservation as ExactRepositoryOperationReservation,
            {
            placementGeneration: intent.placementGeneration,
            projectId: journal.projectId,
            repositoryStorageKey: intent.repositoryStorageKey,
            storageNodeId: intent.storageNodeId,
            },
            input.signal,
          );
          await this.#advance(input.lease, journal, 'repository-removed');
        } else if (journal.phase === 'repository-removed') {
          await input.lease.withProjectScope(scope => (
            scope.portability.removeProjectCoordinationContent({
              operationId: journal.operationId,
              scheduledAt: journal.scheduledAt,
              updatedAt: nextTimestamp(this.#clock, journal.updatedAt),
            })
          ));
        } else if (journal.phase === 'coordination-removed') {
          const tombstone = await input.lease.withProjectScope(scope => (
            scope.portability.getProjectTombstone()
          ));
          if (
            tombstone?.terminalOperationId !== intent.terminalOperationId
            || tombstone.terminalOperationKind !== intent.terminalOperationKind
          ) return fail('recovery-required');
          await this.#advance(input.lease, journal, 'tombstoned');
        } else if (journal.phase === 'tombstoned') {
          const tombstone = await input.lease.withProjectScope(scope => (
            scope.portability.getProjectTombstone()
          ));
          if (tombstone === undefined) return fail('recovery-required');
          await input.lease.withProjectScope(scope => (
            scope.portability.advanceLifecycleJournal({
              expectedPhase: 'tombstoned',
              expectedState: 'active',
              nextPhase: 'completed',
              nextState: 'completed',
              operationId: journal.operationId,
              resultSha256: tombstone.resultSha256,
              scheduledAt: journal.scheduledAt,
              updatedAt: nextTimestamp(this.#clock, journal.updatedAt),
            })
          ));
        } else {
          return fail('recovery-required');
        }
        const next = await input.lease.withProjectScope(scope => (
          scope.portability.getLifecycleJournal(journal.operationId)
        ));
        if (next === undefined) return fail('recovery-required');
        journal = next;
      }
      return fail('recovery-required');
    } catch (error: unknown) {
      return mapDependency(error);
    }
  }

  #assertIntent(
    journal: ProjectLifecycleJournalRecord,
    intent: ProjectDeletionIntentRecord | undefined,
  ): asserts intent is ProjectDeletionIntentRecord {
    if (
      intent === undefined
      || intent.operationId !== journal.operationId
      || intent.phase !== journal.phase
      || intent.authorizationSha256 !== journal.requestFingerprint
    ) return fail('recovery-required');
  }

  async #advance(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    nextPhase: string,
  ): Promise<void> {
    await lease.withProjectScope(scope => scope.portability.advanceLifecycleJournal({
      expectedPhase: journal.phase,
      expectedState: 'active',
      nextPhase,
      nextState: 'active',
      operationId: journal.operationId,
      scheduledAt: journal.scheduledAt,
      updatedAt: nextTimestamp(this.#clock, journal.updatedAt),
    }));
  }
}
