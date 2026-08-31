import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EnvironmentRestoreCommand,
} from '../../src/environment-maintenance/commands/EnvironmentRestoreCommand.js';
import {
  ProjectExportCommand,
} from '../../src/environment-maintenance/commands/ProjectExportCommand.js';
import {
  ResumeDeletionCommand,
} from '../../src/environment-maintenance/commands/ResumeDeletionCommand.js';

const catalogSha256 = 'a'.repeat(64);
const operationId = 'backup-environment-1';
const projectId = '11111111-1111-4111-8111-111111111111';

describe('maintenance operation commands', () => {
  it('restores the exact catalog into the target identity', async () => {
    const calls: unknown[] = [];
    const command = new EnvironmentRestoreCommand({
      catalog: {
        readCatalog: () => Promise.resolve({ catalogSha256 }),
      },
      restore: {
        restore: input => {
          calls.push(input);
          return Promise.resolve({ state: 'completed' });
        },
      },
      target: {
        read: () => Promise.resolve({
          authorityVolumeId: '1'.repeat(32),
          authorityVolumeIdentity: 'target-volume-1',
        }),
      },
    });
    assert.deepEqual(await command.run({
      catalogId: operationId,
      operationId: 'restore-environment-1',
      signal: new AbortController().signal,
    }), { state: 'completed' });
    assert.deepEqual(calls[0], {
      authorityVolumeId: '1'.repeat(32),
      authorityVolumeIdentity: 'target-volume-1',
      catalogId: operationId,
      expectedCatalogSha256: catalogSha256,
      operationId: 'restore-environment-1',
      signal: (calls[0] as { signal: AbortSignal }).signal,
    });
  });

  it('uses O1 export policy and the deletion authorization owner unchanged', async () => {
    const exports: unknown[] = [];
    const exportDeliveries: unknown[] = [];
    const deletions: unknown[] = [];
    const signal = new AbortController().signal;
    const exportCommand = new ProjectExportCommand({
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
      coordinator: {
        create: input => {
          exports.push(input);
          return Promise.resolve({
            checkpointSha256: 'c'.repeat(64),
            createdAt: '2026-08-29T00:00:00.000Z',
            expiresAt: input.expiresAt,
            operationId: input.operationId,
            profile: input.profile,
            projectId: input.projectId,
            state: 'published',
          });
        },
        reconcileExpiredExportDeliveries: input => {
          exports.push({ reconcile: input });
          return Promise.resolve({ removed: 0 });
        },
        settleExportDelivery: input => {
          exports.push({ settle: input });
          return Promise.resolve('removed');
        },
      },
      delivery: {
        deliver: input => {
          exportDeliveries.push(input);
          return Promise.resolve();
        },
      },
    });
    const deletionCommand = new ResumeDeletionCommand({
      coordinator: {
        resumeAuthorized: input => {
          deletions.push(input);
          return Promise.resolve('settled');
        },
      },
    });

    await exportCommand.run({
      expiresAt: '2026-09-01T00:00:00.000Z',
      operationId,
      projectId,
      signal,
    });
    await deletionCommand.run({
      authorizationSha256: 'b'.repeat(64),
      operationId,
      projectId,
      signal,
    });
    assert.deepEqual(exports.slice(0, 2), [{
      reconcile: {
        expiredBefore: '2026-08-29T00:00:00.000Z',
        signal,
      },
    }, {
      expiresAt: '2026-09-01T00:00:00.000Z',
      operationId,
      profile: 'export',
      projectId,
      signal,
    }]);
    const settlement = exports[2] as {
      readonly settle: {
        readonly operationId: string;
        readonly projectId: string;
        readonly reason: string;
        readonly signal: AbortSignal;
      };
    };
    assert.deepEqual({
      operationId: settlement.settle.operationId,
      projectId: settlement.settle.projectId,
      reason: settlement.settle.reason,
    }, { operationId, projectId, reason: 'completed' });
    assert.notEqual(settlement.settle.signal, signal);
    assert.equal(settlement.settle.signal.aborted, false);
    assert.equal(exportDeliveries.length, 1);
    assert.equal(
      (exportDeliveries[0] as { readonly operationId: string }).operationId,
      operationId,
    );
    assert.deepEqual(deletions, [{
      authorizationSha256: 'b'.repeat(64),
      operationId,
      projectId,
      signal,
    }]);
  });

  it('settles cancelled export delivery with a fresh bounded signal', async () => {
    const controller = new AbortController();
    let settlementSignal: AbortSignal | undefined;
    const command = new ProjectExportCommand({
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
      coordinator: {
        create: input => Promise.resolve({
          checkpointSha256: 'c'.repeat(64),
          createdAt: '2026-08-29T00:00:00.000Z',
          expiresAt: input.expiresAt,
          operationId: input.operationId,
          profile: input.profile,
          projectId: input.projectId,
          state: 'published',
        }),
        reconcileExpiredExportDeliveries: () => Promise.resolve({ removed: 0 }),
        settleExportDelivery: input => {
          settlementSignal = input.signal;
          return Promise.resolve('removed');
        },
      },
      delivery: {
        deliver: () => {
          controller.abort();
          return Promise.reject(new Error('cancelled delivery'));
        },
      },
    });

    await assert.rejects(command.run({
      expiresAt: '2026-09-01T00:00:00.000Z',
      operationId,
      projectId,
      signal: controller.signal,
    }), /cancelled delivery/u);
    assert.ok(settlementSignal);
    assert.notEqual(settlementSignal, controller.signal);
    assert.equal(settlementSignal.aborted, false);
  });
});
