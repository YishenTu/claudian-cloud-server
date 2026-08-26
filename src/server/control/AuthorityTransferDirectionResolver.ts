import {
  CollabError,
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabAuthorityTransferDirection,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type { PinnedProjectLease } from '../../coordination/ProjectCoordination.js';
import type { AuthorityTransferDirectionResolver } from './CloudLifecycleControl.js';

export interface AuthorityTransferDirectionResolverCoordination {
  acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease>;
}

export class AuthorityTransferDirectionResolverAdapter
implements AuthorityTransferDirectionResolver {
  readonly #coordination: AuthorityTransferDirectionResolverCoordination;

  constructor(coordination: AuthorityTransferDirectionResolverCoordination) {
    this.#coordination = coordination;
  }

  async resolve(input: Readonly<{
    readonly principalId: string;
    readonly projectId: string;
    readonly transferId: string;
  }>): Promise<CollabAuthorityTransferDirection> {
    if (!isCollabProjectId(input.projectId) || !isCollabOpaqueId(input.transferId)) {
      throw new CollabError({ code: 'authority-transfer-not-found' });
    }
    let lease: PinnedProjectLease;
    try {
      lease = await this.#coordination.acquireProjectLease(input.projectId);
    } catch {
      throw new CollabError({ code: 'operation-failed', recoveryActions: ['retry'] });
    }
    try {
      const journal = await lease.withProjectScope(scope => (
        scope.portability.getLifecycleJournal(input.transferId)
      ));
      if (
        journal?.kind !== 'authority-transfer'
        || journal.projectId !== input.projectId
        || journal.operationId !== input.transferId
        || (journal.direction !== 'cloud-to-lan' && journal.direction !== 'lan-to-cloud')
      ) throw new CollabError({ code: 'authority-transfer-not-found' });
      return journal.direction;
    } catch (error: unknown) {
      throw error instanceof CollabError
        ? error
        : new CollabError({ code: 'operation-failed', recoveryActions: ['retry'] });
    } finally {
      await lease.close().catch(() => undefined);
    }
  }
}
