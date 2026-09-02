import type { CloudToLanSourceFencePort } from './CloudToLanTransferCoordinator.js';

function fail(): never {
  throw new Error('project-authority-source-fence.invalid-state');
}

/**
 * Verifies the coordinator's canonical Project authority transition at each
 * external-effect seam. It owns no second fence or mutable authority state.
 */
export class ProjectAuthoritySourceFence implements CloudToLanSourceFencePort {
  async quiesce(input: Parameters<CloudToLanSourceFencePort['quiesce']>[0]): Promise<void> {
    await input.lease.withProjectScope(async scope => {
      const [journal, project] = await Promise.all([
        scope.portability.getLifecycleJournal(input.transferId),
        scope.getProject(),
      ]);
      if (
        journal?.kind !== 'authority-transfer'
        || journal.direction !== 'cloud-to-lan'
        || journal.phase !== 'collecting-readiness'
        || journal.projectId !== input.projectId
        || project?.authorityGeneration !== input.expectedAuthorityGeneration
        || project.serviceState !== 'active'
      ) fail();
    });
  }

  async relinquish(input: Parameters<CloudToLanSourceFencePort['relinquish']>[0]): Promise<void> {
    await input.lease.withProjectScope(async scope => {
      const [journal, project, recovery] = await Promise.all([
        scope.portability.getLifecycleJournal(input.proof.transferId),
        scope.getProject(),
        scope.portability.getAuthorityTransferRecovery(input.proof.transferId),
      ]);
      if (
        journal?.kind !== 'authority-transfer'
        || journal.direction !== 'cloud-to-lan'
        || journal.phase !== 'cloud-relinquished'
        || project?.serviceState !== 'deleting'
        || project.authorityGeneration !== input.proof.targetAuthority.generation
        || recovery?.relinquishmentProof?.certificate !== input.proof.certificate
      ) fail();
    });
  }

  async reopen(input: Parameters<CloudToLanSourceFencePort['reopen']>[0]): Promise<void> {
    await input.lease.withProjectScope(async scope => {
      const [journal, project, recovery] = await Promise.all([
        scope.portability.getLifecycleJournal(input.transferId),
        scope.getProject(),
        scope.portability.getAuthorityTransferRecovery(input.transferId),
      ]);
      const sourceStayedActive = project?.serviceState === 'active'
        && recovery?.targetProof === undefined;
      if (
        journal?.kind !== 'authority-transfer'
        || journal.direction !== 'cloud-to-lan'
        || journal.phase !== 'target-cleaned'
        || journal.projectId !== input.projectId
        || (
          project?.serviceState !== 'read-only-transition'
          && !sourceStayedActive
        )
        || project.authorityGeneration !== input.expectedAuthorityGeneration
        || recovery?.sourceReopenSha256 !== input.cleanupSha256
      ) fail();
    });
  }
}
