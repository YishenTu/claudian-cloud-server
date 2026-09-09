export const CURRENT_POSTGRES_SCHEMA_VERSION = 12;

export function supportsPostgresSchemaVersion(
  value: unknown,
): value is number {
  return Number.isSafeInteger(value)
    && value === CURRENT_POSTGRES_SCHEMA_VERSION;
}
