import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { promisify } from 'node:util';

import {
  COLLAB_PROJECT_BACKUP_COORDINATION_FORMAT_VERSION,
  COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabProjectBackupCheckpointManifest,
} from '@claudian-collab/protocol';

import { EnvironmentRestoreRepositoryAdapter } from '../../../src/environment-maintenance/restore/EnvironmentRestoreRepositoryAdapter.js';
import type { EnvironmentRestoreProject } from '../../../src/environment-maintenance/restore/EnvironmentRestoreCoordinator.js';
import { GitBundleImporter } from '../../../src/repositories/GitBundleImporter.js';
import { RepositoryCheckpointAuthority } from '../../../src/repositories/RepositoryCheckpointAuthority.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';
import { BootstrapUploadAdmission } from '../../../src/resource-admission/BootstrapUploadAdmission.js';

const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claudian-restore-replay-'));
  const source = join(root, 'source');
  const stagingRoot = join(root, 'staging');
  const repositoryRoot = join(root, 'repositories');
  await Promise.all([source, stagingRoot, repositoryRoot].map(path => mkdir(path, { mode: 0o700 })));
  const git = async (...args: string[]) => (await execFileAsync('/usr/bin/git', args, {
    cwd: source,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })).stdout.trim();
  await git('init', '--initial-branch=main');
  await writeFile(join(source, 'sample.bin'), randomBytes(256 * 1024));
  await git('add', '.');
  await git('-c', 'user.name=Restore Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const oid = await git('rev-parse', 'HEAD');
  await git('update-ref', 'refs/heads/members/member-a', oid);
  const refs = [{ name: 'refs/heads/main', oid }, { name: 'refs/heads/members/member-a', oid }];
  const bundlePath = join(root, 'source.bundle');
  await git('bundle', 'create', bundlePath, ...refs.map(ref => ref.name));
  const bytes = await readFile(bundlePath);
  assert.ok(bytes.length > 128 * 1024, 'The bundle must exceed both stream buffers');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const resources = new ResourceAdmission({ maxChildren: 2, maxChildrenPerProject: 1, queueMax: 2, queueMaxPerProject: 1, queueTimeoutMs: 1_000 });
  const upload = new BootstrapUploadAdmission({ maxConcurrentUploads: 1, maxUploadsPerAttempt: 1, queueMax: 2, queueTimeoutMs: 1_000, stagingFreeSpaceFloorBytes: 1, stagingReservationBytes: 2 * 1024 * 1024, stagingRoot });
  const limits = { gitExecutable: '/usr/bin/git', maximumBlobBytes: 1024 * 1024, maximumBundleBytes: 1024 * 1024, maximumExpandedTreeEntries: 100_000, maximumRepositoryBytes: 2 * 1024 * 1024, maximumTreeEntries: 2_000, operationTimeoutMs: 5_000, resourceAdmission: resources };
  const importer = new GitBundleImporter({ ...limits, maximumMetadataOutputBytes: 8 * 1024 * 1024, stagingRoot, uploadAdmission: upload, uploadIdleTimeoutMs: 1_000, uploadTotalTimeoutMs: 5_000 });
  const publication = new RepositoryCheckpointAuthority({ ...limits, operationRoot: stagingRoot, repositoryRoot, outputMaxBytes: 64 * 1024, placementValidator: { isCurrent: () => Promise.resolve(true) }, storageNodeId: 'node-a' });
  const projects: readonly EnvironmentRestoreProject[] = ['project-a', 'project-b'].map(projectId => ({
    authorityGeneration: 1, backupId: `backup-${projectId}`, checkpointSha256: 'a'.repeat(64), expiresAt: '9999-12-31T23:59:59.999Z', placementGeneration: 1, projectId,
  }));
  const state = {
    failProject: '',
    activeReaders: 0,
    abortDuringRead: undefined as AbortController | undefined,
    failDuringRead: false,
  };
  const adapter = new EnvironmentRestoreRepositoryAdapter({
    inspection: { assertEmpty: () => Promise.resolve() }, publication, staging: importer,
    source: { readProjectBackup: input => {
      if (input.project.projectId === state.failProject) return Promise.reject(new Error('injected-backup-read-failure'));
      const manifest: CollabProjectBackupCheckpointManifest = {
        gitObjectFormat: 'sha1', refs,
        artifacts: [{ name: 'repository.bundle', byteCount: bytes.length, sha256: digest }],
        coordinationFormatVersion: COLLAB_PROJECT_BACKUP_COORDINATION_FORMAT_VERSION,
        createdAt: '2026-08-29T00:00:00.000Z', expectedMainOid: oid,
        manifestSchemaVersion: COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
        manifestSha256: input.project.checkpointSha256, operationId: input.project.backupId,
        profile: 'backup', projectId: input.project.projectId, protocolVersion: COLLAB_PROTOCOL_VERSION,
        sourceAuthority: { kind: 'cloud', generation: 1 }, targetAuthority: null,
      };
      return Promise.resolve({
        project: input.project, records: [], manifest,
        readRepository: async delivery => {
          state.activeReaders += 1;
          try {
            for await (const chunk of createReadStream(bundlePath, { highWaterMark: 64 * 1024, signal: delivery.signal })) {
              await delivery.onChunk(chunk as Buffer, delivery.signal);
              state.abortDuringRead?.abort();
              if (state.failDuringRead) throw new Error('injected-bundle-read-failure');
            }
          } finally {
            state.activeReaders -= 1;
          }
        },
      });
    } },
  });
  return {
    adapter, state,
    input: { operationId: 'restore-a', projects, signal: new AbortController().signal },
    async close() {
      await importer.close();
      await publication.close();
      await upload.close();
      await resources.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('replays an exact large staged restore and settles its unused bundle reader', async () => {
  const test = await fixture();
  try {
    const initial = await test.adapter.stage(test.input);
    const replay = await test.adapter.stage({ ...test.input, signal: AbortSignal.timeout(2_000) });
    assert.deepEqual(replay, initial);
    assert.equal(test.state.activeReaders, 0);
    await test.adapter.publish({ operationId: test.input.operationId, repositories: replay, signal: test.input.signal });
    await test.adapter.verifyRestored({ operationId: test.input.operationId, repositories: replay, signal: test.input.signal });
  } finally {
    await test.close();
  }
});

it('recovers all Projects after a later backup fails following an earlier repository stage', async () => {
  const test = await fixture();
  try {
    test.state.failProject = 'project-b';
    await assert.rejects(test.adapter.stage(test.input), /dependency-failed/u);
    assert.equal(test.state.activeReaders, 0);
    test.state.failProject = '';
    const recovered = await test.adapter.stage({ ...test.input, signal: AbortSignal.timeout(2_000) });
    assert.deepEqual(recovered.map(repository => repository.projectId), ['project-a', 'project-b']);
    assert.equal(test.state.activeReaders, 0);
    await test.adapter.publish({ operationId: test.input.operationId, repositories: recovered, signal: test.input.signal });
    await test.adapter.verifyRestored({ operationId: test.input.operationId, repositories: recovered, signal: test.input.signal });
  } finally {
    await test.close();
  }
});

for (const failure of ['cancelled', 'source-failed'] as const) {
  it(`settles the repository reader after ${failure} and permits exact restore retry`, async () => {
    const test = await fixture();
    try {
      const controller = new AbortController();
      test.state.abortDuringRead = failure === 'cancelled' ? controller : undefined;
      test.state.failDuringRead = failure === 'source-failed';
      await assert.rejects(test.adapter.stage({ ...test.input, signal: controller.signal }), /dependency-failed/u);
      assert.equal(test.state.activeReaders, 0);
      test.state.abortDuringRead = undefined;
      test.state.failDuringRead = false;
      const recovered = await test.adapter.stage(test.input);
      assert.deepEqual(recovered.map(repository => repository.projectId), ['project-a', 'project-b']);
      assert.equal(test.state.activeReaders, 0);
    } finally {
      await test.close();
    }
  });
}
