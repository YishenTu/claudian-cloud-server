import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GitReceiveAdmission,
  GitReceiveAdmissionError,
} from '../../src/resource-admission/GitReceiveAdmission.js';

const MIBIBYTE = 1_024 * 1_024;
const GIBIBYTE = 1_024 * MIBIBYTE;

function admission(availableBytes = 4n * BigInt(GIBIBYTE)): GitReceiveAdmission {
  return new GitReceiveAdmission({
    capacityTimeoutMs: 100,
    freeSpaceFloorBytes: GIBIBYTE,
    maxConcurrentReceives: 2,
    maxConcurrentReceivesPerProject: 1,
    maximumRequestBytes: 256 * MIBIBYTE,
    repositoryRoot: '/srv/claudian/repositories',
    reservationBytes: GIBIBYTE,
  }, {
    availableBytes: () => Promise.resolve(availableBytes),
  });
}

async function expectError(
  operation: Promise<unknown> | (() => unknown),
  code: GitReceiveAdmissionError['code'],
): Promise<void> {
  const promise = typeof operation === 'function'
    ? Promise.resolve().then(operation)
    : operation;
  await assert.rejects(promise, error => {
    assert.ok(error instanceof GitReceiveAdmissionError);
    assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes('/srv/claudian'), false);
    return true;
  });
}

describe('GitReceiveAdmission', () => {
  it('reserves bounded disk per Project and counts streamed request bytes', async () => {
    const owner = admission();
    const projectA = await owner.acquire({ projectId: 'project-a' });
    await expectError(owner.acquire({ projectId: 'project-a' }), 'busy');
    const projectB = await owner.acquire({ projectId: 'project-b' });
    await expectError(owner.acquire({ projectId: 'project-c' }), 'busy');

    projectA.consume(128 * MIBIBYTE);
    projectA.consume(128 * MIBIBYTE);
    await expectError(() => projectA.consume(1), 'input-limit');

    projectA.release();
    projectA.release();
    const projectC = await owner.acquire({ projectId: 'project-c' });
    projectB.release();
    projectC.release();
    await owner.close();
  });

  it('fails closed on insufficient or unobservable repository capacity', async () => {
    const insufficient = admission(BigInt(2 * GIBIBYTE - 1));
    await expectError(
      insufficient.acquire({ projectId: 'project-a' }),
      'busy',
    );
    await insufficient.close();

    const unavailable = new GitReceiveAdmission({
      capacityTimeoutMs: 100,
      freeSpaceFloorBytes: GIBIBYTE,
      maxConcurrentReceives: 2,
      maxConcurrentReceivesPerProject: 1,
      maximumRequestBytes: 256 * MIBIBYTE,
      repositoryRoot: '/srv/claudian/repositories',
      reservationBytes: GIBIBYTE,
    }, {
      availableBytes: () => Promise.reject(new Error('/private/storage/path')),
    });
    await expectError(
      unavailable.acquire({ projectId: 'project-a' }),
      'storage-unavailable',
    );
    await unavailable.close();
  });

  it('cancels acquisition and drains active reservations on close', async () => {
    const owner = admission();
    const cancelled = new AbortController();
    cancelled.abort();
    await expectError(
      owner.acquire({ projectId: 'project-a', signal: cancelled.signal }),
      'cancelled',
    );

    const active = await owner.acquire({ projectId: 'project-a' });
    const close = owner.close();
    await expectError(owner.acquire({ projectId: 'project-b' }), 'closed');
    let settled = false;
    void close.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    active.release();
    await close;
    assert.equal(settled, true);
  });

  it('cancels an in-flight capacity probe before acquisition or close settles', async () => {
    const owner = new GitReceiveAdmission({
      capacityTimeoutMs: 100,
      freeSpaceFloorBytes: GIBIBYTE,
      maxConcurrentReceives: 2,
      maxConcurrentReceivesPerProject: 1,
      maximumRequestBytes: 256 * MIBIBYTE,
      repositoryRoot: '/srv/claudian/repositories',
      reservationBytes: GIBIBYTE,
    }, {
      availableBytes: () => new Promise<bigint>(() => undefined),
    });
    const acquiring = owner.acquire({ projectId: 'project-a' });
    await Promise.resolve();

    const closing = owner.close();
    await Promise.race([
      expectError(acquiring, 'closed'),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('capacity-probe-not-cancelled')), 250).unref();
      }),
    ]);
    await Promise.race([
      closing,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('admission-close-not-settled')), 250).unref();
      }),
    ]);
  });
});
