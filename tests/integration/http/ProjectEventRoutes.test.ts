import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { describe, it } from 'node:test';

import {
  collabCloudProjectEventsRoute,
  decodeCollabCloudProjectEventMessage,
  type CollabProjectId,
} from '@claudian-collab/protocol';
import { WebSocket } from 'ws';

import {
  ProjectReadAuthorityError,
  type ProjectEventReadResult,
} from '../../../src/project-authority/reads/ProjectReadAuthority.js';
import type { createDevelopmentIngressPrincipal } from '../../../src/request-context/IngressPrincipal.js';
import { DevelopmentPrincipalAdapter } from '../../../src/request-context/DevelopmentPrincipalAdapter.js';
import { ProjectEventWakeup } from '../../../src/project-authority/reads/ProjectEventWakeup.js';
import { ProjectEventAdmission } from '../../../src/resource-admission/ProjectEventAdmission.js';
import { ProjectEventRoutes } from '../../../src/server/events/ProjectEventRoutes.js';
import { HttpServer } from '../../../src/server/HttpServer.js';

function target(projectId: string, afterSequence: number): string {
  return collabCloudProjectEventsRoute(projectId, afterSequence).target;
}

interface SocketInbox {
  readonly frames: unknown[];
  readonly waiters: Array<(value: unknown) => void>;
}

const inboxes = new WeakMap<WebSocket, SocketInbox>();
const closePromises = new WeakMap<WebSocket, Promise<unknown[]>>();

async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}`)), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function open(
  origin: string,
  projectId: string,
  afterSequence: number,
): Promise<WebSocket> {
  const socket = new WebSocket(
    `${origin.replace(/^http/u, 'ws')}${target(projectId, afterSequence)}`,
    { headers: { 'x-claudian-development-actor': 'member-a' } },
  );
  const inbox: SocketInbox = { frames: [], waiters: [] };
  inboxes.set(socket, inbox);
  closePromises.set(socket, once(socket, 'close'));
  socket.on('message', data => {
    const encoded = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    const value = JSON.parse(encoded.toString('utf8')) as unknown;
    const waiter = inbox.waiters.shift();
    if (waiter === undefined) inbox.frames.push(value);
    else waiter(value);
  });
  await within(once(socket, 'open'), 'open');
  return socket;
}

async function message(socket: WebSocket, label: string): Promise<unknown> {
  const inbox = inboxes.get(socket);
  assert.ok(inbox !== undefined);
  const queued = inbox.frames.shift();
  if (queued !== undefined) return queued;
  return within(
    new Promise(resolve => inbox.waiters.push(resolve)),
    `message:${label}`,
  );
}

async function closed(socket: WebSocket): Promise<void> {
  const completion = closePromises.get(socket);
  assert.ok(completion !== undefined);
  await within(completion, 'close');
}

async function rejected(
  origin: string,
  projectId: string,
  status: 404 | 503,
): Promise<void> {
  const socket = new WebSocket(
    `${origin.replace(/^http/u, 'ws')}${target(projectId, 0)}`,
    { headers: { 'x-claudian-development-actor': 'member-a' } },
  );
  const [error] = await within(once(socket, 'error'), `reject:${projectId}`) as [Error];
  assert.match(error.message, new RegExp(String(status), 'u'));
}

async function malformedAuthorizedUpgrade(
  host: string,
  port: number,
  projectId: string,
): Promise<void> {
  const socket = connectTcp({ host, port });
  const response: Buffer[] = [];
  socket.on('data', chunk => response.push(chunk));
  await within(once(socket, 'connect').then(() => undefined), 'tcp-connect');
  socket.end([
    `GET ${target(projectId, 0)} HTTP/1.1`,
    `Host: ${host}:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'x-claudian-development-actor: member-a',
    '',
    '',
  ].join('\r\n'));
  await within(once(socket, 'close').then(() => undefined), 'malformed-close');
  assert.match(Buffer.concat(response).toString('ascii'), /^HTTP\/1\.1 400 /u);
}

describe('ProjectEventRoutes', () => {
  it('authorizes before upgrade and bounds pending work independently of Project IDs', async () => {
    let authorize!: () => void;
    const authorization = new Promise<void>(resolve => { authorize = resolve; });
    const calls: string[] = [];
    const wakeup = new ProjectEventWakeup();
    const admission = new ProjectEventAdmission({
      maxConnections: 2,
      maxConnectionsPerProject: 1,
      maxPendingAuthorizations: 1,
    });
    const events = new ProjectEventRoutes({
      admission,
      authority: {
        getProjectEvents: async (_principal, projectId) => {
          calls.push(projectId);
          await authorization;
          return { events: [], kind: 'events', latestSequence: 0 };
        },
      },
      heartbeatMs: 30_000,
      maximumBufferedBytes: 1024,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      wakeup,
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      upgradeRoutes: [events],
    });
    try {
      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      const first = new WebSocket(
        `${origin.replace(/^http/u, 'ws')}${target('project-a', 0)}`,
        { headers: { 'x-claudian-development-actor': 'member-a' } },
      );
      const firstOpened = once(first, 'open');
      await within(
        new Promise<void>(resolve => {
          const check = (): void => {
            if (calls.length === 1) resolve();
            else setImmediate(check);
          };
          check();
        }),
        'pending-entered',
      );
      await rejected(origin, 'project-b', 503);
      assert.deepEqual(calls, ['project-a']);

      authorize();
      await within(firstOpened, 'authorized-open');
      first.close();
      await within(once(first, 'close'), 'authorized-close');
    } finally {
      authorize();
      await events.close();
      await admission.close();
      wakeup.close();
      await server.close(1_000);
    }
  });

  it('serializes same-Project authority polls across admitted event sessions', async () => {
    let activePolls = 0;
    let maximumActivePolls = 0;
    const wakeup = new ProjectEventWakeup();
    const admission = new ProjectEventAdmission({
      maxConnections: 8,
      maxConnectionsPerProject: 4,
      maxPendingAuthorizations: 4,
    });
    const events = new ProjectEventRoutes({
      admission,
      authority: {
        getProjectEvents: async () => {
          activePolls += 1;
          maximumActivePolls = Math.max(maximumActivePolls, activePolls);
          await new Promise<void>(resolve => setTimeout(resolve, 10));
          activePolls -= 1;
          return { events: [], kind: 'events', latestSequence: 0 };
        },
      },
      heartbeatMs: 30_000,
      maximumBufferedBytes: 1024,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      wakeup,
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      upgradeRoutes: [events],
    });
    try {
      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      const sockets = await Promise.all(Array.from(
        { length: 4 },
        () => open(origin, 'project-a', 0),
      ));
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      assert.equal(maximumActivePolls, 1);
      for (const socket of sockets) socket.close();
      await Promise.all(sockets.map(socket => closed(socket)));
    } finally {
      await events.close();
      await admission.close();
      wakeup.close();
      await server.close(1_000);
    }
  });

  it('rejects unknown and unrelated Projects before the WebSocket handshake', async () => {
    const wakeup = new ProjectEventWakeup();
    const admission = new ProjectEventAdmission({
      maxConnections: 2,
      maxConnectionsPerProject: 1,
      maxPendingAuthorizations: 1,
    });
    const events = new ProjectEventRoutes({
      admission,
      authority: {
        getProjectEvents: (_principal, projectId) => (
          projectId === 'project-allowed'
            ? Promise.resolve({
              events: [],
              kind: 'events' as const,
              latestSequence: 0,
            })
            : Promise.reject(new ProjectReadAuthorityError(
              projectId === 'project-unrelated'
                ? 'authorization-denied'
                : 'project-not-found',
            ))
        ),
      },
      heartbeatMs: 30_000,
      maximumBufferedBytes: 1024,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      wakeup,
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      upgradeRoutes: [events],
    });
    try {
      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      await rejected(origin, 'project-unrelated', 404);
      await rejected(origin, 'project-unknown', 404);
      const replacement = await open(origin, 'project-allowed', 0);
      replacement.close();
      await closed(replacement);
    } finally {
      await events.close();
      await admission.close();
      wakeup.close();
      await server.close(1_000);
    }
  });

  it('releases active admission after an authorized malformed handshake', async () => {
    const wakeup = new ProjectEventWakeup();
    const admission = new ProjectEventAdmission({
      maxConnections: 2,
      maxConnectionsPerProject: 1,
      maxPendingAuthorizations: 1,
    });
    const events = new ProjectEventRoutes({
      admission,
      authority: {
        getProjectEvents: () => Promise.resolve({
          events: [],
          kind: 'events',
          latestSequence: 0,
        }),
      },
      heartbeatMs: 30_000,
      maximumBufferedBytes: 1024,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      wakeup,
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      upgradeRoutes: [events],
    });
    try {
      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      await malformedAuthorizedUpgrade(address.host, address.port, 'project-a');

      const replacement = await open(origin, 'project-a', 0);
      replacement.close();
      await closed(replacement);
      await events.close();
      await within(admission.close(), 'malformed-admission-close');
    } finally {
      await events.close();
      wakeup.close();
      await server.close(1_000);
    }
  });

  it('replays contiguous events, follows committed wakeups, and closes gaps', async () => {
    const latest = new Map<string, number>([['project-a', 1]]);
    const wakeup = new ProjectEventWakeup();
    const admission = new ProjectEventAdmission({
      maxConnections: 8,
      maxConnectionsPerProject: 4,
    });
    const authority = {
      getProjectEvents: (
        _principal: ReturnType<typeof createDevelopmentIngressPrincipal>,
        projectId: CollabProjectId,
        afterSequence: number,
      ): Promise<ProjectEventReadResult> => {
        const sequence = latest.get(projectId) ?? 0;
        if (projectId === 'project-gap') {
          return Promise.resolve({
            kind: 'snapshot-required',
            latestSequence: 9,
          });
        }
        const events = Array.from(
          { length: Math.max(0, sequence - afterSequence) },
          (_, index) => {
            const eventSequence = afterSequence + index + 1;
            return {
              kind: 'membership.updated' as const,
              occurredAt: '2026-08-21T00:00:00.000Z',
              payload: { memberId: `member-${String(eventSequence)}` },
              projectId,
              protocolVersion: 4 as const,
              sequence: eventSequence,
            };
          },
        );
        return Promise.resolve({
          events,
          kind: 'events',
          latestSequence: sequence,
        });
      },
    };
    const events = new ProjectEventRoutes({
      admission,
      authority,
      heartbeatMs: 30_000,
      maximumBufferedBytes: 512 * 1024,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      wakeup,
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      upgradeRoutes: [events],
    });
    try {
      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      const socket = await open(origin, 'project-a', 0);
      assert.deepEqual(
        decodeCollabCloudProjectEventMessage(await message(socket, 'initial')),
        {
          kind: 'membership.updated',
          occurredAt: '2026-08-21T00:00:00.000Z',
          payload: { memberId: 'member-1' },
          projectId: 'project-a',
          protocolVersion: 4,
          sequence: 1,
        },
      );

      latest.set('project-a', 2);
      wakeup.notify('project-a');
      const second = decodeCollabCloudProjectEventMessage(
        await message(socket, 'wakeup'),
      );
      assert.notEqual(second.kind, 'snapshot.required');
      if (second.kind === 'snapshot.required') throw new Error('unexpected snapshot');
      assert.equal(second.sequence, 2);
      socket.close();
      await closed(socket);

      const gap = await open(origin, 'project-gap', 0);
      assert.deepEqual(
        decodeCollabCloudProjectEventMessage(await message(gap, 'gap')),
        { kind: 'snapshot.required', latestSequence: 9 },
      );
      await closed(gap);
    } finally {
      await events.close();
      await admission.close();
      wakeup.close();
      await server.close(1_000);
    }
  });

  it('polls durable events when the post-commit wakeup is missed', async () => {
    let latestSequence = 0;
    const wakeup = new ProjectEventWakeup();
    const admission = new ProjectEventAdmission({
      maxConnections: 2,
      maxConnectionsPerProject: 1,
    });
    const events = new ProjectEventRoutes({
      admission,
      authority: {
        getProjectEvents: (_principal, projectId, afterSequence) => Promise.resolve({
          events: latestSequence > afterSequence ? [{
            kind: 'membership.updated',
            occurredAt: '2026-08-21T00:00:00.000Z',
            payload: { memberId: 'member-a' },
            projectId,
            protocolVersion: 4,
            sequence: latestSequence,
          }] : [],
          kind: 'events',
          latestSequence,
        }),
      },
      heartbeatMs: 20,
      maximumBufferedBytes: 1024,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      wakeup,
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      upgradeRoutes: [events],
    });
    try {
      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      const socket = await open(origin, 'project-a', 0);
      latestSequence = 1;

      const delivered = decodeCollabCloudProjectEventMessage(
        await message(socket, 'durable-poll'),
      );
      assert.notEqual(delivered.kind, 'snapshot.required');
      if (delivered.kind === 'snapshot.required') throw new Error('unexpected snapshot');
      assert.equal(delivered.sequence, 1);
      socket.close();
      await closed(socket);
    } finally {
      await events.close();
      await admission.close();
      wakeup.close();
      await server.close(1_000);
    }
  });

  it('rejects untrusted upgrades and bounds slow-consumer state', async () => {
    const wakeup = new ProjectEventWakeup();
    const admission = new ProjectEventAdmission({
      maxConnections: 2,
      maxConnectionsPerProject: 1,
    });
    const events = new ProjectEventRoutes({
      admission,
      authority: {
        getProjectEvents: (_principal, projectId) => Promise.resolve({
          events: [{
            kind: 'membership.updated',
            occurredAt: '2026-08-21T00:00:00.000Z',
            payload: { memberId: 'member-a' },
            projectId,
            protocolVersion: 4,
            sequence: 1,
          }],
          kind: 'events',
          latestSequence: 1,
        }),
      },
      heartbeatMs: 20,
      maximumBufferedBytes: 1,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      wakeup,
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      upgradeRoutes: [events],
    });
    try {
      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      const unauthenticated = new WebSocket(
        `${origin.replace(/^http/u, 'ws')}${target('project-a', 0)}`,
      );
      const [error] = await once(unauthenticated, 'error') as [Error];
      assert.match(error.message, /403/u);

      const bounded = await open(origin, 'project-a', 0);
      await closed(bounded);
      await new Promise(resolve => setImmediate(resolve));
      const replacement = await open(origin, 'project-a', 0);
      await closed(replacement);
      await within(events.close(), 'slow-consumer-close');
    } finally {
      await events.close();
      await admission.close();
      wakeup.close();
      await server.close(1_000);
    }
  });

  it('terminates a client after exactly two missed heartbeat responses', async () => {
    const wakeup = new ProjectEventWakeup();
    const admission = new ProjectEventAdmission({
      maxConnections: 8,
      maxConnectionsPerProject: 4,
    });
    const events = new ProjectEventRoutes({
      admission,
      authority: {
        getProjectEvents: () => Promise.resolve({
          events: [],
          kind: 'events',
          latestSequence: 0,
        }),
      },
      heartbeatMs: 20,
      maximumBufferedBytes: 1024,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      wakeup,
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      upgradeRoutes: [events],
    });
    try {
      const address = await server.start();
      const startedAt = Date.now();
      const socket = new WebSocket(
        `ws://${address.host}:${String(address.port)}${target('project-a', 0)}`,
        {
          autoPong: false,
          headers: { 'x-claudian-development-actor': 'member-a' },
        },
      );
      let pings = 0;
      socket.on('ping', () => { pings += 1; });
      const completion = once(socket, 'close');
      await within(once(socket, 'open'), 'heartbeat-open');
      await within(completion, 'heartbeat-close');
      assert.equal(pings, 2);
      assert.equal(Date.now() - startedAt >= 55, true);
    } finally {
      await events.close();
      await admission.close();
      wakeup.close();
      await server.close(1_000);
    }
  });

  it('bounds global and per-Project sessions and forces them closed on shutdown', async () => {
    const wakeup = new ProjectEventWakeup();
    const admission = new ProjectEventAdmission({
      maxConnections: 2,
      maxConnectionsPerProject: 1,
    });
    const events = new ProjectEventRoutes({
      admission,
      authority: {
        getProjectEvents: () => Promise.resolve({
          events: [],
          kind: 'events',
          latestSequence: 0,
        }),
      },
      heartbeatMs: 30_000,
      maximumBufferedBytes: 1024,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
      wakeup,
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      upgradeRoutes: [events],
    });
    try {
      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      const projectA = await open(origin, 'project-a', 0);
      await rejected(origin, 'project-a', 503);
      const projectB = await open(origin, 'project-b', 0);
      await rejected(origin, 'project-c', 503);

      projectA.close();
      await closed(projectA);
      await Promise.resolve();
      const projectC = await open(origin, 'project-c', 0);
      const projectBClosed = closed(projectB);
      const projectCClosed = closed(projectC);
      await events.close();
      await Promise.all([projectBClosed, projectCClosed]);
    } finally {
      await events.close();
      await admission.close();
      wakeup.close();
      await server.close(1_000);
    }
  });
});
