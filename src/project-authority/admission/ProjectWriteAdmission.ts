import type {
  CollabGitOid,
  CollabMemberId,
  CollabOperationId,
  CollabProjectId,
  CollabRole,
} from '@claudian-collab/protocol';

import type {
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
  ProjectReadScope,
  ProjectScope,
} from '../../coordination/ProjectCoordination.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import type { RequestPrincipal } from '../../request-context/RequestPrincipal.js';
import {
  sameRepositoryPlacement,
  type RepositoryPlacementLease,
} from '../../repositories/RepositoryPlacement.js';
import { resolvePrincipalMember } from './resolvePrincipalMember.js';
import {
  OperationDrain,
  OperationDrainClosedError,
} from '../OperationDrain.js';

export type ProjectWriteAdmissionErrorCode =
  | 'authorization-denied'
  | 'cancelled'
  | 'closed'
  | 'dependency-failed'
  | 'recovery-required'
  | 'state-conflict';

export class ProjectWriteAdmissionError extends Error {
  readonly code: ProjectWriteAdmissionErrorCode;

  constructor(code: ProjectWriteAdmissionErrorCode) {
    super(`project-write-admission.error.${code}`);
    this.name = 'ProjectWriteAdmissionError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
    });
  }
}

export interface AuthorizedProjectWrite {
  readonly actorId: string;
  readonly expectedMainOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly membershipRevision: bigint;
  readonly placement: RepositoryPlacementLease;
  readonly projectId: CollabProjectId;
  readonly revalidate: () => Promise<void>;
  readonly role: CollabRole;
  readonly signal: AbortSignal;
  transact<T>(
    operation: (scope: ProjectScope) => Promise<T>,
    options?: Readonly<{ readonly acceptOperationId?: CollabOperationId }>,
  ): Promise<T>;
}

export interface ProjectWriteAdmissionCoordination {
  acquireProjectLease(
    projectId: CollabProjectId,
    options?: AcquireProjectLeaseOptions,
  ): Promise<PinnedProjectLease>;
  withProjectReadScope<T>(
    projectId: CollabProjectId,
    operation: (scope: ProjectReadScope) => Promise<T>,
    options?: AcquireProjectLeaseOptions,
  ): Promise<T>;
}

export interface ProjectRecoveryPort {
  recoverProject(projectId: CollabProjectId): Promise<void>;
}

export type ProjectRecoveryErrorCode =
  | 'closed'
  | 'dependency-failed'
  | 'recovery-required';

export class ProjectRecoveryError extends Error {
  readonly code: ProjectRecoveryErrorCode;

  constructor(code: ProjectRecoveryErrorCode) {
    super(`project-recovery.error.${code}`);
    this.name = 'ProjectRecoveryError';
    this.code = code;
  }
}

export interface ProjectWriteAdmissionOptions {
  readonly coordination: ProjectWriteAdmissionCoordination;
  readonly recovery: ProjectRecoveryPort;
}

interface AuthorizedFacts {
  readonly expectedMainOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly membershipRevision: bigint;
  readonly placement: RepositoryPlacementLease;
  readonly role: CollabRole;
}

interface AuthorizedMemberFacts {
  readonly memberId: CollabMemberId;
  readonly membershipRevision: bigint;
  readonly role: CollabRole;
}

function fail(code: ProjectWriteAdmissionErrorCode): never {
  throw new ProjectWriteAdmissionError(code);
}

export class ProjectWriteAdmission {
  readonly #coordination: ProjectWriteAdmissionCoordination;
  readonly #operations = new OperationDrain();
  readonly #recovery: ProjectRecoveryPort;

  constructor(options: ProjectWriteAdmissionOptions) {
    this.#coordination = options.coordination;
    this.#recovery = options.recovery;
  }

  run<T>(
    principal: RequestPrincipal,
    projectId: CollabProjectId,
    operation: (write: AuthorizedProjectWrite) => Promise<T>,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<T> {
    return this.#track(options, signal => this.#run(
      principal,
      projectId,
      operation,
      signal,
    ));
  }

  runAfterPreflight<T>(
    principal: RequestPrincipal,
    projectId: CollabProjectId,
    operation: (write: AuthorizedProjectWrite) => Promise<T>,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<T> {
    return this.#track(options, signal => this.#run(
      principal, projectId, operation, signal, false,
    ));
  }

  preflight(
    principal: RequestPrincipal,
    projectId: CollabProjectId,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<void> {
    return this.#track(options, signal => this.#run(
      principal,
      projectId,
      () => Promise.resolve(),
      signal,
    ));
  }

  #track<T>(
    options: AcquireProjectLeaseOptions,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.#operations.run(options, operation).catch((error: unknown) => {
      if (error instanceof OperationDrainClosedError) return fail('closed');
      if (!(error instanceof CoordinationError)) throw error;
      if (error.code === 'cancelled') return fail('cancelled');
      if (error.code === 'closed') return fail('closed');
      if (
        error.code === 'invalid-member'
        || error.code === 'invalid-project'
        || error.code === 'invalid-record'
        || error.code === 'state-conflict'
      ) return fail('state-conflict');
      return fail('dependency-failed');
    });
  }

  close(): Promise<void> {
    return this.#operations.close();
  }

  async #run<T>(
    principal: RequestPrincipal,
    projectId: CollabProjectId,
    operation: (write: AuthorizedProjectWrite) => Promise<T>,
    signal: AbortSignal,
    allowRecovery = true,
  ): Promise<T> {
    let recovered = false;
    for (;;) {
      this.#assertAvailable(signal);
      const lease = await this.#coordination.acquireProjectLease(projectId, { signal });
      try {
        this.#assertAvailable(signal);
        const recoveryState = await lease.withProjectScope(async scope => {
          const lifecycle = await scope.portability
            .getNonterminalLifecycleJournal();
          if (lifecycle?.state !== 'active') {
            await this.#authorizeMember(scope, principal);
          }
          return Object.freeze({
            accept: await scope.accept.getNonterminal(),
            bootstrap: await scope.getNonterminalDevelopmentBootstrapAttempt(),
            join: await scope.membership.getNonterminalJoin(),
            lifecycle,
          });
        });
        if (
          recoveryState.bootstrap !== undefined
          || recoveryState.accept !== undefined
          || recoveryState.join !== undefined
          || recoveryState.lifecycle !== undefined
        ) {
          if (
            !allowRecovery
            || recovered
            || recoveryState.bootstrap?.state === 'recovery-required'
            || recoveryState.accept?.phase === 'recovery-required'
            || recoveryState.lifecycle?.state === 'recovery-required'
          ) {
            return fail('recovery-required');
          }
        } else {
          const facts = await lease.withProjectScope(
            scope => this.#authorize(scope, principal, projectId),
          );
          const write = Object.freeze({
            actorId: principal.principalId,
            expectedMainOid: facts.expectedMainOid,
            memberId: facts.memberId,
            membershipRevision: facts.membershipRevision,
            placement: facts.placement,
            projectId,
            revalidate: () => {
              this.#assertAvailable(signal);
              return lease.withProjectScope(scope => (
                this.#revalidate(scope, principal, projectId, facts)
              ));
            },
            role: facts.role,
            signal,
            transact: <T>(
              operation: (scope: ProjectScope) => Promise<T>,
              transactionOptions: Readonly<{
                readonly acceptOperationId?: CollabOperationId;
              }> = {},
            ) => {
              this.#assertAvailable(signal);
              return lease.withProjectScope(async scope => {
                await this.#revalidate(
                  scope,
                  principal,
                  projectId,
                  facts,
                  transactionOptions.acceptOperationId,
                );
                return operation(scope);
              });
            },
          });
          return await operation(write);
        }
      } finally {
        await lease.close();
      }
      await this.#waitForRecovery(projectId, signal);
      recovered = true;
    }
  }

  #assertAvailable(signal: AbortSignal): void {
    if (this.#operations.closed) fail('closed');
    if (signal.aborted) fail('cancelled');
  }

  async #waitForRecovery(
    projectId: CollabProjectId,
    signal: AbortSignal,
  ): Promise<void> {
    this.#assertAvailable(signal);
    const recovery = this.#recovery.recoverProject(projectId);
    let abortListener: (() => void) | undefined;
    try {
      await Promise.race([
        recovery,
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(new ProjectWriteAdmissionError(
            this.#operations.closed ? 'closed' : 'cancelled',
          ));
          signal.addEventListener('abort', abortListener, { once: true });
          if (signal.aborted) abortListener();
        }),
      ]);
    } catch (error: unknown) {
      if (!(error instanceof ProjectRecoveryError)) throw error;
      if (error.code === 'recovery-required') return fail('recovery-required');
      if (error.code === 'closed') return fail('closed');
      return fail('dependency-failed');
    } finally {
      if (abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  async #authorize(
    scope: ProjectScope,
    principal: RequestPrincipal,
    projectId: CollabProjectId,
  ): Promise<AuthorizedFacts> {
    const member = await this.#authorizeMember(scope, principal);
    const project = await scope.getProject();
    if (project === undefined) return fail('authorization-denied');
    if (project.serviceState !== 'active') return fail('recovery-required');
    const placement = await scope.getRepositoryPlacement();
    if (placement === undefined || placement.projectId !== projectId) {
      return fail('state-conflict');
    }
    return Object.freeze({
      expectedMainOid: project.expectedMainOid,
      memberId: member.memberId,
      membershipRevision: member.membershipRevision,
      placement,
      role: member.role,
    });
  }

  async #authorizeMember(
    scope: Pick<
      ProjectReadScope,
      'findDevelopmentActorMember' | 'findMembership' | 'findPrincipalMember'
    >,
    principal: RequestPrincipal,
  ): Promise<AuthorizedMemberFacts> {
    const memberId = await resolvePrincipalMember(scope, principal);
    if (memberId === undefined) return fail('authorization-denied');
    const membership = await scope.findMembership(memberId);
    if (membership?.status !== 'active') return fail('authorization-denied');
    return Object.freeze({
      memberId,
      membershipRevision: membership.revision,
      role: membership.role,
    });
  }

  async #revalidate(
    scope: ProjectScope,
    principal: RequestPrincipal,
    projectId: CollabProjectId,
    expected: AuthorizedFacts,
    acceptOperationId?: CollabOperationId,
  ): Promise<void> {
    const current = await this.#authorize(scope, principal, projectId);
    const accept = await scope.accept.getNonterminal();
    if (
      await scope.getNonterminalDevelopmentBootstrapAttempt() !== undefined
      || await scope.membership.getNonterminalJoin() !== undefined
      || (
        accept !== undefined
        && accept.operationId !== acceptOperationId
      )
    ) {
      return fail('recovery-required');
    }
    if (
      current.expectedMainOid !== expected.expectedMainOid
      || current.memberId !== expected.memberId
      || current.membershipRevision !== expected.membershipRevision
      || current.role !== expected.role
      || !sameRepositoryPlacement(current.placement, expected.placement)
    ) {
      return fail('state-conflict');
    }
  }
}
