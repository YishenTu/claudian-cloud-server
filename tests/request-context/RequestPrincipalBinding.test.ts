import assert from 'node:assert/strict';
import { Agent, request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';

import { DevelopmentPrincipalAdapter } from '../../src/request-context/DevelopmentPrincipalAdapter.js';
import {
  RequestPrincipalBinding,
  RequestPrincipalBindingError,
} from '../../src/request-context/RequestPrincipalBinding.js';
import { HttpServer } from '../../src/server/HttpServer.js';

describe('RequestPrincipalBinding', () => {
  it('authenticates the Vault credential without an ingress assertion', () => {
    const binding = new RequestPrincipalBinding({});
    const principal = binding.bind({
      rawHeaders: ['Authorization', `Bearer ${'a'.repeat(64)}`],
      socket: {},
    } as never);
    assert.deepEqual(principal, {
      principalId: 'vault-ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
      provenance: { kind: 'vault-credential' },
    });
  });

  it('keeps the explicit development binding separate', () => {
    const development = new RequestPrincipalBinding({
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
    });
    assert.equal(development.bind({
      rawHeaders: ['X-Claudian-Development-Actor', 'member-development'],
      socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' },
    } as never).provenance.kind, 'private-development');

    assert.throws(() => development.bind({
      rawHeaders: [],
      socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' },
    } as never), RequestPrincipalBindingError);
  });

  it('never accepts a claimed identity in place of credential possession', () => {
    const binding = new RequestPrincipalBinding({});
    const headers = [
      'X-Claudian-Ingress-Principal', 'vault-other-member',
      'X-Claudian-Ingress-Device-Credential', 'other-device',
      'X-Claudian-Development-Actor', 'member-manager',
    ];
    assert.throws(() => binding.bind({ rawHeaders: headers } as never), RequestPrincipalBindingError);
    assert.deepEqual(binding.bind({
      rawHeaders: [...headers, 'authorization', `bEaReR ${'a'.repeat(64)}`],
    } as never), {
      principalId: 'vault-ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
      provenance: { kind: 'vault-credential' },
    });
  });

  it('rejects missing, duplicate, combined, and malformed credentials with sanitized errors', () => {
    const credential = 'a'.repeat(64);
    for (const rawHeaders of [
      [],
      ['Authorization', `Bearer ${credential}`, 'authorization', `Bearer ${credential}`],
      ['Authorization', `Bearer ${credential}, Bearer ${credential}`],
      ['Authorization', `Basic ${credential}`],
      ['Authorization', `Bearer ${credential.toUpperCase()}`],
      ['Authorization', `Bearer ${credential.slice(1)}`],
      ['Authorization', `Bearer ${credential}a`],
      ['Authorization', `Bearer  ${credential}`],
      ['Authorization', `Bearer ${credential}\n`],
      ['Authorization', `Bearer vault-${credential}`],
    ]) {
      assert.throws(() => new RequestPrincipalBinding({}).bind({ rawHeaders } as never), (error: unknown) => {
        assert.ok(error instanceof RequestPrincipalBindingError);
        assert.equal(error.message, 'request-principal-binding.error.invalid-credential');
        assert.equal(JSON.stringify(error).includes(credential), false);
        assert.equal(error.stack?.includes(credential), false);
        return true;
      });
    }
  });

  it('binds credentials per request over a reused ordinary HTTP connection', async () => {
    const binding = new RequestPrincipalBinding({});
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      routes: [{
        handle: (request, response) => {
          try {
            response.end(binding.bind(request).principalId);
          } catch {
            response.writeHead(403);
            response.end('invalid-credential');
          }
          return true;
        },
      }],
    });
    const address = await server.start();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const submit = (headers: readonly string[]) => new Promise<{
      readonly body: string;
      readonly reused: boolean;
      readonly status: number | undefined;
    }>((resolve, reject) => {
      const request = httpRequest({
        agent, headers: ['Host', 'localhost', ...headers], host: address.host, path: '/identity', port: address.port,
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.once('error', reject);
        response.once('end', () => resolve({ body, reused: request.reusedSocket, status: response.statusCode }));
      });
      request.once('error', reject);
      request.end();
    });
    try {
      assert.deepEqual(await submit(['Authorization', `Bearer ${'a'.repeat(64)}`]), {
        body: 'vault-ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
        reused: false, status: 200,
      });
      assert.deepEqual(await submit(['Authorization', `Bearer ${'b'.repeat(64)}`]), {
        body: 'vault-a0fab1377f49a759b57f63318262ebe89fabfc990e8e93ceac2984561482b9d4',
        reused: true, status: 200,
      });
      assert.deepEqual(await submit([]), { body: 'invalid-credential', reused: true, status: 403 });
      assert.deepEqual(await submit([
        'Authorization', `Bearer ${'a'.repeat(64)}`, 'authorization', `Bearer ${'b'.repeat(64)}`,
      ]), { body: 'invalid-credential', reused: true, status: 403 });
    } finally {
      agent.destroy();
      await server.close(1_000);
    }
  });
});
