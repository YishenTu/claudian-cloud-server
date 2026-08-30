import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { getuid } from 'node:process';

import {
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  collabMemberRef,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabCheckpointGitRef,
  type CollabCheckpointObjectFormat,
  type CollabMemberId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import {
  ResourceAdmissionError,
  type GitChildPermit,
  type ResourceAdmission,
} from '../resource-admission/ResourceAdmission.js';
import {
  DurableTreeRemovalError,
  removeDurableOwnedTree,
} from './DurableTreeRemoval.js';
import {
  GitProcessError,
  GitProcessSupervisor,
} from './GitProcessSupervisor.js';
import { RepositoryPathPolicy } from './RepositoryPathPolicy.js';
import {
  createRepositoryPlacementLease,
  RepositoryPlacementError,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from './RepositoryPlacement.js';
import {
  GitBundleImportError,
  repositoryCheckpointArtifactKey,
  repositoryCheckpointAttemptMarkerJson,
  repositoryCheckpointStagingRepositoryPath,
  verifyGitRepositoryContent,
  type ValidatedRepositoryCheckpoint,
} from './GitBundleImporter.js';

export type RepositoryCheckpointErrorCode =
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'invalid-checkpoint'
  | 'output-limit'
  | 'placement-rejected'
  | 'repository-invalid'
  | 'repository-limit'
  | 'storage-unavailable'
  | 'timeout';

export class RepositoryCheckpointError extends Error {
  readonly code: RepositoryCheckpointErrorCode;
  readonly retryable: boolean;

  constructor(code: RepositoryCheckpointErrorCode) {
    super(`repository-checkpoint.error.${code}`);
    this.name = 'RepositoryCheckpointError';
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

export interface RepositoryCheckpointAuthorityOptions {
  readonly gitExecutable: string;
  readonly maximumBlobBytes: number;
  readonly maximumBundleBytes: number;
  readonly maximumExpandedTreeEntries: number;
  readonly maximumRepositoryBytes: number;
  readonly maximumTreeEntries: number;
  readonly operationRoot: string;
  readonly operationTimeoutMs: number;
  readonly outputMaxBytes: number;
  readonly placementValidator: RepositoryPlacementValidator;
  readonly removeTree?: (path: string) => Promise<void>;
  readonly repositoryRoot: string;
  readonly resourceAdmission: ResourceAdmission;
  readonly storageNodeId: string;
  readonly syncDirectory?: (path: string) => Promise<void>;
}

export interface CaptureRepositoryCheckpointInput {
  readonly operationId: string;
  readonly placement: RepositoryPlacementLease;
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly signal?: AbortSignal;
}

export interface InventoryRepositoryCheckpointRefsInput {
  readonly memberIds: readonly string[];
  readonly placement: RepositoryPlacementLease;
  readonly signal?: AbortSignal;
}

export interface CapturedRepositoryCheckpoint {
  readonly artifactKey: string;
  readonly byteCount: number;
  readonly objectFormat: CollabCheckpointObjectFormat;
  readonly operationId: string;
  readonly placementGeneration: number;
  readonly projectId: CollabProjectId;
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly sha256: string;
}

export interface ReadRepositoryCheckpointInput {
  readonly capture: CapturedRepositoryCheckpoint;
  readonly onChunk: (
    chunk: Buffer,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

export interface VerifyRepositoryCheckpointArtifactInput {
  readonly body: AsyncIterable<Uint8Array>;
  readonly expectedByteCount: number;
  readonly expectedSha256: string;
  readonly objectFormat: CollabCheckpointObjectFormat;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly signal?: AbortSignal;
}

export interface PublishInactiveRepositoryInput {
  readonly checkpoint: ValidatedRepositoryCheckpoint;
  readonly placementGeneration: number;
  readonly repositoryStorageKey: string;
  readonly signal?: AbortSignal;
}

export interface DeleteExactPersonalRefInput {
  readonly expectedOid: string;
  readonly personalRef: string;
  readonly placement: RepositoryPlacementLease;
  readonly signal?: AbortSignal;
}

export type ReadExactPersonalRefInput = Omit<
  DeleteExactPersonalRefInput,
  'expectedOid'
>;

export interface ExactOwnedRepositoryIdentity {
  readonly placementGeneration: number;
  readonly projectId: CollabProjectId;
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
}

export interface ExactRepositoryOperationReservation {
  readonly projectId: CollabProjectId;
  close(): Promise<void>;
}

export interface InactiveRepositoryPublication {
  readonly artifactKey: string;
  readonly bundleByteCount: number;
  readonly bundleSha256: string;
  readonly objectFormat: CollabCheckpointObjectFormat;
  readonly operationId: string;
  readonly placementGeneration: number;
  readonly projectId: CollabProjectId;
  readonly publicationMarkerSha256: string;
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly repositoryStorageKey: string;
  readonly status: 'inactive';
  readonly storageNodeId: string;
  readonly validationMarkerSha256: string;
}

export interface RepositoryCheckpointCapturePort {
  reserveCaptureOperation(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<ExactRepositoryOperationReservation>;
  capture(
    input: CaptureRepositoryCheckpointInput,
    reservation?: ExactRepositoryOperationReservation,
  ): Promise<CapturedRepositoryCheckpoint>;
  discardCapture(
    capture: CapturedRepositoryCheckpoint,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'>;
  discardCaptureOperation(
    input: Readonly<{
      readonly operationId: string;
      readonly projectId: CollabProjectId;
    }>,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'>;
  inventoryRefs(
    input: InventoryRepositoryCheckpointRefsInput,
    reservation?: ExactRepositoryOperationReservation,
  ): Promise<readonly CollabCheckpointGitRef[]>;
  readCapture(input: ReadRepositoryCheckpointInput): Promise<void>;
  verifyArtifact(
    reservation: ExactRepositoryOperationReservation,
    input: VerifyRepositoryCheckpointArtifactInput,
  ): Promise<ValidatedRepositoryCheckpoint>;
}

export interface InactiveRepositoryPublicationPort {
  planInactive(
    input: Omit<PublishInactiveRepositoryInput, 'signal'>,
  ): InactiveRepositoryPublication;
  publishInactive(
    input: PublishInactiveRepositoryInput,
  ): Promise<InactiveRepositoryPublication>;
  removeOwnedRepository(
    publication: InactiveRepositoryPublication,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'>;
}

export interface ExactPersonalRefPort {
  reserveExactRepositoryOperation(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<ExactRepositoryOperationReservation>;
  verifyExactPersonalRef(
    reservation: ExactRepositoryOperationReservation,
    input: DeleteExactPersonalRefInput,
  ): Promise<void>;
  deleteExactPersonalRef(
    reservation: ExactRepositoryOperationReservation,
    input: DeleteExactPersonalRefInput,
  ): Promise<'deleted' | 'replayed'>;
}

export interface ExactPersonalRefReadPort {
  reserveExactRepositoryOperation(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<ExactRepositoryOperationReservation>;
  readExactPersonalRef(
    reservation: ExactRepositoryOperationReservation,
    input: ReadExactPersonalRefInput,
  ): Promise<string>;
}

export interface ExactRepositoryPresencePort {
  reserveExactRepositoryOperation(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<ExactRepositoryOperationReservation>;
  verifyExactRepository(
    reservation: ExactRepositoryOperationReservation,
    placement: RepositoryPlacementLease,
  ): Promise<void>;
}

export interface ExactRepositoryRemovalPort extends ExactRepositoryPresencePort {
  removeExactRepository(
    reservation: ExactRepositoryOperationReservation,
    identity: ExactOwnedRepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'>;
}

interface PublicationPaths {
  readonly attemptMarker: string;
  readonly canonicalProject: string;
  readonly publicationMarker: string;
  readonly publicationMarkerPart: string;
  readonly repository: string;
  readonly stagingOperation: string;
  readonly stagingProfile: string;
  readonly stagingProject: string;
  readonly stagedRepository: string;
  readonly validationMarker: string;
}

interface CapturePaths {
  readonly bundle: string;
  readonly bundlePart: string;
  readonly marker: string;
  readonly markerPart: string;
  readonly operationId: string;
  readonly operation: string;
  readonly ownerMarker: string;
  readonly ownerMarkerPart: string;
  readonly profile: string;
  readonly projectId: string;
  readonly project: string;
  readonly verification: string;
  readonly verificationBundle: string;
  readonly verificationBundlePart: string;
}

interface ExactRepositoryReservationState {
  active: boolean;
  inUse: boolean;
  readonly permit: GitChildPermit;
  readonly projectId: CollabProjectId;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CAPTURE_MARKER = '.claudian-cloud-checkpoint-capture.json';
const CAPTURE_OWNER_MARKER = '.claudian-cloud-checkpoint-capture-owner.json';
const VALIDATION_MARKER = '.claudian-cloud-validation.json';
const PUBLICATION_MARKER = '.claudian-cloud-checkpoint-publication.json';
const BOOTSTRAP_PUBLICATION_MARKER = '.claudian-cloud-publication.json';
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const STORAGE_NODE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

function fail(code: RepositoryCheckpointErrorCode): never {
  throw new RepositoryCheckpointError(code);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
  }
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('repository-checkpoint.options-invalid');
  }
}

function assertRoot(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || parse(path).root === path) {
    throw new TypeError('repository-checkpoint.options-invalid');
  }
}

function assertOptions(options: RepositoryCheckpointAuthorityOptions): void {
  assertPositiveInteger(options.maximumBlobBytes);
  assertPositiveInteger(options.maximumBundleBytes);
  assertPositiveInteger(options.maximumExpandedTreeEntries);
  assertPositiveInteger(options.maximumRepositoryBytes);
  assertPositiveInteger(options.maximumTreeEntries);
  assertPositiveInteger(options.operationTimeoutMs);
  assertPositiveInteger(options.outputMaxBytes);
  assertRoot(options.operationRoot);
  assertRoot(options.repositoryRoot);
  if (
    options.operationRoot === options.repositoryRoot
    || dirname(options.operationRoot) !== dirname(options.repositoryRoot)
    || options.maximumBlobBytes > COLLAB_LIMITS.maxBlobBytes
    || options.maximumBundleBytes
      > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes
    || options.maximumExpandedTreeEntries > 100_000
    || options.maximumRepositoryBytes < options.maximumBlobBytes
    || options.maximumTreeEntries > 2_000
    || !STORAGE_NODE_PATTERN.test(options.storageNodeId)
    || (options.syncDirectory !== undefined
      && typeof options.syncDirectory !== 'function')
    || (options.removeTree !== undefined && typeof options.removeTree !== 'function')
  ) {
    throw new TypeError('repository-checkpoint.options-invalid');
  }
}

function canonicalRefs(
  refs: readonly CollabCheckpointGitRef[],
): readonly CollabCheckpointGitRef[] {
  if (refs.length < 2) fail('invalid-checkpoint');
  let previous = '';
  let objectLength: number | undefined;
  let memberCount = 0;
  const result = refs.map(ref => {
    const memberId = ref.name.startsWith(COLLAB_MEMBER_REF_PREFIX)
      ? ref.name.slice(COLLAB_MEMBER_REF_PREFIX.length)
      : undefined;
    if (
      !isCollabGitOid(ref.oid)
      || (objectLength !== undefined && ref.oid.length !== objectLength)
      || ref.name.localeCompare(previous, 'en-US') <= 0
      || (
        ref.name !== COLLAB_MAIN_REF
        && (
          memberId === undefined
          || !isCollabMemberId(memberId)
          || collabMemberRef(memberId) !== ref.name
        )
      )
    ) {
      fail('invalid-checkpoint');
    }
    if (memberId !== undefined) memberCount += 1;
    objectLength = ref.oid.length;
    previous = ref.name;
    return Object.freeze({ name: ref.name, oid: ref.oid });
  });
  if (result[0]?.name !== COLLAB_MAIN_REF || memberCount !== result.length - 1) {
    fail('invalid-checkpoint');
  }
  return Object.freeze(result);
}

function canonicalMemberIds(memberIds: readonly string[]): readonly CollabMemberId[] {
  let previous = '';
  const result = memberIds.map(value => {
    if (
      !isCollabMemberId(value)
      || value.localeCompare(previous, 'en-US') <= 0
    ) fail('invalid-checkpoint');
    previous = value;
    return value;
  });
  if (result.length === 0) fail('invalid-checkpoint');
  return Object.freeze(result);
}

function captureArtifactKey(projectId: string, operationId: string): string {
  return createHash('sha256')
    .update(`capture\0${projectId}\0${operationId}`, 'utf8')
    .digest('hex');
}

function capturePaths(
  root: string,
  projectId: string,
  operationId: string,
): CapturePaths {
  const project = join(root, Buffer.from(projectId, 'utf8').toString('hex'));
  const profile = join(project, 'capture');
  const operation = join(
    profile,
    captureArtifactKey(projectId, operationId),
  );
  return Object.freeze({
    bundle: join(operation, 'repository.bundle'),
    bundlePart: join(operation, '.repository.bundle.part'),
    marker: join(operation, CAPTURE_MARKER),
    markerPart: join(operation, `.${CAPTURE_MARKER}.part`),
    operationId,
    operation,
    ownerMarker: join(operation, CAPTURE_OWNER_MARKER),
    ownerMarkerPart: join(operation, `.${CAPTURE_OWNER_MARKER}.part`),
    profile,
    projectId,
    project,
    verification: join(operation, 'verification.git'),
    verificationBundle: join(operation, 'published.bundle'),
    verificationBundlePart: join(operation, '.published.bundle.part'),
  });
}

function captureOwnerJson(projectId: string, operationId: string): string {
  return `${JSON.stringify({
    artifactKey: captureArtifactKey(projectId, operationId),
    operationId,
    operationKind: 'capture',
    projectId,
    schemaVersion: 1,
  })}\n`;
}

function captureMarkerJson(capture: CapturedRepositoryCheckpoint): string {
  return `${JSON.stringify({
    artifactKey: capture.artifactKey,
    byteCount: capture.byteCount,
    objectFormat: capture.objectFormat,
    operationId: capture.operationId,
    placementGeneration: capture.placementGeneration,
    projectId: capture.projectId,
    refs: capture.refs,
    schemaVersion: 1,
    sha256: capture.sha256,
  })}\n`;
}

function cleanupFact(
  operationKind: string,
  identity: Readonly<Record<string, number | string>>,
): Readonly<{ cleanupKey: string; markerJson: string }> {
  const markerJson = `${JSON.stringify({
    ...identity,
    operationKind,
    schemaVersion: 1,
  })}\n`;
  return Object.freeze({
    cleanupKey: createHash('sha256')
      .update(`repository-cleanup\0${markerJson}`, 'utf8')
      .digest('hex'),
    markerJson,
  });
}

function captureOperationCleanupFact(
  projectId: string,
  operationId: string,
): Readonly<{ cleanupKey: string; markerJson: string }> {
  return cleanupFact('capture-operation-cleanup', {
    artifactKey: captureArtifactKey(projectId, operationId),
    operationId,
    projectId,
  });
}

function publicationCleanupFact(
  publication: InactiveRepositoryPublication,
  location: 'published' | 'staged',
): Readonly<{ cleanupKey: string; markerJson: string }> {
  return cleanupFact('publication-cleanup', {
    location,
    operationId: publication.operationId,
    placementGeneration: publication.placementGeneration,
    projectId: publication.projectId,
    publicationMarkerSha256: publication.publicationMarkerSha256,
    repositoryStorageKey: publication.repositoryStorageKey,
    storageNodeId: publication.storageNodeId,
  });
}

function exactRepositoryCleanupFact(
  identity: ExactOwnedRepositoryIdentity,
): Readonly<{ cleanupKey: string; markerJson: string }> {
  return cleanupFact('exact-repository-cleanup', {
    placementGeneration: identity.placementGeneration,
    projectId: identity.projectId,
    repositoryStorageKey: identity.repositoryStorageKey,
    storageNodeId: identity.storageNodeId,
  });
}

function publicationPaths(
  operationRoot: string,
  repositoryRoot: string,
  publication: Pick<
    InactiveRepositoryPublication,
    'operationId' | 'projectId' | 'repositoryStorageKey'
  >,
): PublicationPaths {
  const projectHex = Buffer.from(publication.projectId, 'utf8').toString('hex');
  const stagedRepository = repositoryCheckpointStagingRepositoryPath(
    operationRoot,
    publication.projectId,
    publication.operationId,
  );
  const stagingOperation = dirname(stagedRepository);
  const stagingProfile = dirname(stagingOperation);
  const stagingProject = dirname(stagingProfile);
  const canonicalProject = join(repositoryRoot, projectHex);
  const repository = join(canonicalProject, publication.repositoryStorageKey);
  return Object.freeze({
    attemptMarker: join(stagingOperation, '.claudian-cloud-attempt.json'),
    canonicalProject,
    publicationMarker: join(stagedRepository, PUBLICATION_MARKER),
    publicationMarkerPart: join(
      stagedRepository,
      `.${PUBLICATION_MARKER}.part`,
    ),
    repository,
    stagingOperation,
    stagingProfile,
    stagingProject,
    stagedRepository,
    validationMarker: join(stagedRepository, VALIDATION_MARKER),
  });
}

function publicationMarkerJson(
  publication: Omit<InactiveRepositoryPublication, 'publicationMarkerSha256'>,
): string {
  return `${JSON.stringify({
    artifactKey: publication.artifactKey,
    bundleByteCount: publication.bundleByteCount,
    bundleSha256: publication.bundleSha256,
    objectFormat: publication.objectFormat,
    operationId: publication.operationId,
    placementGeneration: publication.placementGeneration,
    projectId: publication.projectId,
    refs: publication.refs,
    repositoryStorageKey: publication.repositoryStorageKey,
    schemaVersion: 1,
    status: publication.status,
    storageNodeId: publication.storageNodeId,
    validationMarkerSha256: publication.validationMarkerSha256,
  })}\n`;
}

function withoutPublicationDigest(
  publication: InactiveRepositoryPublication,
): Omit<InactiveRepositoryPublication, 'publicationMarkerSha256'> {
  return Object.freeze({
    artifactKey: publication.artifactKey,
    bundleByteCount: publication.bundleByteCount,
    bundleSha256: publication.bundleSha256,
    objectFormat: publication.objectFormat,
    operationId: publication.operationId,
    placementGeneration: publication.placementGeneration,
    projectId: publication.projectId,
    refs: publication.refs,
    repositoryStorageKey: publication.repositoryStorageKey,
    status: publication.status,
    storageNodeId: publication.storageNodeId,
    validationMarkerSha256: publication.validationMarkerSha256,
  });
}

function inactivePublication(
  checkpoint: Omit<ValidatedRepositoryCheckpoint, 'bundleInputDisposition'>,
  placementGeneration: number,
  repositoryStorageKey: string,
  storageNodeId: string,
): InactiveRepositoryPublication {
  const refs = canonicalRefs(checkpoint.refs);
  const objectLength = checkpoint.objectFormat === 'sha1' ? 40 : 64;
  if (
    !isCollabProjectId(checkpoint.projectId)
    || !isCollabOpaqueId(checkpoint.operationId)
    || checkpoint.artifactKey !== repositoryCheckpointArtifactKey(
      checkpoint.projectId,
      checkpoint.operationId,
    )
    || !Number.isSafeInteger(checkpoint.bundleByteCount)
    || checkpoint.bundleByteCount <= 0
    || !SHA256_PATTERN.test(checkpoint.bundleSha256)
    || !SHA256_PATTERN.test(checkpoint.markerSha256)
    || refs.some(ref => ref.oid.length !== objectLength)
    || !Number.isSafeInteger(placementGeneration)
    || placementGeneration <= 0
    || !STORAGE_KEY_PATTERN.test(repositoryStorageKey)
  ) {
    fail('invalid-checkpoint');
  }
  const withoutDigest = Object.freeze({
    artifactKey: checkpoint.artifactKey,
    bundleByteCount: checkpoint.bundleByteCount,
    bundleSha256: checkpoint.bundleSha256,
    objectFormat: checkpoint.objectFormat,
    operationId: checkpoint.operationId,
    placementGeneration,
    projectId: checkpoint.projectId,
    refs,
    repositoryStorageKey,
    status: 'inactive' as const,
    storageNodeId,
    validationMarkerSha256: checkpoint.markerSha256,
  });
  return Object.freeze({
    ...withoutDigest,
    publicationMarkerSha256: createHash('sha256')
      .update(publicationMarkerJson(withoutDigest), 'utf8')
      .digest('hex'),
  });
}

function assertPublication(
  publication: InactiveRepositoryPublication,
  storageNodeId: string,
): void {
  const reconstructed = inactivePublication({
    artifactKey: publication.artifactKey,
    bundleByteCount: publication.bundleByteCount,
    bundleSha256: publication.bundleSha256,
    markerSha256: publication.validationMarkerSha256,
    objectFormat: publication.objectFormat,
    operationId: publication.operationId,
    projectId: publication.projectId,
    refs: publication.refs,
  }, publication.placementGeneration, publication.repositoryStorageKey, storageNodeId);
  if (
    (publication as { readonly status: unknown }).status !== 'inactive'
    || publication.storageNodeId !== storageNodeId
    || publication.publicationMarkerSha256
      !== reconstructed.publicationMarkerSha256
  ) {
    fail('invalid-checkpoint');
  }
}

function assertExactOwnedIdentity(
  identity: ExactOwnedRepositoryIdentity,
  storageNodeId: string,
): void {
  if (
    !isCollabProjectId(identity.projectId)
    || !Number.isSafeInteger(identity.placementGeneration)
    || identity.placementGeneration <= 0
    || !STORAGE_KEY_PATTERN.test(identity.repositoryStorageKey)
    || identity.storageNodeId !== storageNodeId
  ) {
    fail('invalid-checkpoint');
  }
}

function assertExactPersonalRef(input: DeleteExactPersonalRefInput): void {
  const memberId = input.personalRef.startsWith(COLLAB_MEMBER_REF_PREFIX)
    ? input.personalRef.slice(COLLAB_MEMBER_REF_PREFIX.length)
    : undefined;
  if (
    !isCollabGitOid(input.expectedOid)
    || memberId === undefined
    || !isCollabMemberId(memberId)
    || collabMemberRef(memberId) !== input.personalRef
  ) {
    fail('invalid-checkpoint');
  }
}

async function assertOwnedRepositoryMarker(
  repositoryPath: string,
  identity: ExactOwnedRepositoryIdentity,
): Promise<void> {
  let markers = 0;
  for (const name of [PUBLICATION_MARKER, BOOTSTRAP_PUBLICATION_MARKER]) {
    const path = join(repositoryPath, name);
    let source: Record<string, unknown>;
    try {
      const entry = await lstat(path);
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || entry.size > 1024 * 1024
      ) {
        fail('invalid-checkpoint');
      }
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('invalid-checkpoint');
      }
      source = value as Record<string, unknown>;
      markers += 1;
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      ) {
        continue;
      }
      fail('invalid-checkpoint');
    }
    const generation = name === PUBLICATION_MARKER
      ? source.placementGeneration
      : source.generation;
    const operationId = name === PUBLICATION_MARKER
      ? source.operationId
      : source.attemptId;
    const expectedKeys = name === PUBLICATION_MARKER
      ? [
        'artifactKey',
        'bundleByteCount',
        'bundleSha256',
        'objectFormat',
        'operationId',
        'placementGeneration',
        'projectId',
        'refs',
        'repositoryStorageKey',
        'schemaVersion',
        'status',
        'storageNodeId',
        'validationMarkerSha256',
      ]
      : [
        'artifactKey',
        'attemptId',
        'generation',
        'markerSha256',
        'objectFormat',
        'projectId',
        'refs',
        'repositoryStorageKey',
        'schemaVersion',
        'storageNodeId',
        'validationMarkerSha256',
      ];
    if (
      Object.keys(source).sort().join('\0') !== expectedKeys.sort().join('\0')
      || source.schemaVersion !== 1
      || source.projectId !== identity.projectId
      || generation !== identity.placementGeneration
      || source.repositoryStorageKey !== identity.repositoryStorageKey
      || source.storageNodeId !== identity.storageNodeId
      || !isCollabOpaqueId(operationId)
    ) {
      fail('invalid-checkpoint');
    }
  }
  if (markers !== 1) fail('invalid-checkpoint');
}

function assertCapture(capture: CapturedRepositoryCheckpoint): void {
  const refs = canonicalRefs(capture.refs);
  const objectLength = capture.objectFormat === 'sha1' ? 40 : 64;
  if (
    !isCollabProjectId(capture.projectId)
    || !isCollabOpaqueId(capture.operationId)
    || capture.artifactKey !== captureArtifactKey(
      capture.projectId,
      capture.operationId,
    )
    || !Number.isSafeInteger(capture.byteCount)
    || capture.byteCount <= 0
    || !Number.isSafeInteger(capture.placementGeneration)
    || capture.placementGeneration <= 0
    || !SHA256_PATTERN.test(capture.sha256)
    || refs.some(ref => ref.oid.length !== objectLength)
  ) {
    fail('invalid-checkpoint');
  }
}

function parseRefOutput(output: Buffer): readonly CollabCheckpointGitRef[] {
  const text = output.toString('utf8').trim();
  if (text.length === 0) return Object.freeze([]);
  const refs = text.split('\n').map(line => {
    const separator = line.indexOf(' ');
    const oid = line.slice(0, separator);
    const name = line.slice(separator + 1);
    if (separator <= 0 || !isCollabGitOid(oid) || name.length === 0) {
      fail('repository-invalid');
    }
    return Object.freeze({ name, oid });
  });
  return Object.freeze(
    refs.sort((left, right) => left.name.localeCompare(right.name, 'en-US')),
  );
}

function parseForEachRefOutput(
  output: Buffer,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const text = output.toString('utf8').trim();
  if (text.length === 0) return result;
  for (const line of text.split('\n')) {
    const separator = line.indexOf('\0');
    const name = line.slice(0, separator);
    const oid = line.slice(separator + 1);
    if (
      separator <= 0
      || line.indexOf('\0', separator + 1) !== -1
      || !isCollabGitOid(oid)
      || result.has(name)
    ) {
      fail('repository-invalid');
    }
    result.set(name, oid);
  }
  return result;
}

function refsEqual(
  left: readonly CollabCheckpointGitRef[],
  right: readonly CollabCheckpointGitRef[],
): boolean {
  return left.length === right.length && left.every((ref, index) => {
    const expected = right[index] as CollabCheckpointGitRef;
    return ref.name === expected.name && ref.oid === expected.oid;
  });
}

function mapPlacement(error: RepositoryPlacementError): RepositoryCheckpointError {
  if (
    error.code === 'inactive-placement'
    || error.code === 'invalid-placement'
    || error.code === 'stale-placement'
    || error.code === 'wrong-storage-node'
  ) {
    return new RepositoryCheckpointError('placement-rejected');
  }
  return new RepositoryCheckpointError('storage-unavailable');
}

function mapAdmission(error: ResourceAdmissionError): RepositoryCheckpointError {
  if (error.code === 'busy') return new RepositoryCheckpointError('busy');
  if (error.code === 'cancelled') return new RepositoryCheckpointError('cancelled');
  return new RepositoryCheckpointError('closed');
}

function mapGit(error: GitProcessError): RepositoryCheckpointError {
  if (error.code === 'cancelled') return new RepositoryCheckpointError('cancelled');
  if (error.code === 'closed') return new RepositoryCheckpointError('closed');
  if (error.code === 'output-limit') return new RepositoryCheckpointError('output-limit');
  if (error.code === 'timeout') return new RepositoryCheckpointError('timeout');
  return new RepositoryCheckpointError('repository-invalid');
}

function mapRepositoryValidation(
  error: GitBundleImportError,
): RepositoryCheckpointError {
  if (error.code === 'busy') return new RepositoryCheckpointError('busy');
  if (error.code === 'cancelled') {
    return new RepositoryCheckpointError('cancelled');
  }
  if (error.code === 'closed') return new RepositoryCheckpointError('closed');
  if (error.code === 'output-limit') {
    return new RepositoryCheckpointError('output-limit');
  }
  if (error.code === 'repository-limit') {
    return new RepositoryCheckpointError('repository-limit');
  }
  if (error.code === 'timeout') return new RepositoryCheckpointError('timeout');
  if (
    error.code === 'artifact-conflict'
    || error.code === 'artifact-invalid'
    || error.code === 'digest-mismatch'
    || error.code === 'repository-invalid'
  ) {
    return new RepositoryCheckpointError('repository-invalid');
  }
  return new RepositoryCheckpointError('storage-unavailable');
}

async function assertPrivateDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path, { bigint: true });
    const uid = getuid?.();
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || uid === undefined
      || entry.uid !== BigInt(uid)
    ) {
      return fail('storage-unavailable');
    }
    await access(path, 7);
  } catch (error: unknown) {
    if (error instanceof RepositoryCheckpointError) throw error;
    fail('storage-unavailable');
  }
}

async function privateDirectoryDevice(path: string): Promise<bigint> {
  await assertPrivateDirectory(path);
  try {
    return (await lstat(path, { bigint: true })).dev;
  } catch {
    fail('storage-unavailable');
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail('invalid-checkpoint');
    }
    return true;
  } catch (error: unknown) {
    if (error instanceof RepositoryCheckpointError) throw error;
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return false;
    }
    fail('storage-unavailable');
  }
}

async function removeEmptyPrivateDirectory(path: string): Promise<boolean> {
  if (!await directoryExists(path)) return false;
  await assertPrivateDirectory(path);
  try {
    await rmdir(path);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (
        error.code === 'ENOENT'
        || error.code === 'ENOTEMPTY'
        || error.code === 'EEXIST'
      )
    ) return false;
    fail('storage-unavailable');
  }
}

async function inspectPublicationLocations(
  paths: PublicationPaths,
): Promise<{
  readonly canonicalProject: boolean;
  readonly published: boolean;
  readonly staged: boolean;
  readonly stagingOperation: boolean;
  readonly stagingProfile: boolean;
  readonly stagingProject: boolean;
}> {
  const stagingProject = await directoryExists(paths.stagingProject);
  const stagingProfile = stagingProject
    ? await directoryExists(paths.stagingProfile)
    : false;
  const stagingOperation = stagingProfile
    ? await directoryExists(paths.stagingOperation)
    : false;
  const staged = stagingOperation
    ? await directoryExists(paths.stagedRepository)
    : false;
  const canonicalProject = await directoryExists(paths.canonicalProject);
  const published = canonicalProject
    ? await directoryExists(paths.repository)
    : false;
  return Object.freeze({
    canonicalProject,
    published,
    staged,
    stagingOperation,
    stagingProfile,
    stagingProject,
  });
}

async function assertFileDigest(path: string, expectedSha256: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || entry.size > 1024 * 1024
    ) {
      fail('invalid-checkpoint');
    }
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== expectedSha256) fail('invalid-checkpoint');
  } catch (error: unknown) {
    if (error instanceof RepositoryCheckpointError) throw error;
    fail('invalid-checkpoint');
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) fail('invalid-checkpoint');
    return true;
  } catch (error: unknown) {
    if (error instanceof RepositoryCheckpointError) throw error;
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) return false;
    fail('storage-unavailable');
  }
}

async function ensureDirectory(path: string): Promise<boolean> {
  let created = false;
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error: unknown) {
    if (!(
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'EEXIST'
    )) {
      return fail('storage-unavailable');
    }
  }
  await assertPrivateDirectory(path);
  return created;
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    fail('storage-unavailable');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeOwnedFile(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) fail('storage-unavailable');
    await rm(path);
  } catch (error: unknown) {
    if (error instanceof RepositoryCheckpointError) throw error;
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return;
    }
    fail('storage-unavailable');
  }
}

async function hashFile(path: string, signal?: AbortSignal): Promise<{
  readonly byteCount: number;
  readonly sha256: string;
}> {
  const digest = createHash('sha256');
  let byteCount = 0;
  try {
    for await (const rawChunk of createReadStream(path, { signal })) {
      const chunk: unknown = rawChunk;
      if (!Buffer.isBuffer(chunk)) fail('storage-unavailable');
      byteCount += chunk.length;
      digest.update(chunk);
    }
  } catch (_error: unknown) {
    if (signal?.aborted === true) {
      fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
    }
    fail('storage-unavailable');
  }
  return Object.freeze({ byteCount, sha256: digest.digest('hex') });
}

async function consumeExactOpenedFile(
  handle: Awaited<ReturnType<typeof open>>,
  expectedByteCount: number,
  signal: AbortSignal,
  onChunk?: (chunk: Buffer, signal: AbortSignal) => Promise<void> | void,
): Promise<string> {
  const digest = createHash('sha256');
  let position = 0;
  while (position < expectedByteCount) {
    assertNotAborted(signal);
    const buffer = Buffer.allocUnsafe(Math.min(
      64 * 1024,
      expectedByteCount - position,
    ));
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      position,
    );
    if (bytesRead <= 0) fail('invalid-checkpoint');
    const chunk = buffer.subarray(0, bytesRead);
    position += bytesRead;
    digest.update(chunk);
    await onChunk?.(chunk, signal);
  }
  assertNotAborted(signal);
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0) {
    fail('invalid-checkpoint');
  }
  return digest.digest('hex');
}

function captureFromMarker(value: unknown): CapturedRepositoryCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid-checkpoint');
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  if (keys.join('\0') !== [
    'artifactKey',
    'byteCount',
    'objectFormat',
    'operationId',
    'placementGeneration',
    'projectId',
    'refs',
    'schemaVersion',
    'sha256',
  ].sort().join('\0') || source.schemaVersion !== 1 || !Array.isArray(source.refs)) {
    fail('invalid-checkpoint');
  }
  const capture = Object.freeze({
    artifactKey: source.artifactKey,
    byteCount: source.byteCount,
    objectFormat: source.objectFormat,
    operationId: source.operationId,
    placementGeneration: source.placementGeneration,
    projectId: source.projectId,
    refs: Object.freeze(source.refs.map(ref => {
      if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
        fail('invalid-checkpoint');
      }
      const candidate = ref as Record<string, unknown>;
      if (
        Object.keys(candidate).sort().join('\0') !== 'name\0oid'
        || typeof candidate.name !== 'string'
        || typeof candidate.oid !== 'string'
      ) {
        fail('invalid-checkpoint');
      }
      return Object.freeze({ name: candidate.name, oid: candidate.oid });
    })),
    sha256: source.sha256,
  }) as CapturedRepositoryCheckpoint;
  assertCapture(capture);
  return capture;
}

export class RepositoryCheckpointAuthority
implements
RepositoryCheckpointCapturePort,
InactiveRepositoryPublicationPort,
ExactPersonalRefPort,
ExactRepositoryRemovalPort {
  readonly #activeCaptures = new Set<string>();
  readonly #captureAncestryTails = new Map<string, Promise<void>>();
  readonly #activeExactRepositoryReservations = new Set<
    ExactRepositoryReservationState
  >();
  readonly #maximumBlobBytes: number;
  readonly #maximumBundleBytes: number;
  readonly #maximumExpandedTreeEntries: number;
  readonly #maximumRepositoryBytes: number;
  readonly #maximumTreeEntries: number;
  readonly #operationRoot: string;
  readonly #operationTimeoutMs: number;
  readonly #pathPolicy: RepositoryPathPolicy;
  readonly #repositoryRoot: string;
  readonly #resourceAdmission: ResourceAdmission;
  readonly #storageNodeId: string;
  readonly #supervisor: GitProcessSupervisor;
  readonly #directorySync: (path: string) => Promise<void>;
  readonly #treeRemoval: (path: string) => Promise<void>;
  readonly #running = new Set<Promise<void>>();
  readonly #controllers = new Set<AbortController>();
  readonly #exactRepositoryReservations = new WeakMap<
    ExactRepositoryOperationReservation,
    ExactRepositoryReservationState
  >();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: RepositoryCheckpointAuthorityOptions) {
    assertOptions(options);
    this.#maximumBlobBytes = options.maximumBlobBytes;
    this.#maximumBundleBytes = options.maximumBundleBytes;
    this.#maximumExpandedTreeEntries = options.maximumExpandedTreeEntries;
    this.#maximumRepositoryBytes = options.maximumRepositoryBytes;
    this.#maximumTreeEntries = options.maximumTreeEntries;
    this.#operationRoot = options.operationRoot;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#repositoryRoot = options.repositoryRoot;
    this.#pathPolicy = new RepositoryPathPolicy({
      placementValidator: options.placementValidator,
      repositoryRoot: options.repositoryRoot,
      storageNodeId: options.storageNodeId,
    });
    this.#resourceAdmission = options.resourceAdmission;
    this.#storageNodeId = options.storageNodeId;
    this.#directorySync = options.syncDirectory ?? syncDirectory;
    this.#treeRemoval = options.removeTree
      ?? (path => rm(path, { recursive: true }));
    this.#supervisor = new GitProcessSupervisor({
      gitExecutable: options.gitExecutable,
      operationTimeoutMs: options.operationTimeoutMs,
      outputMaxBytes: options.outputMaxBytes,
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const state of this.#activeExactRepositoryReservations) {
        state.active = false;
        state.permit.release();
      }
      this.#activeExactRepositoryReservations.clear();
      for (const controller of this.#controllers) controller.abort('closed');
      this.#closePromise = Promise.allSettled([
        this.#supervisor.close(),
        ...this.#running,
      ]).then(() => undefined);
    }
    return this.#closePromise;
  }

  async reserveExactRepositoryOperation(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<ExactRepositoryOperationReservation> {
    if (this.#closed) fail('closed');
    let permit: GitChildPermit;
    try {
      permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'write',
        projectId,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError) throw mapAdmission(error);
      return fail('storage-unavailable');
    }
    const reservation: ExactRepositoryOperationReservation = Object.freeze({
      close: (): Promise<void> => {
        const state = this.#exactRepositoryReservations.get(reservation);
        if (state?.active === true) {
          state.active = false;
          this.#activeExactRepositoryReservations.delete(state);
          state.permit.release();
        }
        return Promise.resolve();
      },
      projectId,
    });
    const state: ExactRepositoryReservationState = {
      active: true,
      inUse: false,
      permit,
      projectId,
    };
    this.#exactRepositoryReservations.set(reservation, state);
    this.#activeExactRepositoryReservations.add(state);
    return reservation;
  }

  #runExactRepositoryOperation<Result>(
    reservation: ExactRepositoryOperationReservation,
    projectId: CollabProjectId,
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const state = this.#exactRepositoryReservations.get(reservation);
    if (
      state?.active !== true
      || state.inUse
      || state.projectId !== projectId
      || reservation.projectId !== projectId
    ) {
      return Promise.reject(new RepositoryCheckpointError('invalid-checkpoint'));
    }
    state.inUse = true;
    return this.#runOperation(externalSignal, operation).finally(() => {
      state.inUse = false;
    });
  }

  #runOperation<Result>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new RepositoryCheckpointError('closed'));
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

  async #syncDirectory(path: string): Promise<void> {
    try {
      await this.#directorySync(path);
    } catch {
      fail('storage-unavailable');
    }
  }

  async #removeDurableTree(input: {
    readonly assertTargetOwned: () => Promise<void>;
    readonly cleanupKey: string;
    readonly markerJson: string;
    readonly parentPath: string;
    readonly signal: AbortSignal;
    readonly targetPath: string;
  }): Promise<'removed' | 'replayed'> {
    try {
      return await removeDurableOwnedTree({
        assertCanContinue: () => assertNotAborted(input.signal),
        assertTargetOwned: input.assertTargetOwned,
        cleanupKey: input.cleanupKey,
        markerJson: input.markerJson,
        parentPath: input.parentPath,
        removeTree: this.#treeRemoval,
        syncDirectory: path => this.#syncDirectory(path),
        targetPath: input.targetPath,
      });
    } catch (error: unknown) {
      if (
        error instanceof DurableTreeRemovalError
        && error.code === 'conflict'
      ) {
        fail('invalid-checkpoint');
      }
      if (error instanceof RepositoryCheckpointError) throw error;
      fail('storage-unavailable');
    }
  }

  capture(
    input: CaptureRepositoryCheckpointInput,
    reservation?: ExactRepositoryOperationReservation,
  ): Promise<CapturedRepositoryCheckpoint> {
    if (!isCollabOpaqueId(input.operationId)) {
      return Promise.reject(new RepositoryCheckpointError('invalid-checkpoint'));
    }
    let refs: readonly CollabCheckpointGitRef[];
    try {
      refs = canonicalRefs(input.refs);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error
        ? error
        : new RepositoryCheckpointError('invalid-checkpoint'));
    }
    const operationKey = captureArtifactKey(
      input.placement.projectId,
      input.operationId,
    );
    if (this.#activeCaptures.has(operationKey)) {
      return Promise.reject(new RepositoryCheckpointError('busy'));
    }
    const result = reservation === undefined
      ? this.#runOperation(
          input.signal,
          signal => this.#capture({ ...input, refs }, signal, true),
        )
      : this.#runExactRepositoryOperation(
          reservation,
          input.placement.projectId,
          input.signal,
          signal => this.#capture({ ...input, refs }, signal, false),
        );
    this.#activeCaptures.add(operationKey);
    void result.then(
      () => this.#activeCaptures.delete(operationKey),
      () => this.#activeCaptures.delete(operationKey),
    );
    return result;
  }

  inventoryRefs(
    input: InventoryRepositoryCheckpointRefsInput,
    reservation?: ExactRepositoryOperationReservation,
  ): Promise<readonly CollabCheckpointGitRef[]> {
    let memberIds: readonly CollabMemberId[];
    let placement: RepositoryPlacementLease;
    try {
      memberIds = canonicalMemberIds(input.memberIds);
      placement = createRepositoryPlacementLease(input.placement);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error
        ? error
        : new RepositoryCheckpointError('invalid-checkpoint'));
    }
    return reservation === undefined
      ? this.#runOperation(
          input.signal,
          signal => this.#inventoryRefs(placement, memberIds, signal, true),
        )
      : this.#runExactRepositoryOperation(
          reservation,
          placement.projectId,
          input.signal,
          signal => this.#inventoryRefs(placement, memberIds, signal, false),
        );
  }

  reserveCaptureOperation(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<ExactRepositoryOperationReservation> {
    return this.reserveExactRepositoryOperation(projectId, signal);
  }

  verifyArtifact(
    reservation: ExactRepositoryOperationReservation,
    input: VerifyRepositoryCheckpointArtifactInput,
  ): Promise<ValidatedRepositoryCheckpoint> {
    let refs: readonly CollabCheckpointGitRef[];
    try {
      refs = canonicalRefs(input.refs);
      if (
        !isCollabOpaqueId(input.operationId)
        || !isCollabProjectId(input.projectId)
        || !Number.isSafeInteger(input.expectedByteCount)
        || input.expectedByteCount <= 0
        || input.expectedByteCount > this.#maximumBundleBytes
        || !SHA256_PATTERN.test(input.expectedSha256)
      ) fail('invalid-checkpoint');
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error
        ? error
        : new RepositoryCheckpointError('invalid-checkpoint'));
    }
    return this.#runExactRepositoryOperation(
      reservation,
      input.projectId,
      input.signal,
      signal => this.#verifyArtifact({ ...input, refs }, signal),
    );
  }

  readCapture(input: ReadRepositoryCheckpointInput): Promise<void> {
    return this.#runOperation(
      input.signal,
      signal => this.#readCapture(input, signal),
    );
  }

  async #readCapture(
    input: ReadRepositoryCheckpointInput,
    signal: AbortSignal,
  ): Promise<void> {
    assertCapture(input.capture);
    if (input.capture.byteCount > this.#maximumBundleBytes) fail('repository-limit');
    const paths = capturePaths(
      this.#operationRoot,
      input.capture.projectId,
      input.capture.operationId,
    );
    await this.#assertStoredCaptureMetadata(paths, input.capture);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        paths.bundle,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const entry = await handle.stat();
      if (!entry.isFile() || entry.size !== input.capture.byteCount) {
        fail('invalid-checkpoint');
      }
      if (
        await consumeExactOpenedFile(
          handle,
          input.capture.byteCount,
          signal,
        ) !== input.capture.sha256
      ) {
        fail('invalid-checkpoint');
      }
      if (
        await consumeExactOpenedFile(
          handle,
          input.capture.byteCount,
          signal,
          input.onChunk,
        ) !== input.capture.sha256
      ) {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
      }
      if (error instanceof RepositoryCheckpointError) throw error;
      fail('storage-unavailable');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  discardCapture(
    capture: CapturedRepositoryCheckpoint,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    return this.#runOperation(
      signal,
      operationSignal => this.#discardCapture(capture, operationSignal),
    );
  }

  discardCaptureOperation(
    input: Readonly<{
      readonly operationId: string;
      readonly projectId: CollabProjectId;
    }>,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    if (
      !isCollabOpaqueId(input.operationId)
      || !isCollabProjectId(input.projectId)
    ) {
      return Promise.reject(new RepositoryCheckpointError('invalid-checkpoint'));
    }
    const identity = Object.freeze({
      operationId: input.operationId,
      projectId: input.projectId,
    });
    return this.#runOperation(
      signal,
      operationSignal => this.#discardCaptureOperation(identity, operationSignal),
    );
  }

  async #discardCaptureOperation(
    input: Readonly<{
      readonly operationId: string;
      readonly projectId: CollabProjectId;
    }>,
    signal: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    assertNotAborted(signal);
    const paths = capturePaths(
      this.#operationRoot,
      input.projectId,
      input.operationId,
    );
    await assertPrivateDirectory(this.#operationRoot);
    if (!await directoryExists(paths.project)) {
      await this.#syncDirectory(this.#operationRoot);
      return 'replayed';
    }
    if (!await directoryExists(paths.profile)) {
      await this.#removeEmptyCaptureAncestry(paths);
      return 'replayed';
    }
    const cleanup = captureOperationCleanupFact(
      input.projectId,
      input.operationId,
    );
    const result = await this.#removeDurableTree({
      assertTargetOwned: async () => {
        await assertPrivateDirectory(paths.project);
        await assertPrivateDirectory(paths.profile);
        await assertPrivateDirectory(paths.operation);
        await this.#assertCaptureOwner(paths);
      },
      cleanupKey: cleanup.cleanupKey,
      markerJson: cleanup.markerJson,
      parentPath: paths.profile,
      signal,
      targetPath: paths.operation,
    });
    await this.#removeEmptyCaptureAncestry(paths);
    return result;
  }

  async #discardCapture(
    capture: CapturedRepositoryCheckpoint,
    signal: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    assertNotAborted(signal);
    assertCapture(capture);
    const paths = capturePaths(
      this.#operationRoot,
      capture.projectId,
      capture.operationId,
    );
    await assertPrivateDirectory(this.#operationRoot);
    if (!await directoryExists(paths.project)) {
      await this.#syncDirectory(this.#operationRoot);
      return 'replayed';
    }
    if (!await directoryExists(paths.profile)) {
      await this.#removeEmptyCaptureAncestry(paths);
      return 'replayed';
    }
    const cleanup = captureOperationCleanupFact(
      capture.projectId,
      capture.operationId,
    );
    const result = await this.#removeDurableTree({
      assertTargetOwned: () => this.#assertStoredCapture(paths, capture, signal),
      cleanupKey: cleanup.cleanupKey,
      markerJson: cleanup.markerJson,
      parentPath: paths.profile,
      signal,
      targetPath: paths.operation,
    });
    await this.#removeEmptyCaptureAncestry(paths);
    return result;
  }

  async #removeEmptyCaptureAncestry(paths: CapturePaths): Promise<void> {
    await this.#withCaptureAncestry(paths.projectId, async () => {
      if (await removeEmptyPrivateDirectory(paths.profile)) {
        await this.#syncDirectory(paths.project);
      }
      if (await removeEmptyPrivateDirectory(paths.project)) {
        await this.#syncDirectory(this.#operationRoot);
      }
    });
  }

  async #ensureCaptureAncestry(
    paths: CapturePaths,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.#withCaptureAncestry(paths.projectId, async () => {
      assertNotAborted(signal);
      await ensureDirectory(paths.project);
      await this.#syncDirectory(this.#operationRoot);
      await ensureDirectory(paths.profile);
      await this.#syncDirectory(paths.project);
      const operationCreated = await ensureDirectory(paths.operation);
      await this.#syncDirectory(paths.profile);
      return operationCreated;
    });
  }

  async #withCaptureAncestry<Result>(
    projectId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#captureAncestryTails.get(projectId)
      ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>(resolve => {
      release = resolve;
    });
    this.#captureAncestryTails.set(projectId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#captureAncestryTails.get(projectId) === tail) {
        this.#captureAncestryTails.delete(projectId);
      }
    }
  }

  publishInactive(
    input: PublishInactiveRepositoryInput,
  ): Promise<InactiveRepositoryPublication> {
    return this.#runOperation(
      input.signal,
      signal => this.#publishInactive(input, signal),
    );
  }

  planInactive(
    input: Omit<PublishInactiveRepositoryInput, 'signal'>,
  ): InactiveRepositoryPublication {
    return inactivePublication(
      input.checkpoint,
      input.placementGeneration,
      input.repositoryStorageKey,
      this.#storageNodeId,
    );
  }

  async #publishInactive(
    input: PublishInactiveRepositoryInput,
    signal: AbortSignal,
  ): Promise<InactiveRepositoryPublication> {
    const publication = this.planInactive(input);
    let permit;
    try {
      permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'write',
        projectId: publication.projectId,
        signal,
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError) throw mapAdmission(error);
      return fail('storage-unavailable');
    }
    try {
      await this.#verifyPublicationRoots();
      const paths = publicationPaths(
        this.#operationRoot,
        this.#repositoryRoot,
        publication,
      );
      const locations = await inspectPublicationLocations(paths);
      if (locations.staged && locations.published) fail('invalid-checkpoint');
      if (!locations.staged && !locations.published) fail('invalid-checkpoint');
      if (locations.published) {
        await this.#assertPublicationMarker(paths.repository, publication);
        await assertFileDigest(
          join(paths.repository, VALIDATION_MARKER),
          publication.validationMarkerSha256,
        );
        await this.#verifyPublicationRepository(
          paths.repository,
          publication,
          signal,
        );
        const stagingParent = locations.stagingOperation
          ? paths.stagingOperation
          : locations.stagingProfile
            ? paths.stagingProfile
            : locations.stagingProject
              ? paths.stagingProject
              : this.#operationRoot;
        await Promise.all([
          this.#syncDirectory(stagingParent),
          this.#syncDirectory(this.#repositoryRoot),
          this.#syncDirectory(paths.canonicalProject),
          this.#syncDirectory(paths.repository),
        ]);
        return publication;
      }

      await this.#assertCheckpointAttemptMarker(paths, publication);
      await assertFileDigest(
        paths.validationMarker,
        publication.validationMarkerSha256,
      );
      await this.#verifyPublicationRepository(
        paths.stagedRepository,
        publication,
        signal,
      );
      assertNotAborted(signal);
      await this.#writePublicationMarker(paths, publication, signal);
      assertNotAborted(signal);
      await ensureDirectory(paths.canonicalProject);
      await this.#syncDirectory(this.#repositoryRoot);
      if (
        await privateDirectoryDevice(paths.canonicalProject)
        !== await privateDirectoryDevice(paths.stagedRepository)
      ) {
        fail('storage-unavailable');
      }
      assertNotAborted(signal);
      try {
        await rename(paths.stagedRepository, paths.repository);
      } catch {
        const recovered = (await inspectPublicationLocations(paths)).published;
        if (!recovered) fail('storage-unavailable');
      }
      await Promise.all([
        this.#syncDirectory(dirname(paths.stagedRepository)),
        this.#syncDirectory(this.#repositoryRoot),
        this.#syncDirectory(paths.canonicalProject),
      ]);
      await this.#assertPublicationMarker(paths.repository, publication);
      await this.#verifyPublicationRepository(
        paths.repository,
        publication,
        signal,
      );
      return publication;
    } finally {
      permit.release();
    }
  }

  deleteExactPersonalRef(
    reservation: ExactRepositoryOperationReservation,
    input: DeleteExactPersonalRefInput,
  ): Promise<'deleted' | 'replayed'> {
    return this.#runExactRepositoryOperation(
      reservation,
      input.placement.projectId,
      input.signal,
      signal => this.#deleteExactPersonalRef(input, signal),
    );
  }

  async #deleteExactPersonalRef(
    input: DeleteExactPersonalRefInput,
    signal: AbortSignal,
  ): Promise<'deleted' | 'replayed'> {
    assertExactPersonalRef(input);
    try {
      const resolved = await this.#pathPolicy.resolveExisting(input.placement)
        .catch((error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        });
      const currentRefs = parseForEachRefOutput(
        await this.#supervisor.runCommand({
        arguments: [
          'for-each-ref',
          '--format=%(refname)%00%(objectname)',
          input.personalRef,
        ],
        captureOutput: true,
        cwd: resolved.repositoryPath,
        failureCode: 'repository-corrupt',
        signal,
      }),
      );
      if (currentRefs.size === 0) {
        await this.#pathPolicy.revalidate(input.placement).catch(
          (error: unknown) => {
            if (error instanceof RepositoryPlacementError) {
              throw mapPlacement(error);
            }
            fail('storage-unavailable');
          },
        );
        await this.#syncPersonalRefState(resolved.repositoryPath);
        await this.#pathPolicy.revalidate(input.placement).catch(
          (error: unknown) => {
            if (error instanceof RepositoryPlacementError) {
              throw mapPlacement(error);
            }
            fail('storage-unavailable');
          },
        );
        return 'replayed';
      }
      if (
        currentRefs.size !== 1
        || currentRefs.get(input.personalRef) !== input.expectedOid
      ) {
        fail('repository-invalid');
      }
      await this.#pathPolicy.revalidate(input.placement).catch(
        (error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        },
      );
      await this.#supervisor.runCommand({
        arguments: [
          '-c',
          'core.fsync=all',
          '-c',
          'core.fsyncMethod=fsync',
          'update-ref',
          '-d',
          input.personalRef,
          input.expectedOid,
        ],
        captureOutput: false,
        cwd: resolved.repositoryPath,
        failureCode: 'repository-corrupt',
        signal,
      });
      await this.#syncPersonalRefState(resolved.repositoryPath);
      await this.#pathPolicy.revalidate(input.placement).catch(
        (error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        },
      );
      return 'deleted';
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (error instanceof GitProcessError) throw mapGit(error);
      return fail('storage-unavailable');
    }
  }

  verifyExactPersonalRef(
    reservation: ExactRepositoryOperationReservation,
    input: DeleteExactPersonalRefInput,
  ): Promise<void> {
    return this.#runExactRepositoryOperation(
      reservation,
      input.placement.projectId,
      input.signal,
      signal => this.#verifyExactPersonalRef(input, signal),
    );
  }

  readExactPersonalRef(
    reservation: ExactRepositoryOperationReservation,
    input: ReadExactPersonalRefInput,
  ): Promise<string> {
    return this.#runExactRepositoryOperation(
      reservation,
      input.placement.projectId,
      input.signal,
      signal => this.#readExactPersonalRef(input, signal),
    );
  }

  async #readExactPersonalRef(
    input: ReadExactPersonalRefInput,
    signal: AbortSignal,
  ): Promise<string> {
    if (!input.personalRef.startsWith(COLLAB_MEMBER_REF_PREFIX)) {
      return fail('invalid-checkpoint');
    }
    try {
      const resolved = await this.#pathPolicy.resolveExisting(input.placement)
        .catch((error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        });
      const currentRefs = parseForEachRefOutput(
        await this.#supervisor.runCommand({
          arguments: [
            'for-each-ref',
            '--format=%(refname)%00%(objectname)',
            input.personalRef,
          ],
          captureOutput: true,
          cwd: resolved.repositoryPath,
          failureCode: 'repository-corrupt',
          signal,
        }),
      );
      const oid = currentRefs.get(input.personalRef);
      if (currentRefs.size !== 1 || oid === undefined || !isCollabGitOid(oid)) {
        return fail('repository-invalid');
      }
      await this.#pathPolicy.revalidate(input.placement).catch(
        (error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        },
      );
      return oid;
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (error instanceof GitProcessError) throw mapGit(error);
      return fail('storage-unavailable');
    }
  }

  async #verifyExactPersonalRef(
    input: DeleteExactPersonalRefInput,
    signal: AbortSignal,
  ): Promise<void> {
    assertExactPersonalRef(input);
    try {
      const resolved = await this.#pathPolicy.resolveExisting(input.placement)
        .catch((error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        });
      const currentRefs = parseForEachRefOutput(
        await this.#supervisor.runCommand({
          arguments: [
            'for-each-ref',
            '--format=%(refname)%00%(objectname)',
            input.personalRef,
          ],
          captureOutput: true,
          cwd: resolved.repositoryPath,
          failureCode: 'repository-corrupt',
          signal,
        }),
      );
      if (
        currentRefs.size !== 1
        || currentRefs.get(input.personalRef) !== input.expectedOid
      ) {
        fail('repository-invalid');
      }
      await this.#pathPolicy.revalidate(input.placement).catch(
        (error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        },
      );
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (error instanceof GitProcessError) throw mapGit(error);
      fail('storage-unavailable');
    }
  }

  async #syncPersonalRefState(repositoryPath: string): Promise<void> {
    const refs = join(repositoryPath, 'refs');
    const heads = join(refs, 'heads');
    const members = join(heads, 'members');
    for (const path of [members, heads, refs, repositoryPath]) {
      if (await directoryExists(path)) await this.#syncDirectory(path);
    }
  }

  removeExactRepository(
    reservation: ExactRepositoryOperationReservation,
    identity: ExactOwnedRepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    return this.#runExactRepositoryOperation(
      reservation,
      identity.projectId,
      signal,
      operationSignal => this.#removeExactRepository(
        identity,
        operationSignal,
      ),
    );
  }

  async #removeExactRepository(
    identity: ExactOwnedRepositoryIdentity,
    signal: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    assertExactOwnedIdentity(identity, this.#storageNodeId);
    await this.#pathPolicy.verifyRoot().catch((error: unknown) => {
      if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
      fail('storage-unavailable');
    });
    const projectPath = join(
      this.#repositoryRoot,
      Buffer.from(identity.projectId, 'utf8').toString('hex'),
    );
    const repositoryPath = join(
      projectPath,
      identity.repositoryStorageKey,
    );
    const projectExists = await directoryExists(projectPath);
    if (!projectExists) {
      await this.#syncDirectory(this.#repositoryRoot);
      return 'replayed';
    }
    const cleanup = exactRepositoryCleanupFact(identity);
    return this.#removeDurableTree({
      assertTargetOwned: async () => {
        await assertPrivateDirectory(repositoryPath);
        await assertOwnedRepositoryMarker(repositoryPath, identity);
      },
      cleanupKey: cleanup.cleanupKey,
      markerJson: cleanup.markerJson,
      parentPath: projectPath,
      signal,
      targetPath: repositoryPath,
    });
  }

  verifyExactRepository(
    reservation: ExactRepositoryOperationReservation,
    placement: RepositoryPlacementLease,
  ): Promise<void> {
    return this.#runExactRepositoryOperation(
      reservation,
      placement.projectId,
      undefined,
      async () => {
        try {
          const resolved = await this.#pathPolicy.resolveExisting(placement);
          await assertOwnedRepositoryMarker(resolved.repositoryPath, {
            placementGeneration: placement.generation,
            projectId: placement.projectId,
            repositoryStorageKey: placement.repositoryStorageKey,
            storageNodeId: placement.storageNodeId,
          });
          await this.#pathPolicy.revalidate(placement);
        } catch (error: unknown) {
          if (error instanceof RepositoryCheckpointError) throw error;
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        }
      },
    );
  }

  removeOwnedRepository(
    publication: InactiveRepositoryPublication,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    return this.#runOperation(
      signal,
      operationSignal => this.#removeOwnedRepository(
        publication,
        operationSignal,
      ),
    );
  }

  async #removeOwnedRepository(
    publication: InactiveRepositoryPublication,
    signal: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    assertPublication(publication, this.#storageNodeId);
    let permit;
    try {
      permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'write',
        projectId: publication.projectId,
        signal,
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError) throw mapAdmission(error);
      fail('storage-unavailable');
    }
    try {
      await this.#verifyPublicationRoots();
      const paths = publicationPaths(
        this.#operationRoot,
        this.#repositoryRoot,
        publication,
      );
      const locations = await inspectPublicationLocations(paths);
      const { published, staged } = locations;
      if (staged && published) fail('invalid-checkpoint');
      const removeAt = async (
        location: 'published' | 'staged',
      ): Promise<'removed' | 'replayed'> => {
        const ownedRepository = location === 'staged'
          ? paths.stagedRepository
          : paths.repository;
        const cleanup = publicationCleanupFact(publication, location);
        return this.#removeDurableTree({
          assertTargetOwned: async () => {
            if (
              location === 'published'
              || await regularFileExists(paths.publicationMarker)
            ) {
              await this.#assertPublicationMarker(
                ownedRepository,
                publication,
              );
              return;
            }
            await this.#assertCheckpointAttemptMarker(paths, publication);
            await assertFileDigest(
              paths.validationMarker,
              publication.validationMarkerSha256,
            );
          },
          cleanupKey: cleanup.cleanupKey,
          markerJson: cleanup.markerJson,
          parentPath: dirname(ownedRepository),
          signal,
          targetPath: ownedRepository,
        });
      };
      if (staged) return await removeAt('staged');
      if (published) return await removeAt('published');
      let removed = false;
      if (locations.stagingOperation) {
        removed = await removeAt('staged') === 'removed' || removed;
      }
      if (locations.canonicalProject) {
        removed = await removeAt('published') === 'removed' || removed;
      }
      if (removed) return 'removed';
      const stagingParent = locations.stagingOperation
        ? paths.stagingOperation
        : locations.stagingProfile
          ? paths.stagingProfile
          : locations.stagingProject
            ? paths.stagingProject
            : this.#operationRoot;
      await Promise.all([
        this.#syncDirectory(stagingParent),
        this.#syncDirectory(locations.canonicalProject
          ? paths.canonicalProject
          : this.#repositoryRoot),
      ]);
      return 'replayed';
    } finally {
      permit.release();
    }
  }

  async #capture(
    input: CaptureRepositoryCheckpointInput,
    signal: AbortSignal,
    acquirePermit: boolean,
  ): Promise<CapturedRepositoryCheckpoint> {
    let permit: GitChildPermit | undefined;
    let finalizedCapture: CapturedRepositoryCheckpoint | undefined;
    let finalizedPaths: CapturePaths | undefined;
    try {
      if (acquirePermit) permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'read',
        projectId: input.placement.projectId,
        signal,
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError) throw mapAdmission(error);
      return fail('storage-unavailable');
    }
    try {
      const resolved = await this.#pathPolicy.resolveExisting(input.placement)
        .catch((error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        });
      await this.#supervisor.verifyVersion(signal);
      await this.#supervisor.verifyBareRepository(resolved.repositoryPath, signal);
      const objectFormatOutput = await this.#supervisor.runCommand({
        arguments: ['rev-parse', '--show-object-format'],
        captureOutput: true,
        cwd: resolved.repositoryPath,
        failureCode: 'repository-corrupt',
        signal,
      });
      const objectFormat = objectFormatOutput.toString('utf8').trim();
      if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
        fail('repository-invalid');
      }
      const expectedLength = objectFormat === 'sha1' ? 40 : 64;
      if (input.refs.some(ref => ref.oid.length !== expectedLength)) {
        fail('invalid-checkpoint');
      }
      const currentRefs = parseForEachRefOutput(await this.#supervisor.runCommand({
        arguments: [
          'for-each-ref',
          '--format=%(refname)%00%(objectname)',
          'refs/heads',
        ],
        captureOutput: true,
        cwd: resolved.repositoryPath,
        failureCode: 'repository-corrupt',
        signal,
      }));
      if (input.refs.some(ref => currentRefs.get(ref.name) !== ref.oid)) {
        fail('repository-invalid');
      }
      await assertPrivateDirectory(this.#operationRoot);
      const paths = capturePaths(
        this.#operationRoot,
        input.placement.projectId,
        input.operationId,
      );
      const operationCreated = await this.#ensureCaptureAncestry(paths, signal);
      await this.#ensureCaptureOwner(paths, signal, operationCreated);
      const replay = await this.#readReplay(paths, input, objectFormat, signal);
      if (replay !== undefined) {
        await this.#pathPolicy.revalidate(input.placement).catch((error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          fail('storage-unavailable');
        });
        return replay;
      }
      finalizedPaths = paths;
      await this.#writeBundle(paths, resolved.repositoryPath, input.refs, signal);
      const facts = await hashFile(paths.bundle, signal);
      if (facts.byteCount <= 0 || facts.byteCount > this.#maximumBundleBytes) {
        fail('repository-limit');
      }
      const capture = Object.freeze({
        artifactKey: captureArtifactKey(input.placement.projectId, input.operationId),
        byteCount: facts.byteCount,
        objectFormat,
        operationId: input.operationId,
        placementGeneration: input.placement.generation,
        projectId: input.placement.projectId,
        refs: input.refs,
        sha256: facts.sha256,
      });
      finalizedCapture = capture;
      await this.#verifyBundle(paths, capture, signal);
      await this.#pathPolicy.revalidate(input.placement).catch((error: unknown) => {
        if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
        fail('storage-unavailable');
      });
      assertNotAborted(signal);
      await this.#writeMarker(paths, capture, signal);
      return capture;
    } catch (error: unknown) {
      if (finalizedPaths !== undefined) {
        await this.#settleFailedCapture(finalizedPaths, finalizedCapture);
      }
      if (error instanceof RepositoryCheckpointError) throw error;
      if (error instanceof GitProcessError) throw mapGit(error);
      return fail('storage-unavailable');
    } finally {
      permit?.release();
    }
  }

  async #inventoryRefs(
    placement: RepositoryPlacementLease,
    memberIds: readonly CollabMemberId[],
    signal: AbortSignal,
    acquirePermit: boolean,
  ): Promise<readonly CollabCheckpointGitRef[]> {
    let permit: GitChildPermit | undefined;
    try {
      if (acquirePermit) permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'read',
        projectId: placement.projectId,
        signal,
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError) throw mapAdmission(error);
      return fail('storage-unavailable');
    }
    try {
      const resolved = await this.#pathPolicy.resolveExisting(placement)
        .catch((error: unknown) => {
          if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
          return fail('storage-unavailable');
        });
      await this.#supervisor.verifyVersion(signal);
      await this.#supervisor.verifyBareRepository(resolved.repositoryPath, signal);
      const refs = parseForEachRefOutput(await this.#supervisor.runCommand({
        arguments: [
          'for-each-ref',
          '--format=%(refname)%00%(objectname)',
          'refs/heads',
        ],
        captureOutput: true,
        cwd: resolved.repositoryPath,
        failureCode: 'repository-corrupt',
        signal,
      }));
      const names = [COLLAB_MAIN_REF, ...memberIds.map(collabMemberRef)];
      const inventory = names.map(name => {
        const oid = refs.get(name);
        if (oid === undefined) return fail('repository-invalid');
        return Object.freeze({ name, oid });
      });
      const canonical = canonicalRefs(inventory);
      await this.#pathPolicy.revalidate(placement).catch((error: unknown) => {
        if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
        return fail('storage-unavailable');
      });
      return canonical;
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (error instanceof GitProcessError) throw mapGit(error);
      return fail('storage-unavailable');
    } finally {
      permit?.release();
    }
  }

  async #verifyArtifact(
    input: VerifyRepositoryCheckpointArtifactInput,
    signal: AbortSignal,
  ): Promise<ValidatedRepositoryCheckpoint> {
    const paths = capturePaths(
      this.#operationRoot,
      input.projectId,
      input.operationId,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await assertPrivateDirectory(this.#operationRoot);
      const operationCreated = await this.#ensureCaptureAncestry(paths, signal);
      await this.#ensureCaptureOwner(paths, signal, operationCreated);
      await removeOwnedFile(paths.verificationBundlePart);
      await removeOwnedFile(paths.verificationBundle);
      handle = await open(paths.verificationBundlePart, 'wx', FILE_MODE);
      const digest = createHash('sha256');
      let byteCount = 0;
      for await (const value of input.body) {
        assertNotAborted(signal);
        const chunk = Buffer.from(value);
        byteCount += chunk.length;
        if (byteCount > input.expectedByteCount) fail('invalid-checkpoint');
        digest.update(chunk);
        await handle.writeFile(chunk);
      }
      if (
        byteCount !== input.expectedByteCount
        || digest.digest('hex') !== input.expectedSha256
      ) fail('invalid-checkpoint');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(paths.verificationBundlePart, FILE_MODE);
      await rename(paths.verificationBundlePart, paths.verificationBundle);
      await this.#syncDirectory(paths.operation);
      await this.#verifyBundleFile(
        paths,
        paths.verificationBundle,
        input.objectFormat,
        input.refs,
        signal,
      );
      const markerJson = `${JSON.stringify({
        artifactKey: repositoryCheckpointArtifactKey(
          input.projectId,
          input.operationId,
        ),
        bundleByteCount: input.expectedByteCount,
        bundleSha256: input.expectedSha256,
        objectFormat: input.objectFormat,
        operationId: input.operationId,
        projectId: input.projectId,
        refs: input.refs,
        schemaVersion: 1,
      })}\n`;
      return Object.freeze({
        artifactKey: repositoryCheckpointArtifactKey(
          input.projectId,
          input.operationId,
        ),
        bundleByteCount: input.expectedByteCount,
        bundleInputDisposition: 'consumed' as const,
        bundleSha256: input.expectedSha256,
        markerSha256: createHash('sha256').update(markerJson).digest('hex'),
        objectFormat: input.objectFormat,
        operationId: input.operationId,
        projectId: input.projectId,
        refs: input.refs,
      });
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      if (signal.aborted) {
        return fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
      }
      if (error instanceof RepositoryCheckpointError) throw error;
      if (error instanceof GitBundleImportError) {
        return fail(error.code === 'repository-limit'
          ? 'repository-limit'
          : 'repository-invalid');
      }
      if (error instanceof GitProcessError) throw mapGit(error);
      return fail('storage-unavailable');
    } finally {
      await handle?.close().catch(() => undefined);
      await removeOwnedFile(paths.verificationBundlePart).catch(() => undefined);
      await removeOwnedFile(paths.verificationBundle).catch(() => undefined);
      await rm(paths.verification, { force: true, recursive: true })
        .catch(() => undefined);
      await this.#syncDirectory(paths.operation).catch(() => undefined);
    }
  }

  async #readReplay(
    paths: CapturePaths,
    input: CaptureRepositoryCheckpointInput,
    objectFormat: CollabCheckpointObjectFormat,
    signal: AbortSignal,
  ): Promise<CapturedRepositoryCheckpoint | undefined> {
    let markerExists = false;
    let bundleExists = false;
    try {
      const marker = await lstat(paths.marker);
      if (!marker.isFile() || marker.isSymbolicLink()) fail('invalid-checkpoint');
      markerExists = true;
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (!(
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      )) fail('storage-unavailable');
    }
    try {
      const bundle = await lstat(paths.bundle);
      if (!bundle.isFile() || bundle.isSymbolicLink()) fail('invalid-checkpoint');
      bundleExists = true;
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (!(
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      )) fail('storage-unavailable');
    }
    await removeOwnedFile(paths.bundlePart);
    await removeOwnedFile(paths.markerPart);
    if (!markerExists && !bundleExists) return undefined;
    if (!markerExists || !bundleExists) {
      if (bundleExists) await removeOwnedFile(paths.bundle);
      if (markerExists) await removeOwnedFile(paths.marker);
      return undefined;
    }
    let replay: CapturedRepositoryCheckpoint;
    try {
      replay = captureFromMarker(JSON.parse(await readFile(paths.marker, 'utf8')));
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      fail('invalid-checkpoint');
    }
    if (
      replay.projectId !== input.placement.projectId
      || replay.operationId !== input.operationId
      || replay.placementGeneration !== input.placement.generation
      || replay.objectFormat !== objectFormat
      || !refsEqual(replay.refs, input.refs)
    ) {
      fail('invalid-checkpoint');
    }
    await this.#assertStoredCapture(paths, replay, signal);
    await this.#verifyBundle(paths, replay, signal);
    await this.#syncDirectory(paths.operation);
    return replay;
  }

  async #writeBundle(
    paths: CapturePaths,
    repositoryPath: string,
    refs: readonly CollabCheckpointGitRef[],
    signal: AbortSignal,
  ): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const digest = createHash('sha256');
    let byteCount = 0;
    try {
      handle = await open(paths.bundlePart, 'wx', FILE_MODE);
      await this.#supervisor.runStreamingCommand({
        arguments: ['bundle', 'create', '-', ...refs.map(ref => ref.name)],
        cwd: repositoryPath,
        failureCode: 'repository-corrupt',
        onStdoutChunk: async chunk => {
          byteCount += chunk.length;
          if (byteCount > this.#maximumBundleBytes) fail('repository-limit');
          digest.update(chunk);
          await handle?.writeFile(chunk);
        },
        signal,
        stdoutMaxBytes: this.#maximumBundleBytes,
      });
      if (byteCount <= 0 || digest.digest('hex').length !== 64) {
        fail('repository-invalid');
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(paths.bundlePart, FILE_MODE);
      await rename(paths.bundlePart, paths.bundle);
      await this.#syncDirectory(paths.operation);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await rm(paths.bundlePart, { force: true }).catch(() => undefined);
      if (error instanceof RepositoryCheckpointError) throw error;
      if (error instanceof GitProcessError) throw mapGit(error);
      fail('storage-unavailable');
    }
  }

  async #ensureCaptureOwner(
    paths: CapturePaths,
    signal: AbortSignal,
    allowCreate: boolean,
  ): Promise<void> {
    const json = captureOwnerJson(paths.projectId, paths.operationId);
    try {
      const entry = await lstat(paths.ownerMarker);
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || entry.size !== Buffer.byteLength(json, 'utf8')
        || await readFile(paths.ownerMarker, 'utf8') !== json
      ) {
        fail('invalid-checkpoint');
      }
      await removeOwnedFile(paths.ownerMarkerPart);
      return;
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (!(
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      )) {
        fail('storage-unavailable');
      }
    }
    if (!allowCreate) fail('invalid-checkpoint');
    await removeOwnedFile(paths.ownerMarkerPart);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      assertNotAborted(signal);
      handle = await open(paths.ownerMarkerPart, 'wx', FILE_MODE);
      await handle.writeFile(json, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      assertNotAborted(signal);
      await rename(paths.ownerMarkerPart, paths.ownerMarker);
      await this.#syncDirectory(paths.operation);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await rm(paths.ownerMarkerPart, { force: true }).catch(() => undefined);
      if (error instanceof RepositoryCheckpointError) throw error;
      fail('storage-unavailable');
    }
  }

  async #assertCaptureOwner(paths: CapturePaths): Promise<void> {
    const json = captureOwnerJson(paths.projectId, paths.operationId);
    try {
      const entry = await lstat(paths.ownerMarker);
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || entry.size !== Buffer.byteLength(json, 'utf8')
        || await readFile(paths.ownerMarker, 'utf8') !== json
      ) {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      fail('invalid-checkpoint');
    }
  }

  async #verifyBundle(
    paths: CapturePaths,
    capture: CapturedRepositoryCheckpoint,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#verifyBundleFile(
      paths,
      paths.bundle,
      capture.objectFormat,
      capture.refs,
      signal,
    );
  }

  async #verifyBundleFile(
    paths: CapturePaths,
    bundlePath: string,
    objectFormat: CollabCheckpointObjectFormat,
    expectedRefs: readonly CollabCheckpointGitRef[],
    signal: AbortSignal,
  ): Promise<void> {
    const relativeBundle = `../${basename(bundlePath)}`;
    try {
      await rm(paths.verification, { force: true, recursive: true });
      await mkdir(paths.verification, { mode: DIRECTORY_MODE });
      await this.#supervisor.runCommand({
        arguments: [
          'init',
          '--quiet',
          '--bare',
          `--object-format=${objectFormat}`,
          '.',
        ],
        captureOutput: false,
        cwd: paths.verification,
        failureCode: 'repository-corrupt',
        signal,
      });
      await this.#supervisor.runCommand({
        arguments: ['bundle', 'verify', relativeBundle],
        captureOutput: false,
        cwd: paths.verification,
        failureCode: 'repository-corrupt',
        signal,
      });
      const refs = parseRefOutput(await this.#supervisor.runCommand({
        arguments: ['bundle', 'list-heads', relativeBundle],
        captureOutput: true,
        cwd: paths.verification,
        failureCode: 'repository-corrupt',
        signal,
      }));
      if (!refsEqual(refs, expectedRefs)) fail('repository-invalid');
      await this.#supervisor.runCommand({
        arguments: [
          'fetch',
          '--quiet',
          relativeBundle,
          ...expectedRefs.map(ref => `${ref.name}:${ref.name}`),
        ],
        captureOutput: false,
        cwd: paths.verification,
        failureCode: 'repository-corrupt',
        signal,
      });
      await verifyGitRepositoryContent({
        closed: () => this.#closed,
        deadline: Date.now() + this.#operationTimeoutMs,
        maximumBlobBytes: this.#maximumBlobBytes,
        maximumExpandedTreeEntries: this.#maximumExpandedTreeEntries,
        maximumRepositoryBytes: this.#maximumRepositoryBytes,
        maximumTreeEntries: this.#maximumTreeEntries,
        objectFormat,
        refs: expectedRefs,
        repositoryPath: paths.verification,
        signal,
        supervisor: this.#supervisor,
      });
      await rm(paths.verification, { force: true, recursive: true });
    } catch (error: unknown) {
      await rm(paths.verification, { force: true, recursive: true })
        .catch(() => undefined);
      if (error instanceof RepositoryCheckpointError) throw error;
      if (error instanceof GitBundleImportError) {
        throw mapRepositoryValidation(error);
      }
      if (error instanceof GitProcessError) throw mapGit(error);
      fail('storage-unavailable');
    }
  }

  async #writeMarker(
    paths: CapturePaths,
    capture: CapturedRepositoryCheckpoint,
    signal: AbortSignal,
  ): Promise<void> {
    const json = captureMarkerJson(capture);
    let handle;
    try {
      assertNotAborted(signal);
      handle = await open(paths.markerPart, 'wx', FILE_MODE);
      await handle.writeFile(json, 'utf8');
      await handle.sync();
      assertNotAborted(signal);
      await handle.close();
      handle = undefined;
      assertNotAborted(signal);
      await rename(paths.markerPart, paths.marker);
      await this.#syncDirectory(paths.operation);
    } catch {
      await handle?.close().catch(() => undefined);
      await rm(paths.markerPart, { force: true }).catch(() => undefined);
      fail('storage-unavailable');
    }
  }

  async #settleFailedCapture(
    paths: CapturePaths,
    capture: CapturedRepositoryCheckpoint | undefined,
  ): Promise<void> {
    await this.#assertCaptureOwner(paths);
    if (capture !== undefined) {
      try {
        await this.#assertStoredCapture(paths, capture);
        return;
      } catch {
        // A markerless capture is incomplete and safe to remove below.
      }
    }
    try {
      const marker = await lstat(paths.marker);
      if (marker.isFile() && !marker.isSymbolicLink()) {
        fail('storage-unavailable');
      }
      fail('storage-unavailable');
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (!(
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      )) {
        fail('storage-unavailable');
      }
    }
    try {
      await Promise.all([
        removeOwnedFile(paths.bundle),
        removeOwnedFile(paths.bundlePart),
        removeOwnedFile(paths.markerPart),
        removeOwnedFile(paths.ownerMarkerPart),
        rm(paths.verification, { force: true, recursive: true }),
      ]);
      await this.#syncDirectory(paths.operation);
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      fail('storage-unavailable');
    }
  }

  async #verifyPublicationRoots(): Promise<void> {
    await this.#pathPolicy.verifyRoot().catch((error: unknown) => {
      if (error instanceof RepositoryPlacementError) throw mapPlacement(error);
      fail('storage-unavailable');
    });
    if (
      await privateDirectoryDevice(this.#operationRoot)
      !== await privateDirectoryDevice(this.#repositoryRoot)
    ) {
      fail('storage-unavailable');
    }
  }

  async #verifyPublicationRepository(
    repositoryPath: string,
    publication: InactiveRepositoryPublication,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#supervisor.verifyBareRepository(repositoryPath, signal);
      await verifyGitRepositoryContent({
        closed: () => this.#closed,
        deadline: Date.now() + this.#operationTimeoutMs,
        maximumBlobBytes: this.#maximumBlobBytes,
        maximumExpandedTreeEntries: this.#maximumExpandedTreeEntries,
        maximumRepositoryBytes: this.#maximumRepositoryBytes,
        maximumTreeEntries: this.#maximumTreeEntries,
        objectFormat: publication.objectFormat,
        refs: publication.refs,
        repositoryPath,
        signal,
        supervisor: this.#supervisor,
      });
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (error instanceof GitBundleImportError) {
        throw mapRepositoryValidation(error);
      }
      if (error instanceof GitProcessError) throw mapGit(error);
      fail('storage-unavailable');
    }
  }

  async #assertPublicationMarker(
    repositoryPath: string,
    publication: InactiveRepositoryPublication,
  ): Promise<void> {
    const markerPath = join(repositoryPath, PUBLICATION_MARKER);
    await assertFileDigest(markerPath, publication.publicationMarkerSha256);
    try {
      if (
        await readFile(markerPath, 'utf8')
        !== publicationMarkerJson(withoutPublicationDigest(publication))
      ) {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      fail('invalid-checkpoint');
    }
  }

  async #assertCheckpointAttemptMarker(
    paths: PublicationPaths,
    publication: InactiveRepositoryPublication,
  ): Promise<void> {
    const expected = repositoryCheckpointAttemptMarkerJson(
      publication.projectId,
      publication.operationId,
    );
    try {
      const entry = await lstat(paths.attemptMarker);
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || entry.size !== Buffer.byteLength(expected, 'utf8')
        || await readFile(paths.attemptMarker, 'utf8') !== expected
      ) {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      fail('invalid-checkpoint');
    }
  }

  async #writePublicationMarker(
    paths: PublicationPaths,
    publication: InactiveRepositoryPublication,
    signal: AbortSignal,
  ): Promise<void> {
    const json = publicationMarkerJson(withoutPublicationDigest(publication));
    try {
      const entry = await lstat(paths.publicationMarker);
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || await readFile(paths.publicationMarker, 'utf8') !== json
      ) {
        fail('invalid-checkpoint');
      }
      await removeOwnedFile(paths.publicationMarkerPart);
      await this.#syncDirectory(paths.stagedRepository);
      return;
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      if (!(
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      )) {
        fail('storage-unavailable');
      }
    }
    await removeOwnedFile(paths.publicationMarkerPart);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      assertNotAborted(signal);
      handle = await open(paths.publicationMarkerPart, 'wx', FILE_MODE);
      await handle.writeFile(json, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      assertNotAborted(signal);
      await rename(paths.publicationMarkerPart, paths.publicationMarker);
      await this.#syncDirectory(paths.stagedRepository);
    } catch {
      await handle?.close().catch(() => undefined);
      await rm(paths.publicationMarkerPart, { force: true })
        .catch(() => undefined);
      fail('storage-unavailable');
    }
  }

  async #assertStoredCapture(
    paths: CapturePaths,
    capture: CapturedRepositoryCheckpoint,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertStoredCaptureMetadata(paths, capture);
    const facts = await hashFile(paths.bundle, signal);
    if (
      facts.byteCount !== capture.byteCount
      || facts.sha256 !== capture.sha256
    ) {
      fail('invalid-checkpoint');
    }
  }

  async #assertStoredCaptureMetadata(
    paths: CapturePaths,
    capture: CapturedRepositoryCheckpoint,
  ): Promise<void> {
    try {
      await assertPrivateDirectory(this.#operationRoot);
      await assertPrivateDirectory(paths.project);
      await assertPrivateDirectory(paths.profile);
      await assertPrivateDirectory(paths.operation);
      const [
        markerEntry,
        bundleEntry,
        ownerEntry,
        marker,
        ownerMarker,
      ] = await Promise.all([
        lstat(paths.marker),
        lstat(paths.bundle),
        lstat(paths.ownerMarker),
        readFile(paths.marker, 'utf8'),
        readFile(paths.ownerMarker, 'utf8'),
      ]);
      if (
        !markerEntry.isFile()
        || markerEntry.isSymbolicLink()
        || !bundleEntry.isFile()
        || bundleEntry.isSymbolicLink()
        || !ownerEntry.isFile()
        || ownerEntry.isSymbolicLink()
        || marker !== captureMarkerJson(capture)
        || ownerMarker !== captureOwnerJson(capture.projectId, capture.operationId)
      ) {
        fail('invalid-checkpoint');
      }
    } catch (error: unknown) {
      if (error instanceof RepositoryCheckpointError) throw error;
      fail('storage-unavailable');
    }
  }
}
