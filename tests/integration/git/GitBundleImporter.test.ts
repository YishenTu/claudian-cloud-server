import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import type { DevelopmentBootstrapGitRef } from '@claudian-collab/protocol';

import {
  GitBundleImporter,
  GitBundleImportError,
  repositoryCheckpointArtifactKey,
  repositoryCheckpointAttemptId,
  repositoryCheckpointStagingRepositoryPath,
  type GitBundleImporterOptions,
  type ImportGitBundleInput,
  type ImportRepositoryCheckpointInput,
} from '../../../src/repositories/GitBundleImporter.js';
import { BootstrapUploadAdmission } from '../../../src/resource-admission/BootstrapUploadAdmission.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';

interface BundleFixture {
  readonly authorityRoot: string;
  readonly bundleByteCount: number;
  readonly bundlePath: string;
  readonly bundleSha256: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly refs: readonly DevelopmentBootstrapGitRef[];
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
}

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, [...arguments_], {
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

async function createBundleFixture(options: {
  readonly bundleRefMode?: 'exact' | 'extra' | 'missing';
  readonly files?: Readonly<Record<string, string>>;
  readonly gitlink?: boolean;
  readonly memberIds?: readonly string[];
  readonly objectFormat?: 'sha1' | 'sha256';
  readonly repeatedTreeDepth?: number;
  readonly symlinks?: Readonly<Record<string, string>>;
  readonly wideTreeDirectoryCount?: number;
} = {}): Promise<BundleFixture> {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'claudian-bundle-import-'));
  const repositoryRoot = join(authorityRoot, 'repositories');
  const stagingRoot = join(authorityRoot, 'staging');
  const source = join(authorityRoot, 'source');
  await Promise.all([
    mkdir(repositoryRoot),
    mkdir(stagingRoot),
    mkdir(source),
  ]);
  const objectFormat = options.objectFormat ?? 'sha1';
  await git(source, [
    'init',
    '--initial-branch=main',
    `--object-format=${objectFormat}`,
  ]);
  const files = options.files ?? { 'note.md': '# Shared\n' };
  for (const [path, body] of Object.entries(files)) {
    const segments = path.split('/');
    if (segments.length > 1) {
      await mkdir(join(source, ...segments.slice(0, -1)), { recursive: true });
    }
    await writeFile(join(source, path), body);
  }
  for (const [path, target] of Object.entries(options.symlinks ?? {})) {
    await symlink(target, join(source, path));
  }
  await git(source, ['add', '--all']);
  await execFileAsync(GIT_EXECUTABLE, [
    '-c',
    'user.name=Claudian Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'initial',
  ], {
    cwd: source,
    env: {
      GIT_AUTHOR_DATE: '2026-08-21T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-08-21T00:00:00Z',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    },
  });
  let mainOid = await git(source, ['rev-parse', 'refs/heads/main']);
  if (options.repeatedTreeDepth !== undefined) {
    let treeOid = await git(source, ['rev-parse', `${mainOid}^{tree}`]);
    for (let depth = 0; depth < options.repeatedTreeDepth; depth += 1) {
      treeOid = execFileSync(GIT_EXECUTABLE, ['mktree'], {
        cwd: source,
        encoding: 'utf8',
        env: {
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          HOME: '/nonexistent',
          LANG: 'C',
          LC_ALL: 'C',
          PATH: '/usr/bin:/bin',
        },
        input: `040000 tree ${treeOid}\tleft-${String(depth)}\n040000 tree ${treeOid}\tright-${String(depth)}\n`,
      }).trim();
    }
    const result = await execFileAsync(GIT_EXECUTABLE, [
      '-c',
      'user.name=Claudian Test',
      '-c',
      'user.email=test@example.invalid',
      'commit-tree',
      treeOid,
      '-p',
      mainOid,
      '-m',
      'repeat tree',
    ], {
      cwd: source,
      encoding: 'utf8',
      env: {
        GIT_AUTHOR_DATE: '2026-08-21T00:00:02Z',
        GIT_COMMITTER_DATE: '2026-08-21T00:00:02Z',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: '/nonexistent',
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
    });
    mainOid = result.stdout.trim();
    await git(source, ['update-ref', 'refs/heads/main', mainOid]);
  }
  if (options.wideTreeDirectoryCount !== undefined) {
    const blobOid = await git(source, ['rev-parse', `${mainOid}:note.md`]);
    const directoryTrees: string[] = [];
    for (let directory = 0; directory < options.wideTreeDirectoryCount; directory += 1) {
      const entries = Array.from({ length: 2_000 }, (_, index) => (
        `100644 blob ${blobOid}\tfile-${String(directory).padStart(2, '0')}-${String(index).padStart(4, '0')}-${'界'.repeat(100)}\0`
      )).join('');
      directoryTrees.push(execFileSync(GIT_EXECUTABLE, ['mktree', '-z'], {
        cwd: source,
        encoding: 'utf8',
        env: {
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          HOME: '/nonexistent',
          LANG: 'C',
          LC_ALL: 'C',
          PATH: '/usr/bin:/bin',
        },
        input: entries,
      }).trim());
    }
    const rootTree = execFileSync(GIT_EXECUTABLE, ['mktree', '-z'], {
      cwd: source,
      encoding: 'utf8',
      env: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: '/nonexistent',
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
      input: directoryTrees.map((oid, index) => (
        `040000 tree ${oid}\tdirectory-${String(index).padStart(2, '0')}\0`
      )).join(''),
    }).trim();
    const result = await execFileAsync(GIT_EXECUTABLE, [
      '-c',
      'user.name=Claudian Test',
      '-c',
      'user.email=test@example.invalid',
      'commit-tree',
      rootTree,
      '-p',
      mainOid,
      '-m',
      'wide tree',
    ], {
      cwd: source,
      encoding: 'utf8',
      env: {
        GIT_AUTHOR_DATE: '2026-08-21T00:00:03Z',
        GIT_COMMITTER_DATE: '2026-08-21T00:00:03Z',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: '/nonexistent',
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
    });
    mainOid = result.stdout.trim();
    await git(source, ['update-ref', 'refs/heads/main', mainOid]);
  }
  if (options.gitlink === true) {
    await git(source, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${mainOid},external-project`,
    ]);
    await execFileAsync(GIT_EXECUTABLE, [
      '-c',
      'user.name=Claudian Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'add gitlink',
    ], {
      cwd: source,
      env: {
        GIT_AUTHOR_DATE: '2026-08-21T00:00:01Z',
        GIT_COMMITTER_DATE: '2026-08-21T00:00:01Z',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: '/nonexistent',
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
    });
  }
  const headOid = await git(source, ['rev-parse', 'refs/heads/main']);
  const memberIds = options.memberIds ?? ['member-a', 'member-b'];
  for (const memberId of memberIds) {
    await git(source, ['update-ref', `refs/heads/members/${memberId}`, headOid]);
  }
  const refs = [
    { name: 'refs/heads/main', oid: headOid },
    ...memberIds.map(memberId => ({
      name: `refs/heads/members/${memberId}`,
      oid: headOid,
    })),
  ].sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
  if (options.bundleRefMode === 'extra') {
    await git(source, ['update-ref', 'refs/heads/extra', headOid]);
  }
  const bundledRefs: string[] = options.bundleRefMode === 'missing'
    ? refs.slice(0, -1).map(ref => ref.name)
    : refs.map(ref => ref.name);
  if (options.bundleRefMode === 'extra') bundledRefs.push('refs/heads/extra');
  const bundlePath = join(authorityRoot, 'source.bundle');
  await git(source, [
    'bundle',
    'create',
    bundlePath,
    ...bundledRefs,
  ]);
  const bundle = await readFile(bundlePath);
  return {
    authorityRoot,
    bundleByteCount: bundle.length,
    bundlePath,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    objectFormat,
    refs,
    repositoryRoot,
    stagingRoot,
  };
}

function createImporter(
  fixture: BundleFixture,
  overrides: Partial<Pick<
    GitBundleImporterOptions,
    | 'maximumBlobBytes'
    | 'maximumBundleBytes'
    | 'maximumExpandedTreeEntries'
    | 'maximumMetadataOutputBytes'
    | 'maximumRepositoryBytes'
    | 'maximumTreeEntries'
    | 'gitExecutable'
    | 'uploadIdleTimeoutMs'
    | 'uploadTotalTimeoutMs'
  >> & {
    readonly createBundleReadStream?: (
      path: string,
      signal: AbortSignal,
    ) => AsyncIterable<unknown>;
    readonly removeTree?: (path: string) => Promise<void>;
    readonly syncDirectory?: (path: string) => Promise<void>;
  } = {},
): {
  readonly importer: GitBundleImporter;
  readonly resourceAdmission: ResourceAdmission;
  readonly uploadAdmission: BootstrapUploadAdmission;
} {
  const uploadAdmission = new BootstrapUploadAdmission({
    maxConcurrentUploads: 1,
    maxUploadsPerAttempt: 1,
    queueMax: 2,
    queueTimeoutMs: 1_000,
    stagingFreeSpaceFloorBytes: 1,
    stagingReservationBytes: 2 * 1024 * 1024,
    stagingRoot: fixture.stagingRoot,
  });
  const resourceAdmission = new ResourceAdmission({
    maxChildren: 2,
    maxChildrenPerProject: 1,
    queueMax: 2,
    queueMaxPerProject: 1,
    queueTimeoutMs: 1_000,
  });
  return {
    importer: new GitBundleImporter({
      gitExecutable: GIT_EXECUTABLE,
      maximumBlobBytes: 1024 * 1024,
      maximumBundleBytes: 1024 * 1024,
      maximumExpandedTreeEntries: 100_000,
      maximumMetadataOutputBytes: 8 * 1024 * 1024,
      maximumRepositoryBytes: 2 * 1024 * 1024,
      maximumTreeEntries: 2_000,
      operationTimeoutMs: 5_000,
      resourceAdmission,
      stagingRoot: fixture.stagingRoot,
      uploadAdmission,
      uploadIdleTimeoutMs: 1_000,
      uploadTotalTimeoutMs: 5_000,
      ...overrides,
    }),
    resourceAdmission,
    uploadAdmission,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function importInput(
  fixture: BundleFixture,
  overrides: Partial<ImportGitBundleInput> = {},
): ImportGitBundleInput {
  return {
    attemptId: 'attempt-a',
    body: createReadStream(fixture.bundlePath, { highWaterMark: 7 }),
    contentEncoding: 'identity',
    contentType: 'application/x-git-bundle',
    declaredByteCount: fixture.bundleByteCount,
    declaredSha256: fixture.bundleSha256,
    expectedByteCount: fixture.bundleByteCount,
    expectedSha256: fixture.bundleSha256,
    objectFormat: fixture.objectFormat,
    projectId: 'project-a',
    refs: fixture.refs,
    ...overrides,
  };
}

async function expectImportError(
  operation: Promise<unknown>,
  code: GitBundleImportError['code'],
  forbidden: readonly string[] = [],
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof GitBundleImportError);
    assert.equal(error.code, code);
    for (const value of forbidden) {
      assert.doesNotMatch(JSON.stringify(error), new RegExp(value, 'u'));
    }
    return true;
  });
}

describe('GitBundleImporter', () => {
  it('stages a production checkpoint independently from bootstrap upload admission', async () => {
    const fixture = await createBundleFixture({
      memberIds: ['member-a', 'member-b', 'member-c'],
    });
    const owners = createImporter(fixture);
    try {
      await owners.uploadAdmission.close();
      const input: ImportRepositoryCheckpointInput = {
        body: createReadStream(fixture.bundlePath, { highWaterMark: 11 }),
        expectedByteCount: fixture.bundleByteCount,
        expectedSha256: fixture.bundleSha256,
        objectFormat: fixture.objectFormat,
        operationId: 'operation-checkpoint',
        projectId: 'project-a',
        refs: fixture.refs,
      };
      const staged = await owners.importer.importCheckpoint(input);
      assert.deepEqual(staged, {
        artifactKey: repositoryCheckpointArtifactKey(
          'project-a',
          'operation-checkpoint',
        ),
        bundleByteCount: fixture.bundleByteCount,
        bundleSha256: fixture.bundleSha256,
        markerSha256: staged.markerSha256,
        objectFormat: fixture.objectFormat,
        operationId: 'operation-checkpoint',
        projectId: 'project-a',
        refs: fixture.refs,
      });
      assert.equal(Object.isFrozen(staged), true);
      assert.equal(await owners.importer.discardAttempt({
        attemptId: 'operation-checkpoint',
        projectId: 'project-a',
      }), 'replayed');
      assert.equal(await owners.importer.discardCheckpoint({
        operationId: 'operation-checkpoint',
        projectId: 'project-a',
      }), 'removed');
      assert.equal(await owners.importer.discardCheckpoint({
        operationId: 'operation-checkpoint',
        projectId: 'project-a',
      }), 'replayed');
    } finally {
      await owners.importer.close();
      await owners.resourceAdmission.close();
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('hardens imported Git state before committing validation and rebuilds after a barrier failure', async () => {
    const fixture = await createBundleFixture({
      memberIds: ['member-a', 'member-b', 'member-c'],
    });
    const operationId = 'operation-durability';
    const attemptId = repositoryCheckpointAttemptId('project-a', operationId);
    const attempt = join(
      fixture.stagingRoot,
      Buffer.from('project-a').toString('hex'),
      'checkpoint',
      Buffer.from(attemptId).toString('hex'),
    );
    const repository = join(attempt, 'repository');
    const validationMarker = join(repository, '.claudian-cloud-validation.json');
    let injected = false;
    const owners = createImporter(fixture, {
      syncDirectory: async path => {
        if (
          !injected
          && path === attempt
          && await pathExists(repository)
          && !await pathExists(validationMarker)
        ) {
          injected = true;
          throw new Error('injected-repository-durability-failure');
        }
      },
    });
    const input = (): ImportRepositoryCheckpointInput => ({
      body: createReadStream(fixture.bundlePath, { highWaterMark: 11 }),
      expectedByteCount: fixture.bundleByteCount,
      expectedSha256: fixture.bundleSha256,
      objectFormat: fixture.objectFormat,
      operationId,
      projectId: 'project-a',
      refs: fixture.refs,
    });
    try {
      await expectImportError(
        owners.importer.importCheckpoint(input()),
        'storage-unavailable',
      );
      assert.equal(injected, true);
      assert.equal(await pathExists(validationMarker), false);
      const checkpoint = await owners.importer.importCheckpoint(input());
      assert.equal(checkpoint.operationId, operationId);
      assert.equal(await pathExists(validationMarker), true);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('re-establishes an ambiguous validation-marker barrier on replay', async () => {
    const fixture = await createBundleFixture({
      memberIds: ['member-a', 'member-b', 'member-c'],
    });
    const operationId = 'operation-marker-barrier';
    const attemptId = repositoryCheckpointAttemptId('project-a', operationId);
    const attempt = join(
      fixture.stagingRoot,
      Buffer.from('project-a').toString('hex'),
      'checkpoint',
      Buffer.from(attemptId).toString('hex'),
    );
    const repository = join(attempt, 'repository');
    const validationMarker = join(repository, '.claudian-cloud-validation.json');
    let repositorySyncsWithMarker = 0;
    const owners = createImporter(fixture, {
      syncDirectory: async path => {
        if (path === repository && await pathExists(validationMarker)) {
          repositorySyncsWithMarker += 1;
          if (repositorySyncsWithMarker === 1) {
            throw new Error('injected-validation-marker-sync-failure');
          }
        }
      },
    });
    const input = (): ImportRepositoryCheckpointInput => ({
      body: createReadStream(fixture.bundlePath, { highWaterMark: 11 }),
      expectedByteCount: fixture.bundleByteCount,
      expectedSha256: fixture.bundleSha256,
      objectFormat: fixture.objectFormat,
      operationId,
      projectId: 'project-a',
      refs: fixture.refs,
    });
    try {
      await expectImportError(
        owners.importer.importCheckpoint(input()),
        'storage-unavailable',
      );
      assert.equal(await pathExists(validationMarker), true);
      const replay = await owners.importer.importCheckpoint(input());
      assert.equal(replay.operationId, operationId);
      assert.equal(repositorySyncsWithMarker, 2);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('uses an explicit Git fsync policy while materializing a checkpoint', async () => {
    const fixture = await createBundleFixture({
      memberIds: ['member-a', 'member-b', 'member-c'],
    });
    const executable = join(fixture.authorityRoot, 'recording-git');
    const commandLog = join(fixture.authorityRoot, 'git-commands.log');
    await writeFile(executable, `#!/bin/sh
set -eu
printf '%s ' "$@" >> '${commandLog}'
printf '\\n' >> '${commandLog}'
exec '${GIT_EXECUTABLE}' "$@"
`, { mode: 0o755 });
    const owners = createImporter(fixture, { gitExecutable: executable });
    try {
      await owners.importer.importCheckpoint({
        body: createReadStream(fixture.bundlePath, { highWaterMark: 11 }),
        expectedByteCount: fixture.bundleByteCount,
        expectedSha256: fixture.bundleSha256,
        objectFormat: fixture.objectFormat,
        operationId: 'operation-fsync-policy',
        projectId: 'project-a',
        refs: fixture.refs,
      });
      const commands = (await readFile(commandLog, 'utf8')).split('\n');
      for (const command of ['init', 'fetch']) {
        const observed = commands.find(line => line.includes(` ${command} `));
        assert.notEqual(observed, undefined);
        assert.match(observed ?? '', /-c core\.fsync=all -c core\.fsyncMethod=fsync/u);
      }
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('waits for checkpoint discard to finish before shutdown settles', async () => {
    const fixture = await createBundleFixture({
      memberIds: ['member-a', 'member-b', 'member-c'],
    });
    const operationId = 'operation-discard-close';
    const attemptParent = join(
      fixture.stagingRoot,
      Buffer.from('project-a').toString('hex'),
      'checkpoint',
    );
    let blockDiscard = false;
    let enterDiscard: (() => void) | undefined;
    let releaseDiscard: (() => void) | undefined;
    const discardEntered = new Promise<void>(resolve => {
      enterDiscard = resolve;
    });
    const discardRelease = new Promise<void>(resolve => {
      releaseDiscard = resolve;
    });
    const owners = createImporter(fixture, {
      syncDirectory: async path => {
        if (blockDiscard && path === attemptParent) {
          enterDiscard?.();
          await discardRelease;
        }
      },
    });
    try {
      await owners.importer.importCheckpoint({
        body: createReadStream(fixture.bundlePath, { highWaterMark: 11 }),
        expectedByteCount: fixture.bundleByteCount,
        expectedSha256: fixture.bundleSha256,
        objectFormat: fixture.objectFormat,
        operationId,
        projectId: 'project-a',
        refs: fixture.refs,
      });
      blockDiscard = true;
      const discard = owners.importer.discardCheckpoint({
        operationId,
        projectId: 'project-a',
      });
      assert.equal(await Promise.race([
        discardEntered.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
      ]), true);
      let closeSettled = false;
      const closing = owners.importer.close().then(() => {
        closeSettled = true;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(closeSettled, false);
      releaseDiscard?.();
      assert.equal(await discard, 'removed');
      await closing;
    } finally {
      releaseDiscard?.();
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('replays checkpoint cleanup after detachment and partial recursive removal', async () => {
    const fixture = await createBundleFixture({
      memberIds: ['member-a', 'member-b', 'member-c'],
    });
    const operationId = 'operation-partial-cleanup';
    const attemptId = repositoryCheckpointAttemptId('project-a', operationId);
    const attempt = join(
      fixture.stagingRoot,
      Buffer.from('project-a').toString('hex'),
      'checkpoint',
      Buffer.from(attemptId).toString('hex'),
    );
    const attemptParent = join(
      fixture.stagingRoot,
      Buffer.from('project-a').toString('hex'),
      'checkpoint',
    );
    let cleanupStarted = false;
    let cleanupSyncCount = 0;
    let failCleanup = true;
    const detachedCleanups: string[] = [];
    const latestDetachedCleanup = (): string | undefined => detachedCleanups.at(-1);
    const owners = createImporter(fixture, {
      removeTree: async path => {
        detachedCleanups.push(path);
        if (failCleanup) {
          failCleanup = false;
          await rm(join(path, 'repository', '.claudian-cloud-validation.json'), {
            force: true,
          });
          throw new Error('injected-partial-cleanup-failure');
        }
        await rm(path, { recursive: true });
      },
      syncDirectory: path => {
        if (cleanupStarted && path === attemptParent) {
          cleanupSyncCount += 1;
          if (cleanupSyncCount === 2) {
            throw new Error('injected-detachment-sync-failure');
          }
        }
        return Promise.resolve();
      },
    });
    try {
      await owners.importer.importCheckpoint({
        body: createReadStream(fixture.bundlePath, { highWaterMark: 11 }),
        expectedByteCount: fixture.bundleByteCount,
        expectedSha256: fixture.bundleSha256,
        objectFormat: fixture.objectFormat,
        operationId,
        projectId: 'project-a',
        refs: fixture.refs,
      });
      cleanupStarted = true;
      await expectImportError(owners.importer.discardCheckpoint({
        operationId,
        projectId: 'project-a',
      }), 'storage-unavailable');
      assert.equal(await pathExists(attempt), false);
      assert.deepEqual(detachedCleanups, []);
      await expectImportError(owners.importer.discardCheckpoint({
        operationId,
        projectId: 'project-a',
      }), 'storage-unavailable');
      const detachedCleanup = latestDetachedCleanup();
      assert.ok(detachedCleanup !== undefined);
      assert.equal(await pathExists(detachedCleanup), true);
      assert.equal(await owners.importer.discardCheckpoint({
        operationId,
        projectId: 'project-a',
      }), 'removed');
      assert.equal(await pathExists(detachedCleanup), false);
      assert.equal(await owners.importer.discardCheckpoint({
        operationId,
        projectId: 'project-a',
      }), 'replayed');
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('preserves an ownership conflict while discarding checkpoint staging', async () => {
    const fixture = await createBundleFixture({
      memberIds: ['member-a', 'member-b'],
    });
    const operationId = 'operation-discard-ownership-conflict';
    const repository = repositoryCheckpointStagingRepositoryPath(
      fixture.stagingRoot,
      'project-a',
      operationId,
    );
    const attempt = dirname(repository);
    const owners = createImporter(fixture);
    try {
      await owners.importer.importCheckpoint({
        body: createReadStream(fixture.bundlePath, { highWaterMark: 11 }),
        expectedByteCount: fixture.bundleByteCount,
        expectedSha256: fixture.bundleSha256,
        objectFormat: fixture.objectFormat,
        operationId,
        projectId: 'project-a',
        refs: fixture.refs,
      });
      await rm(join(attempt, '.claudian-cloud-attempt.json'));
      await expectImportError(owners.importer.discardCheckpoint({
        operationId,
        projectId: 'project-a',
      }), 'artifact-conflict');
      assert.equal(await pathExists(repository), true);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('structurally isolates checkpoint staging from caller-chosen bootstrap IDs', async () => {
    const fixture = await createBundleFixture({
      memberIds: ['member-a', 'member-b'],
    });
    const owners = createImporter(fixture);
    const projectId = 'project-a';
    const operationId = 'operation-shared';
    const bootstrapAttemptId = repositoryCheckpointAttemptId(
      projectId,
      operationId,
    );
    const checkpointInput = (): ImportRepositoryCheckpointInput => ({
      body: createReadStream(fixture.bundlePath, { highWaterMark: 11 }),
      expectedByteCount: fixture.bundleByteCount,
      expectedSha256: fixture.bundleSha256,
      objectFormat: fixture.objectFormat,
      operationId,
      projectId,
      refs: fixture.refs,
    });
    const bootstrapInput = (): ImportGitBundleInput => importInput(fixture, {
      attemptId: bootstrapAttemptId,
      body: createReadStream(fixture.bundlePath, { highWaterMark: 13 }),
      projectId,
    });
    try {
      const [bootstrap, checkpoint] = await Promise.all([
        owners.importer.importBundle(bootstrapInput()),
        owners.importer.importCheckpoint(checkpointInput()),
      ]);
      assert.notEqual(bootstrap.artifactKey, checkpoint.artifactKey);
      assert.equal(
        (await owners.importer.importBundle(bootstrapInput())).artifactKey,
        bootstrap.artifactKey,
      );
      assert.equal(
        (await owners.importer.importCheckpoint(checkpointInput())).artifactKey,
        checkpoint.artifactKey,
      );

      assert.equal(await owners.importer.discardCheckpoint({
        operationId,
        projectId,
      }), 'removed');
      assert.equal(
        (await owners.importer.importBundle(bootstrapInput())).artifactKey,
        bootstrap.artifactKey,
      );
      await owners.importer.importCheckpoint(checkpointInput());

      assert.equal(await owners.importer.discardAttempt({
        attemptId: bootstrapAttemptId,
        projectId,
      }), 'removed');
      assert.equal(
        (await owners.importer.importCheckpoint(checkpointInput())).artifactKey,
        checkpoint.artifactKey,
      );
      assert.equal(await owners.importer.discardCheckpoint({
        operationId,
        projectId,
      }), 'removed');
    } finally {
      await owners.importer.close();
      await owners.resourceAdmission.close();
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('rejects extra refs in a production checkpoint bundle', async () => {
    const fixture = await createBundleFixture({
      bundleRefMode: 'extra',
      memberIds: ['member-a', 'member-b', 'member-c'],
    });
    const owners = createImporter(fixture);
    try {
      await expectImportError(owners.importer.importCheckpoint({
        body: createReadStream(fixture.bundlePath),
        expectedByteCount: fixture.bundleByteCount,
        expectedSha256: fixture.bundleSha256,
        objectFormat: fixture.objectFormat,
        operationId: 'operation-extra-ref',
        projectId: 'project-a',
        refs: fixture.refs,
      }), 'repository-invalid');
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('streams and imports an exact raw bundle with real Git', async () => {
    const fixture = await createBundleFixture();
    const owners = createImporter(fixture);
    try {
      const input = importInput(fixture);
      const validated = await owners.importer.importBundle(input);
      assert.deepEqual(validated, {
        artifactKey: createHash('sha256')
          .update('project-a\0attempt-a')
          .digest('hex'),
        attemptId: 'attempt-a',
        bundleByteCount: fixture.bundleByteCount,
        bundleSha256: fixture.bundleSha256,
        markerSha256: validated.markerSha256,
        objectFormat: 'sha1',
        projectId: 'project-a',
        refs: fixture.refs,
      });
      assert.match(validated.markerSha256, /^[0-9a-f]{64}$/u);
      assert.equal(Object.isFrozen(validated), true);
      assert.equal(JSON.stringify(validated).includes(fixture.authorityRoot), false);

      let replayBodyRead = false;
      const replay = await owners.importer.importBundle({
        ...input,
        body: {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<Uint8Array>> {
                replayBodyRead = true;
                return Promise.reject(new Error('replay-body-must-not-be-read'));
              },
            };
          },
        },
      });
      assert.deepEqual(replay, validated);
      assert.equal(replayBodyRead, false);

      const stagedBundle = join(
        fixture.stagingRoot,
        Buffer.from('project-a').toString('hex'),
        Buffer.from('attempt-a').toString('hex'),
        'source.bundle',
      );
      assert.equal((await stat(stagedBundle)).mode & 0o777, 0o600);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('imports the exact repository using the declared sha256 object format', async () => {
    const fixture = await createBundleFixture({ objectFormat: 'sha256' });
    const owners = createImporter(fixture);
    try {
      const validated = await owners.importer.importBundle(importInput(fixture));
      assert.equal(validated.objectFormat, 'sha256');
      assert.equal(validated.refs.every(ref => ref.oid.length === 64), true);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('accepts mixed-case refs in the protocol canonical en-US order', async () => {
    const fixture = await createBundleFixture({ memberIds: ['member-a', 'member-B'] });
    const owners = createImporter(fixture);
    try {
      const validated = await owners.importer.importBundle(importInput(fixture));
      assert.deepEqual(validated.refs.map(ref => ref.name), [
        'refs/heads/main',
        'refs/heads/members/member-a',
        'refs/heads/members/member-B',
      ]);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('rejects contradictory transport identity before reading bytes', async () => {
    const fixture = await createBundleFixture();
    const owners = createImporter(fixture);
    let bodyRead = false;
    try {
      await expectImportError(owners.importer.importBundle({
        attemptId: 'attempt-a',
        body: (async function* body(): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          bodyRead = true;
          yield Buffer.from('private-bundle-sentinel');
        })(),
        contentEncoding: 'gzip',
        contentLength: fixture.bundleByteCount,
        contentType: 'application/octet-stream',
        declaredByteCount: fixture.bundleByteCount + 1,
        declaredSha256: 'b'.repeat(64),
        expectedByteCount: fixture.bundleByteCount,
        expectedSha256: fixture.bundleSha256,
        objectFormat: 'sha1',
        projectId: 'project-a',
        refs: fixture.refs,
      }), 'artifact-invalid', [fixture.authorityRoot, 'private-bundle-sentinel']);
      assert.equal(bodyRead, false);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('cleans partial uploads on digest failure, timeout, and cancellation', async () => {
    const fixture = await createBundleFixture();
    const owners = createImporter(fixture, {
      uploadIdleTimeoutMs: 20,
      uploadTotalTimeoutMs: 1_000,
    });
    const attemptPath = (attemptId: string): string => join(
      fixture.stagingRoot,
      Buffer.from('project-a').toString('hex'),
      Buffer.from(attemptId).toString('hex'),
    );
    try {
      const changed = Buffer.from(await readFile(fixture.bundlePath));
      changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
      await expectImportError(owners.importer.importBundle(importInput(fixture, {
        attemptId: 'attempt-digest',
        body: (async function* body(): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield changed;
        })(),
      })), 'digest-mismatch');
      await assert.rejects(
        stat(join(attemptPath('attempt-digest'), '.source.bundle.part')),
        { code: 'ENOENT' },
      );

      let timedOutReturned = false;
      await expectImportError(owners.importer.importBundle(importInput(fixture, {
        attemptId: 'attempt-timeout',
        body: {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<Uint8Array>> {
                return new Promise(() => undefined);
              },
              return(): Promise<IteratorResult<Uint8Array>> {
                timedOutReturned = true;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        },
      })), 'timeout');
      assert.equal(timedOutReturned, true);
      await assert.rejects(
        stat(join(attemptPath('attempt-timeout'), '.source.bundle.part')),
        { code: 'ENOENT' },
      );

      const cancellation = new AbortController();
      let cancelledReturned = false;
      let calls = 0;
      const cancelled = owners.importer.importBundle(importInput(fixture, {
        attemptId: 'attempt-cancelled',
        body: {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<Uint8Array>> {
                calls += 1;
                if (calls === 1) {
                  return Promise.resolve({
                    done: false,
                    value: Buffer.from('partial'),
                  });
                }
                return new Promise(() => undefined);
              },
              return(): Promise<IteratorResult<Uint8Array>> {
                cancelledReturned = true;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        },
        signal: cancellation.signal,
      }));
      await new Promise(resolve => setTimeout(resolve, 10));
      cancellation.abort();
      await expectImportError(cancelled, 'cancelled');
      assert.equal(cancelledReturned, true);
      await assert.rejects(
        stat(join(attemptPath('attempt-cancelled'), '.source.bundle.part')),
        { code: 'ENOENT' },
      );

      let settlementReturned = false;
      const settlementUpload = owners.importer.importBundle(importInput(fixture, {
        attemptId: 'attempt-settlement',
        body: {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<Uint8Array>> {
                return new Promise(() => undefined);
              },
              return(): Promise<IteratorResult<Uint8Array>> {
                settlementReturned = true;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        },
      }));
      const settlementFailure = expectImportError(settlementUpload, 'cancelled');
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(await owners.importer.discardAttempt({
        attemptId: 'attempt-settlement',
        projectId: 'project-a',
      }), 'removed');
      await settlementFailure;
      assert.equal(settlementReturned, true);
      await assert.rejects(stat(attemptPath('attempt-settlement')), { code: 'ENOENT' });
      assert.equal(await owners.importer.discardAttempt({
        attemptId: 'attempt-settlement',
        projectId: 'project-a',
      }), 'replayed');

      assert.equal(
        (await owners.importer.importBundle(importInput(fixture, {
          attemptId: 'attempt-after-failures',
        }))).attemptId,
        'attempt-after-failures',
      );
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('bounds overflow and rejects incomplete and disconnected upload bodies', async () => {
    const fixture = await createBundleFixture();
    const owners = createImporter(fixture);
    const attemptPath = (attemptId: string): string => join(
      fixture.stagingRoot,
      Buffer.from('project-a').toString('hex'),
      Buffer.from(attemptId).toString('hex'),
    );
    const bundle = await readFile(fixture.bundlePath);
    try {
      await expectImportError(owners.importer.importBundle(importInput(fixture, {
        attemptId: 'attempt-overflow',
        body: (async function* body(): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield bundle;
        })(),
        declaredByteCount: bundle.length - 1,
        expectedByteCount: bundle.length - 1,
      })), 'repository-limit');
      await expectImportError(owners.importer.importBundle(importInput(fixture, {
        attemptId: 'attempt-incomplete',
        body: (async function* body(): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield bundle.subarray(0, -1);
        })(),
      })), 'artifact-invalid');
      await expectImportError(owners.importer.importBundle(importInput(fixture, {
        attemptId: 'attempt-disconnected',
        body: (async function* body(): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield bundle.subarray(0, 8);
          throw new Error('private-disconnect-sentinel');
        })(),
      })), 'artifact-invalid', ['private-disconnect-sentinel']);

      for (const attemptId of [
        'attempt-overflow',
        'attempt-incomplete',
        'attempt-disconnected',
      ]) {
        await assert.rejects(
          stat(join(attemptPath(attemptId), '.source.bundle.part')),
          { code: 'ENOENT' },
        );
      }
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('rejects markerless adoption and recovers an owned partial marker', async () => {
    const fixture = await createBundleFixture();
    const owners = createImporter(fixture);
    const attempt = join(
      fixture.stagingRoot,
      Buffer.from('project-a').toString('hex'),
      Buffer.from('attempt-a').toString('hex'),
    );
    try {
      await mkdir(attempt, { recursive: true });
      await writeFile(
        join(attempt, '..claudian-cloud-attempt.json.part'),
        'interrupted-marker',
      );
      await expectImportError(
        owners.importer.importBundle(importInput(fixture)),
        'artifact-conflict',
      );
      await rm(attempt, { recursive: true });
      const validated = await owners.importer.importBundle(importInput(fixture));
      assert.equal(validated.attemptId, 'attempt-a');
      await writeFile(
        join(attempt, '..claudian-cloud-attempt.json.part'),
        'interrupted-marker',
      );
      assert.equal(
        (await owners.importer.importBundle(importInput(fixture))).artifactKey,
        validated.artifactKey,
      );
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('enforces blob, tree, repository, path, and mode policy', async () => {
    const cases = [{
      code: 'repository-limit' as const,
      fixture: await createBundleFixture({ files: { 'large.md': 'x'.repeat(32) } }),
      overrides: { maximumBlobBytes: 8 },
    }, {
      code: 'repository-limit' as const,
      fixture: await createBundleFixture({ files: { 'a.md': 'a', 'b.md': 'b' } }),
      overrides: { maximumTreeEntries: 1 },
    }, {
      code: 'repository-limit' as const,
      fixture: await createBundleFixture(),
      overrides: { maximumBlobBytes: 100, maximumRepositoryBytes: 100 },
    }, {
      code: 'repository-invalid' as const,
      fixture: await createBundleFixture({ files: { CON: 'reserved' } }),
      overrides: {},
    }, {
      code: 'repository-limit' as const,
      fixture: await createBundleFixture({ files: { ['x'.repeat(121)]: 'long' } }),
      overrides: {},
    }, {
      code: 'repository-limit' as const,
      fixture: await createBundleFixture({
        files: { [`${'a'.repeat(100)}/${'b'.repeat(100)}/${'c'.repeat(100)}`]: 'long' },
      }),
      overrides: {},
    }, {
      code: 'repository-invalid' as const,
      fixture: await createBundleFixture({
        files: { 'note.md': 'note' },
        symlinks: { link: 'note.md' },
      }),
      overrides: {},
    }, {
      code: 'repository-invalid' as const,
      fixture: await createBundleFixture({ gitlink: true }),
      overrides: {},
    }];
    for (const testCase of cases) {
      const owners = createImporter(testCase.fixture, testCase.overrides);
      try {
        await expectImportError(
          owners.importer.importBundle(importInput(testCase.fixture)),
          testCase.code,
          [testCase.fixture.authorityRoot],
        );
      } finally {
        await owners.importer.close();
        await Promise.all([
          owners.resourceAdmission.close(),
          owners.uploadAdmission.close(),
        ]);
        await rm(testCase.fixture.authorityRoot, { force: true, recursive: true });
      }
    }
  });

  it('bounds expanded paths when tree objects are reused', async () => {
    const fixture = await createBundleFixture({ repeatedTreeDepth: 4 });
    const owners = createImporter(fixture, { maximumExpandedTreeEntries: 12 });
    try {
      await expectImportError(
        owners.importer.importBundle(importInput(fixture)),
        'repository-limit',
      );
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('materializes all tree objects through one bounded Git process', async () => {
    const fixture = await createBundleFixture({ repeatedTreeDepth: 4 });
    const counter = join(fixture.authorityRoot, 'cat-file-batch-count');
    const executable = join(fixture.authorityRoot, 'counting-git');
    await writeFile(
      executable,
      `#!/bin/sh\nif [ "$1" = "cat-file" ] && [ "$2" = "--batch" ]; then\n  printf '1\\n' >> '${counter}'\nfi\nexec ${GIT_EXECUTABLE} "$@"\n`,
      { mode: 0o700 },
    );
    const owners = createImporter(fixture, { gitExecutable: executable });
    try {
      await owners.importer.importBundle(importInput(fixture));
      const invocations = (await readFile(counter, 'utf8')).trim().split('\n');
      assert.equal(invocations.length, 1);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('streams eligible aggregate tree metadata beyond the generic output cap', async () => {
    const fixture = await createBundleFixture({ wideTreeDirectoryCount: 2 });
    const owners = createImporter(fixture, {
      maximumMetadataOutputBytes: 1024 * 1024,
    });
    try {
      const validated = await owners.importer.importBundle(importInput(fixture));
      assert.equal(validated.projectId, 'project-a');
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('applies the total upload deadline while Git materializes trees', async () => {
    const fixture = await createBundleFixture();
    const executable = join(fixture.authorityRoot, 'slow-tree-git');
    await writeFile(
      executable,
      `#!/bin/sh\nif [ "$1" = "cat-file" ] && [ "$2" = "--batch" ]; then\n  sleep 2\nfi\nexec ${GIT_EXECUTABLE} "$@"\n`,
      { mode: 0o700 },
    );
    const owners = createImporter(fixture, {
      gitExecutable: executable,
      uploadIdleTimeoutMs: 100,
      uploadTotalTimeoutMs: 500,
    });
    const startedAt = Date.now();
    try {
      await expectImportError(
        owners.importer.importBundle(importInput(fixture)),
        'timeout',
      );
      assert.ok(Date.now() - startedAt < 1_500);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('applies the total upload deadline while verifying the Git version', async () => {
    const fixture = await createBundleFixture();
    const executable = join(fixture.authorityRoot, 'slow-version-git');
    await writeFile(
      executable,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  sleep 2\nfi\nexec ${GIT_EXECUTABLE} "$@"\n`,
      { mode: 0o700 },
    );
    const owners = createImporter(fixture, {
      gitExecutable: executable,
      uploadIdleTimeoutMs: 100,
      uploadTotalTimeoutMs: 500,
    });
    const startedAt = Date.now();
    try {
      await expectImportError(
        owners.importer.importBundle(importInput(fixture)),
        'timeout',
      );
      assert.ok(Date.now() - startedAt < 1_500);
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('cancels Git version verification without retaining permits', async () => {
    const fixture = await createBundleFixture();
    const executable = join(fixture.authorityRoot, 'cancel-version-git');
    await writeFile(
      executable,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  sleep 2\nfi\nexec ${GIT_EXECUTABLE} "$@"\n`,
      { mode: 0o700 },
    );
    const owners = createImporter(fixture, { gitExecutable: executable });
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expectImportError(
        owners.importer.importBundle(importInput(fixture, { signal: controller.signal })),
        'cancelled',
      );
      assert.ok(Date.now() - startedAt < 1_500);
    } finally {
      clearTimeout(timer);
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('aborts stalled validated-bundle hashing and releases both permits', async () => {
    const fixture = await createBundleFixture();
    const owners = createImporter(fixture, {
      createBundleReadStream: (_path, signal) => {
        const stream = new Readable({ read() {} });
        signal.addEventListener('abort', () => stream.destroy(), { once: true });
        return stream;
      },
      uploadIdleTimeoutMs: 100,
      uploadTotalTimeoutMs: 1_000,
    });
    try {
      await owners.importer.importBundle(importInput(fixture));
      const startedAt = Date.now();
      await expectImportError(
        owners.importer.importBundle(importInput(fixture)),
        'timeout',
      );
      assert.ok(Date.now() - startedAt < 2_000);

      const uploadPermit = await owners.uploadAdmission.acquire({
        attemptId: 'attempt-after-timeout',
      });
      const gitPermit = await owners.resourceAdmission.acquireGitChild({
        classification: 'write',
        projectId: 'project-after-timeout',
      });
      gitPermit.release();
      uploadPermit.release();
    } finally {
      await owners.importer.close();
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('rejects ref, bundle, and validated-replay contradictions', async () => {
    for (const bundleRefMode of ['extra', 'missing'] as const) {
      const fixture = await createBundleFixture({ bundleRefMode });
      const owners = createImporter(fixture);
      try {
        await expectImportError(
          owners.importer.importBundle(importInput(fixture)),
          'repository-invalid',
        );
      } finally {
        await owners.importer.close();
        await Promise.all([
          owners.resourceAdmission.close(),
          owners.uploadAdmission.close(),
        ]);
        await rm(fixture.authorityRoot, { force: true, recursive: true });
      }
    }

    const wrongRefs = await createBundleFixture();
    const wrongRefOwners = createImporter(wrongRefs);
    try {
      await expectImportError(wrongRefOwners.importer.importBundle(importInput(
        wrongRefs,
        {
          refs: wrongRefs.refs.map((ref, index) => (
            index === 0 ? { ...ref, oid: 'b'.repeat(40) } : ref
          )),
        },
      )), 'repository-invalid');
    } finally {
      await wrongRefOwners.importer.close();
      await Promise.all([
        wrongRefOwners.resourceAdmission.close(),
        wrongRefOwners.uploadAdmission.close(),
      ]);
      await rm(wrongRefs.authorityRoot, { force: true, recursive: true });
    }

    const corrupt = await createBundleFixture();
    const corruptOwners = createImporter(corrupt);
    try {
      const bytes = Buffer.from(await readFile(corrupt.bundlePath));
      const corruptOffset = Math.floor(bytes.length / 2);
      bytes.writeUInt8(bytes.readUInt8(corruptOffset) ^ 1, corruptOffset);
      const corruptPath = join(corrupt.authorityRoot, 'corrupt.bundle');
      await writeFile(corruptPath, bytes);
      const digest = createHash('sha256').update(bytes).digest('hex');
      await expectImportError(corruptOwners.importer.importBundle(importInput(corrupt, {
        body: createReadStream(corruptPath),
        declaredSha256: digest,
        expectedSha256: digest,
      })), 'repository-invalid');
    } finally {
      await corruptOwners.importer.close();
      await Promise.all([
        corruptOwners.resourceAdmission.close(),
        corruptOwners.uploadAdmission.close(),
      ]);
      await rm(corrupt.authorityRoot, { force: true, recursive: true });
    }

    const replay = await createBundleFixture();
    const replayOwners = createImporter(replay);
    try {
      const input = importInput(replay);
      await replayOwners.importer.importBundle(input);
      const repository = join(
        replay.stagingRoot,
        Buffer.from('project-a').toString('hex'),
        Buffer.from('attempt-a').toString('hex'),
        'repository',
      );
      await execFileAsync(GIT_EXECUTABLE, [
        `--git-dir=${repository}`,
        'update-ref',
        'refs/heads/extra',
        replay.refs[0]?.oid ?? '',
      ]);
      let bodyRead = false;
      await expectImportError(replayOwners.importer.importBundle({
        ...input,
        body: {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<Uint8Array>> {
                bodyRead = true;
                return Promise.reject(new Error('body-must-not-be-read'));
              },
            };
          },
        },
      }), 'repository-invalid');
      assert.equal(bodyRead, false);

      await execFileAsync(GIT_EXECUTABLE, [
        `--git-dir=${repository}`,
        'update-ref',
        '-d',
        'refs/heads/extra',
      ]);
      const unreachable = join(replay.authorityRoot, 'unreachable-object');
      await writeFile(unreachable, 'private-unreachable-object');
      await execFileAsync(GIT_EXECUTABLE, [
        `--git-dir=${repository}`,
        'hash-object',
        '-w',
        unreachable,
      ]);
      await expectImportError(
        replayOwners.importer.importBundle(input),
        'repository-invalid',
        ['private-unreachable-object'],
      );
    } finally {
      await replayOwners.importer.close();
      await Promise.all([
        replayOwners.resourceAdmission.close(),
        replayOwners.uploadAdmission.close(),
      ]);
      await rm(replay.authorityRoot, { force: true, recursive: true });
    }
  });

  it('aborts an active stream during shutdown and releases admission', async () => {
    const fixture = await createBundleFixture();
    const owners = createImporter(fixture);
    let returned = false;
    const importing = owners.importer.importBundle(importInput(fixture, {
      body: {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Uint8Array>> {
              return new Promise(() => undefined);
            },
            return(): Promise<IteratorResult<Uint8Array>> {
              returned = true;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
    }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const closing = owners.importer.close();
    try {
      await expectImportError(importing, 'closed');
      await closing;
      assert.equal(returned, true);
    } finally {
      await Promise.all([
        owners.resourceAdmission.close(),
        owners.uploadAdmission.close(),
      ]);
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });
});
