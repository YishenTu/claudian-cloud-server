import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import {
  COLLAB_PROTOCOL_VERSION,
  CollabError,
  collabCloudProjectOperationRoute,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudSuccessEnvelope,
  type CollabAuthorityTransferStatus,
} from '@claudian-collab/protocol';

import { DevelopmentPrincipalAdapter } from '../../src/request-context/DevelopmentPrincipalAdapter.js';
import {
  ProjectLifecycleRoutes,
  type CloudLifecycleControl,
} from '../../src/server/control/ProjectLifecycleRoutes.js';

const PROJECT_ID = 'project-lifecycle-routes';
const TRANSFER_ID = 'transfer-lifecycle-routes';
const TIMESTAMP = '2026-08-27T00:00:00.000Z';
const servers = new Set<ReturnType<typeof createServer>>();

const status = Object.freeze({
  batchRevision: null,
  batchSha256: null,
  checkpointSha256: null,
  createdAt: TIMESTAMP,
  direction: 'cloud-to-lan',
  expiresAt: '2026-09-26T00:00:00.000Z',
  phase: 'collecting-readiness',
  projectId: PROJECT_ID,
  relinquishmentProof: null,
  sourceAuthority: { generation: 1, kind: 'cloud' },
  state: 'active',
  targetAuthority: { generation: 2, kind: 'lan' },
  targetUrl: 'http://127.0.0.1:43123',
  transferId: TRANSFER_ID,
  updatedAt: TIMESTAMP,
} satisfies CollabAuthorityTransferStatus);

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
  servers.clear();
});

function envelope(data: unknown, requestId = 'request-lifecycle-routes'): unknown {
  return { data, protocolVersion: COLLAB_PROTOCOL_VERSION, requestId };
}

async function request(
  control: CloudLifecycleControl,
  operation: Parameters<typeof collabCloudProjectOperationRoute>[1],
  data: unknown,
  pathProjectId = PROJECT_ID,
  operationTimeoutMs = 5_000,
): Promise<Response> {
  const routes = new ProjectLifecycleRoutes({
    control,
    maximumJsonBytes: 64 * 1024,
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
  const route = collabCloudProjectOperationRoute(pathProjectId, operation);
  return fetch(`http://127.0.0.1:${String(address.port)}${route.target}`, {
    body: JSON.stringify(envelope(data)),
    headers: {
      'content-type': 'application/json',
      'x-claudian-development-actor': 'member-manager',
    },
    method: route.method,
  });
}

describe('ProjectLifecycleRoutes', () => {
  it('binds a trusted principal and dispatches a Cloud v2 lifecycle operation', async () => {
    const calls: unknown[] = [];
    const response = await request({
      execute: (operation, context) => {
        calls.push({ operation, context });
        return Promise.resolve(status) as never;
      },
    }, 'getProjectAuthorityTransfer', {
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(decodeCollabCloudSuccessEnvelope(await response.json()).data, status);
    assert.equal(calls.length, 1);
    const call = calls[0] as {
      readonly context: {
        readonly principalId: string;
        readonly request: { readonly projectId: string };
      };
      readonly operation: string;
    };
    assert.equal(call.operation, 'getProjectAuthorityTransfer');
    assert.equal(call.context.principalId, 'member-manager');
    assert.equal(call.context.request.projectId, PROJECT_ID);
  });

  it('keeps LAN-source-only operations and binding v1 unsupported', async () => {
    const control: CloudLifecycleControl = {
      execute: () => Promise.reject(new Error('must not execute')),
    };
    const sourceOnly = await request(control, 'requestLanToCloudTransfer', {
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-source-proposal',
      projectId: PROJECT_ID,
      targetUrl: 'http://127.0.0.1:43123',
    });
    assert.equal(sourceOnly.status, 404);

    const routes = new ProjectLifecycleRoutes({
      control,
      maximumJsonBytes: 64 * 1024,
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
    const v1 = await fetch(
      `http://127.0.0.1:${String(address.port)}`
        + `/collab/v1/projects/${PROJECT_ID}/operations/getProjectAuthorityTransfer`,
      { method: 'POST' },
    );
    assert.equal(v1.status, 404);
  });

  it('returns package errors without leaking dependency details', async () => {
    const response = await request({
      execute: () => Promise.reject(new CollabError({
        code: 'authority-transfer-stale',
        recoveryActions: ['retry'],
        safeContext: { phase: 'checkpoint-captured' },
      })),
    }, 'cancelProjectAuthorityTransfer', {
      expectedPhase: 'checkpoint-captured',
      idempotencyKey: 'intent-cancel-transfer',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    });

    assert.equal(response.status, 409);
    const failure = decodeCollabCloudErrorEnvelope(await response.json());
    assert.equal(failure.error.code, 'authority-transfer-stale');
    assert.deepEqual(failure.error.safeContext, {});
  });

  it('sanitizes a malformed owner response as a server failure', async () => {
    const response = await request({
      execute: () => Promise.resolve({ direction: 'not-a-direction' }) as never,
    }, 'getProjectAuthorityTransfer', {
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    });

    assert.equal(response.status, 500);
    const failure = decodeCollabCloudErrorEnvelope(await response.json());
    assert.equal(failure.error.code, 'operation-failed');
    assert.deepEqual(failure.error.safeContext, {});
  });

  it('rejects a body whose Project does not match the route', async () => {
    const response = await request({
      execute: () => Promise.resolve(status) as never,
    }, 'getProjectAuthorityTransfer', {
      projectId: 'project-other',
      transferId: TRANSFER_ID,
    });

    assert.equal(response.status, 400);
    const failure = decodeCollabCloudErrorEnvelope(await response.json());
    assert.equal(failure.error.code, 'protocol-payload-invalid');
    assert.deepEqual(failure.error.safeContext, { field: 'projectId' });
  });

  it('owns the response deadline even when a lifecycle mutation settles later', async () => {
    let signal: AbortSignal | undefined;
    const response = await request({
      execute: (_operation, context) => {
        signal = context.signal;
        return new Promise(resolve => setTimeout(() => resolve(status), 100)) as never;
      },
    }, 'getProjectAuthorityTransfer', {
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }, PROJECT_ID, 20);

    assert.equal(response.status, 408);
    assert.equal(signal?.aborted, true);
    assert.equal(
      decodeCollabCloudErrorEnvelope(await response.json()).error.code,
      'operation-timeout',
    );
  });
});
