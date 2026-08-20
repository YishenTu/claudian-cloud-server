import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it } from 'node:test';

import { HttpServer } from '../../../src/server/HttpServer.js';

describe('application lifecycle', () => {
  it('publishes only the configured health state and closes repeatedly', async () => {
    let ready = false;
    const server = new HttpServer({
      config: Object.freeze({
        host: '127.0.0.1',
        port: 0,
      }),
      isReady: () => ready,
    });
    const address = await server.start();
    const origin = `http://${address.host}:${String(address.port)}`;

    const liveResponse = await fetch(`${origin}/livez`);
    assert.equal(liveResponse.status, 200);
    assert.deepEqual(await liveResponse.json(), { status: 'alive' });

    const unavailable = await fetch(`${origin}/readyz`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: 'not-ready' });

    ready = true;
    const available = await fetch(`${origin}/readyz`);
    assert.equal(available.status, 200);
    assert.deepEqual(await available.json(), { status: 'ready' });

    for (const path of [
      '/control/private-sentinel',
      '/events/private-sentinel',
      '/git/private-sentinel',
      '/projects/private-sentinel',
      '/versionz',
    ]) {
      const missing = await fetch(`${origin}${path}`);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { status: 'not-found' });
    }

    await server.close(1_000);
    await server.close(1_000);

    await assert.rejects(fetch(`${origin}/livez`));
  });

  it('closes a listener when shutdown races the listening event', async () => {
    const probe = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      [
        'import { HttpServer } from "./src/server/HttpServer.ts";',
        'const server = new HttpServer({',
        '  config: { host: "127.0.0.1", port: 0 },',
        '  isReady: () => false,',
        '});',
        'const starting = server.start();',
        'const closing = server.close(100);',
        'let address;',
        'try { address = await starting; } catch {}',
        'await closing;',
        'let reachable = false;',
        'if (address !== undefined) try {',
        '  const response = await fetch(',
        '    "http://" + address.host + ":" + String(address.port) + "/livez",',
        '  );',
        '  reachable = response.status === 200;',
        '} catch {}',
        'process.exit(reachable ? 17 : 0);',
      ].join('\n'),
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr: string[] = [];
    probe.stderr.setEncoding('utf8');
    probe.stderr.on('data', chunk => stderr.push(String(chunk)));

    const [exitCode, signal] = await once(probe, 'exit') as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.equal(exitCode, 0);
    assert.equal(signal, null);
    assert.equal(stderr.join(''), '');
  });
});
