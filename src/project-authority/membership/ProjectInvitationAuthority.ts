import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  COLLAB_PROJECT_MEMBERSHIP_LIMITS,
  CollabError,
  collabControlOperationCodec,
  type CollabProjectRequest,
  type CreateProjectInvitationRequest,
  type CreateProjectInvitationResponse,
  type ListProjectInvitationsResponse,
  type RevokeProjectInvitationRequest,
  type RevokeProjectInvitationResponse,
} from '@claudian-collab/protocol';

import type {
  ProjectInvitationRecord,
  ProtectedInvitationEnvelope,
} from '../../coordination/ProjectMembershipPersistence.js';
import { ProjectMutationRejection } from '../ProjectMutationRejection.js';
import type { RequestPrincipal } from '../../request-context/RequestPrincipal.js';
import type { ProjectWriteAdmission } from '../admission/ProjectWriteAdmission.js';
import { ProtectedSecretCustodyError } from '../lifecycle/ProtectedSecretCustody.js';
import type { ProtectedSecretCustody } from '../lifecycle/ProtectedSecretCustody.js';

export interface ProjectInvitationAuthorityOptions {
  readonly clock?: () => Date;
  readonly custody: ProtectedSecretCustody;
  readonly invitationIdFactory?: () => string;
  readonly secretFactory?: () => string;
  readonly writeAdmission: Pick<ProjectWriteAdmission, 'run'>;
}

function domainError(
  code: ConstructorParameters<typeof CollabError>[0]['code'],
  reason: string,
): CollabError {
  return new CollabError({ code, safeContext: { reason } });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalNow(clock: () => Date): string {
  const now = new Date(clock().valueOf());
  if (Number.isNaN(now.valueOf())) throw new Error('invalid-clock');
  now.setUTCMilliseconds(0);
  return now.toISOString();
}

function plusMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

export function encodeInvitationAssociatedData(input: Readonly<{
  readonly expiresAt: string;
  readonly invitationId: string;
  readonly projectId: string;
}>): string {
  return JSON.stringify({
    envelopeVersion: 1,
    expiresAt: input.expiresAt,
    invitationId: input.invitationId,
    projectId: input.projectId,
    purpose: 'cloud-project-invitation',
  });
}

function creationFingerprint(request: CreateProjectInvitationRequest): string {
  return sha256(JSON.stringify({
    expectedManagerSetGeneration: request.expectedManagerSetGeneration,
    projectId: request.projectId,
  }));
}

function revokeFingerprint(request: RevokeProjectInvitationRequest): string {
  return sha256(JSON.stringify({
    expectedInvitationRevision: request.expectedInvitationRevision,
    expectedManagerSetGeneration: request.expectedManagerSetGeneration,
    invitationId: request.invitationId,
    projectId: request.projectId,
  }));
}

function summary(record: ProjectInvitationRecord) {
  return Object.freeze({
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    invitationId: record.invitationId,
    revision: record.revision,
    state: record.state,
    terminalAt: record.terminalAt,
  });
}

function mapStatus(status: string): never {
  if (status === 'permanently-stale') {
    throw new ProjectMutationRejection({
      code: 'authority-not-synchronized',
      safeContext: { reason: 'membership-expected-state' },
    });
  }
  if (status === 'quota') throw domainError('quota-exceeded', 'membership-capacity');
  if (status === 'stale-generation' || status === 'stale-invitation') {
    throw domainError('authority-not-synchronized', 'membership-expected-state');
  }
  if (status === 'replay-expired') {
    throw domainError('idempotency-conflict', 'secret-replay-expired');
  }
  throw domainError('idempotency-conflict', 'membership-idempotency-conflict');
}

export class ProjectInvitationAuthority {
  readonly #clock: () => Date;
  readonly #custody: ProtectedSecretCustody;
  readonly #invitationIdFactory: () => string;
  readonly #secretFactory: () => string;
  readonly #writeAdmission: Pick<ProjectWriteAdmission, 'run'>;

  constructor(options: ProjectInvitationAuthorityOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#custody = options.custody;
    this.#invitationIdFactory = options.invitationIdFactory ?? (() => (
      `invitation_${randomUUID().replaceAll('-', '')}`
    ));
    this.#secretFactory = options.secretFactory ?? (() => (
      randomBytes(32).toString('base64url')
    ));
    this.#writeAdmission = options.writeAdmission;
  }

  create(
    principal: RequestPrincipal,
    request: CreateProjectInvitationRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<CreateProjectInvitationResponse> {
    return this.#writeAdmission.run(
      principal,
      request.projectId,
      async write => {
        if (write.role !== 'manager') {
          throw domainError('authorization-denied', 'manager-required');
        }
        const createdAt = canonicalNow(this.#clock);
        const expiresAt = plusMilliseconds(
          createdAt,
          COLLAB_PROJECT_MEMBERSHIP_LIMITS.invitationTtlMs,
        );
        const secretReplayExpiresAt = plusMilliseconds(
          createdAt,
          COLLAB_PROJECT_MEMBERSHIP_LIMITS.secretReplayTtlMs,
        );
        const invitationId = this.#invitationIdFactory();
        const secret = this.#secretFactory();
        if (secret.length !== COLLAB_PROJECT_MEMBERSHIP_LIMITS.invitationSecretLength) {
          throw domainError('operation-failed', 'invitation-secret-source-invalid');
        }
        const associatedData = encodeInvitationAssociatedData({
          expiresAt,
          invitationId,
          projectId: request.projectId,
        });
        let protectedSecret;
        try {
          protectedSecret = await this.#custody.seal({ associatedData, secret });
        } catch (error: unknown) {
          if (!(error instanceof ProtectedSecretCustodyError)) throw error;
          throw domainError('operation-failed', 'invitation-custody-unavailable');
        }
        const envelope: ProtectedInvitationEnvelope = Object.freeze({
          ...protectedSecret,
          createdAt,
          expiresAt,
          invitationId,
          projectId: request.projectId,
        });
        const result = await write.transact(scope => scope.membership.createInvitation({
          createdAt,
          envelope,
          expectedManagerSetGeneration: request.expectedManagerSetGeneration,
          expiresAt,
          idempotencyKey: request.idempotencyKey,
          invitationId,
          issuedByMemberId: write.memberId,
          projectId: request.projectId,
          requestFingerprint: creationFingerprint(request),
          secretReplayExpiresAt,
          secretSha256: sha256(secret),
          terminalAt: null,
        }));
        if (result.record === undefined) return mapStatus(result.status);
        let replayedSecret = secret;
        if (result.status === 'replayed') {
          if (result.record.envelope === undefined) return mapStatus('replay-expired');
          const replayAssociatedData = encodeInvitationAssociatedData(result.record);
          try {
            replayedSecret = await this.#custody.open({
              associatedData: replayAssociatedData,
              envelope: result.record.envelope,
            });
          } catch {
            throw domainError('operation-failed', 'invitation-custody-unavailable');
          }
        }
        return collabControlOperationCodec('createProjectInvitation').decodeResponse({
          createdAt: result.record.createdAt,
          expiresAt: result.record.expiresAt,
          invitationId: result.record.invitationId,
          issuedState: 'active',
          projectId: result.record.projectId,
          secret: replayedSecret,
          secretReplayExpiresAt: result.record.secretReplayExpiresAt,
        });
      },
      options,
    );
  }

  list(
    principal: RequestPrincipal,
    request: CollabProjectRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<ListProjectInvitationsResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      if (write.role !== 'manager') {
        throw domainError('authorization-denied', 'manager-required');
      }
      const result = await write.transact(scope => (
        scope.membership.listInvitations(canonicalNow(this.#clock))
      ));
      return collabControlOperationCodec('listProjectInvitations').decodeResponse({
        invitations: result.invitations.map(summary),
        managerSetGeneration: result.managerSetGeneration,
        projectId: request.projectId,
      });
    }, options);
  }

  revoke(
    principal: RequestPrincipal,
    request: RevokeProjectInvitationRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<RevokeProjectInvitationResponse> {
    return this.#writeAdmission.run(principal, request.projectId, async write => {
      if (write.role !== 'manager') {
        throw domainError('authorization-denied', 'manager-required');
      }
      const revokedAt = canonicalNow(this.#clock);
      const result = await write.transact(scope => scope.membership.revokeInvitation({
        actorMemberId: write.memberId,
        expectedInvitationRevision: request.expectedInvitationRevision,
        expectedManagerSetGeneration: request.expectedManagerSetGeneration,
        idempotencyKey: request.idempotencyKey,
        invitationId: request.invitationId,
        projectId: request.projectId,
        requestFingerprint: revokeFingerprint(request),
        revokedAt,
      }));
      if (result.record === undefined) return mapStatus(result.status);
      return collabControlOperationCodec('revokeProjectInvitation').decodeResponse({
        invitationId: result.record.invitationId,
        projectId: result.record.projectId,
        revision: result.record.revision,
        revokedAt: result.record.terminalAt,
        state: 'revoked',
      });
    }, options);
  }
}
