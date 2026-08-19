export type DeploymentProfile = 'private-development';

export interface HttpConfig {
  readonly host: '127.0.0.1';
  readonly port: number;
}

export interface ServerConfig {
  readonly deploymentProfile: DeploymentProfile;
  readonly http: HttpConfig;
  readonly shutdownTimeoutMs: number;
}

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

type ConfigSource = Readonly<Record<string, string | undefined>>;

const CONFIG_PREFIX = 'CLAUDIAN_CLOUD_';
const TRUSTED_INGRESS_PREFIX = 'CLAUDIAN_CLOUD_TRUSTED_INGRESS_';
const CONFIG_FIELDS = new Set([
  'CLAUDIAN_CLOUD_BIND_HOST',
  'CLAUDIAN_CLOUD_DEPLOYMENT_PROFILE',
  'CLAUDIAN_CLOUD_PORT',
  'CLAUDIAN_CLOUD_SHUTDOWN_TIMEOUT_MS',
]);

function requireValue(source: ConfigSource, field: string): string {
  const value = source[field];
  if (value === undefined || value.length === 0) {
    throw new ConfigError('missing-field', field);
  }
  return value;
}

function parseInteger(
  source: ConfigSource,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const value = requireValue(source, field);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ConfigError('invalid-field', field);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError('invalid-field', field);
  }
  return parsed;
}

function rejectUnknownFields(source: ConfigSource): void {
  for (const [field, value] of Object.entries(source)) {
    if (value === undefined || !field.startsWith(CONFIG_PREFIX)) continue;
    if (field.startsWith(TRUSTED_INGRESS_PREFIX)) {
      throw new ConfigError('profile-conflict', field);
    }
    if (!CONFIG_FIELDS.has(field)) {
      throw new ConfigError('unknown-field', field);
    }
  }
}

export function decodeServerConfig(source: ConfigSource): ServerConfig {
  rejectUnknownFields(source);

  const deploymentProfile = requireValue(
    source,
    'CLAUDIAN_CLOUD_DEPLOYMENT_PROFILE',
  );
  if (deploymentProfile !== 'private-development') {
    throw new ConfigError('invalid-field', 'CLAUDIAN_CLOUD_DEPLOYMENT_PROFILE');
  }

  const host = requireValue(source, 'CLAUDIAN_CLOUD_BIND_HOST');
  if (host !== '127.0.0.1') {
    throw new ConfigError('profile-conflict', 'CLAUDIAN_CLOUD_BIND_HOST');
  }

  const http = Object.freeze({
    host,
    port: parseInteger(source, 'CLAUDIAN_CLOUD_PORT', 0, 65_535),
  });

  return Object.freeze({
    deploymentProfile,
    http,
    shutdownTimeoutMs: parseInteger(
      source,
      'CLAUDIAN_CLOUD_SHUTDOWN_TIMEOUT_MS',
      100,
      120_000,
    ),
  });
}
