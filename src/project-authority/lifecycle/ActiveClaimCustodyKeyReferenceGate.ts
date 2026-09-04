import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  ActiveRepositoryPlacementPage,
  PinnedProjectLease,
} from '../../coordination/ProjectCoordination.js';
import type {
  ListRecoveryCandidatesOptions,
  RecoveryCandidatePage,
} from '../../coordination/DevelopmentBootstrapPersistence.js';
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
    listRecoveryCandidates(
      options?: ListRecoveryCandidatesOptions,
    ): Promise<RecoveryCandidatePage>;
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
    verify(
      records: readonly unknown[],
      profile?: 'project' | 'terminal',
    ): Promise<void>;
  }>;
}

function fail(): never {
  throw new Error('active-claim-custody-key-reference.error.unavailable');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) fail();
}

function decodedEvidence(value: string | undefined): unknown {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return fail();
    }
    return parsed;
  } catch {
    return fail();
  }
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
      const verifiedProjects = new Set<string>();
      let after: CollabProjectId | undefined;
      do {
        assertActive(signal);
        const page = await this.#coordination.listActiveRepositoryPlacements({
          ...(after === undefined ? {} : { after }),
          limit: 100,
        });
        for (const placement of page.placements) {
          verifiedProjects.add(placement.projectId);
          await this.#verifyProject(placement, metadata, signal);
        }
        after = page.nextCursor;
      } while (after !== undefined);
      let recoveryAfter: ListRecoveryCandidatesOptions['after'];
      do {
        assertActive(signal);
        const page = await this.#coordination.listRecoveryCandidates({
          ...(recoveryAfter === undefined ? {} : { after: recoveryAfter }),
          limit: 100,
        });
        for (const candidate of page.candidates) {
          if (
            candidate.kind === 'authority-transfer'
            && !verifiedProjects.has(candidate.projectId)
          ) {
            if (await this.#verifyRecoveryTransfer(
              candidate.projectId,
              candidate.operationId,
              signal,
            )) verifiedProjects.add(candidate.projectId);
          }
        }
        recoveryAfter = page.nextCursor;
      } while (recoveryAfter !== undefined);
      after = undefined;
      do {
        assertActive(signal);
        const page = await this.#coordination.listTerminalProjectContinuity({
          ...(after === undefined ? {} : { after }),
          limit: 100,
        });
        for (const projectId of page.projectIds) {
          if (!verifiedProjects.has(projectId)) {
            await this.#verifyTerminalProject(projectId, signal);
            verifiedProjects.add(projectId);
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
          (project?.serviceState !== 'active'
            && project?.serviceState !== 'read-only-transition')
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
    await this.#verifier.verify(records, 'project');
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
    await this.#verifier.verify(records, 'terminal');
  }

  async #verifyRecoveryTransfer(
    projectId: CollabProjectId,
    operationId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    let lease: PinnedProjectLease | undefined;
    let records: readonly unknown[] | undefined;
    let failure: unknown;
    try {
      lease = await this.#coordination.acquireProjectLease(projectId, { signal });
      const result = await lease.withProjectScope(async scope => {
        const journal = await scope.portability.getLifecycleJournal(operationId);
        if (
          journal?.kind !== 'authority-transfer'
          || journal.operationId !== operationId
          || journal.projectId !== projectId
          || (journal.direction !== 'cloud-to-lan'
            && journal.direction !== 'lan-to-cloud')
        ) return fail();
        const recovery = await scope.portability.getAuthorityTransferRecovery(
          operationId,
        );
        if (
          recovery === undefined
          || recovery.transferId !== operationId
          || recovery.sourceAuthority.kind
            !== (journal.direction === 'cloud-to-lan' ? 'cloud' : 'lan')
          || recovery.targetAuthority.kind
            !== (journal.direction === 'cloud-to-lan' ? 'lan' : 'cloud')
        ) return fail();
        const continuity = await scope.checkpoint.readTerminalProjectContinuityRecords({
          maximumCoordinationBytes:
            COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
        });
        return Object.freeze({
          records: Object.freeze([
            ...continuity,
            Object.freeze({
              kind: 'lifecycle-journal',
              value: Object.freeze({
                direction: journal.direction,
                operationId: journal.operationId,
                operationKind: journal.kind,
              }),
            }),
            Object.freeze({
              kind: 'authority-transfer-recovery',
              value: Object.freeze({
                relinquishmentProof: recovery.relinquishmentProof ?? null,
                sourceAuthority: recovery.sourceAuthority,
                sourceEvidence: decodedEvidence(recovery.sourceProof),
                targetAuthority: recovery.targetAuthority,
                targetEvidence: decodedEvidence(recovery.targetProof),
                transferId: recovery.transferId,
              }),
            }),
          ]),
        });
      }, { signal, snapshot: 'repeatable-read' });
      records = result.records;
    } catch (error: unknown) {
      failure = error;
    }
    try {
      await lease?.close();
    } catch (error: unknown) {
      failure = error;
    }
    if (failure !== undefined) fail();
    if (records === undefined) fail();
    await this.#verifier.verify(records, 'project');
    return true;
  }
}
