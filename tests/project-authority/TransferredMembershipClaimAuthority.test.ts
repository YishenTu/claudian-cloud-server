import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CollabError } from '@claudian-collab/protocol';

import type {
  InsertClaimOverrideInput,
  ProjectTransferredMembershipClaimAdministrationPersistence,
  TransferredMembershipClaimOverrideRecord,
} from '../../src/coordination/ProjectMembershipPersistence.js';
import type { PortabilityLifecyclePersistenceReader } from '../../src/coordination/PortabilityLifecyclePersistence.js';
import { ProtectedSecretCustody } from '../../src/project-authority/lifecycle/ProtectedSecretCustody.js';
import { TransferredMembershipClaimAuthority } from '../../src/project-authority/membership/TransferredMembershipClaimAuthority.js';
import { createVaultCredentialPrincipal } from '../../src/request-context/RequestPrincipal.js';

const NOW = '2026-08-30T06:00:00.000Z';
const PROJECT_ID = 'project-claim-admin';
const MEMBER_ID = 'member-imported';
const CLAIM = Buffer.alloc(32, 5).toString('base64url');
const PRINCIPAL = createVaultCredentialPrincipal({
  principalId: 'principal-claim-manager',
});

class MemoryClaimAdministration
implements ProjectTransferredMembershipClaimAdministrationPersistence {
  record: TransferredMembershipClaimOverrideRecord | undefined;
  transferId = 'transfer-imported';
  managerSetGeneration = 1;
  membershipRevision = 2n;
  bound = false;
  originalState = 'unclaimed';
  readonly results = new Map<string, { requestFingerprint: string; response: unknown }>();
  hasLiveMemberBinding(): Promise<boolean> { return Promise.resolve(this.bound); }
  expireClaimOverrides(): Promise<void> { return Promise.resolve(); }
  scrubClaimOverrideEnvelopes(): Promise<void> { return Promise.resolve(); }
  findSecretReplayTombstone(): Promise<string | undefined> { return Promise.resolve(undefined); }
  readCurrentTransferClaim() { return Promise.resolve({ claimSha256: 'a'.repeat(64), expiresAt: '2026-09-29T06:00:00.000Z', state: this.originalState, transferId: this.transferId }); }
  readHighestClaimOverride(transferId: string) { return Promise.resolve(this.record?.transferId === transferId ? this.record : undefined); }
  readClaimOverride() { return Promise.resolve(this.record); }
  readClaimOverrideIssuance(actor: string, key: string) { return Promise.resolve(this.record?.managerMemberId === actor && this.record.idempotencyKey === key ? this.record : undefined); }
  readTransferredClaimByDigest(): Promise<undefined> { return Promise.resolve(undefined); }
  insertClaimOverride(input: InsertClaimOverrideInput): Promise<TransferredMembershipClaimOverrideRecord> {
    this.record = Object.freeze({ ...input, projectId: PROJECT_ID, operationIntentId: null, redemptionReceiptId: null, state: 'active', targetPrincipalId: null, updatedAt: input.createdAt });
    return Promise.resolve(this.record);
  }
  revokeClaimRow(): Promise<void> {
    if (this.record === undefined) this.originalState = 'revoked';
    else this.record = Object.freeze({ ...this.record, state: 'revoked', updatedAt: NOW });
    return Promise.resolve();
  }
  recordClaimOverrideRedemption(): Promise<never> { return Promise.reject(new Error('unused')); }
  findMembershipResult(actor: string, operation: string, key: string) { return Promise.resolve(this.results.get(JSON.stringify([actor, operation, key]))); }
  hasMembershipResultTombstone(): Promise<boolean> { return Promise.resolve(false); }
  storeMembershipResult(actor: string, operation: string, key: string, requestFingerprint: string, response: unknown): Promise<void> {
    this.results.set(JSON.stringify([actor, operation, key]), { requestFingerprint, response });
    return Promise.resolve();
  }

}

function fixture() {
  const persistence = new MemoryClaimAdministration();
  const authority = new TransferredMembershipClaimAuthority({
    clock: () => new Date(NOW),
    custody: new ProtectedSecretCustody({
      activeKeyId: 'claim-key',
      keys: [{ key: Buffer.alloc(32, 7), keyId: 'claim-key', keyVersion: 2 }],
      nonceFactory: () => Buffer.alloc(24, 8),
    }),
    secretFactory: () => CLAIM,
    writeAdmission: {
      run: async <T>(_principal: unknown, _projectId: unknown, operation: (write: {
        memberId: string;
        role: 'manager';
        transact<U>(callback: (scope: {
          getProject(): Promise<{ managerSetGeneration: number }>;
          findMembership(memberId: string): Promise<{ revision: bigint; role: string; status: string }>;
          membership: ProjectTransferredMembershipClaimAdministrationPersistence;
          portability: Pick<PortabilityLifecyclePersistenceReader, 'getLifecycleJournal'>;
        }) => Promise<U>): Promise<U>;
      }) => Promise<T>) => operation({
        memberId: 'member-manager',
        role: 'manager',
        transact: callback => callback({
          getProject: () => Promise.resolve({ managerSetGeneration: persistence.managerSetGeneration }),
          findMembership: (memberId: string) => Promise.resolve({ revision: persistence.membershipRevision, role: memberId === MEMBER_ID ? 'member' : 'manager', status: 'active' }),
          membership: persistence,
          portability: {
            getLifecycleJournal: transferId => Promise.resolve(transferId === 'transfer-imported' ? {
              actorMemberId: 'member-manager',
              batchRevision: 1,
              batchSha256: 'b'.repeat(64),
              checkpointSha256: 'a'.repeat(64),
              createdAt: NOW,
              direction: 'lan-to-cloud',
              expectedAuthorityGeneration: 6,
              idempotencyKey: 'transfer-import-key',
              kind: 'authority-transfer',
              operationId: 'transfer-imported',
              phase: 'completed',
              projectId: PROJECT_ID,
              recoveryFromPhase: undefined,
              requestFingerprint: 'c'.repeat(64),
              resultSha256: 'd'.repeat(64),
              scheduledAt: NOW,
              state: 'completed',
              updatedAt: NOW,
            } : undefined),
          },
        }),
      }),
    } as never,
  });
  return { authority, persistence };
}

describe('TransferredMembershipClaimAuthority', () => {
  it('reissues one generation-bound secret and replays the durable custody result', async () => {
    const { authority, persistence } = fixture();
    const request = {
      expectedClaimGeneration: 0,
      expectedManagerSetGeneration: 1,
      expectedMembershipRevision: 2,
      idempotencyKey: 'claim-reissue-key',
      memberId: MEMBER_ID,
      projectId: PROJECT_ID,
    };
    const created = await authority.reissue(PRINCIPAL, request);
    assert.deepEqual(created, {
      claim: CLAIM,
      claimGeneration: 1,
      createdAt: NOW,
      expiresAt: '2026-09-29T06:00:00.000Z',
      memberId: MEMBER_ID,
      projectId: PROJECT_ID,
      secretReplayExpiresAt: '2026-09-29T06:00:00.000Z',
      targetAuthorityGeneration: 7,
      transferId: 'transfer-imported',
    });
    assert.equal(JSON.stringify(persistence.record).includes(CLAIM), false);
    persistence.transferId = 'transfer-newer-import';
    assert.deepEqual(await authority.reissue(PRINCIPAL, request), created);
  });

  it('preserves only authority-proved negative settlement for claim mutations', async () => {
    const request = { expectedClaimGeneration: 0, expectedManagerSetGeneration: 1,
      expectedMembershipRevision: 1, idempotencyKey: 'claim-negative', memberId: MEMBER_ID, projectId: PROJECT_ID };
    for (const status of ['permanently-stale', 'stale'] as const) {
      const { authority, persistence } = fixture();
      persistence.membershipRevision = 1n;
      persistence.managerSetGeneration = status === 'permanently-stale' ? 2 : 0;
      const expected = { code: 'authority-not-synchronized',
        name: status === 'permanently-stale' ? 'ProjectMutationRejection' : 'CollabError' };
      await assert.rejects(authority.reissue(PRINCIPAL, request), expected);
      await assert.rejects(authority.revoke(PRINCIPAL, request), expected);
    }
  });

  it('revokes the exact highest generation and fails closed on stale state', async () => {
    const { authority, persistence } = fixture();
    assert.equal((await authority.revoke(PRINCIPAL, {
      expectedClaimGeneration: 0,
      expectedManagerSetGeneration: 1,
      expectedMembershipRevision: 2,
      idempotencyKey: 'claim-revoke-key',
      memberId: MEMBER_ID,
      projectId: PROJECT_ID,
    })).state, 'revoked');
    persistence.managerSetGeneration = 0;
    await assert.rejects(authority.revoke(PRINCIPAL, {
      expectedClaimGeneration: 0,
      expectedManagerSetGeneration: 1,
      expectedMembershipRevision: 2,
      idempotencyKey: 'claim-revoke-stale',
      memberId: MEMBER_ID,
      projectId: PROJECT_ID,
    }), (error: unknown) => error instanceof CollabError
      && error.code === 'authority-not-synchronized');
  });
});
