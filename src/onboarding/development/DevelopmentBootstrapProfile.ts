import { createHash } from 'node:crypto';

import {
  COLLAB_CLOUD_BINDING_LIMITS,
  decodeDevelopmentBootstrapManifest,
  decodeDevelopmentBootstrapReport,
  encodeDevelopmentBootstrapManifestCanonicalJson,
  type ActivateDevelopmentBootstrapRequest,
  type BeginDevelopmentBootstrapRequest,
  type CancelDevelopmentBootstrapRequest,
  type CollabProjectId,
  type DevelopmentBootstrapActivationResult,
  type DevelopmentBootstrapAttemptStatus,
  type DevelopmentBootstrapManifest,
  type DevelopmentBootstrapReport,
  type GetDevelopmentBootstrapRequest,
  type SubmitDevelopmentBootstrapReportRequest,
} from '@claudian/collab-protocol';

import type {
  DevelopmentBootstrapAttemptInput,
  DevelopmentBootstrapAttemptLocator,
  DevelopmentBootstrapAttemptRecord,
  DevelopmentBootstrapAttemptTransition,
  DevelopmentBootstrapReportInput,
  DevelopmentBootstrapUploadInput,
  PersistenceAdvanceResult,
  PersistencePutResult,
} from '../../coordination/DevelopmentBootstrapPersistence.js';
import type { ProjectRecord } from '../../coordination/ProjectPersistence.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import {
  DevelopmentBootstrapUploadGateError,
  type DevelopmentBootstrapUploadGate,
  type DevelopmentBootstrapUploadLease as LocalDevelopmentBootstrapUploadLease,
} from '../../project-authority/lifecycle/DevelopmentBootstrapUploadGate.js';
import type {
  ImportGitBundleInput,
  ValidatedBootstrapRepository,
} from '../../repositories/GitBundleImporter.js';

export type DevelopmentBootstrapProfileErrorCode =
  | 'attempt-not-found'
  | 'authorization-denied'
  | 'closed'
  | 'comparison-mismatch'
  | 'dependency-failed'
  | 'host-stop-mismatch'
  | 'repository-mismatch'
  | 'state-conflict';

export class DevelopmentBootstrapProfileError extends Error {
  readonly code: DevelopmentBootstrapProfileErrorCode;

  constructor(code: DevelopmentBootstrapProfileErrorCode) {
    super(`development-bootstrap-profile.error.${code}`);
    this.name = 'DevelopmentBootstrapProfileError';
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

export interface DevelopmentBootstrapProfileScope {
  getActiveDevelopmentBootstrapAttempt(): Promise<
    DevelopmentBootstrapAttemptRecord | undefined
  >;
  getDevelopmentBootstrapAttempt(
    attemptId: string,
  ): Promise<DevelopmentBootstrapAttemptRecord | undefined>;
  getProject(): Promise<ProjectRecord | undefined>;
  putDevelopmentBootstrapAttempt(
    input: DevelopmentBootstrapAttemptInput,
  ): Promise<PersistencePutResult>;
  putDevelopmentBootstrapReport(
    input: DevelopmentBootstrapReportInput,
  ): Promise<PersistencePutResult>;
  putDevelopmentBootstrapUpload(
    input: DevelopmentBootstrapUploadInput,
  ): Promise<PersistencePutResult>;
  transitionDevelopmentBootstrapAttempt(
    input: DevelopmentBootstrapAttemptTransition,
  ): Promise<PersistenceAdvanceResult>;
}

export interface DevelopmentBootstrapProfilePersistence
  extends DevelopmentBootstrapAttemptLocator {
  acquireProjectLease(
    projectId: CollabProjectId,
  ): Promise<DevelopmentBootstrapProfileProjectLease>;
  withProjectScope<T>(
    projectId: CollabProjectId,
    operation: (scope: DevelopmentBootstrapProfileScope) => Promise<T>,
  ): Promise<T>;
}

export interface DevelopmentBootstrapProfileUploadLease {
  close(): Promise<void>;
}

export interface DevelopmentBootstrapProfileProjectLease {
  close(): Promise<void>;
  handoffToDevelopmentBootstrapUpload(
    attemptId: string,
  ): Promise<DevelopmentBootstrapProfileUploadLease>;
  withProjectScope<T>(
    operation: (scope: DevelopmentBootstrapProfileScope) => Promise<T>,
  ): Promise<T>;
}

export interface DevelopmentBootstrapRepositoryImporter {
  importBundle(input: ImportGitBundleInput): Promise<ValidatedBootstrapRepository>;
}

export interface DevelopmentBootstrapSettlementInput {
  readonly actorId: string;
  readonly attemptId: string;
  readonly projectId: CollabProjectId;
}

export interface DevelopmentBootstrapActivationInput
  extends DevelopmentBootstrapSettlementInput {
  readonly manifestSha256: string;
}

export interface DevelopmentBootstrapSettlementPort {
  activate(
    input: DevelopmentBootstrapActivationInput,
  ): Promise<void>;
  cancel(
    input: DevelopmentBootstrapSettlementInput,
  ): Promise<void>;
  getActivationResult(
    input: Readonly<{ attemptId: string; projectId: CollabProjectId }>,
  ): Promise<DevelopmentBootstrapActivationResult | undefined>;
  expire(
    input: Readonly<{ attemptId: string; projectId: CollabProjectId }>,
  ): Promise<void>;
}

export interface PutDevelopmentBootstrapGitBundleInput {
  readonly attemptId: string;
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentEncoding: string;
  readonly contentLength?: number;
  readonly contentType: string;
  readonly signal?: AbortSignal;
}

export interface DevelopmentBootstrapProfileOptions {
  readonly attemptTtlMs: number;
  readonly clock?: () => Date;
  readonly importer: DevelopmentBootstrapRepositoryImporter;
  readonly persistence: DevelopmentBootstrapProfilePersistence;
  readonly settlement: DevelopmentBootstrapSettlementPort;
  readonly uploadGate: DevelopmentBootstrapUploadGate;
}

interface LoadedAttempt {
  readonly manifest: DevelopmentBootstrapManifest;
  readonly record: DevelopmentBootstrapAttemptRecord;
}

function fail(code: DevelopmentBootstrapProfileErrorCode): never {
  throw new DevelopmentBootstrapProfileError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalReportJson(report: DevelopmentBootstrapReport): string {
  return JSON.stringify(decodeDevelopmentBootstrapReport(report));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function iso(date: Date): string {
  if (Number.isNaN(date.valueOf())) fail('dependency-failed');
  return date.toISOString();
}

function assertOptions(options: DevelopmentBootstrapProfileOptions): void {
  if (
    options.attemptTtlMs
      !== COLLAB_CLOUD_BINDING_LIMITS.bootstrapAttemptTtlMs
  ) {
    throw new TypeError('development-bootstrap-profile.options-invalid');
  }
}

export class DevelopmentBootstrapProfile {
  readonly #attemptTtlMs: number;
  readonly #clock: () => Date;
  readonly #importer: DevelopmentBootstrapRepositoryImporter;
  readonly #persistence: DevelopmentBootstrapProfilePersistence;
  readonly #settlement: DevelopmentBootstrapSettlementPort;
  readonly #uploadGate: DevelopmentBootstrapUploadGate;

  constructor(options: DevelopmentBootstrapProfileOptions) {
    assertOptions(options);
    this.#attemptTtlMs = options.attemptTtlMs;
    this.#clock = options.clock ?? (() => new Date());
    this.#importer = options.importer;
    this.#persistence = options.persistence;
    this.#settlement = options.settlement;
    this.#uploadGate = options.uploadGate;
  }

  async beginDevelopmentBootstrap(
    principal: IngressPrincipal,
    request: BeginDevelopmentBootstrapRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    const manifest = decodeDevelopmentBootstrapManifest(request.manifest);
    if (principal.actorId !== manifest.comparison.sourceHostMemberId) {
      fail('authorization-denied');
    }
    const manifestJson = encodeDevelopmentBootstrapManifestCanonicalJson(manifest);
    const manifestDigest = sha256(manifestJson);
    const now = this.#now();
    const expiresAt = iso(new Date(Date.parse(now) + this.#attemptTtlMs));

    await this.#expirePredecessor(manifest.comparison.projectId);

    const record = await this.#persistence.withProjectScope(
      manifest.comparison.projectId,
      async scope => {
        const existing = await scope.getDevelopmentBootstrapAttempt(manifest.attemptId);
        if (existing !== undefined) {
          if (
            existing.manifestJson !== manifestJson
            || existing.manifestSha256 !== manifestDigest
            || existing.sourceHostMemberId !== principal.actorId
          ) {
            fail('state-conflict');
          }
          return existing;
        }
        if (await scope.getProject() !== undefined) fail('state-conflict');
        await scope.putDevelopmentBootstrapAttempt({
          attemptId: manifest.attemptId,
          createdAt: now,
          expiresAt,
          manifestJson,
          manifestSha256: manifestDigest,
          projectId: manifest.comparison.projectId,
          sourceHostMemberId: manifest.comparison.sourceHostMemberId,
        });
        return this.#requireAttempt(scope, manifest.attemptId);
      },
    );
    return this.#statusOrExpire(this.#decodeAttempt(record));
  }

  async submitDevelopmentBootstrapReport(
    principal: IngressPrincipal,
    request: SubmitDevelopmentBootstrapReportRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    const report = decodeDevelopmentBootstrapReport(request.report);
    const projectId = await this.#locate(request.attemptId);
    const initial = await this.#load(request.attemptId);
    this.#authorize(initial, principal, false);
    if (this.#isExpired(initial.record)) {
      await this.#settlement.expire({
        attemptId: initial.record.attemptId,
        projectId: initial.record.projectId,
      });
      return this.#status((await this.#load(request.attemptId)).record);
    }
    const record = await this.#persistence.withProjectScope(
      projectId,
      async scope => {
        let loaded = this.#decodeAttempt(
          await this.#requireAttempt(scope, request.attemptId),
        );
        this.#authorize(loaded, principal, false);
        if (this.#isExpired(loaded.record)) fail('state-conflict');
        this.#validateReport(loaded, report, principal);
        const reportJson = canonicalReportJson(report);
        const reportDigest = sha256(reportJson);
        const existing = loaded.record.reports.find(
          item => item.reporterMemberId === report.reporterMemberId,
        );
        if (existing !== undefined) {
          if (
            existing.reportJson !== reportJson
            || existing.reportSha256 !== reportDigest
            || existing.capturedAt !== report.capturedAt
          ) {
            fail('state-conflict');
          }
          return loaded.record;
        }
        if (loaded.record.state !== 'collecting' && loaded.record.state !== 'validating') {
          fail('state-conflict');
        }
        await scope.putDevelopmentBootstrapReport({
          attemptId: request.attemptId,
          capturedAt: report.capturedAt,
          createdAt: this.#now(),
          reportJson,
          reportSha256: reportDigest,
          reporterMemberId: report.reporterMemberId,
        });
        loaded = this.#decodeAttempt(await this.#requireAttempt(scope, request.attemptId));
        return this.#promoteReady(scope, loaded);
      },
    );
    return this.#status(record);
  }

  async getDevelopmentBootstrap(
    principal: IngressPrincipal,
    request: GetDevelopmentBootstrapRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    const loaded = await this.#load(request.attemptId);
    this.#authorize(loaded, principal, false);
    return this.#statusOrExpire(loaded);
  }

  async putDevelopmentBootstrapGitBundle(
    principal: IngressPrincipal,
    input: PutDevelopmentBootstrapGitBundleInput,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    const projectId = await this.#locate(input.attemptId);
    const initial = await this.#load(input.attemptId);
    this.#authorize(initial, principal, true);
    if (this.#isExpired(initial.record)) {
      await this.#settlement.expire({
        attemptId: initial.record.attemptId,
        projectId: initial.record.projectId,
      });
      return this.#status((await this.#load(input.attemptId)).record);
    }
    let localUploadLease: LocalDevelopmentBootstrapUploadLease | undefined;
    let durableUploadLease: DevelopmentBootstrapProfileUploadLease | undefined;
    const projectLease = await this.#persistence.acquireProjectLease(projectId);
    let loaded: LoadedAttempt;
    try {
      loaded = await projectLease.withProjectScope(async scope => {
        let current = this.#decodeAttempt(
          await this.#requireAttempt(scope, input.attemptId),
        );
        this.#authorize(current, principal, true);
        if (this.#isExpired(current.record)) fail('state-conflict');
        if (current.record.state === 'collecting') {
          await scope.transitionDevelopmentBootstrapAttempt({
            attemptId: input.attemptId,
            expectedBundleState: current.record.bundleState,
            expectedState: 'collecting',
            nextBundleState: current.record.bundleState,
            nextState: 'validating',
            updatedAt: this.#now(),
          });
          current = this.#decodeAttempt(
            await this.#requireAttempt(scope, input.attemptId),
          );
        } else if (
          current.record.state !== 'validating'
          && current.record.state !== 'ready'
        ) {
          fail('state-conflict');
        }
        try {
          localUploadLease = this.#uploadGate.acquire(input.attemptId);
        } catch (error: unknown) {
          if (error instanceof DevelopmentBootstrapUploadGateError) {
            fail('state-conflict');
          }
          throw error;
        }
        return current;
      });
      durableUploadLease = await projectLease
        .handoffToDevelopmentBootstrapUpload(input.attemptId);
    } catch (error: unknown) {
      localUploadLease?.release();
      await projectLease.close();
      throw error;
    }
    await projectLease.close();

    const manifest = loaded.manifest;
    let validated: ValidatedBootstrapRepository;
    try {
      validated = await this.#importer.importBundle({
        attemptId: input.attemptId,
        body: input.body,
        contentEncoding: input.contentEncoding,
        ...(input.contentLength === undefined ? {} : { contentLength: input.contentLength }),
        contentType: input.contentType,
        declaredByteCount: manifest.git.bundle.byteCount,
        declaredSha256: manifest.git.bundle.sha256,
        expectedByteCount: manifest.git.bundle.byteCount,
        expectedSha256: manifest.git.bundle.sha256,
        objectFormat: manifest.git.objectFormat,
        projectId,
        refs: manifest.git.refs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } finally {
      localUploadLease?.release();
      await durableUploadLease.close();
    }
    this.#assertValidatedRepository(loaded, validated);

    const record = await this.#persistence.withProjectScope(projectId, async scope => {
      loaded = this.#decodeAttempt(await this.#requireAttempt(scope, input.attemptId));
      this.#authorize(loaded, principal, true);
      if (loaded.record.state !== 'validating' && loaded.record.state !== 'ready') {
        fail('state-conflict');
      }
      const upload = loaded.record.upload;
      if (upload === undefined) {
        await scope.putDevelopmentBootstrapUpload({
          attemptId: input.attemptId,
          byteCount: validated.bundleByteCount,
          createdAt: this.#now(),
          sha256: validated.bundleSha256,
          stagingArtifactKey: validated.artifactKey,
          validationMarkerSha256: validated.markerSha256,
        });
        loaded = this.#decodeAttempt(await this.#requireAttempt(scope, input.attemptId));
      } else if (
        upload.byteCount !== validated.bundleByteCount
        || upload.sha256 !== validated.bundleSha256
        || upload.stagingArtifactKey !== validated.artifactKey
      ) {
        fail('repository-mismatch');
      }
      if (loaded.record.bundleState === 'uploaded') {
        await scope.transitionDevelopmentBootstrapAttempt({
          attemptId: input.attemptId,
          expectedBundleState: 'uploaded',
          expectedState: loaded.record.state,
          nextBundleState: 'validated',
          nextState: loaded.record.state,
          updatedAt: this.#now(),
        });
        loaded = this.#decodeAttempt(await this.#requireAttempt(scope, input.attemptId));
      }
      return this.#promoteReady(scope, loaded);
    });
    return this.#status(record);
  }

  async activateDevelopmentBootstrap(
    principal: IngressPrincipal,
    request: ActivateDevelopmentBootstrapRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    const loaded = await this.#load(request.attemptId);
    this.#authorize(loaded, principal, true);
    if (this.#isExpired(loaded.record)) {
      await this.#settlement.expire({
        attemptId: loaded.record.attemptId,
        projectId: loaded.record.projectId,
      });
      return this.#status((await this.#load(request.attemptId)).record);
    }
    if (
      request.manifestSha256 !== loaded.record.manifestSha256
      || (loaded.record.state !== 'ready'
        && loaded.record.state !== 'activating'
        && loaded.record.state !== 'activated')
      || loaded.record.bundleState !== 'validated'
    ) {
      fail('state-conflict');
    }
    await this.#settlement.activate({
      actorId: principal.actorId,
      attemptId: request.attemptId,
      manifestSha256: request.manifestSha256,
      projectId: loaded.record.projectId,
    });
    return this.#status((await this.#load(request.attemptId)).record);
  }

  async cancelDevelopmentBootstrap(
    principal: IngressPrincipal,
    request: CancelDevelopmentBootstrapRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    const loaded = await this.#load(request.attemptId);
    this.#authorize(loaded, principal, true);
    if (
      !['collecting', 'validating', 'ready', 'rejected', 'cancelled']
        .includes(loaded.record.state)
      || (loaded.record.settlement !== undefined
        && loaded.record.settlement.kind !== 'cancellation')
    ) {
      fail('state-conflict');
    }
    await this.#settlement.cancel({
      actorId: principal.actorId,
      attemptId: request.attemptId,
      projectId: loaded.record.projectId,
    });
    return this.#status((await this.#load(request.attemptId)).record);
  }

  async #locate(attemptId: string): Promise<CollabProjectId> {
    const projectId = await this.#persistence.findDevelopmentBootstrapProject(attemptId);
    if (projectId === undefined) fail('attempt-not-found');
    return projectId;
  }

  async #load(attemptId: string): Promise<LoadedAttempt> {
    const projectId = await this.#locate(attemptId);
    const record = await this.#persistence.withProjectScope(
      projectId,
      scope => this.#requireAttempt(scope, attemptId),
    );
    return this.#decodeAttempt(record);
  }

  async #requireAttempt(
    scope: DevelopmentBootstrapProfileScope,
    attemptId: string,
  ): Promise<DevelopmentBootstrapAttemptRecord> {
    const attempt = await scope.getDevelopmentBootstrapAttempt(attemptId);
    if (attempt === undefined) fail('attempt-not-found');
    return attempt;
  }

  #decodeAttempt(record: DevelopmentBootstrapAttemptRecord): LoadedAttempt {
    let manifest: DevelopmentBootstrapManifest;
    try {
      manifest = decodeDevelopmentBootstrapManifest(JSON.parse(record.manifestJson));
    } catch {
      return fail('dependency-failed');
    }
    const canonical = encodeDevelopmentBootstrapManifestCanonicalJson(manifest);
    if (
      canonical !== record.manifestJson
      || sha256(canonical) !== record.manifestSha256
      || manifest.attemptId !== record.attemptId
      || manifest.comparison.projectId !== record.projectId
      || manifest.comparison.sourceHostMemberId !== record.sourceHostMemberId
    ) {
      fail('dependency-failed');
    }
    return Object.freeze({ manifest, record });
  }

  #authorize(
    loaded: LoadedAttempt,
    principal: IngressPrincipal,
    hostOnly: boolean,
  ): void {
    const accepted = loaded.manifest.comparison.members.some(
      member => member.memberId === principal.actorId,
    );
    if (
      !accepted
      || (hostOnly
        && principal.actorId !== loaded.manifest.comparison.sourceHostMemberId)
    ) {
      fail('authorization-denied');
    }
  }

  #validateReport(
    loaded: LoadedAttempt,
    report: DevelopmentBootstrapReport,
    principal: IngressPrincipal,
  ): void {
    if (
      report.attemptId !== loaded.record.attemptId
      || report.reporterMemberId !== principal.actorId
    ) {
      fail('authorization-denied');
    }
    if (!sameJson(report.comparison, loaded.manifest.comparison)) {
      fail('comparison-mismatch');
    }
    const expectedRef = loaded.manifest.git.refs.find(
      ref => ref.name === loaded.manifest.comparison.members.find(
        member => member.memberId === report.reporterMemberId,
      )?.personalRef,
    );
    if (expectedRef?.oid !== report.observedPersonalRefOid) {
      fail('repository-mismatch');
    }
    if (report.reporterMemberId === loaded.record.sourceHostMemberId) {
      const attestation = report.hostStopAttestation;
      if (
        attestation === undefined
        || attestation.manifestSha256 !== loaded.record.manifestSha256
      ) {
        fail('host-stop-mismatch');
      }
    }
  }

  async #promoteReady(
    scope: DevelopmentBootstrapProfileScope,
    loaded: LoadedAttempt,
  ): Promise<DevelopmentBootstrapAttemptRecord> {
    if (
      loaded.record.state === 'ready'
      || loaded.record.bundleState !== 'validated'
      || loaded.record.reports.length !== 2
    ) {
      return loaded.record;
    }
    for (const stored of loaded.record.reports) {
      let report: DevelopmentBootstrapReport;
      try {
        report = decodeDevelopmentBootstrapReport(JSON.parse(stored.reportJson));
      } catch {
        return fail('dependency-failed');
      }
      this.#validateReport(
        loaded,
        report,
        Object.freeze({
          actorId: stored.reporterMemberId,
          profile: 'loopback-development' as const,
        }),
      );
      if (sha256(canonicalReportJson(report)) !== stored.reportSha256) {
        fail('dependency-failed');
      }
    }
    if (loaded.record.state !== 'collecting' && loaded.record.state !== 'validating') {
      fail('state-conflict');
    }
    await scope.transitionDevelopmentBootstrapAttempt({
      attemptId: loaded.record.attemptId,
      expectedBundleState: 'validated',
      expectedState: loaded.record.state,
      nextBundleState: 'validated',
      nextState: 'ready',
      updatedAt: this.#now(),
    });
    return this.#requireAttempt(scope, loaded.record.attemptId);
  }

  #assertValidatedRepository(
    loaded: LoadedAttempt,
    repository: ValidatedBootstrapRepository,
  ): void {
    if (
      repository.projectId !== loaded.record.projectId
      || repository.attemptId !== loaded.record.attemptId
      || repository.bundleByteCount !== loaded.manifest.git.bundle.byteCount
      || repository.bundleSha256 !== loaded.manifest.git.bundle.sha256
      || repository.objectFormat !== loaded.manifest.git.objectFormat
      || !sameJson(repository.refs, loaded.manifest.git.refs)
    ) {
      fail('repository-mismatch');
    }
  }

  async #status(
    record: DevelopmentBootstrapAttemptRecord,
    knownManifest?: DevelopmentBootstrapManifest,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    const loaded = knownManifest === undefined
      ? this.#decodeAttempt(record)
      : Object.freeze({ manifest: knownManifest, record });
    const settlement = record.settlement;
    const activationResult = record.state === 'activated'
      ? await this.#settlement.getActivationResult({
        attemptId: record.attemptId,
        projectId: record.projectId,
      })
      : undefined;
    if (record.state === 'activated' && activationResult === undefined) {
      fail('dependency-failed');
    }
    return Object.freeze({
      ...(settlement?.kind === 'activation'
        ? { activationPhase: settlement.activationPhase }
        : {}),
      ...(activationResult === undefined ? {} : { activationResult }),
      attemptId: record.attemptId,
      bundleState: record.bundleState,
      ...(settlement?.kind === 'cancellation'
        ? { cancellationPhase: settlement.cancellationPhase }
        : {}),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      manifestSha256: record.manifestSha256,
      projectId: loaded.manifest.comparison.projectId,
      reporterMemberIds: Object.freeze(record.reports
        .map(report => report.reporterMemberId)
        .sort((left, right) => left.localeCompare(right, 'en-US'))),
      state: record.state,
    });
  }

  async #statusOrExpire(
    loaded: LoadedAttempt,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    if (
      this.#isExpired(loaded.record)
      && ['collecting', 'validating', 'ready', 'rejected'].includes(loaded.record.state)
    ) {
      await this.#settlement.expire({
        attemptId: loaded.record.attemptId,
        projectId: loaded.record.projectId,
      });
      return this.#status((await this.#load(loaded.record.attemptId)).record);
    }
    return this.#status(loaded.record, loaded.manifest);
  }

  async #expirePredecessor(projectId: CollabProjectId): Promise<void> {
    const current = await this.#persistence.withProjectScope(
      projectId,
      scope => scope.getActiveDevelopmentBootstrapAttempt(),
    );
    if (
      current !== undefined
      && this.#isExpired(current)
      && ['collecting', 'validating', 'ready'].includes(current.state)
    ) {
      await this.#settlement.expire({
        attemptId: current.attemptId,
        projectId,
      });
    }
  }

  #isExpired(record: DevelopmentBootstrapAttemptRecord): boolean {
    return record.expiresAt <= this.#now();
  }

  #now(): string {
    return iso(this.#clock());
  }
}
