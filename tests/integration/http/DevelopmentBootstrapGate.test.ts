import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabDevelopmentBootstrapRoute,
  collabMemberRef,
  decodeCollabCloudCapabilityDocument,
  decodeCollabCloudSuccessEnvelope,
  encodeDevelopmentBootstrapManifestCanonicalJson,
  type DevelopmentBootstrapAttemptStatus,
  type DevelopmentBootstrapManifest,
  type DevelopmentBootstrapReport,
} from '@claudian/collab-protocol';

import { createApplication } from '../../../src/composition/createApplication.js';
import type { ServerConfig } from '../../../src/config/ServerConfig.js';
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
    gitAdmission: Object.freeze({
      maxChildren: 2,
      maxChildrenPerProject: 1,
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

async function createBundle(root: string): Promise<BundleFixture> {
  const working = join(root, 'working');
  const bundlePath = join(root, 'project.bundle');
  await mkdir(working);
  await git(working, ['init', '--initial-branch=main']);
  await git(working, ['config', 'user.name', 'Gate Test']);
  await git(working, ['config', 'user.email', 'gate@claudian.local']);
  await writeFile(join(working, 'shared.md'), 'main\n');
  await git(working, ['add', 'shared.md']);
  await git(working, ['commit', '-m', 'main']);
  const mainOid = await git(working, ['rev-parse', 'HEAD']);

  await git(working, ['switch', '-c', `members/${HOST_MEMBER_ID}`]);
  await writeFile(join(working, 'alice.md'), 'alice\n');
  await git(working, ['add', 'alice.md']);
  await git(working, ['commit', '-m', 'alice']);
  const hostOid = await git(working, ['rev-parse', 'HEAD']);

  await git(working, ['switch', 'main']);
  await git(working, ['switch', '-c', `members/${OTHER_MEMBER_ID}`]);
  await writeFile(join(working, 'bob.md'), 'bob\n');
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
      projectId: PROJECT_ID,
      projectName: 'Gate Project',
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
    bundle = await createBundle(root);
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
    assert.deepEqual(capabilities.capabilities, ['development-bootstrap']);

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

    await application.close();
    application = createApplication({
      config: applicationConfig,
      logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
    });
    const restartedAddress = await application.start();
    const restartedUrl = `http://${restartedAddress.host}:${String(restartedAddress.port)}`;
    try {
      const replayed = await jsonOperation(
        restartedUrl,
        'getDevelopmentBootstrap',
        OTHER_MEMBER_ID,
        activeManifest.attemptId,
      );
      assert.deepEqual(replayed.activationResult, activated.activationResult);
      assert.equal(replayed.activationPhase, 'completed');
      assert.equal(replayed.state, 'activated');

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
    } finally {
      await application.close();
    }
    } finally {
      await application.close().catch(() => undefined);
    }
  });
});
