import { createHash } from 'node:crypto';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_PROTECTED_CLAIM_ENVELOPE_LIMITS,
  COLLAB_PROTECTED_CLAIM_ENVELOPE_VERSION,
  collabControlOperationCodec,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabProtectedClaimAssociatedData,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type { TerminalProjectContinuityRecord } from '../../coordination/ProjectCheckpointPersistence.js';

export interface TerminalProjectContinuityArtifact {
  readonly json: string;
  readonly projectId: CollabProjectId;
  readonly records: readonly TerminalProjectContinuityRecord[];
  readonly sha256: string;
}

const KIND_ORDER = new Map<string, number>([
  'lifecycle-journal',
  'transfer-receipt-key',
  'transfer-redemption-receipt',
  'terminal-principal',
  'terminal-responder-replay',
  'terminal-responder',
  'protected-claim-envelope',
  'tombstone',
].map((kind, index) => [kind, index]));
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PHASE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const BACKUP_EXPORT_ACTIVE_PHASES = new Set([
  'prepared',
  'coordination-captured',
  'repository-captured',
  'checkpoint-verified',
  'artifact-published',
  'cancel-intent',
]);
const BACKUP_EXPORT_CHECKPOINT_PHASES = new Set([
  'checkpoint-verified', 'artifact-published', 'completed',
]);
const DELETE_ACTIVE_PHASES = new Set([
  'traffic-denied',
  'repository-delete-intent',
  'repository-removed',
  'coordination-removed',
  'tombstoned',
]);

function fail(reason = 'invalid'): never {
  throw new Error(`terminal-project-continuity-artifact.error.${reason}`);
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function nullableSha256(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && SHA256_PATTERN.test(value));
}

function nullablePositiveInteger(value: unknown): value is number | null {
  return value === null || positiveInteger(value);
}

function canonicalBase64url(
  value: unknown,
  maximumBytes: number,
  exactBytes?: number,
): value is string {
  if (
    typeof value !== 'string'
    || !BASE64URL_PATTERN.test(value)
  ) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value
    && decoded.byteLength <= maximumBytes
    && (exactBytes === undefined || decoded.byteLength === exactBytes);
}

function exactValue(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!plain(value) || !exactKeys(value, keys)) return fail('record-schema');
  return value;
}

function invalidLifecycleSemantics(value: Record<string, unknown>): boolean {
  const state = value.state as string;
  const phase = value.phase as string;
  const recoveryFromPhase = value.recoveryFromPhase as string | null;
  const effectivePhase = state === 'recovery-required'
    ? recoveryFromPhase
    : phase;
  if (effectivePhase === null) return true;
  const hasResult = value.resultSha256 !== null;
  const hasCheckpoint = value.checkpointSha256 !== null;
  const hasTransferBatch = value.batchRevision !== null
    || value.batchSha256 !== null;
  if (value.operationKind === 'authority-transfer') {
    return state === 'recovery-required'
      || hasResult !== (state === 'completed');
  }
  if (hasTransferBatch) return true;
  if (value.operationKind === 'backup' || value.operationKind === 'export') {
    const invalidStatePhase = state === 'active'
      ? !BACKUP_EXPORT_ACTIVE_PHASES.has(phase)
      : state === 'recovery-required'
        ? phase !== recoveryFromPhase
          || !BACKUP_EXPORT_ACTIVE_PHASES.has(effectivePhase)
        : state === 'cancelled'
          ? phase !== 'cancelled'
          : phase !== 'completed';
    const checkpointRequired = BACKUP_EXPORT_CHECKPOINT_PHASES.has(effectivePhase);
    const checkpointOptional = effectivePhase === 'cancel-intent'
      || effectivePhase === 'cancelled';
    const resultRequired = effectivePhase === 'artifact-published'
      || state === 'completed';
    return invalidStatePhase
      || (!checkpointOptional && hasCheckpoint !== checkpointRequired)
      || hasResult !== resultRequired;
  }
  if (hasCheckpoint) return true;
  if (value.operationKind === 'leave') {
    const validStatePhase = state === 'active'
      ? phase === 'prepared'
        || phase === 'membership-left'
        || phase === 'personal-ref-removed'
      : state === 'recovery-required'
        ? phase === 'recovery-required'
          && recoveryFromPhase === 'membership-left'
        : state === 'cancelled'
          ? phase === 'manager-succession-required'
          : phase === 'completed';
    return !validStatePhase || hasResult !== (state === 'completed');
  }
  if (value.operationKind === 'retire') {
    return state !== 'completed' || phase !== 'completed' || !hasResult;
  }
  const validDeleteState = state === 'active'
    ? DELETE_ACTIVE_PHASES.has(phase)
    : state === 'completed' && phase === 'completed';
  return !validDeleteState || hasResult !== (state === 'completed');
}

function validateLifecycleJournal(
  item: Record<string, unknown>,
  projectId: CollabProjectId,
): void {
  const value = exactValue(item.value, [
    'actorMemberId',
    'batchRevision',
    'batchSha256',
    'checkpointSha256',
    'createdAt',
    'direction',
    'expectedAuthorityGeneration',
    'expectedPersonalRefOid',
    'idempotencyKey',
    'operationId',
    'operationKind',
    'phase',
    'projectId',
    'recoveryFromPhase',
    'requestFingerprint',
    'resultSha256',
    'scheduledAt',
    'state',
    'updatedAt',
  ]);
  const operationKinds = [
    'authority-transfer', 'backup', 'delete', 'export', 'leave', 'retire',
  ];
  const states = ['active', 'cancelled', 'completed', 'recovery-required'];
  const directions = ['cloud-to-lan', 'lan-to-cloud'];
  if (
    value.projectId !== projectId
    || value.operationId !== item.recordId
    || typeof value.operationId !== 'string'
    || !isCollabOpaqueId(value.operationId)
    || typeof value.operationKind !== 'string'
    || !operationKinds.includes(value.operationKind)
    || (value.actorMemberId !== null && !isCollabMemberId(value.actorMemberId))
    || !nullablePositiveInteger(value.batchRevision)
    || !nullableSha256(value.batchSha256)
    || (value.batchRevision === null) !== (value.batchSha256 === null)
    || !nullableSha256(value.checkpointSha256)
    || (value.batchRevision !== null && value.checkpointSha256 === null)
    || !timestamp(value.createdAt)
    || !timestamp(value.scheduledAt)
    || !timestamp(value.updatedAt)
    || Date.parse(value.scheduledAt) < Date.parse(value.createdAt)
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
    || !positiveInteger(value.expectedAuthorityGeneration)
    || typeof value.idempotencyKey !== 'string'
    || !isCollabOpaqueId(value.idempotencyKey)
    || typeof value.phase !== 'string'
    || !PHASE_PATTERN.test(value.phase)
    || typeof value.requestFingerprint !== 'string'
    || !SHA256_PATTERN.test(value.requestFingerprint)
    || !nullableSha256(value.resultSha256)
    || typeof value.state !== 'string'
    || !states.includes(value.state)
    || (
      value.recoveryFromPhase !== null
      && (
        typeof value.recoveryFromPhase !== 'string'
        || !PHASE_PATTERN.test(value.recoveryFromPhase)
      )
    )
    || (value.state === 'recovery-required')
      !== (value.recoveryFromPhase !== null)
    || (value.operationKind === 'authority-transfer')
      !== (typeof value.direction === 'string' && directions.includes(value.direction))
    || (value.operationKind !== 'authority-transfer' && value.direction !== null)
    || (value.operationKind === 'leave')
      !== (typeof value.expectedPersonalRefOid === 'string')
    || (
      value.expectedPersonalRefOid !== null
      && !isCollabGitOid(value.expectedPersonalRefOid)
    )
    || invalidLifecycleSemantics(value)
  ) return fail('record-schema');
}

function validateTransferReceiptKey(
  item: Record<string, unknown>,
  projectId: CollabProjectId,
): void {
  const value = exactValue(item.value, [
    'createdAt',
    'projectId',
    'receiptKeyId',
    'receiptPublicKey',
    'receiptPublicKeyEncoding',
    'signatureAlgorithm',
    'transferId',
  ]);
  if (
    value.projectId !== projectId
    || typeof value.transferId !== 'string'
    || !isCollabOpaqueId(value.transferId)
    || typeof value.receiptKeyId !== 'string'
    || !isCollabOpaqueId(value.receiptKeyId)
    || item.recordId !== `${value.transferId}:${value.receiptKeyId}`
    || !timestamp(value.createdAt)
    || !canonicalBase64url(value.receiptPublicKey, 32, 32)
    || value.receiptPublicKeyEncoding !== 'base64url-raw'
    || value.signatureAlgorithm !== 'ed25519'
  ) return fail('record-schema');
}

function validateTransferRedemptionReceipt(
  item: Record<string, unknown>,
  projectId: CollabProjectId,
): void {
  const value = exactValue(item.value, ['acknowledgedAt', 'projectId', 'receipt']);
  let receipt;
  try {
    receipt = decodeCollabTransferredMembershipRedemptionReceipt(value.receipt);
  } catch {
    return fail('record-schema');
  }
  if (
    JSON.stringify(receipt) !== JSON.stringify(value.receipt)
    || value.projectId !== projectId
    || receipt.projectId !== projectId
    || item.recordId !== `${receipt.transferId}:${receipt.memberId}`
    || !nullableTimestamp(value.acknowledgedAt)
    || (
      value.acknowledgedAt !== null
      && Date.parse(value.acknowledgedAt) < Date.parse(receipt.redeemedAt)
    )
  ) return fail('record-schema');
}

function validateTerminalPrincipal(
  item: Record<string, unknown>,
  projectId: CollabProjectId,
): void {
  const value = exactValue(item.value, [
    'acknowledgedAt',
    'memberId',
    'operationId',
    'operationKind',
    'principalId',
    'projectId',
  ]);
  if (
    value.projectId !== projectId
    || typeof value.operationId !== 'string'
    || !isCollabOpaqueId(value.operationId)
    || !isCollabMemberId(value.memberId)
    || item.recordId !== `${value.operationId}:${value.memberId}`
    || !nullableTimestamp(value.acknowledgedAt)
    || (value.operationKind !== 'authority-transfer' && value.operationKind !== 'retire')
    || typeof value.principalId !== 'string'
    || !PRINCIPAL_PATTERN.test(value.principalId)
  ) return fail('record-schema');
}

function validateTerminalResponderReplay(
  item: Record<string, unknown>,
  projectId: CollabProjectId,
): void {
  const value = exactValue(item.value, [
    'memberId', 'operationId', 'projectId', 'requestSha256',
  ]);
  if (
    value.projectId !== projectId
    || typeof value.operationId !== 'string'
    || !isCollabOpaqueId(value.operationId)
    || item.recordId !== value.operationId
    || !isCollabMemberId(value.memberId)
    || typeof value.requestSha256 !== 'string'
    || !SHA256_PATTERN.test(value.requestSha256)
  ) return fail('record-schema');
}

function validateTerminalResponder(
  item: Record<string, unknown>,
  projectId: CollabProjectId,
): void {
  const value = exactValue(item.value, [
    'acknowledgements',
    'eligibleMemberIds',
    'expiresAt',
    'operation',
    'operationId',
    'projectId',
    'responseJson',
  ]);
  if (
    value.projectId !== projectId
    || typeof value.operationId !== 'string'
    || !isCollabOpaqueId(value.operationId)
    || item.recordId !== value.operationId
    || (value.operation !== 'getProjectAuthorityTransfer'
      && value.operation !== 'retireProject')
    || !timestamp(value.expiresAt)
    || typeof value.responseJson !== 'string'
    || Buffer.byteLength(value.responseJson, 'utf8') > 512 * 1024
    || !Array.isArray(value.eligibleMemberIds)
    || !Array.isArray(value.acknowledgements)
  ) return fail('record-schema');
  const eligible = value.eligibleMemberIds;
  if (eligible.some((memberId, index) => (
    !isCollabMemberId(memberId)
    || (index > 0 && String(eligible[index - 1]).localeCompare(memberId, 'en-US') >= 0)
  ))) return fail('record-schema');
  const principals = new Set<string>();
  const acknowledgements = value.acknowledgements;
  for (let index = 0; index < acknowledgements.length; index += 1) {
    const acknowledgement = exactValue(acknowledgements[index], [
      'acknowledgedAt', 'memberId', 'principalId',
    ]);
    if (
      !timestamp(acknowledgement.acknowledgedAt)
      || !isCollabMemberId(acknowledgement.memberId)
      || !eligible.includes(acknowledgement.memberId)
      || typeof acknowledgement.principalId !== 'string'
      || !PRINCIPAL_PATTERN.test(acknowledgement.principalId)
      || principals.has(acknowledgement.principalId)
      || (
        index > 0
        && String(exactValue(acknowledgements[index - 1], [
          'acknowledgedAt', 'memberId', 'principalId',
        ]).memberId).localeCompare(acknowledgement.memberId, 'en-US') >= 0
      )
    ) return fail('record-schema');
    principals.add(acknowledgement.principalId);
  }
  let response: unknown;
  try {
    response = collabControlOperationCodec(value.operation).decodeResponse(
      JSON.parse(value.responseJson) as unknown,
    );
  } catch {
    return fail('record-schema');
  }
  if (
    JSON.stringify(response) !== value.responseJson
    || !plain(response)
    || response.projectId !== projectId
    || (
      value.operation === 'retireProject'
      && (
        response.retirementId !== value.operationId
        || response.kind !== 'project-retired'
        || response.terminalExpiresAt !== value.expiresAt
      )
    )
    || (
      value.operation === 'getProjectAuthorityTransfer'
      && (
        response.transferId !== value.operationId
        || response.direction !== 'cloud-to-lan'
        || response.phase !== 'completed'
        || response.state !== 'completed'
        || response.expiresAt !== value.expiresAt
      )
    )
  ) return fail('record-schema');
}

function validateProtectedClaimEnvelope(
  item: Record<string, unknown>,
  projectId: CollabProjectId,
): void {
  const value = exactValue(item.value, [
    'associatedData',
    'associatedDataSha256',
    'ciphertext',
    'encryptionAlgorithm',
    'expiresAt',
    'keyId',
    'keyVersion',
    'memberId',
    'nonce',
    'receiptKeyId',
    'tag',
    'transferId',
  ]);
  const associatedData = exactValue(value.associatedData, [
    'authorityGeneration',
    'checkpointSha256',
    'claimSha256',
    'envelopeVersion',
    'environmentIdentity',
    'memberId',
    'projectId',
    'transferId',
  ]);
  let encoded: string;
  try {
    encoded = encodeCollabProtectedClaimAssociatedData(associatedData as never);
  } catch {
    return fail('record-schema');
  }
  if (
    associatedData.projectId !== projectId
    || associatedData.envelopeVersion !== COLLAB_PROTECTED_CLAIM_ENVELOPE_VERSION
    || typeof value.transferId !== 'string'
    || !isCollabOpaqueId(value.transferId)
    || value.transferId !== associatedData.transferId
    || !isCollabMemberId(value.memberId)
    || value.memberId !== associatedData.memberId
    || item.recordId !== `${value.transferId}:${value.memberId}`
    || typeof value.associatedDataSha256 !== 'string'
    || value.associatedDataSha256 !== sha256(encoded)
    || !canonicalBase64url(
      value.ciphertext,
      COLLAB_PROTECTED_CLAIM_ENVELOPE_LIMITS.maxCiphertextBytes,
    )
    || value.encryptionAlgorithm !== 'xchacha20-poly1305'
    || !timestamp(value.expiresAt)
    || typeof value.keyId !== 'string'
    || Buffer.byteLength(value.keyId, 'utf8') > 256
    || !positiveInteger(value.keyVersion)
    || !canonicalBase64url(
      value.nonce,
      COLLAB_PROTECTED_CLAIM_ENVELOPE_LIMITS.nonceBytes,
      COLLAB_PROTECTED_CLAIM_ENVELOPE_LIMITS.nonceBytes,
    )
    || typeof value.receiptKeyId !== 'string'
    || Buffer.byteLength(value.receiptKeyId, 'utf8') > 256
    || !canonicalBase64url(
      value.tag,
      COLLAB_PROTECTED_CLAIM_ENVELOPE_LIMITS.tagBytes,
      COLLAB_PROTECTED_CLAIM_ENVELOPE_LIMITS.tagBytes,
    )
  ) return fail('record-schema');
}

function validateTombstone(
  item: Record<string, unknown>,
  projectId: CollabProjectId,
): void {
  const value = exactValue(item.value, [
    'authorityGeneration', 'projectId', 'retiredAt', 'terminalExpiresAt',
  ]);
  if (
    value.projectId !== projectId
    || item.recordId !== projectId
    || !positiveInteger(value.authorityGeneration)
    || !timestamp(value.retiredAt)
    || !timestamp(value.terminalExpiresAt)
    || Date.parse(value.terminalExpiresAt) <= Date.parse(value.retiredAt)
  ) return fail('record-schema');
}

function validateTerminalRecord(
  item: Record<string, unknown>,
  projectId: CollabProjectId,
): void {
  switch (item.kind) {
    case 'lifecycle-journal': return validateLifecycleJournal(item, projectId);
    case 'transfer-receipt-key': return validateTransferReceiptKey(item, projectId);
    case 'transfer-redemption-receipt':
      return validateTransferRedemptionReceipt(item, projectId);
    case 'terminal-principal': return validateTerminalPrincipal(item, projectId);
    case 'terminal-responder-replay':
      return validateTerminalResponderReplay(item, projectId);
    case 'terminal-responder': return validateTerminalResponder(item, projectId);
    case 'protected-claim-envelope':
      return validateProtectedClaimEnvelope(item, projectId);
    case 'tombstone': return validateTombstone(item, projectId);
    default: return fail('record-schema');
  }
}

function canonicalRecords(
  projectId: CollabProjectId,
  values: readonly unknown[],
): readonly TerminalProjectContinuityRecord[] {
  const seen = new Set<string>();
  let priorKind = -1;
  let priorRecordId = '';
  let tombstones = 0;
  const records = values.map(value => {
    const valueProjectId = plain(value)
      && plain(value.value)
      && value.kind === 'protected-claim-envelope'
      && plain(value.value.associatedData)
      ? value.value.associatedData.projectId
      : plain(value) && plain(value.value)
        ? value.value.projectId
        : undefined;
    if (
      !plain(value)
      || !exactKeys(value, ['kind', 'recordId', 'revision', 'value'])
      || typeof value.kind !== 'string'
      || !KIND_ORDER.has(value.kind)
      || typeof value.recordId !== 'string'
      || !RECORD_ID_PATTERN.test(value.recordId)
      || typeof value.revision !== 'number'
      || !Number.isSafeInteger(value.revision)
      || value.revision <= 0
      || !plain(value.value)
      || valueProjectId !== projectId
    ) return fail(`record-${plain(value) ? String(value.kind) : 'shape'}`);
    validateTerminalRecord(value, projectId);
    const kindIndex = KIND_ORDER.get(value.kind) ?? fail();
    if (
      kindIndex < priorKind
      || (kindIndex === priorKind && value.recordId <= priorRecordId)
      || seen.has(`${value.kind}\0${value.recordId}`)
    ) return fail('order');
    seen.add(`${value.kind}\0${value.recordId}`);
    priorKind = kindIndex;
    priorRecordId = value.recordId;
    if (value.kind === 'tombstone') tombstones += 1;
    if (value.kind === 'protected-claim-envelope') {
      const associatedData = value.value.associatedData;
      if (
        !plain(associatedData)
        || associatedData.projectId !== projectId
        || typeof value.value.associatedDataSha256 !== 'string'
      ) return fail('associated-data');
      let encoded: string;
      try {
        encoded = encodeCollabProtectedClaimAssociatedData(associatedData as never);
      } catch {
        return fail('associated-data');
      }
      if (sha256(encoded) !== value.value.associatedDataSha256) {
        return fail('associated-data');
      }
    }
    return Object.freeze(value) as unknown as TerminalProjectContinuityRecord;
  });
  if (tombstones !== 1) return fail('tombstone');
  const lifecycleTransfers = new Set(records.flatMap(record => (
    record.kind === 'lifecycle-journal'
      && record.value.operationKind === 'authority-transfer'
      ? [record.value.operationId]
      : []
  )));
  const receiptKeys = new Set(records.flatMap(record => (
    record.kind === 'transfer-receipt-key'
      ? [`${record.value.transferId}\0${record.value.receiptKeyId}`]
      : []
  )));
  for (const record of records) {
    if (
      record.kind === 'protected-claim-envelope'
      && (
        !lifecycleTransfers.has(record.value.transferId)
        || !receiptKeys.has(
          `${record.value.transferId}\0${record.value.receiptKeyId}`,
        )
      )
    ) return fail('links');
  }
  const responders = records.filter((record): record is Extract<
    TerminalProjectContinuityRecord,
    { readonly kind: 'terminal-responder' }
  > => record.kind === 'terminal-responder');
  if (responders.length > 1) return fail('links');
  for (const responder of responders) {
    const principals = records.filter((record): record is Extract<
      TerminalProjectContinuityRecord,
      { readonly kind: 'terminal-principal' }
    > => (
      record.kind === 'terminal-principal'
      && record.value.operationId === responder.value.operationId
    ));
    if (
      principals.length !== responder.value.eligibleMemberIds.length
      || principals.some(record => (
        !responder.value.eligibleMemberIds.includes(record.value.memberId)
        || record.value.operationKind !== (
          responder.value.operation === 'retireProject'
            ? 'retire'
            : 'authority-transfer'
        )
      ))
    ) return fail('links');
    for (const principal of principals) {
      const acknowledgement = responder.value.acknowledgements.find(value => (
        value.memberId === principal.value.memberId
      ));
      if (
        (principal.value.acknowledgedAt === null) !== (acknowledgement === undefined)
        || (
          acknowledgement !== undefined
          && (
            acknowledgement.acknowledgedAt !== principal.value.acknowledgedAt
            || acknowledgement.principalId !== principal.value.principalId
          )
        )
      ) return fail('links');
    }
    const replays = records.filter((record): record is Extract<
      TerminalProjectContinuityRecord,
      { readonly kind: 'terminal-responder-replay' }
    > => (
      record.kind === 'terminal-responder-replay'
      && record.value.operationId === responder.value.operationId
    ));
    if (
      (responder.value.operation === 'getProjectAuthorityTransfer')
        !== (replays.length === 1)
      || replays.length > 1
    ) return fail('links');
    for (const replay of replays) {
      const lifecycle = records.find((record): record is Extract<
        TerminalProjectContinuityRecord,
        { readonly kind: 'lifecycle-journal' }
      > => (
        record.kind === 'lifecycle-journal'
        && record.value.operationId === replay.value.operationId
      ));
      if (
        lifecycle?.kind !== 'lifecycle-journal'
        || lifecycle.value.operationKind !== 'authority-transfer'
        || lifecycle.value.direction !== 'cloud-to-lan'
        || lifecycle.value.state !== 'completed'
        || !principals.some(principal => (
          principal.value.memberId === replay.value.memberId
        ))
      ) return fail('links');
    }
  }
  for (const record of records) {
    if (
      (record.kind === 'terminal-principal'
        || record.kind === 'terminal-responder-replay')
      && !responders.some(responder => (
        responder.value.operationId === record.value.operationId
      ))
    ) return fail('links');
  }
  return Object.freeze(records);
}

function decode(value: unknown): TerminalProjectContinuityArtifact {
  if (
    !plain(value)
    || !exactKeys(value, ['projectId', 'records', 'schemaVersion'])
    || typeof value.projectId !== 'string'
    || !isCollabProjectId(value.projectId)
    || !Array.isArray(value.records)
    || value.records.length === 0
    || value.schemaVersion !== 1
  ) return fail('document');
  const records = canonicalRecords(value.projectId, value.records);
  const document = Object.freeze({
    projectId: value.projectId,
    records,
    schemaVersion: 1 as const,
  });
  const json = JSON.stringify(document);
  if (Buffer.byteLength(json, 'utf8') > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes) {
    return fail('size');
  }
  return Object.freeze({
    json,
    projectId: value.projectId,
    records,
    sha256: sha256(json),
  });
}

export function createTerminalProjectContinuityArtifact(
  projectId: CollabProjectId,
  records: readonly TerminalProjectContinuityRecord[],
): TerminalProjectContinuityArtifact {
  return decode({ projectId, records, schemaVersion: 1 });
}

export function decodeTerminalProjectContinuityArtifact(
  json: string,
  expected: Readonly<{
    readonly projectId: CollabProjectId;
    readonly sha256: string;
  }>,
): TerminalProjectContinuityArtifact {
  if (
    Buffer.byteLength(json, 'utf8') > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes
    || !SHA256_PATTERN.test(expected.sha256)
    || sha256(json) !== expected.sha256
  ) return fail('digest');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return fail('json');
  }
  const artifact = decode(parsed);
  if (artifact.projectId !== expected.projectId || artifact.json !== json) {
    return fail('canonical');
  }
  return artifact;
}
