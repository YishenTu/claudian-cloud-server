import type { RedeemProjectRecoveryLinkResponse } from '@claudian-collab/protocol';

import type { ProtectedSecretCustodyEnvelope } from '../project-authority/lifecycle/ProtectedSecretCustody.js';

export interface ProjectRecoveryLinkRecord {
  readonly authorityGeneration: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly issuedByMemberId: string;
  readonly projectId: string;
  readonly recoveryLinkId: string;
  readonly requestFingerprint: string;
  readonly secretReplayExpiresAt: string;
  readonly tokenSha256: string;
  readonly envelope: ProtectedSecretCustodyEnvelope | undefined;
  readonly redemption: Readonly<{
    readonly idempotencyKey: string;
    readonly proofCredentialSha256: string;
    readonly requestFingerprint: string;
    readonly targetPrincipalId: string;
    readonly response: RedeemProjectRecoveryLinkResponse;
  }> | undefined;
}

export interface ProjectRecoveryLinkPersistence {
  readLink(recoveryLinkId: string): Promise<ProjectRecoveryLinkRecord | undefined>;
  readIssuance(memberId: string, idempotencyKey: string): Promise<ProjectRecoveryLinkRecord | undefined>;
  countAvailableLinks(authorityGeneration: number, now: string): Promise<number>;
  insertLink(record: ProjectRecoveryLinkRecord): Promise<void>;
  recordRedemption(recoveryLinkId: string, redemption: NonNullable<ProjectRecoveryLinkRecord['redemption']>): Promise<void>;
  findCredentialMembers(credentialSha256: string): Promise<readonly string[]>;
  readMemberCredentialHashes(memberId: string): Promise<readonly string[]>;
  retainMemberCredentialHash(memberId: string, credentialSha256: string): Promise<void>;
  revokeUnredeemedClaims(memberId: string, now: string): Promise<void>;
}
