import type { CollabIsoTimestamp } from '@claudian-collab/protocol';

const AUTHORITY_TRANSFER_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type AuthorityTransferExpiresAtFactory = (
  createdAt: CollabIsoTimestamp,
) => string;

export function defaultAuthorityTransferExpiresAt(
  createdAt: CollabIsoTimestamp,
): CollabIsoTimestamp {
  return new Date(Date.parse(createdAt) + AUTHORITY_TRANSFER_RETENTION_MS).toISOString();
}

export function selectAuthorityTransferExpiresAt(
  factory: AuthorityTransferExpiresAtFactory,
  createdAt: CollabIsoTimestamp,
): CollabIsoTimestamp | undefined {
  const expiresAt = factory(createdAt);
  if (typeof expiresAt !== 'string') return undefined;
  const parsed = new Date(expiresAt);
  if (
    Number.isNaN(parsed.valueOf())
    || parsed.toISOString() !== expiresAt
    || parsed.valueOf() <= Date.parse(createdAt)
  ) return undefined;
  return expiresAt;
}
