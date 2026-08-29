import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  COLLAB_PROJECT_BACKUP_COORDINATION_FORMAT_VERSION,
  COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
  COLLAB_PROTOCOL_VERSION,
  encodeCollabProjectBackupCheckpointCoordinationNdjson,
  encodeCollabProjectBackupCheckpointManifestCanonicalJson,
  encodeCollabProjectBackupCheckpointManifestDigestInput,
  type CollabProjectBackupCheckpointManifest,
  type CollabProjectBackupRecord,
} from '@claudian-collab/protocol';

import {
  productionCheckpointAttemptIdentity,
  type ProductionCheckpointStagingPort,
  type StagedProductionCheckpointArtifact,
} from '../../src/onboarding/production/ProductionCheckpointStaging.js';
import { CoordinationError } from '../../src/coordination/CoordinationError.js';
import { ProjectCheckpointCoordinator } from '../../src/project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import type { RepositoryCheckpointCapturePort } from '../../src/repositories/RepositoryCheckpointAuthority.js';
import { EnvironmentRestoreCoordinationAdapter } from '../../src/environment-maintenance/restore/EnvironmentRestoreCoordinationAdapter.js';
import { EnvironmentRestoreContinuityVerifier } from '../../src/environment-maintenance/restore/EnvironmentRestoreContinuityVerifier.js';
import { EnvironmentRestoreRepositoryAdapter } from '../../src/environment-maintenance/restore/EnvironmentRestoreRepositoryAdapter.js';
import { FileEnvironmentBackupCatalogSource } from '../../src/environment-maintenance/restore/FileEnvironmentBackupCatalogSource.js';
import { EnvironmentBackupCatalogVerifierError } from '../../src/environment-maintenance/restore/EnvironmentBackupCatalog.js';
import { createTerminalProjectContinuityArtifact } from '../../src/environment-maintenance/restore/TerminalProjectContinuityArtifact.js';
import {
  PublishedEnvironmentBackupSource,
} from '../../src/environment-maintenance/restore/PublishedEnvironmentBackupSource.js';
import {
  EnvironmentRestoreCoordinatorError,
  type EnvironmentRestoreCatalog,
  type EnvironmentRestoreProject,
  type EnvironmentRestoreRepositoryPublication,
} from '../../src/environment-maintenance/restore/EnvironmentRestoreCoordinator.js';
/*
 * This real custody implementation proves the restore verifier receives the
 * exact sealed envelope shape rather than a test-only decrypted claim.
 */
import { XChaCha20ClaimCustody } from '../../src/project-authority/lifecycle/cloud-to-lan/XChaCha20ClaimCustody.js';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CREATED_AT = '2026-08-29T00:00:00.000Z';
const EXPIRES_AT = '2026-09-29T00:00:00.000Z';
const MAIN_OID = 'a'.repeat(40);
const REPOSITORY_BYTES = Buffer.from('canonical repository bundle', 'utf8');

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function backupRecords(): readonly CollabProjectBackupRecord[] {
  return Object.freeze([
    Object.freeze({
      kind: 'project' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        authorityGeneration: 4,
        createdAt: CREATED_AT,
        expectedMainOid: MAIN_OID,
        managerSetGeneration: 1,
        name: 'Project A',
        projectId: PROJECT_ID,
      }),
    }),
    Object.freeze({
      kind: 'member' as const,
      recordId: 'member-manager',
      revision: 1,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Manager',
        memberId: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        projectId: PROJECT_ID,
        role: 'manager' as const,
        status: 'active' as const,
        revokedAt: null,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'cloud-event-cursor' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        currentSequence: 0,
        projectId: PROJECT_ID,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'repository-placement' as const,
      recordId: `repository-placement:${PROJECT_ID}`,
      revision: 7,
      value: Object.freeze({
        nodeId: 'source-node',
        placementGeneration: 7,
        projectId: PROJECT_ID,
        repositoryIdentity: 'source-repository',
      }),
    }),
    Object.freeze({
      kind: 'schema-catalog' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        coordinationSchemaVersion: 9,
        projectId: PROJECT_ID,
        repositoryFormatVersion: 1,
      }),
    }),
    Object.freeze({
      kind: 'server-compatibility' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        maximumBuild: 'cloud-build-a',
        minimumBuild: 'cloud-build-a',
        projectId: PROJECT_ID,
      }),
    }),
    Object.freeze({
      kind: 'authority-volume-pair' as const,
      recordId: PROJECT_ID,
      revision: 1,
      value: Object.freeze({
        authorityId: 'cloud-authority-a',
        authorityVolumeIdentity: 'source-volume-a',
        projectId: PROJECT_ID,
        restoreEpoch: 3,
      }),
    }),
  ]);
}

const COORDINATION_BYTES = Buffer.from(
  encodeCollabProjectBackupCheckpointCoordinationNdjson(backupRecords()),
  'utf8',
);

function manifest(): CollabProjectBackupCheckpointManifest {
  const unsigned: CollabProjectBackupCheckpointManifest = Object.freeze({
    artifacts: Object.freeze([
      Object.freeze({
        byteCount: COORDINATION_BYTES.length,
        name: 'coordination.ndjson' as const,
        sha256: sha256(COORDINATION_BYTES),
      }),
      Object.freeze({
        byteCount: REPOSITORY_BYTES.length,
        name: 'repository.bundle' as const,
        sha256: sha256(REPOSITORY_BYTES),
      }),
    ]),
    coordinationFormatVersion: COLLAB_PROJECT_BACKUP_COORDINATION_FORMAT_VERSION,
    createdAt: CREATED_AT,
    expectedMainOid: MAIN_OID,
    gitObjectFormat: 'sha1',
    manifestSchemaVersion: COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
    manifestSha256: '0'.repeat(64),
    operationId: 'backup-project-a',
    profile: 'backup',
    projectId: PROJECT_ID,
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    refs: Object.freeze([Object.freeze({
      name: 'refs/heads/main',
      oid: MAIN_OID,
    }), Object.freeze({
      name: 'refs/heads/members/member-manager',
      oid: MAIN_OID,
    })]),
    sourceAuthority: Object.freeze({ generation: 4, kind: 'cloud' }),
    targetAuthority: null,
  });
  return Object.freeze({
    ...unsigned,
    manifestSha256: sha256(
      encodeCollabProjectBackupCheckpointManifestDigestInput(unsigned),
    ),
  });
}

function project(checkpointSha256: string): EnvironmentRestoreProject {
  return Object.freeze({
    authorityGeneration: 4,
    backupId: 'backup-project-a',
    checkpointSha256,
    expiresAt: EXPIRES_AT,
    placementGeneration: 7,
    projectId: PROJECT_ID,
  });
}

function publishedSource(options: Readonly<{
  readonly failReservation?: boolean;
  readonly failVerification?: boolean;
}> = {}) {
  const exactManifest = manifest();
  const manifestBytes = Buffer.from(
    encodeCollabProjectBackupCheckpointManifestCanonicalJson(exactManifest),
    'utf8',
  );
  const attempt = productionCheckpointAttemptIdentity({
    expiresAt: EXPIRES_AT,
    operationId: 'backup-project-a',
    projectId: PROJECT_ID,
  });
  const artifactBytes = new Map([
    ['checkpoint.json', manifestBytes],
    ['coordination.ndjson', COORDINATION_BYTES],
    ['repository.bundle', REPOSITORY_BYTES],
  ] as const);
  const artifacts = Object.freeze([...artifactBytes].map(([name, bytes]) => (
    Object.freeze({
      attemptKey: attempt.attemptKey,
      byteCount: bytes.length,
      name,
      operationId: attempt.operationId,
      projectId: attempt.projectId,
      sha256: sha256(bytes),
    }) as StagedProductionCheckpointArtifact
  )));
  const events: string[] = [];
  const publication: ProductionCheckpointStagingPort & Readonly<{
    listDueDeliveries: () => Promise<Readonly<{
      readonly deliveries: readonly never[];
      readonly nextCursor: undefined;
    }>>;
    registerDelivery: () => Promise<'registered'>;
  }> = {
    discardAttempt: () => Promise.resolve('replayed'),
    expireAttempt: () => Promise.resolve('retained'),
    inspectAttempt: () => Promise.resolve(Object.freeze({ artifacts, attempt })),
    listDueDeliveries: () => Promise.resolve(Object.freeze({
      deliveries: Object.freeze([]),
      nextCursor: undefined,
    })),
    prepareAttempt: () => Promise.resolve(attempt),
    readArtifact: async input => {
      const bytes = artifactBytes.get(input.artifact.name);
      assert.ok(bytes);
      await input.onChunk(bytes, input.signal ?? new AbortController().signal);
    },
    receiveArtifact: () => Promise.reject(new Error('not-used')),
    registerDelivery: () => Promise.resolve('registered'),
  };
  const repositoryCapture: RepositoryCheckpointCapturePort = {
    capture: () => Promise.reject(new Error('not-used')),
    discardCapture: () => Promise.resolve('replayed'),
    discardCaptureOperation: () => {
      events.push('checkpoint-released');
      return Promise.resolve('replayed');
    },
    inventoryRefs: () => Promise.resolve(exactManifest.refs),
    readCapture: () => Promise.reject(new Error('not-used')),
    reserveCaptureOperation: projectId => {
      if (options.failReservation === true) {
        events.push('reservation-failed');
        return Promise.reject(new Error('reservation-failed'));
      }
      return Promise.resolve(Object.freeze({
        close: () => {
          events.push('reservation-closed');
          return Promise.resolve();
        },
        projectId,
      }));
    },
    verifyArtifact: async (_reservation, input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, input.expectedByteCount);
      assert.equal(sha256(bytes), input.expectedSha256);
      if (options.failVerification === true) {
        events.push('checkpoint-verification-failed');
        throw new Error('verification-failed');
      }
      events.push('checkpoint-verified');
      return Object.freeze({
        artifactKey: 'f'.repeat(64),
        bundleByteCount: bytes.length,
        bundleInputDisposition: 'consumed',
        bundleSha256: input.expectedSha256,
        markerSha256: 'e'.repeat(64),
        objectFormat: input.objectFormat,
        operationId: input.operationId,
        projectId: input.projectId,
        refs: input.refs,
      });
    },
  };
  const checkpoint = new ProjectCheckpointCoordinator({
    maximumCoordinationBytes: 1024 * 1024,
    publication: {
      backup: publication,
      export: publication,
    },
    repository: {
      discardCheckpoint: () => Promise.resolve('replayed'),
      importCheckpoint: () => Promise.reject(new Error('not-used')),
    },
    repositoryCapture,
    staging: { ...publication },
  });
  const source = new PublishedEnvironmentBackupSource({
    catalog: { readCatalog: () => Promise.resolve({}) },
    checkpoint,
    publication,
  });
  return Object.freeze({ exactManifest, events, source });
}

function catalog(exactProject: EnvironmentRestoreProject): EnvironmentRestoreCatalog {
  return Object.freeze({
    authorityId: 'cloud-authority-a',
    authorityVolumeIdentity: 'source-volume-a',
    catalogId: 'environment-catalog-a',
    catalogSha256: 'c'.repeat(64),
    coordinationSchemaVersion: 9,
    createdAt: CREATED_AT,
    maximumServerBuild: 'cloud-build-a',
    minimumServerBuild: 'cloud-build-a',
    projects: Object.freeze([exactProject]),
    repositoryFormatVersion: 1,
    restoreEpoch: 3,
    terminalProjects: Object.freeze([]),
  });
}

describe('production environment restore adapters', () => {
  it('requires the common repository verifier before reading a Project backup', () => {
    assert.throws(
      () => new PublishedEnvironmentBackupSource({
        catalog: { readCatalog: () => Promise.resolve({}) },
        checkpoint: undefined as never,
        publication: {
          inspectAttempt: () => assert.fail('unexpected attempt inspection'),
          readArtifact: () => assert.fail('unexpected artifact read'),
        },
      }),
      /published-environment-backup-source\.options-invalid/u,
    );
  });

  it('verifies a self-contained backup before the clean target database exists', async () => {
    const { exactManifest, events, source } = publishedSource();
    const exactProject = project(exactManifest.manifestSha256);
    const backup = await source.readProjectBackup({
      project: exactProject,
      signal: new AbortController().signal,
    });
    assert.equal(backup.manifest.projectId, PROJECT_ID);
    assert.deepEqual(backup.records, backupRecords());
    assert.deepEqual(events, [
      'checkpoint-verified',
      'checkpoint-released',
      'reservation-closed',
    ]);
  });

  it('releases exact verification scratch after repository verification fails', async () => {
    const { exactManifest, events, source } = publishedSource({
      failVerification: true,
    });
    await assert.rejects(
      source.readProjectBackup({
        project: project(exactManifest.manifestSha256),
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentBackupCatalogVerifierError);
        assert.equal(error.code, 'dependency-failed');
        return true;
      },
    );
    assert.deepEqual(events, [
      'checkpoint-verification-failed',
      'checkpoint-released',
      'reservation-closed',
    ]);
  });

  it('does not release verification scratch without owning its reservation', async () => {
    const { exactManifest, events, source } = publishedSource({
      failReservation: true,
    });
    await assert.rejects(source.readProjectBackup({
      project: project(exactManifest.manifestSha256),
      signal: new AbortController().signal,
    }));
    assert.deepEqual(events, ['reservation-failed']);
  });

  it('imports and verifies terminal continuity without a Project repository', async () => {
    const artifact = createTerminalProjectContinuityArtifact(PROJECT_ID, [{
      kind: 'tombstone',
      recordId: PROJECT_ID,
      revision: 1,
      value: {
        authorityGeneration: 4,
        projectId: PROJECT_ID,
        retiredAt: CREATED_AT,
        terminalExpiresAt: EXPIRES_AT,
      },
    }] as never);
    const terminalProject = Object.freeze({
      artifactByteCount: Buffer.byteLength(artifact.json, 'utf8'),
      artifactSha256: artifact.sha256,
      projectId: PROJECT_ID,
    });
    const events: string[] = [];
    const adapter = new EnvironmentRestoreCoordinationAdapter({
      source: {
        readProjectBackup: () => assert.fail('unexpected Project backup'),
        readTerminalProjectBackup: () => Promise.resolve(artifact),
      },
      storage: {
        assertEmpty: () => Promise.resolve(),
        classifyOrRemoveRestoreOwnedDatabase: () => Promise.resolve('replayed'),
        createDatabase: () => Promise.resolve({ authorityVolumeId: 'volume-a' }),
        importProject: () => assert.fail('unexpected Project import'),
        importTerminalProject: input => {
          events.push(`import:${input.projectId}`);
          assert.deepEqual(input.records, artifact.records);
          return Promise.resolve();
        },
        publishAuthority: () => Promise.resolve(),
        verifyDatabaseIdentity: () => Promise.resolve(),
        verifyRestoredProject: () => assert.fail('unexpected Project verify'),
        verifyRestoredTerminalProject: input => {
          events.push(`verify:${input.projectId}`);
          assert.deepEqual(input.records, artifact.records);
          return Promise.resolve();
        },
      },
    });
    const terminalCatalog = Object.freeze({
      ...catalog(project('a'.repeat(64))),
      projects: Object.freeze([]),
      terminalProjects: Object.freeze([terminalProject]),
    });

    await adapter.importCoordination({
      catalog: terminalCatalog,
      operationId: 'restore-terminal-a',
      restoreEpoch: 4,
      signal: new AbortController().signal,
    });
    await adapter.verifyRestored({
      catalog: terminalCatalog,
      operationId: 'restore-terminal-a',
      repositories: Object.freeze([]),
      restoreEpoch: 4,
      signal: new AbortController().signal,
    });
    assert.deepEqual(events, [`import:${PROJECT_ID}`, `verify:${PROJECT_ID}`]);
  });

  it('verifies terminal continuity key references before reopening it', async () => {
    const artifact = createTerminalProjectContinuityArtifact(PROJECT_ID, [{
      kind: 'tombstone',
      recordId: PROJECT_ID,
      revision: 1,
      value: {
        authorityGeneration: 4,
        projectId: PROJECT_ID,
        retiredAt: CREATED_AT,
        terminalExpiresAt: EXPIRES_AT,
      },
    }] as never);
    const checked: unknown[] = [];
    const source = new PublishedEnvironmentBackupSource({
      catalog: {
        readCatalog: () => assert.fail('unexpected catalog read'),
        readTerminalArtifact: () => Promise.resolve(artifact.json),
      },
      checkpoint: {
        readPublishedOutboundRecords: () => assert.fail('unexpected record read'),
        releaseOutboundOperation: () => assert.fail('unexpected release'),
        reserveOutbound: () => assert.fail('unexpected reservation'),
        verifyOutboundOperation: () => assert.fail('unexpected verification'),
      },
      publication: {
        inspectAttempt: () => assert.fail('unexpected attempt inspection'),
        readArtifact: () => assert.fail('unexpected artifact read'),
      },
      keyReferences: {
        verify: records => {
          checked.push(records);
          return Promise.resolve();
        },
      },
    });

    assert.equal((await source.readTerminalProjectBackup({
      signal: new AbortController().signal,
      terminalProject: {
        artifactByteCount: Buffer.byteLength(artifact.json, 'utf8'),
        artifactSha256: artifact.sha256,
        projectId: PROJECT_ID,
      },
    })).sha256, artifact.sha256);
    assert.deepEqual(checked, [artifact.records]);
  });

  it('maps coordination persistence failures at the environment boundary', async () => {
    const coordination = new EnvironmentRestoreCoordinationAdapter({
      source: {
        readProjectBackup: () => Promise.reject(
          new Error('backup-must-not-be-read'),
        ),
      },
      storage: {
        assertEmpty: () => Promise.reject(new CoordinationError('state-conflict')),
        classifyOrRemoveRestoreOwnedDatabase: () => Promise.resolve('replayed'),
        createDatabase: () => Promise.reject(
          new CoordinationError('dependency-failed'),
        ),
        importProject: () => Promise.resolve(),
        publishAuthority: () => Promise.resolve(),
        verifyDatabaseIdentity: () => Promise.resolve(),
        verifyRestoredProject: () => Promise.resolve(),
      },
    });
    await assert.rejects(
      coordination.assertEmpty(new AbortController().signal),
      (error: unknown) => (
        error instanceof EnvironmentRestoreCoordinatorError
        && error.code === 'non-empty'
      ),
    );
    await assert.rejects(
      coordination.createDatabase({
        authorityId: 'authority-a',
        authorityVolumeId: 'volume-a',
        authorityVolumeIdentity: 'volume-identity-a',
        coordinationSchemaVersion: 9,
        operationId: 'restore-a',
        restoreEpoch: 2,
        signal: new AbortController().signal,
      }),
      (error: unknown) => (
        error instanceof EnvironmentRestoreCoordinatorError
        && error.code === 'dependency-failed'
        && error.retryable
      ),
    );
  });

  it('reopens and verifies the canonical O1 publication before exposing it', async () => {
    const { exactManifest, events, source } = publishedSource();
    const exactProject = project(exactManifest.manifestSha256);
    const verified = await source.verifyProjectBackup({
      project: exactProject,
      signal: new AbortController().signal,
    });
    assert.equal(verified.checkpointSha256, exactManifest.manifestSha256);
    assert.equal(verified.expiresAt, EXPIRES_AT);
    const checkpoint = await source.readProjectBackup({
      project: exactProject,
      signal: new AbortController().signal,
    });
    const repository: Buffer[] = [];
    await checkpoint.readRepository({
      onChunk: chunk => { repository.push(Buffer.from(chunk)); },
      signal: new AbortController().signal,
    });
    assert.deepEqual(Buffer.concat(repository), REPOSITORY_BYTES);
    assert.deepEqual(events, [
      'checkpoint-verified',
      'checkpoint-released',
      'reservation-closed',
      'checkpoint-verified',
      'checkpoint-released',
      'reservation-closed',
    ]);
  });

  it('routes canonical records and repository bytes through owning storage ports', async () => {
    const { exactManifest, source } = publishedSource();
    const exactProject = project(exactManifest.manifestSha256);
    const imported: string[] = [];
    let publication: EnvironmentRestoreRepositoryPublication | undefined;
    const repositories = new EnvironmentRestoreRepositoryAdapter({
      inspection: { assertEmpty: () => Promise.resolve() },
      publication: {
        planInactive: input => Object.freeze({
          artifactKey: input.checkpoint.artifactKey,
          bundleByteCount: input.checkpoint.bundleByteCount,
          bundleSha256: input.checkpoint.bundleSha256,
          objectFormat: input.checkpoint.objectFormat,
          operationId: input.checkpoint.operationId,
          placementGeneration: input.placementGeneration,
          projectId: input.checkpoint.projectId,
          publicationMarkerSha256: 'd'.repeat(64),
          refs: input.checkpoint.refs,
          repositoryStorageKey: input.repositoryStorageKey,
          status: 'inactive',
          storageNodeId: 'restore-node',
          validationMarkerSha256: input.checkpoint.markerSha256,
        }),
        publishInactive: input => {
          publication = Object.freeze({
            artifactKey: input.checkpoint.artifactKey,
            bundleByteCount: input.checkpoint.bundleByteCount,
            bundleSha256: input.checkpoint.bundleSha256,
            objectFormat: input.checkpoint.objectFormat,
            operationId: input.checkpoint.operationId,
            placementGeneration: input.placementGeneration,
            projectId: input.checkpoint.projectId,
            publicationMarkerSha256: 'd'.repeat(64),
            refs: input.checkpoint.refs,
            repositoryStorageKey: input.repositoryStorageKey,
            status: 'inactive',
            storageNodeId: 'restore-node',
            validationMarkerSha256: input.checkpoint.markerSha256,
          });
          return Promise.resolve(publication);
        },
        removeOwnedRepository: () => Promise.resolve('removed'),
      },
      source,
      staging: {
        discardCheckpoint: () => Promise.resolve('removed'),
        importCheckpoint: async input => {
          const chunks: Buffer[] = [];
          for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
          assert.deepEqual(Buffer.concat(chunks), REPOSITORY_BYTES);
          imported.push(input.projectId);
          return Object.freeze({
            artifactKey: '1'.repeat(64),
            bundleByteCount: input.expectedByteCount,
            bundleInputDisposition: 'consumed',
            bundleSha256: input.expectedSha256,
            markerSha256: '2'.repeat(64),
            objectFormat: input.objectFormat,
            operationId: input.operationId,
            projectId: input.projectId,
            refs: input.refs,
          });
        },
      },
    });
    const staged = await repositories.stage({
      operationId: 'restore-operation-a',
      projects: [exactProject],
      signal: new AbortController().signal,
    });
    await repositories.publish({
      operationId: 'restore-operation-a',
      repositories: staged,
      signal: new AbortController().signal,
    });
    assert.deepEqual(imported, [PROJECT_ID]);
    assert.deepEqual(publication, staged[0]);

    const coordinationEvents: string[] = [];
    const coordination = new EnvironmentRestoreCoordinationAdapter({
      source,
      storage: {
        assertEmpty: () => Promise.resolve(),
        classifyOrRemoveRestoreOwnedDatabase: () => Promise.resolve('removed'),
        createDatabase: input => Promise.resolve(Object.freeze({
          authorityVolumeId: input.authorityVolumeId,
        })),
        importProject: input => {
          coordinationEvents.push(`import:${input.project.projectId}`);
          assert.deepEqual(input.records, backupRecords());
          return Promise.resolve();
        },
        publishAuthority: () => Promise.resolve(),
        verifyDatabaseIdentity: () => Promise.resolve(),
        verifyRestoredProject: input => {
          coordinationEvents.push(`verify:${input.project.projectId}`);
          return Promise.resolve();
        },
      },
    });
    const environmentCatalog = catalog(exactProject);
    await coordination.importCoordination({
      catalog: environmentCatalog,
      operationId: 'restore-operation-a',
      restoreEpoch: 4,
      signal: new AbortController().signal,
    });
    await coordination.verifyRestored({
      catalog: environmentCatalog,
      operationId: 'restore-operation-a',
      repositories: staged,
      restoreEpoch: 4,
      signal: new AbortController().signal,
    });
    assert.deepEqual(coordinationEvents, [
      `import:${PROJECT_ID}`,
      `verify:${PROJECT_ID}`,
    ]);
  });

  it('aborts backup delivery when repository import rejects early', async () => {
    const { exactManifest, source } = publishedSource();
    const exactProject = project(exactManifest.manifestSha256);
    const backup = await source.readProjectBackup({
      project: exactProject,
      signal: new AbortController().signal,
    });
    let aborted = false;
    const repositories = new EnvironmentRestoreRepositoryAdapter({
      inspection: { assertEmpty: () => Promise.resolve() },
      publication: {
        planInactive: () => assert.fail('publication must not be planned'),
        publishInactive: () => Promise.reject(new Error('not-used')),
        removeOwnedRepository: () => Promise.resolve('replayed'),
      },
      source: {
        readProjectBackup: () => Promise.resolve(Object.freeze({
          ...backup,
          readRepository: (input: Readonly<{
            readonly onChunk: (
              chunk: Buffer,
              signal: AbortSignal,
            ) => Promise<void> | void;
            readonly signal: AbortSignal;
          }>) => (async () => {
            input.signal.addEventListener('abort', () => {
              aborted = true;
            }, { once: true });
            await input.onChunk(Buffer.alloc(128 * 1024), input.signal);
          })(),
        })),
      },
      staging: {
        discardCheckpoint: () => Promise.resolve('replayed'),
        importCheckpoint: () => Promise.reject(new Error('import-failed')),
      },
    });
    await assert.rejects(Promise.race([
      repositories.stage({
        operationId: 'restore-operation-a',
        projects: [exactProject],
        signal: new AbortController().signal,
      }),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('delivery-not-aborted')), 100).unref();
      }),
    ]));
    assert.equal(aborted, true);
  });

  it('opens every live protected envelope before creation and after restore', async () => {
    const { exactManifest, source } = publishedSource();
    const exactProject = project(exactManifest.manifestSha256);
    const backup = await source.readProjectBackup({
      project: exactProject,
      signal: new AbortController().signal,
    });
    const custody = new XChaCha20ClaimCustody({
      activeKeyId: 'restore-key-a',
      keys: [Object.freeze({
        key: Buffer.alloc(32, 7),
        keyId: 'restore-key-a',
        keyVersion: 1,
      })],
      nonceFactory: () => Buffer.alloc(24, 9),
    });
    const claim = Buffer.from('offline-member-claim', 'utf8').toString('base64url');
    const sealed = await custody.seal({
      associatedData: Object.freeze({
        authorityGeneration: 4,
        checkpointSha256: exactManifest.manifestSha256,
        claimSha256: sha256(claim),
        envelopeVersion: 1,
        environmentIdentity: 'source-volume-a',
        memberId: 'member-offline',
        projectId: PROJECT_ID,
        transferId: 'transfer-a',
      }),
      claim,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      receiptKeyId: 'receipt-key-a',
    });
    const { createdAt: _createdAt, ...envelopeValue } = sealed;
    assert.equal(_createdAt, CREATED_AT);
    const records: readonly CollabProjectBackupRecord[] = Object.freeze([
      ...backup.records,
      Object.freeze({
        kind: 'transfer-receipt-key' as const,
        recordId: 'transfer-a:receipt-key-a',
        revision: 1,
        value: Object.freeze({
          createdAt: CREATED_AT,
          projectId: PROJECT_ID,
          receiptKeyId: 'receipt-key-a',
          receiptPublicKey: Buffer.alloc(32, 3).toString('base64url'),
          receiptPublicKeyEncoding: 'base64url-raw' as const,
          signatureAlgorithm: 'ed25519' as const,
          transferId: 'transfer-a',
        }),
      }),
      Object.freeze({
        kind: 'protected-claim-envelope' as const,
        recordId: 'transfer-a:member-offline',
        revision: 1,
        value: Object.freeze(envelopeValue),
      }),
    ]);
    const opened: string[] = [];
    const verifier = new EnvironmentRestoreContinuityVerifier({
      clock: () => new Date(CREATED_AT),
      custody: {
        open: async envelope => {
          const openedClaim = await custody.open(envelope);
          opened.push(openedClaim);
          return openedClaim;
        },
      },
      source: {
        readProjectBackup: () => Promise.resolve(Object.freeze({
          ...backup,
          records,
        })),
      },
      storage: { readRestoredContinuity: () => Promise.resolve(records) },
    });
    await verifier.verifyBeforeCreation({
      catalog: catalog(exactProject),
      signal: new AbortController().signal,
    });
    await verifier.verifyRestored({
      catalog: catalog(exactProject),
      signal: new AbortController().signal,
    });
    assert.deepEqual(opened, [claim, claim]);
  });

  it('fails continuity before creation when a live envelope has no receipt key', async () => {
    const { exactManifest, source } = publishedSource();
    const exactProject = project(exactManifest.manifestSha256);
    const backup = await source.readProjectBackup({
      project: exactProject,
      signal: new AbortController().signal,
    });
    const records: readonly CollabProjectBackupRecord[] = Object.freeze([
      ...backup.records,
      Object.freeze({
        kind: 'protected-claim-envelope' as const,
        recordId: 'transfer-a:member-offline',
        revision: 1,
        value: Object.freeze({
          associatedData: Object.freeze({
            authorityGeneration: 4,
            checkpointSha256: exactManifest.manifestSha256,
            claimSha256: 'a'.repeat(64),
            envelopeVersion: 1 as const,
            environmentIdentity: 'source-volume-a',
            memberId: 'member-offline',
            projectId: PROJECT_ID,
            transferId: 'transfer-a',
          }),
          associatedDataSha256: 'b'.repeat(64),
          ciphertext: 'AA',
          encryptionAlgorithm: 'xchacha20-poly1305' as const,
          expiresAt: EXPIRES_AT,
          keyId: 'restore-key-a',
          keyVersion: 1,
          memberId: 'member-offline',
          nonce: 'AA',
          receiptKeyId: 'receipt-key-a',
          tag: 'AA',
          transferId: 'transfer-a',
        }),
      }),
    ]);
    const verifier = new EnvironmentRestoreContinuityVerifier({
      clock: () => new Date(CREATED_AT),
      custody: { open: () => assert.fail('missing key must fail first') },
      source: {
        readProjectBackup: () => Promise.resolve(Object.freeze({
          ...backup,
          records,
        })),
      },
      storage: { readRestoredContinuity: () => Promise.resolve(records) },
    });
    await assert.rejects(
      verifier.verifyBeforeCreation({
        catalog: catalog(exactProject),
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'continuity-unavailable');
        return true;
      },
    );
  });

  it('reads a private bounded environment catalog from its fixed root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-environment-catalog-'));
    const catalogId = 'environment-catalog-a';
    const file = join(root, `${Buffer.from(catalogId).toString('hex')}.json`);
    try {
      await writeFile(file, '{"schemaVersion":1}', { mode: 0o600 });
      const source = new FileEnvironmentBackupCatalogSource({ catalogRoot: root });
      assert.deepEqual(await source.readCatalog({
        catalogId,
        signal: new AbortController().signal,
      }), { schemaVersion: 1 });
      await mkdir(join(root, 'unrelated'), { mode: 0o700 });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
