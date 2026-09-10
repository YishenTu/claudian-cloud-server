import { SafeLogger } from '../../src/observability/SafeLogger.js';
import { ProjectRecoveryCoordinator } from '../../src/project-authority/recovery/ProjectRecoveryCoordinator.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { createProductionCloudLifecycleRuntime } from '../../src/composition/ProductionCloudLifecycleRuntime.js';
import { decodeClaimCustodyKeyring } from '../../src/config/ClaimCustodyKeyringConfig.js';
import type { ProjectLifecycleJournalRecord } from '../../src/coordination/PortabilityLifecyclePersistence.js';
import { ProjectRecoveryError } from '../../src/project-authority/admission/ProjectWriteAdmission.js';

const CREATED_AT = '2026-09-03T00:00:00.000Z';

function journal(kind: 'backup' | 'export'): ProjectLifecycleJournalRecord {
  return Object.freeze({
    actorMemberId: 'member-runtime-manager',
    batchRevision: undefined,
    batchSha256: undefined,
    checkpointSha256: undefined,
    createdAt: CREATED_AT,
    direction: undefined,
    expectedAuthorityGeneration: 1,
    idempotencyKey: `intent-runtime-${kind}`,
    kind,
    operationId: `operation-runtime-${kind}`,
    phase: 'prepared',
    projectId: 'project-runtime-maintenance',
    recoveryFromPhase: undefined,
    requestFingerprint: '1'.repeat(64),
    resultSha256: undefined,
    scheduledAt: CREATED_AT,
    state: 'active',
    updatedAt: CREATED_AT,
  });
}

function keyring() {
  const pair = generateKeyPairSync('ed25519');
  return decodeClaimCustodyKeyring({
    activeEncryptionKeyId: 'encryption-runtime-key',
    activeReceiptKeyId: 'receipt-runtime-key',
    encryptionKeys: [{
      key: Buffer.alloc(32, 1).toString('base64url'),
      keyId: 'encryption-runtime-key',
      keyVersion: 1,
    }],
    receiptKeys: [{
      keyId: 'receipt-runtime-key',
      keyVersion: 1,
      privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' })
        .toString('base64url'),
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' })
        .toString('base64url'),
    }],
    schemaVersion: 1,
  });
}

describe('production Cloud lifecycle runtime', () => {
  it('keeps serving reconciliation available while ordinary recovery candidates remain pending', async () => {
    const runtime = createProductionCloudLifecycleRuntime({
      config: {
        checkpointAdmission: {
          maxConcurrentStreams: 2,
          maxConcurrentStreamsPerProject: 1,
          maxStagingAttempts: 2,
          maxStagingAttemptsPerProject: 1,
          queueMax: 2,
          queueMaxPerProject: 1,
        },
        developmentBootstrap: {
          stagingFreeSpaceFloorBytes: 1_073_741_824,
          stagingRoot: '/tmp/claudian-runtime-test-staging',
          uploadDeadlineMs: 900_000,
          uploadIdleTimeoutMs: 30_000,
        },
        gitAdmission: { queueTimeoutMs: 1_000 },
        repository: { root: '/tmp/claudian-runtime-test-repositories' },
      } as never,
      coordination: {
        acquireProjectLease: () => Promise.reject(new Error('ordinary-recovery-entered-lifecycle')),
        listRecoveryCandidates: () => Promise.resolve({
          candidates: (['accept', 'activation', 'create-project', 'join-project'] as const)
            .map(kind => ({
              kind,
              operationId: `operation-runtime-${kind}`,
              projectId: `project-runtime-${kind}`,
              scheduledAt: CREATED_AT,
            })),
          nextCursor: undefined,
        }),
        listTerminalResponders: () => Promise.resolve({ nextCursor: undefined, responders: [] }),
      } as never,
      importer: {} as never,
      keyring: keyring(),
      logger: new SafeLogger({ now: () => new Date(0), write: () => undefined }),
      leave: {} as never,
      removal: {} as never,
      repository: {} as never,
    });
    try {
      await runtime.reconcileAll();
      await runtime.reconcileAll();
    } finally {
      await runtime.close(1_000);
    }
  });

  it('keeps readiness closed on offline-only backup and export recovery', async () => {
    for (const kind of ['backup', 'export'] as const) {
      const record = journal(kind);
      const runtime = createProductionCloudLifecycleRuntime({
        config: {
          checkpointAdmission: {
            maxConcurrentStreams: 2,
            maxConcurrentStreamsPerProject: 1,
            maxStagingAttempts: 2,
            maxStagingAttemptsPerProject: 1,
            queueMax: 2,
            queueMaxPerProject: 1,
          },
          developmentBootstrap: {
            maxBundleBytes: 1_073_741_824,
            stagingFreeSpaceFloorBytes: 1_073_741_824,
            stagingReservationBytes: 2_147_483_648,
            stagingRoot: '/tmp/claudian-runtime-test-staging',
            uploadDeadlineMs: 900_000,
            uploadIdleTimeoutMs: 30_000,
          },
          gitAdmission: { queueTimeoutMs: 1_000 },
          repository: { root: '/tmp/claudian-runtime-test-repositories' },
        } as never,
        coordination: {
          acquireProjectLease: () => Promise.resolve({
            close: () => Promise.resolve(),
            withProjectScope: (operation: (scope: never) => Promise<unknown>) => (
              operation({
                portability: {
                  getLifecycleJournal: () => Promise.resolve(record),
                },
              } as never)
            ),
          }),
          listRecoveryCandidates: () => Promise.resolve({
            candidates: [{
              kind,
              operationId: record.operationId,
              projectId: record.projectId,
              scheduledAt: record.scheduledAt,
            }],
            nextCursor: undefined,
          }),
          listTerminalResponders: () => Promise.resolve({
            nextCursor: undefined,
            responders: [],
          }),
        } as never,
        importer: {} as never,
        keyring: keyring(),
      logger: new SafeLogger({ now: () => new Date(0), write: () => undefined }),
        leave: {} as never,
        removal: {} as never,
        repository: {} as never,
      });

      const recovery = new ProjectRecoveryCoordinator({
        accept: { recoverProject: () => Promise.resolve() },
        activation: { recoverProject: () => Promise.resolve() },
        catalog: { listRecoveryCandidates: () => Promise.resolve({
          candidates: [{ kind, operationId: record.operationId,
            projectId: record.projectId, scheduledAt: record.scheduledAt }],
          nextCursor: undefined,
        }) },
        isolation: { acquireProjectLease: () => Promise.reject(new Error('unexpected')) },
        lifecycle: runtime.recovery,
      });
      await assert.rejects(recovery.recoverAll(), error => {
        assert.ok(error instanceof ProjectRecoveryError);
        assert.equal(error.code, 'dependency-failed');
        return true;
      });
      assert.deepEqual(await recovery.recoverAvailable(), {
        settled: 0, isolated: 0, waiting: 0, offline: 1,
      });
      recovery.close();
      await runtime.close(1_000);
    }
  });
});
