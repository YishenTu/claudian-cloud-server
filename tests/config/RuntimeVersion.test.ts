import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertSupportedNodeVersion,
  RuntimeVersionError,
} from '../../src/config/RuntimeVersion.js';

describe('assertSupportedNodeVersion', () => {
  it('accepts Node 24 and rejects other major versions without exposing input', () => {
    assert.doesNotThrow(() => assertSupportedNodeVersion('24.16.0'));

    assert.throws(
      () => assertSupportedNodeVersion('26.5.0'),
      (error: unknown) => {
        assert.equal(error instanceof RuntimeVersionError, true);
        assert.deepEqual((error as RuntimeVersionError).toJSON(), {
          code: 'unsupported-node-version',
          message: 'runtime.error.unsupported-node-version',
          name: 'RuntimeVersionError',
        });
        assert.equal(JSON.stringify(error).includes('26.5.0'), false);
        return true;
      },
    );
  });
});
