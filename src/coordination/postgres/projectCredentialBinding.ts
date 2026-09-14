import { COLLAB_PROJECT_RECOVERY_LIMITS } from '@claudian-collab/protocol';
import type { QueryResultRow } from 'pg';

import { CoordinationError } from '../CoordinationError.js';

type ProjectQuery = <Row extends QueryResultRow>(sql: string, values: readonly unknown[]) => Promise<readonly Row[]>;

/** Preserve unique portable credential ownership across every principal-binding writer. */
export async function assertProjectCredentialBinding(
  query: ProjectQuery, projectId: string, memberId: string, principalId: string,
): Promise<void> {
  if (!/^vault-[a-f0-9]{64}$/u.test(principalId)) return;
  const digest = principalId.slice(6);
  const rows = await query<{ readonly conflict: boolean; readonly count: string }>(`WITH verifiers AS (
    SELECT member_id, credential_sha256 FROM claudian_cloud.project_member_recovery_credentials WHERE project_id = $1
    UNION SELECT member_id, substring(principal_id from 7) FROM claudian_cloud.project_principal_bindings
      WHERE project_id = $1 AND principal_id ~ '^vault-[a-f0-9]{64}$'
  ) SELECT EXISTS(SELECT 1 FROM verifiers WHERE credential_sha256 = $3 AND member_id <> $2) AS conflict,
    (SELECT count(*)::text FROM (SELECT credential_sha256 FROM verifiers WHERE member_id = $2 UNION SELECT $3::text) AS owned) AS count`,
  [projectId, memberId, digest]);
  if (!rows[0] || rows[0].conflict || Number(rows[0].count) > COLLAB_PROJECT_RECOVERY_LIMITS.maxCredentialVerifiersPerMember) {
    throw new CoordinationError('state-conflict');
  }
}
