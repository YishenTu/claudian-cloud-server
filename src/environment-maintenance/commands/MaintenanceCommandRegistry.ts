export const MAINTENANCE_COMMANDS = Object.freeze([
  'backup',
  'verify-backup',
  'restore',
  'recover-restore',
  'export-project',
  'reconcile-exports',
  'resume-delete',
  'verify-authority',
  'migration',
] as const);

export type MaintenanceCommand = typeof MAINTENANCE_COMMANDS[number];

export type MaintenanceCommandErrorCode = 'cancelled' | 'invalid-command';

export class MaintenanceCommandError extends Error {
  readonly code: MaintenanceCommandErrorCode;

  constructor(code: MaintenanceCommandErrorCode) {
    super(`maintenance-command.error.${code}`);
    this.name = 'MaintenanceCommandError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
    });
  }
}

export interface MaintenanceCommandInput {
  readonly arguments: readonly string[];
  readonly signal: AbortSignal;
}

export type MaintenanceCommandHandler = (
  input: MaintenanceCommandInput,
) => Promise<void>;

export type MaintenanceCommandHandlers = Readonly<Record<
  string,
  MaintenanceCommandHandler
>>;

function command(value: string | undefined): MaintenanceCommand {
  if (
    value === undefined
    || !MAINTENANCE_COMMANDS.includes(value as MaintenanceCommand)
  ) {
    throw new MaintenanceCommandError('invalid-command');
  }
  return value as MaintenanceCommand;
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new MaintenanceCommandError('cancelled');
}

export class MaintenanceCommandRegistry {
  readonly #handlers: MaintenanceCommandHandlers;

  constructor(handlers: MaintenanceCommandHandlers) {
    const keys = Object.keys(handlers).sort();
    const expected = [...MAINTENANCE_COMMANDS].sort();
    if (
      keys.length !== expected.length
      || !keys.every((key, index) => key === expected[index])
      || MAINTENANCE_COMMANDS.some(item => typeof handlers[item] !== 'function')
    ) {
      throw new TypeError('maintenance-command-registry.handlers-invalid');
    }
    this.#handlers = Object.freeze({ ...handlers });
  }

  async run(
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    assertActive(signal);
    const selected = command(arguments_[0]);
    const handler = this.#handlers[selected];
    if (handler === undefined) throw new MaintenanceCommandError('invalid-command');
    await handler(Object.freeze({
      arguments: Object.freeze(arguments_.slice(1)),
      signal,
    }));
    assertActive(signal);
  }
}
