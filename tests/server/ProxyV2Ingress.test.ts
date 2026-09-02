import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { RequestPrincipalBinding } from '../../src/request-context/RequestPrincipalBinding.js';
import { TrustedPrincipalProvider } from '../../src/request-context/TrustedPrincipalProvider.js';
import {
  HttpServer,
  type HttpRouteHandler,
} from '../../src/server/HttpServer.js';
import { ProxyV2Ingress } from '../../src/server/ProxyV2Ingress.js';

const running = new Set<HttpServer>();

afterEach(async () => {
  await Promise.all([...running].map(server => server.close(1_000)));
  running.clear();
});

describe('ProxyV2Ingress', () => {
  it('binds only an exact mapped fragmented PROXY v2 source assertion', async () => {
    const ingress = new ProxyV2Ingress({
      preambleTimeoutMs: 1_000,
      principals: [{
        assertion: {
          deviceCredentialId: 'mac-a',
          principalId: 'account-a',
          provenance: {
            kind: 'operator-protected-channel',
            providerId: 'tailscale-serve',
          },
        },
        sourceAddress: '100.64.0.10',
      }],
    });
    const binding = new RequestPrincipalBinding({
      trustedPrincipal: {
        establishedAssertion: request => ingress.establishedAssertion(request),
        provider: new TrustedPrincipalProvider(),
      },
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      connectionIngress: ingress,
      isReady: () => true,
      routes: [new PrincipalRoute(binding)],
    });
    running.add(server);
    const address = await server.start();
    const frame = proxyV2Ipv4Frame('100.64.0.10');
    const response = await rawRequest(address.port, [
      frame.subarray(0, 5),
      frame.subarray(5, 15),
      frame.subarray(15),
      Buffer.from('GET /principal HTTP/1.1\r\nHost: cloud\r\nConnection: close\r\n\r\n'),
    ]);

    assert.match(response, /^HTTP\/1\.1 200 OK/mu);
    assert.match(response, /account-a:mac-a/u);
  });

  it('binds a mapped assertion when the PROXY frame and HTTP request coalesce', async () => {
    const ingress = ingressFor('100.64.0.10');
    const binding = bindingFor(ingress);
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      connectionIngress: ingress,
      isReady: () => true,
      routes: [new PrincipalRoute(binding)],
    });
    running.add(server);
    const address = await server.start();
    const response = await rawRequest(address.port, [Buffer.concat([
      proxyV2Ipv4Frame('100.64.0.10'),
      Buffer.from('GET /principal HTTP/1.1\r\nHost: cloud\r\nConnection: close\r\n\r\n'),
    ])]);

    assert.match(response, /^HTTP\/1\.1 200 OK/mu);
    assert.match(response, /account-a:/u);
  });

  it('keeps public health available to raw loopback requests without establishing identity', async () => {
    const ingress = ingressFor('100.64.0.10');
    const binding = bindingFor(ingress);
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      connectionIngress: ingress,
      isReady: () => true,
      routes: [new PrincipalRoute(binding)],
    });
    running.add(server);
    const address = await server.start();

    const health = await fetch(`http://127.0.0.1:${String(address.port)}/livez`);
    assert.equal(health.status, 200);
    const protectedResponse = await fetch(
      `http://127.0.0.1:${String(address.port)}/principal`,
      { headers: { 'x-claudian-trusted-principal': 'account-a' } },
    );
    assert.equal(protectedResponse.status, 401);
  });

  it('closes unmapped, TLV-bearing, and duplicate PROXY v2 assertions', async () => {
    const ingress = ingressFor('100.64.0.10');
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      connectionIngress: ingress,
      isReady: () => true,
    });
    running.add(server);
    const address = await server.start();
    const request = Buffer.from('GET /livez HTTP/1.1\r\nHost: cloud\r\nConnection: close\r\n\r\n');

    const unmapped = await rawRequest(address.port, [
      proxyV2Ipv4Frame('100.64.0.11'),
      request,
    ]);
    assert.equal(unmapped, '');

    const withTlv = proxyV2Ipv4Frame('100.64.0.10', Buffer.from([0x01]));
    assert.equal(await rawRequest(address.port, [withTlv, request]), '');

    const frame = proxyV2Ipv4Frame('100.64.0.10');
    assert.equal(await rawRequest(address.port, [frame, frame, request]), '');
  });

  it('contains connection reset while a PROXY signature prefix is buffered', async () => {
    const ingress = ingressFor('100.64.0.10');
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      connectionIngress: ingress,
      isReady: () => true,
    });
    running.add(server);
    const address = await server.start();
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write(Buffer.from([0x0d, 0x0a]));
    socket.resetAndDestroy();
    await once(socket, 'close');
    await new Promise<void>(resolve => setImmediate(resolve));

    const health = await fetch(`http://127.0.0.1:${String(address.port)}/livez`);
    assert.equal(health.status, 200);
  });

  it('bounds an incomplete PROXY signature before HTTP ownership begins', async () => {
    const ingress = new ProxyV2Ingress({
      preambleTimeoutMs: 20,
      principals: ingressPrincipals('100.64.0.10'),
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      connectionIngress: ingress,
      isReady: () => true,
    });
    running.add(server);
    const address = await server.start();
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write(Buffer.from([0x0d, 0x0a]));
    await once(socket, 'close');

    assert.equal(socket.destroyed, true);
  });

  it('closes an idle accepted keep-alive socket without spending the shutdown grace', async () => {
    const ingress = ingressFor('100.64.0.10');
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      connectionIngress: ingress,
      isReady: () => true,
    });
    running.add(server);
    const address = await server.start();
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write(Buffer.concat([
      proxyV2Ipv4Frame('100.64.0.10'),
      Buffer.from(
        'GET /livez HTTP/1.1\r\nHost: cloud\r\nConnection: keep-alive\r\n\r\n',
      ),
    ]));
    await once(socket, 'data');

    const startedAt = Date.now();
    await server.close(500);
    assert.ok(Date.now() - startedAt < 250);
    if (!socket.destroyed) await once(socket, 'close');
    assert.equal(socket.destroyed, true);
    running.delete(server);
  });
});

class PrincipalRoute implements HttpRouteHandler {
  readonly #binding: RequestPrincipalBinding;

  constructor(binding: RequestPrincipalBinding) {
    this.#binding = binding;
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.url !== '/principal') return false;
    try {
      const principal = this.#binding.bind(request);
      const body = `${principal.principalId}:${'deviceCredentialId' in principal
        ? principal.deviceCredentialId ?? ''
        : ''}`;
      response.writeHead(200, { 'content-length': Buffer.byteLength(body) });
      response.end(body);
    } catch {
      response.writeHead(401, { 'content-length': 0 });
      response.end();
    }
    return true;
  }
}

function ingressFor(sourceAddress: string): ProxyV2Ingress {
  return new ProxyV2Ingress({
    preambleTimeoutMs: 1_000,
    principals: ingressPrincipals(sourceAddress),
  });
}

function ingressPrincipals(sourceAddress: string) {
  return [{
      assertion: {
        principalId: 'account-a',
        provenance: {
          kind: 'operator-protected-channel',
          providerId: 'tailscale-serve',
        },
      },
      sourceAddress,
    }] as const;
}

function bindingFor(ingress: ProxyV2Ingress): RequestPrincipalBinding {
  return new RequestPrincipalBinding({
    trustedPrincipal: {
      establishedAssertion: request => ingress.establishedAssertion(request),
      provider: new TrustedPrincipalProvider(),
    },
  });
}

function proxyV2Ipv4Frame(source: string, tlv = Buffer.alloc(0)): Buffer {
  const sourceBytes = Buffer.from(source.split('.').map(Number));
  const address = Buffer.concat([
    sourceBytes,
    Buffer.from([127, 0, 0, 1]),
    Buffer.from([0xc3, 0x50, 0x22, 0x53]),
    tlv,
  ]);
  const frame = Buffer.alloc(16);
  Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a])
    .copy(frame);
  frame[12] = 0x21;
  frame[13] = 0x11;
  frame.writeUInt16BE(address.length, 14);
  return Buffer.concat([frame, address]);
}

async function rawRequest(port: number, chunks: readonly Buffer[]): Promise<string> {
  const socket = createConnection({ host: '127.0.0.1', port });
  const received: Buffer[] = [];
  let unexpectedError: Error | undefined;
  socket.on('data', chunk => received.push(Buffer.from(chunk)));
  socket.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ECONNRESET') unexpectedError = error;
  });
  await once(socket, 'connect');
  for (const chunk of chunks) {
    socket.write(chunk);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  socket.end();
  await new Promise<void>(resolve => socket.once('close', () => resolve()));
  if (unexpectedError !== undefined) throw unexpectedError;
  return Buffer.concat(received).toString('utf8');
}
