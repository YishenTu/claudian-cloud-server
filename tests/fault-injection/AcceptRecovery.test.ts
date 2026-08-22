import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  CollabError,
  collabMemberRef,
  type AcceptRequest,
  type CollabProjectId,
} from '@claudian/collab-protocol';
import { Client } from 'pg';

import type {
  AcceptPersistence,
} from '../../src/coordination/AcceptPersistence.js';
import type {
  AcquireProjectLeaseOptions,
  PinnedProjectLease,
  ProjectReadScope,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import { PostgresCoordination } from '../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../src/coordination/postgres/PostgresMigrator.js';
import {
  ProjectAcceptCoordinator,
  ProjectAcceptCoordinatorError,
  type ProjectAcceptCoordination,
} from '../../src/project-authority/acceptance/ProjectAcceptCoordinator.js';
import type {
  InspectProjectAcceptInput,
  ProjectAcceptInspection,
  ProjectAcceptMainPlan,
  ProjectAcceptRepository,
  ProjectAcceptRepositoryReservation,
  ProjectAcceptResultPlan,
} from '../../src/project-authority/acceptance/ProjectAcceptRepository.js';
import {
  ProjectWriteAdmission,
} from '../../src/project-authority/admission/ProjectWriteAdmission.js';
import { ProjectPersonalRefAuthority } from '../../src/project-authority/writes/ProjectPersonalRefAuthority.js';
import { createDevelopmentIngressPrincipal } from '../../src/request-context/IngressPrincipal.js';
import { GitRepositoryAuthority } from '../../src/repositories/GitRepositoryAuthority.js';
import { GitReceiveAdmission } from '../../src/resource-admission/GitReceiveAdmission.js';
import { ResourceAdmission } from '../../src/resource-admission/ResourceAdmission.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';
const T0 = '2026-08-24T00:00:00.000Z';
const NOW = '2026-08-24T02:00:00.000Z';
const STORAGE_NODE = 'accept-node';
const MEMBER_ID = 'member-author';
const MANAGER_ID = 'member-manager';
const PERSONAL_REF = collabMemberRef(MEMBER_ID);

type Checkpoint =
  | 'git:inspection'
  | 'git:main'
  | 'git:result'
  | 'sql:completed'
  | 'sql:main-updated'
  | 'sql:prepared'
  | 'sql:result-persisted';

class FaultController {
  readonly seen: Checkpoint[] = [];
  lastError: string | undefined;
  resultOid: string | undefined;
  target: Checkpoint | undefined;

  trip(checkpoint: Checkpoint): void {
    this.seen.push(checkpoint);
    if (this.target !== checkpoint) return;
    this.target = undefined;
    throw new Error('injected-process-death');
  }
}

function persistenceCheckpoint(method: PropertyKey): Checkpoint | undefined {
  if (method === 'prepare') return 'sql:prepared';
  if (method === 'persistResult') return 'sql:result-persisted';
  if (method === 'markMainUpdated') return 'sql:main-updated';
  if (method === 'complete') return 'sql:completed';
  return undefined;
}

function faultAcceptPersistence(
  persistence: AcceptPersistence,
  commit: (checkpoint: Checkpoint) => void,
): AcceptPersistence {
  return new Proxy(persistence, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      return async (...arguments_: readonly unknown[]) => {
        const result: unknown = await Reflect.apply(member, target, arguments_);
        const checkpoint = persistenceCheckpoint(property);
        if (checkpoint !== undefined) commit(checkpoint);
        return result;
      };
    },
  });
}

class FaultLease implements PinnedProjectLease {
  readonly #controller: FaultController;
  readonly #lease: PinnedProjectLease;

  constructor(lease: PinnedProjectLease, controller: FaultController) {
    this.#controller = controller;
    this.#lease = lease;
  }

  close(): Promise<void> {
    return this.#lease.close();
  }

  drainDevelopmentBootstrapUploads(attemptId: string): Promise<void> {
    return this.#lease.drainDevelopmentBootstrapUploads(attemptId);
  }

  handoffToDevelopmentBootstrapUpload(attemptId: string) {
    return this.#lease.handoffToDevelopmentBootstrapUpload(attemptId);
  }

  async withProjectScope<T>(
    operation: (scope: ProjectScope) => Promise<T>,
  ): Promise<T> {
    let committed: Checkpoint | undefined;
    let value: T;
    try {
      value = await this.#lease.withProjectScope(scope => operation(
        new Proxy(scope, {
          get(target, property): unknown {
            if (property !== 'accept') {
              const member: unknown = Reflect.get(target, property, target);
              return typeof member === 'function' ? member.bind(target) : member;
            }
            return faultAcceptPersistence(target.accept, checkpoint => {
              committed = checkpoint;
            });
          },
        }),
      ));
    } catch (error: unknown) {
      this.#controller.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    if (committed !== undefined) this.#controller.trip(committed);
    return value;
  }
}

class FaultCoordination implements ProjectAcceptCoordination {
  readonly #controller: FaultController;
  readonly #store: PostgresCoordination;

  constructor(store: PostgresCoordination, controller: FaultController) {
    this.#controller = controller;
    this.#store = store;
  }

  async acquireProjectLease(
    projectId: CollabProjectId,
    options?: AcquireProjectLeaseOptions,
  ): Promise<PinnedProjectLease> {
    const lease = options === undefined
      ? await this.#store.acquireProjectLease(projectId)
      : await this.#store.acquireProjectLease(projectId, options);
    return new FaultLease(lease, this.#controller);
  }

  withProjectReadScope<T>(
    projectId: CollabProjectId,
    operation: (scope: ProjectReadScope) => Promise<T>,
    options?: AcquireProjectLeaseOptions,
  ): Promise<T> {
    return options === undefined
      ? this.#store.withProjectReadScope(projectId, operation)
      : this.#store.withProjectReadScope(projectId, operation, options);
  }
}

class FaultRepository implements ProjectAcceptRepository {
  readonly #controller: FaultController;
  readonly #repository: ProjectAcceptRepository;

  constructor(repository: ProjectAcceptRepository, controller: FaultController) {
    this.#controller = controller;
    this.#repository = repository;
  }

  async inspectAccept(
    reservation: ProjectAcceptRepositoryReservation,
    input: InspectProjectAcceptInput,
  ): Promise<ProjectAcceptInspection> {
    let result: ProjectAcceptInspection;
    try {
      result = await this.#repository.inspectAccept(reservation, input);
    } catch (error: unknown) {
      this.#controller.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    this.#controller.trip('git:inspection');
    return result;
  }

  async materializeAcceptResult(
    reservation: ProjectAcceptRepositoryReservation,
    plan: ProjectAcceptResultPlan,
  ): Promise<string> {
    const result = await this.#repository.materializeAcceptResult(reservation, plan);
    this.#controller.resultOid = result;
    this.#controller.trip('git:result');
    return result;
  }

  async settleAcceptMain(
    reservation: ProjectAcceptRepositoryReservation,
    plan: ProjectAcceptMainPlan,
  ): Promise<'advanced' | 'replayed'> {
    const result = await this.#repository.settleAcceptMain(reservation, plan);
    this.#controller.trip('git:main');
    return result;
  }

  reserveAccept(
    projectId: CollabProjectId,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<ProjectAcceptRepositoryReservation> {
    return this.#repository.reserveAccept(
      projectId,
      options === undefined ? {} : options,
    );
  }
}

class BlockingRepository implements ProjectAcceptRepository {
  readonly entered: Promise<void>;
  readonly #repository: ProjectAcceptRepository;
  readonly #release: Promise<void>;
  readonly #resolveEntered: () => void;

  constructor(repository: ProjectAcceptRepository, release: Promise<void>) {
    let resolveEntered!: () => void;
    this.entered = new Promise(resolve => { resolveEntered = resolve; });
    this.#resolveEntered = resolveEntered;
    this.#release = release;
    this.#repository = repository;
  }

  inspectAccept(
    reservation: ProjectAcceptRepositoryReservation,
    input: InspectProjectAcceptInput,
  ): Promise<ProjectAcceptInspection> {
    return this.#repository.inspectAccept(reservation, input);
  }

  async materializeAcceptResult(
    reservation: ProjectAcceptRepositoryReservation,
    plan: ProjectAcceptResultPlan,
  ): Promise<string> {
    this.#resolveEntered();
    await this.#release;
    return this.#repository.materializeAcceptResult(reservation, plan);
  }

  settleAcceptMain(
    reservation: ProjectAcceptRepositoryReservation,
    plan: ProjectAcceptMainPlan,
  ): Promise<'advanced' | 'replayed'> {
    return this.#repository.settleAcceptMain(reservation, plan);
  }

  reserveAccept(
    projectId: CollabProjectId,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<ProjectAcceptRepositoryReservation> {
    return this.#repository.reserveAccept(
      projectId,
      options === undefined ? {} : options,
    );
  }
}

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 4,
    pinnedPoolMax: 6,
    projectLockTimeoutMs: 10_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT, [...arguments_], {
    cwd,
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    },
  });
  return result.stdout.trim();
}

async function createRepository(
  root: string,
  projectId: CollabProjectId,
  storageKey: string,
): Promise<Readonly<{ readonly headOid: string; readonly mainOid: string }>> {
  const work = join(root, `work-${projectId}`);
  const bare = join(
    root,
    Buffer.from(projectId, 'utf8').toString('hex'),
    storageKey,
  );
  await mkdir(work, { recursive: true });
  await git(work, ['init', '--initial-branch=main']);
  await git(work, ['config', 'user.name', 'Fixture']);
  await git(work, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(work, 'base.txt'), 'base\n');
  await git(work, ['add', 'base.txt']);
  await git(work, ['commit', '-m', 'Base']);
  const baseOid = await git(work, ['rev-parse', 'HEAD']);
  await writeFile(join(work, 'main.txt'), 'main\n');
  await git(work, ['add', 'main.txt']);
  await git(work, ['commit', '-m', 'Main']);
  const mainOid = await git(work, ['rev-parse', 'HEAD']);
  await git(work, ['checkout', '-b', 'member', baseOid]);
  await writeFile(join(work, 'member.txt'), 'member\n');
  await git(work, ['add', 'member.txt']);
  await git(work, ['commit', '-m', 'Member']);
  const headOid = await git(work, ['rev-parse', 'HEAD']);
  await mkdir(bare, { recursive: true });
  await git(bare, ['init', '--bare']);
  await git(work, ['push', bare, `${mainOid}:${COLLAB_MAIN_REF}`]);
  await git(work, ['push', bare, `${headOid}:${PERSONAL_REF}`]);
  return { headOid, mainOid };
}

async function seedProject(
  database: PostgresTestDatabase,
  projectId: CollabProjectId,
  storageKey: string,
  mainOid: string,
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation,
         expected_main_oid, service_state, created_at, activated_at
       ) VALUES ($1, 'Accept Project', 1, $2, 'active', $3, $3)`,
      [projectId, mainOid, T0],
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
        [projectId, memberId, role, T0],
      );
    }
    for (const memberId of [MANAGER_ID, MEMBER_ID]) {
      await client.query(
        `INSERT INTO claudian_cloud.development_actor_mappings (
           project_id, actor_id, member_id, created_at
         ) VALUES ($1, $2, $2, $3)`,
        [projectId, memberId, T0],
      );
    }
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, $2, $3, 7, true, $4, $4)`,
      [projectId, STORAGE_NODE, storageKey, T0],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, $2, $3, 7)`,
      [projectId, STORAGE_NODE, storageKey],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function seedCollaboration(
  store: PostgresCoordination,
  projectId: CollabProjectId,
  mainOid: string,
  headOid: string,
): Promise<void> {
  await store.withProjectScope(projectId, async scope => {
    await scope.collaboration.requests.create({
      createdAt: T0,
      description: 'Accept this request',
      firstBaseOid: mainOid,
      latestHeadOid: headOid,
      memberId: MEMBER_ID,
      requestId: 'request-shared',
    });
    await scope.collaboration.tickets.create({
      authorMemberId: MEMBER_ID,
      body: 'Resolve this Ticket',
      createdAt: T0,
      ticketId: 'ticket-resolve',
      title: 'Resolve',
    });
    await scope.collaboration.requests.replacePendingRelations({
      actorMemberId: MEMBER_ID,
      commitOid: headOid,
      relations: [{
        kind: 'resolves',
        relationId: 'relation-resolve',
        ticketId: 'ticket-resolve',
      }],
      requestId: 'request-shared',
      updatedAt: T0,
    });
  });
}

function acceptRequest(
  projectId: CollabProjectId,
  mainOid: string,
  headOid: string,
  idempotencyKey: string,
): AcceptRequest {
  return {
    expectedHeadOid: headOid,
    expectedMainOid: mainOid,
    expectedRequestRevision: 1,
    expectedResolvingTickets: [{ revision: 1, ticketId: 'ticket-resolve' }],
    idempotencyKey,
    projectId,
    requestId: 'request-shared',
  };
}

describe('Accept cross-store recovery', () => {
  it('restarts to the exact result after every committed SQL and Git effect', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      const root = await mkdtemp(join(tmpdir(), 'claudian-cloud-accept-recovery-'));
      const store = coordination(database);
      const resources = new ResourceAdmission({
        maxChildren: 4,
        maxChildrenPerProject: 1,
        queueMax: 8,
        queueMaxPerProject: 2,
        queueTimeoutMs: 2_000,
      });
      const repository = new GitRepositoryAuthority({
        gitExecutable: GIT,
        operationTimeoutMs: 5_000,
        outputMaxBytes: 2 * 1_024 * 1_024,
        placementValidator: store,
        receiveAdmission: new GitReceiveAdmission({
          capacityTimeoutMs: 2_000,
          freeSpaceFloorBytes: 1,
          maxConcurrentReceives: 2,
          maxConcurrentReceivesPerProject: 1,
          maximumRequestBytes: 1_024 * 1_024,
          repositoryRoot: root,
          reservationBytes: 64 * 1_024 * 1_024,
        }, {
          availableBytes: () => Promise.resolve(4n * 1_024n * 1_024n * 1_024n),
        }),
        receivePolicy: {
          maximumBlobBytes: COLLAB_LIMITS.maxBlobBytes,
          maximumExpandedTreeEntries: 100_000,
          maximumRepositoryBytes: 1024 * 1024 * 1024,
          maximumTreeEntries: COLLAB_LIMITS.maxChangedPaths,
        },
        repositoryRoot: root,
        resourceAdmission: resources,
        storageNodeId: STORAGE_NODE,
      });
      const checkpoints: readonly Checkpoint[] = [
        'git:inspection',
        'sql:prepared',
        'git:result',
        'sql:result-persisted',
        'git:main',
        'sql:main-updated',
        'sql:completed',
      ];
      try {
        for (const [index, checkpoint] of checkpoints.entries()) {
          const projectId = `project-fault-${String(index)}`;
          const storageKey = `repository-fault-${String(index)}`;
          const fixture = await createRepository(root, projectId, storageKey);
          await seedProject(database, projectId, storageKey, fixture.mainOid);
          await seedCollaboration(store, projectId, fixture.mainOid, fixture.headOid);
          const request = acceptRequest(
            projectId,
            fixture.mainOid,
            fixture.headOid,
            `accept-key-${String(index)}`,
          );
          const controller = new FaultController();
          controller.target = checkpoint;
          const failed = new ProjectAcceptCoordinator({
            clock: () => new Date(NOW),
            coordination: new FaultCoordination(store, controller),
            operationIdFactory: () => `accept-operation-${String(index)}`,
            repository: new FaultRepository(repository, controller),
          });
          const failure = await failed.accept(
            createDevelopmentIngressPrincipal(MANAGER_ID),
            request,
          ).then(() => undefined, (error: unknown) => error);
          assert.ok(failure instanceof CollabError, checkpoint);
          assert.equal(failure.code, 'operation-failed', checkpoint);
          await failed.close();
          assert.equal(
            controller.target,
            undefined,
            `${checkpoint}:${JSON.stringify(failure.safeContext)}:${controller.lastError ?? ''}`,
          );
          if (checkpoint === 'git:result') {
            assert.ok(controller.resultOid);
            await git(join(
              root,
              Buffer.from(projectId).toString('hex'),
              storageKey,
            ), [
              'update-ref',
              COLLAB_MAIN_REF,
              controller.resultOid,
              fixture.mainOid,
            ]);
          }

          const recovered = new ProjectAcceptCoordinator({
            clock: () => new Date(NOW),
            coordination: store,
            operationIdFactory: () => `accept-operation-${String(index)}`,
            repository,
          });
          try {
            await recovered.recoverProject(projectId);
            const response = await recovered.accept(
              createDevelopmentIngressPrincipal(MANAGER_ID),
              request,
            );
            assert.equal(
              await git(join(root, Buffer.from(projectId).toString('hex'), storageKey), [
                'rev-parse',
                COLLAB_MAIN_REF,
              ]),
              response.mainOid,
              checkpoint,
            );
            assert.equal(
              await git(join(root, Buffer.from(projectId).toString('hex'), storageKey), [
                'rev-parse',
                PERSONAL_REF,
              ]),
              fixture.headOid,
              checkpoint,
            );
            await store.withProjectReadScope(projectId, async scope => {
              assert.equal((await scope.getProject())?.expectedMainOid, response.mainOid);
              assert.equal(
                (await scope.accept.get(`accept-operation-${String(index)}`))?.phase,
                'completed',
              );
              assert.equal(
                (await scope.collaboration.requests.find('request-shared'))?.status,
                'merged',
              );
            });
            assert.equal(
              (await store.listRecoveryCandidates()).candidates.some(candidate => (
                candidate.projectId === projectId
              )),
              false,
              checkpoint,
            );
          } finally {
            await recovered.close();
          }
        }

        const divergentProject = 'project-divergent';
        const divergentStorage = 'repository-divergent';
        const divergentFixture = await createRepository(
          root,
          divergentProject,
          divergentStorage,
        );
        await seedProject(
          database,
          divergentProject,
          divergentStorage,
          divergentFixture.mainOid,
        );
        await seedCollaboration(
          store,
          divergentProject,
          divergentFixture.mainOid,
          divergentFixture.headOid,
        );
        const divergentRequest = acceptRequest(
          divergentProject,
          divergentFixture.mainOid,
          divergentFixture.headOid,
          'accept-key-divergent',
        );
        const divergentFault = new FaultController();
        divergentFault.target = 'sql:result-persisted';
        const interrupted = new ProjectAcceptCoordinator({
          clock: () => new Date(NOW),
          coordination: new FaultCoordination(store, divergentFault),
          operationIdFactory: () => 'accept-operation-divergent',
          repository: new FaultRepository(repository, divergentFault),
        });
        await assert.rejects(interrupted.accept(
          createDevelopmentIngressPrincipal(MANAGER_ID),
          divergentRequest,
        ));
        await interrupted.close();
        const divergentPath = join(
          root,
          Buffer.from(divergentProject).toString('hex'),
          divergentStorage,
        );
        await git(divergentPath, [
          'update-ref',
          COLLAB_MAIN_REF,
          divergentFixture.headOid,
          divergentFixture.mainOid,
        ]);

        const classifier = new ProjectAcceptCoordinator({
          clock: () => new Date(NOW),
          coordination: store,
          repository,
        });
        try {
          await assert.rejects(
            classifier.recoverProject(divergentProject),
            error => (
              error instanceof ProjectAcceptCoordinatorError
              && error.code === 'recovery-required'
            ),
          );
          await store.withProjectReadScope(divergentProject, async scope => {
            assert.equal((await scope.getProject())?.serviceState, 'recovery-required');
            assert.equal(
              (await scope.accept.get('accept-operation-divergent'))?.phase,
              'recovery-required',
            );
          });
          await assert.rejects(
            classifier.accept(
              createDevelopmentIngressPrincipal(MANAGER_ID),
              divergentRequest,
            ),
            error => (
              error instanceof CollabError
              && error.code === 'acceptance-recovery-required'
            ),
          );

          const isolatedProject = 'project-isolated';
          const isolatedStorage = 'repository-isolated';
          const isolatedFixture = await createRepository(
            root,
            isolatedProject,
            isolatedStorage,
          );
          await seedProject(
            database,
            isolatedProject,
            isolatedStorage,
            isolatedFixture.mainOid,
          );
          await seedCollaboration(
            store,
            isolatedProject,
            isolatedFixture.mainOid,
            isolatedFixture.headOid,
          );
          const isolated = await classifier.accept(
            createDevelopmentIngressPrincipal(MANAGER_ID),
            acceptRequest(
              isolatedProject,
              isolatedFixture.mainOid,
              isolatedFixture.headOid,
              'accept-key-isolated',
            ),
          );
          assert.equal(
            await git(join(
              root,
              Buffer.from(isolatedProject).toString('hex'),
              isolatedStorage,
            ), ['rev-parse', COLLAB_MAIN_REF]),
            isolated.mainOid,
          );
        } finally {
          await classifier.close();
        }

        const contendedProject = 'project-contended';
        const contendedStorage = 'repository-contended';
        const contendedFixture = await createRepository(
          root,
          contendedProject,
          contendedStorage,
        );
        await seedProject(
          database,
          contendedProject,
          contendedStorage,
          contendedFixture.mainOid,
        );
        await seedCollaboration(
          store,
          contendedProject,
          contendedFixture.mainOid,
          contendedFixture.headOid,
        );
        const progressingProject = 'project-progressing';
        const progressingStorage = 'repository-progressing';
        const progressingFixture = await createRepository(
          root,
          progressingProject,
          progressingStorage,
        );
        await seedProject(
          database,
          progressingProject,
          progressingStorage,
          progressingFixture.mainOid,
        );
        await seedCollaboration(
          store,
          progressingProject,
          progressingFixture.mainOid,
          progressingFixture.headOid,
        );
        let releaseMaterialization!: () => void;
        const materializationReleased = new Promise<void>(resolve => {
          releaseMaterialization = resolve;
        });
        const blockingRepository = new BlockingRepository(
          repository,
          materializationReleased,
        );
        const contendedAccept = new ProjectAcceptCoordinator({
          clock: () => new Date(NOW),
          coordination: store,
          operationIdFactory: () => 'accept-operation-contended',
          repository: blockingRepository,
        });
        const ordinaryAdmission = new ProjectWriteAdmission({
          coordination: store,
          recovery: contendedAccept,
        });
        const receiveAuthority = new ProjectPersonalRefAuthority({
          coordination: store,
          recovery: contendedAccept,
          repository,
        });
        try {
          const accept = contendedAccept.accept(
            createDevelopmentIngressPrincipal(MANAGER_ID),
            acceptRequest(
              contendedProject,
              contendedFixture.mainOid,
              contendedFixture.headOid,
              'accept-key-contended',
            ),
          );
          await blockingRepository.entered;
          let ordinaryEntered = false;
          const ordinary = ordinaryAdmission.run(
            createDevelopmentIngressPrincipal(MANAGER_ID),
            contendedProject,
            () => {
              ordinaryEntered = true;
              return Promise.resolve();
            },
          ).then(() => undefined, (error: unknown) => error);
          let receiveSettled = false;
          const receive = receiveAuthority.advertiseReceivePack(
            createDevelopmentIngressPrincipal(MEMBER_ID),
            contendedProject,
          ).then(
            (): unknown => {
              receiveSettled = true;
              return undefined;
            },
            (error: unknown): unknown => {
              receiveSettled = true;
              return error;
            },
          );
          const otherProjectResult = await ordinaryAdmission.run(
            createDevelopmentIngressPrincipal(MANAGER_ID),
            progressingProject,
            () => Promise.resolve('progressed'),
          ).catch((error: unknown) => {
            throw new Error('progressing-project-failed', { cause: error });
          });
          assert.equal(otherProjectResult, 'progressed');
          assert.equal(ordinaryEntered, false);
          assert.equal(receiveSettled, false);

          releaseMaterialization();
          await accept.catch((error: unknown) => {
            throw new Error('contended-accept-failed', { cause: error });
          });
          const ordinaryFailure = await ordinary;
          assert.equal(
            ordinaryFailure,
            undefined,
            ordinaryFailure instanceof Error ? ordinaryFailure.message : String(ordinaryFailure),
          );
          const receiveFailure = await receive;
          assert.equal(
            receiveFailure,
            undefined,
            receiveFailure instanceof Error ? receiveFailure.message : String(receiveFailure),
          );
          assert.equal(ordinaryEntered, true);
          assert.equal(receiveSettled, true);
        } finally {
          releaseMaterialization();
          await receiveAuthority.close();
          await ordinaryAdmission.close();
          await contendedAccept.close();
        }
      } finally {
        await repository.close();
        await resources.close();
        await store.close();
        await rm(root, { force: true, recursive: true });
      }
    });
  });
});
