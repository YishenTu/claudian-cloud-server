import { isAbsolute, normalize, parse } from 'node:path';

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
  readonly queueMax: number;
  readonly queueMaxPerProject: number;
  readonly queueTimeoutMs: number;
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

export interface ServerConfig {
  readonly gitAdmission: GitAdmissionConfig;
  readonly http: HttpConfig;
  readonly postgres: PostgresConfig;
  readonly repository: RepositoryConfig;
  readonly shutdownTimeoutMs: number;
}

const SHUTDOWN_TIMEOUT_MS = 15_000;
const STORAGE_NODE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

const CONFIG_FIELDS = new Set([
  'CLAUDIAN_CLOUD_BIND_HOST',
  'CLAUDIAN_CLOUD_GIT_EXECUTABLE',
  'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN',
  'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN_PER_PROJECT',
  'CLAUDIAN_CLOUD_GIT_OPERATION_TIMEOUT_MS',
  'CLAUDIAN_CLOUD_GIT_OUTPUT_MAX_BYTES',
  'CLAUDIAN_CLOUD_GIT_QUEUE_MAX',
  'CLAUDIAN_CLOUD_GIT_QUEUE_MAX_PER_PROJECT',
  'CLAUDIAN_CLOUD_GIT_QUEUE_TIMEOUT_MS',
  'CLAUDIAN_CLOUD_PORT',
  'CLAUDIAN_CLOUD_POSTGRES_ORDINARY_POOL_MAX',
  'CLAUDIAN_CLOUD_POSTGRES_PINNED_POOL_MAX',
  'CLAUDIAN_CLOUD_POSTGRES_RESERVED_POOL_MAX',
  'CLAUDIAN_CLOUD_POSTGRES_URL',
  'CLAUDIAN_CLOUD_PROJECT_LOCK_TIMEOUT_MS',
  'CLAUDIAN_CLOUD_REPOSITORY_ROOT',
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

  const host = requireConfigValue(source, 'CLAUDIAN_CLOUD_BIND_HOST');
  if (host !== '127.0.0.1') {
    throw new ConfigError('profile-conflict', 'CLAUDIAN_CLOUD_BIND_HOST');
  }

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

  const gitAdmission = Object.freeze({
    maxChildren,
    maxChildrenPerProject,
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
    root: requireAbsoluteNormalizedPath(
      source,
      'CLAUDIAN_CLOUD_REPOSITORY_ROOT',
    ),
    storageNodeId: requireStorageNodeId(source),
  });

  return Object.freeze({
    gitAdmission,
    http,
    postgres,
    repository,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
}
