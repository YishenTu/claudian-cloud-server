export interface PostgresSchemaCompatibility {
  readonly maximumVersion: number;
  readonly minimumVersion: number;
}

export const CURRENT_POSTGRES_SCHEMA_VERSION = 9;

export const RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY = Object.freeze({
  maximumVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
  minimumVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
}) satisfies PostgresSchemaCompatibility;

export function supportsPostgresSchemaVersion(
  value: unknown,
  compatibility: PostgresSchemaCompatibility = RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY,
): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= compatibility.minimumVersion
    && (value as number) <= compatibility.maximumVersion;
}
