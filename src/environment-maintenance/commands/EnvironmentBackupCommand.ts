import { createHash } from 'node:crypto';

import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';
import type { TerminalProjectContinuityRecord } from '../../coordination/ProjectCheckpointPersistence.js';

import {
  BackupExportCoordinatorError,
  type BackupExportCoordinator,
  type BackupExportMetadata,
} from '../../project-authority/checkpoint/BackupExportCoordinator.js';
import {
  createEnvironmentBackupCatalog,
  type CreatedEnvironmentBackupCatalog,
} from '../restore/EnvironmentBackupCatalog.js';
import {
  createTerminalProjectContinuityArtifact,
  type TerminalProjectContinuityArtifact,
} from '../restore/TerminalProjectContinuityArtifact.js';

export type EnvironmentBackupCommandErrorCode =
  | 'cancelled'
  | 'dependency-failed'
  | 'state-conflict';

export class EnvironmentBackupCommandError extends Error {
  readonly code: EnvironmentBackupCommandErrorCode;

  constructor(code: EnvironmentBackupCommandErrorCode) {
    super(`environment-backup-command.error.${code}`);
    this.name = 'EnvironmentBackupCommandError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
    });
  }
}

export interface EnvironmentBackupProjectCatalogPort {
  list(input: Readonly<{
    readonly after?: CollabProjectId;
  }>): Promise<Readonly<{
    readonly nextCursor: CollabProjectId | undefined;
    readonly projectIds: readonly CollabProjectId[];
  }>>;
  readFacts(projectId: CollabProjectId, backupId: string): Promise<Readonly<{
    readonly authorityGeneration: number;
    readonly placementGeneration: number;
  }>>;
  listTerminal?(input: Readonly<{
    readonly after?: CollabProjectId;
    readonly signal: AbortSignal;
  }>): Promise<Readonly<{
    readonly nextCursor: CollabProjectId | undefined;
    readonly projectIds: readonly CollabProjectId[];
  }>>;
  readTerminalRecords?(projectId: CollabProjectId): Promise<
    readonly TerminalProjectContinuityRecord[]
  >;
}

export interface EnvironmentBackupCatalogPublicationPort {
  publish(
    value: CreatedEnvironmentBackupCatalog,
  ): Promise<'published' | 'replayed'>;
  publishTerminalProject?(
    value: TerminalProjectContinuityArtifact,
  ): Promise<'published' | 'replayed'>;
}

export interface EnvironmentBackupCommandOptions {
  readonly backup: Pick<BackupExportCoordinator, 'create'>;
  readonly catalog: EnvironmentBackupCatalogPublicationPort;
  readonly metadata: BackupExportMetadata;
  readonly projects: EnvironmentBackupProjectCatalogPort;
  readonly terminalRecords: Readonly<{
    verify(records: readonly TerminalProjectContinuityRecord[]): Promise<void>;
  }>;
}

export interface EnvironmentBackupCommandResult {
  readonly catalogId: string;
  readonly catalogSha256: string;
  readonly projectCount: number;
  readonly state: 'published';
}

const RETAINED_UNTIL = '9999-12-31T23:59:59.999Z';

function fail(code: EnvironmentBackupCommandErrorCode): never {
  throw new EnvironmentBackupCommandError(code);
}

function active(signal: AbortSignal): void {
  if (signal.aborted) return fail('cancelled');
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function backupId(catalogId: string, projectId: string): string {
  return `backup-${createHash('sha256')
    .update(`${catalogId}\0${projectId}`, 'utf8')
    .digest('hex')}`;
}

function timestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function mapError(error: unknown, signal: AbortSignal): never {
  if (error instanceof EnvironmentBackupCommandError) throw error;
  if (signal.aborted) return fail('cancelled');
  if (
    error instanceof BackupExportCoordinatorError
    && (
      error.code === 'state-conflict'
      || error.code === 'recovery-required'
      || error.code === 'invalid-checkpoint'
    )
  ) return fail('state-conflict');
  return fail('dependency-failed');
}

export class EnvironmentBackupCommand {
  readonly #backup: EnvironmentBackupCommandOptions['backup'];
  readonly #catalog: EnvironmentBackupCommandOptions['catalog'];
  readonly #metadata: BackupExportMetadata;
  readonly #projects: EnvironmentBackupCommandOptions['projects'];
  readonly #terminalRecords: EnvironmentBackupCommandOptions['terminalRecords'];

  constructor(options: EnvironmentBackupCommandOptions) {
    this.#backup = options.backup;
    this.#catalog = options.catalog;
    this.#metadata = Object.freeze({ ...options.metadata });
    this.#projects = options.projects;
    this.#terminalRecords = options.terminalRecords;
  }

  async run(input: Readonly<{
    readonly catalogId: string;
    readonly signal: AbortSignal;
  }>): Promise<EnvironmentBackupCommandResult> {
    try {
      active(input.signal);
      if (!isCollabOpaqueId(input.catalogId)) return fail('state-conflict');
      let createdAt: string | undefined;
      const seen = new Set<string>();
      const projects: CollabProjectId[] = [];
      let after: CollabProjectId | undefined;
      for (;;) {
        active(input.signal);
        const page = await this.#projects.list(
          after === undefined ? {} : { after },
        );
        let previous = after;
        for (const projectId of page.projectIds) {
          if (
            !isCollabProjectId(projectId)
            || seen.has(projectId)
            || (previous !== undefined && previous >= projectId)
          ) return fail('state-conflict');
          seen.add(projectId);
          projects.push(projectId);
          previous = projectId;
        }
        if (page.nextCursor === undefined) break;
        if (
          page.projectIds.length === 0
          || page.nextCursor !== page.projectIds.at(-1)
        ) return fail('state-conflict');
        after = page.nextCursor;
      }
      const entries = [];
      for (const projectId of projects) {
        active(input.signal);
        const operationId = backupId(input.catalogId, projectId);
        const result = await this.#backup.create({
          expiresAt: RETAINED_UNTIL,
          operationId,
          profile: 'backup',
          projectId,
          signal: input.signal,
        });
        const facts = await this.#projects.readFacts(projectId, operationId);
        if (
          result.operationId !== operationId
          || result.profile !== 'backup'
          || result.projectId !== projectId
          || !positiveInteger(facts.authorityGeneration)
          || !positiveInteger(facts.placementGeneration)
        ) return fail('state-conflict');
        if (!timestamp(result.createdAt)) return fail('state-conflict');
        createdAt ??= result.createdAt;
        entries.push(Object.freeze({
          authorityGeneration: facts.authorityGeneration,
          backupId: result.operationId,
          checkpointSha256: result.checkpointSha256,
          expiresAt: result.expiresAt,
          placementGeneration: facts.placementGeneration,
          projectId,
        }));
      }
      const terminalProjects: CollabProjectId[] = [];
      after = undefined;
      for (;;) {
        active(input.signal);
        const page: Readonly<{
          readonly nextCursor: CollabProjectId | undefined;
          readonly projectIds: readonly CollabProjectId[];
        }> = this.#projects.listTerminal === undefined
          ? Object.freeze({ nextCursor: undefined, projectIds: [] })
          : await this.#projects.listTerminal(
            after === undefined
              ? { signal: input.signal }
              : { after, signal: input.signal },
          );
        let previous = after;
        for (const projectId of page.projectIds) {
          if (
            !isCollabProjectId(projectId)
            || (previous !== undefined && previous >= projectId)
          ) return fail('state-conflict');
          if (!seen.has(projectId)) terminalProjects.push(projectId);
          previous = projectId;
        }
        if (page.nextCursor === undefined) break;
        if (
          page.projectIds.length === 0
          || page.nextCursor !== page.projectIds.at(-1)
        ) return fail('state-conflict');
        after = page.nextCursor;
      }
      if (projects.length + terminalProjects.length === 0) {
        return fail('state-conflict');
      }
      const terminalEntries = [];
      for (const projectId of terminalProjects) {
        active(input.signal);
        if (
          this.#projects.readTerminalRecords === undefined
          || this.#catalog.publishTerminalProject === undefined
        ) return fail('state-conflict');
        const records = await this.#projects.readTerminalRecords(projectId);
        await this.#terminalRecords.verify(records);
        const artifact = createTerminalProjectContinuityArtifact(
          projectId,
          records,
        );
        await this.#catalog.publishTerminalProject(artifact);
        const tombstone = records.find(record => record.kind === 'tombstone');
        if (tombstone?.kind !== 'tombstone') return fail('state-conflict');
        createdAt ??= tombstone.value.retiredAt;
        terminalEntries.push(Object.freeze({
          artifactByteCount: Buffer.byteLength(artifact.json, 'utf8'),
          artifactSha256: artifact.sha256,
          projectId,
        }));
      }
      const publication = createEnvironmentBackupCatalog({
        authorityId: this.#metadata.authorityId,
        authorityVolumeIdentity: this.#metadata.authorityVolumeIdentity,
        catalogId: input.catalogId,
        coordinationSchemaVersion: this.#metadata.coordinationSchemaVersion,
        createdAt: createdAt ?? fail('state-conflict'),
        projects: entries,
        repositoryFormatVersion: this.#metadata.repositoryFormatVersion,
        restoreEpoch: this.#metadata.restoreEpoch,
        serverBuild: this.#metadata.serverBuild,
        terminalProjects: terminalEntries,
      });
      await this.#catalog.publish(publication);
      return Object.freeze({
        catalogId: publication.catalog.catalogId,
        catalogSha256: publication.catalog.catalogSha256,
        projectCount: publication.catalog.projects.length
          + publication.catalog.terminalProjects.length,
        state: 'published' as const,
      });
    } catch (error: unknown) {
      return mapError(error, input.signal);
    }
  }
}
