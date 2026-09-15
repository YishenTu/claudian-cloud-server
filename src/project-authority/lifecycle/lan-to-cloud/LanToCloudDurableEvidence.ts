import { isDeepStrictEqual } from 'node:util';

import type {
  AuthorityTransferRecoveryRecord,
  ProjectLifecycleJournalRecord,
} from '../../../coordination/PortabilityLifecyclePersistence.js';

interface LanToCloudDurableEvidence {
  readonly journal: ProjectLifecycleJournalRecord;
  readonly recovery: AuthorityTransferRecoveryRecord;
  readonly checkpointManifestSha256: string;
}

/** Phase evidence is checked under the Project lease, independently of transport availability. */
export function hasConsistentLanToCloudEvidence({ journal, recovery, checkpointManifestSha256 }: LanToCloudDurableEvidence): boolean {
  if (recovery.transferId !== journal.operationId
    || recovery.sourceAuthority.generation !== journal.expectedAuthorityGeneration
    || recovery.targetAuthority.generation !== journal.expectedAuthorityGeneration + 1
    || journal.checkpointSha256 !== undefined && journal.checkpointSha256 !== checkpointManifestSha256) return false;

  switch (journal.phase) {
    case 'checkpoint-validated':
    case 'claims-retained':
    case 'repository-published':
    case 'source-relinquished':
    case 'cloud-activated':
    case 'completed':
      if (journal.checkpointSha256 !== checkpointManifestSha256
        || recovery.stageSha256 !== checkpointManifestSha256
        || journal.batchRevision === undefined || journal.batchSha256 === undefined) return false;
  }
  switch (journal.phase) {
    case 'source-relinquished':
    case 'cloud-activated':
    case 'completed':
      return hasDurableLanRelinquishment(journal, recovery);
    default:
      return true;
  }
}

export function hasDurableLanRelinquishment(journal: ProjectLifecycleJournalRecord, recovery: AuthorityTransferRecoveryRecord): boolean {
  const proof = recovery.relinquishmentProof;
  return proof !== undefined
    && proof.projectId === journal.projectId
    && proof.transferId === journal.operationId
    && proof.sourceHostMemberId === recovery.sourceHostMemberId
    && isDeepStrictEqual(proof.sourceAuthority, recovery.sourceAuthority)
    && isDeepStrictEqual(proof.targetAuthority, recovery.targetAuthority)
    && proof.checkpointSha256 === journal.checkpointSha256
    && proof.batchRevision === journal.batchRevision
    && proof.batchSha256 === journal.batchSha256;
}
