import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

import { isCollabOpaqueId } from '@claudian-collab/protocol';

export const CLAIM_CUSTODY_KEYRING_PATH =
  '/run/secrets/claudian_claim_custody_keyring';

export class ClaimCustodyKeyringConfigError extends Error {
  readonly code = 'invalid-keyring' as const;

  constructor() {
    super('claim-custody-keyring.error.invalid-keyring');
    this.name = 'ClaimCustodyKeyringConfigError';
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
    });
  }
}

export interface ClaimCustodyEncryptionKeyConfig {
  readonly key: Buffer;
  readonly keyId: string;
  readonly keyVersion: number;
}

export interface ClaimCustodyReceiptKeyConfig {
  readonly keyId: string;
  readonly keyVersion: number;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export interface ClaimCustodyKeyringConfig {
  readonly activeEncryptionKeyId: string;
  readonly activeReceiptKeyId: string;
  readonly encryptionKeys: readonly ClaimCustodyEncryptionKeyConfig[];
  readonly receiptKeys: readonly ClaimCustodyReceiptKeyConfig[];
  assertReferences(input: Readonly<{
    readonly encryptionKeyIds: readonly string[];
    readonly receiptKeyIds: readonly string[];
  }>): void;
  assertReceiptPublicKey(keyId: string, publicKey: string): void;
  toJSON(): Readonly<Record<string, string>>;
}

const DOCUMENT_KEYS = Object.freeze([
  'activeEncryptionKeyId',
  'activeReceiptKeyId',
  'encryptionKeys',
  'receiptKeys',
  'schemaVersion',
]);
const ENCRYPTION_KEY_KEYS = Object.freeze([
  'key',
  'keyId',
  'keyVersion',
]);
const RECEIPT_KEY_KEYS = Object.freeze([
  'keyId',
  'keyVersion',
  'privateKey',
  'publicKey',
]);
const KEYRING_UID = 10_001n;
const KEYRING_GID = 10_001n;
const KEYRING_MODE = 0o400;
const MAXIMUM_KEYRING_BYTES = 64 * 1_024;

function fail(): never {
  throw new ClaimCustodyKeyringConfigError();
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const exact = [...expected].sort();
  return keys.length === exact.length
    && keys.every((key, index) => key === exact[index]);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function canonicalBase64url(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) return false;
  return Buffer.from(value, 'base64url').toString('base64url') === value;
}

function encryptionKey(value: unknown): ClaimCustodyEncryptionKeyConfig {
  if (!record(value) || !exactKeys(value, ENCRYPTION_KEY_KEYS)) return fail();
  if (
    typeof value.keyId !== 'string'
    || !isCollabOpaqueId(value.keyId)
    || !positiveInteger(value.keyVersion)
    || !canonicalBase64url(value.key)
  ) return fail();
  const key = Buffer.from(value.key, 'base64url');
  if (key.byteLength !== 32) return fail();
  return Object.freeze({
    key,
    keyId: value.keyId,
    keyVersion: value.keyVersion,
  });
}

function receiptKey(value: unknown): ClaimCustodyReceiptKeyConfig {
  if (!record(value) || !exactKeys(value, RECEIPT_KEY_KEYS)) return fail();
  if (
    typeof value.keyId !== 'string'
    || !isCollabOpaqueId(value.keyId)
    || !positiveInteger(value.keyVersion)
    || !canonicalBase64url(value.privateKey)
    || !canonicalBase64url(value.publicKey)
  ) return fail();
  try {
    const privateKey = createPrivateKey({
      format: 'der',
      key: Buffer.from(value.privateKey, 'base64url'),
      type: 'pkcs8',
    });
    const publicKey = createPublicKey({
      format: 'der',
      key: Buffer.from(value.publicKey, 'base64url'),
      type: 'spki',
    });
    if (privateKey.asymmetricKeyType !== 'ed25519'
      || publicKey.asymmetricKeyType !== 'ed25519') return fail();
    const derived = createPublicKey(privateKey).export({
      format: 'der',
      type: 'spki',
    });
    const declared = publicKey.export({ format: 'der', type: 'spki' });
    if (
      derived.byteLength !== declared.byteLength
      || !timingSafeEqual(derived, declared)
    ) return fail();
    return Object.freeze({
      keyId: value.keyId,
      keyVersion: value.keyVersion,
      privateKey,
      publicKey,
    });
  } catch (error: unknown) {
    if (error instanceof ClaimCustodyKeyringConfigError) throw error;
    return fail();
  }
}

function uniqueIds(values: readonly { readonly keyId: string }[]): boolean {
  return new Set(values.map(value => value.keyId)).size === values.length;
}

export function decodeClaimCustodyKeyring(
  value: unknown,
): ClaimCustodyKeyringConfig {
  if (!record(value) || !exactKeys(value, DOCUMENT_KEYS)) return fail();
  if (
    value.schemaVersion !== 1
    || typeof value.activeEncryptionKeyId !== 'string'
    || !isCollabOpaqueId(value.activeEncryptionKeyId)
    || typeof value.activeReceiptKeyId !== 'string'
    || !isCollabOpaqueId(value.activeReceiptKeyId)
    || !Array.isArray(value.encryptionKeys)
    || value.encryptionKeys.length === 0
    || !Array.isArray(value.receiptKeys)
    || value.receiptKeys.length === 0
  ) return fail();
  const encryptionKeys = Object.freeze(value.encryptionKeys.map(encryptionKey));
  const receiptKeys = Object.freeze(value.receiptKeys.map(receiptKey));
  if (
    !uniqueIds(encryptionKeys)
    || !uniqueIds(receiptKeys)
    || !encryptionKeys.some(key => key.keyId === value.activeEncryptionKeyId)
    || !receiptKeys.some(key => key.keyId === value.activeReceiptKeyId)
  ) return fail();
  const encryptionIds = new Set(encryptionKeys.map(key => key.keyId));
  const receiptIds = new Set(receiptKeys.map(key => key.keyId));
  const receiptPublicKeys = new Map(receiptKeys.map(key => {
    const exported = key.publicKey.export({ format: 'jwk' });
    if (typeof exported.x !== 'string' || !canonicalBase64url(exported.x)) {
      return fail();
    }
    return [key.keyId, exported.x] as const;
  }));
  return Object.freeze({
    activeEncryptionKeyId: value.activeEncryptionKeyId,
    activeReceiptKeyId: value.activeReceiptKeyId,
    assertReferences(input: Readonly<{
      readonly encryptionKeyIds: readonly string[];
      readonly receiptKeyIds: readonly string[];
    }>): void {
      if (
        input.encryptionKeyIds.some(keyId => !encryptionIds.has(keyId))
        || input.receiptKeyIds.some(keyId => !receiptIds.has(keyId))
      ) return fail();
    },
    assertReceiptPublicKey(keyId: string, publicKey: string): void {
      const expected = receiptPublicKeys.get(keyId);
      if (
        expected === undefined
        || !canonicalBase64url(publicKey)
      ) return fail();
      const left = Buffer.from(expected, 'base64url');
      const right = Buffer.from(publicKey, 'base64url');
      if (
        left.byteLength !== 32
        || right.byteLength !== 32
        || !timingSafeEqual(left, right)
      ) return fail();
    },
    encryptionKeys,
    receiptKeys,
    toJSON: () => Object.freeze({
      message: 'claim-custody-keyring.redacted',
    }),
  });
}

function exactFile(
  opened: BigIntStats,
  current: BigIntStats,
): boolean {
  return opened.isFile()
    && !opened.isSymbolicLink()
    && current.isFile()
    && !current.isSymbolicLink()
    && opened.dev === current.dev
    && opened.ino === current.ino
    && opened.uid === KEYRING_UID
    && opened.gid === KEYRING_GID
    && current.uid === KEYRING_UID
    && current.gid === KEYRING_GID
    && Number(opened.mode & 0o777n) === KEYRING_MODE
    && Number(current.mode & 0o777n) === KEYRING_MODE
    && opened.size > 0n
    && opened.size <= BigInt(MAXIMUM_KEYRING_BYTES)
    && current.size === opened.size;
}

export async function loadClaimCustodyKeyring(): Promise<
  ClaimCustodyKeyringConfig
> {
  let handle: FileHandle | undefined;
  let result: ClaimCustodyKeyringConfig | undefined;
  let failure: unknown;
  try {
    handle = await open(
      CLAIM_CUSTODY_KEYRING_PATH,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(CLAIM_CUSTODY_KEYRING_PATH, { bigint: true });
    if (!exactFile(opened, current)) fail();
    const contents = await handle.readFile({ encoding: 'utf8' });
    const [stillOpened, stillCurrent] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(CLAIM_CUSTODY_KEYRING_PATH, { bigint: true }),
    ]);
    if (
      !exactFile(stillOpened, stillCurrent)
      || stillOpened.dev !== opened.dev
      || stillOpened.ino !== opened.ino
      || stillOpened.size !== opened.size
    ) fail();
    result = decodeClaimCustodyKeyring(JSON.parse(contents) as unknown);
  } catch (error: unknown) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error: unknown) {
    failure = error;
  }
  if (failure !== undefined || result === undefined) fail();
  return result;
}
