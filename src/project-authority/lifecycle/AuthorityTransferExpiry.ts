import type { CollabIsoTimestamp } from '@claudian-collab/protocol';

const AUTHORITY_TRANSFER_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function defaultAuthorityTransferExpiresAt(
  createdAt: CollabIsoTimestamp,
): CollabIsoTimestamp {
  return new Date(Date.parse(createdAt) + AUTHORITY_TRANSFER_RETENTION_MS).toISOString();
}
