import { createHash } from 'node:crypto';

import { importRepositoryCheckpoint } from '../../repositories/importRepositoryCheckpoint.js';
import type {
  RepositoryRestoreStagingPort,
  ValidatedRepositoryCheckpoint,
} from '../../repositories/GitBundleImporter.js';
import type {
  InactiveRepositoryPublication,
  InactiveRepositoryPublicationPort,
} from '../../repositories/RepositoryCheckpointAuthority.js';
import {
  EnvironmentRestoreCoordinatorError,
  type EnvironmentRestoreProject,
  type EnvironmentRestoreRepositoryPort,
  type EnvironmentRestoreRepositoryPublication,
} from './EnvironmentRestoreCoordinator.js';
import type {
  EnvironmentProjectBackupSource,
} from './PublishedEnvironmentBackupSource.js';

export interface EnvironmentRestoreRepositoryInspectionPort {
  assertEmpty(signal: AbortSignal): Promise<void>;
}

export interface EnvironmentRestoreRepositoryAdapterOptions {
  readonly inspection: EnvironmentRestoreRepositoryInspectionPort;
  readonly publication: InactiveRepositoryPublicationPort;
  readonly source: EnvironmentProjectBackupSource;
  readonly staging: RepositoryRestoreStagingPort;
}

function fail(): never {
  throw new EnvironmentRestoreCoordinatorError('dependency-failed');
}

function storageKey(operationId: string, projectId: string): string {
  return `restore-${createHash('sha256')
    .update(`${operationId}\0${projectId}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

function environmentPublication(
  publication: InactiveRepositoryPublication,
): EnvironmentRestoreRepositoryPublication {
  return Object.freeze({ ...publication });
}

function inactivePublication(
  publication: EnvironmentRestoreRepositoryPublication,
): InactiveRepositoryPublication {
  return Object.freeze({ ...publication });
}

function replayedCheckpoint(
  publication: EnvironmentRestoreRepositoryPublication,
): ValidatedRepositoryCheckpoint {
  return Object.freeze({
    artifactKey: publication.artifactKey,
    bundleByteCount: publication.bundleByteCount,
    bundleInputDisposition: 'replayed',
    bundleSha256: publication.bundleSha256,
    markerSha256: publication.validationMarkerSha256,
    objectFormat: publication.objectFormat,
    operationId: publication.operationId,
    projectId: publication.projectId,
    refs: publication.refs,
  });
}

function sameRefs(
  left: EnvironmentRestoreRepositoryPublication['refs'],
  right: EnvironmentRestoreRepositoryPublication['refs'],
): boolean {
  if (left.length !== right.length) return false;
  for (const [index, ref] of left.entries()) {
    const expected = right[index];
    if (
      expected === undefined
      || ref.name !== expected.name
      || ref.oid !== expected.oid
    ) return false;
  }
  return true;
}

function samePublication(
  left: EnvironmentRestoreRepositoryPublication,
  right: EnvironmentRestoreRepositoryPublication,
): boolean {
  return left.artifactKey === right.artifactKey
    && left.bundleByteCount === right.bundleByteCount
    && left.bundleSha256 === right.bundleSha256
    && left.objectFormat === right.objectFormat
    && left.operationId === right.operationId
    && left.placementGeneration === right.placementGeneration
    && left.projectId === right.projectId
    && left.publicationMarkerSha256 === right.publicationMarkerSha256
    && left.repositoryStorageKey === right.repositoryStorageKey
    && (left as { readonly status: unknown }).status === right.status
    && left.storageNodeId === right.storageNodeId
    && left.validationMarkerSha256 === right.validationMarkerSha256
    && sameRefs(left.refs, right.refs);
}

/** Adapts canonical backup artifacts to repository-owned staging/publish. */
export class EnvironmentRestoreRepositoryAdapter
implements EnvironmentRestoreRepositoryPort {
  readonly #inspection: EnvironmentRestoreRepositoryInspectionPort;
  readonly #publication: InactiveRepositoryPublicationPort;
  readonly #source: EnvironmentProjectBackupSource;
  readonly #staging: RepositoryRestoreStagingPort;

  constructor(options: EnvironmentRestoreRepositoryAdapterOptions) {
    if (
      typeof options.inspection.assertEmpty !== 'function'
      || typeof options.publication.planInactive !== 'function'
      || typeof options.publication.publishInactive !== 'function'
      || typeof options.publication.removeOwnedRepository !== 'function'
      || typeof options.source.readProjectBackup !== 'function'
      || typeof options.staging.discardCheckpoint !== 'function'
      || typeof options.staging.importCheckpoint !== 'function'
    ) throw new TypeError('environment-restore-repository.options-invalid');
    this.#inspection = options.inspection;
    this.#publication = options.publication;
    this.#source = options.source;
    this.#staging = options.staging;
  }

  assertEmpty(signal: AbortSignal): Promise<void> {
    return this.#inspection.assertEmpty(signal);
  }

  async stage(input: Readonly<{
    readonly operationId: string;
    readonly projects: readonly EnvironmentRestoreProject[];
    readonly signal: AbortSignal;
  }>): Promise<readonly EnvironmentRestoreRepositoryPublication[]> {
    const publications: EnvironmentRestoreRepositoryPublication[] = [];
    try {
      for (const project of input.projects) {
        const backup = await this.#source.readProjectBackup({
          project,
          signal: input.signal,
        });
        const repository = backup.manifest.artifacts.find(
          artifact => artifact.name === 'repository.bundle',
        ) ?? fail();
        const checkpoint = await importRepositoryCheckpoint(this.#staging, {
          expectedByteCount: repository.byteCount,
          expectedSha256: repository.sha256,
          objectFormat: backup.manifest.gitObjectFormat,
          operationId: input.operationId,
          projectId: project.projectId,
          refs: backup.manifest.refs,
          signal: input.signal,
        }, delivery => backup.readRepository(delivery));
        publications.push(environmentPublication(this.#publication.planInactive({
          checkpoint,
          placementGeneration: project.placementGeneration + 1,
          repositoryStorageKey: storageKey(input.operationId, project.projectId),
        })));
      }
      return Object.freeze(publications);
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    }
  }

  async publish(input: Readonly<{
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly signal: AbortSignal;
  }>): Promise<void> {
    try {
      for (const expected of input.repositories) {
        if (expected.operationId !== input.operationId) return fail();
        const actual = environmentPublication(await this.#publication.publishInactive({
          checkpoint: replayedCheckpoint(expected),
          placementGeneration: expected.placementGeneration,
          repositoryStorageKey: expected.repositoryStorageKey,
          signal: input.signal,
        }));
        if (!samePublication(actual, expected)) return fail();
      }
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    }
  }

  verifyRestored(input: Readonly<{
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly signal: AbortSignal;
  }>): Promise<void> {
    return this.publish(input);
  }

  async removeRestoreOwned(input: Readonly<{
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly signal: AbortSignal;
  }>): Promise<'removed' | 'replayed'> {
    let removed = false;
    try {
      for (const repository of input.repositories) {
        if (repository.operationId !== input.operationId) return fail();
        removed = await this.#publication.removeOwnedRepository(
          inactivePublication(repository),
          input.signal,
        ) === 'removed' || removed;
      }
      return removed ? 'removed' : 'replayed';
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    }
  }

  async removeRestoreStaging(input: Readonly<{
    readonly operationId: string;
    readonly projects: readonly EnvironmentRestoreProject[];
    readonly signal: AbortSignal;
  }>): Promise<'removed' | 'replayed'> {
    let removed = false;
    try {
      for (const project of input.projects) {
        removed = await this.#staging.discardCheckpoint({
          operationId: input.operationId,
          projectId: project.projectId,
        }) === 'removed' || removed;
      }
      return removed ? 'removed' : 'replayed';
    } catch (error: unknown) {
      if (error instanceof EnvironmentRestoreCoordinatorError) throw error;
      return fail();
    }
  }
}
