import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../../config/PostgresSchemaCompatibility.js';

export const CURRENT_POSTGRES_SCHEMA = Object.freeze({
  checksum: '836255d673eecde0c6fae6df35edff9f1528cfcdccd37b81c8dadb72fdc922a7',
  version: CURRENT_POSTGRES_SCHEMA_VERSION,
});

export interface PostgresSchemaMetadata {
  readonly singleton: boolean;
  readonly checksum: string;
  readonly version: number;
}

export function isCurrentPostgresSchema(rows: readonly PostgresSchemaMetadata[]): boolean {
  const row = rows[0];
  return rows.length === 1
    && row?.singleton === true
    && row.version === CURRENT_POSTGRES_SCHEMA.version
    && row.checksum === CURRENT_POSTGRES_SCHEMA.checksum;
}
