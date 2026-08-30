import { decodeMigrationConfig } from '../../config/MigrationConfig.js';
import type { ConfigSource } from '../../config/configDecoder.js';
import { PostgresMigrator } from '../../coordination/postgres/PostgresMigrator.js';
import { MaintenanceCommandError } from './MaintenanceCommandRegistry.js';

export interface MigrationMaintenanceCommandInput {
  readonly arguments: readonly string[];
  readonly signal: AbortSignal;
  readonly source: ConfigSource;
  readonly write: (line: string) => void;
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new MaintenanceCommandError('cancelled');
}

export async function runMigrationMaintenanceCommand(
  input: MigrationMaintenanceCommandInput,
): Promise<void> {
  active(input.signal);
  const command = input.arguments[0] ?? 'apply';
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
}
