import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
} from '@claudian-collab/protocol';

import {
  CheckpointStreamAdmission,
  CheckpointStreamAdmissionError,
} from '../../src/resource-admission/CheckpointStreamAdmission.js';

const GIBIBYTE = 1_073_741_824;

function createAdmission(options: {
  readonly availableBytes?: () => Promise<bigint>;
  readonly capacityTimeoutMs?: number;
  readonly maxConcurrentStreams?: number;
  readonly maxConcurrentStreamsPerProject?: number;
  readonly maxStagingAttempts?: number;
  readonly maxStagingAttemptsPerProject?: number;
  readonly queueTimeoutMs?: number;
} = {}): CheckpointStreamAdmission {
  return new CheckpointStreamAdmission({
    capacityTimeoutMs: options.capacityTimeoutMs ?? 100,
    freeSpaceFloorBytes: GIBIBYTE,
    maxConcurrentStreams: options.maxConcurrentStreams ?? 3,
    maxConcurrentStreamsPerProject:
      options.maxConcurrentStreamsPerProject ?? 2,
    maxStagingAttempts: options.maxStagingAttempts ?? 8,
    maxStagingAttemptsPerProject:
      options.maxStagingAttemptsPerProject ?? 4,
    queueMax: 4,
    queueMaxPerProject: 2,
    queueTimeoutMs: options.queueTimeoutMs ?? 100,
    stagingReservationBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
    stagingRoot: '/srv/claudian/staging',
  }, {
    availableBytes: options.availableBytes
      ?? (() => Promise.resolve(32n * BigInt(GIBIBYTE))),
  });
}

function reserve(
  admission: CheckpointStreamAdmission,
  input: Readonly<{
    operationId: string;
    projectId: string;
    signal?: AbortSignal;
  }>,
) {
  return admission.reserveAttempt({
    operationId: input.operationId,
    projectId: input.projectId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function acquire(
  admission: CheckpointStreamAdmission,
  input: Readonly<{
    artifact?: 'checkpoint.json' | 'coordination.ndjson' | 'repository.bundle';
    direction?: 'download' | 'upload';
    expectedByteCount?: number;
    operationId: string;
    projectId: string;
    signal?: AbortSignal;
  }>,
) {
  return admission.acquire({
    artifact: input.artifact ?? 'checkpoint.json',
    direction: input.direction ?? 'upload',
    expectedByteCount: input.expectedByteCount ?? 128,
    operationId: input.operationId,
    projectId: input.projectId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function expectError(
  promise: Promise<unknown> | (() => unknown),
  code: CheckpointStreamAdmissionError['code'],
): Promise<void> {
  await assert.rejects(
    typeof promise === 'function' ? Promise.resolve().then(promise) : promise,
    error => {
      assert.ok(error instanceof CheckpointStreamAdmissionError);
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(error).includes('/srv/claudian'), false);
      return true;
    },
  );
}

describe('CheckpointStreamAdmission', () => {
  it('reserves global, Project, and attempt stream capacity', async () => {
    const admission = createAdmission();
    const reservations = await Promise.all([
      reserve(admission, {
        operationId: 'operation-a-1',
        projectId: 'project-a',
      }),
      reserve(admission, {
        operationId: 'operation-a-2',
        projectId: 'project-a',
      }),
      reserve(admission, {
        operationId: 'operation-a-3',
        projectId: 'project-a',
      }),
      reserve(admission, {
        operationId: 'operation-b-1',
        projectId: 'project-b',
      }),
    ]);
    const projectAFirst = await acquire(admission, {
      operationId: 'operation-a-1',
      projectId: 'project-a',
    });
    await expectError(acquire(admission, {
      direction: 'download',
      operationId: 'operation-a-1',
      projectId: 'project-a',
    }), 'busy');
    const projectASecond = await acquire(admission, {
      direction: 'download',
      operationId: 'operation-a-2',
      projectId: 'project-a',
    });
    let projectAThirdGranted = false;
    const projectAThird = acquire(admission, {
      operationId: 'operation-a-3',
      projectId: 'project-a',
    }).then(permit => {
      projectAThirdGranted = true;
      return permit;
    });
    const projectB = await acquire(admission, {
      operationId: 'operation-b-1',
      projectId: 'project-b',
    });
    assert.equal(projectAThirdGranted, false);

    projectAFirst.consume(64);
    projectAFirst.consume(64);
    await expectError(() => projectAFirst.consume(1), 'input-limit');
    projectAFirst.release();
    const projectANext = await projectAThird;

    projectAFirst.release();
    projectASecond.release();
    projectANext.release();
    projectB.release();
    for (const reservation of reservations) reservation.release();
    await admission.close();
  });

  it('retains disk capacity for the complete attempt lifetime', async () => {
    const available = BigInt(
      GIBIBYTE + (2 * COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes) - 1,
    );
    const admission = createAdmission({
      availableBytes: () => Promise.resolve(available),
    });
    const firstReservation = await reserve(admission, {
      operationId: 'operation-first',
      projectId: 'project-a',
    });
    const upload = await acquire(admission, {
      operationId: 'operation-first',
      projectId: 'project-a',
    });
    upload.release();
    await expectError(reserve(admission, {
      operationId: 'operation-second',
      projectId: 'project-b',
    }), 'busy');
    const download = await acquire(admission, {
      direction: 'download',
      operationId: 'operation-first',
      projectId: 'project-a',
    });
    download.release();
    firstReservation.release();
    const secondReservation = await reserve(admission, {
      operationId: 'operation-second',
      projectId: 'project-b',
    });
    secondReservation.release();
    await admission.close();
  });

  it('reserves staging headroom globally and for another Project', async () => {
    const admission = createAdmission({
      maxStagingAttempts: 3,
      maxStagingAttemptsPerProject: 2,
    });
    const first = await reserve(admission, {
      operationId: 'operation-a-1',
      projectId: 'project-a',
    });
    const second = await reserve(admission, {
      operationId: 'operation-a-2',
      projectId: 'project-a',
    });
    await expectError(reserve(admission, {
      operationId: 'operation-a-3',
      projectId: 'project-a',
    }), 'busy');
    const otherProject = await reserve(admission, {
      operationId: 'operation-b-1',
      projectId: 'project-b',
    });
    await expectError(reserve(admission, {
      operationId: 'operation-c-1',
      projectId: 'project-c',
    }), 'busy');
    first.release();
    const recovered = await reserve(admission, {
      operationId: 'operation-c-1',
      projectId: 'project-c',
    });
    second.release();
    otherProject.release();
    recovered.release();
    await admission.close();
  });

  it('bounds queued work, deadlines, and cancellation without leaks', async () => {
    const admission = createAdmission({
      maxConcurrentStreams: 2,
      maxConcurrentStreamsPerProject: 1,
      queueTimeoutMs: 25,
    });
    const reservations = await Promise.all([
      reserve(admission, {
        operationId: 'operation-a',
        projectId: 'project-a',
      }),
      reserve(admission, {
        operationId: 'operation-b',
        projectId: 'project-b',
      }),
      reserve(admission, {
        operationId: 'operation-cancelled',
        projectId: 'project-c',
      }),
      reserve(admission, {
        operationId: 'operation-expired',
        projectId: 'project-c',
      }),
      reserve(admission, {
        operationId: 'operation-recovered',
        projectId: 'project-c',
      }),
    ]);
    const first = await acquire(admission, {
      operationId: 'operation-a',
      projectId: 'project-a',
    });
    const second = await acquire(admission, {
      operationId: 'operation-b',
      projectId: 'project-b',
    });
    const controller = new AbortController();
    const cancelled = acquire(admission, {
      operationId: 'operation-cancelled',
      projectId: 'project-c',
      signal: controller.signal,
    });
    controller.abort();
    await expectError(cancelled, 'cancelled');
    await expectError(acquire(admission, {
      operationId: 'operation-expired',
      projectId: 'project-c',
    }), 'busy');
    first.release();
    second.release();
    const recovered = await acquire(admission, {
      operationId: 'operation-recovered',
      projectId: 'project-c',
    });
    recovered.release();
    for (const reservation of reservations) reservation.release();
    await admission.close();
  });

  it('cancels an in-flight capacity probe and drains close', async () => {
    let probe = 0;
    const admission = createAdmission({
      availableBytes: () => {
        probe += 1;
        return probe === 1
          ? new Promise<bigint>(() => undefined)
          : Promise.resolve(10n * BigInt(GIBIBYTE));
      },
    });
    const controller = new AbortController();
    const cancelled = reserve(admission, {
      operationId: 'operation-cancelled-probe',
      projectId: 'project-a',
      signal: controller.signal,
    });
    controller.abort();
    await expectError(cancelled, 'cancelled');
    const activeReservation = await reserve(admission, {
      operationId: 'operation-active',
      projectId: 'project-b',
    });
    const active = await acquire(admission, {
      operationId: 'operation-active',
      projectId: 'project-b',
    });
    const closing = admission.close();
    await expectError(acquire(admission, {
      operationId: 'operation-closed',
      projectId: 'project-c',
    }), 'closed');
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    active.release();
    await Promise.resolve();
    assert.equal(settled, false);
    activeReservation.release();
    await closing;
  });

  it('rejects invalid identities, artifacts, and declared limits safely', async () => {
    const admission = createAdmission();
    await expectError(acquire(admission, {
      operationId: '../private-operation',
      projectId: 'project-a',
    }), 'invalid-request');
    await expectError(acquire(admission, {
      artifact: 'repository.bundle',
      expectedByteCount:
        COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes + 1,
      operationId: 'operation-too-large',
      projectId: 'project-a',
    }), 'invalid-request');
    await expectError(admission.acquire({
      artifact: 'unknown.bin' as never,
      direction: 'upload',
      expectedByteCount: 1,
      operationId: 'operation-artifact',
      projectId: 'project-a',
    }), 'invalid-request');
    const reservation = await reserve(admission, {
      operationId: 'operation-snapshot',
      projectId: 'project-a',
    });
    const reads = new Map<string, number>();
    const input: Record<string, unknown> = {};
    for (const [name, value] of Object.entries({
      artifact: 'checkpoint.json',
      direction: 'upload',
      expectedByteCount: 128,
      operationId: 'operation-snapshot',
      projectId: 'project-a',
      signal: undefined,
    })) {
      Object.defineProperty(input, name, {
        get: () => {
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return value;
        },
      });
    }
    const permit = await admission.acquire(
      input as unknown as Parameters<typeof admission.acquire>[0],
    );
    assert.deepEqual(
      Object.fromEntries(reads),
      {
        artifact: 1,
        direction: 1,
        expectedByteCount: 1,
        operationId: 1,
        projectId: 1,
        signal: 1,
      },
    );
    permit.release();
    reservation.release();

    const malicious: Record<string, unknown> = {};
    Object.defineProperty(malicious, 'projectId', {
      get: () => {
        throw new Error('/private/project-getter');
      },
    });
    await expectError(
      () => admission.acquire(
        malicious as unknown as Parameters<typeof admission.acquire>[0],
      ),
      'invalid-request',
    );
    await admission.close();
  });
});
