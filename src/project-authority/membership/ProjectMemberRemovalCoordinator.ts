import { createHash } from 'node:crypto';

import {
  CollabError,
  collabControlOperationCodec,
  collabMemberRef,
  type CollabProjectId,
  type RemoveMemberRequest,
  type RemoveMemberResponse,
} from '@claudian-collab/protocol';

import type {
  ProjectMemberRemovalJournal,
} from '../../coordination/ProjectMembershipPersistence.js';
import type {
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
} from '../../coordination/ProjectCoordination.js';
import { ProjectMutationRejection } from '../ProjectMutationRejection.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import {
  OperationDrain,
  OperationDrainClosedError,
} from '../OperationDrain.js';
import {
  RepositoryCheckpointError,
  type ExactPersonalRefPort,
  type ExactPersonalRefReadPort,
  type ExactRepositoryOperationReservation,
} from '../../repositories/RepositoryCheckpointAuthority.js';
import {
  ProjectRecoveryError,
  type ProjectRecoveryPort,
} from '../admission/ProjectWriteAdmission.js';
import { hasNonterminalProjectMutation } from '../admission/hasNonterminalProjectMutation.js';
import type {
  ProjectLifecycleRecoveryOutcome,
  ProjectLifecycleRecoveryOwner,
  RecoverProjectLifecycleInput,
} from '../lifecycle/ProjectLifecycleRecoveryDispatcher.js';

export interface ProjectMemberRemovalCoordinatorOptions {
  readonly clock?: () => Date;
  readonly coordination: Readonly<{
    acquireProjectLease(
      projectId: CollabProjectId,
      options?: AcquireProjectLeaseOptions,
    ): Promise<PinnedProjectLease>;
  }>;
  readonly repository: ExactPersonalRefPort & ExactPersonalRefReadPort;
}

function domainError(
  code: ConstructorParameters<typeof CollabError>[0]['code'],
  reason: string,
  retry = false,
): CollabError {
  return new CollabError({
    code,
    ...(retry ? { recoveryActions: ['retry'] as const } : {}),
    safeContext: { reason },
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function operationId(
  projectId: CollabProjectId,
  actorMemberId: string,
  idempotencyKey: string,
): string {
  return `remove_${sha256(
    `${projectId}\0${actorMemberId}\0${idempotencyKey}`,
  ).slice(0, 48)}`;
}

function canonicalNow(clock: () => Date, after?: string): string {
  const observed = new Date(clock().valueOf());
  if (Number.isNaN(observed.valueOf())) throw new Error('invalid-clock');
  observed.setUTCMilliseconds(0);
  const value = after === undefined
    ? observed.valueOf()
    : Math.max(observed.valueOf(), Date.parse(after) + 1_000);
  return new Date(value).toISOString();
}

function requestFingerprint(request: RemoveMemberRequest): string {
  return sha256(JSON.stringify(request));
}

function mapStatus(status: string): never {
  if (status === 'permanently-stale') {
    throw new ProjectMutationRejection({
      code: 'authority-not-synchronized',
      safeContext: { reason: 'member-removal-expected-state' },
    });
  }
  if (status === 'authorization-denied') {
    throw domainError('authorization-denied', 'member-removal-denied');
  }
  if (status === 'stale' || status === 'final-manager') {
    throw domainError('authority-not-synchronized', 'member-removal-expected-state');
  }
  throw domainError('idempotency-conflict', 'member-removal-conflict');
}

function mapPublicFailure(error: unknown): never {
  if (error instanceof CollabError) throw error;
  if (error instanceof RepositoryCheckpointError) {
    if (
      error.code === 'repository-invalid'
      || error.code === 'placement-rejected'
      || error.code === 'invalid-checkpoint'
    ) {
      throw domainError('personal-ref-diverged', 'member-removal-personal-ref');
    }
  }
  throw domainError('operation-failed', 'member-removal-unavailable', true);
}

export class ProjectMemberRemovalCoordinator
implements ProjectRecoveryPort, ProjectLifecycleRecoveryOwner {
  readonly #clock: () => Date;
  readonly #coordination: ProjectMemberRemovalCoordinatorOptions['coordination'];
  readonly #operations = new OperationDrain();
  readonly #repository: ExactPersonalRefPort & ExactPersonalRefReadPort;

  constructor(options: ProjectMemberRemovalCoordinatorOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#repository = options.repository;
  }

  close(): Promise<void> {
    return this.#operations.close();
  }

  remove(
    principal: IngressPrincipal,
    request: RemoveMemberRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<RemoveMemberResponse> {
    return this.#operations.run(options, signal => this.#remove(
      principal,
      request,
      { signal },
    )).catch(mapPublicFailure);
  }

  async #remove(
    principal: IngressPrincipal,
    request: RemoveMemberRequest,
    options: Readonly<{ readonly signal: AbortSignal }>,
  ): Promise<RemoveMemberResponse> {
    const decoded = collabControlOperationCodec('removeMember').decodeRequest(request);
    if (decoded.status !== 'ok') throw decoded.error;
    let reservation: ExactRepositoryOperationReservation | undefined;
    let lease: PinnedProjectLease | undefined;
    try {
      reservation = await this.#repository.reserveExactRepositoryOperation(
        request.projectId,
        options.signal,
      );
      lease = await this.#coordination.acquireProjectLease(
        request.projectId,
        { signal: options.signal },
      );
      const binding = await lease.withProjectScope(scope => (
        scope.portability.findProjectPrincipalBinding(principal.principalId)
      ), options);
      if (binding?.state !== 'active') return mapStatus('authorization-denied');
      const removalOperationId = operationId(
        request.projectId,
        binding.memberId,
        request.idempotencyKey,
      );
      let journal = await lease.withProjectScope(scope => (
        scope.membership.getRemoval(removalOperationId)
      ), options);
      if (journal === undefined) {
        if (await lease.withProjectScope(hasNonterminalProjectMutation, options)) {
          throw domainError(
            'authority-not-synchronized',
            'project-mutation-recovery-required',
          );
        }
        const facts = await lease.withProjectScope(async scope => {
          const actor = await scope.findMembership(binding.memberId);
          const target = await scope.findMembership(request.targetMemberId);
          const placement = await scope.getRepositoryPlacement();
          const project = await scope.getProject();
          if (actor?.status !== 'active' || actor.role !== 'manager') {
            return mapStatus('authorization-denied');
          }
          if (
            binding.memberId !== request.targetMemberId
            && target !== undefined
            && project !== undefined
            && (project.managerSetGeneration > request.expectedManagerSetGeneration
              || target.revision > BigInt(request.expectedTargetMembershipRevision))
          ) return mapStatus('permanently-stale');
          if (
            target?.status !== 'active'
            || placement?.active !== true
            || project?.serviceState !== 'active'
          ) return mapStatus('stale');
          return Object.freeze({ placement });
        }, options);
        const expectedPersonalRefOid = await this.#repository.readExactPersonalRef(
          reservation,
          {
            personalRef: collabMemberRef(request.targetMemberId),
            placement: facts.placement,
            signal: options.signal,
          },
        );
        const preparedAt = canonicalNow(this.#clock);
        const result = await lease.withProjectScope(scope => (
          scope.membership.prepareRemoval({
            actorMemberId: binding.memberId,
            expectedManagerSetGeneration: request.expectedManagerSetGeneration,
            expectedPersonalRefOid,
            expectedTargetMembershipRevision:
              request.expectedTargetMembershipRevision,
            idempotencyKey: request.idempotencyKey,
            operationId: removalOperationId,
            personalRef: collabMemberRef(request.targetMemberId),
            placementGeneration: facts.placement.generation,
            preparedAt,
            projectId: request.projectId,
            repositoryStorageKey: facts.placement.repositoryStorageKey,
            requestFingerprint: requestFingerprint(request),
            storageNodeId: facts.placement.storageNodeId,
            targetMemberId: request.targetMemberId,
          })
        ), options);
        if (result.status !== 'created' && result.status !== 'replayed') {
          return mapStatus(result.status);
        }
        journal = result.journal;
      }
      if (
        journal === undefined
        || journal.requestFingerprint !== requestFingerprint(request)
        || journal.actorMemberId !== binding.memberId
        || journal.targetMemberId !== request.targetMemberId
      ) return mapStatus('conflict');
      return await this.#continue(lease, reservation, journal, options.signal);
    } finally {
      await lease?.close().catch(() => undefined);
      await reservation?.close().catch(() => undefined);
    }
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
        scope.membership.getNonterminalRemoval()
      ));
      if (journal !== undefined) {
        await this.#continue(lease, reservation, journal, signal);
      }
    } catch (error: unknown) {
      throw new ProjectRecoveryError(
        error instanceof RepositoryCheckpointError
          && error.code === 'closed'
          ? 'closed'
          : 'recovery-required',
      );
    } finally {
      await lease?.close().catch(() => undefined);
      await reservation?.close().catch(() => undefined);
    }
  }

  reserveRecovery(
    projectId: CollabProjectId,
  ): Promise<ExactRepositoryOperationReservation> {
    if (this.#operations.closed) {
      return Promise.reject(new ProjectRecoveryError('closed'));
    }
    return this.#repository.reserveExactRepositoryOperation(projectId);
  }

  recover(
    input: RecoverProjectLifecycleInput,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    return this.#operations.run({}, signal => this.#recover(input, signal)).catch(
      (error: unknown) => {
        if (error instanceof OperationDrainClosedError) {
          throw new ProjectRecoveryError('closed');
        }
        throw error;
      },
    );
  }

  async #recover(
    input: RecoverProjectLifecycleInput,
    signal: AbortSignal,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    if (input.journal.kind !== 'remove-member') {
      throw new ProjectRecoveryError('recovery-required');
    }
    const reservation = input.repositoryReservation;
    if (reservation === undefined) throw new ProjectRecoveryError('recovery-required');
    const journal = await input.lease.withProjectScope(scope => (
      scope.membership.getRemoval(input.journal.operationId)
    ));
    if (journal === undefined) throw new ProjectRecoveryError('recovery-required');
    await this.#continue(
      input.lease,
      reservation as ExactRepositoryOperationReservation,
      journal,
      signal,
    );
    return 'settled';
  }

  async #continue(
    lease: PinnedProjectLease,
    reservation: ExactRepositoryOperationReservation,
    initial: ProjectMemberRemovalJournal,
    signal?: AbortSignal,
  ): Promise<RemoveMemberResponse> {
    let journal = initial;
    const placement = Object.freeze({
      active: true,
      generation: journal.placementGeneration,
      projectId: journal.projectId,
      repositoryStorageKey: journal.repositoryStorageKey,
      storageNodeId: journal.storageNodeId,
    });
    if (journal.phase === 'prepared') {
      await this.#repository.verifyExactPersonalRef(reservation, {
        expectedOid: journal.expectedPersonalRefOid,
        personalRef: journal.personalRef,
        placement,
        ...(signal === undefined ? {} : { signal }),
      });
      const settled = await lease.withProjectScope<RemoveMemberResponse>(async scope => {
        const result = await scope.membership.settleRemoval({
          operationId: journal.operationId,
          removedAt: canonicalNow(this.#clock, journal.updatedAt),
        });
        if (result.status === 'stale' || result.response === undefined) {
          return mapStatus('stale');
        }
        if (result.status === 'settled') {
          await scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: result.response.removedAt,
            payload: { memberId: result.response.memberId },
          });
        }
        return result.response;
      }, signal === undefined ? {} : { signal });
      journal = await this.#journal(lease, journal.operationId, signal);
      if (journal.response === undefined || journal.response.memberId !== settled.memberId) {
        throw domainError('operation-failed', 'member-removal-recovery', true);
      }
    }
    if (journal.phase === 'membership-revoked') {
      await this.#repository.deleteExactPersonalRef(reservation, {
        expectedOid: journal.expectedPersonalRefOid,
        personalRef: journal.personalRef,
        placement,
        ...(signal === undefined ? {} : { signal }),
      });
      await lease.withProjectScope(scope => scope.membership.advanceRemoval({
        expectedPhase: 'membership-revoked',
        nextPhase: 'personal-ref-removed',
        operationId: journal.operationId,
        updatedAt: canonicalNow(this.#clock, journal.updatedAt),
      }), signal === undefined ? {} : { signal });
      journal = await this.#journal(lease, journal.operationId, signal);
    }
    if (journal.phase === 'personal-ref-removed') {
      return lease.withProjectScope(scope => scope.membership.completeRemoval({
        completedAt: canonicalNow(this.#clock, journal.updatedAt),
        operationId: journal.operationId,
      }), signal === undefined ? {} : { signal });
    }
    if (journal.phase === 'completed' && journal.response !== undefined) {
      return journal.response;
    }
    throw domainError('operation-failed', 'member-removal-recovery', true);
  }

  async #journal(
    lease: PinnedProjectLease,
    operation: string,
    signal?: AbortSignal,
  ): Promise<ProjectMemberRemovalJournal> {
    const journal = await lease.withProjectScope<
      ProjectMemberRemovalJournal | undefined
    >(scope => (
      scope.membership.getRemoval(operation)
    ), signal === undefined ? {} : { signal });
    if (journal === undefined) {
      throw domainError('operation-failed', 'member-removal-recovery', true);
    }
    return journal;
  }
}
