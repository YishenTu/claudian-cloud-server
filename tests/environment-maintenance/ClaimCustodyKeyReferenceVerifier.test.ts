import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ClaimCustodyKeyReferenceVerifier,
  KeyReferenceCheckingBackupExportSource,
  KeyReferenceCheckingPublishedCheckpoint,
} from '../../src/environment-maintenance/commands/ClaimCustodyKeyReferenceVerifier.js';

describe('ClaimCustodyKeyReferenceVerifier', () => {
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

  it('checks captured and reopened checkpoint records before returning them', async () => {
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
    const published = new KeyReferenceCheckingPublishedCheckpoint({
      checkpoint: {
        readPublishedOutboundRecords: () => Promise.resolve(capturedRecords),
        reserveOutbound: () => Promise.resolve({}),
        verifyOutboundOperation: () => Promise.resolve(),
      } as never,
      verifier,
    });

    assert.equal((await source.snapshot({} as never)).records, capturedRecords);
    assert.equal(
      await published.readPublishedOutboundRecords({} as never, {} as never),
      capturedRecords,
    );
    assert.deepEqual(checked, [capturedRecords, capturedRecords]);
  });
});
