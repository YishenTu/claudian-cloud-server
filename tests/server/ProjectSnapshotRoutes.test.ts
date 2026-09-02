import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import {
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_MAIN_REF,
  collabCloudProjectOperationRoute,
  collabCloudSuccessEnvelope,
} from '@claudian-collab/protocol';

import { RetireCoordinator } from '../../src/project-authority/lifecycle/retire/RetireCoordinator.js';
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
    authorityGeneration: 7,
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
    readonly actorId?: string;
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
        'x-claudian-development-actor': input.actorId ?? 'member-a',
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
        protocolVersion: 8,
        requestId: 'request-a',
      }),
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(
      result.value,
      collabCloudSuccessEnvelope('request-a', snapshot),
    );
    assert.deepEqual(calls, [{
      principal: {
        principalId: 'member-a',
        provenance: { kind: 'private-development' },
      },
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
          protocolVersion: 8,
          requestId: 'request-b',
        }),
        status: 400,
      },
      {
        body: JSON.stringify({
          data: { extra: true, projectId: 'project-a' },
          protocolVersion: 8,
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
        8,
      );
    }

    const missing = await request(route, {
      body: '{}',
      path: '/v4/projects/project-a/operations/getProjectSnapshot?extra=1',
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
          protocolVersion: 8,
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

  it('returns an eligible Retire terminal result after ordinary authority is gone', async () => {
    const route = new ProjectSnapshotRoutes({
      authority: {
        getProjectSnapshot: () => Promise.reject(
          new ProjectReadAuthorityError('project-not-found'),
        ),
      },
      maximumJsonBytes: 512 * 1024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      retirementTerminal: {
        getRetirementTerminal: (principalId, projectId) => Promise.resolve(
          principalId === 'member-a' && projectId === 'project-a'
            ? {
                acknowledgementRequired: true,
                kind: 'project-retired',
                projectId: 'project-a',
                retiredAt: '2026-08-27T00:00:00.000Z',
                retirementId: 'retire_terminal_one',
                terminalExpiresAt: '2026-09-26T00:00:00.000Z',
              }
            : null,
        ),
      },
    });

    const eligible = await request(route, {
      body: JSON.stringify({
        data: { projectId: 'project-a' },
        protocolVersion: 8,
        requestId: 'request-terminal-eligible',
      }),
    });
    assert.equal(eligible.response.status, 410);
    assert.deepEqual(
      (eligible.value as { readonly error: unknown }).error,
      {
        code: 'project-retired',
        recoveryActions: [],
        safeContext: {
          operationId: 'retire_terminal_one',
          projectId: 'project-a',
          retiredAt: '2026-08-27T00:00:00.000Z',
        },
      },
    );
    const unrelated = await request(route, {
      actorId: 'member-unrelated',
      body: JSON.stringify({
        data: { projectId: 'project-a' },
        protocolVersion: 8,
        requestId: 'request-terminal-unrelated',
      }),
    });
    assert.equal(unrelated.response.status, 404);
    assert.deepEqual(
      (unrelated.value as { readonly error: unknown }).error,
      { code: 'project-not-found', recoveryActions: [], safeContext: {} },
    );
  });

  it('preserves project-not-found for a non-Retire terminal tombstone', async () => {
    const retirement = new RetireCoordinator({
      clock: () => new Date('2026-08-27T00:00:00.000Z'),
      coordination: {
        acquireProjectLease() {
          return Promise.resolve({
            async close() {},
            async withProjectScope<T>(operation: (scope: unknown) => Promise<T>) {
              return operation({
                portability: {
                  getProjectTombstone() {
                    return Promise.resolve({
                      authorityGeneration: 4,
                      projectId: 'project-a',
                      resultSha256: 'a'.repeat(64),
                      retiredAt: '2026-08-27T00:00:00.000Z',
                      terminalExpiresAt: '2026-09-26T00:00:00.000Z',
                      terminalOperationId: 'transfer_terminal_one',
                      terminalOperationKind: 'authority-transfer',
                    });
                  },
                  getTerminalResponder() {
                    return Promise.reject(new Error('must not read Retire responder'));
                  },
                },
              });
            },
          } as never);
        },
      },
      repository: {
        reserveExactRepositoryOperation() {
          return Promise.reject(new Error('must not reserve'));
        },
        verifyExactRepository() { return Promise.reject(new Error('must not verify')); },
      },
    });
    const route = new ProjectSnapshotRoutes({
      authority: {
        getProjectSnapshot: () => Promise.reject(
          new ProjectReadAuthorityError('project-not-found'),
        ),
      },
      maximumJsonBytes: 512 * 1024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      retirementTerminal: {
        getRetirementTerminal: (principalId, projectId, options) => (
          retirement.getTerminalResult({ principalId, projectId, ...options })
        ),
      },
    });

    const result = await request(route, {
      actorId: 'member-unrelated',
      body: JSON.stringify({
        data: { projectId: 'project-a' },
        protocolVersion: 8,
        requestId: 'request-transfer-tombstone-unrelated',
      }),
    });

    assert.equal(result.response.status, 404);
    assert.deepEqual((result.value as { readonly error: unknown }).error, {
      code: 'project-not-found',
      recoveryActions: [],
      safeContext: {},
    });
  });

  it('returns the Retire terminal result while deletion still fences ordinary reads', async () => {
    const route = new ProjectSnapshotRoutes({
      authority: {
        getProjectSnapshot: () => Promise.reject(
          new ProjectReadAuthorityError('recovery-required'),
        ),
      },
      maximumJsonBytes: 512 * 1024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      retirementTerminal: {
        getRetirementTerminal: principalId => Promise.resolve(
          principalId === 'member-a'
            ? {
                acknowledgementRequired: true,
                kind: 'project-retired',
                projectId: 'project-a',
                retiredAt: '2026-08-27T00:00:00.000Z',
                retirementId: 'retire_deleting',
                terminalExpiresAt: '2026-09-26T00:00:00.000Z',
              }
            : null,
        ),
      },
    });

    const eligible = await request(route, {
      body: JSON.stringify({
        data: { projectId: 'project-a' },
        protocolVersion: 8,
        requestId: 'request-terminal-deleting',
      }),
    });
    assert.equal(eligible.response.status, 410);

    const unrelated = await request(route, {
      actorId: 'member-unrelated',
      body: JSON.stringify({
        data: { projectId: 'project-a' },
        protocolVersion: 8,
        requestId: 'request-terminal-deleting-unrelated',
      }),
    });
    assert.equal(unrelated.response.status, 409);
    assert.deepEqual(
      (unrelated.value as { readonly error: unknown }).error,
      {
        code: 'authority-not-synchronized',
        recoveryActions: ['retry'],
        safeContext: {},
      },
    );
  });

  it('cancels a terminal fallback lookup when the client disconnects', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let markCancelled!: () => void;
    const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
    const route = new ProjectSnapshotRoutes({
      authority: {
        getProjectSnapshot: () => Promise.reject(
          new ProjectReadAuthorityError('project-not-found'),
        ),
      },
      maximumJsonBytes: 512 * 1024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      retirementTerminal: {
        getRetirementTerminal: (_principalId, _projectId, options) => new Promise(
          (_resolve, reject) => {
            markStarted();
            options?.signal?.addEventListener('abort', () => {
              markCancelled();
              reject(new Error('cancelled'));
            }, { once: true });
          },
        ),
      },
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
      protocolVersion: 8,
      requestId: 'request-terminal-disconnect',
    }));
    await started;
    client.destroy();

    await cancelled;
  });

  it('maps a failed terminal fallback lookup to a retryable safe response', async () => {
    const route = new ProjectSnapshotRoutes({
      authority: {
        getProjectSnapshot: () => Promise.reject(
          new ProjectReadAuthorityError('project-not-found'),
        ),
      },
      maximumJsonBytes: 512 * 1024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      retirementTerminal: {
        getRetirementTerminal: () => Promise.reject(new Error('database-busy-secret')),
      },
    });

    const result = await request(route, {
      body: JSON.stringify({
        data: { projectId: 'project-a' },
        protocolVersion: 8,
        requestId: 'request-terminal-failure',
      }),
    });

    assert.equal(result.response.status, 503);
    assert.deepEqual((result.value as { readonly error: unknown }).error, {
      code: 'operation-failed',
      recoveryActions: ['retry'],
      safeContext: {},
    });
  });

  it('fails safely when the persisted Retire responder contradicts its tombstone', async () => {
    const terminalResult = {
      acknowledgementRequired: true as const,
      kind: 'project-retired' as const,
      projectId: 'project-a',
      retiredAt: '2026-08-27T00:00:00.000Z',
      retirementId: 'retire_terminal_corrupt',
      terminalExpiresAt: '2026-09-26T00:00:00.000Z',
    };
    const responseJson = JSON.stringify(terminalResult);
    const resultSha256 = createHash('sha256').update(responseJson, 'utf8').digest('hex');
    const retirement = new RetireCoordinator({
      clock: () => new Date('2026-08-27T00:00:00.000Z'),
      coordination: {
        acquireProjectLease() {
          return Promise.resolve({
            async close() {},
            async withProjectScope<T>(operation: (scope: unknown) => Promise<T>) {
              return operation({
                portability: {
                  getProjectTombstone() {
                    return Promise.resolve({
                      authorityGeneration: 4,
                      projectId: 'project-a',
                      resultSha256,
                      retiredAt: terminalResult.retiredAt,
                      terminalExpiresAt: terminalResult.terminalExpiresAt,
                      terminalOperationId: terminalResult.retirementId,
                      terminalOperationKind: 'retire',
                    });
                  },
                  getTerminalResponder() {
                    return Promise.resolve({
                      acknowledgements: [],
                      createdAt: terminalResult.retiredAt,
                      eligiblePrincipals: [{
                        memberId: 'member-a',
                        principalId: 'member-a',
                      }],
                      expiresAt: terminalResult.terminalExpiresAt,
                      operationId: terminalResult.retirementId,
                      operationKind: 'retire',
                      replayAuthorization: undefined,
                      responseJson,
                      responseSha256: 'f'.repeat(64),
                    });
                  },
                },
              });
            },
          } as never);
        },
      },
      repository: {
        reserveExactRepositoryOperation() {
          return Promise.reject(new Error('must not reserve'));
        },
        verifyExactRepository() { return Promise.reject(new Error('must not verify')); },
      },
    });
    const route = new ProjectSnapshotRoutes({
      authority: {
        getProjectSnapshot: () => Promise.reject(
          new ProjectReadAuthorityError('project-not-found'),
        ),
      },
      maximumJsonBytes: 512 * 1024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      retirementTerminal: {
        getRetirementTerminal: (principalId, projectId, options) => (
          retirement.getTerminalResult({ principalId, projectId, ...options })
        ),
      },
    });

    const result = await request(route, {
      body: JSON.stringify({
        data: { projectId: 'project-a' },
        protocolVersion: 8,
        requestId: 'request-terminal-corrupt',
      }),
    });

    assert.equal(result.response.status, 503);
    assert.deepEqual((result.value as { readonly error: unknown }).error, {
      code: 'operation-failed',
      recoveryActions: ['retry'],
      safeContext: {},
    });
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
      protocolVersion: 8,
      requestId: 'request-disconnect',
    }));
    await started;
    client.destroy();

    await cancelled;
  });
});
