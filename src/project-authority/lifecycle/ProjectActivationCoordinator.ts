import { createHash, randomUUID } from 'node:crypto';

import {
  decodeDevelopmentBootstrapManifest,
  decodeDevelopmentBootstrapReport,
  encodeDevelopmentBootstrapManifestCanonicalJson,
  isCollabOpaqueId,
  type CollabProjectId,
  type DevelopmentBootstrapActivationResult,
  type DevelopmentBootstrapManifest,
} from '@claudian/collab-protocol';

import {
  type DevelopmentBootstrapAttemptRecord,
  type RecoveryCandidateCatalog,
} from '../../coordination/DevelopmentBootstrapPersistence.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../coordination/ProjectCoordination.js';
import {
  GitBundleImportError,
  type DiscardBootstrapAttemptInput,
  type ValidatedBootstrapRepository,
} from '../../repositories/GitBundleImporter.js';
import {
  RepositoryPublicationError,
  type PrepareRepositoryPublicationInput,
  type PreparedRepositoryPublication,
  type RepositoryPublicationObservation,
} from '../../repositories/RepositoryPublication.js';
import {
  decodeDevelopmentBootstrapJournalJson,
  encodeDevelopmentBootstrapJournal,
  type DevelopmentBootstrapActivationJournal,
  type DevelopmentBootstrapCancellationJournal,
} from './DevelopmentBootstrapJournal.js';
import type { DevelopmentBootstrapUploadGate } from './DevelopmentBootstrapUploadGate.js';

export type ProjectActivationCoordinatorErrorCode =
  | 'closed'
  | 'dependency-failed'
  | 'recovery-required'
  | 'state-conflict';

export class ProjectActivationCoordinatorError extends Error {
  readonly code: ProjectActivationCoordinatorErrorCode;

  constructor(code: ProjectActivationCoordinatorErrorCode) {
    super(`project-activation-coordinator.error.${code}`);
    this.name = 'ProjectActivationCoordinatorError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
    });
  }
}

export interface ProjectActivationCoordination extends RecoveryCandidateCatalog {
  acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
}

export interface ProjectActivationRepositoryPublication {
  cleanupAttempt(
    publication: PreparedRepositoryPublication,
  ): Promise<'cleaned' | 'replayed'>;
  inspect(
    publication: PreparedRepositoryPublication,
  ): Promise<RepositoryPublicationObservation>;
  plan(input: PrepareRepositoryPublicationInput): PreparedRepositoryPublication;
  prepare(
    input: PrepareRepositoryPublicationInput,
  ): Promise<PreparedRepositoryPublication>;
  publish(
    publication: PreparedRepositoryPublication,
  ): Promise<Readonly<{
    publication: PreparedRepositoryPublication;
    status: 'published' | 'replayed';
  }>>;
}

export interface ProjectActivationAttemptCleaner {
  abortAttempt(input: DiscardBootstrapAttemptInput): Promise<void>;
  discardAttempt(
    input: DiscardBootstrapAttemptInput,
  ): Promise<'removed' | 'replayed'>;
}

export interface ProjectActivationCoordinatorOptions {
  readonly attemptCleaner: ProjectActivationAttemptCleaner;
  readonly clock?: () => Date;
  readonly coordination: ProjectActivationCoordination;
  readonly operationIdFactory?: (kind: 'activation' | 'cancellation') => string;
  readonly publication: ProjectActivationRepositoryPublication;
  readonly repositoryStorageKeyFactory?: (projectId: CollabProjectId) => string;
  readonly uploadGate: DevelopmentBootstrapUploadGate;
}

export interface ActivateProjectBootstrapInput {
  readonly actorId: string;
  readonly attemptId: string;
  readonly manifestSha256: string;
  readonly projectId: CollabProjectId;
}

export interface CancelProjectBootstrapInput {
  readonly actorId: string;
  readonly attemptId: string;
  readonly projectId: CollabProjectId;
}

export interface ExpireProjectBootstrapInput {
  readonly attemptId: string;
  readonly projectId: CollabProjectId;
}

interface ValidatedAttemptFacts {
  readonly manifest: DevelopmentBootstrapManifest;
  readonly repository: ValidatedBootstrapRepository;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function fail(code: ProjectActivationCoordinatorErrorCode): never {
  throw new ProjectActivationCoordinatorError(code);
}

function now(clock: () => Date): string {
  const value = clock();
  if (Number.isNaN(value.valueOf())) return fail('dependency-failed');
  return value.toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function defaultOperationId(kind: 'activation' | 'cancellation'): string {
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

function defaultRepositoryStorageKey(projectId: CollabProjectId): string {
  return `repo_${sha256(projectId).slice(0, 48)}`;
}

function exactPublication(
  left: PreparedRepositoryPublication,
  right: PreparedRepositoryPublication,
): boolean {
  return left.artifactKey === right.artifactKey
    && left.attemptId === right.attemptId
    && left.markerSha256 === right.markerSha256
    && left.objectFormat === right.objectFormat
    && left.projectId === right.projectId
    && sameJson(left.refs, right.refs)
    && left.publicationMarkerSha256 === right.publicationMarkerSha256
    && left.repositoryStorageKey === right.repositoryStorageKey
    && left.storageNodeId === right.storageNodeId
    && left.validationMarkerSha256 === right.validationMarkerSha256;
}

function isClassifiableRepositoryFailure(error: unknown): boolean {
  return error instanceof RepositoryPublicationError
    && [
      'ambiguous-state',
      'invalid-publication',
      'marker-conflict',
      'missing-state',
      'repository-invalid',
    ].includes(error.code);
}

function dependency(error: unknown): never {
  if (
    error instanceof ProjectActivationCoordinatorError
    || error instanceof CoordinationError
    || error instanceof RepositoryPublicationError
    || error instanceof GitBundleImportError
  ) {
    if (error.code === 'closed') return fail('closed');
  }
  return fail('dependency-failed');
}

function validatedAttempt(record: DevelopmentBootstrapAttemptRecord): ValidatedAttemptFacts {
  let manifest: DevelopmentBootstrapManifest;
  try {
    manifest = decodeDevelopmentBootstrapManifest(JSON.parse(record.manifestJson));
  } catch {
    return fail('recovery-required');
  }
  const manifestJson = encodeDevelopmentBootstrapManifestCanonicalJson(manifest);
  const upload = record.upload;
  if (
    manifestJson !== record.manifestJson
    || sha256(manifestJson) !== record.manifestSha256
    || manifest.attemptId !== record.attemptId
    || manifest.comparison.projectId !== record.projectId
    || manifest.comparison.sourceHostMemberId !== record.sourceHostMemberId
    || record.bundleState !== 'validated'
    || upload?.state !== 'validated'
    || upload.byteCount !== manifest.git.bundle.byteCount
    || upload.sha256 !== manifest.git.bundle.sha256
    || upload.stagingArtifactKey !== sha256(`${record.projectId}\0${record.attemptId}`)
    || !SHA256_PATTERN.test(upload.validationMarkerSha256)
    || record.reports.length !== 2
  ) {
    return fail('recovery-required');
  }
  const expectedReporters = manifest.comparison.members
    .map(member => member.memberId)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  const storedReports = [...record.reports].sort((left, right) => (
    left.reporterMemberId.localeCompare(right.reporterMemberId, 'en-US')
  ));
  for (const [index, stored] of storedReports.entries()) {
    let report;
    try {
      report = decodeDevelopmentBootstrapReport(JSON.parse(stored.reportJson));
    } catch {
      return fail('recovery-required');
    }
    const reportJson = JSON.stringify(report);
    const member = manifest.comparison.members.find(
      candidate => candidate.memberId === report.reporterMemberId,
    );
    const ref = manifest.git.refs.find(candidate => candidate.name === member?.personalRef);
    if (
      stored.reporterMemberId !== expectedReporters[index]
      || stored.reporterMemberId !== report.reporterMemberId
      || stored.reportJson !== reportJson
      || stored.reportSha256 !== sha256(reportJson)
      || stored.capturedAt !== report.capturedAt
      || report.attemptId !== record.attemptId
      || !sameJson(report.comparison, manifest.comparison)
      || ref?.oid !== report.observedPersonalRefOid
      || (report.reporterMemberId === record.sourceHostMemberId
        && report.hostStopAttestation?.manifestSha256 !== record.manifestSha256)
    ) {
      return fail('recovery-required');
    }
  }
  return Object.freeze({
    manifest,
    repository: Object.freeze({
      artifactKey: upload.stagingArtifactKey,
      attemptId: record.attemptId,
      bundleByteCount: upload.byteCount,
      bundleSha256: upload.sha256,
      markerSha256: upload.validationMarkerSha256,
      objectFormat: manifest.git.objectFormat,
      projectId: record.projectId,
      refs: manifest.git.refs,
    }),
  });
}

function requireAttempt(
  attempt: DevelopmentBootstrapAttemptRecord | undefined,
): DevelopmentBootstrapAttemptRecord {
  if (attempt === undefined) return fail('state-conflict');
  return attempt;
}

export class ProjectActivationCoordinator {
  readonly #attemptCleaner: ProjectActivationAttemptCleaner;
  readonly #clock: () => Date;
  readonly #coordination: ProjectActivationCoordination;
  readonly #operationIdFactory: (kind: 'activation' | 'cancellation') => string;
  readonly #publication: ProjectActivationRepositoryPublication;
  readonly #repositoryStorageKeyFactory: (projectId: CollabProjectId) => string;
  readonly #uploadGate: DevelopmentBootstrapUploadGate;
  readonly #running = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: ProjectActivationCoordinatorOptions) {
    this.#attemptCleaner = options.attemptCleaner;
    this.#clock = options.clock ?? (() => new Date());
    this.#coordination = options.coordination;
    this.#operationIdFactory = options.operationIdFactory ?? defaultOperationId;
    this.#publication = options.publication;
    this.#repositoryStorageKeyFactory = options.repositoryStorageKeyFactory
      ?? defaultRepositoryStorageKey;
    this.#uploadGate = options.uploadGate;
  }

  activate(input: ActivateProjectBootstrapInput): Promise<void> {
    return this.#run(input.projectId, lease => this.#activate(lease, input));
  }

  cancel(input: CancelProjectBootstrapInput): Promise<void> {
    return this.#run(input.projectId, lease => this.#cancel(lease, {
      actorId: input.actorId,
      attemptId: input.attemptId,
      projectId: input.projectId,
      reason: 'requested',
    }));
  }

  expire(input: ExpireProjectBootstrapInput): Promise<void> {
    return this.#run(input.projectId, lease => this.#cancel(lease, {
      attemptId: input.attemptId,
      projectId: input.projectId,
      reason: 'expired',
    }));
  }

  getActivationResult(
    input: Readonly<{ attemptId: string; projectId: CollabProjectId }>,
  ): Promise<DevelopmentBootstrapActivationResult | undefined> {
    return this.#run(input.projectId, async lease => {
      const attempt = await lease.withProjectScope(
        scope => scope.getDevelopmentBootstrapAttempt(input.attemptId),
      );
      if (attempt?.settlement?.kind !== 'activation') return undefined;
      if (
        attempt.settlement.activationPhase !== 'activated'
        && attempt.settlement.activationPhase !== 'completed'
      ) {
        return undefined;
      }
      const journal = this.#activationJournal(attempt);
      return journal.activationResult;
    });
  }

  recoverProject(projectId: CollabProjectId): Promise<void> {
    return this.#run(projectId, async lease => {
      const attempt = await lease.withProjectScope(
        scope => scope.getNonterminalDevelopmentBootstrapAttempt(),
      );
      if (attempt === undefined) return;
      await this.#recoverAttempt(lease, attempt);
    });
  }

  async recoverAll(): Promise<void> {
    let after;
    for (;;) {
      let page;
      try {
        page = await this.#coordination.listRecoveryCandidates(
          after === undefined ? undefined : { after },
        );
      } catch (error: unknown) {
        return dependency(error);
      }
      for (const candidate of page.candidates) {
        if (candidate.kind !== 'activation') return fail('dependency-failed');
        try {
          await this.#run(candidate.projectId, async lease => {
            const attempt = await lease.withProjectScope(
              scope => scope.getDevelopmentBootstrapRecoveryAttempt(
                candidate.operationId,
              ),
            );
            if (attempt !== undefined) await this.#recoverAttempt(lease, attempt);
          });
        } catch (error: unknown) {
          if (
            error instanceof ProjectActivationCoordinatorError
            && error.code === 'recovery-required'
          ) {
            continue;
          }
          throw error;
        }
      }
      if (page.nextCursor === undefined) return;
      after = page.nextCursor;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = Promise.allSettled([...this.#running]).then(() => undefined);
    }
    return this.#closePromise;
  }

  async #activate(
    lease: PinnedProjectLease,
    input: ActivateProjectBootstrapInput,
  ): Promise<void> {
    let attempt = requireAttempt(await lease.withProjectScope(
      scope => scope.getDevelopmentBootstrapAttempt(input.attemptId),
    ));
    if (attempt.projectId !== input.projectId) return fail('state-conflict');
    if (attempt.settlement === undefined) {
      if (attempt.state !== 'ready') return fail('state-conflict');
      const facts = validatedAttempt(attempt);
      if (
        input.actorId !== facts.manifest.comparison.sourceHostMemberId
        || input.manifestSha256 !== attempt.manifestSha256
      ) {
        return fail('state-conflict');
      }
      const operationId = this.#newOperationId('activation');
      const activatedAt = now(this.#clock);
      const publicationInput = this.#publicationInput(
        facts,
        this.#repositoryStorageKeyFactory(input.projectId),
      );
      const publication = this.#publication.plan(publicationInput);
      const journal: DevelopmentBootstrapActivationJournal = Object.freeze({
        activationResult: Object.freeze({
          activatedAt,
          activationOperationId: operationId,
          placementGeneration: 1,
          projectId: input.projectId,
        }),
        actorId: input.actorId,
        attemptId: input.attemptId,
        kind: 'activation',
        manifestSha256: input.manifestSha256,
        projectId: input.projectId,
        publication,
        schemaVersion: 1,
      });
      await lease.withProjectScope(scope => scope.beginDevelopmentBootstrapActivation({
        attemptId: input.attemptId,
        journalJson: encodeDevelopmentBootstrapJournal(journal),
        operationId,
        scheduledAt: activatedAt,
      }));
      attempt = requireAttempt(await lease.withProjectScope(
        scope => scope.getDevelopmentBootstrapAttempt(input.attemptId),
      ));
    }
    let journal: DevelopmentBootstrapActivationJournal;
    try {
      journal = this.#activationJournal(attempt);
    } catch (error: unknown) {
      if (
        error instanceof ProjectActivationCoordinatorError
        && error.code === 'recovery-required'
      ) {
        await this.#classifyActivation(lease, attempt);
      }
      throw error;
    }
    if (
      journal.actorId !== input.actorId
      || journal.manifestSha256 !== input.manifestSha256
    ) {
      return fail('state-conflict');
    }
    await this.#settleActivation(lease, attempt, journal);
  }

  async #settleActivation(
    lease: PinnedProjectLease,
    initial: DevelopmentBootstrapAttemptRecord,
    journal: DevelopmentBootstrapActivationJournal,
  ): Promise<void> {
    await this.#closeUploadLane(lease, initial);
    let attempt = initial;
    for (;;) {
      if (attempt.state === 'recovery-required') return fail('recovery-required');
      const settlement = attempt.settlement;
      if (settlement?.kind !== 'activation') return fail('state-conflict');
      const phase = settlement.activationPhase;
      try {
        const facts = validatedAttempt(attempt);
        const publicationInput = this.#publicationInput(
          facts,
          journal.publication.repositoryStorageKey,
        );
        const planned = this.#publication.plan(publicationInput);
        if (!exactPublication(planned, journal.publication)) {
          return await this.#classifyActivation(lease, attempt);
        }
        if (phase === 'publish-intent') {
          const prepared = await this.#publication.prepare(publicationInput);
          if (!exactPublication(prepared, journal.publication)) {
            return await this.#classifyActivation(lease, attempt);
          }
          const published = await this.#publication.publish(journal.publication);
          if (!exactPublication(published.publication, journal.publication)) {
            return await this.#classifyActivation(lease, attempt);
          }
          await lease.withProjectScope(scope => (
            scope.advanceDevelopmentBootstrapActivation({
              attemptId: attempt.attemptId,
              expectedPhase: 'publish-intent',
              nextPhase: 'repository-published',
              updatedAt: now(this.#clock),
            })
          ));
        } else if (phase === 'repository-published') {
          await this.#assertPublished(journal.publication);
          const activation = this.#projectActivation(facts, journal);
          await lease.withProjectScope(async scope => {
            await scope.insertActivatedDevelopmentProject(activation);
            await scope.advanceDevelopmentBootstrapActivation({
              attemptId: attempt.attemptId,
              expectedPhase: 'repository-published',
              nextPhase: 'activated',
              updatedAt: now(this.#clock),
            });
          });
        } else if (phase === 'activated') {
          await this.#assertPublished(journal.publication);
          await lease.withProjectScope(scope => (
            scope.insertActivatedDevelopmentProject(
              this.#projectActivation(facts, journal),
            )
          ));
          await this.#publication.cleanupAttempt(journal.publication);
          await lease.withProjectScope(scope => (
            scope.advanceDevelopmentBootstrapActivation({
              attemptId: attempt.attemptId,
              expectedPhase: 'activated',
              nextPhase: 'completed',
              updatedAt: now(this.#clock),
            })
          ));
        } else {
          await this.#assertPublished(journal.publication);
          await lease.withProjectScope(scope => (
            scope.insertActivatedDevelopmentProject(
              this.#projectActivation(facts, journal),
            )
          ));
          await this.#publication.cleanupAttempt(journal.publication);
          return;
        }
      } catch (error: unknown) {
        if (
          isClassifiableRepositoryFailure(error)
          || (error instanceof ProjectActivationCoordinatorError
            && error.code === 'recovery-required')
        ) {
          return this.#classifyActivation(lease, attempt);
        }
        if (
          error instanceof CoordinationError
          && ['invalid-record', 'state-conflict'].includes(error.code)
        ) {
          return this.#classifyActivation(lease, attempt);
        }
        throw error;
      }
      attempt = requireAttempt(await lease.withProjectScope(
        scope => scope.getDevelopmentBootstrapAttempt(attempt.attemptId),
      ));
    }
  }

  async #cancel(
    lease: PinnedProjectLease,
    input: Readonly<{
      actorId?: string;
      attemptId: string;
      projectId: CollabProjectId;
      reason: 'expired' | 'requested';
    }>,
  ): Promise<void> {
    let attempt = requireAttempt(await lease.withProjectScope(
      scope => scope.getDevelopmentBootstrapAttempt(input.attemptId),
    ));
    if (attempt.projectId !== input.projectId) return fail('state-conflict');
    if (attempt.settlement === undefined) {
      if (!['collecting', 'validating', 'ready', 'rejected'].includes(attempt.state)) {
        return fail('state-conflict');
      }
      const operationId = this.#newOperationId('cancellation');
      const scheduledAt = now(this.#clock);
      const journal: DevelopmentBootstrapCancellationJournal = Object.freeze({
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        attemptId: input.attemptId,
        kind: 'cancellation',
        projectId: input.projectId,
        reason: input.reason,
        schemaVersion: 1,
      });
      await lease.withProjectScope(scope => scope.beginDevelopmentBootstrapCancellation({
        attemptId: input.attemptId,
        expectedState: attempt.state,
        journalJson: encodeDevelopmentBootstrapJournal(journal),
        operationId,
        scheduledAt,
      }));
      attempt = requireAttempt(await lease.withProjectScope(
        scope => scope.getDevelopmentBootstrapAttempt(input.attemptId),
      ));
    }
    if (attempt.settlement?.kind !== 'cancellation') return fail('state-conflict');
    await this.#closeUploadLane(lease, attempt);
    let journal: DevelopmentBootstrapCancellationJournal;
    try {
      journal = this.#cancellationJournal(attempt);
    } catch (error: unknown) {
      if (
        error instanceof ProjectActivationCoordinatorError
        && error.code === 'recovery-required'
      ) {
        await this.#classifyCancellation(lease, attempt);
      }
      throw error;
    }
    if (
      journal.projectId !== input.projectId
      || journal.attemptId !== input.attemptId
      || (input.actorId !== undefined && journal.actorId !== input.actorId)
    ) {
      return fail('state-conflict');
    }
    if (attempt.settlement.cancellationPhase === 'recovery-required') return;
    if (attempt.settlement.cancellationPhase === 'cancelled') return;
    try {
      await this.#attemptCleaner.discardAttempt({
        attemptId: attempt.attemptId,
        projectId: attempt.projectId,
      });
    } catch (error: unknown) {
      if (error instanceof GitBundleImportError && error.code === 'artifact-conflict') {
        await lease.withProjectScope(scope => (
          scope.advanceDevelopmentBootstrapCancellation({
            attemptId: attempt.attemptId,
            expectedPhase: 'cancel-intent',
            nextPhase: 'recovery-required',
            updatedAt: now(this.#clock),
          })
        ));
        return;
      }
      throw error;
    }
    await lease.withProjectScope(scope => (
      scope.advanceDevelopmentBootstrapCancellation({
        attemptId: attempt.attemptId,
        expectedPhase: 'cancel-intent',
        nextPhase: 'cancelled',
        updatedAt: now(this.#clock),
      })
    ));
  }

  async #recoverAttempt(
    lease: PinnedProjectLease,
    attempt: DevelopmentBootstrapAttemptRecord,
  ): Promise<void> {
    if (attempt.state === 'recovery-required') return fail('recovery-required');
    if (attempt.settlement?.kind === 'activation') {
      let journal: DevelopmentBootstrapActivationJournal;
      try {
        journal = this.#activationJournal(attempt);
      } catch (error: unknown) {
        if (
          error instanceof ProjectActivationCoordinatorError
          && error.code === 'recovery-required'
        ) {
          await this.#classifyActivation(lease, attempt);
        }
        throw error;
      }
      await this.#settleActivation(
        lease,
        attempt,
        journal,
      );
      return;
    }
    if (attempt.settlement?.kind === 'cancellation') {
      let journal: DevelopmentBootstrapCancellationJournal;
      try {
        journal = this.#cancellationJournal(attempt);
      } catch (error: unknown) {
        if (
          error instanceof ProjectActivationCoordinatorError
          && error.code === 'recovery-required'
        ) {
          await this.#classifyCancellation(lease, attempt);
        }
        throw error;
      }
      await this.#cancel(lease, {
        ...(journal.actorId === undefined ? {} : { actorId: journal.actorId }),
        attemptId: journal.attemptId,
        projectId: journal.projectId,
        reason: journal.reason,
      });
      return;
    }
    return fail('state-conflict');
  }

  async #closeUploadLane(
    lease: PinnedProjectLease,
    attempt: DevelopmentBootstrapAttemptRecord,
  ): Promise<void> {
    const drained = this.#uploadGate.closeAndDrain(attempt.attemptId);
    await Promise.all([
      this.#attemptCleaner.abortAttempt({
        attemptId: attempt.attemptId,
        projectId: attempt.projectId,
      }),
      drained,
    ]);
    await lease.drainDevelopmentBootstrapUploads(attempt.attemptId);
  }

  #activationJournal(
    attempt: DevelopmentBootstrapAttemptRecord,
  ): DevelopmentBootstrapActivationJournal {
    if (attempt.settlement?.kind !== 'activation') return fail('state-conflict');
    let journal;
    try {
      journal = decodeDevelopmentBootstrapJournalJson(attempt.settlement.journalJson);
    } catch {
      return fail('recovery-required');
    }
    if (
      journal.kind !== 'activation'
      || journal.attemptId !== attempt.attemptId
      || journal.projectId !== attempt.projectId
      || journal.activationResult.activationOperationId
        !== attempt.settlement.operationId
    ) {
      return fail('recovery-required');
    }
    return journal;
  }

  #cancellationJournal(
    attempt: DevelopmentBootstrapAttemptRecord,
  ): DevelopmentBootstrapCancellationJournal {
    if (attempt.settlement?.kind !== 'cancellation') return fail('state-conflict');
    let journal;
    try {
      journal = decodeDevelopmentBootstrapJournalJson(attempt.settlement.journalJson);
    } catch {
      return fail('recovery-required');
    }
    if (
      journal.kind !== 'cancellation'
      || journal.attemptId !== attempt.attemptId
      || journal.projectId !== attempt.projectId
    ) {
      return fail('recovery-required');
    }
    return journal;
  }

  async #classifyActivation(
    lease: PinnedProjectLease,
    attempt: DevelopmentBootstrapAttemptRecord,
  ): Promise<void> {
    if (attempt.settlement?.kind !== 'activation') return fail('recovery-required');
    await lease.withProjectScope(scope => (
      scope.markDevelopmentBootstrapActivationRecoveryRequired({
        attemptId: attempt.attemptId,
        expectedPhase: attempt.settlement?.kind === 'activation'
          ? attempt.settlement.activationPhase
          : 'publish-intent',
        updatedAt: now(this.#clock),
      })
    ));
  }

  async #classifyCancellation(
    lease: PinnedProjectLease,
    attempt: DevelopmentBootstrapAttemptRecord,
  ): Promise<void> {
    if (
      attempt.settlement?.kind !== 'cancellation'
      || attempt.settlement.cancellationPhase !== 'cancel-intent'
    ) {
      return fail('recovery-required');
    }
    await lease.withProjectScope(scope => (
      scope.advanceDevelopmentBootstrapCancellation({
        attemptId: attempt.attemptId,
        expectedPhase: 'cancel-intent',
        nextPhase: 'recovery-required',
        updatedAt: now(this.#clock),
      })
    ));
  }

  async #assertPublished(publication: PreparedRepositoryPublication): Promise<void> {
    const observation = await this.#publication.inspect(publication);
    if (observation.state !== 'published') {
      throw new RepositoryPublicationError('ambiguous-state');
    }
  }

  #publicationInput(
    facts: ValidatedAttemptFacts,
    repositoryStorageKey: string,
  ): PrepareRepositoryPublicationInput {
    return Object.freeze({
      generation: 1,
      repository: facts.repository,
      repositoryStorageKey,
    });
  }

  #projectActivation(
    facts: ValidatedAttemptFacts,
    journal: DevelopmentBootstrapActivationJournal,
  ) {
    const comparison = facts.manifest.comparison;
    return Object.freeze({
      activatedAt: journal.activationResult.activatedAt,
      attemptId: journal.attemptId,
      expectedMainOid: comparison.mainOid,
      managerSetGeneration: 0,
      members: comparison.members.map(member => Object.freeze({
        activatedAt: member.activatedAt,
        createdAt: member.createdAt,
        displayName: member.displayName,
        memberId: member.memberId,
        role: member.role,
      })) as [
        {
          readonly activatedAt: string;
          readonly createdAt: string;
          readonly displayName: string;
          readonly memberId: string;
          readonly role: 'manager' | 'member';
        },
        {
          readonly activatedAt: string;
          readonly createdAt: string;
          readonly displayName: string;
          readonly memberId: string;
          readonly role: 'manager' | 'member';
        },
      ],
      projectCreatedAt: comparison.projectCreatedAt,
      projectName: comparison.projectName,
      repositoryStorageKey: journal.publication.repositoryStorageKey,
      storageNodeId: journal.publication.storageNodeId,
    });
  }

  #newOperationId(kind: 'activation' | 'cancellation'): string {
    const operationId = this.#operationIdFactory(kind);
    if (!isCollabOpaqueId(operationId)) return fail('dependency-failed');
    return operationId;
  }

  #run<T>(
    projectId: CollabProjectId,
    operation: (lease: PinnedProjectLease) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(
      new ProjectActivationCoordinatorError('closed'),
    );
    const running = (async () => {
      let lease: PinnedProjectLease | undefined;
      try {
        lease = await this.#coordination.acquireProjectLease(projectId);
        return await operation(lease);
      } catch (error: unknown) {
        if (
          error instanceof ProjectActivationCoordinatorError
          || error instanceof CoordinationError
          || error instanceof RepositoryPublicationError
          || error instanceof GitBundleImportError
        ) {
          throw error;
        }
        return dependency(error);
      } finally {
        if (lease !== undefined) await lease.close();
      }
    })();
    const tracked = running.then(() => undefined, () => undefined);
    this.#running.add(tracked);
    void tracked.finally(() => this.#running.delete(tracked));
    return running;
  }
}

export type ProjectActivationProjectScope = Pick<
  ProjectScope,
  | 'advanceDevelopmentBootstrapActivation'
  | 'advanceDevelopmentBootstrapCancellation'
  | 'beginDevelopmentBootstrapActivation'
  | 'beginDevelopmentBootstrapCancellation'
  | 'getDevelopmentBootstrapAttempt'
  | 'getDevelopmentBootstrapRecoveryAttempt'
  | 'getNonterminalDevelopmentBootstrapAttempt'
  | 'insertActivatedDevelopmentProject'
  | 'markDevelopmentBootstrapActivationRecoveryRequired'
>;
