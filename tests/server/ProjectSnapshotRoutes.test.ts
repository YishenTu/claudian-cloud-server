import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import {
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_MAIN_REF,
  collabCloudProjectOperationRoute,
  collabCloudSuccessEnvelope,
} from '@claudian/collab-protocol';

import { ProjectReadAuthorityError } from '../../src/project-authority/reads/ProjectReadAuthority.js';
import { DevelopmentPrincipalAdapter } from '../../src/request-context/DevelopmentPrincipalAdapter.js';
import { ProjectSnapshotRoutes } from '../../src/server/control/ProjectSnapshotRoutes.js';

const servers = new Set<ReturnType<typeof createServer>>();
const target = collabCloudProjectOperationRoute(
  'project-a',
  'getProjectSnapshot',
).target;
const snapshot = COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeResponse({
  currentMember: {
    activatedAt: '2026-08-21T00:00:00.000Z',
    createdAt: '2026-08-21T00:00:00.000Z',
    displayName: 'Member A',
    id: 'member-a',
    personalRef: 'refs/heads/members/member-a',
    role: 'manager',
    status: 'active',
  },
  eventSequence: 0,
  members: [{
    activatedAt: '2026-08-21T00:00:00.000Z',
    createdAt: '2026-08-21T00:00:00.000Z',
    displayName: 'Member A',
    id: 'member-a',
    personalRef: 'refs/heads/members/member-a',
    role: 'manager',
    status: 'active',
  }],
  openRequests: [],
  openTicketCount: 0,
  project: {
    createdAt: '2026-08-21T00:00:00.000Z',
    expectedMainOid: 'a'.repeat(40),
    id: 'project-a',
    mainRef: COLLAB_MAIN_REF,
    name: 'Project A',
  },
  ticketHighlights: [],
});

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
  servers.clear();
});

async function request(
  route: ProjectSnapshotRoutes,
  input: {
    readonly body: string;
    readonly contentType?: string;
    readonly path?: string;
  },
) {
  const server = createServer((incoming, response) => {
    if (!route.handle(incoming, response)) {
      response.writeHead(404);
      response.end();
    }
  });
  servers.add(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(
    `http://127.0.0.1:${String(address.port)}${input.path ?? target}`,
    {
      body: input.body,
      headers: {
        'content-type': input.contentType ?? 'application/json; charset=utf-8',
        'x-claudian-development-actor': 'member-a',
      },
      method: 'POST',
    },
  );
  const body = await response.text();
  return {
    response,
    value: body.length === 0 ? undefined : JSON.parse(body) as unknown,
  };
}

describe('ProjectSnapshotRoutes', () => {
  it('strictly adapts the package route and codec to Project authority', async () => {
    const calls: unknown[] = [];
    const route = new ProjectSnapshotRoutes({
      authority: {
        getProjectSnapshot: (principal, projectId) => {
          calls.push({ principal, projectId });
          return Promise.resolve(snapshot);
        },
      },
      maximumJsonBytes: 512 * 1024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
    });
    const result = await request(route, {
      body: JSON.stringify({
        data: { projectId: 'project-a' },
        protocolVersion: 4,
        requestId: 'request-a',
      }),
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(
      result.value,
      collabCloudSuccessEnvelope('request-a', snapshot),
    );
    assert.deepEqual(calls, [{
      principal: { actorId: 'member-a', profile: 'loopback-development' },
      projectId: 'project-a',
    }]);
  });

  it('rejects path/body disagreement, unknown fields, media, and oversized bodies', async () => {
    const route = new ProjectSnapshotRoutes({
      authority: { getProjectSnapshot: () => Promise.resolve(snapshot) },
      maximumJsonBytes: 128,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
    });

    for (const testCase of [
      {
        body: JSON.stringify({
          data: { projectId: 'project-b' },
          protocolVersion: 4,
          requestId: 'request-b',
        }),
        status: 400,
      },
      {
        body: JSON.stringify({
          data: { extra: true, projectId: 'project-a' },
          protocolVersion: 4,
          requestId: 'request-c',
        }),
        status: 400,
      },
      {
        body: '{}',
        contentType: 'text/plain',
        status: 400,
      },
      {
        body: JSON.stringify({ padding: 'x'.repeat(256) }),
        status: 413,
      },
    ]) {
      const result = await request(route, testCase);
      assert.equal(result.response.status, testCase.status);
      assert.equal(
        (result.value as { readonly protocolVersion?: number }).protocolVersion,
        4,
      );
    }

    const missing = await request(route, {
      body: '{}',
      path: '/v1/projects/project-a/operations/getProjectSnapshot?extra=1',
    });
    assert.equal(missing.response.status, 404);
  });

  it('does not distinguish an unknown Project from an unrelated actor', async () => {
    const responses = [];
    for (const code of ['authorization-denied', 'project-not-found'] as const) {
      const route = new ProjectSnapshotRoutes({
        authority: {
          getProjectSnapshot: () => Promise.reject(new ProjectReadAuthorityError(code)),
        },
        maximumJsonBytes: 512 * 1024,
        operationTimeoutMs: 2_000,
        principalAdapter: new DevelopmentPrincipalAdapter({
          profile: 'loopback-development',
        }),
      });
      responses.push(await request(route, {
        body: JSON.stringify({
          data: { projectId: 'project-a' },
          protocolVersion: 4,
          requestId: `request-${code}`,
        }),
      }));
    }

    assert.deepEqual(
      responses.map(result => ({
        error: (result.value as { readonly error?: unknown }).error,
        status: result.response.status,
      })),
      [
        {
          error: {
            code: 'project-not-found',
            recoveryActions: [],
            safeContext: {},
          },
          status: 404,
        },
        {
          error: {
            code: 'project-not-found',
            recoveryActions: [],
            safeContext: {},
          },
          status: 404,
        },
      ],
    );
  });

  it('cancels an admitted snapshot read when the client disconnects', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let markCancelled!: () => void;
    const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
    const route = new ProjectSnapshotRoutes({
      authority: {
        getProjectSnapshot: (_principal, _projectId, options) => new Promise(
          (_resolve, reject) => {
            markStarted();
            options?.signal?.addEventListener('abort', () => {
              markCancelled();
              reject(new ProjectReadAuthorityError('cancelled'));
            }, { once: true });
          },
        ),
      },
      maximumJsonBytes: 512 * 1024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
    });
    const server = createServer((incoming, response) => {
      route.handle(incoming, response);
    });
    servers.add(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = httpRequest({
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-claudian-development-actor': 'member-a',
      },
      host: '127.0.0.1',
      method: 'POST',
      path: target,
      port: address.port,
    });
    client.on('error', () => undefined);
    client.end(JSON.stringify({
      data: { projectId: 'project-a' },
      protocolVersion: 4,
      requestId: 'request-disconnect',
    }));
    await started;
    client.destroy();

    await cancelled;
  });
});
