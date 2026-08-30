import type { CollabMemberId } from '@claudian-collab/protocol';

export interface DevelopmentIngressPrincipal {
  readonly principalId: CollabMemberId;
  readonly provenance: Readonly<{ readonly kind: 'private-development' }>;
}

export interface TrustedIngressPrincipal {
  readonly deviceCredentialId?: string;
  readonly principalId: string;
  readonly provenance: Readonly<{
    readonly kind: 'operator-protected-channel';
    readonly providerId: string;
  }>;
}

export type IngressPrincipal = DevelopmentIngressPrincipal | TrustedIngressPrincipal;

export function createDevelopmentIngressPrincipal(
  principalId: CollabMemberId,
): IngressPrincipal {
  return Object.freeze({
    principalId,
    provenance: Object.freeze({ kind: 'private-development' as const }),
  });
}

export function createTrustedIngressPrincipal(input: Readonly<{
  readonly deviceCredentialId?: string;
  readonly principalId: string;
  readonly providerId: string;
}>): IngressPrincipal {
  return Object.freeze({
    ...(input.deviceCredentialId === undefined
      ? {}
      : { deviceCredentialId: input.deviceCredentialId }),
    principalId: input.principalId,
    provenance: Object.freeze({
      kind: 'operator-protected-channel' as const,
      providerId: input.providerId,
    }),
  });
}
