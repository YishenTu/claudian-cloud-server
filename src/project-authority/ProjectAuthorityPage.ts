import {
  COLLAB_LIMITS,
  CollabError,
} from '@claudian/collab-protocol';

import type {
  CollaborationKeysetCursor,
  CollaborationTicketListCursor,
} from '../coordination/CollaborationPersistence.js';

function cursorError(reason: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    recoveryActions: ['retry'],
    safeContext: { reason },
  });
}

export function decodeProjectAuthorityCursor(
  value: string | undefined,
  reason: string,
): CollaborationKeysetCursor | undefined {
  if (
    value === undefined
  ) return undefined;
  if (value.length === 0 || value.length > COLLAB_LIMITS.maxPageCursorUtf16) {
    throw cursorError(reason);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw cursorError(reason);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw cursorError(reason);
  }
  const source = parsed as Readonly<Record<string, unknown>>;
  if (
    typeof source.createdAt !== 'string'
    || Number.isNaN(Date.parse(source.createdAt))
    || new Date(source.createdAt).toISOString() !== source.createdAt
    || typeof source.id !== 'string'
    || source.id.length === 0
    || source.id.length > 128
    || Object.keys(source).some(key => key !== 'createdAt' && key !== 'id')
  ) {
    throw cursorError(reason);
  }
  return Object.freeze({ createdAt: source.createdAt, id: source.id });
}

export function encodeProjectAuthorityCursor(
  cursor: CollaborationKeysetCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeProjectAuthorityTicketCursor(
  value: string | undefined,
): CollaborationTicketListCursor | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > COLLAB_LIMITS.maxPageCursorUtf16) {
    throw cursorError('ticket-cursor-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw cursorError('ticket-cursor-invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw cursorError('ticket-cursor-invalid');
  }
  const source = parsed as Readonly<Record<string, unknown>>;
  if (
    typeof source.ticketNumber !== 'number'
    || !Number.isSafeInteger(source.ticketNumber)
    || source.ticketNumber < 1
    || typeof source.updatedAt !== 'string'
    || Number.isNaN(Date.parse(source.updatedAt))
    || new Date(source.updatedAt).toISOString() !== source.updatedAt
    || Object.keys(source).some(key => key !== 'ticketNumber' && key !== 'updatedAt')
  ) {
    throw cursorError('ticket-cursor-invalid');
  }
  return Object.freeze({
    ticketNumber: source.ticketNumber,
    updatedAt: source.updatedAt,
  });
}

export function encodeProjectAuthorityTicketCursor(
  cursor: CollaborationTicketListCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export interface BoundedProjectAuthorityPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
}

const DETAIL_ENVELOPE_RESERVE_BYTES = 1_024;
const JSON_STRING_WORST_CASE_EXPANSION = 6;
const COMMENT_PAGE_FLOOR_BYTES = (
  COLLAB_LIMITS.maxTicketCommentBytes * JSON_STRING_WORST_CASE_EXPANSION
) + 4_096;
const RELATION_PAGE_FLOOR_BYTES = 4_096;

export interface ProjectAuthorityDetailPageBudgets {
  readonly commentsMaximumUtf8Bytes: number;
  readonly relationsMaximumUtf8Bytes: number;
}

export function projectAuthorityDetailPageBudgets(
  fixedUtf8Bytes: number,
  includeRelations: boolean,
): ProjectAuthorityDetailPageBudgets {
  const clamp = (value: number, floor: number, ceiling: number): number => (
    Math.min(ceiling, Math.max(floor, value))
  );
  const available = Math.max(
    0,
    COLLAB_LIMITS.detailMaxUtf8Bytes
      - fixedUtf8Bytes
      - DETAIL_ENVELOPE_RESERVE_BYTES,
  );
  if (!includeRelations) {
    return Object.freeze({
      commentsMaximumUtf8Bytes: clamp(
        available,
        COMMENT_PAGE_FLOOR_BYTES,
        COLLAB_LIMITS.commentPageMaxUtf8Bytes,
      ),
      relationsMaximumUtf8Bytes: 0,
    });
  }
  const relationsMaximumUtf8Bytes = clamp(
    Math.ceil(available / 4),
    RELATION_PAGE_FLOOR_BYTES,
    COLLAB_LIMITS.relationPageMaxUtf8Bytes,
  );
  return Object.freeze({
    commentsMaximumUtf8Bytes: clamp(
      available - relationsMaximumUtf8Bytes,
      COMMENT_PAGE_FLOOR_BYTES,
      COLLAB_LIMITS.commentPageMaxUtf8Bytes,
    ),
    relationsMaximumUtf8Bytes,
  });
}

export function projectAuthorityCommentDetailBudget(fixedUtf8Bytes: number): number {
  return projectAuthorityDetailPageBudgets(
    fixedUtf8Bytes,
    false,
  ).commentsMaximumUtf8Bytes;
}

export function boundProjectAuthorityPage<T>(
  items: readonly T[],
  options: Readonly<{
    readonly hasMore: boolean;
    readonly itemField: 'acceptedRelations' | 'comments' | 'tickets';
    readonly encodeKey?: (key: CollaborationKeysetCursor) => string;
    readonly key: (item: T) => CollaborationKeysetCursor;
    readonly maximumUtf8Bytes: number;
  }>,
): BoundedProjectAuthorityPage<T> {
  const accepted: T[] = [];
  let nextCursor: string | undefined;
  for (const [index, item] of items.entries()) {
    const candidate = [...accepted, item];
    const hasMore = index + 1 < items.length || options.hasMore;
    const cursor = hasMore
      ? (options.encodeKey ?? encodeProjectAuthorityCursor)(options.key(item))
      : undefined;
    if (
      Buffer.byteLength(JSON.stringify({
        [options.itemField]: candidate,
        ...(cursor === undefined ? {} : { nextCursor: cursor }),
      }), 'utf8') > options.maximumUtf8Bytes
    ) {
      if (accepted.length === 0) {
        throw new CollabError({
          code: 'authority-integrity-error',
          safeContext: { reason: 'authority-page-item-exceeds-byte-budget' },
        });
      }
      break;
    }
    accepted.push(item);
    nextCursor = cursor;
  }
  return Object.freeze({
    items: Object.freeze(accepted),
    nextCursor,
  });
}
