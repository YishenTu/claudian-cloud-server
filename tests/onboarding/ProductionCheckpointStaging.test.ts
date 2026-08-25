import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
} from '@claudian-collab/protocol';

import {
  ProductionCheckpointStaging,
  ProductionCheckpointStagingError,
  productionCheckpointAttemptPath,
} from '../../src/onboarding/production/ProductionCheckpointStaging.js';
import { CheckpointStreamAdmission } from '../../src/resource-admission/CheckpointStreamAdmission.js';

const GIBIBYTE = 1_073_741_824;
const CLOCK = new Date('2026-08-25T12:00:00.000Z');

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function createOwners(
  stagingRoot: string,
  options: {
    readonly clock?: () => Date;
    readonly idleTimeoutMs?: number;
    readonly totalTimeoutMs?: number;
  } = {},
) {
  const admission = new CheckpointStreamAdmission({
    capacityTimeoutMs: 100,
    freeSpaceFloorBytes: 1,
    maxConcurrentStreams: 3,
    maxConcurrentStreamsPerProject: 2,
    maxStagingAttempts: 3,
    maxStagingAttemptsPerProject: 2,
    queueMax: 4,
    queueMaxPerProject: 2,
    queueTimeoutMs: 100,
    stagingReservationBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
    stagingRoot,
  }, {
    availableBytes: () => Promise.resolve(10n * BigInt(GIBIBYTE)),
  });
  const staging = new ProductionCheckpointStaging({
    admission,
    clock: options.clock ?? (() => new Date(CLOCK)),
    idleTimeoutMs: options.idleTimeoutMs ?? 100,
    stagingRoot,
    totalTimeoutMs: options.totalTimeoutMs ?? 1_000,
  });
  return { admission, staging };
}

async function expectError(
  promise: Promise<unknown>,
  code: ProductionCheckpointStagingError['code'],
): Promise<void> {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ProductionCheckpointStagingError);
    assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes('/private/'), false);
    return true;
  });
}

describe('ProductionCheckpointStaging', () => {
  it('receives, replays, inspects, and downloads exact bounded artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-production-staging-'));
    const owners = createOwners(root);
    const input = {
      expiresAt: '2026-08-26T12:00:00.000Z',
      operationId: 'transfer-a',
      projectId: 'project-a',
    } as const;
    const payloads = {
      'checkpoint.json': Buffer.from('{"checkpoint":"fixture"}\n'),
      'coordination.ndjson': Buffer.from(
        '{"kind":"project","recordId":"project-a"}\n',
      ),
      'repository.bundle': Buffer.from('repository-bundle-fixture\n'),
    } as const;
    try {
      const attempt = await owners.staging.prepareAttempt(input);
      assert.equal(attempt.attemptKey, createHash('sha256')
        .update('production-checkpoint\0project-a\0transfer-a')
        .digest('hex'));
      assert.equal(Object.isFrozen(attempt), true);
      const facts = [];
      for (const artifact of COLLAB_PROJECT_CHECKPOINT_ARTIFACTS) {
        const body = payloads[artifact];
        facts.push(await owners.staging.receiveArtifact({
          artifact,
          attempt,
          body: Readable.from([
            body.subarray(0, 3),
            body.subarray(3),
          ]),
          expectedByteCount: body.length,
          expectedSha256: sha256(body),
        }));
      }
      assert.deepEqual(
        (await owners.staging.inspectAttempt(attempt)).artifacts,
        facts,
      );
      const replayBody = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          throw new Error('replay-body-must-not-be-read');
        },
      };
      assert.deepEqual(await owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: replayBody,
        expectedByteCount: payloads['checkpoint.json'].length,
        expectedSha256: sha256(payloads['checkpoint.json']),
      }), facts[0]);
      for (const fact of facts) {
        const chunks: Buffer[] = [];
        await owners.staging.readArtifact({
          artifact: fact,
          attempt,
          onChunk: async chunk => {
            await Promise.resolve();
            chunks.push(Buffer.from(chunk));
          },
        });
        assert.deepEqual(Buffer.concat(chunks), payloads[fact.name]);
      }
      assert.equal(
        await owners.staging.discardAttempt(attempt),
        'removed',
      );
      assert.equal(
        await owners.staging.discardAttempt(attempt),
        'replayed',
      );
    } finally {
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('snapshots caller metadata before invoking stream callbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-snapshots-'));
    const owners = createOwners(root);
    const prepared = await owners.staging.prepareAttempt({
      expiresAt: '2026-08-26T12:00:00.000Z',
      operationId: 'transfer-snapshot',
      projectId: 'project-a',
    });
    const payload = Buffer.from('snapshot');
    const mutableAttempt = { ...prepared };
    let yielded = false;
    const receiveInput = {
      artifact: 'checkpoint.json' as const,
      attempt: mutableAttempt,
      body: {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => {
              if (yielded) {
                return Promise.resolve({ done: true, value: undefined });
              }
              yielded = true;
              mutableAttempt.attemptKey = 'f'.repeat(64);
              return Promise.resolve({ done: false, value: payload });
            },
          };
        },
      },
      expectedByteCount: payload.length,
      expectedSha256: sha256(payload),
    };
    try {
      const artifact = await owners.staging.receiveArtifact(receiveInput);
      const mutableArtifact = { ...artifact };
      const mutableReadAttempt = { ...prepared };
      const chunks: Buffer[] = [];
      await owners.staging.readArtifact({
        artifact: mutableArtifact,
        attempt: mutableReadAttempt,
        onChunk: chunk => {
          chunks.push(Buffer.from(chunk));
          mutableArtifact.sha256 = '0'.repeat(64);
          mutableReadAttempt.attemptKey = 'e'.repeat(64);
        },
      });
      assert.deepEqual(Buffer.concat(chunks), payload);
      assert.deepEqual(
        (await owners.staging.inspectAttempt(prepared)).artifacts,
        [artifact],
      );

      const digestAttempt = await owners.staging.prepareAttempt({
        expiresAt: '2026-08-26T12:00:00.000Z',
        operationId: 'transfer-snapshot-digest',
        projectId: 'project-b',
      });
      const digestPayload = Buffer.from('right');
      let digestYielded = false;
      const digestInput = {
        artifact: 'checkpoint.json' as const,
        attempt: digestAttempt,
        body: {
          [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
            return {
              next: () => {
                if (digestYielded) {
                  return Promise.resolve({ done: true, value: undefined });
                }
                digestYielded = true;
                digestInput.expectedSha256 = sha256(digestPayload);
                return Promise.resolve({ done: false, value: digestPayload });
              },
            };
          },
        },
        expectedByteCount: digestPayload.length,
        expectedSha256: sha256(Buffer.from('wrong')),
      };
      await expectError(
        owners.staging.receiveArtifact(digestInput),
        'digest-mismatch',
      );
    } finally {
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('cleans digest, overflow, timeout, and cancellation partials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-failure-'));
    const owners = createOwners(root, { idleTimeoutMs: 25, totalTimeoutMs: 100 });
    const attempt = await owners.staging.prepareAttempt({
      expiresAt: '2026-08-26T12:00:00.000Z',
      operationId: 'transfer-failures',
      projectId: 'project-a',
    });
    const attemptPath = productionCheckpointAttemptPath(
      root,
      attempt.projectId,
      attempt.operationId,
    );
    try {
      await expectError(owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: Readable.from([Buffer.from('wrong')]),
        expectedByteCount: 5,
        expectedSha256: sha256(Buffer.from('right')),
      }), 'digest-mismatch');
      await expectError(owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: Readable.from([Buffer.from('overflow')]),
        expectedByteCount: 4,
        expectedSha256: sha256(Buffer.from('four')),
      }), 'input-limit');
      let oversizedChunkCopied = false;
      const oversizedChunk = new Proxy(new Uint8Array(5), {
        get(target, property, receiver: unknown): unknown {
          if (property === 'length' || /^\d+$/u.test(String(property))) {
            oversizedChunkCopied = true;
          }
          if (property === 'byteLength') return target.byteLength;
          if (property === 'length') return target.length;
          if (typeof property === 'string' && /^\d+$/u.test(property)) {
            return target[Number(property)];
          }
          if (property === 'valueOf') return () => receiver;
          return undefined;
        },
      });
      let oversizedChunkYielded = false;
      await expectError(owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: {
          [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
            return {
              next: () => {
                if (oversizedChunkYielded) {
                  return Promise.resolve({ done: true, value: undefined });
                }
                oversizedChunkYielded = true;
                return Promise.resolve({
                  done: false,
                  value: oversizedChunk,
                });
              },
            };
          },
        },
        expectedByteCount: 4,
        expectedSha256: sha256(Buffer.from('four')),
      }), 'input-limit');
      assert.equal(oversizedChunkCopied, false);
      const lyingChunk = new Proxy(new Uint8Array(5), {
        get(target, property, receiver: unknown): unknown {
          if (property === 'byteLength') return 1;
          if (property === 'length') return target.length;
          if (typeof property === 'string' && /^\d+$/u.test(property)) {
            return target[Number(property)];
          }
          if (property === 'valueOf') return () => receiver;
          return undefined;
        },
      });
      await expectError(owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: Readable.from([lyingChunk]),
        expectedByteCount: 1,
        expectedSha256: sha256(new Uint8Array(5)),
      }), 'input-limit');
      await expectError(owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: {
          [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
            throw new Error('/private/iterator-factory');
          },
        },
        expectedByteCount: 4,
        expectedSha256: sha256(Buffer.from('four')),
      }), 'input-limit');
      const stalled = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => new Promise(() => undefined),
          };
        },
      };
      await expectError(owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: stalled,
        expectedByteCount: 4,
        expectedSha256: sha256(Buffer.from('four')),
      }), 'timeout');
      let releaseIteratorReturn: (() => void) | undefined;
      const iteratorReturnReleased = new Promise<void>(resolve => {
        releaseIteratorReturn = resolve;
      });
      let observeIteratorReturn: (() => void) | undefined;
      const iteratorReturnStarted = new Promise<void>(resolve => {
        observeIteratorReturn = resolve;
      });
      const stalledReturn = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => new Promise(() => undefined),
            return: async () => {
              observeIteratorReturn?.();
              await iteratorReturnReleased;
              return { done: true, value: undefined };
            },
          };
        },
      };
      const stalledReturnResult = owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: stalledReturn,
        expectedByteCount: 4,
        expectedSha256: sha256(Buffer.from('four')),
      }).then(
        () => 'resolved' as const,
        (error: unknown) => error,
      );
      let iteratorStartTimeout: ReturnType<typeof setTimeout> | undefined;
      const iteratorStartOutcome = await Promise.race([
        iteratorReturnStarted.then(() => 'started' as const),
        stalledReturnResult.then(() => 'settled' as const),
        new Promise<'not-started'>(resolve => {
          iteratorStartTimeout = setTimeout(
            () => resolve('not-started'),
            1_000,
          );
          iteratorStartTimeout.unref();
        }),
      ]).finally(() => {
        if (iteratorStartTimeout !== undefined) {
          clearTimeout(iteratorStartTimeout);
        }
      });
      if (iteratorStartOutcome !== 'started') releaseIteratorReturn?.();
      assert.equal(iteratorStartOutcome, 'started');
      const settledBeforeIteratorReturn = await Promise.race([
        stalledReturnResult,
        new Promise<'still-running'>(resolve => {
          setTimeout(() => resolve('still-running'), 75);
        }),
      ]);
      releaseIteratorReturn?.();
      await stalledReturnResult;
      assert.notEqual(settledBeforeIteratorReturn, 'still-running');
      assert.ok(
        settledBeforeIteratorReturn instanceof ProductionCheckpointStagingError,
      );
      assert.equal(settledBeforeIteratorReturn.code, 'timeout');
      const cancellation = new AbortController();
      const cancelled = owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: stalled,
        expectedByteCount: 4,
        expectedSha256: sha256(Buffer.from('four')),
        signal: cancellation.signal,
      });
      cancellation.abort();
      await expectError(cancelled, 'cancelled');
      assert.deepEqual(
        (await readdir(attemptPath)).filter(name => name.endsWith('.part')),
        [],
      );
      const valid = Buffer.from('four');
      await owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: Readable.from([valid]),
        expectedByteCount: valid.length,
        expectedSha256: sha256(valid),
      });
    } finally {
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('aborts an active stream and waits for its callback during close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-close-'));
    const owners = createOwners(root);
    const attempt = await owners.staging.prepareAttempt({
      expiresAt: '2026-08-26T12:00:00.000Z',
      operationId: 'transfer-close',
      projectId: 'project-a',
    });
    const payload = Buffer.alloc(192 * 1024, 7);
    const artifact = await owners.staging.receiveArtifact({
      artifact: 'coordination.ndjson',
      attempt,
      body: Readable.from([payload]),
      expectedByteCount: payload.length,
      expectedSha256: sha256(payload),
    });
    let enterCallback: (() => void) | undefined;
    let releaseCallback: (() => void) | undefined;
    const callbackEntered = new Promise<void>(resolve => {
      enterCallback = resolve;
    });
    const callbackRelease = new Promise<void>(resolve => {
      releaseCallback = resolve;
    });
    try {
      const reading = owners.staging.readArtifact({
        artifact,
        attempt,
        onChunk: async () => {
          enterCallback?.();
          await callbackRelease;
        },
      });
      await callbackEntered;
      const closing = owners.staging.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await Promise.resolve();
      assert.equal(closed, false);
      releaseCallback?.();
      await expectError(reading, 'closed');
      await closing;
    } finally {
      releaseCallback?.();
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('aborts and drains a timed-out download callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-download-timeout-'));
    const owners = createOwners(root, { idleTimeoutMs: 25, totalTimeoutMs: 100 });
    const attempt = await owners.staging.prepareAttempt({
      expiresAt: '2026-08-26T12:00:00.000Z',
      operationId: 'transfer-download-timeout',
      projectId: 'project-a',
    });
    const payload = Buffer.from('download-timeout');
    const artifact = await owners.staging.receiveArtifact({
      artifact: 'checkpoint.json',
      attempt,
      body: Readable.from([payload]),
      expectedByteCount: payload.length,
      expectedSha256: sha256(payload),
    });
    let callbackAborted = false;
    let callbackSettled = false;
    try {
      await expectError(owners.staging.readArtifact({
        artifact,
        attempt,
        onChunk: (_chunk, signal) => new Promise<void>(resolve => {
          signal.addEventListener('abort', () => {
            callbackAborted = true;
            setTimeout(() => {
              callbackSettled = true;
              resolve();
            }, 10);
          }, { once: true });
        }),
      }), 'timeout');
      assert.equal(callbackAborted, true);
      assert.equal(callbackSettled, true);
    } finally {
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('bounds an uncooperative download callback without releasing ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-download-retained-'));
    const owners = createOwners(root, { idleTimeoutMs: 25, totalTimeoutMs: 100 });
    const attempt = await owners.staging.prepareAttempt({
      expiresAt: '2026-08-26T12:00:00.000Z',
      operationId: 'transfer-download-retained',
      projectId: 'project-a',
    });
    const payload = Buffer.from('download-retained');
    const artifact = await owners.staging.receiveArtifact({
      artifact: 'checkpoint.json',
      attempt,
      body: Readable.from([payload]),
      expectedByteCount: payload.length,
      expectedSha256: sha256(payload),
    });
    let releaseCallback: (() => void) | undefined;
    const callbackRelease = new Promise<void>(resolve => {
      releaseCallback = resolve;
    });
    const readResult = owners.staging.readArtifact({
      artifact,
      attempt,
      onChunk: async () => callbackRelease,
    }).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    try {
      const earlyReadResult = await Promise.race([
        readResult,
        new Promise<'still-running'>(resolve => {
          setTimeout(() => resolve('still-running'), 100);
        }),
      ]);
      assert.notEqual(earlyReadResult, 'still-running');
      assert.ok(earlyReadResult instanceof ProductionCheckpointStagingError);
      assert.equal(earlyReadResult.code, 'timeout');
      await expectError(owners.staging.inspectAttempt(attempt), 'busy');
      const closeResult = owners.staging.close().then(
        () => 'closed' as const,
        (error: unknown) => error,
      );
      const earlyCloseResult = await Promise.race([
        closeResult,
        new Promise<'still-running'>(resolve => {
          setTimeout(() => resolve('still-running'), 100);
        }),
      ]);
      assert.notEqual(earlyCloseResult, 'still-running');
      assert.ok(earlyCloseResult instanceof ProductionCheckpointStagingError);
      assert.equal(earlyCloseResult.code, 'timeout');
    } finally {
      releaseCallback?.();
      await readResult;
      await owners.staging.close().catch(() => undefined);
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('aborts receipt before exact discard and preserves unrelated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-discard-'));
    const owners = createOwners(root);
    const attempt = await owners.staging.prepareAttempt({
      expiresAt: '2026-08-26T12:00:00.000Z',
      operationId: 'transfer-discard',
      projectId: 'project-a',
    });
    const outside = join(root, 'outside');
    await writeFile(outside, 'must remain\n');
    let enterBody: (() => void) | undefined;
    const bodyEntered = new Promise<void>(resolve => {
      enterBody = resolve;
    });
    const stalled = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next: () => {
            enterBody?.();
            return new Promise(() => undefined);
          },
        };
      },
    };
    try {
      const receiving = owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: stalled,
        expectedByteCount: 4,
        expectedSha256: sha256(Buffer.from('four')),
      });
      await bodyEntered;
      const discarding = owners.staging.discardAttempt(attempt);
      await expectError(receiving, 'cancelled');
      assert.equal(await discarding, 'removed');
      assert.equal(await readFile(outside, 'utf8'), 'must remain\n');
    } finally {
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('reports inspection as busy while an artifact receipt is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-inspect-busy-'));
    const owners = createOwners(root);
    const attempt = await owners.staging.prepareAttempt({
      expiresAt: '2026-08-26T12:00:00.000Z',
      operationId: 'transfer-inspect-busy',
      projectId: 'project-a',
    });
    let enterBody: (() => void) | undefined;
    const bodyEntered = new Promise<void>(resolve => {
      enterBody = resolve;
    });
    const stalled = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next: () => {
            enterBody?.();
            return new Promise(() => undefined);
          },
        };
      },
    };
    const cancellation = new AbortController();
    try {
      const receiving = owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt,
        body: stalled,
        expectedByteCount: 4,
        expectedSha256: sha256(Buffer.from('four')),
        signal: cancellation.signal,
      });
      await bodyEntered;
      await expectError(owners.staging.inspectAttempt(attempt), 'busy');
      cancellation.abort();
      await expectError(receiving, 'cancelled');
    } finally {
      cancellation.abort();
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('holds per-attempt staging capacity until exact cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-reservations-'));
    const owners = createOwners(root);
    const input = (
      projectId: 'project-a' | 'project-b',
      operationId: string,
    ) => ({
      expiresAt: '2026-08-26T12:00:00.000Z' as const,
      operationId,
      projectId,
    });
    try {
      const first = await owners.staging.prepareAttempt(
        input('project-a', 'transfer-reservation-a-1'),
      );
      await owners.staging.prepareAttempt(
        input('project-a', 'transfer-reservation-a-2'),
      );
      await expectError(owners.staging.prepareAttempt(
        input('project-a', 'transfer-reservation-a-3'),
      ), 'busy');
      const otherProject = await owners.staging.prepareAttempt(
        input('project-b', 'transfer-reservation-b-1'),
      );
      await expectError(owners.staging.prepareAttempt(
        input('project-b', 'transfer-reservation-b-2'),
      ), 'busy');
      assert.equal(await owners.staging.discardAttempt(first), 'removed');
      const recovered = await owners.staging.prepareAttempt(
        input('project-b', 'transfer-reservation-b-2'),
      );
      assert.equal(await owners.staging.discardAttempt(otherProject), 'removed');
      assert.equal(await owners.staging.discardAttempt(recovered), 'removed');
    } finally {
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('expires exact attempts after restart and resumes partial cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-expiry-'));
    const firstOwners = createOwners(root, {
      clock: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    const expired = await firstOwners.staging.prepareAttempt({
      expiresAt: '2026-08-25T01:00:00.000Z',
      operationId: 'transfer-expired',
      projectId: 'project-a',
    });
    const retained = await firstOwners.staging.prepareAttempt({
      expiresAt: '2026-08-27T00:00:00.000Z',
      operationId: 'transfer-retained',
      projectId: 'project-b',
    });
    const payload = Buffer.from('expired-artifact');
    const expiredArtifact = await firstOwners.staging.receiveArtifact({
      artifact: 'checkpoint.json',
      attempt: expired,
      body: Readable.from([payload]),
      expectedByteCount: payload.length,
      expectedSha256: sha256(payload),
    });
    await firstOwners.staging.close();
    await firstOwners.admission.close();

    const expiredPath = productionCheckpointAttemptPath(
      root,
      expired.projectId,
      expired.operationId,
    );
    await rm(join(expiredPath, expiredArtifact.name));
    const secondOwners = createOwners(root, {
      clock: () => new Date('2026-08-26T00:00:00.000Z'),
    });
    try {
      assert.equal(await secondOwners.staging.expireAttempt(
        expired,
        '2026-08-26T00:00:00.000Z',
      ), 'expired');
      assert.equal(await secondOwners.staging.expireAttempt(
        retained,
        '2026-08-26T00:00:00.000Z',
      ), 'retained');
      await assert.rejects(readFile(expiredPath), { code: 'ENOENT' });
      assert.deepEqual(
        await secondOwners.staging.prepareAttempt({
          expiresAt: retained.expiresAt,
          operationId: retained.operationId,
          projectId: retained.projectId,
        }),
        retained,
      );
      assert.equal(await secondOwners.staging.discardAttempt(expired), 'replayed');

      const markerless = await secondOwners.staging.prepareAttempt({
        expiresAt: '2026-08-27T00:00:00.000Z',
        operationId: 'transfer-markerless',
        projectId: 'project-c',
      });
      const markerlessPath = productionCheckpointAttemptPath(
        root,
        markerless.projectId,
        markerless.operationId,
      );
      await rm(join(markerlessPath, '.claudian-cloud-production-attempt.json'));
      await writeFile(join(markerlessPath, 'foreign'), 'must remain\n');
      await expectError(
        secondOwners.staging.discardAttempt(markerless),
        'artifact-conflict',
      );
      assert.equal(
        await readFile(join(markerlessPath, 'foreign'), 'utf8'),
        'must remain\n',
      );
    } finally {
      await secondOwners.staging.close();
      await secondOwners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('recovers an exact attempt-marker part during restart expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-marker-part-'));
    const firstOwners = createOwners(root, {
      clock: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    const attempt = await firstOwners.staging.prepareAttempt({
      expiresAt: '2026-08-25T01:00:00.000Z',
      operationId: 'transfer-crash-part',
      projectId: 'project-a',
    });
    const discarded = await firstOwners.staging.prepareAttempt({
      expiresAt: '2026-08-25T02:00:00.000Z',
      operationId: 'transfer-discard-part',
      projectId: 'project-b',
    });
    const attemptPath = productionCheckpointAttemptPath(
      root,
      attempt.projectId,
      attempt.operationId,
    );
    const ownerMarker = '.claudian-cloud-production-attempt.json';
    await rename(
      join(attemptPath, ownerMarker),
      join(attemptPath, `.${ownerMarker}.part`),
    );
    const discardedPath = productionCheckpointAttemptPath(
      root,
      discarded.projectId,
      discarded.operationId,
    );
    await rename(
      join(discardedPath, ownerMarker),
      join(discardedPath, `.${ownerMarker}.part`),
    );
    await firstOwners.staging.close();
    await firstOwners.admission.close();
    const secondOwners = createOwners(root, {
      clock: () => new Date('2026-08-26T00:00:00.000Z'),
    });
    try {
      assert.equal(await secondOwners.staging.expireAttempt(
        attempt,
        '2026-08-26T00:00:00.000Z',
      ), 'expired');
      assert.equal(
        await secondOwners.staging.discardAttempt(discarded),
        'removed',
      );
      await assert.rejects(readFile(attemptPath), { code: 'ENOENT' });
      await assert.rejects(readFile(discardedPath), { code: 'ENOENT' });
    } finally {
      await secondOwners.staging.close();
      await secondOwners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('preserves exact attempt identity when restart finds a marker part', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-part-identity-'));
    const firstOwners = createOwners(root, {
      clock: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    const attempt = await firstOwners.staging.prepareAttempt({
      expiresAt: '2026-08-27T00:00:00.000Z',
      operationId: 'transfer-part-identity',
      projectId: 'project-a',
    });
    const attemptPath = productionCheckpointAttemptPath(
      root,
      attempt.projectId,
      attempt.operationId,
    );
    const ownerMarker = '.claudian-cloud-production-attempt.json';
    await rename(
      join(attemptPath, ownerMarker),
      join(attemptPath, `.${ownerMarker}.part`),
    );
    await firstOwners.staging.close();
    await firstOwners.admission.close();

    const secondOwners = createOwners(root, {
      clock: () => new Date('2026-08-26T00:00:00.000Z'),
    });
    try {
      await expectError(secondOwners.staging.prepareAttempt({
        expiresAt: '2026-08-28T00:00:00.000Z',
        operationId: attempt.operationId,
        projectId: attempt.projectId,
      }), 'artifact-conflict');
      assert.deepEqual(await secondOwners.staging.prepareAttempt({
        expiresAt: attempt.expiresAt,
        operationId: attempt.operationId,
        projectId: attempt.projectId,
      }), attempt);
    } finally {
      await secondOwners.staging.close();
      await secondOwners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('expires only the exact durable candidate supplied by lifecycle recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-expiry-exact-'));
    const owners = createOwners(root, {
      clock: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    const [selected, unrelated] = await Promise.all([
      owners.staging.prepareAttempt({
        expiresAt: '2026-08-25T01:00:00.000Z',
        operationId: 'transfer-exact-a',
        projectId: 'project-a',
      }),
      owners.staging.prepareAttempt({
        expiresAt: '2026-08-25T01:00:00.000Z',
        operationId: 'transfer-exact-b',
        projectId: 'project-b',
      }),
    ]);
    try {
      const unrelatedPath = productionCheckpointAttemptPath(
        root,
        unrelated.projectId,
        unrelated.operationId,
      );
      await writeFile(
        join(unrelatedPath, '.claudian-cloud-production-attempt.json'),
        '{"corrupt":true}\n',
      );
      assert.equal(await owners.staging.expireAttempt(
        selected,
        '2026-08-26T00:00:00.000Z',
      ), 'expired');
      assert.equal(
        await readFile(
          join(unrelatedPath, '.claudian-cloud-production-attempt.json'),
          'utf8',
        ),
        '{"corrupt":true}\n',
      );
      await expectError(owners.staging.expireAttempt(
        unrelated,
        '2026-08-26T00:00:00.000Z',
      ), 'artifact-conflict');
    } finally {
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects expired, contradictory, and escaping attempt identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-staging-identity-'));
    const owners = createOwners(root);
    try {
      await expectError(owners.staging.prepareAttempt({
        expiresAt: '2026-08-25T11:59:59.000Z',
        operationId: 'transfer-expired',
        projectId: 'project-a',
      }), 'expired');
      const attempt = await owners.staging.prepareAttempt({
        expiresAt: '2026-08-26T12:00:00.000Z',
        operationId: 'transfer-a',
        projectId: 'project-a',
      });
      await expectError(owners.staging.prepareAttempt({
        expiresAt: '2026-08-27T12:00:00.000Z',
        operationId: attempt.operationId,
        projectId: attempt.projectId,
      }), 'artifact-conflict');
      const concurrentInput = {
        expiresAt: '2026-08-26T12:00:00.000Z',
        operationId: 'transfer-concurrent',
        projectId: 'project-b',
      } as const;
      const [first, second] = await Promise.all([
        owners.staging.prepareAttempt(concurrentInput),
        owners.staging.prepareAttempt(concurrentInput),
      ]);
      assert.deepEqual(first, second);
      await expectError(owners.staging.inspectAttempt({
        ...attempt,
        attemptKey: '../private/path',
      }), 'invalid-attempt');
      const outside = join(root, 'outside-artifact');
      await writeFile(outside, 'must remain\n');
      const attemptPath = productionCheckpointAttemptPath(
        root,
        concurrentInput.projectId,
        concurrentInput.operationId,
      );
      await symlink(outside, join(attemptPath, 'checkpoint.json'));
      await expectError(owners.staging.receiveArtifact({
        artifact: 'checkpoint.json',
        attempt: first,
        body: Readable.from([Buffer.from('four')]),
        expectedByteCount: 4,
        expectedSha256: sha256(Buffer.from('four')),
      }), 'artifact-conflict');
      assert.equal(await readFile(outside, 'utf8'), 'must remain\n');
    } finally {
      await owners.staging.close();
      await owners.admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('does not expose private filesystem errors through an error cause', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'claudian-staging-errors-'));
    const missingRoot = join(parent, 'private-staging-root');
    const owners = createOwners(missingRoot);
    try {
      const maliciousAttempt = {
        expiresAt: '2026-08-26T12:00:00.000Z',
        operationId: 'transfer-private-error',
        projectId: 'project-a',
      } as Record<string, unknown>;
      Object.defineProperty(maliciousAttempt, 'attemptKey', {
        get: () => {
          throw new Error('/private/attempt-getter');
        },
      });
      await expectError(
        owners.staging.inspectAttempt(
          maliciousAttempt as unknown as Parameters<
            typeof owners.staging.inspectAttempt
          >[0],
        ),
        'invalid-attempt',
      );
      let caught: unknown;
      try {
        await owners.staging.prepareAttempt({
          expiresAt: '2026-08-26T12:00:00.000Z',
          operationId: 'transfer-private-error',
          projectId: 'project-a',
        });
      } catch (error: unknown) {
        caught = error;
      }
      assert.ok(caught instanceof ProductionCheckpointStagingError);
      assert.equal(caught.code, 'storage-unavailable');
      assert.equal(Object.hasOwn(caught, 'cause'), false);
      assert.equal(String(caught).includes(missingRoot), false);
    } finally {
      await owners.staging.close();
      await owners.admission.close();
      await rm(parent, { force: true, recursive: true });
    }
  });
});
