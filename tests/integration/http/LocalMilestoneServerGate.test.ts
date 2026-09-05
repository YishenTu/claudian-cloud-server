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
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabCloudProjectOperationRoute,
  collabDevelopmentBootstrapRoute,
  collabMemberRef,
  decodeCollabCloudCapabilityDocument,
  decodeCollabCloudSuccessEnvelope,
  encodeDevelopmentBootstrapManifestCanonicalJson,
  type DevelopmentBootstrapAttemptStatus,
  type DevelopmentBootstrapManifest,
  type DevelopmentBootstrapReport,
} from '@claudian-collab/protocol';

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
const PROJECT_ID = 'project-local-milestone';
const HOST_MEMBER_ID = 'member-alice';
const OTHER_MEMBER_ID = 'member-bob';

interface BundleFixture {
  readonly bytes: Buffer;
  readonly mainOid: string;
  readonly refs: DevelopmentBootstrapManifest['git']['refs'];
  readonly seedPath: string;
  readonly sha256: string;
}

interface ClientGateResult {
  readonly acceptedMainOid: string;
  readonly localWorkPreserved: boolean;
  readonly requestId: string;
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
    principalProfile: 'private-development',
    repository: Object.freeze({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 10_000,
      outputMaxBytes: 256 * 1024,
      root: repositoryRoot,
      storageNodeId: 'local-milestone-node',
    }),
    shutdownTimeoutMs: 5_000,
  });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function createBundle(root: string): Promise<BundleFixture> {
  const seedPath = join(root, 'seed');
  const bundlePath = join(root, 'project.bundle');
  await mkdir(seedPath);
  await git(seedPath, ['init', '--initial-branch=main']);
  await git(seedPath, ['config', 'user.name', 'Local Milestone']);
  await git(seedPath, ['config', 'user.email', 'gate@claudian.local']);
  await writeFile(join(seedPath, 'shared.md'), 'canonical main\n');
  await git(seedPath, ['add', 'shared.md']);
  await git(seedPath, ['commit', '-m', 'main']);
  const mainOid = await git(seedPath, ['rev-parse', 'HEAD']);
  const memberRefs: { readonly name: string; readonly oid: string }[] = [];
  for (const memberId of [HOST_MEMBER_ID, OTHER_MEMBER_ID]) {
    await git(seedPath, ['switch', '-C', `members/${memberId}`, 'main']);
    await writeFile(join(seedPath, `${memberId}.md`), `${memberId} seed\n`);
    await git(seedPath, ['add', `${memberId}.md`]);
    await git(seedPath, ['commit', '-m', `${memberId} seed`]);
    memberRefs.push({
      name: collabMemberRef(memberId),
      oid: await git(seedPath, ['rev-parse', 'HEAD']),
    });
  }
  const refs = [{ name: COLLAB_MAIN_REF, oid: mainOid }, ...memberRefs];
  refs.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
  await git(seedPath, ['bundle', 'create', bundlePath, ...refs.map(ref => ref.name)]);
  const bytes = await readFile(bundlePath);
  return {
    bytes,
    mainOid,
    refs,
    seedPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function manifest(bundle: BundleFixture): DevelopmentBootstrapManifest {
  return {
    attemptId: 'attempt-local-milestone',
    comparison: {
      mainOid: bundle.mainOid,
      mainRef: COLLAB_MAIN_REF,
      managerSetGeneration: 1,
      members: [{
        activatedAt: '2026-08-23T00:00:00.000Z',
        createdAt: '2026-08-22T00:00:00.000Z',
        displayName: 'Alice',
        memberId: HOST_MEMBER_ID,
        personalRef: collabMemberRef(HOST_MEMBER_ID),
        role: 'manager',
        status: 'active',
      }, {
        activatedAt: '2026-08-23T00:00:01.000Z',
        createdAt: '2026-08-22T00:00:01.000Z',
        displayName: 'Bob',
        memberId: OTHER_MEMBER_ID,
        personalRef: collabMemberRef(OTHER_MEMBER_ID),
        role: 'member',
        status: 'active',
      }],
      projectCreatedAt: '2026-08-22T00:00:00.000Z',
      projectId: PROJECT_ID,
      projectName: 'Local Milestone Project',
      sourceCaFingerprint: 'd'.repeat(64),
      sourceEventSequence: 0,
      sourceHostMemberId: HOST_MEMBER_ID,
    },
    createdAt: new Date(Date.now() - 3_000).toISOString(),
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
  memberId: string,
): DevelopmentBootstrapReport {
  const member = source.comparison.members.find(candidate => candidate.memberId === memberId);
  const personal = source.git.refs.find(candidate => candidate.name === member?.personalRef);
  assert.ok(personal);
  const manifestSha256 = createHash('sha256')
    .update(encodeDevelopmentBootstrapManifestCanonicalJson(source))
    .digest('hex');
  return {
    attemptId: source.attemptId,
    capturedAt: new Date(Date.now() - 1_000).toISOString(),
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
    ...(memberId === HOST_MEMBER_ID ? {
      hostStopAttestation: {
        attemptId: source.attemptId,
        autoStartDisabled: true,
        fenceDurable: true,
        fenceId: 'local-milestone-fence',
        hostStopped: true,
        manifestSha256,
        projectId: PROJECT_ID,
        resourcesDrained: true,
        routeUnregistered: true,
        stoppedAt: new Date(Date.now() - 2_000).toISOString(),
      },
    } : {}),
    observedPersonalRefOid: personal.oid,
    reporterMemberId: memberId,
  };
}

function envelope(data: unknown, requestId: string): unknown {
  return { data, protocolVersion: COLLAB_PROTOCOL_VERSION, requestId };
}

async function bootstrap(
  baseUrl: string,
  source: DevelopmentBootstrapManifest,
  bundle: BundleFixture,
): Promise<DevelopmentBootstrapAttemptStatus> {
  const operation = async (
    name: 'activateDevelopmentBootstrap' | 'beginDevelopmentBootstrap'
      | 'submitDevelopmentBootstrapReport',
    actor: string,
    data: unknown,
  ) => {
    const route = name === 'beginDevelopmentBootstrap'
      ? collabDevelopmentBootstrapRoute(name)
      : collabDevelopmentBootstrapRoute(name, source.attemptId);
    const response = await fetch(`${baseUrl}${route.target}`, {
      body: JSON.stringify(envelope(data, `gate-${name}-${actor}`)),
      headers: {
        'content-type': 'application/json',
        'x-claudian-development-actor': actor,
      },
      method: route.method,
    });
    const value: unknown = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return decodeCollabCloudSuccessEnvelope<DevelopmentBootstrapAttemptStatus>(value).data;
  };
  await operation('beginDevelopmentBootstrap', HOST_MEMBER_ID, { manifest: source });
  for (const memberId of [HOST_MEMBER_ID, OTHER_MEMBER_ID]) {
    await operation('submitDevelopmentBootstrapReport', memberId, {
      attemptId: source.attemptId,
      report: report(source, memberId),
    });
  }
  const uploadRoute = collabDevelopmentBootstrapRoute(
    'putDevelopmentBootstrapGitBundle',
    source.attemptId,
  );
  const upload = await fetch(`${baseUrl}${uploadRoute.target}`, {
    body: new Uint8Array(bundle.bytes),
    headers: {
      'content-encoding': 'identity',
      'content-type': 'application/x-git-bundle',
      'x-claudian-development-actor': HOST_MEMBER_ID,
    },
    method: uploadRoute.method,
  });
  assert.equal(upload.status, 200, await upload.text());
  return operation('activateDevelopmentBootstrap', HOST_MEMBER_ID, {
    attemptId: source.attemptId,
    manifestSha256: createHash('sha256')
      .update(encodeDevelopmentBootstrapManifestCanonicalJson(source))
      .digest('hex'),
  });
}

async function snapshot(baseUrl: string, actor: string) {
  const route = collabCloudProjectOperationRoute(PROJECT_ID, 'getProjectSnapshot');
  const response = await fetch(`${baseUrl}${route.target}`, {
    body: JSON.stringify(envelope({ projectId: PROJECT_ID }, `snapshot-${actor}`)),
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

async function runClientGate(worktree: string, descriptorPath: string): Promise<void> {
  try {
    await execFileAsync(process.execPath, [
      join(worktree, 'scripts/run-jest.js'),
      '--runInBand',
      'tests/integration/app/collab/gates/CloudLocalMilestoneGate.test.ts',
    ], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...process.env, CLAUDIAN_CLOUD_LOCAL_GATE_DESCRIPTOR: descriptorPath },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch {
    throw new Error('Claudian localhost milestone client gate failed');
  }
}

describe('localhost milestone server gate', { concurrency: false }, () => {
  let database: PostgresTestDatabase;
  let root: string;
  let repositoryRoot: string;
  let stagingRoot: string;

  before(async () => {
    database = await acquirePostgresTestDatabase();
    await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
    root = await mkdtemp(join(tmpdir(), 'claudian-local-milestone-'));
    repositoryRoot = join(root, 'repositories');
    stagingRoot = join(root, 'staging');
    await mkdir(repositoryRoot, { mode: 0o700 });
    await mkdir(stagingRoot, { mode: 0o700 });
    await writeFile(join(root, '.authority-volume-id'), `${database.authorityVolumeId}\n`, {
      mode: 0o600,
    });
  });

  after(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('persists an activated Project across a real two-client Claudian milestone', {
    timeout: 150_000,
  }, async () => {
    const applicationConfig = config(database, repositoryRoot, stagingRoot);
    const bundle = await createBundle(root);
    const source = manifest(bundle);
    let application = createApplication({
      config: applicationConfig,
      logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
    });
    try {
      let address = await application.start();
      let baseUrl = `http://${address.host}:${String(address.port)}`;
      const capabilitiesResponse = await fetch(`${baseUrl}/collab/capabilities`);
      assert.equal(capabilitiesResponse.status, 200);
      assert.deepEqual(
        decodeCollabCloudCapabilityDocument(await capabilitiesResponse.json()).capabilities,
        [
          'accept',
          'development-bootstrap',
          'git-receive-pack-personal-ref',
          'git-upload-pack',
          'project-events',
          'project-snapshot',
          'requests',
          'tickets',
        ],
      );
      const activated = await bootstrap(baseUrl, source, bundle);
      assert.equal(activated.state, 'activated');
      assert.equal(activated.activationPhase, 'completed');

      await application.close();
      application = createApplication({
        config: applicationConfig,
        logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
      });
      address = await application.start();
      baseUrl = `http://${address.host}:${String(address.port)}`;
      const beforeClient = await Promise.all([
        snapshot(baseUrl, HOST_MEMBER_ID),
        snapshot(baseUrl, OTHER_MEMBER_ID),
      ]);
      assert.deepEqual(beforeClient[0].project, beforeClient[1].project);

      const clientWorktree = process.env.CLAUDIAN_CLOUD_CLIENT_WORKTREE;
      if (clientWorktree !== undefined) {
        const descriptorPath = join(root, 'client-gate.json');
        const resultPath = join(root, 'client-result.json');
        await writeFile(descriptorPath, JSON.stringify({
          manifest: source,
          origin: baseUrl,
          resultPath,
          seedPath: bundle.seedPath,
        }), { mode: 0o600 });
        await runClientGate(clientWorktree, descriptorPath);
        const result = JSON.parse(await readFile(resultPath, 'utf8')) as ClientGateResult;
        assert.equal(result.localWorkPreserved, true);
        assert.match(result.requestId, /^[0-9a-f-]{36}$/u);

        await application.close();
        application = createApplication({
          config: applicationConfig,
          logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
        });
        address = await application.start();
        baseUrl = `http://${address.host}:${String(address.port)}`;
        const afterRestart = await Promise.all([
          snapshot(baseUrl, HOST_MEMBER_ID),
          snapshot(baseUrl, OTHER_MEMBER_ID),
        ]);
        assert.equal(afterRestart[0].project.expectedMainOid, result.acceptedMainOid);
        assert.equal(afterRestart[1].project.expectedMainOid, result.acceptedMainOid);
      }

      const stagedProject = join(stagingRoot, Buffer.from(PROJECT_ID, 'utf8').toString('hex'));
      assert.deepEqual(await readdir(stagedProject), []);
    } finally {
      await application.close().catch(() => undefined);
    }
  });
});
