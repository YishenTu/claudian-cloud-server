import {
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

export type RepositoryPlacementErrorCode =
  | 'inactive-placement'
  | 'invalid-placement'
  | 'placement-unavailable'
  | 'repository-not-found'
  | 'repository-path-invalid'
  | 'repository-root-unavailable'
  | 'stale-placement'
  | 'wrong-storage-node';

export class RepositoryPlacementError extends Error {
  readonly code: RepositoryPlacementErrorCode;

  constructor(code: RepositoryPlacementErrorCode) {
    super(`repository-placement.error.${code}`);
    this.name = 'RepositoryPlacementError';
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

export interface RepositoryPlacementLease {
  readonly active: true;
  readonly generation: number;
  readonly projectId: CollabProjectId;
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
}

export interface RepositoryPlacementInput {
  readonly active: boolean;
  readonly generation: number;
  readonly projectId: string;
  readonly repositoryStorageKey: string;
  readonly storageNodeId: string;
}

export interface RepositoryPlacementValidator {
  isCurrent(placement: RepositoryPlacementLease): Promise<boolean>;
}

const STORAGE_NODE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export function createRepositoryPlacementLease(
  input: RepositoryPlacementInput,
): RepositoryPlacementLease {
  if (!input.active) {
    throw new RepositoryPlacementError('inactive-placement');
  }
  if (
    !isCollabProjectId(input.projectId)
    || !STORAGE_NODE_ID_PATTERN.test(input.storageNodeId)
    || !STORAGE_KEY_PATTERN.test(input.repositoryStorageKey)
    || !Number.isSafeInteger(input.generation)
    || input.generation <= 0
  ) {
    throw new RepositoryPlacementError('invalid-placement');
  }
  return Object.freeze({
    active: true,
    generation: input.generation,
    projectId: input.projectId,
    repositoryStorageKey: input.repositoryStorageKey,
    storageNodeId: input.storageNodeId,
  });
}

export function assertRepositoryPlacementLease(
  placement: RepositoryPlacementLease,
): void {
  createRepositoryPlacementLease(placement);
}
