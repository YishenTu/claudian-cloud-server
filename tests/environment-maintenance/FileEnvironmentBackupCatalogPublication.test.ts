import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createEnvironmentBackupCatalog } from '../../src/environment-maintenance/restore/EnvironmentBackupCatalog.js';
import { FileEnvironmentBackupCatalogSource } from '../../src/environment-maintenance/restore/FileEnvironmentBackupCatalogSource.js';
import { createTerminalProjectContinuityArtifact } from '../../src/environment-maintenance/restore/TerminalProjectContinuityArtifact.js';
import {
  EnvironmentBackupCatalogPublicationError,
  FileEnvironmentBackupCatalogPublication,
} from '../../src/environment-maintenance/commands/FileEnvironmentBackupCatalogPublication.js';

const roots: string[] = [];

function publication(catalogId = 'catalog-a') {
  return createEnvironmentBackupCatalog({
    authorityId: 'authority-a',
    authorityVolumeIdentity: 'volume-a',
    catalogId,
    coordinationSchemaVersion: 9,
    createdAt: '2026-08-29T00:00:00.000Z',
    projects: [Object.freeze({
      authorityGeneration: 1,
      backupId: 'backup-project-a',
      checkpointSha256: 'a'.repeat(64),
      expiresAt: '9999-12-31T23:59:59.999Z',
      placementGeneration: 1,
      projectId: 'project-a',
    })],
    repositoryFormatVersion: 1,
    restoreEpoch: 1,
    serverBuild: '0.0.0',
    terminalProjects: [],
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {
    force: true,
    recursive: true,
  })));
});

describe('FileEnvironmentBackupCatalogPublication', () => {
  it('publishes and reopens one private terminal continuity artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-backup-catalog-'));
    roots.push(root);
    const projectId = '11111111-1111-4111-8111-111111111111';
    const artifact = createTerminalProjectContinuityArtifact(projectId, [{
      kind: 'tombstone',
      recordId: projectId,
      revision: 1,
      value: {
        terminalOperationId: projectId,
        terminalOperationKind: 'retire',
        resultSha256: 'a'.repeat(64),
        returnHostMemberId: null,
        returnPrincipalId: null,
        returnAuthorityFingerprint: null,
        authorityGeneration: 1,
        projectId,
        retiredAt: '2026-08-29T00:00:00.000Z',
        terminalExpiresAt: '2026-09-29T00:00:00.000Z',
      },
    }] as never);
    const store = new FileEnvironmentBackupCatalogPublication({ catalogRoot: root });

    assert.equal(await store.publishTerminalProject(artifact), 'published');
    assert.equal(await store.publishTerminalProject(artifact), 'replayed');
    const source = new FileEnvironmentBackupCatalogSource({ catalogRoot: root });
    assert.equal(await source.readTerminalArtifact({
      signal: new AbortController().signal,
      terminalProject: {
        artifactByteCount: Buffer.byteLength(artifact.json, 'utf8'),
        artifactSha256: artifact.sha256,
        projectId,
      },
    }), artifact.json);
  });

  it('publishes one private immutable catalog and replays exact bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-backup-catalog-'));
    roots.push(root);
    const store = new FileEnvironmentBackupCatalogPublication({ catalogRoot: root });
    const created = publication();

    assert.equal(await store.publish(created), 'published');
    assert.equal(await store.publish(created), 'replayed');

    const path = join(root, `${Buffer.from('catalog-a').toString('hex')}.json`);
    const stat = await lstat(path, { bigint: true });
    assert.equal(Number(stat.mode & 0o777n), 0o600);
    assert.equal(await readFile(path, 'utf8'), created.json);
  });

  it('rejects a conflicting catalog without exposing either document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-backup-catalog-'));
    roots.push(root);
    const store = new FileEnvironmentBackupCatalogPublication({ catalogRoot: root });
    const created = publication();
    await store.publish(created);
    const conflicting = Object.freeze({
      ...created,
      json: created.json.replace('authority-a', 'authority-b'),
    });

    const error = await store.publish(conflicting).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof EnvironmentBackupCatalogPublicationError);
    assert.equal(error.code, 'publication-conflict');
    assert.doesNotMatch(JSON.stringify(error), /authority-[ab]/u);
  });
});
