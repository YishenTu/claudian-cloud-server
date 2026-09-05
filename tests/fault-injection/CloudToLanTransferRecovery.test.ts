import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type {
  CollabAuthorityRelinquishmentProof,
  CollabAuthorityTransferStatus,
} from '@claudian-collab/protocol';

import { PostgresSchemaInitializer } from '../../src/coordination/postgres/PostgresSchemaInitializer.js';
import type { PostgresCoordination } from '../../src/coordination/postgres/PostgresCoordination.js';
import { createMaintenanceAuthorityTransferRecovery } from '../../src/composition/MaintenanceAuthorityTransferRecovery.js';
import type { CloudToLanTransferCoordinator } from '../../src/project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
import {
  acceptCloudToLan,
  activateCloudToLan,
  beginCloudToLan,
  cloudToLanCoordinator,
  CLOUD_TO_LAN_MANAGER_PRINCIPAL,
  cloudToLanPostgres,
  readCloudToLanDurableEvidence,
  seedCloudToLanProject,
  seedCloudToLanRepository,
  stageCloudToLan,
} from '../helpers/CloudToLanPostgresHarness.js';
import { withPostgresTestDatabase } from '../helpers/PostgresTestDatabase.js';

const PROCESS_WORKER = fileURLToPath(new URL(
  '../helpers/CloudToLanProcessWorker.ts',
  import.meta.url,
));

interface ProcessWorkerResult {
  readonly claimRecovered?: boolean;
  readonly competingWrite?: 'admitted-after-settlement' | 'rejected';
  readonly oldPhase?: string;
  readonly outcome?: string;
  readonly phase?: string;
  readonly projectAuthorityGeneration?: number;
  readonly projectServiceState?: string;
  readonly transferId?: string;
}

function spawnProcessWorker(input: Readonly<{
  readonly action: 'drive-and-hold' | 'recover-then-write';
  readonly durableRoot: string;
  readonly mode: 'cancel' | 'forward';
  readonly phase: string;
  readonly projectId: string;
  readonly runtimeUrl: string;
  readonly transferId?: string;
}>) {
  return spawn(process.execPath, ['--import', 'tsx', PROCESS_WORKER], {
    env: {
      ...process.env,
      CLAUDIAN_C2L_PROCESS_ACTION: input.action,
      CLAUDIAN_C2L_PROCESS_DURABLE_ROOT: input.durableRoot,
      CLAUDIAN_C2L_PROCESS_MODE: input.mode,
      CLAUDIAN_C2L_PROCESS_PHASE: input.phase,
      CLAUDIAN_C2L_PROCESS_PROJECT_ID: input.projectId,
      CLAUDIAN_C2L_PROCESS_RUNTIME_URL: input.runtimeUrl,
      ...(input.transferId === undefined
        ? {}
        : { CLAUDIAN_C2L_PROCESS_TRANSFER_ID: input.transferId }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function firstWorkerResult(
  child: ReturnType<typeof spawnProcessWorker>,
): Promise<ProcessWorkerResult> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error('cloud-to-lan-process-worker.timeout'));
    }, 10_000);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output.slice(0, newline)) as ProcessWorkerResult);
      } catch {
        reject(new Error('cloud-to-lan-process-worker.invalid-output'));
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error('cloud-to-lan-process-worker.failed'));
      }
    });
  });
}

async function killHeldProcess(child: ReturnType<typeof spawnProcessWorker>): Promise<void> {
  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
}

async function runRecoveryProcess(input: Readonly<{
  readonly durableRoot: string;
  readonly mode: 'cancel' | 'forward';
  readonly phase: string;
  readonly projectId: string;
  readonly runtimeUrl: string;
  readonly transferId: string;
}>): Promise<ProcessWorkerResult> {
  const child = spawnProcessWorker({
    action: 'recover-then-write',
    ...input,
  });
  const exitResult = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  const [result, exit] = await Promise.all([
    firstWorkerResult(child),
    exitResult,
  ]);
  assert.equal(exit, 0);
  return result;
}

function suffix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

async function withDurableRoot<T>(
  operation: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'claudian-c2l-durable-'));
  try {
    return await operation(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function journalPhase(
  store: PostgresCoordination,
  projectId: string,
  transferId: string,
): Promise<string> {
  return store.withProjectScope(projectId, async scope => {
    const journal = await scope.portability.getLifecycleJournal(transferId);
    assert.ok(journal);
    return journal.phase;
  });
}

async function recoverCurrent(
  coordinator: CloudToLanTransferCoordinator,
  store: PostgresCoordination,
  projectId: string,
  transferId: string,
): Promise<void> {
  const observed = await store.withProjectScope(projectId, scope => (
    scope.portability.getLifecycleJournal(transferId)
  ));
  assert.ok(observed);
  const reservation = await coordinator.reserveRecovery(projectId, observed);
  const lease = await store.acquireProjectLease(projectId);
  try {
    const journal = await lease.withProjectScope(scope => (
      scope.portability.getLifecycleJournal(transferId)
    ));
    assert.ok(journal);
    await coordinator.recover({
      journal,
      lease,
      ...(reservation === undefined ? {} : {
        repositoryReservation: reservation,
      }),
    });
  } finally {
    await lease.close();
    await reservation?.close();
  }
}

async function relinquishmentProof(
  coordinator: CloudToLanTransferCoordinator,
  projectId: string,
  transferId: string,
): Promise<CollabAuthorityRelinquishmentProof> {
  const status = await coordinator.getStatus({
    principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
    request: { projectId, transferId },
  });
  assert.ok(status.relinquishmentProof);
  return status.relinquishmentProof;
}

async function settleForward(input: Readonly<{
  readonly coordinator: CloudToLanTransferCoordinator;
  readonly projectId: string;
  readonly store: PostgresCoordination;
  readonly transferId: string;
}>): Promise<CollabAuthorityTransferStatus> {
  let phase = await journalPhase(input.store, input.projectId, input.transferId);
  if (phase === 'collecting-readiness') {
    await acceptCloudToLan(input.coordinator, input.projectId, input.transferId);
    phase = await journalPhase(input.store, input.projectId, input.transferId);
  }
  if (phase === 'cloud-quiesced') {
    await recoverCurrent(
      input.coordinator,
      input.store,
      input.projectId,
      input.transferId,
    );
    phase = await journalPhase(input.store, input.projectId, input.transferId);
  }
  if (phase === 'checkpoint-captured') {
    await stageCloudToLan(input.coordinator, input.projectId, input.transferId);
    phase = await journalPhase(input.store, input.projectId, input.transferId);
  }
  if (phase === 'target-staged' || phase === 'claims-retained') {
    await recoverCurrent(
      input.coordinator,
      input.store,
      input.projectId,
      input.transferId,
    );
    phase = await journalPhase(input.store, input.projectId, input.transferId);
  }
  if (phase === 'cloud-relinquished') {
    await activateCloudToLan(
      input.coordinator,
      input.projectId,
      input.transferId,
      await relinquishmentProof(
        input.coordinator,
        input.projectId,
        input.transferId,
      ),
    );
    phase = await journalPhase(input.store, input.projectId, input.transferId);
  }
  if (phase === 'lan-activated') {
    await recoverCurrent(
      input.coordinator,
      input.store,
      input.projectId,
      input.transferId,
    );
  }
  return input.coordinator.getStatus({
    principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
    request: { projectId: input.projectId, transferId: input.transferId },
  });
}

async function stopProcess(
  coordinator: CloudToLanTransferCoordinator,
  store: PostgresCoordination,
): Promise<void> {
  await coordinator.close();
  await store.close();
}

describe('Cloud-to-LAN cross-store recovery', () => {
  it('lets the offline maintenance owner finish every locally actionable phase', async () => {
    await withPostgresTestDatabase(async database => {
      await withDurableRoot(async durableRoot => {
        await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
        const cases = [
          ['collecting-readiness', 'cloud-quiesced', 'checkpoint-captured'],
          ['cloud-quiesced', 'checkpoint-captured', 'checkpoint-captured'],
          ['target-staged', 'claims-retained', 'cloud-relinquished'],
          ['claims-retained', 'cloud-relinquished', 'cloud-relinquished'],
          ['cloud-relinquished', undefined, 'cloud-relinquished'],
        ] as const;
        for (const [phase, faultPhase, expectedPhase] of cases) {
          const projectId = `project-maintenance-${suffix(phase)}`;
          const expectedMainOid = await seedCloudToLanRepository(
            durableRoot,
            projectId,
          );
          await seedCloudToLanProject(database, projectId, expectedMainOid);
          const store = cloudToLanPostgres(database);
          const fault = { nextPhase: undefined as string | undefined };
          const foreground = cloudToLanCoordinator({
            durableRoot,
            fault,
            projectId,
            store,
          });
          const begun = await beginCloudToLan(foreground, projectId);
          if (phase === 'collecting-readiness' || phase === 'cloud-quiesced') {
            fault.nextPhase = faultPhase;
            await assert.rejects(
              acceptCloudToLan(foreground, projectId, begun.transferId),
            );
          } else {
            await acceptCloudToLan(foreground, projectId, begun.transferId);
            if (faultPhase !== undefined) fault.nextPhase = faultPhase;
            if (phase === 'cloud-relinquished') {
              await stageCloudToLan(foreground, projectId, begun.transferId);
            } else {
              await assert.rejects(
                stageCloudToLan(foreground, projectId, begun.transferId),
              );
            }
          }
          assert.equal(
            await journalPhase(store, projectId, begun.transferId),
            phase,
          );
          await foreground.close();

          const recoveryCoordinator = cloudToLanCoordinator({
            durableRoot,
            projectId,
            store,
          });
          const maintenance = createMaintenanceAuthorityTransferRecovery({
            checkpoint: {} as never,
            cloudToLan: recoveryCoordinator,
            repository: {} as never,
          });
          const lease = await store.acquireProjectLease(projectId);
          try {
            const journal = await lease.withProjectScope(scope => (
              scope.portability.getLifecycleJournal(begun.transferId)
            ));
            assert.ok(journal);
            assert.equal(await maintenance.owner.recover({ journal, lease }),
              'waiting-for-external-proof');
          } finally {
            await lease.close();
            await maintenance.close();
          }
          assert.equal(
            await journalPhase(store, projectId, begun.transferId),
            expectedPhase,
          );
          await store.close();
        }
      });
    });
  });

  it('recovers forward after process death at every durable transfer phase', async () => {
    await withPostgresTestDatabase(async database => {
      await withDurableRoot(async durableRoot => {
        await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
        const phases = [
          'collecting-readiness',
          'cloud-quiesced',
          'checkpoint-captured',
          'target-staged',
          'claims-retained',
          'cloud-relinquished',
          'lan-activated',
          'completed',
        ] as const;
        for (const stoppedPhase of phases) {
          const projectId = `project-c2l-${suffix(stoppedPhase)}`;
          const expectedMainOid = await seedCloudToLanRepository(durableRoot, projectId);
          await seedCloudToLanProject(database, projectId, expectedMainOid);
        const processA = spawnProcessWorker({
          action: 'drive-and-hold',
          durableRoot,
          mode: 'forward',
          phase: stoppedPhase,
          projectId,
          runtimeUrl: database.runtimeUrl,
        });
        const stopped = await firstWorkerResult(processA);
        assert.equal(stopped.phase, stoppedPhase);
        assert.ok(stopped.transferId);
        if (stoppedPhase === 'collecting-readiness') {
          const unrelatedProjectId = 'project-c2l-unrelated-progress';
          const unrelatedMainOid = await seedCloudToLanRepository(
            durableRoot,
            unrelatedProjectId,
          );
          await seedCloudToLanProject(
            database,
            unrelatedProjectId,
            unrelatedMainOid,
          );
          const unrelatedStore = cloudToLanPostgres(database);
          const unrelatedCoordinator = cloudToLanCoordinator({
            durableRoot,
            projectId: unrelatedProjectId,
            store: unrelatedStore,
          });
          assert.equal((await beginCloudToLan(
            unrelatedCoordinator,
            unrelatedProjectId,
          )).phase, 'collecting-readiness');
          await stopProcess(unrelatedCoordinator, unrelatedStore);
        }
        await killHeldProcess(processA);

        const processB = await runRecoveryProcess({
          durableRoot,
          mode: 'forward',
          phase: stoppedPhase,
          projectId,
          runtimeUrl: database.runtimeUrl,
          transferId: stopped.transferId,
        });
        assert.equal(processB.competingWrite, 'rejected');
        assert.ok(processB.outcome === 'settled'
          || processB.outcome === 'waiting-for-external-proof');
        assert.equal(
          processB.claimRecovered,
          stoppedPhase === 'target-staged'
            || stoppedPhase === 'claims-retained'
            || stoppedPhase === 'cloud-relinquished'
            || stoppedPhase === 'lan-activated'
            || stoppedPhase === 'completed',
        );

        const store = cloudToLanPostgres(database);
        const coordinator = cloudToLanCoordinator({ durableRoot, projectId, store });
        const completed = await settleForward({
          coordinator,
          projectId,
          store,
          transferId: stopped.transferId,
        });
        assert.equal(completed.phase, 'completed');
        assert.equal(completed.state, 'completed');
        await store.withProjectScope(projectId, async scope => {
          const project = await scope.getProject();
          assert.equal(project?.authorityGeneration, 5);
          assert.equal(project.serviceState, 'deleting');
          assert.equal((await scope.portability.getLifecycleJournal(
            stopped.transferId as string,
          ))?.state, 'completed');
        });
        await stopProcess(coordinator, store);
        assert.deepEqual(
          await readCloudToLanDurableEvidence(
            durableRoot,
            projectId,
            stopped.transferId,
          ),
          {
            checkpointExists: false,
            fenceState: 'relinquished',
            targetState: 'activated',
          },
        );
        }
      });
    });
  });

  it('reopens the same generation after process death at every cancellation phase', async () => {
    await withPostgresTestDatabase(async database => {
      await withDurableRoot(async durableRoot => {
        await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
        const cases = [
          ['cancel-intent', 'target-invalidated'],
          ['target-invalidated', 'target-cleaned'],
          ['target-cleaned', 'source-reopened'],
          ['source-reopened', 'cancelled'],
          ['cancelled', undefined],
        ] as const;
        for (const [stoppedPhase, faultPhase] of cases) {
          const projectId = `project-cancel-${suffix(stoppedPhase)}`;
          const expectedMainOid = await seedCloudToLanRepository(durableRoot, projectId);
          await seedCloudToLanProject(database, projectId, expectedMainOid);
        assert.equal(faultPhase === undefined, stoppedPhase === 'cancelled');
        const processA = spawnProcessWorker({
          action: 'drive-and-hold',
          durableRoot,
          mode: 'cancel',
          phase: stoppedPhase,
          projectId,
          runtimeUrl: database.runtimeUrl,
        });
        const stopped = await firstWorkerResult(processA);
        assert.equal(stopped.phase, stoppedPhase);
        assert.ok(stopped.transferId);
        await killHeldProcess(processA);

        const processB = await runRecoveryProcess({
          durableRoot,
          mode: 'cancel',
          phase: stoppedPhase,
          projectId,
          runtimeUrl: database.runtimeUrl,
          transferId: stopped.transferId,
        });
        assert.equal(processB.outcome, 'settled');
        assert.equal(processB.competingWrite, 'admitted-after-settlement');

        const store = cloudToLanPostgres(database);
        const coordinator = cloudToLanCoordinator({ durableRoot, projectId, store });
        const status = await coordinator.getStatus({
          principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
          request: { projectId, transferId: stopped.transferId },
        });
        assert.equal(status.phase, 'cancelled');
        assert.equal(status.state, 'cancelled');
        await store.withProjectScope(projectId, async scope => {
          const project = await scope.getProject();
          assert.equal(project?.authorityGeneration, 4);
          assert.equal(project.serviceState, 'active');
        });
        await stopProcess(coordinator, store);
        assert.deepEqual(
          await readCloudToLanDurableEvidence(
            durableRoot,
            projectId,
            stopped.transferId,
          ),
          {
            checkpointExists: false,
            fenceState: 'reopened',
            targetState: 'invalidated',
          },
        );
        }
      });
    });
  });
});
