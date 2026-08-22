import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_PROTOCOL_VERSION,
  collabCloudProjectEventsRoute,
  collabCloudProjectOperationRoute,
  collabMemberRef,
  collabControlOperationCodec,
  decodeCollabCloudCapabilityDocument,
  decodeCollabCloudProjectEventMessage,
  decodeCollabCloudProjectSnapshot,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudSuccessEnvelope,
  type CollabControlOperation,
} from '@claudian/collab-protocol';
import { Client } from 'pg';
import { type RawData, WebSocket } from 'ws';

import {
  createApplication,
  type Application,
} from '../../../src/composition/createApplication.js';
import type { ServerConfig } from '../../../src/config/ServerConfig.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { SafeLogger } from '../../../src/observability/SafeLogger.js';
import { acquirePostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const CREATED_AT = '2026-08-23T00:00:00.000Z';
const PROJECT_ID = 'project-collaboration-gate';
const SECOND_PROJECT_ID = 'project-collaboration-gate-two';
const ACTORS = ['member-alice', 'member-bob'] as const;

function config(
  databaseUrl: string,
  repositoryRoot: string,
  stagingRoot: string,
  gitExecutable = GIT_EXECUTABLE,
): ServerConfig {
  const maxBundleBytes = 16 * 1_024 * 1_024;
  const maxRepositoryBytes = 64 * 1_024 * 1_024;
  return Object.freeze({
    developmentBootstrap: Object.freeze({
      attemptTtlMs: COLLAB_CLOUD_BINDING_LIMITS.bootstrapAttemptTtlMs,
      maxBundleBytes,
      maxConcurrentUploads: 1,
      maxRepositoryBytes,
      maxUploadsPerAttempt: 1,
      queueMax: 4,
      queueTimeoutMs: 2_000,
      stagingFreeSpaceFloorBytes: 1,
      stagingReservationBytes: maxBundleBytes + maxRepositoryBytes,
      stagingRoot,
      uploadDeadlineMs: 30_000,
      uploadIdleTimeoutMs: 5_000,
    }),
    eventAdmission: Object.freeze({
      maxConnections: 8,
      maxConnectionsPerProject: 4,
      maxPendingAuthorizations: 4,
    }),
    gitAdmission: Object.freeze({
      maxChildren: 3,
      maxChildrenPerProject: 1,
      maxQueuedReads: 5,
      maxQueuedWrites: 5,
      maxReadChildren: 2,
      maxWriteChildren: 1,
      queueMax: 6,
      queueMaxPerProject: 4,
      queueTimeoutMs: 2_000,
    }),
    http: Object.freeze({ host: '127.0.0.1', port: 0 }),
    postgres: Object.freeze({
      ordinaryPoolMax: 3,
      pinnedPoolMax: 3,
      projectLockTimeoutMs: 10_000,
      reservedPoolMax: 1,
      url: databaseUrl,
    }),
    repository: Object.freeze({
      gitExecutable,
      operationTimeoutMs: 10_000,
      outputMaxBytes: 1_024 * 1_024,
      root: repositoryRoot,
      storageNodeId: 'collaboration-gate-node',
    }),
    shutdownTimeoutMs: 5_000,
  });
}

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, arguments_, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1_024 * 1_024,
  });
  return result.stdout.trim();
}

async function createRepository(
  root: string,
  repositoryRoot: string,
  projectId = PROJECT_ID,
  suffix = 'primary',
): Promise<Readonly<{
  mainOid: string;
  projectId: string;
  repositoryPath: string;
  repositoryStorageKey: string;
}>> {
  const work = join(root, `work-${suffix}`);
  const repositoryStorageKey = `repository_collaboration_gate_${suffix}`;
  const projectDirectory = join(
    repositoryRoot,
    Buffer.from(projectId, 'utf8').toString('hex'),
  );
  await git(root, ['init', '--initial-branch=main', work]);
  await git(work, ['config', 'user.name', 'Collaboration Gate']);
  await git(work, ['config', 'user.email', 'gate@example.invalid']);
  await writeFile(join(work, 'shared.txt'), 'base\n');
  await git(work, ['add', 'shared.txt']);
  await git(work, ['commit', '-m', 'base']);
  const mainOid = await git(work, ['rev-parse', 'HEAD']);
  for (const actor of ACTORS) {
    await git(work, ['branch', collabMemberRef(actor).slice('refs/heads/'.length)]);
  }
  await mkdir(projectDirectory);
  const repositoryPath = join(projectDirectory, repositoryStorageKey);
  await git(root, [
    'clone',
    '--bare',
    work,
    repositoryPath,
  ]);
  return Object.freeze({ mainOid, projectId, repositoryPath, repositoryStorageKey });
}

async function seedProject(
  client: Client,
  fixture: Readonly<{
    mainOid: string;
    projectId: string;
    repositoryStorageKey: string;
  }>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [fixture.projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation,
         expected_main_oid, service_state, created_at, activated_at
       ) VALUES ($1, 'Collaboration Gate', 1, $2, 'active', $3, $3)`,
      [fixture.projectId, fixture.mainOid, CREATED_AT],
    );
    for (const [index, actor] of ACTORS.entries()) {
      await client.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, display_name, role, status, revision,
           created_at, updated_at
         ) VALUES ($1, $2, $2, $3, 'active', 1, $4, $4)`,
        [fixture.projectId, actor, index === 0 ? 'manager' : 'member', CREATED_AT],
      );
      await client.query(
        `INSERT INTO claudian_cloud.development_actor_mappings (
           project_id, actor_id, member_id, created_at
         ) VALUES ($1, $2, $2, $3)`,
        [fixture.projectId, actor, CREATED_AT],
      );
    }
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, 'collaboration-gate-node', $2, 1, true, $3, $3)`,
      [fixture.projectId, fixture.repositoryStorageKey, CREATED_AT],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, 'collaboration-gate-node', $2, 1)`,
      [fixture.projectId, fixture.repositoryStorageKey],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

type ActiveOperation = Exclude<CollabControlOperation, 'acceptRequest'>;

function envelope(data: unknown, requestId: string): unknown {
  return { data, protocolVersion: COLLAB_PROTOCOL_VERSION, requestId };
}

async function collaborationOperation(
  baseUrl: string,
  operation: ActiveOperation,
  actor: typeof ACTORS[number],
  data: unknown,
  requestId: string,
  projectId = PROJECT_ID,
): Promise<unknown> {
  const route = collabCloudProjectOperationRoute(projectId, operation);
  const response = await fetch(`${baseUrl}${route.target}`, {
    body: JSON.stringify(envelope(data, requestId)),
    headers: {
      'content-type': 'application/json',
      'x-claudian-development-actor': actor,
    },
    method: route.method,
  });
  const value: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  const decoded = decodeCollabCloudSuccessEnvelope(value).data;
  return (collabControlOperationCodec(operation) as Readonly<{
    decodeResponse(input: unknown): unknown;
  }>).decodeResponse(decoded);
}

async function collaborationFailure(
  baseUrl: string,
  operation: ActiveOperation,
  actor: typeof ACTORS[number],
  data: unknown,
  requestId: string,
): Promise<Readonly<{ code: string; status: number }>> {
  const route = collabCloudProjectOperationRoute(PROJECT_ID, operation);
  const response = await fetch(`${baseUrl}${route.target}`, {
    body: JSON.stringify(envelope(data, requestId)),
    headers: {
      'content-type': 'application/json',
      'x-claudian-development-actor': actor,
    },
    method: route.method,
  });
  const error = decodeCollabCloudErrorEnvelope(await response.json());
  return Object.freeze({ code: error.error.code, status: response.status });
}

async function projectSnapshot(
  baseUrl: string,
  actor: typeof ACTORS[number],
) {
  const route = collabCloudProjectOperationRoute(PROJECT_ID, 'getProjectSnapshot');
  const response = await fetch(`${baseUrl}${route.target}`, {
    body: JSON.stringify(envelope(
      { projectId: PROJECT_ID },
      `request-snapshot-${actor}`,
    )),
    headers: {
      'content-type': 'application/json',
      'x-claudian-development-actor': actor,
    },
    method: route.method,
  });
  const value: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return decodeCollabCloudProjectSnapshot(
    decodeCollabCloudSuccessEnvelope(value).data,
  );
}

function socketData(data: RawData): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
}

async function firstProjectEvent(
  baseUrl: string,
  actor: typeof ACTORS[number],
): Promise<unknown> {
  const route = collabCloudProjectEventsRoute(PROJECT_ID, 0);
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/u, 'ws')}${route.target}`,
    { headers: { 'x-claudian-development-actor': actor } },
  );
  try {
    await once(socket, 'open');
    const [raw] = await once(socket, 'message') as [RawData];
    return decodeCollabCloudProjectEventMessage(
      JSON.parse(socketData(raw).toString('utf8')) as unknown,
    );
  } finally {
    socket.close();
    if (socket.readyState !== WebSocket.CLOSED) await once(socket, 'close');
  }
}

async function pushPersonalCommit(
  root: string,
  repositoryPath: string,
  baseUrl: string,
  actor: typeof ACTORS[number],
): Promise<string> {
  const checkout = join(root, `checkout-${actor}`);
  const personalRef = collabMemberRef(actor);
  await git(root, [
    'clone',
    '--branch',
    personalRef.slice('refs/heads/'.length),
    repositoryPath,
    checkout,
  ]);
  await git(checkout, ['config', 'user.name', actor]);
  await git(checkout, ['config', 'user.email', `${actor}@example.invalid`]);
  await writeFile(join(checkout, 'later.txt'), 'later\n');
  await git(checkout, ['add', 'later.txt']);
  await git(checkout, ['commit', '-m', 'later personal change']);
  const oid = await git(checkout, ['rev-parse', 'HEAD']);
  await git(checkout, [
    '-c',
    `http.extraHeader=X-Claudian-Development-Actor: ${actor}`,
    'push',
    `${baseUrl}/v1/projects/${PROJECT_ID}/repository.git`,
    `HEAD:${personalRef}`,
  ]);
  return oid;
}

async function createBlockingGitWrapper(root: string): Promise<Readonly<{
  enabledPath: string;
  executable: string;
  releasePath: string;
  startedPath: string;
}>> {
  const executable = join(root, 'git-with-receive-gate');
  const enabledPath = join(root, 'receive-gate-enabled');
  const releasePath = join(root, 'receive-gate-release');
  const startedPath = join(root, 'receive-gate-started');
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "receive-pack" ] && [ "$2" = "--stateless-rpc" ] && [ "$3" = "." ] && [ -f "${enabledPath}" ]; then
  /usr/bin/touch "${startedPath}"
  while [ ! -f "${releasePath}" ]; do /bin/sleep 0.01; done
fi
exec ${GIT_EXECUTABLE} "$@"
`);
  await chmod(executable, 0o700);
  return Object.freeze({ enabledPath, executable, releasePath, startedPath });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error('collaboration-gate-marker-timeout');
}

describe('collaboration operation gate', { concurrency: false }, () => {
  it('activates Request and Ticket transport for two clients', async () => {
    const database = await acquirePostgresTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'claudian-collaboration-gate-'));
    const repositoryRoot = join(root, 'repositories');
    const stagingRoot = join(root, 'staging');
    const seed = new Client({ connectionString: database.migrationUrl });
    let application: Application | undefined;
    try {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await mkdir(repositoryRoot, { mode: 0o700 });
      await mkdir(stagingRoot, { mode: 0o700 });
      await writeFile(
        join(root, '.authority-volume-id'),
        `${database.authorityVolumeId}\n`,
        { mode: 0o600 },
      );
      const fixture = await createRepository(root, repositoryRoot);
      const secondFixture = await createRepository(
        root,
        repositoryRoot,
        SECOND_PROJECT_ID,
        'secondary',
      );
      const receiveGate = await createBlockingGitWrapper(root);
      await seed.connect();
      await seedProject(seed, fixture);
      await seedProject(seed, secondFixture);
      const applicationConfig = config(
        database.runtimeUrl,
        repositoryRoot,
        stagingRoot,
        receiveGate.executable,
      );
      application = createApplication({
        config: applicationConfig,
        logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
      });
      const address = await application.start();
      const baseUrl = `http://${address.host}:${String(address.port)}`;
      const capabilityResponse = await fetch(`${baseUrl}/collab/capabilities`);
      assert.equal(capabilityResponse.status, 200);
      const capabilities = decodeCollabCloudCapabilityDocument(
        await capabilityResponse.json(),
      );
      assert.equal(capabilities.capabilities.includes('requests'), true);
      assert.equal(capabilities.capabilities.includes('tickets'), true);
      assert.equal(capabilities.capabilities.includes('accept'), false);

      const ticketCreateInput = {
        body: 'Initial ticket body mentioning @member-bob',
        idempotencyKey: 'idempotency-ticket-create',
        projectId: PROJECT_ID,
        title: 'Initial ticket',
      };
      const createdTicket = await collaborationOperation(
        baseUrl,
        'createTicket',
        ACTORS[0],
        ticketCreateInput,
        'request-ticket-create',
      ) as {
        readonly ticket: {
          readonly body: string;
          readonly ticket: { readonly id: string; readonly revision: number };
        };
      };
      const ticketId = createdTicket.ticket.ticket.id;
      const replayedTicket = await collaborationOperation(
        baseUrl,
        'createTicket',
        ACTORS[0],
        ticketCreateInput,
        'request-ticket-create-replay',
      );
      assert.deepEqual(replayedTicket, createdTicket);
      assert.deepEqual(await collaborationFailure(
        baseUrl,
        'createTicket',
        ACTORS[0],
        { ...ticketCreateInput, title: 'Conflicting reuse' },
        'request-ticket-create-conflict',
      ), { code: 'idempotency-conflict', status: 409 });

      const ensureInputs = ACTORS.map((actor, index) => ({
        description: index === 0
          ? 'Publish Alice\n\nReferences #1'
          : 'Publish Bob',
        expectedMainOid: fixture.mainOid,
        headOid: fixture.mainOid,
        idempotencyKey: `idempotency-ensure-${actor}`,
        projectId: PROJECT_ID,
      }));
      const requests = await Promise.all(ACTORS.map((actor, index) => (
        collaborationOperation(
          baseUrl,
          'ensureMyRequest',
          actor,
          ensureInputs[index],
          `request-ensure-${actor}`,
        )
      ))) as readonly {
        readonly mainOid: string;
        readonly request: {
          readonly id: string;
          readonly memberId: string;
          readonly revision: number;
        };
      }[];
      assert.deepEqual(
        requests.map(result => result.request.memberId),
        [...ACTORS],
      );
      const aliceRequest = requests[0];
      assert.ok(aliceRequest);
      assert.deepEqual(
        await collaborationOperation(
          baseUrl,
          'ensureMyRequest',
          ACTORS[0],
          ensureInputs[0],
          'request-ensure-alice-replay',
        ),
        aliceRequest,
      );
      assert.deepEqual(await collaborationFailure(
        baseUrl,
        'ensureMyRequest',
        ACTORS[0],
        { ...ensureInputs[0], description: 'Conflicting request reuse' },
        'request-ensure-alice-conflict',
      ), { code: 'idempotency-conflict', status: 409 });

      const requestDetail = await collaborationOperation(
        baseUrl,
        'getRequest',
        ACTORS[1],
        { projectId: PROJECT_ID, requestId: aliceRequest.request.id },
        'request-detail',
      ) as {
        readonly reviewCondition: string;
        readonly request: { readonly revision: number };
      };
      assert.equal(requestDetail.reviewCondition, 'clean');
      const requestComment = await collaborationOperation(
        baseUrl,
        'createComment',
        ACTORS[1],
        {
          body: 'Review comment',
          idempotencyKey: 'idempotency-request-comment',
          projectId: PROJECT_ID,
          requestId: aliceRequest.request.id,
        },
        'request-comment-create',
      ) as {
        readonly comment: { readonly authorMemberId: string };
        readonly request: { readonly revision: number };
      };
      assert.equal(requestComment.comment.authorMemberId, ACTORS[1]);
      const requestComments = await collaborationOperation(
        baseUrl,
        'listRequestComments',
        ACTORS[0],
        { projectId: PROJECT_ID, requestId: aliceRequest.request.id },
        'request-comment-list',
      ) as { readonly comments: readonly unknown[] };
      assert.equal(requestComments.comments.length, 1);
      const updatedRequest = await collaborationOperation(
        baseUrl,
        'updateMyRequestMetadata',
        ACTORS[0],
        {
          description: 'Updated Publish Alice\n\nReferences #1',
          expectedHeadOid: fixture.mainOid,
          expectedRequestRevision: requestComment.request.revision,
          idempotencyKey: 'idempotency-request-update',
          projectId: PROJECT_ID,
          requestId: aliceRequest.request.id,
        },
        'request-metadata-update',
      ) as { readonly request: { readonly description: string } };
      assert.match(updatedRequest.request.description, /^Updated Publish Alice/u);

      const ticketDetail = await collaborationOperation(
        baseUrl,
        'getTicket',
        ACTORS[1],
        { projectId: PROJECT_ID, ticketId },
        'request-ticket-detail',
      ) as { readonly body: string; readonly ticket: { readonly revision: number } };
      assert.equal(ticketDetail.body, ticketCreateInput.body);
      const ticketUpdated = await collaborationOperation(
        baseUrl,
        'updateTicketContent',
        ACTORS[0],
        {
          body: 'Updated ticket body',
          expectedRevision: ticketDetail.ticket.revision,
          idempotencyKey: 'idempotency-ticket-update',
          projectId: PROJECT_ID,
          ticketId,
          title: 'Updated ticket',
        },
        'request-ticket-update',
      ) as { readonly ticket: { readonly revision: number; readonly title: string } };
      assert.equal(ticketUpdated.ticket.title, 'Updated ticket');
      const ticketComment = await collaborationOperation(
        baseUrl,
        'createTicketComment',
        ACTORS[1],
        {
          body: 'Ticket comment from Bob',
          idempotencyKey: 'idempotency-ticket-comment',
          projectId: PROJECT_ID,
          ticketId,
        },
        'request-ticket-comment-create',
      ) as {
        readonly comment: { readonly authorMemberId: string };
        readonly ticket: { readonly revision: number };
      };
      assert.equal(ticketComment.comment.authorMemberId, ACTORS[1]);
      const ticketComments = await collaborationOperation(
        baseUrl,
        'listTicketComments',
        ACTORS[0],
        { projectId: PROJECT_ID, ticketId },
        'request-ticket-comment-list',
      ) as { readonly comments: readonly unknown[] };
      assert.equal(ticketComments.comments.length, 1);
      const ticketRelations = await collaborationOperation(
        baseUrl,
        'listTicketAcceptedRelations',
        ACTORS[1],
        { projectId: PROJECT_ID, ticketId },
        'request-ticket-relation-list',
      ) as { readonly acceptedRelations: readonly unknown[] };
      assert.deepEqual(ticketRelations.acceptedRelations, []);
      const closedTicket = await collaborationOperation(
        baseUrl,
        'closeTicket',
        ACTORS[0],
        {
          expectedRevision: ticketComment.ticket.revision,
          idempotencyKey: 'idempotency-ticket-close',
          projectId: PROJECT_ID,
          ticketId,
        },
        'request-ticket-close',
      ) as { readonly ticket: { readonly revision: number; readonly status: string } };
      assert.equal(closedTicket.ticket.status, 'closed');
      const reopenedTicket = await collaborationOperation(
        baseUrl,
        'reopenTicket',
        ACTORS[0],
        {
          expectedRevision: closedTicket.ticket.revision,
          idempotencyKey: 'idempotency-ticket-reopen',
          projectId: PROJECT_ID,
          ticketId,
        },
        'request-ticket-reopen',
      ) as { readonly ticket: { readonly status: string } };
      assert.equal(reopenedTicket.ticket.status, 'open');
      const tickets = await collaborationOperation(
        baseUrl,
        'listTickets',
        ACTORS[1],
        { projectId: PROJECT_ID, status: 'all' },
        'request-ticket-list',
      ) as { readonly tickets: readonly { readonly id: string }[] };
      assert.deepEqual(tickets.tickets.map(ticket => ticket.id), [ticketId]);

      const snapshot = await projectSnapshot(baseUrl, ACTORS[1]);
      assert.equal(snapshot.openRequests.length, 2);
      assert.equal(snapshot.openTicketCount, 1);
      assert.deepEqual(snapshot.ticketHighlights.map(ticket => ticket.id), [ticketId]);
      const firstEvent = await firstProjectEvent(baseUrl, ACTORS[1]) as {
        readonly kind: string;
        readonly projectId?: string;
        readonly sequence?: number;
      };
      assert.equal(firstEvent.projectId, PROJECT_ID);
      assert.equal(firstEvent.sequence, 1);

      await application.close();
      application = createApplication({
        config: applicationConfig,
        logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
      });
      const restarted = await application.start();
      const restartedUrl = `http://${restarted.host}:${String(restarted.port)}`;
      assert.deepEqual(
        await collaborationOperation(
          restartedUrl,
          'ensureMyRequest',
          ACTORS[0],
          ensureInputs[0],
          'request-ensure-alice-restart-replay',
        ),
        aliceRequest,
      );
      const restartedSnapshot = await projectSnapshot(restartedUrl, ACTORS[0]);
      assert.equal(restartedSnapshot.openRequests.length, 2);
      assert.equal(restartedSnapshot.openTicketCount, 1);

      await writeFile(receiveGate.enabledPath, 'enabled\n');
      const personalPush = pushPersonalCommit(
        root,
        fixture.repositoryPath,
        restartedUrl,
        ACTORS[0],
      );
      await waitForFile(receiveGate.startedPath);
      let sameProjectSettled = false;
      const sameProjectMutation = collaborationOperation(
        restartedUrl,
        'createTicket',
        ACTORS[1],
        {
          body: 'Same Project contention',
          idempotencyKey: 'idempotency-same-project-contention',
          projectId: PROJECT_ID,
          title: 'Same Project contention',
        },
        'request-same-project-contention',
      ).finally(() => {
        sameProjectSettled = true;
      });
      const differentProjectMutation = collaborationOperation(
        restartedUrl,
        'createTicket',
        ACTORS[1],
        {
          body: 'Different Project progress',
          idempotencyKey: 'idempotency-different-project-progress',
          projectId: SECOND_PROJECT_ID,
          title: 'Different Project progress',
        },
        'request-different-project-progress',
        SECOND_PROJECT_ID,
      );
      await Promise.race([
        differentProjectMutation,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('different-project-progress-timeout')),
            2_000,
          );
          timer.unref();
        }),
      ]);
      assert.equal(sameProjectSettled, false);
      await writeFile(receiveGate.releasePath, 'released\n');
      await Promise.all([personalPush, sameProjectMutation]);
      const staleDetail = await collaborationOperation(
        restartedUrl,
        'getRequest',
        ACTORS[0],
        { projectId: PROJECT_ID, requestId: aliceRequest.request.id },
        'request-detail-stale',
      ) as { readonly reviewCondition: string };
      assert.equal(staleDetail.reviewCondition, 'stale');
    } finally {
      await seed.query('ROLLBACK').catch(() => undefined);
      await seed.end().catch(() => undefined);
      await application?.close().catch(() => undefined);
      await database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
