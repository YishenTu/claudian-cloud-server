const MAXIMUM_DURABLE_PROOF_BYTES = 7_000;

/** Keeps externally supplied proof text inside the durable recovery evidence budget. */
export function isDurableAuthorityTransferProof(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') >= 1
    && Buffer.byteLength(value, 'utf8') <= MAXIMUM_DURABLE_PROOF_BYTES;
}
