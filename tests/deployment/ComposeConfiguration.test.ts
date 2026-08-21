import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

interface RenderedCompose {
  readonly services: Readonly<Record<string, {
    readonly environment?: Readonly<Record<string, string>>;
    readonly healthcheck?: {
      readonly test?: readonly string[];
    };
  }>>;
}

const repositoryRoot = resolve(import.meta.dirname, '../..');
const composeFile = resolve(repositoryRoot, 'deploy/compose.yaml');

function renderCompose(environmentFile: string): RenderedCompose {
  const rendered = execFileSync(
    'docker',
    ['compose', '--file', composeFile, 'config', '--format', 'json'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDIAN_CLOUD_ENV_FILE: environmentFile,
        CLAUDIAN_CLOUD_POSTGRES_ENV_FILE: resolve(
          repositoryRoot,
          '.env.postgres.example',
        ),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(rendered) as RenderedCompose;
}

describe('Compose configuration', () => {
  it('derives the health probe port from runtime configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-compose-'));
    const environmentFile = join(root, 'server.env');
    await writeFile(
      environmentFile,
      [
        'CLAUDIAN_CLOUD_BIND_HOST=127.0.0.1',
        'CLAUDIAN_CLOUD_PORT=49152',
        '',
      ].join('\n'),
    );

    try {
      const model = renderCompose(environmentFile);
      const service = model.services['cloud-server'];
      const probe = service?.healthcheck?.test;

      assert.equal(service?.environment?.CLAUDIAN_CLOUD_PORT, '49152');
      assert.ok(probe);
      const command = probe.join(' ');
      assert.match(command, /process\.env\.CLAUDIAN_CLOUD_PORT/);
      assert.doesNotMatch(command, /127\.0\.0\.1:8787/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
