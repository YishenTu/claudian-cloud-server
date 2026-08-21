import type {
  CollabGitOid,
  CollabMemberId,
  CollabProjectId,
  CollabRole,
} from '@claudian/collab-protocol';

import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../coordination/ProjectCoordination.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

export type ProjectWriteAdmissionErrorCode =
  | 'authorization-denied'
  | 'closed'
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
}

export interface ProjectWriteAdmissionCoordination {
  acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
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
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new ProjectWriteAdmissionError('closed'));
    }
    const running = this.#run(principal, projectId, operation);
    const tracked = running.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    void tracked.finally(() => this.#running.delete(tracked));
    return running;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = Promise.allSettled([...this.#running]).then(() => undefined);
    }
    return this.#closePromise;
  }

  async #run<T>(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    operation: (write: AuthorizedProjectWrite) => Promise<T>,
  ): Promise<T> {
    let recovered = false;
    for (;;) {
      const lease = await this.#coordination.acquireProjectLease(projectId);
      try {
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
            revalidate: () => lease.withProjectScope(scope => (
              this.#revalidate(scope, principal, projectId, facts)
            )),
            role: facts.role,
          });
          return await operation(write);
        }
      } finally {
        await lease.close();
      }
      await this.#recovery.recoverProject(projectId);
      recovered = true;
    }
  }

  async #authorize(
    scope: ProjectScope,
    principal: IngressPrincipal,
    projectId: CollabProjectId,
  ): Promise<AuthorizedFacts> {
    const project = await scope.getProject();
    if (project === undefined) return fail('state-conflict');
    if (project.serviceState !== 'active') return fail('recovery-required');
    const memberId = await scope.findDevelopmentActorMember(principal.actorId);
    if (memberId === undefined) return fail('authorization-denied');
    const membership = await scope.findMembership(memberId);
    if (membership?.status !== 'active') return fail('authorization-denied');
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

  async #revalidate(
    scope: ProjectScope,
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    expected: AuthorizedFacts,
  ): Promise<void> {
    if (await scope.getNonterminalDevelopmentBootstrapAttempt() !== undefined) {
      return fail('recovery-required');
    }
    const current = await this.#authorize(scope, principal, projectId);
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
