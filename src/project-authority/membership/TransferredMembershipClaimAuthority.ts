import { createHash, randomBytes } from 'node:crypto';

import {
  COLLAB_PROJECT_MEMBERSHIP_LIMITS,
  CollabError,
  collabControlOperationCodec,
  type ReissueTransferredMembershipClaimRequest,
  type ReissueTransferredMembershipClaimResponse,
  type RevokeTransferredMembershipClaimRequest,
  type RevokeTransferredMembershipClaimResponse,
} from '@claudian-collab/protocol';

import type { ProtectedClaimOverrideEnvelope } from '../../coordination/ProjectMembershipPersistence.js';
import { ProjectMutationRejection } from '../ProjectMutationRejection.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import type { ProjectWriteAdmission } from '../admission/ProjectWriteAdmission.js';
import {
  ProtectedSecretCustodyError,
  type ProtectedSecretCustody,
} from '../lifecycle/ProtectedSecretCustody.js';

export interface TransferredMembershipClaimAuthorityOptions {
  readonly clock?: () => Date;
  readonly custody: ProtectedSecretCustody;
  readonly secretFactory?: () => string;
  readonly writeAdmission: Pick<ProjectWriteAdmission, 'run'>;
}

function domainError(
  code: ConstructorParameters<typeof CollabError>[0]['code'],
  reason: string,
): CollabError {
  return new CollabError({ code, safeContext: { reason } });
}

function canonicalNow(clock: () => Date): string {
  const value = new Date(clock().valueOf());
  if (Number.isNaN(value.valueOf())) throw new Error('invalid-clock');
  value.setUTCMilliseconds(0);
  return value.toISOString();
}

function plusMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fingerprint(operation: string, request: object): string {
  return sha256(JSON.stringify({ operation, request }));
}

export function encodeClaimOverrideAssociatedData(input: Readonly<{
  readonly claimGeneration: number;
  readonly expiresAt: string;
  readonly memberId: string;
  readonly projectId: string;
  readonly transferId: string;
}>): string {
  return JSON.stringify({
    claimGeneration: input.claimGeneration,
    envelopeVersion: 1,
    expiresAt: input.expiresAt,
    memberId: input.memberId,
    projectId: input.projectId,
    purpose: 'transferred-membership-claim-override',
    transferId: input.transferId,
  });
}

function mapStatus(status: string): never {
  if (status === 'permanently-stale') {
    throw new ProjectMutationRejection({
      code: 'authority-not-synchronized',
      safeContext: { reason: 'claim-expected-state' },
    });
  }
  if (status === 'authorization-denied') {
    throw domainError('authorization-denied', 'claim-administration-denied');
  }
  if (status === 'stale') {
    throw domainError('authority-not-synchronized', 'claim-expected-state');
  }
  if (status === 'replay-expired') {
    throw domainError('idempotency-conflict', 'secret-replay-expired');
  }
  throw domainError('idempotency-conflict', 'claim-idempotency-conflict');
}

export class TransferredMembershipClaimAuthority {
  readonly #clock: () => Date;
  readonly #custody: ProtectedSecretCustody;
  readonly #secretFactory: () => string;
  readonly #writeAdmission: Pick<ProjectWriteAdmission, 'run'>;

  constructor(options: TransferredMembershipClaimAuthorityOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#custody = options.custody;
    this.#secretFactory = options.secretFactory ?? (() => (
      randomBytes(32).toString('base64url')
    ));
    this.#writeAdmission = options.writeAdmission;
  }

  reissue(
    principal: IngressPrincipal,
    request: ReissueTransferredMembershipClaimRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<ReissueTransferredMembershipClaimResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      if (write.role !== 'manager') {
        throw domainError('authorization-denied', 'manager-required');
      }
      const createdAt = canonicalNow(this.#clock);
      const facts = await write.transact(scope => (
        scope.membership.getImportedMembershipClaimFacts(
          request.memberId,
          createdAt,
        )
      ));
      if (facts === undefined) return mapStatus('stale');
      const claimGeneration = request.expectedClaimGeneration + 1;
      if (!Number.isSafeInteger(claimGeneration)) return mapStatus('stale');
      const expiresAt = plusMilliseconds(
        createdAt,
        COLLAB_PROJECT_MEMBERSHIP_LIMITS.transferredClaimTtlMs,
      );
      const secretReplayExpiresAt = plusMilliseconds(
        createdAt,
        COLLAB_PROJECT_MEMBERSHIP_LIMITS.secretReplayTtlMs,
      );
      const claim = this.#secretFactory();
      if (claim.length !== COLLAB_PROJECT_MEMBERSHIP_LIMITS.transferredClaimLength) {
        throw domainError('operation-failed', 'claim-secret-source-invalid');
      }
      const associatedData = encodeClaimOverrideAssociatedData({
        claimGeneration,
        expiresAt,
        memberId: request.memberId,
        projectId: request.projectId,
        transferId: facts.transferId,
      });
      let protectedSecret;
      try {
        protectedSecret = await this.#custody.seal({ associatedData, secret: claim });
      } catch (error: unknown) {
        if (!(error instanceof ProtectedSecretCustodyError)) throw error;
        throw domainError('operation-failed', 'claim-custody-unavailable');
      }
      const envelope: ProtectedClaimOverrideEnvelope = Object.freeze({
        ...protectedSecret,
        claimGeneration,
        createdAt,
        expiresAt,
        memberId: request.memberId,
        projectId: request.projectId,
        transferId: facts.transferId,
      });
      const result = await write.transact(scope => (
        scope.membership.reissueTransferredMembershipClaim({
          actorMemberId: write.memberId,
          claimGeneration,
          claimSha256: sha256(claim),
          createdAt,
          envelope,
          expectedClaimGeneration: request.expectedClaimGeneration,
          expectedManagerSetGeneration: request.expectedManagerSetGeneration,
          expectedMembershipRevision: request.expectedMembershipRevision,
          expiresAt,
          idempotencyKey: request.idempotencyKey,
          memberId: request.memberId,
          projectId: request.projectId,
          requestFingerprint: fingerprint(
            'reissueTransferredMembershipClaim',
            request,
          ),
          secretReplayExpiresAt,
          transferId: facts.transferId,
        })
      ));
      if (result.status !== 'created' && result.status !== 'replayed') {
        return mapStatus(result.status);
      }
      const record = result.record;
      if (record === undefined) return mapStatus('conflict');
      const transfer = await write.transact(scope => (
        scope.portability.getLifecycleJournal(record.transferId)
      ));
      if (
        transfer?.kind !== 'authority-transfer'
        || transfer.direction !== 'lan-to-cloud'
        || transfer.state !== 'completed'
        || transfer.projectId !== record.projectId
        || transfer.operationId !== record.transferId
      ) {
        throw domainError('operation-failed', 'claim-transfer-unavailable');
      }
      let replayedClaim = claim;
      if (result.status === 'replayed') {
        if (record.envelope === undefined) return mapStatus('replay-expired');
        try {
          replayedClaim = await this.#custody.open({
            associatedData: encodeClaimOverrideAssociatedData(record),
            envelope: record.envelope,
          });
        } catch {
          throw domainError('operation-failed', 'claim-custody-unavailable');
        }
      }
      return collabControlOperationCodec('reissueTransferredMembershipClaim')
        .decodeResponse({
          claim: replayedClaim,
          claimGeneration: record.claimGeneration,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          memberId: record.memberId,
          projectId: record.projectId,
          secretReplayExpiresAt: record.secretReplayExpiresAt,
          targetAuthorityGeneration: transfer.expectedAuthorityGeneration + 1,
          transferId: record.transferId,
        });
    }, options);
  }

  revoke(
    principal: IngressPrincipal,
    request: RevokeTransferredMembershipClaimRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<RevokeTransferredMembershipClaimResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      if (write.role !== 'manager') {
        throw domainError('authorization-denied', 'manager-required');
      }
      const result = await write.transact(scope => (
        scope.membership.revokeTransferredMembershipClaim({
          actorMemberId: write.memberId,
          expectedClaimGeneration: request.expectedClaimGeneration,
          expectedManagerSetGeneration: request.expectedManagerSetGeneration,
          expectedMembershipRevision: request.expectedMembershipRevision,
          idempotencyKey: request.idempotencyKey,
          memberId: request.memberId,
          projectId: request.projectId,
          requestFingerprint: fingerprint(
            'revokeTransferredMembershipClaim',
            request,
          ),
          revokedAt: canonicalNow(this.#clock),
        })
      ));
      if (result.status !== 'created' && result.status !== 'replayed') {
        return mapStatus(result.status);
      }
      if (result.response === undefined) return mapStatus('conflict');
      return collabControlOperationCodec('revokeTransferredMembershipClaim')
        .decodeResponse(result.response);
    }, options);
  }
}
