import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../../config/PostgresSchemaCompatibility.js';

export const CURRENT_POSTGRES_SCHEMA = Object.freeze({
  checksum: '0e4d70b95b2e7a12a377af09dcb9f5e58241ca828d02a95b977f48e515b029bb',
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
