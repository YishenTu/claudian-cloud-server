import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type { DeletionCoordinator } from '../../project-authority/lifecycle/delete/DeletionCoordinator.js';
import { invalidMaintenanceOperationInput } from './MaintenanceOperationCommandError.js';

export interface ResumeDeletionCommandOptions {
  readonly coordinator: Pick<DeletionCoordinator, 'resumeAuthorized'>;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class ResumeDeletionCommand {
  readonly #coordinator: ResumeDeletionCommandOptions['coordinator'];

  constructor(options: ResumeDeletionCommandOptions) {
    this.#coordinator = options.coordinator;
  }

  run(input: Readonly<{
    readonly authorizationSha256: string;
    readonly operationId: string;
    readonly projectId: CollabProjectId;
    readonly signal: AbortSignal;
  }>): ReturnType<DeletionCoordinator['resumeAuthorized']> {
    if (
      !SHA256_PATTERN.test(input.authorizationSha256)
      || !isCollabOpaqueId(input.operationId)
      || !isCollabProjectId(input.projectId)
      || input.signal.aborted
    ) return invalidMaintenanceOperationInput();
    return this.#coordinator.resumeAuthorized({
      authorizationSha256: input.authorizationSha256,
      operationId: input.operationId,
      projectId: input.projectId,
      signal: input.signal,
    });
  }
}
