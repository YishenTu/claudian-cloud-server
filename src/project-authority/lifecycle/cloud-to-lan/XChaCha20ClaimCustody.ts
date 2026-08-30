import {
  encodeCollabProtectedClaimAssociatedData,
  isCollabOpaqueId,
} from '@claudian-collab/protocol';

import type { ProtectedClaimEnvelopeInput } from '../../../coordination/PortabilityLifecyclePersistence.js';
import {
  ProtectedSecretCustody,
  ProtectedSecretCustodyError,
  type ProtectedSecretCustodyEnvelope,
  type ProtectedSecretCustodyKey,
} from '../ProtectedSecretCustody.js';
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
    return Object.freeze({ code: this.code, message: this.message, name: this.name });
  }
}

export type XChaCha20ClaimCustodyKey = ProtectedSecretCustodyKey;

export interface XChaCha20ClaimCustodyOptions {
  readonly activeKeyId: string;
  readonly keys: readonly XChaCha20ClaimCustodyKey[];
  readonly nonceFactory?: () => Uint8Array;
}

type OpenProtectedClaimEnvelope = Omit<
  ProtectedClaimEnvelopeInput,
  'createdAt'
> & Readonly<{ readonly createdAt?: string }>;

function fail(code: XChaCha20ClaimCustodyErrorCode): never {
  throw new XChaCha20ClaimCustodyError(code);
}

function associatedData(input: ProtectedClaimEnvelopeInput['associatedData']): string {
  try {
    return encodeCollabProtectedClaimAssociatedData(input);
  } catch {
    return fail('invalid-envelope');
  }
}

function mapError(error: unknown): XChaCha20ClaimCustodyError {
  return error instanceof ProtectedSecretCustodyError
    ? new XChaCha20ClaimCustodyError(error.code)
    : new XChaCha20ClaimCustodyError('authentication-failed');
}

function primitiveEnvelope(
  envelope: OpenProtectedClaimEnvelope,
): ProtectedSecretCustodyEnvelope {
  if (
    envelope.memberId !== envelope.associatedData.memberId
    || envelope.transferId !== envelope.associatedData.transferId
  ) return fail('invalid-envelope');
  return Object.freeze({
    algorithm: envelope.encryptionAlgorithm,
    associatedDataSha256: envelope.associatedDataSha256,
    ciphertext: envelope.ciphertext,
    keyId: envelope.keyId,
    keyVersion: envelope.keyVersion,
    nonce: envelope.nonce,
    tag: envelope.tag,
  });
}

export class XChaCha20ClaimCustody implements CloudToLanClaimCustodyPort {
  readonly #custody: ProtectedSecretCustody;

  constructor(options: XChaCha20ClaimCustodyOptions) {
    try {
      this.#custody = new ProtectedSecretCustody(options);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  async seal(input: Readonly<{
    readonly associatedData: ProtectedClaimEnvelopeInput['associatedData'];
    readonly claim: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly receiptKeyId: string;
  }>): Promise<ProtectedClaimEnvelopeInput> {
    if (!isCollabOpaqueId(input.receiptKeyId)) return fail('invalid-envelope');
    const encodedAssociatedData = associatedData(input.associatedData);
    try {
      const envelope = await this.#custody.seal({
        associatedData: encodedAssociatedData,
        secret: input.claim,
      });
      return Object.freeze({
        associatedData: input.associatedData,
        associatedDataSha256: envelope.associatedDataSha256,
        ciphertext: envelope.ciphertext,
        createdAt: input.createdAt,
        encryptionAlgorithm: envelope.algorithm,
        expiresAt: input.expiresAt,
        keyId: envelope.keyId,
        keyVersion: envelope.keyVersion,
        memberId: input.associatedData.memberId,
        nonce: envelope.nonce,
        receiptKeyId: input.receiptKeyId,
        tag: envelope.tag,
        transferId: input.associatedData.transferId,
      });
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  async open(envelope: OpenProtectedClaimEnvelope): Promise<string> {
    const encodedAssociatedData = associatedData(envelope.associatedData);
    try {
      return await this.#custody.open({
        associatedData: encodedAssociatedData,
        envelope: primitiveEnvelope(envelope),
      });
    } catch (error: unknown) {
      if (error instanceof XChaCha20ClaimCustodyError) throw error;
      throw mapError(error);
    }
  }
}
