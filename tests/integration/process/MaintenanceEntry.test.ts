import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

function run(
  arguments_: readonly string[],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [
    '--import',
    'tsx',
    'src/main.ts',
    ...arguments_,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
}

describe('compiled maintenance entry', () => {
  it('routes the migration target probe without constructing the server', () => {
    const result = run(['maintenance', 'migration', 'target']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^[1-9][0-9]*\n$/u);
    assert.equal(result.stderr, '');
  });

  it('reports unknown maintenance input through the sanitized bootstrap reporter', () => {
    const secret = 'private-operator-argument';
    const result = run(['maintenance', 'unknown-command', secret]);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /claudian-cloud-server bootstrap failure/u);
    assert.doesNotMatch(result.stderr, new RegExp(secret, 'u'));
  });

  it('treats an ordinary paired authority without a restore journal as recovered', () => {
    const authorityRoot = mkdtempSync(join(tmpdir(), 'claudian-recovery-gate-'));
    const repositoryRoot = join(authorityRoot, 'repositories');
    const stagingRoot = join(authorityRoot, 'staging');
    mkdirSync(repositoryRoot, { mode: 0o700 });
    mkdirSync(stagingRoot, { mode: 0o700 });
    writeFileSync(
      join(authorityRoot, '.authority-volume-id'),
      `${'1'.repeat(32)}\n`,
      { mode: 0o600 },
    );
    try {
      const result = run(['maintenance', 'recover-restore'], {
        CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
        CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
        CLAUDIAN_CLOUD_PORT: '8787',
        CLAUDIAN_CLOUD_POSTGRES_URL:
          'postgresql://runtime:password@127.0.0.1:5432/claudian_cloud',
        CLAUDIAN_CLOUD_REPOSITORY_ROOT: repositoryRoot,
        CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED: 'true',
        CLAUDIAN_CLOUD_STAGING_ROOT: stagingRoot,
        CLAUDIAN_CLOUD_STORAGE_NODE_ID: 'test-node',
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    } finally {
      rmSync(authorityRoot, { force: true, recursive: true });
    }
  });
});
