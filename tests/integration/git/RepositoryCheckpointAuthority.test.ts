import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  RepositoryCheckpointAuthority,
  RepositoryCheckpointError,
} from '../../../src/repositories/RepositoryCheckpointAuthority.js';
import {
  GitBundleImporter,
  repositoryCheckpointArtifactKey,
  repositoryCheckpointAttemptId,
  repositoryCheckpointStagingRepositoryPath,
} from '../../../src/repositories/GitBundleImporter.js';
import {
  createRepositoryPlacementLease,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from '../../../src/repositories/RepositoryPlacement.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';
import { BootstrapUploadAdmission } from '../../../src/resource-admission/BootstrapUploadAdmission.js';

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';
const REPOSITORY_VALIDATION_LIMITS = Object.freeze({
  maximumBlobBytes: 1024 * 1024,
  maximumExpandedTreeEntries: 100_000,
  maximumRepositoryBytes: 2 * 1024 * 1024,
  maximumTreeEntries: 2_000,
});

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT, [...arguments_], {
    cwd,
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    },
  });
  return result.stdout.trim();
}

class CurrentPlacement implements RepositoryPlacementValidator {
  async isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    await Promise.resolve();
    return true;
  }
}

class SequencedPlacement implements RepositoryPlacementValidator {
  readonly #results: boolean[];

  constructor(results: readonly boolean[]) {
    this.#results = [...results];
  }

  async isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    await Promise.resolve();
    return this.#results.shift() ?? false;
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new Error('checkpoint-test-marker-timeout');
}

function captureOperationPath(
  operationRoot: string,
  projectId: string,
  operationId: string,
): string {
  return join(
    operationRoot,
    Buffer.from(projectId).toString('hex'),
    'capture',
    createHash('sha256')
      .update(`capture\0${projectId}\0${operationId}`, 'utf8')
      .digest('hex'),
  );
}

describe('RepositoryCheckpointAuthority', () => {
  it('requires sibling operation and repository authority roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-checkpoint-roots-'));
    const repositoryRoot = join(root, 'repositories');
    const admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 1_000,
    });
    const options = {
      ...REPOSITORY_VALIDATION_LIMITS,
      gitExecutable: GIT,
      maximumBundleBytes: 2 * 1024 * 1024,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 64 * 1024,
      placementValidator: new CurrentPlacement(),
      repositoryRoot,
      resourceAdmission: admission,
      storageNodeId: 'node-a',
    } as const;
    try {
      for (const operationRoot of [
        join(repositoryRoot, 'checkpoint-operations'),
        join(root, 'other', 'checkpoint-operations'),
      ]) {
        assert.throws(
          () => new RepositoryCheckpointAuthority({
            ...options,
            operationRoot,
          }),
          /repository-checkpoint\.options-invalid/u,
        );
      }
    } finally {
      await admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('captures only the canonical allowed refs from one current placement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-checkpoint-export-'));
    const repositoryRoot = join(root, 'repositories');
    const operationRoot = join(root, 'checkpoint-operations');
    const work = join(root, 'work');
    const placement = createRepositoryPlacementLease({
      active: true,
      generation: 7,
      projectId: 'project-a',
      repositoryStorageKey: 'repository-a',
      storageNodeId: 'node-a',
    });
    const repository = join(
      repositoryRoot,
      Buffer.from(placement.projectId).toString('hex'),
      placement.repositoryStorageKey,
    );
    const admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 1_000,
    });
    const commandLog = join(root, 'git-commands.log');
    const recordingGit = join(root, 'recording-git');
    await writeFile(recordingGit, `#!/bin/sh
set -eu
printf '%s ' "$@" >> '${commandLog}'
printf '\\n' >> '${commandLog}'
exec '${GIT}' "$@"
`, { mode: 0o755 });
    const synchronizedDirectories: string[] = [];
    const personalRefBarrier = repository;
    let failPersonalRefSync = false;
    let failCaptureCleanup = false;
    let detachedCaptureCleanup: string | undefined;
    const authority = new RepositoryCheckpointAuthority({
      ...REPOSITORY_VALIDATION_LIMITS,
      gitExecutable: recordingGit,
      maximumBundleBytes: 2 * 1024 * 1024,
      operationRoot,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 64 * 1024,
      placementValidator: new CurrentPlacement(),
      repositoryRoot,
      removeTree: async path => {
        detachedCaptureCleanup = path;
        if (failCaptureCleanup) {
          failCaptureCleanup = false;
          await rm(join(path, '.claudian-cloud-checkpoint-capture.json'), {
            force: true,
          });
          throw new Error('injected-partial-capture-cleanup-failure');
        }
        await rm(path, { recursive: true });
      },
      resourceAdmission: admission,
      storageNodeId: 'node-a',
      syncDirectory: path => {
        synchronizedDirectories.push(path);
        if (path === personalRefBarrier && failPersonalRefSync) {
          failPersonalRefSync = false;
          return Promise.reject(new Error('injected-personal-ref-sync-failure'));
        }
        return Promise.resolve();
      },
    });
    try {
      await Promise.all([
        mkdir(repositoryRoot),
        mkdir(operationRoot),
      ]);
      await git(root, ['init', '--initial-branch=main', work]);
      await git(work, ['config', 'user.email', 'test@example.invalid']);
      await git(work, ['config', 'user.name', 'Test User']);
      await writeFile(join(work, 'note.md'), '# checkpoint\n');
      await writeFile(join(work, 'payload.bin'), randomBytes(192 * 1024));
      await git(work, ['add', 'note.md', 'payload.bin']);
      await git(work, ['commit', '-m', 'fixture']);
      const oid = await git(work, ['rev-parse', 'HEAD']);
      await git(work, ['branch', 'members/member-a']);
      await git(work, ['branch', 'members/member-b']);
      await git(work, ['branch', 'unmanaged-extra']);
      await mkdir(join(repositoryRoot, Buffer.from(placement.projectId).toString('hex')));
      await git(root, ['clone', '--bare', work, repository]);

      const refs = Object.freeze([
        Object.freeze({ name: 'refs/heads/main', oid }),
        Object.freeze({ name: 'refs/heads/members/member-a', oid }),
        Object.freeze({ name: 'refs/heads/members/member-b', oid }),
      ]);
      const markerlessOperation = captureOperationPath(
        operationRoot,
        placement.projectId,
        'operation-markerless',
      );
      const markerlessVictim = join(markerlessOperation, 'unowned.txt');
      await mkdir(markerlessOperation, { recursive: true });
      await writeFile(markerlessVictim, 'must remain\n');
      await assert.rejects(authority.capture({
        operationId: 'operation-markerless',
        placement,
        refs,
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'invalid-checkpoint');
        return true;
      });
      assert.equal(await readFile(markerlessVictim, 'utf8'), 'must remain\n');
      await rm(markerlessOperation, { recursive: true });
      const captured = await authority.capture({
        operationId: 'operation-a',
        placement,
        refs,
      });
      const captureProject = join(
        operationRoot,
        Buffer.from(placement.projectId).toString('hex'),
      );
      const captureProfile = join(captureProject, 'capture');
      assert.deepEqual(synchronizedDirectories.slice(0, 3), [
        operationRoot,
        captureProject,
        captureProfile,
      ]);
      synchronizedDirectories.length = 0;
      assert.deepEqual(await authority.capture({
        operationId: 'operation-a',
        placement,
        refs,
      }), captured);
      assert.deepEqual(synchronizedDirectories.slice(0, 3), [
        operationRoot,
        captureProject,
        captureProfile,
      ]);
      assert.deepEqual(captured, {
        artifactKey: captured.artifactKey,
        byteCount: captured.byteCount,
        objectFormat: 'sha1',
        operationId: 'operation-a',
        placementGeneration: 7,
        projectId: 'project-a',
        refs,
        sha256: captured.sha256,
      });
      assert.match(captured.artifactKey, /^[0-9a-f]{64}$/u);
      assert.match(captured.sha256, /^[0-9a-f]{64}$/u);
      assert.equal(captured.byteCount > 0, true);
      assert.equal(Object.isFrozen(captured), true);
      assert.equal(JSON.stringify(captured).includes(root), false);

      const chunks: Buffer[] = [];
      await authority.readCapture({
        capture: captured,
        onChunk: chunk => {
          chunks.push(Buffer.from(chunk));
        },
      });
      const bundle = join(root, 'observed.bundle');
      await writeFile(bundle, Buffer.concat(chunks));
      const listed = (await git(repository, ['bundle', 'list-heads', bundle]))
        .split('\n')
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right, 'en-US'));
      assert.deepEqual(listed, refs.map(ref => `${ref.oid} ${ref.name}`));
      assert.equal((await readFile(bundle)).length, captured.byteCount);

      const concurrentCapture = authority.capture({
        operationId: 'operation-concurrent',
        placement,
        refs,
      });
      await assert.rejects(authority.capture({
        operationId: 'operation-concurrent',
        placement,
        refs,
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'busy');
        return true;
      });
      assert.equal(
        await authority.discardCapture(await concurrentCapture),
        'removed',
      );

      const bootstrapAliasOperationId = 'operation-bootstrap-alias';
      const bootstrapAliasAttempt = join(
        captureProject,
        Buffer.from(bootstrapAliasOperationId).toString('hex'),
      );
      const bootstrapVictim = join(bootstrapAliasAttempt, 'bootstrap-owned.txt');
      await mkdir(bootstrapAliasAttempt);
      await writeFile(bootstrapVictim, 'must remain\n');
      const isolatedCapture = await authority.capture({
        operationId: bootstrapAliasOperationId,
        placement,
        refs,
      });
      assert.notEqual(
        isolatedCapture.artifactKey,
        createHash('sha256')
          .update(`${placement.projectId}\0${bootstrapAliasOperationId}`)
          .digest('hex'),
      );
      const isolatedCaptureOperation = captureOperationPath(
        operationRoot,
        placement.projectId,
        bootstrapAliasOperationId,
      );
      await access(join(
        isolatedCaptureOperation,
        '.claudian-cloud-checkpoint-capture-owner.json',
      ));
      assert.equal(await authority.discardCapture(isolatedCapture), 'removed');
      assert.equal(await readFile(bootstrapVictim, 'utf8'), 'must remain\n');

      const mutableCapture = await authority.capture({
        operationId: 'operation-read-mutation',
        placement,
        refs,
      });
      assert.equal(mutableCapture.byteCount > 64 * 1024, true);
      const mutableBundle = join(
        captureOperationPath(
          operationRoot,
          placement.projectId,
          mutableCapture.operationId,
        ),
        'repository.bundle',
      );
      let firstChunk = true;
      await assert.rejects(authority.readCapture({
        capture: mutableCapture,
        onChunk: async chunk => {
          if (!firstChunk) return;
          firstChunk = false;
          await truncate(mutableBundle, chunk.length);
        },
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'invalid-checkpoint');
        return true;
      });

      const maximumOperationId = 'o'.repeat(128);
      const maximumIdCapture = await authority.capture({
        operationId: maximumOperationId,
        placement,
        refs,
      });
      assert.equal(maximumIdCapture.operationId, maximumOperationId);
      assert.equal(await authority.discardCapture(maximumIdCapture), 'removed');

      const cleanupCapture = await authority.capture({
        operationId: 'operation-partial-capture-cleanup',
        placement,
        refs,
      });
      failCaptureCleanup = true;
      await assert.rejects(authority.discardCapture(cleanupCapture), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'storage-unavailable');
        return true;
      });
      await assert.rejects(access(captureOperationPath(
        operationRoot,
        placement.projectId,
        cleanupCapture.operationId,
      )), { code: 'ENOENT' });
      assert.notEqual(detachedCaptureCleanup, undefined);
      await access(detachedCaptureCleanup ?? '');
      assert.equal(await authority.discardCapture(cleanupCapture), 'removed');
      await assert.rejects(access(detachedCaptureCleanup ?? ''), { code: 'ENOENT' });

      failPersonalRefSync = true;
      await assert.rejects(authority.deleteExactPersonalRef({
        expectedOid: oid,
        personalRef: 'refs/heads/members/member-a',
        placement,
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'storage-unavailable');
        return true;
      });
      synchronizedDirectories.length = 0;
      assert.equal(await authority.deleteExactPersonalRef({
        expectedOid: oid,
        personalRef: 'refs/heads/members/member-a',
        placement,
      }), 'replayed');
      assert.equal(synchronizedDirectories.includes(personalRefBarrier), true);
      const updateRefCommand = (await readFile(commandLog, 'utf8'))
        .split('\n')
        .find(line => line.includes(' update-ref -d '));
      assert.notEqual(updateRefCommand, undefined);
      assert.match(
        updateRefCommand ?? '',
        /-c core\.fsync=all -c core\.fsyncMethod=fsync update-ref -d/u,
      );
      await assert.rejects(authority.deleteExactPersonalRef({
        expectedOid: oid,
        personalRef: 'refs/heads/main',
        placement,
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'invalid-checkpoint');
        return true;
      });

      const cancelledDiscard = new AbortController();
      cancelledDiscard.abort();
      await assert.rejects(
        authority.discardCapture(captured, cancelledDiscard.signal),
        error => {
          assert.ok(error instanceof RepositoryCheckpointError);
          assert.equal(error.code, 'cancelled');
          return true;
        },
      );

      let enterCallback: (() => void) | undefined;
      let releaseCallback: (() => void) | undefined;
      const callbackEntered = new Promise<void>(resolve => {
        enterCallback = resolve;
      });
      const callbackRelease = new Promise<void>(resolve => {
        releaseCallback = resolve;
      });
      const reading = authority.readCapture({
        capture: captured,
        onChunk: async () => {
          enterCallback?.();
          await callbackRelease;
        },
      });
      await callbackEntered;
      let closeSettled = false;
      const closing = authority.close().then(() => {
        closeSettled = true;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(closeSettled, false);
      releaseCallback?.();
      await assert.rejects(reading, error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'closed');
        return true;
      });
      await closing;
    } finally {
      await authority.close();
      await admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('publishes an imported repository as inactive and removes only its exact owned identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-checkpoint-publication-'));
    const repositoryRoot = join(root, 'repositories');
    const operationRoot = join(root, 'checkpoint-operations');
    const work = join(root, 'work');
    const projectId = 'project-publication';
    const operationId = 'operation-publication';
    const staged = repositoryCheckpointStagingRepositoryPath(
      operationRoot,
      projectId,
      operationId,
    );
    const projectHex = Buffer.from(projectId).toString('hex');
    const projectPath = join(repositoryRoot, projectHex);
    const publishedRepository = join(projectPath, 'repository-imported');
    const admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 1_000,
    });
    const uploadAdmission = new BootstrapUploadAdmission({
      maxConcurrentUploads: 1,
      maxUploadsPerAttempt: 1,
      queueMax: 2,
      queueTimeoutMs: 1_000,
      stagingFreeSpaceFloorBytes: 1,
      stagingReservationBytes: 2 * 1024 * 1024,
      stagingRoot: operationRoot,
    });
    const importer = new GitBundleImporter({
      gitExecutable: GIT,
      maximumBlobBytes: REPOSITORY_VALIDATION_LIMITS.maximumBlobBytes,
      maximumBundleBytes: 2 * 1024 * 1024,
      maximumExpandedTreeEntries:
        REPOSITORY_VALIDATION_LIMITS.maximumExpandedTreeEntries,
      maximumMetadataOutputBytes: 8 * 1024 * 1024,
      maximumRepositoryBytes:
        REPOSITORY_VALIDATION_LIMITS.maximumRepositoryBytes,
      maximumTreeEntries: REPOSITORY_VALIDATION_LIMITS.maximumTreeEntries,
      operationTimeoutMs: 5_000,
      resourceAdmission: admission,
      stagingRoot: operationRoot,
      uploadAdmission,
      uploadIdleTimeoutMs: 1_000,
      uploadTotalTimeoutMs: 5_000,
    });
    const synchronizedDirectories: string[] = [];
    let publicationMarkerSyncCount = 0;
    let failPublicationMarkerSync = true;
    let failPublishedSourceSync = true;
    let failOwnedTreeCleanup = false;
    let detachedOwnedCleanup: string | undefined;
    const authority = new RepositoryCheckpointAuthority({
      ...REPOSITORY_VALIDATION_LIMITS,
      gitExecutable: GIT,
      maximumBundleBytes: 2 * 1024 * 1024,
      operationRoot,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 64 * 1024,
      placementValidator: new CurrentPlacement(),
      repositoryRoot,
      removeTree: async path => {
        detachedOwnedCleanup = path;
        if (failOwnedTreeCleanup) {
          failOwnedTreeCleanup = false;
          await rm(join(
            path,
            '.claudian-cloud-checkpoint-publication.json',
          ), { force: true });
          throw new Error('injected-partial-publication-cleanup-failure');
        }
        await rm(path, { recursive: true });
      },
      resourceAdmission: admission,
      storageNodeId: 'node-a',
      syncDirectory: path => {
        synchronizedDirectories.push(path);
        if (path === staged) {
          publicationMarkerSyncCount += 1;
          if (failPublicationMarkerSync) {
            failPublicationMarkerSync = false;
            return Promise.reject(new Error('injected-publication-marker-sync-failure'));
          }
        }
        if (path === dirname(staged) && failPublishedSourceSync) {
          failPublishedSourceSync = false;
          return Promise.reject(new Error('injected-publication-sync-failure'));
        }
        return Promise.resolve();
      },
    });
    try {
      await Promise.all([mkdir(repositoryRoot), mkdir(operationRoot)]);
      await git(root, ['init', '--initial-branch=main', work]);
      await git(work, ['config', 'user.email', 'test@example.invalid']);
      await git(work, ['config', 'user.name', 'Test User']);
      await writeFile(join(work, 'note.md'), '# imported\n');
      await git(work, ['add', 'note.md']);
      await git(work, ['commit', '-m', 'fixture']);
      const oid = await git(work, ['rev-parse', 'HEAD']);
      await git(work, ['branch', 'members/member-a']);
      const bundle = join(root, 'checkpoint.bundle');
      await git(work, [
        'bundle',
        'create',
        bundle,
        'refs/heads/main',
        'refs/heads/members/member-a',
      ]);
      const bundleBytes = await readFile(bundle);
      const refs = Object.freeze([
        Object.freeze({ name: 'refs/heads/main', oid }),
        Object.freeze({ name: 'refs/heads/members/member-a', oid }),
      ]);
      const checkpoint = await importer.importCheckpoint({
        body: createReadStream(bundle, { highWaterMark: 11 }),
        expectedByteCount: bundleBytes.length,
        expectedSha256: createHash('sha256').update(bundleBytes).digest('hex'),
        objectFormat: 'sha1',
        operationId,
        projectId,
        refs,
      });
      assert.equal(
        checkpoint.artifactKey,
        repositoryCheckpointArtifactKey(projectId, operationId),
      );
      const validation = await readFile(
        join(staged, '.claudian-cloud-validation.json'),
        'utf8',
      );

      const publicationInput = {
        checkpoint,
        placementGeneration: 8,
        repositoryStorageKey: 'repository-imported',
      } as const;
      const plannedPublication = authority.planInactive(publicationInput);
      assert.equal(plannedPublication.status, 'inactive');
      await access(staged);
      await assert.rejects(access(publishedRepository), { code: 'ENOENT' });
      await git(staged, ['update-ref', 'refs/tags/unmanaged', oid]);
      await assert.rejects(authority.publishInactive(publicationInput), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'repository-invalid');
        return true;
      });
      await git(staged, ['update-ref', '-d', 'refs/tags/unmanaged']);
      const unreachablePath = join(root, 'unreachable.bin');
      await writeFile(unreachablePath, randomBytes(32 * 1024));
      await git(staged, ['hash-object', '-w', unreachablePath]);
      await assert.rejects(authority.publishInactive(publicationInput), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'repository-invalid');
        return true;
      });
      await git(staged, ['prune', '--expire=now']);
      await assert.rejects(authority.publishInactive(publicationInput), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'storage-unavailable');
        return true;
      });
      assert.equal(publicationMarkerSyncCount, 1);
      await assert.rejects(authority.publishInactive(publicationInput), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'storage-unavailable');
        return true;
      });
      assert.equal(publicationMarkerSyncCount, 2);
      synchronizedDirectories.length = 0;
      const publication = await authority.publishInactive(publicationInput);
      assert.deepEqual(publication, plannedPublication);
      assert.equal(publication.status, 'inactive');
      assert.equal(publication.placementGeneration, 8);
      assert.equal(publication.storageNodeId, 'node-a');
      assert.equal(Object.isFrozen(publication), true);
      assert.equal(JSON.stringify(publication).includes(root), false);
      assert.equal((await authority.publishInactive({
        checkpoint,
        placementGeneration: 8,
        repositoryStorageKey: 'repository-imported',
      })).publicationMarkerSha256, publication.publicationMarkerSha256);
      assert.equal(synchronizedDirectories.includes(dirname(staged)), true);
      assert.equal(synchronizedDirectories.includes(repositoryRoot), true);
      assert.equal(synchronizedDirectories.includes(projectPath), true);
      assert.equal(synchronizedDirectories.includes(publishedRepository), true);

      failOwnedTreeCleanup = true;
      await assert.rejects(
        authority.removeOwnedRepository(publication),
        error => {
          assert.ok(error instanceof RepositoryCheckpointError);
          assert.equal(error.code, 'storage-unavailable');
          return true;
        },
      );
      await assert.rejects(access(publishedRepository), { code: 'ENOENT' });
      assert.notEqual(detachedOwnedCleanup, undefined);
      await access(detachedOwnedCleanup ?? '');
      assert.equal(await authority.removeOwnedRepository(publication), 'removed');
      await assert.rejects(access(detachedOwnedCleanup ?? ''), { code: 'ENOENT' });
      const reimportedCheckpoint = await importer.importCheckpoint({
        body: createReadStream(bundle, { highWaterMark: 11 }),
        expectedByteCount: bundleBytes.length,
        expectedSha256: createHash('sha256').update(bundleBytes).digest('hex'),
        objectFormat: 'sha1',
        operationId,
        projectId,
        refs,
      });
      assert.equal(reimportedCheckpoint.markerSha256, checkpoint.markerSha256);
      assert.equal(
        await authority.removeOwnedRepository(plannedPublication),
        'removed',
      );
      await assert.rejects(access(staged), { code: 'ENOENT' });
      await importer.importCheckpoint({
        body: createReadStream(bundle, { highWaterMark: 11 }),
        expectedByteCount: bundleBytes.length,
        expectedSha256: createHash('sha256').update(bundleBytes).digest('hex'),
        objectFormat: 'sha1',
        operationId,
        projectId,
        refs,
      });
      assert.equal(
        (await authority.publishInactive(publicationInput)).publicationMarkerSha256,
        publication.publicationMarkerSha256,
      );

      assert.equal(await importer.discardCheckpoint({
        operationId,
        projectId,
      }), 'removed');
      assert.equal(
        (await authority.publishInactive(publicationInput)).publicationMarkerSha256,
        publication.publicationMarkerSha256,
      );
      const publishedValidationMarker = join(
        publishedRepository,
        '.claudian-cloud-validation.json',
      );
      await rm(publishedValidationMarker);
      await assert.rejects(authority.publishInactive(publicationInput), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'invalid-checkpoint');
        return true;
      });
      await writeFile(publishedValidationMarker, 'corrupt\n', { mode: 0o600 });
      await assert.rejects(authority.publishInactive(publicationInput), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'invalid-checkpoint');
        return true;
      });
      await writeFile(publishedValidationMarker, validation, { mode: 0o600 });
      assert.equal(
        (await authority.publishInactive(publicationInput)).publicationMarkerSha256,
        publication.publicationMarkerSha256,
      );
      const publicationMarker = await readFile(join(
        publishedRepository,
        '.claudian-cloud-checkpoint-publication.json',
      ));
      const exactIdentity = Object.freeze({
        placementGeneration: 8,
        projectId,
        repositoryStorageKey: 'repository-imported',
        storageNodeId: 'node-a',
      });
      let failRemovalSync = false;
      let failExactTreeCleanup = true;
      let detachedExactCleanup: string | undefined;
      const removalAuthority = new RepositoryCheckpointAuthority({
        ...REPOSITORY_VALIDATION_LIMITS,
        gitExecutable: GIT,
        maximumBundleBytes: 2 * 1024 * 1024,
        operationRoot,
        operationTimeoutMs: 5_000,
        outputMaxBytes: 64 * 1024,
        placementValidator: new CurrentPlacement(),
        repositoryRoot,
        removeTree: async path => {
          detachedExactCleanup = path;
          if (failExactTreeCleanup) {
            failExactTreeCleanup = false;
            await rm(join(
              path,
              '.claudian-cloud-checkpoint-publication.json',
            ), { force: true });
            throw new Error('injected-partial-exact-cleanup-failure');
          }
          await rm(path, { recursive: true });
        },
        resourceAdmission: admission,
        storageNodeId: 'node-a',
        syncDirectory: path => {
          synchronizedDirectories.push(path);
          if (path === projectPath && failRemovalSync) {
            failRemovalSync = false;
            return Promise.reject(new Error('injected-removal-sync-failure'));
          }
          return Promise.resolve();
        },
      });
      await assert.rejects(
        removalAuthority.removeExactRepository(exactIdentity),
        error => {
          assert.ok(error instanceof RepositoryCheckpointError);
          assert.equal(error.code, 'storage-unavailable');
          return true;
        },
      );
      await assert.rejects(access(publishedRepository), { code: 'ENOENT' });
      assert.notEqual(detachedExactCleanup, undefined);
      await access(detachedExactCleanup ?? '');
      failRemovalSync = true;
      await assert.rejects(
        removalAuthority.removeExactRepository(exactIdentity),
        error => {
          assert.ok(error instanceof RepositoryCheckpointError);
          assert.equal(error.code, 'storage-unavailable');
          return true;
        },
      );
      synchronizedDirectories.length = 0;
      assert.equal(
        await removalAuthority.removeExactRepository(exactIdentity),
        'removed',
      );
      assert.equal(synchronizedDirectories.includes(projectPath), true);
      await assert.rejects(access(detachedExactCleanup ?? ''), { code: 'ENOENT' });
      assert.equal(
        await removalAuthority.removeExactRepository(exactIdentity),
        'replayed',
      );
      await rm(projectPath, { recursive: true });
      synchronizedDirectories.length = 0;
      assert.equal(
        await removalAuthority.removeExactRepository(exactIdentity),
        'replayed',
      );
      assert.equal(synchronizedDirectories.includes(repositoryRoot), true);
      await removalAuthority.close();
      assert.equal(await authority.removeExactRepository(exactIdentity), 'replayed');

      const stagingProject = join(operationRoot, projectHex);
      const outsideStagingProject = join(root, 'outside-staging-project');
      const checkpointAttemptId = repositoryCheckpointAttemptId(
        projectId,
        operationId,
      );
      await rm(stagingProject, { recursive: true });
      for (const attemptId of [operationId, checkpointAttemptId]) {
        const outsideStaged = join(
          outsideStagingProject,
          Buffer.from(attemptId).toString('hex'),
          'repository',
        );
        await mkdir(dirname(outsideStaged), { recursive: true });
        await git(root, ['clone', '--bare', work, outsideStaged]);
        await writeFile(
          join(outsideStaged, '.claudian-cloud-validation.json'),
          validation,
          { mode: 0o600 },
        );
      }
      await symlink(outsideStagingProject, stagingProject, 'dir');
      await assert.rejects(authority.publishInactive({
        checkpoint,
        placementGeneration: 8,
        repositoryStorageKey: 'repository-imported',
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        return true;
      });
      await access(join(
        outsideStagingProject,
        Buffer.from(operationId).toString('hex'),
        'repository',
      ));
      await rm(stagingProject);
      await mkdir(stagingProject);

      const outsideProject = join(root, 'outside-project');
      const outsideRepository = join(outsideProject, 'repository-imported');
      const victim = join(outsideRepository, 'victim.txt');
      await rm(projectPath, { force: true, recursive: true });
      await mkdir(outsideRepository, { recursive: true });
      await writeFile(
        join(outsideRepository, '.claudian-cloud-checkpoint-publication.json'),
        publicationMarker,
      );
      await writeFile(victim, 'must remain\n');
      await symlink(outsideProject, projectPath, 'dir');
      await assert.rejects(
        authority.removeOwnedRepository(publication),
        error => {
          assert.ok(error instanceof RepositoryCheckpointError);
          return true;
        },
      );
      assert.equal(await readFile(victim, 'utf8'), 'must remain\n');
    } finally {
      await importer.close();
      await uploadAdmission.close();
      await authority.close();
      await admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('revalidates placement immediately before deleting a personal ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-checkpoint-ref-fence-'));
    const repositoryRoot = join(root, 'repositories');
    const operationRoot = join(root, 'checkpoint-operations');
    const work = join(root, 'work');
    const placement = createRepositoryPlacementLease({
      active: true,
      generation: 4,
      projectId: 'project-ref-fence',
      repositoryStorageKey: 'repository-ref-fence',
      storageNodeId: 'node-a',
    });
    const repository = join(
      repositoryRoot,
      Buffer.from(placement.projectId).toString('hex'),
      placement.repositoryStorageKey,
    );
    await Promise.all([mkdir(repositoryRoot), mkdir(operationRoot)]);
    await git(root, ['init', '--initial-branch=main', work]);
    await git(work, ['config', 'user.email', 'test@example.invalid']);
    await git(work, ['config', 'user.name', 'Test User']);
    await writeFile(join(work, 'note.md'), '# fence\n');
    await git(work, ['add', 'note.md']);
    await git(work, ['commit', '-m', 'fixture']);
    const oid = await git(work, ['rev-parse', 'HEAD']);
    await git(work, ['branch', 'members/member-a']);
    await mkdir(dirname(repository));
    await git(root, ['clone', '--bare', work, repository]);
    const admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 1_000,
    });
    const authority = new RepositoryCheckpointAuthority({
      ...REPOSITORY_VALIDATION_LIMITS,
      gitExecutable: GIT,
      maximumBundleBytes: 2 * 1024 * 1024,
      operationRoot,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 64 * 1024,
      placementValidator: new SequencedPlacement([true, false]),
      repositoryRoot,
      resourceAdmission: admission,
      storageNodeId: 'node-a',
    });
    let captureAuthority: RepositoryCheckpointAuthority | undefined;
    let syncFailureAuthority: RepositoryCheckpointAuthority | undefined;
    try {
      await assert.rejects(authority.deleteExactPersonalRef({
        expectedOid: oid,
        personalRef: 'refs/heads/members/member-a',
        placement,
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'placement-rejected');
        return true;
      });
      assert.equal(
        await git(repository, ['rev-parse', 'refs/heads/members/member-a']),
        oid,
      );
      await authority.close();
      captureAuthority = new RepositoryCheckpointAuthority({
        ...REPOSITORY_VALIDATION_LIMITS,
        gitExecutable: GIT,
        maximumBundleBytes: 2 * 1024 * 1024,
        operationRoot,
        operationTimeoutMs: 5_000,
        outputMaxBytes: 64 * 1024,
        placementValidator: new SequencedPlacement([true, false]),
        repositoryRoot,
        resourceAdmission: admission,
        storageNodeId: 'node-a',
      });
      await assert.rejects(captureAuthority.capture({
        operationId: 'operation-stale-capture',
        placement,
        refs: Object.freeze([
          Object.freeze({ name: 'refs/heads/main', oid }),
          Object.freeze({ name: 'refs/heads/members/member-a', oid }),
        ]),
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'placement-rejected');
        return true;
      });
      await assert.rejects(access(join(
        captureOperationPath(
          operationRoot,
          placement.projectId,
          'operation-stale-capture',
        ),
        'repository.bundle',
      )), { code: 'ENOENT' });
      await captureAuthority.close();

      const syncFailureOperationId = 'operation-sync-failure';
      const syncFailureOperation = captureOperationPath(
        operationRoot,
        placement.projectId,
        syncFailureOperationId,
      );
      let operationSyncCount = 0;
      const markerSyncFailureOperationId = 'operation-marker-sync-failure';
      const markerSyncFailureOperation = captureOperationPath(
        operationRoot,
        placement.projectId,
        markerSyncFailureOperationId,
      );
      let markerOperationSyncCount = 0;
      syncFailureAuthority = new RepositoryCheckpointAuthority({
        ...REPOSITORY_VALIDATION_LIMITS,
        gitExecutable: GIT,
        maximumBundleBytes: 2 * 1024 * 1024,
        operationRoot,
        operationTimeoutMs: 5_000,
        outputMaxBytes: 64 * 1024,
        placementValidator: new CurrentPlacement(),
        repositoryRoot,
        resourceAdmission: admission,
        storageNodeId: 'node-a',
        syncDirectory: path => {
          if (path === syncFailureOperation) {
            operationSyncCount += 1;
          }
          if (path === markerSyncFailureOperation) {
            markerOperationSyncCount += 1;
          }
          if (path === syncFailureOperation && operationSyncCount === 2) {
            return Promise.reject(new Error('injected-sync-failure'));
          }
          if (
            path === markerSyncFailureOperation
            && markerOperationSyncCount === 3
          ) {
            return Promise.reject(new Error('injected-marker-sync-failure'));
          }
          return Promise.resolve();
        },
      });
      await assert.rejects(syncFailureAuthority.capture({
        operationId: syncFailureOperationId,
        placement,
        refs: Object.freeze([
          Object.freeze({ name: 'refs/heads/main', oid }),
          Object.freeze({ name: 'refs/heads/members/member-a', oid }),
        ]),
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'storage-unavailable');
        return true;
      });
      await assert.rejects(
        access(join(syncFailureOperation, 'repository.bundle')),
        { code: 'ENOENT' },
      );
      const recoveredCapture = await syncFailureAuthority.capture({
        operationId: syncFailureOperationId,
        placement,
        refs: Object.freeze([
          Object.freeze({ name: 'refs/heads/main', oid }),
          Object.freeze({ name: 'refs/heads/members/member-a', oid }),
        ]),
      });
      assert.equal(recoveredCapture.operationId, syncFailureOperationId);
      await assert.rejects(syncFailureAuthority.capture({
        operationId: markerSyncFailureOperationId,
        placement,
        refs: Object.freeze([
          Object.freeze({ name: 'refs/heads/main', oid }),
          Object.freeze({ name: 'refs/heads/members/member-a', oid }),
        ]),
      }), error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'storage-unavailable');
        return true;
      });
      await access(join(
        markerSyncFailureOperation,
        '.claudian-cloud-checkpoint-capture.json',
      ));
      const recoveredMarkerCapture = await syncFailureAuthority.capture({
        operationId: markerSyncFailureOperationId,
        placement,
        refs: Object.freeze([
          Object.freeze({ name: 'refs/heads/main', oid }),
          Object.freeze({ name: 'refs/heads/members/member-a', oid }),
        ]),
      });
      assert.equal(recoveredMarkerCapture.operationId, markerSyncFailureOperationId);
      assert.equal(markerOperationSyncCount, 4);
    } finally {
      await syncFailureAuthority?.close();
      await captureAuthority?.close();
      await authority.close();
      await admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('cancels and reaps a bundle capture without retaining a partial artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-checkpoint-cancel-'));
    const repositoryRoot = join(root, 'repositories');
    const operationRoot = join(root, 'checkpoint-operations');
    const processMarker = join(root, 'process.marker');
    const executable = join(root, 'fake-git');
    const placement = createRepositoryPlacementLease({
      active: true,
      generation: 3,
      projectId: 'project-cancel',
      repositoryStorageKey: 'repository-cancel',
      storageNodeId: 'node-a',
    });
    const repository = join(
      repositoryRoot,
      Buffer.from(placement.projectId).toString('hex'),
      placement.repositoryStorageKey,
    );
    const oid = 'a'.repeat(40);
    await writeFile(executable, `#!/bin/sh
set -eu
case "\${1-}" in
  --version)
    printf 'git version 2.50.1\\n'
    ;;
  rev-parse)
    if [ "\${2-}" = "--is-bare-repository" ]; then
      printf 'true\\n'
    else
      printf 'sha1\\n'
    fi
    ;;
  for-each-ref)
    printf 'refs/heads/main\\000${oid}\\nrefs/heads/members/member-a\\000${oid}\\n'
    ;;
  bundle)
    printf '%s\\n' "$$" > '${processMarker}'
    trap 'exit 0' TERM INT
    while :; do sleep 1; done
    ;;
  *)
    exit 2
    ;;
esac
`);
    await chmod(executable, 0o755);
    await Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(operationRoot),
    ]);
    const admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 1_000,
    });
    const authority = new RepositoryCheckpointAuthority({
      ...REPOSITORY_VALIDATION_LIMITS,
      gitExecutable: executable,
      maximumBundleBytes: 1024 * 1024,
      operationRoot,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 64 * 1024,
      placementValidator: new CurrentPlacement(),
      repositoryRoot,
      resourceAdmission: admission,
      storageNodeId: 'node-a',
    });
    const cancellation = new AbortController();
    try {
      const capture = authority.capture({
        operationId: 'operation-cancel',
        placement,
        refs: Object.freeze([
          Object.freeze({ name: 'refs/heads/main', oid }),
          Object.freeze({ name: 'refs/heads/members/member-a', oid }),
        ]),
        signal: cancellation.signal,
      });
      await waitForFile(processMarker);
      cancellation.abort();
      await assert.rejects(capture, error => {
        assert.ok(error instanceof RepositoryCheckpointError);
        assert.equal(error.code, 'cancelled');
        return true;
      });
      const pid = Number(await readFile(processMarker, 'utf8'));
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'ESRCH'
        ),
      );
      await assert.rejects(access(join(
        captureOperationPath(
          operationRoot,
          placement.projectId,
          'operation-cancel',
        ),
        '.repository.bundle.part',
      )), { code: 'ENOENT' });
    } finally {
      await authority.close();
      await admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
