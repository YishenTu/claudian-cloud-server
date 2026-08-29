import process from 'node:process';

import {
  ClaimCustodyKeyringConfigError,
  loadClaimCustodyKeyring,
  type ClaimCustodyKeyringConfig,
} from '../config/ClaimCustodyKeyringConfig.js';
import {
  ConfigError,
  decodeServerConfig,
} from '../config/ServerConfig.js';
import { assertSupportedNodeVersion } from '../config/RuntimeVersion.js';
import { SafeLogger } from '../observability/SafeLogger.js';
import { createApplication } from './createApplication.js';

export interface ServerProcessOptions {
  readonly loadKeyring?: () => Promise<ClaimCustodyKeyringConfig>;
  readonly source?: NodeJS.ProcessEnv;
  readonly write?: (line: string) => void;
}

function writeStandardOutput(line: string): void {
  process.stdout.write(line);
}

/** Owns server bootstrap and process-signal cleanup behind injectable external inputs. */
export async function runServerProcess(
  options: ServerProcessOptions = {},
): Promise<void> {
  assertSupportedNodeVersion();
  const logger = new SafeLogger({
    now: () => new Date(),
    write: options.write ?? writeStandardOutput,
  });

  let config;
  try {
    config = decodeServerConfig(options.source ?? process.env);
  } catch (error: unknown) {
    logger.error('server.startup-failed', {
      reason: error instanceof ConfigError ? error.code : 'config-decode-failed',
    });
    process.exitCode = 1;
    return;
  }

  let keyring;
  try {
    keyring = await (options.loadKeyring ?? loadClaimCustodyKeyring)();
  } catch (error: unknown) {
    logger.error('server.startup-failed', {
      reason: error instanceof ClaimCustodyKeyringConfigError
        ? 'invalid-keyring'
        : 'keyring-unavailable',
    });
    process.exitCode = 1;
    return;
  }

  const application = createApplication({ config, keyring, logger });
  const shutdownState = { started: false };
  const shutdown = (_signal: NodeJS.Signals): void => {
    if (shutdownState.started) return;
    shutdownState.started = true;
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
    let closeFailed = false;
    try {
      await application.close();
    } catch {
      closeFailed = true;
    }
    process.exitCode = shutdownState.started && !closeFailed ? 0 : 1;
  }
}
