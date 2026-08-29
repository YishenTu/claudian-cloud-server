import {
  CURRENT_POSTGRES_SCHEMA_VERSION,
  MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY,
  supportsPostgresSchemaVersion,
} from '../../config/PostgresSchemaCompatibility.js';
import { decodeMigrationConfig } from '../../config/MigrationConfig.js';
import type { ConfigSource } from '../../config/configDecoder.js';
import { PostgresMigrator } from '../../coordination/postgres/PostgresMigrator.js';
import { MaintenanceCommandError } from './MaintenanceCommandRegistry.js';

export type MigrationMaintenanceCommandResult = 'complete' | 'unsupported';

export interface MigrationMaintenanceCommandInput {
  readonly arguments: readonly string[];
  readonly signal: AbortSignal;
  readonly source: ConfigSource;
  readonly write: (line: string) => void;
}

function parseVersion(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new MaintenanceCommandError('cancelled');
}

export async function runMigrationMaintenanceCommand(
  input: MigrationMaintenanceCommandInput,
): Promise<MigrationMaintenanceCommandResult> {
  active(input.signal);
  const command = input.arguments[0] ?? 'apply';
  if (command === 'target' && input.arguments.length === 1) {
    input.write(`${String(CURRENT_POSTGRES_SCHEMA_VERSION)}\n`);
    return 'complete';
  }
  if (command === 'supports' && input.arguments.length === 2) {
    return supportsPostgresSchemaVersion(
      parseVersion(input.arguments[1]),
      MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY,
    )
      ? 'complete'
      : 'unsupported';
  }
  if (
    (command !== 'apply' && command !== 'preflight')
    || (input.arguments.length !== 0 && input.arguments.length !== 1)
  ) throw new MaintenanceCommandError('invalid-command');
  const config = decodeMigrationConfig(input.source);
  const migrator = new PostgresMigrator({ connectionString: config.postgresUrl });
  active(input.signal);
  if (command === 'preflight') {
    const plan = await migrator.preflight(input.signal);
    active(input.signal);
    input.write(`${String(plan.currentVersion)}\n`);
  } else {
    await migrator.apply(input.signal);
    active(input.signal);
  }
  return 'complete';
}
