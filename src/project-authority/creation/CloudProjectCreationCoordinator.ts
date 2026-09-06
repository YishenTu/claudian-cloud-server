import { createHash, randomUUID } from 'node:crypto';

import {
  COLLAB_MAIN_REF,
  CollabError,
  collabControlOperationCodec,
  collabMemberRef,
  type CollabGitOid,
  type CollabMemberId,
  type CollabProjectId,
  type CreateCloudProjectRequest,
  type CreateCloudProjectResponse,
} from '@claudian-collab/protocol';

import type {
  CloudProjectCreationCoordination,
  CloudProjectCreationJournal,
  CloudProjectCreationLease,
  PrepareCloudProjectCreationInput,
} from '../../coordination/CloudProjectCreationPersistence.js';
import type { RequestPrincipal } from '../../request-context/RequestPrincipal.js';
import {
  EmptyProjectRepositoryError,
  type EmptyProjectPublicationPlan,
  type EmptyProjectRepository,
} from '../../repositories/EmptyProjectRepositoryAuthority.js';
import { OperationDrain } from '../OperationDrain.js';

export type {
  CloudProjectCreationCoordination,
  CloudProjectCreationLease,
} from '../../coordination/CloudProjectCreationPersistence.js';

export interface CloudProjectCreationCoordinatorOptions {
  readonly clock?: () => Date;
  readonly coordination: CloudProjectCreationCoordination;
  readonly memberIdFactory?: () => string;
  readonly operationIdFactory?: () => string;
  readonly repository: EmptyProjectRepository;
  readonly repositoryStorageKeyFactory?: (projectId: CollabProjectId) => string;
  readonly storageNodeId: string;
}

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

function gitObjectOid(kind: 'commit', content: string): CollabGitOid {
  return createHash('sha1')
    .update(`${kind} ${String(Buffer.byteLength(content, 'utf8'))}\0`, 'utf8')
    .update(content, 'utf8')
    .digest('hex');
}

function creationFingerprint(request: CreateCloudProjectRequest): string {
  return sha256(JSON.stringify({
    managerDisplayName: request.managerDisplayName,
    projectId: request.projectId,
    projectName: request.projectName,
  }));
}

function canonicalTime(clock: () => Date): Readonly<{
  readonly iso: string;
  readonly seconds: number;
}> {
  const date = new Date(clock().valueOf());
  if (Number.isNaN(date.valueOf())) throw new Error('invalid-clock');
  date.setUTCMilliseconds(0);
  return Object.freeze({
    iso: date.toISOString(),
    seconds: Math.floor(date.valueOf() / 1_000),
  });
}

function initialCommitContent(timestampSeconds: number): string {
  const identity = `Claudian Cloud <cloud@claudian.invalid> ${String(timestampSeconds)} +0000`;
  return `tree ${EMPTY_TREE_SHA1}\nauthor ${identity}\ncommitter ${identity}\n\nInitialize Collab project\n`;
}

function immutablePlan(input: Readonly<{
  readonly createdAt: string;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly memberId: CollabMemberId;
  readonly operationId: string;
  readonly principalId: string;
  readonly projectId: CollabProjectId;
  readonly projectName: string;
  readonly managerDisplayName: string;
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
  readonly timestampSeconds: number;
}>): PrepareCloudProjectCreationInput {
  const personalRef = collabMemberRef(input.memberId);
  const initialCommitOid = gitObjectOid(
    'commit',
    initialCommitContent(input.timestampSeconds),
  );
  const commit = Object.freeze({
    authorEmail: 'cloud@claudian.invalid' as const,
    authorName: 'Claudian Cloud' as const,
    commitMessage: 'Initialize Collab project' as const,
    commitTimestampSeconds: input.timestampSeconds,
    emptyTreeOid: EMPTY_TREE_SHA1 as CollabGitOid,
    initialCommitOid,
    mainRef: COLLAB_MAIN_REF,
    objectFormat: 'sha1' as const,
    personalRef,
    timezone: '+0000' as const,
  });
  const placement = Object.freeze({
    active: false as const,
    generation: 1 as const,
    projectId: input.projectId,
    repositoryStorageKey: input.repositoryStorageKey,
    storageNodeId: input.storageNodeId,
  });
  const planSha256 = sha256(JSON.stringify({
    commit,
    createdAt: input.createdAt,
    managerDisplayName: input.managerDisplayName,
    memberId: input.memberId,
    placement,
    principalId: input.principalId,
    projectId: input.projectId,
    projectName: input.projectName,
  }));
  return Object.freeze({
    commit,
    idempotencyKey: input.idempotencyKey,
    managerDisplayName: input.managerDisplayName,
    memberId: input.memberId,
    operationId: input.operationId,
    placement,
    planSha256,
    preparedAt: input.createdAt,
    principalId: input.principalId,
    projectId: input.projectId,
    projectName: input.projectName,
    requestFingerprint: input.fingerprint,
  });
}

function publicationPlan(
  journal: CloudProjectCreationJournal,
): EmptyProjectPublicationPlan {
  return Object.freeze({
    ...journal.commit,
    planSha256: journal.planSha256,
    projectId: journal.projectId,
    repositoryStorageKey: journal.placement.repositoryStorageKey,
    storageNodeId: journal.placement.storageNodeId,
  });
}

function exactReplay(
  journal: CloudProjectCreationJournal,
  principal: RequestPrincipal,
  request: CreateCloudProjectRequest,
  fingerprint: string,
): boolean {
  return journal.principalId === principal.principalId
    && journal.idempotencyKey === request.idempotencyKey
    && journal.requestFingerprint === fingerprint;
}

function response(journal: CloudProjectCreationJournal): CreateCloudProjectResponse {
  return Object.freeze({
    createdAt: journal.preparedAt,
    mainOid: journal.commit.initialCommitOid,
    managerSetGeneration: 1,
    memberId: journal.memberId,
    membershipRevision: 2,
    personalRef: journal.commit.personalRef,
    projectId: journal.projectId,
    role: 'manager',
  });
}

function decodeResponse(value: unknown): CreateCloudProjectResponse {
  try {
    return collabControlOperationCodec('createCloudProject').decodeResponse(value);
  } catch {
    throw domainError(
      'authority-integrity-error',
      'project-create-response-invalid',
    );
  }
}

function mapPublicError(error: unknown): never {
  if (error instanceof CollabError) throw error;
  if (error instanceof EmptyProjectRepositoryError) {
    if (error.code === 'state-conflict' || error.code === 'invalid-plan') {
      throw domainError(
        'authority-not-synchronized',
        'project-create-repository-conflict',
        true,
      );
    }
  }
  throw domainError('operation-failed', 'project-create-unavailable', true);
}

export class CloudProjectCreationCoordinator {
  readonly #clock: () => Date;
  readonly #coordination: CloudProjectCreationCoordination;
  readonly #memberIdFactory: () => string;
  readonly #operationIdFactory: () => string;
  readonly #operations = new OperationDrain();
  readonly #repository: EmptyProjectRepository;
  readonly #repositoryStorageKeyFactory: (projectId: CollabProjectId) => string;
  readonly #storageNodeId: string;

  constructor(options: CloudProjectCreationCoordinatorOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#memberIdFactory = options.memberIdFactory ?? (() => (
      `member_${randomUUID().replaceAll('-', '')}`
    ));
    this.#operationIdFactory = options.operationIdFactory ?? (() => (
      `create_${randomUUID().replaceAll('-', '')}`
    ));
    this.#repository = options.repository;
    this.#repositoryStorageKeyFactory = options.repositoryStorageKeyFactory ?? (
      projectId => `repo_${sha256(projectId).slice(0, 48)}`
    );
    this.#storageNodeId = options.storageNodeId;
  }

  create(
    principal: RequestPrincipal,
    request: CreateCloudProjectRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CreateCloudProjectResponse> {
    return this.#operations.run(options, signal => this.#create(
      principal,
      request,
      { signal },
    )).catch(mapPublicError);
  }

  async #create(
    principal: RequestPrincipal,
    request: CreateCloudProjectRequest,
    options: Readonly<{ readonly signal: AbortSignal }>,
  ): Promise<CreateCloudProjectResponse> {
    if (principal.provenance.kind !== 'vault-credential') {
      throw domainError('authorization-denied', 'project-create-principal-untrusted');
    }
    const fingerprint = creationFingerprint(request);
    let reservation;
    let lease;
    try {
      reservation = await this.#repository.reserve(request.projectId, options);
      lease = await this.#coordination.acquireCloudProjectCreationLease(
        request.projectId,
        options,
      );
      let journal = await lease.withCreationScope(persistence => persistence.get());
      if (journal === undefined) {
        const time = canonicalTime(this.#clock);
        const plan = immutablePlan({
          createdAt: time.iso,
          fingerprint,
          idempotencyKey: request.idempotencyKey,
          managerDisplayName: request.managerDisplayName,
          memberId: this.#memberIdFactory(),
          operationId: this.#operationIdFactory(),
          principalId: principal.principalId,
          projectId: request.projectId,
          projectName: request.projectName,
          repositoryStorageKey: this.#repositoryStorageKeyFactory(request.projectId),
          storageNodeId: this.#storageNodeId,
          timestampSeconds: time.seconds,
        });
        const prepared = await lease.withCreationScope(persistence => (
          persistence.prepare(plan)
        ));
        if (prepared === 'conflict') {
          throw domainError('idempotency-conflict', 'project-create-conflict');
        }
        journal = await lease.withCreationScope(persistence => persistence.get());
      }
      if (
        journal === undefined
        || !exactReplay(journal, principal, request, fingerprint)
      ) {
        throw domainError('idempotency-conflict', 'project-create-conflict');
      }
      const result = await this.#advance(lease, reservation, journal);
      return decodeResponse(result);
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

  async #recoverProject(
    projectId: CollabProjectId,
    signal: AbortSignal,
  ): Promise<void> {
    let preflightLease;
    try {
      preflightLease = await this.#coordination.acquireCloudProjectCreationLease(
        projectId,
        { signal },
      );
      const preflight = await preflightLease.withCreationScope(
        persistence => persistence.get(),
      );
      if (preflight === undefined || preflight.phase === 'completed') return;
    } finally {
      await preflightLease?.close().catch(() => undefined);
    }
    let reservation;
    let lease;
    try {
      reservation = await this.#repository.reserve(projectId, { signal });
      lease = await this.#coordination.acquireCloudProjectCreationLease(
        projectId,
        { signal },
      );
      const journal = await lease.withCreationScope(persistence => persistence.get());
      if (journal === undefined || journal.projectId !== projectId) {
        throw new Error('cloud-project-creation.recovery-state-invalid');
      }
      await this.#advance(lease, reservation, journal);
    } finally {
      await lease?.close().catch(() => undefined);
      await reservation?.close().catch(() => undefined);
    }
  }

  close(): Promise<void> {
    return this.#operations.close();
  }

  async #advance(
    lease: CloudProjectCreationLease,
    reservation: Awaited<ReturnType<EmptyProjectRepository['reserve']>>,
    initial: CloudProjectCreationJournal,
  ): Promise<CreateCloudProjectResponse> {
    let journal = initial;
    if (journal.phase === 'prepared') {
      await lease.withCreationScope(persistence => (
        persistence.markRepositoryPublicationIntent(journal.updatedAt)
      ));
      journal = await this.#requiredJournal(lease);
    }
    if (journal.phase === 'repository-publication-intent') {
      const publication = await this.#repository.publish(
        reservation,
        publicationPlan(journal),
      );
      await lease.withCreationScope(persistence => persistence.markRepositoryPublished({
        publicationMarkerSha256: publication.publicationMarkerSha256,
        updatedAt: journal.updatedAt,
      }));
      journal = await this.#requiredJournal(lease);
    }
    if (journal.phase === 'repository-published') {
      if (journal.publicationMarkerSha256 === undefined) {
        throw new Error('cloud-project-creation.publication-missing');
      }
      await this.#repository.verify(
        reservation,
        publicationPlan(journal),
        journal.publicationMarkerSha256,
      );
      await lease.withCreationScope(persistence => persistence.activate({
        activatedAt: journal.preparedAt,
        response: response(journal),
      }));
      journal = await this.#requiredJournal(lease);
    }
    if (journal.phase === 'activated') {
      const result = await lease.withCreationScope(persistence => (
        persistence.complete(journal.updatedAt)
      ));
      return result;
    }
    if (journal.phase === 'completed' && journal.response !== undefined) {
      return journal.response;
    }
    throw new Error('cloud-project-creation.phase-invalid');
  }

  async #requiredJournal(
    lease: CloudProjectCreationLease,
  ): Promise<CloudProjectCreationJournal> {
    const journal = await lease.withCreationScope(persistence => persistence.get());
    if (journal === undefined) throw new Error('cloud-project-creation.journal-missing');
    return journal;
  }
}
