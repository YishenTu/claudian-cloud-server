import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../../config/PostgresSchemaCompatibility.js';

export const CURRENT_POSTGRES_SCHEMA = Object.freeze({
  checksum: '889ce8b82580c5428522baf761050023a2a8a68b4c9e204f5c9f9ebcd7d5642a',
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
