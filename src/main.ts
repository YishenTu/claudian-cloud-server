import process from 'node:process';

import { createApplication } from './composition/createApplication.js';
import {
  ConfigError,
  decodeServerConfig,
} from './config/ServerConfig.js';
import { assertSupportedNodeVersion } from './config/RuntimeVersion.js';
import { reportBootstrapFailure } from './observability/BootstrapReporter.js';
import { SafeLogger } from './observability/SafeLogger.js';

function writeStandardOutput(line: string): void {
  process.stdout.write(line);
}

function writeStandardError(line: string): void {
  process.stderr.write(line);
}

async function run(): Promise<void> {
  assertSupportedNodeVersion();
  const logger = new SafeLogger({
    now: () => new Date(),
    write: writeStandardOutput,
  });

  let config;
  try {
    config = decodeServerConfig(process.env);
  } catch (error: unknown) {
    logger.error('server.startup-failed', {
      reason: error instanceof ConfigError ? error.code : 'config-decode-failed',
    });
    process.exitCode = 1;
    return;
  }

  const application = createApplication({ config, logger });
  let shutdownStarted = false;
  const shutdown = (_signal: NodeJS.Signals): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void application.close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await application.start();
  } catch {
    try {
      await application.close();
    } catch {
      // Startup already emitted the one safe failure event.
    }
    process.exitCode = 1;
  }
}

try {
  await run();
} catch {
  reportBootstrapFailure(writeStandardError);
  process.exitCode = 1;
}
