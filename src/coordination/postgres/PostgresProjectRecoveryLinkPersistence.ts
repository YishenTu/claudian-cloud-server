import { collabControlOperationCodec } from '@claudian-collab/protocol';
import type { QueryResultRow } from 'pg';

import { CoordinationError } from '../CoordinationError.js';
import { assertProjectCredentialBinding } from './projectCredentialBinding.js';
import type { ProjectRecoveryLinkPersistence, ProjectRecoveryLinkRecord } from '../ProjectRecoveryLinkPersistence.js';

export interface RecoveryLinkRow extends QueryResultRow {
  readonly authority_generation: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly idempotency_key: string;
  readonly issued_by_member_id: string;
  readonly project_id: string;
  readonly recovery_link_id: string;
  readonly request_fingerprint: string;
  readonly secret_replay_expires_at: Date;
  readonly token_sha256: string;
  readonly envelope_json: string | null;
  readonly redemption_json: string | null;
}

type ProjectQuery = <Row extends QueryResultRow>(sql: string, values: readonly unknown[]) => Promise<readonly Row[]>;

function json(value: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(value);
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
  } catch { /* Invalid storage is reported without record content. */ }
  throw new CoordinationError('invalid-record');
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new CoordinationError('invalid-record');
  return value;
}
export function decodeProjectRecoveryLinkRow(row: RecoveryLinkRow): ProjectRecoveryLinkRecord {
  const raw = row.envelope_json === null ? undefined : json(row.envelope_json);
  let envelope: ProjectRecoveryLinkRecord['envelope'];
  if (raw) {
    if (raw.algorithm !== 'xchacha20-poly1305' || !Number.isSafeInteger(raw.keyVersion)
      || Number(raw.keyVersion) < 1) throw new CoordinationError('invalid-record');
    envelope = { algorithm: raw.algorithm, associatedDataSha256: text(raw.associatedDataSha256),
      ciphertext: text(raw.ciphertext), keyId: text(raw.keyId), keyVersion: Number(raw.keyVersion), nonce: text(raw.nonce), tag: text(raw.tag) };
  }
  const redemption = row.redemption_json === null ? undefined : json(row.redemption_json);
  return { authorityGeneration: Number(row.authority_generation), createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(), idempotencyKey: row.idempotency_key, issuedByMemberId: row.issued_by_member_id,
    projectId: row.project_id, recoveryLinkId: row.recovery_link_id, requestFingerprint: row.request_fingerprint,
    secretReplayExpiresAt: row.secret_replay_expires_at.toISOString(), tokenSha256: row.token_sha256, envelope,
    redemption: redemption === undefined ? undefined : { idempotencyKey: text(redemption.idempotencyKey),
      proofCredentialSha256: text(redemption.proofCredentialSha256), requestFingerprint: text(redemption.requestFingerprint),
      targetPrincipalId: text(redemption.targetPrincipalId),
      response: collabControlOperationCodec('redeemProjectRecoveryLink').decodeResponse(redemption.response) } };
}

export class PostgresProjectRecoveryLinkPersistence implements ProjectRecoveryLinkPersistence {
  readonly #projectId: string;
  readonly #query: ProjectQuery;
  constructor(projectId: string, query: ProjectQuery) { this.#projectId = projectId; this.#query = query; }

  async readLink(recoveryLinkId: string): Promise<ProjectRecoveryLinkRecord | undefined> {
    const rows = await this.#query<RecoveryLinkRow>(`SELECT * FROM claudian_cloud.project_recovery_links
      WHERE project_id = $1 AND recovery_link_id = $2`, [this.#projectId, recoveryLinkId]);
    return rows[0] ? decodeProjectRecoveryLinkRow(rows[0]) : undefined;
  }
  async readIssuance(memberId: string, idempotencyKey: string): Promise<ProjectRecoveryLinkRecord | undefined> {
    const rows = await this.#query<RecoveryLinkRow>(`SELECT * FROM claudian_cloud.project_recovery_links
      WHERE project_id = $1 AND issued_by_member_id = $2 AND idempotency_key = $3`, [this.#projectId, memberId, idempotencyKey]);
    return rows[0] ? decodeProjectRecoveryLinkRow(rows[0]) : undefined;
  }
  async countAvailableLinks(authorityGeneration: number, now: string): Promise<number> {
    const rows = await this.#query<{ count: string }>(`SELECT count(*)::text AS count FROM claudian_cloud.project_recovery_links
      WHERE project_id = $1 AND authority_generation = $2 AND expires_at > $3::timestamptz AND redemption_json IS NULL`,
    [this.#projectId, authorityGeneration, now]);
    return Number(rows[0]?.count ?? 0);
  }
  async insertLink(record: ProjectRecoveryLinkRecord): Promise<void> {
    if (record.projectId !== this.#projectId) throw new CoordinationError('invalid-project');
    await this.#query(`INSERT INTO claudian_cloud.project_recovery_links
      (project_id, recovery_link_id, authority_generation, issued_by_member_id, idempotency_key,
       request_fingerprint, token_sha256, created_at, expires_at, secret_replay_expires_at, envelope_json, redemption_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11,$12)`,
    [this.#projectId, record.recoveryLinkId, record.authorityGeneration, record.issuedByMemberId, record.idempotencyKey,
      record.requestFingerprint, record.tokenSha256, record.createdAt, record.expiresAt, record.secretReplayExpiresAt,
      record.envelope ? JSON.stringify(record.envelope) : null, record.redemption ? JSON.stringify(record.redemption) : null]);
  }
  async recordRedemption(recoveryLinkId: string, redemption: NonNullable<ProjectRecoveryLinkRecord['redemption']>): Promise<void> {
    const rows = await this.#query(`UPDATE claudian_cloud.project_recovery_links SET redemption_json = $3
      WHERE project_id = $1 AND recovery_link_id = $2 AND redemption_json IS NULL RETURNING recovery_link_id`,
    [this.#projectId, recoveryLinkId, JSON.stringify(redemption)]);
    if (rows.length !== 1) throw new CoordinationError('state-conflict');
  }
  async findCredentialMembers(credentialSha256: string): Promise<readonly string[]> {
    const rows = await this.#query<{ member_id: string }>(`SELECT member_id FROM claudian_cloud.project_member_recovery_credentials
      WHERE project_id = $1 AND credential_sha256 = $2
      UNION SELECT member_id FROM claudian_cloud.project_principal_bindings WHERE project_id = $1 AND principal_id = $3`,
    [this.#projectId, credentialSha256, `vault-${credentialSha256}`]);
    return rows.map(row => row.member_id);
  }
  async readMemberCredentialHashes(memberId: string): Promise<readonly string[]> {
    const rows = await this.#query<{ credential_sha256: string }>(`SELECT credential_sha256 FROM claudian_cloud.project_member_recovery_credentials
      WHERE project_id = $1 AND member_id = $2
      UNION SELECT substring(principal_id from 7) AS credential_sha256 FROM claudian_cloud.project_principal_bindings
      WHERE project_id = $1 AND member_id = $2 AND principal_id ~ '^vault-[a-f0-9]{64}$'`, [this.#projectId, memberId]);
    return rows.map(row => row.credential_sha256).sort();
  }
  async retainMemberCredentialHash(memberId: string, credentialSha256: string): Promise<void> {
    await assertProjectCredentialBinding(this.#query, this.#projectId, memberId, `vault-${credentialSha256}`);
    const rows = await this.#query<{ member_id: string }>(`INSERT INTO claudian_cloud.project_member_recovery_credentials
      (project_id, member_id, credential_sha256) VALUES ($1,$2,$3)
      ON CONFLICT (project_id, credential_sha256) DO UPDATE SET member_id = claudian_cloud.project_member_recovery_credentials.member_id
      WHERE claudian_cloud.project_member_recovery_credentials.member_id = EXCLUDED.member_id RETURNING member_id`,
    [this.#projectId, memberId, credentialSha256]);
    if (rows.length !== 1) throw new CoordinationError('state-conflict');
  }
  async revokeUnredeemedClaims(memberId: string, now: string): Promise<void> {
    await this.#query(`UPDATE claudian_cloud.transferred_membership_claims SET state = 'revoked', updated_at = $3::timestamptz
      WHERE project_id = $1 AND member_id = $2 AND state = 'unclaimed'`, [this.#projectId, memberId, now]);
    await this.#query(`UPDATE claudian_cloud.transferred_membership_claim_overrides SET state = 'revoked', updated_at = $3::timestamptz
      WHERE project_id = $1 AND member_id = $2 AND state = 'active'`, [this.#projectId, memberId, now]);
  }
}
