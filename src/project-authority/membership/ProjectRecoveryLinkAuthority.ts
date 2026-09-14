import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  COLLAB_PROJECT_RECOVERY_LIMITS,
  CollabError,
  collabControlOperationCodec,
  collabMemberRef,
  type CreateProjectRecoveryLinkRequest,
  type CreateProjectRecoveryLinkResponse,
  type RedeemProjectRecoveryLinkRequest,
  type RedeemProjectRecoveryLinkResponse,
} from '@claudian-collab/protocol';

import type { AcquireProjectLeaseOptions, PinnedProjectLease } from '../../coordination/ProjectCoordination.js';
import type { ProjectRecoveryLinkRecord } from '../../coordination/ProjectRecoveryLinkPersistence.js';
import type { RequestPrincipal } from '../../request-context/RequestPrincipal.js';
import type { ProjectWriteAdmission } from '../admission/ProjectWriteAdmission.js';
import { hasNonterminalProjectMutation } from '../admission/hasNonterminalProjectMutation.js';
import { ProtectedSecretCustodyError, type ProtectedSecretCustody } from '../lifecycle/ProtectedSecretCustody.js';
import { OperationDrain } from '../OperationDrain.js';

export interface ProjectRecoveryLinkAuthorityOptions {
  readonly clock?: () => Date;
  readonly coordination: {
    acquireProjectLease(projectId: string, options?: AcquireProjectLeaseOptions): Promise<PinnedProjectLease>;
  };
  readonly custody: ProtectedSecretCustody;
  readonly writeAdmission: Pick<ProjectWriteAdmission, 'run'>;
}

function fail(code: ConstructorParameters<typeof CollabError>[0]['code'] = 'authorization-denied'): never {
  throw new CollabError({ code, safeContext: { reason: 'project-recovery-unavailable' } });
}
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function matches(expected: string, input: string): boolean {
  return /^[a-f0-9]{64}$/u.test(expected)
    && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sha256(input), 'hex'));
}
export function encodeRecoveryLinkAssociatedData(link: Pick<ProjectRecoveryLinkRecord,
  'projectId' | 'recoveryLinkId' | 'authorityGeneration' | 'createdAt' | 'secretReplayExpiresAt'>): string {
  return JSON.stringify({ purpose: 'project-recovery-link', envelopeVersion: 1, projectId: link.projectId,
    recoveryLinkId: link.recoveryLinkId, authorityGeneration: link.authorityGeneration,
    createdAt: link.createdAt, secretReplayExpiresAt: link.secretReplayExpiresAt });
}

export class ProjectRecoveryLinkAuthority {
  readonly #options: ProjectRecoveryLinkAuthorityOptions;
  readonly #operations = new OperationDrain();

  constructor(options: ProjectRecoveryLinkAuthorityOptions) { this.#options = options; }

  #now(): string {
    const now = new Date((this.#options.clock?.() ?? new Date()).valueOf());
    if (!Number.isFinite(now.valueOf())) return fail('operation-failed');
    now.setUTCMilliseconds(0);
    return now.toISOString();
  }

  create(principal: RequestPrincipal, request: CreateProjectRecoveryLinkRequest,
    options: AcquireProjectLeaseOptions = {}): Promise<CreateProjectRecoveryLinkResponse> {
    return this.#operations.run(options, signal => this.#options.writeAdmission.run(principal, request.projectId, async write => {
      const decoded = collabControlOperationCodec('createProjectRecoveryLink').decodeRequest(request);
      if (decoded.status !== 'ok') return fail('protocol-payload-invalid');
      if (write.role !== 'manager') return fail();
      const now = this.#now();
      const token = randomBytes(32).toString('hex');
      const record = {
        authorityGeneration: request.expectedAuthorityGeneration, createdAt: now,
        expiresAt: new Date(Date.parse(now) + COLLAB_PROJECT_RECOVERY_LIMITS.linkTtlMs).toISOString(),
        idempotencyKey: request.idempotencyKey, issuedByMemberId: write.memberId,
        projectId: request.projectId, recoveryLinkId: `recovery_${randomUUID().replaceAll('-', '')}`,
        requestFingerprint: sha256(JSON.stringify({ projectId: request.projectId, expectedAuthorityGeneration: request.expectedAuthorityGeneration })),
        secretReplayExpiresAt: new Date(Date.parse(now) + COLLAB_PROJECT_RECOVERY_LIMITS.secretReplayTtlMs).toISOString(),
        tokenSha256: sha256(token), redemption: undefined,
      };
      const envelope = await this.#options.custody.seal({ associatedData: encodeRecoveryLinkAssociatedData(record), secret: token });
      const retained = await write.transact(async scope => {
        const project = await scope.getProject();
        if (project?.authorityGeneration !== request.expectedAuthorityGeneration) return fail('authority-not-synchronized');
        const existing = await scope.membershipRecovery.readIssuance(write.memberId, request.idempotencyKey);
        if (existing) {
          if (existing.requestFingerprint !== record.requestFingerprint
            || Date.parse(existing.secretReplayExpiresAt) <= Date.parse(now) || !existing.envelope) return fail('idempotency-conflict');
          return existing;
        }
        if (await scope.membershipRecovery.countAvailableLinks(request.expectedAuthorityGeneration, now)
          >= COLLAB_PROJECT_RECOVERY_LIMITS.maxActiveLinks) return fail('quota-exceeded');
        const created = { ...record, envelope };
        await scope.membershipRecovery.insertLink(created);
        return created;
      });
      let retainedToken: string;
      try {
        if (!retained.envelope) return fail('idempotency-conflict');
        retainedToken = await this.#options.custody.open({ associatedData: encodeRecoveryLinkAssociatedData(retained), envelope: retained.envelope });
      } catch (error: unknown) {
        if (error instanceof ProtectedSecretCustodyError) return fail('operation-failed');
        throw error;
      }
      return collabControlOperationCodec('createProjectRecoveryLink').decodeResponse({ projectId: retained.projectId,
        recoveryLinkId: retained.recoveryLinkId, authorityGeneration: retained.authorityGeneration,
        token: retainedToken, expiresAt: retained.expiresAt, secretReplayExpiresAt: retained.secretReplayExpiresAt });
    }, { signal }));
  }

  redeem(principal: RequestPrincipal, request: RedeemProjectRecoveryLinkRequest,
    options: AcquireProjectLeaseOptions = {}): Promise<RedeemProjectRecoveryLinkResponse> {
    return this.#operations.run(options, async signal => {
      const decoded = collabControlOperationCodec('redeemProjectRecoveryLink').decodeRequest(request);
      if (decoded.status !== 'ok') return fail('protocol-payload-invalid');
      if (request.targetCredentialHash !== undefined || principal.provenance.kind !== 'vault-credential'
        || !/^vault-[a-f0-9]{64}$/u.test(principal.principalId)) return fail();
      const lease = await this.#options.coordination.acquireProjectLease(request.projectId, { signal });
      try {
        return await lease.withProjectScope(async scope => {
          const now = this.#now();
          const project = await scope.getProject();
          const link = await scope.membershipRecovery.readLink(request.recoveryLinkId);
          if (!project || !link || !matches(link.tokenSha256, request.token)) return fail();
          if (project.serviceState !== 'active' || project.authorityGeneration !== request.expectedAuthorityGeneration
            || link.authorityGeneration !== request.expectedAuthorityGeneration
            || await hasNonterminalProjectMutation(scope)) return fail('authority-not-synchronized');
          const proofCredentialSha256 = sha256(request.proofCredential);
          const requestFingerprint = sha256(JSON.stringify({ projectId: request.projectId, recoveryLinkId: request.recoveryLinkId,
            expectedAuthorityGeneration: request.expectedAuthorityGeneration, proofCredentialSha256, targetPrincipalId: principal.principalId }));
          if (link.redemption) {
            if (link.redemption.idempotencyKey !== request.idempotencyKey
              || link.redemption.requestFingerprint !== requestFingerprint
              || link.redemption.targetPrincipalId !== principal.principalId) return fail();
            return link.redemption.response;
          }
          if (Date.parse(link.expiresAt) <= Date.parse(now)) return fail();
          const members = await scope.membershipRecovery.findCredentialMembers(proofCredentialSha256);
          if (members.length !== 1 || !members[0]) return fail();
          const memberId = members[0];
          const member = await scope.findMembership(memberId);
          if (member?.status !== 'active') return fail();
          const binding = await scope.portability.findProjectPrincipalBinding(principal.principalId);
          if (binding && (binding.memberId !== memberId || binding.state !== 'active')) return fail();
          const memberBinding = (await scope.portability.listActiveProjectPrincipalBindings()).find(item => item.memberId === memberId);
          if (memberBinding && memberBinding.principalId !== principal.principalId) return fail();
          const hashes = new Set([...await scope.membershipRecovery.readMemberCredentialHashes(memberId),
            proofCredentialSha256, principal.principalId.slice('vault-'.length)]);
          if (hashes.size > COLLAB_PROJECT_RECOVERY_LIMITS.maxCredentialVerifiersPerMember) return fail('quota-exceeded');
          for (const hash of hashes) await scope.membershipRecovery.retainMemberCredentialHash(memberId, hash);
          if (!binding) await scope.portability.bindProjectPrincipal({ memberId, principalId: principal.principalId, boundAt: now });
          await scope.membershipRecovery.revokeUnredeemedClaims(memberId, now);
          const response = collabControlOperationCodec('redeemProjectRecoveryLink').decodeResponse({ projectId: request.projectId,
            recoveryLinkId: request.recoveryLinkId, authorityGeneration: link.authorityGeneration,
            memberId, personalRef: collabMemberRef(memberId), receiptId: `receipt_${randomUUID().replaceAll('-', '')}`, recoveredAt: now });
          await scope.membershipRecovery.recordRedemption(link.recoveryLinkId, { idempotencyKey: request.idempotencyKey,
            proofCredentialSha256, requestFingerprint, targetPrincipalId: principal.principalId, response });
          await scope.appendProjectEvent({ kind: 'membership.updated', payload: { memberId }, occurredAt: now });
          return response;
        }, { signal });
      } finally { await lease.close(); }
    });
  }

  close(): Promise<void> { return this.#operations.close(); }
}
