import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { describe, it } from 'node:test';

import { encodeCollabProtectedClaimAssociatedData } from '@claudian-collab/protocol';

import {
  XChaCha20ClaimCustody,
  XChaCha20ClaimCustodyError,
} from '../../src/project-authority/lifecycle/cloud-to-lan/XChaCha20ClaimCustody.js';

const CLAIM = Buffer.alloc(32, 7).toString('base64url');
const KEY = Buffer.alloc(32, 9);

function custody(key: Uint8Array = KEY): XChaCha20ClaimCustody {
  return new XChaCha20ClaimCustody({
    activeKeyId: 'claim-key-current',
    keys: [{
      key,
      keyId: 'claim-key-current',
      keyVersion: 1,
    }],
  });
}

const associatedData = Object.freeze({
  authorityGeneration: 4,
  checkpointSha256: '1'.repeat(64),
  claimSha256: '2'.repeat(64),
  envelopeVersion: 1 as const,
  environmentIdentity: 'environment-test',
  memberId: 'member-offline',
  projectId: 'project-cloud-to-lan',
  transferId: 'transfer-cloud-to-lan',
});

describe('XChaCha20ClaimCustody', () => {
  it('opens an exact envelope after restart without retaining plaintext', async () => {
    const envelope = await custody().seal({
      associatedData,
      claim: CLAIM,
      createdAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-09-26T00:00:00.000Z',
      receiptKeyId: 'receipt-key-target',
    });

    assert.equal(JSON.stringify(envelope).includes(CLAIM), false);
    assert.equal(envelope.encryptionAlgorithm, 'xchacha20-poly1305');
    assert.equal(Buffer.from(envelope.nonce, 'base64url').byteLength, 24);
    assert.equal(Buffer.from(envelope.tag, 'base64url').byteLength, 16);
    assert.equal(await custody().open(envelope), CLAIM);
  });

  it('fails closed for ciphertext, associated-data, and historical-key drift', async () => {
    const envelope = await custody().seal({
      associatedData,
      claim: CLAIM,
      createdAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-09-26T00:00:00.000Z',
      receiptKeyId: 'receipt-key-target',
    });
    const reject = (operation: Promise<unknown>) => assert.rejects(
      operation,
      (error: unknown) => error instanceof XChaCha20ClaimCustodyError,
    );

    await reject(custody().open({
      ...envelope,
      ciphertext: Buffer.alloc(32, 1).toString('base64url'),
    }));
    await reject(custody().open({
      ...envelope,
      associatedData: { ...associatedData, memberId: 'member-other' },
    }));
    await reject(custody(Buffer.alloc(32, 8)).open(envelope));
  });

  it('matches the published HChaCha20 subkey vector', async () => {
    const key = Buffer.from(
      '000102030405060708090a0b0c0d0e0f'
      + '101112131415161718191a1b1c1d1e1f',
      'hex',
    );
    const nonce = Buffer.from(
      '000000090000004a0000000031415927' + '0102030405060708',
      'hex',
    );
    const implementation = new XChaCha20ClaimCustody({
      activeKeyId: 'claim-key-current',
      keys: [{ key, keyId: 'claim-key-current', keyVersion: 1 }],
      nonceFactory: () => nonce,
    });
    const envelope = await implementation.seal({
      associatedData,
      claim: CLAIM,
      createdAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-09-26T00:00:00.000Z',
      receiptKeyId: 'receipt-key-target',
    });
    const publishedSubkey = Buffer.from(
      '82413b4227b27bfed30e42508a877d73'
      + 'a0f9e4d58a74a853c12ec41326d3ecdc',
      'hex',
    );
    const cipher = createCipheriv(
      'chacha20-poly1305',
      publishedSubkey,
      Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]),
      { authTagLength: 16 },
    );
    const plaintext = Buffer.from(CLAIM, 'utf8');
    cipher.setAAD(Buffer.from(
      encodeCollabProtectedClaimAssociatedData(associatedData),
      'utf8',
    ), { plaintextLength: plaintext.byteLength });
    const expectedCiphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]).toString('base64url');

    assert.equal(envelope.ciphertext, expectedCiphertext);
    assert.equal(envelope.tag, cipher.getAuthTag().toString('base64url'));
  });
});
