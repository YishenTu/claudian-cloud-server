import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import type {
  ProjectLifecycleJournalRecord,
} from '../../src/coordination/PortabilityLifecyclePersistence.js';
import { PostgresCoordination } from '../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../src/coordination/postgres/PostgresSchemaInitializer.js';
import {
  ProjectWriteAdmission,
  ProjectWriteAdmissionError,
  ProjectRecoveryError,
} from '../../src/project-authority/admission/ProjectWriteAdmission.js';
import {
  ProjectLifecycleRecoveryDispatcher,
  type ProjectLifecycleRecoveryOwner,
} from '../../src/project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import {
  ProjectRecoveryCoordinator,
} from '../../src/project-authority/recovery/ProjectRecoveryCoordinator.js';
import {
  createDevelopmentPrincipal,
} from '../../src/request-context/RequestPrincipal.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../helpers/PostgresTestDatabase.js';

const T0 = '2026-08-25T00:00:00.000Z';
const T1 = '2026-08-25T00:01:00.000Z';
const T2 = '2026-08-25T00:02:00.000Z';

type Fault =
  | 'after-completed'
  | 'after-repository-effect'
  | 'after-repository-observed';

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 3,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

async function seedProject(
  database: PostgresTestDatabase,
  projectId: string,
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('claudian_cloud.project_id', $1, true)`,
      [projectId],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation, expected_main_oid,
         service_state, created_at, activated_at
       ) VALUES (
         $1, 'Lifecycle Recovery', 1, repeat('a', 40), 'maintenance',
         $2::timestamptz, $2::timestamptz
       )`,
      [projectId, T0],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

class FaultController {
  target: Fault | undefined;

  trip(point: Fault): void {
    if (this.target !== point) return;
    this.target = undefined;
    throw new Error('injected-process-death');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

class DurableRepositoryEffect {
  constructor(readonly root: string) {}

  async apply(operationId: string): Promise<void> {
    let created = false;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        join(this.root, operationId),
        'wx',
        0o600,
      );
      await handle.writeFile('repository-effect\n');
      await handle.sync();
      created = true;
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    } finally {
      if (handle !== undefined) await handle.close();
    }
    if (created) {
      const directory = await open(this.root, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }

  async assertApplied(operationId: string): Promise<void> {
    assert.equal(
      await readFile(join(this.root, operationId), 'utf8'),
      'repository-effect\n',
    );
  }
}

class VerticalOwner implements ProjectLifecycleRecoveryOwner {
  constructor(
    readonly controller: FaultController,
    readonly repository: DurableRepositoryEffect,
  ) {}

  async recover(input: Parameters<ProjectLifecycleRecoveryOwner['recover']>[0]) {
    let journal: ProjectLifecycleJournalRecord = input.journal;
    if (journal.phase === 'prepared') {
      await this.repository.apply(journal.operationId);
      this.controller.trip('after-repository-effect');
      await input.lease.withProjectScope(scope => (
        scope.portability.advanceLifecycleJournal({
          expectedPhase: 'prepared',
          expectedState: 'active',
          nextPhase: 'repository-observed',
          nextState: 'active',
          operationId: journal.operationId,
          scheduledAt: T1,
          updatedAt: T1,
        })
      ));
      this.controller.trip('after-repository-observed');
      journal = Object.freeze({
        ...journal,
        phase: 'repository-observed',
        scheduledAt: T1,
        updatedAt: T1,
      });
    }
    if (journal.phase !== 'repository-observed') {
      throw new Error('unexpected-phase');
    }
    await this.repository.assertApplied(journal.operationId);
    await input.lease.withProjectScope(scope => (
      scope.portability.advanceLifecycleJournal({
        expectedPhase: 'repository-observed',
        expectedState: 'active',
        nextPhase: 'completed',
        nextState: 'completed',
        operationId: journal.operationId,
        scheduledAt: T2,
        updatedAt: T2,
      })
    ));
    this.controller.trip('after-completed');
    return 'settled' as const;
  }
}

function owners(owner: ProjectLifecycleRecoveryOwner) {
  const unexpected: ProjectLifecycleRecoveryOwner = {
    recover: () => Promise.reject(new Error('unexpected-owner')),
  };
  return Object.freeze({
    authorityTransfer: unexpected,
    backup: owner,
    deletion: unexpected,
    export: unexpected,
    leave: unexpected,
    retire: unexpected,
  });
}

async function within<Result>(
  promise: Promise<Result>,
  label: string,
): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timeout:${label}`)),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe('Project lifecycle cross-store recovery', () => {
  it('recovers past a full page of ordinary candidates after a lifecycle fault and restart', async context => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      const projectId = 'project-lifecycle-mixed';
      const operationId = 'backup-lifecycle-mixed';
      await seedProject(database, projectId);
      const client = new Client({ connectionString: database.migrationUrl });
      try {
        await client.connect();
        // Catalog metadata for other owners remains pending throughout this test.
        await client.query(
          `INSERT INTO claudian_cloud.recovery_candidates (
             kind, project_id, operation_id, scheduled_at, created_at
           )
           SELECT 'accept', 'project-ordinary-' || value::text,
                  'operation-ordinary-' || value::text, $1::timestamptz, $1::timestamptz
             FROM generate_series(1, 105) AS value`,
          [T0],
        );
      } finally {
        await client.end();
      }
      const root = await mkdtemp(join(tmpdir(), 'claudian-mixed-recovery-'));
      context.after(() => rm(root, { recursive: true, force: true }));
      const repository = new DurableRepositoryEffect(root);
      const controller = new FaultController();
      controller.target = 'after-repository-effect';
      const firstStore = coordination(database);
      const first = new ProjectLifecycleRecoveryDispatcher({
        coordination: firstStore,
        owners: owners(new VerticalOwner(controller, repository)),
      });
      try {
        await firstStore.withProjectScope(projectId, scope => scope.portability.putLifecycleJournal({
          actorMemberId: undefined,
          createdAt: T0,
          direction: undefined,
          expectedAuthorityGeneration: 1,
          idempotencyKey: 'intent-lifecycle-mixed',
          kind: 'backup',
          operationId,
          phase: 'prepared',
          projectId,
          requestFingerprint: 'b'.repeat(64),
          scheduledAt: T0,
        }));
        await assert.rejects(first.recoverAvailable(firstStore), error => (
          error instanceof ProjectRecoveryError && error.code === 'dependency-failed'
        ));
        await repository.assertApplied(operationId);
      } finally {
        first.close();
        await firstStore.close();
      }
      const restartedStore = coordination(database);
      const restarted = new ProjectLifecycleRecoveryDispatcher({
        coordination: restartedStore,
        owners: owners(new VerticalOwner(new FaultController(), repository)),
      });
      try {
        await restarted.recoverAvailable(restartedStore);
        await restarted.recoverAvailable(restartedStore);
        const settled = await restartedStore.withProjectScope(projectId, scope => (
          scope.portability.getLifecycleJournal(operationId)
        ));
        assert.equal(settled?.state, 'completed');
        await repository.assertApplied(operationId);
        const head = await restartedStore.listRecoveryCandidates();
        assert.equal(head.candidates.length, 100);
        assert.ok(head.nextCursor);
        const tail = await restartedStore.listRecoveryCandidates({ after: head.nextCursor });
        assert.equal(tail.candidates.length, 5);
        assert.equal(tail.nextCursor, undefined);
        assert.ok([...head.candidates, ...tail.candidates].every(candidate => candidate.kind === 'accept'));
      } finally {
        restarted.close();
        await restartedStore.close();
      }
    });
  });

  it('settles exact replay after failure at every shared durable edge', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      const repositoryRoot = await mkdtemp(join(
        tmpdir(),
        'claudian-lifecycle-recovery-',
      ));
      try {
        for (const [index, fault] of ([
          'after-repository-effect',
          'after-repository-observed',
          'after-completed',
        ] as const).entries()) {
          const suffix = String(index);
          const projectId = `project-lifecycle-${suffix}`;
          const operationId = `backup-lifecycle-${suffix}`;
          await seedProject(database, projectId);
          const candidate = {
            kind: 'backup' as const,
            operationId,
            projectId,
            scheduledAt: T0,
          };
          const controller = new FaultController();
          controller.target = fault;
          const firstStore = coordination(database);
          try {
            await firstStore.withProjectScope(projectId, scope => (
              scope.portability.putLifecycleJournal({
                actorMemberId: undefined,
                createdAt: T0,
                direction: undefined,
                expectedAuthorityGeneration: 1,
                idempotencyKey: `intent-${suffix}`,
                kind: 'backup',
                operationId,
                phase: 'prepared',
                projectId,
                requestFingerprint: String(index + 1).repeat(64),
                scheduledAt: T0,
              })
            ));
            const first = new ProjectLifecycleRecoveryDispatcher({
              coordination: firstStore,
              owners: owners(new VerticalOwner(
                controller,
                new DurableRepositoryEffect(repositoryRoot),
              )),
            });
            await assert.rejects(first.recoverCandidate(candidate), error => {
              assert.ok(error instanceof ProjectRecoveryError);
              assert.equal(error.code, 'dependency-failed');
              return true;
            });
            first.close();
          } finally {
            await firstStore.close();
          }

          const restartedStore = coordination(database);
          const lifecycle = new ProjectLifecycleRecoveryDispatcher({
            coordination: restartedStore,
            owners: owners(new VerticalOwner(
              new FaultController(),
              new DurableRepositoryEffect(repositoryRoot),
            )),
          });
          const recovery = new ProjectRecoveryCoordinator({
            accept: { recoverProject: () => Promise.resolve() },
            activation: { recoverProject: () => Promise.resolve() },
            catalog: {
              listRecoveryCandidates: () => Promise.resolve({
                candidates: [],
                nextCursor: undefined,
              }),
            },
            isolation: restartedStore,
            lifecycle,
          });
          const admission = new ProjectWriteAdmission({
            coordination: restartedStore,
            recovery,
          });
          try {
            await assert.rejects(admission.run(
              createDevelopmentPrincipal('former-member'),
              projectId,
              () => Promise.reject(new Error('unexpected-write-admission')),
            ), error => {
              assert.ok(error instanceof ProjectWriteAdmissionError);
              assert.equal(error.code, 'authorization-denied');
              return true;
            });
            await restartedStore.withProjectScope(projectId, async scope => {
              const settled = await scope.portability.getLifecycleJournal(
                operationId,
              );
              assert.ok(settled);
              assert.equal(settled.phase, 'completed');
              assert.equal(settled.state, 'completed');
            });
          } finally {
            await admission.close();
            recovery.close();
            lifecycle.close();
            await restartedStore.close();
          }
          await new DurableRepositoryEffect(repositoryRoot)
            .assertApplied(operationId);
        }
      } finally {
        await rm(repositoryRoot, { force: true, recursive: true });
      }
    });
  });

  it('allows an unrelated Project to recover while another owner is blocked', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      const repositoryRoot = await mkdtemp(join(
        tmpdir(),
        'claudian-lifecycle-isolation-',
      ));
      const store = coordination(database);
      let releaseFirst: (() => void) | undefined;
      const firstReleased = new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      let markFirstEntered: (() => void) | undefined;
      const firstEntered = new Promise<void>(resolve => {
        markFirstEntered = resolve;
      });
      let firstRecovery: Promise<void> | undefined;
      const repository = new DurableRepositoryEffect(repositoryRoot);
      const owner: ProjectLifecycleRecoveryOwner = {
        recover: async input => {
          await repository.apply(input.journal.operationId);
          if (input.journal.operationId === 'backup-overlap-a') {
            assert.ok(markFirstEntered);
            markFirstEntered();
            await firstReleased;
          }
          await input.lease.withProjectScope(scope => (
            scope.portability.advanceLifecycleJournal({
              expectedPhase: 'prepared',
              expectedState: 'active',
              nextPhase: 'completed',
              nextState: 'completed',
              operationId: input.journal.operationId,
              scheduledAt: T2,
              updatedAt: T2,
            })
          ));
          return 'settled';
        },
      };
      const dispatcher = new ProjectLifecycleRecoveryDispatcher({
        coordination: store,
        owners: owners(owner),
      });
      try {
        for (const [projectId, operationId, fingerprint] of [
          ['project-overlap-a', 'backup-overlap-a', 'a'.repeat(64)],
          ['project-overlap-b', 'backup-overlap-b', 'b'.repeat(64)],
        ] as const) {
          await seedProject(database, projectId);
          await store.withProjectScope(projectId, scope => (
            scope.portability.putLifecycleJournal({
              actorMemberId: undefined,
              createdAt: T0,
              direction: undefined,
              expectedAuthorityGeneration: 1,
              idempotencyKey: `intent-${operationId}`,
              kind: 'backup',
              operationId,
              phase: 'prepared',
              projectId,
              requestFingerprint: fingerprint,
              scheduledAt: T0,
            })
          ));
        }
        firstRecovery = dispatcher.recoverCandidate({
          kind: 'backup',
          operationId: 'backup-overlap-a',
          projectId: 'project-overlap-a',
          scheduledAt: T0,
        });
        await within(firstEntered, 'first-owner-entered');
        await within(dispatcher.recoverCandidate({
          kind: 'backup',
          operationId: 'backup-overlap-b',
          projectId: 'project-overlap-b',
          scheduledAt: T0,
        }), 'unrelated-project-recovery');
        await store.withProjectScope('project-overlap-b', async scope => {
          const settled = await scope.portability.getLifecycleJournal(
            'backup-overlap-b',
          );
          assert.equal(settled?.state, 'completed');
        });
        await repository.assertApplied('backup-overlap-b');
        assert.ok(releaseFirst);
        releaseFirst();
        await firstRecovery;
        await repository.assertApplied('backup-overlap-a');
      } finally {
        releaseFirst?.();
        if (firstRecovery !== undefined) {
          await firstRecovery.catch(() => undefined);
        }
        dispatcher.close();
        await store.close();
        await rm(repositoryRoot, { force: true, recursive: true });
      }
    });
  });
});
