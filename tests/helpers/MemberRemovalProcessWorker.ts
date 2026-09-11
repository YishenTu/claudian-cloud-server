import { ProjectMemberRemovalCoordinator } from '../../src/project-authority/membership/ProjectMemberRemovalCoordinator.js';
import { createVaultCredentialPrincipal } from '../../src/request-context/RequestPrincipal.js';
import { CLOUD_TO_LAN_MANAGER_PRINCIPAL } from './CloudToLanPostgresHarness.js';
import { PostgresCoordination } from '../../src/coordination/postgres/PostgresCoordination.js';
import { RepositoryCheckpointAuthority } from '../../src/repositories/RepositoryCheckpointAuthority.js';
import type {
  RepositoryPlacementLease,
  RepositoryPlacementValidator,
} from '../../src/repositories/RepositoryPlacement.js';
import { ResourceAdmission } from '../../src/resource-admission/ResourceAdmission.js';

const GIT = '/usr/bin/git';
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error('member-removal-worker.configuration-invalid');
  return value;
}
class CurrentPlacement implements RepositoryPlacementValidator {
  isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> { return Promise.resolve(true); }
}
async function main(): Promise<void> {
  const projectId = required('CLAUDIAN_REMOVAL_PROJECT_ID');
  const repositoryRoot = required('CLAUDIAN_REMOVAL_REPOSITORY_ROOT');
  const operationRoot = required('CLAUDIAN_REMOVAL_OPERATION_ROOT');
  const runtimeConnectionString = required('CLAUDIAN_REMOVAL_RUNTIME_URL');
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
  const removal = new ProjectMemberRemovalCoordinator({
    clock: () => new Date('2026-08-27T00:00:01.000Z'),
    coordination: store,
    repository: {
      reserveExactRepositoryOperation: (projectId, signal) => repository.reserveExactRepositoryOperation(projectId, signal),
      readExactPersonalRef: (reservation, input) => repository.readExactPersonalRef(reservation, input),
      verifyExactPersonalRef: (reservation, input) => repository.verifyExactPersonalRef(reservation, input),
      deleteExactPersonalRef: () => {
        process.stdout.write('membership-revoked\n');
        return new Promise<never>(() => undefined);
      },
    },
  });
  await removal.remove(createVaultCredentialPrincipal({ principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL }), {
    expectedManagerSetGeneration: 1, expectedTargetMembershipRevision: 1, idempotencyKey: 'remove-recovery-intent', projectId, targetMemberId: 'member-target',
  });
}
void main().catch(() => {
  process.stderr.write('member-removal-worker.failed\n');
  process.exit(1);
});
