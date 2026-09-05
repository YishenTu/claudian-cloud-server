import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { TextDecoder } from 'node:util';
import { getHeapStatistics } from 'node:v8';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CHECKPOINT_PROFILES,
  COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
  COLLAB_PROJECT_BACKUP_COORDINATION_FORMAT_VERSION,
  COLLAB_PROJECT_COORDINATION_FORMAT_VERSION,
  COLLAB_PROTOCOL_VERSION,
  CollabError,
  decodeCollabProjectBackupCheckpointCoordinationNdjson,
  decodeCollabProjectBackupCheckpointManifest,
  decodeCollabProjectCheckpointCoordinationNdjson,
  decodeCollabProjectCheckpointManifest,
  encodeCollabProjectBackupCheckpointCoordinationNdjson,
  encodeCollabProjectBackupCheckpointManifestCanonicalJson,
  encodeCollabProjectBackupCheckpointManifestDigestInput,
  encodeCollabProjectCheckpointCoordinationNdjson,
  encodeCollabProjectCheckpointManifestCanonicalJson,
  encodeCollabProjectCheckpointManifestDigestInput,
  isCollabGitOid,
  isCollabOpaqueId,
  isCollabProjectId,
  validateCollabProjectBackupCheckpointConsistency,
  validateCollabProjectCheckpointConsistency,
  type CollabCheckpointAuthority,
  type CollabCheckpointGitRef,
  type CollabCheckpointBackupRecord,
  type CollabCheckpointProfile,
  type CollabCloudAuthorityTransferArtifact,
  type CollabProjectCheckpointManifest,
  type CollabProjectBackupCheckpointManifest,
  type CollabProjectBackupRecord,
} from '@claudian-collab/protocol';

import {
  productionCheckpointAttemptIdentity,
  ProductionCheckpointStagingError,
  type PreparedProductionCheckpointAttempt,
  type ProductionCheckpointDeliveryCursor,
  type ProductionCheckpointDeliveryPage,
  type ProductionCheckpointStagingPort,
  type StagedProductionCheckpointArtifact,
} from '../../onboarding/production/ProductionCheckpointStaging.js';
import {
  GitBundleImportError,
  type RepositoryCheckpointStagingPort,
  type ValidatedRepositoryCheckpoint,
} from '../../repositories/GitBundleImporter.js';
import { importRepositoryCheckpoint } from '../../repositories/importRepositoryCheckpoint.js';
import type {
  CapturedRepositoryCheckpoint,
  ExactRepositoryOperationReservation,
  RepositoryCheckpointCapturePort,
} from '../../repositories/RepositoryCheckpointAuthority.js';
import { RepositoryCheckpointError } from '../../repositories/RepositoryCheckpointAuthority.js';
import {
  createRepositoryPlacementLease,
  type RepositoryPlacementLease,
} from '../../repositories/RepositoryPlacement.js';
import type {
  ExportCheckpointPublicationPort,
} from './LifecycleCheckpointPublication.js';

export type ProjectCheckpointCoordinatorErrorCode =
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'invalid-checkpoint'
  | 'resource-limit'
  | 'storage-unavailable'
  | 'timeout';

export class ProjectCheckpointCoordinatorError extends Error {
  readonly code: ProjectCheckpointCoordinatorErrorCode;
  readonly retryable: boolean;

  constructor(code: ProjectCheckpointCoordinatorErrorCode) {
    super(`project-checkpoint-coordinator.error.${code}`);
    this.name = 'ProjectCheckpointCoordinatorError';
    this.code = code;
    this.retryable = code === 'busy' || code === 'storage-unavailable';
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

export interface ValidateStagedProjectCheckpointInput {
  readonly attempt: PreparedProductionCheckpointAttempt;
  readonly expectedProfile: CollabCheckpointProfile;
  readonly expectedSourceAuthority: CollabCheckpointAuthority;
  readonly expectedTargetAuthority: CollabCheckpointAuthority | null;
  readonly signal?: AbortSignal;
}

export interface ValidatedProjectCheckpoint {
  readonly attempt: PreparedProductionCheckpointAttempt;
  readonly manifest: CollabProjectCheckpointManifest;
  readonly records: readonly CollabCheckpointBackupRecord[];
  readonly repository: ValidatedRepositoryCheckpoint;
}

export type OutboundProjectCheckpointProgress =
  | 'checkpoint-verified'
  | 'coordination-captured'
  | 'repository-captured';

export interface CaptureOutboundProjectCheckpointInput {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expectedMainOid: string;
  readonly onProgress: (
    phase: OutboundProjectCheckpointProgress,
    checkpointSha256: string | undefined,
  ) => Promise<void> | void;
  readonly operationId: string;
  readonly placement: RepositoryPlacementLease;
  readonly profile: CollabCheckpointProfile;
  readonly projectId: string;
  /** Borrowed immutable snapshot; the caller must not mutate these records. */
  readonly records: readonly OutboundProjectCheckpointRecord[];
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly signal?: AbortSignal;
  readonly sourceAuthority: CollabCheckpointAuthority & { readonly kind: 'cloud' };
  readonly targetAuthority?: CollabCheckpointAuthority & { readonly kind: 'lan' };
}

export interface CapturedOutboundProjectCheckpoint {
  readonly attempt: PreparedProductionCheckpointAttempt;
  readonly manifest: OutboundProjectCheckpointManifest;
  readonly records: readonly OutboundProjectCheckpointRecord[];
  readonly repository: CapturedRepositoryCheckpoint;
}

export interface OutboundProjectCheckpointIdentity {
  readonly expiresAt: string;
  readonly operationId: string;
  readonly projectId: string;
}

export interface ProfiledOutboundProjectCheckpointIdentity
  extends OutboundProjectCheckpointIdentity {
  readonly profile: CollabCheckpointProfile;
}

export interface OutboundProjectCheckpointReservation {
  readonly maximumCoordinationBytes: number;
  readonly projectId: string;
  readonly repositoryReservation: ExactRepositoryOperationReservation;
  close(): Promise<void>;
}

export interface VerifyOutboundProjectCheckpointInput
  extends OutboundProjectCheckpointIdentity {
  readonly expectedCheckpointSha256: string;
  readonly expectedProfile: Extract<CollabCheckpointProfile, 'backup' | 'export'>;
  readonly expectedSourceAuthority: CollabCheckpointAuthority & {
    readonly kind: 'cloud';
  };
}

export interface ReadOutboundProjectCheckpointRecordsInput
  extends OutboundProjectCheckpointIdentity {
  readonly expectedProfile: Extract<CollabCheckpointProfile, 'backup' | 'export'>;
}

export interface ProjectCheckpointCoordinatorOptions {
  readonly maximumConcurrentCoordinationValidations?: number;
  readonly maximumCoordinationBytes?: number;
  /** A distinct immutable backup/export root, never the onboarding staging root. */
  readonly publication?: Readonly<{
    readonly backup: ProductionCheckpointStagingPort;
    readonly export: ExportCheckpointPublicationPort;
  }>;
  readonly repository: RepositoryCheckpointStagingPort;
  readonly repositoryCapture?: RepositoryCheckpointCapturePort;
  readonly staging: ProductionCheckpointStagingPort;
}

interface ValidationInputSnapshot {
  readonly attempt: PreparedProductionCheckpointAttempt;
  readonly expectedProfile: CollabCheckpointProfile;
  readonly expectedSourceAuthority: CollabCheckpointAuthority;
  readonly expectedTargetAuthority: CollabCheckpointAuthority | null;
  readonly signal: AbortSignal | undefined;
}

interface OutboundCaptureSnapshot
  extends Omit<
    CaptureOutboundProjectCheckpointInput,
    'records' | 'signal' | 'targetAuthority'
  > {
  readonly coordinationJson: string;
  readonly records: readonly OutboundProjectCheckpointRecord[];
  readonly signal: AbortSignal | undefined;
  readonly targetAuthority: CollabCheckpointAuthority | null;
}

export type OutboundProjectCheckpointManifest =
  | CollabProjectBackupCheckpointManifest
  | CollabProjectCheckpointManifest;

export type OutboundProjectCheckpointRecord =
  | CollabCheckpointBackupRecord
  | CollabProjectBackupRecord;

interface OutboundIdentitySnapshot extends OutboundProjectCheckpointIdentity {
  readonly signal: AbortSignal | undefined;
}

interface VerifyOutboundSnapshot extends OutboundIdentitySnapshot {
  readonly expectedCheckpointSha256: string;
  readonly expectedProfile: CollabCheckpointProfile;
  readonly expectedSourceAuthority: CollabCheckpointAuthority & {
    readonly kind: 'cloud';
  };
  readonly expectedTargetAuthority: CollabCheckpointAuthority | null;
}

interface OutboundReservationState {
  active: boolean;
  readonly projectId: string;
  readonly repositoryReservation: ExactRepositoryOperationReservation;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STREAM_BUFFER_BYTES = 64 * 1024;
const COORDINATION_HEAP_AMPLIFICATION = 12;
const COORDINATION_HEAP_BUDGET_DIVISOR = 2;

function fail(code: ProjectCheckpointCoordinatorErrorCode): never {
  throw new ProjectCheckpointCoordinatorError(code);
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function sameAuthority(
  left: CollabCheckpointAuthority | null,
  right: CollabCheckpointAuthority | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.generation === right.generation
      && left.kind === right.kind;
}

function snapshotAuthority(value: CollabCheckpointAuthority): CollabCheckpointAuthority {
  const kind: unknown = value.kind;
  const snapshot = Object.freeze({
    generation: value.generation,
    kind,
  });
  if (
    !Number.isSafeInteger(snapshot.generation)
    || snapshot.generation <= 0
    || (kind !== 'cloud' && kind !== 'lan')
  ) {
    fail('invalid-checkpoint');
  }
  return snapshot as CollabCheckpointAuthority;
}

function snapshotAttempt(
  value: PreparedProductionCheckpointAttempt,
): PreparedProductionCheckpointAttempt {
  const snapshot = Object.freeze({
    attemptKey: value.attemptKey,
    expiresAt: value.expiresAt,
    operationId: value.operationId,
    projectId: value.projectId,
  });
  if (
    !SHA256_PATTERN.test(snapshot.attemptKey)
    || !isCollabOpaqueId(snapshot.operationId)
    || !isCollabProjectId(snapshot.projectId)
  ) {
    fail('invalid-checkpoint');
  }
  return snapshot;
}

function snapshotInput(
  input: ValidateStagedProjectCheckpointInput,
): ValidationInputSnapshot {
  try {
    const attempt = snapshotAttempt(input.attempt);
    const expectedProfile = input.expectedProfile;
    const expectedSourceAuthority = snapshotAuthority(
      input.expectedSourceAuthority,
    );
    const target = input.expectedTargetAuthority;
    const expectedTargetAuthority = target === null
      ? null
      : snapshotAuthority(target);
    const signal = input.signal;
    if (!COLLAB_CHECKPOINT_PROFILES.some(profile => profile === expectedProfile)) {
      fail('invalid-checkpoint');
    }
    return Object.freeze({
      attempt,
      expectedProfile,
      expectedSourceAuthority,
      expectedTargetAuthority,
      signal,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectCheckpointCoordinatorError) throw error;
    return fail('invalid-checkpoint');
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function encodeOutboundCoordination(
  records: readonly OutboundProjectCheckpointRecord[],
  profile: CollabCheckpointProfile,
): string {
  return profile === 'backup'
    ? encodeCollabProjectBackupCheckpointCoordinationNdjson(
      records as readonly CollabProjectBackupRecord[],
    )
    : encodeCollabProjectCheckpointCoordinationNdjson(
      records as readonly CollabCheckpointBackupRecord[],
      profile,
    );
}

function decodeOutboundCoordination(
  value: string,
  profile: CollabCheckpointProfile,
): readonly OutboundProjectCheckpointRecord[] {
  return profile === 'backup'
    ? decodeCollabProjectBackupCheckpointCoordinationNdjson(value)
    : decodeCollabProjectCheckpointCoordinationNdjson(value, profile);
}

function snapshotOutboundInput(
  input: CaptureOutboundProjectCheckpointInput,
): OutboundCaptureSnapshot {
  try {
    const createdAt = input.createdAt;
    const expiresAt = input.expiresAt;
    const expectedMainOid = input.expectedMainOid;
    const operationId = input.operationId;
    const profile = input.profile;
    const projectId = input.projectId;
    const onProgress = input.onProgress;
    if (
      !canonicalTimestamp(createdAt)
      || !canonicalTimestamp(expiresAt)
      || Date.parse(expiresAt) <= Date.parse(createdAt)
      || !isCollabGitOid(expectedMainOid)
      || !isCollabOpaqueId(operationId)
      || !isCollabProjectId(projectId)
      || !COLLAB_CHECKPOINT_PROFILES.some(candidate => candidate === profile)
      || typeof onProgress !== 'function'
    ) {
      fail('invalid-checkpoint');
    }
    const placement = createRepositoryPlacementLease(input.placement);
    if (placement.projectId !== projectId) fail('invalid-checkpoint');
    const sourceAuthority = snapshotAuthority(input.sourceAuthority);
    if (sourceAuthority.kind !== 'cloud') fail('invalid-checkpoint');
    const targetAuthority = input.targetAuthority === undefined
      ? null
      : snapshotAuthority(input.targetAuthority);
    if (
      profile === 'authority-transfer'
        ? targetAuthority?.kind !== 'lan'
          || targetAuthority.generation !== sourceAuthority.generation + 1
        : targetAuthority !== null
    ) fail('invalid-checkpoint');
    const refs = Object.freeze(input.refs.map(ref => Object.freeze({
      name: ref.name,
      oid: ref.oid,
    })));
    const records = input.records;
    const coordinationJson = encodeOutboundCoordination(records, profile);
    return Object.freeze({
      coordinationJson,
      createdAt,
      expiresAt,
      expectedMainOid,
      onProgress,
      operationId,
      placement,
      profile,
      projectId,
      records,
      refs,
      signal: input.signal,
      sourceAuthority: sourceAuthority as CollabCheckpointAuthority & {
        readonly kind: 'cloud';
      },
      targetAuthority,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectCheckpointCoordinatorError) throw error;
    return fail('invalid-checkpoint');
  }
}

function snapshotOutboundIdentity(
  input: OutboundProjectCheckpointIdentity,
  signal: AbortSignal | undefined,
): OutboundIdentitySnapshot {
  const snapshot = Object.freeze({
    expiresAt: input.expiresAt,
    operationId: input.operationId,
    projectId: input.projectId,
    signal,
  });
  if (
    !canonicalTimestamp(snapshot.expiresAt)
    || !isCollabOpaqueId(snapshot.operationId)
    || !isCollabProjectId(snapshot.projectId)
  ) {
    fail('invalid-checkpoint');
  }
  return snapshot;
}

function snapshotOutboundVerification(
  input: VerifyOutboundProjectCheckpointInput,
  signal: AbortSignal | undefined,
): VerifyOutboundSnapshot {
  const identity = snapshotOutboundIdentity(input, signal);
  const expectedProfile: unknown = input.expectedProfile;
  const expectedSourceAuthority = snapshotAuthority(
    input.expectedSourceAuthority,
  );
  if (
    !SHA256_PATTERN.test(input.expectedCheckpointSha256)
    || (expectedProfile !== 'backup' && expectedProfile !== 'export')
    || expectedSourceAuthority.kind !== 'cloud'
  ) fail('invalid-checkpoint');
  return Object.freeze({
    ...identity,
    expectedCheckpointSha256: input.expectedCheckpointSha256,
    expectedProfile,
    expectedSourceAuthority: expectedSourceAuthority as CollabCheckpointAuthority & {
      readonly kind: 'cloud';
    },
    expectedTargetAuthority: null,
  });
}

function exactAttempt(
  left: PreparedProductionCheckpointAttempt,
  right: PreparedProductionCheckpointAttempt,
): boolean {
  return left.attemptKey === right.attemptKey
    && left.expiresAt === right.expiresAt
    && left.operationId === right.operationId
    && left.projectId === right.projectId;
}

function artifactLimit(name: CollabCloudAuthorityTransferArtifact): number {
  switch (name) {
    case 'checkpoint.json':
      return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes;
    case 'coordination.ndjson':
      return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes;
    case 'repository.bundle':
      return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes;
  }
}

function snapshotArtifacts(
  artifacts: readonly StagedProductionCheckpointArtifact[],
  attempt: PreparedProductionCheckpointAttempt,
): ReadonlyMap<
  CollabCloudAuthorityTransferArtifact,
  StagedProductionCheckpointArtifact
> {
  if (artifacts.length !== COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.length) {
    fail('invalid-checkpoint');
  }
  const result = new Map<
    CollabCloudAuthorityTransferArtifact,
    StagedProductionCheckpointArtifact
  >();
  for (const artifact of artifacts) {
    const snapshot = Object.freeze({
      attemptKey: artifact.attemptKey,
      byteCount: artifact.byteCount,
      name: artifact.name,
      operationId: artifact.operationId,
      projectId: artifact.projectId,
      sha256: artifact.sha256,
    });
    if (
      !COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.some(name => name === snapshot.name)
      || snapshot.attemptKey !== attempt.attemptKey
      || snapshot.operationId !== attempt.operationId
      || snapshot.projectId !== attempt.projectId
      || !Number.isSafeInteger(snapshot.byteCount)
      || snapshot.byteCount <= 0
      || snapshot.byteCount > artifactLimit(snapshot.name)
      || !SHA256_PATTERN.test(snapshot.sha256)
      || result.has(snapshot.name)
    ) {
      fail('invalid-checkpoint');
    }
    result.set(snapshot.name, snapshot);
  }
  if (COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.some(name => !result.has(name))) {
    fail('invalid-checkpoint');
  }
  return result;
}

function exactArtifactFact(
  artifact: StagedProductionCheckpointArtifact,
  attempt: PreparedProductionCheckpointAttempt,
  name: CollabCloudAuthorityTransferArtifact,
  byteCount: number,
  digest: string,
): StagedProductionCheckpointArtifact {
  if (
    artifact.attemptKey !== attempt.attemptKey
    || artifact.byteCount !== byteCount
    || artifact.name !== name
    || artifact.operationId !== attempt.operationId
    || artifact.projectId !== attempt.projectId
    || artifact.sha256 !== digest
  ) fail('invalid-checkpoint');
  return artifact;
}

function decodeManifestJson(value: string): CollabProjectCheckpointManifest {
  try {
    return decodeCollabProjectCheckpointManifest(JSON.parse(value) as unknown);
  } catch {
    return fail('invalid-checkpoint');
  }
}

function decodeOutboundManifestJson(
  value: string,
  profile: CollabCheckpointProfile,
): OutboundProjectCheckpointManifest {
  try {
    const parsed = JSON.parse(value) as unknown;
    return profile === 'backup'
      ? decodeCollabProjectBackupCheckpointManifest(parsed)
      : decodeCollabProjectCheckpointManifest(parsed);
  } catch {
    return fail('invalid-checkpoint');
  }
}

function encodeOutboundManifestCanonicalJson(
  manifest: OutboundProjectCheckpointManifest,
): string {
  return manifest.profile === 'backup'
    ? encodeCollabProjectBackupCheckpointManifestCanonicalJson(
      manifest as CollabProjectBackupCheckpointManifest,
    )
    : encodeCollabProjectCheckpointManifestCanonicalJson(manifest);
}

function encodeOutboundManifestDigestInput(
  manifest: OutboundProjectCheckpointManifest,
): string {
  return manifest.profile === 'backup'
    ? encodeCollabProjectBackupCheckpointManifestDigestInput(
      manifest as CollabProjectBackupCheckpointManifest,
    )
    : encodeCollabProjectCheckpointManifestDigestInput(manifest);
}

function validateOutboundConsistency(
  manifest: OutboundProjectCheckpointManifest,
  records: readonly OutboundProjectCheckpointRecord[],
): void {
  if (manifest.profile === 'backup') {
    validateCollabProjectBackupCheckpointConsistency(
      manifest as CollabProjectBackupCheckpointManifest,
      records as readonly CollabProjectBackupRecord[],
    );
    return;
  }
  validateCollabProjectCheckpointConsistency(
    manifest,
    records as readonly CollabCheckpointBackupRecord[],
  );
}

function snapshotRepository(
  value: ValidatedRepositoryCheckpoint,
  attempt: PreparedProductionCheckpointAttempt,
  artifact: StagedProductionCheckpointArtifact,
  manifest: OutboundProjectCheckpointManifest,
): ValidatedRepositoryCheckpoint {
  try {
    const bundleInputDisposition: unknown = value.bundleInputDisposition;
    if (
      bundleInputDisposition !== 'consumed'
      && bundleInputDisposition !== 'replayed'
    ) {
      fail('invalid-checkpoint');
    }
    const refs = value.refs.map(ref => Object.freeze({
      name: ref.name,
      oid: ref.oid,
    }));
    const snapshot = Object.freeze({
      artifactKey: value.artifactKey,
      bundleByteCount: value.bundleByteCount,
      bundleInputDisposition,
      bundleSha256: value.bundleSha256,
      markerSha256: value.markerSha256,
      objectFormat: value.objectFormat,
      operationId: value.operationId,
      projectId: value.projectId,
      refs: Object.freeze(refs),
    });
    if (
      !SHA256_PATTERN.test(snapshot.artifactKey)
      || !SHA256_PATTERN.test(snapshot.markerSha256)
      || snapshot.bundleByteCount !== artifact.byteCount
      || snapshot.bundleSha256 !== artifact.sha256
      || snapshot.objectFormat !== manifest.gitObjectFormat
      || snapshot.operationId !== attempt.operationId
      || snapshot.projectId !== attempt.projectId
      || snapshot.refs.length !== manifest.refs.length
      || snapshot.refs.some((ref, index) => {
        const expected = manifest.refs.at(index);
        return expected === undefined
          || ref.name !== expected.name
          || ref.oid !== expected.oid;
      })
    ) {
      fail('invalid-checkpoint');
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof ProjectCheckpointCoordinatorError) throw error;
    return fail('invalid-checkpoint');
  }
}

function mapDependency(
  error: unknown,
  signal: AbortSignal,
): never {
  if (error instanceof ProjectCheckpointCoordinatorError) throw error;
  if (signal.aborted) {
    return fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
  }
  if (error instanceof ProductionCheckpointStagingError) {
    switch (error.code) {
      case 'busy': return fail('busy');
      case 'cancelled': return fail('cancelled');
      case 'closed': return fail('closed');
      case 'storage-unavailable': return fail('storage-unavailable');
      case 'timeout': return fail('timeout');
      default: return fail('invalid-checkpoint');
    }
  }
  if (error instanceof GitBundleImportError) {
    switch (error.code) {
      case 'busy': return fail('busy');
      case 'cancelled': return fail('cancelled');
      case 'closed': return fail('closed');
      case 'git-unavailable': return fail('storage-unavailable');
      case 'process-failed': return fail('storage-unavailable');
      case 'storage-unavailable': return fail('storage-unavailable');
      case 'timeout': return fail('timeout');
      case 'unsupported-git': return fail('storage-unavailable');
      default: return fail('invalid-checkpoint');
    }
  }
  if (error instanceof RepositoryCheckpointError) {
    switch (error.code) {
      case 'busy': return fail('busy');
      case 'cancelled': return fail('cancelled');
      case 'closed': return fail('closed');
      case 'storage-unavailable': return fail('storage-unavailable');
      case 'timeout': return fail('timeout');
      default: return fail('invalid-checkpoint');
    }
  }
  if (error instanceof CollabError) return fail('invalid-checkpoint');
  return fail('storage-unavailable');
}

function invalidRepositoryStaging(error: unknown): boolean {
  if (error instanceof GitBundleImportError) {
    return error.code === 'artifact-conflict'
      || error.code === 'artifact-invalid'
      || error.code === 'digest-mismatch'
      || error.code === 'repository-invalid'
      || error.code === 'repository-limit';
  }
  if (error instanceof ProductionCheckpointStagingError) {
    return error.code === 'artifact-conflict'
      || error.code === 'digest-mismatch'
      || error.code === 'expired'
      || error.code === 'input-limit'
      || error.code === 'invalid-attempt';
  }
  return error instanceof ProjectCheckpointCoordinatorError
    && error.code === 'invalid-checkpoint';
}

function safePumpFailure(error: unknown): Error {
  return error instanceof ProductionCheckpointStagingError
      || error instanceof ProjectCheckpointCoordinatorError
    ? error
    : new ProjectCheckpointCoordinatorError('storage-unavailable');
}

export class ProjectCheckpointCoordinator {
  readonly #controllers = new Set<AbortController>();
  readonly #maximumConcurrentCoordinationValidations: number;
  readonly #maximumCoordinationBytes: number;
  readonly #repository: RepositoryCheckpointStagingPort;
  readonly #repositoryCapture: RepositoryCheckpointCapturePort | undefined;
  readonly #outboundReservations = new WeakMap<
    OutboundProjectCheckpointReservation,
    OutboundReservationState
  >();
  readonly #running = new Set<Promise<void>>();
  readonly #publication: ProjectCheckpointCoordinatorOptions['publication'];
  readonly #staging: ProjectCheckpointCoordinatorOptions['staging'];
  #activeCoordinationValidations = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ProjectCheckpointCoordinatorOptions) {
    const maximumConcurrentCoordinationValidations =
      options.maximumConcurrentCoordinationValidations ?? 1;
    const heapBudgetBytes = Math.floor(
      getHeapStatistics().heap_size_limit / COORDINATION_HEAP_BUDGET_DIVISOR,
    );
    const defaultMaximumCoordinationBytes = Math.min(
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
      Math.floor(
        heapBudgetBytes
          / COORDINATION_HEAP_AMPLIFICATION
          / maximumConcurrentCoordinationValidations,
      ),
    );
    const maximumCoordinationBytes = options.maximumCoordinationBytes
      ?? defaultMaximumCoordinationBytes;
    if (
      !Number.isSafeInteger(maximumConcurrentCoordinationValidations)
      || maximumConcurrentCoordinationValidations <= 0
      || !Number.isSafeInteger(maximumCoordinationBytes)
      || maximumCoordinationBytes <= 0
      || maximumCoordinationBytes
        > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes
      || maximumCoordinationBytes
        * maximumConcurrentCoordinationValidations
        * COORDINATION_HEAP_AMPLIFICATION
        > heapBudgetBytes
    ) {
      throw new TypeError('project-checkpoint-coordinator.options-invalid');
    }
    if (
      options.publication !== undefined
      && (
        options.publication.backup === options.staging
        || options.publication.export === options.staging
      )
    ) {
      throw new TypeError('project-checkpoint-coordinator.options-invalid');
    }
    this.#maximumConcurrentCoordinationValidations =
      maximumConcurrentCoordinationValidations;
    this.#maximumCoordinationBytes = maximumCoordinationBytes;
    this.#publication = options.publication;
    this.#repository = options.repository;
    this.#repositoryCapture = options.repositoryCapture;
    this.#staging = options.staging;
  }

  get maximumCoordinationBytes(): number {
    return this.#maximumCoordinationBytes;
  }

  validateStaged(
    input: ValidateStagedProjectCheckpointInput,
  ): Promise<ValidatedProjectCheckpoint> {
    let snapshot: ValidationInputSnapshot;
    try {
      snapshot = snapshotInput(input);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#run(snapshot.signal, signal => (
      this.#validateStaged(snapshot, signal)
    ));
  }

  validateStagedWithRepository(
    input: ValidateStagedProjectCheckpointInput,
    repository: ValidatedRepositoryCheckpoint,
  ): Promise<ValidatedProjectCheckpoint> {
    let snapshot: ValidationInputSnapshot;
    try {
      snapshot = snapshotInput(input);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#run(snapshot.signal, signal => (
      this.#validateStaged(snapshot, signal, repository)
    ));
  }

  async captureOutbound(
    input: CaptureOutboundProjectCheckpointInput,
    reservation: OutboundProjectCheckpointReservation,
  ): Promise<CapturedOutboundProjectCheckpoint> {
    return await this.#run(input.signal, async signal => {
      try {
        this.#outboundRepositoryReservation(reservation, input.projectId);
        const snapshot = snapshotOutboundInput({ ...input, signal });
        return await this.#captureOutbound(snapshot, signal, reservation);
      } catch (error: unknown) {
        if (error instanceof ProjectCheckpointCoordinatorError) throw error;
        return mapDependency(error, signal);
      }
    });
  }

  reserveOutbound(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<OutboundProjectCheckpointReservation> {
    if (!isCollabProjectId(projectId)) {
      return Promise.reject(
        new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    const repositoryCapture = this.#repositoryCapture;
    if (repositoryCapture === undefined) {
      return Promise.reject(
        new ProjectCheckpointCoordinatorError('storage-unavailable'),
      );
    }
    return this.#run(signal, async operationSignal => {
      let coordinationOwned = false;
      try {
        if (
          this.#activeCoordinationValidations
          >= this.#maximumConcurrentCoordinationValidations
        ) fail('busy');
        this.#activeCoordinationValidations += 1;
        coordinationOwned = true;
        const repositoryReservation =
          await repositoryCapture.reserveCaptureOperation(
          projectId,
          operationSignal,
        );
        const state: OutboundReservationState = {
          active: true,
          projectId,
          repositoryReservation,
        };
        const reservation: OutboundProjectCheckpointReservation = Object.freeze({
          maximumCoordinationBytes: this.#maximumCoordinationBytes,
          projectId,
          repositoryReservation,
          close: async (): Promise<void> => {
            if (!state.active) return;
            state.active = false;
            try {
              await repositoryReservation.close();
            } finally {
              this.#activeCoordinationValidations -= 1;
            }
          },
        });
        this.#outboundReservations.set(reservation, state);
        coordinationOwned = false;
        return reservation;
      } catch (error: unknown) {
        return mapDependency(error, operationSignal);
      } finally {
        if (coordinationOwned) this.#activeCoordinationValidations -= 1;
      }
    });
  }

  releaseOutbound(
    checkpoint: CapturedOutboundProjectCheckpoint,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#settleOutbound(checkpoint, false, signal);
  }

  publishOutbound(
    checkpoint: CapturedOutboundProjectCheckpoint,
    reservation: OutboundProjectCheckpointReservation,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#run(signal, operationSignal => (
      this.#publishOutbound(checkpoint, reservation, operationSignal)
    ));
  }

  registerOutboundDelivery(
    input: OutboundProjectCheckpointIdentity,
    signal?: AbortSignal,
  ): Promise<'registered' | 'replayed'> {
    let snapshot: OutboundIdentitySnapshot;
    try {
      snapshot = snapshotOutboundIdentity(input, signal);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#run(snapshot.signal, async operationSignal => {
      try {
        const publication = this.#publication?.export;
        if (publication === undefined) fail('storage-unavailable');
        return await publication.registerDelivery(
          productionCheckpointAttemptIdentity(snapshot),
          operationSignal,
        );
      } catch (error: unknown) {
        return mapDependency(error, operationSignal);
      }
    });
  }

  listDueOutboundDeliveries(
    options: Readonly<{
      readonly after?: ProductionCheckpointDeliveryCursor;
      readonly expiredBefore: string;
      readonly limit?: number;
    }>,
    signal?: AbortSignal,
  ): Promise<ProductionCheckpointDeliveryPage> {
    return this.#run(signal, async operationSignal => {
      try {
        const publication = this.#publication?.export;
        if (publication === undefined) fail('storage-unavailable');
        return await publication.listDueDeliveries(
          options as Parameters<ExportCheckpointPublicationPort[
            'listDueDeliveries'
          ]>[0],
          operationSignal,
        );
      } catch (error: unknown) {
        return mapDependency(error, operationSignal);
      }
    });
  }

  readOutboundRecords(
    input: ReadOutboundProjectCheckpointRecordsInput,
    reservation: OutboundProjectCheckpointReservation,
    signal?: AbortSignal,
  ): Promise<readonly OutboundProjectCheckpointRecord[]> {
    let snapshot: OutboundIdentitySnapshot;
    const expectedProfile: unknown = input.expectedProfile;
    try {
      snapshot = snapshotOutboundIdentity(input, signal);
      if (expectedProfile !== 'backup' && expectedProfile !== 'export') {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#run(snapshot.signal, async operationSignal => {
      try {
        this.#outboundRepositoryReservation(reservation, snapshot.projectId);
        const attempt = productionCheckpointAttemptIdentity(snapshot);
        const inspected = await this.#staging.inspectAttempt(
          attempt,
          operationSignal,
        );
        if (!exactAttempt(inspected.attempt, attempt)) {
          fail('invalid-checkpoint');
        }
        const coordination = inspected.artifacts.filter(
          artifact => artifact.name === 'coordination.ndjson',
        );
        if (coordination.length !== 1 || coordination[0] === undefined) {
          fail('invalid-checkpoint');
        }
        if (coordination[0].byteCount > this.#maximumCoordinationBytes) {
          fail('resource-limit');
        }
        const coordinationJson = await this.#readTextArtifact(
          this.#staging,
          attempt,
          coordination[0],
          operationSignal,
        );
        const records = deepFreeze(decodeOutboundCoordination(
          coordinationJson,
          expectedProfile,
        ));
        if (
          encodeOutboundCoordination(records, expectedProfile)
            !== coordinationJson
        ) fail('invalid-checkpoint');
        return records;
      } catch (error: unknown) {
        return mapDependency(error, operationSignal);
      }
    });
  }

  readPublishedOutboundRecords(
    input: ReadOutboundProjectCheckpointRecordsInput,
    reservation: OutboundProjectCheckpointReservation,
    signal?: AbortSignal,
  ): Promise<readonly OutboundProjectCheckpointRecord[]> {
    let snapshot: OutboundIdentitySnapshot;
    const expectedProfile: unknown = input.expectedProfile;
    try {
      snapshot = snapshotOutboundIdentity(input, signal);
      if (expectedProfile !== 'backup' && expectedProfile !== 'export') {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#run(snapshot.signal, async operationSignal => {
      try {
        this.#outboundRepositoryReservation(reservation, snapshot.projectId);
        const publication = this.#publication?.[expectedProfile];
        if (publication === undefined) fail('storage-unavailable');
        const attempt = productionCheckpointAttemptIdentity(snapshot);
        const inspected = await publication.inspectAttempt(
          attempt,
          operationSignal,
        );
        if (!exactAttempt(inspected.attempt, attempt)) {
          fail('invalid-checkpoint');
        }
        const coordination = inspected.artifacts.filter(
          artifact => artifact.name === 'coordination.ndjson',
        );
        if (coordination.length !== 1 || coordination[0] === undefined) {
          fail('invalid-checkpoint');
        }
        if (coordination[0].byteCount > this.#maximumCoordinationBytes) {
          fail('resource-limit');
        }
        const coordinationJson = await this.#readTextArtifact(
          publication,
          attempt,
          coordination[0],
          operationSignal,
        );
        const records = deepFreeze(decodeOutboundCoordination(
          coordinationJson,
          expectedProfile,
        ));
        if (
          encodeOutboundCoordination(records, expectedProfile)
            !== coordinationJson
        ) fail('invalid-checkpoint');
        return records;
      } catch (error: unknown) {
        return mapDependency(error, operationSignal);
      }
    });
  }

  discardOutbound(
    checkpoint: CapturedOutboundProjectCheckpoint,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#settleOutbound(checkpoint, true, signal);
  }

  discardOutboundOperation(
    input: ProfiledOutboundProjectCheckpointIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    let snapshot: OutboundIdentitySnapshot;
    const profile = input.profile;
    try {
      snapshot = snapshotOutboundIdentity(input, signal);
      if (!COLLAB_CHECKPOINT_PROFILES.some(candidate => candidate === profile)) {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#settleOutboundOperation(snapshot, profile, true);
  }

  releaseOutboundOperation(
    input: ProfiledOutboundProjectCheckpointIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    let snapshot: OutboundIdentitySnapshot;
    const profile = input.profile;
    try {
      snapshot = snapshotOutboundIdentity(input, signal);
      if (!COLLAB_CHECKPOINT_PROFILES.some(candidate => candidate === profile)) {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#settleOutboundOperation(snapshot, profile, false);
  }

  verifyOutboundOperation(
    input: VerifyOutboundProjectCheckpointInput,
    reservation: OutboundProjectCheckpointReservation,
    signal?: AbortSignal,
  ): Promise<void> {
    let snapshot: VerifyOutboundSnapshot;
    try {
      snapshot = snapshotOutboundVerification(input, signal);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#run(snapshot.signal, operationSignal => (
      this.#verifyOutbound(
        snapshot,
        operationSignal,
        reservation,
        snapshot.expectedProfile === 'backup'
          || snapshot.expectedProfile === 'export'
          ? this.#publication?.[snapshot.expectedProfile]
          : undefined,
      )
    ));
  }

  discard(
    checkpoint: ValidatedProjectCheckpoint,
    signal?: AbortSignal,
  ): Promise<void> {
    let attempt: PreparedProductionCheckpointAttempt;
    let operationId: string;
    let projectId: string;
    try {
      attempt = snapshotAttempt(checkpoint.attempt);
      operationId = checkpoint.repository.operationId;
      projectId = checkpoint.repository.projectId;
      if (
        operationId !== attempt.operationId
        || projectId !== attempt.projectId
        || checkpoint.manifest.operationId !== attempt.operationId
        || checkpoint.manifest.projectId !== attempt.projectId
      ) {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProjectCheckpointCoordinatorError
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#discardAttempt(attempt, signal);
  }

  discardAttempt(
    input: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<void> {
    let attempt: PreparedProductionCheckpointAttempt;
    try {
      attempt = snapshotAttempt(input);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof ProjectCheckpointCoordinatorError
          ? error
          : new ProjectCheckpointCoordinatorError('invalid-checkpoint'),
      );
    }
    return this.#discardAttempt(attempt, signal);
  }

  #discardAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#run(signal, async operationSignal => {
      try {
        await this.#repository.discardCheckpoint({
          operationId: attempt.operationId,
          projectId: attempt.projectId,
        });
        await this.#staging.discardAttempt(attempt, operationSignal);
      } catch (error: unknown) {
        mapDependency(error, operationSignal);
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort('closed');
      this.#closePromise = Promise.allSettled([...this.#running]).then(
        () => undefined,
      );
    }
    return this.#closePromise;
  }

  #run<Result>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new ProjectCheckpointCoordinatorError('closed'));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort('cancelled');
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted === true) onAbort();
    this.#controllers.add(controller);
    const result = Promise.resolve().then(() => operation(controller.signal));
    const tracked = result.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    void tracked.finally(() => {
      externalSignal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      this.#running.delete(tracked);
    });
    return result;
  }

  async #validateStaged(
    input: ValidationInputSnapshot,
    signal: AbortSignal,
    expectedRepository?: ValidatedRepositoryCheckpoint,
  ): Promise<ValidatedProjectCheckpoint> {
    let coordinationValidationOwned = false;
    try {
      const inspected = await this.#staging.inspectAttempt(
        input.attempt,
        signal,
      );
      if (!exactAttempt(inspected.attempt, input.attempt)) {
        fail('invalid-checkpoint');
      }
      const artifacts = snapshotArtifacts(inspected.artifacts, input.attempt);
      const manifestFact = artifacts.get('checkpoint.json');
      const coordinationFact = artifacts.get('coordination.ndjson');
      const repositoryFact = artifacts.get('repository.bundle');
      if (
        manifestFact === undefined
        || coordinationFact === undefined
        || repositoryFact === undefined
      ) {
        fail('invalid-checkpoint');
      }
      if (coordinationFact.byteCount > this.#maximumCoordinationBytes) {
        fail('resource-limit');
      }
      const manifestJson = await this.#readTextArtifact(
        this.#staging,
        input.attempt,
        manifestFact,
        signal,
      );
      const manifest = deepFreeze(decodeManifestJson(manifestJson));
      if (
        encodeCollabProjectCheckpointManifestCanonicalJson(manifest)
          !== manifestJson
        || sha256(encodeCollabProjectCheckpointManifestDigestInput(manifest))
          !== manifest.manifestSha256
        || manifest.projectId !== input.attempt.projectId
        || manifest.operationId !== input.attempt.operationId
        || manifest.profile !== input.expectedProfile
        || !sameAuthority(
          manifest.sourceAuthority,
          input.expectedSourceAuthority,
        )
        || !sameAuthority(
          manifest.targetAuthority,
          input.expectedTargetAuthority,
        )
      ) {
        fail('invalid-checkpoint');
      }
      for (const fact of [coordinationFact, repositoryFact]) {
        const expected = manifest.artifacts.find(item => item.name === fact.name);
        if (
          expected?.byteCount !== fact.byteCount
          || expected.sha256 !== fact.sha256
        ) {
          fail('invalid-checkpoint');
        }
      }
      if (
        this.#activeCoordinationValidations
        >= this.#maximumConcurrentCoordinationValidations
      ) {
        fail('busy');
      }
      this.#activeCoordinationValidations += 1;
      coordinationValidationOwned = true;
      const coordinationJson = await this.#readTextArtifact(
        this.#staging,
        input.attempt,
        coordinationFact,
        signal,
      );
      const records = deepFreeze(validateCollabProjectCheckpointConsistency(
        manifest,
        decodeCollabProjectCheckpointCoordinationNdjson(
          coordinationJson,
          manifest.profile,
        ),
      ));
      let importedRepository: ValidatedRepositoryCheckpoint;
      if (expectedRepository === undefined) {
        try {
          importedRepository = await importRepositoryCheckpoint(this.#repository, {
            expectedByteCount: repositoryFact.byteCount,
            expectedSha256: repositoryFact.sha256,
            objectFormat: manifest.gitObjectFormat,
            operationId: input.attempt.operationId,
            projectId: input.attempt.projectId,
            refs: manifest.refs,
            signal,
          }, delivery => this.#staging.readArtifact({
            artifact: repositoryFact,
            attempt: input.attempt,
            ...delivery,
          }));
        } catch (error: unknown) {
          if (invalidRepositoryStaging(error)) {
            await this.#repository.discardCheckpoint({
              operationId: input.attempt.operationId,
              projectId: input.attempt.projectId,
            });
          }
          throw error;
        }
      } else {
        importedRepository = expectedRepository;
      }
      let repository: ValidatedRepositoryCheckpoint;
      try {
        repository = snapshotRepository(
          importedRepository,
          input.attempt,
          repositoryFact,
          manifest,
        );
      } catch (error: unknown) {
        if (expectedRepository === undefined) {
          try {
            await this.#repository.discardCheckpoint({
              operationId: input.attempt.operationId,
              projectId: input.attempt.projectId,
            });
          } catch (cleanupError: unknown) {
            return mapDependency(cleanupError, signal);
          }
        }
        throw error;
      }
      return Object.freeze({
        attempt: input.attempt,
        manifest,
        records,
        repository,
      });
    } catch (error: unknown) {
      return mapDependency(error, signal);
    } finally {
      if (coordinationValidationOwned) {
        this.#activeCoordinationValidations -= 1;
      }
    }
  }

  async #captureOutbound(
    input: OutboundCaptureSnapshot,
    signal: AbortSignal,
    reservation: OutboundProjectCheckpointReservation,
  ): Promise<CapturedOutboundProjectCheckpoint> {
    const repositoryCapture = this.#repositoryCapture;
    if (repositoryCapture === undefined) fail('storage-unavailable');
    const repositoryReservation = this.#outboundRepositoryReservation(
      reservation,
      input.projectId,
    );
    try {
      const expectedAttempt = productionCheckpointAttemptIdentity({
        expiresAt: input.expiresAt,
        operationId: input.operationId,
        projectId: input.projectId,
      });
      const attempt = snapshotAttempt(await this.#staging.prepareAttempt(
        {
          expiresAt: input.expiresAt,
          operationId: input.operationId,
          projectId: input.projectId,
        },
        signal,
      ));
      if (!exactAttempt(attempt, expectedAttempt)) fail('invalid-checkpoint');
      const coordinationBytes = Buffer.from(input.coordinationJson, 'utf8');
      if (coordinationBytes.length > this.#maximumCoordinationBytes) {
        fail('resource-limit');
      }
      const coordination = exactArtifactFact(
        await this.#staging.receiveArtifact({
        artifact: 'coordination.ndjson',
        attempt,
        body: ProjectCheckpointCoordinator.#bufferBody(coordinationBytes),
        expectedByteCount: coordinationBytes.length,
        expectedSha256: sha256(coordinationBytes),
        signal,
        }),
        attempt,
        'coordination.ndjson',
        coordinationBytes.length,
        sha256(coordinationBytes),
      );
      await input.onProgress('coordination-captured', undefined);
      const repository = await repositoryCapture.capture({
        operationId: input.operationId,
        placement: input.placement,
        refs: input.refs,
        signal,
      }, repositoryReservation);
      if (
        repository.projectId !== input.projectId
        || repository.operationId !== input.operationId
        || repository.placementGeneration !== input.placement.generation
        || repository.refs.length !== input.refs.length
        || repository.refs.some((ref, index) => {
          const expected = input.refs.at(index);
          return expected === undefined
            || ref.name !== expected.name
            || ref.oid !== expected.oid;
        })
      ) {
        fail('invalid-checkpoint');
      }
      const repositoryArtifact = exactArtifactFact(
        await this.#stageRepositoryCapture(attempt, repository, signal),
        attempt,
        'repository.bundle',
        repository.byteCount,
        repository.sha256,
      );
      await input.onProgress('repository-captured', undefined);
      const unsigned = Object.freeze({
        artifacts: Object.freeze([
          Object.freeze({
            byteCount: coordination.byteCount,
            name: 'coordination.ndjson' as const,
            sha256: coordination.sha256,
          }),
          Object.freeze({
            byteCount: repositoryArtifact.byteCount,
            name: 'repository.bundle' as const,
            sha256: repositoryArtifact.sha256,
          }),
        ]),
        coordinationFormatVersion: input.profile === 'backup'
          ? COLLAB_PROJECT_BACKUP_COORDINATION_FORMAT_VERSION
          : COLLAB_PROJECT_COORDINATION_FORMAT_VERSION,
        createdAt: input.createdAt,
        expectedMainOid: input.expectedMainOid,
        gitObjectFormat: repository.objectFormat,
        manifestSchemaVersion: COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
        manifestSha256: '0'.repeat(64),
        operationId: input.operationId,
        profile: input.profile,
        projectId: input.projectId,
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        refs: input.refs,
        sourceAuthority: input.sourceAuthority,
        targetAuthority: input.targetAuthority,
      }) as OutboundProjectCheckpointManifest;
      const manifest = deepFreeze(decodeOutboundManifestJson(
        encodeOutboundManifestCanonicalJson(Object.freeze({
          ...unsigned,
          manifestSha256: sha256(
            encodeOutboundManifestDigestInput(unsigned),
          ),
        })),
        input.profile,
      ));
      validateOutboundConsistency(manifest, input.records);
      const manifestJson = encodeOutboundManifestCanonicalJson(
        manifest,
      );
      const manifestBytes = Buffer.from(manifestJson, 'utf8');
      exactArtifactFact(
        await this.#staging.receiveArtifact({
          artifact: 'checkpoint.json',
          attempt,
          body: ProjectCheckpointCoordinator.#bufferBody(manifestBytes),
          expectedByteCount: manifestBytes.length,
          expectedSha256: sha256(manifestBytes),
          signal,
        }),
        attempt,
        'checkpoint.json',
        manifestBytes.length,
        sha256(manifestBytes),
      );
      const inspected = await this.#staging.inspectAttempt(attempt, signal);
      if (!exactAttempt(inspected.attempt, attempt)) fail('invalid-checkpoint');
      const artifacts = snapshotArtifacts(inspected.artifacts, attempt);
      if (
        artifacts.get('coordination.ndjson')?.byteCount
          !== coordination.byteCount
        || artifacts.get('coordination.ndjson')?.sha256 !== coordination.sha256
        || artifacts.get('repository.bundle')?.byteCount
          !== repositoryArtifact.byteCount
        || artifacts.get('repository.bundle')?.sha256
          !== repositoryArtifact.sha256
        || artifacts.get('checkpoint.json')?.byteCount !== manifestBytes.length
        || artifacts.get('checkpoint.json')?.sha256 !== sha256(manifestBytes)
      ) {
        fail('invalid-checkpoint');
      }
      await this.#verifyOutbound(Object.freeze({
        expectedCheckpointSha256: manifest.manifestSha256,
        expectedProfile: input.profile,
        expectedSourceAuthority: input.sourceAuthority,
        expectedTargetAuthority: input.targetAuthority,
        expiresAt: input.expiresAt,
        operationId: input.operationId,
        projectId: input.projectId,
        signal,
      }), signal, reservation, this.#staging);
      await input.onProgress('checkpoint-verified', manifest.manifestSha256);
      return Object.freeze({
        attempt,
        manifest,
        records: input.records,
        repository,
      });
    } catch (error: unknown) {
      return mapDependency(error, signal);
    }
  }

  async #stageRepositoryCapture(
    attempt: PreparedProductionCheckpointAttempt,
    capture: CapturedRepositoryCheckpoint,
    signal: AbortSignal,
  ): Promise<StagedProductionCheckpointArtifact> {
    const repositoryCapture = this.#repositoryCapture;
    if (repositoryCapture === undefined) fail('storage-unavailable');
    const body = new PassThrough({ highWaterMark: STREAM_BUFFER_BYTES });
    body.on('error', () => undefined);
    const pumpController = new AbortController();
    const pumpSignal = AbortSignal.any([signal, pumpController.signal]);
    const pump = repositoryCapture.readCapture({
      capture,
      onChunk: async chunk => {
        if (!body.write(chunk)) await once(body, 'drain', { signal: pumpSignal });
      },
      signal: pumpSignal,
    }).then(
      () => {
        body.end();
      },
      (error: unknown) => {
        body.destroy(safePumpFailure(error));
      },
    );
    try {
      const artifact = await this.#staging.receiveArtifact({
        artifact: 'repository.bundle',
        attempt,
        body,
        expectedByteCount: capture.byteCount,
        expectedSha256: capture.sha256,
        signal,
      });
      pumpController.abort('cancelled');
      body.destroy(new ProjectCheckpointCoordinatorError('cancelled'));
      await pump;
      if (signal.aborted) {
        fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
      }
      return artifact;
    } finally {
      pumpController.abort('cancelled');
      body.destroy();
      await pump.catch(() => undefined);
    }
  }

  async #publishOutbound(
    checkpoint: CapturedOutboundProjectCheckpoint,
    reservation: OutboundProjectCheckpointReservation,
    signal: AbortSignal,
  ): Promise<void> {
    const profile = checkpoint.manifest.profile;
    if (profile !== 'backup' && profile !== 'export') {
      fail('invalid-checkpoint');
    }
    const publication = this.#publication?.[profile];
    if (publication === undefined) fail('storage-unavailable');
    this.#outboundRepositoryReservation(
      reservation,
      checkpoint.attempt.projectId,
    );
    try {
      const attempt = snapshotAttempt(checkpoint.attempt);
      if (
        checkpoint.manifest.projectId !== attempt.projectId
        || checkpoint.manifest.operationId !== attempt.operationId
        || checkpoint.manifest.profile !== 'backup'
          && checkpoint.manifest.profile !== 'export'
        || checkpoint.manifest.manifestSha256 !== sha256(
          encodeOutboundManifestDigestInput(checkpoint.manifest),
        )
      ) fail('invalid-checkpoint');
      const source = await this.#staging.inspectAttempt(attempt, signal);
      if (!exactAttempt(source.attempt, attempt)) fail('invalid-checkpoint');
      const sourceArtifacts = snapshotArtifacts(source.artifacts, attempt);
      if (
        sourceArtifacts.size !== COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.length
        || COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.some(
          name => sourceArtifacts.get(name) === undefined,
        )
      ) fail('invalid-checkpoint');
      const publishedAttempt = snapshotAttempt(await publication.prepareAttempt({
        expiresAt: attempt.expiresAt,
        operationId: attempt.operationId,
        projectId: attempt.projectId,
      }, signal));
      if (!exactAttempt(publishedAttempt, attempt)) fail('invalid-checkpoint');
      for (const artifactName of COLLAB_PROJECT_CHECKPOINT_ARTIFACTS) {
        const artifact = sourceArtifacts.get(artifactName);
        if (artifact === undefined) fail('invalid-checkpoint');
        await this.#copyArtifact(
          this.#staging,
          publication,
          attempt,
          artifact,
          signal,
        );
      }
      await this.#verifyOutbound(Object.freeze({
        expectedCheckpointSha256: checkpoint.manifest.manifestSha256,
        expectedProfile: checkpoint.manifest.profile,
        expectedSourceAuthority: snapshotAuthority(
          checkpoint.manifest.sourceAuthority,
        ) as CollabCheckpointAuthority & { readonly kind: 'cloud' },
        expectedTargetAuthority: null,
        expiresAt: attempt.expiresAt,
        operationId: attempt.operationId,
        projectId: attempt.projectId,
        signal,
      }), signal, reservation, publication);
    } catch (error: unknown) {
      mapDependency(error, signal);
    }
  }

  async #copyArtifact(
    source: ProductionCheckpointStagingPort,
    target: ProductionCheckpointStagingPort,
    attempt: PreparedProductionCheckpointAttempt,
    artifact: StagedProductionCheckpointArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    const body = new PassThrough({ highWaterMark: STREAM_BUFFER_BYTES });
    body.on('error', () => undefined);
    const pumpController = new AbortController();
    const pumpSignal = AbortSignal.any([signal, pumpController.signal]);
    const pump = source.readArtifact({
      artifact,
      attempt,
      onChunk: async chunk => {
        if (!body.write(chunk)) {
          await once(body, 'drain', { signal: pumpSignal });
        }
      },
      signal: pumpSignal,
    }).then(
      () => body.end(),
      (error: unknown) => body.destroy(safePumpFailure(error)),
    );
    try {
      exactArtifactFact(await target.receiveArtifact({
        artifact: artifact.name,
        attempt,
        body,
        expectedByteCount: artifact.byteCount,
        expectedSha256: artifact.sha256,
        signal,
      }), attempt, artifact.name, artifact.byteCount, artifact.sha256);
    } finally {
      pumpController.abort('cancelled');
      body.destroy();
      await pump.catch(() => undefined);
    }
  }

  #settleOutbound(
    checkpoint: CapturedOutboundProjectCheckpoint,
    discardArtifacts: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#run(signal, async operationSignal => {
      const repositoryCapture = this.#repositoryCapture;
      if (repositoryCapture === undefined) fail('storage-unavailable');
      try {
        await repositoryCapture.discardCapture(
          checkpoint.repository,
          operationSignal,
        );
        await this.#staging.discardAttempt(
          checkpoint.attempt,
          operationSignal,
        );
        const profile = checkpoint.manifest.profile;
        const publication = profile === 'backup' || profile === 'export'
          ? this.#publication?.[profile]
          : undefined;
        if (discardArtifacts && publication !== undefined) {
          await publication.discardAttempt(
            checkpoint.attempt,
            operationSignal,
          );
        }
      } catch (error: unknown) {
        mapDependency(error, operationSignal);
      }
    });
  }

  #settleOutboundOperation(
    input: OutboundIdentitySnapshot,
    profile: CollabCheckpointProfile,
    discardArtifacts: boolean,
  ): Promise<void> {
    return this.#run(input.signal, async operationSignal => {
      const repositoryCapture = this.#repositoryCapture;
      if (repositoryCapture === undefined) fail('storage-unavailable');
      try {
        const attempt = productionCheckpointAttemptIdentity(input);
        await repositoryCapture.discardCaptureOperation({
          operationId: input.operationId,
          projectId: input.projectId,
        }, operationSignal);
        await this.#staging.discardAttempt(attempt, operationSignal);
        const publication = profile === 'backup' || profile === 'export'
          ? this.#publication?.[profile]
          : undefined;
        if (discardArtifacts && publication !== undefined) {
          await publication.discardAttempt(attempt, operationSignal);
        }
      } catch (error: unknown) {
        mapDependency(error, operationSignal);
      }
    });
  }

  async #verifyOutbound(
    input: VerifyOutboundSnapshot,
    signal: AbortSignal,
    reservation: OutboundProjectCheckpointReservation,
    store: ProductionCheckpointStagingPort | undefined,
  ): Promise<void> {
    const repositoryCapture = this.#repositoryCapture;
    if (repositoryCapture === undefined || store === undefined) {
      fail('storage-unavailable');
    }
    const attempt = productionCheckpointAttemptIdentity(input);
    try {
      const repositoryReservation = this.#outboundRepositoryReservation(
        reservation,
        input.projectId,
      );
      const inspected = await store.inspectAttempt(attempt, signal);
      if (!exactAttempt(inspected.attempt, attempt)) fail('invalid-checkpoint');
      const artifacts = snapshotArtifacts(inspected.artifacts, attempt);
      const manifestFact = artifacts.get('checkpoint.json');
      const coordinationFact = artifacts.get('coordination.ndjson');
      const repositoryFact = artifacts.get('repository.bundle');
      if (
        manifestFact === undefined
        || coordinationFact === undefined
        || repositoryFact === undefined
        || coordinationFact.byteCount > this.#maximumCoordinationBytes
      ) {
        fail(coordinationFact !== undefined
          && coordinationFact.byteCount > this.#maximumCoordinationBytes
          ? 'resource-limit'
          : 'invalid-checkpoint');
      }
      const manifestJson = await this.#readTextArtifact(
        store,
        attempt,
        manifestFact,
        signal,
      );
      const manifest = deepFreeze(decodeOutboundManifestJson(
        manifestJson,
        input.expectedProfile,
      ));
      if (
        encodeOutboundManifestCanonicalJson(manifest) !== manifestJson
        || sha256(encodeOutboundManifestDigestInput(manifest))
          !== manifest.manifestSha256
        || manifest.manifestSha256 !== input.expectedCheckpointSha256
        || manifest.projectId !== attempt.projectId
        || manifest.operationId !== attempt.operationId
        || manifest.profile !== input.expectedProfile
        || !sameAuthority(manifest.sourceAuthority, input.expectedSourceAuthority)
        || !sameAuthority(
          manifest.targetAuthority,
          input.expectedTargetAuthority,
        )
      ) {
        fail('invalid-checkpoint');
      }
      for (const fact of [coordinationFact, repositoryFact]) {
        const expected = manifest.artifacts.find(item => item.name === fact.name);
        if (
          expected?.byteCount !== fact.byteCount
          || expected.sha256 !== fact.sha256
        ) fail('invalid-checkpoint');
      }
      const coordinationJson = await this.#readTextArtifact(
        store,
        attempt,
        coordinationFact,
        signal,
      );
      validateOutboundConsistency(
        manifest,
        decodeOutboundCoordination(
          coordinationJson,
          manifest.profile,
        ),
      );
      const verified = await this.#verifyOutboundRepositoryArtifact(
        store,
        attempt,
        repositoryFact,
        manifest,
        repositoryReservation,
        signal,
      );
      snapshotRepository(verified, attempt, repositoryFact, manifest);
    } catch (error: unknown) {
      mapDependency(error, signal);
    }
  }

  async #verifyOutboundRepositoryArtifact(
    store: ProductionCheckpointStagingPort,
    attempt: PreparedProductionCheckpointAttempt,
    artifact: StagedProductionCheckpointArtifact,
    manifest: OutboundProjectCheckpointManifest,
    reservation: ExactRepositoryOperationReservation,
    signal: AbortSignal,
  ): Promise<ValidatedRepositoryCheckpoint> {
    const repositoryCapture = this.#repositoryCapture;
    if (repositoryCapture === undefined) fail('storage-unavailable');
    const body = new PassThrough({ highWaterMark: STREAM_BUFFER_BYTES });
    body.on('error', () => undefined);
    const pumpController = new AbortController();
    const pumpSignal = AbortSignal.any([signal, pumpController.signal]);
    const pump = store.readArtifact({
      artifact,
      attempt,
      onChunk: async chunk => {
        if (!body.write(chunk)) {
          await once(body, 'drain', { signal: pumpSignal });
        }
      },
      signal: pumpSignal,
    }).then(
      () => body.end(),
      (error: unknown) => body.destroy(safePumpFailure(error)),
    );
    try {
      const verified = await repositoryCapture.verifyArtifact(reservation, {
        body,
        expectedByteCount: artifact.byteCount,
        expectedSha256: artifact.sha256,
        objectFormat: manifest.gitObjectFormat,
        operationId: attempt.operationId,
        projectId: attempt.projectId,
        refs: manifest.refs,
        signal,
      });
      await pump;
      if (signal.aborted) {
        fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
      }
      return verified;
    } finally {
      pumpController.abort('cancelled');
      body.destroy();
      await pump.catch(() => undefined);
    }
  }

  static #bufferBody(bytes: Buffer): AsyncIterable<Buffer> {
    return Object.freeze({
      async *[Symbol.asyncIterator]() {
        yield await Promise.resolve(bytes);
      },
    });
  }

  #outboundRepositoryReservation(
    reservation: OutboundProjectCheckpointReservation,
    projectId: string,
  ): ExactRepositoryOperationReservation {
    const state = this.#outboundReservations.get(reservation);
    if (
      state === undefined
      || !state.active
      || state.projectId !== projectId
      || reservation.projectId !== projectId
      || reservation.maximumCoordinationBytes !== this.#maximumCoordinationBytes
      || reservation.repositoryReservation !== state.repositoryReservation
    ) fail('invalid-checkpoint');
    return state.repositoryReservation;
  }

  async #readTextArtifact(
    store: ProductionCheckpointStagingPort,
    attempt: PreparedProductionCheckpointAttempt,
    artifact: StagedProductionCheckpointArtifact,
    signal: AbortSignal,
  ): Promise<string> {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    await store.readArtifact({
      artifact,
      attempt,
      onChunk: chunk => {
        byteCount += chunk.length;
        if (byteCount > artifact.byteCount || byteCount > artifactLimit(artifact.name)) {
          fail('invalid-checkpoint');
        }
        chunks.push(Buffer.from(chunk));
      },
      signal,
    });
    if (byteCount !== artifact.byteCount) fail('invalid-checkpoint');
    const bytes = Buffer.concat(chunks, byteCount);
    if (sha256(bytes) !== artifact.sha256) fail('invalid-checkpoint');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return fail('invalid-checkpoint');
    }
  }
}
