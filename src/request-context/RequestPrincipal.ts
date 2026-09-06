import type { CollabMemberId } from '@claudian-collab/protocol';

export interface DevelopmentPrincipal {
  readonly principalId: CollabMemberId;
  readonly provenance: Readonly<{ readonly kind: 'private-development' }>;
}

export interface VaultCredentialPrincipal {
  readonly principalId: string;
  readonly provenance: Readonly<{ readonly kind: 'vault-credential' }>;
}

export type RequestPrincipal = DevelopmentPrincipal | VaultCredentialPrincipal;

export function createDevelopmentPrincipal(principalId: CollabMemberId): DevelopmentPrincipal {
  return Object.freeze({
    principalId,
    provenance: Object.freeze({ kind: 'private-development' as const }),
  });
}

export function createVaultCredentialPrincipal(input: Readonly<{
  readonly principalId: string;
}>): VaultCredentialPrincipal {
  return Object.freeze({
    principalId: input.principalId,
    provenance: Object.freeze({ kind: 'vault-credential' as const }),
  });
}
