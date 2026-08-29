import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExportDeliveryExpiryCommand } from '../../src/environment-maintenance/commands/ExportDeliveryExpiryCommand.js';

describe('ExportDeliveryExpiryCommand', () => {
  it('reconciles every delivery due at the one-shot observation time', async () => {
    const calls: Array<Readonly<{
      readonly expiredBefore: string;
      readonly signal?: AbortSignal;
    }>> = [];
    const signal = new AbortController().signal;
    const command = new ExportDeliveryExpiryCommand({
      clock: () => new Date('2026-08-29T12:00:00.000Z'),
      coordinator: {
        reconcileExpiredExportDeliveries: input => {
          calls.push(input);
          return Promise.resolve(Object.freeze({ removed: 2 }));
        },
      },
    });

    assert.deepEqual(await command.run(signal), { removed: 2 });
    assert.deepEqual(calls, [{
      expiredBefore: '2026-08-29T12:00:00.000Z',
      signal,
    }]);
  });
});
