import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLLAB_MAIN_REF,
  CollabError,
  collabMemberRef,
  type CreateCloudProjectRequest,
  type CreateCloudProjectResponse,
} from '@claudian-collab/protocol';

import type {
  CloudProjectCreationJournal,
  CloudProjectCreationPersistence,
  PrepareCloudProjectCreationInput,
} from '../../src/coordination/CloudProjectCreationPersistence.js';
import {
  CloudProjectCreationCoordinator,
  type CloudProjectCreationCoordination,
} from '../../src/project-authority/creation/CloudProjectCreationCoordinator.js';
import type {
  EmptyProjectPublicationPlan,
  EmptyProjectRepository,
  EmptyProjectRepositoryReservation,
} from '../../src/repositories/EmptyProjectRepositoryAuthority.js';
import { createVaultCredentialPrincipal } from '../../src/request-context/RequestPrincipal.js';

const CREATED_AT = '2026-08-30T01:02:03.000Z';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// Independently worked from the canonical empty-Project Git commit bytes.
const INITIAL_COMMIT = '6b1a12d6d3b4714801617caa850adf32f9858bf5';
const MARKER_SHA256 = 'a'.repeat(64);
const MEMBER_ID = 'member_initial_manager';
const OPERATION_ID = 'create_project_operation';
const REQUEST: CreateCloudProjectRequest = {
  idempotencyKey: 'create_project_key',
  managerDisplayName: 'Initial Manager',
  projectId: 'project_cloud_empty',
  projectName: 'Empty Cloud Project',
};
const PRINCIPAL = createVaultCredentialPrincipal({
  principalId: 'principal_operator_asserted',
});

class MemoryCreationPersistence implements CloudProjectCreationPersistence {
  record: CloudProjectCreationJournal | undefined;
  readonly committedPhases: string[] = [];
  failAfter: string | undefined;

  #commit(record: CloudProjectCreationJournal): void {
    this.record = Object.freeze(record);
    this.committedPhases.push(record.phase);
    if (this.failAfter === record.phase) {
      this.failAfter = undefined;
      throw new Error('injected-after-durable-phase');
    }
  }

  get(): Promise<CloudProjectCreationJournal | undefined> {
    return Promise.resolve(this.record);
  }

  prepare(input: PrepareCloudProjectCreationInput): Promise<'created' | 'replayed' | 'conflict'> {
    if (this.record !== undefined) return Promise.resolve('replayed');
    this.#commit(Object.freeze({
      ...input,
      phase: 'prepared',
      publicationMarkerSha256: undefined,
      response: undefined,
      updatedAt: input.preparedAt,
    }));
    return Promise.resolve('created');
  }

  markRepositoryPublicationIntent(updatedAt: string): Promise<'advanced' | 'replayed'> {
    assert.ok(this.record);
    this.#commit(Object.freeze({
      ...this.record,
      phase: 'repository-publication-intent',
      updatedAt,
    }));
    return Promise.resolve('advanced');
  }

  markRepositoryPublished(input: Readonly<{
    readonly publicationMarkerSha256: string;
    readonly updatedAt: string;
  }>): Promise<'advanced' | 'replayed'> {
    assert.ok(this.record);
    this.#commit(Object.freeze({
      ...this.record,
      phase: 'repository-published',
      publicationMarkerSha256: input.publicationMarkerSha256,
      updatedAt: input.updatedAt,
    }));
    return Promise.resolve('advanced');
  }

  activate(input: Readonly<{
    readonly activatedAt: string;
    readonly response: CreateCloudProjectResponse;
  }>): Promise<CreateCloudProjectResponse> {
    assert.ok(this.record);
    this.#commit(Object.freeze({
      ...this.record,
      phase: 'activated',
      response: Object.freeze(input.response),
      updatedAt: input.activatedAt,
    }));
    return Promise.resolve(input.response);
  }

  complete(completedAt: string): Promise<CreateCloudProjectResponse> {
    assert.ok(this.record?.response);
    this.#commit(Object.freeze({
      ...this.record,
      phase: 'completed',
      updatedAt: completedAt,
    }));
    return Promise.resolve(this.record.response);
  }
}

class MemoryCreationCoordination implements CloudProjectCreationCoordination {
  readonly persistence = new MemoryCreationPersistence();
  readonly order: string[];

  constructor(order: string[]) {
    this.order = order;
  }

  acquireCloudProjectCreationLease(): Promise<Readonly<{
    close(): Promise<void>;
    withCreationScope<T>(
      operation: (persistence: CloudProjectCreationPersistence) => Promise<T>,
    ): Promise<T>;
  }>> {
    this.order.push('project-lease');
    return Promise.resolve(Object.freeze({
      close: () => Promise.resolve(),
      withCreationScope: <T>(
        operation: (persistence: CloudProjectCreationPersistence) => Promise<T>,
      ): Promise<T> => operation(this.persistence),
    }));
  }
}

class MemoryEmptyRepository implements EmptyProjectRepository {
  readonly order: string[];
  published = 0;
  verified = 0;

  constructor(order: string[]) {
    this.order = order;
  }

  reserve(): Promise<EmptyProjectRepositoryReservation> {
    this.order.push('repository-reservation');
    return Promise.resolve(Object.freeze({
      close: () => Promise.resolve(),
      projectId: REQUEST.projectId,
    }));
  }

  publish(
    _reservation: EmptyProjectRepositoryReservation,
    plan: EmptyProjectPublicationPlan,
  ): Promise<Readonly<{
    readonly publicationMarkerSha256: string;
    readonly status: 'published' | 'replayed';
  }>> {
    assert.equal(plan.emptyTreeOid, EMPTY_TREE);
    assert.equal(plan.initialCommitOid, INITIAL_COMMIT);
    assert.equal(plan.mainRef, COLLAB_MAIN_REF);
    assert.equal(plan.personalRef, collabMemberRef(MEMBER_ID));
    this.published += 1;
    return Promise.resolve({
      publicationMarkerSha256: MARKER_SHA256,
      status: this.published === 1 ? 'published' : 'replayed',
    });
  }

  verify(
    _reservation: EmptyProjectRepositoryReservation,
    plan: EmptyProjectPublicationPlan,
    publicationMarkerSha256: string,
  ): Promise<void> {
    assert.equal(plan.initialCommitOid, INITIAL_COMMIT);
    assert.equal(publicationMarkerSha256, MARKER_SHA256);
    this.verified += 1;
    return Promise.resolve();
  }
}

function fixture(): Readonly<{
  coordination: MemoryCreationCoordination;
  coordinator: CloudProjectCreationCoordinator;
  order: string[];
  repository: MemoryEmptyRepository;
}> {
  const order: string[] = [];
  const coordination = new MemoryCreationCoordination(order);
  const repository = new MemoryEmptyRepository(order);
  return {
    coordination,
    coordinator: new CloudProjectCreationCoordinator({
      clock: () => new Date(CREATED_AT),
      coordination,
      memberIdFactory: () => MEMBER_ID,
      operationIdFactory: () => OPERATION_ID,
      repository,
      storageNodeId: 'node-a',
    }),
    order,
    repository,
  };
}

describe('CloudProjectCreationCoordinator', () => {
  it('creates an active empty Project with one generated Manager and exact refs', async () => {
    const { coordination, coordinator, order, repository } = fixture();

    const result = await coordinator.create(PRINCIPAL, REQUEST);

    assert.deepEqual(result, {
      createdAt: CREATED_AT,
      mainOid: INITIAL_COMMIT,
      managerSetGeneration: 1,
      memberId: MEMBER_ID,
      membershipRevision: 2,
      personalRef: collabMemberRef(MEMBER_ID),
      projectId: REQUEST.projectId,
      role: 'manager',
    });
    assert.deepEqual(order.slice(0, 2), [
      'repository-reservation',
      'project-lease',
    ]);
    assert.deepEqual(coordination.persistence.committedPhases, [
      'prepared',
      'repository-publication-intent',
      'repository-published',
      'activated',
      'completed',
    ]);
    assert.equal(repository.published, 1);
    assert.equal(repository.verified, 1);
  });

  for (const phase of [
    'prepared',
    'repository-publication-intent',
    'repository-published',
    'activated',
    'completed',
  ] as const) {
    it(`recovers forward after response loss at ${phase}`, async () => {
      const { coordination, coordinator } = fixture();
      coordination.persistence.failAfter = phase;

      await assert.rejects(
        coordinator.create(PRINCIPAL, REQUEST),
        (error: unknown) => error instanceof CollabError
          && error.code === 'operation-failed',
      );

      const result = await coordinator.create(PRINCIPAL, REQUEST);
      assert.equal(result.mainOid, INITIAL_COMMIT);
      assert.equal(result.memberId, MEMBER_ID);
      assert.equal(coordination.persistence.record?.phase, 'completed');
    });
  }

  it('returns one safe conflict for a colliding Project or non-exact replay', async () => {
    const { coordinator } = fixture();
    await coordinator.create(PRINCIPAL, REQUEST);

    for (const [principal, request] of [
      [createVaultCredentialPrincipal({
        principalId: 'different-principal',
      }), REQUEST],
      [PRINCIPAL, { ...REQUEST, idempotencyKey: 'different-key' }],
      [PRINCIPAL, { ...REQUEST, projectName: 'Different name' }],
    ] as const) {
      await assert.rejects(
        coordinator.create(principal, request),
        (error: unknown) => error instanceof CollabError
          && error.code === 'idempotency-conflict'
          && error.safeContext.reason === 'project-create-conflict',
      );
    }
  });
});
