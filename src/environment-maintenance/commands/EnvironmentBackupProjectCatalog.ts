import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  ActiveRepositoryPlacementPage,
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
} from '../../coordination/ProjectCoordination.js';
import type { EnvironmentBackupProjectCatalogPort } from './EnvironmentBackupCommand.js';
import type { TerminalProjectContinuityRecord } from '../../coordination/ProjectCheckpointPersistence.js';

interface TerminalProjectContinuityCatalog {
  list(input: Readonly<{
    readonly after?: CollabProjectId;
    readonly limit: number;
    readonly signal: AbortSignal;
  }>): Promise<Readonly<{
    readonly nextCursor: CollabProjectId | undefined;
    readonly projectIds: readonly CollabProjectId[];
  }>>;
}

export interface EnvironmentBackupProjectCatalogOptions {
  readonly coordination: Readonly<{
    acquireProjectLease(
      projectId: CollabProjectId,
      options?: AcquireProjectLeaseOptions,
    ): Promise<PinnedProjectLease>;
    listActiveRepositoryPlacements(options?: Readonly<{
      readonly after?: CollabProjectId;
      readonly limit?: number;
    }>): Promise<ActiveRepositoryPlacementPage>;
    listTerminalProjectContinuity(options?: Readonly<{
      readonly after?: CollabProjectId;
      readonly limit?: number;
    }>): Promise<Readonly<{
      readonly nextCursor: CollabProjectId | undefined;
      readonly projectIds: readonly CollabProjectId[];
    }>>;
  }>;
  readonly terminalCatalog?: TerminalProjectContinuityCatalog;
}

function fail(): never {
  throw new Error('environment-backup-project-catalog.error.unavailable');
}

async function close(lease: PinnedProjectLease | undefined): Promise<void> {
  try {
    await lease?.close();
  } catch {
    return fail();
  }
}

export class EnvironmentBackupProjectCatalog
implements EnvironmentBackupProjectCatalogPort {
  readonly #coordination: EnvironmentBackupProjectCatalogOptions['coordination'];
  readonly #terminalCatalog: TerminalProjectContinuityCatalog | undefined;

  constructor(options: EnvironmentBackupProjectCatalogOptions) {
    this.#coordination = options.coordination;
    this.#terminalCatalog = options.terminalCatalog;
  }

  async list(input: Readonly<{
    readonly after?: CollabProjectId;
  }>): ReturnType<EnvironmentBackupProjectCatalogPort['list']> {
    const page = await this.#coordination.listActiveRepositoryPlacements({
      ...(input.after === undefined ? {} : { after: input.after }),
      limit: 100,
    });
    return Object.freeze({
      nextCursor: page.nextCursor,
      projectIds: Object.freeze(page.placements.map(item => item.projectId)),
    });
  }

  async readFacts(projectId: CollabProjectId, backupId: string): ReturnType<
    EnvironmentBackupProjectCatalogPort['readFacts']
  > {
    let lease: PinnedProjectLease | undefined;
    try {
      const acquired = await this.#coordination.acquireProjectLease(projectId);
      lease = acquired;
      return await acquired.withProjectScope(async scope => {
        const backup = await scope.portability.getBackupCatalogEntry(backupId);
        if (
          backup === undefined
          || backup.backupId !== backupId
          || backup.state !== 'published'
        ) return fail();
        return Object.freeze({
          authorityGeneration: backup.authorityGeneration,
          placementGeneration: backup.placementGeneration,
        });
      });
    } finally {
      await close(lease);
    }
  }

  async listTerminal(input: Readonly<{
    readonly after?: CollabProjectId;
    readonly signal: AbortSignal;
  }>): Promise<Readonly<{
    readonly nextCursor: CollabProjectId | undefined;
    readonly projectIds: readonly CollabProjectId[];
  }>> {
    if (this.#terminalCatalog !== undefined) {
      return this.#terminalCatalog.list({
        ...(input.after === undefined ? {} : { after: input.after }),
        limit: 100,
        signal: input.signal,
      });
    }
    return this.#coordination.listTerminalProjectContinuity({
      ...(input.after === undefined ? {} : { after: input.after }),
      limit: 100,
    });
  }

  async readTerminalRecords(projectId: CollabProjectId): Promise<
    readonly TerminalProjectContinuityRecord[]
  > {
    let lease: PinnedProjectLease | undefined;
    try {
      lease = await this.#coordination.acquireProjectLease(projectId);
      return await lease.withProjectScope(scope => (
        scope.checkpoint.readTerminalProjectContinuityRecords({
          maximumCoordinationBytes:
            COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
        })
      ), { snapshot: 'repeatable-read' });
    } finally {
      await close(lease);
    }
  }
}
