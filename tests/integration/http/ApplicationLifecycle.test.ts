import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApplication } from '../../../src/composition/createApplication.js';
import type { ServerConfig } from '../../../src/config/ServerConfig.js';
import { SafeLogger } from '../../../src/observability/SafeLogger.js';

const config: ServerConfig = Object.freeze({
  gitAdmission: Object.freeze({
    maxChildren: 2,
    maxChildrenPerProject: 1,
    queueMax: 6,
    queueMaxPerProject: 4,
    queueTimeoutMs: 10_000,
  }),
  http: Object.freeze({
    host: '127.0.0.1',
    port: 0,
  }),
  postgres: Object.freeze({
    ordinaryPoolMax: 8,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 2,
    url: 'postgresql://runtime:test@127.0.0.1/cloud-test',
  }),
  repository: Object.freeze({
    gitExecutable: '/usr/bin/git',
    operationTimeoutMs: 300_000,
    outputMaxBytes: 1_048_576,
    root: '/tmp/claudian-cloud-test-repositories',
    storageNodeId: 'test-node',
  }),
  shutdownTimeoutMs: 1_000,
});

describe('application lifecycle', () => {
  it('serves health after startup and releases the listener on repeated close', async () => {
    const logLines: string[] = [];
    const logger = new SafeLogger({
      now: () => new Date('2026-08-19T00:00:00.000Z'),
      write: line => logLines.push(line),
    });
    const application = createApplication({ config, logger });

    const address = await application.start();
    const origin = `http://${address.host}:${String(address.port)}`;

    const liveResponse = await fetch(`${origin}/livez`);
    assert.equal(liveResponse.status, 200);
    assert.deepEqual(await liveResponse.json(), { status: 'alive' });

    const readyResponse = await fetch(`${origin}/readyz`);
    assert.equal(readyResponse.status, 200);
    assert.deepEqual(await readyResponse.json(), { status: 'ready' });

    await application.close();
    await application.close();

    await assert.rejects(fetch(`${origin}/livez`));
    assert.deepEqual(
      logLines.map(parseLogEvent),
      [
        'server.starting',
        'server.listening',
        'server.stopping',
        'server.stopped',
      ],
    );
  });
});

function parseLogEvent(line: string): string {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== 'object'
    || value === null
    || !('event' in value)
    || typeof value.event !== 'string'
  ) {
    throw new TypeError('Expected a safe log event');
  }
  return value.event;
}
