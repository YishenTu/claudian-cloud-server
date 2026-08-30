import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { isCollabOpaqueId } from '@claudian-collab/protocol';

export type ProtectedSecretCustodyErrorCode =
  | 'authentication-failed'
  | 'invalid-envelope'
  | 'invalid-keyring';

export class ProtectedSecretCustodyError extends Error {
  readonly code: ProtectedSecretCustodyErrorCode;

  constructor(code: ProtectedSecretCustodyErrorCode) {
    super(`protected-secret-custody.error.${code}`);
    this.name = 'ProtectedSecretCustodyError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({ code: this.code, message: this.message, name: this.name });
  }
}

export interface ProtectedSecretCustodyKey {
  readonly key: Uint8Array;
  readonly keyId: string;
  readonly keyVersion: number;
}

export interface ProtectedSecretCustodyEnvelope {
  readonly algorithm: 'xchacha20-poly1305';
  readonly associatedDataSha256: string;
  readonly ciphertext: string;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly tag: string;
}

export interface ProtectedSecretCustodyOptions {
  readonly activeKeyId: string;
  readonly keys: readonly ProtectedSecretCustodyKey[];
  readonly nonceFactory?: () => Uint8Array;
}

interface StoredKey {
  readonly key: Buffer;
  readonly keyId: string;
  readonly keyVersion: number;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const CHACHA_CONSTANTS = new Uint32Array([
  0x6170_7865,
  0x3320_646e,
  0x7962_2d32,
  0x6b20_6574,
]);

function fail(code: ProtectedSecretCustodyErrorCode): never {
  throw new ProtectedSecretCustodyError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactDigest(left: string, right: string): boolean {
  return SHA256_PATTERN.test(left)
    && SHA256_PATTERN.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalBase64url(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return (bytes === undefined || decoded.byteLength === bytes)
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
  if (key.byteLength !== KEY_BYTES || nonce.byteLength !== 16) {
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
  const result = Buffer.alloc(KEY_BYTES);
  for (const [output, source] of [
    [0, 0], [1, 1], [2, 2], [3, 3],
    [4, 12], [5, 13], [6, 14], [7, 15],
  ] as const) result.writeUInt32LE(state[source] as number, output * 4);
  state.fill(0);
  return result;
}

function ietfNonce(nonce: Buffer): Buffer {
  if (nonce.byteLength !== NONCE_BYTES) return fail('invalid-envelope');
  return Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]);
}

export class ProtectedSecretCustody {
  readonly #active: StoredKey;
  readonly #keys = new Map<string, StoredKey>();
  readonly #nonceFactory: () => Uint8Array;

  constructor(options: ProtectedSecretCustodyOptions) {
    if (!isCollabOpaqueId(options.activeKeyId) || options.keys.length === 0) {
      throw new ProtectedSecretCustodyError('invalid-keyring');
    }
    for (const candidate of options.keys) {
      if (
        !isCollabOpaqueId(candidate.keyId)
        || !Number.isSafeInteger(candidate.keyVersion)
        || candidate.keyVersion <= 0
        || candidate.key.byteLength !== KEY_BYTES
        || this.#keys.has(candidate.keyId)
      ) throw new ProtectedSecretCustodyError('invalid-keyring');
      this.#keys.set(candidate.keyId, Object.freeze({
        key: Buffer.from(candidate.key),
        keyId: candidate.keyId,
        keyVersion: candidate.keyVersion,
      }));
    }
    const active = this.#keys.get(options.activeKeyId);
    if (active === undefined) throw new ProtectedSecretCustodyError('invalid-keyring');
    this.#active = active;
    this.#nonceFactory = options.nonceFactory ?? (() => randomBytes(NONCE_BYTES));
  }

  seal(input: Readonly<{
    readonly associatedData: string;
    readonly secret: string;
  }>): Promise<ProtectedSecretCustodyEnvelope> {
    try {
      if (input.associatedData.length === 0 || !canonicalBase64url(input.secret)) {
        return Promise.reject(new ProtectedSecretCustodyError('invalid-envelope'));
      }
      const nonce = Buffer.from(this.#nonceFactory());
      if (nonce.byteLength !== NONCE_BYTES) {
        return Promise.reject(new ProtectedSecretCustodyError('invalid-keyring'));
      }
      const aad = Buffer.from(input.associatedData, 'utf8');
      const plaintext = Buffer.from(input.secret, 'utf8');
      const subkey = hChaCha20(this.#active.key, nonce.subarray(0, 16));
      try {
        const cipher = createCipheriv(
          'chacha20-poly1305',
          subkey,
          ietfNonce(nonce),
          { authTagLength: TAG_BYTES },
        );
        cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return Promise.resolve(Object.freeze({
          algorithm: 'xchacha20-poly1305' as const,
          associatedDataSha256: sha256(input.associatedData),
          ciphertext: ciphertext.toString('base64url'),
          keyId: this.#active.keyId,
          keyVersion: this.#active.keyVersion,
          nonce: nonce.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
        }));
      } finally {
        subkey.fill(0);
        plaintext.fill(0);
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof ProtectedSecretCustodyError
        ? error
        : new ProtectedSecretCustodyError('authentication-failed'));
    }
  }

  open(input: Readonly<{
    readonly associatedData: string;
    readonly envelope: ProtectedSecretCustodyEnvelope;
  }>): Promise<string> {
    try {
      const key = this.#keys.get(input.envelope.keyId);
      if (
        input.associatedData.length === 0
        || key === undefined
        || key.keyVersion !== input.envelope.keyVersion
        || !exactDigest(
          input.envelope.associatedDataSha256,
          sha256(input.associatedData),
        )
        || !canonicalBase64url(input.envelope.nonce, NONCE_BYTES)
        || !canonicalBase64url(input.envelope.tag, TAG_BYTES)
        || !canonicalBase64url(input.envelope.ciphertext)
      ) return Promise.reject(new ProtectedSecretCustodyError('invalid-envelope'));
      const nonce = Buffer.from(input.envelope.nonce, 'base64url');
      const ciphertext = Buffer.from(input.envelope.ciphertext, 'base64url');
      const subkey = hChaCha20(key.key, nonce.subarray(0, 16));
      try {
        const decipher = createDecipheriv(
          'chacha20-poly1305',
          subkey,
          ietfNonce(nonce),
          { authTagLength: TAG_BYTES },
        );
        decipher.setAuthTag(Buffer.from(input.envelope.tag, 'base64url'));
        decipher.setAAD(Buffer.from(input.associatedData, 'utf8'), {
          plaintextLength: ciphertext.byteLength,
        });
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const secret = plaintext.toString('utf8');
        plaintext.fill(0);
        if (!canonicalBase64url(secret)) return fail('authentication-failed');
        return Promise.resolve(secret);
      } finally {
        subkey.fill(0);
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof ProtectedSecretCustodyError
        ? error
        : new ProtectedSecretCustodyError('authentication-failed'));
    }
  }
}
