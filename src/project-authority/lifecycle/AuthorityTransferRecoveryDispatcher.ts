import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  ProjectLifecycleJournalRecord,
} from '../../coordination/PortabilityLifecyclePersistence.js';
import {
  ProjectRecoveryError,
} from '../admission/ProjectWriteAdmission.js';
import type {
  ProjectLifecycleRecoveryOwner,
  ProjectLifecycleRecoveryReservation,
  RecoverProjectLifecycleInput,
  ProjectLifecycleRecoveryOutcome,
} from './ProjectLifecycleRecoveryDispatcher.js';

export interface AuthorityTransferRecoveryDispatcherOptions {
  readonly cloudToLan: ProjectLifecycleRecoveryOwner;
  readonly lanToCloud: ProjectLifecycleRecoveryOwner;
}

function fail(): never {
  throw new ProjectRecoveryError('dependency-failed');
}

/**
 * Selects the authority-transfer recovery owner only from the canonical
 * lifecycle journal. Direction owners retain every phase and effect policy.
 */
export class AuthorityTransferRecoveryDispatcher
implements ProjectLifecycleRecoveryOwner {
  readonly #cloudToLan: ProjectLifecycleRecoveryOwner;
  readonly #lanToCloud: ProjectLifecycleRecoveryOwner;

  constructor(options: AuthorityTransferRecoveryDispatcherOptions) {
    this.#cloudToLan = options.cloudToLan;
    this.#lanToCloud = options.lanToCloud;
  }

  reserveRecovery(
    projectId: CollabProjectId,
    journal: ProjectLifecycleJournalRecord,
  ): Promise<ProjectLifecycleRecoveryReservation | undefined> {
    const owner = this.#owner(projectId, journal);
    return owner.reserveRecovery?.(projectId, journal)
      ?? Promise.resolve(undefined);
  }

  recover(
    input: RecoverProjectLifecycleInput,
  ): Promise<ProjectLifecycleRecoveryOutcome> {
    return this.#owner(input.journal.projectId, input.journal).recover(input);
  }

  #owner(
    projectId: CollabProjectId,
    journal: ProjectLifecycleJournalRecord,
  ): ProjectLifecycleRecoveryOwner {
    if (
      journal.kind !== 'authority-transfer'
      || journal.projectId !== projectId
    ) return fail();
    if (journal.direction === 'cloud-to-lan') return this.#cloudToLan;
    if (journal.direction === 'lan-to-cloud') return this.#lanToCloud;
    return fail();
  }
}
