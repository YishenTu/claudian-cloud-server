import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
  encodeCollabProjectBackupCheckpointCoordinationNdjson,
  encodeCollabProjectBackupCheckpointManifestDigestInput,
  encodeCollabProjectCheckpointCoordinationNdjson,
  encodeCollabProjectCheckpointManifestCanonicalJson,
  encodeCollabProjectCheckpointManifestDigestInput,
  type CollabCheckpointArtifactFact,
  type CollabCheckpointBackupRecord,
  type CollabCheckpointPortableRecord,
  type CollabProjectBackupRecord,
  type CollabProjectCheckpointManifest,
} from '@claudian-collab/protocol';

import {
  ProductionCheckpointStagingError,
  type PreparedProductionCheckpointAttempt,
  type ProductionCheckpointStagingErrorCode,
  type ProductionCheckpointStagingPort,
  type StagedProductionCheckpointArtifact,
} from '../../src/onboarding/production/ProductionCheckpointStaging.js';
import {
  ProjectCheckpointCoordinator,
  ProjectCheckpointCoordinatorError,
  type CapturedOutboundProjectCheckpoint,
} from '../../src/project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import {
  GitBundleImportError,
  type GitBundleImportErrorCode,
  type RepositoryCheckpointStagingPort,
  type ValidatedRepositoryCheckpoint,
} from '../../src/repositories/GitBundleImporter.js';
import type {
  CapturedRepositoryCheckpoint,
  RepositoryCheckpointCapturePort,
} from '../../src/repositories/RepositoryCheckpointAuthority.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

const CREATED_AT = '2026-08-25T00:00:00.000Z';
const EXPIRES_AT = '2026-08-26T00:00:00.000Z';
const MAIN_OID = '1'.repeat(40);
const MEMBER_OID = '2'.repeat(40);
const RAW_CLAIM = 'raw-claim-must-not-appear';
const PRIVATE_KEY = 'private-key-must-not-appear';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(
  bundle: Buffer = Buffer.from('streamed-repository-bundle-fixture'),
): Readonly<{
  attempt: PreparedProductionCheckpointAttempt;
  artifacts: Readonly<Record<string, Buffer>>;
  manifest: CollabProjectCheckpointManifest;
  records: readonly CollabCheckpointPortableRecord[];
}> {
  const records: readonly CollabCheckpointPortableRecord[] = Object.freeze([
    Object.freeze({
      kind: 'project' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        authorityGeneration: 1,
        createdAt: CREATED_AT,
        expectedMainOid: MAIN_OID,
        managerSetGeneration: 1,
        name: 'Project A',
        projectId: 'project-a',
      }),
    }),
    Object.freeze({
      kind: 'member' as const,
      recordId: 'member-manager',
      revision: 1,
      value: Object.freeze({
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Manager',
        memberId: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        projectId: 'project-a',
        role: 'manager' as const,
        status: 'active' as const,
        revokedAt: null,
        updatedAt: CREATED_AT,
      }),
    }),
  ]);
  const coordination = Buffer.from(
    encodeCollabProjectCheckpointCoordinationNdjson(
      records,
      'authority-transfer',
    ),
    'utf8',
  );
  const artifactFacts: readonly CollabCheckpointArtifactFact[] = Object.freeze([
    Object.freeze({
      byteCount: coordination.length,
      name: 'coordination.ndjson' as const,
      sha256: sha256(coordination),
    }),
    Object.freeze({
      byteCount: bundle.length,
      name: 'repository.bundle' as const,
      sha256: sha256(bundle),
    }),
  ]);
  const unsigned: CollabProjectCheckpointManifest = {
    artifacts: artifactFacts,
    coordinationFormatVersion: 1,
    createdAt: CREATED_AT,
    expectedMainOid: MAIN_OID,
    gitObjectFormat: 'sha1',
    manifestSchemaVersion: 1,
    manifestSha256: '0'.repeat(64),
    operationId: 'operation-transfer',
    profile: 'authority-transfer',
    projectId: 'project-a',
    protocolVersion: 6,
    refs: Object.freeze([
      Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
      Object.freeze({
        name: 'refs/heads/members/member-manager',
        oid: MEMBER_OID,
      }),
    ]),
    sourceAuthority: Object.freeze({ generation: 1, kind: 'lan' }),
    targetAuthority: Object.freeze({ generation: 2, kind: 'cloud' }),
  };
  const manifest: CollabProjectCheckpointManifest = Object.freeze({
    ...unsigned,
    manifestSha256: sha256(
      encodeCollabProjectCheckpointManifestDigestInput(unsigned),
    ),
  });
  const manifestBytes = Buffer.from(
    encodeCollabProjectCheckpointManifestCanonicalJson(manifest),
    'utf8',
  );
  return Object.freeze({
    artifacts: Object.freeze({
      'checkpoint.json': manifestBytes,
      'coordination.ndjson': coordination,
      'repository.bundle': bundle,
    }),
    attempt: Object.freeze({
      attemptKey: sha256('production-checkpoint\0project-a\0operation-transfer'),
      expiresAt: '2026-08-26T00:00:00.000Z',
      operationId: 'operation-transfer',
      projectId: 'project-a',
    }),
    manifest,
    records,
  });
}

function backupRecords(): readonly CollabProjectBackupRecord[] {
  const portable = fixture().records;
  return Object.freeze([
    ...portable,
    Object.freeze({
      kind: 'cloud-event-cursor' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        currentSequence: 0,
        projectId: 'project-a',
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'lifecycle-journal' as const,
      recordId: 'backup-previous',
      revision: 1,
      value: Object.freeze({
        actorMemberId: 'member-manager',
        batchRevision: null,
        batchSha256: null,
        checkpointSha256: '7'.repeat(64),
        createdAt: CREATED_AT,
        direction: null,
        expectedAuthorityGeneration: 1,
        expectedPersonalRefOid: null,
        idempotencyKey: 'backup-previous-key',
        operationId: 'backup-previous',
        operationKind: 'backup' as const,
        phase: 'completed' as const,
        projectId: 'project-a',
        recoveryFromPhase: null,
        requestFingerprint: '8'.repeat(64),
        resultSha256: '9'.repeat(64),
        scheduledAt: CREATED_AT,
        state: 'completed' as const,
        updatedAt: CREATED_AT,
      }),
    }),
    Object.freeze({
      kind: 'schema-catalog' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        coordinationSchemaVersion: 9,
        projectId: 'project-a',
        repositoryFormatVersion: 1,
      }),
    }),
    Object.freeze({
      kind: 'server-compatibility' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        maximumBuild: 'cloud-build-a',
        minimumBuild: 'cloud-build-a',
        projectId: 'project-a',
      }),
    }),
    Object.freeze({
      kind: 'authority-volume-pair' as const,
      recordId: 'project-a',
      revision: 1,
      value: Object.freeze({
        authorityId: 'authority-a',
        authorityVolumeIdentity: 'volume-a',
        projectId: 'project-a',
        restoreEpoch: 1,
      }),
    }),
  ]);
}

class MemoryStaging implements ProductionCheckpointStagingPort {
  readonly events: string[];
  readonly facts: readonly StagedProductionCheckpointArtifact[];

  constructor(
    readonly attempt: PreparedProductionCheckpointAttempt,
    readonly artifacts: Readonly<Record<string, Buffer>>,
    events: string[] = [],
  ) {
    this.events = events;
    this.facts = Object.freeze(COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.map(name => {
      const bytes = artifacts[name];
      assert.ok(bytes);
      return Object.freeze({
        attemptKey: attempt.attemptKey,
        byteCount: bytes.length,
        name,
        operationId: attempt.operationId,
        projectId: attempt.projectId,
        sha256: sha256(bytes),
      });
    }));
  }

  discardAttempt(): Promise<'removed'> {
    this.events.push('staging-discard');
    return Promise.resolve('removed');
  }

  expireAttempt(): Promise<'retained'> {
    return Promise.resolve('retained');
  }

  inspectAttempt() {
    return Promise.resolve(Object.freeze({
      artifacts: this.facts,
      attempt: this.attempt,
    }));
  }

  prepareAttempt(): Promise<PreparedProductionCheckpointAttempt> {
    return Promise.resolve(this.attempt);
  }

  async readArtifact(input: Parameters<ProductionCheckpointStagingPort['readArtifact']>[0]) {
    const bytes = this.artifacts[input.artifact.name];
    assert.ok(bytes);
    this.events.push(`read:${input.artifact.name}:start`);
    const midpoint = Math.max(1, Math.floor(bytes.length / 2));
    await input.onChunk(bytes.subarray(0, midpoint), input.signal ?? new AbortController().signal);
    await input.onChunk(bytes.subarray(midpoint), input.signal ?? new AbortController().signal);
    this.events.push(`read:${input.artifact.name}:end`);
  }

  receiveArtifact(): Promise<StagedProductionCheckpointArtifact> {
    return Promise.reject(new Error('unexpected-receive'));
  }
}

class MemoryOutboundStaging implements ProductionCheckpointStagingPort {
  readonly artifacts = new Map<string, Buffer>();
  readonly deliveries: PreparedProductionCheckpointAttempt[] = [];
  readonly facts = new Map<string, StagedProductionCheckpointArtifact>();
  readonly events: string[] = [];
  readonly attempt: PreparedProductionCheckpointAttempt;

  constructor(operationId = 'backup-one') {
    this.attempt = Object.freeze({
      attemptKey: sha256(`production-checkpoint\0project-a\0${operationId}`),
      expiresAt: EXPIRES_AT,
      operationId,
      projectId: 'project-a',
    });
  }

  discardAttempt(): Promise<'removed'> {
    this.events.push('staging-discard');
    this.artifacts.clear();
    this.facts.clear();
    return Promise.resolve('removed');
  }

  expireAttempt(): Promise<'retained'> {
    return Promise.resolve('retained');
  }

  listDueDeliveries() {
    return Promise.resolve(Object.freeze({
      deliveries: Object.freeze([...this.deliveries]),
      nextCursor: undefined,
    }));
  }

  registerDelivery(
    attempt: PreparedProductionCheckpointAttempt,
  ): Promise<'registered'> {
    this.deliveries.push(attempt);
    this.events.push('delivery-registered');
    return Promise.resolve('registered');
  }

  inspectAttempt() {
    return Promise.resolve(Object.freeze({
      artifacts: Object.freeze(COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.flatMap(
        name => {
          const fact = this.facts.get(name);
          return fact === undefined ? [] : [fact];
        },
      )),
      attempt: this.attempt,
    }));
  }

  prepareAttempt(input: Readonly<{
    readonly expiresAt: string;
    readonly operationId: string;
    readonly projectId: string;
  }>): Promise<PreparedProductionCheckpointAttempt> {
    assert.deepEqual(input, {
      expiresAt: this.attempt.expiresAt,
      operationId: this.attempt.operationId,
      projectId: this.attempt.projectId,
    });
    return Promise.resolve(this.attempt);
  }

  async readArtifact(
    input: Parameters<ProductionCheckpointStagingPort['readArtifact']>[0],
  ): Promise<void> {
    const bytes = this.artifacts.get(input.artifact.name);
    assert.ok(bytes);
    await input.onChunk(bytes, input.signal ?? new AbortController().signal);
  }

  async receiveArtifact(
    input: Parameters<ProductionCheckpointStagingPort['receiveArtifact']>[0],
  ): Promise<StagedProductionCheckpointArtifact> {
    const existing = this.artifacts.get(input.artifact);
    if (existing !== undefined) {
      if (
        existing.length !== input.expectedByteCount
        || sha256(existing) !== input.expectedSha256
      ) {
        throw new ProductionCheckpointStagingError('artifact-conflict');
      }
      const fact = this.facts.get(input.artifact);
      assert.ok(fact);
      return fact;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) {
      assert.ok(chunk instanceof Uint8Array);
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, input.expectedByteCount);
    assert.equal(sha256(bytes), input.expectedSha256);
    const fact = Object.freeze({
      attemptKey: input.attempt.attemptKey,
      byteCount: bytes.length,
      name: input.artifact,
      operationId: input.attempt.operationId,
      projectId: input.attempt.projectId,
      sha256: input.expectedSha256,
    });
    this.artifacts.set(input.artifact, bytes);
    this.facts.set(input.artifact, fact);
    this.events.push(`staged:${input.artifact}`);
    return fact;
  }
}

class MemoryRepositoryCapture implements RepositoryCheckpointCapturePort {
  readonly bundle: Buffer;
  discarded = 0;
  discardedOperations = 0;
  verified = 0;

  constructor(bundle = Buffer.from('verified-backup-bundle')) {
    this.bundle = bundle;
  }

  capture(
    input: Parameters<RepositoryCheckpointCapturePort['capture']>[0],
  ): Promise<CapturedRepositoryCheckpoint> {
    return Promise.resolve(Object.freeze({
      artifactKey: sha256(`${input.placement.projectId}\0${input.operationId}`),
      byteCount: this.bundle.length,
      objectFormat: 'sha1' as const,
      operationId: input.operationId,
      placementGeneration: input.placement.generation,
      projectId: input.placement.projectId,
      refs: input.refs,
      sha256: sha256(this.bundle),
    }));
  }

  discardCapture(): Promise<'removed'> {
    this.discarded += 1;
    return Promise.resolve('removed');
  }

  discardCaptureOperation(): Promise<'removed'> {
    this.discardedOperations += 1;
    return Promise.resolve('removed');
  }

  inventoryRefs(
    input: Parameters<RepositoryCheckpointCapturePort['inventoryRefs']>[0],
  ): Promise<readonly Readonly<{ readonly name: string; readonly oid: string }>[]> {
    return Promise.resolve(Object.freeze([
      Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
      ...input.memberIds.map(memberId => Object.freeze({
        name: `refs/heads/members/${memberId}`,
        oid: MEMBER_OID,
      })),
    ]));
  }

  async readCapture(
    input: Parameters<RepositoryCheckpointCapturePort['readCapture']>[0],
  ): Promise<void> {
    const midpoint = Math.floor(this.bundle.length / 2);
    const signal = input.signal ?? new AbortController().signal;
    await input.onChunk(this.bundle.subarray(0, midpoint), signal);
    await input.onChunk(this.bundle.subarray(midpoint), signal);
  }

  async verifyArtifact(
    _reservation: Parameters<RepositoryCheckpointCapturePort['verifyArtifact']>[0],
    input: Parameters<RepositoryCheckpointCapturePort['verifyArtifact']>[1],
  ): Promise<ValidatedRepositoryCheckpoint> {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    const bundle = Buffer.concat(chunks);
    assert.equal(bundle.length, input.expectedByteCount);
    assert.equal(sha256(bundle), input.expectedSha256);
    this.verified += 1;
    return Object.freeze({
      artifactKey: sha256(`${input.projectId}\0${input.operationId}`),
      bundleByteCount: input.expectedByteCount,
      bundleInputDisposition: 'consumed' as const,
      bundleSha256: input.expectedSha256,
      markerSha256: 'f'.repeat(64),
      objectFormat: input.objectFormat,
      operationId: input.operationId,
      projectId: input.projectId,
      refs: input.refs,
    });
  }

  reserveCaptureOperation(projectId: string) {
    return Promise.resolve(Object.freeze({
      close: () => Promise.resolve(),
      projectId,
    }));
  }
}

class ContradictoryOutboundStaging extends MemoryOutboundStaging {
  constructor(readonly contradiction: 'artifact-byte-count' | 'attempt') {
    super();
  }

  override prepareAttempt(
    input: Parameters<ProductionCheckpointStagingPort['prepareAttempt']>[0],
  ): Promise<PreparedProductionCheckpointAttempt> {
    if (this.contradiction !== 'attempt') return super.prepareAttempt(input);
    return Promise.resolve(Object.freeze({
      ...this.attempt,
      projectId: 'project-other',
    }));
  }

  override async receiveArtifact(
    input: Parameters<ProductionCheckpointStagingPort['receiveArtifact']>[0],
  ): Promise<StagedProductionCheckpointArtifact> {
    const artifact = await super.receiveArtifact(input);
    if (
      this.contradiction !== 'artifact-byte-count'
      || input.artifact !== 'coordination.ndjson'
    ) return artifact;
    return Object.freeze({
      ...artifact,
      byteCount: artifact.byteCount + 1,
    });
  }
}

class MemoryRepositoryStaging implements RepositoryCheckpointStagingPort {
  readonly events: string[];
  imported: Buffer | undefined;
  resultProjectId: string | undefined;

  constructor(events: string[] = []) {
    this.events = events;
  }

  discardCheckpoint(): Promise<'removed'> {
    this.events.push('repository-discard');
    return Promise.resolve('removed');
  }

  async importCheckpoint(
    input: Parameters<RepositoryCheckpointStagingPort['importCheckpoint']>[0],
  ): Promise<ValidatedRepositoryCheckpoint> {
    this.events.push('repository-import:start');
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    this.imported = Buffer.concat(chunks);
    this.events.push('repository-import:end');
    return Object.freeze({
      artifactKey: sha256(`${input.projectId}\0${input.operationId}`),
      bundleByteCount: input.expectedByteCount,
      bundleInputDisposition: 'consumed',
      bundleSha256: input.expectedSha256,
      markerSha256: 'f'.repeat(64),
      objectFormat: input.objectFormat,
      operationId: input.operationId,
      projectId: this.resultProjectId ?? input.projectId,
      refs: input.refs,
    });
  }
}

class FailingRepositoryReadStaging extends MemoryStaging {
  constructor(
    attempt: PreparedProductionCheckpointAttempt,
    artifacts: Readonly<Record<string, Buffer>>,
    readonly failureCode: ProductionCheckpointStagingErrorCode =
      'storage-unavailable',
    readonly failBeforeChunk = false,
  ) {
    super(attempt, artifacts);
  }

  override async readArtifact(
    input: Parameters<ProductionCheckpointStagingPort['readArtifact']>[0],
  ): Promise<void> {
    if (input.artifact.name !== 'repository.bundle') {
      return super.readArtifact(input);
    }
    const bytes = this.artifacts[input.artifact.name];
    assert.ok(bytes);
    if (!this.failBeforeChunk) {
      await input.onChunk(
        bytes.subarray(0, 1),
        input.signal ?? new AbortController().signal,
      );
    }
    throw new ProductionCheckpointStagingError(this.failureCode);
  }
}

class DelayedReplayReadStaging extends MemoryStaging {
  pumpWasAborted = false;

  override async readArtifact(
    input: Parameters<ProductionCheckpointStagingPort['readArtifact']>[0],
  ): Promise<void> {
    if (input.artifact.name !== 'repository.bundle') {
      return super.readArtifact(input);
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    this.pumpWasAborted = input.signal?.aborted === true;
    if (this.pumpWasAborted) {
      throw new ProductionCheckpointStagingError('cancelled');
    }
  }
}

class BlockingCoordinationReadStaging extends MemoryStaging {
  readonly started: Promise<void>;
  #release!: () => void;
  #started!: () => void;

  constructor(
    attempt: PreparedProductionCheckpointAttempt,
    artifacts: Readonly<Record<string, Buffer>>,
  ) {
    super(attempt, artifacts);
    this.started = new Promise(resolve => {
      this.#started = resolve;
    });
  }

  override async readArtifact(
    input: Parameters<ProductionCheckpointStagingPort['readArtifact']>[0],
  ): Promise<void> {
    if (input.artifact.name !== 'coordination.ndjson') {
      return super.readArtifact(input);
    }
    this.#started();
    await new Promise<void>(resolve => {
      this.#release = resolve;
    });
    return super.readArtifact(input);
  }

  release(): void {
    this.#release();
  }
}

class ImmediateRepositoryStaging extends MemoryRepositoryStaging {
  override importCheckpoint(
    input: Parameters<RepositoryCheckpointStagingPort['importCheckpoint']>[0],
  ): Promise<ValidatedRepositoryCheckpoint> {
    return Promise.resolve(Object.freeze({
      artifactKey: sha256(`${input.projectId}\0${input.operationId}`),
      bundleByteCount: input.expectedByteCount,
      bundleInputDisposition: 'consumed',
      bundleSha256: input.expectedSha256,
      markerSha256: 'f'.repeat(64),
      objectFormat: input.objectFormat,
      operationId: input.operationId,
      projectId: input.projectId,
      refs: input.refs,
    }));
  }
}

class ReplayRepositoryStaging extends MemoryRepositoryStaging {
  override importCheckpoint(
    input: Parameters<RepositoryCheckpointStagingPort['importCheckpoint']>[0],
  ): Promise<ValidatedRepositoryCheckpoint> {
    const replay = Object.freeze({
      artifactKey: sha256(`${input.projectId}\0${input.operationId}`),
      bundleByteCount: input.expectedByteCount,
      bundleInputDisposition: 'replayed' as const,
      bundleSha256: input.expectedSha256,
      markerSha256: 'f'.repeat(64),
      objectFormat: input.objectFormat,
      operationId: input.operationId,
      projectId: input.projectId,
      refs: input.refs,
    });
    return Promise.resolve(replay);
  }
}

class BlockingRepositoryStaging extends MemoryRepositoryStaging {
  readonly started: Promise<void>;
  #calls = 0;
  #release!: () => void;
  #started!: () => void;

  constructor() {
    super();
    this.started = new Promise(resolve => {
      this.#started = resolve;
    });
  }

  override async importCheckpoint(
    input: Parameters<RepositoryCheckpointStagingPort['importCheckpoint']>[0],
  ): Promise<ValidatedRepositoryCheckpoint> {
    this.#calls += 1;
    const result = await super.importCheckpoint(input);
    if (this.#calls !== 1) return result;
    this.#started();
    await new Promise<void>(resolve => {
      this.#release = resolve;
    });
    return result;
  }

  release(): void {
    this.#release();
  }
}

class RejectingRepositoryStaging extends MemoryRepositoryStaging {
  constructor(readonly code: GitBundleImportErrorCode) {
    super();
  }

  override importCheckpoint(): Promise<ValidatedRepositoryCheckpoint> {
    return Promise.reject(new GitBundleImportError(this.code));
  }
}

async function expectCheckpointError(
  operation: Promise<unknown>,
  code: ProjectCheckpointCoordinatorError['code'],
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ProjectCheckpointCoordinatorError);
    assert.equal(error.code, code);
    return true;
  });
}

async function captureOutboundReserved(
  coordinator: ProjectCheckpointCoordinator,
  input: Parameters<ProjectCheckpointCoordinator['captureOutbound']>[0],
) {
  const reservation = await coordinator.reserveOutbound(input.projectId);
  try {
    return await coordinator.captureOutbound(input, reservation);
  } finally {
    await reservation.close();
  }
}

async function verifyOutboundReserved(
  coordinator: ProjectCheckpointCoordinator,
  input: Parameters<ProjectCheckpointCoordinator['verifyOutboundOperation']>[0],
): Promise<void> {
  const reservation = await coordinator.reserveOutbound(input.projectId);
  try {
    await coordinator.verifyOutboundOperation(input, reservation);
  } finally {
    await reservation.close();
  }
}

async function publishOutboundReserved(
  coordinator: ProjectCheckpointCoordinator,
  checkpoint: CapturedOutboundProjectCheckpoint,
): Promise<void> {
  const reservation = await coordinator.reserveOutbound(
    checkpoint.manifest.projectId,
  );
  try {
    await coordinator.publishOutbound(checkpoint, reservation);
  } finally {
    await reservation.close();
  }
}

describe('ProjectCheckpointCoordinator', () => {
  it('captures one canonical backup and retains its immutable artifacts', async () => {
    const publication = new MemoryOutboundStaging();
    const staging = new MemoryOutboundStaging();
    const repositoryCapture = new MemoryRepositoryCapture();
    const repository = new MemoryRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({
      publication: Object.freeze({ backup: publication, export: publication }),
      repository,
      repositoryCapture,
      staging,
    });
    const records = backupRecords();
    const refs = Object.freeze([
      Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
      Object.freeze({
        name: 'refs/heads/members/member-manager',
        oid: MEMBER_OID,
      }),
    ]);
    const progress: string[] = [];

    const checkpoint = await captureOutboundReserved(coordinator, {
      createdAt: CREATED_AT,
      expectedMainOid: MAIN_OID,
      expiresAt: staging.attempt.expiresAt,
      onProgress: (phase, checkpointSha256) => {
        progress.push(`${phase}:${checkpointSha256 ?? 'pending'}`);
      },
      operationId: staging.attempt.operationId,
      placement: createRepositoryPlacementLease({
        active: true,
        generation: 3,
        projectId: 'project-a',
        repositoryStorageKey: 'repository-a',
        storageNodeId: 'node-a',
      }),
      profile: 'backup',
      projectId: 'project-a',
      records,
      refs,
      sourceAuthority: Object.freeze({ generation: 1, kind: 'cloud' }),
    });

    assert.deepEqual(checkpoint.records, records);
    assert.equal(checkpoint.manifest.profile, 'backup');
    assert.equal(checkpoint.manifest.coordinationFormatVersion, 3);
    assert.equal(checkpoint.manifest.targetAuthority, null);
    assert.equal(
      checkpoint.manifest.manifestSha256,
      sha256(encodeCollabProjectBackupCheckpointManifestDigestInput(
        checkpoint.manifest,
      )),
    );
    assert.equal(
      staging.artifacts.get('coordination.ndjson')?.toString('utf8'),
      encodeCollabProjectBackupCheckpointCoordinationNdjson(records),
    );
    const serialized = Buffer.concat([...staging.artifacts.values()])
      .toString('utf8');
    assert.equal(serialized.includes(RAW_CLAIM), false);
    assert.equal(serialized.includes(PRIVATE_KEY), false);
    assert.deepEqual(staging.events, [
      'staged:coordination.ndjson',
      'staged:repository.bundle',
      'staged:checkpoint.json',
    ]);
    assert.deepEqual(progress, [
      'coordination-captured:pending',
      'repository-captured:pending',
      `checkpoint-verified:${checkpoint.manifest.manifestSha256}`,
    ]);
    await publishOutboundReserved(coordinator, checkpoint);
    await verifyOutboundReserved(coordinator, {
      expectedCheckpointSha256: checkpoint.manifest.manifestSha256,
      expectedProfile: 'backup',
      expectedSourceAuthority: Object.freeze({
        generation: 1,
        kind: 'cloud',
      }),
      expiresAt: staging.attempt.expiresAt,
      operationId: staging.attempt.operationId,
      projectId: staging.attempt.projectId,
    });
    assert.equal(repository.imported, undefined);
    assert.deepEqual(repository.events, []);
    assert.equal(repositoryCapture.verified, 3);
    assert.equal(staging.artifacts.size, 3);
    assert.equal(publication.artifacts.size, 3);
    await coordinator.releaseOutbound(checkpoint);
    assert.equal(repositoryCapture.discarded, 1);
    assert.equal(staging.artifacts.size, 0);
    assert.equal(publication.artifacts.size, 3);
    await coordinator.close();
  });

  it('captures only portable records for export and rejects backup-only leakage', async () => {
    const staging = new MemoryOutboundStaging('export-one');
    const backupPublication = new MemoryOutboundStaging('export-one');
    const exportPublication = new MemoryOutboundStaging('export-one');
    backupPublication.artifacts.set('sentinel', Buffer.from('backup-retained'));
    const repositoryCapture = new MemoryRepositoryCapture();
    const coordinator = new ProjectCheckpointCoordinator({
      publication: Object.freeze({
        backup: backupPublication,
        export: exportPublication,
      }),
      repository: new MemoryRepositoryStaging(),
      repositoryCapture,
      staging,
    });
    const input = {
      createdAt: CREATED_AT,
      expectedMainOid: MAIN_OID,
      expiresAt: staging.attempt.expiresAt,
      onProgress: () => undefined,
      operationId: staging.attempt.operationId,
      placement: createRepositoryPlacementLease({
        active: true,
        generation: 3,
        projectId: 'project-a',
        repositoryStorageKey: 'repository-a',
        storageNodeId: 'node-a',
      }),
      profile: 'export' as const,
      projectId: 'project-a',
      refs: Object.freeze([
        Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
        Object.freeze({
          name: 'refs/heads/members/member-manager',
          oid: MEMBER_OID,
        }),
      ]),
      sourceAuthority: Object.freeze({ generation: 1, kind: 'cloud' as const }),
    };

    const checkpoint = await captureOutboundReserved(coordinator, {
      ...input,
      records: fixture().records,
    });
    assert.deepEqual(
      checkpoint.records.map(record => record.kind),
      ['project', 'member'],
    );
    await expectCheckpointError(captureOutboundReserved(coordinator, {
      ...input,
      records: backupRecords(),
    }), 'invalid-checkpoint');
    await expectCheckpointError(captureOutboundReserved(coordinator, {
      ...input,
      records: Object.freeze([...fixture().records].reverse()),
    }), 'invalid-checkpoint');
    await publishOutboundReserved(coordinator, checkpoint);
    assert.equal(exportPublication.artifacts.size, 3);
    assert.equal(backupPublication.artifacts.has('sentinel'), true);
    assert.equal(await coordinator.registerOutboundDelivery({
      expiresAt: staging.attempt.expiresAt,
      operationId: staging.attempt.operationId,
      projectId: staging.attempt.projectId,
    }), 'registered');
    assert.deepEqual(await coordinator.listDueOutboundDeliveries({
      expiredBefore: '2030-01-01T00:00:00.000Z',
      limit: 10,
    }), {
      deliveries: [staging.attempt],
      nextCursor: undefined,
    });
    assert.equal(backupPublication.events.includes('delivery-registered'), false);
    await coordinator.discardOutbound(checkpoint);
    assert.equal(exportPublication.artifacts.size, 0);
    assert.equal(backupPublication.artifacts.has('sentinel'), true);
    assert.equal(repositoryCapture.discarded, 1);
    await coordinator.close();
  });

  it('rejects immutable artifact corruption on exact outbound replay', async () => {
    const publication = new MemoryOutboundStaging();
    const staging = new MemoryOutboundStaging();
    const coordinator = new ProjectCheckpointCoordinator({
      publication: Object.freeze({ backup: publication, export: publication }),
      repository: new MemoryRepositoryStaging(),
      repositoryCapture: new MemoryRepositoryCapture(),
      staging,
    });
    const input = {
      createdAt: CREATED_AT,
      expectedMainOid: MAIN_OID,
      expiresAt: staging.attempt.expiresAt,
      onProgress: () => undefined,
      operationId: staging.attempt.operationId,
      placement: createRepositoryPlacementLease({
        active: true,
        generation: 3,
        projectId: 'project-a',
        repositoryStorageKey: 'repository-a',
        storageNodeId: 'node-a',
      }),
      profile: 'backup' as const,
      projectId: 'project-a',
      records: backupRecords(),
      refs: Object.freeze([
        Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
        Object.freeze({
          name: 'refs/heads/members/member-manager',
          oid: MEMBER_OID,
        }),
      ]),
      sourceAuthority: Object.freeze({ generation: 1, kind: 'cloud' as const }),
    };
    const checkpoint = await captureOutboundReserved(coordinator, input);
    await publishOutboundReserved(coordinator, checkpoint);
    staging.artifacts.set(
      'coordination.ndjson',
      Buffer.from('corrupt\n', 'utf8'),
    );

    await expectCheckpointError(
      captureOutboundReserved(coordinator, input),
      'invalid-checkpoint',
    );
    publication.artifacts.set(
      'coordination.ndjson',
      Buffer.from('published-corrupt\n', 'utf8'),
    );
    await expectCheckpointError(verifyOutboundReserved(coordinator, {
      expectedCheckpointSha256: checkpoint.manifest.manifestSha256,
      expectedProfile: 'backup',
      expectedSourceAuthority: input.sourceAuthority,
      expiresAt: staging.attempt.expiresAt,
      operationId: staging.attempt.operationId,
      projectId: staging.attempt.projectId,
    }), 'invalid-checkpoint');
    await coordinator.close();
  });

  it('replays an existing large published artifact without waiting for its body', async () => {
    const publication = new MemoryOutboundStaging();
    const staging = new MemoryOutboundStaging();
    const repositoryCapture = new MemoryRepositoryCapture(Buffer.alloc(
      256 * 1024,
      7,
    ));
    const coordinator = new ProjectCheckpointCoordinator({
      publication: Object.freeze({ backup: publication, export: publication }),
      repository: new MemoryRepositoryStaging(),
      repositoryCapture,
      staging,
    });
    const checkpoint = await captureOutboundReserved(coordinator, {
      createdAt: CREATED_AT,
      expectedMainOid: MAIN_OID,
      expiresAt: staging.attempt.expiresAt,
      onProgress: () => undefined,
      operationId: staging.attempt.operationId,
      placement: createRepositoryPlacementLease({
        active: true,
        generation: 3,
        projectId: 'project-a',
        repositoryStorageKey: 'repository-a',
        storageNodeId: 'node-a',
      }),
      profile: 'backup',
      projectId: 'project-a',
      records: backupRecords(),
      refs: Object.freeze([
        Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
        Object.freeze({
          name: 'refs/heads/members/member-manager',
          oid: MEMBER_OID,
        }),
      ]),
      sourceAuthority: Object.freeze({ generation: 1, kind: 'cloud' }),
    });
    await publishOutboundReserved(coordinator, checkpoint);

    const reservation = await coordinator.reserveOutbound('project-a');
    const signal = AbortSignal.timeout(100);
    try {
      await coordinator.publishOutbound(checkpoint, reservation, signal);
    } finally {
      await reservation.close();
      await coordinator.close();
    }
  });

  it('rejects contradictory outbound staging identities and artifact facts', async () => {
    for (const contradiction of ['attempt', 'artifact-byte-count'] as const) {
      const staging = new ContradictoryOutboundStaging(contradiction);
      const coordinator = new ProjectCheckpointCoordinator({
        repository: new MemoryRepositoryStaging(),
        repositoryCapture: new MemoryRepositoryCapture(),
        staging,
      });

      await expectCheckpointError(captureOutboundReserved(coordinator, {
        createdAt: CREATED_AT,
        expectedMainOid: MAIN_OID,
        expiresAt: staging.attempt.expiresAt,
        onProgress: () => undefined,
        operationId: staging.attempt.operationId,
        placement: createRepositoryPlacementLease({
          active: true,
          generation: 3,
          projectId: 'project-a',
          repositoryStorageKey: 'repository-a',
          storageNodeId: 'node-a',
        }),
        profile: 'backup',
        projectId: 'project-a',
        records: backupRecords(),
        refs: Object.freeze([
          Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
          Object.freeze({
            name: 'refs/heads/members/member-manager',
            oid: MEMBER_OID,
          }),
        ]),
        sourceAuthority: Object.freeze({ generation: 1, kind: 'cloud' }),
      }), 'invalid-checkpoint');
      await coordinator.close();
    }
  });

  it('rejects raw claims and private keys as unknown backup record fields', async () => {
    const staging = new MemoryOutboundStaging();
    const coordinator = new ProjectCheckpointCoordinator({
      repository: new MemoryRepositoryStaging(),
      repositoryCapture: new MemoryRepositoryCapture(),
      staging,
    });
    const records = backupRecords().map(record => record.kind === 'project'
      ? Object.freeze({
          ...record,
          value: Object.freeze({
            ...record.value,
            privateKey: PRIVATE_KEY,
            rawClaim: RAW_CLAIM,
          }),
        })
      : record) as unknown as readonly CollabCheckpointBackupRecord[];

    await expectCheckpointError(captureOutboundReserved(coordinator, {
      createdAt: CREATED_AT,
      expectedMainOid: MAIN_OID,
      expiresAt: staging.attempt.expiresAt,
      onProgress: () => undefined,
      operationId: staging.attempt.operationId,
      placement: createRepositoryPlacementLease({
        active: true,
        generation: 3,
        projectId: 'project-a',
        repositoryStorageKey: 'repository-a',
        storageNodeId: 'node-a',
      }),
      profile: 'backup',
      projectId: 'project-a',
      records,
      refs: Object.freeze([
        Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
        Object.freeze({
          name: 'refs/heads/members/member-manager',
          oid: MEMBER_OID,
        }),
      ]),
      sourceAuthority: Object.freeze({ generation: 1, kind: 'cloud' }),
    }), 'invalid-checkpoint');
    assert.equal(staging.artifacts.size, 0);
    await coordinator.close();
  });

  it('cleans exact outbound staging by durable operation identity', async () => {
    const publication = new MemoryOutboundStaging();
    const staging = new MemoryOutboundStaging();
    const repositoryCapture = new MemoryRepositoryCapture();
    const coordinator = new ProjectCheckpointCoordinator({
      publication: Object.freeze({ backup: publication, export: publication }),
      repository: new MemoryRepositoryStaging(),
      repositoryCapture,
      staging,
    });

    await coordinator.discardOutboundOperation({
      expiresAt: staging.attempt.expiresAt,
      operationId: staging.attempt.operationId,
      profile: 'backup',
      projectId: staging.attempt.projectId,
    });

    assert.equal(repositoryCapture.discardedOperations, 1);
    assert.deepEqual(staging.events, ['staging-discard']);
    assert.deepEqual(publication.events, ['staging-discard']);
    await coordinator.close();
  });

  it('validates one exact staged checkpoint and streams its repository bundle', async () => {
    const expected = fixture();
    const events: string[] = [];
    const staging = new MemoryStaging(
      expected.attempt,
      expected.artifacts,
      events,
    );
    const repository = new MemoryRepositoryStaging(events);
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });

    const validated = await coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    });

    assert.deepEqual(validated.manifest, expected.manifest);
    assert.deepEqual(validated.records, expected.records);
    assert.deepEqual(repository.imported, expected.artifacts['repository.bundle']);
    assert.equal(Object.isFrozen(validated), true);
    assert.equal(Object.isFrozen(validated.manifest), true);
    assert.equal(Object.isFrozen(validated.manifest.sourceAuthority), true);
    assert.equal(Object.isFrozen(validated.manifest.refs), true);
    assert.equal(Object.isFrozen(validated.manifest.refs[0]), true);
    assert.equal(Object.isFrozen(validated.records), true);
    assert.equal(Object.isFrozen(validated.records[0]), true);
    assert.equal(Object.isFrozen(validated.records[0]?.value), true);
    assert.ok(
      events.indexOf('repository-import:start')
        < events.indexOf('read:repository.bundle:end'),
    );
    await coordinator.close();
  });

  it('fails before Git import when the staged manifest contradicts authority', async () => {
    const expected = fixture();
    const staging = new MemoryStaging(expected.attempt, expected.artifacts);
    const repository = new MemoryRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });

    await expectCheckpointError(coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: Object.freeze({ generation: 2, kind: 'lan' }),
      expectedTargetAuthority: expected.manifest.targetAuthority,
    }), 'invalid-checkpoint');
    assert.deepEqual(repository.events, []);
    await coordinator.close();
  });

  it('discards repository staging before the exact received attempt', async () => {
    const expected = fixture();
    const staging = new MemoryStaging(expected.attempt, expected.artifacts);
    const repository = new MemoryRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });
    const validated = await coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    });

    await coordinator.discard(validated);
    assert.deepEqual(repository.events.slice(-1), ['repository-discard']);
    assert.deepEqual(staging.events.slice(-1), ['staging-discard']);
    await coordinator.close();
  });

  it('revalidates manifest and coordination against an already verified repository', async () => {
    const expected = fixture();
    const staging = new MemoryStaging(expected.attempt, expected.artifacts);
    const repository = new MemoryRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });
    const validated = await coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    });
    repository.events.length = 0;

    const replayed = await coordinator.validateStagedWithRepository({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    }, validated.repository);
    assert.deepEqual(replayed, validated);
    assert.deepEqual(repository.events, []);
    await coordinator.close();
  });

  it('replays exact attempt cleanup without requiring staged artifacts', async () => {
    const expected = fixture();
    const staging = new MemoryStaging(expected.attempt, expected.artifacts);
    const repository = new MemoryRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });

    await coordinator.discardAttempt(expected.attempt);
    await coordinator.discardAttempt(expected.attempt);
    assert.deepEqual(repository.events, [
      'repository-discard',
      'repository-discard',
    ]);
    assert.deepEqual(staging.events, [
      'staging-discard',
      'staging-discard',
    ]);
    await coordinator.close();
  });

  it('removes a contradictory imported repository without deleting receipt staging', async () => {
    const expected = fixture();
    const staging = new MemoryStaging(expected.attempt, expected.artifacts);
    const repository = new MemoryRepositoryStaging();
    repository.resultProjectId = 'project-other';
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });

    await expectCheckpointError(coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    }), 'invalid-checkpoint');
    assert.deepEqual(repository.events.slice(-1), ['repository-discard']);
    assert.equal(staging.events.includes('staging-discard'), false);
    await coordinator.close();
  });

  it('removes every invalid repository staging result while retaining receipts', async () => {
    const expected = fixture();
    for (const code of [
      'artifact-conflict',
      'artifact-invalid',
      'digest-mismatch',
      'repository-invalid',
      'repository-limit',
    ] as const) {
      const staging = new MemoryStaging(expected.attempt, expected.artifacts);
      const repository = new RejectingRepositoryStaging(code);
      const coordinator = new ProjectCheckpointCoordinator({
        repository,
        staging,
      });

      await expectCheckpointError(coordinator.validateStaged({
        attempt: expected.attempt,
        expectedProfile: 'authority-transfer',
        expectedSourceAuthority: expected.manifest.sourceAuthority,
        expectedTargetAuthority: expected.manifest.targetAuthority,
      }), 'invalid-checkpoint');
      assert.deepEqual(repository.events, ['repository-discard']);
      assert.equal(staging.events.includes('staging-discard'), false);
      await coordinator.close();
    }
  });

  it('classifies malformed manifest bytes as an invalid checkpoint', async () => {
    const expected = fixture();
    const malformed = Object.freeze({
      ...expected.artifacts,
      'checkpoint.json': Buffer.from('{not-json'),
    });
    const staging = new MemoryStaging(expected.attempt, malformed);
    const repository = new MemoryRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });

    await expectCheckpointError(coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    }), 'invalid-checkpoint');
    assert.deepEqual(repository.events, []);
    await coordinator.close();
  });

  it('rejects coordination above the measured deployment heap limit', async () => {
    const expected = fixture();
    const staging = new MemoryStaging(expected.attempt, expected.artifacts);
    const repository = new MemoryRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({
      maximumCoordinationBytes: 1,
      repository,
      staging,
    });

    await expectCheckpointError(coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    }), 'resource-limit');
    assert.equal(staging.events.includes('read:coordination.ndjson:start'), false);
    await coordinator.close();
  });

  it('owns the coordination heap slot before an outbound SQL snapshot starts', async () => {
    const coordinator = new ProjectCheckpointCoordinator({
      maximumConcurrentCoordinationValidations: 1,
      maximumCoordinationBytes: 1024,
      repository: new MemoryRepositoryStaging(),
      repositoryCapture: new MemoryRepositoryCapture(),
      staging: new MemoryOutboundStaging(),
    });

    const first = await coordinator.reserveOutbound('project-a');
    assert.equal(first.maximumCoordinationBytes, 1024);
    await expectCheckpointError(
      coordinator.reserveOutbound('project-b'),
      'busy',
    );
    await first.close();
    const replay = await coordinator.reserveOutbound('project-b');
    await replay.close();
    await coordinator.close();
  });

  it('bounds concurrent coordination decoding independently of Projects', async () => {
    const expected = fixture();
    const staging = new BlockingCoordinationReadStaging(
      expected.attempt,
      expected.artifacts,
    );
    const repository = new MemoryRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({
      maximumConcurrentCoordinationValidations: 1,
      repository,
      staging,
    });
    const input = {
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer' as const,
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    };

    const first = coordinator.validateStaged(input);
    await staging.started;
    await expectCheckpointError(coordinator.validateStaged(input), 'busy');
    staging.release();
    await first;
    await coordinator.close();
  });

  it('holds the coordination heap slot through repository validation', async () => {
    const expected = fixture();
    const staging = new MemoryStaging(expected.attempt, expected.artifacts);
    const repository = new BlockingRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({
      maximumConcurrentCoordinationValidations: 1,
      repository,
      staging,
    });
    const input = {
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer' as const,
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    };

    const first = coordinator.validateStaged(input);
    await repository.started;
    try {
      await expectCheckpointError(coordinator.validateStaged(input), 'busy');
    } finally {
      repository.release();
    }
    await first;
    await coordinator.close();
  });

  it('rejects a failed repository stream even when the importer returns early', async () => {
    const expected = fixture();
    const staging = new FailingRepositoryReadStaging(
      expected.attempt,
      expected.artifacts,
    );
    const repository = new ImmediateRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });

    await expectCheckpointError(coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    }), 'storage-unavailable');
    await coordinator.close();
  });

  it('accepts a verified replay without draining a backpressured bundle', async () => {
    const expected = fixture(Buffer.alloc(128 * 1024, 0x61));
    const staging = new MemoryStaging(expected.attempt, expected.artifacts);
    const repository = new ReplayRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });

    const validated = await coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    });

    assert.equal(
      validated.repository.bundleInputDisposition,
      'replayed',
    );
    assert.equal(
      staging.events.includes('read:repository.bundle:end'),
      false,
    );
    await coordinator.close();
  });

  it('accepts a verified replay after the discarded receipt stream fails', async () => {
    const expected = fixture();
    const staging = new FailingRepositoryReadStaging(
      expected.attempt,
      expected.artifacts,
      'storage-unavailable',
      true,
    );
    const repository = new ReplayRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });

    const validated = await coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    });

    assert.equal(validated.repository.bundleInputDisposition, 'replayed');
    await coordinator.close();
  });

  it('aborts a verified replay pump before delayed first delivery', async () => {
    const expected = fixture();
    const staging = new DelayedReplayReadStaging(
      expected.attempt,
      expected.artifacts,
    );
    const repository = new ReplayRepositoryStaging();
    const coordinator = new ProjectCheckpointCoordinator({ repository, staging });

    const validated = await coordinator.validateStaged({
      attempt: expected.attempt,
      expectedProfile: 'authority-transfer',
      expectedSourceAuthority: expected.manifest.sourceAuthority,
      expectedTargetAuthority: expected.manifest.targetAuthority,
    });

    assert.equal(validated.repository.bundleInputDisposition, 'replayed');
    assert.equal(staging.pumpWasAborted, true);
    await coordinator.close();
  });

  it('preserves staging conflict and timeout causes across repository consumption', async () => {
    const expected = fixture();
    for (const [code, failBeforeChunk, expectedCode, expectDiscard] of [
      ['artifact-conflict', true, 'invalid-checkpoint', true],
      ['timeout', false, 'timeout', false],
    ] as const) {
      const staging = new FailingRepositoryReadStaging(
        expected.attempt,
        expected.artifacts,
        code,
        failBeforeChunk,
      );
      const repository = new MemoryRepositoryStaging();
      const coordinator = new ProjectCheckpointCoordinator({
        repository,
        staging,
      });

      await expectCheckpointError(coordinator.validateStaged({
        attempt: expected.attempt,
        expectedProfile: 'authority-transfer',
        expectedSourceAuthority: expected.manifest.sourceAuthority,
        expectedTargetAuthority: expected.manifest.targetAuthority,
      }), expectedCode);
      assert.equal(
        repository.events.includes('repository-discard'),
        expectDiscard,
      );
      await coordinator.close();
    }
  });

  it('classifies Git infrastructure failures as retryable storage unavailability', async () => {
    const expected = fixture();
    for (const code of [
      'git-unavailable',
      'process-failed',
      'unsupported-git',
    ] as const) {
      const staging = new MemoryStaging(expected.attempt, expected.artifacts);
      const repository = new RejectingRepositoryStaging(code);
      const coordinator = new ProjectCheckpointCoordinator({
        repository,
        staging,
      });

      await expectCheckpointError(coordinator.validateStaged({
        attempt: expected.attempt,
        expectedProfile: 'authority-transfer',
        expectedSourceAuthority: expected.manifest.sourceAuthority,
        expectedTargetAuthority: expected.manifest.targetAuthority,
      }), 'storage-unavailable');
      assert.equal(repository.events.includes('repository-discard'), false);
      await coordinator.close();
    }
  });
});
