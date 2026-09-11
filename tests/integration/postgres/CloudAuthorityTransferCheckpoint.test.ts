import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { CoordinationError } from '../../../src/coordination/CoordinationError.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { EnvironmentBackupMetadataSource } from '../../../src/environment-maintenance/commands/EnvironmentBackupMetadataSource.js';
import { FileEnvironmentRestoreState } from '../../../src/environment-maintenance/restore/FileEnvironmentRestoreState.js';
import { ProductionCheckpointStaging } from '../../../src/onboarding/production/ProductionCheckpointStaging.js';
import { ProjectCheckpointCoordinator } from '../../../src/project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import { CloudAuthorityTransferCheckpoint } from '../../../src/project-authority/lifecycle/cloud-to-lan/CloudAuthorityTransferCheckpoint.js';
import { ProjectAuthoritySourceFence } from '../../../src/project-authority/lifecycle/cloud-to-lan/ProjectAuthoritySourceFence.js';
import { GitBundleImporter } from '../../../src/repositories/GitBundleImporter.js';
import { RepositoryCheckpointAuthority } from '../../../src/repositories/RepositoryCheckpointAuthority.js';
import { BootstrapUploadAdmission } from '../../../src/resource-admission/BootstrapUploadAdmission.js';
import { CheckpointStreamAdmission } from '../../../src/resource-admission/CheckpointStreamAdmission.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';
import {
  acceptCloudToLan,
  beginCloudToLan,
  cloudToLanCoordinator,
  seedCloudToLanProject,
  seedCloudToLanRepository,
} from '../../helpers/CloudToLanPostgresHarness.js';
import { type PostgresTestDatabase, withPostgresTestDatabase } from '../../helpers/PostgresTestDatabase.js';

const PROJECT_ID = 'project-checkpoint-admission';

async function fixture(database: PostgresTestDatabase, maximumCoordinationBytes = 1048576) {
  await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
  const root = await mkdtemp(join(tmpdir(), 'claudian-checkpoint-admission-'));
  const stagingRoot = join(root, 'staging');
  await mkdir(stagingRoot, { mode: 0o700 });
  await mkdir(join(root, 'operations'), { mode: 0o700 });
  await writeFile(join(root, '.authority-volume-id'), database.authorityVolumeId, { mode: 0o600 });
  const oid = await seedCloudToLanRepository(root, PROJECT_ID);
  await seedCloudToLanProject(database, PROJECT_ID, oid);
  const store = new PostgresCoordination({
    ordinaryPoolMax: 3,
    pinnedPoolMax: 3,
    reservedPoolMax: 1,
    projectLockTimeoutMs: 2000,
    shutdownTimeoutMs: 2000,
    runtimeConnectionString: database.runtimeUrl,
  });
  const resources = new ResourceAdmission({
    maxChildren: 3, maxChildrenPerProject: 1, queueMax: 4,
    queueMaxPerProject: 2, queueTimeoutMs: 1000,
  });
  const limits = {
    gitExecutable: '/usr/bin/git', maximumBlobBytes: 1048576,
    maximumBundleBytes: 2097152, maximumExpandedTreeEntries: 100000,
    maximumRepositoryBytes: 2097152, maximumTreeEntries: 2000,
    operationTimeoutMs: 5000, resourceAdmission: resources,
  };
  const repository = new RepositoryCheckpointAuthority({
    ...limits, operationRoot: join(root, 'operations'),
    repositoryRoot: join(root, 'repositories'), outputMaxBytes: 65536,
    placementValidator: store, storageNodeId: 'local',
  });
  const uploads = new BootstrapUploadAdmission({
    maxConcurrentUploads: 1, maxUploadsPerAttempt: 1, queueMax: 2,
    queueTimeoutMs: 1000, stagingFreeSpaceFloorBytes: 1,
    stagingReservationBytes: 4194304, stagingRoot,
  });
  const importer = new GitBundleImporter({
    ...limits, stagingRoot, maximumMetadataOutputBytes: 65536,
    uploadAdmission: uploads, uploadIdleTimeoutMs: 1000, uploadTotalTimeoutMs: 5000,
  });
  const streams = new CheckpointStreamAdmission({
    capacityTimeoutMs: 1000, freeSpaceFloorBytes: 1,
    maxConcurrentStreams: 2, maxConcurrentStreamsPerProject: 1,
    maxStagingAttempts: 2, maxStagingAttemptsPerProject: 1,
    queueMax: 4, queueMaxPerProject: 2, queueTimeoutMs: 1000,
    stagingReservationBytes: 536870912, stagingRoot,
    maximumRepositoryBundleBytes: 2097152,
    maximumCoordinationBytes: 1048576, maximumManifestBytes: 65536,
  });
  const staging = new ProductionCheckpointStaging({
    admission: streams, stagingRoot, idleTimeoutMs: 1000, totalTimeoutMs: 5000,
  });
  const checkpoint = new ProjectCheckpointCoordinator({
    repository: importer, repositoryCapture: repository, staging, maximumCoordinationBytes,
  });
  const state = new FileEnvironmentRestoreState({ authorityRoot: root });
  const capture = new CloudAuthorityTransferCheckpoint({
    checkpoint, repository,
    metadata: new EnvironmentBackupMetadataSource({ state: { inspect: () => state.inspectSettled() } }),
  });
  return {
    capture, checkpoint, repository, resources, root, stagingRoot, store,
    async close() {
      await checkpoint.close();
      await staging.close();
      await importer.close();
      await repository.close();
      await streams.close();
      await uploads.close();
      await resources.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('rejects coordination above its reservation while reading PostgreSQL, before staging', async () => {
  await withPostgresTestDatabase(async database => {
    const runtime = await fixture(database, 128);
    const coordinator = cloudToLanCoordinator({
      store: runtime.store, projectId: PROJECT_ID, fault: { nextPhase: 'checkpoint-captured' },
    });
    try {
      const begun = await beginCloudToLan(coordinator, PROJECT_ID);
      await assert.rejects(acceptCloudToLan(coordinator, PROJECT_ID, begun.transferId));
      const reservation = await runtime.capture.reserve(PROJECT_ID);
      const lease = await runtime.store.acquireProjectLease(PROJECT_ID);
      try {
        await assert.rejects(runtime.capture.capture({
          projectId: PROJECT_ID, operationId: begun.transferId,
          lease, expiresAt: begun.expiresAt,
          sourceAuthority: { kind: 'cloud', generation: 4 },
          targetAuthority: { kind: 'lan', generation: 5 },
        }, reservation), error => error instanceof CoordinationError && error.code === 'resource-limit');
        assert.deepEqual(await readdir(runtime.stagingRoot), []);
      } finally {
        await lease.close();
        await reservation.close();
      }
    } finally {
      await coordinator.close();
      await runtime.close();
    }
  });
});

it('allows a reserved writer to enter while target acceptance waits for checkpoint capacity', async () => {
  await withPostgresTestDatabase(async database => {
    const runtime = await fixture(database);
    const coordinator = cloudToLanCoordinator({
      store: runtime.store, projectId: PROJECT_ID,
      checkpoint: runtime.capture, repository: runtime.repository,
      sourceFence: new ProjectAuthoritySourceFence(),
    });
    let releaseWriter: (() => void) | undefined;
    try {
      const begun = await beginCloudToLan(coordinator, PROJECT_ID);
      const permit = await runtime.resources.acquireGitChild({ classification: 'write', projectId: PROJECT_ID });
      releaseWriter = () => permit.release();
      let markRequested!: () => void;
      const requested = new Promise<void>(resolve => { markRequested = resolve; });
      const reserve = runtime.repository.reserveCaptureOperation.bind(runtime.repository);
      runtime.repository.reserveCaptureOperation = (...args) => {
        markRequested();
        return reserve(...args);
      };
      const accepted = acceptCloudToLan(coordinator, PROJECT_ID, begun.transferId)
        .then(value => ({ value }), (error: unknown) => ({ error }));
      await requested;
      const other = await runtime.store.acquireProjectLease('project-unrelated');
      const otherPermit = await runtime.resources.acquireGitChild({ classification: 'write', projectId: 'project-unrelated' });
      otherPermit.release();
      await other.close();
      const writer = await runtime.store.acquireProjectLease(PROJECT_ID);
      await writer.close();
      permit.release();
      const result = await accepted;
      if ('error' in result) throw result.error;
      assert.equal(result.value.phase, 'checkpoint-captured');
      assert.match(result.value.checkpointSha256 ?? '', /^[0-9a-f]{64}$/u);
      const project = await runtime.store.withProjectScope(PROJECT_ID, scope => scope.getProject());
      assert.equal(project?.serviceState, 'read-only-transition');
      assert.equal(project.authorityGeneration, 4);
    } finally {
      releaseWriter?.();
      await coordinator.close();
      await runtime.close();
    }
  });
});

for (const failedPhase of ['cloud-quiesced', 'checkpoint-captured'] as const) {
  it(`reserves capture before the Project lane when recovering a failed ${failedPhase} transition`, async () => {
    await withPostgresTestDatabase(async database => {
      const runtime = await fixture(database);
      const dependencies = {
        store: runtime.store, projectId: PROJECT_ID,
        checkpoint: runtime.capture, repository: runtime.repository,
        sourceFence: new ProjectAuthoritySourceFence(),
      };
      const first = cloudToLanCoordinator({ ...dependencies, fault: { nextPhase: failedPhase } });
      const recovery = cloudToLanCoordinator(dependencies);
      let releaseWriter: (() => void) | undefined;
      try {
        const begun = await beginCloudToLan(first, PROJECT_ID);
        await assert.rejects(acceptCloudToLan(first, PROJECT_ID, begun.transferId));
        await first.close();
        const journal = await runtime.store.withProjectScope(PROJECT_ID, scope => (
          scope.portability.getLifecycleJournal(begun.transferId)
        ));
        assert.ok(journal);
        assert.equal(journal.phase, failedPhase === 'cloud-quiesced' ? 'collecting-readiness' : 'cloud-quiesced');
        const permit = await runtime.resources.acquireGitChild({ classification: 'write', projectId: PROJECT_ID });
        releaseWriter = () => permit.release();
        let markRequested!: () => void;
        const requested = new Promise<void>(resolve => { markRequested = resolve; });
        const reserve = runtime.repository.reserveCaptureOperation.bind(runtime.repository);
        runtime.repository.reserveCaptureOperation = (...args) => {
          markRequested();
          return reserve(...args);
        };
        const reserving = recovery.reserveRecovery(PROJECT_ID, journal);
        await requested;
        const writer = await runtime.store.acquireProjectLease(PROJECT_ID);
        await writer.close();
        permit.release();
        const reservation = await reserving;
        assert.ok(reservation);
        const lease = await runtime.store.acquireProjectLease(PROJECT_ID);
        try {
          assert.equal(await recovery.recover({ journal, lease, repositoryReservation: reservation }), 'waiting-for-external-proof');
          const recovered = await lease.withProjectScope(scope => scope.portability.getLifecycleJournal(begun.transferId));
          assert.equal(recovered?.phase, 'checkpoint-captured');
          assert.match(recovered.checkpointSha256 ?? '', /^[0-9a-f]{64}$/u);
        } finally {
          await lease.close();
          await reservation.close();
        }
        const available = await runtime.capture.reserve(PROJECT_ID);
        await available.close();
      } finally {
        releaseWriter?.();
        await first.close();
        await recovery.close();
        await runtime.close();
      }
    });
  });
}
