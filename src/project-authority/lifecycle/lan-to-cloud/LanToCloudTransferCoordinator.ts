import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  collabControlOperationCodec,
  decodeCollabTransferredMembershipClaimBatch,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
  encodeCollabTransferredMembershipRedemptionReceiptSigningInput,
  isCollabOpaqueId,
  type AcknowledgeTransferredMembershipClaimBatchRequest,
  type BeginLanToCloudTransferRequest,
  type CancelProjectAuthorityTransferRequest,
  type ClaimTransferredMembershipRequest,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferStatus,
  type CollabCheckpointMemberRecord,
  type CollabCheckpointPortableRecord,
  type CollabCheckpointProjectRecord,
  type CollabControlOperationMap,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  type CollabTransferredMembershipClaimBatch,
  type CollabTransferredMembershipClaimCustodyReceipt,
  type CollabTransferredMembershipRedemptionReceipt,
  type CollabTransferredMembershipRedemptionReceiptSigningPayload,
  type CommitLanToCloudRelinquishmentRequest,
  type GetProjectAuthorityTransferRequest,
  type RotateTransferredMembershipClaimsRequest,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../../coordination/CoordinationError.js';
import type {
  AuthorityTransferRecoveryRecord,
  ProjectLifecycleJournalRecord,
} from '../../../coordination/PortabilityLifecyclePersistence.js';
import type {
  PinnedProjectLease,
} from '../../../coordination/ProjectCoordination.js';
import type {
  PreparedProductionCheckpointAttempt,
  ProductionCheckpointStagingPort,
} from '../../../onboarding/production/ProductionCheckpointStaging.js';
import type {
  ValidatedRepositoryCheckpoint,
} from '../../../repositories/GitBundleImporter.js';
import type {
  InactiveRepositoryPublication,
  InactiveRepositoryPublicationPort,
} from '../../../repositories/RepositoryCheckpointAuthority.js';
import {
  ProjectCheckpointCoordinatorError,
  type ProjectCheckpointCoordinator,
  type ValidatedProjectCheckpoint,
} from '../../checkpoint/ProjectCheckpointCoordinator.js';
import type {
  ProjectLifecycleRecoveryOwner,
  ProjectLifecycleRecoveryOutcome,
  RecoverProjectLifecycleInput,
} from '../ProjectLifecycleRecoveryDispatcher.js';
import {
  defaultAuthorityTransferExpiresAt,
} from '../AuthorityTransferExpiry.js';

export type LanToCloudTransferCoordinatorErrorCode =
  | 'authorization-denied'
  | 'cancelled'
  | 'closed'
  | 'dependency-failed'
  | 'expired'
  | 'invalid-checkpoint'
  | 'recovery-required'
  | 'state-conflict';

export class LanToCloudTransferCoordinatorError extends Error {
  readonly code: LanToCloudTransferCoordinatorErrorCode;
  readonly retryable: boolean;

  constructor(code: LanToCloudTransferCoordinatorErrorCode) {
    super(`lan-to-cloud-transfer.error.${code}`);
    this.name = 'LanToCloudTransferCoordinatorError';
    this.code = code;
    this.retryable = code === 'dependency-failed';
  }

  toJSON(): Readonly<Record<string, boolean | string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
      retryable: this.retryable,
    });
  }
}

export interface LanToCloudTransferCoordination {
  acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
}

export interface VerifiedLanToCloudSourceProof {
  readonly checkpointManifestSha256: string;
  readonly projectId: CollabProjectId;
  readonly sourceAuthorityGeneration: number;
  readonly sourceHostMemberId: CollabMemberId;
  readonly targetAuthorityGeneration: number;
  readonly targetUrl: string;
  readonly transferId: string;
}

export interface LanToCloudSourceTrustPort {
  verifySourceProof(input: Readonly<{
    readonly principalId: string;
    readonly proof: string;
  }>): Promise<VerifiedLanToCloudSourceProof>;
  verifyRelinquishmentProof(input: Readonly<{
    readonly proof: CollabAuthorityRelinquishmentProof;
    readonly sourceProof: VerifiedLanToCloudSourceProof;
  }>): Promise<void>;
}

export interface LanToCloudReceiptSigner {
  readonly activeKey: Readonly<{
    readonly publicKey: string;
    readonly receiptKeyId: string;
  }>;
  sign(input: Readonly<{
    readonly receiptKeyId: string;
    readonly signingInput: string;
  }>): Promise<string>;
}

export interface ActivateLanToCloudProjectInput {
  readonly activatedAt: CollabIsoTimestamp;
  readonly checkpoint: ValidatedProjectCheckpoint;
  readonly hostMemberId: CollabMemberId;
  readonly hostPrincipalId: string;
  readonly journal: ProjectLifecycleJournalRecord;
  readonly lease: PinnedProjectLease;
  readonly publication: InactiveRepositoryPublication;
  readonly receiptKeyId: string;
  readonly recovery: AuthorityTransferRecoveryRecord;
}

export interface LanToCloudProjectActivationPort {
  /**
   * Atomically materializes the portable coordination records, activates the
   * exact inactive placement, binds only the source Host principal, and
   * advances the lifecycle journal from source-relinquished to cloud-activated.
   */
  activate(input: ActivateLanToCloudProjectInput): Promise<'activated' | 'replayed'>;
}

export interface LanToCloudTransferCoordinatorOptions {
  readonly activation: LanToCloudProjectActivationPort;
  readonly checkpoint: Pick<
    ProjectCheckpointCoordinator,
    'discardAttempt' | 'validateStaged' | 'validateStagedWithRepository'
  >;
  readonly claimFactory?: () => string;
  readonly clock?: () => Date;
  readonly coordination: LanToCloudTransferCoordination;
  readonly custodyReceiptIdFactory?: () => string;
  readonly receiptIdFactory?: () => string;
  readonly receiptSigner: LanToCloudReceiptSigner;
  readonly relinquishmentTrust: LanToCloudSourceTrustPort;
  readonly repository: InactiveRepositoryPublicationPort;
  readonly repositoryStorageKeyFactory?: (projectId: CollabProjectId) => string;
  readonly staging: Pick<
    ProductionCheckpointStagingPort,
    'prepareAttempt'
  >;
}

export interface BeginLanToCloudTransferInput {
  readonly principalId: string;
  readonly request: BeginLanToCloudTransferRequest;
}

export interface CompleteLanToCloudCheckpointInput {
  readonly principalId: string;
  readonly projectId: CollabProjectId;
  readonly transferId: string;
}

export interface RotateLanToCloudClaimsInput {
  readonly principalId: string;
  readonly request: RotateTransferredMembershipClaimsRequest;
}

export interface AcknowledgeLanToCloudClaimBatchInput {
  readonly principalId: string;
  readonly request: AcknowledgeTransferredMembershipClaimBatchRequest;
}

export interface CommitLanToCloudRelinquishmentInput {
  readonly principalId: string;
  readonly request: CommitLanToCloudRelinquishmentRequest;
}

export interface ClaimLanToCloudMembershipInput {
  readonly principalId: string;
  readonly request: ClaimTransferredMembershipRequest;
}

export interface CancelLanToCloudTransferInput {
  readonly principalId: string;
  readonly request: CancelProjectAuthorityTransferRequest;
}

export interface GetLanToCloudTransferInput {
  readonly principalId: string;
  readonly request: GetProjectAuthorityTransferRequest;
}

interface StoredSourceEvidence {
  readonly checkpointManifestSha256: string;
  readonly principalId: string;
  readonly proof: string;
  readonly receiptKeyId: string;
  readonly receiptPublicKey: string;
  readonly schemaVersion: 1;
}

interface ExactTransfer {
  readonly evidence: StoredSourceEvidence;
  readonly journal: ProjectLifecycleJournalRecord;
  readonly proof: VerifiedLanToCloudSourceProof;
  readonly recovery: AuthorityTransferRecoveryRecord;
}

interface PendingClaimBatch {
  readonly batch: CollabTransferredMembershipClaimBatch;
  exposed: boolean;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SOURCE_EVIDENCE_KEYS = [
  'checkpointManifestSha256',
  'principalId',
  'proof',
  'receiptKeyId',
  'receiptPublicKey',
  'schemaVersion',
] as const;

function fail(code: LanToCloudTransferCoordinatorErrorCode): never {
  throw new LanToCloudTransferCoordinatorError(code);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactDigest(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function timestamp(clock: () => Date, after?: CollabIsoTimestamp): CollabIsoTimestamp {
  const observed = clock();
  if (Number.isNaN(observed.valueOf())) return fail('dependency-failed');
  const minimum = after === undefined ? observed.valueOf() : Date.parse(after) + 1;
  return new Date(Math.max(observed.valueOf(), minimum)).toISOString();
}

function defaultOpaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function defaultClaim(): string {
  return randomBytes(32).toString('base64url');
}

function defaultRepositoryStorageKey(projectId: CollabProjectId): string {
  return `repo_${sha256(projectId).slice(0, 48)}`;
}

function canonicalSigningPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength >= 32
    && decoded.byteLength <= 64
    && decoded.toString('base64url') === value;
}

function pendingBatchKey(projectId: CollabProjectId, transferId: string): string {
  return `${projectId}\0${transferId}`;
}

type LanToCloudControlOperation =
  | 'acknowledgeTransferredMembershipClaimBatch'
  | 'beginLanToCloudTransfer'
  | 'cancelProjectAuthorityTransfer'
  | 'claimTransferredMembership'
  | 'commitLanToCloudRelinquishment'
  | 'getProjectAuthorityTransfer'
  | 'rotateTransferredMembershipClaims';

function decodeRequest<Operation extends LanToCloudControlOperation>(
  operation: Operation,
  value: unknown,
): CollabControlOperationMap[Operation]['request'] {
  const decoded = collabControlOperationCodec(operation).decodeRequest(value);
  if (decoded.status !== 'ok') return fail('state-conflict');
  return decoded.value as never;
}

function encodeSourceEvidence(value: StoredSourceEvidence): string {
  return JSON.stringify(value);
}

function decodeSourceEvidence(value: string | undefined): StoredSourceEvidence {
  if (value === undefined) return fail('recovery-required');
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return fail('recovery-required');
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join('\0') !== [...SOURCE_EVIDENCE_KEYS].sort().join('\0')
      || record.schemaVersion !== 1
      || typeof record.checkpointManifestSha256 !== 'string'
      || !SHA256_PATTERN.test(record.checkpointManifestSha256)
      || typeof record.principalId !== 'string'
      || !PRINCIPAL_PATTERN.test(record.principalId)
      || typeof record.proof !== 'string'
      || record.proof.length === 0
      || record.proof.length > 7_000
      || typeof record.receiptKeyId !== 'string'
      || !isCollabOpaqueId(record.receiptKeyId)
      || !canonicalSigningPublicKey(record.receiptPublicKey)
    ) {
      return fail('recovery-required');
    }
    const evidence = Object.freeze({
      checkpointManifestSha256: record.checkpointManifestSha256,
      principalId: record.principalId,
      proof: record.proof,
      receiptKeyId: record.receiptKeyId,
      receiptPublicKey: record.receiptPublicKey,
      schemaVersion: 1 as const,
    });
    if (encodeSourceEvidence(evidence) !== value) return fail('recovery-required');
    return evidence;
  } catch (error: unknown) {
    if (error instanceof LanToCloudTransferCoordinatorError) throw error;
    return fail('recovery-required');
  }
}

function exactSourceProof(
  proof: VerifiedLanToCloudSourceProof,
  expected: Readonly<{
    readonly checkpointManifestSha256: string;
    readonly projectId: CollabProjectId;
    readonly sourceAuthorityGeneration: number;
    readonly sourceHostMemberId: CollabMemberId;
    readonly targetAuthorityGeneration: number;
    readonly targetUrl: string;
    readonly transferId: string;
  }>,
): boolean {
  return proof.checkpointManifestSha256 === expected.checkpointManifestSha256
    && proof.projectId === expected.projectId
    && proof.sourceAuthorityGeneration === expected.sourceAuthorityGeneration
    && proof.sourceHostMemberId === expected.sourceHostMemberId
    && proof.targetAuthorityGeneration === expected.targetAuthorityGeneration
    && proof.targetUrl === expected.targetUrl
    && proof.transferId === expected.transferId;
}

function checkpointRecords(checkpoint: ValidatedProjectCheckpoint): Readonly<{
  readonly activeMembers: readonly CollabCheckpointMemberRecord[];
  readonly project: CollabCheckpointProjectRecord;
}> {
  const projects = checkpoint.records.filter(
    (record): record is CollabCheckpointProjectRecord => record.kind === 'project',
  );
  const members = checkpoint.records.filter(
    (record): record is CollabCheckpointMemberRecord => record.kind === 'member',
  );
  const project = projects[0];
  if (
    projects.length !== 1
    || project === undefined
    || project.value.projectId !== checkpoint.manifest.projectId
    || project.value.authorityGeneration !== checkpoint.manifest.sourceAuthority.generation
    || project.value.expectedMainOid !== checkpoint.manifest.expectedMainOid
  ) {
    return fail('invalid-checkpoint');
  }
  const activeMembers = members
    .filter(record => record.value.status === 'active')
    .sort((left, right) => left.value.memberId.localeCompare(
      right.value.memberId,
      'en-US',
    ));
  if (
    activeMembers.length === 0
    || activeMembers.every(record => record.value.role !== 'manager')
    || new Set(members.map(record => record.value.memberId)).size !== members.length
  ) {
    return fail('invalid-checkpoint');
  }
  const refs = new Set(checkpoint.manifest.refs.map(ref => ref.name));
  if (activeMembers.some(member => !refs.has(member.value.personalRef))) {
    return fail('invalid-checkpoint');
  }
  return Object.freeze({ activeMembers: Object.freeze(activeMembers), project });
}

function claimBatch(
  claims: readonly Readonly<{ readonly claim: string; readonly memberId: CollabMemberId }>[],
  input: Readonly<{
    readonly batchRevision: number;
    readonly checkpointSha256: string;
    readonly expiresAt: CollabIsoTimestamp;
    readonly projectId: CollabProjectId;
    readonly targetAuthorityGeneration: number;
    readonly transferId: string;
  }>,
): CollabTransferredMembershipClaimBatch {
  const withoutDigest = {
    ...input,
    batchSha256: '0'.repeat(64),
    claims: Object.freeze([...claims].sort((left, right) => (
      left.memberId.localeCompare(right.memberId, 'en-US')
    ))),
  };
  const batchSha256 = sha256(
    encodeCollabTransferredMembershipClaimBatchDigestInput(withoutDigest),
  );
  return decodeCollabTransferredMembershipClaimBatch({
    ...withoutDigest,
    batchSha256,
  });
}

function sameCustodyRequest(
  receipt: CollabTransferredMembershipClaimCustodyReceipt,
  request: AcknowledgeTransferredMembershipClaimBatchRequest,
  hostMemberId: CollabMemberId,
): boolean {
  return receipt.batchRevision === request.batchRevision
    && exactDigest(receipt.batchSha256, request.batchSha256)
    && receipt.operationIntentId === request.operationIntentId
    && receipt.projectId === request.projectId
    && receipt.submittedByMemberId === hostMemberId
    && receipt.transferId === request.transferId;
}

function dependency(error: unknown): never {
  if (error instanceof LanToCloudTransferCoordinatorError) throw error;
  if (error instanceof ProjectCheckpointCoordinatorError) {
    if (error.code === 'cancelled') return fail('cancelled');
    if (error.code === 'closed') return fail('closed');
    if (error.code === 'invalid-checkpoint') return fail('invalid-checkpoint');
  }
  if (error instanceof CoordinationError) {
    if (error.code === 'closed') return fail('closed');
    if (error.code === 'invalid-record') return fail('invalid-checkpoint');
    if (error.code === 'state-conflict') return fail('state-conflict');
  }
  return fail('dependency-failed');
}

export class LanToCloudTransferCoordinator
implements ProjectLifecycleRecoveryOwner {
  readonly #activation: LanToCloudProjectActivationPort;
  readonly #checkpoint: LanToCloudTransferCoordinatorOptions['checkpoint'];
  readonly #claimFactory: () => string;
  readonly #clock: () => Date;
  readonly #coordination: LanToCloudTransferCoordination;
  readonly #custodyReceiptIdFactory: () => string;
  readonly #pendingClaimBatches = new Map<string, PendingClaimBatch>();
  readonly #receiptIdFactory: () => string;
  readonly #receiptKeyId: string;
  readonly #receiptPublicKey: string;
  readonly #receiptSigner: LanToCloudReceiptSigner;
  readonly #relinquishmentTrust: LanToCloudSourceTrustPort;
  readonly #repository: InactiveRepositoryPublicationPort;
  readonly #repositoryStorageKeyFactory: (projectId: CollabProjectId) => string;
  readonly #running = new Set<Promise<void>>();
  readonly #staging: LanToCloudTransferCoordinatorOptions['staging'];
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: LanToCloudTransferCoordinatorOptions) {
    const activeReceiptKey = Object.freeze({
      publicKey: options.receiptSigner.activeKey.publicKey,
      receiptKeyId: options.receiptSigner.activeKey.receiptKeyId,
    });
    if (
      !isCollabOpaqueId(activeReceiptKey.receiptKeyId)
      || !canonicalSigningPublicKey(activeReceiptKey.publicKey)
    ) {
      throw new TypeError('lan-to-cloud-transfer.options-invalid');
    }
    this.#activation = options.activation;
    this.#checkpoint = options.checkpoint;
    this.#claimFactory = options.claimFactory ?? defaultClaim;
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#custodyReceiptIdFactory = options.custodyReceiptIdFactory
      ?? (() => defaultOpaqueId('custody'));
    this.#receiptIdFactory = options.receiptIdFactory
      ?? (() => defaultOpaqueId('redemption'));
    this.#receiptKeyId = activeReceiptKey.receiptKeyId;
    this.#receiptPublicKey = activeReceiptKey.publicKey;
    this.#receiptSigner = options.receiptSigner;
    this.#relinquishmentTrust = options.relinquishmentTrust;
    this.#repository = options.repository;
    this.#repositoryStorageKeyFactory = options.repositoryStorageKeyFactory
      ?? defaultRepositoryStorageKey;
    this.#staging = options.staging;
  }

  begin(input: BeginLanToCloudTransferInput): Promise<CollabAuthorityTransferStatus> {
    const request = decodeRequest(
      'beginLanToCloudTransfer',
      input.request,
    );
    return this.#run(request.projectId, async lease => {
      if (!PRINCIPAL_PATTERN.test(input.principalId)) {
        return fail('authorization-denied');
      }
      const verified = await this.#relinquishmentTrust.verifySourceProof({
        principalId: input.principalId,
        proof: request.sourceProof,
      });
      if (!exactSourceProof(verified, {
        checkpointManifestSha256: request.checkpointManifestSha256,
        projectId: request.projectId,
        sourceAuthorityGeneration: request.expectedSourceAuthorityGeneration,
        sourceHostMemberId: request.sourceHostMemberId,
        targetAuthorityGeneration: request.expectedSourceAuthorityGeneration + 1,
        targetUrl: request.targetUrl,
        transferId: request.transferId,
      })) return fail('authorization-denied');
      const evidence = Object.freeze({
        checkpointManifestSha256: request.checkpointManifestSha256,
        principalId: input.principalId,
        proof: request.sourceProof,
        receiptKeyId: this.#receiptKeyId,
        receiptPublicKey: this.#receiptPublicKey,
        schemaVersion: 1 as const,
      });
      const requestFingerprint = sha256(JSON.stringify(request));
      const preparation = await lease.withProjectScope(async scope => {
        const existing = await scope.portability.getLifecycleJournal(
          request.transferId,
        );
        if (existing === undefined) {
          const createdAt = timestamp(this.#clock);
          const expiresAt = defaultAuthorityTransferExpiresAt(createdAt);
          const [project, tombstone] = await Promise.all([
            scope.getProject(),
            scope.portability.getProjectTombstone(),
          ]);
          if (project !== undefined || tombstone !== undefined) {
            return fail('state-conflict');
          }
          await scope.portability.putLifecycleJournal({
            actorMemberId: request.sourceHostMemberId,
            createdAt,
            direction: 'lan-to-cloud',
            expectedAuthorityGeneration: request.expectedSourceAuthorityGeneration,
            idempotencyKey: request.idempotencyKey,
            kind: 'authority-transfer',
            operationId: request.transferId,
            phase: 'source-quiesced',
            projectId: request.projectId,
            requestFingerprint,
            scheduledAt: expiresAt,
          });
          await scope.portability.putAuthorityTransferRecovery({
            createdAt,
            expiresAt,
            sourceAuthority: Object.freeze({
              generation: request.expectedSourceAuthorityGeneration,
              kind: 'lan',
            }),
            sourceHostMemberId: request.sourceHostMemberId,
            targetAuthority: Object.freeze({
              generation: request.expectedSourceAuthorityGeneration + 1,
              kind: 'cloud',
            }),
            targetHostMemberId: undefined,
            targetUrl: request.targetUrl,
            transferId: request.transferId,
          });
          await scope.portability.advanceAuthorityTransferRecoveryEvidence({
            expectedUpdatedAt: createdAt,
            sourceProof: encodeSourceEvidence(evidence),
            transferId: request.transferId,
            updatedAt: timestamp(this.#clock, createdAt),
          });
          return Object.freeze({ expiresAt, prepareAttempt: true });
        }
        if (
          existing.kind !== 'authority-transfer'
          || existing.direction !== 'lan-to-cloud'
          || existing.actorMemberId !== request.sourceHostMemberId
          || existing.expectedAuthorityGeneration
            !== request.expectedSourceAuthorityGeneration
          || existing.idempotencyKey !== request.idempotencyKey
          || existing.requestFingerprint !== requestFingerprint
        ) return fail('state-conflict');
        const recovery = await scope.portability.getAuthorityTransferRecovery(
          request.transferId,
        );
        const storedEvidence = decodeSourceEvidence(recovery?.sourceProof);
        if (
          storedEvidence.principalId !== evidence.principalId
          || storedEvidence.checkpointManifestSha256
            !== evidence.checkpointManifestSha256
          || storedEvidence.proof !== evidence.proof
        ) return fail('state-conflict');
        if (recovery === undefined) return fail('recovery-required');
        if (existing.state === 'completed' || existing.state === 'cancelled') {
          return Object.freeze({
            expiresAt: recovery.expiresAt,
            prepareAttempt: false,
          });
        }
        const observedAt = timestamp(this.#clock);
        if (Date.parse(recovery.expiresAt) <= Date.parse(observedAt)) {
          return fail('expired');
        }
        return Object.freeze({
          expiresAt: recovery.expiresAt,
          prepareAttempt: existing.phase === 'source-quiesced',
        });
      });
      if (preparation.prepareAttempt) {
        await this.#staging.prepareAttempt({
          expiresAt: preparation.expiresAt,
          operationId: request.transferId,
          projectId: request.projectId,
        });
      }
      return this.#requireStatus(lease, request.transferId);
    });
  }

  completeCheckpoint(
    input: CompleteLanToCloudCheckpointInput,
  ): Promise<CollabAuthorityTransferStatus> {
    return this.#run(input.projectId, async lease => {
      const exact = await this.#authorizeSource(lease, input.transferId, input.principalId);
      if (exact.journal.phase !== 'source-quiesced'
        && exact.journal.phase !== 'checkpoint-received'
        && exact.journal.phase !== 'checkpoint-validated') {
        return this.#requireStatus(lease, input.transferId);
      }
      if (exact.journal.phase !== 'checkpoint-validated') {
        this.#assertNotExpired(exact);
      }
      if (exact.journal.phase === 'source-quiesced') {
        await this.#advance(lease, exact.journal, {
          nextPhase: 'checkpoint-received',
          scheduledAt: exact.recovery.expiresAt,
        });
      }
      const current = await this.#exactTransfer(lease, input.transferId);
      if (current.journal.phase === 'checkpoint-validated') {
        return this.#requireStatus(lease, input.transferId);
      }
      const checkpoint = await this.#validatedCheckpoint(current);
      const facts = checkpointRecords(checkpoint);
      if (!facts.activeMembers.some(member => (
        member.value.memberId === current.proof.sourceHostMemberId
      ))) return fail('invalid-checkpoint');
      const batch = this.#newBatch(
        current,
        facts.activeMembers,
        1,
      );
      const updatedAt = timestamp(this.#clock, current.journal.updatedAt);
      await lease.withProjectScope(async scope => {
        await scope.portability.stageLanToCloudProject({
          authorityGeneration: current.recovery.targetAuthority.generation,
          checkpointSha256: batch.checkpointSha256,
          records: checkpoint.records as readonly CollabCheckpointPortableRecord[],
          stagedAt: updatedAt,
          transferId: current.journal.operationId,
        });
        await scope.portability.advanceAuthorityTransferRecoveryEvidence({
          expectedUpdatedAt: current.recovery.updatedAt,
          stageSha256: batch.checkpointSha256,
          transferId: current.journal.operationId,
          updatedAt,
        });
        await scope.portability.advanceLifecycleJournal({
          batchRevision: batch.batchRevision,
          batchSha256: batch.batchSha256,
          checkpointSha256: batch.checkpointSha256,
          expectedPhase: 'checkpoint-received',
          expectedState: 'active',
          nextPhase: 'checkpoint-validated',
          nextState: 'active',
          operationId: current.journal.operationId,
          scheduledAt: current.recovery.expiresAt,
          updatedAt,
        });
        await scope.portability.putTransferReceiptKey({
          createdAt: updatedAt,
          publicKey: current.evidence.receiptPublicKey,
          receiptKeyId: current.evidence.receiptKeyId,
          transferId: current.journal.operationId,
        });
        for (const item of batch.claims) {
          await scope.portability.putTransferredMembershipClaim({
            batchRevision: batch.batchRevision,
            checkpointSha256: batch.checkpointSha256,
            claimSha256: sha256(item.claim),
            createdAt: updatedAt,
            expiresAt: batch.expiresAt,
            memberId: item.memberId,
            transferId: batch.transferId,
          });
        }
      });
      this.#pendingClaimBatches.set(
        pendingBatchKey(input.projectId, input.transferId),
        { batch, exposed: false },
      );
      return this.#requireStatus(lease, input.transferId);
    });
  }

  rotateClaims(
    input: RotateLanToCloudClaimsInput,
  ): Promise<CollabTransferredMembershipClaimBatch> {
    const request = decodeRequest(
      'rotateTransferredMembershipClaims',
      input.request,
    );
    return this.#run(request.projectId, async lease => {
      const exact = await this.#authorizeSource(
        lease,
        request.transferId,
        input.principalId,
      );
      this.#assertNotExpired(exact);
      if (
        exact.journal.phase !== 'checkpoint-validated'
        || exact.journal.batchRevision !== request.expectedBatchRevision
        || exact.journal.batchSha256 === undefined
        || !exactDigest(exact.journal.batchSha256, request.expectedBatchSha256)
        || exact.journal.checkpointSha256 === undefined
      ) return fail('state-conflict');
      const receipt = await lease.withProjectScope(scope => (
        scope.portability.getTransferClaimBatchReceipt(request.transferId)
      ));
      if (receipt !== undefined) return fail('state-conflict');
      const key = pendingBatchKey(request.projectId, request.transferId);
      const pending = this.#pendingClaimBatches.get(key);
      if (
        pending !== undefined
        && pending.batch.batchRevision === request.expectedBatchRevision
        && exactDigest(pending.batch.batchSha256, request.expectedBatchSha256)
        && !pending.exposed
      ) {
        pending.exposed = true;
        return pending.batch;
      }
      const checkpoint = await this.#validatedCheckpoint(exact);
      const facts = checkpointRecords(checkpoint);
      const nonHostMembers = facts.activeMembers.filter(member => (
        member.value.memberId !== exact.proof.sourceHostMemberId
      ));
      if (nonHostMembers.length === 0) {
        const empty = this.#newBatch(exact, facts.activeMembers, exact.journal.batchRevision);
        if (!exactDigest(empty.batchSha256, request.expectedBatchSha256)) {
          return fail('recovery-required');
        }
        this.#pendingClaimBatches.set(key, {
          batch: empty,
          exposed: true,
        });
        return empty;
      }
      const next = this.#newBatch(
        exact,
        facts.activeMembers,
        request.expectedBatchRevision + 1,
      );
      const updatedAt = timestamp(this.#clock, exact.journal.updatedAt);
      await lease.withProjectScope(scope => (
        scope.portability.rotateTransferredMembershipClaims({
          checkpointSha256: next.checkpointSha256,
          expectedBatchRevision: request.expectedBatchRevision,
          expectedBatchSha256: request.expectedBatchSha256,
          nextBatchRevision: next.batchRevision,
          nextBatchSha256: next.batchSha256,
          replacements: next.claims.map(item => Object.freeze({
            claimSha256: sha256(item.claim),
            expiresAt: next.expiresAt,
            memberId: item.memberId,
          })),
          rotatedAt: updatedAt,
          scheduledAt: exact.recovery.expiresAt,
          transferId: request.transferId,
        })
      ));
      this.#pendingClaimBatches.set(key, {
        batch: next,
        exposed: true,
      });
      return next;
    });
  }

  acknowledgeClaimBatch(
    input: AcknowledgeLanToCloudClaimBatchInput,
  ): Promise<CollabTransferredMembershipClaimCustodyReceipt> {
    const request = decodeRequest(
      'acknowledgeTransferredMembershipClaimBatch',
      input.request,
    );
    return this.#run(request.projectId, async lease => {
      let exact = await this.#authorizeSource(
        lease,
        request.transferId,
        input.principalId,
      );
      const existing = await lease.withProjectScope(scope => (
        scope.portability.getTransferClaimBatchReceipt(request.transferId)
      ));
      if (existing !== undefined) {
        if (!sameCustodyRequest(existing, request, exact.proof.sourceHostMemberId)) {
          return fail('state-conflict');
        }
        if (exact.journal.phase === 'claims-retained' && !this.#isExpired(exact)) {
          await this.#publishIfNeeded(lease, exact);
        }
        return existing;
      }
      this.#assertNotExpired(exact);
      if (
        exact.journal.phase !== 'checkpoint-validated'
        || exact.journal.batchRevision !== request.batchRevision
        || exact.journal.batchSha256 === undefined
        || !exactDigest(exact.journal.batchSha256, request.batchSha256)
        || exact.journal.checkpointSha256 === undefined
      ) return fail('state-conflict');
      const committedAt = timestamp(this.#clock, exact.journal.updatedAt);
      const receipt = Object.freeze({
        batchRevision: request.batchRevision,
        batchSha256: request.batchSha256,
        checkpointSha256: exact.journal.checkpointSha256,
        committedAt,
        custodyAuthority: exact.recovery.sourceAuthority,
        operationIntentId: request.operationIntentId,
        projectId: request.projectId,
        receiptId: this.#custodyReceiptIdFactory(),
        submittedByMemberId: exact.proof.sourceHostMemberId,
        targetAuthorityGeneration: exact.recovery.targetAuthority.generation,
        transferId: request.transferId,
      } satisfies CollabTransferredMembershipClaimCustodyReceipt);
      await lease.withProjectScope(async scope => {
        await scope.portability.putClaimBatchReceipt(receipt);
        await scope.portability.advanceLifecycleJournal({
          batchRevision: receipt.batchRevision,
          batchSha256: receipt.batchSha256,
          checkpointSha256: receipt.checkpointSha256,
          expectedPhase: 'checkpoint-validated',
          expectedState: 'active',
          nextPhase: 'claims-retained',
          nextState: 'active',
          operationId: request.transferId,
          scheduledAt: exact.recovery.expiresAt,
          updatedAt: committedAt,
        });
      });
      this.#pendingClaimBatches.delete(
        pendingBatchKey(request.projectId, request.transferId),
      );
      exact = await this.#exactTransfer(lease, request.transferId);
      await this.#publishIfNeeded(lease, exact);
      return receipt;
    });
  }

  commitRelinquishment(
    input: CommitLanToCloudRelinquishmentInput,
  ): Promise<CollabAuthorityTransferStatus> {
    const request = decodeRequest(
      'commitLanToCloudRelinquishment',
      input.request,
    );
    return this.#run(request.projectId, async lease => {
      let exact = await this.#authorizeSource(
        lease,
        request.transferId,
        input.principalId,
      );
      if (exact.journal.phase === 'completed') {
        this.#assertCommittedRelinquishment(request.proof, exact);
        return this.#requireStatus(lease, request.transferId);
      }
      if (exact.journal.phase === 'claims-retained') {
        this.#assertNotExpired(exact);
        await this.#publishIfNeeded(lease, exact);
        exact = await this.#exactTransfer(lease, request.transferId);
      }
      if (exact.journal.phase === 'repository-published') {
        this.#assertNotExpired(exact);
        this.#assertRelinquishment(request.proof, exact);
        await this.#relinquishmentTrust.verifyRelinquishmentProof({
          proof: request.proof,
          sourceProof: exact.proof,
        });
        const updatedAt = timestamp(
          this.#clock,
          exact.recovery.updatedAt > exact.journal.updatedAt
            ? exact.recovery.updatedAt
            : exact.journal.updatedAt,
        );
        await lease.withProjectScope(async scope => {
          await scope.portability.advanceAuthorityTransferRecoveryEvidence({
            expectedUpdatedAt: exact.recovery.updatedAt,
            relinquishmentProof: request.proof,
            transferId: request.transferId,
            updatedAt,
          });
          await scope.portability.advanceLifecycleJournal({
            batchRevision: request.proof.batchRevision,
            batchSha256: request.proof.batchSha256,
            checkpointSha256: request.proof.checkpointSha256,
            expectedPhase: 'repository-published',
            expectedState: 'active',
            nextPhase: 'source-relinquished',
            nextState: 'active',
            operationId: request.transferId,
            scheduledAt: updatedAt,
            updatedAt,
          });
        });
      } else if (
        exact.journal.phase !== 'source-relinquished'
        && exact.journal.phase !== 'cloud-activated'
      ) return fail('state-conflict');
      else this.#assertCommittedRelinquishment(request.proof, exact);
      await this.#activateIfNeeded(lease, request.transferId);
      return this.#requireStatus(lease, request.transferId);
    });
  }

  claimMembership(
    input: ClaimLanToCloudMembershipInput,
  ): Promise<CollabTransferredMembershipRedemptionReceipt> {
    const request = decodeRequest(
      'claimTransferredMembership',
      input.request,
    );
    return this.#run(request.projectId, async lease => {
      if (!PRINCIPAL_PATTERN.test(input.principalId)) {
        return fail('authorization-denied');
      }
      if ('credentialHash' in request) return fail('state-conflict');
      const exact = await this.#exactTransfer(lease, request.transferId);
      if (exact.journal.phase !== 'completed' || exact.journal.state !== 'completed') {
        return fail('state-conflict');
      }
      const claimSha256 = sha256(request.claim);
      const claim = await lease.withProjectScope(scope => (
        scope.portability.findTransferredMembershipClaimBySha256(
          request.transferId,
          claimSha256,
        )
      ));
      if (claim === undefined || claim.memberId === exact.proof.sourceHostMemberId) {
        return fail('authorization-denied');
      }
      if (Date.parse(claim.expiresAt) <= this.#clock().valueOf()) return fail('expired');
      let payload: CollabTransferredMembershipRedemptionReceiptSigningPayload;
      if (claim.state === 'redeemed') {
        if (
          claim.targetPrincipalId !== input.principalId
          || claim.operationIntentId !== request.idempotencyKey
          || claim.redemptionReceiptId === undefined
        ) return fail('authorization-denied');
        payload = Object.freeze({
          checkpointSha256: claim.checkpointSha256,
          claimSha256,
          memberId: claim.memberId,
          operationIntentId: request.idempotencyKey,
          projectId: request.projectId,
          receiptId: claim.redemptionReceiptId,
          receiptKeyId: exact.evidence.receiptKeyId,
          redeemedAt: claim.updatedAt,
          signatureAlgorithm: 'ed25519',
          targetAuthorityGeneration: exact.recovery.targetAuthority.generation,
          transferId: request.transferId,
        });
      } else if (claim.state === 'unclaimed') {
        payload = Object.freeze({
          checkpointSha256: claim.checkpointSha256,
          claimSha256,
          memberId: claim.memberId,
          operationIntentId: request.idempotencyKey,
          projectId: request.projectId,
          receiptId: this.#receiptIdFactory(),
          receiptKeyId: exact.evidence.receiptKeyId,
          redeemedAt: timestamp(this.#clock, claim.updatedAt),
          signatureAlgorithm: 'ed25519',
          targetAuthorityGeneration: exact.recovery.targetAuthority.generation,
          transferId: request.transferId,
        });
      } else return fail('authorization-denied');
      const receipt = decodeCollabTransferredMembershipRedemptionReceipt({
        ...payload,
        signature: await this.#receiptSigner.sign({
          receiptKeyId: exact.evidence.receiptKeyId,
          signingInput: encodeCollabTransferredMembershipRedemptionReceiptSigningInput(
            payload,
          ),
        }),
      });
      return lease.withProjectScope(async scope => {
        const binding = await scope.portability.findProjectPrincipalBinding(
          input.principalId,
        );
        if (
          binding !== undefined
          && (
            binding.state !== 'active'
            || binding.memberId !== claim.memberId
          )
        ) return fail('authorization-denied');
        return scope.portability.redeemTransferredMembershipClaim({
          claimSha256,
          memberId: claim.memberId,
          operationIntentId: request.idempotencyKey,
          receipt,
          targetPrincipalId: input.principalId,
          transferId: request.transferId,
          updatedAt: payload.redeemedAt,
        });
      });
    });
  }

  getStatus(
    input: GetLanToCloudTransferInput,
  ): Promise<CollabAuthorityTransferStatus> {
    const request = decodeRequest(
      'getProjectAuthorityTransfer',
      input.request,
    );
    return this.#run(request.projectId, async lease => {
      const exact = await this.#exactTransfer(lease, request.transferId);
      const sourceAuthorized = exact.evidence.principalId === input.principalId;
      const targetAuthorized = await lease.withProjectScope(async scope => {
        const binding = await scope.portability.findProjectPrincipalBinding(
          input.principalId,
        );
        return binding?.state === 'active';
      });
      if (!sourceAuthorized && !targetAuthorized) return fail('authorization-denied');
      return this.#requireStatus(lease, request.transferId);
    });
  }

  cancel(
    input: CancelLanToCloudTransferInput,
  ): Promise<CollabAuthorityTransferStatus> {
    const request = decodeRequest(
      'cancelProjectAuthorityTransfer',
      input.request,
    );
    return this.#run(request.projectId, async lease => {
      let exact = await this.#authorizeSource(
        lease,
        request.transferId,
        input.principalId,
      );
      const requestFingerprint = sha256(JSON.stringify(request));
      if (exact.recovery.sourceReopenSha256 === requestFingerprint) {
        if (
          exact.journal.phase === 'target-cleaned'
          && request.expectedPhase === 'target-cleaned'
        ) {
          await this.#recordCancellationTransition(
            lease,
            exact,
            'source-reopened',
            { sourceReopenSha256: requestFingerprint },
          );
          exact = await this.#exactTransfer(lease, request.transferId);
        }
        if (exact.journal.phase === 'source-reopened') {
          await this.#finishCancellation(lease, exact);
        } else if (exact.journal.phase !== 'cancelled') {
          return fail('state-conflict');
        }
        return this.#requireStatus(lease, request.transferId);
      }
      if (exact.recovery.cancellationRequestSha256 === requestFingerprint) {
        if (exact.journal.phase === request.expectedPhase) {
          await this.#startCancellation(lease, exact, requestFingerprint);
          exact = await this.#exactTransfer(lease, request.transferId);
        }
        if (
          exact.journal.phase !== 'cancel-intent'
          && exact.journal.phase !== 'target-invalidated'
          && exact.journal.phase !== 'target-cleaned'
          && exact.journal.phase !== 'source-reopened'
          && exact.journal.phase !== 'cancelled'
        ) return fail('state-conflict');
        await this.#cancelPreRelinquishment(lease, exact);
        return this.#requireStatus(lease, request.transferId);
      }
      if (exact.journal.phase === 'target-cleaned') {
        if (
          request.expectedPhase !== 'target-cleaned'
          || exact.recovery.sourceReopenSha256 !== undefined
        ) return fail('state-conflict');
        await this.#recordCancellationTransition(
          lease,
          exact,
          'source-reopened',
          { sourceReopenSha256: requestFingerprint },
        );
        exact = await this.#exactTransfer(lease, request.transferId);
        await this.#finishCancellation(lease, exact);
        return this.#requireStatus(lease, request.transferId);
      }
      if (
        exact.journal.phase !== request.expectedPhase
        || exact.recovery.cancellationRequestSha256 !== undefined
      ) return fail('state-conflict');
      await this.#startCancellation(lease, exact, requestFingerprint);
      exact = await this.#exactTransfer(lease, request.transferId);
      await this.#cancelPreRelinquishment(lease, exact);
      return this.#requireStatus(lease, request.transferId);
    });
  }

  async recover(
    input: RecoverProjectLifecycleInput,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    return this.#track(async () => {
      try {
        if (
          input.journal.kind !== 'authority-transfer'
          || input.journal.direction !== 'lan-to-cloud'
        ) return fail('recovery-required');
        const phase = input.journal.phase;
        if (phase === 'source-relinquished' || phase === 'cloud-activated') {
          await this.#activateIfNeeded(input.lease, input.journal.operationId);
          return 'settled';
        }
        if (
          phase === 'cancel-intent'
          || phase === 'target-invalidated'
          || phase === 'target-cleaned'
          || phase === 'source-reopened'
        ) {
          const exact = await this.#exactTransfer(
            input.lease,
            input.journal.operationId,
          );
          await this.#cancelPreRelinquishment(input.lease, exact);
          const status = await input.lease.withProjectScope(scope => (
            scope.portability.getLifecycleJournal(input.journal.operationId)
          ));
          return status?.state === 'cancelled'
            ? 'settled'
            : 'waiting-for-external-proof';
        }
        const exact = await this.#exactTransfer(
          input.lease,
          input.journal.operationId,
        );
        const observedAt = this.#clock().valueOf();
        if (Number.isNaN(observedAt)) return fail('dependency-failed');
        if (observedAt >= Date.parse(exact.recovery.expiresAt)) {
          if (exact.recovery.cancellationRequestSha256 === undefined) {
            await this.#startCancellation(
              input.lease,
              exact,
              sha256(`expired\0${exact.journal.operationId}`),
            );
          }
          const cancelling = await this.#exactTransfer(
            input.lease,
            input.journal.operationId,
          );
          await this.#cancelPreRelinquishment(input.lease, cancelling);
          return 'waiting-for-external-proof';
        }
        return 'waiting-for-external-proof';
      } catch (error: unknown) {
        dependency(error);
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = Promise.allSettled([...this.#running]).then(() => {
        this.#pendingClaimBatches.clear();
      });
    }
    return this.#closePromise;
  }

  async #authorizeSource(
    lease: PinnedProjectLease,
    transferId: string,
    principalId: string,
  ): Promise<ExactTransfer> {
    const exact = await this.#exactTransfer(lease, transferId);
    if (exact.evidence.principalId !== principalId) {
      return fail('authorization-denied');
    }
    return exact;
  }

  async #exactTransfer(
    lease: PinnedProjectLease,
    transferId: string,
  ): Promise<ExactTransfer> {
    const [journal, recovery] = await lease.withProjectScope(async scope => (
      Promise.all([
        scope.portability.getLifecycleJournal(transferId),
        scope.portability.getAuthorityTransferRecovery(transferId),
      ])
    ));
    if (
      journal?.kind !== 'authority-transfer'
      || journal.direction !== 'lan-to-cloud'
      || recovery === undefined
      || recovery.sourceAuthority.kind !== 'lan'
      || recovery.targetAuthority.kind !== 'cloud'
      || recovery.sourceHostMemberId === undefined
      || recovery.targetHostMemberId !== undefined
    ) return fail('recovery-required');
    const evidence = decodeSourceEvidence(recovery.sourceProof);
    const proof = await this.#relinquishmentTrust.verifySourceProof({
      principalId: evidence.principalId,
      proof: evidence.proof,
    });
    if (!exactSourceProof(proof, {
      checkpointManifestSha256: evidence.checkpointManifestSha256,
      projectId: journal.projectId,
      sourceAuthorityGeneration: recovery.sourceAuthority.generation,
      sourceHostMemberId: recovery.sourceHostMemberId,
      targetAuthorityGeneration: recovery.targetAuthority.generation,
      targetUrl: recovery.targetUrl,
      transferId,
    })) return fail('recovery-required');
    return Object.freeze({ evidence, journal, proof, recovery });
  }

  #attempt(exact: ExactTransfer): PreparedProductionCheckpointAttempt {
    return Object.freeze({
      attemptKey: sha256(
        `production-checkpoint\0${exact.journal.projectId}\0${exact.journal.operationId}`,
      ),
      expiresAt: exact.recovery.expiresAt,
      operationId: exact.journal.operationId,
      projectId: exact.journal.projectId,
    });
  }

  async #validatedCheckpoint(exact: ExactTransfer): Promise<ValidatedProjectCheckpoint> {
    const input = {
      attempt: this.#attempt(exact),
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: exact.recovery.sourceAuthority,
      expectedTargetAuthority: exact.recovery.targetAuthority,
    } as const;
    let checkpoint: ValidatedProjectCheckpoint;
    if (exact.recovery.inactivePublicationJson === undefined) {
      checkpoint = await this.#checkpoint.validateStaged(input);
    } else {
      const publication = this.#publicationFromRecovery(exact);
      const repository = this.#repositoryCheckpoint(publication);
      const verified = await this.#repository.publishInactive({
        checkpoint: repository,
        placementGeneration: publication.placementGeneration,
        repositoryStorageKey: publication.repositoryStorageKey,
      });
      if (!isDeepStrictEqual(verified, publication)) {
        return fail('recovery-required');
      }
      checkpoint = await this.#checkpoint.validateStagedWithRepository(
        input,
        repository,
      );
    }
    if (
      checkpoint.manifest.manifestSha256
        !== exact.evidence.checkpointManifestSha256
      || checkpoint.manifest.projectId !== exact.journal.projectId
      || checkpoint.manifest.operationId !== exact.journal.operationId
    ) return fail('invalid-checkpoint');
    return checkpoint;
  }

  #repositoryCheckpoint(
    publication: InactiveRepositoryPublication,
  ): ValidatedRepositoryCheckpoint {
    return Object.freeze({
      artifactKey: publication.artifactKey,
      bundleByteCount: publication.bundleByteCount,
      bundleInputDisposition: 'replayed',
      bundleSha256: publication.bundleSha256,
      markerSha256: publication.validationMarkerSha256,
      objectFormat: publication.objectFormat,
      operationId: publication.operationId,
      projectId: publication.projectId,
      refs: publication.refs,
    });
  }

  #publicationFromRecovery(exact: ExactTransfer): InactiveRepositoryPublication {
    const json = exact.recovery.inactivePublicationJson;
    if (json === undefined) return fail('recovery-required');
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return fail('recovery-required');
      }
      const publication = parsed as InactiveRepositoryPublication;
      if (!Array.isArray(publication.refs)) return fail('recovery-required');
      const planned = this.#repository.planInactive({
        checkpoint: this.#repositoryCheckpoint(publication),
        placementGeneration: publication.placementGeneration,
        repositoryStorageKey: publication.repositoryStorageKey,
      });
      if (
        publication.projectId !== exact.journal.projectId
        || publication.operationId !== exact.journal.operationId
        || !isDeepStrictEqual(planned, publication)
        || JSON.stringify(planned) !== json
      ) return fail('recovery-required');
      return planned;
    } catch (error: unknown) {
      if (error instanceof LanToCloudTransferCoordinatorError) throw error;
      return fail('recovery-required');
    }
  }

  async #ensurePublicationPlan(
    lease: PinnedProjectLease,
    exact: ExactTransfer,
  ): Promise<InactiveRepositoryPublication> {
    if (exact.recovery.inactivePublicationJson !== undefined) {
      return this.#publicationFromRecovery(exact);
    }
    const checkpoint = await this.#validatedCheckpoint(exact);
    const publication = this.#repository.planInactive({
      checkpoint: checkpoint.repository,
      placementGeneration: 1,
      repositoryStorageKey: this.#repositoryStorageKeyFactory(
        exact.journal.projectId,
      ),
    });
    await lease.withProjectScope(scope => (
      scope.portability.advanceAuthorityTransferRecoveryEvidence({
        expectedUpdatedAt: exact.recovery.updatedAt,
        inactivePublicationJson: JSON.stringify(publication),
        transferId: exact.journal.operationId,
        updatedAt: timestamp(this.#clock, exact.recovery.updatedAt),
      })
    ));
    return publication;
  }

  #newBatch(
    exact: ExactTransfer,
    activeMembers: readonly CollabCheckpointMemberRecord[],
    batchRevision: number,
  ): CollabTransferredMembershipClaimBatch {
    const checkpointSha256 = exact.evidence.checkpointManifestSha256;
    const claims = activeMembers
      .filter(member => member.value.memberId !== exact.proof.sourceHostMemberId)
      .map(member => Object.freeze({
        claim: this.#claimFactory(),
        memberId: member.value.memberId,
      }));
    return claimBatch(claims, {
      batchRevision,
      checkpointSha256,
      expiresAt: exact.recovery.expiresAt,
      projectId: exact.journal.projectId,
      targetAuthorityGeneration: exact.recovery.targetAuthority.generation,
      transferId: exact.journal.operationId,
    });
  }

  async #publishIfNeeded(
    lease: PinnedProjectLease,
    initial: ExactTransfer,
  ): Promise<void> {
    let exact = initial;
    if (exact.journal.phase === 'repository-published') return;
    if (exact.journal.phase !== 'claims-retained') {
      if (
        exact.journal.phase === 'source-relinquished'
        || exact.journal.phase === 'cloud-activated'
        || exact.journal.phase === 'completed'
      ) return;
      return fail('state-conflict');
    }
    const publication = await this.#ensurePublicationPlan(lease, exact);
    await this.#repository.publishInactive({
      checkpoint: this.#repositoryCheckpoint(publication),
      placementGeneration: publication.placementGeneration,
      repositoryStorageKey: publication.repositoryStorageKey,
    });
    await this.#advance(lease, exact.journal, {
      nextPhase: 'repository-published',
      scheduledAt: exact.recovery.expiresAt,
    });
    exact = await this.#exactTransfer(lease, exact.journal.operationId);
    if (exact.journal.phase !== 'repository-published') {
      return fail('recovery-required');
    }
  }

  async #activateIfNeeded(
    lease: PinnedProjectLease,
    transferId: string,
  ): Promise<void> {
    let exact = await this.#exactTransfer(lease, transferId);
    if (exact.journal.phase === 'source-relinquished') {
      const checkpoint = await this.#validatedCheckpoint(exact);
      const publication = this.#publicationFromRecovery(exact);
      await this.#activation.activate({
        activatedAt: timestamp(this.#clock, exact.journal.updatedAt),
        checkpoint,
        hostMemberId: exact.proof.sourceHostMemberId,
        hostPrincipalId: exact.evidence.principalId,
        journal: exact.journal,
        lease,
        publication,
        receiptKeyId: exact.evidence.receiptKeyId,
        recovery: exact.recovery,
      });
      exact = await this.#exactTransfer(lease, transferId);
      if (exact.journal.phase !== 'cloud-activated') {
        return fail('recovery-required');
      }
    }
    if (exact.journal.phase === 'cloud-activated') {
      await this.#checkpoint.discardAttempt(this.#attempt(exact));
      await this.#advance(lease, exact.journal, {
        nextPhase: 'completed',
        nextState: 'completed',
        scheduledAt: exact.recovery.expiresAt,
      });
      return;
    }
    if (exact.journal.phase !== 'completed') return fail('state-conflict');
  }

  #assertRelinquishment(
    proof: CollabAuthorityRelinquishmentProof,
    exact: ExactTransfer,
  ): void {
    if (
      proof.projectId !== exact.journal.projectId
      || proof.transferId !== exact.journal.operationId
      || proof.sourceHostMemberId !== exact.proof.sourceHostMemberId
      || proof.sourceAuthority.generation !== exact.recovery.sourceAuthority.generation
      || proof.targetAuthority.generation !== exact.recovery.targetAuthority.generation
      || proof.checkpointSha256 !== exact.journal.checkpointSha256
      || proof.batchRevision !== exact.journal.batchRevision
      || proof.batchSha256 !== exact.journal.batchSha256
    ) return fail('state-conflict');
  }

  #assertNotExpired(exact: ExactTransfer): void {
    if (this.#isExpired(exact)) {
      return fail('expired');
    }
  }

  #isExpired(exact: ExactTransfer): boolean {
    const observed = this.#clock();
    if (Number.isNaN(observed.valueOf())) return fail('dependency-failed');
    return observed.valueOf() >= Date.parse(exact.recovery.expiresAt);
  }

  #assertCommittedRelinquishment(
    proof: CollabAuthorityRelinquishmentProof,
    exact: ExactTransfer,
  ): void {
    this.#assertRelinquishment(proof, exact);
    if (
      exact.recovery.relinquishmentProof === undefined
      || !isDeepStrictEqual(exact.recovery.relinquishmentProof, proof)
    ) return fail('state-conflict');
  }

  async #cancelPreRelinquishment(
    lease: PinnedProjectLease,
    initial: ExactTransfer,
  ): Promise<void> {
    let exact = initial;
    if (
      exact.journal.phase === 'source-relinquished'
      || exact.journal.phase === 'cloud-activated'
      || exact.journal.phase === 'completed'
    ) return fail('state-conflict');
    if (exact.journal.phase === 'cancel-intent') {
      await this.#advance(lease, exact.journal, {
        nextPhase: 'target-invalidated',
        scheduledAt: exact.recovery.expiresAt,
      });
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'target-invalidated') {
      if (exact.recovery.inactivePublicationJson !== undefined) {
        const publication = this.#publicationFromRecovery(exact);
        await this.#repository.removeOwnedRepository(publication);
      }
      await this.#checkpoint.discardAttempt(this.#attempt(exact));
      await lease.withProjectScope(async scope => {
        await scope.portability.discardLanToCloudProjectStage({
          authorityGeneration: exact.recovery.targetAuthority.generation,
          stageSha256: exact.recovery.stageSha256,
          transferId: exact.journal.operationId,
        });
        if (
          exact.journal.batchRevision !== undefined
          && exact.journal.batchSha256 !== undefined
          && exact.journal.checkpointSha256 !== undefined
        ) {
          await scope.portability.deleteTransferredMembershipClaims({
            batchRevision: exact.journal.batchRevision,
            batchSha256: exact.journal.batchSha256,
            checkpointSha256: exact.journal.checkpointSha256,
            transferId: exact.journal.operationId,
          });
        }
      });
      this.#pendingClaimBatches.delete(pendingBatchKey(
        exact.journal.projectId,
        exact.journal.operationId,
      ));
      await this.#advance(lease, exact.journal, {
        nextPhase: 'target-cleaned',
        scheduledAt: exact.recovery.expiresAt,
      });
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'target-cleaned') {
      return;
    }
    if (exact.journal.phase === 'source-reopened') {
      await this.#finishCancellation(lease, exact);
      return;
    }
    if (
      exact.journal.phase !== 'target-cleaned'
      && exact.journal.phase !== 'cancelled'
    ) return fail('recovery-required');
  }

  async #startCancellation(
    lease: PinnedProjectLease,
    exact: ExactTransfer,
    requestFingerprint: string,
  ): Promise<void> {
    if (
      exact.journal.phase === 'source-relinquished'
      || exact.journal.phase === 'cloud-activated'
      || exact.journal.phase === 'completed'
      || exact.journal.phase === 'target-cleaned'
      || exact.journal.phase === 'source-reopened'
      || exact.journal.phase === 'cancelled'
    ) return fail('state-conflict');
    await this.#recordCancellationTransition(
      lease,
      exact,
      'cancel-intent',
      { cancellationRequestSha256: requestFingerprint },
    );
  }

  async #recordCancellationTransition(
    lease: PinnedProjectLease,
    exact: ExactTransfer,
    nextPhase: 'cancel-intent' | 'source-reopened',
    evidence: Readonly<{
      readonly cancellationRequestSha256?: string;
      readonly sourceReopenSha256?: string;
    }>,
  ): Promise<void> {
    const updatedAt = timestamp(
      this.#clock,
      exact.recovery.updatedAt > exact.journal.updatedAt
        ? exact.recovery.updatedAt
        : exact.journal.updatedAt,
    );
    await lease.withProjectScope(async scope => {
      await scope.portability.advanceAuthorityTransferRecoveryEvidence({
        ...(evidence.cancellationRequestSha256 === undefined
          ? {}
          : { cancellationRequestSha256: evidence.cancellationRequestSha256 }),
        expectedUpdatedAt: exact.recovery.updatedAt,
        ...(evidence.sourceReopenSha256 === undefined
          ? {}
          : { sourceReopenSha256: evidence.sourceReopenSha256 }),
        transferId: exact.journal.operationId,
        updatedAt,
      });
      await scope.portability.advanceLifecycleJournal({
        expectedPhase: exact.journal.phase,
        expectedState: exact.journal.state,
        nextPhase,
        nextState: 'active',
        operationId: exact.journal.operationId,
        scheduledAt: exact.recovery.expiresAt,
        updatedAt,
      });
    });
  }

  async #finishCancellation(
    lease: PinnedProjectLease,
    exact: ExactTransfer,
  ): Promise<void> {
    if (exact.journal.phase === 'cancelled') return;
    if (exact.journal.phase !== 'source-reopened') {
      return fail('recovery-required');
    }
    await this.#advance(lease, exact.journal, {
      nextPhase: 'cancelled',
      nextState: 'cancelled',
      scheduledAt: exact.recovery.expiresAt,
    });
  }

  async #advance(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    input: Readonly<{
      readonly nextPhase: string;
      readonly nextState?: 'active' | 'cancelled' | 'completed';
      readonly scheduledAt: CollabIsoTimestamp;
    }>,
  ): Promise<void> {
    await lease.withProjectScope(scope => scope.portability.advanceLifecycleJournal({
      expectedPhase: journal.phase,
      expectedState: journal.state,
      nextPhase: input.nextPhase,
      nextState: input.nextState ?? 'active',
      operationId: journal.operationId,
      scheduledAt: input.scheduledAt,
      updatedAt: timestamp(this.#clock, journal.updatedAt),
    }));
  }

  async #requireStatus(
    lease: PinnedProjectLease,
    transferId: string,
  ): Promise<CollabAuthorityTransferStatus> {
    const status = await lease.withProjectScope(scope => (
      scope.portability.getAuthorityTransferStatus(transferId)
    ));
    if (status === undefined || status.direction !== 'lan-to-cloud') {
      return fail('recovery-required');
    }
    return status;
  }

  #run<Result>(
    projectId: CollabProjectId,
    operation: (lease: PinnedProjectLease) => Promise<Result>,
  ): Promise<Result> {
    return this.#track(async () => {
      let lease: PinnedProjectLease;
      try {
        lease = await this.#coordination.acquireProjectLease(projectId);
      } catch (error: unknown) {
        return dependency(error);
      }
      let failure: unknown;
      try {
        if (this.#closed) return fail('closed');
        return await operation(lease);
      } catch (error: unknown) {
        failure = error;
        return dependency(error);
      } finally {
        try {
          await lease.close();
        } catch (error: unknown) {
          if (failure === undefined) dependency(error);
        }
      }
    });
  }

  #track<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new LanToCloudTransferCoordinatorError('closed'));
    }
    const result = Promise.resolve().then(async () => {
      if (this.#closed) return fail('closed');
      return operation();
    });
    const tracked = result.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    void tracked.finally(() => this.#running.delete(tracked));
    return result;
  }
}
