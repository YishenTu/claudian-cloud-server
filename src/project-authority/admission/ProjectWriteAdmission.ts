import type {
  CollabGitOid,
  CollabMemberId,
  CollabProjectId,
  CollabRole,
} from '@claudian/collab-protocol';

import type {
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
  ProjectReadScope,
  ProjectScope,
} from '../../coordination/ProjectCoordination.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

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
  transact<T>(operation: (scope: ProjectScope) => Promise<T>): Promise<T>;
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

function samePlacement(
  left: RepositoryPlacementLease,
  right: RepositoryPlacementLease,
): boolean {
  return left.generation === right.generation
    && left.projectId === right.projectId
    && left.repositoryStorageKey === right.repositoryStorageKey
    && left.storageNodeId === right.storageNodeId;
}

export class ProjectWriteAdmission {
  readonly #controllers = new Set<AbortController>();
  readonly #coordination: ProjectWriteAdmissionCoordination;
  readonly #recovery: ProjectRecoveryPort;
  readonly #running = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: ProjectWriteAdmissionOptions) {
    this.#coordination = options.coordination;
    this.#recovery = options.recovery;
  }

  run<T>(
    principal: IngressPrincipal,
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

  preflight(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<void> {
    return this.#track(options, signal => {
      this.#assertAvailable(signal);
      return this.#coordination.withProjectReadScope(
        projectId,
        scope => this.#authorizeMember(scope, principal).then(() => undefined),
        { signal },
      );
    });
  }

  #track<T>(
    options: AcquireProjectLeaseOptions,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new ProjectWriteAdmissionError('closed'));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) controller.abort();
    this.#controllers.add(controller);
    const running = Promise.resolve().then(
      () => operation(controller.signal),
    ).catch((error: unknown) => {
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
    const tracked = running.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    void tracked.finally(() => {
      options.signal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      this.#running.delete(tracked);
    });
    return running;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort();
      this.#closePromise = Promise.allSettled([...this.#running]).then(() => undefined);
    }
    return this.#closePromise;
  }

  async #run<T>(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    operation: (write: AuthorizedProjectWrite) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    let recovered = false;
    for (;;) {
      this.#assertAvailable(signal);
      const lease = await this.#coordination.acquireProjectLease(projectId, { signal });
      try {
        this.#assertAvailable(signal);
        await lease.withProjectScope(
          scope => this.#authorizeMember(scope, principal).then(() => undefined),
        );
        const attempt = await lease.withProjectScope(
          scope => scope.getNonterminalDevelopmentBootstrapAttempt(),
        );
        if (attempt !== undefined) {
          if (recovered || attempt.state === 'recovery-required') {
            return fail('recovery-required');
          }
        } else {
          const facts = await lease.withProjectScope(
            scope => this.#authorize(scope, principal, projectId),
          );
          const write = Object.freeze({
            actorId: principal.actorId,
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
            transact: <T>(operation: (scope: ProjectScope) => Promise<T>) => {
              this.#assertAvailable(signal);
              return lease.withProjectScope(async scope => {
                await this.#revalidate(scope, principal, projectId, facts);
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
    if (this.#closed) fail('closed');
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
            this.#closed ? 'closed' : 'cancelled',
          ));
          signal.addEventListener('abort', abortListener, { once: true });
          if (signal.aborted) abortListener();
        }),
      ]);
    } finally {
      if (abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  async #authorize(
    scope: ProjectScope,
    principal: IngressPrincipal,
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
    scope: Pick<ProjectReadScope, 'findDevelopmentActorMember' | 'findMembership'>,
    principal: IngressPrincipal,
  ): Promise<AuthorizedMemberFacts> {
    const memberId = await scope.findDevelopmentActorMember(principal.actorId);
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
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    expected: AuthorizedFacts,
  ): Promise<void> {
    const current = await this.#authorize(scope, principal, projectId);
    if (await scope.getNonterminalDevelopmentBootstrapAttempt() !== undefined) {
      return fail('recovery-required');
    }
    if (
      current.expectedMainOid !== expected.expectedMainOid
      || current.memberId !== expected.memberId
      || current.membershipRevision !== expected.membershipRevision
      || current.role !== expected.role
      || !samePlacement(current.placement, expected.placement)
    ) {
      return fail('state-conflict');
    }
  }
}
