import {
  COLLAB_MAIN_REF,
  collabMemberRef,
  isCollabGitOid,
  type CollabMemberId,
  type CollabGitOid,
  type CollabProjectId,
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

interface ReceiveReservationState {
  readonly child: GitChildPermit;
  readonly permit: GitReceivePermit;
  readonly projectId: CollabProjectId;
  active: boolean;
  inUse: boolean;
}

const RECEIVE_POLICY_METADATA_MAX_BYTES = 48 * 1_024 * 1_024;

export class GitRepositoryAuthority {
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
