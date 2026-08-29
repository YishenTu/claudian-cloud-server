import { createHash } from 'node:crypto';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  decodeCollabProjectBackupCheckpointManifest,
  encodeCollabProjectBackupCheckpointManifestCanonicalJson,
  encodeCollabProjectBackupCheckpointManifestDigestInput,
  type CollabProjectBackupCheckpointManifest,
  type CollabProjectBackupRecord,
} from '@claudian-collab/protocol';

import {
  productionCheckpointAttemptIdentity,
  type PreparedProductionCheckpointAttempt,
  type ProductionCheckpointStagingPort,
  type StagedProductionCheckpointArtifact,
} from '../../onboarding/production/ProductionCheckpointStaging.js';
import {
  ProjectCheckpointCoordinatorError,
  type ProjectCheckpointCoordinator,
} from '../../project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import {
  EnvironmentBackupCatalogVerifierError,
  type EnvironmentBackupCatalogSource,
  type VerifiedEnvironmentProjectBackup,
} from './EnvironmentBackupCatalog.js';
import type {
  EnvironmentRestoreProject,
} from './EnvironmentRestoreCoordinator.js';

export interface EnvironmentBackupCatalogDocumentSource {
  readCatalog(input: Readonly<{
    readonly catalogId: string;
    readonly signal: AbortSignal;
  }>): Promise<unknown>;
}

export interface VerifiedEnvironmentProjectCheckpoint {
  readonly manifest: CollabProjectBackupCheckpointManifest;
  readonly project: EnvironmentRestoreProject;
  readonly records: readonly CollabProjectBackupRecord[];
  readRepository(input: Readonly<{
    readonly onChunk: (
      chunk: Buffer,
      signal: AbortSignal,
    ) => Promise<void> | void;
    readonly signal: AbortSignal;
  }>): Promise<void>;
}

export interface EnvironmentProjectBackupSource {
  readProjectBackup(input: Readonly<{
    readonly project: EnvironmentRestoreProject;
    readonly signal: AbortSignal;
  }>): Promise<VerifiedEnvironmentProjectCheckpoint>;
}

export interface PublishedEnvironmentBackupSourceOptions {
  readonly catalog: EnvironmentBackupCatalogDocumentSource;
  readonly checkpoint: Pick<
    ProjectCheckpointCoordinator,
    | 'readPublishedOutboundRecords'
    | 'reserveOutbound'
    | 'verifyOutboundOperation'
  >;
  readonly publication: Pick<
    ProductionCheckpointStagingPort,
    'inspectAttempt' | 'readArtifact'
  >;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(): never {
  throw new EnvironmentBackupCatalogVerifierError('invalid-backup');
}

function dependency(): never {
  throw new EnvironmentBackupCatalogVerifierError('dependency-failed');
}

function mapCheckpointError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) {
    throw new EnvironmentBackupCatalogVerifierError('cancelled');
  }
  if (
    error instanceof ProjectCheckpointCoordinatorError
    && error.code === 'invalid-checkpoint'
  ) return invalid();
  return dependency();
}

function exactArtifact(
  artifacts: readonly StagedProductionCheckpointArtifact[],
  name: StagedProductionCheckpointArtifact['name'],
): StagedProductionCheckpointArtifact {
  const matches = artifacts.filter(artifact => artifact.name === name);
  if (matches.length !== 1 || matches[0] === undefined) return invalid();
  return matches[0];
}

function exactRecord<Kind extends CollabProjectBackupRecord['kind']>(
  records: readonly CollabProjectBackupRecord[],
  kind: Kind,
): Extract<CollabProjectBackupRecord, { readonly kind: Kind }> {
  const matches = records.filter(record => record.kind === kind);
  if (matches.length !== 1 || matches[0] === undefined) return invalid();
  return matches[0] as Extract<
    CollabProjectBackupRecord,
    { readonly kind: Kind }
  >;
}

function exactAttemptProject(
  attempt: PreparedProductionCheckpointAttempt,
  project: EnvironmentRestoreProject,
): boolean {
  return attempt.operationId === project.backupId
    && attempt.projectId === project.projectId
    && attempt.expiresAt === project.expiresAt;
}

/**
 * Reopens O1's immutable backup publication and runs the common checkpoint
 * verifier before exposing canonical records or repository bytes to restore.
 */
export class PublishedEnvironmentBackupSource
implements EnvironmentBackupCatalogSource, EnvironmentProjectBackupSource {
  readonly #catalog: EnvironmentBackupCatalogDocumentSource;
  readonly #checkpoint: PublishedEnvironmentBackupSourceOptions['checkpoint'];
  readonly #publication: PublishedEnvironmentBackupSourceOptions['publication'];

  constructor(options: PublishedEnvironmentBackupSourceOptions) {
    if (
      typeof options.catalog.readCatalog !== 'function'
      || typeof options.checkpoint.readPublishedOutboundRecords !== 'function'
      || typeof options.checkpoint.reserveOutbound !== 'function'
      || typeof options.checkpoint.verifyOutboundOperation !== 'function'
      || typeof options.publication.inspectAttempt !== 'function'
      || typeof options.publication.readArtifact !== 'function'
    ) throw new TypeError('published-environment-backup-source.options-invalid');
    this.#catalog = options.catalog;
    this.#checkpoint = options.checkpoint;
    this.#publication = options.publication;
  }

  readCatalog(input: Readonly<{
    readonly catalogId: string;
    readonly signal: AbortSignal;
  }>): Promise<unknown> {
    return this.#catalog.readCatalog(input);
  }

  async verifyProjectBackup(input: Readonly<{
    readonly project: EnvironmentRestoreProject;
    readonly signal: AbortSignal;
  }>): Promise<VerifiedEnvironmentProjectBackup> {
    const checkpoint = await this.readProjectBackup(input);
    const projectRecord = exactRecord(checkpoint.records, 'project');
    const schema = exactRecord(checkpoint.records, 'schema-catalog');
    const server = exactRecord(checkpoint.records, 'server-compatibility');
    const volume = exactRecord(checkpoint.records, 'authority-volume-pair');
    const placement = exactRecord(checkpoint.records, 'repository-placement');
    if (
      projectRecord.value.projectId !== input.project.projectId
      || projectRecord.value.authorityGeneration
        !== input.project.authorityGeneration
      || schema.value.projectId !== input.project.projectId
      || server.value.projectId !== input.project.projectId
      || volume.value.projectId !== input.project.projectId
      || placement.value.projectId !== input.project.projectId
      || placement.value.placementGeneration
        !== input.project.placementGeneration
    ) return invalid();
    return Object.freeze({
      authorityGeneration: input.project.authorityGeneration,
      authorityId: volume.value.authorityId,
      authorityVolumeIdentity: volume.value.authorityVolumeIdentity,
      backupId: input.project.backupId,
      checkpointSha256: input.project.checkpointSha256,
      coordinationSchemaVersion: schema.value.coordinationSchemaVersion,
      expiresAt: input.project.expiresAt,
      maximumServerBuild: server.value.maximumBuild,
      minimumServerBuild: server.value.minimumBuild,
      placementGeneration: input.project.placementGeneration,
      projectId: input.project.projectId,
      repositoryFormatVersion: schema.value.repositoryFormatVersion,
      restoreEpoch: volume.value.restoreEpoch,
    });
  }

  async readProjectBackup(input: Readonly<{
    readonly project: EnvironmentRestoreProject;
    readonly signal: AbortSignal;
  }>): Promise<VerifiedEnvironmentProjectCheckpoint> {
    const attempt = productionCheckpointAttemptIdentity({
      expiresAt: input.project.expiresAt,
      operationId: input.project.backupId,
      projectId: input.project.projectId,
    });
    let reservation;
    try {
      reservation = await this.#checkpoint.reserveOutbound(
        input.project.projectId,
        input.signal,
      );
      await this.#checkpoint.verifyOutboundOperation({
        expectedCheckpointSha256: input.project.checkpointSha256,
        expectedProfile: 'backup',
        expectedSourceAuthority: Object.freeze({
          generation: input.project.authorityGeneration,
          kind: 'cloud',
        }),
        expiresAt: input.project.expiresAt,
        operationId: input.project.backupId,
        projectId: input.project.projectId,
      }, reservation, input.signal);
      const records = await this.#checkpoint.readPublishedOutboundRecords({
        expectedProfile: 'backup',
        expiresAt: input.project.expiresAt,
        operationId: input.project.backupId,
        projectId: input.project.projectId,
      }, reservation, input.signal) as readonly CollabProjectBackupRecord[];
      const inspected = await this.#publication.inspectAttempt(
        attempt,
        input.signal,
      );
      if (!exactAttemptProject(inspected.attempt, input.project)) return invalid();
      const manifestArtifact = exactArtifact(
        inspected.artifacts,
        'checkpoint.json',
      );
      const repositoryArtifact = exactArtifact(
        inspected.artifacts,
        'repository.bundle',
      );
      const manifestJson = await this.#readTextArtifact(
        attempt,
        manifestArtifact,
        input.signal,
      );
      const manifest = decodeCollabProjectBackupCheckpointManifest(
        JSON.parse(manifestJson) as unknown,
      );
      if (
        encodeCollabProjectBackupCheckpointManifestCanonicalJson(manifest)
          !== manifestJson
        || sha256(encodeCollabProjectBackupCheckpointManifestDigestInput(manifest))
          !== manifest.manifestSha256
        || manifest.manifestSha256 !== input.project.checkpointSha256
        || manifest.operationId !== input.project.backupId
        || manifest.projectId !== input.project.projectId
      ) return invalid();
      const repositoryFact = manifest.artifacts.find(
        artifact => artifact.name === 'repository.bundle',
      );
      if (
        repositoryFact === undefined
        || repositoryFact.byteCount !== repositoryArtifact.byteCount
        || repositoryFact.sha256 !== repositoryArtifact.sha256
        || !SHA256_PATTERN.test(repositoryArtifact.sha256)
      ) return invalid();
      return Object.freeze({
        manifest,
        project: input.project,
        records: Object.freeze([...records]),
        readRepository: (repositoryInput: Readonly<{
          readonly onChunk: (
            chunk: Buffer,
            signal: AbortSignal,
          ) => Promise<void> | void;
          readonly signal: AbortSignal;
        }>) => this.#publication.readArtifact({
          artifact: repositoryArtifact,
          attempt,
          onChunk: repositoryInput.onChunk,
          signal: repositoryInput.signal,
        }),
      });
    } catch (error: unknown) {
      if (error instanceof EnvironmentBackupCatalogVerifierError) throw error;
      return mapCheckpointError(error, input.signal);
    } finally {
      await reservation?.close();
    }
  }

  async #readTextArtifact(
    attempt: PreparedProductionCheckpointAttempt,
    artifact: StagedProductionCheckpointArtifact,
    signal: AbortSignal,
  ): Promise<string> {
    if (artifact.byteCount > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes) {
      return invalid();
    }
    const chunks: Buffer[] = [];
    let byteCount = 0;
    await this.#publication.readArtifact({
      artifact,
      attempt,
      onChunk: chunk => {
        byteCount += chunk.length;
        if (byteCount > artifact.byteCount) return invalid();
        chunks.push(Buffer.from(chunk));
      },
      signal,
    });
    if (byteCount !== artifact.byteCount) return invalid();
    return Buffer.concat(chunks, byteCount).toString('utf8');
  }
}
