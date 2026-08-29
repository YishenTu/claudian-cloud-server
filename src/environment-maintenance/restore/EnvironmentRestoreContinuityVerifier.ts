import type {
  CollabCheckpointProtectedClaimEnvelopeRecord,
  CollabIsoTimestamp,
  CollabProjectBackupRecord,
} from '@claudian-collab/protocol';

import {
  EnvironmentRestoreCoordinatorError,
  type EnvironmentRestoreCatalog,
  type EnvironmentRestoreContinuityPort,
  type EnvironmentRestoreProject,
  type EnvironmentRestoreTerminalProject,
} from './EnvironmentRestoreCoordinator.js';
import type {
  EnvironmentProjectBackupSource,
  EnvironmentTerminalProjectBackupSource,
} from './PublishedEnvironmentBackupSource.js';

export interface EnvironmentRestoreClaimCustodyPort {
  open(envelope: Readonly<
    CollabCheckpointProtectedClaimEnvelopeRecord['value'] & {
      readonly createdAt: CollabIsoTimestamp;
    }
  >): Promise<string>;
}

export interface EnvironmentRestoreContinuityStoragePort {
  readRestoredContinuity(
    project: EnvironmentRestoreProject,
    signal: AbortSignal,
  ): Promise<readonly CollabProjectBackupRecord[]>;
  readRestoredTerminalContinuity?(
    projectId: EnvironmentRestoreTerminalProject['projectId'],
    signal: AbortSignal,
  ): Promise<readonly CollabProjectBackupRecord[]>;
}

export interface EnvironmentRestoreContinuityVerifierOptions {
  readonly clock?: () => Date;
  readonly custody: EnvironmentRestoreClaimCustodyPort;
  readonly source: EnvironmentProjectBackupSource
    & Partial<EnvironmentTerminalProjectBackupSource>;
  readonly storage: EnvironmentRestoreContinuityStoragePort;
}

type ContinuityRecord = Extract<CollabProjectBackupRecord, {
  readonly kind:
    | 'protected-claim-envelope'
    | 'terminal-principal'
    | 'terminal-responder'
    | 'terminal-responder-replay'
    | 'transfer-claim-batch-receipt'
    | 'transfer-receipt-key'
    | 'transfer-redemption-receipt'
    | 'transferred-membership-claim';
}>;

const CONTINUITY_KINDS = new Set<CollabProjectBackupRecord['kind']>([
  'protected-claim-envelope',
  'terminal-principal',
  'terminal-responder',
  'terminal-responder-replay',
  'transfer-claim-batch-receipt',
  'transfer-receipt-key',
  'transfer-redemption-receipt',
  'transferred-membership-claim',
]);

function fail(): never {
  throw new EnvironmentRestoreCoordinatorError('continuity-unavailable');
}

function continuityRecords(
  records: readonly CollabProjectBackupRecord[],
): readonly ContinuityRecord[] {
  return records.filter(
    (record): record is ContinuityRecord => CONTINUITY_KINDS.has(record.kind),
  );
}

/** Verifies key and terminal continuity before creation and after restore. */
export class EnvironmentRestoreContinuityVerifier
implements EnvironmentRestoreContinuityPort {
  readonly #clock: () => Date;
  readonly #custody: EnvironmentRestoreClaimCustodyPort;
  readonly #source: EnvironmentProjectBackupSource
    & Partial<EnvironmentTerminalProjectBackupSource>;
  readonly #storage: EnvironmentRestoreContinuityStoragePort;

  constructor(options: EnvironmentRestoreContinuityVerifierOptions) {
    if (
      typeof options.custody.open !== 'function'
      || typeof options.source.readProjectBackup !== 'function'
      || typeof options.storage.readRestoredContinuity !== 'function'
      || (options.clock !== undefined && typeof options.clock !== 'function')
    ) throw new TypeError('environment-restore-continuity.options-invalid');
    this.#clock = options.clock ?? (() => new Date());
    this.#custody = options.custody;
    this.#source = options.source;
    this.#storage = options.storage;
  }

  async verifyBeforeCreation(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly signal: AbortSignal;
  }>): Promise<void> {
    try {
      for (const project of input.catalog.projects) {
        const backup = await this.#source.readProjectBackup({
          project,
          signal: input.signal,
        });
        await this.#verifyRecords(
          backup.records,
          input.catalog.createdAt,
          input.signal,
        );
      }
      for (const terminalProject of input.catalog.terminalProjects) {
        const readTerminal = this.#source.readTerminalProjectBackup;
        if (readTerminal === undefined) return fail();
        const backup = await readTerminal.call(this.#source, {
          signal: input.signal,
          terminalProject,
        });
        await this.#verifyRecords(
          backup.records,
          input.catalog.createdAt,
          input.signal,
        );
      }
    } catch (error: unknown) {
      if (
        error instanceof EnvironmentRestoreCoordinatorError
        && error.code === 'continuity-unavailable'
      ) throw error;
      return fail();
    }
  }

  async verifyRestored(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly signal: AbortSignal;
  }>): Promise<void> {
    try {
      for (const project of input.catalog.projects) {
        const backup = await this.#source.readProjectBackup({
          project,
          signal: input.signal,
        });
        const expected = continuityRecords(backup.records);
        const restored = continuityRecords(
          await this.#storage.readRestoredContinuity(
            project,
            input.signal,
          ),
        );
        if (JSON.stringify(restored) !== JSON.stringify(expected)) return fail();
        await this.#verifyRecords(restored, input.catalog.createdAt, input.signal);
      }
      for (const terminalProject of input.catalog.terminalProjects) {
        if (
          this.#source.readTerminalProjectBackup === undefined
          || this.#storage.readRestoredTerminalContinuity === undefined
        ) return fail();
        const backup = await this.#source.readTerminalProjectBackup({
          signal: input.signal,
          terminalProject,
        });
        const expected = continuityRecords(backup.records);
        const restored = continuityRecords(
          await this.#storage.readRestoredTerminalContinuity(
            terminalProject.projectId,
            input.signal,
          ),
        );
        if (JSON.stringify(restored) !== JSON.stringify(expected)) return fail();
        await this.#verifyRecords(restored, input.catalog.createdAt, input.signal);
      }
    } catch (error: unknown) {
      if (
        error instanceof EnvironmentRestoreCoordinatorError
        && error.code === 'continuity-unavailable'
      ) throw error;
      return fail();
    }
  }

  async #verifyRecords(
    records: readonly CollabProjectBackupRecord[],
    createdAt: CollabIsoTimestamp,
    signal: AbortSignal,
  ): Promise<void> {
    const receiptKeys = records.filter(record => record.kind === 'transfer-receipt-key');
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) return fail();
    for (const record of records) {
      if (record.kind !== 'protected-claim-envelope') continue;
      if (Date.parse(record.value.expiresAt) <= now.valueOf()) continue;
      if (signal.aborted) return fail();
      const keys = receiptKeys.filter(key => (
        key.value.transferId === record.value.transferId
        && key.value.receiptKeyId === record.value.receiptKeyId
      ));
      if (keys.length !== 1) return fail();
      await this.#custody.open(Object.freeze({
        ...record.value,
        createdAt,
      }));
    }
  }
}
