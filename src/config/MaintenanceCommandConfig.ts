import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabIsoTimestamp,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type { ConfigSource } from './configDecoder.js';

export const BACKUP_ARTIFACT_ROOT =
  '/var/lib/claudian-cloud-backups/artifacts';
export const BACKUP_CATALOG_ROOT =
  '/var/lib/claudian-cloud-backups/catalogs';
export const EXPORT_ARTIFACT_ROOT =
  '/var/lib/claudian-cloud-exports/artifacts';

export class MaintenanceCommandConfigError extends Error {
  readonly code = 'invalid-maintenance-config' as const;

  constructor() {
    super('maintenance-command-config.error.invalid-maintenance-config');
    this.name = 'MaintenanceCommandConfigError';
  }
}

export type MaintenanceOperationCommand =
  | 'backup'
  | 'export-project'
  | 'restore'
  | 'resume-delete'
  | 'verify-authority'
  | 'verify-backup';

export interface MaintenanceOperationConfig {
  readonly authorizationSha256?: string;
  readonly expiresAt?: CollabIsoTimestamp;
  readonly operationId: string;
  readonly projectId?: CollabProjectId;
}

const AUTHORIZATION_FIELD =
  'CLAUDIAN_CLOUD_MAINTENANCE_AUTHORIZATION_SHA256';
const EXPIRES_AT_FIELD = 'CLAUDIAN_CLOUD_MAINTENANCE_EXPIRES_AT';
const OPERATION_ID_FIELD = 'CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID';
const PROJECT_ID_FIELD = 'CLAUDIAN_CLOUD_MAINTENANCE_PROJECT_ID';
const MAINTENANCE_FIELDS = new Set([
  AUTHORIZATION_FIELD,
  EXPIRES_AT_FIELD,
  OPERATION_ID_FIELD,
  PROJECT_ID_FIELD,
]);
const MAINTENANCE_COMPOSITION_FIELDS = new Set([
  ...MAINTENANCE_FIELDS,
  'CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL',
  'CLAUDIAN_CLOUD_PROJECT_RECOVERY_REQUIRED',
  'CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function fail(): never {
  throw new MaintenanceCommandConfigError();
}

function required(source: ConfigSource, field: string): string {
  const value = source[field];
  if (value === undefined || value.length === 0) return fail();
  return value;
}

function timestamp(value: string): value is CollabIsoTimestamp {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function assertExactFields(
  source: ConfigSource,
  command: MaintenanceOperationCommand,
): void {
  const allowed = new Set(command === 'export-project'
    ? [EXPIRES_AT_FIELD, OPERATION_ID_FIELD, PROJECT_ID_FIELD]
    : command === 'resume-delete'
      ? [AUTHORIZATION_FIELD, OPERATION_ID_FIELD, PROJECT_ID_FIELD]
      : [OPERATION_ID_FIELD]);
  for (const field of MAINTENANCE_FIELDS) {
    const value = source[field];
    if (value !== undefined && value.length > 0 && !allowed.has(field)) fail();
  }
}

export function decodeMaintenanceCommandConfig(
  source: ConfigSource,
  command: MaintenanceOperationCommand,
): MaintenanceOperationConfig {
  assertExactFields(source, command);
  const operationId = required(source, OPERATION_ID_FIELD);
  if (!isCollabOpaqueId(operationId)) return fail();
  if (command === 'export-project') {
    const projectId = required(source, PROJECT_ID_FIELD);
    const expiresAt = required(source, EXPIRES_AT_FIELD);
    if (!isCollabProjectId(projectId) || !timestamp(expiresAt)) return fail();
    return Object.freeze({ expiresAt, operationId, projectId });
  }
  if (command === 'resume-delete') {
    const projectId = required(source, PROJECT_ID_FIELD);
    const authorizationSha256 = required(source, AUTHORIZATION_FIELD);
    if (
      !isCollabProjectId(projectId)
      || !SHA256_PATTERN.test(authorizationSha256)
    ) return fail();
    return Object.freeze({ authorizationSha256, operationId, projectId });
  }
  return Object.freeze({ operationId });
}

export function serverConfigSource(source: ConfigSource): ConfigSource {
  return Object.freeze(Object.fromEntries(
    Object.entries(source).filter(
      ([field]) => !MAINTENANCE_COMPOSITION_FIELDS.has(field),
    ),
  ));
}

export function migrationConfigSource(source: ConfigSource): ConfigSource {
  return Object.freeze({
    CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL:
      source.CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL,
  });
}
