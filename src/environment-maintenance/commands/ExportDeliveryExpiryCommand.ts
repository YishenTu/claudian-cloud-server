import type { BackupExportCoordinator } from '../../project-authority/checkpoint/BackupExportCoordinator.js';

export interface ExportDeliveryExpiryCommandOptions {
  readonly clock?: () => Date;
  readonly coordinator: Pick<
    BackupExportCoordinator,
    'reconcileExpiredExportDeliveries'
  >;
}

/** One bounded operator-scheduled pass over expired export deliveries. */
export class ExportDeliveryExpiryCommand {
  readonly #clock: () => Date;
  readonly #coordinator: ExportDeliveryExpiryCommandOptions['coordinator'];

  constructor(options: ExportDeliveryExpiryCommandOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordinator = options.coordinator;
  }

  run(signal: AbortSignal): Promise<Readonly<{ readonly removed: number }>> {
    const observed = this.#clock();
    if (Number.isNaN(observed.valueOf())) {
      return Promise.reject(new Error('export-delivery-expiry-command.clock-invalid'));
    }
    return this.#coordinator.reconcileExpiredExportDeliveries({
      expiredBefore: observed.toISOString(),
      signal,
    });
  }
}
