import { generateKeyPairSync } from 'node:crypto';

import { runServerProcess } from '../../../src/composition/ServerProcess.js';
import { decodeClaimCustodyKeyring } from '../../../src/config/ClaimCustodyKeyringConfig.js';

const pair = generateKeyPairSync('ed25519');
const keyring = decodeClaimCustodyKeyring({
  activeEncryptionKeyId: 'test-encryption-key',
  activeReceiptKeyId: 'test-receipt-key',
  encryptionKeys: [{
    key: Buffer.alloc(32, 7).toString('base64url'),
    keyId: 'test-encryption-key',
    keyVersion: 1,
  }],
  receiptKeys: [{
    keyId: 'test-receipt-key',
    keyVersion: 1,
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64url'),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64url'),
  }],
  schemaVersion: 1,
});

await runServerProcess({
  loadKeyring: () => Promise.resolve(keyring),
});
