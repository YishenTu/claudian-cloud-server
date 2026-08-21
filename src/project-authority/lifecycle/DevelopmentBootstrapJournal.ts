import {
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
  type DevelopmentBootstrapActivationResult,
} from '@claudian/collab-protocol';

import type { PreparedRepositoryPublication } from '../../repositories/RepositoryPublication.js';

export interface DevelopmentBootstrapActivationJournal {
  readonly activationResult: DevelopmentBootstrapActivationResult;
  readonly actorId: string;
  readonly attemptId: string;
  readonly kind: 'activation';
  readonly manifestSha256: string;
  readonly projectId: string;
  readonly publication: PreparedRepositoryPublication;
  readonly schemaVersion: 1;
}

export interface DevelopmentBootstrapCancellationJournal {
  readonly actorId?: string;
  readonly attemptId: string;
  readonly kind: 'cancellation';
  readonly projectId: string;
  readonly reason: 'expired' | 'requested';
  readonly schemaVersion: 1;
}

export type DevelopmentBootstrapJournal =
  | DevelopmentBootstrapActivationJournal
  | DevelopmentBootstrapCancellationJournal;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const STORAGE_NODE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

function invalidJournal(): never {
  throw new TypeError('development-bootstrap-journal.invalid');
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidJournal();
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !allowed.has(key))
  ) {
    invalidJournal();
  }
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    return invalidJournal();
  }
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    return invalidJournal();
  }
  return value;
}

function decodeActivationResult(
  value: unknown,
): DevelopmentBootstrapActivationResult {
  const source = record(value);
  exactKeys(source, [
    'activatedAt',
    'activationOperationId',
    'placementGeneration',
    'projectId',
  ]);
  if (
    !isCollabOpaqueId(source.activationOperationId)
    || source.placementGeneration !== 1
    || !isCollabProjectId(source.projectId)
  ) {
    return invalidJournal();
  }
  return Object.freeze({
    activatedAt: timestamp(source.activatedAt),
    activationOperationId: source.activationOperationId,
    placementGeneration: 1,
    projectId: source.projectId,
  });
}

function decodePublication(value: unknown): PreparedRepositoryPublication {
  const source = record(value);
  exactKeys(source, [
    'artifactKey',
    'attemptId',
    'generation',
    'markerSha256',
    'objectFormat',
    'projectId',
    'publicationMarkerSha256',
    'refs',
    'repositoryStorageKey',
    'storageNodeId',
    'validationMarkerSha256',
  ]);
  if (
    typeof source.artifactKey !== 'string'
    || !STORAGE_KEY_PATTERN.test(source.artifactKey)
    || !isCollabOpaqueId(source.attemptId)
    || source.generation !== 1
    || (source.objectFormat !== 'sha1' && source.objectFormat !== 'sha256')
    || !isCollabProjectId(source.projectId)
    || typeof source.repositoryStorageKey !== 'string'
    || !STORAGE_KEY_PATTERN.test(source.repositoryStorageKey)
    || typeof source.storageNodeId !== 'string'
    || !STORAGE_NODE_PATTERN.test(source.storageNodeId)
    || !Array.isArray(source.refs)
    || source.refs.length !== 3
  ) {
    return invalidJournal();
  }
  const refs = source.refs.map(value => {
    const ref = record(value);
    exactKeys(ref, ['name', 'oid']);
    if (typeof ref.name !== 'string' || !isCollabGitOid(ref.oid)) {
      return invalidJournal();
    }
    return Object.freeze({ name: ref.name, oid: ref.oid });
  });
  return Object.freeze({
    artifactKey: source.artifactKey,
    attemptId: source.attemptId,
    generation: 1,
    markerSha256: sha256(source.markerSha256),
    objectFormat: source.objectFormat,
    projectId: source.projectId,
    publicationMarkerSha256: sha256(source.publicationMarkerSha256),
    refs: Object.freeze(refs),
    repositoryStorageKey: source.repositoryStorageKey,
    storageNodeId: source.storageNodeId,
    validationMarkerSha256: sha256(source.validationMarkerSha256),
  });
}

export function encodeDevelopmentBootstrapJournal(
  journal: DevelopmentBootstrapJournal,
): string {
  return JSON.stringify(decodeDevelopmentBootstrapJournal(journal));
}

export function decodeDevelopmentBootstrapJournal(
  value: unknown,
): DevelopmentBootstrapJournal {
  const source = record(value);
  if (source.schemaVersion !== 1) return invalidJournal();
  if (source.kind === 'activation') {
    exactKeys(source, [
      'activationResult',
      'actorId',
      'attemptId',
      'kind',
      'manifestSha256',
      'projectId',
      'publication',
      'schemaVersion',
    ]);
    if (
      !isCollabMemberId(source.actorId)
      || !isCollabOpaqueId(source.attemptId)
      || !isCollabProjectId(source.projectId)
    ) {
      return invalidJournal();
    }
    const activationResult = decodeActivationResult(source.activationResult);
    const publication = decodePublication(source.publication);
    if (
      activationResult.projectId !== source.projectId
      || publication.projectId !== source.projectId
      || publication.attemptId !== source.attemptId
    ) {
      return invalidJournal();
    }
    return Object.freeze({
      activationResult,
      actorId: source.actorId,
      attemptId: source.attemptId,
      kind: 'activation',
      manifestSha256: sha256(source.manifestSha256),
      projectId: source.projectId,
      publication,
      schemaVersion: 1,
    });
  }
  if (source.kind !== 'cancellation') return invalidJournal();
  exactKeys(source, [
    'attemptId',
    'kind',
    'projectId',
    'reason',
    'schemaVersion',
  ], ['actorId']);
  if (
    !isCollabOpaqueId(source.attemptId)
    || !isCollabProjectId(source.projectId)
    || (source.reason !== 'expired' && source.reason !== 'requested')
    || (source.actorId !== undefined && !isCollabMemberId(source.actorId))
  ) {
    return invalidJournal();
  }
  return Object.freeze({
    ...(source.actorId === undefined ? {} : { actorId: source.actorId }),
    attemptId: source.attemptId,
    kind: 'cancellation',
    projectId: source.projectId,
    reason: source.reason,
    schemaVersion: 1,
  });
}

export function decodeDevelopmentBootstrapJournalJson(
  json: string,
): DevelopmentBootstrapJournal {
  try {
    const decoded = decodeDevelopmentBootstrapJournal(JSON.parse(json));
    if (JSON.stringify(decoded) !== json) return invalidJournal();
    return decoded;
  } catch (error: unknown) {
    if (
      error instanceof TypeError
      && error.message === 'development-bootstrap-journal.invalid'
    ) {
      throw error;
    }
    return invalidJournal();
  }
}
