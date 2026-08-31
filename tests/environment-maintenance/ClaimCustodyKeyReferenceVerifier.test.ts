import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ClaimCustodyKeyReferenceVerifier,
  KeyReferenceCheckingBackupExportSource,
} from '../../src/environment-maintenance/commands/ClaimCustodyKeyReferenceVerifier.js';
import { frameBackupProtectedSecretEnvelope } from '../../src/coordination/backupProtectedSecretEnvelope.js';
import { ProtectedSecretCustody } from '../../src/project-authority/lifecycle/ProtectedSecretCustody.js';
import { encodeInvitationAssociatedData } from '../../src/project-authority/membership/ProjectInvitationAuthority.js';
import { encodeClaimOverrideAssociatedData } from '../../src/project-authority/membership/TransferredMembershipClaimAuthority.js';

describe('ClaimCustodyKeyReferenceVerifier', () => {
  it('opens framed invitation custody and rejects the wrong retained key', async () => {
    const key = Buffer.alloc(32, 7);
    const custody = new ProtectedSecretCustody({
      activeKeyId: 'membership-key',
      keys: [{ key, keyId: 'membership-key', keyVersion: 3 }],
      nonceFactory: () => Buffer.alloc(24, 9),
    });
    const associatedData = encodeInvitationAssociatedData({
      expiresAt: '2026-08-31T00:00:00.000Z',
      invitationId: 'invitation-one',
      projectId: 'project-one',
    });
    const sealed = await custody.seal({
      associatedData,
      secret: Buffer.alloc(32, 5).toString('base64url'),
    });
    const overrideAssociatedData = encodeClaimOverrideAssociatedData({
      claimGeneration: 2,
      expiresAt: '2026-09-29T00:00:00.000Z',
      memberId: 'member-one',
      projectId: 'project-one',
      transferId: 'transfer-one',
    });
    const overrideSealed = await custody.seal({
      associatedData: overrideAssociatedData,
      secret: Buffer.alloc(32, 6).toString('base64url'),
    });
    const records = [{
      kind: 'project-invitation',
      value: {
        expiresAt: '2026-08-31T00:00:00.000Z',
        invitationId: 'invitation-one',
        projectId: 'project-one',
      },
    }, {
      kind: 'protected-invitation-envelope',
      value: {
        associatedDataSha256: sealed.associatedDataSha256,
        ciphertext: frameBackupProtectedSecretEnvelope(sealed),
        invitationId: 'invitation-one',
        keyId: sealed.keyId,
        nonce: sealed.nonce,
        projectId: 'project-one',
      },
    }, {
      kind: 'protected-claim-override-envelope',
      value: {
        associatedDataSha256: overrideSealed.associatedDataSha256,
        ciphertext: frameBackupProtectedSecretEnvelope(overrideSealed),
        claimGeneration: 2,
        expiresAt: '2026-09-29T00:00:00.000Z',
        keyId: overrideSealed.keyId,
        memberId: 'member-one',
        nonce: overrideSealed.nonce,
        projectId: 'project-one',
        transferId: 'transfer-one',
      },
    }];
    const references: unknown[] = [];
    const verifier = new ClaimCustodyKeyReferenceVerifier({
      custody: { open: () => Promise.resolve('unused') },
      keyring: {
        assertReferences: input => references.push(input),
        assertReceiptPublicKey() {},
      },
      membershipCustody: custody,
    });
    await verifier.verify(records);
    assert.deepEqual(references, [{
      encryptionKeyIds: ['membership-key'],
      receiptKeyIds: [],
    }]);

    const wrongKeyVerifier = new ClaimCustodyKeyReferenceVerifier({
      custody: { open: () => Promise.resolve('unused') },
      keyring: {
        assertReferences() {},
        assertReceiptPublicKey() {},
      },
      membershipCustody: new ProtectedSecretCustody({
        activeKeyId: 'membership-key',
        keys: [{
          key: Buffer.alloc(32, 8),
          keyId: 'membership-key',
          keyVersion: 3,
        }],
      }),
    });
    await assert.rejects(wrongKeyVerifier.verify(records));
  });

  it('collects and opens every historical encryption and receipt-key reference', async () => {
    const calls: unknown[] = [];
    const opened: unknown[] = [];
    const publicKeys: unknown[] = [];
    const verifier = new ClaimCustodyKeyReferenceVerifier({
      custody: {
        open: envelope => {
          opened.push(envelope);
          return Promise.resolve('opaque-claim');
        },
      },
      keyring: {
        assertReferences: input => calls.push(input),
        assertReceiptPublicKey: (keyId, publicKey) => {
          publicKeys.push({ keyId, publicKey });
        },
      },
    });
    const records = [
      {
        kind: 'protected-claim-envelope',
        value: {
          keyId: 'encryption-2',
          receiptKeyId: 'receipt-1',
          transferId: 'transfer-1',
        },
      },
      {
        kind: 'protected-claim-envelope',
        value: {
          keyId: 'encryption-1',
          receiptKeyId: 'receipt-2',
          transferId: 'transfer-2',
        },
      },
      {
        kind: 'transfer-receipt-key',
        value: {
          receiptKeyId: 'receipt-1',
          receiptPublicKey: Buffer.alloc(32, 1).toString('base64url'),
          transferId: 'transfer-1',
        },
      },
      {
        kind: 'lifecycle-journal',
        value: {
          direction: 'lan-to-cloud',
          operationId: 'transfer-2',
          operationKind: 'authority-transfer',
        },
      },
      {
        kind: 'transfer-receipt-key',
        value: {
          receiptKeyId: 'receipt-2',
          receiptPublicKey: Buffer.alloc(32, 2).toString('base64url'),
          transferId: 'transfer-2',
        },
      },
      {
        kind: 'transfer-receipt-key',
        value: {
          receiptKeyId: 'lan-owned-key',
          receiptPublicKey: Buffer.alloc(32, 3).toString('base64url'),
          transferId: 'lan-transfer',
        },
      },
      { kind: 'project', value: {} },
    ];
    await verifier.verify(records);
    assert.deepEqual(calls, [{
      encryptionKeyIds: ['encryption-1', 'encryption-2'],
      receiptKeyIds: ['receipt-2'],
    }]);
    assert.deepEqual(publicKeys, [
      {
        keyId: 'receipt-2',
        publicKey: Buffer.alloc(32, 2).toString('base64url'),
      },
    ]);
    assert.deepEqual(opened, [records[0]?.value, records[1]?.value]);
  });

  it('fails closed on a malformed referenced record', async () => {
    const verifier = new ClaimCustodyKeyReferenceVerifier({
      custody: { open: () => Promise.resolve('opaque-claim') },
      keyring: {
        assertReferences() {},
        assertReceiptPublicKey() {},
      },
    });
    await assert.rejects(
      verifier.verify([{
        kind: 'protected-claim-envelope',
        value: {
          keyId: '',
          receiptKeyId: 'receipt-1',
          transferId: 'transfer-1',
        },
      }]),
      /claim-custody-key-reference\.error\.invalid-record/u,
    );
  });

  it('checks captured checkpoint records before returning them', async () => {
    const checked: unknown[] = [];
    const verifier = {
      verify: (records: readonly unknown[]) => {
        checked.push(records);
        return Promise.resolve();
      },
    };
    const capturedRecords = [{
      kind: 'protected-claim-envelope',
      value: { keyId: 'encryption-1', receiptKeyId: 'receipt-1' },
    }];
    const source = new KeyReferenceCheckingBackupExportSource({
      source: {
        snapshot: () => Promise.resolve({ records: capturedRecords, refs: [] }),
      } as never,
      verifier,
    });
    assert.equal((await source.snapshot({} as never)).records, capturedRecords);
    assert.deepEqual(checked, [capturedRecords]);
  });
});
