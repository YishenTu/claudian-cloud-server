export class MaintenanceOperationCommandError extends Error {
  readonly code = 'invalid-input' as const;

  constructor() {
    super('maintenance-operation-command.error.invalid-input');
    this.name = 'MaintenanceOperationCommandError';
  }
}

export function invalidMaintenanceOperationInput(): never {
  throw new MaintenanceOperationCommandError();
}
