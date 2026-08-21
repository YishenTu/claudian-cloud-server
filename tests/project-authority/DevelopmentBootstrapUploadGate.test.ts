import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  DevelopmentBootstrapUploadGate,
  DevelopmentBootstrapUploadGateError,
} from '../../src/project-authority/lifecycle/DevelopmentBootstrapUploadGate.js';

it('closes and drains admitted staging before allowing terminal rechecks', async () => {
  const gate = new DevelopmentBootstrapUploadGate();
  const first = gate.acquire('attempt_1');
  let drained = false;
  const closing = gate.closeAndDrain('attempt_1').then(() => {
    drained = true;
  });

  assert.equal(drained, false);
  assert.throws(() => gate.acquire('attempt_1'), error => {
    assert.ok(error instanceof DevelopmentBootstrapUploadGateError);
    assert.equal(error.code, 'closed');
    return true;
  });

  first.release();
  await closing;
  assert.equal(drained, true);

  const terminalRecheck = gate.acquire('attempt_1');
  terminalRecheck.release();
});
