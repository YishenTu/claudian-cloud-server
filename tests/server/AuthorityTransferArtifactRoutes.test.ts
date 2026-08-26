import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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

async function start(authority: AuthorityTransferArtifactAuthority) {
  const routes = new AuthorityTransferArtifactRoutes({
    authority,
    limits: {
      'checkpoint.json': 32,
      'coordination.ndjson': 64,
      'repository.bundle': 128,
    },
    operationTimeoutMs: 5_000,
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
