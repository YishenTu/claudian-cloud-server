import {
  COLLAB_MAIN_REF,
  isCollabGitOid,
  type CollabGitOid,
} from '@claudian/collab-protocol';

import {
  ResourceAdmissionError,
  type ResourceAdmission,
} from '../resource-admission/ResourceAdmission.js';
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
  | 'output-limit'
  | 'placement-rejected'
  | 'placement-unavailable'
  | 'process-failed'
  | 'repository-corrupt'
  | 'repository-unavailable'
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
  readonly repositoryRoot: string;
  readonly resourceAdmission: ResourceAdmission;
  readonly storageNodeId: string;
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

function mapProcessError(error: GitProcessError): GitRepositoryError {
  return new GitRepositoryError(error.code);
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

export class GitRepositoryAuthority {
  readonly #pathPolicy: RepositoryPathPolicy;
  readonly #resourceAdmission: ResourceAdmission;
  readonly #supervisor: GitProcessSupervisor;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: GitRepositoryAuthorityOptions) {
    this.#pathPolicy = new RepositoryPathPolicy({
      placementValidator: options.placementValidator,
      repositoryRoot: options.repositoryRoot,
      storageNodeId: options.storageNodeId,
    });
    this.#resourceAdmission = options.resourceAdmission;
    this.#supervisor = new GitProcessSupervisor({
      gitExecutable: options.gitExecutable,
      operationTimeoutMs: options.operationTimeoutMs,
      outputMaxBytes: options.outputMaxBytes,
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = this.#supervisor.close();
    }
    return this.#closePromise;
  }

  async verifyCapability(): Promise<Readonly<{ status: 'supported' }>> {
    this.#assertOpen();
    try {
      await this.#pathPolicy.verifyRoot();
      await this.#supervisor.verifyVersion();
    } catch (error: unknown) {
      if (error instanceof RepositoryPlacementError) {
        throw mapPlacementError(error);
      }
      if (error instanceof GitProcessError) throw mapProcessError(error);
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

  #assertOpen(): void {
    if (this.#closed) throw new GitRepositoryError('closed');
  }
}
