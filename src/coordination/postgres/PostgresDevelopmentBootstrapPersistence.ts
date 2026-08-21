import {
  COLLAB_LIMITS,
  DEVELOPMENT_BOOTSTRAP_ACTIVATION_PHASES,
  DEVELOPMENT_BOOTSTRAP_ATTEMPT_STATES,
  DEVELOPMENT_BOOTSTRAP_CANCELLATION_PHASES,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  type CollabProjectId,
  type DevelopmentBootstrapActivationPhase,
  type DevelopmentBootstrapAttemptState,
  type DevelopmentBootstrapBundleState,
  type DevelopmentBootstrapCancellationPhase,
} from '@claudian/collab-protocol';
import type { QueryResultRow } from 'pg';

import type {
  DevelopmentBootstrapActivationAdvance,
  DevelopmentBootstrapActivationInput,
  DevelopmentBootstrapActivationRecoveryRequired,
  DevelopmentBootstrapAttemptInput,
  DevelopmentBootstrapAttemptRecord,
  DevelopmentBootstrapAttemptTransition,
  DevelopmentBootstrapCancellationAdvance,
  DevelopmentBootstrapCancellationInput,
  DevelopmentBootstrapProjectActivation,
  DevelopmentBootstrapProjectPersistence,
  DevelopmentBootstrapReportInput,
  DevelopmentBootstrapReportRecord,
  DevelopmentBootstrapSettlementRecord,
  DevelopmentBootstrapUploadInput,
  DevelopmentBootstrapUploadRecord,
  PersistenceAdvanceResult,
  PersistencePutResult,
} from '../DevelopmentBootstrapPersistence.js';
import { CoordinationError } from '../CoordinationError.js';

type ProjectQuery = <Row extends QueryResultRow>(
  text: string,
  values: readonly unknown[],
) => Promise<readonly Row[]>;

interface AttemptRow {
  readonly attempt_id: string;
  readonly bundle_state: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly manifest_json: string;
  readonly manifest_sha256: string;
  readonly project_id: string;
  readonly source_host_member_id: string;
  readonly state: string;
  readonly updated_at: Date;
}

interface ReportRow {
  readonly captured_at: Date;
  readonly created_at: Date;
  readonly report_json: string;
  readonly report_sha256: string;
  readonly reporter_member_id: string;
}

interface UploadRow {
  readonly byte_count: string;
  readonly created_at: Date;
  readonly sha256: string;
  readonly staging_artifact_key: string;
  readonly state: string;
  readonly updated_at: Date;
  readonly validation_marker_sha256: string;
}

interface SettlementRow {
  readonly activation_phase: string | null;
  readonly attempt_id: string;
  readonly cancellation_phase: string | null;
  readonly journal_json: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly updated_at: Date;
}

interface ActivatedProjectRow {
  readonly activated_at: Date;
  readonly created_at: Date;
  readonly expected_main_oid: string;
  readonly manager_set_generation: string;
  readonly project_name: string;
  readonly service_state: string;
}

interface ActivatedMemberRow {
  readonly activated_at: Date;
  readonly actor_id: string;
  readonly created_at: Date;
  readonly display_name: string;
  readonly member_id: string;
  readonly revision: string;
  readonly role: string;
  readonly status: string;
}

interface ActivatedPlacementRow {
  readonly active: boolean;
  readonly generation: string;
  readonly repository_storage_key: string;
  readonly storage_node_id: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const STORAGE_NODE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const BUNDLE_STATES = new Set<DevelopmentBootstrapBundleState>([
  'missing',
  'uploaded',
  'validated',
]);
const ATTEMPT_STATES = new Set<DevelopmentBootstrapAttemptState>(
  DEVELOPMENT_BOOTSTRAP_ATTEMPT_STATES,
);
const ACTIVATION_PHASES = new Set<DevelopmentBootstrapActivationPhase>(
  DEVELOPMENT_BOOTSTRAP_ACTIVATION_PHASES,
);
const CANCELLATION_PHASES = new Set<DevelopmentBootstrapCancellationPhase>(
  DEVELOPMENT_BOOTSTRAP_CANCELLATION_PHASES,
);

function invalidRecord(): never {
  throw new CoordinationError('invalid-record');
}

function stateConflict(): never {
  throw new CoordinationError('state-conflict');
}

function dependencyFailure(): never {
  throw new CoordinationError('dependency-failed');
}

function isoTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalidRecord();
  }
  return value;
}

function dateIso(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) dependencyFailure();
  return value.toISOString();
}

function boundedJson(value: string, maximum: number): string {
  if (
    value.length < 2
    || Buffer.byteLength(value, 'utf8') > maximum
  ) {
    invalidRecord();
  }
  try {
    JSON.parse(value) as unknown;
  } catch {
    invalidRecord();
  }
  return value;
}

function sha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) invalidRecord();
  return value;
}

function opaqueId(value: string): string {
  if (!isCollabOpaqueId(value)) invalidRecord();
  return value;
}

function equalTimestamp(row: Date, value: string): boolean {
  return dateIso(row) === value;
}

function attemptState(value: string): DevelopmentBootstrapAttemptState {
  if (!ATTEMPT_STATES.has(value as DevelopmentBootstrapAttemptState)) {
    dependencyFailure();
  }
  return value as DevelopmentBootstrapAttemptState;
}

function bundleState(value: string): DevelopmentBootstrapBundleState {
  if (!BUNDLE_STATES.has(value as DevelopmentBootstrapBundleState)) {
    dependencyFailure();
  }
  return value as DevelopmentBootstrapBundleState;
}

function activationPhase(value: string): DevelopmentBootstrapActivationPhase {
  if (!ACTIVATION_PHASES.has(value as DevelopmentBootstrapActivationPhase)) {
    dependencyFailure();
  }
  return value as DevelopmentBootstrapActivationPhase;
}

function cancellationPhase(value: string): DevelopmentBootstrapCancellationPhase {
  if (!CANCELLATION_PHASES.has(value as DevelopmentBootstrapCancellationPhase)) {
    dependencyFailure();
  }
  return value as DevelopmentBootstrapCancellationPhase;
}

function nextActivationPhase(
  expected: DevelopmentBootstrapActivationPhase,
): DevelopmentBootstrapActivationPhase | undefined {
  const index = DEVELOPMENT_BOOTSTRAP_ACTIVATION_PHASES.indexOf(expected);
  return DEVELOPMENT_BOOTSTRAP_ACTIVATION_PHASES[index + 1];
}

function validCancellationAdvance(
  expected: DevelopmentBootstrapCancellationPhase,
  next: DevelopmentBootstrapCancellationPhase,
): boolean {
  return expected === 'cancel-intent'
    && (next === 'cancelled' || next === 'recovery-required');
}

function freezeReport(row: ReportRow): DevelopmentBootstrapReportRecord {
  if (!isCollabMemberId(row.reporter_member_id)) dependencyFailure();
  return Object.freeze({
    capturedAt: dateIso(row.captured_at),
    createdAt: dateIso(row.created_at),
    reportJson: row.report_json,
    reportSha256: row.report_sha256,
    reporterMemberId: row.reporter_member_id,
  });
}

function freezeUpload(row: UploadRow): DevelopmentBootstrapUploadRecord {
  const byteCount = Number(row.byte_count);
  if (!Number.isSafeInteger(byteCount) || byteCount <= 0) dependencyFailure();
  if (row.state !== 'uploaded' && row.state !== 'validated') dependencyFailure();
  return Object.freeze({
    byteCount,
    createdAt: dateIso(row.created_at),
    sha256: row.sha256,
    stagingArtifactKey: row.staging_artifact_key,
    state: row.state,
    updatedAt: dateIso(row.updated_at),
    validationMarkerSha256: row.validation_marker_sha256,
  });
}

function freezeSettlement(row: SettlementRow): DevelopmentBootstrapSettlementRecord {
  if (!isCollabOpaqueId(row.operation_id)) dependencyFailure();
  const common = {
    attemptId: row.attempt_id,
    journalJson: row.journal_json,
    operationId: row.operation_id,
    updatedAt: dateIso(row.updated_at),
  } as const;
  if (
    row.kind === 'activation'
    && row.activation_phase !== null
    && row.cancellation_phase === null
  ) {
    return Object.freeze({
      ...common,
      activationPhase: activationPhase(row.activation_phase),
      kind: 'activation' as const,
    });
  }
  if (
    row.kind === 'cancellation'
    && row.cancellation_phase !== null
    && row.activation_phase === null
  ) {
    return Object.freeze({
      ...common,
      cancellationPhase: cancellationPhase(row.cancellation_phase),
      kind: 'cancellation' as const,
    });
  }
  return dependencyFailure();
}

export class PostgresDevelopmentBootstrapPersistence
implements DevelopmentBootstrapProjectPersistence {
  readonly #projectId: CollabProjectId;
  readonly #query: ProjectQuery;
  #active = true;

  constructor(projectId: CollabProjectId, query: ProjectQuery) {
    this.#projectId = projectId;
    this.#query = query;
  }

  deactivate(): void {
    this.#active = false;
  }

  async putDevelopmentBootstrapAttempt(
    input: DevelopmentBootstrapAttemptInput,
  ): Promise<PersistencePutResult> {
    this.assertActive();
    if (
      input.projectId !== this.#projectId
      || !isCollabMemberId(input.sourceHostMemberId)
    ) {
      invalidRecord();
    }
    const attemptId = opaqueId(input.attemptId);
    const createdAt = isoTimestamp(input.createdAt);
    const expiresAt = isoTimestamp(input.expiresAt);
    if (expiresAt <= createdAt) invalidRecord();
    const manifestSha256 = sha256(input.manifestSha256);
    const manifestJson = boundedJson(input.manifestJson, 65_536);

    const existing = await this.#attemptRow(attemptId);
    if (existing !== undefined) {
      if (
        existing.project_id === input.projectId
        && existing.source_host_member_id === input.sourceHostMemberId
        && existing.manifest_sha256 === manifestSha256
        && existing.manifest_json === manifestJson
        && existing.state === 'collecting'
        && existing.bundle_state === 'missing'
        && equalTimestamp(existing.created_at, createdAt)
        && equalTimestamp(existing.expires_at, expiresAt)
        && equalTimestamp(existing.updated_at, createdAt)
      ) {
        await this.#upsertExpiryCandidate(attemptId, expiresAt);
        return 'replayed';
      }
      return stateConflict();
    }

    const nonterminal = await this.#query<{ readonly attempt_id: string }>(
      `SELECT attempt_id
         FROM claudian_cloud.development_bootstrap_attempts
        WHERE project_id = $1
          AND state IN (
            'collecting', 'validating', 'ready', 'activating',
            'recovery-required'
          )`,
      [this.#projectId],
    );
    if (nonterminal.length > 0) stateConflict();

    await this.#query(
      `INSERT INTO claudian_cloud.development_bootstrap_attempts (
         project_id,
         attempt_id,
         source_host_member_id,
         manifest_sha256,
         manifest_json,
         state,
         bundle_state,
         created_at,
         expires_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'collecting', 'missing', $6, $7, $6)`,
      [
        this.#projectId,
        attemptId,
        input.sourceHostMemberId,
        manifestSha256,
        manifestJson,
        createdAt,
        expiresAt,
      ],
    );
    const route = await this.#query<{ readonly claimed: boolean }>(
      `SELECT claudian_cloud.put_development_bootstrap_attempt_route($1, $2)
              AS claimed`,
      [attemptId, this.#projectId],
    );
    if (route[0]?.claimed !== true) stateConflict();
    await this.#upsertExpiryCandidate(attemptId, expiresAt);
    return 'created';
  }

  async getDevelopmentBootstrapAttempt(
    attemptIdInput: string,
  ): Promise<DevelopmentBootstrapAttemptRecord | undefined> {
    this.assertActive();
    const attemptId = opaqueId(attemptIdInput);
    const row = await this.#attemptRow(attemptId);
    if (row === undefined) return undefined;
    if (!isCollabMemberId(row.source_host_member_id)) dependencyFailure();

    const reports = await this.#query<ReportRow>(
        `SELECT reporter_member_id,
                report_sha256,
                report_json,
                captured_at,
                created_at
           FROM claudian_cloud.development_bootstrap_reports
          WHERE project_id = $1 AND attempt_id = $2
          ORDER BY reporter_member_id`,
        [this.#projectId, attemptId],
      );
    const uploads = await this.#query<UploadRow>(
        `SELECT byte_count,
                sha256,
                staging_artifact_key,
                state,
                created_at,
                updated_at,
                validation_marker_sha256
           FROM claudian_cloud.development_bootstrap_uploads
          WHERE project_id = $1 AND attempt_id = $2`,
        [this.#projectId, attemptId],
      );
    const settlements = await this.#query<SettlementRow>(
        `SELECT attempt_id,
                operation_id,
                kind,
                activation_phase,
                cancellation_phase,
                journal_json,
                updated_at
           FROM claudian_cloud.development_bootstrap_settlements
          WHERE project_id = $1 AND attempt_id = $2`,
        [this.#projectId, attemptId],
      );
    if (uploads.length > 1 || settlements.length > 1 || reports.length > 2) {
      dependencyFailure();
    }
    return Object.freeze({
      attemptId: row.attempt_id,
      bundleState: bundleState(row.bundle_state),
      createdAt: dateIso(row.created_at),
      expiresAt: dateIso(row.expires_at),
      manifestJson: row.manifest_json,
      manifestSha256: row.manifest_sha256,
      projectId: row.project_id,
      reports: Object.freeze(reports
        .map(freezeReport)
        .sort((left, right) => left.reporterMemberId.localeCompare(
          right.reporterMemberId,
          'en-US',
        ))),
      settlement: settlements[0] === undefined
        ? undefined
        : freezeSettlement(settlements[0]),
      sourceHostMemberId: row.source_host_member_id,
      state: attemptState(row.state),
      updatedAt: dateIso(row.updated_at),
      upload: uploads[0] === undefined ? undefined : freezeUpload(uploads[0]),
    });
  }

  async getDevelopmentBootstrapRecoveryAttempt(
    operationIdInput: string,
  ): Promise<DevelopmentBootstrapAttemptRecord | undefined> {
    this.assertActive();
    const operationId = opaqueId(operationIdInput);
    const attemptId = await this.#findNonterminalAttemptId(operationId);
    return attemptId === undefined
      ? undefined
      : this.getDevelopmentBootstrapAttempt(attemptId);
  }

  async getNonterminalDevelopmentBootstrapAttempt(): Promise<
    DevelopmentBootstrapAttemptRecord | undefined
  > {
    this.assertActive();
    const attemptId = await this.#findNonterminalAttemptId();
    return attemptId === undefined
      ? undefined
      : this.getDevelopmentBootstrapAttempt(attemptId);
  }

  async getActiveDevelopmentBootstrapAttempt(): Promise<
    DevelopmentBootstrapAttemptRecord | undefined
  > {
    this.assertActive();
    const rows = await this.#query<{ readonly attempt_id: string }>(
      `SELECT attempt_id
         FROM claudian_cloud.development_bootstrap_attempts
        WHERE project_id = $1
          AND state IN (
            'collecting', 'validating', 'ready', 'activating',
            'recovery-required'
          )
        ORDER BY attempt_id
        LIMIT 2`,
      [this.#projectId],
    );
    if (rows.length > 1) dependencyFailure();
    const attemptId = rows[0]?.attempt_id;
    return attemptId === undefined
      ? undefined
      : this.getDevelopmentBootstrapAttempt(attemptId);
  }

  async putDevelopmentBootstrapReport(
    input: DevelopmentBootstrapReportInput,
  ): Promise<PersistencePutResult> {
    this.assertActive();
    const attemptId = opaqueId(input.attemptId);
    if (!isCollabMemberId(input.reporterMemberId)) invalidRecord();
    const capturedAt = isoTimestamp(input.capturedAt);
    const createdAt = isoTimestamp(input.createdAt);
    const reportSha256 = sha256(input.reportSha256);
    const reportJson = boundedJson(input.reportJson, 65_536);
    await this.#requireAttempt(attemptId);

    const rows = await this.#query<ReportRow>(
      `SELECT reporter_member_id,
              report_sha256,
              report_json,
              captured_at,
              created_at
         FROM claudian_cloud.development_bootstrap_reports
        WHERE project_id = $1 AND attempt_id = $2
        ORDER BY reporter_member_id`,
      [this.#projectId, attemptId],
    );
    const existing = rows.find(row => (
      row.reporter_member_id === input.reporterMemberId
    ));
    if (existing !== undefined) {
      if (
        existing.report_sha256 === reportSha256
        && existing.report_json === reportJson
        && equalTimestamp(existing.captured_at, capturedAt)
        && equalTimestamp(existing.created_at, createdAt)
      ) {
        return 'replayed';
      }
      return stateConflict();
    }
    if (rows.length >= 2) stateConflict();

    await this.#query(
      `INSERT INTO claudian_cloud.development_bootstrap_reports (
         project_id,
         attempt_id,
         reporter_member_id,
         report_sha256,
         report_json,
         captured_at,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        this.#projectId,
        attemptId,
        input.reporterMemberId,
        reportSha256,
        reportJson,
        capturedAt,
        createdAt,
      ],
    );
    return 'created';
  }

  async putDevelopmentBootstrapUpload(
    input: DevelopmentBootstrapUploadInput,
  ): Promise<PersistencePutResult> {
    this.assertActive();
    const attemptId = opaqueId(input.attemptId);
    if (
      !Number.isSafeInteger(input.byteCount)
      || input.byteCount <= 0
      || input.byteCount > 1_073_741_824
      || !STORAGE_KEY_PATTERN.test(input.stagingArtifactKey)
    ) {
      invalidRecord();
    }
    const digest = sha256(input.sha256);
    const validationMarkerSha256 = sha256(input.validationMarkerSha256);
    const createdAt = isoTimestamp(input.createdAt);
    await this.#requireAttempt(attemptId);
    const existing = await this.#query<UploadRow>(
      `SELECT byte_count,
              sha256,
              staging_artifact_key,
              state,
              created_at,
              updated_at,
              validation_marker_sha256
         FROM claudian_cloud.development_bootstrap_uploads
        WHERE project_id = $1 AND attempt_id = $2`,
      [this.#projectId, attemptId],
    );
    const row = existing[0];
    if (row !== undefined) {
      if (
        Number(row.byte_count) === input.byteCount
        && row.sha256 === digest
        && row.staging_artifact_key === input.stagingArtifactKey
        && row.validation_marker_sha256 === validationMarkerSha256
        && row.state === 'uploaded'
        && equalTimestamp(row.created_at, createdAt)
        && equalTimestamp(row.updated_at, createdAt)
      ) {
        return 'replayed';
      }
      return stateConflict();
    }

    await this.#query(
      `INSERT INTO claudian_cloud.development_bootstrap_uploads (
         project_id,
         attempt_id,
         byte_count,
         sha256,
         staging_artifact_key,
         validation_marker_sha256,
         state,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'uploaded', $7, $7)`,
      [
        this.#projectId,
        attemptId,
        input.byteCount,
        digest,
        input.stagingArtifactKey,
        validationMarkerSha256,
        createdAt,
      ],
    );
    await this.#query(
      `UPDATE claudian_cloud.development_bootstrap_attempts
          SET bundle_state = 'uploaded', updated_at = $3
        WHERE project_id = $1
          AND attempt_id = $2
          AND bundle_state = 'missing'`,
      [this.#projectId, attemptId, createdAt],
    );
    return 'created';
  }

  async transitionDevelopmentBootstrapAttempt(
    input: DevelopmentBootstrapAttemptTransition,
  ): Promise<PersistenceAdvanceResult> {
    this.assertActive();
    const attemptId = opaqueId(input.attemptId);
    const updatedAt = isoTimestamp(input.updatedAt);
    if (
      !ATTEMPT_STATES.has(input.expectedState)
      || !ATTEMPT_STATES.has(input.nextState)
      || !BUNDLE_STATES.has(input.expectedBundleState)
      || !BUNDLE_STATES.has(input.nextBundleState)
    ) {
      invalidRecord();
    }
    const rows = await this.#query<{ readonly attempt_id: string }>(
      `UPDATE claudian_cloud.development_bootstrap_attempts
          SET state = $5, bundle_state = $6, updated_at = $7
        WHERE project_id = $1
          AND attempt_id = $2
          AND state = $3
          AND bundle_state = $4
          AND updated_at <= $7
      RETURNING attempt_id`,
      [
        this.#projectId,
        attemptId,
        input.expectedState,
        input.expectedBundleState,
        input.nextState,
        input.nextBundleState,
        updatedAt,
      ],
    );
    if (rows.length === 1) {
      if (input.nextBundleState === 'validated') {
        await this.#query(
          `UPDATE claudian_cloud.development_bootstrap_uploads
              SET state = 'validated', updated_at = $3
            WHERE project_id = $1 AND attempt_id = $2`,
          [this.#projectId, attemptId, updatedAt],
        );
      }
      return 'advanced';
    }
    const current = await this.#requireAttempt(attemptId);
    if (
      current.state === input.nextState
      && current.bundle_state === input.nextBundleState
      && equalTimestamp(current.updated_at, updatedAt)
    ) {
      return 'replayed';
    }
    return stateConflict();
  }

  async beginDevelopmentBootstrapActivation(
    input: DevelopmentBootstrapActivationInput,
  ): Promise<PersistencePutResult> {
    this.assertActive();
    const attemptId = opaqueId(input.attemptId);
    const operationId = opaqueId(input.operationId);
    const scheduledAt = isoTimestamp(input.scheduledAt);
    const journalJson = boundedJson(input.journalJson, 524_288);
    const existing = await this.#settlementRow(attemptId);
    if (existing !== undefined) {
      if (
        existing.kind === 'activation'
        && existing.operation_id === operationId
        && existing.activation_phase === 'publish-intent'
        && existing.journal_json === journalJson
        && equalTimestamp(existing.updated_at, scheduledAt)
      ) {
        await this.#upsertCandidate(operationId, scheduledAt);
        await this.#removeExpiryCandidate(attemptId);
        return 'replayed';
      }
      return stateConflict();
    }
    const attempt = await this.#requireAttempt(attemptId);
    if (attempt.state !== 'ready' || attempt.bundle_state !== 'validated') {
      stateConflict();
    }
    await this.#query(
      `INSERT INTO claudian_cloud.development_bootstrap_settlements (
         project_id,
         attempt_id,
         operation_id,
         kind,
         activation_phase,
         cancellation_phase,
         journal_json,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, 'activation', 'publish-intent', NULL, $4, $5, $5
       )`,
      [this.#projectId, attemptId, operationId, journalJson, scheduledAt],
    );
    await this.#query(
      `UPDATE claudian_cloud.development_bootstrap_attempts
          SET state = 'activating', updated_at = $3
        WHERE project_id = $1 AND attempt_id = $2`,
      [this.#projectId, attemptId, scheduledAt],
    );
    await this.#upsertCandidate(operationId, scheduledAt);
    await this.#removeExpiryCandidate(attemptId);
    return 'created';
  }

  async beginDevelopmentBootstrapCancellation(
    input: DevelopmentBootstrapCancellationInput,
  ): Promise<PersistencePutResult> {
    this.assertActive();
    const attemptId = opaqueId(input.attemptId);
    const operationId = opaqueId(input.operationId);
    const scheduledAt = isoTimestamp(input.scheduledAt);
    const journalJson = boundedJson(input.journalJson, 524_288);
    if (!ATTEMPT_STATES.has(input.expectedState)) invalidRecord();
    const existing = await this.#settlementRow(attemptId);
    if (existing !== undefined) {
      if (
        existing.kind === 'cancellation'
        && existing.operation_id === operationId
        && existing.cancellation_phase === 'cancel-intent'
        && existing.journal_json === journalJson
        && equalTimestamp(existing.updated_at, scheduledAt)
      ) {
        await this.#upsertCandidate(operationId, scheduledAt);
        await this.#removeExpiryCandidate(attemptId);
        return 'replayed';
      }
      return stateConflict();
    }
    const attempt = await this.#requireAttempt(attemptId);
    if (attempt.state !== input.expectedState) stateConflict();
    await this.#query(
      `INSERT INTO claudian_cloud.development_bootstrap_settlements (
         project_id,
         attempt_id,
         operation_id,
         kind,
         activation_phase,
         cancellation_phase,
         journal_json,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, 'cancellation', NULL, 'cancel-intent', $4, $5, $5
       )`,
      [this.#projectId, attemptId, operationId, journalJson, scheduledAt],
    );
    await this.#upsertCandidate(operationId, scheduledAt);
    await this.#removeExpiryCandidate(attemptId);
    return 'created';
  }

  async advanceDevelopmentBootstrapActivation(
    input: DevelopmentBootstrapActivationAdvance,
  ): Promise<PersistenceAdvanceResult> {
    this.assertActive();
    const attemptId = opaqueId(input.attemptId);
    const updatedAt = isoTimestamp(input.updatedAt);
    if (nextActivationPhase(input.expectedPhase) !== input.nextPhase) {
      invalidRecord();
    }
    const rows = await this.#query<{ readonly attempt_id: string }>(
      `UPDATE claudian_cloud.development_bootstrap_settlements
          SET activation_phase = $4, updated_at = $5
        WHERE project_id = $1
          AND attempt_id = $2
          AND kind = 'activation'
          AND activation_phase = $3
          AND updated_at <= $5
      RETURNING attempt_id`,
      [
        this.#projectId,
        attemptId,
        input.expectedPhase,
        input.nextPhase,
        updatedAt,
      ],
    );
    if (rows.length === 0) {
      const current = await this.#settlementRow(attemptId);
      if (
        current?.kind === 'activation'
        && current.activation_phase === input.nextPhase
        && equalTimestamp(current.updated_at, updatedAt)
      ) {
        if (input.nextPhase === 'completed') {
          await this.#removeCandidate(attemptId);
        } else {
          await this.#upsertCandidate(current.operation_id, updatedAt);
        }
        return 'replayed';
      }
      return stateConflict();
    }
    if (input.nextPhase === 'activated') {
      await this.#query(
        `UPDATE claudian_cloud.development_bootstrap_attempts
            SET state = 'activated', updated_at = $3
          WHERE project_id = $1 AND attempt_id = $2`,
        [this.#projectId, attemptId, updatedAt],
      );
    }
    if (input.nextPhase === 'completed') {
      await this.#removeCandidate(attemptId);
    } else {
      const current = await this.#settlementRow(attemptId);
      if (current?.kind !== 'activation') dependencyFailure();
      await this.#upsertCandidate(current.operation_id, updatedAt);
    }
    return 'advanced';
  }

  async advanceDevelopmentBootstrapCancellation(
    input: DevelopmentBootstrapCancellationAdvance,
  ): Promise<PersistenceAdvanceResult> {
    this.assertActive();
    const attemptId = opaqueId(input.attemptId);
    const updatedAt = isoTimestamp(input.updatedAt);
    if (!validCancellationAdvance(input.expectedPhase, input.nextPhase)) {
      invalidRecord();
    }
    const rows = await this.#query<{ readonly attempt_id: string }>(
      `UPDATE claudian_cloud.development_bootstrap_settlements
          SET cancellation_phase = $4, updated_at = $5
        WHERE project_id = $1
          AND attempt_id = $2
          AND kind = 'cancellation'
          AND cancellation_phase = $3
          AND updated_at <= $5
      RETURNING attempt_id`,
      [
        this.#projectId,
        attemptId,
        input.expectedPhase,
        input.nextPhase,
        updatedAt,
      ],
    );
    if (rows.length === 0) {
      const current = await this.#settlementRow(attemptId);
      if (
        current?.kind === 'cancellation'
        && current.cancellation_phase === input.nextPhase
        && equalTimestamp(current.updated_at, updatedAt)
      ) {
        await this.#removeCandidate(attemptId);
        return 'replayed';
      }
      return stateConflict();
    }
    await this.#query(
      `UPDATE claudian_cloud.development_bootstrap_attempts
          SET state = $3, updated_at = $4
        WHERE project_id = $1 AND attempt_id = $2`,
      [this.#projectId, attemptId, input.nextPhase, updatedAt],
    );
    await this.#removeCandidate(attemptId);
    return 'advanced';
  }

  async markDevelopmentBootstrapActivationRecoveryRequired(
    input: DevelopmentBootstrapActivationRecoveryRequired,
  ): Promise<PersistenceAdvanceResult> {
    this.assertActive();
    const attemptId = opaqueId(input.attemptId);
    const updatedAt = isoTimestamp(input.updatedAt);
    if (!ACTIVATION_PHASES.has(input.expectedPhase)) invalidRecord();

    const rows = await this.#query<{ readonly attempt_id: string }>(
      `UPDATE claudian_cloud.development_bootstrap_attempts a
          SET state = 'recovery-required', updated_at = $4
         FROM claudian_cloud.development_bootstrap_settlements s
        WHERE a.project_id = $1
          AND a.attempt_id = $2
          AND a.state IN ('activating', 'activated')
          AND a.updated_at <= $4
          AND s.project_id = a.project_id
          AND s.attempt_id = a.attempt_id
          AND s.kind = 'activation'
          AND s.activation_phase = $3
      RETURNING a.attempt_id`,
      [this.#projectId, attemptId, input.expectedPhase, updatedAt],
    );
    if (rows.length === 0) {
      const attempt = await this.#requireAttempt(attemptId);
      const settlement = await this.#settlementRow(attemptId);
      const candidates = await this.#query<{ readonly operation_id: string }>(
        `SELECT operation_id
           FROM claudian_cloud.recovery_candidates
          WHERE kind = 'activation' AND project_id = $1`,
        [this.#projectId],
      );
      const projects = await this.#query<{ readonly service_state: string }>(
        `SELECT service_state
           FROM claudian_cloud.projects
          WHERE project_id = $1`,
        [this.#projectId],
      );
      if (
        attempt.state === 'recovery-required'
        && equalTimestamp(attempt.updated_at, updatedAt)
        && settlement?.kind === 'activation'
        && settlement.activation_phase === input.expectedPhase
        && candidates.length === 0
        && (projects[0] === undefined || projects[0].service_state === 'recovery-required')
      ) {
        await this.#removeActivePlacementCatalogEntry();
        return 'replayed';
      }
      return stateConflict();
    }

    await this.#query(
      `UPDATE claudian_cloud.projects
          SET service_state = 'recovery-required'
        WHERE project_id = $1`,
      [this.#projectId],
    );
    await this.#removeActivePlacementCatalogEntry();
    await this.#removeCandidate(attemptId);
    return 'advanced';
  }

  async insertActivatedDevelopmentProject(
    input: DevelopmentBootstrapProjectActivation,
  ): Promise<PersistencePutResult> {
    this.assertActive();
    const attemptId = opaqueId(input.attemptId);
    const activatedAt = isoTimestamp(input.activatedAt);
    const projectCreatedAt = isoTimestamp(input.projectCreatedAt);
    if (
      input.projectName.length === 0
      || input.projectName.length > COLLAB_LIMITS.maxProjectNameUtf16
      || !Number.isSafeInteger(input.managerSetGeneration)
      || input.managerSetGeneration < 0
      || !isCollabGitOid(input.expectedMainOid)
      || !STORAGE_KEY_PATTERN.test(input.repositoryStorageKey)
      || !STORAGE_NODE_PATTERN.test(input.storageNodeId)
    ) {
      invalidRecord();
    }
    const [first, second] = input.members;
    if (
      !isCollabMemberId(first.memberId)
      || !isCollabMemberId(second.memberId)
      || first.memberId === second.memberId
      || (first.role !== 'manager' && second.role !== 'manager')
    ) {
      invalidRecord();
    }
    for (const member of input.members) {
      isoTimestamp(member.createdAt);
      isoTimestamp(member.activatedAt);
      if (
        member.activatedAt < member.createdAt
        || member.displayName.length === 0
        || member.displayName.length > COLLAB_LIMITS.maxMemberDisplayNameUtf16
      ) {
        invalidRecord();
      }
    }
    const existing = await this.#query<ActivatedProjectRow>(
      `SELECT project_name,
              manager_set_generation,
              expected_main_oid,
              service_state,
              created_at,
              activated_at
         FROM claudian_cloud.projects
        WHERE project_id = $1`,
      [this.#projectId],
    );
    if (existing[0] !== undefined) {
      return await this.#verifyActivatedProjectReplay(input, existing[0]);
    }

    const settlement = await this.#settlementRow(attemptId);
    if (
      settlement?.kind !== 'activation'
      || settlement.activation_phase !== 'repository-published'
    ) {
      stateConflict();
    }

    await this.#query(
      `INSERT INTO claudian_cloud.projects (
         project_id,
         project_name,
         manager_set_generation,
         expected_main_oid,
         service_state,
         created_at,
         activated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
      [
        this.#projectId,
        input.projectName,
        input.managerSetGeneration,
        input.expectedMainOid,
        projectCreatedAt,
        activatedAt,
      ],
    );
    for (const member of input.members) {
      await this.#query(
        `INSERT INTO claudian_cloud.project_memberships (
           project_id,
           member_id,
           display_name,
           role,
           status,
           revision,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'active', 1, $5, $6)`,
        [
          this.#projectId,
          member.memberId,
          member.displayName,
          member.role,
          member.createdAt,
          member.activatedAt,
        ],
      );
      await this.#query(
        `INSERT INTO claudian_cloud.development_actor_mappings (
           project_id, actor_id, member_id, created_at
         ) VALUES ($1, $2, $2, $3)`,
        [this.#projectId, member.memberId, activatedAt],
      );
    }
    await this.#query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id,
         storage_node_id,
         repository_storage_key,
         generation,
         active,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, 1, true, $4, $4)`,
      [
        this.#projectId,
        input.storageNodeId,
        input.repositoryStorageKey,
        activatedAt,
      ],
    );
    await this.#query(
      `INSERT INTO claudian_cloud.active_repository_placement_catalog (
         project_id,
         storage_node_id,
         repository_storage_key,
         generation
       ) VALUES ($1, $2, $3, 1)`,
      [
        this.#projectId,
        input.storageNodeId,
        input.repositoryStorageKey,
      ],
    );
    return 'created';
  }

  async #verifyActivatedProjectReplay(
    input: DevelopmentBootstrapProjectActivation,
    project: ActivatedProjectRow,
  ): Promise<PersistencePutResult> {
    const members = await this.#query<ActivatedMemberRow>(
        `SELECT m.member_id,
                m.display_name,
                m.role,
                m.status,
                m.revision,
                m.created_at,
                m.updated_at AS activated_at,
                a.actor_id
           FROM claudian_cloud.project_memberships m
           JOIN claudian_cloud.development_actor_mappings a
             ON a.project_id = m.project_id
            AND a.member_id = m.member_id
          WHERE m.project_id = $1
          ORDER BY m.member_id`,
        [this.#projectId],
      );
    const placements = await this.#query<ActivatedPlacementRow>(
        `SELECT storage_node_id,
                repository_storage_key,
                generation,
                active
           FROM claudian_cloud.repository_placements
          WHERE project_id = $1`,
        [this.#projectId],
      );
    const catalogPlacements = await this.#query<ActivatedPlacementRow>(
        `SELECT storage_node_id,
                repository_storage_key,
                generation,
                true AS active
           FROM claudian_cloud.active_repository_placement_catalog
          WHERE project_id = $1`,
        [this.#projectId],
      );
    const expectedMembers = [...input.members].sort((left, right) => (
      left.memberId.localeCompare(right.memberId, 'en-US')
    ));
    const actualMembers = [...members].sort((left, right) => (
      left.member_id.localeCompare(right.member_id, 'en-US')
    ));
    const placement = placements[0];
    const catalogPlacement = catalogPlacements[0];
    if (
      project.project_name !== input.projectName
      || Number(project.manager_set_generation) !== input.managerSetGeneration
      || project.expected_main_oid !== input.expectedMainOid
      || project.service_state !== 'active'
      || !equalTimestamp(project.created_at, input.projectCreatedAt)
      || !equalTimestamp(project.activated_at, input.activatedAt)
      || actualMembers.length !== 2
      || placement === undefined
      || placement.storage_node_id !== input.storageNodeId
      || placement.repository_storage_key !== input.repositoryStorageKey
      || catalogPlacement === undefined
      || catalogPlacements.length !== 1
      || catalogPlacement.storage_node_id !== input.storageNodeId
      || catalogPlacement.repository_storage_key !== input.repositoryStorageKey
      || Number(catalogPlacement.generation) !== 1
      || placement.generation !== '1'
      || !placement.active
      || actualMembers.some((member, index) => {
        const expected = expectedMembers[index];
        return expected === undefined
          || member.member_id !== expected.memberId
          || member.display_name !== expected.displayName
          || member.actor_id !== expected.memberId
          || member.role !== expected.role
          || member.status !== 'active'
          || member.revision !== '1'
          || !equalTimestamp(member.created_at, expected.createdAt)
          || !equalTimestamp(member.activated_at, expected.activatedAt);
      })
    ) {
      return stateConflict();
    }
    return 'replayed';
  }

  async #attemptRow(attemptId: string): Promise<AttemptRow | undefined> {
    const rows = await this.#query<AttemptRow>(
      `SELECT project_id,
              attempt_id,
              source_host_member_id,
              manifest_sha256,
              manifest_json,
              state,
              bundle_state,
              created_at,
              expires_at,
              updated_at
         FROM claudian_cloud.development_bootstrap_attempts
        WHERE project_id = $1 AND attempt_id = $2`,
      [this.#projectId, attemptId],
    );
    if (rows.length > 1) dependencyFailure();
    return rows[0];
  }

  async #findNonterminalAttemptId(
    operationId?: string,
  ): Promise<string | undefined> {
    const operationPredicate = operationId === undefined
      ? ''
      : 'AND s.operation_id = $2';
    const rows = await this.#query<{ readonly attempt_id: string }>(
      `SELECT s.attempt_id
         FROM claudian_cloud.development_bootstrap_settlements s
        WHERE s.project_id = $1
          ${operationPredicate}
          AND (
            (s.kind = 'activation' AND s.activation_phase <> 'completed')
            OR (
              s.kind = 'cancellation'
              AND s.cancellation_phase = 'cancel-intent'
            )
          )
        ORDER BY s.attempt_id
        LIMIT 2`,
      operationId === undefined
        ? [this.#projectId]
        : [this.#projectId, operationId],
    );
    if (rows.length > 1) dependencyFailure();
    return rows[0]?.attempt_id;
  }

  async #requireAttempt(attemptId: string): Promise<AttemptRow> {
    const row = await this.#attemptRow(attemptId);
    if (row === undefined) stateConflict();
    return row;
  }

  async #settlementRow(attemptId: string): Promise<SettlementRow | undefined> {
    const rows = await this.#query<SettlementRow>(
      `SELECT attempt_id,
              operation_id,
              kind,
              activation_phase,
              cancellation_phase,
              journal_json,
              updated_at
         FROM claudian_cloud.development_bootstrap_settlements
        WHERE project_id = $1 AND attempt_id = $2`,
      [this.#projectId, attemptId],
    );
    if (rows.length > 1) dependencyFailure();
    return rows[0];
  }

  async #upsertCandidate(
    operationId: string,
    scheduledAt: string,
  ): Promise<void> {
    const rows = await this.#query<{ readonly operation_id: string }>(
      `INSERT INTO claudian_cloud.recovery_candidates (
         kind, project_id, operation_id, scheduled_at, created_at
       ) VALUES ('activation', $1, $2, $3, $3)
       ON CONFLICT (kind, project_id) DO UPDATE
         SET operation_id = EXCLUDED.operation_id,
             scheduled_at = EXCLUDED.scheduled_at
       WHERE claudian_cloud.recovery_candidates.operation_id = EXCLUDED.operation_id
       RETURNING operation_id`,
      [this.#projectId, operationId, scheduledAt],
    );
    if (rows.length !== 1 || rows[0]?.operation_id !== operationId) {
      stateConflict();
    }
  }

  async #upsertExpiryCandidate(
    attemptId: string,
    expiresAt: string,
  ): Promise<void> {
    const rows = await this.#query<{ readonly attempt_id: string }>(
      `INSERT INTO claudian_cloud.development_bootstrap_expiry_candidates (
         project_id, attempt_id, expires_at
       ) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, attempt_id) DO UPDATE
         SET expires_at = EXCLUDED.expires_at
       WHERE claudian_cloud.development_bootstrap_expiry_candidates.expires_at
             = EXCLUDED.expires_at
       RETURNING attempt_id`,
      [this.#projectId, attemptId, expiresAt],
    );
    if (rows.length !== 1 || rows[0]?.attempt_id !== attemptId) {
      stateConflict();
    }
  }

  async #removeExpiryCandidate(attemptId: string): Promise<void> {
    await this.#query(
      `DELETE FROM claudian_cloud.development_bootstrap_expiry_candidates
        WHERE project_id = $1 AND attempt_id = $2`,
      [this.#projectId, attemptId],
    );
  }

  async #removeCandidate(attemptId: string): Promise<void> {
    await this.#query(
      `DELETE FROM claudian_cloud.recovery_candidates c
        USING claudian_cloud.development_bootstrap_settlements s
        WHERE s.project_id = $1
          AND s.attempt_id = $2
          AND c.kind = 'activation'
          AND c.project_id = s.project_id
          AND c.operation_id = s.operation_id`,
      [this.#projectId, attemptId],
    );
    const remaining = await this.#query<{ readonly operation_id: string }>(
      `SELECT operation_id
         FROM claudian_cloud.recovery_candidates
        WHERE kind = 'activation' AND project_id = $1`,
      [this.#projectId],
    );
    if (remaining.length !== 0) stateConflict();
  }

  async #removeActivePlacementCatalogEntry(): Promise<void> {
    await this.#query(
      `DELETE FROM claudian_cloud.active_repository_placement_catalog
        WHERE project_id = $1`,
      [this.#projectId],
    );
    const remaining = await this.#query<{ readonly project_id: string }>(
      `SELECT project_id
         FROM claudian_cloud.active_repository_placement_catalog
        WHERE project_id = $1`,
      [this.#projectId],
    );
    if (remaining.length !== 0) stateConflict();
  }

  protected assertActive(): void {
    if (!this.#active) throw new CoordinationError('closed');
  }
}
