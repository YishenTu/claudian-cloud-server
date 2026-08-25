import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DurableTreeRemovalError,
  removeDurableOwnedTree,
} from '../../../src/repositories/DurableTreeRemoval.js';

const CLEANUP_KEY = 'a'.repeat(64);
const MARKER_JSON = '{"schemaVersion":1}\n';

describe('DurableTreeRemoval', () => {
  it('serializes duplicate removal before detaching one owned tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-tree-removal-'));
    const parentPath = join(root, 'parent');
    const targetPath = join(parentPath, 'target');
    const ownerMarker = join(targetPath, 'owner');
    let enterFirstRemoval: (() => void) | undefined;
    let releaseFirstRemoval: (() => void) | undefined;
    const firstRemovalEntered = new Promise<void>(resolve => {
      enterFirstRemoval = resolve;
    });
    const firstRemovalRelease = new Promise<void>(resolve => {
      releaseFirstRemoval = resolve;
    });
    let activeRemovals = 0;
    let maximumActiveRemovals = 0;
    let removalCount = 0;
    const input = {
      assertTargetOwned: async (): Promise<void> => {
        assert.equal(await readFile(ownerMarker, 'utf8'), 'owned\n');
      },
      cleanupKey: CLEANUP_KEY,
      markerJson: MARKER_JSON,
      parentPath,
      removeTree: async (path: string): Promise<void> => {
        removalCount += 1;
        activeRemovals += 1;
        maximumActiveRemovals = Math.max(
          maximumActiveRemovals,
          activeRemovals,
        );
        if (removalCount === 1) {
          enterFirstRemoval?.();
          await firstRemovalRelease;
        }
        await rm(path, { recursive: true });
        activeRemovals -= 1;
      },
      syncDirectory: (): Promise<void> => Promise.resolve(),
      targetPath,
    } as const;
    try {
      await mkdir(targetPath, { recursive: true });
      await writeFile(ownerMarker, 'owned\n');
      const first = removeDurableOwnedTree(input);
      await firstRemovalEntered;
      const second = removeDurableOwnedTree(input);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(removalCount, 1);
      releaseFirstRemoval?.();
      assert.deepEqual(await Promise.all([first, second]), [
        'removed',
        'replayed',
      ]);
      assert.equal(maximumActiveRemovals, 1);
    } finally {
      releaseFirstRemoval?.();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('classifies an inaccessible durable intent as unavailable storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-tree-intent-'));
    const parentPath = join(root, 'parent');
    const targetPath = join(parentPath, 'target');
    const ownerMarker = join(targetPath, 'owner');
    const intentMarker = join(
      parentPath,
      `.claudian-cloud-tree-cleanup-${CLEANUP_KEY}.json`,
    );
    let failRemoval = true;
    const input = {
      assertTargetOwned: async (): Promise<void> => {
        assert.equal(await readFile(ownerMarker, 'utf8'), 'owned\n');
      },
      cleanupKey: CLEANUP_KEY,
      markerJson: MARKER_JSON,
      parentPath,
      removeTree: async (path: string): Promise<void> => {
        if (failRemoval) {
          failRemoval = false;
          throw new Error('injected-removal-failure');
        }
        await rm(path, { recursive: true });
      },
      syncDirectory: (): Promise<void> => Promise.resolve(),
      targetPath,
    } as const;
    try {
      await mkdir(targetPath, { recursive: true });
      await writeFile(ownerMarker, 'owned\n');
      await assert.rejects(removeDurableOwnedTree(input), error => {
        assert.ok(error instanceof DurableTreeRemovalError);
        assert.equal(error.code, 'storage-unavailable');
        return true;
      });
      await chmod(intentMarker, 0o000);
      await assert.rejects(removeDurableOwnedTree(input), error => {
        assert.ok(error instanceof DurableTreeRemovalError);
        assert.equal(error.code, 'storage-unavailable');
        return true;
      });
      await chmod(intentMarker, 0o600);
      assert.equal(await removeDurableOwnedTree(input), 'removed');
    } finally {
      await chmod(intentMarker, 0o600).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  });
});
