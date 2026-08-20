import assert from 'node:assert/strict';
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

    const missing = await fetch(`${origin}/projects/private-sentinel`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { status: 'not-found' });

    await server.close(1_000);
    await server.close(1_000);

    await assert.rejects(fetch(`${origin}/livez`));
  });
});
