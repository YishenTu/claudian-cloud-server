import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  createRepositoryPlacementLease,
  RepositoryPlacementError,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from '../../../src/repositories/RepositoryPlacement.js';
import { RepositoryPathPolicy } from '../../../src/repositories/RepositoryPathPolicy.js';

const execFileAsync = promisify(execFile);

class InMemoryPlacementValidator implements RepositoryPlacementValidator {
  #current: RepositoryPlacementLease;
  readonly #failure: boolean;

  constructor(current: RepositoryPlacementLease, failure = false) {
    this.#current = current;
    this.#failure = failure;
  }

  replace(current: RepositoryPlacementLease): void {
    this.#current = current;
  }

  async isCurrent(placement: RepositoryPlacementLease): Promise<boolean> {
    await Promise.resolve();
    if (this.#failure) throw new Error('database-secret-sentinel');
    return placement.projectId === this.#current.projectId
      && placement.storageNodeId === this.#current.storageNodeId
      && placement.repositoryStorageKey === this.#current.repositoryStorageKey
      && placement.generation === this.#current.generation;
  }
}

function placement(
  overrides: Partial<{
    active: boolean;
    generation: number;
    projectId: string;
    repositoryStorageKey: string;
    storageNodeId: string;
  }> = {},
): RepositoryPlacementLease {
  return createRepositoryPlacementLease({
    active: true,
    generation: 1,
    projectId: 'project-a',
    repositoryStorageKey: 'opaque_storage_key_a',
    storageNodeId: 'node-a',
    ...overrides,
  });
}

function projectNamespacePath(
  root: string,
  accepted: RepositoryPlacementLease,
): string {
  return join(root, Buffer.from(accepted.projectId, 'utf8').toString('hex'));
}

function repositoryPath(
  root: string,
  accepted: RepositoryPlacementLease,
): string {
  return join(
    projectNamespacePath(root, accepted),
    accepted.repositoryStorageKey,
  );
}

async function expectPlacementError(
  operation: Promise<unknown> | (() => unknown),
  code: RepositoryPlacementError['code'],
): Promise<void> {
  const verify = (error: unknown): boolean => {
    assert.ok(error instanceof RepositoryPlacementError);
    assert.equal(error.code, code);
    assert.deepEqual(error.toJSON(), {
      code,
      message: `repository-placement.error.${code}`,
      name: 'RepositoryPlacementError',
    });
    return true;
  };
  if (typeof operation === 'function') assert.throws(operation, verify);
  else await assert.rejects(operation, verify);
}

describe('repository placement', () => {
  it('creates one immutable active placement vocabulary', async () => {
    const accepted = placement();
    assert.equal(Object.isFrozen(accepted), true);
    assert.deepEqual(accepted, {
      active: true,
      generation: 1,
      projectId: 'project-a',
      repositoryStorageKey: 'opaque_storage_key_a',
      storageNodeId: 'node-a',
    });

    for (const [input, code] of [
      [{ projectId: '../project' }, 'invalid-placement'],
      [{ storageNodeId: 'node/a' }, 'invalid-placement'],
      [{ repositoryStorageKey: '../repository' }, 'invalid-placement'],
      [{ repositoryStorageKey: '/absolute' }, 'invalid-placement'],
      [{ repositoryStorageKey: 'key.with-dot' }, 'invalid-placement'],
      [{ repositoryStorageKey: 'Storage_A' }, 'invalid-placement'],
      [{ generation: 0 }, 'invalid-placement'],
      [{ generation: Number.MAX_SAFE_INTEGER + 1 }, 'invalid-placement'],
      [{ active: false }, 'inactive-placement'],
    ] as const) {
      await expectPlacementError(
        () => placement(input),
        code,
      );
    }
  });

  it('rejects a case-variant key that aliases on a case-insensitive filesystem', async t => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-case-alias-'));
    const lowercasePath = join(root, 'storage_a');
    const uppercasePath = join(root, 'Storage_A');
    try {
      await mkdir(lowercasePath);
      let lowercase;
      let uppercase;
      try {
        [lowercase, uppercase] = await Promise.all([
          lstat(lowercasePath, { bigint: true }),
          lstat(uppercasePath, { bigint: true }),
        ]);
      } catch (error: unknown) {
        if (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'ENOENT'
        ) {
          t.skip('filesystem is case-sensitive');
          return;
        }
        throw error;
      }
      assert.equal(lowercase.dev, uppercase.dev);
      assert.equal(lowercase.ino, uppercase.ino);
      await expectPlacementError(
        () => placement({ repositoryStorageKey: 'Storage_A' }),
        'invalid-placement',
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('resolves only a current contained repository on the local node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-repositories-'));
    const replacedRoot = `${root}-replaced`;
    try {
      const accepted = placement();
      const validator = new InMemoryPlacementValidator(accepted);
      const policy = new RepositoryPathPolicy({
        placementValidator: validator,
        repositoryRoot: root,
        storageNodeId: 'node-a',
      });
      const acceptedRepositoryPath = repositoryPath(root, accepted);
      await execFileAsync('/usr/bin/git', [
        'init',
        '--bare',
        acceptedRepositoryPath,
      ]);

      const resolved = await policy.resolveExisting(accepted);
      assert.equal(
        resolved.repositoryPath,
        join(root, '70726f6a6563742d61', 'opaque_storage_key_a'),
      );
      assert.equal(resolved.placement, accepted);
      assert.equal(Object.isFrozen(resolved), true);

      await expectPlacementError(
        policy.resolveExisting(placement({ storageNodeId: 'node-b' })),
        'wrong-storage-node',
      );

      const stale = accepted;
      validator.replace(placement({ generation: 2 }));
      await expectPlacementError(
        policy.resolveExisting(stale),
        'stale-placement',
      );

      validator.replace(accepted);
      await rename(root, replacedRoot);
      await mkdir(root);
      await execFileAsync('/usr/bin/git', [
        'init',
        '--bare',
        acceptedRepositoryPath,
      ]);
      await expectPlacementError(
        policy.resolveExisting(accepted),
        'repository-root-unavailable',
      );
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(replacedRoot, { force: true, recursive: true });
    }
  });

  it('fails closed for missing, changed, inaccessible, or escaping paths', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'claudian-path-policy-'));
    const outside = await mkdtemp(join(tmpdir(), 'claudian-outside-'));
    const root = join(fixtureRoot, 'repositories');
    const accepted = placement();
    const validator = new InMemoryPlacementValidator(accepted);

    try {
      await expectPlacementError(
        new RepositoryPathPolicy({
          placementValidator: validator,
          repositoryRoot: join(fixtureRoot, 'missing'),
          storageNodeId: 'node-a',
        }).resolveExisting(accepted),
        'repository-root-unavailable',
      );

      await writeFile(root, 'not-a-directory');
      await expectPlacementError(
        new RepositoryPathPolicy({
          placementValidator: validator,
          repositoryRoot: root,
          storageNodeId: 'node-a',
        }).resolveExisting(accepted),
        'repository-root-unavailable',
      );
      await rm(root);

      await symlink(outside, root);
      await expectPlacementError(
        new RepositoryPathPolicy({
          placementValidator: validator,
          repositoryRoot: root,
          storageNodeId: 'node-a',
        }).resolveExisting(accepted),
        'repository-root-unavailable',
      );
      await rm(root);

      await mkdir(root);
      await expectPlacementError(
        new RepositoryPathPolicy({
          placementValidator: validator,
          repositoryRoot: root,
          storageNodeId: 'node-a',
        }).resolveExisting(accepted),
        'repository-not-found',
      );

      const acceptedRepositoryPath = repositoryPath(root, accepted);
      await mkdir(projectNamespacePath(root, accepted));
      await writeFile(acceptedRepositoryPath, 'not-a-directory');
      await expectPlacementError(
        new RepositoryPathPolicy({
          placementValidator: validator,
          repositoryRoot: root,
          storageNodeId: 'node-a',
        }).resolveExisting(accepted),
        'repository-path-invalid',
      );
      await rm(acceptedRepositoryPath);

      await symlink(outside, acceptedRepositoryPath);
      await expectPlacementError(
        new RepositoryPathPolicy({
          placementValidator: validator,
          repositoryRoot: root,
          storageNodeId: 'node-a',
        }).resolveExisting(accepted),
        'repository-path-invalid',
      );
      await rm(acceptedRepositoryPath);

      await mkdir(acceptedRepositoryPath);
      await chmod(root, 0o000);
      await expectPlacementError(
        new RepositoryPathPolicy({
          placementValidator: validator,
          repositoryRoot: root,
          storageNodeId: 'node-a',
        }).resolveExisting(accepted),
        'repository-root-unavailable',
      );
      await chmod(root, 0o700);
    } finally {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(fixtureRoot, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it('isolates the same storage key in distinct Project namespaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-project-paths-'));
    const projectA = placement({ repositoryStorageKey: 'shared_storage' });
    const projectB = placement({
      projectId: 'project-b',
      repositoryStorageKey: 'shared_storage',
    });
    const policy = new RepositoryPathPolicy({
      placementValidator: {
        isCurrent: async () => Promise.resolve(true),
      },
      repositoryRoot: root,
      storageNodeId: 'node-a',
    });
    try {
      await Promise.all([
        mkdir(repositoryPath(root, projectA), { recursive: true }),
        mkdir(repositoryPath(root, projectB), { recursive: true }),
      ]);
      const [resolvedA, resolvedB] = await Promise.all([
        policy.resolveExisting(projectA),
        policy.resolveExisting(projectB),
      ]);

      assert.equal(
        resolvedA.repositoryPath,
        join(root, '70726f6a6563742d61', 'shared_storage'),
      );
      assert.equal(
        resolvedB.repositoryPath,
        join(root, '70726f6a6563742d62', 'shared_storage'),
      );
      assert.notEqual(resolvedA.repositoryPath, resolvedB.repositoryPath);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('sanitizes placement dependency and path failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'private-root-sentinel-'));
    const accepted = placement();
    try {
      const failure = new RepositoryPathPolicy({
        placementValidator: new InMemoryPlacementValidator(accepted, true),
        repositoryRoot: root,
        storageNodeId: 'node-a',
      }).resolveExisting(accepted);
      await expectPlacementError(failure, 'placement-unavailable');
      await assert.rejects(failure, error => {
        assert.doesNotMatch(JSON.stringify(error), /private-root|database-secret/);
        return true;
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
