import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TrustedPrincipalError,
  TrustedPrincipalProvider,
} from '../../src/request-context/TrustedPrincipalProvider.js';

describe('TrustedPrincipalProvider', () => {
  it('binds one exact established assertion to an immutable principal', () => {
    const principal = new TrustedPrincipalProvider().bind({
      deviceCredentialId: 'device:macbook-a',
      principalId: 'account:alice',
      provenance: {
        kind: 'operator-protected-channel',
        providerId: 'managed:primary',
      },
    });

    assert.deepEqual(principal, {
      deviceCredentialId: 'device:macbook-a',
      principalId: 'account:alice',
      provenance: {
        kind: 'operator-protected-channel',
        providerId: 'managed:primary',
      },
    });
    assert.equal(Object.isFrozen(principal), true);
    assert.equal(Object.isFrozen(principal.provenance), true);
  });

  it('accepts an established self-hosted principal without device attribution', () => {
    assert.deepEqual(new TrustedPrincipalProvider().bind({
      principalId: 'self-hosted:alice',
      provenance: {
        kind: 'operator-protected-channel',
        providerId: 'self-hosted:primary',
      },
    }), {
      principalId: 'self-hosted:alice',
      provenance: {
        kind: 'operator-protected-channel',
        providerId: 'self-hosted:primary',
      },
    });
  });

  it('rejects malformed, unprovenanced, and client-shaped assertions safely', () => {
    const secret = 'private-principal-sentinel';
    const provider = new TrustedPrincipalProvider();
    const assertions: readonly unknown[] = [
      undefined,
      {},
      {
        principalId: `../${secret}`,
        provenance: {
          kind: 'operator-protected-channel',
          providerId: 'managed:primary',
        },
      },
      {
        deviceCredentialId: '',
        principalId: 'account:alice',
        provenance: {
          kind: 'operator-protected-channel',
          providerId: 'managed:primary',
        },
      },
      {
        principalId: 'account:alice',
        provenance: {
          kind: 'private-development',
          providerId: 'managed:primary',
        },
      },
      {
        principalId: 'account:alice',
        provenance: {
          kind: 'operator-protected-channel',
          providerId: `../${secret}`,
        },
      },
      {
        headerValues: ['account:alice'],
        localAddress: '127.0.0.1',
        principalId: 'account:alice',
        provenance: {
          kind: 'operator-protected-channel',
          providerId: 'managed:primary',
        },
        remoteAddress: '127.0.0.1',
      },
      {
        principalId: 'account:alice',
        provenance: {
          kind: 'operator-protected-channel',
          providerId: 'managed:primary',
        },
        role: 'manager',
      },
    ];

    for (const assertion of assertions) {
      assert.throws(() => provider.bind(assertion), error => {
        assert.ok(error instanceof TrustedPrincipalError);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      });
    }
  });
});
