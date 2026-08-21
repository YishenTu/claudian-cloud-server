import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type Server,
} from 'node:http';
import { afterEach, describe, it } from 'node:test';

import {
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabDevelopmentBootstrapRoute,
  collabMemberRef,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudSuccessEnvelope,
  type DevelopmentBootstrapAttemptStatus,
} from '@claudian/collab-protocol';

import { DevelopmentBootstrapProfileError } from '../../../src/onboarding/development/DevelopmentBootstrapProfile.js';
import { ProjectActivationCoordinatorError } from '../../../src/project-authority/lifecycle/ProjectActivationCoordinator.js';
import { DevelopmentPrincipalAdapter } from '../../../src/request-context/DevelopmentPrincipalAdapter.js';
import {
  DevelopmentBootstrapRoutes,
  type DevelopmentBootstrapRequestHandler,
} from '../../../src/server/DevelopmentBootstrapRoutes.js';

const NOW = '2026-08-21T00:00:00.000Z';
const LATER = '2026-08-22T00:00:00.000Z';
const MAIN = '1'.repeat(40);
const MEMBER_ONE = '2'.repeat(40);
const MEMBER_TWO = '3'.repeat(40);
const SHA256 = 'a'.repeat(64);
const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
  servers.clear();
});

function comparisonMember(memberId: string, role: 'manager' | 'member') {
  return {
    activatedAt: NOW,
    createdAt: NOW,
    displayName: memberId,
    memberId,
    personalRef: collabMemberRef(memberId),
    role,
    status: 'active',
  };
}

function comparison() {
  return {
    mainOid: MAIN,
    mainRef: COLLAB_MAIN_REF,
    managerSetGeneration: 1,
    members: [
      comparisonMember('member_1', 'manager'),
      comparisonMember('member_2', 'member'),
    ],
    projectCreatedAt: NOW,
    projectId: 'project_1',
    projectName: 'Private project',
    sourceCaFingerprint: 'b'.repeat(64),
    sourceEventSequence: 0,
    sourceHostMemberId: 'member_1',
  };
}

function manifest() {
  return {
    attemptId: 'attempt_1',
    comparison: comparison(),
    createdAt: NOW,
    git: {
      bundle: { byteCount: 12, sha256: SHA256 },
      objectFormat: 'sha1',
      refs: [
        { name: COLLAB_MAIN_REF, oid: MAIN },
        { name: collabMemberRef('member_1'), oid: MEMBER_ONE },
        { name: collabMemberRef('member_2'), oid: MEMBER_TWO },
      ],
    },
    manifestSchemaVersion: 1,
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sourceEligibility: {
      liveInvitations: 0,
      nonActiveMemberships: 0,
      nonterminalAcceptOperations: 0,
      nonterminalHostTransfers: 0,
      nonterminalManagerOffers: 0,
      requestComments: 0,
      requests: 0,
      terminalProjectTransitions: 0,
      ticketComments: 0,
      ticketMentions: 0,
      ticketRelations: 0,
      tickets: 0,
    },
  } as const;
}

function report() {
  return {
    attemptId: 'attempt_1',
    capturedAt: NOW,
    clientReadiness: {
      cleanupSettled: true,
      collabGitChildrenDrained: true,
      conflictRecoverySettled: true,
      hostTransferSettled: true,
      joinSettled: true,
      leaveSettled: true,
      managerResponsibilitySettled: true,
      projectOperationQueueDrained: true,
      projectSetupSettled: true,
      projectWorkSessionClosed: true,
      publishSettled: true,
      reconciliationSettled: true,
      reconnectSettled: true,
      repositoryIdentityExact: true,
      retirementSettled: true,
    },
    comparison: comparison(),
    hostStopAttestation: {
      attemptId: 'attempt_1',
      autoStartDisabled: true,
      fenceDurable: true,
      fenceId: 'fence_1',
      hostStopped: true,
      manifestSha256: SHA256,
      projectId: 'project_1',
      resourcesDrained: true,
      routeUnregistered: true,
      stoppedAt: NOW,
    },
    observedPersonalRefOid: MEMBER_ONE,
    reporterMemberId: 'member_1',
  } as const;
}

function status(): DevelopmentBootstrapAttemptStatus {
  return Object.freeze({
    attemptId: 'attempt_1',
    bundleState: 'missing',
    createdAt: NOW,
    expiresAt: LATER,
    manifestSha256: SHA256,
    projectId: 'project_1',
    reporterMemberIds: Object.freeze([]),
    state: 'collecting',
  });
}

class Handler implements DevelopmentBootstrapRequestHandler {
  readonly calls: string[] = [];
  uploadBytes = '';
  uploadFirstChunk: (() => void) | undefined;

  activateDevelopmentBootstrap(): Promise<DevelopmentBootstrapAttemptStatus> {
    this.calls.push('activate');
    return Promise.resolve(status());
  }

  beginDevelopmentBootstrap(): Promise<DevelopmentBootstrapAttemptStatus> {
    this.calls.push('begin');
    return Promise.resolve(status());
  }

  cancelDevelopmentBootstrap(): Promise<DevelopmentBootstrapAttemptStatus> {
    this.calls.push('cancel');
    return Promise.resolve(status());
  }

  getDevelopmentBootstrap(): Promise<DevelopmentBootstrapAttemptStatus> {
    this.calls.push('get');
    return Promise.resolve(status());
  }

  async putDevelopmentBootstrapGitBundle(
    _principal: unknown,
    input: Readonly<{ body: AsyncIterable<Uint8Array> }>,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    this.calls.push('upload');
    for await (const chunk of input.body) {
      this.uploadBytes += Buffer.from(chunk).toString('utf8');
      this.uploadFirstChunk?.();
    }
    return status();
  }

  submitDevelopmentBootstrapReport(): Promise<DevelopmentBootstrapAttemptStatus> {
    this.calls.push('report');
    return Promise.resolve(status());
  }
}

async function listen(
  handler: Handler,
  maximumJsonBytes = 512 * 1024,
) {
  let nextRequest = 0;
  const routes = new DevelopmentBootstrapRoutes({
    maximumJsonBytes,
    principalAdapter: new DevelopmentPrincipalAdapter({
      profile: 'loopback-development',
    }),
    profile: handler,
    requestIdFactory: () => `server_request_${String(nextRequest += 1)}`,
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
  return address.port;
}

async function requestJson(
  port: number,
  method: string,
  target: string,
  body?: unknown,
  actor = 'member_1',
) {
  const response = await fetch(`http://127.0.0.1:${String(port)}${target}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(actor.length === 0 ? {} : { 'x-claudian-development-actor': actor }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    method,
  });
  const text = await response.text();
  return {
    response,
    value: text.length === 0 ? undefined : JSON.parse(text) as unknown,
  };
}

async function rawRequest(
  port: number,
  input: Readonly<{
    body: string;
    headers: Record<string, string | string[]>;
    method: string;
    path: string;
  }>,
): Promise<{ status: number; value: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      headers: input.headers,
      host: '127.0.0.1',
      method: input.method,
      path: input.path,
      port,
    }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode ?? 0,
        value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      }));
    });
    outgoing.on('error', reject);
    outgoing.end(input.body);
  });
}

function envelope(data: unknown, requestId: string) {
  return { data, protocolVersion: COLLAB_PROTOCOL_VERSION, requestId };
}

describe('DevelopmentBootstrapRoutes', () => {
  it('rejects a JSON limit above the fixed Cloud envelope maximum', () => {
    assert.throws(() => new DevelopmentBootstrapRoutes({
      maximumJsonBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes + 1,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      profile: new Handler(),
    }), /development-bootstrap-routes\.options-invalid/u);
  });

  it('uses only package routes, envelopes, and codecs for five JSON operations', async () => {
    const handler = new Handler();
    const port = await listen(handler);
    const cases = [{
      data: { manifest: manifest() },
      operation: 'beginDevelopmentBootstrap' as const,
    }, {
      data: { attemptId: 'attempt_1', report: report() },
      operation: 'submitDevelopmentBootstrapReport' as const,
    }, {
      data: undefined,
      operation: 'getDevelopmentBootstrap' as const,
    }, {
      data: { attemptId: 'attempt_1', manifestSha256: SHA256 },
      operation: 'activateDevelopmentBootstrap' as const,
    }, {
      data: { attemptId: 'attempt_1' },
      operation: 'cancelDevelopmentBootstrap' as const,
    }];
    for (const [index, testCase] of cases.entries()) {
      const route = testCase.operation === 'beginDevelopmentBootstrap'
        ? collabDevelopmentBootstrapRoute(testCase.operation)
        : collabDevelopmentBootstrapRoute(testCase.operation, 'attempt_1');
      const result = await requestJson(
        port,
        route.method,
        route.target,
        testCase.data === undefined
          ? undefined
          : envelope(testCase.data, `request_${String(index)}`),
      );
      assert.equal(result.response.status, 200);
      assert.deepEqual(
        decodeCollabCloudSuccessEnvelope(result.value).data,
        status(),
      );
    }
    assert.deepEqual(handler.calls, ['begin', 'report', 'get', 'activate', 'cancel']);
  });

  it('passes a chunked raw bundle to the owner before the request ends', async () => {
    const handler = new Handler();
    const port = await listen(handler);
    let firstChunk!: () => void;
    const observed = new Promise<void>(resolve => {
      firstChunk = resolve;
    });
    handler.uploadFirstChunk = firstChunk;
    const route = collabDevelopmentBootstrapRoute(
      'putDevelopmentBootstrapGitBundle',
      'attempt_1',
    );
    const response = new Promise<{ status: number; value: unknown }>((resolve, reject) => {
      const outgoing = httpRequest({
        headers: {
          'content-type': 'application/x-git-bundle',
          'x-claudian-development-actor': 'member_1',
        },
        host: '127.0.0.1',
        method: route.method,
        path: route.target,
        port,
      }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => resolve({
          status: incoming.statusCode ?? 0,
          value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        }));
      });
      outgoing.on('error', reject);
      outgoing.write('bundle-');
      void Promise.race([
        observed,
        new Promise((_, rejectTimeout) => setTimeout(
          () => rejectTimeout(new Error('upload-was-buffered')),
          500,
        )),
      ]).then(() => outgoing.end('bytes'), reject);
    });
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal(handler.uploadBytes, 'bundle-bytes');
    assert.deepEqual(decodeCollabCloudSuccessEnvelope(result.value).data, status());
  });

  it('fails closed for identity, route, envelope, path, and media contradictions', async () => {
    const handler = new Handler();
    const port = await listen(handler);
    const activate = collabDevelopmentBootstrapRoute(
      'activateDevelopmentBootstrap',
      'attempt_1',
    );

    const missingActor = await requestJson(
      port,
      activate.method,
      activate.target,
      envelope({ attemptId: 'attempt_1', manifestSha256: SHA256 }, 'request_missing'),
      '',
    );
    assert.equal(missingActor.response.status, 403);
    assert.equal(
      decodeCollabCloudErrorEnvelope(missingActor.value).error.code,
      'authentication-failed',
    );

    const malformed = await requestJson(
      port,
      activate.method,
      activate.target,
      { ...envelope({ attemptId: 'attempt_1', manifestSha256: SHA256 }, 'request_bad'), extra: true },
    );
    assert.equal(malformed.response.status, 400);
    assert.equal(
      decodeCollabCloudErrorEnvelope(malformed.value).error.code,
      'protocol-payload-invalid',
    );

    const pathMismatch = await requestJson(
      port,
      activate.method,
      activate.target,
      envelope({ attemptId: 'attempt_2', manifestSha256: SHA256 }, 'request_path'),
    );
    assert.equal(pathMismatch.response.status, 400);

    assert.equal(
      (await requestJson(
        port,
        'POST',
        '/v1/development/bootstrap/attempts/attempt_1/unknown',
        envelope({}, 'request_unknown'),
      )).response.status,
      404,
    );

    const upload = collabDevelopmentBootstrapRoute(
      'putDevelopmentBootstrapGitBundle',
      'attempt_1',
    );
    const wrongMedia = await requestJson(
      port,
      upload.method,
      upload.target,
      'private-bundle-sentinel',
    );
    assert.equal(wrongMedia.response.status, 400);
    assert.equal(handler.calls.length, 0);
    assert.equal(JSON.stringify(wrongMedia.value).includes('private-bundle-sentinel'), false);
  });

  it('rejects duplicate identity, oversized JSON, and encoded bundle bodies before dispatch', async () => {
    const handler = new Handler();
    const port = await listen(handler, 256);
    const activate = collabDevelopmentBootstrapRoute(
      'activateDevelopmentBootstrap',
      'attempt_1',
    );
    const duplicateActor = await rawRequest(port, {
      body: JSON.stringify(envelope(
        { attemptId: 'attempt_1', manifestSha256: SHA256 },
        'request_duplicate',
      )),
      headers: {
        'content-type': 'application/json',
        'x-claudian-development-actor': ['member_1', 'member_1'],
      },
      method: activate.method,
      path: activate.target,
    });
    assert.equal(duplicateActor.status, 403);
    assert.equal(
      decodeCollabCloudErrorEnvelope(duplicateActor.value).error.code,
      'authentication-failed',
    );

    const oversized = await requestJson(
      port,
      activate.method,
      activate.target,
      envelope({
        attemptId: 'attempt_1',
        manifestSha256: SHA256,
        padding: 'sensitive'.repeat(64),
      }, 'request_oversized'),
    );
    assert.equal(oversized.response.status, 413);
    assert.equal(
      decodeCollabCloudErrorEnvelope(oversized.value).error.code,
      'quota-exceeded',
    );
    assert.equal(JSON.stringify(oversized.value).includes('sensitive'), false);

    const upload = collabDevelopmentBootstrapRoute(
      'putDevelopmentBootstrapGitBundle',
      'attempt_1',
    );
    for (const headers of [{
      'content-encoding': 'gzip',
      'content-type': 'application/x-git-bundle',
      'x-claudian-development-actor': 'member_1',
    }, {
      'content-type': 'application/octet-stream',
      'x-claudian-development-actor': 'member_1',
    }]) {
      const rejected = await rawRequest(port, {
        body: 'private-bundle-sentinel',
        headers,
        method: upload.method,
        path: upload.target,
      });
      assert.equal(rejected.status, 400);
      assert.equal(JSON.stringify(rejected.value).includes('private-bundle-sentinel'), false);
    }
    assert.deepEqual(handler.calls, []);
  });

  it('maps only stable safe owner errors into canonical envelopes', async () => {
    const handler = new Handler();
    handler.activateDevelopmentBootstrap = () => Promise.reject(
      new DevelopmentBootstrapProfileError('state-conflict'),
    );
    const port = await listen(handler);
    const route = collabDevelopmentBootstrapRoute(
      'activateDevelopmentBootstrap',
      'attempt_1',
    );
    const result = await requestJson(
      port,
      route.method,
      route.target,
      envelope({ attemptId: 'attempt_1', manifestSha256: SHA256 }, 'request_conflict'),
    );
    assert.equal(result.response.status, 409);
    assert.equal(
      decodeCollabCloudErrorEnvelope(result.value).error.code,
      'authority-not-synchronized',
    );
    assert.equal(
      decodeCollabCloudErrorEnvelope(result.value).requestId,
      'request_conflict',
    );

    handler.activateDevelopmentBootstrap = () => Promise.reject(
      new ProjectActivationCoordinatorError('recovery-required'),
    );
    const recovery = await requestJson(
      port,
      route.method,
      route.target,
      envelope({ attemptId: 'attempt_1', manifestSha256: SHA256 }, 'request_recovery'),
    );
    assert.equal(recovery.response.status, 409);
    assert.equal(
      decodeCollabCloudErrorEnvelope(recovery.value).error.code,
      'authority-not-synchronized',
    );
  });
});
