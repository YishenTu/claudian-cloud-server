/* eslint-disable @typescript-eslint/require-await */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  EnvironmentBackupCatalogVerifier,
  EnvironmentBackupCatalogVerifierError,
} from '../../src/environment-maintenance/restore/EnvironmentBackupCatalog.js';

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function document(
  coordinationSchemaVersion = 9,
): Readonly<Record<string, unknown>> {
  const content = {
    authorityId: 'cloud-authority-a',
    authorityVolumeIdentity: 'authority-volume-a',
    catalogId: 'backup-catalog-a',
    coordinationSchemaVersion,
    createdAt: '2026-08-29T00:00:00.000Z',
    maximumServerBuild: 'cloud-build-a',
    minimumServerBuild: 'cloud-build-a',
    projects: [
      {
        authorityGeneration: 4,
        backupId: 'backup-project-a',
        checkpointSha256: 'a'.repeat(64),
        expiresAt: '2026-09-29T00:00:00.000Z',
        placementGeneration: 7,
        projectId: PROJECT_A,
      },
      {
        authorityGeneration: 2,
        backupId: 'backup-project-b',
        checkpointSha256: 'b'.repeat(64),
        expiresAt: '2026-09-29T00:00:00.000Z',
        placementGeneration: 3,
        projectId: PROJECT_B,
      },
    ],
    repositoryFormatVersion: 1,
    restoreEpoch: 3,
    schemaVersion: 1,
    terminalProjects: [],
  } as const;
  const catalogSha256 = createHash('sha256')
    .update(JSON.stringify(content), 'utf8')
    .digest('hex');
  return Object.freeze({ ...content, catalogSha256 });
}

describe('EnvironmentBackupCatalogVerifier', () => {
  it('verifies every immutable Project checkpoint against one exact environment catalog', async () => {
    const verified: string[] = [];
    const sourceDocument = document();
    const verifier = new EnvironmentBackupCatalogVerifier({
      coordinationSchemaVersion: 9,
      repositoryFormatVersion: 1,
      serverBuild: 'cloud-build-a',
      source: {
        readCatalog: async input => {
          assert.equal(input.catalogId, 'backup-catalog-a');
          return sourceDocument;
        },
        verifyProjectBackup: async input => {
          verified.push(input.project.backupId);
          return Object.freeze({
            authorityGeneration: input.project.authorityGeneration,
            authorityId: 'cloud-authority-a',
            authorityVolumeIdentity: 'authority-volume-a',
            backupId: input.project.backupId,
            checkpointSha256: input.project.checkpointSha256,
            expiresAt: input.project.expiresAt,
            coordinationSchemaVersion: 9,
            maximumServerBuild: 'cloud-build-a',
            minimumServerBuild: 'cloud-build-a',
            placementGeneration: input.project.placementGeneration,
            projectId: input.project.projectId,
            repositoryFormatVersion: 1,
            restoreEpoch: 3,
          });
        },
      },
    });

    const catalog = await verifier.validate({
      catalogId: 'backup-catalog-a',
      expectedCatalogSha256: sourceDocument.catalogSha256 as string,
      signal: new AbortController().signal,
    });
    assert.deepEqual(verified, ['backup-project-a', 'backup-project-b']);
    assert.equal(catalog.catalogSha256, sourceDocument.catalogSha256);
    assert.deepEqual(catalog.projects.map(project => project.projectId), [
      PROJECT_A,
      PROJECT_B,
    ]);
  });

  it('accepts only backup schemas inside the offline maintenance interval', async () => {
    const accepted = document(9);
    const rejected = document(8);
    let sourceDocument = accepted;
    const verifier = new EnvironmentBackupCatalogVerifier({
      coordinationSchemaCompatibility: {
        maximumVersion: 10,
        minimumVersion: 9,
      },
      repositoryFormatVersion: 1,
      serverBuild: 'cloud-build-a',
      source: {
        readCatalog: async () => sourceDocument,
        verifyProjectBackup: async input => Object.freeze({
          authorityGeneration: input.project.authorityGeneration,
          authorityId: 'cloud-authority-a',
          authorityVolumeIdentity: 'authority-volume-a',
          backupId: input.project.backupId,
          checkpointSha256: input.project.checkpointSha256,
          expiresAt: input.project.expiresAt,
          coordinationSchemaVersion:
            sourceDocument.coordinationSchemaVersion as number,
          maximumServerBuild: 'cloud-build-a',
          minimumServerBuild: 'cloud-build-a',
          placementGeneration: input.project.placementGeneration,
          projectId: input.project.projectId,
          repositoryFormatVersion: 1,
          restoreEpoch: 3,
        }),
      },
    });

    await verifier.validate({
      catalogId: 'backup-catalog-a',
      expectedCatalogSha256: accepted.catalogSha256 as string,
      signal: new AbortController().signal,
    });
    sourceDocument = rejected;
    await assert.rejects(
      verifier.validate({
        catalogId: 'backup-catalog-a',
        expectedCatalogSha256: rejected.catalogSha256 as string,
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentBackupCatalogVerifierError);
        assert.equal(error.code, 'invalid-backup');
        return true;
      },
    );
  });

  it('fails closed when a Project checkpoint contradicts the environment catalog', async () => {
    const sourceDocument = document();
    const verifier = new EnvironmentBackupCatalogVerifier({
      coordinationSchemaVersion: 9,
      repositoryFormatVersion: 1,
      serverBuild: 'cloud-build-a',
      source: {
        readCatalog: async () => sourceDocument,
        verifyProjectBackup: async input => Object.freeze({
          authorityGeneration: input.project.authorityGeneration,
          authorityId: 'cloud-authority-a',
          authorityVolumeIdentity: 'foreign-volume',
          backupId: input.project.backupId,
          checkpointSha256: input.project.checkpointSha256,
          expiresAt: input.project.expiresAt,
          coordinationSchemaVersion: 9,
          maximumServerBuild: 'cloud-build-a',
          minimumServerBuild: 'cloud-build-a',
          placementGeneration: input.project.placementGeneration,
          projectId: input.project.projectId,
          repositoryFormatVersion: 1,
          restoreEpoch: 3,
        }),
      },
    });

    await assert.rejects(
      verifier.validate({
        catalogId: 'backup-catalog-a',
        expectedCatalogSha256: sourceDocument.catalogSha256 as string,
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentBackupCatalogVerifierError);
        assert.equal(error.code, 'invalid-backup');
        assert.equal(error.message, 'environment-backup-catalog.error.invalid-backup');
        return true;
      },
    );
  });
});
