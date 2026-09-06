import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLLAB_MAIN_REF,
  CollabError,
  collabMemberRef,
  type AcceptRequest,
  type AcceptResponse,
  type CollabChangeRequest,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  AcceptJournalRecord,
  AcceptPersistence,
  PrepareAcceptInput,
} from '../../src/coordination/AcceptPersistence.js';
import type {
  CollaborationIdempotencyLookup,
  CollaborationIdempotencyStoreResult,
  CollaborationProjectPersistence,
} from '../../src/coordination/CollaborationPersistence.js';
import type {
  PinnedProjectLease,
  ProjectReadScope,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import {
  ProjectAcceptCoordinator,
  type ProjectAcceptCoordination,
} from '../../src/project-authority/acceptance/ProjectAcceptCoordinator.js';
import {
  ProjectAcceptRepositoryError,
  type ProjectAcceptRepository,
} from '../../src/project-authority/acceptance/ProjectAcceptRepository.js';
import { createDevelopmentPrincipal } from '../../src/request-context/RequestPrincipal.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

const T0 = '2026-08-24T00:00:00.000Z';
const T1_WITH_MILLISECONDS = '2026-08-24T01:02:03.987Z';
const T1 = '2026-08-24T01:02:03.000Z';
const T2 = '2026-08-24T01:03:00.000Z';
const T3 = '2026-08-24T01:04:00.000Z';
const T4 = '2026-08-24T01:05:00.000Z';
const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const RESULT = 'd'.repeat(40);
const PERSONAL_REF = collabMemberRef('member-author');

class MemoryCollaboration {
  request: CollabChangeRequest = {
    commentCount: 0,
    createdAt: T0,
    description: 'Accept this request',
    firstBaseOid: MAIN,
    id: 'request-a',
    latestHeadOid: HEAD,
    memberId: 'member-author',
    revision: 3,
    status: 'open',
    ticketRelations: [{
      commitOid: HEAD,
      id: 'relation-a',
      kind: 'resolves',
      state: 'pending',
      ticketId: 'ticket-a',
      ticketNumber: 1,
      ticketRevision: 4,
      ticketTitle: 'Resolve this',
    }],
    updatedAt: T0,
  };
  readonly rows = new Map<string, Readonly<{
    readonly fingerprint: string;
    readonly response: Readonly<Record<string, unknown>>;
  }>>();

  readonly persistence = {
    idempotency: {
      find: (input: {
        readonly idempotencyKey: string;
        readonly requestFingerprint: string;
      }): Promise<CollaborationIdempotencyLookup> => {
        const row = this.rows.get(input.idempotencyKey);
        if (row === undefined) return Promise.resolve({ kind: 'missing' });
        return Promise.resolve(row.fingerprint === input.requestFingerprint
          ? { kind: 'replay', response: row.response }
          : { kind: 'conflict' });
      },
      store: (input: {
        readonly idempotencyKey: string;
        readonly requestFingerprint: string;
        readonly response: Readonly<Record<string, unknown>>;
      }): Promise<CollaborationIdempotencyStoreResult> => {
        this.rows.set(input.idempotencyKey, {
          fingerprint: input.requestFingerprint,
          response: input.response,
        });
        return Promise.resolve({ kind: 'stored', response: input.response });
      },
    },
    requests: {
      find: (requestId: string) => Promise.resolve(
        requestId === this.request.id ? this.request : undefined,
      ),
    },
  } as unknown as CollaborationProjectPersistence;
}

class MemoryAcceptPersistence implements AcceptPersistence {
  record: AcceptJournalRecord | undefined;
  readonly phases: string[] = [];

  constructor(readonly collaboration: MemoryCollaboration) {}

  get(operationId: string): Promise<AcceptJournalRecord | undefined> {
    return Promise.resolve(
      this.record?.operationId === operationId ? this.record : undefined,
    );
  }

  getNonterminal(): Promise<AcceptJournalRecord | undefined> {
    return Promise.resolve(this.record?.phase === 'completed' ? undefined : this.record);
  }

  prepare(input: PrepareAcceptInput): Promise<'created' | 'replayed'> {
    this.record = {
      ...input,
      phase: 'prepared',
      recoveryFromPhase: undefined,
      resultOid: undefined,
      updatedAt: input.preparedAt,
    };
    this.phases.push('prepared');
    return Promise.resolve('created');
  }

  persistResult(input: Readonly<{
    readonly operationId: string;
    readonly resultOid: string;
    readonly updatedAt: string;
  }>): Promise<'advanced' | 'replayed'> {
    assert.ok(this.record);
    this.record = {
      ...this.record,
      phase: 'result-persisted',
      resultOid: input.resultOid,
      updatedAt: input.updatedAt,
    };
    this.phases.push('result-persisted');
    return Promise.resolve('advanced');
  }

  markMainUpdated(input: Readonly<{
    readonly updatedAt: string;
  }>): Promise<'advanced' | 'replayed'> {
    assert.ok(this.record);
    this.record = {
      ...this.record,
      phase: 'main-updated',
      updatedAt: input.updatedAt,
    };
    this.phases.push('main-updated');
    return Promise.resolve('advanced');
  }

  markRecoveryRequired(): Promise<'advanced' | 'replayed'> {
    throw new Error('unexpected recovery classification');
  }

  complete(input: Readonly<{ readonly completedAt: string }>): Promise<AcceptResponse> {
    assert.ok(this.record?.resultOid);
    this.collaboration.request = {
      ...this.collaboration.request,
      mergedOid: this.record.resultOid,
      status: 'merged',
      ticketRelations: this.collaboration.request.ticketRelations.map(relation => ({
        ...relation,
        state: 'accepted' as const,
        ticketRevision: relation.ticketRevision + 1,
      })),
      updatedAt: input.completedAt,
    };
    const response: AcceptResponse = {
      mainOid: this.record.resultOid,
      mergeCommitOid: this.record.resultOid,
      request: this.collaboration.request,
    };
    this.collaboration.rows.set(this.record.idempotencyKey, {
      fingerprint: this.record.requestFingerprint,
      response: response as unknown as Readonly<Record<string, unknown>>,
    });
    this.record = { ...this.record, phase: 'completed', updatedAt: input.completedAt };
    this.phases.push('completed');
    return Promise.resolve(response);
  }
}

class MemoryCoordination implements ProjectAcceptCoordination {
  readonly collaboration = new MemoryCollaboration();
  readonly accept = new MemoryAcceptPersistence(this.collaboration);
  readonly placement = createRepositoryPlacementLease({
    active: true,
    generation: 7,
    projectId: 'project-a',
    repositoryStorageKey: 'repository-a',
    storageNodeId: 'node-a',
  });

  acquireProjectLease(): Promise<PinnedProjectLease> {
    return Promise.resolve({
      close: () => Promise.resolve(),
      drainDevelopmentBootstrapUploads: () => Promise.resolve(),
      handoffToDevelopmentBootstrapUpload: () => Promise.resolve({
        close: () => Promise.resolve(),
      }),
      withProjectScope: operation => operation(this.scope()),
    });
  }

  withProjectReadScope<T>(
    _projectId: CollabProjectId,
    operation: (scope: ProjectReadScope) => Promise<T>,
  ): Promise<T> {
    return operation(this.scope());
  }

  scope(): ProjectScope & ProjectReadScope {
    return {
      accept: this.accept,
      collaboration: this.collaboration.persistence,
      findDevelopmentActorMember: (principalId: string) => Promise.resolve(
        principalId === 'manager-actor' ? 'member-manager' : undefined,
      ),
      findPrincipalMember: (principalId: string) => Promise.resolve(
        principalId === 'manager-actor' ? 'member-manager' : undefined,
      ),
      findMembership: (memberId: string) => Promise.resolve(
        memberId === 'member-manager'
          ? {
            displayName: 'Manager',
            memberId,
            revision: 2n,
            role: 'manager' as const,
            status: 'active' as const,
          }
          : undefined,
      ),
      getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(undefined),
      membership: {
        getNonterminalJoin: () => Promise.resolve(undefined),
      },
      portability: {
        getNonterminalLifecycleJournal: () => Promise.resolve(undefined),
      },
      getProject: () => Promise.resolve({
        activatedAt: T0,
        createdAt: T0,
        expectedMainOid: MAIN,
        managerSetGeneration: 1,
        projectId: 'project-a',
        projectName: 'Project A',
        serviceState: 'active',
      }),
      getRepositoryPlacement: () => Promise.resolve(this.placement),
    } as unknown as ProjectScope & ProjectReadScope;
  }
}

class MemoryRepository implements ProjectAcceptRepository {
  readonly calls: string[] = [];
  failMaterializeOnce = false;
  inspectionKind: 'contained' | 'merge' = 'merge';
  prepared: PrepareAcceptInput | undefined;

  inspectAccept(
    _reservation: Parameters<ProjectAcceptRepository['inspectAccept']>[0],
    input: Parameters<ProjectAcceptRepository['inspectAccept']>[1],
  ) {
    this.calls.push('inspect');
    return input.revalidateAuthority().then(() => this.inspectionKind === 'contained'
      ? { kind: 'contained' as const, objectFormat: 'sha1' as const }
      : {
        kind: 'merge' as const,
        objectFormat: 'sha1' as const,
        treeOid: TREE,
      });
  }

  materializeAcceptResult(
    _reservation: Parameters<ProjectAcceptRepository['materializeAcceptResult']>[0],
    plan: PrepareAcceptInput,
  ): Promise<string> {
    this.calls.push('materialize');
    this.prepared = plan;
    if (this.failMaterializeOnce) {
      this.failMaterializeOnce = false;
      return Promise.reject(new ProjectAcceptRepositoryError('unavailable'));
    }
    return Promise.resolve(plan.resultKind === 'contained' ? MAIN : RESULT);
  }

  reserveAccept(projectId: CollabProjectId) {
    return Promise.resolve({
      close: () => Promise.resolve(),
      projectId,
    });
  }

  settleAcceptMain(): Promise<'advanced'> {
    this.calls.push('settle-main');
    return Promise.resolve('advanced');
  }
}

function input(): AcceptRequest {
  return {
    expectedHeadOid: HEAD,
    expectedMainOid: MAIN,
    expectedRequestRevision: 3,
    expectedResolvingTickets: [{ revision: 4, ticketId: 'ticket-a' }],
    idempotencyKey: 'accept-key',
    projectId: 'project-a',
    requestId: 'request-a',
  };
}

describe('ProjectAcceptCoordinator', () => {
  it('persists the reviewed deterministic plan before Git and completes exact replay', async () => {
    const coordination = new MemoryCoordination();
    const repository = new MemoryRepository();
    const times = [T1_WITH_MILLISECONDS, T2, T3, T4];
    const coordinator = new ProjectAcceptCoordinator({
      clock: () => new Date(times.shift() ?? T4),
      coordination,
      operationIdFactory: () => 'accept-operation',
      repository,
    });
    const principal = createDevelopmentPrincipal('manager-actor');
    try {
      const response = await coordinator.accept(principal, input());
      const replay = await coordinator.accept(principal, input());

      assert.deepEqual(replay, response);
      assert.deepEqual(repository.calls, ['inspect', 'materialize', 'settle-main']);
      assert.deepEqual(coordination.accept.phases, [
        'prepared',
        'result-persisted',
        'main-updated',
        'completed',
      ]);
      assert.ok(repository.prepared);
      const prepared = repository.prepared;
      assert.deepEqual(prepared, {
        actorMemberId: 'member-manager',
        commit: {
          authorEmail: 'collab@claudian.local',
          authorName: 'Claudian Collab',
          committerEmail: 'collab@claudian.local',
          committerName: 'Claudian Collab',
          message: 'Accept request request-a\n',
          parents: [MAIN, HEAD],
          timezone: '+0000',
          treeOid: TREE,
        },
        expectedHeadOid: HEAD,
        expectedMainOid: MAIN,
        expectedRequestRevision: 3,
        idempotencyKey: 'accept-key',
        mainRef: COLLAB_MAIN_REF,
        objectFormat: 'sha1',
        operationId: 'accept-operation',
        personalRef: PERSONAL_REF,
        placement: {
          generation: 7,
          projectId: 'project-a',
          repositoryStorageKey: 'repository-a',
          storageNodeId: 'node-a',
        },
        preparedAt: T1,
        relations: [{
          commitOid: HEAD,
          kind: 'resolves',
          relationId: 'relation-a',
          ticketId: 'ticket-a',
          ticketRevision: 4,
        }],
        requestFingerprint: prepared.requestFingerprint,
        requestId: 'request-a',
        requestMemberId: 'member-author',
        resultKind: 'merge',
      });
      assert.match(prepared.requestFingerprint, /^[0-9a-f]{64}$/u);
      assert.equal(response.mainOid, RESULT);
      assert.equal(response.request.status, 'merged');
    } finally {
      await coordinator.close();
    }
  });

  it('rejects a stale resolving Ticket tuple before Git inspection', async () => {
    const coordination = new MemoryCoordination();
    const repository = new MemoryRepository();
    const coordinator = new ProjectAcceptCoordinator({ coordination, repository });
    try {
      await assert.rejects(
        coordinator.accept(
          createDevelopmentPrincipal('manager-actor'),
          {
            ...input(),
            expectedResolvingTickets: [{ revision: 3, ticketId: 'ticket-a' }],
          },
        ),
        error => error instanceof CollabError && error.code === 'stale-ticket',
      );
      assert.deepEqual(repository.calls, []);
    } finally {
      await coordinator.close();
    }
  });

  it('persists and completes every phase for contained Accept without commit material', async () => {
    const coordination = new MemoryCoordination();
    const repository = new MemoryRepository();
    repository.inspectionKind = 'contained';
    const coordinator = new ProjectAcceptCoordinator({
      clock: () => new Date(T1_WITH_MILLISECONDS),
      coordination,
      operationIdFactory: () => 'accept-contained-operation',
      repository,
    });
    try {
      const response = await coordinator.accept(
        createDevelopmentPrincipal('manager-actor'),
        { ...input(), idempotencyKey: 'accept-contained-key' },
      );

      assert.equal(response.mainOid, MAIN);
      assert.ok(repository.prepared);
      assert.equal(repository.prepared.resultKind, 'contained');
      assert.equal('commit' in repository.prepared, false);
      assert.deepEqual(repository.calls, ['inspect', 'materialize', 'settle-main']);
      assert.deepEqual(coordination.accept.phases, [
        'prepared',
        'result-persisted',
        'main-updated',
        'completed',
      ]);
    } finally {
      await coordinator.close();
    }
  });

  it('recovers an existing prepared journal before admitting a replay', async () => {
    const coordination = new MemoryCoordination();
    const repository = new MemoryRepository();
    repository.failMaterializeOnce = true;
    const coordinator = new ProjectAcceptCoordinator({
      clock: () => new Date(T1_WITH_MILLISECONDS),
      coordination,
      operationIdFactory: () => 'accept-operation',
      repository,
    });
    const principal = createDevelopmentPrincipal('manager-actor');
    try {
      await assert.rejects(
        coordinator.accept(principal, input()),
        error => error instanceof CollabError && error.code === 'operation-failed',
      );
      assert.equal(coordination.accept.record?.phase, 'prepared');

      const response = await coordinator.accept(principal, input());

      assert.equal(response.mainOid, RESULT);
      assert.deepEqual(repository.calls, [
        'inspect',
        'materialize',
        'materialize',
        'materialize',
        'settle-main',
        'settle-main',
      ]);
      assert.deepEqual(coordination.accept.phases, [
        'prepared',
        'result-persisted',
        'main-updated',
        'completed',
      ]);
    } finally {
      await coordinator.close();
    }
  });
});
