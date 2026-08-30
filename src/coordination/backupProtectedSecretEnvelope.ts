import { CoordinationError } from './CoordinationError.js';

const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 9;
const TAG_BYTES = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

function invalidRecord(): never {
  throw new CoordinationError('invalid-record');
}

function canonicalBase64url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) invalidRecord();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) invalidRecord();
  return decoded;
}

export function frameBackupProtectedSecretEnvelope(input: Readonly<{
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly tag: string;
}>): string {
  if (
    !Number.isSafeInteger(input.keyVersion)
    || input.keyVersion <= 0
  ) invalidRecord();
  const ciphertext = canonicalBase64url(input.ciphertext);
  const tag = canonicalBase64url(input.tag);
  if (ciphertext.byteLength === 0 || tag.byteLength !== TAG_BYTES) invalidRecord();
  const frame = Buffer.allocUnsafe(
    FRAME_HEADER_BYTES + ciphertext.byteLength + tag.byteLength,
  );
  frame.writeUInt8(FRAME_VERSION, 0);
  frame.writeBigUInt64BE(BigInt(input.keyVersion), 1);
  ciphertext.copy(frame, FRAME_HEADER_BYTES);
  tag.copy(frame, FRAME_HEADER_BYTES + ciphertext.byteLength);
  return frame.toString('base64url');
}

export function unframeBackupProtectedSecretEnvelope(ciphertext: string): Readonly<{
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly tag: string;
}> {
  const frame = canonicalBase64url(ciphertext);
  if (
    frame.byteLength <= FRAME_HEADER_BYTES + TAG_BYTES
    || frame.readUInt8(0) !== FRAME_VERSION
  ) invalidRecord();
  const keyVersion = Number(frame.readBigUInt64BE(1));
  if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0) invalidRecord();
  return Object.freeze({
    ciphertext: frame
      .subarray(FRAME_HEADER_BYTES, -TAG_BYTES)
      .toString('base64url'),
    keyVersion,
    tag: frame.subarray(-TAG_BYTES).toString('base64url'),
  });
}
