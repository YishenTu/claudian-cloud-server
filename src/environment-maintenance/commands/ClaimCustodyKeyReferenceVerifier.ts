import {
  isCollabOpaqueId,
  type CollabCheckpointProtectedClaimEnvelopeRecord,
} from '@claudian-collab/protocol';

import type {
  BackupExportCheckpointSource,
} from '../../project-authority/checkpoint/BackupExportCoordinator.js';
import type {
  ProjectCheckpointCoordinator,
} from '../../project-authority/checkpoint/ProjectCheckpointCoordinator.js';

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

/** Proves that the operator retained every key referenced by checkpoint state. */
export class ClaimCustodyKeyReferenceVerifier {
  readonly #custody: ClaimCustodyEnvelopeOpeningPort;
  readonly #keyring: ClaimCustodyKeyReferenceConfigPort;

  constructor(options: ClaimCustodyKeyReferenceVerifierOptions) {
    this.#custody = options.custody;
    this.#keyring = options.keyring;
  }

  async verify(records: readonly CandidateRecord[]): Promise<void> {
    const encryption = new Set<string>();
    const receipt = new Set<string>();
    const receiptPublicKeys = new Map<string, string>();
    const cloudTargetTransfers = new Set<string>();
    for (const item of records) {
      if (item.kind === 'lifecycle-journal') {
        const value = record(item.value);
        if (
          value.operationKind === 'authority-transfer'
          && value.direction === 'lan-to-cloud'
        ) cloudTargetTransfers.add(keyId(value, 'operationId'));
      } else if (item.kind === 'authority-transfer-recovery') {
        const value = record(item.value);
        if (value.sourceEvidence !== null && value.sourceEvidence !== undefined) {
          cloudTargetTransfers.add(keyId(value, 'transferId'));
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
    for (const item of records) {
      if (item.kind === 'protected-claim-envelope') {
        const transferId = keyId(item.value, 'transferId');
        const receiptKeyId = keyId(item.value, 'receiptKeyId');
        if (!receiptPublicKeys.has(`${transferId}\0${receiptKeyId}`)) {
          return invalid();
        }
        encryption.add(keyId(item.value, 'keyId'));
      }
    }
    const referencedPublicKeys = new Map<string, string>();
    for (const transferId of cloudTargetTransfers) {
      const matches = [...receiptPublicKeys].filter(([identity]) => (
        identity.startsWith(`${transferId}\0`)
      ));
      if (matches.length !== 1) return invalid();
      const [identity, publicKey] = matches[0] ?? invalid();
      const receiptKeyId = identity.slice(transferId.length + 1);
      const existing = referencedPublicKeys.get(receiptKeyId);
      if (existing !== undefined && existing !== publicKey) return invalid();
      receipt.add(receiptKeyId);
      referencedPublicKeys.set(receiptKeyId, publicKey);
    }
    this.#keyring.assertReferences({
      encryptionKeyIds: [...encryption].sort(),
      receiptKeyIds: [...receipt].sort(),
    });
    for (const [keyId, publicKey] of [...referencedPublicKeys].sort()) {
      this.#keyring.assertReceiptPublicKey(keyId, publicKey);
    }
    for (const item of records) {
      if (item.kind !== 'protected-claim-envelope') continue;
      await this.#custody.open(
        record(item.value) as unknown as
          CollabCheckpointProtectedClaimEnvelopeRecord['value'],
      );
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

type PublishedCheckpoint = Pick<
  ProjectCheckpointCoordinator,
  'readPublishedOutboundRecords' | 'reserveOutbound' | 'verifyOutboundOperation'
>;

export class KeyReferenceCheckingPublishedCheckpoint
implements PublishedCheckpoint {
  readonly #checkpoint: PublishedCheckpoint;
  readonly #verifier: Pick<ClaimCustodyKeyReferenceVerifier, 'verify'>;

  constructor(options: Readonly<{
    readonly checkpoint: PublishedCheckpoint;
    readonly verifier: Pick<ClaimCustodyKeyReferenceVerifier, 'verify'>;
  }>) {
    this.#checkpoint = options.checkpoint;
    this.#verifier = options.verifier;
  }

  reserveOutbound(
    ...arguments_: Parameters<PublishedCheckpoint['reserveOutbound']>
  ): ReturnType<PublishedCheckpoint['reserveOutbound']> {
    return this.#checkpoint.reserveOutbound(...arguments_);
  }

  verifyOutboundOperation(
    ...arguments_: Parameters<PublishedCheckpoint['verifyOutboundOperation']>
  ): ReturnType<PublishedCheckpoint['verifyOutboundOperation']> {
    return this.#checkpoint.verifyOutboundOperation(...arguments_);
  }

  async readPublishedOutboundRecords(
    ...arguments_: Parameters<PublishedCheckpoint['readPublishedOutboundRecords']>
  ): ReturnType<PublishedCheckpoint['readPublishedOutboundRecords']> {
    const records = await this.#checkpoint.readPublishedOutboundRecords(
      ...arguments_,
    );
    await this.#verifier.verify(records);
    return records;
  }
}
