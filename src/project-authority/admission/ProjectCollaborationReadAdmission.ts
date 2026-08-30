import type {
  CollabGitOid,
  CollabMemberId,
  CollabProjectId,
  CollabRole,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../coordination/CoordinationError.js';
import type {
  AcquireProjectLeaseOptions,
  ProjectReadScope,
} from '../../coordination/ProjectCoordination.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import { resolvePrincipalMember } from './resolvePrincipalMember.js';
import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

export type ProjectCollaborationReadAdmissionErrorCode =
  | 'authorization-denied'
  | 'cancelled'
  | 'closed'
  | 'dependency-failed'
  | 'recovery-required'
  | 'state-conflict';

export class ProjectCollaborationReadAdmissionError extends Error {
  readonly code: ProjectCollaborationReadAdmissionErrorCode;

  constructor(code: ProjectCollaborationReadAdmissionErrorCode) {
    super(`project-collaboration-read-admission.error.${code}`);
    this.name = 'ProjectCollaborationReadAdmissionError';
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

export interface ProjectCollaborationReadAdmissionCoordination {
  withProjectReadScope<T>(
    projectId: CollabProjectId,
    operation: (scope: ProjectReadScope) => Promise<T>,
    options?: AcquireProjectLeaseOptions,
  ): Promise<T>;
}

export interface AuthorizedProjectCollaborationRead {
  readonly expectedMainOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly membershipRevision: bigint;
  readonly placement: RepositoryPlacementLease;
  readonly projectId: CollabProjectId;
  readonly role: CollabRole;
  readonly signal: AbortSignal;
  revalidate(): Promise<void>;
  transact<T>(operation: (scope: ProjectReadScope) => Promise<T>): Promise<T>;
}

interface AuthorizedFacts {
  readonly expectedMainOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly membershipRevision: bigint;
  readonly placement: RepositoryPlacementLease;
  readonly role: CollabRole;
}

function fail(code: ProjectCollaborationReadAdmissionErrorCode): never {
  throw new ProjectCollaborationReadAdmissionError(code);
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

function sameFacts(left: AuthorizedFacts, right: AuthorizedFacts): boolean {
  return left.expectedMainOid === right.expectedMainOid
    && left.memberId === right.memberId
    && left.membershipRevision === right.membershipRevision
    && left.role === right.role
    && samePlacement(left.placement, right.placement);
}

export class ProjectCollaborationReadAdmission {
  readonly #controllers = new Set<AbortController>();
  readonly #coordination: ProjectCollaborationReadAdmissionCoordination;
  readonly #running = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(coordination: ProjectCollaborationReadAdmissionCoordination) {
    this.#coordination = coordination;
  }

  run<T>(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    operation: (read: AuthorizedProjectCollaborationRead) => Promise<T>,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<T> {
    return this.#track(options, async signal => {
      const expected = await this.#coordination.withProjectReadScope(
        projectId,
        scope => this.#authorize(scope, principal, projectId),
        { signal },
      );
      const transact = <Result>(
        readOperation: (scope: ProjectReadScope) => Promise<Result>,
      ): Promise<Result> => {
        this.#assertAvailable(signal);
        return this.#coordination.withProjectReadScope(
          projectId,
          async scope => {
            const current = await this.#authorize(scope, principal, projectId);
            if (!sameFacts(current, expected)) return fail('state-conflict');
            return readOperation(scope);
          },
          { signal },
        );
      };
      return operation(Object.freeze({
        ...expected,
        projectId,
        revalidate: () => transact(() => Promise.resolve()),
        signal,
        transact,
      }));
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort();
      this.#closePromise = Promise.allSettled([...this.#running]).then(() => undefined);
    }
    return this.#closePromise;
  }

  #track<T>(
    options: AcquireProjectLeaseOptions,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new ProjectCollaborationReadAdmissionError('closed'));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) controller.abort();
    this.#controllers.add(controller);
    const running = Promise.resolve().then(() => {
      this.#assertAvailable(controller.signal);
      return operation(controller.signal);
    }).catch((error: unknown) => {
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

  async #authorize(
    scope: ProjectReadScope,
    principal: IngressPrincipal,
    projectId: CollabProjectId,
  ): Promise<AuthorizedFacts> {
    const memberId = await resolvePrincipalMember(scope, principal);
    if (memberId === undefined) return fail('authorization-denied');
    const membership = await scope.findMembership(memberId);
    if (membership?.status !== 'active') return fail('authorization-denied');
    if (await scope.getNonterminalDevelopmentBootstrapAttempt() !== undefined) {
      return fail('recovery-required');
    }
    if (await scope.membership.getNonterminalJoin() !== undefined) {
      return fail('recovery-required');
    }
    if (await scope.portability.getNonterminalLifecycleJournal() !== undefined) {
      return fail('recovery-required');
    }
    const project = await scope.getProject();
    if (project === undefined) return fail('authorization-denied');
    if (project.serviceState !== 'active') return fail('recovery-required');
    const placement = await scope.getRepositoryPlacement();
    if (placement === undefined || placement.projectId !== projectId) {
      return fail('state-conflict');
    }
    return Object.freeze({
      expectedMainOid: project.expectedMainOid,
      memberId,
      membershipRevision: membership.revision,
      placement,
      role: membership.role,
    });
  }

  #assertAvailable(signal: AbortSignal): void {
    if (this.#closed) fail('closed');
    if (signal.aborted) fail('cancelled');
  }
}
