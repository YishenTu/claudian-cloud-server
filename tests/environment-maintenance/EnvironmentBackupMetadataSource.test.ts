import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EnvironmentBackupMetadataSource,
} from '../../src/environment-maintenance/commands/EnvironmentBackupMetadataSource.js';

describe('EnvironmentBackupMetadataSource', () => {
  it('uses the paired native authority identity for an original environment', async () => {
    const source = new EnvironmentBackupMetadataSource({
      state: {
        inspect: () => Promise.resolve({
          journal: undefined,
          pair: { authorityVolumeId: '1'.repeat(32) },
        }),
      },
    });
    assert.deepEqual(await source.read(), {
      authorityId: '1'.repeat(32),
      authorityVolumeIdentity: '1'.repeat(32),
      restoreEpoch: 1,
    });
  });

  it('preserves restored authority lineage only from a completed exact journal', async () => {
    const source = new EnvironmentBackupMetadataSource({
      state: {
        inspect: () => Promise.resolve({
          journal: {
            authorityId: 'source-authority',
            authorityVolumeId: '2'.repeat(32),
            authorityVolumeIdentity: 'restored-volume',
            phase: 'completed',
            restoreEpoch: 4,
          },
          pair: { authorityVolumeId: '2'.repeat(32) },
        }),
      },
    });
    assert.deepEqual(await source.read(), {
      authorityId: 'source-authority',
      authorityVolumeIdentity: 'restored-volume',
      restoreEpoch: 4,
    });
  });

  it('rejects absent, ambiguous, or incomplete authority state', async () => {
    for (const inspection of [
      { journal: undefined, pair: 'absent' },
      { journal: undefined, pair: 'ambiguous' },
      {
        journal: {
          authorityId: 'source-authority',
          authorityVolumeId: '2'.repeat(32),
          authorityVolumeIdentity: 'restored-volume',
          phase: 'verified',
          restoreEpoch: 4,
        },
        pair: { authorityVolumeId: '2'.repeat(32) },
      },
    ] as const) {
      const source = new EnvironmentBackupMetadataSource({
        state: { inspect: () => Promise.resolve(inspection) },
      });
      await assert.rejects(
        source.read(),
        /environment-backup-metadata\.error\.unavailable/u,
      );
    }
  });
});
