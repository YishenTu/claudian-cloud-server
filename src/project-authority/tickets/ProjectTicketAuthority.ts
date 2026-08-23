import { createHash, randomUUID } from 'node:crypto';

import {
  COLLAB_LIMITS,
  CollabError,
  collabControlOperationCodec,
  parseCollabMemberMentions,
  type ChangeTicketStatusRequest,
  type CollabRequestTicketOperation,
  type CollabTicketAcceptedRelation,
  type CollabTicketAcceptedRelationPage,
  type CollabTicketComment,
  type CollabTicketCommentPage,
  type CollabTicketDetail,
  type CollabTicketPage,
  type CollabTicketStatus,
  type CollabTicketSummary,
  type CreateTicketCommentRequest,
  type CreateTicketCommentResponse,
  type CreateTicketRequest,
  type CreateTicketResponse,
  type GetTicketRequest,
  type ListTicketAcceptedRelationsRequest,
  type ListTicketCommentsRequest,
  type ListTicketsRequest,
  type TicketMutationResponse,
  type UpdateTicketContentRequest,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../coordination/CoordinationError.js';
import type { ProjectScope } from '../../coordination/ProjectCoordination.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import {
  ProjectCollaborationReadAdmission,
  ProjectCollaborationReadAdmissionError,
} from '../admission/ProjectCollaborationReadAdmission.js';
import {
  ProjectWriteAdmission,
  ProjectWriteAdmissionError,
  type ProjectRecoveryPort,
  type ProjectWriteAdmissionCoordination,
} from '../admission/ProjectWriteAdmission.js';
import {
  boundProjectAuthorityPage,
  decodeProjectAuthorityCursor,
  decodeProjectAuthorityTicketCursor,
  encodeProjectAuthorityTicketCursor,
  projectAuthorityDetailPageBudgets,
} from '../ProjectAuthorityPage.js';

export type ProjectTicketAuthorityCoordination = ProjectWriteAdmissionCoordination;

export interface ProjectTicketAuthorityOptions {
  readonly coordination: ProjectTicketAuthorityCoordination;
  readonly createTicketCommentId?: () => string;
  readonly createTicketId?: () => string;
  readonly now?: () => Date;
  readonly recovery: ProjectRecoveryPort;
}

interface TicketActor {
  readonly memberId: string;
  readonly role: 'manager' | 'member';
}

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

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (
    normalized.length === 0
    || normalized.length > COLLAB_LIMITS.maxTicketTitleUtf16
  ) {
    throw domainError('protocol-payload-invalid', 'ticket-title-invalid');
  }
  return normalized;
}

function normalizeMarkdown(value: string, maximumBytes: number, field: string): string {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n');
  while (lines[0]?.trim().length === 0) lines.shift();
  while (lines.at(-1)?.trim().length === 0) lines.pop();
  const normalized = lines.join('\n');
  if (normalized.trim().length === 0) {
    throw domainError('protocol-payload-invalid', `${field}-blank`);
  }
  if (Buffer.byteLength(normalized, 'utf8') > maximumBytes) {
    throw domainError('quota-exceeded', `${field}-too-large`);
  }
  return normalized;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function responseRecord(value: object): Readonly<Record<string, unknown>> {
  return value as unknown as Readonly<Record<string, unknown>>;
}

function decodeCreateResponse(value: unknown): CreateTicketResponse {
  try {
    return collabControlOperationCodec('createTicket').decodeResponse(value);
  } catch {
    throw domainError('authority-integrity-error', 'ticket-create-replay-invalid');
  }
}

function decodeCommentResponse(value: unknown): CreateTicketCommentResponse {
  try {
    return collabControlOperationCodec('createTicketComment').decodeResponse(value);
  } catch {
    throw domainError('authority-integrity-error', 'ticket-comment-replay-invalid');
  }
}

function decodeMutationResponse(value: unknown): TicketMutationResponse {
  try {
    return collabControlOperationCodec('updateTicketContent').decodeResponse(value);
  } catch {
    throw domainError('authority-integrity-error', 'ticket-mutation-replay-invalid');
  }
}

function decodeStatusResponse(
  operation: 'closeTicket' | 'reopenTicket',
  value: unknown,
): TicketMutationResponse {
  try {
    return collabControlOperationCodec(operation).decodeResponse(value);
  } catch {
    throw domainError('authority-integrity-error', 'ticket-status-replay-invalid');
  }
}

function decodeDetail(value: unknown): CollabTicketDetail {
  try {
    return collabControlOperationCodec('getTicket').decodeResponse(value);
  } catch {
    throw domainError('authority-integrity-error', 'ticket-detail-invalid');
  }
}

function mapInfrastructureError(error: unknown): never {
  if (error instanceof CollabError) throw error;
  if (
    error instanceof ProjectCollaborationReadAdmissionError
    || error instanceof ProjectWriteAdmissionError
  ) {
    if (error.code === 'authorization-denied') {
      throw domainError('authorization-denied', 'ticket-member-not-authorized');
    }
    if (error.code === 'recovery-required' || error.code === 'state-conflict') {
      throw domainError('authority-not-synchronized', 'ticket-authority-stale', true);
    }
    throw domainError('operation-failed', 'ticket-authority-unavailable', true);
  }
  if (error instanceof CoordinationError) {
    if (error.code === 'invalid-record') {
      throw domainError('authority-integrity-error', 'ticket-persistence-invalid');
    }
    throw domainError('operation-failed', 'ticket-persistence-unavailable', true);
  }
  throw domainError('operation-failed', 'ticket-operation-failed', true);
}

function commentPage(
  comments: readonly CollabTicketComment[],
  persistenceHasMore: boolean,
  limit: number,
  maximumUtf8Bytes: number,
): CollabTicketCommentPage {
  const bounded = boundProjectAuthorityPage(comments.slice(0, limit), {
    hasMore: comments.length > limit || persistenceHasMore,
    itemField: 'comments',
    key: comment => ({ createdAt: comment.createdAt, id: comment.id }),
    maximumUtf8Bytes,
  });
  return Object.freeze({
    comments: bounded.items,
    ...(bounded.nextCursor === undefined ? {} : { nextCursor: bounded.nextCursor }),
  });
}

function relationPage(
  relations: readonly CollabTicketAcceptedRelation[],
  persistenceHasMore: boolean,
  limit: number,
  maximumUtf8Bytes: number,
): CollabTicketAcceptedRelationPage {
  const bounded = boundProjectAuthorityPage(relations.slice(0, limit), {
    hasMore: relations.length > limit || persistenceHasMore,
    itemField: 'acceptedRelations',
    key: relation => ({ createdAt: relation.acceptedAt, id: relation.id }),
    maximumUtf8Bytes,
  });
  return Object.freeze({
    acceptedRelations: bounded.items,
    ...(bounded.nextCursor === undefined ? {} : { nextCursor: bounded.nextCursor }),
  });
}

function emptyDetail(body: string, ticket: CollabTicketSummary): CollabTicketDetail {
  return Object.freeze({
    acceptedRelations: Object.freeze({ acceptedRelations: Object.freeze([]) }),
    body,
    comments: Object.freeze({ comments: Object.freeze([]) }),
    ticket,
  });
}

export class ProjectTicketAuthority {
  readonly #admission: ProjectWriteAdmission;
  readonly #createTicketCommentId: () => string;
  readonly #createTicketId: () => string;
  readonly #now: () => Date;
  readonly #readAdmission: ProjectCollaborationReadAdmission;

  constructor(options: ProjectTicketAuthorityOptions) {
    this.#admission = new ProjectWriteAdmission({
      coordination: options.coordination,
      recovery: options.recovery,
    });
    this.#createTicketCommentId = options.createTicketCommentId ?? randomUUID;
    this.#createTicketId = options.createTicketId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#readAdmission = new ProjectCollaborationReadAdmission(options.coordination);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.#admission.close(),
      this.#readAdmission.close(),
    ]);
  }

  async listTickets(
    principal: IngressPrincipal,
    request: ListTicketsRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabTicketPage> {
    try {
      const limit = request.limit ?? COLLAB_LIMITS.defaultTicketPageSize;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > COLLAB_LIMITS.maxTicketPageSize
      ) {
        throw domainError('protocol-payload-invalid', 'ticket-list-limit-invalid');
      }
      const after = decodeProjectAuthorityTicketCursor(request.cursor);
      return await this.#readAdmission.run(
        principal,
        request.projectId,
        read => read.transact(async scope => {
          const rows = await scope.collaboration.tickets.list({
            ...(after === undefined ? {} : { after }),
            limit: limit + 1,
            status: request.status,
          });
          const bounded = boundProjectAuthorityPage(rows.slice(0, limit), {
            encodeKey: key => encodeProjectAuthorityTicketCursor({
              ticketNumber: Number(key.id),
              updatedAt: key.createdAt,
            }),
            hasMore: rows.length > limit,
            itemField: 'tickets',
            key: ticket => ({
              createdAt: ticket.updatedAt,
              id: String(ticket.number),
            }),
            maximumUtf8Bytes: COLLAB_LIMITS.ticketPageMaxUtf8Bytes,
          });
          return Object.freeze({
            tickets: bounded.items,
            ...(bounded.nextCursor === undefined
              ? {}
              : { nextCursor: bounded.nextCursor }),
          });
        }),
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async getTicket(
    principal: IngressPrincipal,
    request: GetTicketRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabTicketDetail> {
    try {
      return await this.#readAdmission.run(
        principal,
        request.projectId,
        read => read.transact(async scope => {
          const base = await scope.collaboration.tickets.findDetailBase(request.ticketId);
          if (base === undefined) {
            throw domainError('ticket-not-found', 'ticket-detail-missing');
          }
          const budgets = projectAuthorityDetailPageBudgets(
            Buffer.byteLength(JSON.stringify(base), 'utf8'),
            true,
          );
          const comments = await scope.collaboration.tickets.listComments(
            request.ticketId,
            { limit: COLLAB_LIMITS.defaultCommentPageSize + 1 },
          );
          const relations = await scope.collaboration.tickets.listAcceptedRelations(
            request.ticketId,
            { limit: COLLAB_LIMITS.maxRelationsPerPage + 1 },
          );
          return decodeDetail({
            acceptedRelations: relationPage(
              relations.items,
              relations.nextCursor !== undefined,
              COLLAB_LIMITS.maxRelationsPerPage,
              budgets.relationsMaximumUtf8Bytes,
            ),
            body: base.body,
            comments: commentPage(
              comments.items,
              comments.nextCursor !== undefined,
              COLLAB_LIMITS.defaultCommentPageSize,
              budgets.commentsMaximumUtf8Bytes,
            ),
            ticket: base.ticket,
          });
        }),
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async listTicketComments(
    principal: IngressPrincipal,
    request: ListTicketCommentsRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabTicketCommentPage> {
    try {
      const limit = request.limit ?? COLLAB_LIMITS.defaultCommentPageSize;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > COLLAB_LIMITS.maxCommentPageSize
      ) {
        throw domainError('protocol-payload-invalid', 'ticket-comment-limit-invalid');
      }
      const after = decodeProjectAuthorityCursor(
        request.cursor,
        'ticket-comment-cursor-invalid',
      );
      return await this.#readAdmission.run(
        principal,
        request.projectId,
        read => read.transact(async scope => {
          if (await scope.collaboration.tickets.find(request.ticketId) === undefined) {
            throw domainError('ticket-not-found', 'ticket-detail-missing');
          }
          const page = await scope.collaboration.tickets.listComments(
            request.ticketId,
            { ...(after === undefined ? {} : { after }), limit: limit + 1 },
          );
          return commentPage(
            page.items,
            page.nextCursor !== undefined,
            limit,
            COLLAB_LIMITS.commentPageMaxUtf8Bytes,
          );
        }),
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async listTicketAcceptedRelations(
    principal: IngressPrincipal,
    request: ListTicketAcceptedRelationsRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabTicketAcceptedRelationPage> {
    try {
      const limit = request.limit ?? COLLAB_LIMITS.maxRelationsPerPage;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > COLLAB_LIMITS.maxRelationsPerPage
      ) {
        throw domainError('protocol-payload-invalid', 'ticket-relation-limit-invalid');
      }
      const after = decodeProjectAuthorityCursor(
        request.cursor,
        'ticket-relation-cursor-invalid',
      );
      return await this.#readAdmission.run(
        principal,
        request.projectId,
        read => read.transact(async scope => {
          if (await scope.collaboration.tickets.find(request.ticketId) === undefined) {
            throw domainError('ticket-not-found', 'ticket-detail-missing');
          }
          const page = await scope.collaboration.tickets.listAcceptedRelations(
            request.ticketId,
            { ...(after === undefined ? {} : { after }), limit: limit + 1 },
          );
          return relationPage(
            page.items,
            page.nextCursor !== undefined,
            limit,
            COLLAB_LIMITS.relationPageMaxUtf8Bytes,
          );
        }),
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async createTicket(
    principal: IngressPrincipal,
    request: CreateTicketRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CreateTicketResponse> {
    try {
      const title = normalizeTitle(request.title);
      const body = normalizeMarkdown(
        request.body,
        COLLAB_LIMITS.maxTicketBodyBytes,
        'ticket-body',
      );
      return await this.#mutateIdempotently(
        principal,
        request.projectId,
        'createTicket',
        request.idempotencyKey,
        fingerprint({ body, title }),
        decodeCreateResponse,
        async (scope, actor, createdAt) => {
          const ticket = await scope.collaboration.tickets.create({
            authorMemberId: actor.memberId,
            body,
            createdAt,
            ticketId: this.#createTicketId(),
            title,
          });
          await this.#replaceMentions(scope, {
            body,
            createdAt,
            sourceId: ticket.id,
            sourceKind: 'description',
            ticketId: ticket.id,
          });
          await scope.appendProjectEvent({
            kind: 'ticket.updated',
            occurredAt: createdAt,
            payload: { ticketId: ticket.id },
          });
          return { ticket: emptyDetail(body, ticket) };
        },
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async updateTicketContent(
    principal: IngressPrincipal,
    request: UpdateTicketContentRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<TicketMutationResponse> {
    try {
      const title = normalizeTitle(request.title);
      const body = normalizeMarkdown(
        request.body,
        COLLAB_LIMITS.maxTicketBodyBytes,
        'ticket-body',
      );
      return await this.#mutateIdempotently(
        principal,
        request.projectId,
        'updateTicketContent',
        request.idempotencyKey,
        fingerprint({
          action: 'content',
          body,
          expectedRevision: request.expectedRevision,
          ticketId: request.ticketId,
          title,
        }),
        decodeMutationResponse,
        async (scope, actor, updatedAt) => {
          const current = await scope.collaboration.tickets.findDetailBase(request.ticketId);
          if (current === undefined) {
            throw domainError('ticket-not-found', 'ticket-detail-missing');
          }
          if (
            actor.role !== 'manager'
            && current.ticket.authorMemberId !== actor.memberId
          ) {
            throw domainError('authorization-denied', 'ticket-edit-denied');
          }
          this.#requireRevision(current.ticket, request.expectedRevision);
          if (current.ticket.title === title && current.body === body) {
            return { ticket: current.ticket };
          }
          const ticket = await scope.collaboration.tickets.updateContent({
            body,
            expectedRevision: request.expectedRevision,
            ticketId: request.ticketId,
            title,
            updatedAt,
          });
          if (ticket === undefined || ticket.revision !== request.expectedRevision + 1) {
            throw domainError('stale-ticket', 'ticket-content-cas-failed', true);
          }
          await this.#replaceMentions(scope, {
            body,
            createdAt: updatedAt,
            sourceId: ticket.id,
            sourceKind: 'description',
            ticketId: ticket.id,
          });
          await scope.appendProjectEvent({
            kind: 'ticket.updated',
            occurredAt: updatedAt,
            payload: { ticketId: ticket.id },
          });
          return { ticket };
        },
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async createTicketComment(
    principal: IngressPrincipal,
    request: CreateTicketCommentRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CreateTicketCommentResponse> {
    try {
      const body = normalizeMarkdown(
        request.body,
        COLLAB_LIMITS.maxTicketCommentBytes,
        'ticket-comment',
      );
      return await this.#mutateIdempotently(
        principal,
        request.projectId,
        'createTicketComment',
        request.idempotencyKey,
        fingerprint({ body, ticketId: request.ticketId }),
        decodeCommentResponse,
        async (scope, actor, createdAt) => {
          const current = await scope.collaboration.tickets.find(request.ticketId);
          if (current === undefined) {
            throw domainError('ticket-not-found', 'ticket-detail-missing');
          }
          if (current.commentCount >= COLLAB_LIMITS.maxTicketComments) {
            throw domainError('quota-exceeded', 'ticket-comment-count-limit');
          }
          const response = await scope.collaboration.tickets.createComment({
            authorMemberId: actor.memberId,
            body,
            commentId: this.#createTicketCommentId(),
            createdAt,
            ticketId: request.ticketId,
          });
          await this.#replaceMentions(scope, {
            body,
            createdAt,
            sourceId: response.comment.id,
            sourceKind: 'comment',
            ticketId: request.ticketId,
          });
          await scope.appendProjectEvent({
            kind: 'ticket.comment-added',
            occurredAt: createdAt,
            payload: { ticketId: request.ticketId },
          });
          return response;
        },
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  closeTicket(
    principal: IngressPrincipal,
    request: ChangeTicketStatusRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<TicketMutationResponse> {
    return this.#changeStatus(principal, request, 'closed', 'closeTicket', options);
  }

  reopenTicket(
    principal: IngressPrincipal,
    request: ChangeTicketStatusRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<TicketMutationResponse> {
    return this.#changeStatus(principal, request, 'open', 'reopenTicket', options);
  }

  async #changeStatus(
    principal: IngressPrincipal,
    request: ChangeTicketStatusRequest,
    status: CollabTicketStatus,
    operation: 'closeTicket' | 'reopenTicket',
    options: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<TicketMutationResponse> {
    try {
      return await this.#mutateIdempotently(
        principal,
        request.projectId,
        operation,
        request.idempotencyKey,
        fingerprint({
          expectedRevision: request.expectedRevision,
          status,
          ticketId: request.ticketId,
        }),
        value => decodeStatusResponse(operation, value),
        async (scope, actor, updatedAt) => {
          const current = await scope.collaboration.tickets.find(request.ticketId);
          if (current === undefined) {
            throw domainError('ticket-not-found', 'ticket-detail-missing');
          }
          this.#requireRevision(current, request.expectedRevision);
          if (
            actor.role !== 'manager'
            && current.authorMemberId !== actor.memberId
          ) {
            throw domainError('authorization-denied', 'ticket-status-denied');
          }
          if (current.status === status) return { ticket: current };
          if (
            status === 'open'
            && await scope.collaboration.tickets.hasPendingResolve(current.id)
          ) {
            throw domainError('stale-ticket', 'ticket-pending-resolve-reopen', true);
          }
          const ticket = await scope.collaboration.tickets.changeStatus({
            actorMemberId: actor.memberId,
            expectedRevision: request.expectedRevision,
            status,
            ticketId: request.ticketId,
            updatedAt,
          });
          if (ticket === undefined || ticket.revision !== request.expectedRevision + 1) {
            throw domainError('stale-ticket', 'ticket-status-cas-failed', true);
          }
          await scope.appendProjectEvent({
            kind: 'ticket.updated',
            occurredAt: updatedAt,
            payload: { ticketId: ticket.id },
          });
          return { ticket };
        },
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async #mutateIdempotently<Response extends object>(
    principal: IngressPrincipal,
    projectId: string,
    operation: CollabRequestTicketOperation,
    idempotencyKey: string,
    requestFingerprint: string,
    decode: (value: unknown) => Response,
    mutation: (
      scope: ProjectScope,
      actor: TicketActor,
      occurredAt: string,
    ) => Promise<Response>,
    options: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<Response> {
    return this.#admission.run(
      principal,
      projectId,
      async write => {
        const identity = {
          idempotencyKey,
          memberId: write.memberId,
          operation,
          requestFingerprint,
        };
        const replay = await write.transact(scope => (
          scope.collaboration.idempotency.find(identity)
        ));
        if (replay.kind === 'conflict') {
          throw domainError('idempotency-conflict', 'ticket-idempotency-key-reused');
        }
        if (replay.kind === 'replay') return decode(replay.response);
        return write.transact(async scope => {
          const concurrent = await scope.collaboration.idempotency.find(identity);
          if (concurrent.kind === 'conflict') {
            throw domainError('idempotency-conflict', 'ticket-idempotency-key-reused');
          }
          if (concurrent.kind === 'replay') return decode(concurrent.response);
          const occurredAt = this.#now().toISOString();
          const response = await mutation(scope, {
            memberId: write.memberId,
            role: write.role,
          }, occurredAt);
          const stored = await scope.collaboration.idempotency.store({
            ...identity,
            createdAt: occurredAt,
            response: responseRecord(response),
          });
          if (stored.kind === 'conflict') {
            throw domainError('idempotency-conflict', 'ticket-idempotency-key-reused');
          }
          return stored.kind === 'replay' ? decode(stored.response) : response;
        });
      },
      options,
    );
  }

  async #replaceMentions(
    scope: ProjectScope,
    input: Readonly<{
      readonly body: string;
      readonly createdAt: string;
      readonly sourceId: string;
      readonly sourceKind: 'comment' | 'description';
      readonly ticketId: string;
    }>,
  ): Promise<void> {
    const memberships = await scope.listMemberships();
    const mentionedMemberIds = parseCollabMemberMentions(
      input.body,
      memberships
        .filter(membership => membership.status === 'active')
        .map(membership => ({
          displayName: membership.displayName,
          memberId: membership.memberId,
        })),
    );
    await scope.collaboration.tickets.replaceMentions({
      createdAt: input.createdAt,
      mentionedMemberIds,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      ticketId: input.ticketId,
    });
  }

  #requireRevision(ticket: CollabTicketSummary, expectedRevision: number): void {
    if (ticket.revision !== expectedRevision) {
      throw domainError('stale-ticket', 'ticket-revision-changed', true);
    }
  }
}
