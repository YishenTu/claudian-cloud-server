import {
  isCollabProjectId,
  type CollabMemberId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import { CoordinationError } from '../../coordination/CoordinationError.js';
import type {
  ProjectCheckpointRecord,
} from '../../coordination/ProjectCheckpointPersistence.js';
import {
  RepositoryCheckpointError,
  type RepositoryCheckpointCapturePort,
} from '../../repositories/RepositoryCheckpointAuthority.js';
import {
  createRepositoryPlacementLease,
} from '../../repositories/RepositoryPlacement.js';
import {
  BackupExportCoordinatorError,
  type BackupExportMetadata,
  type BackupExportCheckpointSnapshot,
  type BackupExportCheckpointSource,
} from './BackupExportCoordinator.js';

export interface CloudBackupExportCheckpointSourceOptions {
  readonly metadata: BackupExportMetadata;
  readonly repository: Pick<RepositoryCheckpointCapturePort, 'inventoryRefs'>;
}

function fail(): never {
  throw new BackupExportCoordinatorError('dependency-failed');
}

function activeMemberIds(
  records: readonly ProjectCheckpointRecord[],
  projectId: CollabProjectId,
): readonly CollabMemberId[] {
  const ids = records.flatMap(record => (
    record.kind === 'member'
      && record.value.projectId === projectId
      && record.value.status === 'active'
      ? [record.value.memberId]
      : []
  )).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (ids.length === 0 || new Set(ids).size !== ids.length) fail();
  return Object.freeze(ids);
}

/** Captures SQL and exact Git refs while the BackupExportCoordinator owns the write lane. */
export class CloudBackupExportCheckpointSource
implements BackupExportCheckpointSource {
  readonly #metadata: BackupExportMetadata;
  readonly #repository: CloudBackupExportCheckpointSourceOptions['repository'];

  constructor(options: CloudBackupExportCheckpointSourceOptions) {
    this.#metadata = Object.freeze({ ...options.metadata });
    this.#repository = options.repository;
  }

  async snapshot(
    input: Parameters<BackupExportCheckpointSource['snapshot']>[0],
  ): Promise<BackupExportCheckpointSnapshot> {
    if (!isCollabProjectId(input.projectId)) fail();
    try {
      const logical = await input.lease.withProjectScope(async scope => {
        const project = await scope.getProject();
        const placement = await scope.getRepositoryPlacement();
        if (
          project === undefined
          || project.projectId !== input.projectId
          || project.serviceState !== 'maintenance'
          || placement === undefined
        ) fail();
        const records = await scope.checkpoint.readProjectCheckpointRecords({
          excludedOperationId: input.operationId,
          maximumCoordinationBytes:
            input.repositoryReservation.maximumCoordinationBytes,
          metadata: Object.freeze({
            authorityId: this.#metadata.authorityId,
            authorityVolumeIdentity: this.#metadata.authorityVolumeIdentity,
            coordinationSchemaVersion:
              this.#metadata.coordinationSchemaVersion,
            maximumServerBuild: this.#metadata.serverBuild,
            minimumServerBuild: this.#metadata.serverBuild,
            repositoryFormatVersion: this.#metadata.repositoryFormatVersion,
            restoreEpoch: this.#metadata.restoreEpoch,
          }),
          profile: input.profile,
          snapshotAt: input.snapshotAt,
        });
        return Object.freeze({
          placement: createRepositoryPlacementLease(placement),
          records,
        });
      }, {
        signal: input.signal,
        snapshot: 'repeatable-read',
      });
      const memberIds = activeMemberIds(logical.records, input.projectId);
      const refs = await this.#repository.inventoryRefs({
        memberIds,
        placement: logical.placement,
        signal: input.signal,
      }, input.repositoryReservation.repositoryReservation);
      return Object.freeze({ records: logical.records, refs });
    } catch (error: unknown) {
      if (error instanceof BackupExportCoordinatorError) throw error;
      if (error instanceof CoordinationError) {
        if (error.code === 'resource-limit') {
          throw new BackupExportCoordinatorError('resource-limit');
        }
        return fail();
      }
      if (error instanceof RepositoryCheckpointError) return fail();
      return fail();
    }
  }
}
