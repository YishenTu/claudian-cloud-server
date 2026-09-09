import { DeletionCoordinator } from '../../src/project-authority/lifecycle/delete/DeletionCoordinator.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import type {
  CollabAuthorityRelinquishmentProof,
  CollabCheckpointBackupRecord,
  CollabProjectCheckpointManifest,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import { PostgresCoordination } from '../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { createMaintenanceAuthorityTransferRecovery } from '../../src/composition/MaintenanceAuthorityTransferRecovery.js';
import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import type { ValidatedProjectCheckpoint } from '../../src/project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import { ProjectRecoveryError } from '../../src/project-authority/admission/ProjectWriteAdmission.js';
import {
  ProjectLifecycleRecoveryDispatcher,
  type ProjectLifecycleRecoveryOwner,
} from '../../src/project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import {
  LanToCloudTransferCoordinator,
  LanToCloudTransferCoordinatorError,
  type LanToCloudSourceTrustPort,
} from '../../src/project-authority/lifecycle/lan-to-cloud/LanToCloudTransferCoordinator.js';
import {
  LanToCloudProjectActivation,
} from '../../src/project-authority/lifecycle/lan-to-cloud/LanToCloudProjectActivation.js';
import {
  GitBundleImporter,
} from '../../src/repositories/GitBundleImporter.js';
import {
  RepositoryCheckpointAuthority,
} from '../../src/repositories/RepositoryCheckpointAuthority.js';
import type {
  RepositoryPlacementLease,
  RepositoryPlacementValidator,
} from '../../src/repositories/RepositoryPlacement.js';
import { BootstrapUploadAdmission } from '../../src/resource-admission/BootstrapUploadAdmission.js';
import { ResourceAdmission } from '../../src/resource-admission/ResourceAdmission.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';
const CREATED_AT = '2026-08-26T00:00:00.000Z';
const EXPIRES_AT = '2026-09-25T00:00:00.000Z';
const TARGET_URL = 'https://cloud.example.test';
const HOST_MEMBER_ID = 'member-host';
const OFFLINE_MEMBER_ID = 'member-a';
const COLLATION_MEMBER_ID = 'member_a';
const REVOKED_MEMBER_ID = 'member-revoked';
const HOST_PRINCIPAL_ID = 'principal:host';
const SIGNATURE = Buffer.alloc(64, 7).toString('base64url');
const PUBLIC_KEY = Buffer.alloc(32, 8).toString('base64url');

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
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

class CurrentPlacement implements RepositoryPlacementValidator {
  isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class JournalAdvanceFault {
  nextPhase: string | undefined;
}

class FaultInjectingCoordination {
  constructor(
    readonly coordination: PostgresCoordination,
    readonly fault: JournalAdvanceFault,
  ) {}

  async acquireProjectLease(
    projectId: Parameters<PostgresCoordination['acquireProjectLease']>[0],
  ): Promise<PinnedProjectLease> {
    const lease = await this.coordination.acquireProjectLease(projectId);
    return {
      close: () => lease.close(),
      drainDevelopmentBootstrapUploads: attemptId => (
        lease.drainDevelopmentBootstrapUploads(attemptId)
      ),
      handoffToDevelopmentBootstrapUpload: attemptId => (
        lease.handoffToDevelopmentBootstrapUpload(attemptId)
      ),
      withProjectScope: operation => lease.withProjectScope(scope => {
        const portability = new Proxy(scope.portability, {
          get: (target, property) => {
            if (property === 'advanceLifecycleJournal') {
              return async (input: Parameters<typeof target.advanceLifecycleJournal>[0]) => {
                if (this.fault.nextPhase === input.nextPhase) {
                  this.fault.nextPhase = undefined;
                  throw new Error('injected-journal-advance-failure');
                }
                return target.advanceLifecycleJournal(input);
              };
            }
            const value: unknown = Reflect.get(target, property);
            if (typeof value !== 'function') return value;
            return (...arguments_: readonly unknown[]): unknown => {
              const result: unknown = Reflect.apply(value, target, arguments_);
              return result;
            };
          },
        });
        const projectScope: ProjectScope = new Proxy(scope, {
          get: (target, property): unknown => {
            if (property === 'portability') return portability;
            const value: unknown = Reflect.get(target, property);
            if (typeof value !== 'function') return value;
            return (...arguments_: readonly unknown[]): unknown => {
              const result: unknown = Reflect.apply(value, target, arguments_);
              return result;
            };
          },
        });
        return operation(projectScope);
      }),
    };
  }
}

function postgres(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 3,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

interface TransferFixture {
  readonly checkpoint: ValidatedProjectCheckpoint;
  readonly principalId: string;
  readonly projectId: string;
  readonly transferId: string;
}

async function importTransfer(
  root: string,
  importer: GitBundleImporter,
  projectId: string,
  transferId: string,
  managerSetGeneration = 1,
): Promise<TransferFixture> {
  const work = join(root, `work-${projectId}`);
  await git(root, ['init', '--initial-branch=main', work]);
  await git(work, ['config', 'user.email', 'test@example.invalid']);
  await git(work, ['config', 'user.name', 'Test User']);
  await writeFile(join(work, 'note.md'), `# ${projectId}\n`);
  await git(work, ['add', 'note.md']);
  await git(work, ['commit', '-m', 'fixture']);
  const oid = await git(work, ['rev-parse', 'HEAD']);
  await git(work, ['branch', `members/${HOST_MEMBER_ID}`]);
  await git(work, ['branch', `members/${OFFLINE_MEMBER_ID}`]);
  await git(work, ['branch', `members/${COLLATION_MEMBER_ID}`]);
  const bundle = join(root, `${projectId}.bundle`);
  await git(work, [
    'bundle',
    'create',
    bundle,
    'refs/heads/main',
    `refs/heads/members/${HOST_MEMBER_ID}`,
    `refs/heads/members/${OFFLINE_MEMBER_ID}`,
    `refs/heads/members/${COLLATION_MEMBER_ID}`,
  ]);
  const bundleBytes = await readFile(bundle);
  const refs = Object.freeze([
    Object.freeze({ name: 'refs/heads/main', oid }),
    Object.freeze({ name: `refs/heads/members/${HOST_MEMBER_ID}`, oid }),
    Object.freeze({ name: `refs/heads/members/${OFFLINE_MEMBER_ID}`, oid }),
    Object.freeze({ name: `refs/heads/members/${COLLATION_MEMBER_ID}`, oid }),
  ].sort((left, right) => left.name.localeCompare(right.name, 'en-US')));
  const repository = await importer.importCheckpoint({
    body: createReadStream(bundle, { highWaterMark: 11 }),
    expectedByteCount: bundleBytes.length,
    expectedSha256: sha256(bundleBytes),
    objectFormat: 'sha1',
    operationId: transferId,
    projectId,
    refs,
  });
  const manifestSha256 = sha256(`manifest:${projectId}`);
  const manifest: CollabProjectCheckpointManifest = Object.freeze({
    artifacts: Object.freeze([
      Object.freeze({ byteCount: 16, name: 'coordination.ndjson', sha256: sha256('coordination') }),
      Object.freeze({ byteCount: bundleBytes.length, name: 'repository.bundle', sha256: sha256(bundleBytes) }),
    ]),
    coordinationFormatVersion: 1,
    createdAt: CREATED_AT,
    expectedMainOid: oid,
    gitObjectFormat: 'sha1',
    manifestSchemaVersion: 1,
    manifestSha256,
    operationId: transferId,
    profile: 'authority-transfer',
    projectId,
    protocolVersion: 10,
    refs,
    sourceAuthority: Object.freeze({ generation: 1, kind: 'lan' }),
    targetAuthority: Object.freeze({ generation: 2, kind: 'cloud' }),
  });
  const records: readonly CollabCheckpointBackupRecord[] = Object.freeze([
    Object.freeze({
      kind: 'project',
      recordId: projectId,
      revision: 1,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        authorityGeneration: 1,
        createdAt: CREATED_AT,
        expectedMainOid: oid,
        managerSetGeneration,
        name: projectId,
        projectId,
      }),
    }),
    ...([HOST_MEMBER_ID, OFFLINE_MEMBER_ID, COLLATION_MEMBER_ID] as const)
      .map((memberId, index) => Object.freeze({
        kind: 'member' as const,
        recordId: memberId,
        revision: 1,
        value: Object.freeze({
          activatedAt: CREATED_AT,
          createdAt: CREATED_AT,
          displayName: memberId,
          memberId,
          personalRef: `refs/heads/members/${memberId}`,
          projectId,
          revokedAt: null,
          role: index === 0 ? 'manager' as const : 'member' as const,
          status: 'active' as const,
          updatedAt: '2026-08-26T00:02:00.000Z',
        }),
      })),
    Object.freeze({
      kind: 'member' as const,
      recordId: REVOKED_MEMBER_ID,
      revision: 3,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Revoked Member',
        memberId: REVOKED_MEMBER_ID,
        personalRef: `refs/heads/members/${REVOKED_MEMBER_ID}`,
        projectId,
        revokedAt: '2026-08-26T00:01:00.000Z',
        role: 'member' as const,
        status: 'revoked' as const,
        updatedAt: '2026-08-26T00:01:00.000Z',
      }),
    }),
    Object.freeze({
      kind: 'request' as const,
      recordId: 'request-imported',
      revision: 2,
      value: Object.freeze({
        createdAt: CREATED_AT,
        description: 'Imported request',
        firstBaseOid: oid,
        latestHeadOid: oid,
        memberId: HOST_MEMBER_ID,
        mergedOid: null,
        projectId,
        requestId: 'request-imported',
        status: 'open' as const,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'request-comment' as const,
      recordId: 'request-comment-imported',
      revision: 1,
      value: Object.freeze({
        authorMemberId: OFFLINE_MEMBER_ID,
        body: 'Imported request comment',
        commentId: 'request-comment-imported',
        createdAt: CREATED_AT,
        projectId,
        requestId: 'request-imported',
      }),
    }),
    Object.freeze({
      kind: 'ticket' as const,
      recordId: 'ticket-imported',
      revision: 2,
      value: Object.freeze({
        authorMemberId: OFFLINE_MEMBER_ID,
        body: 'Imported ticket body',
        closedAt: null,
        closedByMemberId: null,
        createdAt: CREATED_AT,
        number: 1,
        projectId,
        status: 'open' as const,
        ticketId: 'ticket-imported',
        title: 'Imported ticket',
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'ticket-comment' as const,
      recordId: 'ticket-comment-imported',
      revision: 1,
      value: Object.freeze({
        authorMemberId: HOST_MEMBER_ID,
        body: 'Imported ticket comment',
        commentId: 'ticket-comment-imported',
        createdAt: CREATED_AT,
        projectId,
        ticketId: 'ticket-imported',
      }),
    }),
    Object.freeze({
      kind: 'ticket-relation' as const,
      recordId: 'relation-imported',
      revision: 1,
      value: Object.freeze({
        acceptedAt: null,
        acceptedMergeOid: null,
        commitOid: oid,
        createdAt: CREATED_AT,
        createdByMemberId: HOST_MEMBER_ID,
        kind: 'resolves' as const,
        projectId,
        relationId: 'relation-imported',
        requestId: 'request-imported',
        state: 'pending' as const,
        ticketId: 'ticket-imported',
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'ticket-mention' as const,
      recordId: 'mention-imported',
      revision: 1,
      value: Object.freeze({
        createdAt: CREATED_AT,
        mentionedMemberId: HOST_MEMBER_ID,
        projectId,
        sourceId: 'ticket-imported',
        sourceKind: 'description' as const,
        ticketId: 'ticket-imported',
      }),
    }),
  ]);
  return {
    checkpoint: Object.freeze({
      attempt: Object.freeze({
        attemptKey: sha256(`production-checkpoint\0${projectId}\0${transferId}`),
        expiresAt: EXPIRES_AT,
        operationId: transferId,
        projectId,
      }),
      manifest,
      records,
      repository,
    }),
    principalId: HOST_PRINCIPAL_ID,
    projectId,
    transferId,
  };
}

function sourceTrust(transfer: TransferFixture): LanToCloudSourceTrustPort {
  return {
    verifyRelinquishmentProof: () => Promise.resolve(),
    verifySourceProof: () => Promise.resolve(Object.freeze({
      authorityFingerprint: 'f'.repeat(64),
      checkpointManifestSha256: transfer.checkpoint.manifest.manifestSha256,
      projectId: transfer.projectId,
      sourceAuthorityGeneration: 1,
      sourceHostMemberId: HOST_MEMBER_ID,
      targetAuthorityGeneration: 2,
      targetUrl: TARGET_URL,
      transferId: transfer.transferId,
    })),
  };
}

async function beginValidateAndPublish(
  coordinator: LanToCloudTransferCoordinator,
  transfer: TransferFixture,
): Promise<Readonly<{ batchRevision: number; batchSha256: string; checkpointSha256: string }>> {
  const batch = await beginValidateAndRotate(coordinator, transfer);
  await acknowledgeBatch(coordinator, transfer, batch);
  return batch;
}

async function beginValidateAndRotate(
  coordinator: LanToCloudTransferCoordinator,
  transfer: TransferFixture,
): Promise<Readonly<{ batchRevision: number; batchSha256: string; checkpointSha256: string }>> {
  try {
    await coordinator.begin({
    principalId: transfer.principalId,
    request: {
      checkpointManifestSha256: transfer.checkpoint.manifest.manifestSha256,
      expectedSourceAuthorityGeneration: 1,
      idempotencyKey: `begin-${transfer.transferId}`,
      projectId: transfer.projectId,
      sourceHostMemberId: HOST_MEMBER_ID,
      sourceProof: `proof-${transfer.transferId}`,
      targetUrl: TARGET_URL,
      transferId: transfer.transferId,
    },
    });
  } catch (error: unknown) {
    throw new Error('LAN-to-Cloud begin failed', { cause: error });
  }
  let validated;
  try {
    validated = await coordinator.completeCheckpoint({
    principalId: transfer.principalId,
    projectId: transfer.projectId,
    transferId: transfer.transferId,
    });
  } catch (error: unknown) {
    throw new Error('LAN-to-Cloud checkpoint validation failed', { cause: error });
  }
  assert.ok(validated.batchRevision);
  assert.ok(validated.batchSha256);
  assert.ok(validated.checkpointSha256);
  try {
    const exposed = await coordinator.rotateClaims({
      principalId: transfer.principalId,
      request: {
        expectedBatchRevision: validated.batchRevision,
        expectedBatchSha256: validated.batchSha256,
        idempotencyKey: `expose-${transfer.transferId}`,
        projectId: transfer.projectId,
        transferId: transfer.transferId,
      },
    });
    const rotated = await coordinator.rotateClaims({
      principalId: transfer.principalId,
      request: {
        expectedBatchRevision: exposed.batchRevision,
        expectedBatchSha256: exposed.batchSha256,
        idempotencyKey: `rotate-${transfer.transferId}`,
        projectId: transfer.projectId,
        transferId: transfer.transferId,
      },
    });
    assert.equal(rotated.batchRevision, 2);
    return rotated;
  } catch (error: unknown) {
    throw new Error('LAN-to-Cloud claim rotation failed', { cause: error });
  }
}

async function acknowledgeBatch(
  coordinator: LanToCloudTransferCoordinator,
  transfer: TransferFixture,
  batch: Readonly<{ batchRevision: number; batchSha256: string }>,
): Promise<void> {
  await coordinator.acknowledgeClaimBatch({
    principalId: transfer.principalId,
    request: {
      batchRevision: batch.batchRevision,
      batchSha256: batch.batchSha256,
      idempotencyKey: `ack-${transfer.transferId}`,
      operationIntentId: `ack-operation-${transfer.transferId}`,
      projectId: transfer.projectId,
      transferId: transfer.transferId,
    },
  });
}

describe('LAN-to-Cloud cross-store recovery', () => {
  it('replays publication and cleanup after PostgreSQL CAS loss with real Git', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      const root = await mkdtemp(join(tmpdir(), 'claudian-lan-cloud-recovery-'));
      const operationRoot = join(root, 'operations');
      const repositoryRoot = join(root, 'repositories');
      await Promise.all([mkdir(operationRoot), mkdir(repositoryRoot)]);
      const resourceAdmission = new ResourceAdmission({
        maxChildren: 2,
        maxChildrenPerProject: 1,
        queueMax: 2,
        queueMaxPerProject: 1,
        queueTimeoutMs: 1_000,
      });
      const uploadAdmission = new BootstrapUploadAdmission({
        maxConcurrentUploads: 1,
        maxUploadsPerAttempt: 1,
        queueMax: 2,
        queueTimeoutMs: 1_000,
        stagingFreeSpaceFloorBytes: 1,
        stagingReservationBytes: 2 * 1024 * 1024,
        stagingRoot: operationRoot,
      });
      const importer = new GitBundleImporter({
        gitExecutable: GIT,
        maximumBlobBytes: 1024 * 1024,
        maximumBundleBytes: 2 * 1024 * 1024,
        maximumExpandedTreeEntries: 100_000,
        maximumMetadataOutputBytes: 8 * 1024 * 1024,
        maximumRepositoryBytes: 2 * 1024 * 1024,
        maximumTreeEntries: 2_000,
        operationTimeoutMs: 5_000,
        resourceAdmission,
        stagingRoot: operationRoot,
        uploadAdmission,
        uploadIdleTimeoutMs: 1_000,
        uploadTotalTimeoutMs: 5_000,
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
        resourceAdmission,
        storageNodeId: 'node-a',
      });
      const coordination = postgres(database);
      const fault = new JournalAdvanceFault();
      let now = Date.parse(CREATED_AT) - 1_000;
      const claimSequences = new Map<string, number>();
      const activation = new LanToCloudProjectActivation();
      const checkpointPort = (transfer: TransferFixture) => ({
        discardAttempt: (
          attempt: ValidatedProjectCheckpoint['attempt'],
        ) => importer.discardCheckpoint(attempt).then(() => undefined),
        validateStaged: () => Promise.resolve(transfer.checkpoint),
        validateStagedWithRepository: (
          _input: unknown,
          verifiedRepository: ValidatedProjectCheckpoint['repository'],
        ) => Promise.resolve(Object.freeze({
          ...transfer.checkpoint,
          repository: verifiedRepository,
        })),
      });
      const createCoordinator = (
        transfer: TransferFixture,
        injected = false,
      ) => new LanToCloudTransferCoordinator({
        deletion: new DeletionCoordinator({ coordination, repository }),
        activation,
        checkpoint: checkpointPort(transfer),
        claimFactory: () => {
          const sequence = (claimSequences.get(transfer.transferId) ?? 0) + 1;
          claimSequences.set(transfer.transferId, sequence);
          return Buffer.from(
            `claim-${transfer.transferId}-${String(sequence)}`,
          ).toString('base64url');
        },
        clock: () => new Date(now += 1_000),
        coordination: injected
          ? new FaultInjectingCoordination(coordination, fault)
          : coordination,
        custodyReceiptIdFactory: () => `custody-${transfer.transferId}`,
        receiptIdFactory: () => `redemption-${transfer.transferId}`,
        receiptSigner: {
          activeKey: { publicKey: PUBLIC_KEY, receiptKeyId: 'receipt-key' },
          sign: () => Promise.resolve(SIGNATURE),
        },
        relinquishmentTrust: sourceTrust(transfer),
        repository,
        repositoryStorageKeyFactory: () => `repo_${transfer.projectId.replaceAll('-', '_')}`,
        staging: {
          prepareAttempt: input => Promise.resolve(Object.freeze({
            ...input,
            attemptKey: sha256(
              `production-checkpoint\0${input.projectId}\0${input.operationId}`,
            ),
          })),
        },
      });
      const maintenanceRecovery = (
        transfer: TransferFixture,
        injected = false,
      ) => {
        const unavailable: ProjectLifecycleRecoveryOwner = {
          recover: () => Promise.reject(new Error('unexpected-recovery-owner')),
        };
        const exactCoordination = injected
            ? new FaultInjectingCoordination(coordination, fault)
            : coordination;
        const authorityTransfer = createMaintenanceAuthorityTransferRecovery({
          checkpoint: checkpointPort(transfer),
          cloudToLan: {
            close: () => Promise.resolve(),
            recover: () => Promise.resolve('waiting-for-external-proof'),
            reserveRecovery: () => Promise.resolve(undefined),
          },
          repository,
        });
        const dispatcher = new ProjectLifecycleRecoveryDispatcher({
          coordination: exactCoordination,
          owners: {
            authorityTransfer: authorityTransfer.owner,
            backup: unavailable,
            deletion: unavailable,
            export: unavailable,
            leave: unavailable,
            retire: unavailable,
          },
        });
        return Object.freeze({
          close: async (): Promise<void> => {
            dispatcher.close();
            await authorityTransfer.close();
          },
          recoverAll: () => dispatcher.recoverAll(coordination),
        });
      };
      try {
        const activationTransfer = await importTransfer(
          root,
          importer,
          'project-activation-recovery',
          'transfer-activation-recovery',
          0,
        );
        const failingPublication = createCoordinator(activationTransfer, true);
        const activationBatch = await beginValidateAndRotate(
          failingPublication,
          activationTransfer,
        );
        const stagedActivationLease = await coordination.acquireProjectLease(
          activationTransfer.projectId,
        );
        try {
          const staged = await stagedActivationLease.withProjectScope(async scope => ({
            hostBinding: await scope.portability.findProjectPrincipalBinding(
              activationTransfer.principalId,
            ),
            placement: await scope.getRepositoryPlacement(),
            project: await scope.getProject(),
            recovery: await scope.portability.getAuthorityTransferRecovery(
              activationTransfer.transferId,
            ),
            request: await scope.collaboration.requests.find('request-imported'),
          }));
          assert.equal(staged.project?.serviceState, 'maintenance');
          assert.equal(staged.project.authorityGeneration, 2);
          assert.equal(staged.project.managerSetGeneration, 0);
          assert.equal(staged.request?.revision, 2);
          assert.equal(staged.placement, undefined);
          assert.equal(staged.hostBinding, undefined);
          assert.equal(
            staged.recovery?.stageSha256,
            activationTransfer.checkpoint.manifest.manifestSha256,
          );
        } finally {
          await stagedActivationLease.close();
        }
        fault.nextPhase = 'repository-published';
        await assert.rejects(
          acknowledgeBatch(
            failingPublication,
            activationTransfer,
            activationBatch,
          ),
          error => error instanceof LanToCloudTransferCoordinatorError
            && error.code === 'dependency-failed',
        );
        assert.equal(fault.nextPhase, undefined);
        const recoveryCoordinator = createCoordinator(activationTransfer);
        const recoveryState = await coordination.acquireProjectLease(
          activationTransfer.projectId,
        ).then(async lease => {
          try {
            return await lease.withProjectScope(async scope => ({
              journal: await scope.portability.getLifecycleJournal(
                activationTransfer.transferId,
              ),
              recovery: await scope.portability.getAuthorityTransferRecovery(
                activationTransfer.transferId,
              ),
              status: await scope.portability.getAuthorityTransferStatus(
                activationTransfer.transferId,
              ),
            }));
          } finally {
            await lease.close();
          }
        });
        assert.equal(recoveryState.journal?.phase, 'claims-retained');
        assert.ok(recoveryState.recovery);
        const recoveryStatus = recoveryState.status;
        assert.ok(recoveryStatus);
        assert.equal(recoveryStatus.phase, 'claims-retained');
        const batchRevision = recoveryStatus.batchRevision;
        const batchSha256 = recoveryStatus.batchSha256;
        const checkpointSha256 = recoveryStatus.checkpointSha256;
        assert.ok(batchRevision);
        assert.ok(batchSha256);
        assert.ok(checkpointSha256);
        await recoveryCoordinator.acknowledgeClaimBatch({
          principalId: activationTransfer.principalId,
          request: {
            batchRevision,
            batchSha256,
            idempotencyKey: `ack-${activationTransfer.transferId}`,
            operationIntentId: `ack-operation-${activationTransfer.transferId}`,
            projectId: activationTransfer.projectId,
            transferId: activationTransfer.transferId,
          },
        });
        const proof: CollabAuthorityRelinquishmentProof = Object.freeze({
          batchRevision,
          batchSha256,
          certificate: SIGNATURE,
          certificateAlgorithm: 'ed25519',
          checkpointSha256,
          committedAt: new Date(now += 1_000).toISOString(),
          operationIntentId: `relinquish-${activationTransfer.transferId}`,
          projectId: activationTransfer.projectId,
          sourceAuthority: Object.freeze({ generation: 1, kind: 'lan' }),
          sourceHostMemberId: HOST_MEMBER_ID,
          targetAuthority: Object.freeze({ generation: 2, kind: 'cloud' }),
          transferId: activationTransfer.transferId,
        });
        const relinquishmentRequest = {
          idempotencyKey: `relinquish-request-${activationTransfer.transferId}`,
          projectId: activationTransfer.projectId,
          proof,
          transferId: activationTransfer.transferId,
        } as const;
        fault.nextPhase = 'cloud-activated';
        await assert.rejects(createCoordinator(
          activationTransfer,
          true,
        ).commitRelinquishment({
          principalId: activationTransfer.principalId,
          request: relinquishmentRequest,
        }), error => error instanceof LanToCloudTransferCoordinatorError
          && error.code === 'dependency-failed');
        assert.equal(fault.nextPhase, undefined);
        const failedActivationLease = await coordination.acquireProjectLease(
          activationTransfer.projectId,
        );
        try {
          const failedActivation = await failedActivationLease.withProjectScope(
            async scope => ({
              journal: await scope.portability.getLifecycleJournal(
                activationTransfer.transferId,
              ),
              project: await scope.getProject(),
              request: await scope.collaboration.requests.find('request-imported'),
            }),
          );
          assert.equal(failedActivation.journal?.phase, 'source-relinquished');
          assert.equal(failedActivation.project?.serviceState, 'maintenance');
          assert.equal(failedActivation.project.managerSetGeneration, 0);
          assert.equal(failedActivation.request?.revision, 2);
        } finally {
          await failedActivationLease.close();
        }
        fault.nextPhase = 'completed';
        const failingMaintenanceRecovery = maintenanceRecovery(
          activationTransfer,
          true,
        );
        await assert.rejects(
          failingMaintenanceRecovery.recoverAll(),
          error => error instanceof ProjectRecoveryError
            && error.code === 'dependency-failed',
        );
        await failingMaintenanceRecovery.close();
        assert.equal(fault.nextPhase, undefined);
        const interruptedMaintenanceLease = await coordination.acquireProjectLease(
          activationTransfer.projectId,
        );
        try {
          assert.equal(await interruptedMaintenanceLease.withProjectScope(
            scope => scope.portability.getLifecycleJournal(
              activationTransfer.transferId,
            ).then(journal => journal?.phase),
          ), 'cloud-activated');
        } finally {
          await interruptedMaintenanceLease.close();
        }
        assert.equal(await importer.discardCheckpoint(
          activationTransfer.checkpoint.attempt,
        ), 'replayed');
        const completedMaintenanceRecovery = maintenanceRecovery(activationTransfer);
        await completedMaintenanceRecovery.recoverAll();
        await completedMaintenanceRecovery.close();
        assert.equal(
          (await coordination.listRecoveryCandidates()).candidates.some(
            candidate => candidate.operationId === activationTransfer.transferId,
          ),
          false,
        );
        await access(join(
          repositoryRoot,
          Buffer.from(activationTransfer.projectId).toString('hex'),
          `repo_${activationTransfer.projectId.replaceAll('-', '_')}`,
        ));
        const activationLease = await coordination.acquireProjectLease(
          activationTransfer.projectId,
        );
        try {
          const activated = await activationLease.withProjectScope(async scope => ({
            backup: await scope.checkpoint.readProjectCheckpointRecords({
              excludedOperationId: 'backup-after-lan-to-cloud',
              maximumCoordinationBytes: 1024 * 1024,
              metadata: {
                authorityId: 'authority-real',
                authorityVolumeIdentity: 'volume-real',
                coordinationSchemaVersion: 12,
                maximumServerBuild: 'cloud-build-real',
                minimumServerBuild: 'cloud-build-real',
                repositoryFormatVersion: 1,
                restoreEpoch: 1,
              },
              profile: 'backup',
              snapshotAt: '2026-08-27T00:00:00.000Z',
            }),
            eventReplay: await scope.readProjectEvents({
              afterSequence: 0,
              limit: 10,
            }),
            hostBinding: await scope.portability.findProjectPrincipalBinding(
              activationTransfer.principalId,
            ),
            journal: await scope.portability.getLifecycleJournal(
              activationTransfer.transferId,
            ),
            listedMembers: await scope.membership.listProjectMembers({
              actorRole: 'manager',
              now: '2026-08-27T00:00:00.000Z',
            }),
            members: await scope.listMemberships(),
            offlineBinding: await scope.portability.findProjectPrincipalBinding(
              'principal:offline',
            ),
            placement: await scope.getRepositoryPlacement(),
            project: await scope.getProject(),
            request: await scope.collaboration.requests.find('request-imported'),
            requestComments: await scope.collaboration.requests.listComments(
              'request-imported',
              { limit: 10 },
            ),
            status: await scope.portability.getAuthorityTransferStatus(
              activationTransfer.transferId,
            ),
            ticket: await scope.collaboration.tickets.find('ticket-imported'),
            ticketComments: await scope.collaboration.tickets.listComments(
              'ticket-imported',
              { limit: 10 },
            ),
            ticketHasPendingResolve: await scope.collaboration.tickets
              .hasPendingResolve('ticket-imported'),
          }));
          assert.equal(activated.project?.authorityGeneration, 2);
          assert.equal(activated.project.managerSetGeneration, 1);
          assert.equal(activated.listedMembers.managerSetGeneration, 1);
          assert.deepEqual(
            activated.listedMembers.members.map(member => member.memberId),
            [OFFLINE_MEMBER_ID, COLLATION_MEMBER_ID, HOST_MEMBER_ID],
          );
          assert.ok(activated.journal);
          const lifecycleResultSha256 = activated.journal.resultSha256;
          assert.equal(activated.journal.phase, 'completed');
          assert.equal(activated.journal.state, 'completed');
          assert.ok(activated.status);
          assert.equal(activated.status.direction, 'lan-to-cloud');
          assert.equal(activated.status.phase, 'completed');
          assert.equal(activated.status.state, 'completed');
          assert.equal(
            activated.journal.resultSha256,
            sha256(JSON.stringify(activated.status)),
          );
          assert.equal(activated.backup.some(record => (
            record.kind === 'lifecycle-journal'
              && record.value.operationId === activationTransfer.transferId
              && record.value.resultSha256 === lifecycleResultSha256
          )), true);
          assert.deepEqual(activated.backup.filter(record => (
            record.kind === 'transferred-membership-claim'
          )).map(record => ({
            batchRevision: record.value.batchRevision,
            memberId: record.value.memberId,
          })), [
            { batchRevision, memberId: COLLATION_MEMBER_ID },
            { batchRevision, memberId: OFFLINE_MEMBER_ID },
          ]);
          assert.deepEqual(
            activated.members.map(member => member.memberId).sort(),
            [
              HOST_MEMBER_ID,
              OFFLINE_MEMBER_ID,
              COLLATION_MEMBER_ID,
              REVOKED_MEMBER_ID,
            ].sort(),
          );
          assert.equal(activated.hostBinding?.memberId, HOST_MEMBER_ID);
          assert.equal(activated.offlineBinding, undefined);
          assert.equal(activated.placement?.active, true);
          assert.equal(activated.request?.revision, 2);
          assert.deepEqual(
            activated.requestComments.items.map(comment => comment.id),
            ['request-comment-imported'],
          );
          assert.equal(activated.ticket?.revision, 2);
          assert.deepEqual(
            activated.ticketComments.items.map(comment => comment.id),
            ['ticket-comment-imported'],
          );
          assert.equal(activated.ticketHasPendingResolve, true);
          assert.deepEqual(
            activated.eventReplay.events.map(event => event.kind),
            ['authority-transfer.updated'],
          );
        } finally {
          await activationLease.close();
        }
        const activeMemberships = await coordination.withProjectReadScope(
          activationTransfer.projectId,
          scope => scope.listActiveSnapshotMemberships(),
        );
        assert.deepEqual(
          [...activeMemberships]
            .sort((left, right) => left.memberId.localeCompare(
              right.memberId,
              'en-US',
            ))
            .map(member => ({
              activatedAt: member.activatedAt,
              memberId: member.memberId,
            })),
          [HOST_MEMBER_ID, OFFLINE_MEMBER_ID, COLLATION_MEMBER_ID]
            .sort((left, right) => left.localeCompare(right, 'en-US'))
            .map(memberId => ({
              activatedAt: CREATED_AT,
              memberId,
            })),
        );
        const lifecycleTimestampReader = new Client({
          connectionString: database.migrationUrl,
        });
        try {
          await lifecycleTimestampReader.connect();
          await lifecycleTimestampReader.query('BEGIN');
          await lifecycleTimestampReader.query(
            "SELECT set_config('claudian_cloud.project_id', $1, true)",
            [activationTransfer.projectId],
          );
          const lifecycleTimestamps = await lifecycleTimestampReader.query<{
            readonly activated_at: Date;
            readonly member_id: string;
            readonly revoked_at: Date | null;
          }>(
            `SELECT member_id, activated_at, revoked_at
               FROM claudian_cloud.project_memberships
              WHERE project_id = $1
              ORDER BY member_id`,
            [activationTransfer.projectId],
          );
          assert.deepEqual(
            [...lifecycleTimestamps.rows]
              .sort((left, right) => left.member_id.localeCompare(
                right.member_id,
                'en-US',
              ))
              .map(row => ({
                activatedAt: row.activated_at.toISOString(),
                memberId: row.member_id,
                revokedAt: row.revoked_at?.toISOString() ?? null,
              })),
            [
              HOST_MEMBER_ID,
              OFFLINE_MEMBER_ID,
              COLLATION_MEMBER_ID,
              REVOKED_MEMBER_ID,
            ].sort((left, right) => left.localeCompare(right, 'en-US'))
              .map(memberId => ({
              activatedAt: CREATED_AT,
              memberId,
              revokedAt: memberId === REVOKED_MEMBER_ID
                ? '2026-08-26T00:01:00.000Z'
                : null,
            })),
          );
          await lifecycleTimestampReader.query('ROLLBACK');
        } finally {
          await lifecycleTimestampReader.end();
        }

        const incompleteCompletionWriter = new Client({
          connectionString: database.migrationUrl,
        });
        try {
          await incompleteCompletionWriter.connect();
          await incompleteCompletionWriter.query('BEGIN');
          await incompleteCompletionWriter.query(
            "SELECT set_config('claudian_cloud.project_id', $1, true)",
            [activationTransfer.projectId],
          );
          const incomplete = await incompleteCompletionWriter.query(
            `UPDATE claudian_cloud.project_lifecycle_journals
                SET result_sha256 = NULL
              WHERE project_id = $1 AND operation_id = $2
                AND phase = 'completed' AND state = 'completed'`,
            [activationTransfer.projectId, activationTransfer.transferId],
          );
          assert.equal(incomplete.rowCount, 1);
          await incompleteCompletionWriter.query('COMMIT');
        } finally {
          await incompleteCompletionWriter.end();
        }
        const incompleteCompletionLease = await coordination.acquireProjectLease(
          activationTransfer.projectId,
        );
        try {
          const projected = await incompleteCompletionLease.withProjectScope(
            async scope => ({
              journal: await scope.portability.getLifecycleJournal(
                activationTransfer.transferId,
              ),
              records: await scope.checkpoint.readProjectCheckpointRecords({
                excludedOperationId: 'backup-after-incomplete-completion',
                maximumCoordinationBytes: 1024 * 1024,
                metadata: {
                  authorityId: 'authority-real',
                  authorityVolumeIdentity: 'volume-real',
                  coordinationSchemaVersion: 12,
                  maximumServerBuild: 'cloud-build-real',
                  minimumServerBuild: 'cloud-build-real',
                  repositoryFormatVersion: 1,
                  restoreEpoch: 1,
                },
                profile: 'backup',
                snapshotAt: '2026-08-27T00:00:00.000Z',
              }),
              status: await scope.portability.getAuthorityTransferStatus(
                activationTransfer.transferId,
              ),
            }),
          );
          assert.equal(projected.journal?.resultSha256, undefined);
          assert.ok(projected.status);
          assert.equal(projected.records.some(record => (
            record.kind === 'lifecycle-journal'
              && record.value.operationId === activationTransfer.transferId
              && record.value.resultSha256
                === sha256(JSON.stringify(projected.status))
          )), true);
        } finally {
          await incompleteCompletionLease.close();
        }

        const positiveGenerationTransfer = await importTransfer(
          root,
          importer,
          'project-positive-manager-generation',
          'transfer-positive-manager-generation',
          4,
        );
        const positiveGenerationCoordinator = createCoordinator(
          positiveGenerationTransfer,
        );
        const positiveGenerationBatch = await beginValidateAndPublish(
          positiveGenerationCoordinator,
          positiveGenerationTransfer,
        );
        await positiveGenerationCoordinator.commitRelinquishment({
          principalId: positiveGenerationTransfer.principalId,
          request: {
            idempotencyKey: 'relinquish-positive-manager-generation',
            projectId: positiveGenerationTransfer.projectId,
            proof: Object.freeze({
              batchRevision: positiveGenerationBatch.batchRevision,
              batchSha256: positiveGenerationBatch.batchSha256,
              certificate: SIGNATURE,
              certificateAlgorithm: 'ed25519',
              checkpointSha256: positiveGenerationBatch.checkpointSha256,
              committedAt: new Date(now += 1_000).toISOString(),
              operationIntentId: 'relinquish-positive-manager-generation',
              projectId: positiveGenerationTransfer.projectId,
              sourceAuthority: Object.freeze({ generation: 1, kind: 'lan' }),
              sourceHostMemberId: HOST_MEMBER_ID,
              targetAuthority: Object.freeze({ generation: 2, kind: 'cloud' }),
              transferId: positiveGenerationTransfer.transferId,
            }),
            transferId: positiveGenerationTransfer.transferId,
          },
        });
        const positiveGenerationLease = await coordination.acquireProjectLease(
          positiveGenerationTransfer.projectId,
        );
        try {
          const positiveGeneration = await positiveGenerationLease.withProjectScope(
            async scope => ({
              backup: await scope.checkpoint.readProjectCheckpointRecords({
                excludedOperationId: 'backup-positive-manager-generation',
                maximumCoordinationBytes: 1024 * 1024,
                metadata: {
                  authorityId: 'authority-real',
                  authorityVolumeIdentity: 'volume-real',
                  coordinationSchemaVersion: 12,
                  maximumServerBuild: 'cloud-build-real',
                  minimumServerBuild: 'cloud-build-real',
                  repositoryFormatVersion: 1,
                  restoreEpoch: 1,
                },
                profile: 'backup',
                snapshotAt: '2026-08-27T00:00:00.000Z',
              }),
              listedMembers: await scope.membership.listProjectMembers({
                actorRole: 'manager',
                now: '2026-08-27T00:00:00.000Z',
              }),
              project: await scope.getProject(),
            }),
          );
          assert.equal(positiveGeneration.project?.managerSetGeneration, 4);
          assert.equal(positiveGeneration.listedMembers.managerSetGeneration, 4);
          assert.equal(
            positiveGeneration.backup.find(record => record.kind === 'project')
              ?.value.managerSetGeneration,
            4,
          );
        } finally {
          await positiveGenerationLease.close();
        }

        const cancellationTransfer = await importTransfer(
          root,
          importer,
          'project-cancellation-recovery',
          'transfer-cancellation-recovery',
        );
        let publishedBatch;
        try {
          publishedBatch = await beginValidateAndPublish(
            createCoordinator(cancellationTransfer),
            cancellationTransfer,
          );
        } catch (error: unknown) {
          throw new Error('LAN-to-Cloud cancellation setup failed', { cause: error });
        }
        const stagedCancellationLease = await coordination.acquireProjectLease(
          cancellationTransfer.projectId,
        );
        try {
          assert.equal(await stagedCancellationLease.withProjectScope(
            scope => scope.getProject().then(project => project?.serviceState),
          ), 'maintenance');
        } finally {
          await stagedCancellationLease.close();
        }
        fault.nextPhase = 'target-cleaned';
        const failingCleanup = createCoordinator(cancellationTransfer, true);
        await assert.rejects(failingCleanup.cancel({
          principalId: cancellationTransfer.principalId,
          request: {
            expectedPhase: 'repository-published',
            idempotencyKey: `cancel-${cancellationTransfer.transferId}`,
            projectId: cancellationTransfer.projectId,
            transferId: cancellationTransfer.transferId,
          },
        }), error => error instanceof LanToCloudTransferCoordinatorError
          && error.code === 'dependency-failed');
        const cleanupRecovery = createCoordinator(cancellationTransfer);
        let cleanedStatus;
        try {
          cleanedStatus = await cleanupRecovery.cancel({
            principalId: cancellationTransfer.principalId,
            request: {
              expectedPhase: 'repository-published',
              idempotencyKey: `cancel-${cancellationTransfer.transferId}`,
              projectId: cancellationTransfer.projectId,
              transferId: cancellationTransfer.transferId,
            },
          });
        } catch (error: unknown) {
          throw new Error('LAN-to-Cloud cancellation replay failed', { cause: error });
        }
        assert.equal(cleanedStatus.phase, 'target-cleaned');
        await assert.rejects(access(join(
          repositoryRoot,
          Buffer.from(cancellationTransfer.projectId).toString('hex'),
          `repo_${cancellationTransfer.projectId.replaceAll('-', '_')}`,
        )), { code: 'ENOENT' });
        const claim = Buffer.from(
          `claim-${cancellationTransfer.transferId}-2`,
        ).toString('base64url');
        const lease = await coordination.acquireProjectLease(cancellationTransfer.projectId);
        try {
          const cleaned = await lease.withProjectScope(async scope => ({
            claim: await scope.portability.findTransferredMembershipClaimBySha256(
              cancellationTransfer.transferId,
              sha256(claim),
            ),
            project: await scope.getProject(),
          }));
          assert.equal(cleaned.claim, undefined);
          assert.equal(cleaned.project, undefined);
        } finally {
          await lease.close();
        }
        assert.ok(publishedBatch.batchSha256.length > 0);
      } finally {
        await Promise.allSettled([
          repository.close(),
          importer.close(),
          resourceAdmission.close(),
          uploadAdmission.close(),
          coordination.close(),
        ]);
        await rm(root, { recursive: true });
      }
    });
  });
});
