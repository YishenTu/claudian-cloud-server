import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it } from 'node:test';

describe('main process', () => {
  it('reports an unavailable startup dependency without leaking context', async () => {
    const credential = 'main-process-secret-sentinel';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
        CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
        CLAUDIAN_CLOUD_PORT: '49152',
        CLAUDIAN_CLOUD_POSTGRES_URL: `postgresql://runtime:${credential}@127.0.0.1:1/cloud-test`,
        CLAUDIAN_CLOUD_REPOSITORY_ROOT: '/tmp/claudian-cloud-test-repositories',
        CLAUDIAN_CLOUD_STAGING_ROOT: '/tmp/claudian-cloud-test-staging',
        CLAUDIAN_CLOUD_STORAGE_NODE_ID: 'test-node',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout.push(String(chunk)));
    child.stderr.on('data', chunk => stderr.push(String(chunk)));

    const [exitCode, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];

    assert.equal(exitCode, 1);
    assert.equal(signal, null);
    assert.equal(stderr.join(''), '');
    const output = stdout.join('');
    assert.deepEqual(parseEvents(stdout), [
      'server.starting',
      'server.startup-failed',
    ]);
    assert.doesNotMatch(output, new RegExp(credential));
    assert.doesNotMatch(output, /postgresql:|ECONNREFUSED|127\.0\.0\.1/);
  });
});

function parseEvents(chunks: readonly string[]): string[] {
  return chunks.join('')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => (JSON.parse(line) as { event: string }).event);
}
