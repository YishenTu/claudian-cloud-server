import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CollabChangeRequest,
  CollabCloudProjectEvent,
  CollabComment,
  CollabProjectId,
} from '@claudian-collab/protocol';
import { CollabError } from '@claudian-collab/protocol';

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
  ProjectRequestAuthority,
  type ProjectRequestAuthorityCoordination,
  type ProjectRequestRepository,
} from '../../src/project-authority/requests/ProjectRequestAuthority.js';
import { createDevelopmentIngressPrincipal } from '../../src/request-context/IngressPrincipal.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

const CREATED = '2026-08-23T00:00:00.000Z';
const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

class MemoryCollaboration {
  readonly events: CollabCloudProjectEvent[] = [];
  readonly idempotencyRows = new Map<string, {
    readonly fingerprint: string;
    readonly response: Readonly<Record<string, unknown>>;
  }>();
  request: CollabChangeRequest | undefined;
  readonly comments: CollabComment[] = [];

  readonly persistence = {
    idempotency: {
      find: (input: {
        readonly idempotencyKey: string;
        readonly requestFingerprint: string;
      }): Promise<CollaborationIdempotencyLookup> => {
        const row = this.idempotencyRows.get(input.idempotencyKey);
        if (row === undefined) return Promise.resolve({ kind: 'missing' });
        return Promise.resolve(
          row.fingerprint === input.requestFingerprint
            ? { kind: 'replay', response: row.response }
            : { kind: 'conflict' },
        );
      },
      store: (input: {
        readonly idempotencyKey: string;
        readonly requestFingerprint: string;
        readonly response: Readonly<Record<string, unknown>>;
      }): Promise<CollaborationIdempotencyStoreResult> => {
        const row = this.idempotencyRows.get(input.idempotencyKey);
        if (row !== undefined) {
          return Promise.resolve(
            row.fingerprint === input.requestFingerprint
              ? { kind: 'replay', response: row.response }
              : { kind: 'conflict' },
          );
        }
        this.idempotencyRows.set(input.idempotencyKey, {
          fingerprint: input.requestFingerprint,
          response: input.response,
        });
        return Promise.resolve({ kind: 'stored', response: input.response });
      },
    },
    requests: {
      create: (input: {
        readonly createdAt: string;
        readonly description: string;
        readonly firstBaseOid: string;
        readonly latestHeadOid: string;
        readonly memberId: string;
        readonly requestId: string;
      }): Promise<CollabChangeRequest> => {
        this.request = {
          commentCount: 0,
          createdAt: input.createdAt,
          description: input.description,
          firstBaseOid: input.firstBaseOid,
          id: input.requestId,
          latestHeadOid: input.latestHeadOid,
          memberId: input.memberId,
          revision: 1,
          status: 'open',
          ticketRelations: [],
          updatedAt: input.createdAt,
        };
        return Promise.resolve(this.request);
      },
      createComment: (input: {
        readonly authorMemberId: string;
        readonly body: string;
        readonly commentId: string;
        readonly createdAt: string;
        readonly requestId: string;
      }) => {
        assert.ok(this.request);
        const comment = {
          authorMemberId: input.authorMemberId,
          body: input.body,
          createdAt: input.createdAt,
          id: input.commentId,
          requestId: input.requestId,
        };
        this.comments.push(comment);
        this.request = {
          ...this.request,
          commentCount: this.comments.length,
          updatedAt: input.createdAt,
        };
        return Promise.resolve({ comment, request: this.request });
      },
      find: (requestId: string) => Promise.resolve(
        this.request?.id === requestId ? this.request : undefined,
      ),
      findOpenByMember: (memberId: string) => Promise.resolve(
        this.request?.memberId === memberId && this.request.status === 'open'
          ? this.request
          : undefined,
      ),
      listComments: (
        _requestId: string,
        options: Readonly<{
          readonly after?: Readonly<{ readonly createdAt: string; readonly id: string }>;
          readonly limit: number;
        }>,
      ) => {
        const after = options.after;
        const rows = after === undefined
          ? this.comments
          : this.comments.filter(comment => (
            comment.createdAt > after.createdAt
            || (
              comment.createdAt === after.createdAt
              && comment.id > after.id
            )
          ));
        const cursorRow = rows.at(options.limit - 1);
        return Promise.resolve({
          items: rows.slice(0, options.limit),
          nextCursor: rows.length > options.limit && cursorRow !== undefined
            ? {
              createdAt: cursorRow.createdAt,
              id: cursorRow.id,
            }
            : undefined,
        });
      },
      replacePendingRelations: () => Promise.resolve([]),
      touchOpen: () => Promise.resolve(this.request?.status === 'open'),
      updateOpen: (input: {
        readonly description: string;
        readonly expectedRevision: number;
        readonly latestHeadOid: string;
        readonly updatedAt: string;
      }) => {
        if (
          this.request === undefined
          || this.request.status !== 'open'
          || this.request.revision !== input.expectedRevision
        ) return Promise.resolve(undefined);
        this.request = {
          ...this.request,
          description: input.description,
          latestHeadOid: input.latestHeadOid,
          revision: this.request.revision + 1,
          updatedAt: input.updatedAt,
        };
        return Promise.resolve(this.request);
      },
    },
    tickets: {
      findByNumbers: () => Promise.resolve([]),
    },
  } as unknown as CollaborationProjectPersistence;
}

class MemoryCoordination implements ProjectRequestAuthorityCoordination {
  readonly collaboration = new MemoryCollaboration();
  expectedMainOid = MAIN;
  readonly placement = createRepositoryPlacementLease({
    active: true,
    generation: 1,
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
      accept: { getNonterminal: () => Promise.resolve(undefined) },
      appendProjectEvent: (
        input: Parameters<ProjectScope['appendProjectEvent']>[0],
      ) => {
        const event = {
          ...input,
          projectId: 'project-a',
          protocolVersion: 8 as const,
          sequence: this.collaboration.events.length + 1,
        } as CollabCloudProjectEvent;
        this.collaboration.events.push(event);
        return Promise.resolve(event);
      },
      collaboration: this.collaboration.persistence,
      findDevelopmentActorMember: (principalId: string) => Promise.resolve(
        principalId === 'actor-a' ? 'member-a' : undefined,
      ),
      findPrincipalMember: (principalId: string) => Promise.resolve(
        principalId === 'actor-a' ? 'member-a' : undefined,
      ),
      findMembership: (memberId: string) => Promise.resolve(
        memberId === 'member-a'
          ? {
            displayName: 'Member A',
            memberId,
            revision: 1n,
            role: 'member',
            status: 'active',
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
        activatedAt: CREATED,
        createdAt: CREATED,
        expectedMainOid: this.expectedMainOid,
        managerSetGeneration: 1,
        projectId: 'project-a',
        projectName: 'Project A',
        serviceState: 'active',
      }),
      getRepositoryPlacement: () => Promise.resolve(this.placement),
    } as unknown as ProjectScope & ProjectReadScope;
  }
}

class MemoryRepository implements ProjectRequestRepository {
  inspections = 0;
  onInspect: (() => void) | undefined;
  validations = 0;

  async inspectRequest(input: Parameters<ProjectRequestRepository['inspectRequest']>[0]): Promise<{
    readonly currentMainOid: string;
    readonly reviewCondition: 'clean';
    readonly reviewedHeadOid: string;
  }> {
    this.inspections += 1;
    this.onInspect?.();
    await input.revalidateAuthority();
    return {
      currentMainOid: input.expectedMainOid,
      reviewCondition: 'clean',
      reviewedHeadOid: input.latestHeadOid,
    };
  }

  async validateRequestHead(
    input: Parameters<ProjectRequestRepository['validateRequestHead']>[0],
  ): Promise<void> {
    this.validations += 1;
    await input.revalidateAuthority();
  }
}

describe('Project Request authority', () => {
  it('returns SQL metadata with Git scalars only after read-side revalidation', async () => {
    const coordination = new MemoryCoordination();
    coordination.collaboration.request = {
      commentCount: 0,
      createdAt: CREATED,
      description: 'Describe the change',
      firstBaseOid: MAIN,
      id: 'request-a',
      latestHeadOid: HEAD,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: CREATED,
    };
    const repository = new MemoryRepository();
    const authority = new ProjectRequestAuthority({
      coordination,
      recovery: { recoverProject: () => Promise.resolve() },
      repository,
    });
    try {
      const detail = await authority.getRequest(
        createDevelopmentIngressPrincipal('actor-a'),
        { projectId: 'project-a', requestId: 'request-a' },
      );

      assert.deepEqual(detail, {
        comments: { comments: [] },
        currentMainOid: MAIN,
        request: coordination.collaboration.request,
        reviewCondition: 'clean',
        reviewedHeadOid: HEAD,
      });
      assert.equal(repository.inspections, 1);
    } finally {
      await authority.close();
    }
  });

  it('fails closed when Request SQL state changes during Git inspection', async () => {
    const coordination = new MemoryCoordination();
    coordination.collaboration.request = {
      commentCount: 0,
      createdAt: CREATED,
      description: 'Describe the change',
      firstBaseOid: MAIN,
      id: 'request-a',
      latestHeadOid: HEAD,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: CREATED,
    };
    const repository = new MemoryRepository();
    repository.onInspect = () => {
      const current = coordination.collaboration.request;
      assert.ok(current);
      coordination.collaboration.request = {
        ...current,
        revision: 2,
      };
    };
    const authority = new ProjectRequestAuthority({
      coordination,
      recovery: { recoverProject: () => Promise.resolve() },
      repository,
    });
    try {
      await assert.rejects(
        authority.getRequest(
          createDevelopmentIngressPrincipal('actor-a'),
          { projectId: 'project-a', requestId: 'request-a' },
        ),
        error => error instanceof CollabError && error.code === 'stale-request-head',
      );
    } finally {
      await authority.close();
    }
  });

  it('fails closed when the authoritative main changes during Git inspection', async () => {
    const coordination = new MemoryCoordination();
    coordination.collaboration.request = {
      commentCount: 0,
      createdAt: CREATED,
      description: 'Describe the change',
      firstBaseOid: MAIN,
      id: 'request-a',
      latestHeadOid: HEAD,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: CREATED,
    };
    const repository = new MemoryRepository();
    repository.onInspect = () => {
      coordination.expectedMainOid = 'c'.repeat(40);
    };
    const authority = new ProjectRequestAuthority({
      coordination,
      recovery: { recoverProject: () => Promise.resolve() },
      repository,
    });
    try {
      await assert.rejects(
        authority.getRequest(
          createDevelopmentIngressPrincipal('actor-a'),
          { projectId: 'project-a', requestId: 'request-a' },
        ),
        error => (
          error instanceof CollabError
          && error.code === 'authority-not-synchronized'
        ),
      );
    } finally {
      await authority.close();
    }
  });

  it('paginates Request comments with an opaque keyset cursor', async () => {
    const coordination = new MemoryCoordination();
    coordination.collaboration.request = {
      commentCount: 2,
      createdAt: CREATED,
      description: 'Describe the change',
      firstBaseOid: MAIN,
      id: 'request-a',
      latestHeadOid: HEAD,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: CREATED,
    };
    coordination.collaboration.comments.push(
      {
        authorMemberId: 'member-a',
        body: 'First',
        createdAt: '2026-08-23T01:00:00.000Z',
        id: 'comment-a',
        requestId: 'request-a',
      },
      {
        authorMemberId: 'member-a',
        body: 'Second',
        createdAt: '2026-08-23T02:00:00.000Z',
        id: 'comment-b',
        requestId: 'request-a',
      },
    );
    const authority = new ProjectRequestAuthority({
      coordination,
      recovery: { recoverProject: () => Promise.resolve() },
      repository: new MemoryRepository(),
    });
    try {
      const first = await authority.listRequestComments(
        createDevelopmentIngressPrincipal('actor-a'),
        { limit: 1, projectId: 'project-a', requestId: 'request-a' },
      );
      assert.equal(first.comments[0]?.id, 'comment-a');
      assert.ok(first.nextCursor);
      const second = await authority.listRequestComments(
        createDevelopmentIngressPrincipal('actor-a'),
        {
          cursor: first.nextCursor,
          limit: 1,
          projectId: 'project-a',
          requestId: 'request-a',
        },
      );
      assert.deepEqual(second.comments.map(comment => comment.id), ['comment-b']);
      assert.equal(second.nextCursor, undefined);
    } finally {
      await authority.close();
    }
  });

  it('creates one normalized comment and replays the exact durable response', async () => {
    const coordination = new MemoryCoordination();
    coordination.collaboration.request = {
      commentCount: 0,
      createdAt: CREATED,
      description: 'Describe the change',
      firstBaseOid: MAIN,
      id: 'request-a',
      latestHeadOid: HEAD,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: CREATED,
    };
    const authority = new ProjectRequestAuthority({
      coordination,
      createCommentId: () => 'comment-a',
      now: () => new Date('2026-08-23T01:00:00.000Z'),
      recovery: { recoverProject: () => Promise.resolve() },
      repository: new MemoryRepository(),
    });
    const input = {
      body: '  Comment\r\nbody  ',
      idempotencyKey: 'comment-idempotency-a',
      projectId: 'project-a',
      requestId: 'request-a',
    };
    try {
      const created = await authority.createComment(
        createDevelopmentIngressPrincipal('actor-a'),
        input,
      );
      const replayed = await authority.createComment(
        createDevelopmentIngressPrincipal('actor-a'),
        input,
      );

      assert.deepEqual(replayed, created);
      assert.equal(coordination.collaboration.comments.length, 1);
      assert.equal(created.comment.body, 'Comment\nbody');
      assert.equal(created.request.commentCount, 1);
      assert.deepEqual(
        coordination.collaboration.events.map(event => event.kind),
        ['request.comment-added'],
      );
    } finally {
      await authority.close();
    }
  });

  it('updates only the owner metadata at the expected head and revision', async () => {
    const coordination = new MemoryCoordination();
    coordination.collaboration.request = {
      commentCount: 0,
      createdAt: CREATED,
      description: 'Old description',
      firstBaseOid: MAIN,
      id: 'request-a',
      latestHeadOid: HEAD,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: CREATED,
    };
    const authority = new ProjectRequestAuthority({
      coordination,
      now: () => new Date('2026-08-23T02:00:00.000Z'),
      recovery: { recoverProject: () => Promise.resolve() },
      repository: new MemoryRepository(),
    });
    try {
      const response = await authority.updateMyRequestMetadata(
        createDevelopmentIngressPrincipal('actor-a'),
        {
          description: '\nNew description\n',
          expectedHeadOid: HEAD,
          expectedRequestRevision: 1,
          idempotencyKey: 'metadata-idempotency-a',
          projectId: 'project-a',
          requestId: 'request-a',
        },
      );

      assert.equal(response.request.description, 'New description');
      assert.equal(response.request.revision, 2);
      assert.deepEqual(
        coordination.collaboration.events.map(event => event.kind),
        ['request.updated'],
      );
    } finally {
      await authority.close();
    }
  });

  it('normalizes and atomically creates one idempotent Request after Git validation', async () => {
    const coordination = new MemoryCoordination();
    const repository = new MemoryRepository();
    const authority = new ProjectRequestAuthority({
      coordination,
      createRelationId: () => 'relation-a',
      createRequestId: () => 'request-a',
      now: () => new Date(CREATED),
      recovery: { recoverProject: () => Promise.resolve() },
      repository,
    });
    try {
      const response = await authority.ensureMyRequest(
        createDevelopmentIngressPrincipal('actor-a'),
        {
          description: '\r\nDescribe the change\r\n\r\n',
          expectedMainOid: MAIN,
          headOid: HEAD,
          idempotencyKey: 'idempotency-a',
          projectId: 'project-a',
        },
      );

      assert.deepEqual(response, {
        mainOid: MAIN,
        request: {
          commentCount: 0,
          createdAt: CREATED,
          description: 'Describe the change',
          firstBaseOid: MAIN,
          id: 'request-a',
          latestHeadOid: HEAD,
          memberId: 'member-a',
          revision: 1,
          status: 'open',
          ticketRelations: [],
          updatedAt: CREATED,
        },
      });
      assert.equal(repository.validations, 1);
      assert.equal(coordination.collaboration.idempotencyRows.size, 1);
      assert.deepEqual(
        coordination.collaboration.events.map(event => ({
          kind: event.kind,
          payload: event.payload,
        })),
        [{ kind: 'request.updated', payload: { requestId: 'request-a' } }],
      );
    } finally {
      await authority.close();
    }
  });

  it('rejects a changed idempotency fingerprint before repeating Git validation', async () => {
    const coordination = new MemoryCoordination();
    const repository = new MemoryRepository();
    const authority = new ProjectRequestAuthority({
      coordination,
      createRequestId: () => 'request-a',
      now: () => new Date(CREATED),
      recovery: { recoverProject: () => Promise.resolve() },
      repository,
    });
    const principal = createDevelopmentIngressPrincipal('actor-a');
    const first = {
      description: 'First description',
      expectedMainOid: MAIN,
      headOid: HEAD,
      idempotencyKey: 'idempotency-a',
      projectId: 'project-a',
    };
    try {
      await authority.ensureMyRequest(principal, first);
      await assert.rejects(
        authority.ensureMyRequest(principal, {
          ...first,
          description: 'Changed description',
        }),
        error => error instanceof CollabError && error.code === 'idempotency-conflict',
      );
      assert.equal(repository.validations, 1);
      assert.equal(coordination.collaboration.events.length, 1);
    } finally {
      await authority.close();
    }
  });
});
