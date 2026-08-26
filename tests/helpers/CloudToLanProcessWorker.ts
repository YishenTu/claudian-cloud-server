import assert from 'node:assert/strict';

import {
  CloudToLanTransferCoordinatorError,
} from '../../src/project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
import {
  ProjectLifecycleRecoveryDispatcher,
  type ProjectLifecycleRecoveryOwner,
} from '../../src/project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import {
  acceptCloudToLan,
  activateCloudToLan,
  beginCloudToLan,
  cloudToLanCoordinator,
  cloudToLanPostgres,
  CLOUD_TO_LAN_MANAGER_PRINCIPAL,
  CLOUD_TO_LAN_TARGET_ID,
  type CloudToLanJournalFault,
  stageCloudToLan,
} from './CloudToLanPostgresHarness.js';

const action = process.env.CLAUDIAN_C2L_PROCESS_ACTION;
const durableRoot = process.env.CLAUDIAN_C2L_PROCESS_DURABLE_ROOT;
const mode = process.env.CLAUDIAN_C2L_PROCESS_MODE;
const phase = process.env.CLAUDIAN_C2L_PROCESS_PHASE;
const projectId = process.env.CLAUDIAN_C2L_PROCESS_PROJECT_ID;
const runtimeUrl = process.env.CLAUDIAN_C2L_PROCESS_RUNTIME_URL;
const transferId = process.env.CLAUDIAN_C2L_PROCESS_TRANSFER_ID;

if (
  (action !== 'drive-and-hold' && action !== 'recover-then-write')
  || (mode !== 'forward' && mode !== 'cancel')
  || phase === undefined
  || durableRoot === undefined
  || projectId === undefined
  || runtimeUrl === undefined
) {
  throw new Error('cloud-to-lan-process-worker.invalid-input');
}

const workerPhase = phase;
const workerProjectId = projectId;

const store = cloudToLanPostgres({ runtimeUrl });
const fault: CloudToLanJournalFault = { nextPhase: undefined };
const coordinator = cloudToLanCoordinator({ durableRoot, fault, projectId, store });

async function expectFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  throw new Error('cloud-to-lan-process-worker.expected-failure');
}

async function currentPhase(operationId: string): Promise<string> {
  return store.withProjectScope(projectId as string, async scope => {
    const journal = await scope.portability.getLifecycleJournal(operationId);
    assert.ok(journal);
    return journal.phase;
  });
}

async function proofFor(operationId: string) {
  const status = await coordinator.getStatus({
    principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
    request: { projectId: projectId as string, transferId: operationId },
  });
  assert.ok(status.relinquishmentProof);
  return status.relinquishmentProof;
}

async function driveForward(): Promise<string> {
  const begun = await beginCloudToLan(coordinator, projectId as string);
  if (phase !== 'collecting-readiness') {
    if (phase === 'cloud-quiesced') fault.nextPhase = 'checkpoint-captured';
    const accepted = acceptCloudToLan(
      coordinator,
      projectId as string,
      begun.transferId,
    );
    if (phase === 'cloud-quiesced') await expectFailure(accepted);
    else await accepted;
  }
  if (
    phase === 'target-staged'
    || phase === 'claims-retained'
    || phase === 'cloud-relinquished'
    || phase === 'lan-activated'
    || phase === 'completed'
  ) {
    if (phase === 'target-staged') fault.nextPhase = 'claims-retained';
    if (phase === 'claims-retained') fault.nextPhase = 'cloud-relinquished';
    const staged = stageCloudToLan(
      coordinator,
      projectId as string,
      begun.transferId,
    );
    if (phase === 'target-staged' || phase === 'claims-retained') {
      await expectFailure(staged);
    } else {
      await staged;
    }
  }
  if (phase === 'lan-activated' || phase === 'completed') {
    if (phase === 'lan-activated') fault.nextPhase = 'completed';
    const activated = activateCloudToLan(
      coordinator,
      projectId as string,
      begun.transferId,
      await proofFor(begun.transferId),
    );
    if (phase === 'lan-activated') await expectFailure(activated);
    else await activated;
  }
  assert.equal(await currentPhase(begun.transferId), phase);
  return begun.transferId;
}

async function driveCancellation(): Promise<string> {
  const begun = await beginCloudToLan(coordinator, projectId as string);
  await acceptCloudToLan(coordinator, projectId as string, begun.transferId);
  fault.nextPhase = 'claims-retained';
  await expectFailure(stageCloudToLan(
    coordinator,
    projectId as string,
    begun.transferId,
  ));
  const faultByPhase: Readonly<Record<string, string | undefined>> = {
    'cancel-intent': 'target-invalidated',
    'cancelled': undefined,
    'source-reopened': 'cancelled',
    'target-cleaned': 'source-reopened',
    'target-invalidated': 'target-cleaned',
  };
  const cancellationPhase = phase as string;
  if (!(cancellationPhase in faultByPhase)) {
    throw new Error('cloud-to-lan-process-worker.invalid-cancel-phase');
  }
  const shouldFail = faultByPhase[cancellationPhase] !== undefined;
  fault.nextPhase = faultByPhase[cancellationPhase];
  const cancellation = coordinator.cancel({
    principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
    request: {
      expectedPhase: 'target-staged',
      idempotencyKey: `cancel-${workerProjectId}`,
      projectId: projectId as string,
      transferId: begun.transferId,
    },
  });
  if (shouldFail) await expectFailure(cancellation);
  else await cancellation;
  assert.equal(await currentPhase(begun.transferId), phase);
  return begun.transferId;
}

async function driveAndHold(): Promise<void> {
  const operationId = mode === 'forward'
    ? await driveForward()
    : await driveCancellation();
  const lease = await store.acquireProjectLease(projectId as string);
  process.stdout.write(`${JSON.stringify({
    phase: workerPhase,
    transferId: operationId,
  })}\n`);
  await new Promise<void>(() => undefined);
  await lease.close();
}

async function recoverThenWrite(): Promise<void> {
  if (transferId === undefined) {
    throw new Error('cloud-to-lan-process-worker.transfer-required');
  }
  const journal = await store.withProjectScope(projectId as string, scope => (
    scope.portability.getLifecycleJournal(transferId)
  ));
  assert.ok(journal);
  const waitingOwner: ProjectLifecycleRecoveryOwner = {
    recover: () => Promise.resolve('waiting-for-external-proof'),
  };
  const dispatcher = new ProjectLifecycleRecoveryDispatcher({
    coordination: store,
    owners: {
      authorityTransfer: {
        recover: async input => {
          const status = await input.lease.withProjectScope(scope => (
            scope.portability.getAuthorityTransferStatus(transferId)
          ));
          assert.equal(status?.phase, input.journal.phase);
          return coordinator.recover(input);
        },
      },
      backup: waitingOwner,
      deletion: waitingOwner,
      export: waitingOwner,
      leave: waitingOwner,
      retire: waitingOwner,
    },
  });
  await dispatcher.recoverCandidate({
    kind: journal.kind,
    operationId: journal.operationId,
    projectId: journal.projectId,
    scheduledAt: journal.scheduledAt,
  });

  const recoveredJournal = await store.withProjectScope(projectId as string, scope => (
    scope.portability.getLifecycleJournal(transferId)
  ));
  assert.ok(recoveredJournal);
  const outcome = recoveredJournal.state === 'cancelled'
    || recoveredJournal.state === 'completed'
    ? 'settled'
    : 'waiting-for-external-proof';
  let claimRecovered = false;
  if (
    recoveredJournal.phase === 'cloud-relinquished'
    || recoveredJournal.phase === 'lan-activated'
    || recoveredJournal.phase === 'completed'
  ) {
    const claim = await coordinator.getClaim({
      principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
      request: { projectId: projectId as string, transferId },
    });
    assert.equal(claim.memberId, 'member-manager');
    claimRecovered = true;
  }

  let competingWrite: 'admitted-after-settlement' | 'rejected';
  try {
    await coordinator.begin({
      expiresAt: '2026-10-26T00:00:00.000Z',
      principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
      request: {
        expectedAuthorityGeneration: 4,
        idempotencyKey: `competing-${workerProjectId}`,
        projectId: projectId as string,
        targetHostMemberId: CLOUD_TO_LAN_TARGET_ID,
        targetUrl: 'https://different-lan.example.test',
      },
    });
    competingWrite = 'admitted-after-settlement';
  } catch (error: unknown) {
    if (!(error instanceof CloudToLanTransferCoordinatorError)) throw error;
    competingWrite = 'rejected';
  }

  const state = await store.withProjectScope(projectId as string, async scope => ({
    oldPhase: (await scope.portability.getLifecycleJournal(transferId))?.phase,
    project: await scope.getProject(),
  }));
  process.stdout.write(`${JSON.stringify({
    claimRecovered,
    competingWrite,
    oldPhase: state.oldPhase,
    outcome,
    projectAuthorityGeneration: state.project?.authorityGeneration,
    projectServiceState: state.project?.serviceState,
  })}\n`);
  await coordinator.close();
  await store.close();
}

await (action === 'drive-and-hold' ? driveAndHold() : recoverThenWrite());
