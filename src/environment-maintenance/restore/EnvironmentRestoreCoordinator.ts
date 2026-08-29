import {
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  collabMemberRef,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabCheckpointGitRef,
  type CollabCheckpointObjectFormat,
  type CollabIsoTimestamp,
  type CollabProjectId,
} from '@claudian-collab/protocol';

export const ENVIRONMENT_RESTORE_PHASES = Object.freeze([
  'validated',
  'database-created',
  'coordination-imported',
  'repositories-staged',
  'pair-prepared',
  'repositories-published',
  'authority-published',
  'verified',
  'completed',
] as const);

export const ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES = 2 * 1024 * 1024;

export type EnvironmentRestorePhase = typeof ENVIRONMENT_RESTORE_PHASES[number];

export type EnvironmentRestoreCoordinatorErrorCode =
  | 'cancelled'
  | 'closed'
  | 'continuity-unavailable'
  | 'dependency-failed'
  | 'invalid-backup'
  | 'non-empty'
  | 'pair-mismatch'
  | 'recovery-required'
  | 'state-conflict';

export class EnvironmentRestoreCoordinatorError extends Error {
  readonly code: EnvironmentRestoreCoordinatorErrorCode;
  readonly retryable: boolean;

  constructor(code: EnvironmentRestoreCoordinatorErrorCode) {
    super(`environment-restore.error.${code}`);
    this.name = 'EnvironmentRestoreCoordinatorError';
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

export interface EnvironmentRestoreProject {
  readonly authorityGeneration: number;
  readonly backupId: string;
  readonly checkpointSha256: string;
  readonly expiresAt: CollabIsoTimestamp;
  readonly placementGeneration: number;
  readonly projectId: CollabProjectId;
}

export interface EnvironmentRestoreTerminalProject {
  readonly artifactByteCount: number;
  readonly artifactSha256: string;
  readonly projectId: CollabProjectId;
}

export interface EnvironmentRestoreCatalog {
  readonly authorityId: string;
  readonly authorityVolumeIdentity: string;
  readonly catalogId: string;
  readonly catalogSha256: string;
  readonly coordinationSchemaVersion: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly maximumServerBuild: string;
  readonly minimumServerBuild: string;
  readonly projects: readonly EnvironmentRestoreProject[];
  readonly repositoryFormatVersion: number;
  readonly restoreEpoch: number;
  readonly terminalProjects: readonly EnvironmentRestoreTerminalProject[];
}

export interface EnvironmentRestoreRepositoryPublication {
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

export interface EnvironmentRestoreJournal {
  readonly authorityId: string;
  readonly authorityVolumeId: string;
  readonly authorityVolumeIdentity: string;
  readonly catalogId: string;
  readonly catalogSha256: string;
  readonly coordinationSchemaVersion: number;
  readonly cleanupRequestedAt?: CollabIsoTimestamp;
  readonly createdAt: CollabIsoTimestamp;
  readonly databaseIdentity?: string;
  readonly maximumServerBuild: string;
  readonly minimumServerBuild: string;
  readonly operationId: string;
  readonly phase: EnvironmentRestorePhase;
  readonly projects: readonly EnvironmentRestoreProject[];
  readonly repositories?: readonly EnvironmentRestoreRepositoryPublication[];
  readonly repositoryFormatVersion: number;
  readonly restoreEpoch: number;
  readonly schemaVersion: 1;
  readonly terminalProjects: readonly EnvironmentRestoreTerminalProject[];
  readonly updatedAt: CollabIsoTimestamp;
}

export type EnvironmentRestorePairInspection =
  | 'absent'
  | 'ambiguous'
  | Readonly<{ readonly authorityVolumeId: string }>;

export interface EnvironmentRestoreStateInspection {
  readonly journal: EnvironmentRestoreJournal | undefined;
  readonly pair: EnvironmentRestorePairInspection;
}

export interface EnvironmentRestoreStatePort {
  runExclusive<Result>(
    operation: () => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result>;
  inspect(signal?: AbortSignal): Promise<EnvironmentRestoreStateInspection>;
  create(journal: EnvironmentRestoreJournal): Promise<EnvironmentRestoreJournal>;
  advance(input: Readonly<{
    readonly expectedPhase: EnvironmentRestorePhase;
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal>;
  preparePair(input: Readonly<{
    readonly authorityVolumeId: string;
    readonly expectedPhase: 'repositories-staged';
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal>;
  requestCleanup(input: Readonly<{
    readonly expectedPhase: EnvironmentRestorePhase;
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal>;
  recoverPublishedAuthority(input: Readonly<{
    readonly expectedPhase: 'repositories-published';
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal>;
  remove(input: Readonly<{
    readonly expectedCatalogSha256: string;
    readonly operationId: string;
    readonly phase: EnvironmentRestorePhase;
  }>): Promise<'removed'>;
}

export interface EnvironmentRestoreBackupPort {
  validate(input: Readonly<{
    readonly catalogId: string;
    readonly expectedCatalogSha256: string;
    readonly signal: AbortSignal;
  }>): Promise<EnvironmentRestoreCatalog>;
}

export interface EnvironmentRestoreContinuityPort {
  verifyBeforeCreation(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly signal: AbortSignal;
  }>): Promise<void>;
  verifyRestored(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
}

export interface EnvironmentRestoreCoordinationPort {
  assertEmpty(signal: AbortSignal): Promise<void>;
  createDatabase(input: Readonly<{
    readonly authorityId: string;
    readonly authorityVolumeId: string;
    readonly authorityVolumeIdentity: string;
    readonly coordinationSchemaVersion: number;
    readonly operationId: string;
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<Readonly<{ readonly authorityVolumeId: string }>>;
  importCoordination(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly operationId: string;
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
  publishAuthority(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
  /**
   * Atomically excludes publishAuthority before removing unpublished restore
   * state, or reports that authority publication already committed.
   */
  classifyOrRemoveRestoreOwnedDatabase(input: Readonly<{
    readonly authorityVolumeId: string;
    readonly operationId: string;
    readonly signal: AbortSignal;
  }>): Promise<'authority-published' | 'removed' | 'replayed'>;
  verifyDatabaseIdentity(
    expectedAuthorityVolumeId: string,
    signal: AbortSignal,
  ): Promise<void>;
  verifyRestored(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly restoreEpoch: number;
    readonly signal: AbortSignal;
  }>): Promise<void>;
}

export interface EnvironmentRestoreRepositoryPort {
  assertEmpty(signal: AbortSignal): Promise<void>;
  stage(input: Readonly<{
    readonly operationId: string;
    readonly projects: readonly EnvironmentRestoreProject[];
    readonly signal: AbortSignal;
  }>): Promise<readonly EnvironmentRestoreRepositoryPublication[]>;
  publish(input: Readonly<{
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly signal: AbortSignal;
  }>): Promise<void>;
  removeRestoreOwned(input: Readonly<{
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly signal: AbortSignal;
  }>): Promise<'removed' | 'replayed'>;
  removeRestoreStaging(input: Readonly<{
    readonly operationId: string;
    readonly projects: readonly EnvironmentRestoreProject[];
    readonly signal: AbortSignal;
  }>): Promise<'removed' | 'replayed'>;
  verifyRestored(input: Readonly<{
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly signal: AbortSignal;
  }>): Promise<void>;
}

export interface EnvironmentRestoreCoordinatorOptions {
  readonly backup: EnvironmentRestoreBackupPort;
  readonly clock?: () => Date;
  readonly continuity: EnvironmentRestoreContinuityPort;
  readonly coordination: EnvironmentRestoreCoordinationPort;
  readonly repositories: EnvironmentRestoreRepositoryPort;
  readonly state: EnvironmentRestoreStatePort;
}

export interface RestoreEnvironmentInput {
  readonly authorityVolumeId: string;
  readonly authorityVolumeIdentity: string;
  readonly catalogId: string;
  readonly expectedCatalogSha256: string;
  readonly operationId: string;
  readonly signal?: AbortSignal;
}

export interface EnvironmentRestoreResult {
  readonly catalogId: string;
  readonly catalogSha256: string;
  readonly completedAt: CollabIsoTimestamp;
  readonly operationId: string;
  readonly projectCount: number;
  readonly restoreEpoch: number;
  readonly state: 'completed';
}

export interface RecoverEnvironmentRestoreInput {
  readonly signal?: AbortSignal;
}

export interface CancelEnvironmentRestoreInput {
  readonly expectedCatalogSha256: string;
  readonly operationId: string;
  readonly signal?: AbortSignal;
}

interface RestoreInputSnapshot
  extends Omit<RestoreEnvironmentInput, 'signal'> {
  readonly signal: AbortSignal | undefined;
}

const PHASE_INDEX = new Map<EnvironmentRestorePhase, number>(
  ENVIRONMENT_RESTORE_PHASES.map((phase, index) => [phase, index]),
);
const DATABASE_CREATED_INDEX = ENVIRONMENT_RESTORE_PHASES.indexOf('database-created');
const COORDINATION_IMPORTED_INDEX = ENVIRONMENT_RESTORE_PHASES.indexOf(
  'coordination-imported',
);
const REPOSITORIES_STAGED_INDEX = ENVIRONMENT_RESTORE_PHASES.indexOf('repositories-staged');
const PAIR_PREPARED_INDEX = ENVIRONMENT_RESTORE_PHASES.indexOf('pair-prepared');
const AUTHORITY_PUBLISHED_INDEX = ENVIRONMENT_RESTORE_PHASES.indexOf('authority-published');
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VOLUME_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CATALOG_KEYS = Object.freeze([
  'authorityId',
  'authorityVolumeIdentity',
  'catalogId',
  'catalogSha256',
  'coordinationSchemaVersion',
  'createdAt',
  'maximumServerBuild',
  'minimumServerBuild',
  'projects',
  'repositoryFormatVersion',
  'restoreEpoch',
  'terminalProjects',
]);
const PROJECT_KEYS = Object.freeze([
  'authorityGeneration',
  'backupId',
  'checkpointSha256',
  'expiresAt',
  'placementGeneration',
  'projectId',
]);
const TERMINAL_PROJECT_KEYS = Object.freeze([
  'artifactByteCount',
  'artifactSha256',
  'projectId',
]);
const REPOSITORY_KEYS = Object.freeze([
  'artifactKey',
  'bundleByteCount',
  'bundleSha256',
  'objectFormat',
  'operationId',
  'placementGeneration',
  'projectId',
  'publicationMarkerSha256',
  'refs',
  'repositoryStorageKey',
  'status',
  'storageNodeId',
  'validationMarkerSha256',
]);
const REF_KEYS = Object.freeze(['name', 'oid']);

function fail(code: EnvironmentRestoreCoordinatorErrorCode): never {
  throw new EnvironmentRestoreCoordinatorError(code);
}

function timestamp(value: unknown): value is CollabIsoTimestamp {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function clockTimestamp(clock: () => Date): CollabIsoTimestamp {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    return fail('dependency-failed');
  }
  return value.toISOString();
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
  }
}

function snapshotInput(input: RestoreEnvironmentInput): RestoreInputSnapshot {
  if (
    !VOLUME_ID_PATTERN.test(input.authorityVolumeId)
    || !IDENTITY_PATTERN.test(input.authorityVolumeIdentity)
    || !isCollabOpaqueId(input.catalogId)
    || !SHA256_PATTERN.test(input.expectedCatalogSha256)
    || !isCollabOpaqueId(input.operationId)
  ) fail('state-conflict');
  return Object.freeze({
    authorityVolumeId: input.authorityVolumeId,
    authorityVolumeIdentity: input.authorityVolumeIdentity,
    catalogId: input.catalogId,
    expectedCatalogSha256: input.expectedCatalogSha256,
    operationId: input.operationId,
    signal: input.signal,
  });
}

function validateCatalog(
  value: unknown,
  expected: Readonly<{
    readonly catalogId: string;
    readonly catalogSha256: string;
  }>,
): EnvironmentRestoreCatalog {
  if (
    !plainRecord(value)
    || !exactKeys(value, CATALOG_KEYS)
    || typeof value.authorityId !== 'string'
    || typeof value.authorityVolumeIdentity !== 'string'
    || typeof value.catalogId !== 'string'
    || typeof value.catalogSha256 !== 'string'
    || typeof value.coordinationSchemaVersion !== 'number'
    || typeof value.createdAt !== 'string'
    || typeof value.maximumServerBuild !== 'string'
    || typeof value.minimumServerBuild !== 'string'
    || !Array.isArray(value.projects)
    || typeof value.repositoryFormatVersion !== 'number'
    || typeof value.restoreEpoch !== 'number'
    || !Array.isArray(value.terminalProjects)
  ) fail('invalid-backup');
  const projects = Object.freeze(value.projects.map(project => {
    if (
      !plainRecord(project)
      || !exactKeys(project, PROJECT_KEYS)
      || typeof project.authorityGeneration !== 'number'
      || typeof project.backupId !== 'string'
      || typeof project.checkpointSha256 !== 'string'
      || !timestamp(project.expiresAt)
      || typeof project.placementGeneration !== 'number'
      || typeof project.projectId !== 'string'
    ) fail('invalid-backup');
    return Object.freeze({
      authorityGeneration: project.authorityGeneration,
      backupId: project.backupId,
      checkpointSha256: project.checkpointSha256,
      expiresAt: project.expiresAt,
      placementGeneration: project.placementGeneration,
      projectId: project.projectId,
    });
  }));
  const terminalProjects = Object.freeze(value.terminalProjects.map(item => {
    if (
      !plainRecord(item)
      || !exactKeys(item, TERMINAL_PROJECT_KEYS)
      || typeof item.artifactByteCount !== 'number'
      || typeof item.artifactSha256 !== 'string'
      || typeof item.projectId !== 'string'
    ) fail('invalid-backup');
    return Object.freeze({
      artifactByteCount: item.artifactByteCount,
      artifactSha256: item.artifactSha256,
      projectId: item.projectId,
    });
  }));
  const catalog = Object.freeze({
    authorityId: value.authorityId,
    authorityVolumeIdentity: value.authorityVolumeIdentity,
    catalogId: value.catalogId,
    catalogSha256: value.catalogSha256,
    coordinationSchemaVersion: value.coordinationSchemaVersion,
    createdAt: value.createdAt,
    maximumServerBuild: value.maximumServerBuild,
    minimumServerBuild: value.minimumServerBuild,
    projects,
    repositoryFormatVersion: value.repositoryFormatVersion,
    restoreEpoch: value.restoreEpoch,
    terminalProjects,
  });
  if (
    !IDENTITY_PATTERN.test(catalog.authorityId)
    || !IDENTITY_PATTERN.test(catalog.authorityVolumeIdentity)
    || catalog.catalogId !== expected.catalogId
    || catalog.catalogSha256 !== expected.catalogSha256
    || !SHA256_PATTERN.test(catalog.catalogSha256)
    || !Number.isSafeInteger(catalog.coordinationSchemaVersion)
    || catalog.coordinationSchemaVersion <= 0
    || !timestamp(catalog.createdAt)
    || catalog.minimumServerBuild.length === 0
    || Buffer.byteLength(catalog.minimumServerBuild, 'utf8') > 128
    || catalog.maximumServerBuild.length === 0
    || Buffer.byteLength(catalog.maximumServerBuild, 'utf8') > 128
    || !Number.isSafeInteger(catalog.repositoryFormatVersion)
    || catalog.repositoryFormatVersion <= 0
    || !Number.isSafeInteger(catalog.restoreEpoch)
    || catalog.restoreEpoch <= 0
    || catalog.restoreEpoch >= Number.MAX_SAFE_INTEGER
    || catalog.projects.length + catalog.terminalProjects.length === 0
  ) fail('invalid-backup');
  const projectIds = new Set<string>();
  const backupIds = new Set<string>();
  let priorProjectId: string | undefined;
  for (const project of catalog.projects) {
    if (
      !isCollabProjectId(project.projectId)
      || !isCollabOpaqueId(project.backupId)
      || !SHA256_PATTERN.test(project.checkpointSha256)
      || !Number.isSafeInteger(project.authorityGeneration)
      || project.authorityGeneration <= 0
      || !Number.isSafeInteger(project.placementGeneration)
      || project.placementGeneration <= 0
      || project.placementGeneration >= Number.MAX_SAFE_INTEGER
      || projectIds.has(project.projectId)
      || backupIds.has(project.backupId)
      || (priorProjectId !== undefined && priorProjectId >= project.projectId)
    ) fail('invalid-backup');
    projectIds.add(project.projectId);
    backupIds.add(project.backupId);
    priorProjectId = project.projectId;
  }
  priorProjectId = undefined;
  for (const terminal of catalog.terminalProjects) {
    if (
      !isCollabProjectId(terminal.projectId)
      || !Number.isSafeInteger(terminal.artifactByteCount)
      || terminal.artifactByteCount <= 0
      || terminal.artifactByteCount
        > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes
      || !SHA256_PATTERN.test(terminal.artifactSha256)
      || projectIds.has(terminal.projectId)
      || (priorProjectId !== undefined && priorProjectId >= terminal.projectId)
    ) fail('invalid-backup');
    projectIds.add(terminal.projectId);
    priorProjectId = terminal.projectId;
  }
  return Object.freeze({
    ...catalog,
    projects,
    terminalProjects,
  });
}

function validateRepositories(
  projects: readonly EnvironmentRestoreProject[],
  values: readonly unknown[],
  operationId?: string,
): readonly EnvironmentRestoreRepositoryPublication[] {
  if (values.length !== projects.length) fail('dependency-failed');
  const byProject = new Map(projects.map(project => [project.projectId, project]));
  const seen = new Set<string>();
  let priorProjectId: string | undefined;
  const repositories = values.map(value => {
    if (
      !plainRecord(value)
      || !exactKeys(value, REPOSITORY_KEYS)
      || typeof value.artifactKey !== 'string'
      || typeof value.bundleByteCount !== 'number'
      || typeof value.bundleSha256 !== 'string'
      || (value.objectFormat !== 'sha1' && value.objectFormat !== 'sha256')
      || typeof value.operationId !== 'string'
      || typeof value.placementGeneration !== 'number'
      || typeof value.projectId !== 'string'
      || typeof value.publicationMarkerSha256 !== 'string'
      || !Array.isArray(value.refs)
      || typeof value.repositoryStorageKey !== 'string'
      || value.status !== 'inactive'
      || typeof value.storageNodeId !== 'string'
      || typeof value.validationMarkerSha256 !== 'string'
    ) fail('dependency-failed');
    let priorRefName = '';
    let objectLength: number | undefined;
    let memberRefCount = 0;
    const refs = value.refs.map(ref => {
      if (
        !plainRecord(ref)
        || !exactKeys(ref, REF_KEYS)
        || typeof ref.name !== 'string'
        || typeof ref.oid !== 'string'
      ) fail('dependency-failed');
      const memberId = ref.name.startsWith(COLLAB_MEMBER_REF_PREFIX)
        ? ref.name.slice(COLLAB_MEMBER_REF_PREFIX.length)
        : undefined;
      if (
        !isCollabGitOid(ref.oid)
        || (objectLength !== undefined && ref.oid.length !== objectLength)
        || ref.name.localeCompare(priorRefName, 'en-US') <= 0
        || (
          ref.name !== COLLAB_MAIN_REF
          && (
            memberId === undefined
            || !isCollabMemberId(memberId)
            || collabMemberRef(memberId) !== ref.name
          )
        )
      ) fail('dependency-failed');
      if (memberId !== undefined) memberRefCount += 1;
      objectLength = ref.oid.length;
      priorRefName = ref.name;
      return Object.freeze({ name: ref.name, oid: ref.oid });
    });
    if (
      refs.length < 2
      || refs.length > COLLAB_CLOUD_BINDING_LIMITS.maxCloudProjectMembers + 1
      || refs[0]?.name !== COLLAB_MAIN_REF
      || memberRefCount !== refs.length - 1
    ) fail('dependency-failed');
    return Object.freeze({
      artifactKey: value.artifactKey,
      bundleByteCount: value.bundleByteCount,
      bundleSha256: value.bundleSha256,
      objectFormat: value.objectFormat,
      operationId: value.operationId,
      placementGeneration: value.placementGeneration,
      projectId: value.projectId,
      publicationMarkerSha256: value.publicationMarkerSha256,
      refs: Object.freeze(refs),
      repositoryStorageKey: value.repositoryStorageKey,
      status: value.status,
      storageNodeId: value.storageNodeId,
      validationMarkerSha256: value.validationMarkerSha256,
    });
  });
  for (const repository of repositories) {
    const project = byProject.get(repository.projectId);
    if (
      project === undefined
      || seen.has(repository.projectId)
      || (priorProjectId !== undefined && priorProjectId >= repository.projectId)
      || !IDENTITY_PATTERN.test(repository.artifactKey)
      || !Number.isSafeInteger(repository.bundleByteCount)
      || repository.bundleByteCount <= 0
      || !SHA256_PATTERN.test(repository.bundleSha256)
      || !isCollabOpaqueId(repository.operationId)
      || (operationId !== undefined && repository.operationId !== operationId)
      || repository.placementGeneration !== project.placementGeneration + 1
      || !SHA256_PATTERN.test(repository.publicationMarkerSha256)
      || !IDENTITY_PATTERN.test(repository.repositoryStorageKey)
      || !IDENTITY_PATTERN.test(repository.storageNodeId)
      || !SHA256_PATTERN.test(repository.validationMarkerSha256)
    ) fail('dependency-failed');
    seen.add(repository.projectId);
    priorProjectId = repository.projectId;
  }
  return Object.freeze(repositories);
}

function assertCatalogJournalCapacity(
  catalog: EnvironmentRestoreCatalog,
  input: RestoreInputSnapshot,
): void {
  const maximumMemberRefs = Object.freeze(Array.from(
    { length: COLLAB_CLOUD_BINDING_LIMITS.maxCloudProjectMembers },
    (_, index) => Object.freeze({
      name: `${COLLAB_MEMBER_REF_PREFIX}${index.toString().padStart(2, '0')}${'m'.repeat(62)}`,
      oid: 'a'.repeat(64),
    }),
  ));
  const repositories = Object.freeze(catalog.projects.map(project =>
    Object.freeze({
      artifactKey: 'a'.repeat(128),
      bundleByteCount: Number.MAX_SAFE_INTEGER,
      bundleSha256: 'b'.repeat(64),
      objectFormat: 'sha256' as const,
      operationId: input.operationId,
      placementGeneration: project.placementGeneration + 1,
      projectId: project.projectId,
      publicationMarkerSha256: 'c'.repeat(64),
      refs: Object.freeze([
        Object.freeze({ name: COLLAB_MAIN_REF, oid: 'a'.repeat(64) }),
        ...maximumMemberRefs,
      ]),
      repositoryStorageKey: 'r'.repeat(128),
      status: 'inactive' as const,
      storageNodeId: 's'.repeat(128),
      validationMarkerSha256: 'd'.repeat(64),
    })));
  const probe: EnvironmentRestoreJournal = Object.freeze({
    authorityId: catalog.authorityId,
    authorityVolumeId: input.authorityVolumeId,
    authorityVolumeIdentity: input.authorityVolumeIdentity,
    catalogId: catalog.catalogId,
    catalogSha256: catalog.catalogSha256,
    coordinationSchemaVersion: catalog.coordinationSchemaVersion,
    cleanupRequestedAt: catalog.createdAt,
    createdAt: catalog.createdAt,
    databaseIdentity: input.authorityVolumeId,
    maximumServerBuild: catalog.maximumServerBuild,
    minimumServerBuild: catalog.minimumServerBuild,
    operationId: input.operationId,
    phase: 'repositories-published',
    projects: catalog.projects,
    repositories,
    repositoryFormatVersion: catalog.repositoryFormatVersion,
    restoreEpoch: catalog.restoreEpoch + 1,
    schemaVersion: 1,
    terminalProjects: catalog.terminalProjects,
    updatedAt: catalog.createdAt,
  });
  if (
    Buffer.byteLength(encodeEnvironmentRestoreJournal(probe), 'utf8')
      > ENVIRONMENT_RESTORE_JOURNAL_MAX_UTF8_BYTES
  ) fail('invalid-backup');
}

function sameProjects(
  left: readonly EnvironmentRestoreProject[],
  right: readonly EnvironmentRestoreProject[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameTerminalProjects(
  left: readonly EnvironmentRestoreTerminalProject[],
  right: readonly EnvironmentRestoreTerminalProject[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactJournal(
  journal: EnvironmentRestoreJournal,
  input: RestoreInputSnapshot,
  catalog: EnvironmentRestoreCatalog,
): void {
  if (
    journal.authorityId !== catalog.authorityId
    || journal.authorityVolumeId !== input.authorityVolumeId
    || journal.authorityVolumeIdentity !== input.authorityVolumeIdentity
    || journal.catalogId !== input.catalogId
    || journal.catalogSha256 !== input.expectedCatalogSha256
    || journal.coordinationSchemaVersion !== catalog.coordinationSchemaVersion
    || journal.maximumServerBuild !== catalog.maximumServerBuild
    || journal.minimumServerBuild !== catalog.minimumServerBuild
    || journal.operationId !== input.operationId
    || journal.repositoryFormatVersion !== catalog.repositoryFormatVersion
    || journal.restoreEpoch !== catalog.restoreEpoch + 1
    || !sameProjects(journal.projects, catalog.projects)
    || !sameTerminalProjects(journal.terminalProjects, catalog.terminalProjects)
    || !timestamp(journal.createdAt)
    || !timestamp(journal.updatedAt)
  ) fail('state-conflict');
}

function plainRecord(value: unknown): value is Record<string, unknown> {
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
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export function decodeEnvironmentRestoreJournal(
  value: unknown,
): EnvironmentRestoreJournal {
  if (!plainRecord(value)) fail('state-conflict');
  const phase = value.phase;
  if (
    typeof phase !== 'string'
    || !PHASE_INDEX.has(phase as EnvironmentRestorePhase)
  ) fail('state-conflict');
  const typedPhase = phase as EnvironmentRestorePhase;
  const phaseIndex = PHASE_INDEX.get(typedPhase) ?? fail('state-conflict');
  const expectsDatabase = phaseIndex >= DATABASE_CREATED_INDEX;
  const expectsRepositories = phaseIndex >= REPOSITORIES_STAGED_INDEX;
  const expectedKeys = [
    'authorityId',
    'authorityVolumeId',
    'authorityVolumeIdentity',
    'catalogId',
    'catalogSha256',
    'coordinationSchemaVersion',
    ...(value.cleanupRequestedAt === undefined ? [] : ['cleanupRequestedAt']),
    'createdAt',
    ...(expectsDatabase ? ['databaseIdentity'] : []),
    'maximumServerBuild',
    'minimumServerBuild',
    'operationId',
    'phase',
    'projects',
    ...(expectsRepositories ? ['repositories'] : []),
    'repositoryFormatVersion',
    'restoreEpoch',
    'schemaVersion',
    'terminalProjects',
    'updatedAt',
  ];
  if (!exactKeys(value, expectedKeys)) fail('state-conflict');
  if (!Array.isArray(value.projects) || !Array.isArray(value.terminalProjects)) {
    fail('state-conflict');
  }
  let catalog: EnvironmentRestoreCatalog;
  try {
    catalog = validateCatalog({
      authorityId: value.authorityId,
      authorityVolumeIdentity: value.authorityVolumeIdentity,
      catalogId: value.catalogId,
      catalogSha256: value.catalogSha256,
      coordinationSchemaVersion: value.coordinationSchemaVersion,
      createdAt: value.createdAt,
      maximumServerBuild: value.maximumServerBuild,
      minimumServerBuild: value.minimumServerBuild,
      projects: value.projects,
      repositoryFormatVersion: value.repositoryFormatVersion,
      restoreEpoch: typeof value.restoreEpoch === 'number'
        ? value.restoreEpoch - 1
        : Number.NaN,
      terminalProjects: value.terminalProjects,
    }, {
      catalogId: typeof value.catalogId === 'string' ? value.catalogId : '',
      catalogSha256: typeof value.catalogSha256 === 'string'
        ? value.catalogSha256
        : '',
    });
  } catch {
    fail('state-conflict');
  }
  if (
    value.schemaVersion !== 1
    || typeof value.authorityVolumeId !== 'string'
    || !VOLUME_ID_PATTERN.test(value.authorityVolumeId)
    || typeof value.authorityVolumeIdentity !== 'string'
    || !IDENTITY_PATTERN.test(value.authorityVolumeIdentity)
    || typeof value.operationId !== 'string'
    || !isCollabOpaqueId(value.operationId)
    || !timestamp(value.createdAt)
    || !timestamp(value.updatedAt)
    || new Date(value.updatedAt).valueOf() < new Date(value.createdAt).valueOf()
    || (value.cleanupRequestedAt !== undefined
      && (
        !timestamp(value.cleanupRequestedAt)
        || phaseIndex >= AUTHORITY_PUBLISHED_INDEX
      ))
    || (expectsDatabase
      && value.databaseIdentity !== value.authorityVolumeId)
  ) fail('state-conflict');
  let repositories: readonly EnvironmentRestoreRepositoryPublication[] | undefined;
  if (expectsRepositories) {
    if (!Array.isArray(value.repositories)) fail('state-conflict');
    try {
      repositories = validateRepositories(
        catalog.projects,
        value.repositories,
        typeof value.operationId === 'string' ? value.operationId : undefined,
      );
    } catch {
      fail('state-conflict');
    }
  }
  return Object.freeze({
    authorityId: catalog.authorityId,
    authorityVolumeId: value.authorityVolumeId,
    authorityVolumeIdentity: catalog.authorityVolumeIdentity,
    catalogId: catalog.catalogId,
    catalogSha256: catalog.catalogSha256,
    coordinationSchemaVersion: catalog.coordinationSchemaVersion,
    ...(value.cleanupRequestedAt === undefined
      ? {}
      : { cleanupRequestedAt: value.cleanupRequestedAt }),
    createdAt: value.createdAt,
    ...(expectsDatabase
      ? { databaseIdentity: value.databaseIdentity as string }
      : {}),
    maximumServerBuild: catalog.maximumServerBuild,
    minimumServerBuild: catalog.minimumServerBuild,
    operationId: value.operationId,
    phase: typedPhase,
    projects: catalog.projects,
    ...(repositories === undefined ? {} : { repositories }),
    repositoryFormatVersion: catalog.repositoryFormatVersion,
    restoreEpoch: catalog.restoreEpoch + 1,
    schemaVersion: 1,
    terminalProjects: catalog.terminalProjects,
    updatedAt: value.updatedAt,
  });
}

export function encodeEnvironmentRestoreJournal(
  journal: EnvironmentRestoreJournal,
): string {
  const canonical = decodeEnvironmentRestoreJournal(journal);
  return `${JSON.stringify({
    authorityId: canonical.authorityId,
    authorityVolumeId: canonical.authorityVolumeId,
    authorityVolumeIdentity: canonical.authorityVolumeIdentity,
    catalogId: canonical.catalogId,
    catalogSha256: canonical.catalogSha256,
    coordinationSchemaVersion: canonical.coordinationSchemaVersion,
    ...(canonical.cleanupRequestedAt === undefined
      ? {}
      : { cleanupRequestedAt: canonical.cleanupRequestedAt }),
    createdAt: canonical.createdAt,
    ...(canonical.databaseIdentity === undefined
      ? {}
      : { databaseIdentity: canonical.databaseIdentity }),
    maximumServerBuild: canonical.maximumServerBuild,
    minimumServerBuild: canonical.minimumServerBuild,
    operationId: canonical.operationId,
    phase: canonical.phase,
    projects: canonical.projects,
    ...(canonical.repositories === undefined
      ? {}
      : { repositories: canonical.repositories }),
    repositoryFormatVersion: canonical.repositoryFormatVersion,
    restoreEpoch: canonical.restoreEpoch,
    schemaVersion: canonical.schemaVersion,
    terminalProjects: canonical.terminalProjects,
    updatedAt: canonical.updatedAt,
  })}\n`;
}

function nextJournal(
  journal: EnvironmentRestoreJournal,
  phase: EnvironmentRestorePhase,
  updatedAt: CollabIsoTimestamp,
  patch: Partial<Pick<
    EnvironmentRestoreJournal,
    'databaseIdentity' | 'repositories'
  >> = {},
): EnvironmentRestoreJournal {
  const currentIndex = PHASE_INDEX.get(journal.phase);
  const nextIndex = PHASE_INDEX.get(phase);
  if (
    currentIndex === undefined
    || nextIndex === undefined
    || nextIndex !== currentIndex + 1
  ) fail('state-conflict');
  return Object.freeze({
    ...journal,
    ...patch,
    phase,
    updatedAt,
  });
}

function assertOptions(options: EnvironmentRestoreCoordinatorOptions): void {
  if (
    typeof options.backup.validate !== 'function'
    || typeof options.continuity.verifyBeforeCreation !== 'function'
    || typeof options.continuity.verifyRestored !== 'function'
    || typeof options.coordination.assertEmpty !== 'function'
    || typeof options.coordination.createDatabase !== 'function'
    || typeof options.coordination.importCoordination !== 'function'
    || typeof options.coordination.publishAuthority !== 'function'
    || typeof options.coordination.classifyOrRemoveRestoreOwnedDatabase
      !== 'function'
    || typeof options.coordination.verifyDatabaseIdentity !== 'function'
    || typeof options.coordination.verifyRestored !== 'function'
    || typeof options.repositories.assertEmpty !== 'function'
    || typeof options.repositories.stage !== 'function'
    || typeof options.repositories.publish !== 'function'
    || typeof options.repositories.removeRestoreOwned !== 'function'
    || typeof options.repositories.removeRestoreStaging !== 'function'
    || typeof options.repositories.verifyRestored !== 'function'
    || typeof options.state.runExclusive !== 'function'
    || typeof options.state.advance !== 'function'
    || typeof options.state.create !== 'function'
    || typeof options.state.inspect !== 'function'
    || typeof options.state.preparePair !== 'function'
    || typeof options.state.recoverPublishedAuthority !== 'function'
    || typeof options.state.requestCleanup !== 'function'
    || typeof options.state.remove !== 'function'
  ) throw new TypeError('environment-restore-coordinator.options-invalid');
}

export class EnvironmentRestoreCoordinator {
  readonly #backup: EnvironmentRestoreBackupPort;
  readonly #clock: () => Date;
  readonly #continuity: EnvironmentRestoreContinuityPort;
  readonly #coordination: EnvironmentRestoreCoordinationPort;
  readonly #repositories: EnvironmentRestoreRepositoryPort;
  readonly #state: EnvironmentRestoreStatePort;

  constructor(options: EnvironmentRestoreCoordinatorOptions) {
    assertOptions(options);
    this.#backup = options.backup;
    this.#clock = options.clock ?? (() => new Date());
    this.#continuity = options.continuity;
    this.#coordination = options.coordination;
    this.#repositories = options.repositories;
    this.#state = options.state;
  }

  recover(
    input: RecoverEnvironmentRestoreInput = {},
  ): Promise<EnvironmentRestoreResult | undefined> {
    return this.#state.runExclusive(() => this.#recover(input), input.signal);
  }

  async #recover(
    input: RecoverEnvironmentRestoreInput,
  ): Promise<EnvironmentRestoreResult | undefined> {
    let inspected: EnvironmentRestoreStateInspection;
    try {
      inspected = await this.#state.inspect(input.signal);
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      if (input.signal?.aborted === true) {
        fail(input.signal.reason === 'closed' ? 'closed' : 'cancelled');
      }
      fail('dependency-failed');
    }
    const journal = inspected.journal;
    if (journal === undefined) {
      if (inspected.pair !== 'absent') fail('recovery-required');
      return undefined;
    }
    const exact = decodeEnvironmentRestoreJournal(journal);
    if (exact.cleanupRequestedAt !== undefined) {
      const cleanup = await this.#cleanup(exact, inspected.pair, input.signal);
      if (cleanup === 'cleaned') return undefined;
      return this.#restore(snapshotInput({
        authorityVolumeId: cleanup.authorityVolumeId,
        authorityVolumeIdentity: cleanup.authorityVolumeIdentity,
        catalogId: cleanup.catalogId,
        expectedCatalogSha256: cleanup.catalogSha256,
        operationId: cleanup.operationId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }));
    }
    if (exact.phase === 'verified' || exact.phase === 'completed') {
      const signal = input.signal ?? new AbortController().signal;
      assertNotAborted(signal);
      if (
        typeof inspected.pair !== 'object'
        || inspected.pair.authorityVolumeId !== exact.authorityVolumeId
      ) fail(inspected.pair === 'ambiguous' ? 'recovery-required' : 'pair-mismatch');
      await this.#coordination.verifyDatabaseIdentity(
        exact.authorityVolumeId,
        signal,
      );
      const completed = exact.phase === 'verified'
        ? await this.#advance(exact, 'completed')
        : exact;
      return Object.freeze({
        catalogId: completed.catalogId,
        catalogSha256: completed.catalogSha256,
        completedAt: completed.updatedAt,
        operationId: completed.operationId,
        projectCount: completed.projects.length + completed.terminalProjects.length,
        restoreEpoch: completed.restoreEpoch,
        state: 'completed' as const,
      });
    }
    return this.#restore(snapshotInput({
      authorityVolumeId: exact.authorityVolumeId,
      authorityVolumeIdentity: exact.authorityVolumeIdentity,
      catalogId: exact.catalogId,
      expectedCatalogSha256: exact.catalogSha256,
      operationId: exact.operationId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }));
  }

  cancel(input: CancelEnvironmentRestoreInput): Promise<'cancelled'> {
    return this.#state.runExclusive(() => this.#cancel(input), input.signal);
  }

  async #cancel(input: CancelEnvironmentRestoreInput): Promise<'cancelled'> {
    if (
      !SHA256_PATTERN.test(input.expectedCatalogSha256)
      || !isCollabOpaqueId(input.operationId)
    ) fail('state-conflict');
    const controller = new AbortController();
    const signal = input.signal === undefined
      ? controller.signal
      : AbortSignal.any([input.signal, controller.signal]);
    try {
      assertNotAborted(signal);
      const inspected = await this.#state.inspect(signal);
      let journal = inspected.journal;
      if (
        journal === undefined
        || journal.catalogSha256 !== input.expectedCatalogSha256
        || journal.operationId !== input.operationId
      ) fail('state-conflict');
      journal = decodeEnvironmentRestoreJournal(journal);
      const phaseIndex = PHASE_INDEX.get(journal.phase);
      if (phaseIndex === undefined) fail('state-conflict');
      if (phaseIndex >= AUTHORITY_PUBLISHED_INDEX) {
        fail('recovery-required');
      }
      if (journal.cleanupRequestedAt === undefined) {
        const next = Object.freeze({
          ...journal,
          cleanupRequestedAt: clockTimestamp(this.#clock),
          updatedAt: clockTimestamp(this.#clock),
        });
        journal = await this.#state.requestCleanup({
          expectedPhase: journal.phase,
          next,
        });
      }
      const cleanup = await this.#cleanup(journal, inspected.pair, signal);
      if (cleanup !== 'cleaned') fail('recovery-required');
      return 'cancelled';
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      if (signal.aborted) {
        fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
      }
      fail('dependency-failed');
    }
  }

  restore(input: RestoreEnvironmentInput): Promise<EnvironmentRestoreResult> {
    const snapshot = snapshotInput(input);
    return this.#state.runExclusive(
      () => this.#restore(snapshot),
      snapshot.signal,
    );
  }

  async #restore(
    snapshot: RestoreInputSnapshot,
  ): Promise<EnvironmentRestoreResult> {
    const controller = new AbortController();
    const signal = snapshot.signal === undefined
      ? controller.signal
      : AbortSignal.any([snapshot.signal, controller.signal]);
    try {
      assertNotAborted(signal);
      const catalog = validateCatalog(await this.#backup.validate({
        catalogId: snapshot.catalogId,
        expectedCatalogSha256: snapshot.expectedCatalogSha256,
        signal,
      }), {
        catalogId: snapshot.catalogId,
        catalogSha256: snapshot.expectedCatalogSha256,
      });
      assertCatalogJournalCapacity(catalog, snapshot);
      await this.#continuity.verifyBeforeCreation({ catalog, signal });
      assertNotAborted(signal);
      let inspected = await this.#state.inspect(signal);
      let journal = inspected.journal;
      if (journal === undefined) {
        if (inspected.pair !== 'absent') fail('pair-mismatch');
        await this.#coordination.assertEmpty(signal);
        await this.#repositories.assertEmpty(signal);
        const now = clockTimestamp(this.#clock);
        journal = await this.#state.create(Object.freeze({
          authorityId: catalog.authorityId,
          authorityVolumeId: snapshot.authorityVolumeId,
          authorityVolumeIdentity: snapshot.authorityVolumeIdentity,
          catalogId: snapshot.catalogId,
          catalogSha256: snapshot.expectedCatalogSha256,
          coordinationSchemaVersion: catalog.coordinationSchemaVersion,
          createdAt: now,
          maximumServerBuild: catalog.maximumServerBuild,
          minimumServerBuild: catalog.minimumServerBuild,
          operationId: snapshot.operationId,
          phase: 'validated',
          projects: catalog.projects,
          repositoryFormatVersion: catalog.repositoryFormatVersion,
          restoreEpoch: catalog.restoreEpoch + 1,
          schemaVersion: 1,
          terminalProjects: catalog.terminalProjects,
          updatedAt: now,
        }));
        inspected = Object.freeze({ journal, pair: 'absent' });
      } else {
        journal = decodeEnvironmentRestoreJournal(journal);
        if (journal.cleanupRequestedAt !== undefined) {
          fail('recovery-required');
        }
      }
      exactJournal(journal, snapshot, catalog);
      return await this.#run(snapshot, catalog, journal, inspected.pair, signal);
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      if (signal.aborted) {
        fail(signal.reason === 'closed' ? 'closed' : 'cancelled');
      }
      fail('dependency-failed');
    }
  }

  async #run(
    _input: RestoreInputSnapshot,
    catalog: EnvironmentRestoreCatalog,
    initial: EnvironmentRestoreJournal,
    initialPair: EnvironmentRestorePairInspection,
    signal: AbortSignal,
  ): Promise<EnvironmentRestoreResult> {
    let journal = initial;
    let pair = initialPair;
    const reverifyBeforeReadiness = initial.phase === 'verified'
      || initial.phase === 'completed';
    if (
      (PHASE_INDEX.get(journal.phase) ?? fail('state-conflict')) < PAIR_PREPARED_INDEX
      && pair !== 'absent'
      && !(
        journal.phase === 'repositories-staged'
        && typeof pair === 'object'
        && pair.authorityVolumeId === journal.authorityVolumeId
      )
    ) fail(pair === 'ambiguous' ? 'recovery-required' : 'pair-mismatch');
    if (
      (PHASE_INDEX.get(journal.phase) ?? fail('state-conflict')) >= PAIR_PREPARED_INDEX
      && (
        typeof pair !== 'object'
        || pair.authorityVolumeId !== journal.authorityVolumeId
      )
    ) fail(pair === 'ambiguous' ? 'recovery-required' : 'pair-mismatch');

    if (
      (PHASE_INDEX.get(initial.phase) ?? fail('state-conflict'))
        >= DATABASE_CREATED_INDEX
    ) {
      await this.#coordination.verifyDatabaseIdentity(
        journal.authorityVolumeId,
        signal,
      );
    }

    if (journal.phase === 'validated') {
      const database = await this.#coordination.createDatabase({
        authorityId: journal.authorityId,
        authorityVolumeId: journal.authorityVolumeId,
        authorityVolumeIdentity: journal.authorityVolumeIdentity,
        coordinationSchemaVersion: journal.coordinationSchemaVersion,
        operationId: journal.operationId,
        restoreEpoch: journal.restoreEpoch,
        signal,
      });
      if (database.authorityVolumeId !== journal.authorityVolumeId) {
        fail('pair-mismatch');
      }
      await this.#coordination.verifyDatabaseIdentity(
        journal.authorityVolumeId,
        signal,
      );
      journal = await this.#advance(journal, 'database-created', {
        databaseIdentity: database.authorityVolumeId,
      });
    }
    if (journal.phase === 'database-created') {
      await this.#coordination.importCoordination({
        catalog,
        operationId: journal.operationId,
        restoreEpoch: journal.restoreEpoch,
        signal,
      });
      journal = await this.#advance(journal, 'coordination-imported');
    }
    if (journal.phase === 'coordination-imported') {
      const repositories = validateRepositories(
        catalog.projects,
        await this.#repositories.stage({
          operationId: journal.operationId,
          projects: catalog.projects,
          signal,
        }),
        journal.operationId,
      );
      journal = await this.#advance(journal, 'repositories-staged', {
        repositories,
      });
    }
    if (journal.phase === 'repositories-staged') {
      journal = await this.#state.preparePair({
        authorityVolumeId: journal.authorityVolumeId,
        expectedPhase: 'repositories-staged',
        next: nextJournal(
          journal,
          'pair-prepared',
          clockTimestamp(this.#clock),
        ),
      });
      pair = Object.freeze({ authorityVolumeId: journal.authorityVolumeId });
    }
    const repositories = journal.repositories;
    if (
      (PHASE_INDEX.get(journal.phase) ?? fail('state-conflict')) >= PAIR_PREPARED_INDEX
      && repositories === undefined
    ) fail('state-conflict');
    if (journal.phase === 'pair-prepared') {
      await this.#repositories.publish({
        operationId: journal.operationId,
        repositories: repositories ?? fail('state-conflict'),
        signal,
      });
      journal = await this.#advance(journal, 'repositories-published');
    }
    if (journal.phase === 'repositories-published') {
      await this.#coordination.publishAuthority({
        catalog,
        operationId: journal.operationId,
        repositories: repositories ?? fail('state-conflict'),
        restoreEpoch: journal.restoreEpoch,
        signal,
      });
      journal = await this.#advance(journal, 'authority-published');
    }
    if (journal.phase === 'authority-published') {
      await this.#verify(catalog, journal, repositories, signal);
      journal = await this.#advance(journal, 'verified');
    }
    if (
      reverifyBeforeReadiness
      && (journal.phase === 'verified' || journal.phase === 'completed')
    ) {
      await this.#verify(catalog, journal, repositories, signal);
    }
    if (journal.phase === 'verified') {
      journal = await this.#advance(journal, 'completed');
    }
    if (journal.phase !== 'completed' || pair === 'absent') {
      fail('recovery-required');
    }
    return Object.freeze({
      catalogId: journal.catalogId,
      catalogSha256: journal.catalogSha256,
      completedAt: journal.updatedAt,
      operationId: journal.operationId,
      projectCount: journal.projects.length + journal.terminalProjects.length,
      restoreEpoch: journal.restoreEpoch,
      state: 'completed',
    });
  }

  async #verify(
    catalog: EnvironmentRestoreCatalog,
    journal: EnvironmentRestoreJournal,
    repositories: readonly EnvironmentRestoreRepositoryPublication[] | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const exactRepositories = repositories ?? fail('state-conflict');
    await this.#coordination.verifyRestored({
      catalog,
      operationId: journal.operationId,
      repositories: exactRepositories,
      restoreEpoch: journal.restoreEpoch,
      signal,
    });
    await this.#repositories.verifyRestored({
      operationId: journal.operationId,
      repositories: exactRepositories,
      signal,
    });
    await this.#continuity.verifyRestored({
      catalog,
      repositories: exactRepositories,
      restoreEpoch: journal.restoreEpoch,
      signal,
    });
  }

  async #advance(
    journal: EnvironmentRestoreJournal,
    phase: EnvironmentRestorePhase,
    patch?: Partial<Pick<
      EnvironmentRestoreJournal,
      'databaseIdentity' | 'repositories'
    >>,
  ): Promise<EnvironmentRestoreJournal> {
    const next = nextJournal(
      journal,
      phase,
      clockTimestamp(this.#clock),
      patch,
    );
    const advanced = await this.#state.advance({
      expectedPhase: journal.phase,
      next,
    });
    if (
      encodeEnvironmentRestoreJournal(advanced)
      !== encodeEnvironmentRestoreJournal(next)
    ) {
      fail('state-conflict');
    }
    return advanced;
  }

  async #cleanup(
    journal: EnvironmentRestoreJournal,
    pair: EnvironmentRestorePairInspection,
    outerSignal?: AbortSignal,
  ): Promise<'cleaned' | EnvironmentRestoreJournal> {
    if (journal.cleanupRequestedAt === undefined) fail('state-conflict');
    const controller = new AbortController();
    const signal = outerSignal === undefined
      ? controller.signal
      : AbortSignal.any([outerSignal, controller.signal]);
    const phaseIndex = PHASE_INDEX.get(journal.phase) ?? fail('state-conflict');
    if (phaseIndex >= AUTHORITY_PUBLISHED_INDEX) {
      fail('recovery-required');
    }
    if (pair === 'ambiguous') fail('recovery-required');
    if (
      typeof pair === 'object'
      && pair.authorityVolumeId !== journal.authorityVolumeId
    ) fail('recovery-required');
    const exactPair = typeof pair === 'object'
      && pair.authorityVolumeId === journal.authorityVolumeId;
    if (phaseIndex >= PAIR_PREPARED_INDEX && !exactPair) {
      fail('recovery-required');
    }
    if (
      phaseIndex < PAIR_PREPARED_INDEX
      && pair !== 'absent'
      && !(journal.phase === 'repositories-staged' && exactPair)
    ) fail('recovery-required');
    const database = await this.#coordination
      .classifyOrRemoveRestoreOwnedDatabase({
        authorityVolumeId: journal.authorityVolumeId,
        operationId: journal.operationId,
        signal,
      });
    if (database === 'authority-published') {
      if (journal.phase !== 'repositories-published') {
        fail('recovery-required');
      }
      const publishedJournal = { ...journal };
      Reflect.deleteProperty(publishedJournal, 'cleanupRequestedAt');
      const next = Object.freeze({
        ...publishedJournal,
        phase: 'authority-published' as const,
        updatedAt: clockTimestamp(this.#clock),
      });
      const recovered = await this.#state.recoverPublishedAuthority({
        expectedPhase: 'repositories-published',
        next,
      });
      if (
        encodeEnvironmentRestoreJournal(recovered)
        !== encodeEnvironmentRestoreJournal(next)
      ) fail('state-conflict');
      return recovered;
    }
    if (journal.repositories !== undefined) {
      const repositories = validateRepositories(
        journal.projects,
        journal.repositories,
        journal.operationId,
      );
      await this.#repositories.removeRestoreOwned({
        operationId: journal.operationId,
        repositories,
        signal,
      });
    }
    if (phaseIndex >= COORDINATION_IMPORTED_INDEX) {
      await this.#repositories.removeRestoreStaging({
        operationId: journal.operationId,
        projects: journal.projects,
        signal,
      });
    }
    await this.#state.remove({
      expectedCatalogSha256: journal.catalogSha256,
      operationId: journal.operationId,
      phase: journal.phase,
    });
    return 'cleaned';
  }
}
