import { CoordinationError } from '../../coordination/CoordinationError.js';
import type { ProjectMembershipResultPersistence } from '../../coordination/ProjectMembershipPersistence.js';

export async function readMembershipOperationReplay<Response>(
  persistence: Pick<ProjectMembershipResultPersistence, 'findMembershipResult' | 'hasMembershipResultTombstone'>,
  actorMemberId: string,
  operation: string,
  idempotencyKey: string,
  requestFingerprint: string,
  decode: (value: unknown) => Response,
): Promise<Readonly<{ readonly response: Response; readonly status: 'replayed' }>
  | Readonly<{ readonly status: 'conflict' }> | undefined> {
  const row = await persistence.findMembershipResult(actorMemberId, operation, idempotencyKey);
  if (row !== undefined && row.requestFingerprint !== requestFingerprint) return { status: 'conflict' };
  if (row !== undefined) {
    try { return { response: decode(row.response), status: 'replayed' }; }
    catch { throw new CoordinationError('dependency-failed'); }
  }
  return await persistence.hasMembershipResultTombstone(actorMemberId, operation, idempotencyKey)
    ? { status: 'conflict' } : undefined;
}
