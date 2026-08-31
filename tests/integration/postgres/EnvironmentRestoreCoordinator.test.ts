import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  encodeCollabTransferredMembershipRedemptionReceiptSigningInput,
  type CollabCheckpointGitRef,
  type CollabProjectId,
  type CollabTransferredMembershipRedemptionReceipt,
  type CollabTransferredMembershipRedemptionReceiptSigningPayload,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../../../src/config/PostgresSchemaCompatibility.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { EnvironmentBackupCatalogVerifier } from '../../../src/environment-maintenance/restore/EnvironmentBackupCatalog.js';
import {
  EnvironmentRestoreCoordinator,
  EnvironmentRestoreCoordinatorError,
  ENVIRONMENT_RESTORE_PHASES,
  type EnvironmentRestoreCatalog,
  type EnvironmentRestoreContinuityPort,
  type EnvironmentRestoreCoordinationPort,
  type EnvironmentRestoreJournal,
  type EnvironmentRestorePhase,
  type EnvironmentRestoreProject,
  type EnvironmentRestoreRepositoryPort,
  type EnvironmentRestoreRepositoryPublication,
  type EnvironmentRestoreStateInspection,
  type EnvironmentRestoreStatePort,
} from '../../../src/environment-maintenance/restore/EnvironmentRestoreCoordinator.js';
import { FileEnvironmentRestoreState } from '../../../src/environment-maintenance/restore/FileEnvironmentRestoreState.js';
import { XChaCha20ClaimCustody } from '../../../src/project-authority/lifecycle/cloud-to-lan/XChaCha20ClaimCustody.js';
import { GitBundleImporter } from '../../../src/repositories/GitBundleImporter.js';
import {
  RepositoryCheckpointAuthority,
  type InactiveRepositoryPublication,
} from '../../../src/repositories/RepositoryCheckpointAuthority.js';
import type {
  RepositoryPlacementLease,
  RepositoryPlacementValidator,
} from '../../../src/repositories/RepositoryPlacement.js';
import { BootstrapUploadAdmission } from '../../../src/resource-admission/BootstrapUploadAdmission.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';
const CREATED_AT = '2026-08-29T00:00:00.000Z';
const REDEEMED_AT = '2026-08-29T00:01:00.000Z';
const ACKNOWLEDGED_AT = '2026-08-29T00:02:00.000Z';
const EXPIRES_AT = '2026-09-29T00:00:00.000Z';
const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHECKPOINT_SHA256 = 'a'.repeat(64);
const BATCH_SHA256 = 'b'.repeat(64);
const CLAIM = Buffer.alloc(32, 7).toString('base64url');
const CLAIM_SHA256 = createHash('sha256').update(CLAIM).digest('hex');
const OPERATION_ID = 'restore-operation-real';
const TRANSFER_ID = 'transfer-offline-member';
const OFFLINE_MEMBER_ID = 'member-offline';
const REPOSITORY_LIMITS = Object.freeze({
  maximumBlobBytes: 1024 * 1024,
  maximumExpandedTreeEntries: 100_000,
  maximumRepositoryBytes: 2 * 1024 * 1024,
  maximumTreeEntries: 2_000,
});

interface GitFixture {
  readonly bundle: string;
  readonly bundleByteCount: number;
  readonly bundleSha256: string;
  readonly mainOid: string;
  readonly refs: readonly CollabCheckpointGitRef[];
}

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT, [...arguments_], {
    cwd,
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    },
  });
  return result.stdout.trim();
}

async function createGitFixture(root: string, suffix: string): Promise<GitFixture> {
  const work = join(root, `work-${suffix}`);
  const bundle = join(root, `project-${suffix}.bundle`);
  await git(root, ['init', '--initial-branch=main', work]);
  await git(work, ['config', 'user.email', 'restore@example.invalid']);
  await git(work, ['config', 'user.name', 'Restore Fixture']);
  await writeFile(join(work, 'project.md'), `# Project ${suffix}\n`);
  await git(work, ['add', 'project.md']);
  await git(work, ['commit', '-m', `fixture-${suffix}`]);
  const mainOid = await git(work, ['rev-parse', 'HEAD']);
  await git(work, ['branch', 'members/member-manager']);
  await git(work, [
    'bundle',
    'create',
    bundle,
    'refs/heads/main',
    'refs/heads/members/member-manager',
  ]);
  const bytes = await readFile(bundle);
  return Object.freeze({
    bundle,
    bundleByteCount: bytes.length,
    bundleSha256: createHash('sha256').update(bytes).digest('hex'),
    mainOid,
    refs: Object.freeze([
      Object.freeze({ name: 'refs/heads/main', oid: mainOid }),
      Object.freeze({
        name: 'refs/heads/members/member-manager',
        oid: mainOid,
      }),
    ]),
  });
}

class CurrentPlacement implements RepositoryPlacementValidator {
  isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class RealGitRestorePort implements EnvironmentRestoreRepositoryPort {
  diagnostic = 'constructed';
  readonly #admission: ResourceAdmission;
  readonly #authority: RepositoryCheckpointAuthority;
  readonly #fixtures: ReadonlyMap<CollabProjectId, GitFixture>;
  readonly #importer: GitBundleImporter;
  readonly #operationRoot: string;
  readonly #repositoryRoot: string;
  readonly #uploadAdmission: BootstrapUploadAdmission;

  constructor(
    authorityRoot: string,
    fixtures: ReadonlyMap<CollabProjectId, GitFixture>,
  ) {
    this.#fixtures = fixtures;
    this.#operationRoot = join(authorityRoot, 'restore-operations');
    this.#repositoryRoot = join(authorityRoot, 'repositories');
    this.#admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 2_000,
    });
    this.#uploadAdmission = new BootstrapUploadAdmission({
      maxConcurrentUploads: 1,
      maxUploadsPerAttempt: 1,
      queueMax: 2,
      queueTimeoutMs: 2_000,
      stagingFreeSpaceFloorBytes: 1,
      stagingReservationBytes: 2 * 1024 * 1024,
      stagingRoot: this.#operationRoot,
    });
    this.#importer = new GitBundleImporter({
      gitExecutable: GIT,
      ...REPOSITORY_LIMITS,
      maximumBundleBytes: 2 * 1024 * 1024,
      maximumMetadataOutputBytes: 8 * 1024 * 1024,
      operationTimeoutMs: 5_000,
      resourceAdmission: this.#admission,
      stagingRoot: this.#operationRoot,
      uploadAdmission: this.#uploadAdmission,
      uploadIdleTimeoutMs: 2_000,
      uploadTotalTimeoutMs: 5_000,
    });
    this.#authority = new RepositoryCheckpointAuthority({
      gitExecutable: GIT,
      ...REPOSITORY_LIMITS,
      maximumBundleBytes: 2 * 1024 * 1024,
      operationRoot: this.#operationRoot,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 64 * 1024,
      placementValidator: new CurrentPlacement(),
      repositoryRoot: this.#repositoryRoot,
      resourceAdmission: this.#admission,
      storageNodeId: 'restore-node',
    });
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#operationRoot, { mode: 0o700 }),
      mkdir(this.#repositoryRoot, { mode: 0o700 }),
    ]);
  }

  async assertEmpty(): Promise<void> {
    const contents = await Promise.all([
      readdir(this.#operationRoot),
      readdir(this.#repositoryRoot),
    ]);
    if (contents.some(entries => entries.length !== 0)) {
      throw new EnvironmentRestoreCoordinatorError('non-empty');
    }
  }

  async stage(input: Readonly<{
    readonly operationId: string;
    readonly projects: readonly EnvironmentRestoreProject[];
    readonly signal: AbortSignal;
  }>): Promise<readonly EnvironmentRestoreRepositoryPublication[]> {
    const result: EnvironmentRestoreRepositoryPublication[] = [];
    for (const [index, project] of input.projects.entries()) {
      const fixture = this.#fixtures.get(project.projectId);
      assert.ok(fixture);
      const checkpoint = await this.#importer.importCheckpoint({
        body: createReadStream(fixture.bundle, { highWaterMark: 17 }),
        expectedByteCount: fixture.bundleByteCount,
        expectedSha256: fixture.bundleSha256,
        objectFormat: 'sha1',
        operationId: input.operationId,
        projectId: project.projectId,
        refs: fixture.refs,
        signal: input.signal,
      });
      const publication = this.#authority.planInactive({
        checkpoint,
        placementGeneration: project.placementGeneration + 1,
        repositoryStorageKey: `restored-${String(index + 1)}`,
      });
      result.push(this.#environmentPublication(publication));
    }
    return Object.freeze(result);
  }

  async publish(input: Readonly<{
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly signal: AbortSignal;
  }>): Promise<void> {
    for (const expected of input.repositories) {
      const published = await this.#authority.publishInactive({
        checkpoint: this.#checkpoint(expected),
        placementGeneration: expected.placementGeneration,
        repositoryStorageKey: expected.repositoryStorageKey,
        signal: input.signal,
      });
      assert.deepEqual(this.#environmentPublication(published), expected);
    }
  }

  async verifyRestored(input: Readonly<{
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly signal: AbortSignal;
  }>): Promise<void> {
    this.diagnostic = 'verify-restored';
    await this.publish(input);
    this.diagnostic = 'verified';
  }

  async removeRestoreOwned(input: Readonly<{
    readonly operationId: string;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
    readonly signal: AbortSignal;
  }>): Promise<'removed' | 'replayed'> {
    let removed = false;
    for (const expected of input.repositories) {
      const result = await this.#authority.removeOwnedRepository(
        this.#inactivePublication(expected),
        input.signal,
      );
      removed ||= result === 'removed';
      await this.#removeEmptyDirectory(join(
        this.#repositoryRoot,
        Buffer.from(expected.projectId, 'utf8').toString('hex'),
      ));
    }
    return removed ? 'removed' : 'replayed';
  }

  async removeRestoreStaging(input: Readonly<{
    readonly operationId: string;
    readonly projects: readonly EnvironmentRestoreProject[];
  }>): Promise<'removed' | 'replayed'> {
    let removed = false;
    for (const project of input.projects) {
      const result = await this.#importer.discardCheckpoint({
        operationId: input.operationId,
        projectId: project.projectId,
      });
      removed ||= result === 'removed';
      const projectRoot = join(
        this.#operationRoot,
        Buffer.from(project.projectId, 'utf8').toString('hex'),
      );
      await this.#removeEmptyDirectory(join(projectRoot, 'checkpoint'));
      await this.#removeEmptyDirectory(projectRoot);
    }
    return removed ? 'removed' : 'replayed';
  }

  async close(): Promise<void> {
    await Promise.all([
      this.#authority.close(),
      this.#importer.close(),
      this.#uploadAdmission.close(),
      this.#admission.close(),
    ]);
  }

  #environmentPublication(
    publication: InactiveRepositoryPublication,
  ): EnvironmentRestoreRepositoryPublication {
    return Object.freeze({
      artifactKey: publication.artifactKey,
      bundleByteCount: publication.bundleByteCount,
      bundleSha256: publication.bundleSha256,
      objectFormat: publication.objectFormat,
      operationId: publication.operationId,
      placementGeneration: publication.placementGeneration,
      projectId: publication.projectId,
      publicationMarkerSha256: publication.publicationMarkerSha256,
      refs: publication.refs,
      repositoryStorageKey: publication.repositoryStorageKey,
      status: publication.status,
      storageNodeId: publication.storageNodeId,
      validationMarkerSha256: publication.validationMarkerSha256,
    });
  }

  #checkpoint(
    publication: EnvironmentRestoreRepositoryPublication,
  ): Parameters<RepositoryCheckpointAuthority['publishInactive']>[0]['checkpoint'] {
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

  #inactivePublication(
    publication: EnvironmentRestoreRepositoryPublication,
  ): InactiveRepositoryPublication {
    return Object.freeze({ ...publication });
  }

  async #removeEmptyDirectory(path: string): Promise<void> {
    try {
      await rmdir(path);
    } catch (error: unknown) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      ) return;
      throw error;
    }
  }
}

class FailingRestoreState implements EnvironmentRestoreStatePort {
  readonly #delegate: FileEnvironmentRestoreState;
  readonly #failedPhase: EnvironmentRestorePhase;
  #failed = false;

  constructor(
    delegate: FileEnvironmentRestoreState,
    failedPhase: EnvironmentRestorePhase,
  ) {
    this.#delegate = delegate;
    this.#failedPhase = failedPhase;
  }

  runExclusive<Result>(
    operation: () => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> {
    return this.#delegate.runExclusive(operation, signal);
  }

  inspect(signal?: AbortSignal): Promise<EnvironmentRestoreStateInspection> {
    void signal;
    return this.#delegate.inspect();
  }

  async create(journal: EnvironmentRestoreJournal): Promise<EnvironmentRestoreJournal> {
    return this.#failAfter(await this.#delegate.create(journal));
  }

  async advance(input: Readonly<{
    readonly expectedPhase: EnvironmentRestorePhase;
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal> {
    return this.#failAfter(await this.#delegate.advance(input));
  }

  async preparePair(input: Readonly<{
    readonly authorityVolumeId: string;
    readonly expectedPhase: 'repositories-staged';
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal> {
    return this.#failAfter(await this.#delegate.preparePair(input));
  }

  requestCleanup(input: Readonly<{
    readonly expectedPhase: EnvironmentRestorePhase;
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal> {
    return this.#delegate.requestCleanup(input);
  }

  recoverPublishedAuthority(input: Readonly<{
    readonly expectedPhase: 'repositories-published';
    readonly next: EnvironmentRestoreJournal;
  }>): Promise<EnvironmentRestoreJournal> {
    return this.#delegate.recoverPublishedAuthority(input);
  }

  remove(input: Readonly<{
    readonly expectedCatalogSha256: string;
    readonly operationId: string;
    readonly phase: EnvironmentRestorePhase;
  }>): Promise<'removed'> {
    return this.#delegate.remove(input);
  }

  #failAfter(journal: EnvironmentRestoreJournal): EnvironmentRestoreJournal {
    if (!this.#failed && journal.phase === this.#failedPhase) {
      this.#failed = true;
      throw new Error(`simulated-process-exit-after-${journal.phase}`);
    }
    return journal;
  }
}

function catalogDocument() {
  const content = Object.freeze({
    authorityId: 'cloud-authority-real',
    authorityVolumeIdentity: 'restored-volume-real',
    catalogId: 'environment-backup-real',
    coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
    createdAt: CREATED_AT,
    maximumServerBuild: 'cloud-build-real',
    minimumServerBuild: 'cloud-build-real',
    projects: Object.freeze([
      Object.freeze({
        authorityGeneration: 4,
        backupId: 'backup-project-a',
        checkpointSha256: CHECKPOINT_SHA256,
        expiresAt: EXPIRES_AT,
        placementGeneration: 7,
        projectId: PROJECT_A,
      }),
      Object.freeze({
        authorityGeneration: 2,
        backupId: 'backup-project-b',
        checkpointSha256: 'd'.repeat(64),
        expiresAt: EXPIRES_AT,
        placementGeneration: 3,
        projectId: PROJECT_B,
      }),
    ]),
    repositoryFormatVersion: 1,
    restoreEpoch: 3,
    schemaVersion: 1 as const,
    terminalProjects: Object.freeze([]),
  });
  return Object.freeze({
    ...content,
    catalogSha256: createHash('sha256')
      .update(JSON.stringify(content), 'utf8')
      .digest('hex'),
  });
}

const CATALOG_SHA256 = catalogDocument().catalogSha256;

function backupVerifier(): EnvironmentBackupCatalogVerifier {
  return new EnvironmentBackupCatalogVerifier({
    coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
    repositoryFormatVersion: 1,
    serverBuild: 'cloud-build-real',
    source: {
      readCatalog: () => Promise.resolve(catalogDocument()),
      verifyTerminalProjectBackup: () => assert.fail('unexpected terminal backup'),
      verifyProjectBackup: input => Promise.resolve(Object.freeze({
        authorityGeneration: input.project.authorityGeneration,
        authorityId: 'cloud-authority-real',
        authorityVolumeIdentity: 'restored-volume-real',
        backupId: input.project.backupId,
        checkpointSha256: input.project.checkpointSha256,
        coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
        expiresAt: input.project.expiresAt,
        maximumServerBuild: 'cloud-build-real',
        minimumServerBuild: 'cloud-build-real',
        placementGeneration: input.project.placementGeneration,
        projectId: input.project.projectId,
        repositoryFormatVersion: 1,
        restoreEpoch: 3,
      })),
    },
  });
}

function postgresCoordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 3,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

class RealPostgresRestorePort implements EnvironmentRestoreCoordinationPort {
  diagnostic = 'constructed';
  readonly #database: PostgresTestDatabase;
  readonly #envelope: Awaited<ReturnType<XChaCha20ClaimCustody['seal']>>;
  readonly #fixtures: ReadonlyMap<CollabProjectId, GitFixture>;
  readonly #receiptPublicKey: string;
  #store: PostgresCoordination | undefined;

  constructor(
    database: PostgresTestDatabase,
    envelope: Awaited<ReturnType<XChaCha20ClaimCustody['seal']>>,
    fixtures: ReadonlyMap<CollabProjectId, GitFixture>,
    receiptPublicKey: string,
  ) {
    this.#database = database;
    this.#envelope = envelope;
    this.#fixtures = fixtures;
    this.#receiptPublicKey = receiptPublicKey;
  }

  async assertEmpty(): Promise<void> {
    const client = new Client({ connectionString: this.#database.migrationUrl });
    try {
      await client.connect();
      const result = await client.query<{ readonly schema_name: string | null }>(
        "SELECT to_regnamespace('claudian_cloud')::text AS schema_name",
      );
      if (result.rows[0]?.schema_name !== null) {
        throw new EnvironmentRestoreCoordinatorError('non-empty');
      }
    } finally {
      await client.end();
    }
  }

  async createDatabase(input: Readonly<{
    readonly authorityVolumeId: string;
  }>): Promise<Readonly<{ readonly authorityVolumeId: string }>> {
    assert.equal(input.authorityVolumeId, this.#database.authorityVolumeId);
    await new PostgresMigrator({
      connectionString: this.#database.migrationUrl,
    }).apply();
    this.#store = postgresCoordination(this.#database);
    return Object.freeze({ authorityVolumeId: this.#database.authorityVolumeId });
  }

  async importCoordination(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly restoreEpoch: number;
  }>): Promise<void> {
    assert.equal(input.restoreEpoch, 4);
    const client = new Client({ connectionString: this.#database.migrationUrl });
    try {
      await client.connect();
      for (const project of input.catalog.projects) {
        const fixture = this.#fixtures.get(project.projectId);
        assert.ok(fixture);
        await client.query('BEGIN');
        try {
          await client.query(
            "SELECT set_config('claudian_cloud.project_id', $1, true)",
            [project.projectId],
          );
          await client.query(
            `INSERT INTO claudian_cloud.projects (
               project_id, project_name, manager_set_generation,
               expected_main_oid, service_state, created_at, activated_at,
               authority_generation, authority_state_revision
             ) VALUES ($1, $2, 1, $3, 'maintenance', $4, $4, $5, 1)`,
            [
              project.projectId,
              `Restored ${project.projectId.slice(0, 8)}`,
              fixture.mainOid,
              CREATED_AT,
              project.authorityGeneration,
            ],
          );
          await client.query(
            `INSERT INTO claudian_cloud.project_memberships (
               project_id, member_id, display_name, role, status, revision,
               created_at, updated_at, activated_at
             ) VALUES ($1, 'member-manager', 'Manager', 'manager', 'active',
                       1, $2, $2, $2)`,
            [project.projectId, CREATED_AT],
          );
          if (project.projectId === PROJECT_A) {
            await client.query(
              `INSERT INTO claudian_cloud.project_memberships (
                 project_id, member_id, display_name, role, status, revision,
                 created_at, updated_at, activated_at
               ) VALUES ($1, $2, 'Offline Member', 'member', 'active',
                         1, $3, $3, $3)`,
              [project.projectId, OFFLINE_MEMBER_ID, CREATED_AT],
            );
          }
          await client.query(
            `INSERT INTO claudian_cloud.project_event_sequences (
               project_id, current_sequence, updated_at
             ) VALUES ($1, 1, $2)`,
            [project.projectId, CREATED_AT],
          );
          await client.query(
            `INSERT INTO claudian_cloud.project_events (
               project_id, sequence, kind, payload, occurred_at
             ) VALUES ($1, 1, 'main.updated', $2::jsonb, $3)`,
            [
              project.projectId,
              JSON.stringify({
                mainOid: fixture.mainOid,
                requestId: `restore-${project.projectId.slice(0, 8)}`,
              }),
              CREATED_AT,
            ],
          );
          await client.query(
            `INSERT INTO claudian_cloud.idempotency_results (
               project_id, member_id, operation, idempotency_key,
               request_fingerprint, response_json, created_at
             ) VALUES ($1, 'member-manager', 'updateMain', $2, $3, $4::jsonb, $5)`,
            [
              project.projectId,
              `restore-${project.projectId.slice(0, 8)}`,
              project.checkpointSha256,
              JSON.stringify({ oid: fixture.mainOid }),
              CREATED_AT,
            ],
          );
          await client.query('COMMIT');
        } catch (error: unknown) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.end();
    }

    const store = this.#store;
    assert.ok(store);
    await store.withProjectScope(PROJECT_A, async scope => {
      assert.equal(await scope.portability.putLifecycleJournal({
        actorMemberId: 'member-manager',
        createdAt: CREATED_AT,
        direction: 'cloud-to-lan',
        expectedAuthorityGeneration: 4,
        idempotencyKey: 'restore-transfer-intent',
        kind: 'authority-transfer',
        operationId: TRANSFER_ID,
        phase: 'target-staged',
        projectId: PROJECT_A,
        requestFingerprint: 'f'.repeat(64),
        scheduledAt: CREATED_AT,
      }), 'created');
      assert.equal(await scope.portability.advanceLifecycleJournal({
        batchRevision: 1,
        batchSha256: BATCH_SHA256,
        checkpointSha256: CHECKPOINT_SHA256,
        expectedPhase: 'target-staged',
        expectedState: 'active',
        nextPhase: 'claims-retained',
        nextState: 'active',
        operationId: TRANSFER_ID,
        scheduledAt: CREATED_AT,
        updatedAt: CREATED_AT,
      }), 'advanced');
      assert.equal(await scope.portability.putTransferredMembershipClaim({
        batchRevision: 1,
        checkpointSha256: CHECKPOINT_SHA256,
        claimSha256: CLAIM_SHA256,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        memberId: OFFLINE_MEMBER_ID,
        transferId: TRANSFER_ID,
      }), 'created');
      assert.equal(await scope.portability.putTransferReceiptKey({
        createdAt: CREATED_AT,
        publicKey: this.#receiptPublicKey,
        receiptKeyId: 'receipt-key-restore',
        transferId: TRANSFER_ID,
      }), 'created');
      assert.equal(
        await scope.portability.putProtectedClaimEnvelope(this.#envelope),
        'created',
      );
    });
  }

  async verifyDatabaseIdentity(
    expectedAuthorityVolumeId: string,
  ): Promise<void> {
    const client = new Client({ connectionString: this.#database.runtimeUrl });
    try {
      await client.connect();
      const result = await client.query<{ readonly identity: string }>(
        "SELECT current_setting('claudian_cloud.authority_volume_id') AS identity",
      );
      assert.equal(result.rows[0]?.identity, expectedAuthorityVolumeId);
    } finally {
      await client.end();
    }
  }

  async publishAuthority(input: Readonly<{
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
  }>): Promise<void> {
    const client = new Client({ connectionString: this.#database.migrationUrl });
    try {
      await client.connect();
      for (const repository of input.repositories) {
        await client.query('BEGIN');
        try {
          await client.query(
            "SELECT set_config('claudian_cloud.project_id', $1, true)",
            [repository.projectId],
          );
          await client.query(
            `INSERT INTO claudian_cloud.repository_placements (
               project_id, storage_node_id, repository_storage_key,
               generation, active, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, true, $5, $5)`,
            [
              repository.projectId,
              repository.storageNodeId,
              repository.repositoryStorageKey,
              repository.placementGeneration,
              CREATED_AT,
            ],
          );
          await client.query(
            `UPDATE claudian_cloud.projects
                SET service_state = 'active', authority_state_revision = 2
              WHERE project_id = $1 AND service_state = 'maintenance'`,
            [repository.projectId],
          );
          await client.query('COMMIT');
        } catch (error: unknown) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.end();
    }
  }

  async verifyRestored(input: Readonly<{
    readonly catalog: EnvironmentRestoreCatalog;
    readonly repositories: readonly EnvironmentRestoreRepositoryPublication[];
  }>): Promise<void> {
    this.diagnostic = 'verify-projects';
    const store = this.#store;
    assert.ok(store);
    for (const project of input.catalog.projects) {
      const expectedPlacement = input.repositories.find(
        repository => repository.projectId === project.projectId,
      );
      assert.ok(expectedPlacement);
      await store.withProjectScope(project.projectId, async scope => {
        this.diagnostic = `verify-project-${project.projectId.slice(0, 8)}`;
        const restoredProject = await scope.getProject();
        assert.equal(restoredProject?.serviceState, 'active');
        this.diagnostic = `verify-placement-${project.projectId.slice(0, 8)}`;
        const placement = await scope.getRepositoryPlacement();
        assert.deepEqual(placement, {
          active: true,
          generation: expectedPlacement.placementGeneration,
          projectId: project.projectId,
          repositoryStorageKey: expectedPlacement.repositoryStorageKey,
          storageNodeId: expectedPlacement.storageNodeId,
        });
        this.diagnostic = `verify-events-${project.projectId.slice(0, 8)}`;
        assert.equal((await scope.readProjectEvents({
          afterSequence: 0,
          limit: 2,
        })).events.length, 1);
      });
    }
    const client = new Client({ connectionString: this.#database.migrationUrl });
    try {
      await client.connect();
      for (const project of input.catalog.projects) {
        this.diagnostic = `verify-idempotency-${project.projectId.slice(0, 8)}`;
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [project.projectId],
        );
        const idempotency = await client.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count
             FROM claudian_cloud.idempotency_results
            WHERE project_id = $1`,
          [project.projectId],
        );
        await client.query('COMMIT');
        assert.equal(idempotency.rows[0]?.count, '1');
      }
    } finally {
      await client.end();
    }
    this.diagnostic = 'verified';
  }

  async classifyOrRemoveRestoreOwnedDatabase(input: Readonly<{
    readonly authorityVolumeId: string;
    readonly operationId: string;
  }>): Promise<'removed' | 'replayed'> {
    assert.equal(input.authorityVolumeId, this.#database.authorityVolumeId);
    assert.equal(input.operationId, OPERATION_ID);
    await this.#store?.close();
    this.#store = undefined;
    const client = new Client({ connectionString: this.#database.migrationUrl });
    try {
      await client.connect();
      const result = await client.query<{ readonly schema_name: string | null }>(
        "SELECT to_regnamespace('claudian_cloud')::text AS schema_name",
      );
      if (result.rows[0]?.schema_name === null) return 'replayed';
      await client.query('DROP SCHEMA claudian_cloud CASCADE');
      return 'removed';
    } finally {
      await client.end();
    }
  }

  resumeExistingDatabase(): void {
    if (this.#store !== undefined) assert.fail('restore store is already initialized');
    this.#store = postgresCoordination(this.#database);
  }

  async close(): Promise<void> {
    await this.#store?.close();
  }

  store(): PostgresCoordination {
    return this.#store ?? assert.fail('restore store is not initialized');
  }
}

function continuity(
  custody: XChaCha20ClaimCustody,
  envelope: Awaited<ReturnType<XChaCha20ClaimCustody['seal']>>,
  coordination: RealPostgresRestorePort,
  receiptPrivateKey: KeyObject,
): EnvironmentRestoreContinuityPort {
  return Object.freeze({
    async verifyBeforeCreation(input: Readonly<{
      readonly catalog: EnvironmentRestoreCatalog;
      readonly signal: AbortSignal;
    }>) {
      assert.equal(input.catalog.projects[0]?.projectId, PROJECT_A);
      try {
        assert.equal(await custody.open(envelope), CLAIM);
      } catch {
        throw new EnvironmentRestoreCoordinatorError('continuity-unavailable');
      }
    },
    async verifyRestored() {
      coordination.diagnostic = 'verify-continuity';
      const payload: CollabTransferredMembershipRedemptionReceiptSigningPayload = {
        checkpointSha256: CHECKPOINT_SHA256,
        claimSha256: CLAIM_SHA256,
        memberId: OFFLINE_MEMBER_ID,
        operationIntentId: 'redeem-restored-member',
        projectId: PROJECT_A,
        receiptId: 'receipt-restored-member',
        receiptKeyId: 'receipt-key-restore',
        redeemedAt: REDEEMED_AT,
        signatureAlgorithm: 'ed25519',
        targetAuthorityGeneration: 5,
        transferId: TRANSFER_ID,
      };
      const signingInput =
        encodeCollabTransferredMembershipRedemptionReceiptSigningInput(payload);
      const receipt: CollabTransferredMembershipRedemptionReceipt = {
        ...payload,
        signature: sign(
          null,
          Buffer.from(signingInput, 'utf8'),
          receiptPrivateKey,
        ).toString('base64url'),
      };
      await coordination.store().withProjectScope(PROJECT_A, async scope => {
        const restoredClaim = await scope.portability
          .findTransferredMembershipClaimBySha256(TRANSFER_ID, CLAIM_SHA256);
        assert.equal(restoredClaim?.memberId, OFFLINE_MEMBER_ID);
        const restoredEnvelope = await scope.portability.getProtectedClaimEnvelope(
          TRANSFER_ID,
          OFFLINE_MEMBER_ID,
        );
        if (restoredClaim.state === 'unclaimed') {
          assert.ok(restoredEnvelope);
          assert.equal(await custody.open(restoredEnvelope), CLAIM);
        } else {
          assert.equal(restoredClaim.state, 'redeemed');
          assert.equal(restoredEnvelope, undefined);
        }
        const restoredReceiptKey = await scope.portability.getTransferReceiptKey(
          TRANSFER_ID,
          receipt.receiptKeyId,
        );
        assert.ok(restoredReceiptKey);
        assert.equal(verify(
          null,
          Buffer.from(signingInput, 'utf8'),
          createPublicKey({
            format: 'jwk',
            key: {
              crv: 'Ed25519',
              kty: 'OKP',
              x: restoredReceiptKey.publicKey,
            },
          }),
          Buffer.from(receipt.signature, 'base64url'),
        ), true);
        const redeemInput = {
          claimSha256: CLAIM_SHA256,
          memberId: OFFLINE_MEMBER_ID,
          operationIntentId: receipt.operationIntentId,
          receipt,
          targetPrincipalId: 'principal:restored-member',
          transferId: TRANSFER_ID,
          updatedAt: REDEEMED_AT,
        } as const;
        assert.deepEqual(
          await scope.portability.redeemTransferredMembershipClaim(redeemInput),
          receipt,
        );
        assert.deepEqual(
          await scope.portability.redeemTransferredMembershipClaim(redeemInput),
          receipt,
        );
        assert.equal(await scope.portability.scrubProtectedClaimEnvelope({
          acknowledgedAt: ACKNOWLEDGED_AT,
          memberId: OFFLINE_MEMBER_ID,
          receipt,
          transferId: TRANSFER_ID,
        }), restoredClaim.state === 'unclaimed' ? 'scrubbed' : 'replayed');
        assert.equal(await scope.portability.scrubProtectedClaimEnvelope({
          acknowledgedAt: ACKNOWLEDGED_AT,
          memberId: OFFLINE_MEMBER_ID,
          receipt,
          transferId: TRANSFER_ID,
        }), 'replayed');
        assert.equal(await scope.portability.getProtectedClaimEnvelope(
          TRANSFER_ID,
          OFFLINE_MEMBER_ID,
        ), undefined);
        assert.equal(
          (await scope.portability.findProjectPrincipalBinding(
            'principal:restored-member',
          ))?.memberId,
          OFFLINE_MEMBER_ID,
        );
      });
      coordination.diagnostic = 'continuity-verified';
    },
  });
}

describe('Environment restore with real PostgreSQL and Git', () => {
  it('recovers with fresh ports after every phase before opening readiness', async () => {
    for (const failedPhase of ENVIRONMENT_RESTORE_PHASES) {
      await withPostgresTestDatabase(async database => {
        const root = await mkdtemp(join(tmpdir(), 'claudian-environment-restore-'));
        const authorityRoot = join(root, 'authority');
        await mkdir(authorityRoot, { mode: 0o700 });
        const fixtures = new Map<CollabProjectId, GitFixture>([
          [PROJECT_A, await createGitFixture(root, 'a')],
          [PROJECT_B, await createGitFixture(root, 'b')],
        ]);
        const custody = new XChaCha20ClaimCustody({
          activeKeyId: 'claim-key-restore',
          keys: [{
            key: Buffer.alloc(32, 9),
            keyId: 'claim-key-restore',
            keyVersion: 1,
          }],
        });
        const envelope = await custody.seal({
          associatedData: {
            authorityGeneration: 4,
            checkpointSha256: CHECKPOINT_SHA256,
            claimSha256: CLAIM_SHA256,
            envelopeVersion: 1,
            environmentIdentity: 'restored-volume-real',
            memberId: OFFLINE_MEMBER_ID,
            projectId: PROJECT_A,
            transferId: TRANSFER_ID,
          },
          claim: CLAIM,
          createdAt: CREATED_AT,
          expiresAt: EXPIRES_AT,
          receiptKeyId: 'receipt-key-restore',
        });
        const receiptKeys = generateKeyPairSync('ed25519');
        const receiptPublicJwk = receiptKeys.publicKey.export({ format: 'jwk' });
        const receiptPublicKey = receiptPublicJwk.x;
        if (receiptPublicKey === undefined) assert.fail('missing-ed25519-public-key');
        let repositories = new RealGitRestorePort(authorityRoot, fixtures);
        let coordination = new RealPostgresRestorePort(
          database,
          envelope,
          fixtures,
          receiptPublicKey,
        );
        try {
          await repositories.initialize();
          const first = new EnvironmentRestoreCoordinator({
            backup: backupVerifier(),
            clock: () => new Date(CREATED_AT),
            continuity: continuity(
              custody,
              envelope,
              coordination,
              receiptKeys.privateKey,
            ),
            coordination,
            repositories,
            state: new FailingRestoreState(
              new FileEnvironmentRestoreState({ authorityRoot }),
              failedPhase,
            ),
          });
          await assert.rejects(
            first.restore({
              authorityVolumeId: database.authorityVolumeId,
              authorityVolumeIdentity: 'restored-volume-real',
              catalogId: 'environment-backup-real',
              expectedCatalogSha256: CATALOG_SHA256,
              operationId: OPERATION_ID,
            }),
            (error: unknown) => {
              assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
              assert.equal(error.code, 'dependency-failed');
              return true;
            },
            failedPhase,
          );
          assert.equal(
            (await new FileEnvironmentRestoreState({ authorityRoot }).inspect())
              .journal?.phase,
            failedPhase,
          );

          await coordination.close();
          await repositories.close();
          repositories = new RealGitRestorePort(authorityRoot, fixtures);
          coordination = new RealPostgresRestorePort(
            database,
            envelope,
            fixtures,
            receiptPublicKey,
          );
          if (
            ENVIRONMENT_RESTORE_PHASES.indexOf(failedPhase)
              >= ENVIRONMENT_RESTORE_PHASES.indexOf('database-created')
          ) coordination.resumeExistingDatabase();
          const restarted = new EnvironmentRestoreCoordinator({
            backup: backupVerifier(),
            clock: () => new Date(CREATED_AT),
            continuity: continuity(
              custody,
              envelope,
              coordination,
              receiptKeys.privateKey,
            ),
            coordination,
            repositories,
            state: new FileEnvironmentRestoreState({ authorityRoot }),
          });
          let result;
          try {
            result = await restarted.recover();
          } catch (error: unknown) {
            const phase = (await new FileEnvironmentRestoreState({
              authorityRoot,
            }).inspect()).journal?.phase ?? 'absent';
            throw new Error(
              `environment-restore-integration.${failedPhase}.${phase}.${coordination.diagnostic}.${repositories.diagnostic}`,
              { cause: error },
            );
          }
          assert.deepEqual(result, {
            catalogId: 'environment-backup-real',
            catalogSha256: CATALOG_SHA256,
            completedAt: CREATED_AT,
            operationId: OPERATION_ID,
            projectCount: 2,
            restoreEpoch: 4,
            state: 'completed',
          }, failedPhase);
          assert.equal(
            (await new FileEnvironmentRestoreState({ authorityRoot }).inspect())
              .journal?.phase,
            'completed',
            failedPhase,
          );
        } finally {
          await coordination.close();
          await repositories.close();
          await rm(root, { force: true, recursive: true });
        }
      });
    }
  });

  it('removes exact real restore-owned state at every pre-publication phase', async () => {
    const authorityPublishedIndex = ENVIRONMENT_RESTORE_PHASES.indexOf(
      'authority-published',
    );
    for (const failedPhase of ENVIRONMENT_RESTORE_PHASES.slice(
      0,
      authorityPublishedIndex,
    )) {
      await withPostgresTestDatabase(async database => {
        const root = await mkdtemp(join(tmpdir(), 'claudian-restore-cleanup-'));
        const authorityRoot = join(root, 'authority');
        await mkdir(authorityRoot, { mode: 0o700 });
        const fixtures = new Map<CollabProjectId, GitFixture>([
          [PROJECT_A, await createGitFixture(root, 'a')],
          [PROJECT_B, await createGitFixture(root, 'b')],
        ]);
        const custody = new XChaCha20ClaimCustody({
          activeKeyId: 'claim-key-restore',
          keys: [{
            key: Buffer.alloc(32, 9),
            keyId: 'claim-key-restore',
            keyVersion: 1,
          }],
        });
        const envelope = await custody.seal({
          associatedData: {
            authorityGeneration: 4,
            checkpointSha256: CHECKPOINT_SHA256,
            claimSha256: CLAIM_SHA256,
            envelopeVersion: 1,
            environmentIdentity: 'restored-volume-real',
            memberId: OFFLINE_MEMBER_ID,
            projectId: PROJECT_A,
            transferId: TRANSFER_ID,
          },
          claim: CLAIM,
          createdAt: CREATED_AT,
          expiresAt: EXPIRES_AT,
          receiptKeyId: 'receipt-key-restore',
        });
        const receiptKeys = generateKeyPairSync('ed25519');
        const receiptPublicJwk = receiptKeys.publicKey.export({ format: 'jwk' });
        const receiptPublicKey = receiptPublicJwk.x;
        if (receiptPublicKey === undefined) assert.fail('missing-ed25519-public-key');
        const repositories = new RealGitRestorePort(authorityRoot, fixtures);
        const coordination = new RealPostgresRestorePort(
          database,
          envelope,
          fixtures,
          receiptPublicKey,
        );
        try {
          await repositories.initialize();
          const coordinator = new EnvironmentRestoreCoordinator({
            backup: backupVerifier(),
            clock: () => new Date(CREATED_AT),
            continuity: continuity(
              custody,
              envelope,
              coordination,
              receiptKeys.privateKey,
            ),
            coordination,
            repositories,
            state: new FailingRestoreState(
              new FileEnvironmentRestoreState({ authorityRoot }),
              failedPhase,
            ),
          });
          await assert.rejects(
            coordinator.restore({
              authorityVolumeId: database.authorityVolumeId,
              authorityVolumeIdentity: 'restored-volume-real',
              catalogId: 'environment-backup-real',
              expectedCatalogSha256: CATALOG_SHA256,
              operationId: OPERATION_ID,
            }),
            (error: unknown) => {
              assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
              assert.equal(error.code, 'dependency-failed');
              return true;
            },
            failedPhase,
          );

          assert.equal(await coordinator.cancel({
            expectedCatalogSha256: CATALOG_SHA256,
            operationId: OPERATION_ID,
          }), 'cancelled', failedPhase);
          assert.deepEqual(
            await new FileEnvironmentRestoreState({ authorityRoot }).inspect(),
            { journal: undefined, pair: 'absent' },
            failedPhase,
          );
          await coordination.assertEmpty();
          try {
            await repositories.assertEmpty();
          } catch (error: unknown) {
            throw new Error(`environment-restore-cleanup.${failedPhase}`, {
              cause: error,
            });
          }
        } finally {
          await coordination.close();
          await repositories.close();
          await rm(root, { force: true, recursive: true });
        }
      });
    }
  });
});
