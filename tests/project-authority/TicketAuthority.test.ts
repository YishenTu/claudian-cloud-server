import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CollabCloudProjectEvent,
  CollabProjectId,
  CollabTicketAcceptedRelation,
  CollabTicketComment,
  CollabTicketSummary,
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
  ProjectTicketAuthority,
  type ProjectTicketAuthorityCoordination,
} from '../../src/project-authority/tickets/ProjectTicketAuthority.js';
import { createDevelopmentPrincipal } from '../../src/request-context/RequestPrincipal.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

const CREATED = '2026-08-23T00:00:00.000Z';
const MAIN = 'a'.repeat(40);

class MemoryTickets {
  readonly events: CollabCloudProjectEvent[] = [];
  readonly idempotencyRows = new Map<string, {
    readonly fingerprint: string;
    readonly response: Readonly<Record<string, unknown>>;
  }>();
  readonly mentions: string[] = [];
  readonly acceptedRelations: CollabTicketAcceptedRelation[] = [];
  readonly bodies = new Map<string, string>();
  readonly comments: CollabTicketComment[] = [];
  readonly tickets: CollabTicketSummary[] = [];
  pendingResolve = false;

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
    tickets: {
      create: (input: {
        readonly authorMemberId: string;
        readonly body: string;
        readonly createdAt: string;
        readonly ticketId: string;
        readonly title: string;
      }) => {
        const ticket: CollabTicketSummary = {
          acceptedRelationCount: 0,
          authorMemberId: input.authorMemberId,
          commentCount: 0,
          createdAt: input.createdAt,
          id: input.ticketId,
          number: this.tickets.length + 1,
          revision: 1,
          status: 'open',
          title: input.title,
          updatedAt: input.createdAt,
        };
        this.tickets.push(ticket);
        this.bodies.set(ticket.id, input.body);
        return Promise.resolve(ticket);
      },
      createComment: (input: {
        readonly authorMemberId: string;
        readonly body: string;
        readonly commentId: string;
        readonly createdAt: string;
        readonly ticketId: string;
      }) => {
        const index = this.tickets.findIndex(ticket => ticket.id === input.ticketId);
        const current = this.tickets[index];
        assert.ok(current);
        const comment = {
          authorMemberId: input.authorMemberId,
          body: input.body,
          createdAt: input.createdAt,
          id: input.commentId,
          ticketId: input.ticketId,
        };
        const ticket = {
          ...current,
          commentCount: current.commentCount + 1,
          revision: current.revision + 1,
          updatedAt: input.createdAt,
        };
        this.comments.push(comment);
        this.tickets[index] = ticket;
        return Promise.resolve({ comment, ticket });
      },
      changeStatus: (input: {
        readonly actorMemberId: string;
        readonly expectedRevision: number;
        readonly status: 'closed' | 'open';
        readonly ticketId: string;
        readonly updatedAt: string;
      }) => {
        const index = this.tickets.findIndex(ticket => ticket.id === input.ticketId);
        const current = this.tickets[index];
        if (current === undefined || current.revision !== input.expectedRevision) {
          return Promise.resolve(undefined);
        }
        const ticket: CollabTicketSummary = input.status === 'closed'
          ? {
            ...current,
            closedAt: input.updatedAt,
            closedByMemberId: input.actorMemberId,
            revision: current.revision + 1,
            status: 'closed',
            updatedAt: input.updatedAt,
          }
          : {
            acceptedRelationCount: current.acceptedRelationCount,
            authorMemberId: current.authorMemberId,
            commentCount: current.commentCount,
            createdAt: current.createdAt,
            id: current.id,
            number: current.number,
            revision: current.revision + 1,
            status: 'open',
            title: current.title,
            updatedAt: input.updatedAt,
          };
        this.tickets[index] = ticket;
        return Promise.resolve(ticket);
      },
      find: (ticketId: string) => Promise.resolve(
        this.tickets.find(ticket => ticket.id === ticketId),
      ),
      findDetailBase: (ticketId: string) => {
        const ticket = this.tickets.find(candidate => candidate.id === ticketId);
        const body = this.bodies.get(ticketId);
        return Promise.resolve(
          ticket === undefined || body === undefined ? undefined : { body, ticket },
        );
      },
      hasPendingResolve: () => Promise.resolve(this.pendingResolve),
      list: (input: Readonly<{
        readonly after?: Readonly<{
          readonly ticketNumber: number;
          readonly updatedAt: string;
        }>;
        readonly limit: number;
        readonly status: 'all' | 'closed' | 'open';
      }>) => {
        const rows = this.tickets
          .filter(ticket => input.status === 'all' || ticket.status === input.status)
          .filter(ticket => input.after === undefined || (
            ticket.updatedAt < input.after.updatedAt
            || (
              ticket.updatedAt === input.after.updatedAt
              && ticket.number < input.after.ticketNumber
            )
          ))
          .sort((left, right) => (
            right.updatedAt.localeCompare(left.updatedAt)
            || right.number - left.number
          ));
        return Promise.resolve(rows.slice(0, input.limit));
      },
      listAcceptedRelations: (
        _ticketId: string,
        input: Readonly<{ readonly limit: number }>,
      ) => Promise.resolve({
        items: this.acceptedRelations.slice(0, input.limit),
        nextCursor: this.acceptedRelations.length > input.limit
          ? {
            createdAt: this.acceptedRelations[input.limit - 1]?.acceptedAt ?? CREATED,
            id: this.acceptedRelations[input.limit - 1]?.id ?? 'relation-cursor',
          }
          : undefined,
      }),
      listComments: (
        _ticketId: string,
        input: Readonly<{ readonly limit: number }>,
      ) => Promise.resolve({
        items: this.comments.slice(0, input.limit),
        nextCursor: this.comments.length > input.limit
          ? {
            createdAt: this.comments[input.limit - 1]?.createdAt ?? CREATED,
            id: this.comments[input.limit - 1]?.id ?? 'comment-cursor',
          }
          : undefined,
      }),
      replaceMentions: (input: { readonly mentionedMemberIds: readonly string[] }) => {
        this.mentions.splice(0, this.mentions.length, ...input.mentionedMemberIds);
        return Promise.resolve();
      },
      updateContent: (input: {
        readonly body: string;
        readonly expectedRevision: number;
        readonly ticketId: string;
        readonly title: string;
        readonly updatedAt: string;
      }) => {
        const index = this.tickets.findIndex(ticket => ticket.id === input.ticketId);
        const current = this.tickets[index];
        if (current === undefined || current.revision !== input.expectedRevision) {
          return Promise.resolve(undefined);
        }
        const ticket = {
          ...current,
          revision: current.revision + 1,
          title: input.title,
          updatedAt: input.updatedAt,
        };
        this.bodies.set(ticket.id, input.body);
        this.tickets[index] = ticket;
        return Promise.resolve(ticket);
      },
    },
  } as unknown as CollaborationProjectPersistence;
}

class MemoryCoordination implements ProjectTicketAuthorityCoordination {
  readonly state = new MemoryTickets();
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
      appendProjectEvent: (input: Parameters<ProjectScope['appendProjectEvent']>[0]) => {
        const event = {
          ...input,
          projectId: 'project-a',
          protocolVersion: 10 as const,
          sequence: this.state.events.length + 1,
        } as CollabCloudProjectEvent;
        this.state.events.push(event);
        return Promise.resolve(event);
      },
      collaboration: this.state.persistence,
      findDevelopmentActorMember: (principalId: string) => Promise.resolve(
        principalId === 'actor-a'
          ? 'member-a'
          : principalId === 'actor-b'
            ? 'member-b'
            : undefined,
      ),
      findPrincipalMember: (principalId: string) => Promise.resolve(
        principalId === 'actor-a'
          ? 'member-a'
          : principalId === 'actor-b'
            ? 'member-b'
            : undefined,
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
          : memberId === 'member-b'
            ? {
              displayName: 'Member B',
              memberId,
              revision: 1n,
              role: 'manager',
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
        expectedMainOid: MAIN,
        managerSetGeneration: 1,
        projectId: 'project-a',
        projectName: 'Project A',
        serviceState: 'active',
      }),
      getRepositoryPlacement: () => Promise.resolve(this.placement),
      listMemberships: () => Promise.resolve([
        {
          displayName: 'Member A',
          memberId: 'member-a',
          revision: 1n,
          role: 'member' as const,
          status: 'active' as const,
        },
        {
          displayName: 'Member B',
          memberId: 'member-b',
          revision: 1n,
          role: 'manager' as const,
          status: 'active' as const,
        },
      ]),
    } as unknown as ProjectScope & ProjectReadScope;
  }
}

function seedTicket(
  state: MemoryTickets,
  input: Readonly<{
    readonly authorMemberId?: string;
    readonly body?: string;
    readonly createdAt?: string;
    readonly id?: string;
    readonly number?: number;
    readonly title?: string;
  }> = {},
): CollabTicketSummary {
  const createdAt = input.createdAt ?? CREATED;
  const ticket = {
    acceptedRelationCount: 0,
    authorMemberId: input.authorMemberId ?? 'member-a',
    commentCount: 0,
    createdAt,
    id: input.id ?? 'ticket-a',
    number: input.number ?? 1,
    revision: 1,
    status: 'open' as const,
    title: input.title ?? 'Ticket A',
    updatedAt: createdAt,
  };
  state.tickets.push(ticket);
  state.bodies.set(ticket.id, input.body ?? 'Ticket body');
  return ticket;
}

describe('Project Ticket authority', () => {
  it('creates one normalized Ticket and records active-member mentions atomically', async () => {
    const coordination = new MemoryCoordination();
    const authority = new ProjectTicketAuthority({
      coordination,
      createTicketId: () => 'ticket-a',
      now: () => new Date(CREATED),
      recovery: { recoverProject: () => Promise.resolve() },
    });
    try {
      const response = await authority.createTicket(
        createDevelopmentPrincipal('actor-a'),
        {
          body: '\r\nHello @Member B\r\n\r\n',
          idempotencyKey: 'ticket-idempotency-a',
          projectId: 'project-a',
          title: '  First ticket  ',
        },
      );

      assert.equal(response.ticket.body, 'Hello @Member B');
      assert.equal(response.ticket.ticket.title, 'First ticket');
      assert.deepEqual(coordination.state.mentions, ['member-b']);
      assert.deepEqual(
        coordination.state.events.map(event => event.kind),
        ['ticket.updated'],
      );
    } finally {
      await authority.close();
    }
  });

  it('returns bounded Ticket detail and paginates the canonical Ticket order', async () => {
    const coordination = new MemoryCoordination();
    seedTicket(coordination.state);
    seedTicket(coordination.state, {
      createdAt: '2026-08-23T01:00:00.000Z',
      id: 'ticket-b',
      number: 2,
      title: 'Ticket B',
    });
    coordination.state.comments.push({
      authorMemberId: 'member-a',
      body: 'A comment',
      createdAt: '2026-08-23T02:00:00.000Z',
      id: 'comment-a',
      ticketId: 'ticket-a',
    });
    coordination.state.acceptedRelations.push({
      acceptedAt: '2026-08-23T03:00:00.000Z',
      acceptedMergeOid: 'b'.repeat(40),
      commitOid: 'c'.repeat(40),
      id: 'relation-a',
      kind: 'references',
      requestId: 'request-a',
    });
    const authority = new ProjectTicketAuthority({
      coordination,
      recovery: { recoverProject: () => Promise.resolve() },
    });
    const principal = createDevelopmentPrincipal('actor-a');
    try {
      const first = await authority.listTickets(principal, {
        limit: 1,
        projectId: 'project-a',
        status: 'all',
      });
      assert.equal(first.tickets[0]?.id, 'ticket-b');
      assert.ok(first.nextCursor);
      const second = await authority.listTickets(principal, {
        cursor: first.nextCursor,
        limit: 1,
        projectId: 'project-a',
        status: 'all',
      });
      assert.deepEqual(second.tickets.map(ticket => ticket.id), ['ticket-a']);

      const detail = await authority.getTicket(principal, {
        projectId: 'project-a',
        ticketId: 'ticket-a',
      });
      assert.equal(detail.body, 'Ticket body');
      assert.deepEqual(detail.comments.comments.map(comment => comment.id), ['comment-a']);
      assert.deepEqual(
        detail.acceptedRelations.acceptedRelations.map(relation => relation.id),
        ['relation-a'],
      );
      const comments = await authority.listTicketComments(principal, {
        projectId: 'project-a',
        ticketId: 'ticket-a',
      });
      const relations = await authority.listTicketAcceptedRelations(principal, {
        projectId: 'project-a',
        ticketId: 'ticket-a',
      });
      assert.deepEqual(comments.comments.map(comment => comment.id), ['comment-a']);
      assert.deepEqual(
        relations.acceptedRelations.map(relation => relation.id),
        ['relation-a'],
      );
    } finally {
      await authority.close();
    }
  });

  it('allows a Manager to update content and refreshes description mentions', async () => {
    const coordination = new MemoryCoordination();
    seedTicket(coordination.state);
    const authority = new ProjectTicketAuthority({
      coordination,
      now: () => new Date('2026-08-23T01:00:00.000Z'),
      recovery: { recoverProject: () => Promise.resolve() },
    });
    try {
      const response = await authority.updateTicketContent(
        createDevelopmentPrincipal('actor-b'),
        {
          body: '\nUpdated for @Member A\n',
          expectedRevision: 1,
          idempotencyKey: 'update-ticket-a',
          projectId: 'project-a',
          ticketId: 'ticket-a',
          title: ' Updated title ',
        },
      );

      assert.equal(response.ticket.revision, 2);
      assert.equal(response.ticket.title, 'Updated title');
      assert.deepEqual(coordination.state.mentions, ['member-a']);
      assert.deepEqual(coordination.state.events.map(event => event.kind), [
        'ticket.updated',
      ]);
    } finally {
      await authority.close();
    }
  });

  it('creates and exactly replays one Ticket comment with mention state', async () => {
    const coordination = new MemoryCoordination();
    seedTicket(coordination.state);
    const authority = new ProjectTicketAuthority({
      coordination,
      createTicketCommentId: () => 'comment-a',
      now: () => new Date('2026-08-23T01:00:00.000Z'),
      recovery: { recoverProject: () => Promise.resolve() },
    });
    const input = {
      body: '\r\nQuestion for @Member B\r\n',
      idempotencyKey: 'comment-ticket-a',
      projectId: 'project-a',
      ticketId: 'ticket-a',
    };
    const principal = createDevelopmentPrincipal('actor-a');
    try {
      const created = await authority.createTicketComment(principal, input);
      const replayed = await authority.createTicketComment(principal, input);

      assert.deepEqual(replayed, created);
      assert.equal(created.ticket.revision, 2);
      assert.equal(coordination.state.comments.length, 1);
      assert.deepEqual(coordination.state.mentions, ['member-b']);
      assert.deepEqual(coordination.state.events.map(event => event.kind), [
        'ticket.comment-added',
      ]);
    } finally {
      await authority.close();
    }
  });

  it('enforces exact revisions and pending-resolve safety across close and reopen', async () => {
    const coordination = new MemoryCoordination();
    seedTicket(coordination.state);
    const authority = new ProjectTicketAuthority({
      coordination,
      now: () => new Date('2026-08-23T01:00:00.000Z'),
      recovery: { recoverProject: () => Promise.resolve() },
    });
    try {
      const closed = await authority.closeTicket(
        createDevelopmentPrincipal('actor-a'),
        {
          expectedRevision: 1,
          idempotencyKey: 'close-ticket-a',
          projectId: 'project-a',
          ticketId: 'ticket-a',
        },
      );
      assert.equal(closed.ticket.status, 'closed');
      assert.equal(closed.ticket.revision, 2);

      coordination.state.pendingResolve = true;
      await assert.rejects(
        authority.reopenTicket(
          createDevelopmentPrincipal('actor-b'),
          {
            expectedRevision: 2,
            idempotencyKey: 'reopen-ticket-a',
            projectId: 'project-a',
            ticketId: 'ticket-a',
          },
        ),
        error => error instanceof CollabError && error.code === 'stale-ticket',
      );
      coordination.state.pendingResolve = false;
      const reopened = await authority.reopenTicket(
        createDevelopmentPrincipal('actor-b'),
        {
          expectedRevision: 2,
          idempotencyKey: 'reopen-ticket-a',
          projectId: 'project-a',
          ticketId: 'ticket-a',
        },
      );
      assert.equal(reopened.ticket.status, 'open');
      assert.equal(reopened.ticket.revision, 3);
    } finally {
      await authority.close();
    }
  });

  it('denies a non-Manager who does not own the Ticket without partial state', async () => {
    const coordination = new MemoryCoordination();
    seedTicket(coordination.state, { authorMemberId: 'member-b' });
    const authority = new ProjectTicketAuthority({
      coordination,
      recovery: { recoverProject: () => Promise.resolve() },
    });
    try {
      await assert.rejects(
        authority.updateTicketContent(
          createDevelopmentPrincipal('actor-a'),
          {
            body: 'Changed body',
            expectedRevision: 1,
            idempotencyKey: 'update-ticket-a',
            projectId: 'project-a',
            ticketId: 'ticket-a',
            title: 'Changed title',
          },
        ),
        error => error instanceof CollabError && error.code === 'authorization-denied',
      );
      assert.equal(coordination.state.tickets[0]?.revision, 1);
      assert.equal(coordination.state.idempotencyRows.size, 0);
      assert.equal(coordination.state.events.length, 0);
    } finally {
      await authority.close();
    }
  });

  it('rejects a changed create fingerprint without duplicate state or event', async () => {
    const coordination = new MemoryCoordination();
    const authority = new ProjectTicketAuthority({
      coordination,
      createTicketId: () => 'ticket-a',
      now: () => new Date(CREATED),
      recovery: { recoverProject: () => Promise.resolve() },
    });
    const principal = createDevelopmentPrincipal('actor-a');
    const input = {
      body: 'Ticket body',
      idempotencyKey: 'ticket-idempotency-a',
      projectId: 'project-a',
      title: 'Ticket title',
    };
    try {
      await authority.createTicket(principal, input);
      await assert.rejects(
        authority.createTicket(principal, { ...input, title: 'Changed title' }),
        error => error instanceof CollabError && error.code === 'idempotency-conflict',
      );
      assert.equal(coordination.state.tickets.length, 1);
      assert.equal(coordination.state.events.length, 1);
    } finally {
      await authority.close();
    }
  });
});
