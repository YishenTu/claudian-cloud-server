import { createPublicKey, verify } from 'node:crypto';

import {
  decodeCollabAuthorityRelinquishmentProof,
  encodeCollabAuthorityRelinquishmentProofSigningInput,
  isCollabOpaqueId,
  type CollabCheckpointProtectedClaimEnvelopeRecord,
} from '@claudian-collab/protocol';

import type {
  BackupExportCheckpointSource,
} from '../../project-authority/checkpoint/BackupExportCoordinator.js';
import { unframeBackupProtectedSecretEnvelope } from '../../coordination/backupProtectedSecretEnvelope.js';
import type { ProtectedSecretCustody } from '../../project-authority/lifecycle/ProtectedSecretCustody.js';
import { encodeInvitationAssociatedData } from '../../project-authority/membership/ProjectInvitationAuthority.js';
import { encodeClaimOverrideAssociatedData } from '../../project-authority/membership/TransferredMembershipClaimAuthority.js';

export interface ClaimCustodyKeyReferenceConfigPort {
  assertReferences(input: Readonly<{
    readonly encryptionKeyIds: readonly string[];
    readonly receiptKeyIds: readonly string[];
  }>): void;
  assertReceiptPublicKey(keyId: string, publicKey: string): void;
}

export interface ClaimCustodyEnvelopeOpeningPort {
  open(
    envelope: CollabCheckpointProtectedClaimEnvelopeRecord['value'],
  ): Promise<string>;
}

export interface ClaimCustodyKeyReferenceVerifierOptions {
  readonly custody: ClaimCustodyEnvelopeOpeningPort;
  readonly keyring: ClaimCustodyKeyReferenceConfigPort;
  readonly membershipCustody?: Pick<ProtectedSecretCustody, 'open'>;
}

interface CandidateRecord {
  readonly kind?: unknown;
  readonly value?: unknown;
}

function invalid(): never {
  throw new Error('claim-custody-key-reference.error.invalid-record');
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function keyId(value: unknown, field: string): string {
  const candidate = record(value)[field];
  if (typeof candidate !== 'string' || !isCollabOpaqueId(candidate)) {
    return invalid();
  }
  return candidate;
}

function rawPublicKey(value: unknown): string {
  const candidate = record(value).receiptPublicKey;
  if (typeof candidate !== 'string') return invalid();
  const decoded = Buffer.from(candidate, 'base64url');
  if (
    decoded.byteLength !== 32
    || decoded.toString('base64url') !== candidate
  ) return invalid();
  return candidate;
}

interface ReceiptKeyReference {
  readonly publicKey: string;
  readonly receiptKeyId: string;
}

function receiptKeyReference(value: unknown): ReceiptKeyReference {
  return Object.freeze({
    publicKey: rawPublicKey(value),
    receiptKeyId: keyId(value, 'receiptKeyId'),
  });
}

function authorityKind(value: unknown): 'cloud' | 'lan' {
  const kind = record(value).kind;
  if (kind !== 'cloud' && kind !== 'lan') return invalid();
  return kind;
}

function retainReceiptReference(
  receipt: Set<string>,
  publicKeys: Map<string, string>,
  reference: ReceiptKeyReference,
): void {
  const existing = publicKeys.get(reference.receiptKeyId);
  if (existing !== undefined && existing !== reference.publicKey) return invalid();
  receipt.add(reference.receiptKeyId);
  publicKeys.set(reference.receiptKeyId, reference.publicKey);
}

/** Proves that the operator retained every key referenced by checkpoint state. */
export class ClaimCustodyKeyReferenceVerifier {
  readonly #custody: ClaimCustodyEnvelopeOpeningPort;
  readonly #keyring: ClaimCustodyKeyReferenceConfigPort;
  readonly #membershipCustody: Pick<ProtectedSecretCustody, 'open'> | undefined;

  constructor(options: ClaimCustodyKeyReferenceVerifierOptions) {
    this.#custody = options.custody;
    this.#keyring = options.keyring;
    this.#membershipCustody = options.membershipCustody;
  }

  async verify(records: readonly CandidateRecord[]): Promise<void> {
    const encryption = new Set<string>();
    const receipt = new Set<string>();
    const receiptPublicKeys = new Map<string, string>();
    const receiptPublicKeysForConfig = new Map<string, string>();
    const transferDirections = new Map<string, 'cloud-to-lan' | 'lan-to-cloud'>();
    const cloudTargetKeys = new Map<string, ReceiptKeyReference>();
    const lanTargetKeys = new Map<string, ReceiptKeyReference>();
    const relinquishmentProofs = new Map<string, unknown>();
    for (const item of records) {
      if (item.kind === 'lifecycle-journal') {
        const value = record(item.value);
        if (
          value.operationKind === 'authority-transfer'
          && (value.direction === 'cloud-to-lan'
            || value.direction === 'lan-to-cloud')
        ) {
          const transferId = keyId(value, 'operationId');
          const existing = transferDirections.get(transferId);
          if (existing !== undefined && existing !== value.direction) return invalid();
          transferDirections.set(transferId, value.direction);
        }
      } else if (item.kind === 'authority-transfer-recovery') {
        const value = record(item.value);
        const transferId = keyId(value, 'transferId');
        if (value.sourceEvidence !== null && value.sourceEvidence !== undefined) {
          if (
            authorityKind(value.sourceAuthority) !== 'lan'
            || authorityKind(value.targetAuthority) !== 'cloud'
            || cloudTargetKeys.has(transferId)
          ) return invalid();
          cloudTargetKeys.set(
            transferId,
            receiptKeyReference(value.sourceEvidence),
          );
        }
        if (value.targetEvidence !== null && value.targetEvidence !== undefined) {
          if (
            authorityKind(value.sourceAuthority) !== 'cloud'
            || authorityKind(value.targetAuthority) !== 'lan'
            || lanTargetKeys.has(transferId)
          ) return invalid();
          lanTargetKeys.set(
            transferId,
            receiptKeyReference(value.targetEvidence),
          );
        }
        if (
          value.relinquishmentProof !== null
          && value.relinquishmentProof !== undefined
        ) {
          if (relinquishmentProofs.has(transferId)) return invalid();
          relinquishmentProofs.set(transferId, value.relinquishmentProof);
        }
      }
      if (item.kind !== 'transfer-receipt-key') continue;
      const transferId = keyId(item.value, 'transferId');
      const receiptKeyId = keyId(item.value, 'receiptKeyId');
      const publicKey = rawPublicKey(item.value);
      const identity = `${transferId}\0${receiptKeyId}`;
      if (receiptPublicKeys.has(identity)) return invalid();
      receiptPublicKeys.set(identity, publicKey);
    }
    for (const [transferId, encodedProof] of relinquishmentProofs) {
      let proof;
      try {
        proof = decodeCollabAuthorityRelinquishmentProof(encodedProof);
      } catch {
        return invalid();
      }
      if (proof.transferId !== transferId) return invalid();
      if (proof.sourceAuthority.kind !== 'cloud') continue;
      const { certificate, ...payload } = proof;
      const signingInput = Buffer.from(
        encodeCollabAuthorityRelinquishmentProofSigningInput(payload),
        'utf8',
      );
      const signature = Buffer.from(certificate, 'base64url');
      const target = lanTargetKeys.get(transferId);
      if (target === undefined) return invalid();
      const targetIdentity = `${transferId}\0${target.receiptKeyId}`;
      if (receiptPublicKeys.get(targetIdentity) !== target.publicKey) return invalid();
      const matches = [...receiptPublicKeys].filter(([identity, publicKey]) => {
        if (!identity.startsWith(`${transferId}\0`)) return false;
        if (identity === targetIdentity) return false;
        try {
          return verify(
            null,
            signingInput,
            createPublicKey({
              format: 'jwk',
              key: { crv: 'Ed25519', kty: 'OKP', x: publicKey },
            }),
            signature,
          );
        } catch {
          return false;
        }
      });
      if (matches.length !== 1) return invalid();
      const [identity, publicKey] = matches[0] ?? invalid();
      retainReceiptReference(receipt, receiptPublicKeysForConfig, {
        publicKey,
        receiptKeyId: identity.slice(transferId.length + 1),
      });
    }
    for (const item of records) {
      if (item.kind === 'protected-claim-envelope') {
        const transferId = keyId(item.value, 'transferId');
        const receiptKeyId = keyId(item.value, 'receiptKeyId');
        if (!receiptPublicKeys.has(`${transferId}\0${receiptKeyId}`)) {
          return invalid();
        }
        encryption.add(keyId(item.value, 'keyId'));
      } else if (
        item.kind === 'protected-invitation-envelope'
        || item.kind === 'protected-claim-override-envelope'
      ) {
        encryption.add(keyId(item.value, 'keyId'));
      }
    }
    for (const [transferId, reference] of cloudTargetKeys) {
      if (transferDirections.get(transferId) !== 'lan-to-cloud') return invalid();
      const persisted = receiptPublicKeys.get(
        `${transferId}\0${reference.receiptKeyId}`,
      );
      if (persisted !== undefined && persisted !== reference.publicKey) return invalid();
      retainReceiptReference(receipt, receiptPublicKeysForConfig, reference);
    }
    for (const [transferId, direction] of transferDirections) {
      if (direction !== 'cloud-to-lan' || relinquishmentProofs.has(transferId)) {
        continue;
      }
      const target = lanTargetKeys.get(transferId);
      if (target === undefined) {
        if ([...receiptPublicKeys.keys()].some(identity => (
          identity.startsWith(`${transferId}\0`)
        ))) return invalid();
        continue;
      }
      const targetIdentity = `${transferId}\0${target.receiptKeyId}`;
      if (receiptPublicKeys.get(targetIdentity) !== target.publicKey) return invalid();
      const sourceMatches = [...receiptPublicKeys].filter(([identity]) => (
        identity.startsWith(`${transferId}\0`) && identity !== targetIdentity
      ));
      if (sourceMatches.length > 1) return invalid();
      const source = sourceMatches[0];
      if (source !== undefined) {
        retainReceiptReference(receipt, receiptPublicKeysForConfig, {
          publicKey: source[1],
          receiptKeyId: source[0].slice(transferId.length + 1),
        });
      }
    }
    this.#keyring.assertReferences({
      encryptionKeyIds: [...encryption].sort(),
      receiptKeyIds: [...receipt].sort(),
    });
    for (const [keyId, publicKey] of [...receiptPublicKeysForConfig].sort()) {
      this.#keyring.assertReceiptPublicKey(keyId, publicKey);
    }
    for (const item of records) {
      if (item.kind !== 'protected-claim-envelope') continue;
      await this.#custody.open(
        record(item.value) as unknown as
          CollabCheckpointProtectedClaimEnvelopeRecord['value'],
      );
    }
    for (const item of records) {
      if (
        item.kind !== 'protected-invitation-envelope'
        && item.kind !== 'protected-claim-override-envelope'
      ) continue;
      if (this.#membershipCustody === undefined) return invalid();
      const value = record(item.value);
      let framed;
      try {
        const encoded = value.ciphertext;
        if (typeof encoded !== 'string') return invalid();
        framed = unframeBackupProtectedSecretEnvelope(encoded);
      } catch {
        return invalid();
      }
      let associatedData: string;
      if (item.kind === 'protected-invitation-envelope') {
        const invitationId = keyId(value, 'invitationId');
        const invitation = records.find(candidate => (
          candidate.kind === 'project-invitation'
          && record(candidate.value).invitationId === invitationId
        ));
        if (invitation === undefined) return invalid();
        const invitationValue = record(invitation.value);
        const expiresAt = invitationValue.expiresAt;
        if (typeof expiresAt !== 'string') return invalid();
        associatedData = encodeInvitationAssociatedData({
          expiresAt,
          invitationId,
          projectId: keyId(value, 'projectId'),
        });
      } else {
        const claimGeneration = value.claimGeneration;
        const expiresAt = value.expiresAt;
        if (
          !Number.isSafeInteger(claimGeneration)
          || (claimGeneration as number) <= 0
          || typeof expiresAt !== 'string'
        ) return invalid();
        associatedData = encodeClaimOverrideAssociatedData({
          claimGeneration: claimGeneration as number,
          expiresAt,
          memberId: keyId(value, 'memberId'),
          projectId: keyId(value, 'projectId'),
          transferId: keyId(value, 'transferId'),
        });
      }
      const associatedDataSha256 = value.associatedDataSha256;
      const nonce = value.nonce;
      if (
        typeof associatedDataSha256 !== 'string'
        || typeof nonce !== 'string'
      ) return invalid();
      await this.#membershipCustody.open({
        associatedData,
        envelope: Object.freeze({
          algorithm: 'xchacha20-poly1305' as const,
          associatedDataSha256,
          ciphertext: framed.ciphertext,
          keyId: keyId(value, 'keyId'),
          keyVersion: framed.keyVersion,
          nonce,
          tag: framed.tag,
        }),
      });
    }
  }
}

export class KeyReferenceCheckingBackupExportSource
implements BackupExportCheckpointSource {
  readonly #source: BackupExportCheckpointSource;
  readonly #verifier: Pick<ClaimCustodyKeyReferenceVerifier, 'verify'>;

  constructor(options: Readonly<{
    readonly source: BackupExportCheckpointSource;
    readonly verifier: Pick<ClaimCustodyKeyReferenceVerifier, 'verify'>;
  }>) {
    this.#source = options.source;
    this.#verifier = options.verifier;
  }

  async snapshot(
    input: Parameters<BackupExportCheckpointSource['snapshot']>[0],
  ): ReturnType<BackupExportCheckpointSource['snapshot']> {
    const snapshot = await this.#source.snapshot(input);
    await this.#verifier.verify(snapshot.records);
    return snapshot;
  }
}
