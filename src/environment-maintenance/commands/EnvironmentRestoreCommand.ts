import { isCollabOpaqueId } from '@claudian-collab/protocol';

import type { EnvironmentBackupCatalogDocumentSource } from '../restore/PublishedEnvironmentBackupSource.js';
import { invalidMaintenanceOperationInput } from './MaintenanceOperationCommandError.js';

export interface EnvironmentRestoreCommandPort<Result = unknown> {
  restore(input: Readonly<{
    readonly authorityVolumeId: string;
    readonly authorityVolumeIdentity: string;
    readonly catalogId: string;
    readonly expectedCatalogSha256: string;
    readonly operationId: string;
    readonly signal: AbortSignal;
  }>): Promise<Result>;
}

export interface EnvironmentRestoreTargetPort {
  read(signal: AbortSignal): Promise<Readonly<{
    readonly authorityVolumeId: string;
    readonly authorityVolumeIdentity: string;
  }>>;
}

export interface EnvironmentRestoreCommandOptions<Result = unknown> {
  readonly catalog: EnvironmentBackupCatalogDocumentSource;
  readonly restore: EnvironmentRestoreCommandPort<Result>;
  readonly target: EnvironmentRestoreTargetPort;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VOLUME_ID_PATTERN = /^[0-9a-f]{32}$/u;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function digest(value: unknown): string {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || !('catalogSha256' in value)
    || typeof value.catalogSha256 !== 'string'
    || !SHA256_PATTERN.test(value.catalogSha256)
  ) return invalidMaintenanceOperationInput();
  return value.catalogSha256;
}

export class EnvironmentRestoreCommand<Result = unknown> {
  readonly #catalog: EnvironmentBackupCatalogDocumentSource;
  readonly #restore: EnvironmentRestoreCommandPort<Result>;
  readonly #target: EnvironmentRestoreTargetPort;

  constructor(options: EnvironmentRestoreCommandOptions<Result>) {
    this.#catalog = options.catalog;
    this.#restore = options.restore;
    this.#target = options.target;
  }

  async run(input: Readonly<{
    readonly catalogId: string;
    readonly operationId: string;
    readonly signal: AbortSignal;
  }>): Promise<Result> {
    if (
      !isCollabOpaqueId(input.catalogId)
      || !isCollabOpaqueId(input.operationId)
      || input.signal.aborted
    ) return invalidMaintenanceOperationInput();
    const catalogSha256 = digest(await this.#catalog.readCatalog({
      catalogId: input.catalogId,
      signal: input.signal,
    }));
    const target = await this.#target.read(input.signal);
    if (
      !VOLUME_ID_PATTERN.test(target.authorityVolumeId)
      || !IDENTITY_PATTERN.test(target.authorityVolumeIdentity)
    ) return invalidMaintenanceOperationInput();
    return await this.#restore.restore({
      authorityVolumeId: target.authorityVolumeId,
      authorityVolumeIdentity: target.authorityVolumeIdentity,
      catalogId: input.catalogId,
      expectedCatalogSha256: catalogSha256,
      operationId: input.operationId,
      signal: input.signal,
    });
  }
}
