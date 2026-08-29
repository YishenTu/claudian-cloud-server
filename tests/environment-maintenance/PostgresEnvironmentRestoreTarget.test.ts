import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PostgresEnvironmentRestoreTarget,
} from '../../src/environment-maintenance/commands/PostgresEnvironmentRestoreTarget.js';

describe('PostgresEnvironmentRestoreTarget', () => {
  it('closes a blocked target identity connection when the command is cancelled', async () => {
    let rejectConnect: ((error: Error) => void) | undefined;
    let ended = false;
    const target = new PostgresEnvironmentRestoreTarget({
      connectionString: 'postgresql://migration:secret@127.0.0.1/cloud',
      createClient: () => ({
        connect: () => new Promise<void>((_resolve, reject) => {
          rejectConnect = reject;
        }),
        end: () => {
          ended = true;
          rejectConnect?.(new Error('closed'));
          return Promise.resolve();
        },
        query: () => assert.fail('unexpected query'),
      }),
    });
    const controller = new AbortController();
    const operation = target.read(controller.signal);
    await Promise.resolve();
    controller.abort('operator-signal');

    await assert.rejects(
      operation,
      /postgres-environment-restore-target\.error\.unavailable/u,
    );
    assert.equal(ended, true);
  });
});
