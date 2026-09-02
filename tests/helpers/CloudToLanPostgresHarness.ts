import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  decodeCollabTransferredMembershipClaimBatch,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferStatus,
} from '@claudian-collab/protocol';
import { Client } from 'pg';

import { PostgresCoordination } from '../../src/coordination/postgres/PostgresCoordination.js';
import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import {
  CloudToLanTransferCoordinator,
} from '../../src/project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';
import { XChaCha20ClaimCustody } from '../../src/project-authority/lifecycle/cloud-to-lan/XChaCha20ClaimCustody.js';
import type { PostgresTestDatabase } from './PostgresTestDatabase.js';

export const CLOUD_TO_LAN_MANAGER_ID = 'member-manager';
export const CLOUD_TO_LAN_TARGET_ID = 'member-target';
export const CLOUD_TO_LAN_OFFLINE_ID = 'member-offline';
export const CLOUD_TO_LAN_MANAGER_PRINCIPAL = 'principal:manager';
export const CLOUD_TO_LAN_TARGET_PRINCIPAL = 'principal:target';
export const CLOUD_TO_LAN_CREATED_AT = '2026-08-27T00:00:00.000Z';
export const CLOUD_TO_LAN_EXPIRES_AT = '2026-09-26T00:00:00.000Z';
export const CLOUD_TO_LAN_CHECKPOINT_SHA = '1'.repeat(64);
export const CLOUD_TO_LAN_STAGE_SHA = '2'.repeat(64);
const PUBLIC_KEY = Buffer.alloc(32, 8).toString('base64url');
const SIGNATURE = Buffer.alloc(64, 9).toString('base64url');
const GIT = '/usr/bin/git';
const execFileAsync = promisify(execFile);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function storageKey(projectId: string): string {
  return `repository_${sha256(projectId).slice(0, 20)}`;
}

function repositoryPath(root: string, projectId: string): string {
  return join(root, 'repositories', Buffer.from(projectId).toString('hex'), storageKey(
    projectId,
  ));
}

function operationPath(root: string, projectId: string, transferId: string): string {
  return join(root, 'operations', sha256(`${projectId}\0${transferId}`));
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

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  await rename(partial, path);
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function seedCloudToLanRepository(
  root: string,
  projectId: string,
): Promise<string> {
  const repository = repositoryPath(root, projectId);
  const work = await mkdtemp(join(tmpdir(), 'claudian-cloud-to-lan-work-'));
  try {
    await mkdir(dirname(repository), { recursive: true });
    await git(root, ['init', '--bare', '--initial-branch=main', repository]);
    await git(root, ['init', '--initial-branch=main', work]);
    await git(work, ['config', 'user.email', 'test@example.invalid']);
    await git(work, ['config', 'user.name', 'Test User']);
    await writeFile(join(work, 'note.md'), `# ${projectId}\n`, 'utf8');
    await git(work, ['add', 'note.md']);
    await git(work, ['commit', '-m', 'fixture']);
    const oid = await git(work, ['rev-parse', 'HEAD']);
    for (const memberId of [
      CLOUD_TO_LAN_MANAGER_ID,
      CLOUD_TO_LAN_TARGET_ID,
      CLOUD_TO_LAN_OFFLINE_ID,
    ]) {
      await git(work, ['branch', `members/${memberId}`, oid]);
    }
    await git(work, ['remote', 'add', 'origin', repository]);
    await git(work, ['push', 'origin',
      'refs/heads/main:refs/heads/main',
      ...[
        CLOUD_TO_LAN_MANAGER_ID,
        CLOUD_TO_LAN_TARGET_ID,
        CLOUD_TO_LAN_OFFLINE_ID,
      ].map(memberId => (
        `refs/heads/members/${memberId}:refs/heads/members/${memberId}`
      )),
    ]);
    return oid;
  } finally {
    await rm(work, { force: true, recursive: true });
  }
}

export async function readCloudToLanDurableEvidence(
  root: string,
  projectId: string,
  transferId: string,
): Promise<Readonly<{
  readonly checkpointExists: boolean;
  readonly fenceState: unknown;
  readonly targetState: unknown;
}>> {
  const operation = operationPath(root, projectId, transferId);
  let checkpointExists = true;
  try {
    await access(`${operation}.bundle`);
  } catch {
    checkpointExists = false;
  }
  return Object.freeze({
    checkpointExists,
    fenceState: (await readJson(`${operation}.fence.json`))?.state,
    targetState: (await readJson(`${operation}.target.json`))?.state,
  });
}

export interface CloudToLanJournalFault {
  nextPhase: string | undefined;
}

class FaultInjectingCoordination {
  readonly #coordination: PostgresCoordination;
  readonly #fault: CloudToLanJournalFault;

  constructor(
    coordination: PostgresCoordination,
    fault: CloudToLanJournalFault,
  ) {
    this.#coordination = coordination;
    this.#fault = fault;
  }

  async acquireProjectLease(
    projectId: Parameters<PostgresCoordination['acquireProjectLease']>[0],
  ): Promise<PinnedProjectLease> {
    const lease = await this.#coordination.acquireProjectLease(projectId);
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
          get: (target, property): unknown => {
            if (property === 'advanceLifecycleJournal') {
              return async (
                input: Parameters<typeof target.advanceLifecycleJournal>[0],
              ) => {
                if (this.#fault.nextPhase === input.nextPhase) {
                  this.#fault.nextPhase = undefined;
                  throw new Error('injected-journal-advance-failure');
                }
                return target.advanceLifecycleJournal(input);
              };
            }
            const value: unknown = Reflect.get(target, property);
            if (typeof value !== 'function') return value;
            return (...arguments_: readonly unknown[]): unknown => (
              Reflect.apply(value, target, arguments_)
            );
          },
        });
        const projectScope: ProjectScope = new Proxy(scope, {
          get: (target, property): unknown => {
            if (property === 'portability') return portability;
            const value: unknown = Reflect.get(target, property);
            if (typeof value !== 'function') return value;
            return (...arguments_: readonly unknown[]): unknown => (
              Reflect.apply(value, target, arguments_)
            );
          },
        });
        return operation(projectScope);
      }),
    };
  }
}

export function cloudToLanPostgres(
  database: Pick<PostgresTestDatabase, 'runtimeUrl'>,
): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 3,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

export async function seedCloudToLanProject(
  database: PostgresTestDatabase,
  projectId: string,
  expectedMainOid: string = 'a'.repeat(40),
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
         service_state, authority_generation, authority_state_revision,
         created_at, activated_at
       ) VALUES ($1, 'Cloud to LAN Fault', 1, $3, 'active', 4, 1,
                 $2::timestamptz, $2::timestamptz)`,
      [projectId, CLOUD_TO_LAN_CREATED_AT, expectedMainOid],
    );
    for (const [memberId, role] of [
      [CLOUD_TO_LAN_MANAGER_ID, 'manager'],
      [CLOUD_TO_LAN_TARGET_ID, 'member'],
      [CLOUD_TO_LAN_OFFLINE_ID, 'member'],
    ] as const) {
      await client.query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id, member_id, role, status, revision, display_name,
           created_at, updated_at, activated_at, revoked_at
         ) VALUES ($1, $2, $3, 'active', 1, $2,
                   $4::timestamptz, $4::timestamptz, $4::timestamptz, NULL)`,
        [projectId, memberId, role, CLOUD_TO_LAN_CREATED_AT],
      );
    }
    for (const [memberId, principalId] of [
      [CLOUD_TO_LAN_MANAGER_ID, CLOUD_TO_LAN_MANAGER_PRINCIPAL],
      [CLOUD_TO_LAN_TARGET_ID, CLOUD_TO_LAN_TARGET_PRINCIPAL],
    ] as const) {
      await client.query(
        `INSERT INTO claudian_cloud.project_principal_bindings (
           project_id, principal_id, member_id, state, bound_at, revoked_at
         ) VALUES ($1, $2, $3, 'active', $4::timestamptz, NULL)`,
        [projectId, principalId, memberId, CLOUD_TO_LAN_CREATED_AT],
      );
    }
    const repositoryStorageKey = storageKey(projectId);
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, 'local', $2, 7, true, $3::timestamptz, $3::timestamptz)`,
      [projectId, repositoryStorageKey, CLOUD_TO_LAN_CREATED_AT],
    );
    await client.query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id, storage_node_id, repository_storage_key, generation
       ) VALUES ($1, 'local', $2, 7)`,
      [projectId, repositoryStorageKey],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

export function cloudToLanCoordinator(input: Readonly<{
  readonly durableRoot?: string;
  readonly fault?: CloudToLanJournalFault;
  readonly projectId: string;
  readonly store: PostgresCoordination;
}>): CloudToLanTransferCoordinator {
  let tick = Date.parse(CLOUD_TO_LAN_CREATED_AT) - 1_000;
  const coordination = input.fault === undefined
    ? input.store
    : new FaultInjectingCoordination(input.store, input.fault);
  const checkpoint = input.durableRoot === undefined
    ? {
      capture: (request: Readonly<{
        readonly expiresAt: string;
        readonly operationId: string;
        readonly projectId: string;
      }>) => Promise.resolve(Object.freeze({
        checkpointSha256: CLOUD_TO_LAN_CHECKPOINT_SHA,
        expiresAt: request.expiresAt,
        operationId: request.operationId,
        projectId: request.projectId,
      })),
      discard: () => Promise.resolve<'removed' | 'replayed'>('removed'),
    }
    : {
      capture: async (request: Readonly<{
        readonly expiresAt: string;
        readonly operationId: string;
        readonly projectId: string;
      }>) => {
        const bundle = `${operationPath(
          input.durableRoot as string,
          request.projectId,
          request.operationId,
        )}.bundle`;
        const repository = repositoryPath(input.durableRoot as string, request.projectId);
        await mkdir(dirname(bundle), { recursive: true });
        try {
          await access(bundle);
        } catch {
          const partial = `${bundle}.partial`;
          await rm(partial, { force: true });
          await git(repository, [
            'bundle',
            'create',
            partial,
            'refs/heads/main',
            `refs/heads/members/${CLOUD_TO_LAN_MANAGER_ID}`,
            `refs/heads/members/${CLOUD_TO_LAN_TARGET_ID}`,
            `refs/heads/members/${CLOUD_TO_LAN_OFFLINE_ID}`,
          ]);
          await git(repository, ['bundle', 'verify', partial]);
          await rename(partial, bundle);
        }
        await git(repository, ['bundle', 'verify', bundle]);
        return Object.freeze({
          checkpointSha256: sha256(await readFile(bundle)),
          expiresAt: request.expiresAt,
          operationId: request.operationId,
          projectId: request.projectId,
        });
      },
      discard: async (captured: Readonly<{
        readonly operationId: string;
        readonly projectId: string;
      }>) => {
        const bundle = `${operationPath(
          input.durableRoot as string,
          captured.projectId,
          captured.operationId,
        )}.bundle`;
        try {
          await access(bundle);
        } catch {
          return 'replayed' as const;
        }
        await rm(bundle);
        return 'removed' as const;
      },
    };
  const sourceFence = input.durableRoot === undefined
    ? {
      quiesce: () => Promise.resolve(),
      relinquish: () => Promise.resolve(),
      reopen: () => Promise.resolve(),
    }
    : {
      quiesce: async (request: Readonly<{
        readonly expectedAuthorityGeneration: number;
        readonly projectId: string;
        readonly transferId: string;
      }>) => {
        const path = `${operationPath(
          input.durableRoot as string,
          request.projectId,
          request.transferId,
        )}.fence.json`;
        const current = await readJson(path);
        if (current?.state === 'relinquished') {
          throw new Error('cloud-to-lan-test-fence.cannot-quiesce-relinquished');
        }
        await writeDurableJson(path, {
          authorityGeneration: request.expectedAuthorityGeneration,
          state: 'quiesced',
          transferId: request.transferId,
        });
      },
      relinquish: async (request: Readonly<{
        readonly proof: CollabAuthorityRelinquishmentProof;
      }>) => {
        const path = `${operationPath(
          input.durableRoot as string,
          request.proof.projectId,
          request.proof.transferId,
        )}.fence.json`;
        const current = await readJson(path);
        if (current?.state === 'reopened') {
          throw new Error('cloud-to-lan-test-fence.cannot-relinquish-reopened');
        }
        if (current?.state !== 'relinquished') {
          await writeDurableJson(path, {
            authorityGeneration: request.proof.sourceAuthority.generation,
            state: 'relinquished',
            transferId: request.proof.transferId,
          });
        }
      },
      reopen: async (request: Readonly<{
        readonly expectedAuthorityGeneration: number;
        readonly projectId: string;
        readonly transferId: string;
      }>) => {
        const path = `${operationPath(
          input.durableRoot as string,
          request.projectId,
          request.transferId,
        )}.fence.json`;
        const current = await readJson(path);
        if (current?.state === 'relinquished') {
          throw new Error('cloud-to-lan-test-fence.cannot-reopen-relinquished');
        }
        await writeDurableJson(path, {
          authorityGeneration: request.expectedAuthorityGeneration,
          state: 'reopened',
          transferId: request.transferId,
        });
      },
    };
  const targetTrust = {
    verifyAcceptance: (request: Readonly<{
      readonly principalId: string;
      readonly request: { readonly projectId: string; readonly targetHostMemberId: string; readonly transferId: string };
      readonly targetAuthority: { readonly generation: number; readonly kind: 'lan' };
      readonly targetUrl: string;
    }>) => Promise.resolve(Object.freeze({
      principalId: request.principalId,
      projectId: request.request.projectId,
      receiptKeyId: `receipt-${sha256(input.projectId).slice(0, 16)}`,
      receiptPublicKey: PUBLIC_KEY,
      targetAuthority: request.targetAuthority,
      targetHostMemberId: request.request.targetHostMemberId,
      targetUrl: request.targetUrl,
      transferId: request.request.transferId,
    })),
    verifyStaged: async (request: Readonly<{
      readonly request: {
        readonly checkpointSha256: string;
        readonly projectId: string;
        readonly stageSha256: string;
        readonly transferId: string;
      };
    }>) => {
      if (input.durableRoot === undefined) return;
      await writeDurableJson(`${operationPath(
        input.durableRoot,
        request.request.projectId,
        request.request.transferId,
      )}.target.json`, {
        checkpointSha256: request.request.checkpointSha256,
        stageSha256: request.request.stageSha256,
        state: 'staged',
      });
    },
    verifyActivation: async (request: Readonly<{
      readonly request: {
        readonly projectId: string;
        readonly transferId: string;
      };
    }>) => {
      if (input.durableRoot === undefined) return;
      const path = `${operationPath(
        input.durableRoot,
        request.request.projectId,
        request.request.transferId,
      )}.target.json`;
      const current = await readJson(path);
      if (current?.state !== 'staged' && current?.state !== 'activated') {
        throw new Error('cloud-to-lan-test-target.not-staged');
      }
      await writeDurableJson(path, { ...current, state: 'activated' });
    },
    verifyRedemptionReceipt: () => Promise.resolve(),
    verifyCleanup: async (request: Readonly<{
      readonly proof: {
        readonly projectId: string;
        readonly transferId: string;
      };
    }>) => {
      if (input.durableRoot === undefined) return;
      const path = `${operationPath(
        input.durableRoot,
        request.proof.projectId,
        request.proof.transferId,
      )}.target.json`;
      const current = await readJson(path);
      if (current?.state !== 'staged' && current?.state !== 'invalidated') {
        throw new Error('cloud-to-lan-test-target.not-staged');
      }
      await writeDurableJson(path, { ...current, state: 'invalidated' });
    },
  };
  return new CloudToLanTransferCoordinator({
    checkpoint,
    clock: () => new Date(tick += 1_000),
    coordination,
    custody: new XChaCha20ClaimCustody({
      activeKeyId: 'claim-key-current',
      keys: [{
        key: Buffer.alloc(32, 6),
        keyId: 'claim-key-current',
        keyVersion: 1,
      }],
    }),
    custodyReceiptIdFactory: () => `custody-${sha256(input.projectId).slice(0, 16)}`,
    deletionOperationIdFactory: () => `delete-${sha256(input.projectId).slice(0, 16)}`,
    environmentIdentity: 'environment-fault-test',
    relinquishmentIntentIdFactory: () => (
      `relinquish-${sha256(input.projectId).slice(0, 16)}`
    ),
    relinquishmentSigner: {
      activeKey: Object.freeze({
        publicKey: Buffer.alloc(32, 6).toString('base64url'),
        receiptKeyId: 'receipt-key-source',
      }),
      resolveReceiptKey: () => Promise.resolve(Object.freeze({
        publicKey: Buffer.alloc(32, 6).toString('base64url'),
        receiptKeyId: 'receipt-key-source',
      })),
      sign: () => Promise.resolve(SIGNATURE),
    },
    repository: {
      reserveExactRepositoryOperation: projectId => Promise.resolve(Object.freeze({
        async close() {},
        projectId,
      })),
      verifyExactRepository: async () => {
        if (input.durableRoot !== undefined) {
          await access(repositoryPath(input.durableRoot, input.projectId));
        }
      },
    },
    sourceFence,
    targetTrust,
  });
}

export async function beginCloudToLan(
  coordinator: CloudToLanTransferCoordinator,
  projectId: string,
): Promise<CollabAuthorityTransferStatus> {
  return coordinator.begin({
    principalId: CLOUD_TO_LAN_MANAGER_PRINCIPAL,
    request: {
      expectedAuthorityGeneration: 4,
      idempotencyKey: `begin-${sha256(projectId).slice(0, 16)}`,
      projectId,
      targetHostMemberId: CLOUD_TO_LAN_TARGET_ID,
      targetUrl: 'https://lan.example.test',
    },
  });
}

export function acceptCloudToLan(
  coordinator: CloudToLanTransferCoordinator,
  projectId: string,
  transferId: string,
): Promise<CollabAuthorityTransferStatus> {
  return coordinator.acceptTarget({
    principalId: CLOUD_TO_LAN_TARGET_PRINCIPAL,
    request: {
      idempotencyKey: `accept-${sha256(projectId).slice(0, 16)}`,
      projectId,
      targetHostMemberId: CLOUD_TO_LAN_TARGET_ID,
      targetProof: Buffer.alloc(32, 1).toString('base64url'),
      transferId,
    },
  });
}

export async function stageCloudToLan(
  coordinator: CloudToLanTransferCoordinator,
  projectId: string,
  transferId: string,
) {
  const status = await coordinator.getStatus({
    principalId: CLOUD_TO_LAN_TARGET_PRINCIPAL,
    request: { projectId, transferId },
  });
  assert.ok(status.checkpointSha256);
  const checkpointSha256 = status.checkpointSha256;
  const withoutDigest = {
    batchRevision: 1,
    batchSha256: '0'.repeat(64),
    checkpointSha256,
    claims: [
      {
        claim: Buffer.alloc(32, 1).toString('base64url'),
        memberId: CLOUD_TO_LAN_MANAGER_ID,
      },
      {
        claim: Buffer.alloc(32, 2).toString('base64url'),
        memberId: CLOUD_TO_LAN_OFFLINE_ID,
      },
    ].sort((left, right) => left.memberId.localeCompare(right.memberId, 'en-US')),
    expiresAt: CLOUD_TO_LAN_EXPIRES_AT,
    projectId,
    targetAuthorityGeneration: 5,
    transferId,
  };
  const claimBatch = decodeCollabTransferredMembershipClaimBatch({
    ...withoutDigest,
    batchSha256: sha256(encodeCollabTransferredMembershipClaimBatchDigestInput(
      withoutDigest,
    )),
  });
  return coordinator.reportTargetStaged({
    principalId: CLOUD_TO_LAN_TARGET_PRINCIPAL,
    request: {
      checkpointSha256,
      claimBatch,
      idempotencyKey: `stage-${sha256(projectId).slice(0, 16)}`,
      projectId,
      stageSha256: CLOUD_TO_LAN_STAGE_SHA,
      targetAuthority: { generation: 5, kind: 'lan' },
      targetProof: Buffer.alloc(32, 2).toString('base64url'),
      transferId,
    },
  });
}

export function activateCloudToLan(
  coordinator: CloudToLanTransferCoordinator,
  projectId: string,
  transferId: string,
  proof: CollabAuthorityRelinquishmentProof,
): Promise<CollabAuthorityTransferStatus> {
  return coordinator.confirmTargetActive({
    principalId: CLOUD_TO_LAN_TARGET_PRINCIPAL,
    request: {
      idempotencyKey: `activate-${sha256(projectId).slice(0, 16)}`,
      projectId,
      relinquishmentProof: proof,
      targetActivationProof: Buffer.alloc(32, 3).toString('base64url'),
      transferId,
    },
  });
}

export async function confirmCloudToLanTargetInvalidated(
  coordinator: CloudToLanTransferCoordinator,
  store: PostgresCoordination,
  projectId: string,
  transferId: string,
): Promise<CollabAuthorityTransferStatus> {
  const facts = await store.withProjectScope(projectId, async scope => ({
    journal: await scope.portability.getLifecycleJournal(transferId),
    recovery: await scope.portability.getAuthorityTransferRecovery(transferId),
  }));
  assert.ok(facts.journal);
  assert.ok(facts.recovery);
  return coordinator.confirmTargetInvalidated({
    principalId: CLOUD_TO_LAN_TARGET_PRINCIPAL,
    request: {
      idempotencyKey: `cleanup-${sha256(projectId).slice(0, 16)}`,
      projectId,
      proof: {
        batchRevision: facts.journal.batchRevision ?? null,
        batchSha256: facts.journal.batchSha256 ?? null,
        checkpointSha256: facts.journal.checkpointSha256 ?? null,
        cleanupSha256: '7'.repeat(64),
        invalidatedAt: '2026-08-28T00:00:00.000Z',
        operationIntentId: `cleanup-${sha256(projectId).slice(0, 16)}`,
        projectId,
        receiptKeyId: `receipt-${sha256(projectId).slice(0, 16)}`,
        signature: SIGNATURE,
        signatureAlgorithm: 'ed25519',
        sourceAuthority: { generation: 4, kind: 'cloud' },
        stageSha256: facts.recovery.stageSha256 ?? null,
        targetAuthority: { generation: 5, kind: 'lan' },
        targetHostMemberId: CLOUD_TO_LAN_TARGET_ID,
        transferId,
      },
      transferId,
    },
  });
}
