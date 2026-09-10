import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COLLAB_CHECKPOINT_ARTIFACT_LIMITS } from '@claudian-collab/protocol';

import { decodeServerConfig } from '../../src/config/ServerConfig.js';
import { BootstrapUploadAdmission } from '../../src/resource-admission/BootstrapUploadAdmission.js';
import { CheckpointStreamAdmission } from '../../src/resource-admission/CheckpointStreamAdmission.js';
import { ProjectEventAdmission } from '../../src/resource-admission/ProjectEventAdmission.js';
import { ResourceAdmission } from '../../src/resource-admission/ResourceAdmission.js';

const source = {
  CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
  CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
  CLAUDIAN_CLOUD_PORT: '8787',
  CLAUDIAN_CLOUD_POSTGRES_URL: 'postgresql://runtime:synthetic@127.0.0.1/cloud',
  CLAUDIAN_CLOUD_PRINCIPAL_PROFILE: 'private-development',
  CLAUDIAN_CLOUD_REPOSITORY_ROOT: '/srv/cloud/repositories',
  CLAUDIAN_CLOUD_STAGING_ROOT: '/srv/cloud/staging',
  CLAUDIAN_CLOUD_STORAGE_NODE_ID: 'node-a',
};

describe('configured resource capacity', () => {
  it('admits several self-hosted Projects with multiple devices under default budgets', async () => {
    const config = decodeServerConfig(source);
    const admission = new ProjectEventAdmission(config.eventAdmission);
    const connections = [];
    try {
      // Five Projects, each with twenty Members using two devices.
      for (let project = 0; project < 5; project += 1) {
        for (let device = 0; device < 40; device += 1) {
          connections.push(admission.acquirePending().promote(`project-${String(project)}`));
        }
      }
    } finally {
      connections.forEach(connection => connection.release());
      await admission.close();
    }
  });

  it('admits a larger Git workload while preserving write and Project capacity', async () => {
    const config = decodeServerConfig({
      ...source,
      CLAUDIAN_CLOUD_GIT_MAX_CHILDREN: '66',
      CLAUDIAN_CLOUD_GIT_QUEUE_MAX: '2048',
    });
    const admission = new ResourceAdmission(config.gitAdmission);
    const reads = await Promise.all(Array.from({ length: 65 }, (_, index) => (
      admission.acquireGitChild({ projectId: `project-${String(index)}`, classification: 'read' })
    )));
    const writer = await admission.acquireGitChild({ projectId: 'project-write', classification: 'write' });
    let granted = false;
    const queued = admission.acquireGitChild({ projectId: 'project-0', classification: 'read' })
      .then(permit => { granted = true; return permit; });
    writer.release();
    await Promise.resolve();
    assert.equal(granted, false);
    reads[0]?.release();
    const next = await queued;
    assert.equal(granted, true);
    next.release();
    reads.forEach(permit => permit.release());
    await admission.close();
  });

  it('enforces explicit connection budgets below the defaults', async () => {
    const config = decodeServerConfig({
      ...source,
      CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS: '32',
      CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS_PER_PROJECT: '16',
    });
    const admission = new ProjectEventAdmission(config.eventAdmission);
    const connections = [];
    try {
      for (let index = 0; index < 32; index += 1) {
        connections.push(admission.acquire(`project-${String(index % 2)}`));
      }
      assert.throws(() => admission.acquire('project-third'), { code: 'busy' });
    } finally {
      connections.forEach(connection => connection.release());
      await admission.close();
    }
  });

  it('keeps connection admission enforced with an independent authorization budget', async () => {
    const config = decodeServerConfig({
      ...source,
      CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS: '2',
      CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS_PER_PROJECT: '1',
      CLAUDIAN_CLOUD_EVENT_MAX_PENDING_AUTHORIZATIONS: '3',
    });
    const admission = new ProjectEventAdmission(config.eventAdmission);
    const pending = Array.from({ length: 3 }, () => admission.acquirePending());
    assert.throws(() => admission.acquirePending(), { code: 'busy' });
    const [pendingFirst, pendingDuplicate, pendingSecond] = pending;
    assert.ok(pendingFirst && pendingDuplicate && pendingSecond);
    const first = pendingFirst.promote('project-a');
    assert.throws(() => pendingDuplicate.promote('project-a'), { code: 'busy' });
    const second = pendingSecond.promote('project-b');
    const overflow = admission.acquirePending();
    assert.throws(() => overflow.promote('project-c'), { code: 'busy' });
    first.release();
    second.release();
    await admission.close();
  });

  it('runs bootstrap uploads concurrently without overcommitting disk or duplicating attempts', async () => {
    const config = decodeServerConfig({
      ...source,
      CLAUDIAN_CLOUD_BOOTSTRAP_MAX_CONCURRENT_UPLOADS: '3',
    }).developmentBootstrap;
    // One GiB floor plus exactly two two-GiB reservations.
    const admission = new BootstrapUploadAdmission(config, {
      availableBytes: () => Promise.resolve(5n * 1_073_741_824n),
    });
    const [first, second] = await Promise.all([
      admission.acquire({ attemptId: 'attempt-a' }),
      admission.acquire({ attemptId: 'attempt-b' }),
    ]);
    await assert.rejects(admission.acquire({ attemptId: 'attempt-a' }), { code: 'busy' });
    await assert.rejects(admission.acquire({ attemptId: 'attempt-c' }), { code: 'busy' });
    first.release();
    const third = await admission.acquire({ attemptId: 'attempt-c' });
    let drained = false;
    const close = admission.close().then(() => { drained = true; });
    second.release();
    await Promise.resolve();
    assert.equal(drained, false);
    third.release();
    await close;
  });

  it('expands checkpoint streams while retaining per-Project and staging admission', async () => {
    const config = decodeServerConfig({
      ...source,
      CLAUDIAN_CLOUD_CHECKPOINT_MAX_CONCURRENT_STREAMS: '3',
      CLAUDIAN_CLOUD_CHECKPOINT_MAX_STAGING_ATTEMPTS: '4',
      CLAUDIAN_CLOUD_CHECKPOINT_QUEUE_MAX: '4',
    });
    const admission = new CheckpointStreamAdmission({
      ...config.checkpointAdmission,
      capacityTimeoutMs: 100,
      freeSpaceFloorBytes: 1,
      queueTimeoutMs: 100,
      stagingReservationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
      stagingRoot: '/srv/cloud/staging',
    }, { availableBytes: () => Promise.resolve(32n * 1_073_741_824n) });
    const identities = ['a', 'b', 'c', 'd'].map(id => ({ projectId: `project-${id}`, operationId: `operation-${id}` }));
    const reservations = await Promise.all(identities.map(identity => admission.reserveAttempt(identity)));
    await assert.rejects(admission.reserveAttempt({ projectId: 'project-a', operationId: 'operation-other' }), { code: 'busy' });
    const acquire = (index: number) => {
      const identity = identities[index];
      assert.ok(identity);
      return admission.acquire({
        ...identity, artifact: 'checkpoint.json', direction: 'upload', expectedByteCount: 1,
      });
    };
    const streams = await Promise.all([acquire(0), acquire(1), acquire(2)]);
    let granted = false;
    const queued = acquire(3).then(permit => { granted = true; return permit; });
    await Promise.resolve();
    assert.equal(granted, false);
    streams[0].release();
    const next = await queued;
    next.release();
    streams.forEach(permit => permit.release());
    reservations.forEach(reservation => reservation.release());
    await admission.close();
  });
});
