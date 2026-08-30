import type { CollabMemberId } from '@claudian-collab/protocol';

import type { ProjectPersistenceReader } from '../../coordination/ProjectPersistence.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';

export function resolvePrincipalMember(
  scope: Pick<
    ProjectPersistenceReader,
    'findDevelopmentActorMember' | 'findPrincipalMember'
  >,
  principal: IngressPrincipal,
): Promise<CollabMemberId | undefined> {
  return principal.provenance.kind === 'private-development'
    ? scope.findDevelopmentActorMember(principal.principalId)
    : scope.findPrincipalMember(principal.principalId);
}
