import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  createEnvironmentBackupCatalog,
  EnvironmentBackupCatalogVerifier,
} from '../../src/environment-maintenance/restore/EnvironmentBackupCatalog.js';
import {
  createTerminalProjectContinuityArtifact,
  decodeTerminalProjectContinuityArtifact,
} from '../../src/environment-maintenance/restore/TerminalProjectContinuityArtifact.js';

const projects = Object.freeze([
  Object.freeze({
    authorityGeneration: 2,
    backupId: 'backup-project-b',
    checkpointSha256: 'b'.repeat(64),
    expiresAt: '9999-12-31T23:59:59.999Z',
    placementGeneration: 4,
    projectId: 'project-b',
  }),
  Object.freeze({
    authorityGeneration: 1,
    backupId: 'backup-project-a',
    checkpointSha256: 'a'.repeat(64),
    expiresAt: '9999-12-31T23:59:59.999Z',
    placementGeneration: 3,
    projectId: 'project-a',
  }),
]);

describe('environment backup catalog publication', () => {
  it('verifies a terminal-only catalog against its immutable continuity artifact', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const artifact = createTerminalProjectContinuityArtifact(projectId, [{
      kind: 'tombstone',
      recordId: projectId,
      revision: 1,
      value: {
        authorityGeneration: 1,
        projectId,
        retiredAt: '2026-08-29T00:00:00.000Z',
        terminalExpiresAt: '2026-09-29T00:00:00.000Z',
      },
    }] as never);
    const publication = createEnvironmentBackupCatalog({
      authorityId: 'authority-a',
      authorityVolumeIdentity: 'volume-a',
      catalogId: 'catalog-terminal',
      coordinationSchemaVersion: 9,
      createdAt: '2026-08-29T00:00:00.000Z',
      projects: [],
      repositoryFormatVersion: 1,
      restoreEpoch: 2,
      serverBuild: 'development',
      terminalProjects: [{
        artifactByteCount: Buffer.byteLength(artifact.json, 'utf8'),
        artifactSha256: artifact.sha256,
        projectId,
      }],
    });
    const verifier = new EnvironmentBackupCatalogVerifier({
      coordinationSchemaVersion: 9,
      repositoryFormatVersion: 1,
      serverBuild: 'development',
      source: {
        readCatalog: () => Promise.resolve(JSON.parse(publication.json)),
        verifyProjectBackup: () => assert.fail('unexpected Project backup'),
        verifyTerminalProjectBackup: () => Promise.resolve(artifact),
      },
    });

    const verified = await verifier.validate({
      catalogId: publication.catalog.catalogId,
      expectedCatalogSha256: publication.catalog.catalogSha256,
      signal: new AbortController().signal,
    });
    assert.deepEqual(verified.projects, []);
    assert.equal(verified.terminalProjects[0]?.projectId, projectId);
  });

  it('rejects noncanonical terminal record values before publication or restore', () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const document = JSON.stringify({
      projectId,
      records: [{
        kind: 'tombstone',
        recordId: projectId,
        revision: 1,
        value: {
          authorityGeneration: '1',
          projectId,
          retiredAt: 'not-a-timestamp',
          terminalExpiresAt: 'also-not-a-timestamp',
        },
      }],
      schemaVersion: 1,
    });
    const sha256 = createHash('sha256')
      .update(document, 'utf8')
      .digest('hex');

    assert.throws(
      () => decodeTerminalProjectContinuityArtifact(document, {
        projectId,
        sha256,
      }),
      /terminal-project-continuity-artifact\.error/u,
    );
  });

  it('creates a canonical sorted catalog accepted by the independent verifier', async () => {
    const publication = createEnvironmentBackupCatalog({
      authorityId: 'authority-a',
      authorityVolumeIdentity: 'volume-a',
      catalogId: 'catalog-a',
      coordinationSchemaVersion: 9,
      createdAt: '2026-08-29T00:00:00.000Z',
      projects,
      repositoryFormatVersion: 1,
      restoreEpoch: 2,
      serverBuild: '0.0.0',
      terminalProjects: [],
    });
    const verifier = new EnvironmentBackupCatalogVerifier({
      coordinationSchemaVersion: 9,
      repositoryFormatVersion: 1,
      serverBuild: '0.0.0',
      source: {
        readCatalog: () => Promise.resolve(JSON.parse(publication.json)),
        verifyProjectBackup: input => Promise.resolve(Object.freeze({
          ...input.project,
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 9,
          maximumServerBuild: '0.0.0',
          minimumServerBuild: '0.0.0',
          repositoryFormatVersion: 1,
          restoreEpoch: 2,
        })),
      },
    });

    const verified = await verifier.validate({
      catalogId: 'catalog-a',
      expectedCatalogSha256: publication.catalog.catalogSha256,
      signal: new AbortController().signal,
    });

    assert.deepEqual(
      verified.projects.map(project => project.projectId),
      ['project-a', 'project-b'],
    );
    assert.equal(
      JSON.stringify(JSON.parse(publication.json)),
      publication.json,
    );
  });
});
