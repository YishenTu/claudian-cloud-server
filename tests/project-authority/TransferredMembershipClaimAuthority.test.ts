import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CollabError } from '@claudian-collab/protocol';

import type {
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
  status: 'created' | 'permanently-stale' | 'replayed' | 'stale' = 'created';

  getImportedMembershipClaimFacts() {
    return Promise.resolve({
      claimGeneration: this.record?.claimGeneration ?? 0,
      claimSha256: this.record?.claimSha256 ?? 'a'.repeat(64),
      memberId: MEMBER_ID,
      transferId: this.transferId,
    });
  }

  reissueTransferredMembershipClaim(input: Parameters<
    ProjectTransferredMembershipClaimAdministrationPersistence[
      'reissueTransferredMembershipClaim'
    ]
  >[0]) {
    if ((this.status === 'stale' || this.status === 'permanently-stale')) return Promise.resolve({ status: this.status });
    if (this.record === undefined) {
      this.record = Object.freeze({
        claimGeneration: input.claimGeneration,
        claimSha256: input.claimSha256,
        createdAt: input.createdAt,
        envelope: input.envelope,
        expiresAt: input.expiresAt,
        idempotencyKey: input.idempotencyKey,
        managerMemberId: input.actorMemberId,
        memberId: input.memberId,
        operationIntentId: null,
        projectId: input.projectId,
        redemptionReceiptId: null,
        requestFingerprint: input.requestFingerprint,
        secretReplayExpiresAt: input.secretReplayExpiresAt,
        state: 'active',
        supersededClaimSha256: 'a'.repeat(64),
        targetPrincipalId: null,
        transferId: input.transferId,
        updatedAt: input.createdAt,
      });
      return Promise.resolve({ record: this.record, status: 'created' as const });
    }
    return Promise.resolve({ record: this.record, status: 'replayed' as const });
  }

  revokeTransferredMembershipClaim() {
    return Promise.resolve((this.status === 'stale' || this.status === 'permanently-stale')
      ? { status: this.status }
      : {
        response: {
          claimGeneration: this.record?.claimGeneration ?? 0,
          memberId: MEMBER_ID,
          projectId: PROJECT_ID,
          revokedAt: NOW,
          state: 'revoked' as const,
        },
        status: 'created' as const,
      });
  }

  resolveEffectiveTransferredMembershipClaim(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  redeemTransferredMembershipClaimOverride(): Promise<never> {
    return Promise.reject(new Error('unused'));
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
          membership: ProjectTransferredMembershipClaimAdministrationPersistence;
          portability: Pick<PortabilityLifecyclePersistenceReader, 'getLifecycleJournal'>;
        }) => Promise<U>): Promise<U>;
      }) => Promise<T>) => operation({
        memberId: 'member-manager',
        role: 'manager',
        transact: callback => callback({
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
      persistence.status = status;
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
    persistence.status = 'stale';
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
