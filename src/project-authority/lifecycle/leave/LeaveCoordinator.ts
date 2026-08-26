import { createHash } from 'node:crypto';

import {
  collabMemberRef,
  isCollabGitOid,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../../coordination/CoordinationError.js';
import type {
  LeaveFormerPrincipalReplayRecord,
  ProjectLifecycleJournalRecord,
} from '../../../coordination/PortabilityLifecyclePersistence.js';
import type { PinnedProjectLease } from '../../../coordination/ProjectCoordination.js';
import {
  RepositoryCheckpointError,
  type ExactPersonalRefPort,
  type ExactRepositoryOperationReservation,
} from '../../../repositories/RepositoryCheckpointAuthority.js';
import type {
  ProjectLifecycleRecoveryOutcome,
  ProjectLifecycleRecoveryOwner,
  RecoverProjectLifecycleInput,
} from '../ProjectLifecycleRecoveryDispatcher.js';

export type LeaveCoordinatorErrorCode =
  | 'authorization-denied'
  | 'closed'
  | 'dependency-failed'
  | 'manager-succession-required'
  | 'recovery-required'
  | 'state-conflict';

export class LeaveCoordinatorError extends Error {
  readonly code: LeaveCoordinatorErrorCode;
  readonly retryable: boolean;

  constructor(code: LeaveCoordinatorErrorCode) {
    super(`leave-coordinator.error.${code}`);
    this.name = 'LeaveCoordinatorError';
    this.code = code;
    this.retryable = code === 'dependency-failed';
  }
}

export interface LeaveProjectRequest {
  readonly expectedPersonalRefOid: string;
  readonly idempotencyKey: string;
  readonly projectId: CollabProjectId;
}

export interface LeaveProjectResult {
  readonly kind: 'member-left';
  readonly leftAt: CollabIsoTimestamp;
  readonly memberId: CollabMemberId;
  readonly projectId: CollabProjectId;
}

export interface LeaveCoordinatorOptions {
  readonly clock?: () => Date;
  readonly coordination: Readonly<{
    acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
  }>;
  readonly repository: ExactPersonalRefPort;
}

const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function fail(code: LeaveCoordinatorErrorCode): never {
  throw new LeaveCoordinatorError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function operationId(
  projectId: CollabProjectId,
  memberId: CollabMemberId,
  idempotencyKey: string,
): string {
  return `leave_${sha256(`${projectId}\0${memberId}\0${idempotencyKey}`).slice(0, 48)}`;
}

function canonicalRequest(request: LeaveProjectRequest): LeaveProjectRequest {
  if (
    !isCollabProjectId(request.projectId)
    || !isCollabOpaqueId(request.idempotencyKey)
    || !isCollabGitOid(request.expectedPersonalRefOid)
  ) return fail('state-conflict');
  return Object.freeze({
    expectedPersonalRefOid: request.expectedPersonalRefOid,
    idempotencyKey: request.idempotencyKey,
    projectId: request.projectId,
  });
}

function requestFingerprint(request: LeaveProjectRequest): string {
  return sha256(JSON.stringify(request));
}

function timestamp(clock: () => Date, after?: CollabIsoTimestamp): CollabIsoTimestamp {
  const observed = clock();
  if (Number.isNaN(observed.valueOf())) return fail('dependency-failed');
  const value = after === undefined
    ? observed.valueOf()
    : Math.max(observed.valueOf(), Date.parse(after) + 1);
  return new Date(value).toISOString();
}

function resultFor(
  projectId: CollabProjectId,
  replay: LeaveFormerPrincipalReplayRecord,
): LeaveProjectResult {
  return Object.freeze({
    kind: 'member-left',
    leftAt: replay.createdAt,
    memberId: replay.memberId,
    projectId,
  });
}

function mapDependency(error: unknown): never {
  if (error instanceof LeaveCoordinatorError) throw error;
  if (error instanceof CoordinationError) {
    if (error.code === 'closed') return fail('closed');
    if (error.code === 'invalid-record' || error.code === 'state-conflict') {
      return fail('state-conflict');
    }
  }
  if (error instanceof RepositoryCheckpointError) {
    if (error.code === 'closed') return fail('closed');
    if (error.code === 'repository-invalid' || error.code === 'placement-rejected') {
      return fail('state-conflict');
    }
  }
  return fail('dependency-failed');
}

export class LeaveCoordinator implements ProjectLifecycleRecoveryOwner {
  readonly #clock: () => Date;
  readonly #coordination: LeaveCoordinatorOptions['coordination'];
  readonly #repository: ExactPersonalRefPort;
  #closed = false;

  constructor(options: LeaveCoordinatorOptions) {
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
    if (this.#closed) return Promise.reject(new LeaveCoordinatorError('closed'));
    return this.#repository.reserveExactRepositoryOperation(projectId);
  }

  async leave(input: Readonly<{
    readonly principalId: string;
    readonly request: LeaveProjectRequest;
  }>): Promise<LeaveProjectResult> {
    if (this.#closed) return fail('closed');
    if (!PRINCIPAL_PATTERN.test(input.principalId)) return fail('authorization-denied');
    const request = canonicalRequest(input.request);
    const fingerprint = requestFingerprint(request);
    let reservation: ExactRepositoryOperationReservation;
    let lease: PinnedProjectLease;
    try {
      reservation = await this.#repository.reserveExactRepositoryOperation(
        request.projectId,
      );
    } catch (error: unknown) {
      return mapDependency(error);
    }
    try {
      lease = await this.#coordination.acquireProjectLease(request.projectId);
    } catch (error: unknown) {
      await reservation.close().catch(() => undefined);
      return mapDependency(error);
    }
    try {
      const callerBinding = await lease.withProjectScope(scope => (
        scope.portability.findProjectPrincipalBinding(input.principalId)
      ));
      if (callerBinding === undefined) return fail('authorization-denied');
      const leaveOperationId = operationId(
        request.projectId,
        callerBinding.memberId,
        request.idempotencyKey,
      );
      let journal = await lease.withProjectScope(scope => (
        scope.portability.getLifecycleJournal(leaveOperationId)
      ));
      if (journal === undefined) {
        const preparation = await lease.withProjectScope(async scope => {
          const binding = await scope.portability.findProjectPrincipalBinding(
            input.principalId,
          );
          if (binding?.state !== 'active') return fail('authorization-denied');
          const membership = await scope.findMembership(binding.memberId);
          const placement = await scope.getRepositoryPlacement();
          const project = await scope.getProject();
          if (
            membership?.status !== 'active'
            || placement?.active !== true
            || project?.serviceState !== 'active'
          ) return fail('authorization-denied');
          if (membership.role === 'manager') {
            const memberships = await scope.listMemberships();
            if (memberships.filter(value => (
              value.status === 'active' && value.role === 'manager'
            )).length <= 1) return fail('manager-succession-required');
          }
          return Object.freeze({
            memberId: membership.memberId,
            membershipRevision: membership.revision,
            placement,
            projectAuthorityGeneration: project.authorityGeneration,
            projectAuthorityStateRevision: project.authorityStateRevision,
          });
        });
        await this.#repository.verifyExactPersonalRef(reservation, {
          expectedOid: request.expectedPersonalRefOid,
          personalRef: collabMemberRef(preparation.memberId),
          placement: preparation.placement,
        });
        journal = await lease.withProjectScope(async scope => {
          const binding = await scope.portability.findProjectPrincipalBinding(
            input.principalId,
          );
          const membership = binding === undefined
            ? undefined
            : await scope.findMembership(binding.memberId);
          const placement = await scope.getRepositoryPlacement();
          const project = await scope.getProject();
          if (
            binding?.state !== 'active'
            || binding.memberId !== preparation.memberId
            || membership?.status !== 'active'
            || membership.revision !== preparation.membershipRevision
            || placement?.active !== true
            || placement.generation !== preparation.placement.generation
            || placement.repositoryStorageKey
              !== preparation.placement.repositoryStorageKey
            || placement.storageNodeId !== preparation.placement.storageNodeId
            || project?.serviceState !== 'active'
            || project.authorityGeneration
              !== preparation.projectAuthorityGeneration
            || project.authorityStateRevision
              !== preparation.projectAuthorityStateRevision
          ) return fail('state-conflict');
          if (membership.role === 'manager') {
            const memberships = await scope.listMemberships();
            if (memberships.filter(value => (
              value.status === 'active' && value.role === 'manager'
            )).length <= 1) return fail('manager-succession-required');
          }
          const createdAt = timestamp(this.#clock);
          await scope.portability.putLifecycleJournal({
            actorMemberId: membership.memberId,
            createdAt,
            direction: undefined,
            expectedAuthorityGeneration: project.authorityGeneration,
            expectedPersonalRefOid: request.expectedPersonalRefOid,
            idempotencyKey: request.idempotencyKey,
            kind: 'leave',
            operationId: leaveOperationId,
            phase: 'prepared',
            projectId: request.projectId,
            requestFingerprint: fingerprint,
            scheduledAt: createdAt,
          });
          const stored = await scope.portability.getLifecycleJournal(leaveOperationId);
          if (stored === undefined) return fail('dependency-failed');
          return stored;
        });
      }
      this.#assertJournal(journal, request, fingerprint);
      await this.#authorizeCaller(
        lease,
        journal,
        input.principalId,
        request,
        fingerprint,
      );
      return await this.#continue(
        lease,
        journal,
        input.principalId,
        request,
        fingerprint,
        reservation,
      );
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
    try {
      if (input.journal.kind !== 'leave' || input.journal.actorMemberId === undefined) {
        return fail('state-conflict');
      }
      if (input.journal.expectedPersonalRefOid === undefined) {
        return fail('recovery-required');
      }
      const request = Object.freeze({
        expectedPersonalRefOid: input.journal.expectedPersonalRefOid,
        idempotencyKey: input.journal.idempotencyKey,
        projectId: input.journal.projectId,
      });
      if (requestFingerprint(request) !== input.journal.requestFingerprint) {
        return fail('recovery-required');
      }
      const reservation = input.repositoryReservation;
      if (reservation === undefined) return fail('recovery-required');
      await this.#continue(
        input.lease,
        input.journal,
        undefined,
        request,
        input.journal.requestFingerprint,
        reservation as ExactRepositoryOperationReservation,
      );
      return 'settled';
    } catch (error: unknown) {
      return mapDependency(error);
    }
  }

  async #continue(
    lease: PinnedProjectLease,
    initial: ProjectLifecycleJournalRecord,
    principalId: string | undefined,
    request: LeaveProjectRequest,
    fingerprint: string,
    reservation: ExactRepositoryOperationReservation,
  ): Promise<LeaveProjectResult> {
    if (initial.actorMemberId === undefined) return fail('recovery-required');
    let journal = initial;
    if (journal.state === 'completed' && journal.phase === 'completed') {
      const replay = principalId === undefined
        ? await this.#recoveryReplay(lease, journal)
        : await this.#authorizedReplay(
            lease, journal, principalId, request, fingerprint,
          );
      return resultFor(request.projectId, replay);
    }
    if (
      journal.state === 'cancelled'
      && journal.phase === 'manager-succession-required'
    ) return fail('manager-succession-required');
    if (journal.state !== 'active') return fail('recovery-required');
    if (journal.phase === 'prepared') {
      const leavingMemberId = journal.actorMemberId;
      if (leavingMemberId === undefined) return fail('recovery-required');
      const placement = await lease.withProjectScope(scope => (
        scope.getRepositoryPlacement()
      ));
      if (placement?.active !== true) return fail('recovery-required');
      await this.#repository.verifyExactPersonalRef(reservation, {
        expectedOid: request.expectedPersonalRefOid,
        personalRef: collabMemberRef(leavingMemberId),
        placement,
      });
      await lease.withProjectScope(async scope => {
        const membership = await scope.findMembership(journal.actorMemberId as CollabMemberId);
        if (membership?.status !== 'active') return fail('recovery-required');
        let exactPrincipalId = principalId;
        if (exactPrincipalId === undefined) {
          const bindings = await scope.portability.listActiveProjectPrincipalBindings();
          exactPrincipalId = bindings.find(value => (
            value.memberId === membership.memberId
          ))?.principalId;
          if (exactPrincipalId === undefined) return fail('recovery-required');
        }
        const leftAt = timestamp(this.#clock, journal.updatedAt);
        const settlement = await scope.portability.settleLeaveMembership({
          expectedMembershipRevision: membership.revision,
          leftAt,
          memberId: membership.memberId,
          operationId: journal.operationId,
        });
        if (settlement === 'last-manager') {
          await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'prepared', expectedState: 'active',
            nextPhase: 'manager-succession-required', nextState: 'cancelled',
            operationId: journal.operationId, scheduledAt: journal.scheduledAt,
            updatedAt: leftAt,
          });
          return fail('manager-succession-required');
        }
        await scope.portability.putLeaveFormerPrincipalReplay({
          createdAt: leftAt,
          expectedPersonalRefOid: request.expectedPersonalRefOid,
          expiresAt: new Date(Date.parse(leftAt) + TERMINAL_RETENTION_MS).toISOString(),
          intentId: request.idempotencyKey,
          memberId: membership.memberId,
          operationId: journal.operationId,
          principalId: exactPrincipalId,
          requestFingerprint: fingerprint,
        });
        await scope.appendProjectEvent({
          kind: 'membership.updated',
          occurredAt: leftAt,
          payload: { memberId: membership.memberId },
        });
        await scope.portability.advanceLifecycleJournal({
          expectedPhase: 'prepared', expectedState: 'active',
          nextPhase: 'membership-left', nextState: 'active',
          operationId: journal.operationId, scheduledAt: journal.scheduledAt,
          updatedAt: leftAt,
        });
      });
      journal = await this.#journal(lease, journal.operationId);
    }
    if (journal.phase === 'membership-left') {
      const leavingMemberId = journal.actorMemberId;
      if (leavingMemberId === undefined) return fail('recovery-required');
      const placement = await lease.withProjectScope(scope => (
        scope.getRepositoryPlacement()
      ));
      if (placement?.active !== true) return fail('recovery-required');
      try {
        await this.#repository.deleteExactPersonalRef(reservation, {
          expectedOid: request.expectedPersonalRefOid,
          personalRef: collabMemberRef(leavingMemberId),
          placement,
        });
      } catch (error: unknown) {
        if (
          error instanceof RepositoryCheckpointError
          && (error.code === 'repository-invalid' || error.code === 'placement-rejected')
        ) {
          await lease.withProjectScope(scope => (
            scope.portability.advanceLifecycleJournal({
              expectedPhase: 'membership-left', expectedState: 'active',
              nextPhase: 'recovery-required', nextState: 'recovery-required',
              operationId: journal.operationId,
              recoveryFromPhase: 'membership-left',
              scheduledAt: journal.scheduledAt,
              updatedAt: timestamp(this.#clock, journal.updatedAt),
            })
          ));
        }
        throw error;
      }
      await lease.withProjectScope(scope => scope.portability.advanceLifecycleJournal({
        expectedPhase: 'membership-left', expectedState: 'active',
        nextPhase: 'personal-ref-removed', nextState: 'active',
        operationId: journal.operationId, scheduledAt: journal.scheduledAt,
        updatedAt: timestamp(this.#clock, journal.updatedAt),
      }));
      journal = await this.#journal(lease, journal.operationId);
    }
    if (journal.phase === 'personal-ref-removed') {
      const replay = principalId === undefined
        ? await this.#recoveryReplay(lease, journal)
        : await this.#authorizedReplay(
            lease, journal, principalId, request, fingerprint,
          );
      const result = resultFor(request.projectId, replay);
      const digest = sha256(JSON.stringify(result));
      const completedAt = timestamp(this.#clock, journal.updatedAt);
      await lease.withProjectScope(async scope => {
        if (principalId === undefined) {
          await scope.portability.completeLeaveFormerPrincipalReplayRecovery({
            completedAt,
            operationId: journal.operationId,
            resultSha256: digest,
          });
        } else {
          await scope.portability.completeLeaveFormerPrincipalReplay({
            completedAt,
            expectedPersonalRefOid: request.expectedPersonalRefOid,
            intentId: request.idempotencyKey,
            memberId: replay.memberId,
            operationId: journal.operationId,
            principalId,
            requestFingerprint: fingerprint,
            resultSha256: digest,
          });
        }
        await scope.portability.advanceLifecycleJournal({
          expectedPhase: 'personal-ref-removed', expectedState: 'active',
          nextPhase: 'completed', nextState: 'completed',
          operationId: journal.operationId, resultSha256: digest,
          scheduledAt: journal.scheduledAt, updatedAt: completedAt,
        });
      });
      return result;
    }
    return fail('recovery-required');
  }

  async #authorizedReplay(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    principalId: string,
    request: LeaveProjectRequest,
    fingerprint: string,
  ): Promise<LeaveFormerPrincipalReplayRecord> {
    if (journal.actorMemberId === undefined) return fail('recovery-required');
    const replay = await lease.withProjectScope(scope => (
      scope.portability.findLeaveFormerPrincipalReplay({
        expectedPersonalRefOid: request.expectedPersonalRefOid,
        intentId: request.idempotencyKey,
        memberId: journal.actorMemberId as CollabMemberId,
        operationId: journal.operationId,
        principalId,
        requestFingerprint: fingerprint,
        requestedAt: timestamp(this.#clock),
      })
    ));
    if (replay === undefined) return fail('authorization-denied');
    return replay;
  }

  async #authorizeCaller(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    principalId: string,
    request: LeaveProjectRequest,
    fingerprint: string,
  ): Promise<void> {
    if (journal.actorMemberId === undefined) return fail('recovery-required');
    const activeBinding = await lease.withProjectScope(scope => (
      scope.portability.findProjectPrincipalBinding(principalId)
    ));
    if (
      activeBinding?.state === 'active'
      && activeBinding.memberId === journal.actorMemberId
    ) return;
    await this.#authorizedReplay(
      lease,
      journal,
      principalId,
      request,
      fingerprint,
    );
  }

  async #recoveryReplay(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
  ): Promise<LeaveFormerPrincipalReplayRecord> {
    const replay = await lease.withProjectScope(scope => (
      scope.portability.getLeaveFormerPrincipalReplay(journal.operationId)
    ));
    if (
      replay === undefined
      || replay.memberId !== journal.actorMemberId
      || replay.intentId !== journal.idempotencyKey
    ) return fail('recovery-required');
    return replay;
  }

  async #journal(
    lease: PinnedProjectLease,
    operation: string,
  ): Promise<ProjectLifecycleJournalRecord> {
    const journal = await lease.withProjectScope(scope => (
      scope.portability.getLifecycleJournal(operation)
    ));
    return journal ?? fail('recovery-required');
  }

  #assertJournal(
    journal: ProjectLifecycleJournalRecord,
    request: LeaveProjectRequest,
    fingerprint: string,
  ): void {
    if (
      journal.kind !== 'leave'
      || journal.projectId !== request.projectId
      || journal.idempotencyKey !== request.idempotencyKey
      || journal.requestFingerprint !== fingerprint
      || journal.expectedPersonalRefOid !== request.expectedPersonalRefOid
    ) return fail('state-conflict');
  }
}
