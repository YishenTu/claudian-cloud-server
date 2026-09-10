import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  CollabError,
  collabMemberRef,
  type CollabCloudProjectSnapshot,
} from '@claudian-collab/protocol';

import type { ProjectScope } from '../../coordination/ProjectCoordination.js';

interface RequestSnapshotCapacity {
  readonly bytes: number;
  readonly requests: number;
}

// Reserve the full allowed membership and highlight projection, including JSON
// escaping and counter growth. Joining a Member or editing a referenced Ticket
// must not make a previously admitted Request collection unreadable.
const maximumText = (utf16: number): string => '\u0000'.repeat(utf16);
const maximumId = 'x'.repeat(64);
const maximumCounter = Number.MAX_SAFE_INTEGER;
const maximumTimestamp = 'x'.repeat(64);
const maximumMember = {
  activatedAt: maximumTimestamp,
  createdAt: maximumTimestamp,
  displayName: maximumText(COLLAB_LIMITS.maxMemberDisplayNameUtf16),
  id: maximumId,
  personalRef: collabMemberRef(maximumId),
  role: 'manager' as const,
  status: 'active' as const,
};
const maximumEnvelope: Omit<CollabCloudProjectSnapshot, 'openRequests'> = {
  currentMember: maximumMember,
  eventSequence: maximumCounter,
  members: Array.from({ length: COLLAB_CLOUD_BINDING_LIMITS.maxCloudProjectMembers }, () => maximumMember),
  openTicketCount: maximumCounter,
  project: {
    authorityGeneration: maximumCounter,
    createdAt: maximumTimestamp,
    expectedMainOid: maximumId,
    id: maximumId,
    mainRef: COLLAB_MAIN_REF,
    name: maximumText(COLLAB_LIMITS.maxProjectNameUtf16),
  },
  ticketHighlights: Array.from({ length: COLLAB_CLOUD_BINDING_LIMITS.maxCloudTicketHighlights }, () => ({
    acceptedRelationCount: maximumCounter,
    authorMemberId: maximumId,
    commentCount: maximumCounter,
    createdAt: maximumTimestamp,
    id: 'x'.repeat(128),
    number: maximumCounter,
    revision: maximumCounter,
    status: 'open' as const,
    title: maximumText(COLLAB_LIMITS.maxTicketTitleUtf16),
    updatedAt: maximumTimestamp,
  })),
};

export async function measureProjectRequestSnapshotCapacity(
  scope: Pick<ProjectScope, 'collaboration'>,
): Promise<RequestSnapshotCapacity> {
  const requests = await scope.collaboration.snapshot.readRequestsForAdmission();
  const openRequests = requests.map(request => ({
    ...request,
    commentCount: maximumCounter,
    revision: maximumCounter,
    ticketRelations: request.ticketRelations.map(relation => ({
      ...relation,
      ticketRevision: maximumCounter,
      ticketTitle: maximumText(COLLAB_LIMITS.maxTicketTitleUtf16),
    })),
    updatedAt: maximumTimestamp,
  }));
  return {
    bytes: Buffer.byteLength(JSON.stringify({ ...maximumEnvelope, openRequests })),
    requests: requests.length,
  };
}

export async function assertProjectRequestSnapshotCapacity(
  scope: Pick<ProjectScope, 'collaboration'>,
  before: RequestSnapshotCapacity,
): Promise<void> {
  const after = await measureProjectRequestSnapshotCapacity(scope);
  if (
    (after.bytes > COLLAB_CLOUD_BINDING_LIMITS.maxCloudSnapshotUtf8Bytes
      || after.requests > COLLAB_CLOUD_BINDING_LIMITS.maxCloudOpenRequests)
    && (after.bytes > before.bytes || after.requests > before.requests)
  ) {
    throw new CollabError({
      code: 'quota-exceeded',
      safeContext: { reason: 'request-snapshot-limit' },
    });
  }
}
