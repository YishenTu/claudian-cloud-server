import { createHash } from 'node:crypto';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  decodeCollabProjectBackupCheckpointCoordinationNdjson,
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
  EnvironmentRestoreTerminalProject,
} from './EnvironmentRestoreCoordinator.js';
import {
  decodeTerminalProjectContinuityArtifact,
  type TerminalProjectContinuityArtifact,
} from './TerminalProjectContinuityArtifact.js';

export interface EnvironmentBackupCatalogDocumentSource {
  readCatalog(input: Readonly<{
    readonly catalogId: string;
    readonly signal: AbortSignal;
  }>): Promise<unknown>;
  readTerminalArtifact(input: Readonly<{
    readonly signal: AbortSignal;
    readonly terminalProject: EnvironmentRestoreTerminalProject;
  }>): Promise<string>;
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

export interface EnvironmentTerminalProjectBackupSource {
  readTerminalProjectBackup(input: Readonly<{
    readonly signal: AbortSignal;
    readonly terminalProject: EnvironmentRestoreTerminalProject;
  }>): Promise<TerminalProjectContinuityArtifact>;
}

export interface PublishedEnvironmentBackupSourceOptions {
  readonly catalog: EnvironmentBackupCatalogDocumentSource;
  readonly checkpoint: Pick<
    ProjectCheckpointCoordinator,
    | 'readPublishedOutboundRecords'
    | 'releaseOutboundOperation'
    | 'reserveOutbound'
    | 'verifyOutboundOperation'
  >;
  readonly publication: Pick<
    ProductionCheckpointStagingPort,
    'inspectAttempt' | 'readArtifact'
  >;
  readonly keyReferences?: Readonly<{
    verify(
      records: readonly CollabProjectBackupRecord[],
      profile?: 'project' | 'terminal',
    ): Promise<void>;
  }>;
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
 * Reopens an immutable backup publication and runs the common checkpoint
 * verifier before exposing canonical records or repository bytes to restore.
 */
export class PublishedEnvironmentBackupSource
implements
  EnvironmentBackupCatalogSource,
  EnvironmentProjectBackupSource,
  EnvironmentTerminalProjectBackupSource {
  readonly #catalog: EnvironmentBackupCatalogDocumentSource;
  readonly #checkpoint: PublishedEnvironmentBackupSourceOptions['checkpoint'];
  readonly #publication: PublishedEnvironmentBackupSourceOptions['publication'];
  readonly #keyReferences: PublishedEnvironmentBackupSourceOptions['keyReferences'];

  constructor(options: PublishedEnvironmentBackupSourceOptions) {
    const checkpoint = (options as Partial<
      PublishedEnvironmentBackupSourceOptions
    >).checkpoint;
    if (
      typeof options.catalog.readCatalog !== 'function'
      || checkpoint === undefined
      || typeof checkpoint.readPublishedOutboundRecords !== 'function'
      || typeof checkpoint.releaseOutboundOperation !== 'function'
      || typeof checkpoint.reserveOutbound !== 'function'
      || typeof checkpoint.verifyOutboundOperation !== 'function'
      || typeof options.publication.inspectAttempt !== 'function'
      || typeof options.publication.readArtifact !== 'function'
    ) throw new TypeError('published-environment-backup-source.options-invalid');
    this.#catalog = options.catalog;
    this.#checkpoint = checkpoint;
    this.#publication = options.publication;
    this.#keyReferences = options.keyReferences;
  }

  readCatalog(input: Readonly<{
    readonly catalogId: string;
    readonly signal: AbortSignal;
  }>): Promise<unknown> {
    return this.#catalog.readCatalog(input);
  }

  verifyTerminalProjectBackup(input: Readonly<{
    readonly signal: AbortSignal;
    readonly terminalProject: EnvironmentRestoreTerminalProject;
  }>): Promise<TerminalProjectContinuityArtifact> {
    return this.readTerminalProjectBackup(input);
  }

  async readTerminalProjectBackup(input: Readonly<{
    readonly signal: AbortSignal;
    readonly terminalProject: EnvironmentRestoreTerminalProject;
  }>): Promise<TerminalProjectContinuityArtifact> {
    try {
      const json = await this.#catalog.readTerminalArtifact(input);
      const artifact = decodeTerminalProjectContinuityArtifact(json, {
        projectId: input.terminalProject.projectId,
        sha256: input.terminalProject.artifactSha256,
      });
      if (
        Buffer.byteLength(artifact.json, 'utf8')
          !== input.terminalProject.artifactByteCount
      ) return invalid();
      if (this.#keyReferences === undefined) return invalid();
      await this.#keyReferences.verify(artifact.records, 'terminal');
      return artifact;
    } catch (error: unknown) {
      if (error instanceof EnvironmentBackupCatalogVerifierError) throw error;
      if (input.signal.aborted) {
        throw new EnvironmentBackupCatalogVerifierError('cancelled');
      }
      return invalid();
    }
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
      const coordinationArtifact = exactArtifact(
        inspected.artifacts,
        'coordination.ndjson',
      );
      if (
        inspected.artifacts.length !== 3
        || new Set(inspected.artifacts.map(artifact => artifact.name)).size !== 3
      ) return invalid();
      const manifestJson = await this.#readTextArtifact(
        attempt,
        manifestArtifact,
        COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
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
      const coordinationFact = manifest.artifacts.find(
        artifact => artifact.name === 'coordination.ndjson',
      );
      if (
        repositoryFact === undefined
        || repositoryFact.byteCount !== repositoryArtifact.byteCount
        || repositoryFact.sha256 !== repositoryArtifact.sha256
        || !SHA256_PATTERN.test(repositoryArtifact.sha256)
        || coordinationFact === undefined
        || coordinationFact.byteCount !== coordinationArtifact.byteCount
        || coordinationFact.sha256 !== coordinationArtifact.sha256
        || !SHA256_PATTERN.test(coordinationArtifact.sha256)
      ) return invalid();
      const coordinationNdjson = await this.#readTextArtifact(
        attempt,
        coordinationArtifact,
        COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
        input.signal,
      );
      const records = decodeCollabProjectBackupCheckpointCoordinationNdjson(
        coordinationNdjson,
      );
      await this.#keyReferences?.verify(records, 'project');
      const catalogRecords = await this.#checkpoint.readPublishedOutboundRecords({
        expectedProfile: 'backup',
        expiresAt: input.project.expiresAt,
        operationId: input.project.backupId,
        projectId: input.project.projectId,
      }, reservation, input.signal) as readonly CollabProjectBackupRecord[];
      if (JSON.stringify(catalogRecords) !== JSON.stringify(records)) {
        return invalid();
      }
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
      let cleanupFailure: unknown;
      if (reservation !== undefined) {
        try {
          await this.#checkpoint.releaseOutboundOperation({
            expiresAt: input.project.expiresAt,
            operationId: input.project.backupId,
            profile: 'backup',
            projectId: input.project.projectId,
          });
        } catch (error: unknown) {
          cleanupFailure = error;
        }
        try {
          await reservation.close();
        } catch (error: unknown) {
          cleanupFailure ??= error;
        }
      }
      if (cleanupFailure !== undefined) {
        mapCheckpointError(cleanupFailure, input.signal);
      }
    }
  }

  async #readTextArtifact(
    attempt: PreparedProductionCheckpointAttempt,
    artifact: StagedProductionCheckpointArtifact,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<string> {
    if (artifact.byteCount > maximumBytes) {
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
    const bytes = Buffer.concat(chunks, byteCount);
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      return invalid();
    }
    return bytes.toString('utf8');
  }
}
