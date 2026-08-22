import {
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  collabMemberRef,
  isCollabGitOid,
  type CollabMemberId,
  type CollabGitOid,
  type CollabProjectId,
  isCollabMemberId,
} from '@claudian/collab-protocol';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import {
  GitReceiveAdmissionError,
  type GitReceiveAdmission,
  type GitReceivePermit,
} from '../resource-admission/GitReceiveAdmission.js';
import {
  ResourceAdmissionError,
  type ResourceAdmission,
  type GitChildPermit,
} from '../resource-admission/ResourceAdmission.js';
import {
  ProjectRequestRepositoryError,
  type ProjectRequestHeadValidationInput,
  type ProjectRequestInspection,
  type ProjectRequestInspectionInput,
} from '../project-authority/requests/ProjectRequestRepository.js';
import {
  ProjectAcceptRepositoryError,
  type InspectProjectAcceptInput,
  type ProjectAcceptInspection,
  type ProjectAcceptMainPlan,
  type ProjectAcceptRepository,
  type ProjectAcceptRepositoryReservation,
  type ProjectAcceptResultPlan,
} from '../project-authority/acceptance/ProjectAcceptRepository.js';
import {
  GitReceivePackPolicy,
  GitReceivePackPolicyError,
  type GitReceivePackPolicyOptions,
} from './GitReceivePackPolicy.js';
import {
  GitProcessError,
  GitProcessSupervisor,
} from './GitProcessSupervisor.js';
import { RepositoryPathPolicy } from './RepositoryPathPolicy.js';
import {
  createRepositoryPlacementLease,
  RepositoryPlacementError,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from './RepositoryPlacement.js';

export type GitRepositoryErrorCode =
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'git-unavailable'
  | 'input-limit'
  | 'output-limit'
  | 'placement-rejected'
  | 'placement-unavailable'
  | 'process-failed'
  | 'repository-corrupt'
  | 'repository-unavailable'
  | 'storage-unavailable'
  | 'timeout'
  | 'unsupported-git';

export class GitRepositoryError extends Error {
  readonly code: GitRepositoryErrorCode;
  readonly retryable: boolean;

  constructor(code: GitRepositoryErrorCode) {
    super(`git-repository.error.${code}`);
    this.name = 'GitRepositoryError';
    this.code = code;
    this.retryable = code === 'busy';
  }

  toJSON(): Readonly<Record<string, boolean | string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
      retryable: this.retryable,
    });
  }
}

export interface GitRepositoryAuthorityOptions {
  readonly gitExecutable: string;
  readonly operationTimeoutMs: number;
  readonly outputMaxBytes: number;
  readonly placementValidator: RepositoryPlacementValidator;
  readonly receiveAdmission?: GitReceiveAdmission;
  readonly receivePolicy?: Omit<
    GitReceivePackPolicyOptions,
    'gitExecutable' | 'maximumMetadataOutputBytes' | 'repositoryRoot'
  >;
  readonly repositoryRoot: string;
  readonly resourceAdmission: ResourceAdmission;
  readonly storageNodeId: string;
}

export interface GitReceivePackReservation {
  readonly projectId: CollabProjectId;
  close(): Promise<void>;
}

export interface GitReceivePackOperationOptions {
  readonly expectedMainOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface GitReceivePackAdvertisementOptions
  extends GitReceivePackOperationOptions {
  readonly gitProtocol?: 'version=1' | 'version=2';
}

export interface GitReceivePackOptions extends GitReceivePackOperationOptions {
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly onResponseChunk: (
    chunk: Buffer,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly request: AsyncIterable<Uint8Array>;
}

export interface VerifyRepositoryIntegrityOptions {
  readonly expectedRefs?: readonly ExpectedRepositoryRef[];
  readonly requiredRefs?: readonly ExpectedRepositoryRef[];
  readonly signal?: AbortSignal;
}

export interface VerifyProjectReadOptions {
  readonly expectedRefs: readonly ExpectedRepositoryRef[];
  readonly expectedMainOid: CollabGitOid;
  readonly placement: RepositoryPlacementLease;
  readonly signal?: AbortSignal;
}

export interface GitUploadPackOptions {
  readonly expectedRefs: readonly ExpectedRepositoryRef[];
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly maximumResponseBytes: number;
  readonly onResponseChunk: (
    chunk: Buffer,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly request: Buffer;
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface GitUploadPackAdvertisementOptions {
  readonly expectedRefs: readonly ExpectedRepositoryRef[];
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ExpectedRepositoryRef {
  readonly name: string;
  readonly oid?: string;
}

export interface RepositoryIntegrityResult {
  readonly status: 'valid';
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new GitRepositoryError('cancelled');
}

function mapPlacementError(error: RepositoryPlacementError): GitRepositoryError {
  if (error.code === 'placement-unavailable') {
    return new GitRepositoryError('placement-unavailable');
  }
  if (
    error.code === 'inactive-placement'
    || error.code === 'invalid-placement'
    || error.code === 'stale-placement'
    || error.code === 'wrong-storage-node'
  ) {
    return new GitRepositoryError('placement-rejected');
  }
  return new GitRepositoryError('repository-unavailable');
}

function mapAdmissionError(error: ResourceAdmissionError): GitRepositoryError {
  if (error.code === 'busy') return new GitRepositoryError('busy');
  if (error.code === 'cancelled') return new GitRepositoryError('cancelled');
  if (error.code === 'invalid-project') {
    return new GitRepositoryError('placement-rejected');
  }
  return new GitRepositoryError('closed');
}

function mapReceiveAdmissionError(
  error: GitReceiveAdmissionError,
): GitRepositoryError {
  if (error.code === 'busy') return new GitRepositoryError('busy');
  if (error.code === 'cancelled') return new GitRepositoryError('cancelled');
  if (error.code === 'input-limit') return new GitRepositoryError('input-limit');
  if (error.code === 'invalid-project') {
    return new GitRepositoryError('placement-rejected');
  }
  if (error.code === 'storage-unavailable') {
    return new GitRepositoryError('storage-unavailable');
  }
  return new GitRepositoryError('closed');
}

function mapReceivePolicyError(
  error: GitReceivePackPolicyError,
): GitRepositoryError {
  if (error.code === 'closed') return new GitRepositoryError('closed');
  if (error.code === 'storage-unavailable') {
    return new GitRepositoryError('storage-unavailable');
  }
  return new GitRepositoryError('repository-corrupt');
}

function mapProcessError(error: GitProcessError): GitRepositoryError {
  return new GitRepositoryError(error.code);
}

function containedPath(root: string, candidate: string): boolean {
  const descendant = relative(root, candidate);
  return descendant.length > 0
    && descendant !== '..'
    && !descendant.startsWith(`..${sep}`)
    && !descendant.includes('\0');
}

function assertExactRefs(
  output: Buffer,
  expectedRefs: readonly ExpectedRepositoryRef[],
): void {
  const actual = output.toString('utf8').split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('\0');
    if (separator <= 0 || line.indexOf('\0', separator + 1) !== -1) {
      throw new GitRepositoryError('repository-corrupt');
    }
    return Object.freeze({
      name: line.slice(0, separator),
      oid: line.slice(separator + 1),
    });
  });
  const expectedByName = new Map(expectedRefs.map(ref => [ref.name, ref]));
  const actualByName = new Map(actual.map(ref => [ref.name, ref.oid]));
  if (
    actual.length !== expectedRefs.length
    || actualByName.size !== actual.length
    || expectedByName.size !== expectedRefs.length
    || actual.some(ref => !isCollabGitOid(ref.oid))
    || expectedRefs.some(expectedRef => {
      const actualOid = actualByName.get(expectedRef.name);
      return actualOid === undefined
        || (expectedRef.oid !== undefined && actualOid !== expectedRef.oid);
    })
  ) {
    throw new GitRepositoryError('repository-corrupt');
  }
}

function assertRequiredRefs(
  output: Buffer,
  requiredRefs: readonly ExpectedRepositoryRef[],
): void {
  const actual = output.toString('utf8').split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('\0');
    if (separator <= 0 || line.indexOf('\0', separator + 1) !== -1) {
      throw new GitRepositoryError('repository-corrupt');
    }
    return Object.freeze({
      name: line.slice(0, separator),
      oid: line.slice(separator + 1),
    });
  });
  const actualByName = new Map(actual.map(ref => [ref.name, ref.oid]));
  if (
    actualByName.size !== actual.length
    || actual.some(ref => !isCollabGitOid(ref.oid))
    || requiredRefs.some(requiredRef => {
      const oid = actualByName.get(requiredRef.name);
      return oid === undefined
        || (requiredRef.oid !== undefined && oid !== requiredRef.oid);
    })
  ) {
    throw new GitRepositoryError('repository-corrupt');
  }
}

function parseRefs(output: Buffer): ReadonlyMap<string, CollabGitOid> {
  const refs = new Map<string, CollabGitOid>();
  for (const line of output.toString('utf8').split('\n').filter(Boolean)) {
    const separator = line.indexOf('\0');
    const name = line.slice(0, separator);
    const oid = line.slice(separator + 1);
    if (
      separator <= 0
      || line.indexOf('\0', separator + 1) !== -1
      || refs.has(name)
      || !isCollabGitOid(oid)
    ) {
      throw new GitRepositoryError('repository-corrupt');
    }
    refs.set(name, oid);
  }
  return refs;
}

function sameRefs(
  left: ReadonlyMap<string, CollabGitOid>,
  right: ReadonlyMap<string, CollabGitOid>,
): boolean {
  return left.size === right.size
    && [...left].every(([name, oid]) => right.get(name) === oid);
}

function acceptError(
  code: ConstructorParameters<typeof ProjectAcceptRepositoryError>[0],
): never {
  throw new ProjectAcceptRepositoryError(code);
}

function acceptObjectFormat(output: Buffer): 'sha1' | 'sha256' {
  const format = output.toString('ascii').trim();
  if (format !== 'sha1' && format !== 'sha256') return acceptError('state-conflict');
  return format;
}

function acceptCommitBytes(plan: ProjectAcceptResultPlan): Buffer {
  if (plan.resultKind !== 'merge') return acceptError('invalid-plan');
  const commit = plan.commit;
  const timestamp = Date.parse(plan.preparedAt);
  if (
    Number.isNaN(timestamp)
    || timestamp % 1_000 !== 0
    || commit.authorName !== 'Claudian Collab'
    || commit.authorEmail !== 'collab@claudian.local'
    || commit.committerName !== 'Claudian Collab'
    || commit.committerEmail !== 'collab@claudian.local'
    || commit.parents[0] !== plan.expectedMainOid
    || commit.parents[1] !== plan.expectedHeadOid
    || commit.message !== `Accept request ${plan.requestId}\n`
    || plan.preparedAt !== new Date(timestamp).toISOString()
  ) {
    return acceptError('invalid-plan');
  }
  const epoch = Math.floor(timestamp / 1_000);
  return Buffer.from([
    `tree ${commit.treeOid}`,
    `parent ${commit.parents[0]}`,
    `parent ${commit.parents[1]}`,
    `author ${commit.authorName} <${commit.authorEmail}> ${String(epoch)} +0000`,
    `committer ${commit.committerName} <${commit.committerEmail}> ${String(epoch)} +0000`,
    '',
    commit.message,
  ].join('\n'), 'utf8');
}

function validAcceptOid(
  oid: unknown,
  objectFormat: 'sha1' | 'sha256',
): oid is CollabGitOid {
  return isCollabGitOid(oid)
    && oid.length === (objectFormat === 'sha1' ? 40 : 64);
}

function validAcceptPersonalRef(personalRef: string): boolean {
  if (!personalRef.startsWith(COLLAB_MEMBER_REF_PREFIX)) return false;
  const memberId = personalRef.slice(COLLAB_MEMBER_REF_PREFIX.length);
  return isCollabMemberId(memberId) && collabMemberRef(memberId) === personalRef;
}

function assertAcceptPlan(plan: ProjectAcceptResultPlan): void {
  if (
    plan.personalRef !== collabMemberRef(plan.requestMemberId)
    || !validAcceptOid(plan.expectedMainOid, plan.objectFormat)
    || !validAcceptOid(plan.expectedHeadOid, plan.objectFormat)
    || plan.relations.some(relation => (
      !validAcceptOid(relation.commitOid, plan.objectFormat)
    ))
    || (
      plan.resultOid !== undefined
      && !validAcceptOid(plan.resultOid, plan.objectFormat)
    )
    || (
      plan.resultKind === 'merge'
      && !validAcceptOid(plan.commit.treeOid, plan.objectFormat)
    )
  ) return acceptError('invalid-plan');
}

interface ReceiveReservationState {
  readonly child: GitChildPermit;
  readonly permit: GitReceivePermit;
  readonly projectId: CollabProjectId;
  active: boolean;
  inUse: boolean;
}

interface AcceptReservationState {
  active: boolean;
  readonly child: GitChildPermit;
  inUse: boolean;
  readonly projectId: CollabProjectId;
}

const RECEIVE_POLICY_METADATA_MAX_BYTES = 48 * 1_024 * 1_024;
const ACCEPT_TREE_OUTPUT_MAX_BYTES = 112 * 1_024 * 1_024;
const ACCEPT_MAX_EXPANDED_TREE_ENTRIES = 100_000;
const WINDOWS_RESERVED_PATH = /^(?:con|prn|aux|nul|com(?:[1-9¹²³])|lpt(?:[1-9¹²³]))(?:\..*)?$/iu;
const WINDOWS_INVALID_PATH = /[<>:"\\|?*]/u;
const RESERVED_REPOSITORY_ROOTS = new Set(['.claudian', '.git', 'workspace']);

function invalidPathControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function validPortablePathSegment(segment: string): boolean {
  return segment.length > 0
    && segment.length <= COLLAB_LIMITS.maxPathSegmentUtf16
    && segment !== '.'
    && segment !== '..'
    && !invalidPathControl(segment)
    && !WINDOWS_INVALID_PATH.test(segment)
    && !/[. ]$/u.test(segment)
    && !WINDOWS_RESERVED_PATH.test(segment)
    && !RESERVED_REPOSITORY_ROOTS.has(
      segment.normalize('NFC').toLocaleLowerCase('en-US'),
    );
}

class AcceptTreePolicyParser {
  readonly #comparisons = new Map<string, string>();
  readonly #entriesByParent = new Map<string, number>();
  readonly #objectFormat: 'sha1' | 'sha256';
  #buffer = Buffer.alloc(0);
  #entryCount = 0;
  #invalid = false;

  constructor(objectFormat: 'sha1' | 'sha256') {
    this.#objectFormat = objectFormat;
  }

  push(chunk: Buffer): void {
    if (this.#invalid) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const end = this.#buffer.indexOf(0);
      if (end < 0) {
        if (this.#buffer.length > 2_048) this.#reject();
        return;
      }
      const record = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      this.#parse(record);
    }
  }

  finish(): void {
    if (this.#invalid || this.#buffer.length !== 0) acceptError('unsupported-tree');
  }

  #parse(record: Buffer): void {
    const separator = record.indexOf(0x09);
    if (separator <= 0) return this.#reject();
    const metadata = record.subarray(0, separator).toString('ascii').split(' ');
    if (metadata.length !== 3) return this.#reject();
    const [mode, type, oid] = metadata;
    if (
      oid === undefined
      || !validAcceptOid(oid, this.#objectFormat)
      || !(
        (type === 'tree' && (mode === '040000' || mode === '40000'))
        || (type === 'blob' && (mode === '100644' || mode === '100755'))
      )
    ) return this.#reject();
    let path: string;
    try {
      path = new TextDecoder('utf-8', { fatal: true }).decode(
        record.subarray(separator + 1),
      );
    } catch {
      return this.#reject();
    }
    const segments = path.split('/');
    if (
      path.length === 0
      || path.length > COLLAB_LIMITS.maxRepositoryPathUtf16
      || segments.some(segment => !validPortablePathSegment(segment))
    ) return this.#reject();
    this.#entryCount += 1;
    if (this.#entryCount > ACCEPT_MAX_EXPANDED_TREE_ENTRIES) return this.#reject();
    const parent = segments.slice(0, -1).join('/');
    const parentEntries = (this.#entriesByParent.get(parent) ?? 0) + 1;
    if (parentEntries > COLLAB_LIMITS.maxChangedPaths) return this.#reject();
    this.#entriesByParent.set(parent, parentEntries);
    const comparison = path.normalize('NFC').toLocaleLowerCase('en-US');
    const prior = this.#comparisons.get(comparison);
    if (prior !== undefined && prior !== path) return this.#reject();
    this.#comparisons.set(comparison, path);
  }

  #reject(): void {
    this.#invalid = true;
    this.#buffer = Buffer.alloc(0);
  }
}

export class GitRepositoryAuthority implements ProjectAcceptRepository {
  readonly #acceptReservations = new WeakMap<
    ProjectAcceptRepositoryReservation,
    AcceptReservationState
  >();
  readonly #activeAcceptReservations = new Set<AcceptReservationState>();
  readonly #activeReceiveReservations = new Set<ReceiveReservationState>();
  readonly #pathPolicy: RepositoryPathPolicy;
  readonly #receiveAdmission: GitReceiveAdmission | undefined;
  readonly #receivePolicy: GitReceivePackPolicy | undefined;
  readonly #receiveReservations = new WeakMap<
    GitReceivePackReservation,
    ReceiveReservationState
  >();
  readonly #resourceAdmission: ResourceAdmission;
  readonly #supervisor: GitProcessSupervisor;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: GitRepositoryAuthorityOptions) {
    if ((options.receiveAdmission === undefined) !== (options.receivePolicy === undefined)) {
      throw new TypeError('git-repository.receive-options-invalid');
    }
    this.#pathPolicy = new RepositoryPathPolicy({
      placementValidator: options.placementValidator,
      repositoryRoot: options.repositoryRoot,
      storageNodeId: options.storageNodeId,
    });
    this.#resourceAdmission = options.resourceAdmission;
    this.#receiveAdmission = options.receiveAdmission;
    this.#receivePolicy = options.receivePolicy === undefined
      ? undefined
      : new GitReceivePackPolicy({
        gitExecutable: options.gitExecutable,
        maximumMetadataOutputBytes: Math.max(
          options.outputMaxBytes,
          RECEIVE_POLICY_METADATA_MAX_BYTES,
        ),
        repositoryRoot: options.repositoryRoot,
        ...options.receivePolicy,
      });
    this.#supervisor = new GitProcessSupervisor({
      gitExecutable: options.gitExecutable,
      operationTimeoutMs: options.operationTimeoutMs,
      outputMaxBytes: options.outputMaxBytes,
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#receivePolicy?.close();
      for (const state of this.#activeReceiveReservations) {
        state.active = false;
        state.permit.release();
        state.child.release();
      }
      this.#activeReceiveReservations.clear();
      for (const state of this.#activeAcceptReservations) {
        state.active = false;
        state.child.release();
      }
      this.#activeAcceptReservations.clear();
      this.#closePromise = Promise.allSettled([
        this.#supervisor.close(),
        this.#receiveAdmission?.close() ?? Promise.resolve(),
      ]).then(() => undefined);
    }
    return this.#closePromise;
  }

  async verifyCapability(): Promise<Readonly<{ status: 'supported' }>> {
    this.#assertOpen();
    try {
      await this.#pathPolicy.verifyRoot();
      await this.#supervisor.verifyVersion();
      await this.#receivePolicy?.verifyCapability();
    } catch (error: unknown) {
      if (error instanceof RepositoryPlacementError) {
        throw mapPlacementError(error);
      }
      if (error instanceof GitProcessError) throw mapProcessError(error);
      if (error instanceof GitReceivePackPolicyError) {
        throw mapReceivePolicyError(error);
      }
      throw new GitRepositoryError('git-unavailable');
    }
    return Object.freeze({ status: 'supported' as const });
  }

  async verifyIntegrity(
    placement: RepositoryPlacementLease,
    options: VerifyRepositoryIntegrityOptions = {},
  ): Promise<RepositoryIntegrityResult> {
    if (this.#closed) throw new GitRepositoryError('closed');
    let placementSnapshot: RepositoryPlacementLease;
    try {
      placementSnapshot = createRepositoryPlacementLease(placement);
    } catch (error: unknown) {
      if (error instanceof RepositoryPlacementError) {
        throw mapPlacementError(error);
      }
      throw new GitRepositoryError('placement-rejected');
    }
    let permit;
    try {
      permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'read',
        projectId: placementSnapshot.projectId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError) throw mapAdmissionError(error);
      throw new GitRepositoryError('process-failed');
    }

    try {
      this.#assertOpen();
      if (options.signal?.aborted === true) {
        throw new GitRepositoryError('cancelled');
      }
      let resolved;
      try {
        resolved = await this.#pathPolicy.resolveExisting(placementSnapshot);
        await this.#pathPolicy.revalidate(placementSnapshot);
      } catch (error: unknown) {
        if (error instanceof RepositoryPlacementError) {
          throw mapPlacementError(error);
        }
        throw new GitRepositoryError('repository-unavailable');
      }
      try {
        await this.#supervisor.verifyBareRepository(
          resolved.repositoryPath,
          options.signal,
        );
        resolved = await this.#pathPolicy.resolveExisting(placementSnapshot);
        await this.#pathPolicy.revalidate(placementSnapshot);
        if (
          options.expectedRefs !== undefined
          || options.requiredRefs !== undefined
        ) {
          const refs = await this.#supervisor.runCommand({
            arguments: [
              'for-each-ref',
              '--format=%(refname)%00%(objectname)',
              'refs',
            ],
            captureOutput: true,
            cwd: resolved.repositoryPath,
            failureCode: 'repository-corrupt',
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          if (options.expectedRefs !== undefined) {
            assertExactRefs(refs, options.expectedRefs);
          }
          if (options.requiredRefs !== undefined) {
            assertRequiredRefs(refs, options.requiredRefs);
          }
        }
        await this.#supervisor.runIntegrityCheck(
          resolved.repositoryPath,
          options.signal,
        );
      } catch (error: unknown) {
        if (error instanceof RepositoryPlacementError) {
          throw mapPlacementError(error);
        }
        if (error instanceof GitRepositoryError) throw error;
        if (error instanceof GitProcessError) throw mapProcessError(error);
        throw new GitRepositoryError('process-failed');
      }
      return Object.freeze({ status: 'valid' as const });
    } finally {
      permit.release();
    }
  }

  async verifyProjectRead(options: VerifyProjectReadOptions): Promise<void> {
    if (!options.expectedRefs.some(ref => (
      ref.name === COLLAB_MAIN_REF && ref.oid === options.expectedMainOid
    ))) {
      throw new GitRepositoryError('repository-corrupt');
    }
    await this.verifyIntegrity(options.placement, {
      expectedRefs: options.expectedRefs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  inspectRequest(
    input: ProjectRequestInspectionInput,
  ): Promise<ProjectRequestInspection> {
    return this.#runRequestRead(input, async (repositoryPath, refs) => {
      if (refs.get(COLLAB_MAIN_REF) !== input.expectedMainOid) {
        throw new ProjectRequestRepositoryError('stale-main');
      }
      const personalOid = refs.get(input.personalRef);
      if (personalOid === undefined) {
        throw new ProjectRequestRepositoryError('state-conflict');
      }
      const mergeBase = await this.#supervisor.runCommand({
        arguments: ['merge-base', input.firstBaseOid, input.latestHeadOid],
        captureOutput: true,
        cwd: repositoryPath,
        failureCode: 'repository-corrupt',
        signal: input.signal,
      });
      if (mergeBase.toString('utf8').trim() !== input.firstBaseOid) {
        throw new ProjectRequestRepositoryError('state-conflict');
      }
      if (personalOid !== input.latestHeadOid) {
        return Object.freeze({
          currentMainOid: input.expectedMainOid,
          reviewCondition: 'stale' as const,
          reviewedHeadOid: input.latestHeadOid,
        });
      }
      const mergeTree = await this.#supervisor.runCommand({
        acceptedExitCodes: [0, 1],
        arguments: ['merge-tree', '--write-tree', input.expectedMainOid, input.latestHeadOid],
        captureOutput: true,
        cwd: repositoryPath,
        failureCode: 'repository-corrupt',
        signal: input.signal,
      });
      const lines = mergeTree.toString('utf8').trimEnd().split('\n');
      if (!isCollabGitOid(lines[0] ?? '')) {
        throw new ProjectRequestRepositoryError('state-conflict');
      }
      return Object.freeze({
        currentMainOid: input.expectedMainOid,
        reviewCondition: lines.length === 1 ? 'clean' as const : 'conflicting' as const,
        reviewedHeadOid: input.latestHeadOid,
      });
    });
  }

  validateRequestHead(input: ProjectRequestHeadValidationInput): Promise<void> {
    return this.#runRequestRead(input, async (repositoryPath, refs) => {
      if (refs.get(COLLAB_MAIN_REF) !== input.expectedMainOid) {
        throw new ProjectRequestRepositoryError('stale-main');
      }
      if (refs.get(input.personalRef) !== input.headOid) {
        throw new ProjectRequestRepositoryError('head-not-pushed');
      }
      await this.#supervisor.runCommand({
        arguments: ['cat-file', '-e', `${input.headOid}^{commit}`],
        captureOutput: false,
        cwd: repositoryPath,
        failureCode: 'repository-corrupt',
        signal: input.signal,
      });
    });
  }

  inspectAccept(
    reservation: ProjectAcceptRepositoryReservation,
    input: InspectProjectAcceptInput,
  ): Promise<ProjectAcceptInspection> {
    if (
      input.placement.projectId !== input.projectId
      || !validAcceptPersonalRef(input.personalRef)
    ) {
      return Promise.reject(new ProjectAcceptRepositoryError('invalid-plan'));
    }
    return this.#runAcceptOperation(
      reservation,
      input.placement,
      input.signal,
      async (repositoryPath, placement) => {
        const objectFormat = await this.#readAcceptObjectFormat(
          repositoryPath,
          input.signal,
        );
        if (
          !validAcceptOid(input.expectedMainOid, objectFormat)
          || !validAcceptOid(input.expectedHeadOid, objectFormat)
          || input.relationCommitOids.some(oid => !validAcceptOid(oid, objectFormat))
        ) return acceptError('invalid-plan');
        const before = await this.#readRefs(repositoryPath, input.signal);
        this.#assertAcceptRefs(before, input.expectedMainOid, input.expectedHeadOid,
          input.personalRef);
        await this.#assertCommit(repositoryPath, input.expectedMainOid, input.signal);
        await this.#assertCommit(repositoryPath, input.expectedHeadOid, input.signal);
        for (const relationOid of input.relationCommitOids) {
          if (!await this.#isAncestor(
            repositoryPath,
            relationOid,
            input.expectedHeadOid,
            input.signal,
          )) return acceptError('stale-relation');
        }
        let result: ProjectAcceptInspection;
        if (await this.#isAncestor(
          repositoryPath,
          input.expectedHeadOid,
          input.expectedMainOid,
          input.signal,
        )) {
          await this.#assertAcceptTreePolicy(
            repositoryPath,
            input.expectedMainOid,
            objectFormat,
            input.signal,
          );
          result = Object.freeze({ kind: 'contained' as const, objectFormat });
        } else {
          const mergeTree = await this.#supervisor.runCommand({
            acceptedExitCodes: [0, 1],
            arguments: [
              'merge-tree',
              '--write-tree',
              input.expectedMainOid,
              input.expectedHeadOid,
            ],
            captureOutput: true,
            cwd: repositoryPath,
            failureCode: 'repository-corrupt',
            signal: input.signal,
          });
          const lines = mergeTree.toString('utf8').trimEnd().split('\n');
          const treeOid = lines[0] ?? '';
          if (!isCollabGitOid(treeOid)) return acceptError('state-conflict');
          if (lines.length !== 1) return acceptError('conflicting');
          await this.#assertTree(repositoryPath, treeOid, input.signal);
          await this.#assertAcceptTreePolicy(
            repositoryPath,
            treeOid,
            objectFormat,
            input.signal,
          );
          result = Object.freeze({
            kind: 'merge' as const,
            objectFormat,
            treeOid,
          });
        }
        await this.#pathPolicy.revalidate(placement);
        await input.revalidateAuthority();
        this.#assertOpen();
        assertNotAborted(input.signal);
        const after = await this.#readRefs(repositoryPath, input.signal);
        if (!sameRefs(before, after)) return acceptError('state-conflict');
        return result;
      },
    );
  }

  materializeAcceptResult(
    reservation: ProjectAcceptRepositoryReservation,
    plan: ProjectAcceptResultPlan,
  ): Promise<CollabGitOid> {
    let placement: RepositoryPlacementLease;
    try {
      placement = createRepositoryPlacementLease({
        active: true,
        ...plan.placement,
      });
    } catch {
      return Promise.reject(new ProjectAcceptRepositoryError('invalid-plan'));
    }
    if (
      plan.personalRef !== collabMemberRef(plan.requestMemberId)
    ) {
      return Promise.reject(new ProjectAcceptRepositoryError('invalid-plan'));
    }
    try {
      assertAcceptPlan(plan);
    } catch {
      return Promise.reject(new ProjectAcceptRepositoryError('invalid-plan'));
    }
    return this.#runAcceptOperation(
      reservation,
      placement,
      undefined,
      async (repositoryPath, currentPlacement) => {
        const objectFormat = await this.#readAcceptObjectFormat(repositoryPath);
        if (objectFormat !== plan.objectFormat) return acceptError('state-conflict');
        const refs = await this.#readRefs(repositoryPath);
        if (refs.get(plan.personalRef) !== plan.expectedHeadOid) {
          return acceptError('stale-head');
        }
        for (const relation of plan.relations) {
          if (!await this.#isAncestor(
            repositoryPath,
            relation.commitOid,
            plan.expectedHeadOid,
          )) return acceptError('stale-relation');
        }
        if (plan.resultKind === 'contained') {
          if (refs.get(plan.mainRef) !== plan.expectedMainOid) {
            return acceptError('stale-main');
          }
          if (plan.resultOid !== undefined && plan.resultOid !== plan.expectedMainOid) {
            return acceptError('invalid-plan');
          }
          if (!await this.#isAncestor(
            repositoryPath,
            plan.expectedHeadOid,
            plan.expectedMainOid,
          )) return acceptError('state-conflict');
          await this.#assertAcceptTreePolicy(
            repositoryPath,
            plan.expectedMainOid,
            objectFormat,
          );
          return plan.expectedMainOid;
        }
        const bytes = acceptCommitBytes(plan);
        await this.#assertTree(repositoryPath, plan.commit.treeOid);
        await this.#assertAcceptTreePolicy(
          repositoryPath,
          plan.commit.treeOid,
          objectFormat,
        );
        await this.#pathPolicy.revalidate(currentPlacement);
        const output = await this.#supervisor.runCommand({
          arguments: ['hash-object', '-t', 'commit', '-w', '--stdin'],
          captureOutput: true,
          cwd: repositoryPath,
          failureCode: 'repository-corrupt',
          input: bytes,
        });
        const resultOid = output.toString('ascii').trim();
        if (
          !isCollabGitOid(resultOid)
          || resultOid.length !== (objectFormat === 'sha1' ? 40 : 64)
          || (plan.resultOid !== undefined && resultOid !== plan.resultOid)
        ) return acceptError('state-conflict');
        const persisted = await this.#supervisor.runCommand({
          arguments: ['cat-file', 'commit', resultOid],
          captureOutput: true,
          cwd: repositoryPath,
          failureCode: 'repository-corrupt',
        });
        if (!persisted.equals(bytes)) return acceptError('state-conflict');
        const currentMainOid = refs.get(plan.mainRef);
        if (
          currentMainOid !== plan.expectedMainOid
          && currentMainOid !== resultOid
        ) return acceptError('stale-main');
        return resultOid;
      },
    );
  }

  settleAcceptMain(
    reservation: ProjectAcceptRepositoryReservation,
    plan: ProjectAcceptMainPlan,
  ): Promise<'advanced' | 'replayed'> {
    let placement: RepositoryPlacementLease;
    try {
      placement = createRepositoryPlacementLease({
        active: true,
        ...plan.placement,
      });
    } catch {
      return Promise.reject(new ProjectAcceptRepositoryError('invalid-plan'));
    }
    if (!isCollabGitOid(plan.resultOid)) {
      return Promise.reject(new ProjectAcceptRepositoryError('invalid-plan'));
    }
    try {
      assertAcceptPlan(plan);
    } catch {
      return Promise.reject(new ProjectAcceptRepositoryError('invalid-plan'));
    }
    return this.#runAcceptOperation(
      reservation,
      placement,
      undefined,
      async (repositoryPath, currentPlacement) => {
        const objectFormat = await this.#readAcceptObjectFormat(repositoryPath);
        if (
          objectFormat !== plan.objectFormat
          || plan.resultOid.length !== (objectFormat === 'sha1' ? 40 : 64)
        ) return acceptError('state-conflict');
        if (plan.resultKind === 'contained') {
          if (plan.resultOid !== plan.expectedMainOid) return acceptError('invalid-plan');
          await this.#assertCommit(repositoryPath, plan.resultOid);
          await this.#assertAcceptTreePolicy(
            repositoryPath,
            plan.resultOid,
            objectFormat,
          );
        } else {
          const bytes = acceptCommitBytes(plan);
          await this.#assertTree(repositoryPath, plan.commit.treeOid);
          await this.#assertAcceptTreePolicy(
            repositoryPath,
            plan.commit.treeOid,
            objectFormat,
          );
          const persisted = await this.#supervisor.runCommand({
            arguments: ['cat-file', 'commit', plan.resultOid],
            captureOutput: true,
            cwd: repositoryPath,
            failureCode: 'repository-corrupt',
          });
          if (!persisted.equals(bytes)) return acceptError('state-conflict');
        }
        const before = await this.#readRefs(repositoryPath);
        const personalOid = before.get(plan.personalRef);
        const mainOid = before.get(plan.mainRef);
        if (personalOid !== plan.expectedHeadOid) return acceptError('stale-head');
        if (mainOid === plan.resultOid) return 'replayed';
        if (mainOid !== plan.expectedMainOid || plan.resultKind === 'contained') {
          return acceptError('stale-main');
        }
        await this.#pathPolicy.revalidate(currentPlacement);
        try {
          await this.#supervisor.runCommand({
            arguments: [
              'update-ref',
              plan.mainRef,
              plan.resultOid,
              plan.expectedMainOid,
            ],
            captureOutput: false,
            cwd: repositoryPath,
            failureCode: 'repository-corrupt',
          });
        } catch (error: unknown) {
          if (!(error instanceof GitProcessError)) throw error;
          const raced = await this.#readRefs(repositoryPath);
          if (raced.get(plan.mainRef) === plan.resultOid) return 'replayed';
          return acceptError('state-conflict');
        }
        const after = await this.#readRefs(repositoryPath);
        if (
          after.get(plan.mainRef) !== plan.resultOid
          || after.size !== before.size
          || [...before].some(([name, oid]) => (
            name === plan.mainRef
              ? after.get(name) !== plan.resultOid
              : after.get(name) !== oid
          ))
        ) return acceptError('state-conflict');
        return 'advanced';
      },
    );
  }

  async reserveReceivePack(
    projectId: CollabProjectId,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<GitReceivePackReservation> {
    this.#assertOpen();
    if (this.#receiveAdmission === undefined || this.#receivePolicy === undefined) {
      throw new GitRepositoryError('repository-unavailable');
    }
    let child: GitChildPermit;
    try {
      child = await this.#resourceAdmission.acquireGitChild({
        classification: 'write',
        projectId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError) throw mapAdmissionError(error);
      throw new GitRepositoryError('process-failed');
    }
    let permit: GitReceivePermit;
    try {
      permit = await this.#receiveAdmission.acquire({
        projectId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error: unknown) {
      child.release();
      if (error instanceof GitReceiveAdmissionError) {
        throw mapReceiveAdmissionError(error);
      }
      throw new GitRepositoryError('storage-unavailable');
    }
    const reservation: GitReceivePackReservation = Object.freeze({
      projectId,
      close: (): Promise<void> => {
        const state = this.#receiveReservations.get(reservation);
        if (state?.active === true) {
          state.active = false;
          this.#activeReceiveReservations.delete(state);
          state.permit.release();
          state.child.release();
        }
        return Promise.resolve();
      },
    });
    const state: ReceiveReservationState = {
      active: true,
      child,
      inUse: false,
      permit,
      projectId,
    };
    this.#receiveReservations.set(reservation, state);
    this.#activeReceiveReservations.add(state);
    return reservation;
  }

  async reserveAccept(
    projectId: CollabProjectId,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<ProjectAcceptRepositoryReservation> {
    this.#assertOpen();
    let child: GitChildPermit;
    try {
      child = await this.#resourceAdmission.acquireGitChild({
        classification: 'write',
        projectId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError && error.code === 'cancelled') {
        throw new ProjectAcceptRepositoryError('cancelled');
      }
      throw new ProjectAcceptRepositoryError('unavailable');
    }
    const reservation: ProjectAcceptRepositoryReservation = Object.freeze({
      close: (): Promise<void> => {
        const state = this.#acceptReservations.get(reservation);
        if (state?.active === true) {
          state.active = false;
          this.#activeAcceptReservations.delete(state);
          state.child.release();
        }
        return Promise.resolve();
      },
      projectId,
    });
    const state: AcceptReservationState = {
      active: true,
      child,
      inUse: false,
      projectId,
    };
    this.#acceptReservations.set(reservation, state);
    this.#activeAcceptReservations.add(state);
    return reservation;
  }

  advertiseReceivePack(
    reservation: GitReceivePackReservation,
    placement: RepositoryPlacementLease,
    options: GitReceivePackAdvertisementOptions,
  ): Promise<Buffer> {
    return this.#runReceiveOperation(
      reservation,
      placement,
      options,
      async (repositoryPath, before, _state, placementSnapshot) => {
        this.#assertExpectedReceiveRefs(before, options);
        await this.#pathPolicy.revalidate(placementSnapshot);
        await options.revalidateAuthority();
        this.#assertOpen();
        assertNotAborted(options.signal);
        return this.#supervisor.runCommand({
          arguments: ['receive-pack', '--stateless-rpc', '--advertise-refs', '.'],
          captureOutput: true,
          cwd: repositoryPath,
          failureCode: 'process-failed',
          ...(options.gitProtocol === undefined
            ? {}
            : { gitProtocol: options.gitProtocol }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      },
    );
  }

  runReceivePack(
    reservation: GitReceivePackReservation,
    placement: RepositoryPlacementLease,
    options: GitReceivePackOptions,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(options.maximumRequestBytes)
      || options.maximumRequestBytes < 1
      || !Number.isSafeInteger(options.maximumResponseBytes)
      || options.maximumResponseBytes < 1
    ) {
      return Promise.reject(new GitRepositoryError('input-limit'));
    }
    return this.#runReceiveOperation(
      reservation,
      placement,
      options,
      async (repositoryPath, before, state, placementSnapshot) => {
        this.#assertExpectedReceiveRefs(before, options);
        const policy = this.#receivePolicy;
        if (policy === undefined) throw new GitRepositoryError('repository-unavailable');
        let prepared;
        try {
          prepared = await policy.prepare(state.projectId, options.personalRef);
        } catch (error: unknown) {
          if (error instanceof GitReceivePackPolicyError) {
            throw mapReceivePolicyError(error);
          }
          throw new GitRepositoryError('storage-unavailable');
        }
        let operationError: Error | undefined;
        try {
          let processError: unknown;
          try {
            let inputBytes = 0;
            const countedRequest = (async function* (): AsyncGenerator<Uint8Array> {
              for await (const chunk of options.request) {
                if (
                  chunk.byteLength < 1
                  || inputBytes > options.maximumRequestBytes - chunk.byteLength
                ) {
                  throw new GitRepositoryError('input-limit');
                }
                inputBytes += chunk.byteLength;
                try {
                  state.permit.consume(chunk.byteLength);
                } catch (error: unknown) {
                  if (error instanceof GitReceiveAdmissionError) {
                    throw mapReceiveAdmissionError(error);
                  }
                  throw error;
                }
                yield chunk;
              }
            })();
            await this.#pathPolicy.revalidate(placementSnapshot);
            await options.revalidateAuthority();
            this.#assertOpen();
            assertNotAborted(options.signal);
            await this.#supervisor.runStreamingCommand({
              arguments: ['receive-pack', '--stateless-rpc', '.'],
              cwd: repositoryPath,
              environment: prepared.environment,
              failureCode: 'process-failed',
              ...(options.gitProtocol === undefined
                ? {}
                : { gitProtocol: options.gitProtocol }),
              inputStream: countedRequest,
              onStdoutChunk: options.onResponseChunk,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
              stdoutMaxBytes: options.maximumResponseBytes,
            });
          } catch (error: unknown) {
            processError = error;
          }
          const after = await this.#readRefs(repositoryPath);
          const result = await prepared.readResult();
          if (result === undefined) {
            if (!sameRefs(before, after)) {
              throw new GitRepositoryError('repository-corrupt');
            }
          } else if (
            result.personalRef !== options.personalRef
            || result.oldOid !== before.get(options.personalRef)
            || after.get(options.personalRef) !== result.newOid
            || after.size !== before.size
            || [...before].some(([name, oid]) => (
              name === options.personalRef
                ? after.get(name) === oid
                : after.get(name) !== oid
            ))
          ) {
            throw new GitRepositoryError('repository-corrupt');
          }
          if (processError !== undefined) {
            if (processError instanceof GitProcessError) {
              throw mapProcessError(processError);
            }
            if (processError instanceof Error) throw processError;
            throw new GitRepositoryError('process-failed');
          }
        } catch (error: unknown) {
          operationError = error instanceof Error
            ? error
            : new GitRepositoryError('process-failed');
        }
        let cleanupFailed = false;
        try {
          await this.#cleanupIncomingObjects(repositoryPath);
        } catch {
          cleanupFailed = true;
        }
        try {
          await prepared.close();
        } catch {
          cleanupFailed = true;
        }
        if (cleanupFailed) throw new GitRepositoryError('storage-unavailable');
        if (operationError !== undefined) throw operationError;
      },
    );
  }

  async cleanupReceivePackState(
    placement: RepositoryPlacementLease,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#assertOpen();
    let permit: GitChildPermit;
    try {
      permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'write',
        projectId: placement.projectId,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError) throw mapAdmissionError(error);
      throw new GitRepositoryError('process-failed');
    }
    try {
      const resolved = await this.#resolveReceivePlacement(placement);
      assertNotAborted(signal);
      await this.#cleanupIncomingObjects(resolved.repositoryPath);
      try {
        await this.#receivePolicy?.cleanupProject(placement.projectId);
      } catch (error: unknown) {
        if (error instanceof GitReceivePackPolicyError) {
          throw mapReceivePolicyError(error);
        }
        throw new GitRepositoryError('storage-unavailable');
      }
    } finally {
      permit.release();
    }
  }

  advertiseUploadPack(
    placement: RepositoryPlacementLease,
    options: GitUploadPackAdvertisementOptions,
  ): Promise<Buffer> {
    return this.#runUploadPackOperation(
      placement,
      options.expectedRefs,
      options.revalidateAuthority,
      options.signal,
      repositoryPath => this.#supervisor.runCommand({
        arguments: ['upload-pack', '--stateless-rpc', '--advertise-refs', '.'],
        captureOutput: true,
        cwd: repositoryPath,
        failureCode: 'process-failed',
        ...(options.gitProtocol === undefined ? {} : { gitProtocol: options.gitProtocol }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  }

  runUploadPack(
    placement: RepositoryPlacementLease,
    options: GitUploadPackOptions,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(options.maximumResponseBytes)
      || options.maximumResponseBytes < 1
    ) {
      return Promise.reject(new GitRepositoryError('output-limit'));
    }
    return this.#runUploadPackOperation(
      placement,
      options.expectedRefs,
      options.revalidateAuthority,
      options.signal,
      repositoryPath => this.#supervisor.runStreamingCommand({
        arguments: ['upload-pack', '--stateless-rpc', '.'],
        cwd: repositoryPath,
        failureCode: 'process-failed',
        ...(options.gitProtocol === undefined
          ? {}
          : { gitProtocol: options.gitProtocol }),
        input: options.request,
        onStdoutChunk: options.onResponseChunk,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        stdoutMaxBytes: options.maximumResponseBytes,
      }),
    );
  }

  async #runUploadPackOperation<T>(
    placement: RepositoryPlacementLease,
    expectedRefs: readonly ExpectedRepositoryRef[],
    revalidateAuthority: () => Promise<void>,
    signal: AbortSignal | undefined,
    operation: (repositoryPath: string) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) throw new GitRepositoryError('closed');
    let placementSnapshot: RepositoryPlacementLease;
    try {
      placementSnapshot = createRepositoryPlacementLease(placement);
    } catch (error: unknown) {
      if (error instanceof RepositoryPlacementError) {
        throw mapPlacementError(error);
      }
      throw new GitRepositoryError('placement-rejected');
    }
    let permit;
    try {
      permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'read',
        projectId: placementSnapshot.projectId,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError) throw mapAdmissionError(error);
      throw new GitRepositoryError('process-failed');
    }
    try {
      this.#assertOpen();
      if (signal?.aborted === true) throw new GitRepositoryError('cancelled');
      let resolved;
      try {
        resolved = await this.#pathPolicy.resolveExisting(placementSnapshot);
        await this.#pathPolicy.revalidate(placementSnapshot);
      } catch (error: unknown) {
        if (error instanceof RepositoryPlacementError) {
          throw mapPlacementError(error);
        }
        throw new GitRepositoryError('repository-unavailable');
      }
      try {
        const refs = await this.#supervisor.runCommand({
          arguments: [
            'for-each-ref',
            '--format=%(refname)%00%(objectname)',
            'refs',
          ],
          captureOutput: true,
          cwd: resolved.repositoryPath,
          failureCode: 'repository-corrupt',
          ...(signal === undefined ? {} : { signal }),
        });
        assertExactRefs(refs, expectedRefs);
        resolved = await this.#pathPolicy.resolveExisting(placementSnapshot);
        await this.#pathPolicy.revalidate(placementSnapshot);
        await revalidateAuthority();
        this.#assertOpen();
        assertNotAborted(signal);
        return await operation(resolved.repositoryPath);
      } catch (error: unknown) {
        if (error instanceof GitRepositoryError) throw error;
        if (error instanceof GitProcessError) throw mapProcessError(error);
        throw error;
      }
    } finally {
      permit.release();
    }
  }

  async #runAcceptOperation<T>(
    reservation: ProjectAcceptRepositoryReservation,
    placement: RepositoryPlacementLease,
    signal: AbortSignal | undefined,
    operation: (
      repositoryPath: string,
      placement: RepositoryPlacementLease,
    ) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const state = this.#acceptReservations.get(reservation);
    if (
      state?.active !== true
      || state.inUse
      || state.projectId !== placement.projectId
      || reservation.projectId !== placement.projectId
    ) throw new ProjectAcceptRepositoryError('invalid-plan');
    let placementSnapshot: RepositoryPlacementLease;
    try {
      placementSnapshot = createRepositoryPlacementLease(placement);
    } catch {
      throw new ProjectAcceptRepositoryError('invalid-plan');
    }
    state.inUse = true;
    try {
      this.#assertOpen();
      assertNotAborted(signal);
      const resolved = await this.#pathPolicy.resolveExisting(placementSnapshot);
      await this.#pathPolicy.revalidate(placementSnapshot);
      return await operation(resolved.repositoryPath, placementSnapshot);
    } catch (error: unknown) {
      if (error instanceof ProjectAcceptRepositoryError) throw error;
      if (
        (error instanceof GitRepositoryError && error.code === 'cancelled')
        || (error instanceof GitProcessError && error.code === 'cancelled')
      ) {
        throw new ProjectAcceptRepositoryError('cancelled');
      }
      if (error instanceof RepositoryPlacementError) {
        if (
          error.code !== 'placement-unavailable'
          && error.code !== 'repository-root-unavailable'
        ) throw new ProjectAcceptRepositoryError('state-conflict');
        throw new ProjectAcceptRepositoryError('unavailable');
      }
      if (error instanceof GitProcessError) {
        if (
          error.code !== 'git-unavailable'
          && error.code !== 'timeout'
          && error.code !== 'unsupported-git'
        ) throw new ProjectAcceptRepositoryError('state-conflict');
        throw new ProjectAcceptRepositoryError('unavailable');
      }
      if (error instanceof GitRepositoryError) {
        throw new ProjectAcceptRepositoryError('unavailable');
      }
      throw new ProjectAcceptRepositoryError('unavailable');
    } finally {
      state.inUse = false;
    }
  }

  #assertAcceptRefs(
    refs: ReadonlyMap<string, CollabGitOid>,
    expectedMainOid: CollabGitOid,
    expectedHeadOid: CollabGitOid,
    personalRef: string,
  ): void {
    if (refs.get(COLLAB_MAIN_REF) !== expectedMainOid) {
      throw new ProjectAcceptRepositoryError('stale-main');
    }
    if (refs.get(personalRef) !== expectedHeadOid) {
      throw new ProjectAcceptRepositoryError('stale-head');
    }
  }

  async #assertCommit(
    repositoryPath: string,
    oid: CollabGitOid,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#supervisor.runCommand({
      arguments: ['cat-file', '-e', `${oid}^{commit}`],
      captureOutput: false,
      cwd: repositoryPath,
      failureCode: 'repository-corrupt',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #assertTree(
    repositoryPath: string,
    oid: CollabGitOid,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#supervisor.runCommand({
      arguments: ['cat-file', '-e', `${oid}^{tree}`],
      captureOutput: false,
      cwd: repositoryPath,
      failureCode: 'repository-corrupt',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #assertAcceptTreePolicy(
    repositoryPath: string,
    treeishOid: CollabGitOid,
    objectFormat: 'sha1' | 'sha256',
    signal?: AbortSignal,
  ): Promise<void> {
    const parser = new AcceptTreePolicyParser(objectFormat);
    await this.#supervisor.runStreamingCommand({
      arguments: ['ls-tree', '-r', '-t', '-z', '--full-tree', treeishOid],
      cwd: repositoryPath,
      failureCode: 'repository-corrupt',
      onStdoutChunk: chunk => parser.push(chunk),
      ...(signal === undefined ? {} : { signal }),
      stdoutMaxBytes: ACCEPT_TREE_OUTPUT_MAX_BYTES,
    });
    parser.finish();
  }

  async #isAncestor(
    repositoryPath: string,
    ancestorOid: CollabGitOid,
    descendantOid: CollabGitOid,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const output = await this.#supervisor.runCommand({
      acceptedExitCodes: [0, 1],
      arguments: ['merge-base', '--all', ancestorOid, descendantOid],
      captureOutput: true,
      cwd: repositoryPath,
      failureCode: 'repository-corrupt',
      ...(signal === undefined ? {} : { signal }),
    });
    const bases = output.toString('ascii').trim().split('\n').filter(Boolean);
    if (bases.some(base => !isCollabGitOid(base))) {
      throw new ProjectAcceptRepositoryError('state-conflict');
    }
    return bases.includes(ancestorOid);
  }

  #readAcceptObjectFormat(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<'sha1' | 'sha256'> {
    return this.#supervisor.runCommand({
      arguments: ['rev-parse', '--show-object-format'],
      captureOutput: true,
      cwd: repositoryPath,
      failureCode: 'repository-corrupt',
      ...(signal === undefined ? {} : { signal }),
    }).then(acceptObjectFormat);
  }

  async #runRequestRead<T>(
    input: Pick<
      ProjectRequestHeadValidationInput,
      'memberId' | 'personalRef' | 'placement' | 'projectId' | 'revalidateAuthority' | 'signal'
    >,
    operation: (
      repositoryPath: string,
      refs: ReadonlyMap<string, CollabGitOid>,
    ) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    if (
      input.personalRef !== collabMemberRef(input.memberId)
      || input.placement.projectId !== input.projectId
    ) {
      throw new ProjectRequestRepositoryError('state-conflict');
    }
    let placement: RepositoryPlacementLease;
    try {
      placement = createRepositoryPlacementLease(input.placement);
    } catch {
      throw new ProjectRequestRepositoryError('state-conflict');
    }
    let permit: GitChildPermit;
    try {
      permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'read',
        projectId: input.projectId,
        signal: input.signal,
      });
    } catch (error: unknown) {
      if (
        error instanceof ResourceAdmissionError
        && error.code === 'cancelled'
      ) {
        throw new ProjectRequestRepositoryError('cancelled');
      }
      throw new ProjectRequestRepositoryError('unavailable');
    }
    try {
      this.#assertOpen();
      assertNotAborted(input.signal);
      let resolved = await this.#pathPolicy.resolveExisting(placement);
      await this.#pathPolicy.revalidate(placement);
      const before = await this.#readRefs(resolved.repositoryPath, input.signal);
      const result = await operation(resolved.repositoryPath, before);
      resolved = await this.#pathPolicy.resolveExisting(placement);
      await this.#pathPolicy.revalidate(placement);
      await input.revalidateAuthority();
      this.#assertOpen();
      assertNotAborted(input.signal);
      const after = await this.#readRefs(resolved.repositoryPath, input.signal);
      if (!sameRefs(before, after)) {
        throw new ProjectRequestRepositoryError('state-conflict');
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof ProjectRequestRepositoryError) throw error;
      if (error instanceof GitRepositoryError && error.code === 'cancelled') {
        throw new ProjectRequestRepositoryError('cancelled');
      }
      if (error instanceof GitProcessError && error.code === 'cancelled') {
        throw new ProjectRequestRepositoryError('cancelled');
      }
      throw new ProjectRequestRepositoryError('unavailable');
    } finally {
      permit.release();
    }
  }

  async #runReceiveOperation<T>(
    reservation: GitReceivePackReservation,
    placement: RepositoryPlacementLease,
    options: GitReceivePackOperationOptions,
    operation: (
      repositoryPath: string,
      before: ReadonlyMap<string, CollabGitOid>,
      state: ReceiveReservationState,
      placementSnapshot: RepositoryPlacementLease,
    ) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const state = this.#receiveReservations.get(reservation);
    if (
      state?.active !== true
      || state.inUse
      || state.projectId !== reservation.projectId
    ) {
      throw new GitRepositoryError('busy');
    }
    if (
      options.personalRef !== collabMemberRef(options.memberId)
      || placement.projectId !== reservation.projectId
    ) {
      throw new GitRepositoryError('placement-rejected');
    }
    let placementSnapshot: RepositoryPlacementLease;
    try {
      placementSnapshot = createRepositoryPlacementLease(placement);
    } catch (error: unknown) {
      if (error instanceof RepositoryPlacementError) {
        throw mapPlacementError(error);
      }
      throw new GitRepositoryError('placement-rejected');
    }
    if (placementSnapshot.projectId !== state.projectId) {
      throw new GitRepositoryError('placement-rejected');
    }
    assertNotAborted(options.signal);
    state.inUse = true;
    try {
      const resolved = await this.#resolveReceivePlacement(placementSnapshot);
      const before = await this.#readRefs(resolved.repositoryPath, options.signal);
      const current = await this.#resolveReceivePlacement(placementSnapshot);
      return await operation(
        current.repositoryPath,
        before,
        state,
        placementSnapshot,
      );
    } catch (error: unknown) {
      if (error instanceof GitRepositoryError) throw error;
      if (error instanceof RepositoryPlacementError) throw mapPlacementError(error);
      if (error instanceof GitProcessError) throw mapProcessError(error);
      if (error instanceof GitReceiveAdmissionError) {
        throw mapReceiveAdmissionError(error);
      }
      if (error instanceof GitReceivePackPolicyError) {
        throw mapReceivePolicyError(error);
      }
      if (error instanceof Error) throw error;
      throw new GitRepositoryError('process-failed');
    } finally {
      state.inUse = false;
    }
  }

  async #resolveReceivePlacement(
    placement: RepositoryPlacementLease,
  ): Promise<Readonly<{ repositoryPath: string }>> {
    try {
      const resolved = await this.#pathPolicy.resolveExisting(placement);
      await this.#pathPolicy.revalidate(placement);
      return resolved;
    } catch (error: unknown) {
      if (error instanceof RepositoryPlacementError) throw mapPlacementError(error);
      throw new GitRepositoryError('repository-unavailable');
    }
  }

  #assertExpectedReceiveRefs(
    refs: ReadonlyMap<string, CollabGitOid>,
    options: GitReceivePackOperationOptions,
  ): void {
    if (
      refs.get(COLLAB_MAIN_REF) !== options.expectedMainOid
      || refs.get(options.personalRef) === undefined
    ) {
      throw new GitRepositoryError('repository-corrupt');
    }
  }

  #readRefs(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, CollabGitOid>> {
    return this.#supervisor.runCommand({
      arguments: [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)',
        'refs',
      ],
      captureOutput: true,
      cwd: repositoryPath,
      failureCode: 'repository-corrupt',
      ...(signal === undefined ? {} : { signal }),
    }).then(parseRefs);
  }

  async #cleanupIncomingObjects(repositoryPath: string): Promise<void> {
    const objectPath = join(repositoryPath, 'objects');
    let entries;
    let objectReal: string;
    try {
      const repositoryReal = await realpath(repositoryPath);
      const objectEntry = await lstat(objectPath);
      objectReal = await realpath(objectPath);
      if (
        !objectEntry.isDirectory()
        || objectEntry.isSymbolicLink()
        || !containedPath(repositoryReal, objectReal)
      ) throw new GitRepositoryError('repository-corrupt');
      entries = await readdir(objectPath, { withFileTypes: true });
    } catch (error: unknown) {
      if (error instanceof GitRepositoryError) throw error;
      throw new GitRepositoryError('repository-corrupt');
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('incoming-')) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new GitRepositoryError('repository-corrupt');
      }
      try {
        const candidate = join(objectPath, entry.name);
        const candidateEntry = await lstat(candidate);
        const candidateReal = await realpath(candidate);
        if (
          !candidateEntry.isDirectory()
          || candidateEntry.isSymbolicLink()
          || !containedPath(objectReal, candidateReal)
        ) throw new GitRepositoryError('repository-corrupt');
        await rm(candidate, { recursive: true });
      } catch (error: unknown) {
        if (error instanceof GitRepositoryError) throw error;
        throw new GitRepositoryError('storage-unavailable');
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new GitRepositoryError('closed');
  }
}
