import {
  type CollabCheckpointMemberRecord,
  type CollabCheckpointPortableRecord,
} from '@claudian-collab/protocol';

import type {
  ProjectScope,
} from '../../../coordination/ProjectCoordination.js';
import type {
  ActivateLanToCloudProjectInput,
  LanToCloudProjectActivationPort,
} from './LanToCloudTransferCoordinator.js';

const PORTABLE_RECORD_KINDS = new Set<CollabCheckpointPortableRecord['kind']>([
  'member',
  'project',
  'request',
  'request-comment',
  'ticket',
  'ticket-comment',
  'ticket-mention',
  'ticket-relation',
]);

function fail(): never {
  throw new Error('lan-to-cloud-activation.invalid-state');
}

function portableRecords(
  input: ActivateLanToCloudProjectInput,
): readonly CollabCheckpointPortableRecord[] {
  if (
    input.checkpoint.manifest.profile !== 'authority-transfer'
    || input.checkpoint.manifest.projectId !== input.journal.projectId
    || input.checkpoint.manifest.operationId !== input.journal.operationId
    || input.checkpoint.manifest.targetAuthority?.kind !== 'cloud'
    || input.checkpoint.manifest.targetAuthority.generation
      !== input.recovery.targetAuthority.generation
    || input.checkpoint.records.some(record => !PORTABLE_RECORD_KINDS.has(
      record.kind as CollabCheckpointPortableRecord['kind'],
    ))
  ) fail();
  return input.checkpoint.records as readonly CollabCheckpointPortableRecord[];
}

function activeMembers(
  records: readonly CollabCheckpointPortableRecord[],
): readonly CollabCheckpointMemberRecord[] {
  return records.filter(
    (record): record is CollabCheckpointMemberRecord => (
      record.kind === 'member' && record.value.status === 'active'
    ),
  );
}

async function verifyTransferCustody(
  scope: ProjectScope,
  input: ActivateLanToCloudProjectInput,
  members: readonly CollabCheckpointMemberRecord[],
): Promise<void> {
  const { journal } = input;
  if (
    journal.batchRevision === undefined
    || journal.batchSha256 === undefined
    || journal.checkpointSha256 === undefined
  ) fail();
  const receipt = await scope.portability.getTransferClaimBatchReceipt(
    journal.operationId,
  );
  const receiptKey = await scope.portability.getTransferReceiptKey(
    journal.operationId,
    input.receiptKeyId,
  );
  const hostClaim = await scope.portability.getTransferredMembershipClaim(
    journal.operationId,
    input.hostMemberId,
  );
  if (
    receipt === undefined
    || receipt.batchRevision !== journal.batchRevision
    || receipt.batchSha256 !== journal.batchSha256
    || receipt.checkpointSha256 !== journal.checkpointSha256
    || receipt.projectId !== journal.projectId
    || receipt.submittedByMemberId !== input.hostMemberId
    || receipt.transferId !== journal.operationId
    || receiptKey?.receiptKeyId !== input.receiptKeyId
    || receiptKey.transferId !== journal.operationId
    || hostClaim !== undefined
  ) fail();
  for (const member of members) {
    if (member.value.memberId === input.hostMemberId) continue;
    const claim = await scope.portability.getTransferredMembershipClaim(
      journal.operationId,
      member.value.memberId,
    );
    if (
      claim?.state !== 'unclaimed'
      || claim.batchRevision !== journal.batchRevision
      || claim.checkpointSha256 !== journal.checkpointSha256
      || claim.transferId !== journal.operationId
    ) fail();
  }
}

export class LanToCloudProjectActivation
implements LanToCloudProjectActivationPort {
  activate(
    input: ActivateLanToCloudProjectInput,
  ): Promise<'activated' | 'replayed'> {
    const records = portableRecords(input);
    const members = activeMembers(records);
    if (
      input.journal.phase !== 'source-relinquished'
      || input.journal.state !== 'active'
      || input.recovery.relinquishmentProof === undefined
      || input.recovery.targetAuthority.kind !== 'cloud'
      || members.length === 0
      || !members.some(member => member.value.memberId === input.hostMemberId)
      || members.every(member => member.value.role !== 'manager')
    ) return Promise.reject(new Error('lan-to-cloud-activation.invalid-state'));
    return input.lease.withProjectScope(async scope => {
      const current = await scope.portability.getLifecycleJournal(
        input.journal.operationId,
      );
      const stagedProject = await scope.getProject();
      if (
        current?.phase !== 'source-relinquished'
        || current.state !== 'active'
        || current.updatedAt !== input.journal.updatedAt
        || stagedProject?.serviceState !== 'maintenance'
        || stagedProject.authorityGeneration
          !== input.recovery.targetAuthority.generation
      ) fail();
      await verifyTransferCustody(scope, input, members);
      await scope.portability.activateLanToCloudProject({
        activatedAt: input.activatedAt,
        authorityGeneration: input.recovery.targetAuthority.generation,
        hostMemberId: input.hostMemberId,
        hostPrincipalId: input.hostPrincipalId,
        placementGeneration: input.publication.placementGeneration,
        repositoryStorageKey: input.publication.repositoryStorageKey,
        storageNodeId: input.publication.storageNodeId,
        transferId: input.journal.operationId,
      });
      await scope.appendProjectEvent({
        kind: 'authority-transfer.updated',
        occurredAt: input.activatedAt,
        payload: Object.freeze({ transferId: input.journal.operationId }),
      });
      await scope.portability.advanceLifecycleJournal({
        batchRevision: input.journal.batchRevision as number,
        batchSha256: input.journal.batchSha256 as string,
        checkpointSha256: input.journal.checkpointSha256 as string,
        expectedPhase: 'source-relinquished',
        expectedState: 'active',
        nextPhase: 'cloud-activated',
        nextState: 'active',
        operationId: input.journal.operationId,
        scheduledAt: input.activatedAt,
        updatedAt: input.activatedAt,
      });
      return 'activated' as const;
    });
  }
}
