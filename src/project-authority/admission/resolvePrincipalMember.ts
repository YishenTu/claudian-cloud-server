import type { CollabMemberId } from '@claudian-collab/protocol';

import type { ProjectPersistenceReader } from '../../coordination/ProjectPersistence.js';
import type { RequestPrincipal } from '../../request-context/RequestPrincipal.js';

export function resolvePrincipalMember(
  scope: Pick<
    ProjectPersistenceReader,
    'findDevelopmentActorMember' | 'findPrincipalMember'
  >,
  principal: RequestPrincipal,
): Promise<CollabMemberId | undefined> {
  return principal.provenance.kind === 'private-development'
    ? scope.findDevelopmentActorMember(principal.principalId)
    : scope.findPrincipalMember(principal.principalId);
}
