import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const image = `ghcr.io/yishentu/claudian-cloud-server@sha256:${'a'.repeat(64)}`;
const revision = 'b'.repeat(40);

describe('Release installation archive', () => {
  it('ships the shared Compose deployment pinned to the published image without source or credentials', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'claudian-release-'));
    const output = join(temporary, 'artifacts');
    try {
      const packaged = spawnSync(process.execPath, [
        resolve(root, 'scripts/packageRelease.ts'), image, revision, output,
      ], { encoding: 'utf8' });
      assert.equal(packaged.status, 0, packaged.stderr);
      const archive = join(output, 'claudian-cloud-server.tar.gz');
      execFileSync('tar', ['-xzf', archive, '-C', temporary]);
      const bundle = join(temporary, 'claudian-cloud-server');
      assert.equal(await readFile(join(bundle, 'release.env'), 'utf8'), `CLAUDIAN_CLOUD_IMAGE=${image}\n`);
      assert.equal(await readFile(join(bundle, 'revision.txt'), 'utf8'), `${revision}\n`);
      assert.equal(await readFile(join(bundle, 'deploy/compose.yaml'), 'utf8'),
        await readFile(join(root, 'deploy/compose.yaml'), 'utf8'));
      const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
      assert.match(entries, /deploy\/configure\.sh/u);
      assert.match(entries, /deploy\/initializeConfig\.ts/u);
      assert.match(entries, /deploy\/bootstrap-postgres\.sh/u);
      assert.doesNotMatch(entries, /(?:node_modules|\.git\/|src\/|server\.env|keyring\.json)/u);
      const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
      assert.equal(await readFile(`${archive}.sha256`, 'utf8'),
        `${checksum}  claudian-cloud-server.tar.gz\n`);

      const rendered = JSON.parse(execFileSync('docker', [
        'compose', '--file', join(bundle, 'deploy/compose.yaml'),
        '--profile', '*', 'config', '--format', 'json',
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDIAN_CLOUD_IMAGE: image,
          CLAUDIAN_CLOUD_ENV_FILE: resolve(root, '.env.example'),
          CLAUDIAN_CLOUD_BOOTSTRAP_ENV_FILE: resolve(root, '.env.bootstrap.example'),
          CLAUDIAN_CLOUD_MIGRATION_ENV_FILE: resolve(root, '.env.migration.example'),
          CLAUDIAN_CLOUD_POSTGRES_ENV_FILE: resolve(root, '.env.postgres.example'),
        },
      })) as { services: Record<string, { image: string; network_mode: string; ports?: unknown }> };
      for (const name of ['cloud-server', 'cloud-migration', 'cloud-restore-recovery', 'cloud-project-recovery']) {
        const service = rendered.services[name];
        assert.ok(service);
        assert.equal(service.image, image);
        assert.equal(service.network_mode, 'host');
        assert.equal(service.ports, undefined);
      }
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  it('rejects a mutable image tag instead of packaging an unpinned installation', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'claudian-release-invalid-'));
    try {
      const packaged = spawnSync(process.execPath, [
        resolve(root, 'scripts/packageRelease.ts'),
        'ghcr.io/yishentu/claudian-cloud-server:latest', revision, join(temporary, 'artifacts'),
      ], { encoding: 'utf8' });
      assert.equal(packaged.status, 1);
      assert.equal(packaged.stderr, 'release.error: invalid-input\n');
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });
});
