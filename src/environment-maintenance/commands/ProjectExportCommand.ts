import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabIsoTimestamp,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  BackupExportCoordinator,
  BackupExportResult,
} from '../../project-authority/checkpoint/BackupExportCoordinator.js';
import { invalidMaintenanceOperationInput } from './MaintenanceOperationCommandError.js';

export interface ProjectExportCommandOptions {
  readonly clock?: () => Date;
  readonly coordinator: Pick<
    BackupExportCoordinator,
    'create' | 'reconcileExpiredExportDeliveries' | 'settleExportDelivery'
  >;
  readonly delivery: Readonly<{
    deliver(
      input: BackupExportResult & Readonly<{ readonly signal: AbortSignal }>,
    ): Promise<void>;
  }>;
}

function timestamp(value: string): value is CollabIsoTimestamp {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

const SETTLEMENT_TIMEOUT_MS = 30_000;

function settlementSignal(): AbortSignal {
  return AbortSignal.timeout(SETTLEMENT_TIMEOUT_MS);
}

export class ProjectExportCommand {
  readonly #clock: () => Date;
  readonly #coordinator: ProjectExportCommandOptions['coordinator'];
  readonly #delivery: ProjectExportCommandOptions['delivery'];

  constructor(options: ProjectExportCommandOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#coordinator = options.coordinator;
    this.#delivery = options.delivery;
  }

  async run(input: Readonly<{
    readonly expiresAt: CollabIsoTimestamp;
    readonly operationId: string;
    readonly projectId: CollabProjectId;
    readonly signal: AbortSignal;
  }>): Promise<BackupExportResult> {
    if (
      !timestamp(input.expiresAt)
      || !isCollabOpaqueId(input.operationId)
      || !isCollabProjectId(input.projectId)
      || input.signal.aborted
    ) return invalidMaintenanceOperationInput();
    const expiredBefore = this.#clock();
    if (Number.isNaN(expiredBefore.valueOf())) {
      return invalidMaintenanceOperationInput();
    }
    await this.#coordinator.reconcileExpiredExportDeliveries({
      expiredBefore: expiredBefore.toISOString(),
      signal: input.signal,
    });
    const result = await this.#coordinator.create({
      expiresAt: input.expiresAt,
      operationId: input.operationId,
      profile: 'export',
      projectId: input.projectId,
      signal: input.signal,
    });
    try {
      await this.#delivery.deliver(Object.freeze({
        ...result,
        signal: input.signal,
      }));
    } catch (error: unknown) {
      if (aborted(input.signal)) {
        await this.#coordinator.settleExportDelivery({
          operationId: input.operationId,
          projectId: input.projectId,
          reason: 'cancelled',
          signal: settlementSignal(),
        }).catch(() => undefined);
      }
      throw error;
    }
    await this.#coordinator.settleExportDelivery({
      operationId: input.operationId,
      projectId: input.projectId,
      reason: 'completed',
      signal: settlementSignal(),
    });
    return result;
  }
}
