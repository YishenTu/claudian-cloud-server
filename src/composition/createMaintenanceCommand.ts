import type { ConfigSource } from '../config/configDecoder.js';
import {
  MaintenanceCommandError,
  MaintenanceCommandRegistry,
  type MaintenanceCommandHandler,
} from '../environment-maintenance/commands/MaintenanceCommandRegistry.js';
import {
  runMigrationMaintenanceCommand,
  type MigrationMaintenanceCommandResult,
} from '../environment-maintenance/commands/MigrationMaintenanceCommand.js';
import {
  createMaintenanceOperations,
  type MaintenanceOperations,
} from './MaintenanceOperations.js';

export interface CreateMaintenanceCommandOptions {
  readonly operations?: MaintenanceOperations;
  readonly source: ConfigSource;
  readonly write: (line: string) => void;
}

export interface MaintenanceCommandRuntime {
  run(
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<MigrationMaintenanceCommandResult>;
}

function operationHandler(
  operation: (signal: AbortSignal) => Promise<void>,
): MaintenanceCommandHandler {
  return async input => {
    if (input.arguments.length !== 0) {
      throw new MaintenanceCommandError('invalid-command');
    }
    await operation(input.signal);
  };
}

export function createMaintenanceCommand(
  options: CreateMaintenanceCommandOptions,
): MaintenanceCommandRuntime {
  let migrationResult: MigrationMaintenanceCommandResult = 'complete';
  const migration: MaintenanceCommandHandler = async input => {
    migrationResult = await runMigrationMaintenanceCommand({
      arguments: input.arguments,
      signal: input.signal,
      source: options.source,
      write: options.write,
    });
  };
  const operations = options.operations ?? createMaintenanceOperations({
    source: options.source,
  });
  const registry = new MaintenanceCommandRegistry({
    backup: operationHandler(signal => operations.backup(signal)),
    'export-project': operationHandler(signal => operations.exportProject(signal)),
    migration,
    'reconcile-exports': operationHandler(signal => operations.reconcileExports(signal)),
    'recover-restore': operationHandler(signal => operations.recoverRestore(signal)),
    'restore': operationHandler(signal => operations.restore(signal)),
    'resume-delete': operationHandler(signal => operations.resumeDelete(signal)),
    'verify-authority': operationHandler(signal => operations.verifyAuthority(signal)),
    'verify-backup': operationHandler(signal => operations.verifyBackup(signal)),
  });
  return Object.freeze({
    async run(
      arguments_: readonly string[],
      signal: AbortSignal,
    ): Promise<MigrationMaintenanceCommandResult> {
      migrationResult = 'complete';
      await registry.run(arguments_, signal);
      return migrationResult;
    },
  });
}
