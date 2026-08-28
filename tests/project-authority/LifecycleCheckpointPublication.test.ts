import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { COLLAB_CHECKPOINT_ARTIFACT_LIMITS } from '@claudian-collab/protocol';

import {
  ProductionCheckpointStaging,
  ProductionCheckpointStagingError,
} from '../../src/onboarding/production/ProductionCheckpointStaging.js';
import type {
  PreparedProductionCheckpointAttempt,
  ProductionCheckpointStagingPort,
} from '../../src/onboarding/production/ProductionCheckpointStaging.js';
import { productionCheckpointAttemptIdentity } from '../../src/onboarding/production/ProductionCheckpointStaging.js';
import {
  LifecycleCheckpointPublication,
  type LifecycleCheckpointPublicationStore,
} from '../../src/project-authority/checkpoint/LifecycleCheckpointPublication.js';
import { CheckpointStreamAdmission } from '../../src/resource-admission/CheckpointStreamAdmission.js';

function realPublication(
  root: string,
  clock: () => Date,
  profile: 'backup' | 'export' = 'backup',
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
    stagingReservationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
    stagingRoot: root,
  }, {
    availableBytes: () => Promise.resolve(10n * 1024n * 1024n * 1024n),
  });
  const staging = new ProductionCheckpointStaging({
    admission,
    clock,
    idleTimeoutMs: 100,
    stagingRoot: root,
    totalTimeoutMs: 1_000,
  });
  return Object.freeze({
    admission,
    publication: new LifecycleCheckpointPublication(staging, profile),
    staging,
  });
}

describe('LifecycleCheckpointPublication', () => {
  it('reopens the real retained artifact after restart beyond its delivery expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-publication-'));
    let now = new Date('2026-08-28T00:00:00.000Z');
    const external = productionCheckpointAttemptIdentity({
      expiresAt: '2026-08-29T00:00:00.000Z',
      operationId: 'backup-restart',
      projectId: 'project-a',
    });
    const payload = Buffer.from('retained-checkpoint\n');
    let owners = realPublication(root, () => new Date(now));
    try {
      const attempt = await owners.publication.prepareAttempt(external);
      await owners.publication.receiveArtifact({
        artifact: 'coordination.ndjson',
        attempt,
        body: Readable.from([payload]),
        expectedByteCount: payload.length,
        expectedSha256: createHash('sha256').update(payload).digest('hex'),
      });
      for (const operationId of ['backup-two', 'backup-three']) {
        const additional = productionCheckpointAttemptIdentity({
          expiresAt: external.expiresAt,
          operationId,
          projectId: external.projectId,
        });
        const prepared = await owners.publication.prepareAttempt(additional);
        await owners.publication.receiveArtifact({
          artifact: 'coordination.ndjson',
          attempt: prepared,
          body: Readable.from([payload]),
          expectedByteCount: payload.length,
          expectedSha256: createHash('sha256').update(payload).digest('hex'),
        });
      }
      await owners.staging.close();
      await owners.admission.close();

      now = new Date('2030-01-01T00:00:00.000Z');
      owners = realPublication(root, () => new Date(now));
      const inspected = await owners.publication.inspectAttempt(external);
      const artifact = inspected.artifacts[0];
      assert.equal(artifact?.name, 'coordination.ndjson');
      assert.deepEqual(inspected.attempt, external);
      const chunks: Buffer[] = [];
      assert.ok(artifact);
      await owners.publication.readArtifact({
        artifact,
        attempt: external,
        onChunk: chunk => {
          chunks.push(Buffer.from(chunk));
        },
      });
      assert.deepEqual(Buffer.concat(chunks), payload);
      assert.equal(await owners.publication.discardAttempt(external), 'removed');
    } finally {
      await owners.staging.close().catch(() => undefined);
      await owners.admission.close().catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  });

  it('retains a published attempt after its delivery TTL until explicit lifecycle cleanup', async () => {
    const external = productionCheckpointAttemptIdentity({
      expiresAt: '2026-08-29T00:00:00.000Z',
      operationId: 'backup-one',
      projectId: 'project-a',
    });
    let storedAttempt: PreparedProductionCheckpointAttempt | undefined;
    let discardedAttempt: PreparedProductionCheckpointAttempt | undefined;
    let expiryCalls = 0;
    const store = {
      discardAttempt(attempt: PreparedProductionCheckpointAttempt) {
        discardedAttempt = attempt;
        return Promise.resolve('removed' as const);
      },
      expireAttempt() {
        expiryCalls += 1;
        return Promise.resolve('expired' as const);
      },
      inspectAttempt(attempt: PreparedProductionCheckpointAttempt) {
        assert.equal(attempt.expiresAt, '9999-12-31T23:59:59.999Z');
        return Promise.resolve(Object.freeze({ artifacts: [], attempt }));
      },
      prepareAttempt(input: PreparedProductionCheckpointAttempt) {
        storedAttempt = input;
        return Promise.resolve(input);
      },
      readArtifact: () => Promise.resolve(),
      releaseAttemptReservation: () => Promise.resolve(),
      receiveArtifact: () => Promise.reject(new Error('unexpected-receive')),
    } satisfies LifecycleCheckpointPublicationStore;
    const publication = new LifecycleCheckpointPublication(store, 'backup');

    assert.deepEqual(await publication.prepareAttempt(external), external);
    assert.equal(storedAttempt?.expiresAt, '9999-12-31T23:59:59.999Z');
    assert.deepEqual(await publication.inspectAttempt(external), {
      artifacts: [],
      attempt: external,
    });
    assert.equal(await publication.expireAttempt(
      external,
      '2030-01-01T00:00:00.000Z',
    ), 'retained');
    assert.equal(expiryCalls, 0);
    assert.equal(await publication.discardAttempt(external), 'removed');
    assert.equal(discardedAttempt?.expiresAt, '9999-12-31T23:59:59.999Z');
  });

  it('rejects a contradictory prepared identity before retained read or cleanup', async () => {
    let calls = 0;
    const store = {
      discardAttempt: () => {
        calls += 1;
        return Promise.resolve('removed' as const);
      },
      expireAttempt: () => Promise.resolve('retained' as const),
      inspectAttempt: () => {
        calls += 1;
        return Promise.reject(new Error('unexpected-inspect'));
      },
      prepareAttempt: () => Promise.reject(new Error('unexpected-prepare')),
      readArtifact: () => {
        calls += 1;
        return Promise.resolve();
      },
      releaseAttemptReservation: () => Promise.resolve(),
      receiveArtifact: () => Promise.reject(new Error('unexpected-receive')),
    } satisfies LifecycleCheckpointPublicationStore;
    const publication = new LifecycleCheckpointPublication(store, 'backup');
    const contradictory = Object.freeze({
      ...productionCheckpointAttemptIdentity({
        expiresAt: '2026-08-29T00:00:00.000Z',
        operationId: 'backup-one',
        projectId: 'project-a',
      }),
      attemptKey: 'a'.repeat(64),
    });

    await assert.rejects(
      publication.inspectAttempt(contradictory),
      /production-checkpoint-staging\.error\.invalid-attempt/u,
    );
    await assert.rejects(
      publication.discardAttempt(contradictory),
      /production-checkpoint-staging\.error\.invalid-attempt/u,
    );
    assert.equal(calls, 0);
  });

  it('detaches the staging reservation after caller cancellation', async () => {
    const controller = new AbortController();
    const external = productionCheckpointAttemptIdentity({
      expiresAt: '2026-08-29T00:00:00.000Z',
      operationId: 'backup-cancelled',
      projectId: 'project-a',
    });
    let releases = 0;
    const store = {
      discardAttempt: () => Promise.resolve('removed' as const),
      expireAttempt: () => Promise.resolve('retained' as const),
      inspectAttempt: () => Promise.resolve(Object.freeze({
        artifacts: [],
        attempt: external,
      })),
      prepareAttempt: (input: PreparedProductionCheckpointAttempt) => (
        Promise.resolve(input)
      ),
      readArtifact: () => Promise.resolve(),
      releaseAttemptReservation(
        _attempt: PreparedProductionCheckpointAttempt,
        signal?: AbortSignal,
      ) {
        if (signal?.aborted === true) {
          return Promise.reject(new ProductionCheckpointStagingError('cancelled'));
        }
        releases += 1;
        return Promise.resolve();
      },
      receiveArtifact(input: Parameters<
        ProductionCheckpointStagingPort['receiveArtifact']
      >[0]) {
        controller.abort();
        return Promise.resolve(Object.freeze({
          attemptKey: input.attempt.attemptKey,
          byteCount: input.expectedByteCount,
          name: input.artifact,
          operationId: input.attempt.operationId,
          projectId: input.attempt.projectId,
          sha256: input.expectedSha256,
        }));
      },
    } satisfies LifecycleCheckpointPublicationStore;
    const publication = new LifecycleCheckpointPublication(store, 'backup');
    const payload = Buffer.from('cancelled-publication');

    const artifact = await publication.receiveArtifact({
      artifact: 'coordination.ndjson',
      attempt: external,
      body: Readable.from([]),
      expectedByteCount: payload.length,
      expectedSha256: createHash('sha256').update(payload).digest('hex'),
      signal: controller.signal,
    });

    assert.equal(artifact.byteCount, payload.length);
    assert.equal(releases, 1);
  });

  it('keeps export delivery bounded by its exact TTL and cleanup identity', async () => {
    const external = productionCheckpointAttemptIdentity({
      expiresAt: '2026-08-29T00:00:00.000Z',
      operationId: 'export-one',
      projectId: 'project-a',
    });
    let prepared: PreparedProductionCheckpointAttempt | undefined;
    let discarded: PreparedProductionCheckpointAttempt | undefined;
    let registered: Readonly<{
      readonly attempt: PreparedProductionCheckpointAttempt;
      readonly expiresAt: string;
    }> | undefined;
    const store = {
      discardAttempt(attempt: PreparedProductionCheckpointAttempt) {
        discarded = attempt;
        return Promise.resolve('removed' as const);
      },
      expireAttempt: () => Promise.resolve('retained' as const),
      inspectAttempt: () => Promise.resolve(Object.freeze({
        artifacts: [],
        attempt: external,
      })),
      prepareAttempt(input: PreparedProductionCheckpointAttempt) {
        prepared = input;
        return Promise.resolve(input);
      },
      registerAttemptDelivery(input: Readonly<{
        readonly attempt: PreparedProductionCheckpointAttempt;
        readonly expiresAt: string;
      }>) {
        registered = input;
        return Promise.resolve('registered' as const);
      },
      listDueAttemptDeliveries: () => Promise.resolve(Object.freeze({
        deliveries: Object.freeze([]),
        nextCursor: undefined,
      })),
      readArtifact: () => Promise.resolve(),
      releaseAttemptReservation: () => Promise.resolve(),
      receiveArtifact: () => Promise.reject(new Error('unexpected-receive')),
    } satisfies LifecycleCheckpointPublicationStore;
    const publication = new LifecycleCheckpointPublication(store, 'export');

    assert.deepEqual(await publication.prepareAttempt(external), external);
    assert.equal(prepared?.expiresAt, '9999-12-31T23:59:59.999Z');
    assert.equal(await publication.registerDelivery(external), 'registered');
    assert.equal(registered?.attempt.expiresAt, '9999-12-31T23:59:59.999Z');
    assert.equal(registered.expiresAt, external.expiresAt);
    assert.equal(await publication.expireAttempt(
      external,
      external.expiresAt,
    ), 'expired');
    assert.ok(discarded);
    assert.equal(discarded.expiresAt, '9999-12-31T23:59:59.999Z');
    assert.equal(await publication.discardAttempt(external), 'removed');
    assert.equal(discarded.expiresAt, '9999-12-31T23:59:59.999Z');
  });

  it('keeps a registered export recovery-readable after TTL and enumerates it after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-export-publication-'));
    let now = new Date('2026-08-28T00:00:00.000Z');
    const external = productionCheckpointAttemptIdentity({
      expiresAt: '2026-08-29T00:00:00.000Z',
      operationId: 'export-restart',
      projectId: 'project-a',
    });
    const payload = Buffer.from('retained-export\n');
    let owners = realPublication(root, () => new Date(now), 'export');
    try {
      const attempt = await owners.publication.prepareAttempt(external);
      await owners.publication.receiveArtifact({
        artifact: 'coordination.ndjson',
        attempt,
        body: Readable.from([payload]),
        expectedByteCount: payload.length,
        expectedSha256: createHash('sha256').update(payload).digest('hex'),
      });
      assert.equal(
        await owners.publication.registerDelivery(external),
        'registered',
      );
      await owners.staging.close();
      await owners.admission.close();

      now = new Date('2030-01-01T00:00:00.000Z');
      owners = realPublication(root, () => new Date(now), 'export');
      const inspected = await owners.publication.inspectAttempt(external);
      assert.equal(inspected.artifacts[0]?.name, 'coordination.ndjson');
      const page = await owners.publication.listDueDeliveries({
        expiredBefore: '2030-01-01T00:00:00.000Z',
        limit: 10,
      });
      assert.deepEqual(page.deliveries, [external]);
      assert.equal(page.nextCursor, undefined);
      assert.equal(
        await owners.publication.expireAttempt(
          external,
          '2030-01-01T00:00:00.000Z',
        ),
        'expired',
      );
      await assert.rejects(
        owners.publication.inspectAttempt(external),
        /production-checkpoint-staging\.error\.storage-unavailable/u,
      );
    } finally {
      await owners.staging.close().catch(() => undefined);
      await owners.admission.close().catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  });

  it('pages durable export deliveries in the same canonical cursor order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-export-pages-'));
    const now = new Date('2026-08-28T00:00:00.000Z');
    const owners = realPublication(root, () => new Date(now), 'export');
    try {
      for (const operationId of ['export-a', 'export_a', 'exportZ']) {
        const attempt = productionCheckpointAttemptIdentity({
          expiresAt: '2026-08-29T00:00:00.000Z',
          operationId,
          projectId: 'project-a',
        });
        await owners.publication.prepareAttempt(attempt);
        await owners.publication.registerDelivery(attempt);
      }
      const operationIds: string[] = [];
      let after;
      do {
        const page = await owners.publication.listDueDeliveries({
          ...(after === undefined ? {} : { after }),
          expiredBefore: '2030-01-01T00:00:00.000Z',
          limit: 1,
        });
        operationIds.push(...page.deliveries.map(item => item.operationId));
        after = page.nextCursor;
      } while (after !== undefined);
      assert.deepEqual(operationIds, ['export-a', 'exportZ', 'export_a']);
    } finally {
      await owners.staging.close().catch(() => undefined);
      await owners.admission.close().catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  });
});
