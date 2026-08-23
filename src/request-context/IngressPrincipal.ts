import type { CollabMemberId } from '@claudian-collab/protocol';

export interface IngressPrincipal {
  readonly actorId: CollabMemberId;
  readonly profile: 'loopback-development';
}

export function createDevelopmentIngressPrincipal(
  actorId: CollabMemberId,
): IngressPrincipal {
  return Object.freeze({
    actorId,
    profile: 'loopback-development' as const,
  });
}
