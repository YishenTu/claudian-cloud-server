import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
  encodeCollabProjectCheckpointCoordinationNdjson,
  encodeCollabProjectCheckpointManifestCanonicalJson,
  encodeCollabProjectCheckpointManifestDigestInput,
  type CollabCheckpointArtifactFact,
  type CollabCheckpointBackupRecord,
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
} from '../../src/project-authority/checkpoint/ProjectCheckpointCoordinator.js';
import {
  GitBundleImportError,
  type GitBundleImportErrorCode,
  type RepositoryCheckpointStagingPort,
  type ValidatedRepositoryCheckpoint,
} from '../../src/repositories/GitBundleImporter.js';

const CREATED_AT = '2026-08-25T00:00:00.000Z';
const MAIN_OID = '1'.repeat(40);
const MEMBER_OID = '2'.repeat(40);

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(
  bundle: Buffer = Buffer.from('streamed-repository-bundle-fixture'),
): Readonly<{
  attempt: PreparedProductionCheckpointAttempt;
  artifacts: Readonly<Record<string, Buffer>>;
  manifest: CollabProjectCheckpointManifest;
  records: readonly CollabCheckpointBackupRecord[];
}> {
  const records: readonly CollabCheckpointBackupRecord[] = Object.freeze([
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

describe('ProjectCheckpointCoordinator', () => {
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
