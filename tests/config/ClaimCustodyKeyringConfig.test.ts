import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  CLAIM_CUSTODY_KEYRING_PATH,
  ClaimCustodyKeyringConfigError,
  decodeClaimCustodyKeyring,
  loadClaimCustodyKeyring,
} from '../../src/config/ClaimCustodyKeyringConfig.js';

function keyring(): Readonly<Record<string, unknown>> {
  const pair = generateKeyPairSync('ed25519');
  return {
    activeEncryptionKeyId: 'encryption-active',
    activeReceiptKeyId: 'receipt-active',
    encryptionKeys: [{
      key: Buffer.alloc(32, 7).toString('base64url'),
      keyId: 'encryption-active',
      keyVersion: 1,
    }],
    receiptKeys: [{
      keyId: 'receipt-active',
      keyVersion: 1,
      privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' })
        .toString('base64url'),
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' })
        .toString('base64url'),
    }],
    schemaVersion: 1,
  };
}

describe('ClaimCustodyKeyringConfig', () => {
  it('decodes strict versioned encryption and receipt keys', () => {
    const config = decodeClaimCustodyKeyring(keyring());

    assert.equal(CLAIM_CUSTODY_KEYRING_PATH,
      '/run/secrets/claudian_claim_custody_keyring');
    assert.equal(config.activeEncryptionKeyId, 'encryption-active');
    assert.equal(config.activeReceiptKeyId, 'receipt-active');
    assert.equal(config.encryptionKeys[0]?.key.byteLength, 32);
    const receiptKey = config.receiptKeys[0];
    assert.ok(receiptKey);
    assert.equal(receiptKey.privateKey.type, 'private');
    assert.equal(receiptKey.publicKey.type, 'public');
    assert.equal(Object.isFrozen(config), true);
    assert.doesNotMatch(JSON.stringify(config), /BwcHBwcH/u);
  });

  it('rejects unknown fields, duplicate keys, and missing active keys', () => {
    const valid = keyring();
    const encryptionKeys = valid.encryptionKeys as readonly unknown[];
    for (const malformed of [
      { ...valid, unexpected: true },
      { ...valid, encryptionKeys: [...encryptionKeys, ...encryptionKeys] },
      { ...valid, activeEncryptionKeyId: 'missing-encryption-key' },
      { ...valid, activeReceiptKeyId: 'missing-receipt-key' },
    ]) {
      assert.throws(
        () => decodeClaimCustodyKeyring(malformed),
        (error: unknown) => {
          assert.ok(error instanceof ClaimCustodyKeyringConfigError);
          assert.equal(error.code, 'invalid-keyring');
          assert.deepEqual(error.toJSON(), {
            code: 'invalid-keyring',
            message: 'claim-custody-keyring.error.invalid-keyring',
            name: 'ClaimCustodyKeyringConfigError',
          });
          return true;
        },
      );
    }
  });

  it('fails closed when a historical envelope or receipt key is unavailable', () => {
    const config = decodeClaimCustodyKeyring(keyring());
    const receiptJwk = config.receiptKeys[0]?.publicKey.export({ format: 'jwk' });
    assert.ok(receiptJwk?.x);

    assert.doesNotThrow(() => config.assertReferences({
      encryptionKeyIds: ['encryption-active'],
      receiptKeyIds: ['receipt-active'],
    }));
    assert.doesNotThrow(() => config.assertReceiptPublicKey(
      'receipt-active',
      receiptJwk.x as string,
    ));
    for (const references of [
      { encryptionKeyIds: ['retired-key'], receiptKeyIds: ['receipt-active'] },
      { encryptionKeyIds: ['encryption-active'], receiptKeyIds: ['retired-key'] },
    ]) {
      assert.throws(
        () => config.assertReferences(references),
        (error: unknown) => {
          assert.ok(error instanceof ClaimCustodyKeyringConfigError);
          assert.equal(error.code, 'invalid-keyring');
          assert.doesNotMatch(JSON.stringify(error), /retired-key/u);
          return true;
        },
      );
    }
    assert.throws(
      () => config.assertReceiptPublicKey(
        'receipt-active',
        Buffer.alloc(32, 9).toString('base64url'),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ClaimCustodyKeyringConfigError);
        assert.equal(error.code, 'invalid-keyring');
        return true;
      },
    );
  });

  it('reports a missing fixed-path mount without exposing the path', async () => {
    const error = await loadClaimCustodyKeyring().then(
      () => undefined,
      (failure: unknown) => failure,
    );

    assert.ok(error instanceof ClaimCustodyKeyringConfigError);
    assert.equal(error.code, 'invalid-keyring');
    assert.doesNotMatch(JSON.stringify(error), /run\/secrets/u);
  });
});
