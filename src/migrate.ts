import process from 'node:process';

import { decodeMigrationConfig } from './config/MigrationConfig.js';
import {
  CURRENT_POSTGRES_SCHEMA_VERSION,
  supportsPostgresSchemaVersion,
} from './config/PostgresSchemaCompatibility.js';
import { assertSupportedNodeVersion } from './config/RuntimeVersion.js';
import { PostgresMigrator } from './coordination/postgres/PostgresMigrator.js';
import { reportBootstrapFailure } from './observability/BootstrapReporter.js';

function writeStandardError(line: string): void {
  process.stderr.write(line);
}

function writeStandardOutput(line: string): void {
  process.stdout.write(line);
}

type MigrationCommandResult = 'complete' | 'unsupported';

function parseVersion(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function run(): Promise<MigrationCommandResult> {
  assertSupportedNodeVersion();
  const requestedCommand = process.argv[2];
  const command = requestedCommand ?? 'apply';
  if (command === 'target' && process.argv.length === 3) {
    writeStandardOutput(`${String(CURRENT_POSTGRES_SCHEMA_VERSION)}\n`);
    return 'complete';
  }
  if (command === 'supports' && process.argv.length === 4) {
    const version = parseVersion(process.argv[3]);
    return supportsPostgresSchemaVersion(version) ? 'complete' : 'unsupported';
  }
  if (
    (command !== 'apply' && command !== 'preflight')
    || (requestedCommand === undefined
      ? process.argv.length !== 2
      : process.argv.length !== 3)
  ) {
    throw new Error('invalid migration command');
  }
  const config = decodeMigrationConfig(process.env);
  const migrator = new PostgresMigrator({
    connectionString: config.postgresUrl,
  });
  if (command === 'preflight') {
    const plan = await migrator.preflight();
    writeStandardOutput(`${String(plan.currentVersion)}\n`);
  } else {
    await migrator.apply();
  }
  return 'complete';
}

try {
  const result = await run();
  if (result === 'unsupported') process.exitCode = 2;
} catch {
  reportBootstrapFailure(writeStandardError);
  process.exitCode = 1;
}
