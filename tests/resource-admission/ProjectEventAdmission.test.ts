import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ProjectEventAdmission,
} from '../../src/resource-admission/ProjectEventAdmission.js';
import { ResourceAdmissionError } from '../../src/resource-admission/ResourceAdmission.js';

function expectBusy(operation: () => unknown): void {
  assert.throws(operation, error => {
    assert.ok(error instanceof ResourceAdmissionError);
    assert.equal(error.code, 'busy');
    return true;
  });
}

describe('ProjectEventAdmission', () => {
  it('bounds pending authorization independently and promotes exactly once', async () => {
    const admission = new ProjectEventAdmission({
      maxConnections: 2,
      maxConnectionsPerProject: 1,
      maxPendingAuthorizations: 1,
    });
    const pending = admission.acquirePending();
    expectBusy(() => admission.acquirePending());
    const projectA = pending.promote('project-a');
    assert.throws(() => pending.promote('project-b'));

    const nextPending = admission.acquirePending();
    nextPending.release();
    nextPending.release();
    projectA.release();
    await admission.close();
  });

  it('reserves connection capacity for another Project and drains exactly once', async () => {
    const admission = new ProjectEventAdmission({
      maxConnections: 2,
      maxConnectionsPerProject: 1,
    });
    const projectA = admission.acquire('project-a');
    expectBusy(() => admission.acquire('project-a'));
    const projectB = admission.acquire('project-b');
    expectBusy(() => admission.acquire('project-c'));

    const close = admission.close();
    assert.equal(admission.close(), close);
    assert.throws(() => admission.acquire('project-c'), error => (
      error instanceof ResourceAdmissionError && error.code === 'closed'
    ));
    projectA.release();
    projectA.release();
    let drained = false;
    void close.then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    projectB.release();
    await close;
    assert.equal(drained, true);
  });
});
