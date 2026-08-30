import process from 'node:process';

import { createMaintenanceCommand } from './composition/createMaintenanceCommand.js';
import { runServerProcess } from './composition/ServerProcess.js';
import { assertSupportedNodeVersion } from './config/RuntimeVersion.js';
import { reportBootstrapFailure } from './observability/BootstrapReporter.js';

function writeStandardOutput(line: string): void {
  process.stdout.write(line);
}

function writeStandardError(line: string): void {
  process.stderr.write(line);
}

async function runMaintenance(arguments_: readonly string[]): Promise<void> {
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals): void => controller.abort(signal);
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const runtime = createMaintenanceCommand({
      source: process.env,
      write: writeStandardOutput,
    });
    await runtime.run(arguments_, controller.signal);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

async function run(): Promise<void> {
  assertSupportedNodeVersion();
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === 'maintenance') {
    await runMaintenance(arguments_.slice(1));
    return;
  }
  if (arguments_.length !== 0) throw new Error('runtime-entry.invalid');
  await runServerProcess();
}

try {
  await run();
} catch {
  reportBootstrapFailure(writeStandardError);
  process.exitCode = 1;
}
