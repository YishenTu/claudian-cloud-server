import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../../config/PostgresSchemaCompatibility.js';

export const CURRENT_POSTGRES_SCHEMA = Object.freeze({
  checksum: 'fb19a46a46b4d6ae644cb05d6b2df9d2c21afe0353cb4fc107231d469ee65c94',
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
