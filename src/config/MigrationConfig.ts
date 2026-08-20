import {
  type ConfigSource,
  rejectUnknownConfigFields,
  requirePostgresUrl,
} from './configDecoder.js';

export interface MigrationConfig {
  readonly postgresUrl: string;
}

const MIGRATION_CONFIG_FIELDS = new Set([
  'CLAUDIAN_CLOUD_POSTGRES_URL',
]);

export function decodeMigrationConfig(source: ConfigSource): MigrationConfig {
  rejectUnknownConfigFields(source, MIGRATION_CONFIG_FIELDS);
  return Object.freeze({
    postgresUrl: requirePostgresUrl(source),
  });
}
