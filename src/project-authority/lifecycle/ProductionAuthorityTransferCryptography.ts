import {
  constants,
  createPublicKey,
  sign,
  verify,
  X509Certificate,
} from 'node:crypto';

import {
  encodeCollabAuthorityRelinquishmentProofSigningInput,
  encodeCollabCloudToLanTargetCleanupProofSigningInput,
  encodeCollabTransferredMembershipRedemptionReceiptSigningInput,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import type { ClaimCustodyKeyringConfig } from '../../config/ClaimCustodyKeyringConfig.js';
import type {
  CloudToLanRelinquishmentSigner,
  CloudToLanTargetTrustPort,
  VerifiedCloudToLanTarget,
} from './cloud-to-lan/CloudToLanTransferCoordinator.js';
import type {
  LanToCloudReceiptSigner,
  LanToCloudSourceTrustPort,
  VerifiedLanToCloudSourceProof,
} from './lan-to-cloud/LanToCloudTransferCoordinator.js';
import { isDurableAuthorityTransferProof } from './AuthorityTransferProof.js';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_CERTIFICATE_BYTES = 64 * 1_024;

interface TargetProofEnvelope {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly certificate: string;
  readonly payload: Readonly<{
    readonly projectId: string;
    readonly receiptKeyId: string;
    readonly receiptPublicKey: string;
    readonly targetAuthorityGeneration: number;
    readonly targetHostMemberId: string;
    readonly targetUrl: string;
    readonly transferCredential: string;
    readonly transferId: string;
  }>;
  readonly schemaVersion: 1;
}

interface SourceProofEnvelope {
  readonly caCertificatePem: string;
  readonly certificate: string;
  readonly payload: Readonly<{
    readonly checkpointManifestSha256: string;
    readonly projectId: string;
    readonly sourceAuthorityGeneration: number;
    readonly sourceHostMemberId: string;
    readonly sourcePrincipalId: string;
    readonly targetAuthorityGeneration: number;
    readonly targetUrl: string;
    readonly transferId: string;
  }>;
  readonly receiptKeyId: string;
  readonly receiptPublicKey: string;
  readonly schemaVersion: 2;
}

function fail(): never {
  throw new Error('production-authority-transfer-cryptography.invalid-proof');
}

function asynchronous<T>(operation: () => T): Promise<T> {
  return Promise.resolve().then(operation);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const exact = [...expected].sort();
  return keys.length === exact.length
    && keys.every((key, index) => key === exact[index]);
}

function canonicalBase64url(
  value: unknown,
  expectedBytes?: number,
): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !BASE64URL_PATTERN.test(value)
  ) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value
    && (expectedBytes === undefined || bytes.byteLength === expectedBytes);
}

function canonicalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function certificate(value: string, fingerprint?: string): X509Certificate {
  if (Buffer.byteLength(value, 'utf8') > MAXIMUM_CERTIFICATE_BYTES) return fail();
  try {
    const parsed = new X509Certificate(value);
    const actualFingerprint = parsed.fingerprint256.replaceAll(':', '').toLowerCase();
    if (
      !parsed.ca
      || parsed.publicKey.asymmetricKeyType !== 'rsa'
      || !parsed.verify(parsed.publicKey)
      || (fingerprint !== undefined && actualFingerprint !== fingerprint)
    ) return fail();
    return parsed;
  } catch {
    return fail();
  }
}

function parseEnvelope(value: string): unknown {
  if (!isDurableAuthorityTransferProof(value) || !canonicalBase64url(value)) {
    return fail();
  }
  const bytes = Buffer.from(value, 'base64url');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail();
  }
}

function verifyRsaPss(
  caCertificatePem: string,
  signature: string,
  signingInput: string,
  fingerprint?: string,
): void {
  if (
    !canonicalBase64url(signature)
    || Buffer.from(signature, 'base64url').byteLength > 2_048
  ) return fail();
  const authority = certificate(caCertificatePem, fingerprint);
  if (!verify(
    'sha256',
    Buffer.from(signingInput, 'utf8'),
    {
      key: authority.publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    },
    Buffer.from(signature, 'base64url'),
  )) return fail();
}

function sourceEnvelope(value: string): SourceProofEnvelope {
  const decoded = parseEnvelope(value);
  if (!record(decoded) || !exactKeys(decoded, [
    'caCertificatePem',
    'certificate',
    'payload',
    'receiptKeyId',
    'receiptPublicKey',
    'schemaVersion',
  ]) || decoded.schemaVersion !== 2 || !record(decoded.payload)) return fail();
  const payload = decoded.payload;
  if (
    !exactKeys(payload, [
      'checkpointManifestSha256',
      'projectId',
      'sourceAuthorityGeneration',
      'sourceHostMemberId',
      'sourcePrincipalId',
      'targetAuthorityGeneration',
      'targetUrl',
      'transferId',
    ])
    || typeof decoded.caCertificatePem !== 'string'
    || typeof decoded.certificate !== 'string'
    || typeof decoded.receiptKeyId !== 'string'
    || !isCollabOpaqueId(decoded.receiptKeyId)
    || !canonicalBase64url(decoded.receiptPublicKey, 32)
    || !SHA256_PATTERN.test(String(payload.checkpointManifestSha256))
    || !isCollabProjectId(payload.projectId)
    || !positiveInteger(payload.sourceAuthorityGeneration)
    || typeof payload.sourceHostMemberId !== 'string'
    || !isCollabOpaqueId(payload.sourceHostMemberId)
    || typeof payload.sourcePrincipalId !== 'string'
    || !PRINCIPAL_PATTERN.test(payload.sourcePrincipalId)
    || !positiveInteger(payload.targetAuthorityGeneration)
    || payload.targetAuthorityGeneration !== payload.sourceAuthorityGeneration + 1
    || !canonicalUrl(payload.targetUrl)
    || typeof payload.transferId !== 'string'
    || !isCollabOpaqueId(payload.transferId)
  ) return fail();
  const signed = JSON.stringify({
    payload: {
      checkpointManifestSha256: payload.checkpointManifestSha256,
      projectId: payload.projectId,
      sourceAuthorityGeneration: payload.sourceAuthorityGeneration,
      sourceHostMemberId: payload.sourceHostMemberId,
      sourcePrincipalId: payload.sourcePrincipalId,
      targetAuthorityGeneration: payload.targetAuthorityGeneration,
      targetUrl: payload.targetUrl,
      transferId: payload.transferId,
    },
    receiptKeyId: decoded.receiptKeyId,
    receiptPublicKey: decoded.receiptPublicKey,
    schemaVersion: 2,
  });
  verifyRsaPss(decoded.caCertificatePem, decoded.certificate, signed);
  return decoded as unknown as SourceProofEnvelope;
}

function targetEnvelope(value: string): TargetProofEnvelope {
  const decoded = parseEnvelope(value);
  if (!record(decoded) || !exactKeys(decoded, [
    'caCertificatePem',
    'caFingerprint',
    'certificate',
    'payload',
    'schemaVersion',
  ]) || decoded.schemaVersion !== 1 || !record(decoded.payload)) return fail();
  const payload = decoded.payload;
  if (
    !exactKeys(payload, [
      'projectId',
      'receiptKeyId',
      'receiptPublicKey',
      'targetAuthorityGeneration',
      'targetHostMemberId',
      'targetUrl',
      'transferCredential',
      'transferId',
    ])
    || typeof decoded.caCertificatePem !== 'string'
    || typeof decoded.caFingerprint !== 'string'
    || !SHA256_PATTERN.test(decoded.caFingerprint)
    || typeof decoded.certificate !== 'string'
    || !isCollabProjectId(payload.projectId)
    || typeof payload.receiptKeyId !== 'string'
    || !isCollabOpaqueId(payload.receiptKeyId)
    || !canonicalBase64url(payload.receiptPublicKey, 32)
    || !positiveInteger(payload.targetAuthorityGeneration)
    || typeof payload.targetHostMemberId !== 'string'
    || !isCollabOpaqueId(payload.targetHostMemberId)
    || !canonicalUrl(payload.targetUrl)
    || !canonicalBase64url(payload.transferCredential, 32)
    || typeof payload.transferId !== 'string'
    || !isCollabOpaqueId(payload.transferId)
  ) return fail();
  const signed = JSON.stringify({
    projectId: payload.projectId,
    receiptKeyId: payload.receiptKeyId,
    receiptPublicKey: payload.receiptPublicKey,
    targetAuthorityGeneration: payload.targetAuthorityGeneration,
    targetHostMemberId: payload.targetHostMemberId,
    targetUrl: payload.targetUrl,
    transferCredential: payload.transferCredential,
    transferId: payload.transferId,
  });
  verifyRsaPss(
    decoded.caCertificatePem,
    decoded.certificate,
    signed,
    decoded.caFingerprint,
  );
  return decoded as unknown as TargetProofEnvelope;
}

function verifyEd25519(
  publicKey: string,
  signingInput: string,
  signature: string,
): void {
  if (!canonicalBase64url(publicKey, 32) || !canonicalBase64url(signature, 64)) {
    return fail();
  }
  try {
    const key = createPublicKey({
      format: 'jwk',
      key: { crv: 'Ed25519', kty: 'OKP', x: publicKey },
    });
    if (!verify(
      null,
      Buffer.from(signingInput, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    )) return fail();
  } catch {
    return fail();
  }
}

/** Verifies LAN proof envelopes and Protocol-owned Ed25519 proof payloads. */
export class ProductionAuthorityTransferTrust
implements CloudToLanTargetTrustPort, LanToCloudSourceTrustPort {
  readonly #sourceKeys = new WeakMap<VerifiedLanToCloudSourceProof, Readonly<{
    readonly receiptKeyId: string;
    readonly receiptPublicKey: string;
  }>>();

  verifySourceProof(input: Readonly<{
    readonly principalId: string;
    readonly proof: string;
  }>): Promise<VerifiedLanToCloudSourceProof> {
    return asynchronous(() => {
      if (!PRINCIPAL_PATTERN.test(input.principalId)) return fail();
      const envelope = sourceEnvelope(input.proof);
      if (envelope.payload.sourcePrincipalId !== input.principalId) return fail();
      const verified: VerifiedLanToCloudSourceProof = Object.freeze({
        authorityFingerprint: certificate(envelope.caCertificatePem).fingerprint256.replaceAll(':', '').toLowerCase(),
        checkpointManifestSha256: envelope.payload.checkpointManifestSha256,
        projectId: envelope.payload.projectId,
        sourceAuthorityGeneration: envelope.payload.sourceAuthorityGeneration,
        sourceHostMemberId: envelope.payload.sourceHostMemberId,
        targetAuthorityGeneration: envelope.payload.targetAuthorityGeneration,
        targetUrl: envelope.payload.targetUrl,
        transferId: envelope.payload.transferId,
      });
      this.#sourceKeys.set(verified, Object.freeze({
        receiptKeyId: envelope.receiptKeyId,
        receiptPublicKey: envelope.receiptPublicKey,
      }));
      return verified;
    });
  }

  verifyRelinquishmentProof(input: Parameters<
    LanToCloudSourceTrustPort['verifyRelinquishmentProof']
  >[0]): Promise<void> {
    return asynchronous(() => {
      const key = this.#sourceKeys.get(input.sourceProof);
      if (key === undefined) return fail();
      const { certificate, ...payload } = input.proof;
      verifyEd25519(
        key.receiptPublicKey,
        encodeCollabAuthorityRelinquishmentProofSigningInput(payload),
        certificate,
      );
    });
  }

  verifyAcceptance(input: Parameters<
    CloudToLanTargetTrustPort['verifyAcceptance']
  >[0]): Promise<VerifiedCloudToLanTarget> {
    return asynchronous(() => {
      if (!PRINCIPAL_PATTERN.test(input.principalId)) return fail();
      const envelope = targetEnvelope(input.request.targetProof);
      const payload = envelope.payload;
      if (
        payload.projectId !== input.request.projectId
        || payload.transferId !== input.request.transferId
        || payload.targetHostMemberId !== input.request.targetHostMemberId
        || payload.targetAuthorityGeneration !== input.targetAuthority.generation
        || payload.targetUrl !== input.targetUrl
        || input.sourceAuthority.generation + 1 !== input.targetAuthority.generation
      ) return fail();
      return Object.freeze({
        authorityFingerprint: envelope.caFingerprint,
        principalId: input.principalId,
        projectId: payload.projectId,
        receiptKeyId: payload.receiptKeyId,
        receiptPublicKey: payload.receiptPublicKey,
        targetAuthority: input.targetAuthority,
        targetHostMemberId: payload.targetHostMemberId,
        targetUrl: payload.targetUrl,
        transferId: payload.transferId,
      });
    });
  }

  verifyStaged(input: Parameters<
    CloudToLanTargetTrustPort['verifyStaged']
  >[0]): Promise<void> {
    return asynchronous(() => {
      const envelope = targetEnvelope(input.request.targetProof);
      const payload = envelope.payload;
      if (
        envelope.caFingerprint !== input.target.authorityFingerprint
        || payload.projectId !== input.target.projectId
        || payload.transferId !== input.target.transferId
        || payload.targetHostMemberId !== input.target.targetHostMemberId
        || payload.targetAuthorityGeneration !== input.target.targetAuthority.generation
        || payload.targetUrl !== input.target.targetUrl
        || payload.receiptKeyId !== input.target.receiptKeyId
        || payload.receiptPublicKey !== input.target.receiptPublicKey
      ) return fail();
    });
  }

  verifyActivation(input: Parameters<
    CloudToLanTargetTrustPort['verifyActivation']
  >[0]): Promise<void> {
    return asynchronous(() => {
      const proof = input.request.relinquishmentProof;
      const signingInput = JSON.stringify({
        checkpointSha256: proof.checkpointSha256,
        projectId: input.target.projectId,
        relinquishmentCertificate: proof.certificate,
        targetAuthorityGeneration: input.target.targetAuthority.generation,
        transferId: input.target.transferId,
      });
      verifyEd25519(
        input.target.receiptPublicKey,
        signingInput,
        input.request.targetActivationProof,
      );
    });
  }

  verifyCleanup(input: Parameters<
    CloudToLanTargetTrustPort['verifyCleanup']
  >[0]): Promise<void> {
    return asynchronous(() => {
      const { signature, ...payload } = input.proof;
      verifyEd25519(
        input.receiptPublicKey,
        encodeCollabCloudToLanTargetCleanupProofSigningInput(payload),
        signature,
      );
    });
  }

  verifyRedemptionReceipt(input: Parameters<
    CloudToLanTargetTrustPort['verifyRedemptionReceipt']
  >[0]): Promise<void> {
    return asynchronous(() => {
      const { signature, ...payload } = input.receipt;
      verifyEd25519(
        input.receiptPublicKey,
        encodeCollabTransferredMembershipRedemptionReceiptSigningInput(
          payload,
        ),
        signature,
      );
    });
  }
}

/** Starts with the active operator key and honors a transfer-pinned retained key. */
export class KeyringAuthorityTransferSigner
implements CloudToLanRelinquishmentSigner, LanToCloudReceiptSigner {
  readonly activeKey: LanToCloudReceiptSigner['activeKey'];
  readonly #keyring: ClaimCustodyKeyringConfig;

  constructor(keyring: ClaimCustodyKeyringConfig) {
    const active = keyring.receiptKeys.find(
      key => key.keyId === keyring.activeReceiptKeyId,
    );
    const publicKey = active?.publicKey.export({ format: 'jwk' }).x;
    if (active === undefined || typeof publicKey !== 'string') fail();
    this.#keyring = keyring;
    this.activeKey = Object.freeze({
      publicKey,
      receiptKeyId: active.keyId,
    });
  }

  sign(input: Readonly<{
    readonly receiptKeyId?: string;
    readonly signingInput: string;
  }>): Promise<string> {
    return asynchronous(() => {
      const keyId = input.receiptKeyId ?? this.activeKey.receiptKeyId;
      const key = this.#keyring.receiptKeys.find(candidate => candidate.keyId === keyId);
      if (key === undefined) return fail();
      return sign(
        null,
        Buffer.from(input.signingInput, 'utf8'),
        key.privateKey,
      ).toString('base64url');
    });
  }

  resolveReceiptKey(input: Readonly<{
    readonly candidates: readonly Readonly<{
      readonly publicKey: string;
      readonly receiptKeyId: string;
    }>[];
    readonly certificate: string;
    readonly signingInput: string;
  }>): Promise<Readonly<{
    readonly publicKey: string;
    readonly receiptKeyId: string;
  }>> {
    return asynchronous(() => {
      if (!canonicalBase64url(input.certificate, 64)) return fail();
      const signature = Buffer.from(input.certificate, 'base64url');
      const signingInput = Buffer.from(input.signingInput, 'utf8');
      const matches = input.candidates.filter(candidate => {
        if (
          !isCollabOpaqueId(candidate.receiptKeyId)
          || !canonicalBase64url(candidate.publicKey, 32)
        ) return false;
        try {
          return verify(
            null,
            signingInput,
            createPublicKey({
              format: 'jwk',
              key: { crv: 'Ed25519', kty: 'OKP', x: candidate.publicKey },
            }),
            signature,
          );
        } catch {
          return false;
        }
      });
      if (matches.length !== 1 || matches[0] === undefined) return fail();
      return Object.freeze({
        publicKey: matches[0].publicKey,
        receiptKeyId: matches[0].receiptKeyId,
      });
    });
  }
}
