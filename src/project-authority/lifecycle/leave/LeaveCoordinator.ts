import { createHash } from 'node:crypto';

import {
  CollabError,
  collabControlOperationCodec,
  collabMemberRef,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  type LeaveProjectRequest,
  type LeaveProjectResponse,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../../coordination/CoordinationError.js';
import type {
  LeaveFormerPrincipalReplayRecord,
  ProjectLifecycleJournalRecord,
} from '../../../coordination/PortabilityLifecyclePersistence.js';
import type {
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
  ProjectMembershipRecord,
  ProjectScope,
} from '../../../coordination/ProjectCoordination.js';
import type { RequestPrincipal } from '../../../request-context/RequestPrincipal.js';
import {
  OperationDrain,
  OperationDrainClosedError,
} from '../../OperationDrain.js';
import {
  ProjectRecoveryError,
  type ProjectRecoveryPort,
} from '../../admission/ProjectWriteAdmission.js';
import { hasNonterminalProjectMutation } from '../../admission/hasNonterminalProjectMutation.js';
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

export interface LeaveCoordinatorOptions {
  readonly clock?: () => Date;
  readonly coordination: Readonly<{
    acquireProjectLease(
      projectId: CollabProjectId,
      options?: AcquireProjectLeaseOptions,
    ): Promise<PinnedProjectLease>;
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
  const decoded = collabControlOperationCodec('leaveProject').decodeRequest(request);
  if (decoded.status !== 'ok') throw decoded.error;
  return decoded.value;
}

function requestFingerprint(request: LeaveProjectRequest): string {
  return sha256(JSON.stringify({
    expectedManagerSetGeneration: request.expectedManagerSetGeneration,
    expectedMembershipRevision: request.expectedMembershipRevision,
    expectedOfferRevision: request.expectedOfferRevision,
    expectedPersonalRefOid: request.expectedPersonalRefOid,
    idempotencyKey: request.idempotencyKey,
    managerResponsibilityOfferId: request.managerResponsibilityOfferId,
    projectId: request.projectId,
  }));
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
  replay: LeaveFormerPrincipalReplayRecord,
): LeaveProjectResponse {
  return replay.response;
}

function publicFailure(error: unknown): never {
  if (error instanceof CollabError) throw error;
  if (error instanceof LeaveCoordinatorError) {
    if (error.code === 'authorization-denied') {
      throw new CollabError({
        code: 'authorization-denied',
        safeContext: { reason: 'leave-project-denied' },
      });
    }
    if (
      error.code === 'manager-succession-required'
      || error.code === 'state-conflict'
      || error.code === 'recovery-required'
    ) {
      throw new CollabError({
        code: 'authority-not-synchronized',
        safeContext: { reason: 'leave-project-expected-state' },
      });
    }
  }
  if (error instanceof RepositoryCheckpointError && (
    error.code === 'repository-invalid'
    || error.code === 'placement-rejected'
  )) {
    throw new CollabError({
      code: 'personal-ref-diverged',
      safeContext: { reason: 'leave-project-personal-ref' },
    });
  }
  throw new CollabError({
    code: 'operation-failed',
    recoveryActions: ['retry'],
    safeContext: { reason: 'leave-project-unavailable' },
  });
}

function mapDependency(error: unknown): never {
  if (error instanceof OperationDrainClosedError) return fail('closed');
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

export class LeaveCoordinator
implements ProjectLifecycleRecoveryOwner, ProjectRecoveryPort {
  readonly #clock: () => Date;
  readonly #coordination: LeaveCoordinatorOptions['coordination'];
  readonly #operations = new OperationDrain();
  readonly #repository: ExactPersonalRefPort;

  constructor(options: LeaveCoordinatorOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#repository = options.repository;
  }

  close(): Promise<void> {
    return this.#operations.close();
  }

  reserveRecovery(
    projectId: CollabProjectId,
  ): Promise<ExactRepositoryOperationReservation> {
    if (this.#operations.closed) {
      return Promise.reject(new LeaveCoordinatorError('closed'));
    }
    return this.#repository.reserveExactRepositoryOperation(projectId);
  }

  recoverProject(projectId: CollabProjectId): Promise<void> {
    return this.#operations.run({}, signal => this.#recoverProject(
      projectId,
      signal,
    )).catch((error: unknown) => {
      if (error instanceof OperationDrainClosedError) {
        throw new ProjectRecoveryError('closed');
      }
      throw error;
    });
  }

  async #recoverProject(projectId: CollabProjectId, signal: AbortSignal): Promise<void> {
    let reservation: ExactRepositoryOperationReservation | undefined;
    let lease: PinnedProjectLease | undefined;
    try {
      reservation = await this.#repository.reserveExactRepositoryOperation(
        projectId,
        signal,
      );
      lease = await this.#coordination.acquireProjectLease(projectId, { signal });
      const journal = await lease.withProjectScope(scope => (
        scope.portability.getNonterminalLifecycleJournal()
      ));
      if (journal?.kind !== 'leave') return;
      await this.#recover({
        journal,
        lease,
        repositoryReservation: reservation,
      }, signal);
    } catch (error: unknown) {
      if (error instanceof ProjectRecoveryError) throw error;
      throw new ProjectRecoveryError(
        error instanceof LeaveCoordinatorError && error.code === 'closed'
          ? 'closed'
          : 'recovery-required',
      );
    } finally {
      await lease?.close().catch(() => undefined);
      await reservation?.close().catch(() => undefined);
    }
  }

  leave(
    principal: RequestPrincipal,
    input: LeaveProjectRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<LeaveProjectResponse> {
    return this.#operations.run(options, signal => this.#leave(
      principal,
      input,
      { signal },
    )).catch(publicFailure);
  }

  async #leave(
    principal: RequestPrincipal,
    input: LeaveProjectRequest,
    options: Readonly<{ readonly signal: AbortSignal }>,
  ): Promise<LeaveProjectResponse> {
    if (!PRINCIPAL_PATTERN.test(principal.principalId)) {
      return publicFailure(new LeaveCoordinatorError('authorization-denied'));
    }
    const request = canonicalRequest(input);
    const fingerprint = requestFingerprint(request);
    let reservation: ExactRepositoryOperationReservation;
    let lease: PinnedProjectLease;
    try {
      reservation = await this.#repository.reserveExactRepositoryOperation(
        request.projectId,
        options.signal,
      );
    } catch (error: unknown) {
      return publicFailure(error);
    }
    try {
      lease = await this.#coordination.acquireProjectLease(
        request.projectId,
        { signal: options.signal },
      );
    } catch (error: unknown) {
      await reservation.close().catch(() => undefined);
      return publicFailure(error);
    }
    try {
      const callerBinding = await lease.withProjectScope(scope => (
        scope.portability.findProjectPrincipalBinding(principal.principalId)
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
        if (await lease.withProjectScope(hasNonterminalProjectMutation, options)) {
          return fail('recovery-required');
        }
        const preparedAt = timestamp(this.#clock);
        const preparation = await lease.withProjectScope(async scope => {
          const binding = await scope.portability.findProjectPrincipalBinding(
            principal.principalId,
          );
          if (binding?.state !== 'active') return fail('authorization-denied');
          const membership = await scope.findMembership(binding.memberId);
          const placement = await scope.getRepositoryPlacement();
          const project = await scope.getProject();
          if (
            membership?.status !== 'active'
            || placement?.active !== true
            || project?.serviceState !== 'active'
            || membership.revision !== BigInt(request.expectedMembershipRevision)
            || project.managerSetGeneration !== request.expectedManagerSetGeneration
          ) return fail('state-conflict');
          await this.#validateSuccession(scope, membership, request, preparedAt);
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
            principal.principalId,
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
            || project.managerSetGeneration !== request.expectedManagerSetGeneration
            || membership.revision !== BigInt(request.expectedMembershipRevision)
          ) return fail('state-conflict');
          await this.#validateSuccession(scope, membership, request, preparedAt);
          const createdAt = preparedAt;
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
          await scope.portability.putLeaveProjectRequestFacts({
            expectedManagerSetGeneration: request.expectedManagerSetGeneration,
            expectedMembershipRevision: request.expectedMembershipRevision,
            expectedOfferRevision: request.expectedOfferRevision,
            managerResponsibilityOfferId: request.managerResponsibilityOfferId,
            operationId: leaveOperationId,
            projectId: request.projectId,
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
        principal.principalId,
        request,
        fingerprint,
      );
      return await this.#continue(
        lease,
        journal,
        principal.principalId,
        request,
        fingerprint,
        reservation,
        options.signal,
      );
    } catch (error: unknown) {
      return publicFailure(error);
    } finally {
      await lease.close().catch(() => undefined);
      await reservation.close().catch(() => undefined);
    }
  }

  recover(
    input: RecoverProjectLifecycleInput,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    return this.#operations.run({}, signal => this.#recover(
      input,
      signal,
    )).catch(mapDependency);
  }

  async #recover(
    input: RecoverProjectLifecycleInput,
    signal: AbortSignal,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    try {
      if (input.journal.kind !== 'leave' || input.journal.actorMemberId === undefined) {
        return fail('state-conflict');
      }
      if (input.journal.expectedPersonalRefOid === undefined) {
        return fail('recovery-required');
      }
      const facts = await input.lease.withProjectScope(scope => (
        scope.portability.getLeaveProjectRequestFacts(input.journal.operationId)
      ));
      if (facts === undefined) return fail('recovery-required');
      const request = canonicalRequest(Object.freeze({
        expectedManagerSetGeneration: facts.expectedManagerSetGeneration,
        expectedMembershipRevision: facts.expectedMembershipRevision,
        expectedOfferRevision: facts.expectedOfferRevision,
        expectedPersonalRefOid: input.journal.expectedPersonalRefOid,
        idempotencyKey: input.journal.idempotencyKey,
        managerResponsibilityOfferId: facts.managerResponsibilityOfferId,
        projectId: input.journal.projectId,
      }));
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
        signal,
      );
      return 'settled';
    } catch (error: unknown) {
      return mapDependency(error);
    }
  }

  async #validateSuccession(
    scope: ProjectScope,
    membership: ProjectMembershipRecord,
    request: LeaveProjectRequest,
    now: string,
  ): Promise<void> {
    const memberships = await scope.listMemberships();
    const activeManagerCount = memberships.filter(value => (
      value.status === 'active' && value.role === 'manager'
    )).length;
    if (membership.role !== 'manager' || activeManagerCount > 1) {
      if (
        request.managerResponsibilityOfferId !== null
        || request.expectedOfferRevision !== null
      ) return fail('state-conflict');
      return;
    }
    if (
      activeManagerCount !== 1
      || request.managerResponsibilityOfferId === null
    ) return fail('manager-succession-required');
    const offer = await scope.membership.getManagerResponsibilityOffer({
      actorMemberId: membership.memberId,
      actorRole: 'manager',
      now,
      offerId: request.managerResponsibilityOfferId,
    });
    if (
      offer === undefined
      || offer.sourceManagerMemberId !== membership.memberId
      || offer.purpose !== 'manager-leave'
      || offer.state !== 'acknowledged'
      || offer.revision !== request.expectedOfferRevision
      || offer.managerSetGenerationAtOffer !== request.expectedManagerSetGeneration
    ) return fail('manager-succession-required');
    const successor = await scope.findMembership(offer.targetMemberId);
    if (
      successor?.status !== 'active'
      || successor.role !== 'member'
      || successor.revision !== BigInt(offer.targetMembershipRevisionAtOffer)
    ) return fail('manager-succession-required');
  }

  async #continue(
    lease: PinnedProjectLease,
    initial: ProjectLifecycleJournalRecord,
    principalId: string | undefined,
    request: LeaveProjectRequest,
    fingerprint: string,
    reservation: ExactRepositoryOperationReservation,
    signal?: AbortSignal,
  ): Promise<LeaveProjectResponse> {
    if (initial.actorMemberId === undefined) return fail('recovery-required');
    let journal = initial;
    if (journal.state === 'completed' && journal.phase === 'completed') {
      const replay = principalId === undefined
        ? await this.#recoveryReplay(lease, journal)
        : await this.#authorizedReplay(
            lease, journal, principalId, request, fingerprint,
          );
      return resultFor(replay);
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
        ...(signal === undefined ? {} : { signal }),
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
        const leftAt = journal.scheduledAt;
        const settlement = await scope.portability.settleLeaveMembership({
          expectedManagerSetGeneration: request.expectedManagerSetGeneration,
          expectedMembershipRevision: BigInt(request.expectedMembershipRevision),
          expectedOfferRevision: request.expectedOfferRevision,
          leftAt,
          managerResponsibilityOfferId: request.managerResponsibilityOfferId,
          memberId: membership.memberId,
          operationId: journal.operationId,
        });
        if (settlement.status === 'last-manager') {
          return fail('recovery-required');
        }
        if (settlement.status === 'stale' || settlement.response === undefined) {
          return fail('state-conflict');
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
          response: settlement.response,
        });
        await scope.appendProjectEvent({
          kind: 'membership.updated',
          occurredAt: leftAt,
          payload: { memberId: membership.memberId },
        });
        if (settlement.response.promotedSuccessorMemberId !== null) {
          await scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: leftAt,
            payload: { memberId: settlement.response.promotedSuccessorMemberId },
          });
        }
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
          ...(signal === undefined ? {} : { signal }),
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
      const result = resultFor(replay);
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
