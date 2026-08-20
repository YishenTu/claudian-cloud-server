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
  readonly signal?: AbortSignal;
}

export interface RepositoryIntegrityResult {
  readonly status: 'valid';
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
        await this.#supervisor.runIntegrityCheck(
          resolved.repositoryPath,
          options.signal,
        );
      } catch (error: unknown) {
        if (error instanceof RepositoryPlacementError) {
          throw mapPlacementError(error);
        }
        if (error instanceof GitProcessError) throw mapProcessError(error);
        throw new GitRepositoryError('process-failed');
      }
      return Object.freeze({ status: 'valid' as const });
    } finally {
      permit.release();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new GitRepositoryError('closed');
  }
}
