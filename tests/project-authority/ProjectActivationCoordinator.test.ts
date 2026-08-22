import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabMemberRef,
  decodeDevelopmentBootstrapManifest,
  decodeDevelopmentBootstrapReport,
  encodeDevelopmentBootstrapManifestCanonicalJson,
  type DevelopmentBootstrapManifest,
} from '@claudian/collab-protocol';

import type {
  DevelopmentBootstrapAttemptRecord,
  DevelopmentBootstrapProjectActivation,
  RecoveryCandidatePage,
} from '../../src/coordination/DevelopmentBootstrapPersistence.js';
import { CoordinationError } from '../../src/coordination/CoordinationError.js';
import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/postgres/PostgresCoordination.js';
import {
  ProjectActivationCoordinator,
  ProjectActivationCoordinatorError,
  type ProjectActivationAttemptCleaner,
  type ProjectActivationCoordination,
  type ProjectActivationRepositoryPublication,
} from '../../src/project-authority/lifecycle/ProjectActivationCoordinator.js';
import { DevelopmentBootstrapUploadGate } from '../../src/project-authority/lifecycle/DevelopmentBootstrapUploadGate.js';
import type {
  PrepareRepositoryPublicationInput,
  PreparedRepositoryPublication,
} from '../../src/repositories/RepositoryPublication.js';

const CREATED = '2026-08-21T00:00:00.000Z';
const STOPPED = '2026-08-21T00:30:00.000Z';
const NOW = '2026-08-21T01:00:00.000Z';
const EXPIRES = '2026-08-22T00:00:00.000Z';
const MAIN = '1'.repeat(40);
const MEMBER_A = '2'.repeat(40);
const MEMBER_B = '3'.repeat(40);
const BUNDLE = 'a'.repeat(64);
const MARKER = 'b'.repeat(64);

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function manifest(): DevelopmentBootstrapManifest {
  return decodeDevelopmentBootstrapManifest({
    attemptId: 'attempt_test',
    comparison: {
      mainOid: MAIN,
      mainRef: COLLAB_MAIN_REF,
      managerSetGeneration: 7,
      members: [{
        activatedAt: CREATED,
        createdAt: CREATED,
        displayName: 'Same name',
        memberId: 'member_a',
        personalRef: collabMemberRef('member_a'),
        role: 'manager',
        status: 'active',
      }, {
        activatedAt: CREATED,
        createdAt: CREATED,
        displayName: 'Same name',
        memberId: 'member_b',
        personalRef: collabMemberRef('member_b'),
        role: 'member',
        status: 'active',
      }],
      projectCreatedAt: CREATED,
      projectId: 'project_test',
      projectName: 'Private project',
      sourceCaFingerprint: 'c'.repeat(64),
      sourceEventSequence: 0,
      sourceHostMemberId: 'member_a',
    },
    createdAt: CREATED,
    git: {
      bundle: { byteCount: 12, sha256: BUNDLE },
      objectFormat: 'sha1',
      refs: [
        { name: COLLAB_MAIN_REF, oid: MAIN },
        { name: collabMemberRef('member_a'), oid: MEMBER_A },
        { name: collabMemberRef('member_b'), oid: MEMBER_B },
      ],
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
  });
}

function manifestFor(
  projectId: string,
  attemptId: string,
): DevelopmentBootstrapManifest {
  const source = manifest();
  return decodeDevelopmentBootstrapManifest({
    ...source,
    attemptId,
    comparison: {
      ...source.comparison,
      projectId,
    },
  });
}

function report(
  source: DevelopmentBootstrapManifest,
  memberId: 'member_a' | 'member_b',
) {
  return decodeDevelopmentBootstrapReport({
    attemptId: source.attemptId,
    capturedAt: NOW,
    clientReadiness: {
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
    },
    comparison: source.comparison,
    ...(memberId === 'member_a' ? {
      hostStopAttestation: {
        attemptId: source.attemptId,
        autoStartDisabled: true,
        fenceDurable: true,
        fenceId: 'fence_test',
        hostStopped: true,
        manifestSha256: digest(
          encodeDevelopmentBootstrapManifestCanonicalJson(source),
        ),
        projectId: source.comparison.projectId,
        resourcesDrained: true,
        routeUnregistered: true,
        stoppedAt: STOPPED,
      },
    } : {}),
    observedPersonalRefOid: memberId === 'member_a' ? MEMBER_A : MEMBER_B,
    reporterMemberId: memberId,
  });
}

function readyAttempt(
  source = manifest(),
  state: DevelopmentBootstrapAttemptRecord['state'] = 'ready',
): DevelopmentBootstrapAttemptRecord {
  const manifestJson = encodeDevelopmentBootstrapManifestCanonicalJson(source);
  const reports = (['member_a', 'member_b'] as const).map(memberId => {
    const value = report(source, memberId);
    const reportJson = JSON.stringify(value);
    return Object.freeze({
      capturedAt: value.capturedAt,
      createdAt: NOW,
      reportJson,
      reportSha256: digest(reportJson),
      reporterMemberId: memberId,
    });
  });
  return Object.freeze({
    attemptId: source.attemptId,
    bundleState: 'validated',
    createdAt: NOW,
    expiresAt: EXPIRES,
    manifestJson,
    manifestSha256: digest(manifestJson),
    projectId: source.comparison.projectId,
    reports: Object.freeze(reports),
    settlement: undefined,
    sourceHostMemberId: source.comparison.sourceHostMemberId,
    state,
    updatedAt: NOW,
    upload: Object.freeze({
      byteCount: source.git.bundle.byteCount,
      createdAt: NOW,
      sha256: source.git.bundle.sha256,
      stagingArtifactKey: digest(`${source.comparison.projectId}\0${source.attemptId}`),
      state: 'validated',
      updatedAt: NOW,
      validationMarkerSha256: MARKER,
    }),
  });
}

class MemoryCoordination implements ProjectActivationCoordination {
  attempt: DevelopmentBootstrapAttemptRecord;
  project: DevelopmentBootstrapProjectActivation | undefined;

  constructor(attempt = readyAttempt()) {
    this.attempt = attempt;
  }

  acquireProjectLease(): Promise<PinnedProjectLease> {
    const scope = this.scope();
    return Promise.resolve({
      close: () => Promise.resolve(),
      drainDevelopmentBootstrapUploads: () => Promise.resolve(),
      handoffToDevelopmentBootstrapUpload: () => Promise.resolve({
        close: () => Promise.resolve(),
      }),
      withProjectScope: operation => operation(scope),
    });
  }

  listRecoveryCandidates(): Promise<RecoveryCandidatePage> {
    const settlement = this.attempt.settlement;
    const nonterminal = settlement !== undefined && (
      (settlement.kind === 'activation' && settlement.activationPhase !== 'completed')
      || (settlement.kind === 'cancellation'
        && settlement.cancellationPhase === 'cancel-intent')
    );
    return Promise.resolve({
      candidates: nonterminal ? [{
        kind: 'activation',
        operationId: settlement.operationId,
        projectId: this.attempt.projectId,
        scheduledAt: settlement.updatedAt,
      }] : [],
      nextCursor: undefined,
    });
  }

  private scope(): ProjectScope {
    // The scoped fixture intentionally commits mutations into its owning store.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const owner = this;
    return {
      collaboration: undefined as never,
      advanceDevelopmentBootstrapActivation(input) {
        const settlement = owner.attempt.settlement;
        if (
          settlement?.kind !== 'activation'
          || settlement.activationPhase !== input.expectedPhase
        ) throw new CoordinationError('state-conflict');
        owner.attempt = Object.freeze({
          ...owner.attempt,
          state: input.nextPhase === 'activated' ? 'activated' : owner.attempt.state,
          settlement: Object.freeze({
            ...settlement,
            activationPhase: input.nextPhase,
            updatedAt: input.updatedAt,
          }),
          updatedAt: input.updatedAt,
        });
        return Promise.resolve('advanced');
      },
      advanceDevelopmentBootstrapCancellation(input) {
        const settlement = owner.attempt.settlement;
        if (
          settlement?.kind !== 'cancellation'
          || settlement.cancellationPhase !== input.expectedPhase
        ) throw new CoordinationError('state-conflict');
        owner.attempt = Object.freeze({
          ...owner.attempt,
          state: input.nextPhase === 'cancelled'
            ? 'cancelled'
            : 'recovery-required',
          settlement: Object.freeze({
            ...settlement,
            cancellationPhase: input.nextPhase,
            updatedAt: input.updatedAt,
          }),
          updatedAt: input.updatedAt,
        });
        return Promise.resolve('advanced');
      },
      beginDevelopmentBootstrapActivation(input) {
        if (owner.attempt.settlement !== undefined) {
          throw new CoordinationError('state-conflict');
        }
        owner.attempt = Object.freeze({
          ...owner.attempt,
          state: 'activating',
          settlement: Object.freeze({
            activationPhase: 'publish-intent',
            attemptId: input.attemptId,
            journalJson: input.journalJson,
            kind: 'activation',
            operationId: input.operationId,
            updatedAt: input.scheduledAt,
          }),
        });
        return Promise.resolve('created');
      },
      beginDevelopmentBootstrapCancellation(input) {
        if (owner.attempt.settlement !== undefined) {
          throw new CoordinationError('state-conflict');
        }
        owner.attempt = Object.freeze({
          ...owner.attempt,
          settlement: Object.freeze({
            attemptId: input.attemptId,
            cancellationPhase: 'cancel-intent',
            journalJson: input.journalJson,
            kind: 'cancellation',
            operationId: input.operationId,
            updatedAt: input.scheduledAt,
          }),
        });
        return Promise.resolve('created');
      },
      appendProjectEvent: () => Promise.reject(new Error('unused')),
      findDevelopmentActorMember: () => Promise.resolve(undefined),
      findMembership: () => Promise.resolve(undefined),
      listMemberships: () => Promise.resolve([]),
      getDevelopmentBootstrapAttempt: attemptId => Promise.resolve(
        owner.attempt.attemptId === attemptId ? owner.attempt : undefined,
      ),
      getActiveDevelopmentBootstrapAttempt: () => Promise.resolve(
        ['collecting', 'validating', 'ready', 'activating', 'recovery-required']
          .includes(owner.attempt.state)
          ? owner.attempt
          : undefined,
      ),
      getDevelopmentBootstrapRecoveryAttempt: operationId => Promise.resolve(
        owner.attempt.settlement?.operationId === operationId
          ? owner.attempt
          : undefined,
      ),
      getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(
        owner.attempt.settlement === undefined
          || (owner.attempt.settlement.kind === 'activation'
            && owner.attempt.settlement.activationPhase === 'completed')
          || (owner.attempt.settlement.kind === 'cancellation'
            && owner.attempt.settlement.cancellationPhase !== 'cancel-intent')
          ? undefined
          : owner.attempt,
      ),
      getProjectEventSequence: () => Promise.resolve(0),
      getProject: () => Promise.resolve(undefined),
      getRepositoryPlacement: () => Promise.resolve(undefined),
      insertActivatedDevelopmentProject(input) {
        if (
          owner.project !== undefined
          && JSON.stringify(owner.project) !== JSON.stringify(input)
        ) {
          throw new CoordinationError('state-conflict');
        }
        owner.project = input;
        return Promise.resolve('created');
      },
      markDevelopmentBootstrapActivationRecoveryRequired(input) {
        owner.attempt = Object.freeze({
          ...owner.attempt,
          state: 'recovery-required',
          updatedAt: input.updatedAt,
        });
        return Promise.resolve('advanced');
      },
      putDevelopmentBootstrapAttempt: () => Promise.reject(new Error('unused')),
      putDevelopmentBootstrapReport: () => Promise.reject(new Error('unused')),
      putDevelopmentBootstrapUpload: () => Promise.reject(new Error('unused')),
      pruneProjectEvents: () => Promise.reject(new Error('unused')),
      readProjectEvents: () => Promise.reject(new Error('unused')),
      transitionDevelopmentBootstrapAttempt: () => Promise.reject(new Error('unused')),
    };
  }
}

class MemoryPublication implements ProjectActivationRepositoryPublication {
  readonly calls: string[] = [];
  state: 'published' | 'staged' = 'staged';

  cleanupAttempt(): Promise<'cleaned' | 'replayed'> {
    this.calls.push('cleanup');
    return Promise.resolve('cleaned');
  }

  inspect(): Promise<{ state: 'published' | 'staged' }> {
    this.calls.push('inspect');
    return Promise.resolve({ state: this.state });
  }

  plan(input: PrepareRepositoryPublicationInput): PreparedRepositoryPublication {
    return Object.freeze({
      artifactKey: input.repository.artifactKey,
      attemptId: input.repository.attemptId,
      generation: 1,
      markerSha256: input.repository.markerSha256,
      objectFormat: input.repository.objectFormat,
      projectId: input.repository.projectId,
      publicationMarkerSha256: digest(JSON.stringify(input)),
      refs: input.repository.refs,
      repositoryStorageKey: input.repositoryStorageKey,
      storageNodeId: 'node_test',
      validationMarkerSha256: input.repository.markerSha256,
    });
  }

  prepare(input: PrepareRepositoryPublicationInput): Promise<PreparedRepositoryPublication> {
    this.calls.push('prepare');
    return Promise.resolve(this.plan(input));
  }

  publish(publication: PreparedRepositoryPublication) {
    this.calls.push('publish');
    this.state = 'published';
    return Promise.resolve({ publication, status: 'published' as const });
  }
}

class MemoryCleaner implements ProjectActivationAttemptCleaner {
  readonly calls: string[] = [];

  abortAttempt(input: Readonly<{ attemptId: string }>): Promise<void> {
    this.calls.push(`abort:${input.attemptId}`);
    return Promise.resolve();
  }

  discardAttempt(input: Readonly<{ attemptId: string }>): Promise<'removed'> {
    this.calls.push(`discard:${input.attemptId}`);
    return Promise.resolve('removed');
  }
}

function fixture(attempt = readyAttempt()) {
  const coordination = new MemoryCoordination(attempt);
  const publication = new MemoryPublication();
  const cleaner = new MemoryCleaner();
  return {
    cleaner,
    coordination,
    coordinator: new ProjectActivationCoordinator({
      attemptCleaner: cleaner,
      clock: () => new Date(NOW),
      coordination,
      operationIdFactory: kind => `${kind}_test`,
      publication,
      repositoryStorageKeyFactory: () => 'repo_test',
      uploadGate: new DevelopmentBootstrapUploadGate(),
    }),
    publication,
  };
}

describe('ProjectActivationCoordinator', () => {
  it('publishes and activates exactly once with a stable replay result', async () => {
    const owners = fixture();
    const source = manifest();
    const input = {
      actorId: 'member_a',
      attemptId: source.attemptId,
      manifestSha256: digest(
        encodeDevelopmentBootstrapManifestCanonicalJson(source),
      ),
      projectId: source.comparison.projectId,
    } as const;

    await owners.coordinator.activate(input);
    assert.equal(owners.coordination.attempt.state, 'activated');
    assert.equal(
      owners.coordination.attempt.settlement?.kind === 'activation'
        ? owners.coordination.attempt.settlement.activationPhase
        : undefined,
      'completed',
    );
    assert.deepEqual(owners.publication.calls, [
      'prepare',
      'publish',
      'inspect',
      'inspect',
      'cleanup',
      'inspect',
      'cleanup',
    ]);
    assert.deepEqual(owners.cleaner.calls, ['abort:attempt_test']);
    assert.deepEqual(await owners.coordinator.getActivationResult(input), {
      activatedAt: NOW,
      activationOperationId: 'activation_test',
      placementGeneration: 1,
      projectId: 'project_test',
    });

    await owners.coordinator.activate(input);
    assert.deepEqual(await owners.coordinator.getActivationResult(input), {
      activatedAt: NOW,
      activationOperationId: 'activation_test',
      placementGeneration: 1,
      projectId: 'project_test',
    });
    const project = owners.coordination.project;
    assert.ok(project);
    assert.equal(project.managerSetGeneration, 0);
    assert.equal(project.repositoryStorageKey, 'repo_test');
    assert.deepEqual(
      project.members.map(member => ({
        displayName: member.displayName,
        memberId: member.memberId,
      })),
      [{ displayName: 'Same name', memberId: 'member_a' }, {
        displayName: 'Same name',
        memberId: 'member_b',
      }],
    );
  });

  it('persists cancellation intent before exact staging cleanup', async () => {
    const owners = fixture(readyAttempt(manifest(), 'collecting'));
    await owners.coordinator.cancel({
      actorId: 'member_a',
      attemptId: 'attempt_test',
      projectId: 'project_test',
    });
    assert.equal(owners.coordination.attempt.state, 'cancelled');
    assert.deepEqual(owners.cleaner.calls, [
      'abort:attempt_test',
      'discard:attempt_test',
    ]);
    assert.equal(
      owners.coordination.attempt.settlement?.kind === 'cancellation'
        ? owners.coordination.attempt.settlement.cancellationPhase
        : undefined,
      'cancelled',
    );
  });

  it('fails closed for a contradictory durable validated fact', async () => {
    const attempt = readyAttempt();
    assert.ok(attempt.upload);
    const owners = fixture(Object.freeze({
      ...attempt,
      upload: Object.freeze({
        ...attempt.upload,
        validationMarkerSha256: 'invalid',
      }),
    }));
    await assert.rejects(owners.coordinator.activate({
      actorId: 'member_a',
      attemptId: 'attempt_test',
      manifestSha256: attempt.manifestSha256,
      projectId: 'project_test',
    }), error => {
      assert.ok(error instanceof ProjectActivationCoordinatorError);
      assert.equal(error.code, 'recovery-required');
      return true;
    });
    assert.equal(owners.publication.calls.length, 0);
  });

  it('continues global recovery after classifying one project for repair', async () => {
    const invalidSource = manifestFor('project_invalid', 'attempt_invalid');
    const recoverableSource = manifestFor('project_recoverable', 'attempt_recoverable');
    const invalid = new MemoryCoordination(Object.freeze({
      ...readyAttempt(invalidSource),
      state: 'activating',
      settlement: Object.freeze({
        activationPhase: 'publish-intent',
        attemptId: invalidSource.attemptId,
        journalJson: '{}',
        kind: 'activation',
        operationId: 'activation_invalid',
        updatedAt: NOW,
      }),
    }));
    const recoverable = new MemoryCoordination(Object.freeze({
      ...readyAttempt(recoverableSource),
      settlement: Object.freeze({
        attemptId: recoverableSource.attemptId,
        cancellationPhase: 'cancel-intent',
        journalJson: JSON.stringify({
          attemptId: recoverableSource.attemptId,
          kind: 'cancellation',
          projectId: recoverableSource.comparison.projectId,
          reason: 'expired',
          schemaVersion: 1,
        }),
        kind: 'cancellation',
        operationId: 'cancellation_recoverable',
        updatedAt: NOW,
      }),
    }));
    const stores = new Map([
      [invalid.attempt.projectId, invalid],
      [recoverable.attempt.projectId, recoverable],
    ]);
    const coordination: ProjectActivationCoordination = {
      acquireProjectLease(projectId) {
        const store = stores.get(projectId);
        if (store === undefined) throw new Error('unknown project');
        return store.acquireProjectLease();
      },
      listRecoveryCandidates: () => Promise.resolve({
        candidates: [invalid, recoverable].map(store => ({
          kind: 'activation' as const,
          operationId: store.attempt.settlement?.operationId ?? 'missing',
          projectId: store.attempt.projectId,
          scheduledAt: NOW,
        })),
        nextCursor: undefined,
      }),
    };
    const cleaner = new MemoryCleaner();
    const coordinator = new ProjectActivationCoordinator({
      attemptCleaner: cleaner,
      clock: () => new Date(NOW),
      coordination,
      publication: new MemoryPublication(),
      uploadGate: new DevelopmentBootstrapUploadGate(),
    });

    await coordinator.recoverAll();

    assert.equal(invalid.attempt.state, 'recovery-required');
    assert.equal(recoverable.attempt.state, 'cancelled');
    assert.deepEqual(cleaner.calls, [
      'abort:attempt_recoverable',
      'discard:attempt_recoverable',
    ]);
  });
});
