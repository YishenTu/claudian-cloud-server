import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import {
  collabCloudAuthorityTransferArtifactRoute,
  decodeCollabCloudErrorEnvelope,
} from '@claudian-collab/protocol';

import { DevelopmentPrincipalAdapter } from '../../src/request-context/DevelopmentPrincipalAdapter.js';
import {
  AuthorityTransferArtifactRoutes,
  type AuthorityTransferArtifactAuthority,
} from '../../src/server/transfer/AuthorityTransferArtifactRoutes.js';

const PROJECT_ID = 'project-artifact-routes';
const TRANSFER_ID = 'transfer-artifact-routes';
const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
  servers.clear();
});

async function start(
  authority: AuthorityTransferArtifactAuthority,
  operationTimeoutMs = 5_000,
  limits = {
    'checkpoint.json': 32,
    'coordination.ndjson': 64,
    'repository.bundle': 128,
  },
) {
  const routes = new AuthorityTransferArtifactRoutes({
    authority,
    limits,
    operationTimeoutMs,
    principalAdapter: new DevelopmentPrincipalAdapter({
      profile: 'loopback-development',
    }),
  });
  const server = createServer((incoming, response) => {
    if (!routes.handle(incoming, response)) {
      response.writeHead(404);
      response.end();
    }
  });
  servers.add(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('AuthorityTransferArtifactRoutes', () => {
  it('streams a bounded upload to its exact Project and transfer owner', async () => {
    let observed: unknown;
    const baseUrl = await start({
      download: () => Promise.reject(new Error('unused')),
      upload: async input => {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) {
          chunks.push(Buffer.from(chunk as Uint8Array));
        }
        observed = {
          artifact: input.artifact,
          bytes: Buffer.concat(chunks).toString('utf8'),
          principalId: input.principalId,
          projectId: input.projectId,
          transferId: input.transferId,
        };
      },
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'upload',
      'checkpoint.json',
    );
    const response = await fetch(`${baseUrl}${route.target}`, {
      body: '{"checkpoint":true}',
      headers: {
        'content-type': 'application/octet-stream',
        'x-claudian-development-actor': 'member-manager',
      },
      method: route.method,
    });
    assert.equal(response.status, 204);
    assert.deepEqual(observed, {
      artifact: 'checkpoint.json',
      bytes: '{"checkpoint":true}',
      principalId: 'member-manager',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    });
  });

  it('rejects an oversized upload before invoking the authority', async () => {
    let invoked = false;
    const baseUrl = await start({
      download: () => Promise.reject(new Error('unused')),
      upload: () => {
        invoked = true;
        return Promise.resolve();
      },
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'upload',
      'checkpoint.json',
    );
    const response = await fetch(`${baseUrl}${route.target}`, {
      body: 'x'.repeat(33),
      headers: {
        'content-type': 'application/octet-stream',
        'x-claudian-development-actor': 'member-manager',
      },
      method: route.method,
    });
    assert.equal(response.status, 413);
    assert.equal(invoked, false);
    assert.equal(
      decodeCollabCloudErrorEnvelope(await response.json()).error.code,
      'quota-exceeded',
    );
  });

  it('closes an incomplete rejected upload instead of retaining keep-alive', async () => {
    const baseUrl = await start({
      download: () => Promise.reject(new Error('unused')),
      upload: () => Promise.reject(new Error('must not execute')),
    }, 20);
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'upload',
      'checkpoint.json',
    );

    const closed = await new Promise<boolean>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}${route.target}`, {
        headers: {
          connection: 'keep-alive',
          'content-length': '33',
          'content-type': 'application/octet-stream',
          'x-claudian-development-actor': 'member-manager',
        },
        method: route.method,
      });
      request.once('error', reject);
      request.once('response', response => {
        assert.equal(response.statusCode, 413);
        response.resume();
        response.once('end', () => {
          const socket = request.socket;
          assert.ok(socket);
          if (socket.destroyed) {
            resolve(true);
            return;
          }
          const timeout = setTimeout(() => {
            socket.destroy();
            resolve(false);
          }, 100);
          timeout.unref();
          socket.once('close', () => {
            clearTimeout(timeout);
            resolve(true);
          });
        });
      });
      request.flushHeaders();
    });

    assert.equal(closed, true);
  });

  it('rejects a chunked upload that crosses the streaming limit', async () => {
    let observedFailure: unknown;
    let streamedBytes = 0;
    const baseUrl = await start({
      download: () => Promise.reject(new Error('unused')),
      upload: async input => {
        try {
          for await (const chunk of input.body) {
            streamedBytes += Buffer.byteLength(chunk as Uint8Array);
          }
        } catch (error: unknown) {
          observedFailure = error;
          throw error;
        }
      },
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'upload',
      'checkpoint.json',
    );
    const response = await fetch(`${baseUrl}${route.target}`, {
      body: Readable.from(['x'.repeat(16), 'x'.repeat(17)]),
      duplex: 'half',
      headers: {
        'content-type': 'application/octet-stream',
        'x-claudian-development-actor': 'member-manager',
      },
      method: route.method,
    } as unknown as RequestInit & { readonly duplex: 'half' });

    assert.equal(response.status, 413);
    assert.ok(observedFailure instanceof Error);
    assert.equal(streamedBytes <= 32, true);
    assert.equal(
      decodeCollabCloudErrorEnvelope(await response.json()).error.code,
      'quota-exceeded',
    );
  });

  it('streams an exact-length download without buffering the artifact', async () => {
    const artifact = Buffer.from('bundle-content', 'utf8');
    const baseUrl = await start({
      download: _input => Promise.resolve({
        body: Readable.from([artifact.subarray(0, 3), artifact.subarray(3)]),
        byteCount: artifact.byteLength,
      }),
      upload: () => Promise.reject(new Error('unused')),
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'download',
      'repository.bundle',
    );
    const response = await fetch(`${baseUrl}${route.target}`, {
      headers: { 'x-claudian-development-actor': 'member-manager' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(artifact.byteLength));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), artifact);
  });

  it('rejects a download whose declared size exceeds the artifact limit', async () => {
    const baseUrl = await start({
      download: () => Promise.resolve({
        body: Readable.from(['x']),
        byteCount: 129,
      }),
      upload: () => Promise.reject(new Error('unused')),
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'download',
      'repository.bundle',
    );
    const response = await fetch(`${baseUrl}${route.target}`, {
      headers: { 'x-claudian-development-actor': 'member-manager' },
    });

    assert.equal(response.status, 500);
    assert.equal(
      decodeCollabCloudErrorEnvelope(await response.json()).error.code,
      'operation-failed',
    );
  });

  it('terminates a download whose stream is shorter than its declared size', async () => {
    const baseUrl = await start({
      download: () => Promise.resolve({
        body: Readable.from(['short']),
        byteCount: 10,
      }),
      upload: () => Promise.reject(new Error('unused')),
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'download',
      'repository.bundle',
    );
    const response = await fetch(`${baseUrl}${route.target}`, {
      headers: { 'x-claudian-development-actor': 'member-manager' },
    });

    assert.equal(response.status, 200);
    await assert.rejects(response.arrayBuffer());
  });

  it('terminates a download before forwarding beyond its declared size', async () => {
    const baseUrl = await start({
      download: () => Promise.resolve({
        body: Readable.from(['abcdef']),
        byteCount: 5,
      }),
      upload: () => Promise.reject(new Error('unused')),
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'download',
      'repository.bundle',
    );
    await assert.rejects(async () => {
      const response = await fetch(`${baseUrl}${route.target}`, {
        headers: { 'x-claudian-development-actor': 'member-manager' },
      });
      await response.arrayBuffer();
    });
  });

  it('owns the deadline while a download owner is uncooperative', async () => {
    let signal: AbortSignal | undefined;
    const baseUrl = await start({
      download: input => {
        signal = input.signal;
        return new Promise(() => undefined);
      },
      upload: () => Promise.reject(new Error('unused')),
    }, 20);
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'download',
      'repository.bundle',
    );
    const response = await fetch(`${baseUrl}${route.target}`, {
      headers: { 'x-claudian-development-actor': 'member-manager' },
    });

    assert.equal(response.status, 408);
    assert.equal(signal?.aborted, true);
    assert.equal(
      decodeCollabCloudErrorEnvelope(await response.json()).error.code,
      'operation-timeout',
    );
  });

  it('destroys a stream returned after the download deadline', async () => {
    let resolveDownload!: (value: {
      readonly body: Readable;
      readonly byteCount: number;
    }) => void;
    const body = Readable.from(['late']);
    const baseUrl = await start({
      download: () => new Promise(resolve => {
        resolveDownload = resolve;
      }),
      upload: () => Promise.reject(new Error('unused')),
    }, 20);
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'download',
      'repository.bundle',
    );

    const response = await fetch(`${baseUrl}${route.target}`, {
      headers: { 'x-claudian-development-actor': 'member-manager' },
    });
    assert.equal(response.status, 408);
    resolveDownload({ body, byteCount: 4 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(body.destroyed, true);
  });

  it('destroys an acquired stream whose metadata is invalid', async () => {
    const body = Readable.from(['invalid']);
    const baseUrl = await start({
      download: () => Promise.resolve({ body, byteCount: 129 }),
      upload: () => Promise.reject(new Error('unused')),
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'download',
      'repository.bundle',
    );

    const response = await fetch(`${baseUrl}${route.target}`, {
      headers: { 'x-claudian-development-actor': 'member-manager' },
    });
    assert.equal(response.status, 500);
    assert.equal(body.destroyed, true);
  });

  it('propagates download backpressure and aborts the owner on disconnect', async () => {
    const chunkBytes = 16 * 1_024;
    const totalChunks = 8_192;
    const byteCount = chunkBytes * totalChunks;
    let emittedChunks = 0;
    let abort!: () => void;
    const aborted = new Promise<void>(resolve => {
      abort = resolve;
    });
    const body = new Readable({
      read() {
        if (emittedChunks === totalChunks) {
          this.push(null);
          return;
        }
        emittedChunks += 1;
        this.push(Buffer.alloc(chunkBytes));
      },
    });
    const bodyClosed = new Promise<void>(resolve => body.once('close', resolve));
    const baseUrl = await start({
      download: input => {
        input.signal.addEventListener('abort', abort, { once: true });
        return Promise.resolve({ body, byteCount });
      },
      upload: () => Promise.reject(new Error('unused')),
    }, 5_000, {
      'checkpoint.json': 32,
      'coordination.ndjson': 64,
      'repository.bundle': byteCount,
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'download',
      'repository.bundle',
    );

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}${route.target}`, {
        headers: { 'x-claudian-development-actor': 'member-manager' },
      }, response => {
        response.pause();
        setTimeout(() => {
          try {
            assert.equal(emittedChunks < totalChunks, true);
            response.destroy();
            resolve();
          } catch (error: unknown) {
            reject(error instanceof Error
              ? error
              : new Error('artifact-backpressure-assertion-failed'));
          }
        }, 20);
      });
      request.once('error', reject);
      request.end();
    });
    await Promise.all([aborted, bodyClosed]);
    assert.equal(body.destroyed, true);
  });

  it('fails closed on a non-loopback/absent trusted principal assertion', async () => {
    const baseUrl = await start({
      download: () => Promise.reject(new Error('unused')),
      upload: () => Promise.reject(new Error('unused')),
    });
    const route = collabCloudAuthorityTransferArtifactRoute(
      PROJECT_ID,
      TRANSFER_ID,
      'download',
      'repository.bundle',
    );
    const response = await fetch(`${baseUrl}${route.target}`);
    assert.equal(response.status, 403);
    assert.equal(
      decodeCollabCloudErrorEnvelope(await response.json()).error.code,
      'authentication-failed',
    );
  });
});
