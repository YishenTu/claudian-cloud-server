import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  EnvironmentRestoreRepositoryInspection,
  RepositoryRestoreInspectionError,
} from '../../../src/repositories/EnvironmentRestoreRepositoryInspection.js';

const roots: string[] = [];

async function fixture(): Promise<Readonly<{
  authorityRoot: string;
  inspection: EnvironmentRestoreRepositoryInspection;
  repositoryRoot: string;
  stagingRoot: string;
}>> {
  const authorityRoot = await mkdtemp(
    join(tmpdir(), 'claudian-restore-inspection-'),
  );
  roots.push(authorityRoot);
  const repositoryRoot = join(authorityRoot, 'repositories');
  const stagingRoot = join(authorityRoot, 'staging');
  await Promise.all([
    mkdir(repositoryRoot, { mode: 0o700 }),
    mkdir(stagingRoot, { mode: 0o700 }),
  ]);
  return Object.freeze({
    authorityRoot,
    inspection: new EnvironmentRestoreRepositoryInspection({
      repositoryRoot,
      stagingRoot,
    }),
    repositoryRoot,
    stagingRoot,
  });
}

function assertCode(
  expected: RepositoryRestoreInspectionError['code'],
): (error: unknown) => boolean {
  return error => {
    assert.equal(error instanceof RepositoryRestoreInspectionError, true);
    assert.equal((error as RepositoryRestoreInspectionError).code, expected);
    return true;
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { force: true, recursive: true })
  ));
});

describe('EnvironmentRestoreRepositoryInspection', () => {
  it('accepts exact empty private sibling repository roots', async () => {
    const { inspection } = await fixture();

    await inspection.assertEmpty(new AbortController().signal);
  });

  it('rejects canonical repositories and restore staging with any entry', async () => {
    for (const selected of ['repository', 'staging'] as const) {
      const current = await fixture();
      const root = selected === 'repository'
        ? current.repositoryRoot
        : current.stagingRoot;
      await writeFile(join(root, '.unexpected-private-state'), 'sentinel');

      await assert.rejects(
        current.inspection.assertEmpty(new AbortController().signal),
        assertCode('not-empty'),
      );
    }
  });

  it('rejects missing, replaced, symlinked, or non-private roots', async () => {
    const missing = await fixture();
    await rm(missing.repositoryRoot, { recursive: true });
    await assert.rejects(
      missing.inspection.assertEmpty(new AbortController().signal),
      assertCode('storage-unavailable'),
    );

    const linked = await fixture();
    const moved = join(linked.authorityRoot, 'moved-repositories');
    await rm(linked.repositoryRoot, { recursive: true });
    await mkdir(moved, { mode: 0o700 });
    await symlink(moved, linked.repositoryRoot, 'dir');
    await assert.rejects(
      linked.inspection.assertEmpty(new AbortController().signal),
      assertCode('storage-unavailable'),
    );

    const publicRoot = await fixture();
    await chmod(publicRoot.stagingRoot, 0o755);
    await assert.rejects(
      publicRoot.inspection.assertEmpty(new AbortController().signal),
      assertCode('storage-unavailable'),
    );
  });

  it('pins the physical root pair after its first successful inspection', async () => {
    const current = await fixture();
    await current.inspection.assertEmpty(new AbortController().signal);
    await rename(
      current.repositoryRoot,
      join(current.authorityRoot, 'replaced-repositories'),
    );
    await mkdir(current.repositoryRoot, { mode: 0o700 });

    await assert.rejects(
      current.inspection.assertEmpty(new AbortController().signal),
      assertCode('storage-unavailable'),
    );
  });

  it('rejects invalid root topology before inspecting the filesystem', () => {
    assert.throws(
      () => new EnvironmentRestoreRepositoryInspection({
        repositoryRoot: '/tmp/claudian-a/repositories',
        stagingRoot: '/tmp/claudian-b/staging',
      }),
      /environment-restore-repository-inspection\.options-invalid/u,
    );
    assert.throws(
      () => new EnvironmentRestoreRepositoryInspection({
        repositoryRoot: '/tmp/claudian-a/repositories',
        stagingRoot: '/tmp/claudian-a/repositories',
      }),
      /environment-restore-repository-inspection\.options-invalid/u,
    );
  });

  it('rejects sibling path strings that alias one physical directory', async t => {
    const current = await fixture();
    const caseVariant = join(current.authorityRoot, 'REPOSITORIES');
    let canonical;
    let alias;
    try {
      [canonical, alias] = await Promise.all([
        lstat(current.repositoryRoot, { bigint: true }),
        lstat(caseVariant, { bigint: true }),
      ]);
    } catch {
      t.skip('filesystem is case-sensitive');
      return;
    }
    if (canonical.dev !== alias.dev || canonical.ino !== alias.ino) {
      t.skip('case variant does not alias the canonical root');
      return;
    }
    const inspection = new EnvironmentRestoreRepositoryInspection({
      repositoryRoot: current.repositoryRoot,
      stagingRoot: caseVariant,
    });

    await assert.rejects(
      inspection.assertEmpty(new AbortController().signal),
      assertCode('storage-unavailable'),
    );
  });

  it('rejects a trailing separator that would follow a directory symlink', async () => {
    const current = await fixture();
    const moved = join(current.authorityRoot, 'symlink-target');
    await rm(current.repositoryRoot, { recursive: true });
    await mkdir(moved, { mode: 0o700 });
    await symlink(moved, current.repositoryRoot, 'dir');

    assert.throws(
      () => new EnvironmentRestoreRepositoryInspection({
        repositoryRoot: `${current.repositoryRoot}/`,
        stagingRoot: current.stagingRoot,
      }),
      /environment-restore-repository-inspection\.options-invalid/u,
    );
  });

  it('reports cancellation without leaking root paths', async () => {
    const current = await fixture();
    const controller = new AbortController();
    controller.abort('operator-cancelled');

    const outcome = await current.inspection.assertEmpty(controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (!(outcome instanceof RepositoryRestoreInspectionError)) {
      assert.fail('expected RepositoryRestoreInspectionError');
    }
    assert.equal(outcome.code, 'cancelled');
    assert.doesNotMatch(JSON.stringify(outcome), /claudian-restore-inspection/u);
  });
});
