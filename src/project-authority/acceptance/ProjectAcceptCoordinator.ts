import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  COLLAB_MAIN_REF,
  CollabError,
  collabControlOperationCodec,
  collabMemberRef,
  isCollabOpaqueId,
  type AcceptRequest,
  type AcceptResponse,
  type CollabChangeRequest,
  type CollabProjectId,
  type CollabResolvingTicketExpectation,
} from '@claudian-collab/protocol';

import type {
  AcceptJournalRecord,
  PrepareAcceptInput,
} from '../../coordination/AcceptPersistence.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import type {
  PinnedProjectLease,
} from '../../coordination/ProjectCoordination.js';
import type { RequestPrincipal } from '../../request-context/RequestPrincipal.js';
import {
  OperationDrain,
  OperationDrainClosedError,
} from '../OperationDrain.js';
import {
  ProjectWriteAdmission,
  ProjectWriteAdmissionError,
  type ProjectRecoveryPort,
  type ProjectWriteAdmissionCoordination,
} from '../admission/ProjectWriteAdmission.js';
import {
  ProjectAcceptRepositoryError,
  type ProjectAcceptInspection,
  type ProjectAcceptRepository,
} from './ProjectAcceptRepository.js';

export type ProjectAcceptCoordinatorErrorCode =
  | 'closed'
  | 'dependency-failed'
  | 'recovery-required';

export class ProjectAcceptCoordinatorError extends Error {
  readonly code: ProjectAcceptCoordinatorErrorCode;

  constructor(code: ProjectAcceptCoordinatorErrorCode) {
    super(`project-accept-coordinator.error.${code}`);
    this.name = 'ProjectAcceptCoordinatorError';
    this.code = code;
  }
}

export type ProjectAcceptCoordination = ProjectWriteAdmissionCoordination;

export interface ProjectAcceptCoordinatorOptions {
  readonly clock?: () => Date;
  readonly coordination: ProjectAcceptCoordination;
  readonly operationIdFactory?: () => string;
  readonly repository: ProjectAcceptRepository;
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

function acceptFingerprint(request: AcceptRequest): string {
  return createHash('sha256').update(JSON.stringify({
    expectedHeadOid: request.expectedHeadOid,
    expectedMainOid: request.expectedMainOid,
    expectedRequestRevision: request.expectedRequestRevision,
    expectedResolvingTickets: [...request.expectedResolvingTickets]
      .sort((left, right) => (
        left.ticketId < right.ticketId ? -1 : left.ticketId > right.ticketId ? 1 : 0
      )),
    projectId: request.projectId,
    requestId: request.requestId,
  })).digest('hex');
}

function operationTime(clock: () => Date, wholeSecond = false): string {
  const value = new Date(clock().valueOf());
  if (Number.isNaN(value.valueOf())) {
    throw new ProjectAcceptCoordinatorError('dependency-failed');
  }
  if (wholeSecond) value.setUTCMilliseconds(0);
  return value.toISOString();
}

function decodeResponse(value: unknown): AcceptResponse {
  try {
    return collabControlOperationCodec('acceptRequest').decodeResponse(value);
  } catch {
    throw domainError(
      'authority-integrity-error',
      'accept-idempotency-response-invalid',
    );
  }
}

function resolvingTickets(
  request: CollabChangeRequest,
): readonly CollabResolvingTicketExpectation[] {
  return Object.freeze(request.ticketRelations
    .filter(relation => relation.kind === 'resolves')
    .map(relation => Object.freeze({
      revision: relation.ticketRevision,
      ticketId: relation.ticketId,
    }))
    .sort((left, right) => (
      left.ticketId < right.ticketId ? -1 : left.ticketId > right.ticketId ? 1 : 0
    )));
}

function validateRequest(
  request: CollabChangeRequest | undefined,
  input: AcceptRequest,
): CollabChangeRequest {
  if (request === undefined || request.status !== 'open') {
    throw domainError('request-not-open', 'accept-request-not-open');
  }
  if (request.latestHeadOid !== input.expectedHeadOid) {
    throw domainError('stale-request-head', 'accept-request-head-mismatch');
  }
  if (request.revision !== input.expectedRequestRevision) {
    throw domainError('stale-request-metadata', 'accept-request-revision-mismatch');
  }
  const expected = [...input.expectedResolvingTickets].sort((left, right) => (
    left.ticketId < right.ticketId ? -1 : left.ticketId > right.ticketId ? 1 : 0
  ));
  const actual = resolvingTickets(request);
  if (!isDeepStrictEqual(actual, expected)) {
    throw domainError('stale-ticket', 'accept-resolving-ticket-mismatch');
  }
  if (request.ticketRelations.some(relation => relation.state !== 'pending')) {
    throw domainError('stale-request-metadata', 'accept-relation-state-mismatch');
  }
  return request;
}

function preparePlan(input: Readonly<{
  readonly actorMemberId: string;
  readonly fingerprint: string;
  readonly inspection: ProjectAcceptInspection;
  readonly operationId: string;
  readonly placement: Readonly<{
    readonly generation: number;
    readonly projectId: string;
    readonly repositoryStorageKey: string;
    readonly storageNodeId: string;
  }>;
  readonly preparedAt: string;
  readonly request: AcceptRequest;
  readonly storedRequest: CollabChangeRequest;
}>): PrepareAcceptInput {
  const common = {
    actorMemberId: input.actorMemberId,
    expectedHeadOid: input.request.expectedHeadOid,
    expectedMainOid: input.request.expectedMainOid,
    expectedRequestRevision: input.request.expectedRequestRevision,
    idempotencyKey: input.request.idempotencyKey,
    mainRef: COLLAB_MAIN_REF,
    objectFormat: input.inspection.objectFormat,
    operationId: input.operationId,
    personalRef: collabMemberRef(input.storedRequest.memberId),
    placement: Object.freeze({
      generation: input.placement.generation,
      projectId: input.placement.projectId,
      repositoryStorageKey: input.placement.repositoryStorageKey,
      storageNodeId: input.placement.storageNodeId,
    }),
    preparedAt: input.preparedAt,
    relations: Object.freeze(input.storedRequest.ticketRelations.map(relation => (
      Object.freeze({
        commitOid: relation.commitOid,
        kind: relation.kind,
        relationId: relation.id,
        ticketId: relation.ticketId,
        ticketRevision: relation.ticketRevision,
      })
    )).sort((left, right) => (
      left.relationId < right.relationId
        ? -1
        : left.relationId > right.relationId ? 1 : 0
    ))),
    requestFingerprint: input.fingerprint,
    requestId: input.request.requestId,
    requestMemberId: input.storedRequest.memberId,
  } as const;
  if (input.inspection.kind === 'contained') {
    return Object.freeze({ ...common, resultKind: 'contained' as const });
  }
  return Object.freeze({
    ...common,
    commit: Object.freeze({
      authorEmail: 'collab@claudian.local',
      authorName: 'Claudian Collab',
      committerEmail: 'collab@claudian.local',
      committerName: 'Claudian Collab',
      message: `Accept request ${input.request.requestId}\n`,
      parents: Object.freeze([
        input.request.expectedMainOid,
        input.request.expectedHeadOid,
      ] as const),
      timezone: '+0000' as const,
      treeOid: input.inspection.treeOid,
    }),
    resultKind: 'merge' as const,
  });
}

function classifiable(error: unknown): boolean {
  return (
    error instanceof ProjectAcceptRepositoryError
    && !['cancelled', 'unavailable'].includes(error.code)
  ) || (
    error instanceof CoordinationError
    && ['invalid-record', 'state-conflict'].includes(error.code)
  );
}

function mapPublicError(error: unknown): never {
  if (error instanceof CollabError) throw error;
  if (error instanceof ProjectAcceptRepositoryError) {
    if (error.code === 'conflicting') {
      throw domainError('content-conflict', 'accept-merge-conflicting');
    }
    if (error.code === 'stale-main') {
      throw domainError('stale-main', 'accept-main-mismatch', true);
    }
    if (error.code === 'stale-head') {
      throw domainError('stale-request-head', 'accept-personal-ref-mismatch', true);
    }
    if (error.code === 'stale-relation') {
      throw domainError(
        'stale-request-metadata',
        'accept-relation-commit-not-contained',
      );
    }
    if (error.code === 'unsupported-tree') {
      throw domainError('operation-failed', 'accept-merge-tree-unsupported');
    }
    if (error.code === 'cancelled') {
      throw domainError('operation-failed', 'accept-cancelled', true);
    }
    if (error.code === 'invalid-plan' || error.code === 'state-conflict') {
      throw domainError(
        'authority-not-synchronized',
        'accept-repository-state-conflict',
        true,
      );
    }
    throw domainError('operation-failed', 'accept-repository-unavailable', true);
  }
  if (error instanceof ProjectWriteAdmissionError) {
    if (error.code === 'authorization-denied') {
      throw domainError('authorization-denied', 'accept-member-not-authorized');
    }
    if (error.code === 'recovery-required') {
      throw domainError(
        'acceptance-recovery-required',
        'accept-project-recovery-required',
      );
    }
    if (error.code === 'state-conflict') {
      throw domainError('authority-not-synchronized', 'accept-authority-stale', true);
    }
    throw domainError('operation-failed', 'accept-admission-unavailable', true);
  }
  if (error instanceof CoordinationError) {
    if (error.code === 'state-conflict') {
      throw domainError('authority-not-synchronized', 'accept-state-conflict', true);
    }
    if (error.code === 'invalid-record') {
      throw domainError('authority-integrity-error', 'accept-persistence-invalid');
    }
    throw domainError('operation-failed', 'accept-persistence-unavailable', true);
  }
  if (
    error instanceof ProjectAcceptCoordinatorError
    && error.code === 'recovery-required'
  ) {
    throw domainError(
      'acceptance-recovery-required',
      'accept-project-recovery-required',
    );
  }
  throw domainError('operation-failed', 'accept-operation-failed', true);
}

export class ProjectAcceptCoordinator implements ProjectRecoveryPort {
  readonly #admission: ProjectWriteAdmission;
  readonly #clock: () => Date;
  readonly #coordination: ProjectAcceptCoordination;
  readonly #operations = new OperationDrain();
  readonly #operationIdFactory: () => string;
  readonly #repository: ProjectAcceptRepository;
  #closePromise: Promise<void> | undefined;

  constructor(options: ProjectAcceptCoordinatorOptions) {
    this.#admission = new ProjectWriteAdmission({
      coordination: options.coordination,
      recovery: this,
    });
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#operationIdFactory = options.operationIdFactory ?? (() => (
      `accept_${randomUUID().replaceAll('-', '')}`
    ));
    this.#repository = options.repository;
  }

  accept(
    principal: RequestPrincipal,
    request: AcceptRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<AcceptResponse> {
    return this.#operations.run(options, signal => (
      this.#accept(principal, request, signal).catch(mapPublicError)
    )).catch((error: unknown) => {
      if (error instanceof OperationDrainClosedError) {
        throw domainError('operation-failed', 'accept-closed');
      }
      throw error;
    });
  }

  async #accept(
    principal: RequestPrincipal,
    request: AcceptRequest,
    signal: AbortSignal,
  ): Promise<AcceptResponse> {
    const reservation = await this.#repository.reserveAccept(
      request.projectId,
      { signal },
    );
    try {
      const fingerprint = acceptFingerprint(request);
      return await this.#admission.run(
        principal,
        request.projectId,
        async write => {
          const identity = {
            idempotencyKey: request.idempotencyKey,
            memberId: write.memberId,
            operation: 'acceptRequest' as const,
            requestFingerprint: fingerprint,
          };
          const replay = await write.transact(scope => (
            scope.collaboration.idempotency.find(identity)
          ));
          if (replay.kind === 'conflict') {
            throw domainError('idempotency-conflict', 'accept-idempotency-conflict');
          }
          if (replay.kind === 'replay') return decodeResponse(replay.response);
          if (write.role !== 'manager') {
            throw domainError('authorization-denied', 'accept-manager-required');
          }
          const storedRequest = validateRequest(
            await write.transact(scope => (
              scope.collaboration.requests.find(request.requestId)
            )),
            request,
          );
          if (write.expectedMainOid !== request.expectedMainOid) {
            throw domainError('stale-main', 'accept-expected-main-mismatch', true);
          }
          const inspection = await this.#repository.inspectAccept(reservation, {
            expectedHeadOid: request.expectedHeadOid,
            expectedMainOid: request.expectedMainOid,
            personalRef: collabMemberRef(storedRequest.memberId),
            placement: write.placement,
            projectId: write.projectId,
            relationCommitOids: storedRequest.ticketRelations.map(
              relation => relation.commitOid,
            ),
            revalidateAuthority: write.revalidate,
            signal: write.signal,
          });
          const operationId = this.#operationIdFactory();
          if (!isCollabOpaqueId(operationId)) {
            throw new ProjectAcceptCoordinatorError('dependency-failed');
          }
          const plan = preparePlan({
            actorMemberId: write.memberId,
            fingerprint,
            inspection,
            operationId,
            placement: write.placement,
            preparedAt: operationTime(this.#clock, true),
            request,
            storedRequest,
          });
          await write.transact(async scope => {
            validateRequest(
              await scope.collaboration.requests.find(request.requestId),
              request,
            );
            await scope.accept.prepare(plan);
          });
          const resultOid = await this.#repository.materializeAcceptResult(
            reservation,
            plan,
          );
          await write.transact(scope => scope.accept.persistResult({
            expectedPhase: 'prepared',
            operationId,
            resultOid,
            updatedAt: operationTime(this.#clock),
          }), { acceptOperationId: operationId });
          await this.#repository.settleAcceptMain(
            reservation,
            { ...plan, resultOid },
          );
          await write.transact(scope => scope.accept.markMainUpdated({
            expectedPhase: 'result-persisted',
            operationId,
            updatedAt: operationTime(this.#clock),
          }), { acceptOperationId: operationId });
          return write.transact(scope => scope.accept.complete({
            completedAt: operationTime(this.#clock),
            operationId,
          }), { acceptOperationId: operationId });
        },
        { signal },
      );
    } finally {
      await reservation.close();
    }
  }

  recoverProject(projectId: CollabProjectId): Promise<void> {
    return this.#operations.run({}, () => this.#recoverProject(projectId)).catch(
      (error: unknown) => {
        if (error instanceof OperationDrainClosedError) {
          throw new ProjectAcceptCoordinatorError('closed');
        }
        throw error;
      },
    );
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      const operationsClosed = this.#operations.close();
      this.#closePromise = this.#admission.close().then(() => operationsClosed);
    }
    return this.#closePromise;
  }

  async #recoverProject(projectId: CollabProjectId): Promise<void> {
    let lease: PinnedProjectLease | undefined;
    const reservation = await this.#repository.reserveAccept(projectId);
    try {
      lease = await this.#coordination.acquireProjectLease(projectId);
      let record = await lease.withProjectScope(scope => scope.accept.getNonterminal());
      if (record === undefined) return;
      const operationId = record.operationId;
      if (record.phase === 'recovery-required') {
        throw new ProjectAcceptCoordinatorError('recovery-required');
      }
      try {
        if (record.phase === 'prepared') {
          const resultOid = await this.#repository.materializeAcceptResult(
            reservation,
            record,
          );
          await lease.withProjectScope(scope => scope.accept.persistResult({
            expectedPhase: 'prepared',
            operationId,
            resultOid,
            updatedAt: operationTime(this.#clock),
          }));
          record = this.#requireRecord(await lease.withProjectScope(
            scope => scope.accept.get(operationId),
          ));
        }
        if (record.phase === 'result-persisted') {
          if (record.resultOid === undefined) {
            throw new ProjectAcceptCoordinatorError('recovery-required');
          }
          await this.#repository.materializeAcceptResult(reservation, record);
          await this.#repository.settleAcceptMain(reservation, {
            ...record,
            resultOid: record.resultOid,
          });
          await lease.withProjectScope(scope => scope.accept.markMainUpdated({
            expectedPhase: 'result-persisted',
            operationId,
            updatedAt: operationTime(this.#clock),
          }));
          record = this.#requireRecord(await lease.withProjectScope(
            scope => scope.accept.get(operationId),
          ));
        }
        if (record.phase === 'main-updated') {
          if (record.resultOid === undefined) {
            throw new ProjectAcceptCoordinatorError('recovery-required');
          }
          await this.#repository.settleAcceptMain(reservation, {
            ...record,
            resultOid: record.resultOid,
          });
          await lease.withProjectScope(scope => scope.accept.complete({
            completedAt: operationTime(this.#clock),
            operationId,
          }));
        }
      } catch (error: unknown) {
        if (!classifiable(error)) throw error;
        await this.#classify(lease, record);
        throw new ProjectAcceptCoordinatorError('recovery-required');
      }
    } catch (error: unknown) {
      if (
        error instanceof ProjectAcceptCoordinatorError
        || error instanceof CoordinationError
        || error instanceof ProjectAcceptRepositoryError
      ) throw error;
      throw new ProjectAcceptCoordinatorError('dependency-failed');
    } finally {
      try {
        if (lease !== undefined) await lease.close();
      } finally {
        await reservation.close();
      }
    }
  }

  #requireRecord(record: AcceptJournalRecord | undefined): AcceptJournalRecord {
    if (record === undefined) {
      throw new ProjectAcceptCoordinatorError('recovery-required');
    }
    return record;
  }

  async #classify(
    lease: PinnedProjectLease,
    record: AcceptJournalRecord,
  ): Promise<void> {
    if (
      record.phase !== 'prepared'
      && record.phase !== 'result-persisted'
      && record.phase !== 'main-updated'
    ) {
      throw new ProjectAcceptCoordinatorError('recovery-required');
    }
    const expectedPhase = record.phase;
    await lease.withProjectScope(scope => scope.accept.markRecoveryRequired({
      expectedPhase,
      operationId: record.operationId,
      updatedAt: operationTime(this.#clock),
    }));
  }
}
