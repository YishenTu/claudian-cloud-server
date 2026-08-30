import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DevelopmentPrincipalAdapter,
  DevelopmentPrincipalError,
} from '../../src/request-context/DevelopmentPrincipalAdapter.js';

function bind(overrides: Readonly<{
  headerValues?: readonly string[];
  localAddress?: string;
  remoteAddress?: string;
}> = {}) {
  return new DevelopmentPrincipalAdapter({
    profile: 'loopback-development',
  }).bind({
    headerValues: overrides.headerValues ?? ['member_1'],
    localAddress: overrides.localAddress ?? '127.0.0.1',
    remoteAddress: overrides.remoteAddress ?? '127.0.0.1',
  });
}

describe('DevelopmentPrincipalAdapter', () => {
  it('binds one exact loopback assertion to an immutable principal', () => {
    const principal = bind();
    assert.deepEqual(principal, {
      principalId: 'member_1',
      provenance: { kind: 'private-development' },
    });
    assert.equal(Object.isFrozen(principal), true);
    assert.equal(Object.isFrozen(principal.provenance), true);
  });

  it('rejects missing, duplicate, malformed, nondevelopment, and nonloopback assertions', () => {
    const secret = 'private-actor-sentinel';
    const operations = [
      () => bind({ headerValues: [] }),
      () => bind({ headerValues: ['member_1', 'member_2'] }),
      () => bind({ headerValues: [`../${secret}`] }),
      () => bind({ remoteAddress: '100.64.0.1' }),
      () => bind({ localAddress: '0.0.0.0' }),
      () => new DevelopmentPrincipalAdapter({ profile: 'external' }).bind({
        headerValues: [secret],
        localAddress: '127.0.0.1',
        remoteAddress: '127.0.0.1',
      }),
    ];

    for (const operation of operations) {
      assert.throws(operation, error => {
        assert.ok(error instanceof DevelopmentPrincipalError);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      });
    }
  });

  it('accepts canonical IPv6 loopback forms without deriving identity from them', () => {
    assert.equal(bind({
      localAddress: '::1',
      remoteAddress: '::ffff:127.0.0.1',
    }).principalId, 'member_1');
  });
});
