import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabMemberRef,
  decodeDevelopmentBootstrapManifest,
  encodeDevelopmentBootstrapManifestCanonicalJson,
  type DevelopmentBootstrapActivationResult,
  type DevelopmentBootstrapManifest,
  type DevelopmentBootstrapReport,
} from '@claudian-collab/protocol';

import type {
  DevelopmentBootstrapAttemptRecord,
  DevelopmentBootstrapAttemptTransition,
  DevelopmentBootstrapReportInput,
  DevelopmentBootstrapUploadInput,
} from '../../src/coordination/DevelopmentBootstrapPersistence.js';
import {
  DevelopmentBootstrapProfile,
  DevelopmentBootstrapProfileError,
  type DevelopmentBootstrapProfilePersistence,
  type DevelopmentBootstrapProfileScope,
  type DevelopmentBootstrapSettlementPort,
} from '../../src/onboarding/development/DevelopmentBootstrapProfile.js';
import {
  createDevelopmentPrincipal,
  type RequestPrincipal,
} from '../../src/request-context/RequestPrincipal.js';
import { DevelopmentBootstrapUploadGate } from '../../src/project-authority/lifecycle/DevelopmentBootstrapUploadGate.js';
import type {
  ImportGitBundleInput,
  ValidatedBootstrapRepository,
} from '../../src/repositories/GitBundleImporter.js';

const NOW = '2026-08-21T01:00:00.000Z';
const MANIFEST_TIME = '2026-08-21T00:00:00.000Z';
const STOPPED_TIME = '2026-08-21T00:30:00.000Z';
const MAIN_OID = '1'.repeat(40);
const MEMBER_ONE_OID = '2'.repeat(40);
const MEMBER_TWO_OID = '3'.repeat(40);
const BUNDLE_SHA256 = 'a'.repeat(64);

function principal(actorId: 'member_1' | 'member_2' | 'member_3'): RequestPrincipal {
  return createDevelopmentPrincipal(actorId);
}

function comparison(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    mainOid: MAIN_OID,
    mainRef: COLLAB_MAIN_REF,
    managerSetGeneration: 4,
    members: [{
      activatedAt: MANIFEST_TIME,
      createdAt: MANIFEST_TIME,
      displayName: 'Alice',
      memberId: 'member_1',
      personalRef: collabMemberRef('member_1'),
      role: 'manager',
      status: 'active',
    }, {
      activatedAt: MANIFEST_TIME,
      createdAt: MANIFEST_TIME,
      displayName: 'Bob',
      memberId: 'member_2',
      personalRef: collabMemberRef('member_2'),
      role: 'member',
      status: 'active',
    }],
    projectCreatedAt: MANIFEST_TIME,
    projectId: 'project_1',
    projectName: 'Private project',
    sourceCaFingerprint: 'b'.repeat(64),
    sourceEventSequence: 9,
    sourceHostMemberId: 'member_1',
    ...overrides,
  };
}

function manifest(overrides: Readonly<Record<string, unknown>> = {}): DevelopmentBootstrapManifest {
  return decodeDevelopmentBootstrapManifest({
    attemptId: 'attempt_1',
    comparison: comparison(),
    createdAt: MANIFEST_TIME,
    git: {
      bundle: { byteCount: 12, sha256: BUNDLE_SHA256 },
      objectFormat: 'sha1',
      refs: [{ name: COLLAB_MAIN_REF, oid: MAIN_OID }, {
        name: collabMemberRef('member_1'),
        oid: MEMBER_ONE_OID,
      }, {
        name: collabMemberRef('member_2'),
        oid: MEMBER_TWO_OID,
      }],
    },
    manifestSchemaVersion: 1,
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sourceEligibility: {
      liveInvitations: 0,
      nonActiveMemberships: 0,
      nonterminalAcceptOperations: 0,
      nonterminalHostTransfers: 0,
      nonterminalManagerOffers: 0,
      requestComments: 0,
      requests: 0,
      terminalProjectTransitions: 0,
      ticketComments: 0,
      ticketMentions: 0,
      ticketRelations: 0,
      tickets: 0,
    },
    ...overrides,
  });
}

function readiness() {
  return {
    cleanupSettled: true,
    collabGitChildrenDrained: true,
    conflictRecoverySettled: true,
    hostTransferSettled: true,
    joinSettled: true,
    leaveSettled: true,
    managerResponsibilitySettled: true,
    projectOperationQueueDrained: true,
    projectSetupSettled: true,
    projectWorkSessionClosed: true,
    publishSettled: true,
    reconciliationSettled: true,
    reconnectSettled: true,
    repositoryIdentityExact: true,
    retirementSettled: true,
  } as const;
}

function manifestSha256(value: DevelopmentBootstrapManifest): string {
  return createHash('sha256')
    .update(encodeDevelopmentBootstrapManifestCanonicalJson(value), 'utf8')
    .digest('hex');
}

function report(
  source: DevelopmentBootstrapManifest,
  reporterMemberId: 'member_1' | 'member_2',
  overrides: Readonly<Record<string, unknown>> = {},
): DevelopmentBootstrapReport {
  return {
    attemptId: source.attemptId,
    capturedAt: NOW,
    clientReadiness: readiness(),
    comparison: source.comparison,
    observedPersonalRefOid: reporterMemberId === 'member_1'
      ? MEMBER_ONE_OID
      : MEMBER_TWO_OID,
    reporterMemberId,
    ...(reporterMemberId === 'member_1' ? {
      hostStopAttestation: {
        attemptId: source.attemptId,
        autoStartDisabled: true,
        fenceDurable: true,
        fenceId: 'fence_1',
        hostStopped: true,
        manifestSha256: manifestSha256(source),
        projectId: source.comparison.projectId,
        resourcesDrained: true,
        routeUnregistered: true,
        stoppedAt: STOPPED_TIME,
      },
    } : {}),
    ...overrides,
  } as DevelopmentBootstrapReport;
}

class MemoryPersistence
implements DevelopmentBootstrapProfilePersistence, DevelopmentBootstrapProfileScope {
  activeProject = false;
  attempt: DevelopmentBootstrapAttemptRecord | undefined;
  readonly uploadLeaseEvents: string[] = [];

  acquireProjectLease(): Promise<{
    close(): Promise<void>;
    handoffToDevelopmentBootstrapUpload(attemptId: string): Promise<{
      close(): Promise<void>;
    }>;
    withProjectScope<T>(
      operation: (scope: DevelopmentBootstrapProfileScope) => Promise<T>,
    ): Promise<T>;
  }> {
    return Promise.resolve({
      close: () => Promise.resolve(),
      handoffToDevelopmentBootstrapUpload: attemptId => {
        this.uploadLeaseEvents.push(`acquired:${attemptId}`);
        return Promise.resolve({
          close: () => {
            this.uploadLeaseEvents.push(`released:${attemptId}`);
            return Promise.resolve();
          },
        });
      },
      withProjectScope: operation => operation(this),
    });
  }

  findDevelopmentBootstrapProject(attemptId: string): Promise<string | undefined> {
    return Promise.resolve(this.attempt?.attemptId === attemptId
      ? this.attempt.projectId
      : undefined);
  }

  getDevelopmentBootstrapAttempt(): Promise<DevelopmentBootstrapAttemptRecord | undefined> {
    return Promise.resolve(this.attempt);
  }

  getActiveDevelopmentBootstrapAttempt(): Promise<
    DevelopmentBootstrapAttemptRecord | undefined
  > {
    return Promise.resolve(
      this.attempt !== undefined
        && ['collecting', 'validating', 'ready', 'activating', 'recovery-required']
          .includes(this.attempt.state)
        ? this.attempt
        : undefined,
    );
  }

  getProject(): Promise<undefined | Readonly<{
    activatedAt: string;
    authorityGeneration: number;
    authorityStateRevision: number;
    createdAt: string;
    expectedMainOid: string;
    managerSetGeneration: number;
    projectId: string;
    projectName: string;
    serviceState: 'active';
  }>> {
    return Promise.resolve(this.activeProject ? {
      activatedAt: NOW,
      authorityGeneration: 1,
      authorityStateRevision: 1,
      createdAt: NOW,
      expectedMainOid: MAIN_OID,
      managerSetGeneration: 1,
      projectId: 'project_1',
      projectName: 'Private project',
      serviceState: 'active',
    } : undefined);
  }

  putDevelopmentBootstrapAttempt(input: {
    readonly attemptId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly manifestJson: string;
    readonly manifestSha256: string;
    readonly projectId: string;
    readonly sourceHostMemberId: string;
  }): Promise<'created' | 'replayed'> {
    if (this.attempt !== undefined) return Promise.resolve('replayed');
    this.attempt = Object.freeze({
      attemptId: input.attemptId,
      bundleState: 'missing',
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      manifestJson: input.manifestJson,
      manifestSha256: input.manifestSha256,
      projectId: input.projectId,
      reports: Object.freeze([]),
      settlement: undefined,
      sourceHostMemberId: input.sourceHostMemberId,
      state: 'collecting',
      updatedAt: input.createdAt,
      upload: undefined,
    });
    return Promise.resolve('created');
  }

  putDevelopmentBootstrapReport(
    input: DevelopmentBootstrapReportInput,
  ): Promise<'created' | 'replayed'> {
    const attempt = this.requireAttempt();
    if (attempt.reports.some(item => item.reporterMemberId === input.reporterMemberId)) {
      return Promise.resolve('replayed');
    }
    this.attempt = Object.freeze({
      ...attempt,
      reports: Object.freeze([...attempt.reports, Object.freeze({
        capturedAt: input.capturedAt,
        createdAt: input.createdAt,
        reportJson: input.reportJson,
        reportSha256: input.reportSha256,
        reporterMemberId: input.reporterMemberId,
      })].sort((left, right) => left.reporterMemberId.localeCompare(
        right.reporterMemberId,
        'en-US',
      ))),
    });
    return Promise.resolve('created');
  }

  putDevelopmentBootstrapUpload(
    input: DevelopmentBootstrapUploadInput,
  ): Promise<'created' | 'replayed'> {
    const attempt = this.requireAttempt();
    if (attempt.upload !== undefined) return Promise.resolve('replayed');
    this.attempt = Object.freeze({
      ...attempt,
      bundleState: 'uploaded',
      upload: Object.freeze({
        byteCount: input.byteCount,
        createdAt: input.createdAt,
        sha256: input.sha256,
        stagingArtifactKey: input.stagingArtifactKey,
        state: 'uploaded',
        updatedAt: input.createdAt,
        validationMarkerSha256: input.validationMarkerSha256,
      }),
    });
    return Promise.resolve('created');
  }

  transitionDevelopmentBootstrapAttempt(
    input: DevelopmentBootstrapAttemptTransition,
  ): Promise<'advanced' | 'replayed'> {
    const attempt = this.requireAttempt();
    if (
      attempt.state === input.nextState
      && attempt.bundleState === input.nextBundleState
    ) return Promise.resolve('replayed');
    assert.equal(attempt.state, input.expectedState);
    assert.equal(attempt.bundleState, input.expectedBundleState);
    this.attempt = Object.freeze({
      ...attempt,
      bundleState: input.nextBundleState,
      state: input.nextState,
      updatedAt: input.updatedAt,
      ...(attempt.upload === undefined ? {} : {
        upload: Object.freeze({
          ...attempt.upload,
          state: input.nextBundleState === 'validated'
            ? 'validated' as const
            : attempt.upload.state,
          updatedAt: input.updatedAt,
        }),
      }),
    });
    return Promise.resolve('advanced');
  }

  withProjectScope<T>(
    _projectId: string,
    operation: (scope: DevelopmentBootstrapProfileScope) => Promise<T>,
  ): Promise<T> {
    return operation(this);
  }

  private requireAttempt(): DevelopmentBootstrapAttemptRecord {
    assert.ok(this.attempt);
    return this.attempt;
  }
}

class Importer {
  imported: ImportGitBundleInput | undefined;
  validated: ValidatedBootstrapRepository | undefined;

  async importBundle(input: ImportGitBundleInput): Promise<ValidatedBootstrapRepository> {
    this.imported = input;
    if (this.validated !== undefined) return this.validated;
    for await (const chunk of input.body) {
      assert.ok(chunk instanceof Uint8Array);
    }
    this.validated = Object.freeze({
      artifactKey: createHash('sha256')
        .update(`${input.projectId}\0${input.attemptId}`)
        .digest('hex'),
      attemptId: input.attemptId,
      bundleByteCount: input.expectedByteCount,
      bundleSha256: input.expectedSha256,
      markerSha256: 'c'.repeat(64),
      objectFormat: input.objectFormat,
      projectId: input.projectId,
      refs: input.refs,
    });
    return this.validated;
  }
}

class Settlement implements DevelopmentBootstrapSettlementPort {
  readonly calls: string[] = [];
  activationResult: DevelopmentBootstrapActivationResult | undefined;

  activate(input: Readonly<{ actorId: string }>): Promise<void> {
    this.calls.push(`activate:${input.actorId}`);
    return Promise.resolve();
  }

  cancel(input: Readonly<{ actorId: string }>): Promise<void> {
    this.calls.push(`cancel:${input.actorId}`);
    return Promise.resolve();
  }

  getActivationResult(): Promise<DevelopmentBootstrapActivationResult | undefined> {
    return Promise.resolve(this.activationResult);
  }

  expire(): Promise<void> {
    this.calls.push('expire');
    return Promise.resolve();
  }
}

function fixture() {
  const persistence = new MemoryPersistence();
  const importer = new Importer();
  const settlement = new Settlement();
  const uploadGate = new DevelopmentBootstrapUploadGate();
  return {
    importer,
    persistence,
    profile: new DevelopmentBootstrapProfile({
      attemptTtlMs: 24 * 60 * 60 * 1_000,
      clock: () => new Date(NOW),
      importer,
      persistence,
      settlement,
      uploadGate,
    }),
    settlement,
  };
}

async function expectProfileError(
  operation: Promise<unknown>,
  code: DevelopmentBootstrapProfileError['code'],
): Promise<void> {
  await assert.rejects(operation, error => {
    if (!(error instanceof DevelopmentBootstrapProfileError)) return false;
    assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify(error), /Private project|fence_1/u);
    return true;
  });
}

describe('DevelopmentBootstrapProfile', () => {
  it('accepts only the package-owned fixed attempt lifetime', () => {
    const owners = fixture();
    assert.ok(owners.profile);
    assert.throws(() => new DevelopmentBootstrapProfile({
      attemptTtlMs: COLLAB_CLOUD_BINDING_LIMITS.bootstrapAttemptTtlMs - 1,
      importer: owners.importer,
      persistence: owners.persistence,
      settlement: owners.settlement,
      uploadGate: new DevelopmentBootstrapUploadGate(),
    }), /development-bootstrap-profile\.options-invalid/u);
  });

  it('allows only the source Host to begin one exact inactive Project attempt', async () => {
    const source = manifest();
    const owners = fixture();
    const status = await owners.profile.beginDevelopmentBootstrap(
      principal('member_1'),
      { manifest: source },
    );
    assert.deepEqual(status, {
      attemptId: 'attempt_1',
      bundleState: 'missing',
      createdAt: NOW,
      expiresAt: '2026-08-22T01:00:00.000Z',
      manifestSha256: manifestSha256(source),
      projectId: 'project_1',
      reporterMemberIds: [],
      state: 'collecting',
    });
    assert.deepEqual(
      await owners.profile.beginDevelopmentBootstrap(
        principal('member_1'),
        { manifest: source },
      ),
      status,
    );

    await expectProfileError(
      fixture().profile.beginDevelopmentBootstrap(
        principal('member_2'),
        { manifest: source },
      ),
      'authorization-denied',
    );
    const active = fixture();
    active.persistence.activeProject = true;
    await expectProfileError(
      active.profile.beginDevelopmentBootstrap(
        principal('member_1'),
        { manifest: source },
      ),
      'state-conflict',
    );

    for (const invalidManifest of [{
      ...source,
      sourceEligibility: { ...source.sourceEligibility, requests: 1 },
    }, {
      ...source,
      git: {
        ...source.git,
        refs: source.git.refs.slice(0, 2),
      },
    }, {
      ...source,
      git: {
        ...source.git,
        refs: source.git.refs.map(item => item.name === COLLAB_MAIN_REF
          ? { ...item, oid: MEMBER_ONE_OID }
          : item),
      },
    }]) {
      await assert.rejects(
        fixture().profile.beginDevelopmentBootstrap(
          principal('member_1'),
          { manifest: invalidManifest as DevelopmentBootstrapManifest },
        ),
        /collab\.error\.protocol-payload-invalid/u,
      );
    }
  });

  it('treats client capture and stop timestamps as informational across clock skew', async () => {
    const source = manifest({ createdAt: '2099-08-21T00:00:00.000Z' });
    const owners = fixture();
    await owners.profile.beginDevelopmentBootstrap(
      principal('member_1'),
      { manifest: source },
    );
    const hostReport = report(source, 'member_1', {
      capturedAt: '2000-01-01T00:00:00.000Z',
      hostStopAttestation: {
        ...report(source, 'member_1').hostStopAttestation,
        stoppedAt: '1999-01-01T00:00:00.000Z',
      },
    });
    const participantReport = report(source, 'member_2', {
      capturedAt: '2100-01-01T00:00:00.000Z',
    });

    await owners.profile.submitDevelopmentBootstrapReport(
      principal('member_1'),
      { attemptId: source.attemptId, report: hostReport },
    );
    const status = await owners.profile.submitDevelopmentBootstrapReport(
      principal('member_2'),
      { attemptId: source.attemptId, report: participantReport },
    );
    assert.deepEqual(status.reporterMemberIds, ['member_1', 'member_2']);
  });

  it('accepts exactly two actor-bound matching reports and rejects contradictions', async () => {
    const source = manifest();
    const owners = fixture();
    await owners.profile.beginDevelopmentBootstrap(
      principal('member_1'),
      { manifest: source },
    );
    await owners.profile.submitDevelopmentBootstrapReport(
      principal('member_1'),
      { attemptId: source.attemptId, report: report(source, 'member_1') },
    );
    assert.deepEqual((await owners.profile.submitDevelopmentBootstrapReport(
      principal('member_2'),
      { attemptId: source.attemptId, report: report(source, 'member_2') },
    )).reporterMemberIds, ['member_1', 'member_2']);

    await expectProfileError(
      owners.profile.submitDevelopmentBootstrapReport(
        principal('member_2'),
        { attemptId: source.attemptId, report: report(source, 'member_1') },
      ),
      'authorization-denied',
    );
    await expectProfileError(
      owners.profile.submitDevelopmentBootstrapReport(
        principal('member_1'),
        {
          attemptId: source.attemptId,
          report: report(source, 'member_1', {
            comparison: comparison({ projectName: 'Changed project' }),
          }),
        },
      ),
      'comparison-mismatch',
    );
    await expectProfileError(
      owners.profile.submitDevelopmentBootstrapReport(
        principal('member_1'),
        {
          attemptId: source.attemptId,
          report: report(source, 'member_1', {
            hostStopAttestation: {
              ...report(source, 'member_1').hostStopAttestation,
              manifestSha256: 'e'.repeat(64),
            },
          }),
        },
      ),
      'host-stop-mismatch',
    );
    await expectProfileError(
      owners.profile.submitDevelopmentBootstrapReport(
        principal('member_2'),
        {
          attemptId: source.attemptId,
          report: report(source, 'member_2', {
            observedPersonalRefOid: '4'.repeat(40),
          }),
        },
      ),
      'repository-mismatch',
    );

    for (const invalidReport of [{
      ...report(source, 'member_2'),
      clientReadiness: {
        ...readiness(),
        cleanupSettled: false,
      },
    }, {
      ...report(source, 'member_1'),
      hostStopAttestation: undefined,
    }, {
      ...report(source, 'member_1'),
      hostStopAttestation: {
        ...report(source, 'member_1').hostStopAttestation,
        resourcesDrained: false,
      },
    }]) {
      await assert.rejects(
        owners.profile.submitDevelopmentBootstrapReport(
          principal(invalidReport.reporterMemberId as 'member_1' | 'member_2'),
          {
            attemptId: source.attemptId,
            report: invalidReport as DevelopmentBootstrapReport,
          },
        ),
        /collab\.error\.protocol-payload-invalid/u,
      );
    }
  });

  it('streams only the Host upload and becomes ready after reports and validation agree', async () => {
    const source = manifest();
    const owners = fixture();
    await owners.profile.beginDevelopmentBootstrap(
      principal('member_1'),
      { manifest: source },
    );
    for (const memberId of ['member_1', 'member_2'] as const) {
      await owners.profile.submitDevelopmentBootstrapReport(
        principal(memberId),
        { attemptId: source.attemptId, report: report(source, memberId) },
      );
    }
    await expectProfileError(
      owners.profile.putDevelopmentBootstrapGitBundle(
        principal('member_2'),
        {
          attemptId: source.attemptId,
          body: (async function* body() {
            await Promise.resolve();
            yield Buffer.from('not-read');
          })(),
          contentEncoding: 'identity',
          contentType: 'application/x-git-bundle',
        },
      ),
      'authorization-denied',
    );

    const status = await owners.profile.putDevelopmentBootstrapGitBundle(
      principal('member_1'),
      {
        attemptId: source.attemptId,
        body: (async function* body() {
          await Promise.resolve();
          yield Buffer.from('bundle-bytes');
        })(),
        contentEncoding: 'identity',
        contentLength: 12,
        contentType: 'application/x-git-bundle',
      },
    );
    assert.equal(status.state, 'ready');
    assert.equal(status.bundleState, 'validated');
    const imported = owners.importer.imported;
    assert.ok(imported);
    assert.equal(imported.declaredByteCount, 12);
    assert.equal(imported.declaredSha256, BUNDLE_SHA256);
    assert.deepEqual(imported.refs, source.git.refs);
    assert.deepEqual(owners.persistence.uploadLeaseEvents, [
      'acquired:attempt_1',
      'released:attempt_1',
    ]);

    let replayRead = false;
    const replay = await owners.profile.putDevelopmentBootstrapGitBundle(
      principal('member_1'),
      {
        attemptId: source.attemptId,
        body: (async function* body() {
          await Promise.resolve();
          replayRead = true;
          yield Buffer.from('must-not-read');
        })(),
        contentEncoding: 'identity',
        contentType: 'application/x-git-bundle',
      },
    );
    assert.equal(replay.state, 'ready');
    assert.equal(replayRead, false);
    assert.deepEqual(owners.persistence.uploadLeaseEvents, [
      'acquired:attempt_1',
      'released:attempt_1',
      'acquired:attempt_1',
      'released:attempt_1',
    ]);
  });

  it('allows both accepted actors bounded reads and delegates Host-only settlement', async () => {
    const source = manifest();
    const owners = fixture();
    await owners.profile.beginDevelopmentBootstrap(
      principal('member_1'),
      { manifest: source },
    );
    assert.equal((await owners.profile.getDevelopmentBootstrap(
      principal('member_2'),
      { attemptId: source.attemptId },
    )).projectId, 'project_1');
    await expectProfileError(
      owners.profile.getDevelopmentBootstrap(
        principal('member_3'),
        { attemptId: source.attemptId },
      ),
      'authorization-denied',
    );

    assert.ok(owners.persistence.attempt);
    owners.persistence.attempt = Object.freeze({
      ...owners.persistence.attempt,
      bundleState: 'validated',
      state: 'ready',
    });

    await owners.profile.activateDevelopmentBootstrap(
      principal('member_1'),
      { attemptId: source.attemptId, manifestSha256: manifestSha256(source) },
    );
    await owners.profile.cancelDevelopmentBootstrap(
      principal('member_1'),
      { attemptId: source.attemptId },
    );
    assert.deepEqual(owners.settlement.calls, [
      'activate:member_1',
      'cancel:member_1',
    ]);
    await expectProfileError(
      owners.profile.activateDevelopmentBootstrap(
        principal('member_2'),
        { attemptId: source.attemptId, manifestSha256: manifestSha256(source) },
      ),
      'authorization-denied',
    );
    await expectProfileError(
      owners.profile.cancelDevelopmentBootstrap(
        principal('member_2'),
        { attemptId: source.attemptId },
      ),
      'authorization-denied',
    );
  });

  it('delegates expired invisible staging to durable cancellation settlement', async () => {
    const source = manifest();
    const owners = fixture();
    await owners.profile.beginDevelopmentBootstrap(
      principal('member_1'),
      { manifest: source },
    );
    assert.ok(owners.persistence.attempt);
    owners.persistence.attempt = Object.freeze({
      ...owners.persistence.attempt,
      expiresAt: '2026-08-21T00:59:59.000Z',
    });

    await owners.profile.getDevelopmentBootstrap(
      principal('member_2'),
      { attemptId: source.attemptId },
    );
    assert.deepEqual(owners.settlement.calls, ['expire']);
  });
});
