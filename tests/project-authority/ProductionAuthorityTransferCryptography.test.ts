import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  constants,
  generateKeyPairSync,
  sign,
  verify,
  X509Certificate,
} from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

import {
  decodeCollabCloudToLanTargetCleanupProof,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabAuthorityRelinquishmentProofSigningInput,
  encodeCollabCloudToLanTargetCleanupProofSigningInput,
  encodeCollabTransferredMembershipRedemptionReceiptSigningInput,
} from '@claudian-collab/protocol';

import {
  KeyringAuthorityTransferSigner,
  ProductionAuthorityTransferTrust,
} from '../../src/project-authority/lifecycle/ProductionAuthorityTransferCryptography.js';
import { decodeClaimCustodyKeyring } from '../../src/config/ClaimCustodyKeyringConfig.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = 'project-production-trust';
const TRANSFER_ID = 'transfer-production-trust';
const TARGET_MEMBER_ID = 'member-production-target';
const TARGET_URL = 'https://lan.example.test:8443';
const SOURCE_AUTHORITY = { generation: 4, kind: 'cloud' as const };
const TARGET_AUTHORITY = { generation: 5, kind: 'lan' as const };

let fixtureRoot: string;
let caCertificatePem: string;
let caPrivateKeyPem: string;

function rsaPss(value: string): string {
  return sign('sha256', Buffer.from(value, 'utf8'), {
    key: caPrivateKeyPem,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString('base64url');
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('ProductionAuthorityTransferCryptography', () => {
  before(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'claudian-production-trust-'));
    const certificatePath = join(fixtureRoot, 'ca.pem');
    const keyPath = join(fixtureRoot, 'ca-key.pem');
    await execFileAsync('/usr/bin/openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certificatePath,
      '-subj', '/CN=Claudian test authority', '-days', '1',
      '-addext', 'basicConstraints=critical,CA:TRUE',
    ]);
    [caCertificatePem, caPrivateKeyPem] = await Promise.all([
      readFile(certificatePath, 'utf8'),
      readFile(keyPath, 'utf8'),
    ]);
  });

  after(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  it('verifies exact LAN source and target proof envelopes', async () => {
    const targetReceipt = generateKeyPairSync('ed25519');
    const targetPublicKey = targetReceipt.publicKey.export({ format: 'jwk' }).x;
    assert.ok(targetPublicKey);
    const sourcePayload = {
      checkpointManifestSha256: '1'.repeat(64),
      projectId: PROJECT_ID,
      sourceAuthorityGeneration: 3,
      sourceHostMemberId: 'member-production-source',
      sourcePrincipalId: 'principal-production-source',
      targetAuthorityGeneration: 4,
      targetUrl: 'http://cloud.example.test:8787',
      transferId: TRANSFER_ID,
    };
    const sourceSigned = {
      payload: sourcePayload,
      receiptKeyId: 'receipt-source-key',
      receiptPublicKey: targetPublicKey,
      schemaVersion: 2,
    };
    const sourceProof = encoded({
      caCertificatePem,
      certificate: rsaPss(JSON.stringify(sourceSigned)),
      ...sourceSigned,
    });
    const trust = new ProductionAuthorityTransferTrust();
    const verifiedSource = await trust.verifySourceProof({
      principalId: 'principal-production-source',
      proof: sourceProof,
    });
    assert.deepEqual({ ...verifiedSource }, {
      authorityFingerprint: new X509Certificate(caCertificatePem).fingerprint256.replaceAll(':', '').toLowerCase(),
      checkpointManifestSha256: sourcePayload.checkpointManifestSha256,
      projectId: sourcePayload.projectId,
      sourceAuthorityGeneration: sourcePayload.sourceAuthorityGeneration,
      sourceHostMemberId: sourcePayload.sourceHostMemberId,
      targetAuthorityGeneration: sourcePayload.targetAuthorityGeneration,
      targetUrl: sourcePayload.targetUrl,
      transferId: sourcePayload.transferId,
    });
    await assert.rejects(trust.verifySourceProof({
      principalId: 'principal-production-attacker',
      proof: sourceProof,
    }));

    const targetPayload = {
      projectId: PROJECT_ID,
      receiptKeyId: 'receipt-target-key',
      receiptPublicKey: targetPublicKey,
      targetAuthorityGeneration: TARGET_AUTHORITY.generation,
      targetHostMemberId: TARGET_MEMBER_ID,
      targetUrl: TARGET_URL,
      transferCredential: Buffer.alloc(32, 9).toString('base64url'),
      transferId: TRANSFER_ID,
    };
    const certificate = new X509Certificate(caCertificatePem);
    const targetProof = encoded({
      caCertificatePem,
      caFingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
      certificate: rsaPss(JSON.stringify(targetPayload)),
      payload: targetPayload,
      schemaVersion: 1,
    });
    const verifiedTarget = await trust.verifyAcceptance({
      principalId: 'principal-production-target',
      request: {
        idempotencyKey: 'accept-production-target',
        projectId: PROJECT_ID,
        targetHostMemberId: TARGET_MEMBER_ID,
        targetProof,
        transferId: TRANSFER_ID,
      },
      sourceAuthority: SOURCE_AUTHORITY,
      targetAuthority: TARGET_AUTHORITY,
      targetUrl: TARGET_URL,
    });
    assert.equal(verifiedTarget.receiptPublicKey, targetPublicKey);
    assert.equal(verifiedTarget.authorityFingerprint, verifiedSource.authorityFingerprint);
    await trust.verifyStaged({
      request: {
        checkpointSha256: '2'.repeat(64),
        claimBatch: {
          batchRevision: 1,
          batchSha256: '3'.repeat(64),
          checkpointSha256: '2'.repeat(64),
          claims: [],
          expiresAt: '2026-10-01T00:00:00.000Z',
          projectId: PROJECT_ID,
          targetAuthorityGeneration: 5,
          transferId: TRANSFER_ID,
        },
        idempotencyKey: 'stage-production-target',
        projectId: PROJECT_ID,
        stageSha256: '4'.repeat(64),
        targetAuthority: TARGET_AUTHORITY,
        targetProof,
        transferId: TRANSFER_ID,
      },
      target: verifiedTarget,
    });

    await assert.rejects(trust.verifyAcceptance({
      principalId: 'principal-production-target',
      request: {
        idempotencyKey: 'accept-production-target',
        projectId: PROJECT_ID,
        targetHostMemberId: TARGET_MEMBER_ID,
        targetProof: `${targetProof}A`,
        transferId: TRANSFER_ID,
      },
      sourceAuthority: SOURCE_AUTHORITY,
      targetAuthority: TARGET_AUTHORITY,
      targetUrl: TARGET_URL,
    }));
  });

  it('rejects proof envelopes that cannot fit durable recovery evidence', async () => {
    const receipt = generateKeyPairSync('ed25519');
    const receiptPublicKey = receipt.publicKey.export({ format: 'jwk' }).x;
    assert.ok(receiptPublicKey);
    const payload = {
      checkpointManifestSha256: '1'.repeat(64),
      projectId: PROJECT_ID,
      sourceAuthorityGeneration: 3,
      sourceHostMemberId: 'member-production-source',
      sourcePrincipalId: 'principal-production-source',
      targetAuthorityGeneration: 4,
      targetUrl: 'http://cloud.example.test:8787',
      transferId: TRANSFER_ID,
    };
    const signed = {
      payload,
      receiptKeyId: 'receipt-source-key',
      receiptPublicKey,
      schemaVersion: 2,
    };
    const proof = encoded({
      caCertificatePem: `${caCertificatePem}${'\n'.repeat(4_000)}`,
      certificate: rsaPss(JSON.stringify(signed)),
      ...signed,
    });
    assert.ok(Buffer.byteLength(proof, 'utf8') > 7_000);

    await assert.rejects(new ProductionAuthorityTransferTrust().verifySourceProof({
      principalId: payload.sourcePrincipalId,
      proof,
    }));
  });

  it('uses the active keyring receipt key for canonical Cloud and target proofs', async () => {
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ format: 'jwk' }).x;
    assert.ok(publicKey);
    const keyring = decodeClaimCustodyKeyring({
      activeEncryptionKeyId: 'encryption-production-key',
      activeReceiptKeyId: 'receipt-production-key',
      encryptionKeys: [{
        key: Buffer.alloc(32, 5).toString('base64url'),
        keyId: 'encryption-production-key',
        keyVersion: 1,
      }],
      receiptKeys: [{
        keyId: 'receipt-production-key',
        keyVersion: 1,
        privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' })
          .toString('base64url'),
        publicKey: pair.publicKey.export({ format: 'der', type: 'spki' })
          .toString('base64url'),
      }],
      schemaVersion: 1,
    });
    const signer = new KeyringAuthorityTransferSigner(keyring);
    assert.deepEqual(signer.activeKey, {
      publicKey,
      receiptKeyId: 'receipt-production-key',
    });
    const trust = new ProductionAuthorityTransferTrust();
    const cleanupUnsigned = {
      batchRevision: null,
      batchSha256: null,
      checkpointSha256: '2'.repeat(64),
      cleanupSha256: '5'.repeat(64),
      invalidatedAt: '2026-09-02T00:00:00.000Z',
      operationIntentId: 'cleanup-production-target',
      projectId: PROJECT_ID,
      receiptKeyId: keyring.activeReceiptKeyId,
      signatureAlgorithm: 'ed25519' as const,
      sourceAuthority: SOURCE_AUTHORITY,
      stageSha256: null,
      targetAuthority: TARGET_AUTHORITY,
      targetHostMemberId: TARGET_MEMBER_ID,
      transferId: TRANSFER_ID,
    };
    const cleanup = decodeCollabCloudToLanTargetCleanupProof({
      ...cleanupUnsigned,
      signature: await signer.sign({
        receiptKeyId: keyring.activeReceiptKeyId,
        signingInput: encodeCollabCloudToLanTargetCleanupProofSigningInput(
          cleanupUnsigned,
        ),
      }),
    });
    await trust.verifyCleanup({ proof: cleanup, receiptPublicKey: publicKey });

    const redemptionUnsigned = {
      checkpointSha256: '2'.repeat(64),
      claimSha256: '6'.repeat(64),
      memberId: TARGET_MEMBER_ID,
      operationIntentId: 'redeem-production-member',
      projectId: PROJECT_ID,
      receiptId: 'redemption-production-receipt',
      receiptKeyId: keyring.activeReceiptKeyId,
      redeemedAt: '2026-09-02T00:00:00.000Z',
      signatureAlgorithm: 'ed25519' as const,
      targetAuthorityGeneration: TARGET_AUTHORITY.generation,
      transferId: TRANSFER_ID,
    };
    const redemption = decodeCollabTransferredMembershipRedemptionReceipt({
      ...redemptionUnsigned,
      signature: await signer.sign({
        receiptKeyId: keyring.activeReceiptKeyId,
        signingInput: encodeCollabTransferredMembershipRedemptionReceiptSigningInput(
          redemptionUnsigned,
        ),
      }),
    });
    await trust.verifyRedemptionReceipt({
      receipt: redemption,
      receiptPublicKey: publicKey,
    });

    const relinquishmentInput = encodeCollabAuthorityRelinquishmentProofSigningInput({
      batchRevision: 1,
      batchSha256: '3'.repeat(64),
      certificateAlgorithm: 'ed25519',
      checkpointSha256: '2'.repeat(64),
      committedAt: '2026-09-02T00:00:00.000Z',
      operationIntentId: 'relinquish-production-source',
      projectId: PROJECT_ID,
      sourceAuthority: SOURCE_AUTHORITY,
      sourceHostMemberId: null,
      targetAuthority: TARGET_AUTHORITY,
      transferId: TRANSFER_ID,
    });
    assert.match(await signer.sign({ signingInput: relinquishmentInput }), /^[A-Za-z0-9_-]+$/u);
  });

  it('continues an in-flight transfer with its retained receipt key after rotation', async () => {
    const retained = generateKeyPairSync('ed25519');
    const active = generateKeyPairSync('ed25519');
    const keyring = decodeClaimCustodyKeyring({
      activeEncryptionKeyId: 'encryption-production-key',
      activeReceiptKeyId: 'receipt-active-key',
      encryptionKeys: [{
        key: Buffer.alloc(32, 5).toString('base64url'),
        keyId: 'encryption-production-key',
        keyVersion: 1,
      }],
      receiptKeys: [
        {
          keyId: 'receipt-retained-key',
          keyVersion: 1,
          privateKey: retained.privateKey.export({ format: 'der', type: 'pkcs8' })
            .toString('base64url'),
          publicKey: retained.publicKey.export({ format: 'der', type: 'spki' })
            .toString('base64url'),
        },
        {
          keyId: 'receipt-active-key',
          keyVersion: 2,
          privateKey: active.privateKey.export({ format: 'der', type: 'pkcs8' })
            .toString('base64url'),
          publicKey: active.publicKey.export({ format: 'der', type: 'spki' })
            .toString('base64url'),
        },
      ],
      schemaVersion: 1,
    });
    const signer = new KeyringAuthorityTransferSigner(keyring);
    const signingInput = 'in-flight-transfer-signing-input';

    const signature = await signer.sign({
      receiptKeyId: 'receipt-retained-key',
      signingInput,
    });

    assert.equal(
      verify(
        null,
        Buffer.from(signingInput, 'utf8'),
        retained.publicKey,
        Buffer.from(signature, 'base64url'),
      ),
      true,
    );
    const retainedJwk = retained.publicKey.export({ format: 'jwk' });
    const activeJwk = active.publicKey.export({ format: 'jwk' });
    assert.ok(retainedJwk.x);
    assert.ok(activeJwk.x);
    assert.deepEqual(await signer.resolveReceiptKey({
      candidates: [{
        publicKey: retainedJwk.x,
        receiptKeyId: 'receipt-retained-key',
      }, {
        publicKey: activeJwk.x,
        receiptKeyId: 'receipt-active-key',
      }],
      certificate: signature,
      signingInput,
    }), {
      publicKey: retainedJwk.x,
      receiptKeyId: 'receipt-retained-key',
    });
  });
});
