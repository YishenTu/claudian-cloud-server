import { createHash } from 'node:crypto';

import {
  decodeCollabProjectRetirementAcknowledgement,
  decodeCollabProjectRetirementOperationRequest,
  decodeCollabProjectRetirementResult,
  type CollabIsoTimestamp,
  type CollabProjectId,
  type CollabProjectRetirementAcknowledgement,
  type CollabProjectRetirementAcknowledgementRequest,
  type CollabProjectRetirementRequest,
  type CollabProjectRetirementResult,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../../coordination/CoordinationError.js';
import type {
  ProjectLifecycleJournalRecord,
  TerminalResponderRecord,
} from '../../../coordination/PortabilityLifecyclePersistence.js';
import type { PinnedProjectLease } from '../../../coordination/ProjectCoordination.js';
import type {
  ProjectLifecycleRecoveryOutcome,
  ProjectLifecycleRecoveryOwner,
  RecoverProjectLifecycleInput,
} from '../ProjectLifecycleRecoveryDispatcher.js';
import type {
  ExactRepositoryOperationReservation,
  ExactRepositoryPresencePort,
} from '../../../repositories/RepositoryCheckpointAuthority.js';

export type RetireCoordinatorErrorCode =
  | 'authorization-denied'
  | 'closed'
  | 'dependency-failed'
  | 'expired'
  | 'recovery-required'
  | 'state-conflict';

export class RetireCoordinatorError extends Error {
  readonly code: RetireCoordinatorErrorCode;
  readonly retryable: boolean;

  constructor(code: RetireCoordinatorErrorCode) {
    super(`retire-coordinator.error.${code}`);
    this.name = 'RetireCoordinatorError';
    this.code = code;
    this.retryable = code === 'dependency-failed';
  }
}

export interface RetireCoordinatorOptions {
  readonly clock?: () => Date;
  readonly coordination: Readonly<{
    acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
  }>;
  readonly repository: ExactRepositoryPresencePort;
}

const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function fail(code: RetireCoordinatorErrorCode): never {
  throw new RetireCoordinatorError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function retirementId(projectId: CollabProjectId, idempotencyKey: string): string {
  return `retire_${sha256(`${projectId}\0${idempotencyKey}`).slice(0, 48)}`;
}

function deletionId(retirement: string): string {
  return `delete_${sha256(retirement).slice(0, 48)}`;
}

function canonicalRequest(value: unknown): CollabProjectRetirementRequest {
  try {
    return decodeCollabProjectRetirementOperationRequest('retireProject', value);
  } catch {
    return fail('state-conflict');
  }
}

function canonicalAcknowledgementRequest(
  value: unknown,
): CollabProjectRetirementAcknowledgementRequest {
  try {
    return decodeCollabProjectRetirementOperationRequest(
      'acknowledgeProjectRetirement',
      value,
    );
  } catch {
    return fail('state-conflict');
  }
}

function now(clock: () => Date): CollabIsoTimestamp {
  const observed = clock();
  if (Number.isNaN(observed.valueOf())) return fail('dependency-failed');
  return observed.toISOString();
}

function mapDependency(error: unknown): never {
  if (error instanceof RetireCoordinatorError) throw error;
  if (error instanceof CoordinationError) {
    if (error.code === 'closed') return fail('closed');
    if (error.code === 'invalid-record' || error.code === 'state-conflict') {
      return fail('state-conflict');
    }
  }
  return fail('dependency-failed');
}

function decodeResponse(responder: TerminalResponderRecord): CollabProjectRetirementResult {
  try {
    const result = decodeCollabProjectRetirementResult(
      JSON.parse(responder.responseJson) as unknown,
    );
    if (sha256(responder.responseJson) !== responder.responseSha256) {
      return fail('recovery-required');
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof RetireCoordinatorError) throw error;
    return fail('recovery-required');
  }
}

export class RetireCoordinator implements ProjectLifecycleRecoveryOwner {
  readonly #clock: () => Date;
  readonly #coordination: RetireCoordinatorOptions['coordination'];
  readonly #repository: ExactRepositoryPresencePort;
  #closed = false;

  constructor(options: RetireCoordinatorOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#repository = options.repository;
  }

  close(): void {
    this.#closed = true;
  }

  async retire(input: Readonly<{
    readonly principalId: string;
    readonly request: unknown;
  }>): Promise<CollabProjectRetirementResult> {
    if (this.#closed) return fail('closed');
    if (!PRINCIPAL_PATTERN.test(input.principalId)) return fail('authorization-denied');
    const request = canonicalRequest(input.request);
    const operationId = retirementId(request.projectId, request.idempotencyKey);
    const fingerprint = sha256(JSON.stringify(request));
    let reservation: ExactRepositoryOperationReservation;
    try {
      reservation = await this.#repository.reserveExactRepositoryOperation(
        request.projectId,
      );
    } catch (error: unknown) {
      return mapDependency(error);
    }
    let lease: PinnedProjectLease;
    try {
      lease = await this.#acquire(request.projectId);
    } catch (error: unknown) {
      await reservation.close().catch(() => undefined);
      return mapDependency(error);
    }
    try {
      const replay = await lease.withProjectScope(async scope => {
        const responder = await scope.portability.getTerminalResponder(
          'retire',
          operationId,
        );
        if (responder === undefined) return undefined;
        const journal = await scope.portability.getLifecycleJournal(operationId);
        const exactActor = [
          ...responder.eligiblePrincipals,
          ...responder.acknowledgements,
        ].some(value => (
          value.principalId === input.principalId
          && value.memberId === journal?.actorMemberId
        ));
        if (journal?.requestFingerprint !== fingerprint || !exactActor) {
          return fail('authorization-denied');
        }
        if (Date.parse(now(this.#clock)) >= Date.parse(responder.expiresAt)) {
          return fail('expired');
        }
        return decodeResponse(responder);
      });
      if (replay !== undefined) return replay;
      const preparation = await lease.withProjectScope(async scope => {
        const binding = await scope.portability.findProjectPrincipalBinding(
          input.principalId,
        );
        if (binding?.state !== 'active') return fail('authorization-denied');
        const membership = await scope.findMembership(binding.memberId);
        if (membership?.status !== 'active' || membership.role !== 'manager') {
          return fail('authorization-denied');
        }
        const project = await scope.getProject();
        const placement = await scope.getRepositoryPlacement();
        if (
          project?.serviceState !== 'active'
          || project.authorityGeneration !== request.expectedAuthorityGeneration
          || project.expectedMainOid !== request.expectedMainOid
          || placement?.active !== true
        ) return fail('state-conflict');
        return Object.freeze({
          memberId: membership.memberId,
          membershipRevision: membership.revision,
          placement,
          projectAuthorityGeneration: project.authorityGeneration,
          projectAuthorityStateRevision: project.authorityStateRevision,
        });
      });
      await this.#repository.verifyExactRepository(
        reservation,
        preparation.placement,
      );
      return await lease.withProjectScope(async scope => {
        const binding = await scope.portability.findProjectPrincipalBinding(
          input.principalId,
        );
        const membership = binding === undefined
          ? undefined
          : await scope.findMembership(binding.memberId);
        const project = await scope.getProject();
        const placement = await scope.getRepositoryPlacement();
        if (
          binding?.state !== 'active'
          || binding.memberId !== preparation.memberId
          || membership?.status !== 'active'
          || membership.role !== 'manager'
          || membership.revision !== preparation.membershipRevision
          || project?.serviceState !== 'active'
          || project.authorityGeneration !== preparation.projectAuthorityGeneration
          || project.authorityStateRevision !== preparation.projectAuthorityStateRevision
          || project.authorityGeneration !== request.expectedAuthorityGeneration
          || project.expectedMainOid !== request.expectedMainOid
          || placement?.active !== true
          || placement.generation !== preparation.placement.generation
          || placement.repositoryStorageKey
            !== preparation.placement.repositoryStorageKey
          || placement.storageNodeId !== preparation.placement.storageNodeId
        ) return fail('state-conflict');
        const principals = await scope.portability.listActiveProjectPrincipalBindings();
        if (
          principals.length === 0
          || !principals.some(value => value.memberId === membership.memberId)
        ) return fail('recovery-required');
        const retiredAt = now(this.#clock);
        const terminalExpiresAt = new Date(
          Date.parse(retiredAt) + TERMINAL_RETENTION_MS,
        ).toISOString();
        const result = decodeCollabProjectRetirementResult({
          acknowledgementRequired: true,
          kind: 'project-retired',
          projectId: request.projectId,
          retiredAt,
          retirementId: operationId,
          terminalExpiresAt,
        });
        const responseJson = JSON.stringify(result);
        const resultSha256 = sha256(responseJson);
        const deleteOperationId = deletionId(operationId);
        await scope.portability.putLifecycleJournal({
          actorMemberId: membership.memberId,
          createdAt: retiredAt,
          direction: undefined,
          expectedAuthorityGeneration: project.authorityGeneration,
          idempotencyKey: request.idempotencyKey,
          kind: 'retire',
          operationId,
          phase: 'prepared',
          projectId: request.projectId,
          requestFingerprint: fingerprint,
          scheduledAt: retiredAt,
        });
        await scope.portability.putTerminalResponder({
          createdAt: retiredAt,
          eligiblePrincipals: principals.map(value => ({
            memberId: value.memberId,
            principalId: value.principalId,
          })),
          expiresAt: terminalExpiresAt,
          operationId,
          operationKind: 'retire',
          responseJson,
          responseSha256: resultSha256,
        });
        await scope.portability.putProjectTombstone({
          authorityGeneration: project.authorityGeneration,
          projectId: request.projectId,
          resultSha256,
          retiredAt,
          terminalExpiresAt,
          terminalOperationId: operationId,
          terminalOperationKind: 'retire',
        });
        await scope.appendProjectEvent({
          kind: 'project.retired',
          occurredAt: retiredAt,
          payload: { retiredAt, retirementId: operationId },
        });
        await scope.portability.advanceLifecycleJournal({
          expectedPhase: 'prepared',
          expectedState: 'active',
          nextPhase: 'completed',
          nextState: 'completed',
          operationId,
          resultSha256,
          scheduledAt: retiredAt,
          updatedAt: retiredAt,
        });
        await scope.advanceProjectAuthorityState({
          expectedAuthorityGeneration: project.authorityGeneration,
          expectedAuthorityStateRevision: project.authorityStateRevision,
          expectedServiceState: 'active',
          nextAuthorityGeneration: project.authorityGeneration,
          nextServiceState: 'deleting',
        });
        await scope.portability.putLifecycleJournal({
          actorMemberId: membership.memberId,
          createdAt: retiredAt,
          direction: undefined,
          expectedAuthorityGeneration: project.authorityGeneration,
          idempotencyKey: deleteOperationId,
          kind: 'delete',
          operationId: deleteOperationId,
          phase: 'traffic-denied',
          projectId: request.projectId,
          requestFingerprint: resultSha256,
          scheduledAt: retiredAt,
        });
        await scope.portability.putDeletionIntent({
          authorizationSha256: resultSha256,
          authorizedMemberId: membership.memberId,
          createdAt: retiredAt,
          operationId: deleteOperationId,
          placementGeneration: placement.generation,
          reason: 'retire',
          repositoryStorageKey: placement.repositoryStorageKey,
          storageNodeId: placement.storageNodeId,
          terminalOperationId: operationId,
          terminalOperationKind: 'retire',
        });
        return result;
      });
    } catch (error: unknown) {
      return mapDependency(error);
    } finally {
      await lease.close().catch(() => undefined);
      await reservation.close().catch(() => undefined);
    }
  }

  async acknowledge(input: Readonly<{
    readonly principalId: string;
    readonly request: unknown;
  }>): Promise<CollabProjectRetirementAcknowledgement> {
    if (!PRINCIPAL_PATTERN.test(input.principalId)) return fail('authorization-denied');
    const request = canonicalAcknowledgementRequest(input.request);
    const lease = await this.#acquire(request.projectId);
    try {
      return await lease.withProjectScope(async scope => {
        const responder = await scope.portability.getTerminalResponder(
          'retire',
          request.retirementId,
        );
        const eligible = responder?.eligiblePrincipals.find(value => (
          value.principalId === input.principalId
        ));
        const existing = responder?.acknowledgements.find(value => (
          value.principalId === input.principalId
        ));
        if (responder === undefined || (eligible === undefined && existing === undefined)) {
          return fail('authorization-denied');
        }
        const observedAt = now(this.#clock);
        if (Date.parse(observedAt) >= Date.parse(responder.expiresAt)) {
          return fail('expired');
        }
        const acknowledgedAt = existing?.acknowledgedAt ?? observedAt;
        if (existing === undefined) {
          await scope.portability.acknowledgeTerminalResponder({
            acknowledgedAt,
            memberId: eligible?.memberId ?? fail('recovery-required'),
            operationId: request.retirementId,
            operationKind: 'retire',
            principalId: input.principalId,
          });
        }
        return decodeCollabProjectRetirementAcknowledgement({
          acknowledgedAt,
          idempotencyKey: request.idempotencyKey,
          projectId: request.projectId,
          retirementId: request.retirementId,
        });
      });
    } catch (error: unknown) {
      return mapDependency(error);
    } finally {
      await lease.close().catch(() => undefined);
    }
  }

  recover(input: RecoverProjectLifecycleInput): Promise<ProjectLifecycleRecoveryOutcome> {
    const journal: ProjectLifecycleJournalRecord = input.journal;
    if (
      journal.kind === 'retire'
      && journal.phase === 'completed'
      && journal.state === 'completed'
    ) return Promise.resolve('settled');
    return Promise.reject(new RetireCoordinatorError('recovery-required'));
  }

  async #acquire(projectId: CollabProjectId): Promise<PinnedProjectLease> {
    if (this.#closed) return fail('closed');
    try {
      return await this.#coordination.acquireProjectLease(projectId);
    } catch (error: unknown) {
      return mapDependency(error);
    }
  }
}
