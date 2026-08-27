import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  collabControlOperationCodec,
  decodeCollabAuthorityRelinquishmentProof,
  decodeCollabAuthorityTransferStatus,
  decodeCollabTransferredMembershipClaim,
  encodeCollabAuthorityRelinquishmentProofSigningInput,
  encodeCollabProtectedClaimAssociatedData,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
  isCollabOpaqueId,
  type AcceptCloudToLanTransferTargetRequest,
  type AcknowledgeTransferredMembershipClaimRedemptionRequest,
  type BeginCloudToLanTransferRequest,
  type CancelProjectAuthorityTransferRequest,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferStatus,
  type CollabCheckpointAuthority,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  type CollabTransferredMembershipClaim,
  type CollabTransferredMembershipClaimBatch,
  type CollabTransferredMembershipClaimCustodyReceipt,
  type CollabTransferredMembershipRedemptionAcknowledgement,
  type CollabTransferredMembershipRedemptionReceipt,
  type ConfirmCloudToLanTargetActiveRequest,
  type GetProjectAuthorityTransferRequest,
  type GetTransferredMembershipClaimRequest,
  type ReportCloudToLanTargetStagedRequest,
  type CollabControlOperationMap,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../../coordination/CoordinationError.js';
import type {
  AuthorityTransferRecoveryRecord,
  ProjectLifecycleJournalRecord,
  ProjectPrincipalBindingRecord,
  ProtectedClaimEnvelopeInput,
} from '../../../coordination/PortabilityLifecyclePersistence.js';
import type {
  PinnedProjectLease,
  ProjectMembershipRecord,
  ProjectScope,
} from '../../../coordination/ProjectCoordination.js';
import type {
  ExactRepositoryOperationReservation,
  ExactRepositoryPresencePort,
} from '../../../repositories/RepositoryCheckpointAuthority.js';
import type {
  ProjectLifecycleRecoveryOutcome,
  ProjectLifecycleRecoveryOwner,
  ProjectLifecycleRecoveryReservation,
  RecoverProjectLifecycleInput,
} from '../ProjectLifecycleRecoveryDispatcher.js';
import {
  defaultAuthorityTransferExpiresAt,
  selectAuthorityTransferExpiresAt,
  type AuthorityTransferExpiresAtFactory,
} from '../AuthorityTransferExpiry.js';

export type CloudToLanTransferCoordinatorErrorCode =
  | 'authorization-denied'
  | 'cancelled'
  | 'closed'
  | 'dependency-failed'
  | 'expired'
  | 'invalid-checkpoint'
  | 'recovery-required'
  | 'state-conflict';

export class CloudToLanTransferCoordinatorError extends Error {
  readonly code: CloudToLanTransferCoordinatorErrorCode;
  readonly retryable: boolean;

  constructor(code: CloudToLanTransferCoordinatorErrorCode) {
    super(`cloud-to-lan-transfer.error.${code}`);
    this.name = 'CloudToLanTransferCoordinatorError';
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

export interface CloudToLanTransferCoordination {
  acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
}

export interface CapturedCloudToLanCheckpoint {
  readonly checkpointSha256: string;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
}

export interface CloudToLanCheckpointCapturePort {
  capture(input: Readonly<{
    readonly expiresAt: CollabIsoTimestamp;
    readonly lease: PinnedProjectLease;
    readonly operationId: string;
    readonly projectId: CollabProjectId;
    readonly sourceAuthority: CollabCheckpointAuthority & { readonly kind: 'cloud' };
    readonly targetAuthority: CollabCheckpointAuthority & { readonly kind: 'lan' };
  }>): Promise<CapturedCloudToLanCheckpoint>;
  discard(input: CapturedCloudToLanCheckpoint): Promise<'removed' | 'replayed'>;
}

export interface VerifiedCloudToLanTarget {
  readonly principalId: string;
  readonly projectId: CollabProjectId;
  readonly receiptKeyId: string;
  readonly receiptPublicKey: string;
  readonly targetAuthority: CollabCheckpointAuthority & { readonly kind: 'lan' };
  readonly targetHostMemberId: CollabMemberId;
  readonly targetUrl: string;
  readonly transferId: string;
}

export interface CloudToLanTargetTrustPort {
  verifyAcceptance(input: Readonly<{
    readonly principalId: string;
    readonly request: AcceptCloudToLanTransferTargetRequest;
    readonly sourceAuthority: CollabCheckpointAuthority & { readonly kind: 'cloud' };
    readonly targetAuthority: CollabCheckpointAuthority & { readonly kind: 'lan' };
    readonly targetUrl: string;
  }>): Promise<VerifiedCloudToLanTarget>;
  verifyStaged(input: Readonly<{
    readonly request: ReportCloudToLanTargetStagedRequest;
    readonly target: VerifiedCloudToLanTarget;
  }>): Promise<void>;
  verifyActivation(input: Readonly<{
    readonly request: ConfirmCloudToLanTargetActiveRequest;
    readonly target: VerifiedCloudToLanTarget;
  }>): Promise<void>;
  verifyRedemptionReceipt(input: Readonly<{
    readonly receipt: CollabTransferredMembershipRedemptionReceipt;
    readonly receiptPublicKey: string;
  }>): Promise<void>;
  invalidateAndClean(input: Readonly<{
    readonly checkpointSha256: string | undefined;
    readonly projectId: CollabProjectId;
    readonly stageSha256: string | undefined;
    readonly target: VerifiedCloudToLanTarget | undefined;
    readonly transferId: string;
  }>): Promise<Readonly<{ readonly cleanupSha256: string }>>;
}

export interface CloudToLanClaimCustodyPort {
  seal(input: Readonly<{
    readonly associatedData: ProtectedClaimEnvelopeInput['associatedData'];
    readonly claim: string;
    readonly createdAt: CollabIsoTimestamp;
    readonly expiresAt: CollabIsoTimestamp;
    readonly receiptKeyId: string;
  }>): Promise<ProtectedClaimEnvelopeInput>;
  open(envelope: ProtectedClaimEnvelopeInput): Promise<string>;
}

export interface CloudToLanRelinquishmentSigner {
  sign(input: Readonly<{
    readonly signingInput: string;
  }>): Promise<string>;
}

export interface CloudToLanSourceFencePort {
  quiesce(input: Readonly<{
    readonly expectedAuthorityGeneration: number;
    readonly lease: PinnedProjectLease;
    readonly projectId: CollabProjectId;
    readonly transferId: string;
  }>): Promise<void>;
  relinquish(input: Readonly<{
    readonly lease: PinnedProjectLease;
    readonly proof: CollabAuthorityRelinquishmentProof;
  }>): Promise<void>;
  reopen(input: Readonly<{
    readonly cleanupSha256: string;
    readonly expectedAuthorityGeneration: number;
    readonly lease: PinnedProjectLease;
    readonly projectId: CollabProjectId;
    readonly transferId: string;
  }>): Promise<void>;
}

export interface CloudToLanTransferCoordinatorOptions {
  readonly checkpoint: CloudToLanCheckpointCapturePort;
  readonly clock?: () => Date;
  readonly coordination: CloudToLanTransferCoordination;
  readonly custody: CloudToLanClaimCustodyPort;
  readonly custodyReceiptIdFactory?: () => string;
  readonly deletionOperationIdFactory?: (transferId: string) => string;
  readonly environmentIdentity: string;
  readonly expiresAtFactory?: AuthorityTransferExpiresAtFactory;
  readonly relinquishmentIntentIdFactory?: (transferId: string) => string;
  readonly relinquishmentSigner: CloudToLanRelinquishmentSigner;
  readonly repository: ExactRepositoryPresencePort;
  readonly sourceFence: CloudToLanSourceFencePort;
  readonly targetTrust: CloudToLanTargetTrustPort;
}

export interface BeginCloudToLanTransferInput {
  readonly principalId: string;
  readonly request: BeginCloudToLanTransferRequest;
}

export interface AcceptCloudToLanTargetInput {
  readonly principalId: string;
  readonly request: AcceptCloudToLanTransferTargetRequest;
}

export interface ReportCloudToLanTargetStagedInput {
  readonly principalId: string;
  readonly request: ReportCloudToLanTargetStagedRequest;
}

export interface ConfirmCloudToLanTargetActiveInput {
  readonly principalId: string;
  readonly request: ConfirmCloudToLanTargetActiveRequest;
}

export interface GetCloudToLanTransferInput {
  readonly principalId: string;
  readonly request: GetProjectAuthorityTransferRequest;
}

export interface GetCloudToLanClaimInput {
  readonly principalId: string;
  readonly request: GetTransferredMembershipClaimRequest;
}

export interface AcknowledgeCloudToLanRedemptionInput {
  readonly principalId: string;
  readonly request: AcknowledgeTransferredMembershipClaimRedemptionRequest;
}

export interface CancelCloudToLanTransferInput {
  readonly principalId: string;
  readonly request: CancelProjectAuthorityTransferRequest;
}

interface StoredTargetEvidence {
  readonly acceptanceIntentId: string;
  readonly principalId: string;
  readonly proof: string;
  readonly receiptKeyId: string;
  readonly receiptPublicKey: string;
  readonly schemaVersion: 1;
}

interface ExactTransfer {
  readonly evidence: StoredTargetEvidence | undefined;
  readonly journal: ProjectLifecycleJournalRecord;
  readonly recovery: AuthorityTransferRecoveryRecord;
  readonly target: VerifiedCloudToLanTarget | undefined;
}

type CloudToLanControlOperation =
  | 'acceptCloudToLanTransferTarget'
  | 'acknowledgeTransferredMembershipClaimRedemption'
  | 'beginCloudToLanTransfer'
  | 'cancelProjectAuthorityTransfer'
  | 'confirmCloudToLanTargetActive'
  | 'getProjectAuthorityTransfer'
  | 'getTransferredMembershipClaim'
  | 'reportCloudToLanTargetStaged';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TARGET_EVIDENCE_KEYS = [
  'acceptanceIntentId',
  'principalId',
  'proof',
  'receiptKeyId',
  'receiptPublicKey',
  'schemaVersion',
] as const;

function fail(code: CloudToLanTransferCoordinatorErrorCode): never {
  throw new CloudToLanTransferCoordinatorError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

function timestampImmediatelyAfter(value: CollabIsoTimestamp): CollabIsoTimestamp {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fail('state-conflict');
  return new Date(parsed + 1).toISOString();
}

function renewedExpiry(
  createdAt: CollabIsoTimestamp,
  expiresAt: CollabIsoTimestamp,
  updatedAt: CollabIsoTimestamp,
): CollabIsoTimestamp | undefined {
  const expires = Date.parse(expiresAt);
  const updated = Date.parse(updatedAt);
  if (updated < expires) return undefined;
  const retentionMs = expires - Date.parse(createdAt);
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    return fail('recovery-required');
  }
  return new Date(updated + retentionMs).toISOString();
}

function latestTimestamp(...values: readonly CollabIsoTimestamp[]): CollabIsoTimestamp {
  return values.reduce((latest, value) => (
    Date.parse(value) > Date.parse(latest) ? value : latest
  ));
}

function defaultOpaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function defaultDeletionId(transferId: string): string {
  return `delete_${sha256(transferId).slice(0, 48)}`;
}

function defaultRelinquishmentIntentId(transferId: string): string {
  return `relinquish_${sha256(transferId).slice(0, 48)}`;
}

function transferIdFor(
  projectId: CollabProjectId,
  memberId: CollabMemberId,
  idempotencyKey: string,
): string {
  return `transfer_${sha256(`${projectId}\0${memberId}\0${idempotencyKey}`).slice(0, 48)}`;
}

function canonicalPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength >= 32
    && decoded.byteLength <= 64
    && decoded.toString('base64url') === value;
}

function canonicalCertificate(value: unknown): value is string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 64 && decoded.toString('base64url') === value;
}

function decodeRequest<Operation extends CloudToLanControlOperation>(
  operation: Operation,
  value: unknown,
): CollabControlOperationMap[Operation]['request'] {
  const decoded = collabControlOperationCodec(operation).decodeRequest(value);
  if (decoded.status !== 'ok') return fail('state-conflict');
  return decoded.value as never;
}

function encodeTargetEvidence(value: StoredTargetEvidence): string {
  return JSON.stringify(value);
}

function decodeTargetEvidence(value: string | undefined): StoredTargetEvidence | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return fail('recovery-required');
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join('\0')
        !== [...TARGET_EVIDENCE_KEYS].sort().join('\0')
      || record.schemaVersion !== 1
      || typeof record.acceptanceIntentId !== 'string'
      || !isCollabOpaqueId(record.acceptanceIntentId)
      || typeof record.principalId !== 'string'
      || !PRINCIPAL_PATTERN.test(record.principalId)
      || typeof record.proof !== 'string'
      || record.proof.length === 0
      || record.proof.length > 7_000
      || typeof record.receiptKeyId !== 'string'
      || !isCollabOpaqueId(record.receiptKeyId)
      || !canonicalPublicKey(record.receiptPublicKey)
    ) return fail('recovery-required');
    const result = Object.freeze({
      acceptanceIntentId: record.acceptanceIntentId,
      principalId: record.principalId,
      proof: record.proof,
      receiptKeyId: record.receiptKeyId,
      receiptPublicKey: record.receiptPublicKey,
      schemaVersion: 1 as const,
    });
    if (encodeTargetEvidence(result) !== value) return fail('recovery-required');
    return result;
  } catch (error: unknown) {
    if (error instanceof CloudToLanTransferCoordinatorError) throw error;
    return fail('recovery-required');
  }
}

function dependency(error: unknown): never {
  if (error instanceof CloudToLanTransferCoordinatorError) throw error;
  if (error instanceof CoordinationError) {
    if (error.code === 'closed') return fail('closed');
    if (error.code === 'state-conflict' || error.code === 'invalid-record') {
      return fail('state-conflict');
    }
  }
  return fail('dependency-failed');
}

function exactRepositoryReservation(
  reservation: ProjectLifecycleRecoveryReservation | undefined,
  projectId: CollabProjectId,
): reservation is ExactRepositoryOperationReservation {
  return reservation !== undefined
    && 'projectId' in reservation
    && reservation.projectId === projectId;
}

function sameAuthority(
  left: CollabCheckpointAuthority,
  right: CollabCheckpointAuthority,
): boolean {
  return left.kind === right.kind && left.generation === right.generation;
}

function exactTarget(
  target: VerifiedCloudToLanTarget,
  expected: Readonly<{
    readonly principalId: string;
    readonly projectId: CollabProjectId;
    readonly targetAuthority: CollabCheckpointAuthority;
    readonly targetHostMemberId: CollabMemberId;
    readonly targetUrl: string;
    readonly transferId: string;
  }>,
): boolean {
  return target.principalId === expected.principalId
    && target.projectId === expected.projectId
    && sameAuthority(target.targetAuthority, expected.targetAuthority)
    && target.targetHostMemberId === expected.targetHostMemberId
    && target.targetUrl === expected.targetUrl
    && target.transferId === expected.transferId
    && isCollabOpaqueId(target.receiptKeyId)
    && canonicalPublicKey(target.receiptPublicKey);
}

function exactBatchMembers(
  batch: CollabTransferredMembershipClaimBatch,
  members: readonly ProjectMembershipRecord[],
  targetHostMemberId: CollabMemberId,
): boolean {
  const expected = members
    .filter(member => member.status === 'active' && member.memberId !== targetHostMemberId)
    .map(member => member.memberId)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  const actual = batch.claims
    .map(item => item.memberId)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  return expected.length === actual.length
    && new Set(actual).size === actual.length
    && expected.every((memberId, index) => memberId === actual[index]);
}

function exactCustodyRequest(
  receipt: CollabTransferredMembershipClaimCustodyReceipt,
  request: ReportCloudToLanTargetStagedRequest,
  exact: ExactTransfer,
  targetHostMemberId: CollabMemberId,
): boolean {
  return receipt.batchRevision === request.claimBatch.batchRevision
    && exactDigest(receipt.batchSha256, request.claimBatch.batchSha256)
    && receipt.checkpointSha256 === request.checkpointSha256
    && receipt.operationIntentId === request.idempotencyKey
    && receipt.projectId === request.projectId
    && receipt.submittedByMemberId === targetHostMemberId
    && receipt.targetAuthorityGeneration === request.targetAuthority.generation
    && receipt.transferId === request.transferId
    && request.claimBatch.projectId === request.projectId
    && request.claimBatch.transferId === request.transferId
    && request.claimBatch.checkpointSha256 === request.checkpointSha256
    && request.claimBatch.batchRevision === 1
    && request.claimBatch.expiresAt === exact.recovery.expiresAt
    && exactDigest(
      request.claimBatch.batchSha256,
      sha256(encodeCollabTransferredMembershipClaimBatchDigestInput(
        request.claimBatch,
      )),
    )
    && request.claimBatch.targetAuthorityGeneration
      === exact.recovery.targetAuthority.generation
    && sameAuthority(request.targetAuthority, exact.recovery.targetAuthority)
    && exactDigest(request.stageSha256, exact.recovery.stageSha256 ?? '');
}

export class CloudToLanTransferCoordinator
implements ProjectLifecycleRecoveryOwner {
  readonly #checkpoint: CloudToLanCheckpointCapturePort;
  readonly #clock: () => Date;
  readonly #coordination: CloudToLanTransferCoordination;
  readonly #custody: CloudToLanClaimCustodyPort;
  readonly #custodyReceiptIdFactory: () => string;
  readonly #deletionOperationIdFactory: (transferId: string) => string;
  readonly #environmentIdentity: string;
  readonly #expiresAtFactory: AuthorityTransferExpiresAtFactory;
  readonly #relinquishmentIntentIdFactory: (transferId: string) => string;
  readonly #relinquishmentSigner: CloudToLanRelinquishmentSigner;
  readonly #repository: ExactRepositoryPresencePort;
  readonly #running = new Set<Promise<void>>();
  readonly #sourceFence: CloudToLanSourceFencePort;
  readonly #targetTrust: CloudToLanTargetTrustPort;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: CloudToLanTransferCoordinatorOptions) {
    if (!PRINCIPAL_PATTERN.test(options.environmentIdentity)) {
      throw new TypeError('cloud-to-lan-transfer.options-invalid');
    }
    this.#checkpoint = options.checkpoint;
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#custody = options.custody;
    this.#custodyReceiptIdFactory = options.custodyReceiptIdFactory
      ?? (() => defaultOpaqueId('custody'));
    this.#deletionOperationIdFactory = options.deletionOperationIdFactory
      ?? defaultDeletionId;
    this.#environmentIdentity = options.environmentIdentity;
    this.#expiresAtFactory = options.expiresAtFactory
      ?? defaultAuthorityTransferExpiresAt;
    this.#relinquishmentIntentIdFactory = options.relinquishmentIntentIdFactory
      ?? defaultRelinquishmentIntentId;
    this.#relinquishmentSigner = options.relinquishmentSigner;
    this.#repository = options.repository;
    this.#sourceFence = options.sourceFence;
    this.#targetTrust = options.targetTrust;
  }

  begin(input: BeginCloudToLanTransferInput): Promise<CollabAuthorityTransferStatus> {
    const request = decodeRequest('beginCloudToLanTransfer', input.request);
    return this.#run(request.projectId, async lease => {
      if (!PRINCIPAL_PATTERN.test(input.principalId)) return fail('state-conflict');
      const requestFingerprint = sha256(JSON.stringify(request));
      const transferId = await lease.withProjectScope(async scope => {
        const actor = await this.#activeActor(scope, input.principalId);
        if (actor.membership.role !== 'manager') return fail('authorization-denied');
        const operationId = transferIdFor(
          request.projectId,
          actor.membership.memberId,
          request.idempotencyKey,
        );
        const existing = await scope.portability.getLifecycleJournal(operationId);
        if (existing !== undefined) {
          if (
            existing.kind !== 'authority-transfer'
            || existing.direction !== 'cloud-to-lan'
            || existing.expectedAuthorityGeneration !== request.expectedAuthorityGeneration
            || existing.idempotencyKey !== request.idempotencyKey
            || existing.requestFingerprint !== requestFingerprint
          ) return fail('state-conflict');
          const recovery = await scope.portability.getAuthorityTransferRecovery(
            operationId,
          );
          if (
            recovery?.targetHostMemberId !== request.targetHostMemberId
            || recovery.targetUrl !== request.targetUrl
          ) return fail('state-conflict');
          return operationId;
        }
        const createdAt = timestamp(this.#clock);
        const expiresAt = selectAuthorityTransferExpiresAt(
          this.#expiresAtFactory,
          createdAt,
        );
        if (expiresAt === undefined) return fail('dependency-failed');
        const project = await scope.getProject();
        const target = await scope.findMembership(request.targetHostMemberId);
        const placement = await scope.getRepositoryPlacement();
        if (
          project?.serviceState !== 'active'
          || project.authorityGeneration !== request.expectedAuthorityGeneration
          || target?.status !== 'active'
          || placement === undefined
        ) return fail('state-conflict');
        await scope.portability.putLifecycleJournal({
          actorMemberId: actor.membership.memberId,
          createdAt,
          direction: 'cloud-to-lan',
          expectedAuthorityGeneration: request.expectedAuthorityGeneration,
          idempotencyKey: request.idempotencyKey,
          kind: 'authority-transfer',
          operationId,
          phase: 'collecting-readiness',
          projectId: request.projectId,
          requestFingerprint,
          scheduledAt: expiresAt,
        });
        await scope.portability.putAuthorityTransferRecovery({
          createdAt,
          expiresAt,
          sourceAuthority: Object.freeze({
            generation: request.expectedAuthorityGeneration,
            kind: 'cloud',
          }),
          sourceHostMemberId: undefined,
          targetAuthority: Object.freeze({
            generation: request.expectedAuthorityGeneration + 1,
            kind: 'lan',
          }),
          targetHostMemberId: request.targetHostMemberId,
          targetUrl: request.targetUrl,
          transferId: operationId,
        });
        return operationId;
      });
      return this.#requireStatus(lease, transferId);
    });
  }

  acceptTarget(
    input: AcceptCloudToLanTargetInput,
  ): Promise<CollabAuthorityTransferStatus> {
    const request = decodeRequest('acceptCloudToLanTransferTarget', input.request);
    return this.#run(request.projectId, async lease => {
      let exact = await this.#exactTransfer(lease, request.transferId);
      if (exact.recovery.targetHostMemberId !== request.targetHostMemberId) {
        return fail('state-conflict');
      }
      await this.#authorizeTarget(lease, exact, input.principalId);
      const verified = await this.#targetTrust.verifyAcceptance({
        principalId: input.principalId,
        request,
        sourceAuthority: exact.recovery.sourceAuthority as CollabCheckpointAuthority & {
          readonly kind: 'cloud';
        },
        targetAuthority: exact.recovery.targetAuthority as CollabCheckpointAuthority & {
          readonly kind: 'lan';
        },
        targetUrl: exact.recovery.targetUrl,
      });
      if (!exactTarget(verified, {
        principalId: input.principalId,
        projectId: request.projectId,
        targetAuthority: exact.recovery.targetAuthority,
        targetHostMemberId: request.targetHostMemberId,
        targetUrl: exact.recovery.targetUrl,
        transferId: request.transferId,
      })) return fail('authorization-denied');
      const evidence = Object.freeze({
        acceptanceIntentId: request.idempotencyKey,
        principalId: input.principalId,
        proof: request.targetProof,
        receiptKeyId: verified.receiptKeyId,
        receiptPublicKey: verified.receiptPublicKey,
        schemaVersion: 1 as const,
      });
      if (exact.evidence === undefined) {
        const updatedAt = timestamp(this.#clock, exact.recovery.updatedAt);
        await lease.withProjectScope(async scope => {
          await scope.portability.advanceAuthorityTransferRecoveryEvidence({
            expectedUpdatedAt: exact.recovery.updatedAt,
            targetProof: encodeTargetEvidence(evidence),
            transferId: request.transferId,
            updatedAt,
          });
          await scope.portability.putTransferReceiptKey({
            createdAt: updatedAt,
            publicKey: evidence.receiptPublicKey,
            receiptKeyId: evidence.receiptKeyId,
            transferId: request.transferId,
          });
        });
      } else if (!isDeepStrictEqual(exact.evidence, evidence)) {
        return fail('state-conflict');
      }
      exact = await this.#exactTransfer(lease, request.transferId);
      await this.#captureIfNeeded(lease, exact);
      return this.#requireStatus(lease, request.transferId);
    });
  }

  reportTargetStaged(
    input: ReportCloudToLanTargetStagedInput,
  ): Promise<CollabTransferredMembershipClaimCustodyReceipt> {
    const request = decodeRequest('reportCloudToLanTargetStaged', input.request);
    return this.#run(request.projectId, async lease => {
      let exact = await this.#exactTransfer(lease, request.transferId);
      const target = this.#requireTarget(exact);
      await this.#authorizeTarget(lease, exact, input.principalId);
      const existing = await lease.withProjectScope(scope => (
        scope.portability.getTransferClaimBatchReceipt(request.transferId)
      ));
      if (existing !== undefined) {
        const members = await lease.withProjectScope(scope => scope.listMemberships());
        if (
          !exactCustodyRequest(existing, request, exact, target.targetHostMemberId)
          || !exactBatchMembers(request.claimBatch, members, target.targetHostMemberId)
        ) {
          return fail('state-conflict');
        }
        if (exact.journal.phase === 'target-staged') {
          await this.#retainClaims(lease, exact);
          exact = await this.#exactTransfer(lease, request.transferId);
        }
        if (
          exact.journal.phase === 'claims-retained'
          || exact.journal.phase === 'cloud-relinquished'
        ) {
          await this.#relinquishIfNeeded(lease, exact);
        }
        return existing;
      }
      this.#assertNotExpired(exact);
      if (
        exact.journal.phase !== 'checkpoint-captured'
        || exact.journal.checkpointSha256 !== request.checkpointSha256
        || request.claimBatch.projectId !== request.projectId
        || request.claimBatch.transferId !== request.transferId
        || request.claimBatch.checkpointSha256 !== request.checkpointSha256
        || request.claimBatch.batchRevision !== 1
        || request.claimBatch.expiresAt !== exact.recovery.expiresAt
        || !exactDigest(
          request.claimBatch.batchSha256,
          sha256(encodeCollabTransferredMembershipClaimBatchDigestInput(
            request.claimBatch,
          )),
        )
        || request.claimBatch.targetAuthorityGeneration
          !== exact.recovery.targetAuthority.generation
        || !sameAuthority(request.targetAuthority, exact.recovery.targetAuthority)
      ) return fail('state-conflict');
      await this.#targetTrust.verifyStaged({ request, target });
      const members = await lease.withProjectScope(scope => scope.listMemberships());
      if (!exactBatchMembers(
        request.claimBatch,
        members,
        target.targetHostMemberId,
      )) return fail('state-conflict');
      const createdAt = timestamp(
        this.#clock,
        latestTimestamp(exact.journal.updatedAt, exact.recovery.updatedAt),
      );
      const envelopes = await Promise.all(request.claimBatch.claims.map(item => (
        this.#sealClaim(exact, target, request.claimBatch, item, createdAt)
      )));
      const receipt = Object.freeze({
        batchRevision: request.claimBatch.batchRevision,
        batchSha256: request.claimBatch.batchSha256,
        checkpointSha256: request.checkpointSha256,
        committedAt: createdAt,
        custodyAuthority: exact.recovery.sourceAuthority,
        operationIntentId: request.idempotencyKey,
        projectId: request.projectId,
        receiptId: this.#custodyReceiptIdFactory(),
        submittedByMemberId: target.targetHostMemberId,
        targetAuthorityGeneration: exact.recovery.targetAuthority.generation,
        transferId: request.transferId,
      } satisfies CollabTransferredMembershipClaimCustodyReceipt);
      await lease.withProjectScope(async scope => {
        await scope.portability.advanceAuthorityTransferRecoveryEvidence({
          expectedUpdatedAt: exact.recovery.updatedAt,
          stageSha256: request.stageSha256,
          transferId: request.transferId,
          updatedAt: createdAt,
        });
        await scope.portability.advanceLifecycleJournal({
          batchRevision: request.claimBatch.batchRevision,
          batchSha256: request.claimBatch.batchSha256,
          checkpointSha256: request.checkpointSha256,
          expectedPhase: 'checkpoint-captured',
          expectedState: 'active',
          nextPhase: 'target-staged',
          nextState: 'active',
          operationId: request.transferId,
          scheduledAt: exact.recovery.expiresAt,
          updatedAt: createdAt,
        });
        for (const envelope of envelopes) {
          await scope.portability.putProtectedClaimEnvelope(envelope);
        }
        await scope.portability.putClaimBatchReceipt(receipt);
      });
      exact = await this.#exactTransfer(lease, request.transferId);
      await this.#retainClaims(lease, exact);
      exact = await this.#exactTransfer(lease, request.transferId);
      await this.#relinquishIfNeeded(lease, exact);
      return receipt;
    });
  }

  confirmTargetActive(
    input: ConfirmCloudToLanTargetActiveInput,
  ): Promise<CollabAuthorityTransferStatus> {
    const request = decodeRequest('confirmCloudToLanTargetActive', input.request);
    return this.#runWithRepositoryReservation(
      request.projectId,
      async (lease, reservation) => {
      const terminal = await lease.withProjectScope(scope => (
        scope.portability.getTerminalResponder('authority-transfer', request.transferId)
      ));
      if (terminal !== undefined) {
        const replayPrincipal = terminal.eligiblePrincipals.find(value => (
          value.principalId === input.principalId
        ));
        if (
          replayPrincipal === undefined
          || terminal.replayAuthorization?.memberId !== replayPrincipal.memberId
          || Date.parse(terminal.expiresAt) <= this.#now()
        ) return fail('authorization-denied');
        if (!exactDigest(
          terminal.replayAuthorization.requestSha256,
          sha256(JSON.stringify(request)),
        )) return fail('state-conflict');
        const status = await this.#requireStatus(lease, request.transferId);
        if (
          status.phase !== 'completed'
          || status.state !== 'completed'
          || status.relinquishmentProof === null
          || !isDeepStrictEqual(status.relinquishmentProof, request.relinquishmentProof)
        ) return fail('state-conflict');
        return status;
      }
      let exact = await this.#exactTransfer(lease, request.transferId);
      const target = this.#requireTarget(exact);
      await this.#authorizeTarget(lease, exact, input.principalId);
      const targetActivationRequestSha256 = sha256(JSON.stringify(request));
      if (
        exact.recovery.relinquishmentProof === undefined
        || !isDeepStrictEqual(request.relinquishmentProof, exact.recovery.relinquishmentProof)
      ) return fail('state-conflict');
      if (exact.journal.phase === 'cloud-relinquished') {
        await this.#relinquishIfNeeded(lease, exact);
        await this.#targetTrust.verifyActivation({ request, target });
        const updatedAt = timestamp(
          this.#clock,
          latestTimestamp(exact.journal.updatedAt, exact.recovery.updatedAt),
        );
        const nextExpiresAt = renewedExpiry(
          exact.recovery.createdAt,
          exact.recovery.expiresAt,
          updatedAt,
        );
        await lease.withProjectScope(async scope => {
          await scope.portability.advanceAuthorityTransferRecoveryEvidence({
            expectedUpdatedAt: exact.recovery.updatedAt,
            ...(nextExpiresAt === undefined ? {} : { nextExpiresAt }),
            targetActivationProof: request.targetActivationProof,
            targetActivationRequestSha256,
            transferId: request.transferId,
            updatedAt,
          });
          await scope.portability.advanceLifecycleJournal({
            expectedPhase: 'cloud-relinquished',
            expectedState: 'active',
            nextPhase: 'lan-activated',
            nextState: 'active',
            operationId: request.transferId,
            scheduledAt: nextExpiresAt ?? exact.recovery.expiresAt,
            updatedAt,
          });
        });
        exact = await this.#exactTransfer(lease, request.transferId);
      } else if (
        exact.journal.phase !== 'lan-activated'
        && exact.journal.phase !== 'completed'
      ) return fail('state-conflict');
      else if (!exactDigest(
        exact.recovery.targetActivationRequestSha256 ?? '',
        targetActivationRequestSha256,
      )) return fail('state-conflict');
      if (exact.journal.phase === 'lan-activated') {
        await this.#completeIfNeeded(lease, exact, reservation);
      }
      return this.#requireStatus(lease, request.transferId);
      },
    );
  }

  getStatus(input: GetCloudToLanTransferInput): Promise<CollabAuthorityTransferStatus> {
    const request = decodeRequest('getProjectAuthorityTransfer', input.request);
    return this.#run(request.projectId, async lease => {
      await this.#authorizeCurrentOrTerminal(
        lease,
        request.transferId,
        input.principalId,
      );
      return this.#requireStatus(lease, request.transferId);
    });
  }

  getClaim(input: GetCloudToLanClaimInput): Promise<CollabTransferredMembershipClaim> {
    const request = decodeRequest('getTransferredMembershipClaim', input.request);
    return this.#run(request.projectId, async lease => {
      const memberId = await this.#authorizeCurrentOrTerminal(
        lease,
        request.transferId,
        input.principalId,
      );
      const status = await this.#requireStatus(lease, request.transferId);
      if (
        status.phase !== 'cloud-relinquished'
        && status.phase !== 'lan-activated'
        && status.phase !== 'completed'
      ) return fail('state-conflict');
      const facts = await lease.withProjectScope(async scope => ({
        envelope: await scope.portability.getProtectedClaimEnvelope(
          request.transferId,
          memberId,
        ),
        recovery: await scope.portability.getAuthorityTransferRecovery(request.transferId),
      }));
      if (facts.envelope === undefined) return fail('authorization-denied');
      if (Date.parse(facts.envelope.expiresAt) <= this.#now()) return fail('expired');
      const claim = await this.#custody.open(facts.envelope);
      if (sha256(claim) !== facts.envelope.associatedData.claimSha256) {
        return fail('recovery-required');
      }
      const targetGeneration = facts.recovery?.targetAuthority.generation
        ?? facts.envelope.associatedData.authorityGeneration + 1;
      return decodeCollabTransferredMembershipClaim({
        claim,
        expiresAt: facts.envelope.expiresAt,
        memberId,
        projectId: request.projectId,
        targetAuthorityGeneration: targetGeneration,
        transferId: request.transferId,
      });
    });
  }

  acknowledgeRedemption(
    input: AcknowledgeCloudToLanRedemptionInput,
  ): Promise<CollabTransferredMembershipRedemptionAcknowledgement> {
    const request = decodeRequest(
      'acknowledgeTransferredMembershipClaimRedemption',
      input.request,
    );
    return this.#run(request.projectId, async lease => {
      const memberId = await this.#authorizeCurrentOrTerminal(
        lease,
        request.transferId,
        input.principalId,
        true,
      );
      const status = await this.#requireStatus(lease, request.transferId);
      if (
        status.phase !== 'cloud-relinquished'
        && status.phase !== 'lan-activated'
        && status.phase !== 'completed'
      ) return fail('state-conflict');
      if (
        request.receipt.memberId !== memberId
        || request.receipt.projectId !== request.projectId
        || request.receipt.transferId !== request.transferId
      ) return fail('authorization-denied');
      const receiptKey = await lease.withProjectScope(scope => (
        scope.portability.getTransferReceiptKey(
          request.transferId,
          request.receipt.receiptKeyId,
        )
      ));
      if (receiptKey === undefined) return fail('recovery-required');
      await this.#targetTrust.verifyRedemptionReceipt({
        receipt: request.receipt,
        receiptPublicKey: receiptKey.publicKey,
      });
      const acknowledgedAt = timestampImmediatelyAfter(request.receipt.redeemedAt);
      await lease.withProjectScope(async scope => {
        await scope.portability.scrubProtectedClaimEnvelope({
          acknowledgedAt,
          memberId,
          receipt: request.receipt,
          transferId: request.transferId,
        });
        const responder = await scope.portability.getTerminalResponder(
          'authority-transfer',
          request.transferId,
        );
        const eligible = responder?.eligiblePrincipals.find(value => (
          value.memberId === memberId
          && value.principalId === input.principalId
        ));
        if (eligible !== undefined && !responder?.acknowledgements.some(value => (
          value.memberId === memberId
          && value.principalId === input.principalId
        ))) {
          await scope.portability.acknowledgeTerminalResponder({
            acknowledgedAt,
            memberId,
            operationId: request.transferId,
            operationKind: 'authority-transfer',
            principalId: input.principalId,
          });
        }
      });
      return Object.freeze({
        acknowledgedAt,
        memberId,
        projectId: request.projectId,
        receiptId: request.receipt.receiptId,
        transferId: request.transferId,
      });
    });
  }

  cancel(input: CancelCloudToLanTransferInput): Promise<CollabAuthorityTransferStatus> {
    const request = decodeRequest('cancelProjectAuthorityTransfer', input.request);
    return this.#run(request.projectId, async lease => {
      let exact = await this.#exactTransfer(lease, request.transferId);
      await this.#authorizeManager(lease, input.principalId);
      const fingerprint = sha256(JSON.stringify(request));
      if (exact.journal.state === 'cancelled') {
        if (exact.recovery.cancellationRequestSha256 !== fingerprint) {
          return fail('state-conflict');
        }
        return this.#requireStatus(lease, request.transferId);
      }
      if (exact.journal.phase !== request.expectedPhase) {
        if (exact.recovery.cancellationRequestSha256 !== fingerprint) {
          return fail('state-conflict');
        }
      } else {
        await this.#startCancellation(lease, exact, fingerprint);
      }
      exact = await this.#exactTransfer(lease, request.transferId);
      await this.#settleCancellation(lease, exact);
      return this.#requireStatus(lease, request.transferId);
    });
  }

  expire(projectId: CollabProjectId, transferId: string): Promise<void> {
    return this.#runWithRepositoryReservation(projectId, async (
      lease,
      reservation,
    ) => {
      const exact = await this.#exactTransfer(lease, transferId);
      if (!this.#isExpired(exact)) return;
      if (
        exact.journal.phase === 'cloud-relinquished'
        || exact.journal.phase === 'lan-activated'
        || exact.journal.phase === 'completed'
      ) {
        await this.#recoverExact(lease, exact, reservation);
        return;
      }
      if (exact.journal.state !== 'active') return;
      if (exact.recovery.cancellationRequestSha256 === undefined) {
        await this.#startCancellation(
          lease,
          exact,
          sha256(`expiry\0${projectId}\0${transferId}\0${exact.recovery.expiresAt}`),
        );
      }
      await this.#settleCancellation(
        lease,
        await this.#exactTransfer(lease, transferId),
      );
    });
  }

  async recover(input: RecoverProjectLifecycleInput): Promise<ProjectLifecycleRecoveryOutcome> {
    if (
      input.journal.kind !== 'authority-transfer'
      || input.journal.direction !== 'cloud-to-lan'
    ) return fail('state-conflict');
    const suppliedReservation = input.repositoryReservation;
    if (
      suppliedReservation !== undefined
      && !exactRepositoryReservation(suppliedReservation, input.journal.projectId)
    ) {
      return fail('recovery-required');
    }
    return this.#track(async () => {
      const exact = await this.#exactTransfer(input.lease, input.journal.operationId);
      return this.#recoverExact(input.lease, exact, suppliedReservation);
    });
  }

  reserveRecovery(
    projectId: CollabProjectId,
    journal: ProjectLifecycleJournalRecord,
  ): Promise<ExactRepositoryOperationReservation | undefined> {
    if (this.#closed) {
      return Promise.reject(new CloudToLanTransferCoordinatorError('closed'));
    }
    if (
      journal.kind !== 'authority-transfer'
      || journal.direction !== 'cloud-to-lan'
      || journal.projectId !== projectId
    ) {
      return Promise.reject(
        new CloudToLanTransferCoordinatorError('state-conflict'),
      );
    }
    if (journal.state !== 'active' || journal.phase !== 'lan-activated') {
      return Promise.resolve(undefined);
    }
    return this.#repository.reserveExactRepositoryOperation(projectId);
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = Promise.allSettled([...this.#running]).then(() => undefined);
    }
    return this.#closePromise;
  }

  async #recoverExact(
    lease: PinnedProjectLease,
    initial: ExactTransfer,
    repositoryReservation: ExactRepositoryOperationReservation | undefined,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    let exact = initial;
    if (exact.journal.state === 'completed' || exact.journal.state === 'cancelled') {
      return 'settled';
    }
    if (exact.journal.state === 'recovery-required') return fail('recovery-required');
    if (
      exact.journal.phase === 'cancel-intent'
      || exact.journal.phase === 'target-invalidated'
      || exact.journal.phase === 'target-cleaned'
      || exact.journal.phase === 'source-reopened'
    ) {
      try {
        await this.#settleCancellation(lease, exact);
      } catch (error: unknown) {
        if (
          error instanceof CloudToLanTransferCoordinatorError
          && error.code === 'dependency-failed'
        ) return 'waiting-for-external-proof';
        throw error;
      }
      return 'settled';
    }
    if (
      this.#isExpired(exact)
      && exact.recovery.relinquishmentProof === undefined
    ) {
      if (exact.recovery.cancellationRequestSha256 === undefined) {
        await this.#startCancellation(
          lease,
          exact,
          sha256(
            `expiry\0${exact.journal.projectId}\0${exact.journal.operationId}`
              + `\0${exact.recovery.expiresAt}`,
          ),
        );
        exact = await this.#exactTransfer(lease, exact.journal.operationId);
      }
      try {
        await this.#settleCancellation(lease, exact);
      } catch (error: unknown) {
        if (
          error instanceof CloudToLanTransferCoordinatorError
          && error.code === 'dependency-failed'
        ) return 'waiting-for-external-proof';
        throw error;
      }
      return 'settled';
    }
    if (exact.journal.phase === 'collecting-readiness') {
      if (exact.evidence === undefined) return 'waiting-for-external-proof';
      await this.#captureIfNeeded(lease, exact);
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'cloud-quiesced') {
      await this.#captureIfNeeded(lease, exact);
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'checkpoint-captured') {
      return 'waiting-for-external-proof';
    }
    if (exact.journal.phase === 'target-staged') {
      const receipt = await lease.withProjectScope(scope => (
        scope.portability.getTransferClaimBatchReceipt(exact.journal.operationId)
      ));
      if (receipt === undefined) return 'waiting-for-external-proof';
      await this.#retainClaims(lease, exact);
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'claims-retained') {
      await this.#relinquishIfNeeded(lease, exact);
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'cloud-relinquished') {
      await this.#relinquishIfNeeded(lease, exact);
      return 'waiting-for-external-proof';
    }
    if (exact.journal.phase === 'lan-activated') {
      if (repositoryReservation === undefined) return fail('recovery-required');
      await this.#completeIfNeeded(lease, exact, repositoryReservation);
      return 'settled';
    }
    if (exact.journal.phase === 'completed') return 'settled';
    return fail('recovery-required');
  }

  async #captureIfNeeded(lease: PinnedProjectLease, initial: ExactTransfer): Promise<void> {
    let exact = initial;
    this.#assertNotExpired(exact);
    if (exact.journal.phase === 'collecting-readiness') {
      if (exact.evidence === undefined) return fail('state-conflict');
      await this.#sourceFence.quiesce({
        expectedAuthorityGeneration: exact.journal.expectedAuthorityGeneration,
        lease,
        projectId: exact.journal.projectId,
        transferId: exact.journal.operationId,
      });
      const updatedAt = timestamp(this.#clock, exact.journal.updatedAt);
      await lease.withProjectScope(async scope => {
        const project = await scope.getProject();
        if (
          project?.serviceState !== 'active'
          || project.authorityGeneration !== exact.journal.expectedAuthorityGeneration
        ) return fail('state-conflict');
        await scope.advanceProjectAuthorityState({
          expectedAuthorityGeneration: project.authorityGeneration,
          expectedAuthorityStateRevision: project.authorityStateRevision,
          expectedServiceState: 'active',
          nextAuthorityGeneration: project.authorityGeneration,
          nextServiceState: 'read-only-transition',
        });
        await scope.portability.advanceLifecycleJournal({
          expectedPhase: 'collecting-readiness',
          expectedState: 'active',
          nextPhase: 'cloud-quiesced',
          nextState: 'active',
          operationId: exact.journal.operationId,
          scheduledAt: exact.recovery.expiresAt,
          updatedAt,
        });
      });
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'cloud-quiesced') {
      const captured = await this.#checkpoint.capture({
        expiresAt: exact.recovery.expiresAt,
        lease,
        operationId: exact.journal.operationId,
        projectId: exact.journal.projectId,
        sourceAuthority: exact.recovery.sourceAuthority as CollabCheckpointAuthority & {
          readonly kind: 'cloud';
        },
        targetAuthority: exact.recovery.targetAuthority as CollabCheckpointAuthority & {
          readonly kind: 'lan';
        },
      });
      if (
        captured.projectId !== exact.journal.projectId
        || captured.operationId !== exact.journal.operationId
        || !SHA256_PATTERN.test(captured.checkpointSha256)
      ) return fail('invalid-checkpoint');
      await this.#advance(lease, exact.journal, {
        checkpointSha256: captured.checkpointSha256,
        nextPhase: 'checkpoint-captured',
        scheduledAt: exact.recovery.expiresAt,
      });
      return;
    }
    if (
      exact.journal.phase !== 'checkpoint-captured'
      && exact.journal.phase !== 'target-staged'
      && exact.journal.phase !== 'claims-retained'
      && exact.journal.phase !== 'cloud-relinquished'
      && exact.journal.phase !== 'lan-activated'
      && exact.journal.phase !== 'completed'
    ) return fail('state-conflict');
  }

  async #retainClaims(lease: PinnedProjectLease, exact: ExactTransfer): Promise<void> {
    if (exact.journal.phase === 'claims-retained') return;
    if (exact.journal.phase !== 'target-staged') return fail('state-conflict');
    const receipt = await lease.withProjectScope(scope => (
      scope.portability.getTransferClaimBatchReceipt(exact.journal.operationId)
    ));
    if (
      receipt === undefined
      || receipt.batchRevision !== exact.journal.batchRevision
      || receipt.batchSha256 !== exact.journal.batchSha256
      || receipt.checkpointSha256 !== exact.journal.checkpointSha256
      || !sameAuthority(receipt.custodyAuthority, exact.recovery.sourceAuthority)
    ) return fail('recovery-required');
    await this.#advance(lease, exact.journal, {
      nextPhase: 'claims-retained',
      scheduledAt: exact.recovery.expiresAt,
    });
  }

  async #relinquishIfNeeded(lease: PinnedProjectLease, initial: ExactTransfer): Promise<void> {
    let exact = initial;
    if (
      exact.journal.phase === 'lan-activated'
      || exact.journal.phase === 'completed'
    ) return;
    if (exact.journal.phase === 'cloud-relinquished') {
      const proof = exact.recovery.relinquishmentProof;
      if (proof === undefined) return fail('recovery-required');
      this.#assertRelinquishment(proof, exact);
      await this.#sourceFence.relinquish({ lease, proof });
      return;
    }
    if (exact.journal.phase !== 'claims-retained') return fail('state-conflict');
    if (exact.recovery.relinquishmentProof !== undefined) {
      return fail('recovery-required');
    }
    this.#assertNotExpired(exact);
    if (
      exact.journal.batchRevision === undefined
      || exact.journal.batchSha256 === undefined
      || exact.journal.checkpointSha256 === undefined
    ) return fail('recovery-required');
    const payload = Object.freeze({
      batchRevision: exact.journal.batchRevision,
      batchSha256: exact.journal.batchSha256,
      certificateAlgorithm: 'ed25519' as const,
      checkpointSha256: exact.journal.checkpointSha256,
      committedAt: timestamp(
        this.#clock,
        latestTimestamp(exact.journal.updatedAt, exact.recovery.updatedAt),
      ),
      operationIntentId: this.#relinquishmentIntentIdFactory(
        exact.journal.operationId,
      ),
      projectId: exact.journal.projectId,
      sourceAuthority: exact.recovery.sourceAuthority as CollabCheckpointAuthority & {
        readonly kind: 'cloud';
      },
      sourceHostMemberId: null,
      targetAuthority: exact.recovery.targetAuthority as CollabCheckpointAuthority & {
        readonly kind: 'lan';
      },
      transferId: exact.journal.operationId,
    });
    const certificate = await this.#relinquishmentSigner.sign({
      signingInput: encodeCollabAuthorityRelinquishmentProofSigningInput(payload),
    });
    this.#assertNotExpired(exact);
    if (!canonicalCertificate(certificate)) return fail('dependency-failed');
    const persistedProof = decodeCollabAuthorityRelinquishmentProof({
      ...payload,
      certificate,
    });
    await lease.withProjectScope(async scope => {
      const project = await scope.getProject();
      if (
        project?.serviceState !== 'read-only-transition'
        || project.authorityGeneration !== exact.journal.expectedAuthorityGeneration
      ) return fail('state-conflict');
      await scope.portability.advanceAuthorityTransferRecoveryEvidence({
        expectedUpdatedAt: exact.recovery.updatedAt,
        relinquishmentProof: persistedProof,
        transferId: exact.journal.operationId,
        updatedAt: persistedProof.committedAt,
      });
      await scope.advanceProjectAuthorityState({
        expectedAuthorityGeneration: project.authorityGeneration,
        expectedAuthorityStateRevision: project.authorityStateRevision,
        expectedServiceState: 'read-only-transition',
        nextAuthorityGeneration: exact.recovery.targetAuthority.generation,
        nextServiceState: 'deleting',
      });
      await scope.portability.advanceLifecycleJournal({
        expectedPhase: 'claims-retained',
        expectedState: 'active',
        nextPhase: 'cloud-relinquished',
        nextState: 'active',
        operationId: exact.journal.operationId,
        scheduledAt: exact.recovery.expiresAt,
        updatedAt: persistedProof.committedAt,
      });
    });
    exact = await this.#exactTransfer(lease, exact.journal.operationId);
    const proof = exact.recovery.relinquishmentProof;
    if (proof === undefined || exact.journal.phase !== 'cloud-relinquished') {
      return fail('recovery-required');
    }
    this.#assertRelinquishment(proof, exact);
    await this.#sourceFence.relinquish({ lease, proof });
  }

  async #completeIfNeeded(
    lease: PinnedProjectLease,
    initial: ExactTransfer,
    repositoryReservation: ExactRepositoryOperationReservation,
  ): Promise<void> {
    if (initial.journal.phase === 'completed') return;
    let exact = initial;
    if (
      exact.journal.phase !== 'lan-activated'
      || exact.recovery.targetActivationProof === undefined
      || exact.recovery.targetActivationRequestSha256 === undefined
      || exact.recovery.relinquishmentProof === undefined
      || exact.journal.checkpointSha256 === undefined
    ) return fail('state-conflict');
    await this.#checkpoint.discard(this.#capturedCheckpoint(exact));
    let completedAt = timestamp(
      this.#clock,
      latestTimestamp(exact.journal.updatedAt, exact.recovery.updatedAt),
    );
    const nextExpiresAt = renewedExpiry(
      exact.recovery.createdAt,
      exact.recovery.expiresAt,
      completedAt,
    );
    if (nextExpiresAt !== undefined) {
      await lease.withProjectScope(scope => (
        scope.portability.advanceAuthorityTransferRecoveryEvidence({
          expectedUpdatedAt: exact.recovery.updatedAt,
          nextExpiresAt,
          transferId: exact.journal.operationId,
          updatedAt: completedAt,
        })
      ));
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
      completedAt = timestamp(
        this.#clock,
        latestTimestamp(exact.journal.updatedAt, exact.recovery.updatedAt),
      );
    }
    const targetActivationRequestSha256 = exact.recovery
      .targetActivationRequestSha256;
    if (targetActivationRequestSha256 === undefined) return fail('recovery-required');
    await lease.withProjectScope(scope => (
      scope.portability.renewProtectedClaimEnvelopes({
        expiresAt: exact.recovery.expiresAt,
        transferId: exact.journal.operationId,
      })
    ));
    const current = await this.#requireStatus(lease, exact.journal.operationId);
    const completed = decodeCollabAuthorityTransferStatus({
      ...current,
      phase: 'completed',
      state: 'completed',
      updatedAt: completedAt,
    });
    const responseJson = JSON.stringify(completed);
    const resultSha256 = sha256(responseJson);
    const deletionOperationId = this.#deletionOperationIdFactory(
      exact.journal.operationId,
    );
    if (!isCollabOpaqueId(deletionOperationId)) return fail('dependency-failed');
    const repositoryPreflight = await lease.withProjectScope(async scope => {
      const project = await scope.getProject();
      const placement = await scope.getRepositoryPlacement();
      if (
        project?.serviceState !== 'deleting'
        || project.authorityGeneration !== exact.recovery.targetAuthority.generation
        || placement?.active !== true
      ) return fail('recovery-required');
      return Object.freeze({
        authorityStateRevision: project.authorityStateRevision,
        placement,
      });
    });
    await this.#repository.verifyExactRepository(
      repositoryReservation,
      repositoryPreflight.placement,
    );
    await lease.withProjectScope(async scope => {
      const project = await scope.getProject();
      const placement = await scope.getRepositoryPlacement();
      const members = await scope.listMemberships();
      const principals = await scope.portability.listActiveProjectPrincipalBindings();
      if (
        project?.serviceState !== 'deleting'
        || project.authorityGeneration !== exact.recovery.targetAuthority.generation
        || project.authorityStateRevision !== repositoryPreflight.authorityStateRevision
        || placement?.active !== true
        || placement.generation !== repositoryPreflight.placement.generation
        || placement.repositoryStorageKey
          !== repositoryPreflight.placement.repositoryStorageKey
        || placement.storageNodeId !== repositoryPreflight.placement.storageNodeId
      ) return fail('recovery-required');
      this.#assertTerminalPrincipals(
        members,
        principals,
        this.#requireTarget(exact).targetHostMemberId,
      );
      await scope.portability.advanceLifecycleJournal({
        expectedPhase: 'lan-activated',
        expectedState: 'active',
        nextPhase: 'completed',
        nextState: 'completed',
        operationId: exact.journal.operationId,
        resultSha256,
        scheduledAt: exact.recovery.expiresAt,
        updatedAt: completedAt,
      });
      await scope.portability.putTerminalResponder({
        createdAt: completedAt,
        eligiblePrincipals: principals.map(binding => Object.freeze({
          memberId: binding.memberId,
          principalId: binding.principalId,
        })),
        expiresAt: exact.recovery.expiresAt,
        operationId: exact.journal.operationId,
        operationKind: 'authority-transfer',
        replayAuthorization: {
          memberId: this.#requireTarget(exact).targetHostMemberId,
          requestSha256: targetActivationRequestSha256,
        },
        responseJson,
        responseSha256: resultSha256,
      });
      await scope.portability.putProjectTombstone({
        authorityGeneration: exact.recovery.targetAuthority.generation,
        projectId: exact.journal.projectId,
        resultSha256,
        retiredAt: completedAt,
        terminalExpiresAt: exact.recovery.expiresAt,
        terminalOperationId: exact.journal.operationId,
        terminalOperationKind: 'authority-transfer',
      });
      await scope.portability.putLifecycleJournal({
        actorMemberId: exact.journal.actorMemberId,
        createdAt: completedAt,
        direction: undefined,
        expectedAuthorityGeneration: exact.recovery.targetAuthority.generation,
        idempotencyKey: deletionOperationId,
        kind: 'delete',
        operationId: deletionOperationId,
        phase: 'traffic-denied',
        projectId: exact.journal.projectId,
        requestFingerprint: resultSha256,
        scheduledAt: completedAt,
      });
      if (exact.journal.actorMemberId === undefined) return fail('recovery-required');
      await scope.portability.putDeletionIntent({
        authorizationSha256: resultSha256,
        authorizedMemberId: exact.journal.actorMemberId,
        createdAt: completedAt,
        operationId: deletionOperationId,
        placementGeneration: placement.generation,
        reason: 'cloud-to-lan',
        repositoryStorageKey: placement.repositoryStorageKey,
        storageNodeId: placement.storageNodeId,
        terminalOperationId: exact.journal.operationId,
        terminalOperationKind: 'authority-transfer',
      });
    });
  }

  async #startCancellation(
    lease: PinnedProjectLease,
    exact: ExactTransfer,
    fingerprint: string,
  ): Promise<void> {
    if (
      exact.journal.phase === 'cloud-relinquished'
      || exact.journal.phase === 'lan-activated'
      || exact.journal.phase === 'completed'
      || exact.recovery.relinquishmentProof !== undefined
      || exact.journal.state !== 'active'
    ) return fail('state-conflict');
    const updatedAt = timestamp(
      this.#clock,
      latestTimestamp(exact.journal.updatedAt, exact.recovery.updatedAt),
    );
    await lease.withProjectScope(async scope => {
      await scope.portability.advanceAuthorityTransferRecoveryEvidence({
        cancellationRequestSha256: fingerprint,
        expectedUpdatedAt: exact.recovery.updatedAt,
        transferId: exact.journal.operationId,
        updatedAt,
      });
      await scope.portability.advanceLifecycleJournal({
        expectedPhase: exact.journal.phase,
        expectedState: 'active',
        nextPhase: 'cancel-intent',
        nextState: 'active',
        operationId: exact.journal.operationId,
        scheduledAt: exact.recovery.expiresAt,
        updatedAt,
      });
    });
  }

  async #settleCancellation(lease: PinnedProjectLease, initial: ExactTransfer): Promise<void> {
    let exact = initial;
    if (exact.journal.phase === 'cancel-intent') {
      const cleanup = await this.#targetTrust.invalidateAndClean({
        checkpointSha256: exact.journal.checkpointSha256,
        projectId: exact.journal.projectId,
        stageSha256: exact.recovery.stageSha256,
        target: exact.target,
        transferId: exact.journal.operationId,
      });
      if (!SHA256_PATTERN.test(cleanup.cleanupSha256)) return fail('dependency-failed');
      const updatedAt = timestamp(
        this.#clock,
        latestTimestamp(exact.journal.updatedAt, exact.recovery.updatedAt),
      );
      await lease.withProjectScope(async scope => {
        await scope.portability.advanceAuthorityTransferRecoveryEvidence({
          expectedUpdatedAt: exact.recovery.updatedAt,
          sourceReopenSha256: cleanup.cleanupSha256,
          transferId: exact.journal.operationId,
          updatedAt,
        });
        await scope.portability.advanceLifecycleJournal({
          expectedPhase: 'cancel-intent',
          expectedState: 'active',
          nextPhase: 'target-invalidated',
          nextState: 'active',
          operationId: exact.journal.operationId,
          scheduledAt: exact.recovery.expiresAt,
          updatedAt,
        });
      });
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'target-invalidated') {
      if (exact.journal.checkpointSha256 !== undefined) {
        await this.#checkpoint.discard(this.#capturedCheckpoint(exact));
      }
      if (
        exact.journal.checkpointSha256 !== undefined
        && exact.journal.batchRevision !== undefined
      ) {
        await lease.withProjectScope(scope => (
          scope.portability.deleteProtectedClaimEnvelopes({
            checkpointSha256: exact.journal.checkpointSha256 as string,
            transferId: exact.journal.operationId,
          })
        ));
      }
      await this.#advance(lease, exact.journal, {
        nextPhase: 'target-cleaned',
        scheduledAt: exact.recovery.expiresAt,
      });
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'target-cleaned') {
      if (exact.recovery.sourceReopenSha256 === undefined) {
        return fail('recovery-required');
      }
      await this.#sourceFence.reopen({
        cleanupSha256: exact.recovery.sourceReopenSha256,
        expectedAuthorityGeneration: exact.journal.expectedAuthorityGeneration,
        lease,
        projectId: exact.journal.projectId,
        transferId: exact.journal.operationId,
      });
      const updatedAt = timestamp(this.#clock, exact.journal.updatedAt);
      await lease.withProjectScope(async scope => {
        const project = await scope.getProject();
        if (project === undefined) return fail('recovery-required');
        if (project.serviceState === 'read-only-transition') {
          await scope.advanceProjectAuthorityState({
            expectedAuthorityGeneration: exact.journal.expectedAuthorityGeneration,
            expectedAuthorityStateRevision: project.authorityStateRevision,
            expectedServiceState: 'read-only-transition',
            nextAuthorityGeneration: exact.journal.expectedAuthorityGeneration,
            nextServiceState: 'active',
          });
        } else if (
          project.serviceState !== 'active'
          || project.authorityGeneration !== exact.journal.expectedAuthorityGeneration
        ) return fail('recovery-required');
        await scope.portability.advanceLifecycleJournal({
          expectedPhase: 'target-cleaned',
          expectedState: 'active',
          nextPhase: 'source-reopened',
          nextState: 'active',
          operationId: exact.journal.operationId,
          scheduledAt: exact.recovery.expiresAt,
          updatedAt,
        });
      });
      exact = await this.#exactTransfer(lease, exact.journal.operationId);
    }
    if (exact.journal.phase === 'source-reopened') {
      await this.#advance(lease, exact.journal, {
        nextPhase: 'cancelled',
        nextState: 'cancelled',
        scheduledAt: exact.recovery.expiresAt,
      });
      return;
    }
    if (exact.journal.phase !== 'cancelled') return fail('recovery-required');
  }

  async #sealClaim(
    exact: ExactTransfer,
    target: VerifiedCloudToLanTarget,
    batch: CollabTransferredMembershipClaimBatch,
    item: CollabTransferredMembershipClaimBatch['claims'][number],
    createdAt: CollabIsoTimestamp,
  ): Promise<ProtectedClaimEnvelopeInput> {
    const associatedData = Object.freeze({
      authorityGeneration: exact.recovery.sourceAuthority.generation,
      checkpointSha256: batch.checkpointSha256,
      claimSha256: sha256(item.claim),
      envelopeVersion: 1 as const,
      environmentIdentity: this.#environmentIdentity,
      memberId: item.memberId,
      projectId: exact.journal.projectId,
      transferId: exact.journal.operationId,
    });
    const envelope = await this.#custody.seal({
      associatedData,
      claim: item.claim,
      createdAt,
      expiresAt: batch.expiresAt,
      receiptKeyId: target.receiptKeyId,
    });
    if (
      !isDeepStrictEqual(envelope.associatedData, associatedData)
      || envelope.associatedDataSha256 !== sha256(
        encodeCollabProtectedClaimAssociatedData(associatedData),
      )
      || envelope.memberId !== item.memberId
      || envelope.transferId !== exact.journal.operationId
      || envelope.receiptKeyId !== target.receiptKeyId
      || envelope.createdAt !== createdAt
      || envelope.expiresAt !== batch.expiresAt
    ) return fail('dependency-failed');
    return envelope;
  }

  async #activeActor(
    scope: ProjectScope,
    principalId: string,
  ): Promise<Readonly<{
    readonly binding: ProjectPrincipalBindingRecord;
    readonly membership: ProjectMembershipRecord;
  }>> {
    if (!PRINCIPAL_PATTERN.test(principalId)) return fail('authorization-denied');
    const binding = await scope.portability.findProjectPrincipalBinding(principalId);
    if (binding?.state !== 'active') return fail('authorization-denied');
    const membership = await scope.findMembership(binding.memberId);
    if (membership?.status !== 'active') return fail('authorization-denied');
    return Object.freeze({ binding, membership });
  }

  async #authorizeManager(
    lease: PinnedProjectLease,
    principalId: string,
  ): Promise<CollabMemberId> {
    return lease.withProjectScope(async scope => {
      const actor = await this.#activeActor(scope, principalId);
      if (actor.membership.role !== 'manager') return fail('authorization-denied');
      return actor.membership.memberId;
    });
  }

  async #authorizeTarget(
    lease: PinnedProjectLease,
    exact: ExactTransfer,
    principalId: string,
  ): Promise<void> {
    await lease.withProjectScope(async scope => {
      const actor = await this.#activeActor(scope, principalId);
      if (actor.membership.memberId !== exact.recovery.targetHostMemberId) {
        return fail('authorization-denied');
      }
    });
  }

  async #authorizeCurrentOrTerminal(
    lease: PinnedProjectLease,
    transferId: string,
    principalId: string,
    includeAcknowledged = false,
  ): Promise<CollabMemberId> {
    if (!PRINCIPAL_PATTERN.test(principalId)) return fail('authorization-denied');
    return lease.withProjectScope(async scope => {
      const responder = await scope.portability.getTerminalResponder(
        'authority-transfer',
        transferId,
      );
      if (responder !== undefined) {
        const terminal = responder.eligiblePrincipals.find(value => (
          value.principalId === principalId
        )) ?? (includeAcknowledged
          ? responder.acknowledgements.find(value => (
              value.principalId === principalId
            ))
          : undefined);
        if (
          terminal === undefined
          || Date.parse(responder.expiresAt) <= this.#now()
        ) return fail('authorization-denied');
        return terminal.memberId;
      }
      const binding = await scope.portability.findProjectPrincipalBinding(principalId);
      if (binding?.state === 'active') {
        const membership = await scope.findMembership(binding.memberId);
        if (membership?.status === 'active') return binding.memberId;
      }
      return fail('authorization-denied');
    });
  }

  async #exactTransfer(
    lease: PinnedProjectLease,
    transferId: string,
  ): Promise<ExactTransfer> {
    const facts = await lease.withProjectScope(async scope => ({
      journal: await scope.portability.getLifecycleJournal(transferId),
      recovery: await scope.portability.getAuthorityTransferRecovery(transferId),
    }));
    if (
      facts.journal?.kind !== 'authority-transfer'
      || facts.journal.direction !== 'cloud-to-lan'
      || facts.recovery === undefined
      || facts.recovery.transferId !== transferId
      || facts.recovery.sourceAuthority.kind !== 'cloud'
      || facts.recovery.targetAuthority.kind !== 'lan'
      || facts.recovery.sourceAuthority.generation
        !== facts.journal.expectedAuthorityGeneration
      || facts.recovery.targetAuthority.generation
        !== facts.journal.expectedAuthorityGeneration + 1
      || facts.recovery.targetHostMemberId === undefined
    ) return fail('recovery-required');
    const evidence = decodeTargetEvidence(facts.recovery.targetProof);
    const target = evidence === undefined ? undefined : Object.freeze({
      principalId: evidence.principalId,
      projectId: facts.journal.projectId,
      receiptKeyId: evidence.receiptKeyId,
      receiptPublicKey: evidence.receiptPublicKey,
      targetAuthority: facts.recovery.targetAuthority as CollabCheckpointAuthority & {
        readonly kind: 'lan';
      },
      targetHostMemberId: facts.recovery.targetHostMemberId,
      targetUrl: facts.recovery.targetUrl,
      transferId,
    });
    return Object.freeze({
      evidence,
      journal: facts.journal,
      recovery: facts.recovery,
      target,
    });
  }

  #requireTarget(exact: ExactTransfer): VerifiedCloudToLanTarget {
    if (exact.target === undefined) return fail('recovery-required');
    return exact.target;
  }

  #capturedCheckpoint(exact: ExactTransfer): CapturedCloudToLanCheckpoint {
    if (exact.journal.checkpointSha256 === undefined) return fail('recovery-required');
    return Object.freeze({
      checkpointSha256: exact.journal.checkpointSha256,
      operationId: exact.journal.operationId,
      projectId: exact.journal.projectId,
    });
  }

  #assertRelinquishment(
    proof: CollabAuthorityRelinquishmentProof,
    exact: ExactTransfer,
  ): void {
    if (
      proof.projectId !== exact.journal.projectId
      || proof.transferId !== exact.journal.operationId
      || proof.sourceHostMemberId !== null
      || !sameAuthority(proof.sourceAuthority, exact.recovery.sourceAuthority)
      || !sameAuthority(proof.targetAuthority, exact.recovery.targetAuthority)
      || proof.checkpointSha256 !== exact.journal.checkpointSha256
      || proof.batchRevision !== exact.journal.batchRevision
      || proof.batchSha256 !== exact.journal.batchSha256
    ) return fail('state-conflict');
  }

  #assertTerminalPrincipals(
    members: readonly ProjectMembershipRecord[],
    principals: readonly ProjectPrincipalBindingRecord[],
    targetHostMemberId: CollabMemberId,
  ): void {
    const activeMembers = new Set(members
      .filter(member => member.status === 'active')
      .map(member => member.memberId));
    const boundMembers = principals.map(binding => binding.memberId);
    if (
      activeMembers.size === 0
      || principals.length === 0
      || new Set(boundMembers).size !== boundMembers.length
      || !boundMembers.includes(targetHostMemberId)
      || boundMembers.some(memberId => !activeMembers.has(memberId))
    ) return fail('recovery-required');
  }

  #assertNotExpired(exact: ExactTransfer): void {
    if (this.#isExpired(exact)) return fail('expired');
  }

  #isExpired(exact: ExactTransfer): boolean {
    return this.#now() >= Date.parse(exact.recovery.expiresAt);
  }

  #now(): number {
    const observed = this.#clock();
    if (Number.isNaN(observed.valueOf())) return fail('dependency-failed');
    return observed.valueOf();
  }

  async #advance(
    lease: PinnedProjectLease,
    journal: ProjectLifecycleJournalRecord,
    input: Readonly<{
      readonly checkpointSha256?: string;
      readonly nextPhase: string;
      readonly nextState?: 'active' | 'cancelled' | 'completed';
      readonly scheduledAt: CollabIsoTimestamp;
    }>,
  ): Promise<void> {
    await lease.withProjectScope(scope => scope.portability.advanceLifecycleJournal({
      ...(input.checkpointSha256 === undefined
        ? {}
        : { checkpointSha256: input.checkpointSha256 }),
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
    const facts = await lease.withProjectScope(async scope => ({
      responder: await scope.portability.getTerminalResponder(
        'authority-transfer',
        transferId,
      ),
      status: await scope.portability.getAuthorityTransferStatus(transferId),
    }));
    if (facts.status?.direction === 'cloud-to-lan') return facts.status;
    if (facts.responder === undefined) return fail('recovery-required');
    try {
      const terminal = decodeCollabAuthorityTransferStatus(
        JSON.parse(facts.responder.responseJson) as unknown,
      );
      if (terminal.direction !== 'cloud-to-lan') return fail('recovery-required');
      return terminal;
    } catch (error: unknown) {
      if (error instanceof CloudToLanTransferCoordinatorError) throw error;
      return fail('recovery-required');
    }
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

  #runWithRepositoryReservation<Result>(
    projectId: CollabProjectId,
    operation: (
      lease: PinnedProjectLease,
      reservation: ExactRepositoryOperationReservation,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.#track(async () => {
      let reservation: ExactRepositoryOperationReservation;
      try {
        reservation = await this.#repository.reserveExactRepositoryOperation(projectId);
      } catch (error: unknown) {
        return dependency(error);
      }
      let lease: PinnedProjectLease;
      try {
        lease = await this.#coordination.acquireProjectLease(projectId);
      } catch (error: unknown) {
        await reservation.close().catch(() => undefined);
        return dependency(error);
      }
      let failure: unknown;
      try {
        if (this.#closed) return fail('closed');
        return await operation(lease, reservation);
      } catch (error: unknown) {
        failure = error;
        return dependency(error);
      } finally {
        try {
          await lease.close();
        } catch (error: unknown) {
          if (failure === undefined) dependency(error);
        } finally {
          await reservation.close().catch(() => undefined);
        }
      }
    });
  }

  #track<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new CloudToLanTransferCoordinatorError('closed'));
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
