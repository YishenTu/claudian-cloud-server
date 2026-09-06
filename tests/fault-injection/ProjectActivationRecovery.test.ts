import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabMemberRef,
  decodeDevelopmentBootstrapManifest,
  decodeDevelopmentBootstrapReport,
  encodeDevelopmentBootstrapManifestCanonicalJson,
  type DevelopmentBootstrapManifest,
} from '@claudian-collab/protocol';

import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresCoordination } from '../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresSchemaInitializer } from '../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { createDevelopmentPrincipal } from '../../src/request-context/RequestPrincipal.js';
import {
  ProjectActivationCoordinator,
  ProjectActivationCoordinatorError,
  type ProjectActivationCoordination,
  type ProjectActivationRepositoryPublication,
} from '../../src/project-authority/lifecycle/ProjectActivationCoordinator.js';
import { DevelopmentBootstrapUploadGate } from '../../src/project-authority/lifecycle/DevelopmentBootstrapUploadGate.js';
import { decodeDevelopmentBootstrapJournalJson } from '../../src/project-authority/lifecycle/DevelopmentBootstrapJournal.js';
import {
  ProjectWriteAdmission,
  ProjectWriteAdmissionError,
} from '../../src/project-authority/admission/ProjectWriteAdmission.js';
import {
  GitBundleImporter,
  type ValidatedBootstrapRepository,
} from '../../src/repositories/GitBundleImporter.js';
import {
  RepositoryPublication,
  type PrepareRepositoryPublicationInput,
  type PreparedRepositoryPublication,
} from '../../src/repositories/RepositoryPublication.js';
import { BootstrapRepositoryIntegrityVerifier } from '../../src/repositories/BootstrapRepositoryIntegrityVerifier.js';
import { BootstrapUploadAdmission } from '../../src/resource-admission/BootstrapUploadAdmission.js';
import { ResourceAdmission } from '../../src/resource-admission/ResourceAdmission.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';
const CREATED = '2026-08-21T00:00:00.000Z';
const STOPPED = '2026-08-21T00:30:00.000Z';
const NOW = '2026-08-21T01:00:00.000Z';
const EXPIRES = '2026-08-22T00:00:00.000Z';

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

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 3,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

class FaultController {
  readonly seen: string[] = [];
  target: string | undefined;

  trip(checkpoint: string): void {
    this.seen.push(checkpoint);
    if (this.target !== checkpoint) return;
    this.target = undefined;
    throw new Error('injected-process-death');
  }
}

function checkpoint(method: PropertyKey, input: unknown): string | undefined {
  if (method === 'beginDevelopmentBootstrapActivation') return 'sql:publish-intent';
  if (method === 'beginDevelopmentBootstrapCancellation') return 'sql:cancel-intent';
  if (
    method !== 'advanceDevelopmentBootstrapActivation'
    && method !== 'advanceDevelopmentBootstrapCancellation'
  ) return undefined;
  if (typeof input !== 'object' || input === null || !('nextPhase' in input)) {
    return undefined;
  }
  const nextPhase = input.nextPhase;
  return typeof nextPhase === 'string' ? `sql:${nextPhase}` : undefined;
}

class FaultLease implements PinnedProjectLease {
  readonly #controller: FaultController;
  readonly #lease: PinnedProjectLease;

  constructor(lease: PinnedProjectLease, controller: FaultController) {
    this.#controller = controller;
    this.#lease = lease;
  }

  close(): Promise<void> {
    return this.#lease.close();
  }

  drainDevelopmentBootstrapUploads(attemptId: string): Promise<void> {
    return this.#lease.drainDevelopmentBootstrapUploads(attemptId);
  }

  handoffToDevelopmentBootstrapUpload(attemptId: string) {
    return this.#lease.handoffToDevelopmentBootstrapUpload(attemptId);
  }

  async withProjectScope<T>(
    operation: (scope: ProjectScope) => Promise<T>,
  ): Promise<T> {
    let committedCheckpoint: string | undefined;
    const controller = this.#controller;
    const value = await this.#lease.withProjectScope(scope => operation(
      new Proxy(scope, {
        get(target, property, receiver) {
          const member: unknown = Reflect.get(target, property, receiver);
          if (typeof member !== 'function') return member;
          return async (...arguments_: readonly unknown[]) => {
            const result: unknown = await Reflect.apply(member, target, arguments_);
            controller.seen.push(`call:${String(property)}`);
            committedCheckpoint = checkpoint(property, arguments_[0]);
            return result;
          };
        },
      }),
    ));
    if (committedCheckpoint !== undefined) {
      this.#controller.trip(committedCheckpoint);
    }
    return value;
  }
}

class FaultCoordination implements ProjectActivationCoordination {
  readonly #controller: FaultController;
  readonly #store: PostgresCoordination;

  constructor(store: PostgresCoordination, controller: FaultController) {
    this.#controller = controller;
    this.#store = store;
  }

  async acquireProjectLease(projectId: string): Promise<PinnedProjectLease> {
    return new FaultLease(
      await this.#store.acquireProjectLease(projectId),
      this.#controller,
    );
  }

  listRecoveryCandidates = this.#listRecoveryCandidates.bind(this);

  async #listRecoveryCandidates(
    options?: Parameters<PostgresCoordination['listRecoveryCandidates']>[0],
  ) {
    return this.#store.listRecoveryCandidates(options);
  }
}

class FaultPublication implements ProjectActivationRepositoryPublication {
  readonly #controller: FaultController;
  readonly #owner: RepositoryPublication;

  constructor(owner: RepositoryPublication, controller: FaultController) {
    this.#controller = controller;
    this.#owner = owner;
  }

  async cleanupAttempt(publication: PreparedRepositoryPublication) {
    const result = await this.#owner.cleanupAttempt(publication);
    this.#controller.trip('fs:cleanup');
    return result;
  }

  inspect(publication: PreparedRepositoryPublication) {
    return this.#owner.inspect(publication);
  }

  plan(input: PrepareRepositoryPublicationInput) {
    return this.#owner.plan(input);
  }

  async prepare(input: PrepareRepositoryPublicationInput) {
    const result = await this.#owner.prepare(input);
    this.#controller.trip('fs:prepare');
    return result;
  }

  async publish(publication: PreparedRepositoryPublication) {
    const result = await this.#owner.publish(publication);
    this.#controller.trip('fs:publish');
    return result;
  }
}

class FaultCleaner {
  readonly #controller: FaultController;
  readonly #importer: GitBundleImporter;

  constructor(importer: GitBundleImporter, controller: FaultController) {
    this.#controller = controller;
    this.#importer = importer;
  }

  abortAttempt(input: Readonly<{
    attemptId: string;
    projectId: string;
  }>): Promise<void> {
    return this.#importer.abortAttempt(input);
  }

  async discardAttempt(input: Readonly<{
    attemptId: string;
    projectId: string;
  }>) {
    const result = await this.#importer.discardAttempt(input);
    this.#controller.trip('fs:discard');
    return result;
  }
}

async function sourceFixture(root: string): Promise<Readonly<{
  bundlePath: string;
  manifest: DevelopmentBootstrapManifest;
}>> {
  const source = join(root, 'source');
  await mkdir(source);
  await git(source, ['init', '--initial-branch=main']);
  await writeFile(join(source, 'note.md'), '# Cloud activation\n');
  await git(source, ['add', '--all']);
  await execFileAsync(GIT, [
    '-c',
    'user.name=Claudian Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'initial',
  ], {
    cwd: source,
    env: {
      GIT_AUTHOR_DATE: '2026-08-21T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-08-21T00:00:00Z',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    },
  });
  const mainOid = await git(source, ['rev-parse', 'refs/heads/main']);
  await git(source, ['update-ref', collabMemberRef('member_a'), mainOid]);
  await git(source, ['update-ref', collabMemberRef('member_b'), mainOid]);
  const bundlePath = join(root, 'source.bundle');
  await git(source, [
    'bundle',
    'create',
    bundlePath,
    COLLAB_MAIN_REF,
    collabMemberRef('member_a'),
    collabMemberRef('member_b'),
  ]);
  const bytes = await readFile(bundlePath);
  return Object.freeze({
    bundlePath,
    manifest: decodeDevelopmentBootstrapManifest({
      attemptId: 'attempt_fault',
      comparison: {
        mainOid,
        mainRef: COLLAB_MAIN_REF,
        managerSetGeneration: 1,
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
        projectId: 'project_fault',
        projectName: 'Private project',
        sourceCaFingerprint: 'c'.repeat(64),
        sourceEventSequence: 0,
        sourceHostMemberId: 'member_a',
      },
      createdAt: CREATED,
      git: {
        bundle: { byteCount: bytes.length, sha256: sha256(bytes) },
        objectFormat: 'sha1',
        refs: [
          { name: COLLAB_MAIN_REF, oid: mainOid },
          { name: collabMemberRef('member_a'), oid: mainOid },
          { name: collabMemberRef('member_b'), oid: mainOid },
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
    }),
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

async function seedReadyAttempt(
  store: PostgresCoordination,
  source: DevelopmentBootstrapManifest,
  repository: ValidatedBootstrapRepository,
): Promise<void> {
  const manifestJson = encodeDevelopmentBootstrapManifestCanonicalJson(source);
  await store.withProjectScope(source.comparison.projectId, async scope => {
    await scope.putDevelopmentBootstrapAttempt({
      attemptId: source.attemptId,
      createdAt: NOW,
      expiresAt: EXPIRES,
      manifestJson,
      manifestSha256: sha256(manifestJson),
      projectId: source.comparison.projectId,
      sourceHostMemberId: source.comparison.sourceHostMemberId,
    });
    for (const memberId of ['member_a', 'member_b'] as const) {
      const report = decodeDevelopmentBootstrapReport({
        attemptId: source.attemptId,
        capturedAt: NOW,
        clientReadiness: readiness(),
        comparison: source.comparison,
        ...(memberId === 'member_a' ? {
          hostStopAttestation: {
            attemptId: source.attemptId,
            autoStartDisabled: true,
            fenceDurable: true,
            fenceId: 'fence_fault',
            hostStopped: true,
            manifestSha256: sha256(manifestJson),
            projectId: source.comparison.projectId,
            resourcesDrained: true,
            routeUnregistered: true,
            stoppedAt: STOPPED,
          },
        } : {}),
        observedPersonalRefOid: source.comparison.mainOid,
        reporterMemberId: memberId,
      });
      const reportJson = JSON.stringify(report);
      await scope.putDevelopmentBootstrapReport({
        attemptId: source.attemptId,
        capturedAt: report.capturedAt,
        createdAt: NOW,
        reportJson,
        reportSha256: sha256(reportJson),
        reporterMemberId: memberId,
      });
    }
    await scope.putDevelopmentBootstrapUpload({
      attemptId: source.attemptId,
      byteCount: repository.bundleByteCount,
      createdAt: NOW,
      sha256: repository.bundleSha256,
      stagingArtifactKey: repository.artifactKey,
      validationMarkerSha256: repository.markerSha256,
    });
    await scope.transitionDevelopmentBootstrapAttempt({
      attemptId: source.attemptId,
      expectedBundleState: 'uploaded',
      expectedState: 'collecting',
      nextBundleState: 'uploaded',
      nextState: 'validating',
      updatedAt: NOW,
    });
    await scope.transitionDevelopmentBootstrapAttempt({
      attemptId: source.attemptId,
      expectedBundleState: 'uploaded',
      expectedState: 'validating',
      nextBundleState: 'validated',
      nextState: 'ready',
      updatedAt: NOW,
    });
  });
}

describe('Project activation restart recovery', () => {
  it('settles the exact result after process death at every durable phase and filesystem effect', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
      const authorityRoot = await mkdtemp(join(tmpdir(), 'claudian-activation-'));
      const stagingRoot = join(authorityRoot, 'staging');
      const repositoryRoot = join(authorityRoot, 'repositories');
      await Promise.all([mkdir(stagingRoot), mkdir(repositoryRoot)]);
      const source = await sourceFixture(authorityRoot);
      const store = coordination(database);
      const uploadAdmission = new BootstrapUploadAdmission({
        maxConcurrentUploads: 1,
        maxUploadsPerAttempt: 1,
        queueMax: 2,
        queueTimeoutMs: 1_000,
        stagingFreeSpaceFloorBytes: 1,
        stagingReservationBytes: 2 * 1024 * 1024,
        stagingRoot,
      });
      const resourceAdmission = new ResourceAdmission({
        maxChildren: 2,
        maxChildrenPerProject: 1,
        queueMax: 2,
        queueMaxPerProject: 1,
        queueTimeoutMs: 1_000,
      });
      const importer = new GitBundleImporter({
        gitExecutable: GIT,
        maximumBlobBytes: 1024 * 1024,
        maximumBundleBytes: 1024 * 1024,
        maximumExpandedTreeEntries: 100_000,
        maximumMetadataOutputBytes: 8 * 1024 * 1024,
        maximumRepositoryBytes: 2 * 1024 * 1024,
        maximumTreeEntries: 2_000,
        operationTimeoutMs: 5_000,
        resourceAdmission,
        stagingRoot,
        uploadAdmission,
        uploadIdleTimeoutMs: 1_000,
        uploadTotalTimeoutMs: 5_000,
      });
      const repositoryIntegrity = new BootstrapRepositoryIntegrityVerifier({
        gitExecutable: GIT,
        operationTimeoutMs: 5_000,
        outputMaxBytes: 8 * 1024 * 1024,
        resourceAdmission,
      });
      const publication = new RepositoryPublication({
        integrityVerifier: repositoryIntegrity,
        repositoryRoot,
        stagingRoot,
        storageNodeId: 'node_fault',
      });
      try {
        const repository = await importer.importBundle({
          attemptId: source.manifest.attemptId,
          body: createReadStream(source.bundlePath),
          contentEncoding: 'identity',
          contentLength: source.manifest.git.bundle.byteCount,
          contentType: 'application/x-git-bundle',
          declaredByteCount: source.manifest.git.bundle.byteCount,
          declaredSha256: source.manifest.git.bundle.sha256,
          expectedByteCount: source.manifest.git.bundle.byteCount,
          expectedSha256: source.manifest.git.bundle.sha256,
          objectFormat: source.manifest.git.objectFormat,
          projectId: source.manifest.comparison.projectId,
          refs: source.manifest.git.refs,
        });
        await seedReadyAttempt(store, source.manifest, repository);
        const controller = new FaultController();
        const createCoordinator = () => new ProjectActivationCoordinator({
          attemptCleaner: importer,
          clock: () => new Date(NOW),
          coordination: new FaultCoordination(store, controller),
          operationIdFactory: kind => `${kind}_fault`,
          publication: new FaultPublication(publication, controller),
          repositoryStorageKeyFactory: () => 'repo_fault',
          uploadGate: new DevelopmentBootstrapUploadGate(),
        });
        const input = {
          actorId: 'member_a',
          attemptId: source.manifest.attemptId,
          manifestSha256: sha256(
            encodeDevelopmentBootstrapManifestCanonicalJson(source.manifest),
          ),
          projectId: source.manifest.comparison.projectId,
        } as const;
        const checkpoints = [
          'sql:publish-intent',
          'fs:prepare',
          'fs:publish',
          'sql:repository-published',
          'sql:activated',
          'fs:cleanup',
          'sql:completed',
        ];
        for (const [index, point] of checkpoints.entries()) {
          if (index > 0 && point !== 'sql:completed') {
            const candidates = (await store.listRecoveryCandidates()).candidates;
            assert.equal(candidates.length, 1, `candidate before ${point}`);
            const candidate = candidates[0];
            assert.ok(candidate);
            await store.withProjectScope(candidate.projectId, async scope => {
              const attempt = await scope.getDevelopmentBootstrapRecoveryAttempt(
                candidate.operationId,
              );
              assert.ok(
                attempt,
                `attempt before ${point}`,
              );
              if (point === 'fs:prepare') {
                assert.ok(attempt.upload);
                assert.ok(attempt.settlement);
                const manifestJson = encodeDevelopmentBootstrapManifestCanonicalJson(
                  source.manifest,
                );
                assert.equal(attempt.manifestJson, manifestJson);
                assert.equal(attempt.manifestSha256, sha256(manifestJson));
                assert.equal(attempt.attemptId, source.manifest.attemptId);
                assert.equal(attempt.projectId, source.manifest.comparison.projectId);
                assert.equal(
                  attempt.sourceHostMemberId,
                  source.manifest.comparison.sourceHostMemberId,
                );
                assert.equal(attempt.bundleState, 'validated');
                assert.equal(attempt.upload.state, 'validated');
                assert.equal(
                  attempt.upload.byteCount,
                  source.manifest.git.bundle.byteCount,
                );
                assert.equal(
                  attempt.upload.sha256,
                  source.manifest.git.bundle.sha256,
                );
                assert.match(attempt.upload.validationMarkerSha256, /^[0-9a-f]{64}$/u);
                assert.equal(
                  attempt.upload.stagingArtifactKey,
                  sha256(`${attempt.projectId}\0${attempt.attemptId}`),
                );
                assert.equal(attempt.reports.length, 2);
                for (const [reportIndex, stored] of attempt.reports.entries()) {
                  const decoded = decodeDevelopmentBootstrapReport(
                    JSON.parse(stored.reportJson),
                  );
                  assert.equal(
                    stored.reporterMemberId,
                    ['member_a', 'member_b'][reportIndex],
                  );
                  assert.equal(stored.reporterMemberId, decoded.reporterMemberId);
                  assert.equal(stored.reportJson, JSON.stringify(decoded));
                  assert.equal(stored.reportSha256, sha256(stored.reportJson));
                  assert.equal(stored.capturedAt, decoded.capturedAt);
                  assert.deepEqual(decoded.comparison, source.manifest.comparison);
                  assert.equal(decoded.attemptId, attempt.attemptId);
                  assert.equal(
                    decoded.observedPersonalRefOid,
                    source.manifest.git.refs.find(ref => (
                      ref.name === source.manifest.comparison.members.find(
                        member => member.memberId === decoded.reporterMemberId,
                      )?.personalRef
                    ))?.oid,
                  );
                  if (decoded.reporterMemberId === attempt.sourceHostMemberId) {
                    assert.equal(
                      decoded.hostStopAttestation?.manifestSha256,
                      attempt.manifestSha256,
                    );
                  }
                }
                const journal = decodeDevelopmentBootstrapJournalJson(
                  attempt.settlement.journalJson,
                );
                assert.equal(journal.kind, 'activation');
                assert.deepEqual(publication.plan({
                  generation: 1,
                  repository: {
                    artifactKey: attempt.upload.stagingArtifactKey,
                    attemptId: attempt.attemptId,
                    bundleByteCount: attempt.upload.byteCount,
                    bundleSha256: attempt.upload.sha256,
                    markerSha256: attempt.upload.validationMarkerSha256,
                    objectFormat: source.manifest.git.objectFormat,
                    projectId: attempt.projectId,
                    refs: source.manifest.git.refs,
                  },
                  repositoryStorageKey: journal.publication.repositoryStorageKey,
                }), journal.publication);
              }
            });
          }
          controller.target = point;
          const coordinator = createCoordinator();
          const operation = index === 0
            ? coordinator.activate(input)
            : coordinator.recoverAll();
          const failure = await operation.then(
            () => undefined,
            (error: unknown) => error,
          );
          assert.ok(
            failure !== undefined,
            `${point}; seen ${controller.seen.join(',')}`,
          );
          assert.ok(failure instanceof ProjectActivationCoordinatorError);
          assert.equal(failure.code, 'dependency-failed');
          await coordinator.close();
          assert.equal(controller.target, undefined);
        }

        const recovered = createCoordinator();
        await recovered.recoverAll();
        await recovered.activate(input);
        assert.deepEqual(await recovered.getActivationResult(input), {
          activatedAt: NOW,
          activationOperationId: 'activation_fault',
          placementGeneration: 1,
          projectId: 'project_fault',
        });
        await store.withProjectScope('project_fault', async scope => {
          assert.equal((await scope.getProject())?.serviceState, 'active');
          assert.equal((await scope.getRepositoryPlacement())?.generation, 1);
          const attempt = await scope.getDevelopmentBootstrapAttempt('attempt_fault');
          assert.equal(
            attempt?.settlement?.kind === 'activation'
              ? attempt.settlement.activationPhase
              : undefined,
            'completed',
          );
        });
        assert.deepEqual((await store.listRecoveryCandidates()).candidates, []);
        const admission = new ProjectWriteAdmission({
          coordination: store,
          recovery: recovered,
        });
        assert.equal(await admission.run(
          createDevelopmentPrincipal('member_a'),
          'project_fault',
          async write => {
            assert.equal(write.memberId, 'member_a');
            assert.equal(write.role, 'manager');
            assert.equal(write.expectedMainOid, source.manifest.comparison.mainOid);
            assert.equal(write.placement.repositoryStorageKey, 'repo_fault');
            await write.revalidate();
            return 'admitted';
          },
        ), 'admitted');
        await assert.rejects(admission.run(
          createDevelopmentPrincipal('member_outsider'),
          'project_fault',
          () => Promise.resolve(),
        ), error => {
          assert.ok(error instanceof ProjectWriteAdmissionError);
          assert.equal(error.code, 'authorization-denied');
          return true;
        });
        await admission.close();
        await recovered.close();

        await store.withProjectScope('project_cancel', scope => (
          scope.putDevelopmentBootstrapAttempt({
            attemptId: 'attempt_cancel',
            createdAt: NOW,
            expiresAt: EXPIRES,
            manifestJson: '{"kind":"cancellation-fixture"}',
            manifestSha256: sha256('{"kind":"cancellation-fixture"}'),
            projectId: 'project_cancel',
            sourceHostMemberId: 'member_a',
          })
        ));
        await assert.rejects(importer.importBundle({
          attemptId: 'attempt_cancel',
          body: (async function* body(): AsyncGenerator<Uint8Array> {
            await Promise.resolve();
            yield Buffer.from('incomplete');
          })(),
          contentEncoding: 'identity',
          contentType: 'application/x-git-bundle',
          declaredByteCount: source.manifest.git.bundle.byteCount,
          declaredSha256: source.manifest.git.bundle.sha256,
          expectedByteCount: source.manifest.git.bundle.byteCount,
          expectedSha256: source.manifest.git.bundle.sha256,
          objectFormat: source.manifest.git.objectFormat,
          projectId: 'project_cancel',
          refs: source.manifest.git.refs,
        }));
        const createCancellationCoordinator = () => (
          new ProjectActivationCoordinator({
            attemptCleaner: new FaultCleaner(importer, controller),
            clock: () => new Date(NOW),
            coordination: new FaultCoordination(store, controller),
            operationIdFactory: kind => `${kind}_fault`,
            publication: new FaultPublication(publication, controller),
            uploadGate: new DevelopmentBootstrapUploadGate(),
          })
        );
        for (const [index, point] of [
          'sql:cancel-intent',
          'fs:discard',
          'sql:cancelled',
        ].entries()) {
          controller.target = point;
          const coordinator = createCancellationCoordinator();
          const operation = index === 0
            ? coordinator.cancel({
              actorId: 'member_a',
              attemptId: 'attempt_cancel',
              projectId: 'project_cancel',
            })
            : coordinator.recoverAll();
          await assert.rejects(operation, error => {
            assert.ok(error instanceof ProjectActivationCoordinatorError);
            assert.equal(error.code, 'dependency-failed');
            return true;
          }, point);
          await coordinator.close();
          assert.equal(controller.target, undefined);
        }
        const cancellationRecovered = createCancellationCoordinator();
        await cancellationRecovered.recoverAll();
        await cancellationRecovered.cancel({
          actorId: 'member_a',
          attemptId: 'attempt_cancel',
          projectId: 'project_cancel',
        });
        await store.withProjectScope('project_cancel', async scope => {
          const attempt = await scope.getDevelopmentBootstrapAttempt('attempt_cancel');
          assert.ok(attempt);
          assert.equal(attempt.state, 'cancelled');
          assert.equal(
            attempt.settlement?.kind === 'cancellation'
              ? attempt.settlement.cancellationPhase
              : undefined,
            'cancelled',
          );
        });
        await cancellationRecovered.close();
      } finally {
        publication.close();
        await repositoryIntegrity.close();
        await importer.close();
        await Promise.all([
          resourceAdmission.close(),
          uploadAdmission.close(),
        ]);
        await store.close();
        await rm(authorityRoot, { force: true, recursive: true });
      }
    });
  });
});
