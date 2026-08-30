import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  ActiveRepositoryPlacementPage,
  PinnedProjectLease,
} from '../../coordination/ProjectCoordination.js';
import {
  sameRepositoryPlacement,
  type RepositoryPlacementLease,
} from '../../repositories/RepositoryPlacement.js';

export interface ActiveClaimCustodyKeyReferenceMetadata {
  readonly authorityId: string;
  readonly authorityVolumeIdentity: string;
  readonly coordinationSchemaVersion: number;
  readonly repositoryFormatVersion: number;
  readonly restoreEpoch: number;
  readonly serverBuild: string;
}

export interface ActiveClaimCustodyKeyReferenceGateOptions {
  readonly coordination: Readonly<{
    acquireProjectLease(
      projectId: CollabProjectId,
      options?: Readonly<{ readonly signal?: AbortSignal }>,
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
  readonly metadata: Readonly<{
    read(): Promise<ActiveClaimCustodyKeyReferenceMetadata>;
  }>;
  readonly verifier: Readonly<{
    verify(records: readonly unknown[]): Promise<void>;
  }>;
}

function fail(): never {
  throw new Error('active-claim-custody-key-reference.error.unavailable');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) fail();
}

/** Holds readiness closed until every live protected-key reference is retained. */
export class ActiveClaimCustodyKeyReferenceGate {
  readonly #coordination: ActiveClaimCustodyKeyReferenceGateOptions['coordination'];
  readonly #metadata: ActiveClaimCustodyKeyReferenceGateOptions['metadata'];
  readonly #verifier: ActiveClaimCustodyKeyReferenceGateOptions['verifier'];

  constructor(options: ActiveClaimCustodyKeyReferenceGateOptions) {
    this.#coordination = options.coordination;
    this.#metadata = options.metadata;
    this.#verifier = options.verifier;
  }

  async verifyAll(signal: AbortSignal): Promise<void> {
    try {
      assertActive(signal);
      const metadata = await this.#metadata.read();
      const activeProjects = new Set<string>();
      let after: CollabProjectId | undefined;
      do {
        assertActive(signal);
        const page = await this.#coordination.listActiveRepositoryPlacements({
          ...(after === undefined ? {} : { after }),
          limit: 100,
        });
        for (const placement of page.placements) {
          activeProjects.add(placement.projectId);
          await this.#verifyProject(placement, metadata, signal);
        }
        after = page.nextCursor;
      } while (after !== undefined);
      after = undefined;
      do {
        assertActive(signal);
        const page = await this.#coordination.listTerminalProjectContinuity({
          ...(after === undefined ? {} : { after }),
          limit: 100,
        });
        for (const projectId of page.projectIds) {
          if (!activeProjects.has(projectId)) {
            await this.#verifyTerminalProject(projectId, signal);
          }
        }
        after = page.nextCursor;
      } while (after !== undefined);
    } catch (error: unknown) {
      if (
        error instanceof Error
        && error.message === 'active-claim-custody-key-reference.error.unavailable'
      ) throw error;
      return fail();
    }
  }

  async #verifyProject(
    expectedPlacement: RepositoryPlacementLease,
    metadata: ActiveClaimCustodyKeyReferenceMetadata,
    signal: AbortSignal,
  ): Promise<void> {
    let lease: PinnedProjectLease | undefined;
    let records: readonly unknown[] | undefined;
    let failure: unknown;
    try {
      lease = await this.#coordination.acquireProjectLease(
        expectedPlacement.projectId,
        { signal },
      );
      records = await lease.withProjectScope(async scope => {
        const [project, placement] = await Promise.all([
          scope.getProject(),
          scope.getRepositoryPlacement(),
        ]);
        if (
          project?.serviceState !== 'active'
          || placement === undefined
          || !sameRepositoryPlacement(placement, expectedPlacement)
        ) return fail();
        return await scope.checkpoint.readProjectCheckpointRecords({
          maximumCoordinationBytes:
            COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
          metadata: Object.freeze({
            authorityId: metadata.authorityId,
            authorityVolumeIdentity: metadata.authorityVolumeIdentity,
            coordinationSchemaVersion: metadata.coordinationSchemaVersion,
            maximumServerBuild: metadata.serverBuild,
            minimumServerBuild: metadata.serverBuild,
            repositoryFormatVersion: metadata.repositoryFormatVersion,
            restoreEpoch: metadata.restoreEpoch,
          }),
          profile: 'backup',
          snapshotAt: new Date().toISOString(),
        });
      }, { signal, snapshot: 'repeatable-read' });
    } catch (error: unknown) {
      failure = error;
    }
    try {
      await lease?.close();
    } catch (error: unknown) {
      failure = error;
    }
    if (failure !== undefined || records === undefined) fail();
    await this.#verifier.verify(records);
  }

  async #verifyTerminalProject(
    projectId: CollabProjectId,
    signal: AbortSignal,
  ): Promise<void> {
    let lease: PinnedProjectLease | undefined;
    let records: readonly unknown[] | undefined;
    let failure: unknown;
    try {
      lease = await this.#coordination.acquireProjectLease(projectId, { signal });
      records = await lease.withProjectScope(scope => (
        scope.checkpoint.readTerminalProjectContinuityRecords({
          maximumCoordinationBytes:
            COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
        })
      ), { signal, snapshot: 'repeatable-read' });
    } catch (error: unknown) {
      failure = error;
    }
    try {
      await lease?.close();
    } catch (error: unknown) {
      failure = error;
    }
    if (failure !== undefined || records === undefined) fail();
    await this.#verifier.verify(records);
  }
}
