import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  after,
  before,
  describe,
  it,
} from 'node:test';

import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabDevelopmentBootstrapRoute,
  collabCloudProjectEventsRoute,
  collabCloudGitRoute,
  collabCloudProjectOperationRoute,
  collabMemberRef,
  decodeCollabCloudCapabilityDocument,
  decodeCollabCloudProjectEventMessage,
  decodeCollabCloudSuccessEnvelope,
  encodeDevelopmentBootstrapManifestCanonicalJson,
  type DevelopmentBootstrapAttemptStatus,
  type DevelopmentBootstrapManifest,
  type DevelopmentBootstrapReport,
} from '@claudian/collab-protocol';
import { Client } from 'pg';
import { type RawData, WebSocket } from 'ws';

import { createApplication } from '../../../src/composition/createApplication.js';
import type { ServerConfig } from '../../../src/config/ServerConfig.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import { SafeLogger } from '../../../src/observability/SafeLogger.js';
import {
  acquirePostgresTestDatabase,
  type PostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const PROJECT_ID = 'project-gate';
const HOST_MEMBER_ID = 'member-alice';
const OTHER_MEMBER_ID = 'member-bob';

interface BundleFixture {
  readonly bytes: Buffer;
  readonly mainOid: string;
  readonly refs: DevelopmentBootstrapManifest['git']['refs'];
  readonly sha256: string;
}

function config(
  database: PostgresTestDatabase,
  repositoryRoot: string,
  stagingRoot: string,
): ServerConfig {
  const maxBundleBytes = 16 * 1024 * 1024;
  const maxRepositoryBytes = COLLAB_LIMITS.maxBlobBytes;
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
      maxChildren: 2,
      maxChildrenPerProject: 1,
      maxQueuedReads: 5,
      maxQueuedWrites: 5,
      maxReadChildren: 1,
      maxWriteChildren: 1,
      queueMax: 6,
      queueMaxPerProject: 4,
      queueTimeoutMs: 2_000,
    }),
    http: Object.freeze({ host: '127.0.0.1', port: 0 }),
    postgres: Object.freeze({
      ordinaryPoolMax: 2,
      pinnedPoolMax: 1,
      projectLockTimeoutMs: 2_000,
      reservedPoolMax: 1,
      url: database.runtimeUrl,
    }),
    repository: Object.freeze({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 10_000,
      outputMaxBytes: 256 * 1024,
      root: repositoryRoot,
      storageNodeId: 'gate-node',
    }),
    shutdownTimeoutMs: 5_000,
  });
}

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, arguments_, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function createBundle(root: string, fixtureId: string): Promise<BundleFixture> {
  const working = join(root, `working-${fixtureId}`);
  const bundlePath = join(root, `project-${fixtureId}.bundle`);
  await mkdir(working);
  await git(working, ['init', '--initial-branch=main']);
  await git(working, ['config', 'user.name', 'Gate Test']);
  await git(working, ['config', 'user.email', 'gate@claudian.local']);
  await writeFile(join(working, 'shared.md'), `main-${fixtureId}\n`);
  await git(working, ['add', 'shared.md']);
  await git(working, ['commit', '-m', 'main']);
  const mainOid = await git(working, ['rev-parse', 'HEAD']);

  await git(working, ['switch', '-c', `members/${HOST_MEMBER_ID}`]);
  await writeFile(join(working, 'alice.md'), `alice-${fixtureId}\n`);
  await git(working, ['add', 'alice.md']);
  await git(working, ['commit', '-m', 'alice']);
  const hostOid = await git(working, ['rev-parse', 'HEAD']);

  await git(working, ['switch', 'main']);
  await git(working, ['switch', '-c', `members/${OTHER_MEMBER_ID}`]);
  await writeFile(join(working, 'bob.md'), `bob-${fixtureId}\n`);
  await git(working, ['add', 'bob.md']);
  await git(working, ['commit', '-m', 'bob']);
  const otherOid = await git(working, ['rev-parse', 'HEAD']);

  const refs = [{ name: COLLAB_MAIN_REF, oid: mainOid }, {
    name: collabMemberRef(HOST_MEMBER_ID),
    oid: hostOid,
  }, {
    name: collabMemberRef(OTHER_MEMBER_ID),
    oid: otherOid,
  }].sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
  await git(working, ['bundle', 'create', bundlePath, ...refs.map(ref => ref.name)]);
  const bytes = await readFile(bundlePath);
  return Object.freeze({
    bytes,
    mainOid,
    refs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

function manifest(
  attemptId: string,
  bundle: BundleFixture,
  createdAt: string,
  projectId = PROJECT_ID,
): DevelopmentBootstrapManifest {
  return {
    attemptId,
    comparison: {
      mainOid: bundle.mainOid,
      mainRef: COLLAB_MAIN_REF,
      managerSetGeneration: 1,
      members: [{
        activatedAt: '2026-08-20T00:00:00.000Z',
        createdAt: '2026-08-19T00:00:00.000Z',
        displayName: 'Alice',
        memberId: HOST_MEMBER_ID,
        personalRef: collabMemberRef(HOST_MEMBER_ID),
        role: 'manager',
        status: 'active',
      }, {
        activatedAt: '2026-08-20T00:01:00.000Z',
        createdAt: '2026-08-19T00:01:00.000Z',
        displayName: 'Bob',
        memberId: OTHER_MEMBER_ID,
        personalRef: collabMemberRef(OTHER_MEMBER_ID),
        role: 'member',
        status: 'active',
      }],
      projectCreatedAt: '2026-08-19T00:00:00.000Z',
      projectId,
      projectName: `Gate Project ${projectId}`,
      sourceCaFingerprint: 'a'.repeat(64),
      sourceEventSequence: 0,
      sourceHostMemberId: HOST_MEMBER_ID,
    },
    createdAt,
    git: {
      bundle: { byteCount: bundle.bytes.length, sha256: bundle.sha256 },
      objectFormat: 'sha1',
      refs: bundle.refs,
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
  };
}

async function activateProject(
  baseUrl: string,
  source: DevelopmentBootstrapManifest,
  bundle: BundleFixture,
): Promise<DevelopmentBootstrapAttemptStatus> {
  const stoppedAt = new Date(Date.now() - 2_000).toISOString();
  const capturedAt = new Date(Date.now() - 1_000).toISOString();
  await jsonOperation(
    baseUrl,
    'beginDevelopmentBootstrap',
    HOST_MEMBER_ID,
    source.attemptId,
    { manifest: source },
  );
  for (const actor of [HOST_MEMBER_ID, OTHER_MEMBER_ID]) {
    await jsonOperation(
      baseUrl,
      'submitDevelopmentBootstrapReport',
      actor,
      source.attemptId,
      {
        attemptId: source.attemptId,
        report: report(source, actor, capturedAt, stoppedAt),
      },
    );
  }
  const uploadRoute = collabDevelopmentBootstrapRoute(
    'putDevelopmentBootstrapGitBundle',
    source.attemptId,
  );
  const uploadResponse = await fetch(`${baseUrl}${uploadRoute.target}`, {
    body: new Uint8Array(bundle.bytes),
    headers: {
      'content-encoding': 'identity',
      'content-type': 'application/x-git-bundle',
      'x-claudian-development-actor': HOST_MEMBER_ID,
    },
    method: uploadRoute.method,
  });
  assert.equal(uploadResponse.status, 200, await uploadResponse.text());
  const manifestSha256 = createHash('sha256')
    .update(encodeDevelopmentBootstrapManifestCanonicalJson(source))
    .digest('hex');
  return jsonOperation(
    baseUrl,
    'activateDevelopmentBootstrap',
    HOST_MEMBER_ID,
    source.attemptId,
    { attemptId: source.attemptId, manifestSha256 },
  );
}

async function projectSnapshot(
  baseUrl: string,
  projectId: string,
  actor: string,
) {
  const route = collabCloudProjectOperationRoute(projectId, 'getProjectSnapshot');
  const response = await fetch(`${baseUrl}${route.target}`, {
    body: JSON.stringify(envelope({ projectId }, `snapshot-${projectId}-${actor}`)),
    headers: {
      'content-type': 'application/json',
      'x-claudian-development-actor': actor,
    },
    method: route.method,
  });
  const value: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeResponse(
    decodeCollabCloudSuccessEnvelope(value).data,
  );
}

async function projectSnapshotStatus(
  baseUrl: string,
  projectId: string,
  actor: string,
): Promise<number> {
  const route = collabCloudProjectOperationRoute(projectId, 'getProjectSnapshot');
  const response = await fetch(`${baseUrl}${route.target}`, {
    body: JSON.stringify(envelope({ projectId }, `denied-${projectId}-${actor}`)),
    headers: {
      'content-type': 'application/json',
      'x-claudian-development-actor': actor,
    },
    method: route.method,
  });
  await response.arrayBuffer();
  return response.status;
}

async function gitAdvertisementStatus(
  baseUrl: string,
  projectId: string,
  actor: string,
): Promise<number> {
  const route = collabCloudGitRoute(projectId, 'info-refs', 'git-upload-pack');
  const response = await fetch(`${baseUrl}${route.target}`, {
    headers: { 'x-claudian-development-actor': actor },
    method: route.method,
  });
  await response.arrayBuffer();
  return response.status;
}

async function fetchProject(
  root: string,
  baseUrl: string,
  projectId: string,
  actor: string,
  personalRef: string,
  expectedMainOid: string,
  expectedPersonalOid: string,
): Promise<void> {
  const checkout = join(root, `fetch-${projectId}-${actor}`);
  await mkdir(checkout);
  await git(checkout, ['init', '--initial-branch=main']);
  await git(checkout, [
    'remote',
    'add',
    'origin',
    `${baseUrl}/v1/projects/${projectId}/repository.git`,
  ]);
  await git(checkout, [
    '-c',
    `http.extraHeader=X-Claudian-Development-Actor: ${actor}`,
    'fetch',
    'origin',
    `+${COLLAB_MAIN_REF}:refs/remotes/origin/main`,
    `+${personalRef}:refs/remotes/origin/${personalRef.slice('refs/heads/'.length)}`,
  ]);
  assert.equal(await git(checkout, ['rev-parse', 'refs/remotes/origin/main']), expectedMainOid);
  assert.equal(
    await git(checkout, [
      'rev-parse',
      `refs/remotes/origin/${personalRef.slice('refs/heads/'.length)}`,
    ]),
    expectedPersonalOid,
  );
}

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

async function openEventConnection(
  baseUrl: string,
  projectId: string,
  actor: string,
  afterSequence: number,
): Promise<{
  readonly closed: Promise<unknown[]>;
  readonly message: Promise<unknown[]>;
  readonly socket: WebSocket;
}> {
  const route = collabCloudProjectEventsRoute(projectId, afterSequence);
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/u, 'ws')}${route.target}`,
    { headers: { 'x-claudian-development-actor': actor } },
  );
  const closed = once(socket, 'close');
  const message = once(socket, 'message');
  await within(once(socket, 'open'), 'event-open');
  return { closed, message, socket };
}

async function rejectedEventConnectionStatus(
  baseUrl: string,
  projectId: string,
  actor: string,
): Promise<number> {
  const route = collabCloudProjectEventsRoute(projectId, 0);
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/u, 'ws')}${route.target}`,
    { headers: { 'x-claudian-development-actor': actor } },
  );
  return within(new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => {
      socket.close();
      reject(new Error('event-upgrade-unexpectedly-authorized'));
    });
    socket.once('error', reject);
  }), 'event-rejection');
}

async function proveEventReplayAndGap(
  baseUrl: string,
  projectId: string,
  actor: string,
  latestSequence: number,
): Promise<void> {
  const replay = await openEventConnection(baseUrl, projectId, actor, 0);
  const [rawReplay] = await within(replay.message, 'event-replay') as [RawData];
  const replayed = decodeCollabCloudProjectEventMessage(
    JSON.parse(socketData(rawReplay).toString('utf8')) as unknown,
  );
  assert.notEqual(replayed.kind, 'snapshot.required');
  if (replayed.kind === 'snapshot.required') throw new Error('Expected replay event');
  assert.equal(replayed.projectId, projectId);
  assert.equal(replayed.sequence, 1);
  replay.socket.close();
  await within(replay.closed, 'event-replay-close');

  const gap = await openEventConnection(
    baseUrl,
    projectId,
    actor,
    latestSequence + 1,
  );
  const [rawGap] = await within(gap.message, 'event-gap') as [RawData];
  assert.deepEqual(
    decodeCollabCloudProjectEventMessage(
      JSON.parse(socketData(rawGap).toString('utf8')) as unknown,
    ),
    { kind: 'snapshot.required', latestSequence },
  );
  const [code] = await within(gap.closed, 'event-gap-close');
  assert.equal(code, 1_000);
}

function socketData(data: RawData): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
}

async function appendGateEvents(
  database: PostgresTestDatabase,
  projectIds: readonly string[],
): Promise<void> {
  const coordination = new PostgresCoordination({
    ordinaryPoolMax: 2,
    pinnedPoolMax: 1,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
  try {
    for (const projectId of projectIds) {
      await coordination.withProjectScope(projectId, scope => scope.appendProjectEvent({
        kind: 'membership.updated',
        occurredAt: new Date().toISOString(),
        payload: { memberId: HOST_MEMBER_ID },
      }));
    }
  } finally {
    await coordination.close();
  }
}

async function removeDevelopmentActorMapping(
  database: PostgresTestDatabase,
  projectId: string,
  actorId: string,
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [projectId],
    );
    const deleted = await client.query(
      `DELETE FROM claudian_cloud.development_actor_mappings
        WHERE project_id = $1 AND actor_id = $2`,
      [projectId, actorId],
    );
    assert.equal(deleted.rowCount, 1);
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function report(
  source: DevelopmentBootstrapManifest,
  reporterMemberId: string,
  capturedAt: string,
  stoppedAt: string,
): DevelopmentBootstrapReport {
  const member = source.comparison.members.find(candidate => (
    candidate.memberId === reporterMemberId
  ));
  const ref = source.git.refs.find(candidate => candidate.name === member?.personalRef);
  assert.ok(ref);
  const manifestSha256 = createHash('sha256')
    .update(encodeDevelopmentBootstrapManifestCanonicalJson(source))
    .digest('hex');
  return {
    attemptId: source.attemptId,
    capturedAt,
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
    comparison: source.comparison,
    ...(reporterMemberId === source.comparison.sourceHostMemberId ? {
      hostStopAttestation: {
        attemptId: source.attemptId,
        autoStartDisabled: true,
        fenceDurable: true,
        fenceId: `fence-${source.attemptId}`,
        hostStopped: true,
        manifestSha256,
        projectId: source.comparison.projectId,
        resourcesDrained: true,
        routeUnregistered: true,
        stoppedAt,
      },
    } : {}),
    observedPersonalRefOid: ref.oid,
    reporterMemberId,
  };
}

function envelope(data: unknown, requestId: string): unknown {
  return { data, protocolVersion: COLLAB_PROTOCOL_VERSION, requestId };
}

async function jsonOperation(
  baseUrl: string,
  operation:
    | 'activateDevelopmentBootstrap'
    | 'beginDevelopmentBootstrap'
    | 'cancelDevelopmentBootstrap'
    | 'getDevelopmentBootstrap'
    | 'submitDevelopmentBootstrapReport',
  actor: string,
  attemptId: string,
  data?: unknown,
): Promise<DevelopmentBootstrapAttemptStatus> {
  const route = operation === 'beginDevelopmentBootstrap'
    ? collabDevelopmentBootstrapRoute(operation)
    : collabDevelopmentBootstrapRoute(operation, attemptId);
  const response = await fetch(`${baseUrl}${route.target}`, {
    ...(data === undefined ? {} : { body: JSON.stringify(envelope(data, `request-${operation}`)) }),
    headers: {
      'x-claudian-development-actor': actor,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    method: route.method,
  });
  const value: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return decodeCollabCloudSuccessEnvelope<DevelopmentBootstrapAttemptStatus>(value).data;
}

describe('development bootstrap gate', { concurrency: false }, () => {
  let database: PostgresTestDatabase;
  let root: string;
  let repositoryRoot: string;
  let stagingRoot: string;
  let bundle: BundleFixture;
  let secondBundle: BundleFixture;

  before(async () => {
    database = await acquirePostgresTestDatabase();
    await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
    root = await mkdtemp(join(tmpdir(), 'claudian-bootstrap-gate-'));
    repositoryRoot = join(root, 'repositories');
    stagingRoot = join(root, 'staging');
    await mkdir(repositoryRoot, { mode: 0o700 });
    await mkdir(stagingRoot, { mode: 0o700 });
    await writeFile(join(root, '.authority-volume-id'), `${database.authorityVolumeId}\n`, {
      mode: 0o600,
    });
    bundle = await createBundle(root, 'one');
    secondBundle = await createBundle(root, 'two');
  });

  after(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('runs all six operations for two actors and replays activation after restart', async () => {
    const applicationConfig = config(database, repositoryRoot, stagingRoot);
    let application = createApplication({
      config: applicationConfig,
      logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
    });
    try {
      const address = await application.start();
      const baseUrl = `http://${address.host}:${String(address.port)}`;

    const capabilitiesResponse = await fetch(`${baseUrl}/collab/capabilities`);
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = decodeCollabCloudCapabilityDocument(
      await capabilitiesResponse.json(),
    );
    assert.deepEqual(capabilities.capabilities, [
      'development-bootstrap',
      'git-receive-pack-personal-ref',
      'git-upload-pack',
      'project-events',
      'project-snapshot',
    ]);

    const cancelledManifest = manifest(
      'attempt-cancelled',
      bundle,
      new Date(Date.now() - 4_000).toISOString(),
    );
    await jsonOperation(
      baseUrl,
      'beginDevelopmentBootstrap',
      HOST_MEMBER_ID,
      cancelledManifest.attemptId,
      { manifest: cancelledManifest },
    );
    const cancelled = await jsonOperation(
      baseUrl,
      'cancelDevelopmentBootstrap',
      HOST_MEMBER_ID,
      cancelledManifest.attemptId,
      { attemptId: cancelledManifest.attemptId },
    );
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.cancellationPhase, 'cancelled');

    const createdAt = new Date(Date.now() - 3_000).toISOString();
    const stoppedAt = new Date(Date.now() - 2_000).toISOString();
    const capturedAt = new Date(Date.now() - 1_000).toISOString();
    const activeManifest = manifest('attempt-activated', bundle, createdAt);
    const begun = await jsonOperation(
      baseUrl,
      'beginDevelopmentBootstrap',
      HOST_MEMBER_ID,
      activeManifest.attemptId,
      { manifest: activeManifest },
    );
    assert.equal(begun.state, 'collecting');

    await jsonOperation(
      baseUrl,
      'submitDevelopmentBootstrapReport',
      HOST_MEMBER_ID,
      activeManifest.attemptId,
      {
        attemptId: activeManifest.attemptId,
        report: report(activeManifest, HOST_MEMBER_ID, capturedAt, stoppedAt),
      },
    );
    await jsonOperation(
      baseUrl,
      'submitDevelopmentBootstrapReport',
      OTHER_MEMBER_ID,
      activeManifest.attemptId,
      {
        attemptId: activeManifest.attemptId,
        report: report(activeManifest, OTHER_MEMBER_ID, capturedAt, stoppedAt),
      },
    );

    const uploadRoute = collabDevelopmentBootstrapRoute(
      'putDevelopmentBootstrapGitBundle',
      activeManifest.attemptId,
    );
    const uploadResponse = await fetch(`${baseUrl}${uploadRoute.target}`, {
      body: new Uint8Array(bundle.bytes),
      headers: {
        'content-encoding': 'identity',
        'content-type': 'application/x-git-bundle',
        'x-claudian-development-actor': HOST_MEMBER_ID,
      },
      method: uploadRoute.method,
    });
    const uploadValue: unknown = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200, JSON.stringify(uploadValue));
    const uploaded = decodeCollabCloudSuccessEnvelope<DevelopmentBootstrapAttemptStatus>(
      uploadValue,
    ).data;
    assert.equal(uploaded.bundleState, 'validated');
    assert.equal(uploaded.state, 'ready');

    const observed = await jsonOperation(
      baseUrl,
      'getDevelopmentBootstrap',
      OTHER_MEMBER_ID,
      activeManifest.attemptId,
    );
    assert.equal(observed.state, 'ready');

    const manifestSha256 = createHash('sha256')
      .update(encodeDevelopmentBootstrapManifestCanonicalJson(activeManifest))
      .digest('hex');
    const activated = await jsonOperation(
      baseUrl,
      'activateDevelopmentBootstrap',
      HOST_MEMBER_ID,
      activeManifest.attemptId,
      { attemptId: activeManifest.attemptId, manifestSha256 },
    );
    assert.equal(activated.state, 'activated');
    assert.equal(activated.activationPhase, 'completed');
    assert.ok(activated.activationResult);

    const secondProjectId = 'project-gate-two';
    const secondManifest = manifest(
      'attempt-activated-two',
      secondBundle,
      new Date(Date.now() - 3_000).toISOString(),
      secondProjectId,
    );
    const secondActivated = await activateProject(baseUrl, secondManifest, secondBundle);
    assert.equal(secondActivated.state, 'activated');
    assert.notEqual(activeManifest.comparison.mainOid, secondManifest.comparison.mainOid);

    await application.close();
    application = createApplication({
      config: applicationConfig,
      logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
    });
    const restartedAddress = await application.start();
    const restartedUrl = `http://${restartedAddress.host}:${String(restartedAddress.port)}`;
    try {
      await appendGateEvents(database, [PROJECT_ID, secondProjectId]);
      const replayed = await jsonOperation(
        restartedUrl,
        'getDevelopmentBootstrap',
        OTHER_MEMBER_ID,
        activeManifest.attemptId,
      );
      assert.deepEqual(replayed.activationResult, activated.activationResult);
      assert.equal(replayed.activationPhase, 'completed');
      assert.equal(replayed.state, 'activated');

      for (const source of [activeManifest, secondManifest]) {
        const snapshots = await Promise.all([
          projectSnapshot(restartedUrl, source.comparison.projectId, HOST_MEMBER_ID),
          projectSnapshot(restartedUrl, source.comparison.projectId, OTHER_MEMBER_ID),
        ]);
        assert.deepEqual(snapshots[0].project, snapshots[1].project);
        assert.deepEqual(snapshots[0].members, snapshots[1].members);
        assert.equal(snapshots[0].currentMember.id, HOST_MEMBER_ID);
        assert.equal(snapshots[1].currentMember.id, OTHER_MEMBER_ID);
        assert.equal(snapshots[0].project.expectedMainOid, source.comparison.mainOid);
        for (const [actor, snapshot] of [
          [HOST_MEMBER_ID, snapshots[0]],
          [OTHER_MEMBER_ID, snapshots[1]],
        ] as const) {
          const expectedPersonalOid = source.git.refs.find(ref => (
            ref.name === snapshot.currentMember.personalRef
          ))?.oid;
          assert.ok(expectedPersonalOid !== undefined);
          await fetchProject(
            root,
            restartedUrl,
            source.comparison.projectId,
            actor,
            snapshot.currentMember.personalRef,
            source.comparison.mainOid,
            expectedPersonalOid,
          );
          await proveEventReplayAndGap(
            restartedUrl,
            source.comparison.projectId,
            actor,
            snapshot.eventSequence,
          );
        }
      }

      await removeDevelopmentActorMapping(database, secondProjectId, HOST_MEMBER_ID);
      assert.equal(
        await projectSnapshotStatus(restartedUrl, PROJECT_ID, HOST_MEMBER_ID),
        200,
      );
      const deniedProjectIds = [secondProjectId, 'project-gate-unknown'];
      assert.deepEqual(
        await Promise.all(deniedProjectIds.map(projectId => (
          projectSnapshotStatus(restartedUrl, projectId, HOST_MEMBER_ID)
        ))),
        [404, 404],
      );
      assert.deepEqual(
        await Promise.all(deniedProjectIds.map(projectId => (
          gitAdvertisementStatus(restartedUrl, projectId, HOST_MEMBER_ID)
        ))),
        [404, 404],
      );
      assert.deepEqual(
        await Promise.all(deniedProjectIds.map(projectId => (
          rejectedEventConnectionStatus(restartedUrl, projectId, HOST_MEMBER_ID)
        ))),
        [404, 404],
      );

      const projectDirectory = join(
        repositoryRoot,
        Buffer.from(PROJECT_ID, 'utf8').toString('hex'),
      );
      const repositoryEntries = await readdir(projectDirectory);
      assert.equal(repositoryEntries.length, 1);
      await git(join(projectDirectory, repositoryEntries[0] ?? ''), ['fsck', '--strict']);

      const stagedProject = join(
        stagingRoot,
        Buffer.from(PROJECT_ID, 'utf8').toString('hex'),
      );
      assert.deepEqual(await readdir(stagedProject), []);

      const activeEvents = await openEventConnection(
        restartedUrl,
        PROJECT_ID,
        HOST_MEMBER_ID,
        1,
      );
      const shutdownStartedAt = Date.now();
      const shutdown = application.close();
      await within(activeEvents.closed, 'event-shutdown-close');
      await shutdown;
      assert.equal(Date.now() - shutdownStartedAt < applicationConfig.shutdownTimeoutMs, true);
    } finally {
      await application.close();
    }
    } finally {
      await application.close().catch(() => undefined);
    }
  });
});
