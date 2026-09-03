export type ConfigErrorCode =
  | 'invalid-field'
  | 'missing-field'
  | 'profile-conflict'
  | 'unknown-field';

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly field: string;

  constructor(code: ConfigErrorCode, field: string) {
    super(`config.error.${code}`);
    this.name = 'ConfigError';
    this.code = code;
    this.field = field;
  }

  toJSON(): Readonly<Record<string, string>> {
    return {
      code: this.code,
      field: this.field,
      message: this.message,
      name: this.name,
    };
  }
}

export type ConfigSource = Readonly<Record<string, string | undefined>>;

const CONFIG_PREFIX = 'CLAUDIAN_CLOUD_';
const TRUSTED_INGRESS_PREFIX = 'CLAUDIAN_CLOUD_TRUSTED_INGRESS_';

export function requireConfigValue(source: ConfigSource, field: string): string {
  const value = source[field];
  if (value === undefined || value.length === 0) {
    throw new ConfigError('missing-field', field);
  }
  return value;
}

export function rejectUnknownConfigFields(
  source: ConfigSource,
  fields: ReadonlySet<string>,
): void {
  for (const [field, value] of Object.entries(source)) {
    if (value === undefined || !field.startsWith(CONFIG_PREFIX)) continue;
    if (!fields.has(field)) {
      throw new ConfigError(
        field.startsWith(TRUSTED_INGRESS_PREFIX)
          ? 'profile-conflict'
          : 'unknown-field',
        field,
      );
    }
  }
}

export function requirePostgresUrl(
  source: ConfigSource,
  field = 'CLAUDIAN_CLOUD_POSTGRES_URL',
): string {
  const value = requireConfigValue(source, field);
  try {
    const parsed = new URL(value);
    if (
      value.trim() !== value
      || (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
      || parsed.hash.length > 0
      || parsed.pathname.length <= 1
    ) {
      throw new ConfigError('invalid-field', field);
    }
  } catch (error: unknown) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('invalid-field', field);
  }
  return value;
}
