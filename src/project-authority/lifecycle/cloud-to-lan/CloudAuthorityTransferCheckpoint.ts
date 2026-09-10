import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
} from '@claudian-collab/protocol';

import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../../../config/PostgresSchemaCompatibility.js';
import { REPOSITORY_FORMAT_VERSION, SERVER_BUILD } from '../../../config/ServerBuild.js';
import type { EnvironmentBackupMetadataSource } from '../../../environment-maintenance/commands/EnvironmentBackupMetadataSource.js';
import { createRepositoryPlacementLease } from '../../../repositories/RepositoryPlacement.js';
import type { RepositoryCheckpointCapturePort } from '../../../repositories/RepositoryCheckpointAuthority.js';
import type { ProjectCheckpointCoordinator } from '../../checkpoint/ProjectCheckpointCoordinator.js';
import type {
  CapturedCloudToLanCheckpoint,
  CloudToLanCheckpointCapturePort,
} from './CloudToLanTransferCoordinator.js';

export interface CloudAuthorityTransferCheckpointOptions {
  readonly checkpoint: Pick<
    ProjectCheckpointCoordinator,
    'captureOutbound' | 'discardOutboundOperation' | 'reserveOutbound'
  >;
  readonly metadata: Pick<EnvironmentBackupMetadataSource, 'read'>;
  readonly repository: Pick<RepositoryCheckpointCapturePort, 'inventoryRefs'>;
}

/** Captures one portable logical/Repository snapshot while the transfer owns the Project lane. */
export class CloudAuthorityTransferCheckpoint
implements CloudToLanCheckpointCapturePort {
  readonly #checkpoint: CloudAuthorityTransferCheckpointOptions['checkpoint'];
  readonly #metadata: CloudAuthorityTransferCheckpointOptions['metadata'];
  readonly #repository: CloudAuthorityTransferCheckpointOptions['repository'];

  constructor(options: CloudAuthorityTransferCheckpointOptions) {
    this.#checkpoint = options.checkpoint;
    this.#metadata = options.metadata;
    this.#repository = options.repository;
  }

  async capture(input: Parameters<CloudToLanCheckpointCapturePort['capture']>[0]): Promise<
    CapturedCloudToLanCheckpoint
  > {
    const reservation = await this.#checkpoint.reserveOutbound(input.projectId);
    try {
      const metadata = await this.#metadata.read();
      const snapshot = await input.lease.withProjectScope(async scope => {
        const journal = await scope.portability.getLifecycleJournal(input.operationId);
        const memberships = await scope.listMemberships();
        const placement = await scope.getRepositoryPlacement();
        const project = await scope.getProject();
        if (
          journal?.kind !== 'authority-transfer'
          || journal.direction !== 'cloud-to-lan'
          || journal.projectId !== input.projectId
          || project?.projectId !== input.projectId
          || project.authorityGeneration !== input.sourceAuthority.generation
          || project.serviceState !== 'read-only-transition'
          || project.expectedMainOid.length === 0
          || placement?.active !== true
        ) throw new Error('cloud-authority-transfer-checkpoint.invalid-state');
        const records = await scope.checkpoint.readProjectCheckpointRecords({
          excludedOperationId: input.operationId,
          maximumCoordinationBytes:
            COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
          metadata: {
            authorityId: metadata.authorityId,
            authorityVolumeIdentity: metadata.authorityVolumeIdentity,
            coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
            maximumServerBuild: SERVER_BUILD,
            minimumServerBuild: SERVER_BUILD,
            repositoryFormatVersion: REPOSITORY_FORMAT_VERSION,
            restoreEpoch: metadata.restoreEpoch,
          },
          profile: 'authority-transfer',
          snapshotAt: journal.updatedAt,
        });
        return Object.freeze({
          createdAt: journal.createdAt,
          expectedMainOid: project.expectedMainOid,
          memberIds: Object.freeze(memberships
            .filter(member => member.status === 'active')
            .map(member => member.memberId)
            .sort((left, right) => left.localeCompare(right, 'en-US'))),
          placement: createRepositoryPlacementLease(placement),
          records,
        });
      }, { snapshot: 'repeatable-read' });
      const refs = await this.#repository.inventoryRefs({
        memberIds: snapshot.memberIds,
        placement: snapshot.placement,
      }, reservation.repositoryReservation);
      const checkpoint = await this.#checkpoint.captureOutbound({
        createdAt: snapshot.createdAt,
        expectedMainOid: snapshot.expectedMainOid,
        expiresAt: input.expiresAt,
        onProgress: () => undefined,
        operationId: input.operationId,
        placement: snapshot.placement,
        profile: 'authority-transfer',
        projectId: input.projectId,
        records: snapshot.records,
        refs,
        sourceAuthority: input.sourceAuthority,
        targetAuthority: input.targetAuthority,
      }, reservation);
      return Object.freeze({
        checkpointSha256: checkpoint.manifest.manifestSha256,
        expiresAt: input.expiresAt,
        operationId: input.operationId,
        projectId: input.projectId,
      });
    } finally {
      await reservation.close();
    }
  }

  async discard(input: CapturedCloudToLanCheckpoint): Promise<'removed' | 'replayed'> {
    await this.#checkpoint.discardOutboundOperation({
      expiresAt: input.expiresAt,
      operationId: input.operationId,
      profile: 'authority-transfer',
      projectId: input.projectId,
    });
    return 'removed';
  }
}
