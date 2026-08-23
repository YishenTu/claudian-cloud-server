import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_MAIN_REF,
  collabMemberRef,
  decodeCollabCloudProjectSnapshot,
  isCollabProjectId,
  type CollabCloudProjectEvent,
  type CollabCloudProjectMember,
  type CollabCloudProjectSnapshot,
  type CollabGitOid,
  type CollabMemberId,
  type CollabProjectId,
  type CollabRole,
} from '@claudian-collab/protocol';

import type {
  AcquireProjectLeaseOptions,
  ProjectReadScope,
  ProjectSnapshotMembershipRecord,
} from '../../coordination/ProjectCoordination.js';
import type { CollaborationSnapshot } from '../../coordination/CollaborationPersistence.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';

export type ProjectReadAuthorityErrorCode =
  | 'authorization-denied'
  | 'cancelled'
  | 'closed'
  | 'dependency-failed'
  | 'project-not-found'
  | 'project-too-large'
  | 'recovery-required'
  | 'state-conflict';

export class ProjectReadAuthorityError extends Error {
  readonly code: ProjectReadAuthorityErrorCode;

  constructor(code: ProjectReadAuthorityErrorCode) {
    super(`project-read-authority.error.${code}`);
    this.name = 'ProjectReadAuthorityError';
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

export interface ProjectReadAuthorityCoordination {
  withProjectReadScope<T>(
    projectId: CollabProjectId,
    operation: (scope: ProjectReadScope) => Promise<T>,
    options?: AcquireProjectLeaseOptions,
  ): Promise<T>;
}

export interface VerifyProjectReadInput {
  readonly expectedRefs: readonly ProjectReadRef[];
  readonly expectedMainOid: CollabGitOid;
  readonly placement: RepositoryPlacementLease;
  readonly signal?: AbortSignal;
}

export interface ProjectReadRef {
  readonly name: string;
  readonly oid?: CollabGitOid;
}

export interface ProjectReadRepository {
  advertiseUploadPack(
    placement: RepositoryPlacementLease,
    options: ProjectUploadPackAdvertisementOptions & Readonly<{
      readonly expectedRefs: readonly ProjectReadRef[];
      readonly revalidateAuthority: () => Promise<void>;
    }>,
  ): Promise<Buffer>;
  runUploadPack(
    placement: RepositoryPlacementLease,
    options: ProjectUploadPackOptions & Readonly<{
      readonly expectedRefs: readonly ProjectReadRef[];
      readonly revalidateAuthority: () => Promise<void>;
    }>,
  ): Promise<void>;
  verifyProjectRead(input: VerifyProjectReadInput): Promise<void>;
}

export interface ProjectReadAuthorityOptions {
  readonly coordination: ProjectReadAuthorityCoordination;
  readonly repository: ProjectReadRepository;
}

export interface ProjectUploadPackAdvertisementOptions {
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly signal?: AbortSignal;
}

export interface ProjectUploadPackOptions {
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly maximumResponseBytes: number;
  readonly onResponseChunk: (
    chunk: Buffer,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly request: Buffer;
  readonly signal?: AbortSignal;
}

export type ProjectEventReadResult = {
  readonly events: readonly CollabCloudProjectEvent[];
  readonly kind: 'events';
  readonly latestSequence: number;
} | {
  readonly kind: 'snapshot-required';
  readonly latestSequence: number;
};

interface AdmissionFacts {
  readonly expectedRefs: readonly ProjectReadRef[];
  readonly expectedMainOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly members: readonly ProjectSnapshotMembershipRecord[];
  readonly membershipRevision: bigint;
  readonly placement: RepositoryPlacementLease;
  readonly role: CollabRole;
}

interface SnapshotFacts extends AdmissionFacts {
  readonly collaboration: CollaborationSnapshot;
  readonly eventSequence: number;
  readonly project: {
    readonly createdAt: string;
    readonly expectedMainOid: CollabGitOid;
    readonly projectId: CollabProjectId;
    readonly projectName: string;
  };
}

function fail(code: ProjectReadAuthorityErrorCode): never {
  throw new ProjectReadAuthorityError(code);
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

function sameAdmission(left: AdmissionFacts, right: AdmissionFacts): boolean {
  return left.expectedMainOid === right.expectedMainOid
    && left.memberId === right.memberId
    && left.membershipRevision === right.membershipRevision
    && left.role === right.role
    && left.members.length === right.members.length
    && left.members.every((member, index) => {
      const other = right.members[index];
      return other !== undefined
        && member.activatedAt === other.activatedAt
        && member.createdAt === other.createdAt
        && member.displayName === other.displayName
        && member.memberId === other.memberId
        && member.revision === other.revision
        && member.role === other.role;
    })
    && samePlacement(left.placement, right.placement);
}

function sameSnapshotFacts(left: SnapshotFacts, right: SnapshotFacts): boolean {
  return sameAdmission(left, right)
    && JSON.stringify(left.collaboration) === JSON.stringify(right.collaboration)
    && left.project.createdAt === right.project.createdAt
    && left.project.projectId === right.project.projectId
    && left.project.projectName === right.project.projectName
    && left.eventSequence === right.eventSequence;
}

function expectedProjectRefs(
  expectedMainOid: CollabGitOid,
  members: readonly ProjectSnapshotMembershipRecord[],
): readonly ProjectReadRef[] {
  return Object.freeze([
    Object.freeze({ name: COLLAB_MAIN_REF, oid: expectedMainOid }),
    ...members.map(member => Object.freeze({
      name: collabMemberRef(member.memberId),
    })),
  ]);
}

function snapshotMember(
  member: ProjectSnapshotMembershipRecord,
): CollabCloudProjectMember {
  return Object.freeze({
    activatedAt: member.activatedAt,
    createdAt: member.createdAt,
    displayName: member.displayName,
    id: member.memberId,
    personalRef: collabMemberRef(member.memberId),
    role: member.role,
    status: 'active' as const,
  });
}

export class ProjectReadAuthority {
  readonly #controllers = new Set<AbortController>();
  readonly #coordination: ProjectReadAuthorityCoordination;
  readonly #repository: ProjectReadRepository;
  readonly #running = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: ProjectReadAuthorityOptions) {
    this.#coordination = options.coordination;
    this.#repository = options.repository;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort();
      this.#closePromise = Promise.allSettled([...this.#running]).then(() => undefined);
    }
    return this.#closePromise;
  }

  getProjectEvents(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    afterSequence: number,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<ProjectEventReadResult> {
    return this.#run(options.signal, signal => this.#getProjectEvents(
      principal, projectId, afterSequence, signal,
    ));
  }

  getProjectSnapshot(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options: AcquireProjectLeaseOptions = {},
  ): Promise<CollabCloudProjectSnapshot> {
    return this.#run(options.signal, signal => this.#getProjectSnapshot(
      principal, projectId, signal,
    ));
  }

  advertiseUploadPack(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options: ProjectUploadPackAdvertisementOptions = {},
  ): Promise<Buffer> {
    return this.#run(options.signal, signal => this.#runUploadPackOperation(
      principal,
      projectId,
      signal,
      facts => this.#repository.advertiseUploadPack(
        facts.placement,
        {
          expectedRefs: facts.expectedRefs,
          ...(options.gitProtocol === undefined ? {} : { gitProtocol: options.gitProtocol }),
          revalidateAuthority: () => this.#revalidateAdmission(
            principal,
            projectId,
            facts,
            signal,
          ),
          signal,
        },
      ),
    ));
  }

  runUploadPack(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options: ProjectUploadPackOptions,
  ): Promise<void> {
    return this.#run(options.signal, signal => this.#runUploadPackOperation(
      principal,
      projectId,
      signal,
      facts => this.#repository.runUploadPack(facts.placement, {
        ...options,
        expectedRefs: facts.expectedRefs,
        revalidateAuthority: () => this.#revalidateAdmission(
          principal,
          projectId,
          facts,
          signal,
        ),
        signal,
      }),
    ));
  }

  #assertAvailable(signal: AbortSignal | undefined): void {
    if (this.#closed) fail('closed');
    if (signal?.aborted === true) fail('cancelled');
  }

  async #admit(
    scope: ProjectReadScope,
    principal: IngressPrincipal,
    projectId: CollabProjectId,
  ): Promise<AdmissionFacts> {
    const memberId = await scope.findDevelopmentActorMember(principal.actorId);
    if (memberId === undefined) return fail('project-not-found');
    const membership = await scope.findMembership(memberId);
    if (membership?.status !== 'active') return fail('project-not-found');
    if (await scope.getNonterminalDevelopmentBootstrapAttempt() !== undefined) {
      return fail('recovery-required');
    }
    const project = await scope.getProject();
    if (project === undefined || project.projectId !== projectId) {
      return fail('project-not-found');
    }
    if (project.serviceState !== 'active') return fail('recovery-required');
    const placement = await scope.getRepositoryPlacement();
    if (
      placement === undefined
      || placement.projectId !== projectId
    ) {
      return fail('state-conflict');
    }
    const members = [...await scope.listActiveSnapshotMemberships()]
      .sort((left, right) => left.memberId.localeCompare(right.memberId, 'en-US'));
    if (members.length > COLLAB_CLOUD_BINDING_LIMITS.maxCloudProjectMembers) {
      return fail('project-too-large');
    }
    if (!members.some(member => member.memberId === memberId)) {
      return fail('state-conflict');
    }
    return Object.freeze({
      expectedRefs: expectedProjectRefs(project.expectedMainOid, members),
      expectedMainOid: project.expectedMainOid,
      memberId,
      members: Object.freeze(members),
      membershipRevision: membership.revision,
      placement,
      role: membership.role,
    });
  }

  async #readAdmission(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    signal: AbortSignal | undefined,
  ): Promise<AdmissionFacts> {
    this.#assertAvailable(signal);
    if (!isCollabProjectId(projectId)) return fail('project-not-found');
    return this.#coordination.withProjectReadScope(
      projectId,
      scope => this.#admit(scope, principal, projectId),
      signal === undefined ? {} : { signal },
    );
  }

  async #readSnapshotFacts(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    signal: AbortSignal | undefined,
  ): Promise<SnapshotFacts> {
    this.#assertAvailable(signal);
    return this.#coordination.withProjectReadScope(projectId, async scope => {
      const admission = await this.#admit(scope, principal, projectId);
      const project = await scope.getProject();
      if (project === undefined) return fail('state-conflict');
      const collaboration = await scope.collaboration.snapshot.read();
      if (collaboration.kind === 'too-large') return fail('project-too-large');
      return Object.freeze({
        ...admission,
        collaboration: collaboration.snapshot,
        eventSequence: await scope.getProjectEventSequence(),
        project: Object.freeze({
          createdAt: project.createdAt,
          expectedMainOid: project.expectedMainOid,
          projectId: project.projectId,
          projectName: project.projectName,
        }),
      });
    }, signal === undefined ? {} : { signal });
  }

  async #verifyRepository(
    facts: AdmissionFacts,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    this.#assertAvailable(signal);
    try {
      await this.#repository.verifyProjectRead({
        expectedRefs: facts.expectedRefs,
        expectedMainOid: facts.expectedMainOid,
        placement: facts.placement,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof ProjectReadAuthorityError) throw error;
      if (signal?.aborted === true) fail('cancelled');
      fail('dependency-failed');
    }
  }

  async #getProjectSnapshot(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    signal: AbortSignal | undefined,
  ): Promise<CollabCloudProjectSnapshot> {
    const initial = await this.#readSnapshotFacts(principal, projectId, signal);
    await this.#verifyRepository(initial, signal);
    const current = await this.#readSnapshotFacts(principal, projectId, signal);
    if (!sameSnapshotFacts(initial, current)) return fail('state-conflict');
    await this.#verifyRepository(current, signal);
    const members = Object.freeze(current.members.map(snapshotMember));
    const currentMember = members.find(member => member.id === current.memberId);
    if (currentMember === undefined) return fail('state-conflict');
    let snapshot: CollabCloudProjectSnapshot;
    try {
      snapshot = decodeCollabCloudProjectSnapshot({
        currentMember,
        eventSequence: current.eventSequence,
        members,
        openRequests: current.collaboration.openRequests,
        openTicketCount: current.collaboration.openTicketCount,
        project: {
          createdAt: current.project.createdAt,
          expectedMainOid: current.project.expectedMainOid,
          id: current.project.projectId,
          mainRef: COLLAB_MAIN_REF,
          name: current.project.projectName,
        },
        ticketHighlights: current.collaboration.ticketHighlights,
      });
    } catch {
      return fail('dependency-failed');
    }
    if (
      Buffer.byteLength(JSON.stringify(snapshot))
      > COLLAB_CLOUD_BINDING_LIMITS.maxCloudSnapshotUtf8Bytes
    ) {
      return fail('project-too-large');
    }
    return snapshot;
  }

  async #getProjectEvents(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    afterSequence: number,
    signal: AbortSignal | undefined,
  ): Promise<ProjectEventReadResult> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return fail('state-conflict');
    }
    const initial = await this.#readAdmission(principal, projectId, signal);
    await this.#verifyRepository(initial, signal);
    const observed = await this.#coordination.withProjectReadScope(
      projectId,
      async scope => {
        const current = await this.#admit(scope, principal, projectId);
        if (!sameAdmission(initial, current)) return fail('state-conflict');
        return Object.freeze({
          current,
          result: await scope.readProjectEvents({
            afterSequence,
            limit: COLLAB_CLOUD_BINDING_LIMITS.maxEventReplay,
          }),
        });
      },
      signal === undefined ? {} : { signal },
    );
    await this.#verifyRepository(observed.current, signal);
    const { result } = observed;
    const needsSnapshot = afterSequence > result.latestSequence
      || afterSequence + 1 < result.retainedFromSequence
      || result.latestSequence - afterSequence
        > COLLAB_CLOUD_BINDING_LIMITS.maxEventReplay;
    if (needsSnapshot) {
      return Object.freeze({
        kind: 'snapshot-required' as const,
        latestSequence: result.latestSequence,
      });
    }
    let expected = afterSequence + 1;
    for (const event of result.events) {
      if (event.sequence !== expected) {
        return Object.freeze({
          kind: 'snapshot-required' as const,
          latestSequence: result.latestSequence,
        });
      }
      expected += 1;
    }
    if (expected - 1 !== result.latestSequence) {
      return Object.freeze({
        kind: 'snapshot-required' as const,
        latestSequence: result.latestSequence,
      });
    }
    return Object.freeze({
      events: result.events,
      kind: 'events' as const,
      latestSequence: result.latestSequence,
    });
  }

  async #runUploadPackOperation<T>(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    signal: AbortSignal | undefined,
    operation: (facts: AdmissionFacts) => Promise<T>,
  ): Promise<T> {
    const initial = await this.#readAdmission(principal, projectId, signal);
    await this.#verifyRepository(initial, signal);
    const current = await this.#readAdmission(principal, projectId, signal);
    if (!sameAdmission(initial, current)) return fail('state-conflict');
    await this.#verifyRepository(current, signal);
    return operation(current);
  }

  async #revalidateAdmission(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    expected: AdmissionFacts,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const current = await this.#readAdmission(principal, projectId, signal);
    if (!sameAdmission(expected, current)) fail('state-conflict');
  }

  #run<T>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new ProjectReadAuthorityError('closed'));
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted === true) controller.abort();
    this.#controllers.add(controller);
    const result = Promise.resolve().then(() => operation(controller.signal));
    const cleanup = (): void => {
      externalSignal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
    };
    const tracked = result.then(() => undefined, () => undefined).finally(cleanup);
    this.#running.add(tracked);
    void tracked.finally(() => this.#running.delete(tracked));
    return result;
  }
}
