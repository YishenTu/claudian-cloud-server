import type {
  CollabProjectId,
  DevelopmentBootstrapGitRef,
  DevelopmentBootstrapObjectFormat,
} from '@claudian/collab-protocol';

import {
  ResourceAdmissionError,
  type ResourceAdmission,
} from '../resource-admission/ResourceAdmission.js';
import {
  GitProcessError,
  GitProcessSupervisor,
} from './GitProcessSupervisor.js';

export type BootstrapRepositoryIntegrityErrorCode =
  | 'closed'
  | 'repository-invalid'
  | 'unavailable';

export class BootstrapRepositoryIntegrityError extends Error {
  readonly code: BootstrapRepositoryIntegrityErrorCode;

  constructor(code: BootstrapRepositoryIntegrityErrorCode) {
    super(`bootstrap-repository-integrity.error.${code}`);
    this.name = 'BootstrapRepositoryIntegrityError';
    this.code = code;
  }
}

export interface VerifyBootstrapRepositoryInput {
  readonly objectFormat: DevelopmentBootstrapObjectFormat;
  readonly projectId: CollabProjectId;
  readonly refs: readonly DevelopmentBootstrapGitRef[];
  readonly repositoryPath: string;
  readonly signal?: AbortSignal;
}

export interface BootstrapRepositoryIntegrityPort {
  verify(input: VerifyBootstrapRepositoryInput): Promise<void>;
}

export interface BootstrapRepositoryIntegrityVerifierOptions {
  readonly gitExecutable: string;
  readonly operationTimeoutMs: number;
  readonly outputMaxBytes: number;
  readonly resourceAdmission: ResourceAdmission;
}

function exactRefs(
  output: Buffer,
  expected: readonly DevelopmentBootstrapGitRef[],
): boolean {
  const actual = output.toString('utf8').split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('\0');
    if (separator <= 0 || line.indexOf('\0', separator + 1) !== -1) return undefined;
    return Object.freeze({
      name: line.slice(0, separator),
      oid: line.slice(separator + 1),
    });
  });
  if (actual.some(ref => ref === undefined) || actual.length !== expected.length) {
    return false;
  }
  const actualByName = new Map(actual.map(ref => [ref?.name, ref?.oid]));
  if (actualByName.size !== actual.length) return false;
  const expectedNames = new Set(expected.map(ref => ref.name));
  return expectedNames.size === expected.length
    && expected.every(ref => actualByName.get(ref.name) === ref.oid);
}

function mapFailure(error: unknown): BootstrapRepositoryIntegrityError {
  if (error instanceof BootstrapRepositoryIntegrityError) return error;
  if (
    error instanceof GitProcessError
    && error.code === 'repository-corrupt'
  ) {
    return new BootstrapRepositoryIntegrityError('repository-invalid');
  }
  if (
    error instanceof GitProcessError
    && error.code === 'closed'
  ) {
    return new BootstrapRepositoryIntegrityError('closed');
  }
  return new BootstrapRepositoryIntegrityError('unavailable');
}

export class BootstrapRepositoryIntegrityVerifier
implements BootstrapRepositoryIntegrityPort {
  readonly #resourceAdmission: ResourceAdmission;
  readonly #supervisor: GitProcessSupervisor;
  #closed = false;

  constructor(options: BootstrapRepositoryIntegrityVerifierOptions) {
    this.#resourceAdmission = options.resourceAdmission;
    this.#supervisor = new GitProcessSupervisor({
      gitExecutable: options.gitExecutable,
      operationTimeoutMs: options.operationTimeoutMs,
      outputMaxBytes: options.outputMaxBytes,
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.#supervisor.close();
  }

  async verify(input: VerifyBootstrapRepositoryInput): Promise<void> {
    if (this.#closed) throw new BootstrapRepositoryIntegrityError('closed');
    let permit;
    try {
      permit = await this.#resourceAdmission.acquireGitChild({
        classification: 'read',
        projectId: input.projectId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error: unknown) {
      if (error instanceof ResourceAdmissionError && error.code === 'closed') {
        throw new BootstrapRepositoryIntegrityError('closed');
      }
      throw new BootstrapRepositoryIntegrityError('unavailable');
    }
    try {
      await this.#supervisor.verifyBareRepository(input.repositoryPath, input.signal);
      const objectFormat = await this.#supervisor.runCommand({
        arguments: ['rev-parse', '--show-object-format'],
        captureOutput: true,
        cwd: input.repositoryPath,
        failureCode: 'repository-corrupt',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (objectFormat.toString('utf8').trim() !== input.objectFormat) {
        throw new BootstrapRepositoryIntegrityError('repository-invalid');
      }
      const refs = await this.#supervisor.runCommand({
        arguments: [
          'for-each-ref',
          '--format=%(refname)%00%(objectname)',
          'refs/heads',
        ],
        captureOutput: true,
        cwd: input.repositoryPath,
        failureCode: 'repository-corrupt',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!exactRefs(refs, input.refs)) {
        throw new BootstrapRepositoryIntegrityError('repository-invalid');
      }
      await this.#supervisor.runIntegrityCheck(input.repositoryPath, input.signal);
    } catch (error: unknown) {
      throw mapFailure(error);
    } finally {
      permit.release();
    }
  }
}
