import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DevelopmentPrincipalAdapter } from '../../src/request-context/DevelopmentPrincipalAdapter.js';
import {
  RequestPrincipalBinding,
  RequestPrincipalBindingError,
} from '../../src/request-context/RequestPrincipalBinding.js';
import { TrustedPrincipalProvider } from '../../src/request-context/TrustedPrincipalProvider.js';

describe('RequestPrincipalBinding', () => {
  it('selects exactly one process-wide development or production principal source', () => {
    const development = new RequestPrincipalBinding({
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
    });
    assert.equal(development.bind({
      rawHeaders: ['X-Claudian-Development-Actor', 'member-development'],
      socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' },
    } as never).provenance.kind, 'private-development');

    const production = new RequestPrincipalBinding({
      trustedPrincipal: {
        establishedAssertion: () => ({
          principalId: 'principal-production',
          provenance: {
            kind: 'operator-protected-channel',
            providerId: 'operator-test',
          },
        }),
        provider: new TrustedPrincipalProvider(),
      },
    });
    assert.equal(production.bind({ rawHeaders: [], socket: {} } as never)
      .provenance.kind, 'operator-protected-channel');

    assert.throws(() => new RequestPrincipalBinding({} as never), TypeError);
    assert.throws(() => development.bind({
      rawHeaders: [],
      socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' },
    } as never), RequestPrincipalBindingError);
  });
});
