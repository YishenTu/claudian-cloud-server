import process from 'node:process';

import { decodeMigrationConfig } from './config/MigrationConfig.js';
import { assertSupportedNodeVersion } from './config/RuntimeVersion.js';
import { PostgresMigrator } from './coordination/postgres/PostgresMigrator.js';
import { reportBootstrapFailure } from './observability/BootstrapReporter.js';

function writeStandardError(line: string): void {
  process.stderr.write(line);
}

async function run(): Promise<void> {
  assertSupportedNodeVersion();
  const config = decodeMigrationConfig(process.env);
  const migrator = new PostgresMigrator({
    connectionString: config.postgresUrl,
  });
  await migrator.apply();
}

try {
  await run();
} catch {
  reportBootstrapFailure(writeStandardError);
  process.exitCode = 1;
}
