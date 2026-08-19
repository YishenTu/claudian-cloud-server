import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reportBootstrapFailure } from '../../src/observability/BootstrapReporter.js';
import { SafeLogger } from '../../src/observability/SafeLogger.js';

describe('SafeLogger', () => {
  it('serializes only allowlisted operational context', () => {
    const lines: string[] = [];
    const logger = new SafeLogger({
      now: () => new Date('2026-08-19T00:00:00.000Z'),
      write: line => lines.push(line),
    });

    logger.info('server.listening', {
      credential: 'private-vps-password',
      path: '/srv/private/project.git',
      port: 8787,
      profile: 'private-development',
      reason: new Error('raw startup failure'),
    });

    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.ok(line);
    assert.deepEqual(JSON.parse(line), {
      context: {
        port: 8787,
        profile: 'private-development',
      },
      event: 'server.listening',
      level: 'info',
      timestamp: '2026-08-19T00:00:00.000Z',
    });
    assert.equal(line.includes('private-vps-password'), false);
    assert.equal(line.includes('/srv/private'), false);
    assert.equal(line.includes('raw startup failure'), false);
  });

  it('reports pre-logger bootstrap failure without exception context', () => {
    const lines: string[] = [];

    reportBootstrapFailure(line => lines.push(line));

    assert.deepEqual(lines, ['claudian-cloud-server bootstrap failure\n']);
  });
});
