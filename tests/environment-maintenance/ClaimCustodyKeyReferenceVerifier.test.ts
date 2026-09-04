import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  encodeCollabAuthorityRelinquishmentProofSigningInput,
} from '@claudian-collab/protocol';

import {
  ClaimCustodyKeyReferenceVerifier,
  KeyReferenceCheckingBackupExportSource,
} from '../../src/environment-maintenance/commands/ClaimCustodyKeyReferenceVerifier.js';
import { frameBackupProtectedSecretEnvelope } from '../../src/coordination/backupProtectedSecretEnvelope.js';
import { ProtectedSecretCustody } from '../../src/project-authority/lifecycle/ProtectedSecretCustody.js';
import { encodeInvitationAssociatedData } from '../../src/project-authority/membership/ProjectInvitationAuthority.js';
import { encodeClaimOverrideAssociatedData } from '../../src/project-authority/membership/TransferredMembershipClaimAuthority.js';

describe('ClaimCustodyKeyReferenceVerifier', () => {
  it('requires the persisted public key that verifies a relinquished Cloud source', async () => {
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ format: 'jwk' }).x;
    const targetPublicKey = Buffer.alloc(32, 8).toString('base64url');
    assert.ok(publicKey);
    const payload = {
      batchRevision: 1,
      batchSha256: '1'.repeat(64),
      certificateAlgorithm: 'ed25519' as const,
      checkpointSha256: '2'.repeat(64),
      committedAt: '2026-09-02T00:00:00.000Z',
      operationIntentId: 'relinquish-one',
      projectId: 'project-one',
      sourceAuthority: { generation: 1, kind: 'cloud' as const },
      sourceHostMemberId: null,
      targetAuthority: { generation: 2, kind: 'lan' as const },
      transferId: 'transfer-one',
    };
    const records = [{
      kind: 'lifecycle-journal',
      value: {
        direction: 'cloud-to-lan',
        operationId: payload.transferId,
        operationKind: 'authority-transfer',
      },
    }, {
      kind: 'authority-transfer-recovery',
      value: {
        relinquishmentProof: {
          ...payload,
          certificate: sign(
            null,
            Buffer.from(
              encodeCollabAuthorityRelinquishmentProofSigningInput(payload),
              'utf8',
            ),
            pair.privateKey,
          ).toString('base64url'),
        },
        sourceAuthority: { generation: 1, kind: 'cloud' },
        targetAuthority: { generation: 2, kind: 'lan' },
        targetEvidence: {
          receiptKeyId: 'lan-target-key',
          receiptPublicKey: targetPublicKey,
        },
        transferId: payload.transferId,
      },
    }, {
      kind: 'transfer-receipt-key',
      value: {
        receiptKeyId: 'cloud-source-key',
        receiptPublicKey: publicKey,
        transferId: payload.transferId,
      },
    }, {
      kind: 'transfer-receipt-key',
      value: {
        receiptKeyId: 'lan-target-key',
        receiptPublicKey: targetPublicKey,
        transferId: payload.transferId,
      },
    }];
    const verifier = new ClaimCustodyKeyReferenceVerifier({
      custody: { open: () => Promise.resolve('unused') },
      keyring: {
        assertReferences() {},
        assertReceiptPublicKey() {},
      },
    });

    await verifier.verify(records);
    await assert.rejects(
      verifier.verify(records.filter(record => record.kind !== 'transfer-receipt-key')),
      /claim-custody-key-reference\.error\.invalid-record/u,
    );
  });

  it('rejects a Cloud source proof signed by the LAN target key', async () => {
    const cloudSource = generateKeyPairSync('ed25519');
    const lanTarget = generateKeyPairSync('ed25519');
    const cloudSourcePublicKey = cloudSource.publicKey.export({ format: 'jwk' }).x;
    const lanTargetPublicKey = lanTarget.publicKey.export({ format: 'jwk' }).x;
    assert.ok(cloudSourcePublicKey);
    assert.ok(lanTargetPublicKey);
    const payload = {
      batchRevision: 1,
      batchSha256: '5'.repeat(64),
      certificateAlgorithm: 'ed25519' as const,
      checkpointSha256: '6'.repeat(64),
      committedAt: '2026-09-02T02:00:00.000Z',
      operationIntentId: 'relinquish-wrong-signer',
      projectId: 'project-wrong-signer',
      sourceAuthority: { generation: 1, kind: 'cloud' as const },
      sourceHostMemberId: null,
      targetAuthority: { generation: 2, kind: 'lan' as const },
      transferId: 'transfer-wrong-signer',
    };
    const records = [{
      kind: 'lifecycle-journal',
      value: {
        direction: 'cloud-to-lan',
        operationId: payload.transferId,
        operationKind: 'authority-transfer',
      },
    }, {
      kind: 'authority-transfer-recovery',
      value: {
        relinquishmentProof: {
          ...payload,
          certificate: sign(
            null,
            Buffer.from(
              encodeCollabAuthorityRelinquishmentProofSigningInput(payload),
              'utf8',
            ),
            lanTarget.privateKey,
          ).toString('base64url'),
        },
        sourceAuthority: { generation: 1, kind: 'cloud' },
        targetAuthority: { generation: 2, kind: 'lan' },
        targetEvidence: {
          receiptKeyId: 'lan-target-key',
          receiptPublicKey: lanTargetPublicKey,
        },
        transferId: payload.transferId,
      },
    }, {
      kind: 'transfer-receipt-key',
      value: {
        receiptKeyId: 'cloud-source-key',
        receiptPublicKey: cloudSourcePublicKey,
        transferId: payload.transferId,
      },
    }, {
      kind: 'transfer-receipt-key',
      value: {
        receiptKeyId: 'lan-target-key',
        receiptPublicKey: lanTargetPublicKey,
        transferId: payload.transferId,
      },
    }];
    const verifier = new ClaimCustodyKeyReferenceVerifier({
      custody: { open: () => Promise.resolve('unused') },
      keyring: {
        assertReferences() {},
        assertReceiptPublicKey() {},
      },
    });

    await assert.rejects(
      verifier.verify(records),
      /claim-custody-key-reference\.error\.invalid-record/u,
    );
  });

  it('does not verify a LAN source proof with the Cloud target receipt key', async () => {
    const lanSource = generateKeyPairSync('ed25519');
    const cloudTarget = generateKeyPairSync('ed25519');
    const cloudTargetPublicKey = cloudTarget.publicKey.export({ format: 'jwk' }).x;
    assert.ok(cloudTargetPublicKey);
    const payload = {
      batchRevision: 1,
      batchSha256: '3'.repeat(64),
      certificateAlgorithm: 'ed25519' as const,
      checkpointSha256: '4'.repeat(64),
      committedAt: '2026-09-02T01:00:00.000Z',
      operationIntentId: 'relinquish-lan-source',
      projectId: 'project-lan-source',
      sourceAuthority: { generation: 1, kind: 'lan' as const },
      sourceHostMemberId: 'member-lan-source',
      targetAuthority: { generation: 2, kind: 'cloud' as const },
      transferId: 'transfer-lan-source',
    };
    const proof = {
      ...payload,
      certificate: sign(
        null,
        Buffer.from(
          encodeCollabAuthorityRelinquishmentProofSigningInput(payload),
          'utf8',
        ),
        lanSource.privateKey,
      ).toString('base64url'),
    };
    const records = [{
      kind: 'lifecycle-journal',
      value: {
        direction: 'lan-to-cloud',
        operationId: payload.transferId,
        operationKind: 'authority-transfer',
      },
    }, {
      kind: 'authority-transfer-recovery',
      value: {
        relinquishmentProof: proof,
        sourceAuthority: { generation: 1, kind: 'lan' },
        sourceEvidence: {
          receiptKeyId: 'cloud-target-key',
          receiptPublicKey: cloudTargetPublicKey,
        },
        targetAuthority: { generation: 2, kind: 'cloud' },
        transferId: payload.transferId,
      },
    }, {
      kind: 'transfer-receipt-key',
      value: {
        receiptKeyId: 'cloud-target-key',
        receiptPublicKey: cloudTargetPublicKey,
        transferId: payload.transferId,
      },
    }];
    const references: unknown[] = [];
    const publicKeys: unknown[] = [];
    const verifier = new ClaimCustodyKeyReferenceVerifier({
      custody: { open: () => Promise.resolve('unused') },
      keyring: {
        assertReferences: input => references.push(input),
        assertReceiptPublicKey: (keyId, publicKey) => {
          publicKeys.push({ keyId, publicKey });
        },
      },
    });

    await verifier.verify(records);
    assert.deepEqual(references, [{
      encryptionKeyIds: [],
      receiptKeyIds: ['cloud-target-key'],
    }]);
    assert.deepEqual(publicKeys, [{
      keyId: 'cloud-target-key',
      publicKey: cloudTargetPublicKey,
    }]);
    await verifier.verify(records.filter(record => record.kind !== 'transfer-receipt-key'));
    await assert.rejects(
      verifier.verify([{
        ...records[1],
        value: {
          ...(records[1]?.value as Record<string, unknown>),
          transferId: 'different-transfer',
        },
      }, records[0] as NonNullable<typeof records[0]>,
      records[2] as NonNullable<typeof records[2]>]),
      /claim-custody-key-reference\.error\.invalid-record/u,
    );
  });

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
        kind: 'authority-transfer-recovery',
        value: {
          relinquishmentProof: null,
          sourceAuthority: { generation: 1, kind: 'lan' },
          sourceEvidence: {
            receiptKeyId: 'receipt-2',
            receiptPublicKey: Buffer.alloc(32, 2).toString('base64url'),
          },
          targetAuthority: { generation: 2, kind: 'cloud' },
          transferId: 'transfer-2',
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

  it('opens retained Cloud-to-LAN terminal claims after recovery removal', async () => {
    const calls: unknown[] = [];
    const opened: unknown[] = [];
    const verifier = new ClaimCustodyKeyReferenceVerifier({
      custody: {
        open: envelope => {
          opened.push(envelope);
          return Promise.resolve('opaque-claim');
        },
      },
      keyring: {
        assertReferences: input => calls.push(input),
        assertReceiptPublicKey: () => assert.fail(
          'the LAN target key is not a Cloud signing key',
        ),
      },
    });
    const envelope = {
      keyId: 'encryption-terminal',
      receiptKeyId: 'lan-target-key',
      transferId: 'transfer-terminal',
    };

    const terminalRecords = [{
      kind: 'lifecycle-journal',
      value: {
        direction: 'cloud-to-lan',
        operationId: 'transfer-terminal',
        operationKind: 'authority-transfer',
      },
    }, {
      kind: 'transfer-receipt-key',
      value: {
        receiptKeyId: 'lan-target-key',
        receiptPublicKey: Buffer.alloc(32, 4).toString('base64url'),
        transferId: 'transfer-terminal',
      },
    }, {
      kind: 'protected-claim-envelope',
      value: envelope,
    }];

    await verifier.verify(terminalRecords, 'terminal');

    assert.deepEqual(calls, [{
      encryptionKeyIds: ['encryption-terminal'],
      receiptKeyIds: [],
    }]);
    assert.deepEqual(opened, [envelope]);

    await assert.rejects(
      verifier.verify([terminalRecords[0] as NonNullable<
        typeof terminalRecords[0]
      >, {
        kind: 'authority-transfer-recovery',
        value: {
          relinquishmentProof: null,
          sourceAuthority: { generation: 1, kind: 'cloud' },
          targetAuthority: { generation: 2, kind: 'lan' },
          targetEvidence: null,
          transferId: 'transfer-terminal',
        },
      }, ...terminalRecords.slice(1)]),
      /claim-custody-key-reference\.error\.invalid-record/u,
    );
  });

  it('uses an acknowledged terminal receipt after every envelope is scrubbed', async () => {
    const calls: unknown[] = [];
    const verifier = new ClaimCustodyKeyReferenceVerifier({
      custody: { open: () => assert.fail('no protected envelope remains') },
      keyring: {
        assertReferences: input => calls.push(input),
        assertReceiptPublicKey: () => assert.fail(
          'the LAN target key is not a Cloud signing key',
        ),
      },
    });

    const terminalRecords = [{
      kind: 'lifecycle-journal',
      value: {
        direction: 'cloud-to-lan',
        operationId: 'transfer-redeemed',
        operationKind: 'authority-transfer',
      },
    }, {
      kind: 'transfer-receipt-key',
      value: {
        receiptKeyId: 'lan-target-key',
        receiptPublicKey: Buffer.alloc(32, 4).toString('base64url'),
        transferId: 'transfer-redeemed',
      },
    }, {
      kind: 'transfer-redemption-receipt',
      value: {
        acknowledgedAt: '2026-09-04T00:00:00.000Z',
        receipt: {
          receiptKeyId: 'lan-target-key',
          transferId: 'transfer-redeemed',
        },
      },
    }];

    await verifier.verify(terminalRecords, 'terminal');

    assert.deepEqual(calls, [{
      encryptionKeyIds: [],
      receiptKeyIds: [],
    }]);
    await assert.rejects(
      verifier.verify([...terminalRecords, {
        kind: 'transfer-receipt-key',
        value: {
          receiptKeyId: 'orphan-cloud-source-key',
          receiptPublicKey: Buffer.alloc(32, 5).toString('base64url'),
          transferId: 'transfer-redeemed',
        },
      }], 'terminal'),
      /claim-custody-key-reference\.error\.invalid-record/u,
    );

    for (const records of [[{
      kind: 'lifecycle-journal',
      value: {
        direction: 'cloud-to-lan',
        operationId: 'transfer-unacknowledged',
        operationKind: 'authority-transfer',
      },
    }, {
      kind: 'transfer-redemption-receipt',
      value: {
        acknowledgedAt: null,
        receipt: {
          receiptKeyId: 'lan-target-key',
          transferId: 'transfer-unacknowledged',
        },
      },
    }], [{
      kind: 'lifecycle-journal',
      value: {
        direction: 'lan-to-cloud',
        operationId: 'transfer-wrong-direction',
        operationKind: 'authority-transfer',
      },
    }, {
      kind: 'transfer-redemption-receipt',
      value: {
        acknowledgedAt: '2026-09-04T00:00:00.000Z',
        receipt: {
          receiptKeyId: 'lan-target-key',
          transferId: 'transfer-wrong-direction',
        },
      },
    }]]) {
      await assert.rejects(
        verifier.verify(records, 'terminal'),
        /claim-custody-key-reference\.error\.invalid-record/u,
      );
    }
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
