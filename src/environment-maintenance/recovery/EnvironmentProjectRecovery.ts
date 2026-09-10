import type { RecoveryCandidateCatalog } from '../../coordination/DevelopmentBootstrapPersistence.js';
import { ProjectRecoveryError } from '../../project-authority/admission/ProjectWriteAdmission.js';
import type { ProjectLifecycleRecoveryPort } from '../../project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';

/** Offline catalog policy; candidate execution remains Project-authority owned. */
export class EnvironmentProjectRecovery {
  constructor(private readonly recovery: ProjectLifecycleRecoveryPort) {}

  recoverAll(catalog: RecoveryCandidateCatalog): Promise<void> {
    return this.#recoverCatalog(catalog, true);
  }

  recoverAvailable(catalog: RecoveryCandidateCatalog): Promise<void> {
    return this.#recoverCatalog(catalog, false);
  }

  async #recoverCatalog(catalog: RecoveryCandidateCatalog, requireComplete: boolean): Promise<void> {
    let after;
    for (;;) {
      const page = await catalog.listRecoveryCandidates(after === undefined ? undefined : { after });
      for (const candidate of page.candidates) {
        if (!requireComplete && (
          candidate.kind === 'accept' || candidate.kind === 'activation'
          || candidate.kind === 'create-project' || candidate.kind === 'join-project'
        )) continue;
        const outcome = await this.recovery.recoverCandidate(candidate);
        if (outcome === 'offline-maintenance-required'
          || (requireComplete && outcome !== 'settled')) {
          throw new ProjectRecoveryError('recovery-required');
        }
      }
      if (page.nextCursor === undefined) return;
      after = page.nextCursor;
    }
  }
}
