import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabCloudProjectOperationRoute,
  collabControlOperationCodec,
  collabMemberRef,
  decodeCollabCloudCapabilityDocument,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudSuccessEnvelope,
  type AcceptRequest,
  type CollabControlOperation,
  type CollabProjectId,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import {
  createApplication,
  type Application,
} from '../../../src/composition/createApplication.js';
import type { ServerConfig } from '../../../src/config/ServerConfig.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { SafeLogger } from '../../../src/observability/SafeLogger.js';
import {
  acquirePostgresTestDatabase,
  type PostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';
const CREATED_AT = '2026-08-19T00:00:00.000Z';
const PREPARED_AT = '2026-08-20T01:00:00.000Z';
const MANAGER_ID = 'member-manager';
const MEMBER_ID = 'member-author';
const STORAGE_NODE = 'accept-gate-node';

interface RepositoryFixture {
  readonly headOid: string;
  readonly mainOid: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly projectId: CollabProjectId;
  readonly repositoryPath: string;
  readonly storageKey: string;
}

function config(
  databaseUrl: string,
  repositoryRoot: string,
  stagingRoot: string,
  gitExecutable: string,
): ServerConfig {
  const maxBundleBytes = 16 * 1_024 * 1_024;
  const maxRepositoryBytes = 64 * 1_024 * 1_024;
  return Object.freeze({
    checkpointAdmission: {
      maxConcurrentStreams: 2,
      maxConcurrentStreamsPerProject: 1,
      maxStagingAttempts: 2,
      maxStagingAttemptsPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
    },
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
      queueMax: 8,
      queueMaxPerProject: 4,
      queueTimeoutMs: 2_000,
    }),
    http: Object.freeze({ host: '127.0.0.1', port: 0 }),
    postgres: Object.freeze({
      ordinaryPoolMax: 4,
      pinnedPoolMax: 4,
      projectLockTimeoutMs: 10_000,
      reservedPoolMax: 1,
      url: databaseUrl,
    }),
    principalProfile: 'private-development',
    repository: Object.freeze({
      gitExecutable,
      operationTimeoutMs: 10_000,
      outputMaxBytes: 2 * 1_024 * 1_024,
      root: repositoryRoot,
      storageNodeId: STORAGE_NODE,
    }),
    shutdownTimeoutMs: 5_000,
  });
}

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT, [...arguments_], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1_024 * 1_024,
  });
  return result.stdout.trim();
}

async function createRepository(
  root: string,
  repositoryRoot: string,
  projectId: CollabProjectId,
  kind: 'contained' | 'merge',
  objectFormat: 'sha1' | 'sha256' = 'sha1',
): Promise<RepositoryFixture> {
  const work = join(root, `work-${projectId}`);
  const storageKey = `repository-${projectId}`;
  const repositoryPath = join(
    repositoryRoot,
    Buffer.from(projectId, 'utf8').toString('hex'),
    storageKey,
  );
  await git(root, [
    'init',
    `--object-format=${objectFormat}`,
    '--initial-branch=main',
    work,
  ]);
  await git(work, ['config', 'user.name', 'Accept Gate']);
  await git(work, ['config', 'user.email', 'gate@example.invalid']);
  await writeFile(join(work, 'base.txt'), `base-${projectId}\n`);
  await git(work, ['add', 'base.txt']);
  await git(work, ['commit', '-m', 'Base']);
  const baseOid = await git(work, ['rev-parse', 'HEAD']);
  await writeFile(join(work, 'main.txt'), `main-${projectId}\n`);
  await git(work, ['add', 'main.txt']);
  await git(work, ['commit', '-m', 'Main']);
  const mainOid = await git(work, ['rev-parse', 'HEAD']);
  await git(work, [
    'branch',
    collabMemberRef(MANAGER_ID).slice('refs/heads/'.length),
    mainOid,
  ]);
  let headOid = baseOid;
  if (kind === 'merge') {
    await git(work, [
      'switch',
      '-c',
      collabMemberRef(MEMBER_ID).slice('refs/heads/'.length),
      baseOid,
    ]);
    await writeFile(join(work, 'member.txt'), `member-${projectId}\n`);
    await git(work, ['add', 'member.txt']);
    await git(work, ['commit', '-m', 'Member']);
    headOid = await git(work, ['rev-parse', 'HEAD']);
  } else {
    await git(work, [
      'branch',
      collabMemberRef(MEMBER_ID).slice('refs/heads/'.length),
      headOid,
    ]);
  }
  await mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, ['init', '--bare', `--object-format=${objectFormat}`]);
  await git(work, ['push', repositoryPath, `${mainOid}:${COLLAB_MAIN_REF}`]);
  await git(work, [
    'push',
    repositoryPath,
    `${mainOid}:${collabMemberRef(MANAGER_ID)}`,
  ]);
  await git(work, [
    'push',
    repositoryPath,
    `${headOid}:${collabMemberRef(MEMBER_ID)}`,
  ]);
  return Object.freeze({
    headOid,
    mainOid,
    objectFormat,
    projectId,
    repositoryPath,
    storageKey,
  });
}

async function seedProject(client: Client, fixture: RepositoryFixture): Promise<void> {
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
       ) VALUES ($1, 'Accept Gate', 1, $2, 'active', $3, $3)`,
      [fixture.projectId, fixture.mainOid, CREATED_AT],
    );
    for (const [memberId, role] of [
      [MANAGER_ID, 'manager'],
      [MEMBER_ID, 'member'],
    ] as const) {
      await client.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, display_name, role, status, revision,
           created_at, updated_at
         ) VALUES ($1, $2, $2, $3, 'active', 1, $4, $4)`,
        [fixture.projectId, memberId, role, CREATED_AT],
      );
      await client.query(
        `INSERT INTO claudian_cloud.development_actor_mappings (
           project_id, actor_id, member_id, created_at
         ) VALUES ($1, $2, $2, $3)`,
        [fixture.projectId, memberId, CREATED_AT],
      );
    }
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, $2, $3, 7, true, $4, $4)`,
      [fixture.projectId, STORAGE_NODE, fixture.storageKey, CREATED_AT],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, $2, $3, 7)`,
      [fixture.projectId, STORAGE_NODE, fixture.storageKey],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 3,
    pinnedPoolMax: 3,
    projectLockTimeoutMs: 10_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

function requestFingerprint(request: AcceptRequest): string {
  return createHash('sha256').update(JSON.stringify({
    expectedHeadOid: request.expectedHeadOid,
    expectedMainOid: request.expectedMainOid,
    expectedRequestRevision: request.expectedRequestRevision,
    expectedResolvingTickets: [...request.expectedResolvingTickets],
    projectId: request.projectId,
    requestId: request.requestId,
  })).digest('hex');
}

function acceptInput(
  fixture: RepositoryFixture,
  requestId: string,
  idempotencyKey: string,
): AcceptRequest {
  return Object.freeze({
    expectedHeadOid: fixture.headOid,
    expectedMainOid: fixture.mainOid,
    expectedRequestRevision: 1,
    expectedResolvingTickets: [],
    idempotencyKey,
    projectId: fixture.projectId,
    requestId,
  });
}

async function seedPreparedAccept(
  database: PostgresTestDatabase,
  fixture: RepositoryFixture,
  operationId: string,
): Promise<AcceptRequest> {
  assert.equal(fixture.objectFormat, 'sha1');
  const request = acceptInput(
    fixture,
    `request-${fixture.projectId}`,
    `idempotency-${fixture.projectId}`,
  );
  const treeOid = (await git(fixture.repositoryPath, [
    'merge-tree',
    '--write-tree',
    fixture.mainOid,
    fixture.headOid,
  ])).split('\n')[0];
  assert.ok(treeOid);
  const store = coordination(database);
  try {
    await store.withProjectScope(fixture.projectId, async scope => {
      await scope.collaboration.requests.create({
        createdAt: CREATED_AT,
        description: 'Prepared Accept',
        firstBaseOid: fixture.mainOid,
        latestHeadOid: fixture.headOid,
        memberId: MEMBER_ID,
        requestId: request.requestId,
      });
      await scope.accept.prepare({
        actorMemberId: MANAGER_ID,
        commit: {
          authorEmail: 'collab@claudian.local',
          authorName: 'Claudian Collab',
          committerEmail: 'collab@claudian.local',
          committerName: 'Claudian Collab',
          message: `Accept request ${request.requestId}\n`,
          parents: [fixture.mainOid, fixture.headOid],
          timezone: '+0000',
          treeOid,
        },
        expectedHeadOid: fixture.headOid,
        expectedMainOid: fixture.mainOid,
        expectedRequestRevision: 1,
        idempotencyKey: request.idempotencyKey,
        mainRef: COLLAB_MAIN_REF,
        objectFormat: fixture.objectFormat,
        operationId,
        personalRef: collabMemberRef(MEMBER_ID),
        placement: {
          generation: 7,
          projectId: fixture.projectId,
          repositoryStorageKey: fixture.storageKey,
          storageNodeId: STORAGE_NODE,
        },
        preparedAt: PREPARED_AT,
        relations: [],
        requestFingerprint: requestFingerprint(request),
        requestId: request.requestId,
        requestMemberId: MEMBER_ID,
        resultKind: 'merge',
      });
    });
  } finally {
    await store.close();
  }
  return request;
}

function envelope(data: unknown, requestId: string): unknown {
  return { data, protocolVersion: COLLAB_PROTOCOL_VERSION, requestId };
}

async function operation(
  baseUrl: string,
  operationName: CollabControlOperation,
  actor: string,
  data: unknown,
  requestId: string,
  projectId: CollabProjectId,
): Promise<unknown> {
  const route = collabCloudProjectOperationRoute(projectId, operationName);
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
  return (collabControlOperationCodec(operationName) as Readonly<{
    decodeResponse(input: unknown): unknown;
  }>).decodeResponse(decoded);
}

async function operationFailure(
  baseUrl: string,
  operationName: CollabControlOperation,
  actor: string,
  data: unknown,
  requestId: string,
  projectId: CollabProjectId,
): Promise<Readonly<{ code: string; status: number }>> {
  const route = collabCloudProjectOperationRoute(projectId, operationName);
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

async function ensureRequest(
  baseUrl: string,
  fixture: RepositoryFixture,
  suffix: string,
): Promise<AcceptRequest> {
  const response = await operation(
    baseUrl,
    'ensureMyRequest',
    MEMBER_ID,
    {
      description: `Accept gate ${suffix}`,
      expectedMainOid: fixture.mainOid,
      headOid: fixture.headOid,
      idempotencyKey: `ensure-${suffix}`,
      projectId: fixture.projectId,
    },
    `request-ensure-${suffix}`,
    fixture.projectId,
  ) as Readonly<{
    readonly request: { readonly id: string; readonly revision: number };
  }>;
  return Object.freeze({
    ...acceptInput(fixture, response.request.id, `accept-${suffix}`),
    expectedRequestRevision: response.request.revision,
  });
}

async function createBlockingGitWrapper(root: string): Promise<Readonly<{
  enabledPath: string;
  executable: string;
  releasePath: string;
  startedPath: string;
}>> {
  const executable = join(root, 'git-with-accept-gate');
  const enabledPath = join(root, 'accept-gate-enabled');
  const releasePath = join(root, 'accept-gate-release');
  const startedPath = join(root, 'accept-gate-started');
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "merge-tree" ] && [ "$2" = "--write-tree" ] && [ -f "${enabledPath}" ]; then
  /usr/bin/touch "${startedPath}"
  while [ ! -f "${releasePath}" ]; do /bin/sleep 0.01; done
fi
exec ${GIT} "$@"
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
  throw new Error('accept-gate-marker-timeout');
}

async function preparePersonalPush(
  root: string,
  fixture: RepositoryFixture,
  baseUrl: string,
): Promise<Readonly<{ oid: string; push: () => Promise<void> }>> {
  const checkout = join(root, `push-${fixture.projectId}`);
  const personalRef = collabMemberRef(MEMBER_ID);
  await git(root, [
    'clone',
    '--branch',
    personalRef.slice('refs/heads/'.length),
    fixture.repositoryPath,
    checkout,
  ]);
  await git(checkout, ['config', 'user.name', 'Contended Writer']);
  await git(checkout, ['config', 'user.email', 'writer@example.invalid']);
  await writeFile(join(checkout, 'after.txt'), 'after Accept\n');
  await git(checkout, ['add', 'after.txt']);
  await git(checkout, ['commit', '-m', 'Personal update after Accept']);
  const oid = await git(checkout, ['rev-parse', 'HEAD']);
  return Object.freeze({
    oid,
    push: async () => {
      await git(checkout, [
        '-c',
        `http.extraHeader=X-Claudian-Development-Actor: ${MEMBER_ID}`,
        'push',
        `${baseUrl}/v6/projects/${fixture.projectId}/repository.git`,
        `HEAD:${personalRef}`,
      ]);
    },
  });
}

async function assertJournalPhase(
  database: PostgresTestDatabase,
  projectId: CollabProjectId,
  operationId: string,
  phase: string,
): Promise<void> {
  const store = coordination(database);
  try {
    await store.withProjectReadScope(projectId, async scope => {
      assert.equal((await scope.accept.get(operationId))?.phase, phase);
    });
  } finally {
    await store.close();
  }
}

describe('Accept recovery gate', { concurrency: false }, () => {
  it('composes JSON Accept, mixed recovery, isolation, and Git write ordering', async () => {
    const database = await acquirePostgresTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'claudian-accept-gate-'));
    const repositoryRoot = join(root, 'repositories');
    const stagingRoot = join(root, 'staging');
    const seed = new Client({ connectionString: database.migrationUrl });
    let application: Application | undefined;
    try {
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      await mkdir(repositoryRoot, { mode: 0o700 });
      await mkdir(stagingRoot, { mode: 0o700 });
      await writeFile(
        join(root, '.authority-volume-id'),
        `${database.authorityVolumeId}\n`,
        { mode: 0o600 },
      );
      const wrapper = await createBlockingGitWrapper(root);
      const startup = await createRepository(
        root,
        repositoryRoot,
        'project-accept-startup',
        'merge',
      );
      const merged = await createRepository(
        root,
        repositoryRoot,
        'project-accept-merge',
        'merge',
      );
      const contained = await createRepository(
        root,
        repositoryRoot,
        'project-accept-contained-sha256',
        'contained',
        'sha256',
      );
      const contended = await createRepository(
        root,
        repositoryRoot,
        'project-accept-contended',
        'merge',
      );
      const progress = await createRepository(
        root,
        repositoryRoot,
        'project-accept-progress',
        'contained',
      );
      await seed.connect();
      for (const fixture of [startup, merged, contained, contended, progress]) {
        await seedProject(seed, fixture);
      }
      const startupRequest = await seedPreparedAccept(
        database,
        startup,
        'accept-operation-startup',
      );

      const applicationConfig = config(
        database.runtimeUrl,
        repositoryRoot,
        stagingRoot,
        wrapper.executable,
      );
      const startupLogs: string[] = [];
      application = createApplication({
        config: applicationConfig,
        logger: new SafeLogger({
          now: () => new Date(),
          write: line => startupLogs.push(line),
        }),
      });
      const address = await application.start().catch((error: unknown) => {
        throw new Error(`accept-gate-startup:${startupLogs.join('')}`, { cause: error });
      });
      const baseUrl = `http://${address.host}:${String(address.port)}`;
      const capabilityResponse = await fetch(`${baseUrl}/collab/capabilities`);
      assert.equal(capabilityResponse.status, 200);
      const capabilities = decodeCollabCloudCapabilityDocument(
        await capabilityResponse.json(),
      );
      assert.equal(capabilities.capabilities.includes('accept'), true);

      const startupReplay = await operation(
        baseUrl,
        'acceptRequest',
        MANAGER_ID,
        startupRequest,
        'request-startup-replay',
        startup.projectId,
      ) as Readonly<{ readonly mainOid: string }>;
      assert.equal(
        await git(startup.repositoryPath, ['rev-parse', COLLAB_MAIN_REF]),
        startupReplay.mainOid,
      );
      await assertJournalPhase(
        database,
        startup.projectId,
        'accept-operation-startup',
        'completed',
      );

      const mergeRequest = await ensureRequest(baseUrl, merged, 'merge');
      const mergeResponse = await operation(
        baseUrl,
        'acceptRequest',
        MANAGER_ID,
        mergeRequest,
        'request-accept-merge',
        merged.projectId,
      ) as Readonly<{ readonly mainOid: string; readonly mergeCommitOid?: string }>;
      assert.equal(mergeResponse.mainOid, mergeResponse.mergeCommitOid);
      assert.equal(
        await git(merged.repositoryPath, ['rev-parse', COLLAB_MAIN_REF]),
        mergeResponse.mainOid,
      );
      assert.deepEqual(
        await operation(
          baseUrl,
          'acceptRequest',
          MANAGER_ID,
          mergeRequest,
          'request-accept-merge-replay',
          merged.projectId,
        ),
        mergeResponse,
      );

      const containedRequest = await ensureRequest(baseUrl, contained, 'contained');
      const containedResponse = await operation(
        baseUrl,
        'acceptRequest',
        MANAGER_ID,
        containedRequest,
        'request-accept-contained',
        contained.projectId,
      ) as Readonly<{ readonly mainOid: string; readonly mergeCommitOid?: string }>;
      assert.equal(containedResponse.mainOid, contained.mainOid);
      assert.equal(containedResponse.mergeCommitOid, contained.mainOid);
      assert.equal(containedResponse.mainOid.length, 64);

      const onDemand = await createRepository(
        root,
        repositoryRoot,
        'project-accept-on-demand',
        'merge',
      );
      await seedProject(seed, onDemand);
      await seedPreparedAccept(
        database,
        onDemand,
        'accept-operation-on-demand',
      );
      const recoveringPush = await preparePersonalPush(
        root,
        onDemand,
        baseUrl,
      );
      await recoveringPush.push();
      await assertJournalPhase(
        database,
        onDemand.projectId,
        'accept-operation-on-demand',
        'completed',
      );
      assert.equal(
        await git(onDemand.repositoryPath, [
          'rev-parse',
          collabMemberRef(MEMBER_ID),
        ]),
        recoveringPush.oid,
      );

      const divergent = await createRepository(
        root,
        repositoryRoot,
        'project-accept-divergent',
        'merge',
      );
      await seedProject(seed, divergent);
      await seedPreparedAccept(
        database,
        divergent,
        'accept-operation-divergent',
      );
      await git(divergent.repositoryPath, [
        'update-ref',
        COLLAB_MAIN_REF,
        divergent.headOid,
        divergent.mainOid,
      ]);
      assert.deepEqual(
        await operationFailure(
          baseUrl,
          'createTicket',
          MANAGER_ID,
          {
            body: 'Must remain isolated',
            idempotencyKey: 'ticket-divergent',
            projectId: divergent.projectId,
            title: 'Blocked',
          },
          'request-divergent',
          divergent.projectId,
        ),
        { code: 'authority-not-synchronized', status: 409 },
      );
      await assertJournalPhase(
        database,
        divergent.projectId,
        'accept-operation-divergent',
        'recovery-required',
      );

      const contendedRequest = await ensureRequest(baseUrl, contended, 'contended');
      const pendingPush = await preparePersonalPush(root, contended, baseUrl);
      await writeFile(wrapper.enabledPath, 'enabled\n');
      const accepting = operation(
        baseUrl,
        'acceptRequest',
        MANAGER_ID,
        contendedRequest,
        'request-accept-contended',
        contended.projectId,
      );
      await waitForFile(wrapper.startedPath);
      let pushSettled = false;
      const pushing = pendingPush.push().finally(() => {
        pushSettled = true;
      });
      await operation(
        baseUrl,
        'createTicket',
        MANAGER_ID,
        {
          body: 'Different Project progresses',
          idempotencyKey: 'ticket-progress',
          projectId: progress.projectId,
          title: 'Progress',
        },
        'request-progress',
        progress.projectId,
      );
      assert.equal(pushSettled, false);
      await writeFile(wrapper.releasePath, 'released\n');
      await Promise.all([accepting, pushing]);
      assert.equal(
        await git(contended.repositoryPath, [
          'rev-parse',
          collabMemberRef(MEMBER_ID),
        ]),
        pendingPush.oid,
      );
    } finally {
      await seed.end().catch(() => undefined);
      await application?.close().catch(() => undefined);
      await database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
