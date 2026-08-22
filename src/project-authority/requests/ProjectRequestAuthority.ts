import { createHash, randomUUID } from 'node:crypto';

import {
  COLLAB_LIMITS,
  CollabError,
  collabControlOperationCodec,
  collabMemberRef,
  parseCollabTicketReferences,
  type CollabCommentPage,
  type CollabGitOid,
  type CollabMemberId,
  type CollabProjectId,
  type CollabRequestDetail,
  type CollabReviewCondition,
  type CreateCommentRequest,
  type CreateCommentResponse,
  type EnsureMyRequestRequest,
  type EnsureMyRequestResponse,
  type GetRequestRequest,
  type ListRequestCommentsRequest,
  type UpdateMyRequestMetadataRequest,
  type UpdateMyRequestMetadataResponse,
} from '@claudian/collab-protocol';

import { CoordinationError } from '../../coordination/CoordinationError.js';
import type { ProjectScope } from '../../coordination/ProjectCoordination.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';
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
  projectAuthorityCommentDetailBudget,
} from '../ProjectAuthorityPage.js';

export type ProjectRequestAuthorityCoordination = ProjectWriteAdmissionCoordination;

export interface ProjectRequestInspection {
  readonly currentMainOid: CollabGitOid;
  readonly reviewCondition: CollabReviewCondition;
  readonly reviewedHeadOid: CollabGitOid;
}

export interface ProjectRequestInspectionInput {
  readonly expectedMainOid: CollabGitOid;
  readonly firstBaseOid: CollabGitOid;
  readonly latestHeadOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly placement: RepositoryPlacementLease;
  readonly projectId: CollabProjectId;
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal: AbortSignal;
}

export interface ProjectRequestHeadValidationInput {
  readonly expectedMainOid: CollabGitOid;
  readonly headOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly placement: RepositoryPlacementLease;
  readonly projectId: CollabProjectId;
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal: AbortSignal;
}

export interface ProjectRequestRepository {
  inspectRequest(input: ProjectRequestInspectionInput): Promise<ProjectRequestInspection>;
  validateRequestHead(input: ProjectRequestHeadValidationInput): Promise<void>;
}

export interface ProjectRequestAuthorityOptions {
  readonly coordination: ProjectRequestAuthorityCoordination;
  readonly createCommentId?: () => string;
  readonly createRelationId?: () => string;
  readonly createRequestId?: () => string;
  readonly now?: () => Date;
  readonly recovery: ProjectRecoveryPort;
  readonly repository: ProjectRequestRepository;
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

function normalizeDescription(description: string): string {
  const lines = description.replace(/\r\n?/gu, '\n').split('\n');
  while (lines[0]?.trim().length === 0) lines.shift();
  while (lines.at(-1)?.trim().length === 0) lines.pop();
  const normalized = lines.join('\n');
  if (normalized.trim().length === 0) {
    throw domainError('description-required', 'request-description-empty');
  }
  if (Buffer.byteLength(normalized, 'utf8') > COLLAB_LIMITS.maxRequestDescriptionBytes) {
    throw domainError('quota-exceeded', 'request-description-limit');
  }
  return normalized;
}

function normalizeCommentBody(body: string): string {
  const normalized = body.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  let containsForbiddenControl = false;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || codePoint === 127
    ) {
      containsForbiddenControl = true;
      break;
    }
  }
  if (
    normalized.length === 0
    || Buffer.byteLength(normalized, 'utf8') > COLLAB_LIMITS.maxCommentBytes
    || containsForbiddenControl
  ) {
    throw domainError('protocol-payload-invalid', 'request-comment-body-invalid');
  }
  return normalized;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function decodeEnsureResponse(value: unknown): EnsureMyRequestResponse {
  try {
    return collabControlOperationCodec('ensureMyRequest').decodeResponse(value);
  } catch {
    throw domainError(
      'authority-integrity-error',
      'request-idempotency-response-invalid',
    );
  }
}

function decodeRequestDetail(value: unknown): CollabRequestDetail {
  try {
    return collabControlOperationCodec('getRequest').decodeResponse(value);
  } catch {
    throw domainError('authority-integrity-error', 'request-detail-invalid');
  }
}

function decodeCommentResponse(value: unknown): CreateCommentResponse {
  try {
    return collabControlOperationCodec('createComment').decodeResponse(value);
  } catch {
    throw domainError(
      'authority-integrity-error',
      'request-comment-idempotency-response-invalid',
    );
  }
}

function decodeMetadataResponse(value: unknown): UpdateMyRequestMetadataResponse {
  try {
    return collabControlOperationCodec('updateMyRequestMetadata').decodeResponse(value);
  } catch {
    throw domainError(
      'authority-integrity-error',
      'request-metadata-idempotency-response-invalid',
    );
  }
}

function mapInfrastructureError(error: unknown): never {
  if (error instanceof CollabError) throw error;
  if (error instanceof ProjectCollaborationReadAdmissionError) {
    if (error.code === 'authorization-denied') {
      throw domainError('authorization-denied', 'request-member-not-authorized');
    }
    if (error.code === 'recovery-required' || error.code === 'state-conflict') {
      throw domainError('authority-not-synchronized', 'request-authority-stale', true);
    }
    throw domainError('operation-failed', 'request-authority-unavailable', true);
  }
  if (error instanceof ProjectWriteAdmissionError) {
    if (error.code === 'authorization-denied') {
      throw domainError('authorization-denied', 'request-member-not-authorized');
    }
    if (error.code === 'recovery-required' || error.code === 'state-conflict') {
      throw domainError('authority-not-synchronized', 'request-authority-stale', true);
    }
    throw domainError('operation-failed', 'request-authority-unavailable', true);
  }
  if (error instanceof CoordinationError) {
    if (error.code === 'state-conflict') {
      throw domainError('authority-not-synchronized', 'request-state-conflict', true);
    }
    if (error.code === 'invalid-record') {
      throw domainError('authority-integrity-error', 'request-persistence-invalid');
    }
    throw domainError('operation-failed', 'request-persistence-unavailable', true);
  }
  throw domainError('operation-failed', 'request-operation-failed', true);
}

function commentPage(
  comments: readonly Readonly<{
    readonly createdAt: string;
    readonly id: string;
  }>[],
  persistenceHasMore: boolean,
  maximumUtf8Bytes: number,
): CollabCommentPage {
  return commentPageWithLimit(
    comments,
    persistenceHasMore,
    COLLAB_LIMITS.defaultCommentPageSize,
    maximumUtf8Bytes,
  );
}

function commentPageWithLimit(
  comments: readonly Readonly<{
    readonly createdAt: string;
    readonly id: string;
  }>[],
  persistenceHasMore: boolean,
  limit: number,
  maximumUtf8Bytes: number,
): CollabCommentPage {
  const candidates = comments.slice(0, limit);
  const bounded = boundProjectAuthorityPage(candidates, {
    hasMore: comments.length > limit || persistenceHasMore,
    itemField: 'comments',
    key: comment => ({ createdAt: comment.createdAt, id: comment.id }),
    maximumUtf8Bytes,
  });
  return Object.freeze({
    comments: bounded.items,
    ...(bounded.nextCursor === undefined ? {} : { nextCursor: bounded.nextCursor }),
  }) as CollabCommentPage;
}

export class ProjectRequestAuthority {
  readonly #admission: ProjectWriteAdmission;
  readonly #createCommentId: () => string;
  readonly #createRelationId: () => string;
  readonly #createRequestId: () => string;
  readonly #now: () => Date;
  readonly #readAdmission: ProjectCollaborationReadAdmission;
  readonly #repository: ProjectRequestRepository;

  constructor(options: ProjectRequestAuthorityOptions) {
    this.#admission = new ProjectWriteAdmission({
      coordination: options.coordination,
      recovery: options.recovery,
    });
    this.#readAdmission = new ProjectCollaborationReadAdmission(options.coordination);
    this.#createCommentId = options.createCommentId ?? randomUUID;
    this.#createRelationId = options.createRelationId ?? randomUUID;
    this.#createRequestId = options.createRequestId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository;
  }

  async close(): Promise<void> {
    await Promise.all([
      this.#admission.close(),
      this.#readAdmission.close(),
    ]);
  }

  async getRequest(
    principal: IngressPrincipal,
    request: GetRequestRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabRequestDetail> {
    try {
      return await this.#readAdmission.run(
        principal,
        request.projectId,
        async read => {
          const initial = await read.transact(async scope => {
            const changeRequest = await scope.collaboration.requests.find(
              request.requestId,
            );
            if (changeRequest === undefined) {
              throw domainError('request-not-open', 'request-detail-missing');
            }
            const page = await scope.collaboration.requests.listComments(
              request.requestId,
              { limit: COLLAB_LIMITS.defaultCommentPageSize + 1 },
            );
            const budget = projectAuthorityCommentDetailBudget(
              Buffer.byteLength(JSON.stringify(changeRequest), 'utf8') + 512,
            );
            return Object.freeze({
              comments: commentPage(page.items, page.nextCursor !== undefined, budget),
              request: changeRequest,
            });
          });
          const inspection = await this.#repository.inspectRequest({
            expectedMainOid: read.expectedMainOid,
            firstBaseOid: initial.request.firstBaseOid,
            latestHeadOid: initial.request.latestHeadOid,
            memberId: initial.request.memberId,
            personalRef: collabMemberRef(initial.request.memberId),
            placement: read.placement,
            projectId: read.projectId,
            revalidateAuthority: () => read.revalidate(),
            signal: read.signal,
          });
          const current = await read.transact(scope => (
            scope.collaboration.requests.find(request.requestId)
          ));
          if (
            current === undefined
            || current.latestHeadOid !== initial.request.latestHeadOid
            || current.revision !== initial.request.revision
            || current.status !== initial.request.status
            || current.updatedAt !== initial.request.updatedAt
          ) {
            throw domainError('stale-request-head', 'request-detail-changed', true);
          }
          if (
            inspection.currentMainOid !== read.expectedMainOid
            || inspection.reviewedHeadOid !== initial.request.latestHeadOid
          ) {
            throw domainError('authority-not-synchronized', 'request-git-state-stale', true);
          }
          return decodeRequestDetail({
            ...inspection,
            comments: initial.comments,
            request: initial.request,
          });
        },
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async listRequestComments(
    principal: IngressPrincipal,
    request: ListRequestCommentsRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CollabCommentPage> {
    try {
      const limit = request.limit ?? COLLAB_LIMITS.defaultCommentPageSize;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > COLLAB_LIMITS.maxCommentPageSize
      ) {
        throw domainError(
          'protocol-payload-invalid',
          'request-comment-page-limit-invalid',
        );
      }
      const after = decodeProjectAuthorityCursor(
        request.cursor,
        'request-comment-cursor-invalid',
      );
      return await this.#readAdmission.run(
        principal,
        request.projectId,
        read => read.transact(async scope => {
          if (await scope.collaboration.requests.find(request.requestId) === undefined) {
            throw domainError('request-not-open', 'request-detail-missing');
          }
          const page = await scope.collaboration.requests.listComments(
            request.requestId,
            { ...(after === undefined ? {} : { after }), limit: limit + 1 },
          );
          return commentPageWithLimit(
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

  async createComment(
    principal: IngressPrincipal,
    request: CreateCommentRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CreateCommentResponse> {
    try {
      const body = normalizeCommentBody(request.body);
      const requestFingerprint = fingerprint({
        body,
        projectId: request.projectId,
        requestId: request.requestId,
      });
      return await this.#admission.run(
        principal,
        request.projectId,
        async write => {
          const identity = {
            idempotencyKey: request.idempotencyKey,
            memberId: write.memberId,
            operation: 'createComment' as const,
            requestFingerprint,
          };
          const replay = await write.transact(scope => (
            scope.collaboration.idempotency.find(identity)
          ));
          if (replay.kind === 'conflict') {
            throw domainError('idempotency-conflict', 'request-idempotency-key-reused');
          }
          if (replay.kind === 'replay') return decodeCommentResponse(replay.response);
          return write.transact(async scope => {
            const concurrent = await scope.collaboration.idempotency.find(identity);
            if (concurrent.kind === 'conflict') {
              throw domainError('idempotency-conflict', 'request-idempotency-key-reused');
            }
            if (concurrent.kind === 'replay') {
              return decodeCommentResponse(concurrent.response);
            }
            const current = await scope.collaboration.requests.find(request.requestId);
            if (current?.status !== 'open') {
              throw domainError('request-not-open', 'request-comment-request-not-open');
            }
            if (current.commentCount >= COLLAB_LIMITS.maxRequestComments) {
              throw domainError('quota-exceeded', 'request-comment-count-limit');
            }
            const createdAt = this.#now().toISOString();
            const response = await scope.collaboration.requests.createComment({
              authorMemberId: write.memberId,
              body,
              commentId: this.#createCommentId(),
              createdAt,
              requestId: request.requestId,
            });
            await scope.appendProjectEvent({
              kind: 'request.comment-added',
              occurredAt: createdAt,
              payload: { requestId: request.requestId },
            });
            const stored = await scope.collaboration.idempotency.store({
              ...identity,
              createdAt,
              response: { ...response },
            });
            if (stored.kind === 'conflict') {
              throw domainError('idempotency-conflict', 'request-idempotency-key-reused');
            }
            return stored.kind === 'replay'
              ? decodeCommentResponse(stored.response)
              : response;
          });
        },
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async updateMyRequestMetadata(
    principal: IngressPrincipal,
    request: UpdateMyRequestMetadataRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<UpdateMyRequestMetadataResponse> {
    try {
      const description = normalizeDescription(request.description);
      const parsed = parseCollabTicketReferences(description);
      if (parsed.status === 'invalid') {
        throw domainError(
          parsed.reason === 'description-too-large'
            ? 'quota-exceeded'
            : 'protocol-payload-invalid',
          'request-ticket-reference-invalid',
        );
      }
      const requestFingerprint = fingerprint({
        description,
        expectedHeadOid: request.expectedHeadOid,
        expectedRequestRevision: request.expectedRequestRevision,
        projectId: request.projectId,
        requestId: request.requestId,
      });
      return await this.#admission.run(
        principal,
        request.projectId,
        async write => {
          const identity = {
            idempotencyKey: request.idempotencyKey,
            memberId: write.memberId,
            operation: 'updateMyRequestMetadata' as const,
            requestFingerprint,
          };
          const replay = await write.transact(scope => (
            scope.collaboration.idempotency.find(identity)
          ));
          if (replay.kind === 'conflict') {
            throw domainError('idempotency-conflict', 'request-idempotency-key-reused');
          }
          if (replay.kind === 'replay') return decodeMetadataResponse(replay.response);
          return write.transact(async scope => {
            const concurrent = await scope.collaboration.idempotency.find(identity);
            if (concurrent.kind === 'conflict') {
              throw domainError('idempotency-conflict', 'request-idempotency-key-reused');
            }
            if (concurrent.kind === 'replay') {
              return decodeMetadataResponse(concurrent.response);
            }
            const existing = await scope.collaboration.requests.find(request.requestId);
            if (existing?.status !== 'open') {
              throw domainError('request-not-open', 'request-metadata-request-not-open');
            }
            if (existing.memberId !== write.memberId) {
              throw domainError('authorization-denied', 'request-metadata-owner-required');
            }
            if (existing.latestHeadOid !== request.expectedHeadOid) {
              throw domainError('stale-request-head', 'request-metadata-head-changed', true);
            }
            if (existing.revision !== request.expectedRequestRevision) {
              throw domainError(
                'stale-request-metadata',
                'request-metadata-revision-changed',
                true,
              );
            }
            const relations = await this.#resolveRelations(scope, parsed.references);
            const updatedAt = this.#now().toISOString();
            let result = existing;
            if (
              existing.description !== description
              || !sameRelations(existing.ticketRelations, relations)
            ) {
              await scope.collaboration.requests.replacePendingRelations({
                actorMemberId: write.memberId,
                commitOid: existing.latestHeadOid,
                relations,
                requestId: existing.id,
                updatedAt,
              });
              const updated = await scope.collaboration.requests.updateOpen({
                description,
                expectedRevision: existing.revision,
                latestHeadOid: existing.latestHeadOid,
                requestId: existing.id,
                updatedAt,
              });
              if (updated === undefined) {
                throw domainError(
                  'stale-request-metadata',
                  'request-metadata-changed',
                  true,
                );
              }
              result = updated;
              await scope.appendProjectEvent({
                kind: 'request.updated',
                occurredAt: updatedAt,
                payload: { requestId: result.id },
              });
            }
            const response = { request: result };
            const stored = await scope.collaboration.idempotency.store({
              ...identity,
              createdAt: updatedAt,
              response,
            });
            if (stored.kind === 'conflict') {
              throw domainError('idempotency-conflict', 'request-idempotency-key-reused');
            }
            return stored.kind === 'replay'
              ? decodeMetadataResponse(stored.response)
              : response;
          });
        },
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async ensureMyRequest(
    principal: IngressPrincipal,
    request: EnsureMyRequestRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<EnsureMyRequestResponse> {
    try {
      const description = normalizeDescription(request.description);
      const parsed = parseCollabTicketReferences(description);
      if (parsed.status === 'invalid') {
        throw domainError(
          parsed.reason === 'description-too-large'
            ? 'quota-exceeded'
            : 'protocol-payload-invalid',
          'request-ticket-reference-invalid',
        );
      }
      const requestFingerprint = fingerprint({
        description,
        expectedMainOid: request.expectedMainOid,
        headOid: request.headOid,
        projectId: request.projectId,
      });
      return await this.#admission.run(
        principal,
        request.projectId,
        async write => {
          const identity = {
            idempotencyKey: request.idempotencyKey,
            memberId: write.memberId,
            operation: 'ensureMyRequest' as const,
            requestFingerprint,
          };
          const replay = await write.transact(scope => (
            scope.collaboration.idempotency.find(identity)
          ));
          if (replay.kind === 'conflict') {
            throw domainError('idempotency-conflict', 'request-idempotency-key-reused');
          }
          if (replay.kind === 'replay') return decodeEnsureResponse(replay.response);
          if (write.expectedMainOid !== request.expectedMainOid) {
            throw domainError('stale-main', 'request-main-not-expected', true);
          }
          await this.#repository.validateRequestHead({
            expectedMainOid: write.expectedMainOid,
            headOid: request.headOid,
            memberId: write.memberId,
            personalRef: collabMemberRef(write.memberId),
            placement: write.placement,
            projectId: write.projectId,
            revalidateAuthority: write.revalidate,
            signal: write.signal,
          });
          return write.transact(async scope => {
            const concurrent = await scope.collaboration.idempotency.find(identity);
            if (concurrent.kind === 'conflict') {
              throw domainError('idempotency-conflict', 'request-idempotency-key-reused');
            }
            if (concurrent.kind === 'replay') {
              return decodeEnsureResponse(concurrent.response);
            }
            const relations = await this.#resolveRelations(scope, parsed.references);
            const existing = await scope.collaboration.requests.findOpenByMember(
              write.memberId,
            );
            const occurredAt = this.#now().toISOString();
            let changed = false;
            let result;
            if (existing === undefined) {
              result = await scope.collaboration.requests.create({
                createdAt: occurredAt,
                description,
                firstBaseOid: write.expectedMainOid,
                latestHeadOid: request.headOid,
                memberId: write.memberId,
                requestId: this.#createRequestId(),
              });
              await scope.collaboration.requests.replacePendingRelations({
                actorMemberId: write.memberId,
                commitOid: request.headOid,
                relations,
                requestId: result.id,
                updatedAt: occurredAt,
              });
              result = await scope.collaboration.requests.find(result.id) ?? result;
              changed = true;
            } else if (
              existing.latestHeadOid === request.headOid
              && existing.description === description
              && sameRelations(existing.ticketRelations, relations)
            ) {
              result = existing;
            } else {
              await scope.collaboration.requests.replacePendingRelations({
                actorMemberId: write.memberId,
                commitOid: request.headOid,
                relations,
                requestId: existing.id,
                updatedAt: occurredAt,
              });
              result = await scope.collaboration.requests.updateOpen({
                description,
                expectedRevision: existing.revision,
                latestHeadOid: request.headOid,
                requestId: existing.id,
                updatedAt: occurredAt,
              });
              if (result === undefined) {
                throw domainError('stale-request-head', 'request-changed', true);
              }
              changed = true;
            }
            const response = { mainOid: write.expectedMainOid, request: result };
            if (changed) {
              await scope.appendProjectEvent({
                kind: 'request.updated',
                occurredAt,
                payload: { requestId: result.id },
              });
            }
            const stored = await scope.collaboration.idempotency.store({
              ...identity,
              createdAt: occurredAt,
              response: { ...response },
            });
            if (stored.kind === 'conflict') {
              throw domainError('idempotency-conflict', 'request-idempotency-key-reused');
            }
            return stored.kind === 'replay'
              ? decodeEnsureResponse(stored.response)
              : response;
          });
        },
        options,
      );
    } catch (error: unknown) {
      return mapInfrastructureError(error);
    }
  }

  async #resolveRelations(
    scope: ProjectScope,
    references: readonly Readonly<{
      readonly kind: 'references' | 'resolves';
      readonly ticketNumber: number;
    }>[],
  ) {
    const tickets = await scope.collaboration.tickets.findByNumbers(
      references.map(reference => reference.ticketNumber),
    );
    const byNumber = new Map(tickets.map(ticket => [ticket.number, ticket]));
    const relations = [];
    for (const reference of references) {
      const ticket = byNumber.get(reference.ticketNumber);
      if (ticket === undefined) {
        if (reference.kind === 'resolves') {
          throw domainError(
            'resolving-ticket-reference-not-found',
            'request-resolving-ticket-missing',
          );
        }
        continue;
      }
      relations.push({
        kind: reference.kind,
        relationId: this.#createRelationId(),
        ticketId: ticket.id,
      });
    }
    if (relations.length > COLLAB_LIMITS.maxRequestTicketRelations) {
      throw domainError('quota-exceeded', 'request-ticket-relation-limit');
    }
    return Object.freeze(relations);
  }
}

function sameRelations(
  existing: readonly Readonly<{
    readonly kind: string;
    readonly state: string;
    readonly ticketId: string;
  }>[],
  desired: readonly Readonly<{
    readonly kind: string;
    readonly ticketId: string;
  }>[],
): boolean {
  if (existing.length !== desired.length) return false;
  const desiredByTicket = new Map(desired.map(relation => [
    relation.ticketId,
    relation.kind,
  ]));
  return existing.every(relation => (
    relation.state === 'pending'
    && desiredByTicket.get(relation.ticketId) === relation.kind
  ));
}

// Kept here so the repository port remains decision-complete for S7B reads.
export type ProjectRequestDetail = CollabRequestDetail;
