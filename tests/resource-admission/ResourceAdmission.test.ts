import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ResourceAdmission,
  ResourceAdmissionError,
} from '../../src/resource-admission/ResourceAdmission.js';

function createAdmission(queueTimeoutMs = 100): ResourceAdmission {
  return new ResourceAdmission({
    maxChildren: 3,
    maxChildrenPerProject: 2,
    queueMax: 4,
    queueMaxPerProject: 2,
    queueTimeoutMs,
  });
}

async function expectAdmissionError(
  promise: Promise<unknown>,
  code: ResourceAdmissionError['code'],
): Promise<void> {
  await assert.rejects(
    promise,
    error => {
      assert.ok(error instanceof ResourceAdmissionError);
      assert.equal(error.code, code);
      assert.deepEqual(error.toJSON(), {
        code,
        message: `resource-admission.error.${code}`,
        name: 'ResourceAdmissionError',
        retryable: code === 'busy',
      });
      return true;
    },
  );
}

describe('ResourceAdmission', () => {
  it('preserves Project headroom and eligible FIFO progress', async () => {
    const admission = createAdmission();
    const projectARead = await admission.acquireGitChild({
      classification: 'read',
      projectId: 'project-a',
    });
    const projectAWrite = await admission.acquireGitChild({
      classification: 'write',
      projectId: 'project-a',
    });

    const order: string[] = [];
    const queuedA = admission.acquireGitChild({
      classification: 'read',
      projectId: 'project-a',
    }).then(permit => {
      order.push('project-a');
      return permit;
    });

    const projectB = await admission.acquireGitChild({
      classification: 'read',
      projectId: 'project-b',
    });
    const queuedC = admission.acquireGitChild({
      classification: 'write',
      projectId: 'project-c',
    }).then(permit => {
      order.push('project-c');
      return permit;
    });

    projectARead.release();
    const nextA = await queuedA;
    assert.deepEqual(order, ['project-a']);

    projectB.release();
    const nextC = await queuedC;
    assert.deepEqual(order, ['project-a', 'project-c']);

    projectARead.release();
    projectAWrite.release();
    nextA.release();
    nextC.release();
    await admission.close();
  });

  it('bounds queues, deadlines, and cancellation without leaking permits', async () => {
    const admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 25,
    });
    const projectA = await admission.acquireGitChild({
      classification: 'read',
      projectId: 'project-a',
    });
    const projectB = await admission.acquireGitChild({
      classification: 'write',
      projectId: 'project-b',
    });

    const cancellation = new AbortController();
    const queuedA = admission.acquireGitChild({
      classification: 'read',
      projectId: 'project-a',
      signal: cancellation.signal,
    });
    await expectAdmissionError(
      admission.acquireGitChild({
        classification: 'write',
        projectId: 'project-a',
      }),
      'busy',
    );

    const queuedC = admission.acquireGitChild({
      classification: 'read',
      projectId: 'project-c',
    });
    await expectAdmissionError(
      admission.acquireGitChild({
        classification: 'read',
        projectId: 'project-d',
      }),
      'busy',
    );

    cancellation.abort();
    await expectAdmissionError(queuedA, 'cancelled');
    await expectAdmissionError(queuedC, 'busy');

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expectAdmissionError(
      admission.acquireGitChild({
        classification: 'read',
        projectId: 'project-c',
        signal: alreadyCancelled.signal,
      }),
      'cancelled',
    );

    projectA.release();
    projectB.release();
    const recovered = await admission.acquireGitChild({
      classification: 'read',
      projectId: 'project-c',
    });
    recovered.release();
    await admission.close();
  });

  it('closes queued and future work and drains active permits exactly once', async () => {
    const admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 100,
    });
    const projectA = await admission.acquireGitChild({
      classification: 'read',
      projectId: 'project-a',
    });
    const projectB = await admission.acquireGitChild({
      classification: 'write',
      projectId: 'project-b',
    });
    const queued = admission.acquireGitChild({
      classification: 'read',
      projectId: 'project-c',
    });

    const close = admission.close();
    assert.equal(admission.close(), close);
    await expectAdmissionError(queued, 'closed');
    await expectAdmissionError(
      admission.acquireGitChild({
        classification: 'read',
        projectId: 'project-d',
      }),
      'closed',
    );

    let drained = false;
    void close.then(() => {
      drained = true;
    });
    projectA.release();
    projectA.release();
    await Promise.resolve();
    assert.equal(drained, false);

    projectB.release();
    projectB.release();
    await close;
    assert.equal(drained, true);
  });

  it('rejects invalid Project identifiers without reflecting them', async () => {
    const admission = createAdmission();
    const secret = '../private-project-path';
    await expectAdmissionError(
      admission.acquireGitChild({
        classification: 'read',
        projectId: secret,
      }),
      'invalid-project',
    );
    await admission.close();
  });
});
