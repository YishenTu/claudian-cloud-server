import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabIsoTimestamp,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type { PinnedProjectLease } from '../../../coordination/ProjectCoordination.js';

export interface ExpireTerminalResponderInput {
  readonly operationId: string;
  readonly operationKind: 'authority-transfer' | 'retire';
  readonly projectId: CollabProjectId;
  readonly removedAt: CollabIsoTimestamp;
}

export class TerminalResponderExpiry {
  readonly #coordination: Readonly<{
    acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
  }>;

  constructor(options: Readonly<{
    readonly coordination: Readonly<{
      acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
    }>;
  }>) {
    this.#coordination = options.coordination;
  }

  async expire(input: ExpireTerminalResponderInput): Promise<'expired' | 'replayed'> {
    if (
      !isCollabProjectId(input.projectId)
      || !isCollabOpaqueId(input.operationId)
      || Number.isNaN(Date.parse(input.removedAt))
      || new Date(input.removedAt).toISOString() !== input.removedAt
    ) throw new TypeError('terminal-responder-expiry.input-invalid');
    const lease = await this.#coordination.acquireProjectLease(input.projectId);
    try {
      return await lease.withProjectScope(async scope => {
        const responder = await scope.portability.getTerminalResponder(
          input.operationKind,
          input.operationId,
        );
        if (responder === undefined) {
          await scope.portability.cleanupTerminalArtifacts(input);
          return 'replayed';
        }
        await scope.portability.removeTerminalResponder({
          expectedExpiresAt: responder.expiresAt,
          operationId: input.operationId,
          operationKind: input.operationKind,
          removedAt: input.removedAt,
        });
        await scope.portability.cleanupTerminalArtifacts(input);
        return 'expired';
      });
    } finally {
      await lease.close();
    }
  }
}
