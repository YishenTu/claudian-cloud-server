import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  CollabError,
  collabControlOperationCodec,
  collabMemberRef,
  type CollabProjectId,
  type JoinCloudProjectRequest,
  type JoinCloudProjectResponse,
} from '@claudian-collab/protocol';

import type {
  ProjectJoinJournal,
} from '../../coordination/ProjectMembershipPersistence.js';
import type {
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
} from '../../coordination/ProjectCoordination.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import { OperationDrain } from '../OperationDrain.js';
import {
  GitRepositoryError,
} from '../../repositories/GitRepositoryAuthority.js';
import { hasNonterminalProjectMutation } from '../admission/hasNonterminalProjectMutation.js';
import type {
  ProjectMembershipRepository,
  ProjectMembershipRepositoryReservation,
} from './ProjectMembershipRepository.js';

export interface CloudProjectJoinCoordination {
  acquireProjectLease(
    projectId: CollabProjectId,
    options?: AcquireProjectLeaseOptions,
  ): Promise<PinnedProjectLease>;
}

export interface CloudProjectJoinCoordinatorOptions {
  readonly clock?: () => Date;
  readonly coordination: CloudProjectJoinCoordination;
  readonly memberIdFactory?: () => string;
  readonly operationIdFactory?: () => string;
  readonly repository: ProjectMembershipRepository;
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

function canonicalNow(clock: () => Date): string {
  const now = new Date(clock().valueOf());
  if (Number.isNaN(now.valueOf())) throw new Error('invalid-clock');
  now.setUTCMilliseconds(0);
  return now.toISOString();
}

function secretMatches(expected: string, secret: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(expected)) return false;
  const observed = Buffer.from(sha256(secret), 'hex');
  const durable = Buffer.from(expected, 'hex');
  return observed.byteLength === durable.byteLength
    && timingSafeEqual(observed, durable);
}

function fingerprint(request: JoinCloudProjectRequest): string {
  return sha256(JSON.stringify({
    displayName: request.displayName,
    invitationId: request.invitationId,
    projectId: request.projectId,
    secretSha256: sha256(request.secret),
  }));
}

function exactReplay(
  journal: ProjectJoinJournal,
  principal: IngressPrincipal,
  request: JoinCloudProjectRequest,
): boolean {
  return journal.principalId === principal.principalId
    && journal.idempotencyKey === request.idempotencyKey
    && journal.requestFingerprint === fingerprint(request);
}

function mapStatus(status: string): never {
  if (status === 'quota') throw domainError('quota-exceeded', 'membership-capacity');
  if (status === 'revoked') throw domainError('membership-revoked', 'membership-revoked');
  if (status === 'invitation-invalid' || status === 'already-bound') {
    throw domainError('authorization-denied', 'join-not-authorized');
  }
  throw domainError('idempotency-conflict', 'join-idempotency-conflict');
}

function mapFailure(error: unknown): never {
  if (error instanceof CollabError) throw error;
  if (error instanceof GitRepositoryError) {
    if (error.code === 'repository-corrupt' || error.code === 'placement-rejected') {
      throw domainError('personal-ref-diverged', 'join-personal-ref-diverged');
    }
  }
  throw domainError('operation-failed', 'join-unavailable', true);
}

function response(journal: ProjectJoinJournal): JoinCloudProjectResponse {
  return Object.freeze({
    joinedAt: journal.preparedAt,
    mainOid: journal.expectedMainOid,
    managerSetGeneration: journal.managerSetGeneration,
    memberId: journal.memberId,
    membershipRevision: 2,
    personalRef: journal.personalRef,
    projectId: journal.projectId,
    role: 'member',
  });
}

export class CloudProjectJoinCoordinator {
  readonly #clock: () => Date;
  readonly #coordination: CloudProjectJoinCoordination;
  readonly #memberIdFactory: () => string;
  readonly #operations = new OperationDrain();
  readonly #operationIdFactory: () => string;
  readonly #repository: ProjectMembershipRepository;

  constructor(options: CloudProjectJoinCoordinatorOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#memberIdFactory = options.memberIdFactory ?? (() => (
      `member_${randomUUID().replaceAll('-', '')}`
    ));
    this.#operationIdFactory = options.operationIdFactory ?? (() => (
      `join_${randomUUID().replaceAll('-', '')}`
    ));
    this.#repository = options.repository;
  }

  join(
    principal: IngressPrincipal,
    request: JoinCloudProjectRequest,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<JoinCloudProjectResponse> {
    return this.#operations.run(options, signal => this.#join(
      principal,
      request,
      { signal },
    )).catch(mapFailure);
  }

  async #join(
    principal: IngressPrincipal,
    request: JoinCloudProjectRequest,
    options: Readonly<{ readonly signal: AbortSignal }>,
  ): Promise<JoinCloudProjectResponse> {
    if (principal.provenance.kind !== 'operator-protected-channel') {
      throw domainError('authorization-denied', 'join-principal-untrusted');
    }
    let lease: PinnedProjectLease | undefined;
    let reservation: ProjectMembershipRepositoryReservation | undefined;
    try {
      reservation = await this.#repository.reserveMembershipRefOperation(
        request.projectId,
        { signal: options.signal },
      );
      lease = await this.#coordination.acquireProjectLease(request.projectId, options);
      let journal = await lease.withProjectScope(scope => (
        scope.membership.findJoinByPrincipal(
          principal.principalId,
          request.idempotencyKey,
        )
      ));
      if (journal === undefined) {
        const blocked = await lease.withProjectScope(
          hasNonterminalProjectMutation,
          options,
        );
        if (blocked) {
          throw domainError(
            'authority-not-synchronized',
            'project-mutation-recovery-required',
          );
        }
        const preparedAt = canonicalNow(this.#clock);
        const facts = await lease.withProjectScope(async scope => Object.freeze({
          invitation: await scope.membership.findInvitationForJoin(
            request.invitationId,
            preparedAt,
          ),
          placement: await scope.getRepositoryPlacement(),
          project: await scope.getProject(),
        }));
        const { invitation, placement, project } = facts;
        if (
          invitation === undefined
          || invitation.state !== 'active'
          || invitation.projectId !== request.projectId
          || !secretMatches(invitation.secretSha256, request.secret)
          || project === undefined
          || project.serviceState !== 'active'
          || placement === undefined
          || project.expectedMainOid.length === 0
        ) throw domainError('authorization-denied', 'join-not-authorized');
        const memberId = this.#memberIdFactory();
        const result = await lease.withProjectScope(scope => scope.membership.prepareJoin({
          displayName: request.displayName,
          expectedMainOid: project.expectedMainOid,
          idempotencyKey: request.idempotencyKey,
          invitationId: request.invitationId,
          invitationRevision: invitation.revision,
          managerSetGeneration: project.managerSetGeneration,
          memberId,
          operationId: this.#operationIdFactory(),
          personalRef: collabMemberRef(memberId),
          placementGeneration: placement.generation,
          preparedAt,
          principalId: principal.principalId,
          principalSha256: sha256(principal.principalId),
          projectId: request.projectId,
          repositoryStorageKey: placement.repositoryStorageKey,
          requestFingerprint: fingerprint(request),
          secretSha256: invitation.secretSha256,
          storageNodeId: placement.storageNodeId,
        }));
        if (result.journal === undefined) return mapStatus(result.status);
        journal = result.journal;
      }
      if (!exactReplay(journal, principal, request)) return mapStatus('conflict');
      return collabControlOperationCodec('joinCloudProject').decodeResponse(
        await this.#advance(lease, reservation, journal, options.signal),
      );
    } finally {
      await lease?.close().catch(() => undefined);
      await reservation?.close().catch(() => undefined);
    }
  }

  recoverProject(projectId: CollabProjectId): Promise<void> {
    return this.#operations.run({}, signal => this.#recoverProject(
      projectId,
      signal,
    ));
  }

  async #recoverProject(projectId: CollabProjectId, signal: AbortSignal): Promise<void> {
    let lease: PinnedProjectLease | undefined;
    let reservation: ProjectMembershipRepositoryReservation | undefined;
    try {
      reservation = await this.#repository.reserveMembershipRefOperation(
        projectId,
        { signal },
      );
      lease = await this.#coordination.acquireProjectLease(projectId, { signal });
      const journal = await lease.withProjectScope(
        scope => scope.membership.getNonterminalJoin(),
      );
      if (journal === undefined) return;
      await this.#advance(lease, reservation, journal, signal);
    } finally {
      await lease?.close().catch(() => undefined);
      await reservation?.close().catch(() => undefined);
    }
  }

  close(): Promise<void> {
    return this.#operations.close();
  }

  async #advance(
    lease: PinnedProjectLease,
    reservation: ProjectMembershipRepositoryReservation,
    initial: ProjectJoinJournal,
    signal?: AbortSignal,
  ): Promise<JoinCloudProjectResponse> {
    let journal = initial;
    if (journal.phase === 'prepared') {
      await lease.withProjectScope(scope => scope.membership.advanceJoin({
        expectedPhase: 'prepared',
        nextPhase: 'membership-pending',
        operationId: journal.operationId,
        updatedAt: canonicalNow(this.#clock),
      }));
      journal = await this.#journal(lease, journal.operationId);
    }
    if (journal.phase === 'membership-pending') {
      await this.#repository.createMemberPersonalRef(reservation, {
        expectedOid: journal.expectedMainOid,
        memberId: journal.memberId,
        personalRef: journal.personalRef,
        placement: {
          active: true,
          generation: journal.placementGeneration,
          projectId: journal.projectId,
          repositoryStorageKey: journal.repositoryStorageKey,
          storageNodeId: journal.storageNodeId,
        },
        projectId: journal.projectId,
        ...(signal === undefined ? {} : { signal }),
      });
      await lease.withProjectScope(scope => scope.membership.advanceJoin({
        expectedPhase: 'membership-pending',
        nextPhase: 'personal-ref-created',
        operationId: journal.operationId,
        updatedAt: canonicalNow(this.#clock),
      }));
      journal = await this.#journal(lease, journal.operationId);
    }
    if (journal.phase === 'personal-ref-created') {
      const joinedAt = canonicalNow(this.#clock);
      const result = response(journal);
      await lease.withProjectScope(async scope => {
        const status = await scope.membership.activateJoin({
          joinedAt,
          operationId: journal.operationId,
          response: { ...result, joinedAt },
        });
        if (status === 'activated') {
          await scope.appendProjectEvent({
            kind: 'membership.updated',
            occurredAt: joinedAt,
            payload: { memberId: journal.memberId },
          });
        }
      });
      journal = await this.#journal(lease, journal.operationId);
    }
    if (journal.phase === 'membership-active') {
      return lease.withProjectScope(scope => scope.membership.completeJoin({
        completedAt: canonicalNow(this.#clock),
        operationId: journal.operationId,
      }));
    }
    if (journal.phase === 'completed' && journal.response !== undefined) {
      return journal.response;
    }
    throw domainError('authority-integrity-error', 'join-recovery-required', true);
  }

  async #journal(
    lease: PinnedProjectLease,
    operationId: string,
  ): Promise<ProjectJoinJournal> {
    const journal = await lease.withProjectScope(
      scope => scope.membership.findJoinByPrincipalOperation(operationId),
    );
    if (journal === undefined) {
      throw domainError('authority-integrity-error', 'join-journal-missing', true);
    }
    return journal;
  }
}
