import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  encodeCollabProtectedClaimAssociatedData,
  isCollabOpaqueId,
} from '@claudian-collab/protocol';

import type { ProtectedClaimEnvelopeInput } from '../../../coordination/PortabilityLifecyclePersistence.js';
import type { CloudToLanClaimCustodyPort } from './CloudToLanTransferCoordinator.js';

export type XChaCha20ClaimCustodyErrorCode =
  | 'authentication-failed'
  | 'invalid-envelope'
  | 'invalid-keyring';

export class XChaCha20ClaimCustodyError extends Error {
  readonly code: XChaCha20ClaimCustodyErrorCode;

  constructor(code: XChaCha20ClaimCustodyErrorCode) {
    super(`xchacha20-claim-custody.error.${code}`);
    this.name = 'XChaCha20ClaimCustodyError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
    });
  }
}

export interface XChaCha20ClaimCustodyKey {
  readonly key: Uint8Array;
  readonly keyId: string;
  readonly keyVersion: number;
}

export interface XChaCha20ClaimCustodyOptions {
  readonly activeKeyId: string;
  readonly keys: readonly XChaCha20ClaimCustodyKey[];
  readonly nonceFactory?: () => Uint8Array;
}

type OpenProtectedClaimEnvelope = Omit<
  ProtectedClaimEnvelopeInput,
  'createdAt'
> & Readonly<{ readonly createdAt?: string }>;

interface StoredKey {
  readonly key: Buffer;
  readonly keyId: string;
  readonly keyVersion: number;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const XCHACHA_KEY_BYTES = 32;
const XCHACHA_NONCE_BYTES = 24;
const POLY1305_TAG_BYTES = 16;
const CHACHA_CONSTANTS = new Uint32Array([
  0x6170_7865,
  0x3320_646e,
  0x7962_2d32,
  0x6b20_6574,
]);

function fail(code: XChaCha20ClaimCustodyErrorCode): never {
  throw new XChaCha20ClaimCustodyError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactDigest(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalBase64url(value: unknown, byteLength?: number): value is string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return (byteLength === undefined || decoded.byteLength === byteLength)
    && decoded.toString('base64url') === value;
}

function rotateLeft(value: number, count: number): number {
  return ((value << count) | (value >>> (32 - count))) >>> 0;
}

function word(state: Uint32Array, index: number): number {
  const value = state[index];
  if (value === undefined) return fail('invalid-keyring');
  return value;
}

function quarterRound(
  state: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
): void {
  state[a] = (word(state, a) + word(state, b)) >>> 0;
  state[d] = rotateLeft(word(state, d) ^ word(state, a), 16);
  state[c] = (word(state, c) + word(state, d)) >>> 0;
  state[b] = rotateLeft(word(state, b) ^ word(state, c), 12);
  state[a] = (word(state, a) + word(state, b)) >>> 0;
  state[d] = rotateLeft(word(state, d) ^ word(state, a), 8);
  state[c] = (word(state, c) + word(state, d)) >>> 0;
  state[b] = rotateLeft(word(state, b) ^ word(state, c), 7);
}

function hChaCha20(key: Buffer, nonce: Buffer): Buffer {
  if (key.byteLength !== XCHACHA_KEY_BYTES || nonce.byteLength !== 16) {
    return fail('invalid-keyring');
  }
  const state = new Uint32Array(16);
  state.set(CHACHA_CONSTANTS, 0);
  for (let index = 0; index < 8; index += 1) {
    state[index + 4] = key.readUInt32LE(index * 4);
  }
  for (let index = 0; index < 4; index += 1) {
    state[index + 12] = nonce.readUInt32LE(index * 4);
  }
  for (let round = 0; round < 10; round += 1) {
    quarterRound(state, 0, 4, 8, 12);
    quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14);
    quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15);
    quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13);
    quarterRound(state, 3, 4, 9, 14);
  }
  const result = Buffer.alloc(XCHACHA_KEY_BYTES);
  for (const [output, source] of [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 12],
    [5, 13],
    [6, 14],
    [7, 15],
  ] as const) {
    result.writeUInt32LE(state[source] as number, output * 4);
  }
  state.fill(0);
  return result;
}

function ietfNonce(nonce: Buffer): Buffer {
  if (nonce.byteLength !== XCHACHA_NONCE_BYTES) return fail('invalid-envelope');
  return Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]);
}

function associatedData(input: ProtectedClaimEnvelopeInput['associatedData']): string {
  try {
    return encodeCollabProtectedClaimAssociatedData(input);
  } catch {
    return fail('invalid-envelope');
  }
}

export class XChaCha20ClaimCustody implements CloudToLanClaimCustodyPort {
  readonly #active: StoredKey;
  readonly #keys = new Map<string, StoredKey>();
  readonly #nonceFactory: () => Uint8Array;

  constructor(options: XChaCha20ClaimCustodyOptions) {
    if (!isCollabOpaqueId(options.activeKeyId) || options.keys.length === 0) {
      throw new XChaCha20ClaimCustodyError('invalid-keyring');
    }
    for (const candidate of options.keys) {
      if (
        !isCollabOpaqueId(candidate.keyId)
        || !Number.isSafeInteger(candidate.keyVersion)
        || candidate.keyVersion <= 0
        || candidate.key.byteLength !== XCHACHA_KEY_BYTES
        || this.#keys.has(candidate.keyId)
      ) {
        throw new XChaCha20ClaimCustodyError('invalid-keyring');
      }
      this.#keys.set(candidate.keyId, Object.freeze({
        key: Buffer.from(candidate.key),
        keyId: candidate.keyId,
        keyVersion: candidate.keyVersion,
      }));
    }
    const active = this.#keys.get(options.activeKeyId);
    if (active === undefined) {
      throw new XChaCha20ClaimCustodyError('invalid-keyring');
    }
    this.#active = active;
    this.#nonceFactory = options.nonceFactory ?? (() => randomBytes(XCHACHA_NONCE_BYTES));
  }

  seal(input: Readonly<{
    readonly associatedData: ProtectedClaimEnvelopeInput['associatedData'];
    readonly claim: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly receiptKeyId: string;
  }>): Promise<ProtectedClaimEnvelopeInput> {
    try {
      if (!canonicalBase64url(input.claim) || !isCollabOpaqueId(input.receiptKeyId)) {
        return Promise.reject(new XChaCha20ClaimCustodyError('invalid-envelope'));
      }
      const nonce = Buffer.from(this.#nonceFactory());
      if (nonce.byteLength !== XCHACHA_NONCE_BYTES) {
        return Promise.reject(new XChaCha20ClaimCustodyError('invalid-keyring'));
      }
      const encodedAssociatedData = associatedData(input.associatedData);
      const aad = Buffer.from(encodedAssociatedData, 'utf8');
      const plaintext = Buffer.from(input.claim, 'utf8');
      const subkey = hChaCha20(this.#active.key, nonce.subarray(0, 16));
      try {
        const cipher = createCipheriv(
          'chacha20-poly1305',
          subkey,
          ietfNonce(nonce),
          { authTagLength: POLY1305_TAG_BYTES },
        );
        cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Promise.resolve(Object.freeze({
          associatedData: input.associatedData,
          associatedDataSha256: sha256(encodedAssociatedData),
          ciphertext: ciphertext.toString('base64url'),
          createdAt: input.createdAt,
          encryptionAlgorithm: 'xchacha20-poly1305' as const,
          expiresAt: input.expiresAt,
          keyId: this.#active.keyId,
          keyVersion: this.#active.keyVersion,
          memberId: input.associatedData.memberId,
          nonce: nonce.toString('base64url'),
          receiptKeyId: input.receiptKeyId,
          tag: tag.toString('base64url'),
          transferId: input.associatedData.transferId,
        }));
      } finally {
        subkey.fill(0);
        plaintext.fill(0);
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof XChaCha20ClaimCustodyError
        ? error
        : new XChaCha20ClaimCustodyError('authentication-failed'));
    }
  }

  open(envelope: OpenProtectedClaimEnvelope): Promise<string> {
    try {
      const key = this.#keys.get(envelope.keyId);
      const encodedAssociatedData = associatedData(envelope.associatedData);
      if (
        key === undefined
        || key.keyVersion !== envelope.keyVersion
        || (envelope as { readonly encryptionAlgorithm?: unknown })
          .encryptionAlgorithm !== 'xchacha20-poly1305'
        || envelope.memberId !== envelope.associatedData.memberId
        || envelope.transferId !== envelope.associatedData.transferId
        || !exactDigest(
          envelope.associatedDataSha256,
          sha256(encodedAssociatedData),
        )
        || !canonicalBase64url(envelope.nonce, XCHACHA_NONCE_BYTES)
        || !canonicalBase64url(envelope.tag, POLY1305_TAG_BYTES)
        || !canonicalBase64url(envelope.ciphertext)
      ) return Promise.reject(new XChaCha20ClaimCustodyError('invalid-envelope'));
      const nonce = Buffer.from(envelope.nonce, 'base64url');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
      const subkey = hChaCha20(key.key, nonce.subarray(0, 16));
      try {
        const decipher = createDecipheriv(
          'chacha20-poly1305',
          subkey,
          ietfNonce(nonce),
          { authTagLength: POLY1305_TAG_BYTES },
        );
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
        decipher.setAAD(Buffer.from(encodedAssociatedData, 'utf8'), {
          plaintextLength: ciphertext.byteLength,
        });
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        const claim = plaintext.toString('utf8');
        plaintext.fill(0);
        if (!canonicalBase64url(claim)) return fail('authentication-failed');
        return Promise.resolve(claim);
      } finally {
        subkey.fill(0);
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof XChaCha20ClaimCustodyError
        ? error
        : new XChaCha20ClaimCustodyError('authentication-failed'));
    }
  }
}
