import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
  readonly #results: boolean[];

  constructor(results: readonly boolean[]) {
    this.#results = [...results];
  }

  async isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    await Promise.resolve();
    return this.#results.shift() ?? false;
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

function admission(): ResourceAdmission {
  return new ResourceAdmission({
    maxChildren: 2,
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
  await mkdir(join(root, repository.repositoryStorageKey));
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
        join(root, accepted.repositoryStorageKey),
      ]);

      assert.deepEqual(await authority.verifyCapability(), {
        status: 'supported',
      });
      assert.deepEqual(await authority.verifyIntegrity(accepted), {
        status: 'valid',
      });

      const corrupt = placement('corrupt_bare');
      const corruptPath = join(root, corrupt.repositoryStorageKey);
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
        join(root, nonBare.repositoryStorageKey),
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

  it('revalidates placement immediately before starting Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-revalidation-'));
    const marker = join(root, 'spawned.marker');
    const executable = await writeExecutable(
      root,
      'fake-git',
      `printf spawned > '${marker}'`,
    );
    const accepted = placement('repository');
    await mkdir(join(root, accepted.repositoryStorageKey));
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
    await mkdir(join(root, accepted.repositoryStorageKey));
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
          'ARGS=fsck --full --strict --no-progress',
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
    await mkdir(join(root, projectA.repositoryStorageKey));
    await mkdir(join(root, projectB.repositoryStorageKey));
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
