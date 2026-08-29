import { isCollabOpaqueId } from '@claudian-collab/protocol';

import type { EnvironmentBackupCatalogDocumentSource } from '../restore/PublishedEnvironmentBackupSource.js';
import { invalidMaintenanceOperationInput } from './MaintenanceOperationCommandError.js';

export interface EnvironmentBackupVerificationPort {
  validate(input: Readonly<{
    readonly catalogId: string;
    readonly expectedCatalogSha256: string;
    readonly signal: AbortSignal;
  }>): Promise<Readonly<{
    readonly projects: readonly unknown[];
    readonly terminalProjects: readonly unknown[];
  }>>;
}

export interface EnvironmentBackupVerificationCommandOptions {
  readonly catalog: EnvironmentBackupCatalogDocumentSource;
  readonly verifier: EnvironmentBackupVerificationPort;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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

export class EnvironmentBackupVerificationCommand {
  readonly #catalog: EnvironmentBackupCatalogDocumentSource;
  readonly #verifier: EnvironmentBackupVerificationPort;

  constructor(options: EnvironmentBackupVerificationCommandOptions) {
    this.#catalog = options.catalog;
    this.#verifier = options.verifier;
  }

  async run(input: Readonly<{
    readonly catalogId: string;
    readonly signal: AbortSignal;
  }>): Promise<Readonly<{
    readonly catalogId: string;
    readonly catalogSha256: string;
    readonly projectCount: number;
    readonly state: 'verified';
  }>> {
    if (!isCollabOpaqueId(input.catalogId) || input.signal.aborted) {
      return invalidMaintenanceOperationInput();
    }
    const catalogSha256 = digest(await this.#catalog.readCatalog(input));
    const catalog = await this.#verifier.validate({
      catalogId: input.catalogId,
      expectedCatalogSha256: catalogSha256,
      signal: input.signal,
    });
    return Object.freeze({
      catalogId: input.catalogId,
      catalogSha256,
      projectCount: catalog.projects.length + catalog.terminalProjects.length,
      state: 'verified' as const,
    });
  }
}
