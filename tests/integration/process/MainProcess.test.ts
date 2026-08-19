import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';

describe('main process', () => {
  it('starts from environment configuration and shuts down on SIGTERM', async () => {
    const port = await findAvailablePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
        CLAUDIAN_CLOUD_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout.push(String(chunk)));
    child.stderr.on('data', chunk => stderr.push(String(chunk)));

    try {
      await waitForEvent(stdout, 'server.listening');
      child.kill('SIGTERM');
      const [exitCode, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];

      assert.equal(exitCode, 0);
      assert.equal(signal, null);
      assert.equal(stderr.join(''), '');
      assert.deepEqual(parseEvents(stdout), [
        'server.starting',
        'server.listening',
        'server.stopping',
        'server.stopped',
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server address unavailable');
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

async function waitForEvent(lines: readonly string[], event: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (parseEvents(lines).includes(event)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${event}`);
}

function parseEvents(chunks: readonly string[]): string[] {
  return chunks.join('')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => (JSON.parse(line) as { event: string }).event);
}
