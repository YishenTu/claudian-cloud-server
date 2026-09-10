import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BootstrapUploadAdmission,
  BootstrapUploadAdmissionError,
} from '../../src/resource-admission/BootstrapUploadAdmission.js';

const GIBIBYTE = 1_073_741_824;

function createAdmission(options: {
  readonly availableBytes?: () => Promise<bigint>;
  readonly queueMax?: number;
  readonly queueTimeoutMs?: number;
} = {}): BootstrapUploadAdmission {
  return new BootstrapUploadAdmission({
    maxConcurrentUploads: 1,
    maxUploadsPerAttempt: 1,
    queueMax: options.queueMax ?? 4,
    queueTimeoutMs: options.queueTimeoutMs ?? 100,
    stagingFreeSpaceFloorBytes: GIBIBYTE,
    stagingReservationBytes: 2 * GIBIBYTE,
    stagingRoot: '/srv/claudian/staging',
  }, {
    availableBytes: options.availableBytes
      ?? (() => Promise.resolve(10n * BigInt(GIBIBYTE))),
  });
}

async function expectAdmissionError(
  promise: Promise<unknown>,
  code: BootstrapUploadAdmissionError['code'],
): Promise<void> {
  await assert.rejects(
    promise,
    error => {
      assert.ok(error instanceof BootstrapUploadAdmissionError);
      assert.equal(error.code, code);
      assert.deepEqual(error.toJSON(), {
        code,
        message: `bootstrap-upload-admission.error.${code}`,
        name: 'BootstrapUploadAdmissionError',
        retryable: code === 'busy' || code === 'storage-unavailable',
      });
      return true;
    },
  );
}

describe('BootstrapUploadAdmission', () => {
  it('grants one global upload in strict FIFO order and rejects duplicate attempts', async () => {
    const admission = createAdmission();
    const first = await admission.acquire({ attemptId: 'attempt-a' });

    await expectAdmissionError(
      admission.acquire({ attemptId: 'attempt-a' }),
      'busy',
    );

    const order: string[] = [];
    const secondPromise = admission.acquire({ attemptId: 'attempt-b' })
      .then(permit => {
        order.push('attempt-b');
        return permit;
      });
    const thirdPromise = admission.acquire({ attemptId: 'attempt-c' })
      .then(permit => {
        order.push('attempt-c');
        return permit;
      });

    first.release();
    const second = await secondPromise;
    assert.deepEqual(order, ['attempt-b']);

    second.release();
    const third = await thirdPromise;
    assert.deepEqual(order, ['attempt-b', 'attempt-c']);

    first.release();
    second.release();
    third.release();
    await admission.close();
  });

  it('bounds the queue, cancellation, and acquisition deadline without leaking reservations', async () => {
    const admission = createAdmission({ queueMax: 1, queueTimeoutMs: 25 });
    const active = await admission.acquire({ attemptId: 'attempt-active' });

    const cancellation = new AbortController();
    const cancelled = admission.acquire({
      attemptId: 'attempt-cancelled',
      signal: cancellation.signal,
    });
    await expectAdmissionError(
      admission.acquire({ attemptId: 'attempt-overflow' }),
      'busy',
    );
    cancellation.abort();
    await expectAdmissionError(cancelled, 'cancelled');

    const expired = admission.acquire({ attemptId: 'attempt-expired' });
    await expectAdmissionError(expired, 'busy');

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expectAdmissionError(
      admission.acquire({
        attemptId: 'attempt-already-cancelled',
        signal: alreadyCancelled.signal,
      }),
      'cancelled',
    );

    active.release();
    const recovered = await admission.acquire({ attemptId: 'attempt-recovered' });
    recovered.release();
    await admission.close();
  });

  it('checks reserved capacity plus the free-space floor before granting', async () => {
    const observations = [
      BigInt(3 * GIBIBYTE - 1),
      BigInt(3 * GIBIBYTE),
    ];
    const admission = createAdmission({
      availableBytes: () => Promise.resolve(observations.shift() ?? 0n),
    });

    await expectAdmissionError(
      admission.acquire({ attemptId: 'attempt-no-space' }),
      'busy',
    );
    const permit = await admission.acquire({ attemptId: 'attempt-enough-space' });
    permit.release();
    await admission.close();
  });

  it('fails safely when staging availability cannot be observed', async () => {
    const secret = '/private/operator/path';
    const admission = createAdmission({
      availableBytes: () => Promise.reject(new Error(secret)),
    });

    const acquisition = admission.acquire({ attemptId: 'attempt-storage-error' });
    await assert.rejects(acquisition, error => {
      assert.ok(error instanceof BootstrapUploadAdmissionError);
      assert.equal(error.code, 'storage-unavailable');
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
    await admission.close();
  });

  it('cancels a pending disk check and grants the next waiter without a partial reservation', async () => {
    let finishProbe!: (value: bigint) => void;
    let probeCount = 0;
    const admission = createAdmission({
      availableBytes: () => {
        probeCount += 1;
        if (probeCount > 1) return Promise.resolve(10n * BigInt(GIBIBYTE));
        return new Promise(resolve => {
          finishProbe = resolve;
        });
      },
    });
    const cancellation = new AbortController();
    const cancelled = admission.acquire({
      attemptId: 'attempt-cancelled-during-probe',
      signal: cancellation.signal,
    });
    const next = admission.acquire({ attemptId: 'attempt-after-cancel' });

    cancellation.abort();
    finishProbe(10n * BigInt(GIBIBYTE));
    await expectAdmissionError(cancelled, 'cancelled');
    const permit = await next;
    permit.release();
    await admission.close();
  });

  it('closes queued and future work and drains an active reservation exactly once', async () => {
    const admission = createAdmission();
    const active = await admission.acquire({ attemptId: 'attempt-active' });
    const queued = admission.acquire({ attemptId: 'attempt-queued' });

    const close = admission.close();
    assert.equal(admission.close(), close);
    await expectAdmissionError(queued, 'closed');
    await expectAdmissionError(
      admission.acquire({ attemptId: 'attempt-after-close' }),
      'closed',
    );

    let drained = false;
    void close.then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);

    active.release();
    active.release();
    await close;
    assert.equal(drained, true);
  });

  it('rejects invalid attempt identifiers without reflecting them', async () => {
    const admission = createAdmission();
    const secret = '../private-attempt-path';
    await expectAdmissionError(
      admission.acquire({ attemptId: secret }),
      'invalid-attempt',
    );
    await admission.close();
  });

  it('rejects invalid construction limits', () => {
    const options = {
      maxConcurrentUploads: 1,
      maxUploadsPerAttempt: 1,
      queueMax: 4,
      queueTimeoutMs: 100,
      stagingFreeSpaceFloorBytes: GIBIBYTE,
      stagingReservationBytes: 2 * GIBIBYTE,
      stagingRoot: '/srv/claudian/staging',
    } as const;
    for (const invalid of [
      { ...options, maxUploadsPerAttempt: 2 },
      { ...options, queueMax: 0 },
      { ...options, queueTimeoutMs: 0 },
      { ...options, stagingFreeSpaceFloorBytes: 0 },
      { ...options, stagingReservationBytes: 0 },
      { ...options, stagingRoot: 'relative/staging' },
    ]) {
      assert.throws(
        () => new BootstrapUploadAdmission(invalid),
        /bootstrap-upload-admission\.options-invalid/,
      );
    }
  });
});
