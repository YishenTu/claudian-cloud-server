import { createHash } from 'node:crypto';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabIsoTimestamp,
} from '@claudian-collab/protocol';

import {
  EnvironmentRestoreCoordinatorError,
  type EnvironmentRestoreCoordinatorErrorCode,
  type EnvironmentRestoreBackupPort,
  type EnvironmentRestoreCatalog,
  type EnvironmentRestoreProject,
  type EnvironmentRestoreTerminalProject,
} from './EnvironmentRestoreCoordinator.js';
import type { TerminalProjectContinuityArtifact } from './TerminalProjectContinuityArtifact.js';

export type EnvironmentBackupCatalogVerifierErrorCode = Extract<
  EnvironmentRestoreCoordinatorErrorCode,
  'cancelled' | 'dependency-failed' | 'invalid-backup'
>;

export class EnvironmentBackupCatalogVerifierError
  extends EnvironmentRestoreCoordinatorError {
  constructor(code: EnvironmentBackupCatalogVerifierErrorCode) {
    super(code);
    this.name = 'EnvironmentBackupCatalogVerifierError';
    this.message = `environment-backup-catalog.error.${code}`;
  }
}

export interface VerifiedEnvironmentProjectBackup
  extends EnvironmentRestoreProject {
  readonly authorityId: string;
  readonly authorityVolumeIdentity: string;
  readonly coordinationSchemaVersion: number;
  readonly maximumServerBuild: string;
  readonly minimumServerBuild: string;
  readonly repositoryFormatVersion: number;
  readonly restoreEpoch: number;
}

export interface EnvironmentBackupCatalogSource {
  readCatalog(input: Readonly<{
    readonly catalogId: string;
    readonly signal: AbortSignal;
  }>): Promise<unknown>;
  /** Uses the common checkpoint verifier, including exact Git refs and objects. */
  verifyProjectBackup(input: Readonly<{
    readonly project: EnvironmentRestoreProject;
    readonly signal: AbortSignal;
  }>): Promise<VerifiedEnvironmentProjectBackup>;
  verifyTerminalProjectBackup(input: Readonly<{
    readonly signal: AbortSignal;
    readonly terminalProject: EnvironmentRestoreTerminalProject;
  }>): Promise<TerminalProjectContinuityArtifact>;
}

export interface EnvironmentBackupCatalogVerifierOptions {
  readonly coordinationSchemaVersion: number;
  readonly repositoryFormatVersion: number;
  readonly serverBuild: string;
  readonly source: EnvironmentBackupCatalogSource;
}

interface EnvironmentBackupCatalogDocument extends EnvironmentRestoreCatalog {
  readonly schemaVersion: 1;
}

export interface CreateEnvironmentBackupCatalogInput {
  readonly authorityId: string;
  readonly authorityVolumeIdentity: string;
  readonly catalogId: string;
  readonly coordinationSchemaVersion: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly projects: readonly EnvironmentRestoreProject[];
  readonly repositoryFormatVersion: number;
  readonly restoreEpoch: number;
  readonly serverBuild: string;
  readonly terminalProjects: readonly EnvironmentRestoreTerminalProject[];
}

export interface CreatedEnvironmentBackupCatalog {
  readonly catalog: EnvironmentRestoreCatalog;
  readonly json: string;
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EXPECTED_KEYS = Object.freeze([
  'authorityId',
  'authorityVolumeIdentity',
  'catalogId',
  'catalogSha256',
  'coordinationSchemaVersion',
  'createdAt',
  'maximumServerBuild',
  'minimumServerBuild',
  'projects',
  'repositoryFormatVersion',
  'restoreEpoch',
  'schemaVersion',
  'terminalProjects',
]);
const PROJECT_KEYS = Object.freeze([
  'authorityGeneration',
  'backupId',
  'checkpointSha256',
  'expiresAt',
  'placementGeneration',
  'projectId',
]);
const TERMINAL_PROJECT_KEYS = Object.freeze([
  'artifactByteCount',
  'artifactSha256',
  'projectId',
]);

function fail(code: EnvironmentBackupCatalogVerifierErrorCode): never {
  throw new EnvironmentBackupCatalogVerifierError(code);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function timestamp(value: unknown): value is CollabIsoTimestamp {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function project(value: unknown): EnvironmentRestoreProject {
  if (!plainRecord(value) || !exactKeys(value, PROJECT_KEYS)) {
    return fail('invalid-backup');
  }
  if (
    typeof value.authorityGeneration !== 'number'
    || !Number.isSafeInteger(value.authorityGeneration)
    || value.authorityGeneration <= 0
    || typeof value.backupId !== 'string'
    || !isCollabOpaqueId(value.backupId)
    || typeof value.checkpointSha256 !== 'string'
    || !SHA256_PATTERN.test(value.checkpointSha256)
    || !timestamp(value.expiresAt)
    || typeof value.placementGeneration !== 'number'
    || !Number.isSafeInteger(value.placementGeneration)
    || value.placementGeneration <= 0
    || typeof value.projectId !== 'string'
    || !isCollabProjectId(value.projectId)
  ) fail('invalid-backup');
  return Object.freeze({
    authorityGeneration: value.authorityGeneration,
    backupId: value.backupId,
    checkpointSha256: value.checkpointSha256,
    expiresAt: value.expiresAt,
    placementGeneration: value.placementGeneration,
    projectId: value.projectId,
  });
}

function terminalProject(value: unknown): EnvironmentRestoreTerminalProject {
  if (!plainRecord(value) || !exactKeys(value, TERMINAL_PROJECT_KEYS)) {
    return fail('invalid-backup');
  }
  if (
    typeof value.artifactByteCount !== 'number'
    || !Number.isSafeInteger(value.artifactByteCount)
    || value.artifactByteCount <= 0
    || value.artifactByteCount
      > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes
    || typeof value.artifactSha256 !== 'string'
    || !SHA256_PATTERN.test(value.artifactSha256)
    || typeof value.projectId !== 'string'
    || !isCollabProjectId(value.projectId)
  ) fail('invalid-backup');
  return Object.freeze({
    artifactByteCount: value.artifactByteCount,
    artifactSha256: value.artifactSha256,
    projectId: value.projectId,
  });
}

function digestInput(document: Omit<EnvironmentBackupCatalogDocument, 'catalogSha256'>): string {
  return JSON.stringify({
    authorityId: document.authorityId,
    authorityVolumeIdentity: document.authorityVolumeIdentity,
    catalogId: document.catalogId,
    coordinationSchemaVersion: document.coordinationSchemaVersion,
    createdAt: document.createdAt,
    maximumServerBuild: document.maximumServerBuild,
    minimumServerBuild: document.minimumServerBuild,
    projects: document.projects.map(item => ({
      authorityGeneration: item.authorityGeneration,
      backupId: item.backupId,
      checkpointSha256: item.checkpointSha256,
      expiresAt: item.expiresAt,
      placementGeneration: item.placementGeneration,
      projectId: item.projectId,
    })),
    repositoryFormatVersion: document.repositoryFormatVersion,
    restoreEpoch: document.restoreEpoch,
    schemaVersion: document.schemaVersion,
    terminalProjects: document.terminalProjects.map(item => ({
      artifactByteCount: item.artifactByteCount,
      artifactSha256: item.artifactSha256,
      projectId: item.projectId,
    })),
  });
}

function decodeDocument(
  value: unknown,
  expectedCatalogId: string,
  expectedCatalogSha256: string,
): EnvironmentBackupCatalogDocument {
  if (!plainRecord(value) || !exactKeys(value, EXPECTED_KEYS)) {
    return fail('invalid-backup');
  }
  if (
    typeof value.authorityId !== 'string'
    || !IDENTITY_PATTERN.test(value.authorityId)
    || typeof value.authorityVolumeIdentity !== 'string'
    || !IDENTITY_PATTERN.test(value.authorityVolumeIdentity)
    || typeof value.catalogId !== 'string'
    || value.catalogId !== expectedCatalogId
    || typeof value.catalogSha256 !== 'string'
    || value.catalogSha256 !== expectedCatalogSha256
    || !SHA256_PATTERN.test(value.catalogSha256)
    || typeof value.coordinationSchemaVersion !== 'number'
    || !Number.isSafeInteger(value.coordinationSchemaVersion)
    || value.coordinationSchemaVersion <= 0
    || !timestamp(value.createdAt)
    || typeof value.maximumServerBuild !== 'string'
    || value.maximumServerBuild.length === 0
    || Buffer.byteLength(value.maximumServerBuild, 'utf8') > 128
    || typeof value.minimumServerBuild !== 'string'
    || value.minimumServerBuild.length === 0
    || Buffer.byteLength(value.minimumServerBuild, 'utf8') > 128
    || !Array.isArray(value.projects)
    || !Array.isArray(value.terminalProjects)
    || value.projects.length + value.terminalProjects.length === 0
    || typeof value.repositoryFormatVersion !== 'number'
    || !Number.isSafeInteger(value.repositoryFormatVersion)
    || value.repositoryFormatVersion <= 0
    || typeof value.restoreEpoch !== 'number'
    || !Number.isSafeInteger(value.restoreEpoch)
    || value.restoreEpoch <= 0
    || value.schemaVersion !== 1
  ) fail('invalid-backup');
  const projects = Object.freeze(value.projects.map(project));
  const terminalProjects = Object.freeze(
    value.terminalProjects.map(terminalProject),
  );
  const seenProjects = new Set<string>();
  const seenBackups = new Set<string>();
  let priorProjectId: string | undefined;
  for (const item of projects) {
    if (
      seenProjects.has(item.projectId)
      || seenBackups.has(item.backupId)
      || (priorProjectId !== undefined && priorProjectId >= item.projectId)
    ) fail('invalid-backup');
    seenProjects.add(item.projectId);
    seenBackups.add(item.backupId);
    priorProjectId = item.projectId;
  }
  priorProjectId = undefined;
  for (const item of terminalProjects) {
    if (
      seenProjects.has(item.projectId)
      || (priorProjectId !== undefined && priorProjectId >= item.projectId)
    ) fail('invalid-backup');
    seenProjects.add(item.projectId);
    priorProjectId = item.projectId;
  }
  const withoutDigest = Object.freeze({
    authorityId: value.authorityId,
    authorityVolumeIdentity: value.authorityVolumeIdentity,
    catalogId: value.catalogId,
    coordinationSchemaVersion: value.coordinationSchemaVersion,
    createdAt: value.createdAt,
    maximumServerBuild: value.maximumServerBuild,
    minimumServerBuild: value.minimumServerBuild,
    projects,
    repositoryFormatVersion: value.repositoryFormatVersion,
    restoreEpoch: value.restoreEpoch,
    schemaVersion: 1 as const,
    terminalProjects,
  });
  if (sha256(digestInput(withoutDigest)) !== value.catalogSha256) {
    fail('invalid-backup');
  }
  return Object.freeze({
    ...withoutDigest,
    catalogSha256: value.catalogSha256,
  });
}

export function createEnvironmentBackupCatalog(
  input: CreateEnvironmentBackupCatalogInput,
): CreatedEnvironmentBackupCatalog {
  const projects = Object.freeze(
    input.projects
      .map(item => project(item))
      .sort((left, right) => left.projectId.localeCompare(
        right.projectId,
        'en-US',
      )),
  );
  const terminalProjects = Object.freeze(
    input.terminalProjects
      .map(item => terminalProject(item))
      .sort((left, right) => left.projectId.localeCompare(
        right.projectId,
        'en-US',
      )),
  );
  const withoutDigest = Object.freeze({
    authorityId: input.authorityId,
    authorityVolumeIdentity: input.authorityVolumeIdentity,
    catalogId: input.catalogId,
    coordinationSchemaVersion: input.coordinationSchemaVersion,
    createdAt: input.createdAt,
    maximumServerBuild: input.serverBuild,
    minimumServerBuild: input.serverBuild,
    projects,
    repositoryFormatVersion: input.repositoryFormatVersion,
    restoreEpoch: input.restoreEpoch,
    schemaVersion: 1 as const,
    terminalProjects,
  });
  const catalogSha256 = sha256(digestInput(withoutDigest));
  const document = decodeDocument(
    Object.freeze({ ...withoutDigest, catalogSha256 }),
    input.catalogId,
    catalogSha256,
  );
  return Object.freeze({
    catalog: Object.freeze({
      authorityId: document.authorityId,
      authorityVolumeIdentity: document.authorityVolumeIdentity,
      catalogId: document.catalogId,
      catalogSha256: document.catalogSha256,
      coordinationSchemaVersion: document.coordinationSchemaVersion,
      createdAt: document.createdAt,
      maximumServerBuild: document.maximumServerBuild,
      minimumServerBuild: document.minimumServerBuild,
      projects: document.projects,
      repositoryFormatVersion: document.repositoryFormatVersion,
      restoreEpoch: document.restoreEpoch,
      terminalProjects: document.terminalProjects,
    }),
    json: JSON.stringify(document),
  });
}

function exactProjectBackup(
  document: EnvironmentBackupCatalogDocument,
  expected: EnvironmentRestoreProject,
  actual: VerifiedEnvironmentProjectBackup,
): void {
  if (
    actual.authorityGeneration !== expected.authorityGeneration
    || actual.authorityId !== document.authorityId
    || actual.authorityVolumeIdentity !== document.authorityVolumeIdentity
    || actual.backupId !== expected.backupId
    || actual.checkpointSha256 !== expected.checkpointSha256
    || actual.expiresAt !== expected.expiresAt
    || actual.coordinationSchemaVersion !== document.coordinationSchemaVersion
    || actual.maximumServerBuild !== document.maximumServerBuild
    || actual.minimumServerBuild !== document.minimumServerBuild
    || actual.placementGeneration !== expected.placementGeneration
    || actual.projectId !== expected.projectId
    || actual.repositoryFormatVersion !== document.repositoryFormatVersion
    || actual.restoreEpoch !== document.restoreEpoch
  ) fail('invalid-backup');
}

export class EnvironmentBackupCatalogVerifier
implements EnvironmentRestoreBackupPort {
  readonly #coordinationSchemaVersion: number;
  readonly #repositoryFormatVersion: number;
  readonly #serverBuild: string;
  readonly #source: EnvironmentBackupCatalogSource;

  constructor(options: EnvironmentBackupCatalogVerifierOptions) {
    if (
      !Number.isSafeInteger(options.coordinationSchemaVersion)
      || options.coordinationSchemaVersion <= 0
      || !Number.isSafeInteger(options.repositoryFormatVersion)
      || options.repositoryFormatVersion <= 0
      || !IDENTITY_PATTERN.test(options.serverBuild)
      || typeof options.source.readCatalog !== 'function'
      || typeof options.source.verifyProjectBackup !== 'function'
    ) throw new TypeError('environment-backup-catalog.options-invalid');
    this.#coordinationSchemaVersion = options.coordinationSchemaVersion;
    this.#repositoryFormatVersion = options.repositoryFormatVersion;
    this.#serverBuild = options.serverBuild;
    this.#source = options.source;
  }

  async validate(input: Readonly<{
    readonly catalogId: string;
    readonly expectedCatalogSha256: string;
    readonly signal: AbortSignal;
  }>): Promise<EnvironmentRestoreCatalog> {
    if (
      !isCollabOpaqueId(input.catalogId)
      || !SHA256_PATTERN.test(input.expectedCatalogSha256)
    ) fail('invalid-backup');
    if (input.signal.aborted) fail('cancelled');
    try {
      const document = decodeDocument(
        await this.#source.readCatalog({
          catalogId: input.catalogId,
          signal: input.signal,
        }),
        input.catalogId,
        input.expectedCatalogSha256,
      );
      if (
        document.coordinationSchemaVersion !== this.#coordinationSchemaVersion
        || document.repositoryFormatVersion !== this.#repositoryFormatVersion
        || document.minimumServerBuild !== this.#serverBuild
        || document.maximumServerBuild !== this.#serverBuild
      ) fail('invalid-backup');
      for (const item of document.projects) {
        assertNotAborted(input.signal);
        exactProjectBackup(
          document,
          item,
          await this.#source.verifyProjectBackup({
            project: item,
            signal: input.signal,
          }),
        );
      }
      for (const item of document.terminalProjects) {
        assertNotAborted(input.signal);
        const artifact = await this.#source.verifyTerminalProjectBackup({
          signal: input.signal,
          terminalProject: item,
        });
        if (
          artifact.projectId !== item.projectId
          || artifact.sha256 !== item.artifactSha256
          || Buffer.byteLength(artifact.json, 'utf8') !== item.artifactByteCount
        ) fail('invalid-backup');
      }
      return Object.freeze({
        authorityId: document.authorityId,
        authorityVolumeIdentity: document.authorityVolumeIdentity,
        catalogId: document.catalogId,
        catalogSha256: document.catalogSha256,
        coordinationSchemaVersion: document.coordinationSchemaVersion,
        createdAt: document.createdAt,
        maximumServerBuild: document.maximumServerBuild,
        minimumServerBuild: document.minimumServerBuild,
        projects: document.projects,
        repositoryFormatVersion: document.repositoryFormatVersion,
        restoreEpoch: document.restoreEpoch,
        terminalProjects: document.terminalProjects,
      });
    } catch (error: unknown) {
      if (error instanceof EnvironmentBackupCatalogVerifierError) throw error;
      assertNotAborted(input.signal);
      fail('dependency-failed');
    }
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) fail('cancelled');
}
