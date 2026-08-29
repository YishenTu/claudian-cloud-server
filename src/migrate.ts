import process from 'node:process';

import { assertSupportedNodeVersion } from './config/RuntimeVersion.js';
import { runMigrationMaintenanceCommand } from './environment-maintenance/commands/MigrationMaintenanceCommand.js';
import { reportBootstrapFailure } from './observability/BootstrapReporter.js';

function writeStandardError(line: string): void {
  process.stderr.write(line);
}

function writeStandardOutput(line: string): void {
  process.stdout.write(line);
}

async function run(): Promise<'complete' | 'unsupported'> {
  assertSupportedNodeVersion();
  return runMigrationMaintenanceCommand({
    arguments: process.argv.slice(2),
    signal: new AbortController().signal,
    source: process.env,
    write: writeStandardOutput,
  });
}

try {
  const result = await run();
  if (result === 'unsupported') process.exitCode = 2;
} catch {
  reportBootstrapFailure(writeStandardError);
  process.exitCode = 1;
}
