import { isAbsolute, normalize, parse } from 'node:path';

import { COLLAB_CLOUD_BINDING_LIMITS } from '@claudian-collab/protocol';

import {
  ConfigError,
  type ConfigSource,
  rejectUnknownConfigFields,
  requireConfigValue,
  requirePostgresUrl,
} from './configDecoder.js';

export { ConfigError } from './configDecoder.js';
export type { ConfigErrorCode, ConfigSource } from './configDecoder.js';

export interface GitAdmissionConfig {
  readonly maxChildren: number;
  readonly maxChildrenPerProject: number;
  readonly maxQueuedReads: number;
  readonly maxQueuedWrites: number;
  readonly maxReadChildren: number;
  readonly maxWriteChildren: number;
  readonly queueMax: number;
  readonly queueMaxPerProject: number;
  readonly queueTimeoutMs: number;
}

export interface EventAdmissionConfig {
  readonly maxConnections: number;
  readonly maxConnectionsPerProject: number;
  readonly maxPendingAuthorizations: number;
}

export interface DevelopmentBootstrapConfig {
  readonly attemptTtlMs: number;
  readonly maxBundleBytes: number;
  readonly maxConcurrentUploads: number;
  readonly maxRepositoryBytes: number;
  readonly maxUploadsPerAttempt: number;
  readonly queueMax: number;
  readonly queueTimeoutMs: number;
  readonly stagingFreeSpaceFloorBytes: number;
  readonly stagingReservationBytes: number;
  readonly stagingRoot: string;
  readonly uploadDeadlineMs: number;
  readonly uploadIdleTimeoutMs: number;
}

export interface HttpConfig {
  readonly host: '127.0.0.1';
  readonly port: number;
}

export interface PostgresConfig {
  readonly ordinaryPoolMax: number;
  readonly pinnedPoolMax: number;
  readonly projectLockTimeoutMs: number;
  readonly reservedPoolMax: number;
  readonly url: string;
}

export interface RepositoryConfig {
  readonly gitExecutable: string;
  readonly operationTimeoutMs: number;
  readonly outputMaxBytes: number;
  readonly root: string;
  readonly storageNodeId: string;
}

export type PrincipalProfile = 'private-development' | 'vault-credential';

export interface ServerConfig {
  readonly developmentBootstrap: DevelopmentBootstrapConfig;
  readonly eventAdmission: EventAdmissionConfig;
  readonly gitAdmission: GitAdmissionConfig;
  readonly http: HttpConfig;
  readonly postgres: PostgresConfig;
  readonly principalProfile: PrincipalProfile;
  readonly repository: RepositoryConfig;
  readonly shutdownTimeoutMs: number;
}

const SHUTDOWN_TIMEOUT_MS = 15_000;
const STORAGE_NODE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const PRINCIPAL_PROFILE_FIELD = 'CLAUDIAN_CLOUD_PRINCIPAL_PROFILE';
const CONFIG_FIELDS = new Set([
  'CLAUDIAN_CLOUD_BIND_HOST',
  'CLAUDIAN_CLOUD_BOOTSTRAP_ATTEMPT_TTL_MS',
  'CLAUDIAN_CLOUD_BOOTSTRAP_MAX_BUNDLE_BYTES',
  'CLAUDIAN_CLOUD_BOOTSTRAP_MAX_REPOSITORY_BYTES',
  'CLAUDIAN_CLOUD_BOOTSTRAP_QUEUE_MAX',
  'CLAUDIAN_CLOUD_BOOTSTRAP_QUEUE_TIMEOUT_MS',
  'CLAUDIAN_CLOUD_BOOTSTRAP_STAGING_FREE_SPACE_FLOOR_BYTES',
  'CLAUDIAN_CLOUD_BOOTSTRAP_STAGING_RESERVATION_BYTES',
  'CLAUDIAN_CLOUD_BOOTSTRAP_UPLOAD_DEADLINE_MS',
  'CLAUDIAN_CLOUD_BOOTSTRAP_UPLOAD_IDLE_TIMEOUT_MS',
  'CLAUDIAN_CLOUD_GIT_EXECUTABLE',
  'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN',
  'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN_PER_PROJECT',
  'CLAUDIAN_CLOUD_GIT_MAX_QUEUED_READS',
  'CLAUDIAN_CLOUD_GIT_MAX_QUEUED_WRITES',
  'CLAUDIAN_CLOUD_GIT_MAX_READ_CHILDREN',
  'CLAUDIAN_CLOUD_GIT_MAX_WRITE_CHILDREN',
  'CLAUDIAN_CLOUD_GIT_OPERATION_TIMEOUT_MS',
  'CLAUDIAN_CLOUD_GIT_OUTPUT_MAX_BYTES',
  'CLAUDIAN_CLOUD_GIT_QUEUE_MAX',
  'CLAUDIAN_CLOUD_GIT_QUEUE_MAX_PER_PROJECT',
  'CLAUDIAN_CLOUD_GIT_QUEUE_TIMEOUT_MS',
  'CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS',
  'CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS_PER_PROJECT',
  'CLAUDIAN_CLOUD_EVENT_MAX_PENDING_AUTHORIZATIONS',
  'CLAUDIAN_CLOUD_PORT',
  PRINCIPAL_PROFILE_FIELD,
  'CLAUDIAN_CLOUD_POSTGRES_ORDINARY_POOL_MAX',
  'CLAUDIAN_CLOUD_POSTGRES_PINNED_POOL_MAX',
  'CLAUDIAN_CLOUD_POSTGRES_RESERVED_POOL_MAX',
  'CLAUDIAN_CLOUD_POSTGRES_URL',
  'CLAUDIAN_CLOUD_PROJECT_LOCK_TIMEOUT_MS',
  'CLAUDIAN_CLOUD_REPOSITORY_ROOT',
  'CLAUDIAN_CLOUD_STAGING_ROOT',
  'CLAUDIAN_CLOUD_STORAGE_NODE_ID',
]);

function parseInteger(
  source: ConfigSource,
  field: string,
  minimum: number,
  maximum: number,
  defaultValue?: number,
): number {
  const value = source[field];
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  const required = requireConfigValue(source, field);
  if (!/^(?:0|[1-9][0-9]*)$/.test(required)) {
    throw new ConfigError('invalid-field', field);
  }
  const parsed = Number(required);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError('invalid-field', field);
  }
  return parsed;
}

function requireAbsoluteNormalizedPath(source: ConfigSource, field: string): string {
  const value = requireConfigValue(source, field);
  if (
    value.includes('\0')
    || !isAbsolute(value)
    || normalize(value) !== value
    || parse(value).root === value
  ) {
    throw new ConfigError('invalid-field', field);
  }
  return value;
}

function requireStorageNodeId(source: ConfigSource): string {
  const field = 'CLAUDIAN_CLOUD_STORAGE_NODE_ID';
  const value = requireConfigValue(source, field);
  if (!STORAGE_NODE_ID_PATTERN.test(value)) {
    throw new ConfigError('invalid-field', field);
  }
  return value;
}

function invalidWhen(condition: boolean, field: string): void {
  if (condition) throw new ConfigError('invalid-field', field);
}

export function decodeServerConfig(source: ConfigSource): ServerConfig {
  rejectUnknownConfigFields(source, CONFIG_FIELDS);
  const profileValue = requireConfigValue(source, PRINCIPAL_PROFILE_FIELD);
  if (profileValue !== 'private-development' && profileValue !== 'vault-credential') {
    throw new ConfigError('invalid-field', PRINCIPAL_PROFILE_FIELD);
  }
  const principalProfile: PrincipalProfile = profileValue;

  const host = requireConfigValue(source, 'CLAUDIAN_CLOUD_BIND_HOST');
  if (host !== '127.0.0.1') {
    throw new ConfigError('profile-conflict', 'CLAUDIAN_CLOUD_BIND_HOST');
  }

  const repositoryRoot = requireAbsoluteNormalizedPath(
    source,
    'CLAUDIAN_CLOUD_REPOSITORY_ROOT',
  );
  const stagingRoot = requireAbsoluteNormalizedPath(
    source,
    'CLAUDIAN_CLOUD_STAGING_ROOT',
  );
  invalidWhen(
    stagingRoot === repositoryRoot
      || parse(stagingRoot).dir !== parse(repositoryRoot).dir,
    'CLAUDIAN_CLOUD_STAGING_ROOT',
  );

  const maxBundleBytes = parseInteger(
    source,
    'CLAUDIAN_CLOUD_BOOTSTRAP_MAX_BUNDLE_BYTES',
    1,
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapGitBundleBytes,
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapGitBundleBytes,
  );
  const maxRepositoryBytes = parseInteger(
    source,
    'CLAUDIAN_CLOUD_BOOTSTRAP_MAX_REPOSITORY_BYTES',
    1,
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapRepositoryBytes,
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapRepositoryBytes,
  );
  const stagingReservationBytes = parseInteger(
    source,
    'CLAUDIAN_CLOUD_BOOTSTRAP_STAGING_RESERVATION_BYTES',
    1,
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapStagingBytes,
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapStagingBytes,
  );
  invalidWhen(
    stagingReservationBytes < maxBundleBytes + maxRepositoryBytes,
    'CLAUDIAN_CLOUD_BOOTSTRAP_STAGING_RESERVATION_BYTES',
  );

  const uploadIdleTimeoutMs = parseInteger(
    source,
    'CLAUDIAN_CLOUD_BOOTSTRAP_UPLOAD_IDLE_TIMEOUT_MS',
    100,
    COLLAB_CLOUD_BINDING_LIMITS.uploadIdleTimeoutMs,
    COLLAB_CLOUD_BINDING_LIMITS.uploadIdleTimeoutMs,
  );
  const uploadDeadlineMs = parseInteger(
    source,
    'CLAUDIAN_CLOUD_BOOTSTRAP_UPLOAD_DEADLINE_MS',
    100,
    COLLAB_CLOUD_BINDING_LIMITS.uploadDeadlineMs,
    COLLAB_CLOUD_BINDING_LIMITS.uploadDeadlineMs,
  );
  invalidWhen(
    uploadDeadlineMs <= uploadIdleTimeoutMs,
    'CLAUDIAN_CLOUD_BOOTSTRAP_UPLOAD_DEADLINE_MS',
  );

  const attemptTtlMs = parseInteger(
    source,
    'CLAUDIAN_CLOUD_BOOTSTRAP_ATTEMPT_TTL_MS',
    COLLAB_CLOUD_BINDING_LIMITS.bootstrapAttemptTtlMs,
    COLLAB_CLOUD_BINDING_LIMITS.bootstrapAttemptTtlMs,
    COLLAB_CLOUD_BINDING_LIMITS.bootstrapAttemptTtlMs,
  );
  invalidWhen(
    attemptTtlMs <= uploadDeadlineMs,
    'CLAUDIAN_CLOUD_BOOTSTRAP_ATTEMPT_TTL_MS',
  );

  const developmentBootstrap = Object.freeze({
    attemptTtlMs,
    maxBundleBytes,
    maxConcurrentUploads:
      COLLAB_CLOUD_BINDING_LIMITS.defaultMaxConcurrentBootstrapUploads,
    maxRepositoryBytes,
    maxUploadsPerAttempt:
      COLLAB_CLOUD_BINDING_LIMITS.maxUploadsPerBootstrapAttempt,
    queueMax: parseInteger(
      source,
      'CLAUDIAN_CLOUD_BOOTSTRAP_QUEUE_MAX',
      1,
      1_024,
      4,
    ),
    queueTimeoutMs: parseInteger(
      source,
      'CLAUDIAN_CLOUD_BOOTSTRAP_QUEUE_TIMEOUT_MS',
      100,
      300_000,
      10_000,
    ),
    stagingFreeSpaceFloorBytes: parseInteger(
      source,
      'CLAUDIAN_CLOUD_BOOTSTRAP_STAGING_FREE_SPACE_FLOOR_BYTES',
      64 * 1_024 * 1_024,
      Number.MAX_SAFE_INTEGER,
      COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapGitBundleBytes,
    ),
    stagingReservationBytes,
    stagingRoot,
    uploadDeadlineMs,
    uploadIdleTimeoutMs,
  });

  const maxChildren = parseInteger(
    source,
    'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN',
    2,
    64,
    2,
  );
  const maxChildrenPerProject = parseInteger(
    source,
    'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN_PER_PROJECT',
    1,
    63,
    1,
  );
  invalidWhen(
    maxChildrenPerProject >= maxChildren,
    'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN_PER_PROJECT',
  );
  const maxReadChildren = parseInteger(
    source,
    'CLAUDIAN_CLOUD_GIT_MAX_READ_CHILDREN',
    1,
    63,
    maxChildren - 1,
  );
  invalidWhen(
    maxReadChildren >= maxChildren,
    'CLAUDIAN_CLOUD_GIT_MAX_READ_CHILDREN',
  );
  const maxWriteChildren = parseInteger(
    source,
    'CLAUDIAN_CLOUD_GIT_MAX_WRITE_CHILDREN',
    1,
    63,
    maxChildren - 1,
  );
  invalidWhen(
    maxWriteChildren >= maxChildren,
    'CLAUDIAN_CLOUD_GIT_MAX_WRITE_CHILDREN',
  );

  const queueMax = parseInteger(
    source,
    'CLAUDIAN_CLOUD_GIT_QUEUE_MAX',
    2,
    1_024,
    6,
  );
  const queueMaxPerProject = parseInteger(
    source,
    'CLAUDIAN_CLOUD_GIT_QUEUE_MAX_PER_PROJECT',
    1,
    1_023,
    4,
  );
  invalidWhen(
    queueMaxPerProject >= queueMax,
    'CLAUDIAN_CLOUD_GIT_QUEUE_MAX_PER_PROJECT',
  );
  const maxQueuedReads = parseInteger(
    source,
    'CLAUDIAN_CLOUD_GIT_MAX_QUEUED_READS',
    1,
    1_023,
    queueMax - 1,
  );
  invalidWhen(
    maxQueuedReads >= queueMax,
    'CLAUDIAN_CLOUD_GIT_MAX_QUEUED_READS',
  );
  const maxQueuedWrites = parseInteger(
    source,
    'CLAUDIAN_CLOUD_GIT_MAX_QUEUED_WRITES',
    1,
    1_023,
    queueMax - 1,
  );
  invalidWhen(
    maxQueuedWrites >= queueMax,
    'CLAUDIAN_CLOUD_GIT_MAX_QUEUED_WRITES',
  );

  const gitAdmission = Object.freeze({
    maxChildren,
    maxChildrenPerProject,
    maxQueuedReads,
    maxQueuedWrites,
    maxReadChildren,
    maxWriteChildren,
    queueMax,
    queueMaxPerProject,
    queueTimeoutMs: parseInteger(
      source,
      'CLAUDIAN_CLOUD_GIT_QUEUE_TIMEOUT_MS',
      100,
      300_000,
      10_000,
    ),
  });

  const maxEventConnections = parseInteger(
    source,
    'CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS',
    2,
    10_000,
    64,
  );
  const maxEventConnectionsPerProject = parseInteger(
    source,
    'CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS_PER_PROJECT',
    1,
    9_999,
    16,
  );
  invalidWhen(
    maxEventConnectionsPerProject >= maxEventConnections,
    'CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS_PER_PROJECT',
  );
  const maxPendingEventAuthorizations = parseInteger(
    source,
    'CLAUDIAN_CLOUD_EVENT_MAX_PENDING_AUTHORIZATIONS',
    1,
    9_999,
    16,
  );
  invalidWhen(
    maxPendingEventAuthorizations >= maxEventConnections,
    'CLAUDIAN_CLOUD_EVENT_MAX_PENDING_AUTHORIZATIONS',
  );
  const eventAdmission = Object.freeze({
    maxConnections: maxEventConnections,
    maxConnectionsPerProject: maxEventConnectionsPerProject,
    maxPendingAuthorizations: maxPendingEventAuthorizations,
  });

  const http = Object.freeze({
    host,
    port: parseInteger(source, 'CLAUDIAN_CLOUD_PORT', 1, 65_535),
  });

  const postgres = Object.freeze({
    ordinaryPoolMax: parseInteger(
      source,
      'CLAUDIAN_CLOUD_POSTGRES_ORDINARY_POOL_MAX',
      1,
      128,
      8,
    ),
    pinnedPoolMax: parseInteger(
      source,
      'CLAUDIAN_CLOUD_POSTGRES_PINNED_POOL_MAX',
      1,
      64,
      2,
    ),
    projectLockTimeoutMs: parseInteger(
      source,
      'CLAUDIAN_CLOUD_PROJECT_LOCK_TIMEOUT_MS',
      100,
      60_000,
      2_000,
    ),
    reservedPoolMax: parseInteger(
      source,
      'CLAUDIAN_CLOUD_POSTGRES_RESERVED_POOL_MAX',
      1,
      16,
      2,
    ),
    url: requirePostgresUrl(source),
  });

  const repository = Object.freeze({
    gitExecutable: requireAbsoluteNormalizedPath(
      source,
      'CLAUDIAN_CLOUD_GIT_EXECUTABLE',
    ),
    operationTimeoutMs: parseInteger(
      source,
      'CLAUDIAN_CLOUD_GIT_OPERATION_TIMEOUT_MS',
      1_000,
      3_600_000,
      300_000,
    ),
    outputMaxBytes: parseInteger(
      source,
      'CLAUDIAN_CLOUD_GIT_OUTPUT_MAX_BYTES',
      1_024,
      67_108_864,
      1_048_576,
    ),
    root: repositoryRoot,
    storageNodeId: requireStorageNodeId(source),
  });

  return Object.freeze({
    developmentBootstrap,
    eventAdmission,
    gitAdmission,
    http,
    postgres,
    principalProfile,
    repository,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
}
