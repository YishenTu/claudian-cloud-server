import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  COLLAB_MAIN_REF,
} from '@claudian/collab-protocol';

import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  GitRepositoryAuthority,
  GitRepositoryError,
} from '../../../src/repositories/GitRepositoryAuthority.js';
import {
  createRepositoryPlacementLease,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from '../../../src/repositories/RepositoryPlacement.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';

class CurrentPlacementValidator implements RepositoryPlacementValidator {
  async isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    await Promise.resolve();
    return true;
  }
}

class SequencedPlacementValidator implements RepositoryPlacementValidator {
  readonly #results: (boolean | Error)[];

  constructor(results: readonly (boolean | Error)[]) {
    this.#results = [...results];
  }

  async isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    await Promise.resolve();
    const result = this.#results.shift() ?? false;
    if (result instanceof Error) throw result;
    return result;
  }
}

function placement(
  repositoryStorageKey: string,
  projectId = 'project-a',
): RepositoryPlacementLease {
  return createRepositoryPlacementLease({
    active: true,
    generation: 1,
    projectId,
    repositoryStorageKey,
    storageNodeId: 'node-a',
  });
}

function repositoryPath(
  root: string,
  accepted: RepositoryPlacementLease,
): string {
  return join(
    root,
    Buffer.from(accepted.projectId, 'utf8').toString('hex'),
    accepted.repositoryStorageKey,
  );
}

function admission(): ResourceAdmission {
  return new ResourceAdmission({
    maxChildren: 3,
    maxChildrenPerProject: 1,
    queueMax: 2,
    queueMaxPerProject: 1,
    queueTimeoutMs: 100,
  });
}

async function expectGitError(
  operation: Promise<unknown>,
  code: GitRepositoryError['code'],
  forbidden: readonly string[] = [],
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof GitRepositoryError);
    assert.equal(error.code, code);
    assert.deepEqual(error.toJSON(), {
      code,
      message: `git-repository.error.${code}`,
      name: 'GitRepositoryError',
      retryable: code === 'busy',
    });
    for (const value of forbidden) {
      assert.equal(JSON.stringify(error).includes(value), false);
    }
    return true;
  });
}

async function writeExecutable(
  root: string,
  name: string,
  body: string,
): Promise<string> {
  const executable = join(root, name);
  await writeFile(
    executable,
    `#!/bin/sh
set -u
if [ "\${1-}" = "rev-parse" ]; then
  printf 'true\\n'
  exit 0
fi
${body}
`,
  );
  await chmod(executable, 0o755);
  return executable;
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
  throw new Error('git-test-marker-timeout');
}

async function assertProcessGone(marker: string): Promise<void> {
  const pid = Number(await readFile(marker, 'utf8'));
  assert.equal(Number.isSafeInteger(pid) && pid > 0, true);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ESRCH'
    ),
  );
}

async function processIds(marker: string): Promise<readonly number[]> {
  return (await readFile(marker, 'utf8'))
    .trim()
    .split(/\s+/)
    .map(value => Number(value));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceProcessCleanup(pids: readonly number[]): void {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process has already been reaped.
    }
  }
}

async function settleWithin(operation: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('git-test-cleanup-timeout')),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function createFakeAuthority(options: {
  readonly executableBody: (marker: string) => string;
  readonly operationTimeoutMs?: number;
  readonly outputMaxBytes?: number;
}) {
  const root = await mkdtemp(join(tmpdir(), 'claudian-fake-git-'));
  const marker = join(root, 'process.marker');
  const executable = await writeExecutable(
    root,
    'fake-git',
    options.executableBody(marker),
  );
  const repository = placement('repository');
  await mkdir(repositoryPath(root, repository), { recursive: true });
  const resourceAdmission = admission();
  const authority = new GitRepositoryAuthority({
    gitExecutable: executable,
    operationTimeoutMs: options.operationTimeoutMs ?? 2_000,
    outputMaxBytes: options.outputMaxBytes ?? 4_096,
    placementValidator: new CurrentPlacementValidator(),
    repositoryRoot: root,
    resourceAdmission,
    storageNodeId: 'node-a',
  });
  return {
    authority,
    marker,
    repository,
    resourceAdmission,
    root,
  };
}

async function closeFakeAuthority(fixture: Awaited<ReturnType<typeof createFakeAuthority>>) {
  await settleWithin(fixture.authority.close());
  await settleWithin(fixture.resourceAdmission.close());
  await rm(fixture.root, { force: true, recursive: true });
}

describe('GitRepositoryAuthority', () => {
  it('rejects receive cleanup through a symlinked object directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-git-cleanup-containment-'));
    const accepted = placement('repository');
    const bare = repositoryPath(root, accepted);
    const outside = join(root, 'outside-objects');
    const victim = join(outside, 'incoming-victim');
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 64 * 1_024,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      await mkdir(bare, { recursive: true });
      await mkdir(victim, { recursive: true });
      await symlink(outside, join(bare, 'objects'));

      await expectGitError(
        authority.cleanupReceivePackState(accepted),
        'repository-corrupt',
      );
      await access(victim);
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('verifies a current contained bare repository with real Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-git-authority-'));
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 64 * 1024,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      const accepted = placement('valid_bare');
      await execFileAsync(GIT_EXECUTABLE, [
        'init',
        '--bare',
        repositoryPath(root, accepted),
      ]);

      assert.deepEqual(await authority.verifyCapability(), {
        status: 'supported',
      });
      assert.deepEqual(await authority.verifyIntegrity(accepted), {
        status: 'valid',
      });

      const corrupt = placement('corrupt_bare');
      const corruptPath = repositoryPath(root, corrupt);
      await execFileAsync(GIT_EXECUTABLE, ['init', '--bare', corruptPath]);
      await mkdir(join(corruptPath, 'objects/aa'));
      await writeFile(
        join(corruptPath, `objects/aa/${'0'.repeat(38)}`),
        'private-object-content',
      );
      await assert.rejects(
        authority.verifyIntegrity(corrupt),
        error => {
          assert.equal(
            (error as { readonly code?: string }).code,
            'repository-corrupt',
          );
          assert.doesNotMatch(
            JSON.stringify(error),
            /private-object-content|claudian-git-authority/,
          );
          return true;
        },
      );

      const nonBare = placement('non_bare');
      await execFileAsync(GIT_EXECUTABLE, [
        'init',
        repositoryPath(root, nonBare),
      ]);
      await expectGitError(
        authority.verifyIntegrity(nonBare),
        'repository-corrupt',
        [root],
      );
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('verifies an exact mixed-case ref set independently of locale ordering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-git-exact-refs-'));
    const work = join(root, 'work');
    const accepted = placement('mixed_case_refs');
    const bare = repositoryPath(root, accepted);
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 64 * 1024,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      await execFileAsync(GIT_EXECUTABLE, ['init', '--initial-branch=main', work]);
      await execFileAsync(GIT_EXECUTABLE, ['config', 'user.email', 'test@example.invalid'], {
        cwd: work,
      });
      await execFileAsync(GIT_EXECUTABLE, ['config', 'user.name', 'Test User'], {
        cwd: work,
      });
      await writeFile(join(work, 'file.txt'), 'content\n');
      await execFileAsync(GIT_EXECUTABLE, ['add', 'file.txt'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'fixture'], { cwd: work });
      const { stdout } = await execFileAsync(GIT_EXECUTABLE, ['rev-parse', 'HEAD'], {
        cwd: work,
        encoding: 'utf8',
      });
      const oid = stdout.trim();
      await execFileAsync(GIT_EXECUTABLE, ['branch', 'members/member-a'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['branch', 'members/Member-B'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['clone', '--bare', work, bare]);

      const expectedRefs = [{ name: 'refs/heads/main', oid }, {
          name: 'refs/heads/members/member-a',
          oid,
        }, {
          name: 'refs/heads/members/Member-B',
          oid,
        }];
      assert.deepEqual(await authority.verifyIntegrity(accepted, {
        expectedRefs,
      }), { status: 'valid' });
      await authority.verifyProjectRead({
        expectedRefs,
        expectedMainOid: oid,
        placement: accepted,
      });
      await expectGitError(
        authority.verifyProjectRead({
          expectedRefs: expectedRefs.map(ref => (
            ref.name === COLLAB_MAIN_REF ? { ...ref, oid: 'f'.repeat(40) } : ref
          )),
          expectedMainOid: 'f'.repeat(40),
          placement: accepted,
        }),
        'repository-corrupt',
      );
      await execFileAsync(GIT_EXECUTABLE, [
        `--git-dir=${bare}`,
        'update-ref',
        'refs/tags/private-drift',
        oid,
      ]);
      await expectGitError(
        authority.verifyProjectRead({
          expectedRefs,
          expectedMainOid: oid,
          placement: accepted,
        }),
        'repository-corrupt',
      );
      assert.equal(COLLAB_MAIN_REF, 'refs/heads/main');
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('accepts valid unreachable objects without charging diagnostic output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-git-unreachable-'));
    const accepted = placement('valid_unreachable');
    const acceptedRepositoryPath = repositoryPath(root, accepted);
    const blobPath = join(root, 'unreachable-blob');
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 1_024,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      await execFileAsync(GIT_EXECUTABLE, [
        'init',
        '--bare',
        acceptedRepositoryPath,
      ]);
      for (let index = 0; index < 40; index += 1) {
        await writeFile(blobPath, `valid-unreachable-object-${String(index)}`);
        await execFileAsync(GIT_EXECUTABLE, [
          `--git-dir=${acceptedRepositoryPath}`,
          'hash-object',
          '-w',
          blobPath,
        ]);
      }

      assert.deepEqual(await authority.verifyIntegrity(accepted), {
        status: 'valid',
      });
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('revalidates placement immediately before starting Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-revalidation-'));
    const marker = join(root, 'spawned.marker');
    const executable = await writeExecutable(
      root,
      'fake-git',
      `printf spawned > '${marker}'`,
    );
    const accepted = placement('repository');
    await mkdir(repositoryPath(root, accepted), { recursive: true });
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: executable,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: new SequencedPlacementValidator([true, false]),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      await expectGitError(
        authority.verifyIntegrity(accepted),
        'placement-rejected',
      );
      await assert.rejects(access(marker), { code: 'ENOENT' });
      const wrongNode = createRepositoryPlacementLease({
        ...accepted,
        storageNodeId: 'node-b',
      });
      await expectGitError(
        authority.verifyIntegrity(wrongNode),
        'placement-rejected',
      );
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('revalidates placement immediately before advertising upload-pack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-upload-pack-revalidation-'));
    const marker = join(root, 'spawned.marker');
    const executable = await writeExecutable(
      root,
      'fake-git',
      `printf spawned > '${marker}'`,
    );
    const accepted = placement('repository');
    await mkdir(repositoryPath(root, accepted), { recursive: true });
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: executable,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: new SequencedPlacementValidator([true, false]),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      await expectGitError(
        authority.advertiseUploadPack(accepted, {
          expectedRefs: [],
          revalidateAuthority: () => Promise.resolve(),
        }),
        'placement-rejected',
      );
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('revalidates Project authority after queued Git admission before upload-pack starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-upload-pack-authorization-'));
    const marker = join(root, 'upload-pack.marker');
    const executable = await writeExecutable(
      root,
      'fake-git',
      `if [ "\${1-}" = "for-each-ref" ]; then
  exit 0
fi
printf upload-pack > '${marker}'`,
    );
    const accepted = placement('repository');
    await mkdir(repositoryPath(root, accepted), { recursive: true });
    const resourceAdmission = admission();
    const blocker = await resourceAdmission.acquireGitChild({
      classification: 'read',
      projectId: accepted.projectId,
    });
    const authority = new GitRepositoryAuthority({
      gitExecutable: executable,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    let revalidationCount = 0;
    try {
      const queued = authority.advertiseUploadPack(accepted, {
        expectedRefs: [],
        revalidateAuthority: () => {
          revalidationCount += 1;
          return Promise.reject(new Error('authorization-revoked'));
        },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(revalidationCount, 0);
      blocker.release();
      await assert.rejects(queued, /authorization-revoked/u);
      assert.equal(revalidationCount, 1);
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      blocker.release();
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('revalidates Project authority after the final placement check before spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-upload-pack-final-auth-'));
    const marker = join(root, 'upload-pack.marker');
    const executable = await writeExecutable(
      root,
      'fake-git',
      `if [ "\${1-}" = "for-each-ref" ]; then
  exit 0
fi
printf upload-pack > '${marker}'`,
    );
    const accepted = placement('repository');
    await mkdir(repositoryPath(root, accepted), { recursive: true });
    let authorized = true;
    let placementChecks = 0;
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: executable,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: {
        isCurrent: () => {
          placementChecks += 1;
          if (placementChecks === 3) authorized = false;
          return Promise.resolve(true);
        },
      },
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      await assert.rejects(authority.advertiseUploadPack(accepted, {
        expectedRefs: [],
        revalidateAuthority: () => authorized
          ? Promise.resolve()
          : Promise.reject(new Error('authorization-revoked')),
      }), /authorization-revoked/u);
      assert.equal(placementChecks >= 3, true);
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('preserves placement errors at the fence before integrity checking', async () => {
    for (const [lastValidation, expectedCode] of [
      [false, 'placement-rejected'],
      [new Error('private-placement-dependency'), 'placement-unavailable'],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), 'claudian-second-fence-'));
      const marker = join(root, 'fsck.marker');
      const executable = await writeExecutable(
        root,
        'fake-git',
        `printf fsck > '${marker}'`,
      );
      const accepted = placement('repository');
      await mkdir(repositoryPath(root, accepted), { recursive: true });
      const resourceAdmission = admission();
      const authority = new GitRepositoryAuthority({
        gitExecutable: executable,
        operationTimeoutMs: 2_000,
        outputMaxBytes: 4_096,
        placementValidator: new SequencedPlacementValidator([
          true,
          true,
          true,
          lastValidation,
        ]),
        repositoryRoot: root,
        resourceAdmission,
        storageNodeId: 'node-a',
      });
      try {
        await expectGitError(
          authority.verifyIntegrity(accepted),
          expectedCode,
          ['private-placement-dependency'],
        );
        await assert.rejects(access(marker), { code: 'ENOENT' });
      } finally {
        await authority.close();
        await resourceAdmission.close();
        await rm(root, { force: true, recursive: true });
      }
    }
  });

  it('binds admission and execution to one owned placement snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-placement-snapshot-'));
    const marker = join(root, 'repository.marker');
    const executable = await writeExecutable(
      root,
      'fake-git',
      `pwd > '${marker}'`,
    );
    const original = placement('repository_a', 'project-a');
    const replacement = createRepositoryPlacementLease({
      active: true,
      generation: 2,
      projectId: 'project-b',
      repositoryStorageKey: 'repository_b',
      storageNodeId: 'node-b',
    });
    await mkdir(repositoryPath(root, original), { recursive: true });
    await mkdir(repositoryPath(root, replacement), { recursive: true });
    const borrowed = { ...original };
    const observed: RepositoryPlacementLease[] = [];
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: executable,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: {
        isCurrent: async candidate => {
          observed.push({ ...candidate });
          await Promise.resolve();
          return true;
        },
      },
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      const verification = authority.verifyIntegrity(borrowed);
      borrowed.generation = replacement.generation;
      borrowed.projectId = replacement.projectId;
      borrowed.repositoryStorageKey = replacement.repositoryStorageKey;
      borrowed.storageNodeId = replacement.storageNodeId;

      assert.deepEqual(await verification, { status: 'valid' });
      assert.equal(
        (await readFile(marker, 'utf8')).trim(),
        await realpath(repositoryPath(root, original)),
      );
      assert.equal(observed.length > 0, true);
      assert.equal(
        observed.every(candidate => (
          candidate.generation === original.generation
          && candidate.projectId === original.projectId
          && candidate.repositoryStorageKey === original.repositoryStorageKey
          && candidate.storageNodeId === original.storageNodeId
        )),
        true,
      );
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects an unsupported Git version without exposing its output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-unsupported-git-'));
    const executable = await writeExecutable(
      root,
      'fake-git',
      'printf "git version 2.38.5 private-version-sentinel\\n"',
    );
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: executable,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      await expectGitError(
        authority.verifyCapability(),
        'unsupported-git',
        ['2.38.5', 'private-version-sentinel', root],
      );
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects an unavailable repository root before starting Git', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'claudian-missing-root-'));
    const repositoryRoot = join(parent, 'missing');
    const marker = join(parent, 'spawned.marker');
    const executable = await writeExecutable(
      parent,
      'fake-git',
      `printf spawned > '${marker}'\nprintf 'git version 2.39.0\\n'`,
    );
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: executable,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      await expectGitError(
        authority.verifyCapability(),
        'repository-unavailable',
        [parent],
      );
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(parent, { force: true, recursive: true });
    }
  });

  it('bounds duration and reaps a child that ignores termination', async () => {
    const fixture = await createFakeAuthority({
      executableBody: marker => (
        `printf '%s' "$$" > '${marker}'\ntrap '' TERM\nwhile :; do :; done`
      ),
      operationTimeoutMs: 30,
    });
    try {
      await expectGitError(
        fixture.authority.verifyIntegrity(fixture.repository),
        'timeout',
        [fixture.root],
      );
      await assertProcessGone(fixture.marker);
    } finally {
      await closeFakeAuthority(fixture);
    }
  });

  it('aborts and reaps an active Git child', async () => {
    const fixture = await createFakeAuthority({
      executableBody: marker => (
        `printf '%s' "$$" > '${marker}'\ntrap '' TERM\nwhile :; do :; done`
      ),
    });
    const cancellation = new AbortController();
    try {
      const verification = fixture.authority.verifyIntegrity(
        fixture.repository,
        { signal: cancellation.signal },
      );
      await waitForFile(fixture.marker);
      cancellation.abort();
      await expectGitError(verification, 'cancelled');
      await assertProcessGone(fixture.marker);
    } finally {
      await closeFakeAuthority(fixture);
    }
  });

  it('aborts and reaps the bare-repository inspection child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-bare-check-abort-'));
    const marker = join(root, 'process.marker');
    const executable = join(root, 'fake-git');
    await writeFile(
      executable,
      `#!/bin/sh
printf '%s' "$$" > '${marker}'
trap '' TERM
while :; do sleep 1; done
`,
    );
    await chmod(executable, 0o755);
    const repository = placement('repository');
    await mkdir(repositoryPath(root, repository), { recursive: true });
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: executable,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    const cancellation = new AbortController();
    try {
      const verification = authority.verifyIntegrity(repository, {
        signal: cancellation.signal,
      });
      await waitForFile(marker);
      cancellation.abort();
      await expectGitError(verification, 'cancelled');
      await assertProcessGone(marker);
    } finally {
      cancellation.abort();
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('reaps helper descendants in the owned Git process group', async () => {
    const fixture = await createFakeAuthority({
      executableBody: marker => `trap '' TERM
sh -c 'trap "" TERM; sleep 5' &
printf '%s %s' "$$" "$!" > '${marker}'
wait`,
      operationTimeoutMs: 30,
    });
    let pids: readonly number[] = [];
    try {
      const startedAt = Date.now();
      await expectGitError(
        fixture.authority.verifyIntegrity(fixture.repository),
        'timeout',
      );
      assert.equal(Date.now() - startedAt < 2_000, true);
      pids = await processIds(fixture.marker);
      assert.equal(pids.length, 2);
      assert.equal(pids.some(processExists), false);
    } finally {
      forceProcessCleanup(pids);
      await closeFakeAuthority(fixture);
    }
  });

  it('bounds unsafe output and sanitizes child failures', async () => {
    const output = await createFakeAuthority({
      executableBody: marker => (
        `printf '%s' "$$" > '${marker}'\ntrap '' TERM\nwhile :; do printf private-output-sentinel; done`
      ),
      outputMaxBytes: 128,
    });
    try {
      await expectGitError(
        output.authority.verifyIntegrity(output.repository),
        'output-limit',
        ['private-output-sentinel', output.root],
      );
      await assertProcessGone(output.marker);
    } finally {
      await closeFakeAuthority(output);
    }

    const failure = await createFakeAuthority({
      executableBody: marker => (
        `printf '%s' "$$" > '${marker}'\nprintf private-error-sentinel >&2\nexit 17`
      ),
    });
    try {
      await expectGitError(
        failure.authority.verifyIntegrity(failure.repository),
        'repository-corrupt',
        ['private-error-sentinel', failure.root],
      );
      await assertProcessGone(failure.marker);
    } finally {
      await closeFakeAuthority(failure);
    }
  });

  it('sanitizes spawn errors and unexpected process signals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-missing-git-'));
    const accepted = placement('repository');
    await mkdir(repositoryPath(root, accepted), { recursive: true });
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: join(root, 'missing-git'),
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    try {
      await expectGitError(
        authority.verifyIntegrity(accepted),
        'git-unavailable',
        [root],
      );
    } finally {
      await authority.close();
      await resourceAdmission.close();
      await rm(root, { force: true, recursive: true });
    }

    const signalled = await createFakeAuthority({
      executableBody: marker => (
        `printf '%s' "$$" > '${marker}'\nkill -TERM $$`
      ),
    });
    try {
      await expectGitError(
        signalled.authority.verifyIntegrity(signalled.repository),
        'process-failed',
      );
      await assertProcessGone(signalled.marker);
    } finally {
      await closeFakeAuthority(signalled);
    }
  });

  it('uses a fixed non-interactive environment and argument inventory', async () => {
    const fixture = await createFakeAuthority({
      executableBody: marker => `{
  printf 'HOME=%s\\n' "$HOME"
  printf 'GIT_CONFIG_NOSYSTEM=%s\\n' "$GIT_CONFIG_NOSYSTEM"
  printf 'GIT_TERMINAL_PROMPT=%s\\n' "$GIT_TERMINAL_PROMPT"
  printf 'LC_ALL=%s\\n' "$LC_ALL"
  printf 'PRIVATE_INHERITED=%s\\n' "\${PRIVATE_INHERITED_SENTINEL-unset}"
  printf 'ARGS=%s\\n' "$*"
} > '${marker}'`,
    });
    process.env.PRIVATE_INHERITED_SENTINEL = 'private-environment-sentinel';
    try {
      assert.deepEqual(
        await fixture.authority.verifyIntegrity(fixture.repository),
        { status: 'valid' },
      );
      assert.equal(
        await readFile(fixture.marker, 'utf8'),
        [
          'HOME=/nonexistent',
          'GIT_CONFIG_NOSYSTEM=1',
          'GIT_TERMINAL_PROMPT=0',
          'LC_ALL=C',
          'PRIVATE_INHERITED=unset',
          'ARGS=fsck --full --strict --no-dangling --no-progress',
          '',
        ].join('\n'),
      );
    } finally {
      delete process.env.PRIVATE_INHERITED_SENTINEL;
      await closeFakeAuthority(fixture);
    }
  });

  it('preserves unrelated Project progress under integrated saturation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-git-saturation-'));
    const marker = join(root, 'slow.marker');
    const executable = await writeExecutable(
      root,
      'fake-git',
      `case "$PWD" in
  */slow_a)
    printf '%s' "$$" > '${marker}'
    trap '' TERM
    while :; do :; done
    ;;
  *)
    exit 0
    ;;
esac`,
    );
    const projectA = placement('slow_a');
    const projectB = placement('fast_b', 'project-b');
    await mkdir(repositoryPath(root, projectA), { recursive: true });
    await mkdir(repositoryPath(root, projectB), { recursive: true });
    const resourceAdmission = admission();
    const authority = new GitRepositoryAuthority({
      gitExecutable: executable,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 4_096,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission,
      storageNodeId: 'node-a',
    });
    const activeCancellation = new AbortController();
    const queuedCancellation = new AbortController();
    try {
      const activeA = authority.verifyIntegrity(projectA, {
        signal: activeCancellation.signal,
      });
      await waitForFile(marker);
      const queuedA = authority.verifyIntegrity(projectA, {
        signal: queuedCancellation.signal,
      });

      assert.deepEqual(await authority.verifyIntegrity(projectB), {
        status: 'valid',
      });
      queuedCancellation.abort();
      await expectGitError(queuedA, 'cancelled');
      activeCancellation.abort();
      await expectGitError(activeA, 'cancelled');
      await assertProcessGone(marker);
    } finally {
      activeCancellation.abort();
      queuedCancellation.abort();
      await authority.close();
      await settleWithin(resourceAdmission.close());
      await rm(root, { force: true, recursive: true });
    }
  });

  it('closes idempotently, reaps children, and releases permits', async () => {
    const fixture = await createFakeAuthority({
      executableBody: marker => (
        `printf '%s' "$$" > '${marker}'\ntrap '' TERM\nwhile :; do :; done`
      ),
    });
    try {
      const verification = fixture.authority.verifyIntegrity(fixture.repository);
      await waitForFile(fixture.marker);
      const close = fixture.authority.close();
      assert.equal(fixture.authority.close(), close);
      await close;
      await expectGitError(verification, 'closed');
      await assertProcessGone(fixture.marker);
      await expectGitError(
        fixture.authority.verifyIntegrity(fixture.repository),
        'closed',
      );
      await settleWithin(fixture.resourceAdmission.close());
    } finally {
      await closeFakeAuthority(fixture);
    }
  });
});
