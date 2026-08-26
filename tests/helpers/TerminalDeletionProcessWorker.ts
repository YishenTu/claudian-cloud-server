import { PostgresCoordination } from '../../src/coordination/postgres/PostgresCoordination.js';
import { RepositoryCheckpointAuthority } from '../../src/repositories/RepositoryCheckpointAuthority.js';
import type {
  RepositoryPlacementLease,
  RepositoryPlacementValidator,
} from '../../src/repositories/RepositoryPlacement.js';
import { ResourceAdmission } from '../../src/resource-admission/ResourceAdmission.js';

const GIT = '/usr/bin/git';
const DELETION_PHASES = [
  'traffic-denied',
  'repository-delete-intent',
  'repository-removed',
  'coordination-removed',
  'tombstoned',
  'completed',
] as const;
type DeletionPhase = typeof DELETION_PHASES[number];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error('terminal-deletion-worker.configuration-invalid');
  }
  return value;
}

function requiredPhase(): DeletionPhase {
  const value = required('CLAUDIAN_TERMINAL_DELETE_TARGET_PHASE');
  const phase = DELETION_PHASES.find(candidate => candidate === value);
  if (phase === undefined) {
    throw new Error('terminal-deletion-worker.configuration-invalid');
  }
  return phase;
}

function immediatelyAfter(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 1).toISOString();
}

class CurrentPlacement implements RepositoryPlacementValidator {
  async isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    await Promise.resolve();
    return true;
  }
}

async function main(): Promise<void> {
  const operationId = required('CLAUDIAN_TERMINAL_DELETE_OPERATION_ID');
  const operationRoot = required('CLAUDIAN_TERMINAL_DELETE_OPERATION_ROOT');
  const projectId = required('CLAUDIAN_TERMINAL_DELETE_PROJECT_ID');
  const repositoryRoot = required('CLAUDIAN_TERMINAL_DELETE_REPOSITORY_ROOT');
  const runtimeConnectionString = required('CLAUDIAN_TERMINAL_DELETE_RUNTIME_URL');
  const targetPhase = requiredPhase();
  const admission = new ResourceAdmission({
    maxChildren: 2,
    maxChildrenPerProject: 1,
    queueMax: 2,
    queueMaxPerProject: 1,
    queueTimeoutMs: 1_000,
  });
  const repository = new RepositoryCheckpointAuthority({
    gitExecutable: GIT,
    maximumBlobBytes: 1024 * 1024,
    maximumBundleBytes: 2 * 1024 * 1024,
    maximumExpandedTreeEntries: 100_000,
    maximumRepositoryBytes: 2 * 1024 * 1024,
    maximumTreeEntries: 2_000,
    operationRoot,
    operationTimeoutMs: 5_000,
    outputMaxBytes: 64 * 1024,
    placementValidator: new CurrentPlacement(),
    repositoryRoot,
    resourceAdmission: admission,
    storageNodeId: 'local',
  });
  const store = new PostgresCoordination({
    ordinaryPoolMax: 3,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString,
    shutdownTimeoutMs: 2_000,
  });
  const reservation = await repository.reserveExactRepositoryOperation(projectId);
  const lease = await store.acquireProjectLease(projectId);
  let journal = await lease.withProjectScope(scope => (
    scope.portability.getLifecycleJournal(operationId)
  ));
  if (
    journal?.kind !== 'delete'
    || journal.phase !== 'traffic-denied'
    || journal.state !== 'active'
  ) {
    throw new Error('terminal-deletion-worker.journal-invalid');
  }
  const intent = await lease.withProjectScope(scope => (
    scope.portability.getDeletionIntent(operationId)
  ));
  if (intent === undefined) {
    throw new Error('terminal-deletion-worker.intent-invalid');
  }
  const advance = async (
    expectedPhase: DeletionPhase,
    nextPhase: DeletionPhase,
    resultSha256?: string,
  ): Promise<void> => {
    const currentJournal = journal;
    if (currentJournal === undefined) {
      throw new Error('terminal-deletion-worker.journal-invalid');
    }
    await lease.withProjectScope(scope => scope.portability.advanceLifecycleJournal({
      expectedPhase,
      expectedState: 'active',
      nextPhase,
      nextState: nextPhase === 'completed' ? 'completed' : 'active',
      operationId,
      ...(resultSha256 === undefined ? {} : { resultSha256 }),
      scheduledAt: currentJournal.scheduledAt,
      updatedAt: immediatelyAfter(currentJournal.updatedAt),
    }));
    journal = await lease.withProjectScope(scope => (
      scope.portability.getLifecycleJournal(operationId)
    ));
    if (journal === undefined || journal.phase !== nextPhase) {
      throw new Error('terminal-deletion-worker.journal-invalid');
    }
  };
  const targetIndex = DELETION_PHASES.indexOf(targetPhase);
  if (targetIndex >= 1) {
    await advance('traffic-denied', 'repository-delete-intent');
  }
  if (targetIndex >= 2) {
    await repository.removeExactRepository(reservation, {
      placementGeneration: intent.placementGeneration,
      projectId,
      repositoryStorageKey: intent.repositoryStorageKey,
      storageNodeId: intent.storageNodeId,
    });
    await advance('repository-delete-intent', 'repository-removed');
  }
  if (targetIndex >= 3) {
    const currentJournal = journal;
    await lease.withProjectScope(scope => scope.portability.removeProjectCoordinationContent({
      operationId,
      scheduledAt: currentJournal.scheduledAt,
      updatedAt: immediatelyAfter(currentJournal.updatedAt),
    }));
    journal = await lease.withProjectScope(scope => (
      scope.portability.getLifecycleJournal(operationId)
    ));
    if (journal?.phase !== 'coordination-removed') {
      throw new Error('terminal-deletion-worker.journal-invalid');
    }
  }
  if (targetIndex >= 4) {
    await advance('coordination-removed', 'tombstoned');
  }
  if (targetIndex >= 5) {
    const tombstone = await lease.withProjectScope(scope => (
      scope.portability.getProjectTombstone()
    ));
    if (tombstone === undefined) {
      throw new Error('terminal-deletion-worker.tombstone-invalid');
    }
    await advance('tombstoned', 'completed', tombstone.resultSha256);
  }
  process.stdout.write(`${JSON.stringify({ phase: targetPhase })}\n`);
  await new Promise<void>(() => undefined);
}

void main().catch(() => {
  process.stderr.write('terminal-deletion-worker.failed\n');
  process.exit(1);
});
