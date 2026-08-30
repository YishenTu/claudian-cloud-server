import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  collabControlOperationCodec,
  matchCollabCloudRoute,
  type CollabControlOperation,
  type CreateCloudProjectRequest,
} from '@claudian-collab/protocol';

import type { CloudProjectCreationCoordinator } from '../../project-authority/creation/CloudProjectCreationCoordinator.js';
import type { CloudProjectJoinCoordinator } from '../../project-authority/membership/CloudProjectJoinCoordinator.js';
import type { ProjectInvitationAuthority } from '../../project-authority/membership/ProjectInvitationAuthority.js';
import type { ProjectMembershipAdministrationAuthority } from '../../project-authority/membership/ProjectMembershipAdministrationAuthority.js';
import type { ProjectMemberRemovalCoordinator } from '../../project-authority/membership/ProjectMemberRemovalCoordinator.js';
import type { LeaveCoordinator } from '../../project-authority/lifecycle/leave/LeaveCoordinator.js';
import type { TransferredMembershipClaimAuthority } from '../../project-authority/membership/TransferredMembershipClaimAuthority.js';
import {
  ProjectJsonRouteFailure,
  ProjectJsonTransport,
  projectProtocolFailure,
  type ProjectJsonRequestContext,
  type ProjectJsonTransportOptions,
} from './ProjectJsonTransport.js';

export interface CloudProjectMembershipRoutesOptions
  extends ProjectJsonTransportOptions {
  readonly creation: Pick<CloudProjectCreationCoordinator, 'create'>;
  readonly administration?: Pick<
    ProjectMembershipAdministrationAuthority,
    | 'acknowledgeOffer'
    | 'cancelOffer'
    | 'createOffer'
    | 'declineOffer'
    | 'demote'
    | 'getOffer'
    | 'listMembers'
    | 'listOffers'
    | 'promote'
  >;
  readonly claims?: Pick<TransferredMembershipClaimAuthority, 'reissue' | 'revoke'>;
  readonly invitation?: Pick<ProjectInvitationAuthority, 'create' | 'list' | 'revoke'>;
  readonly join?: Pick<CloudProjectJoinCoordinator, 'join'>;
  readonly leave?: Pick<LeaveCoordinator, 'leave'>;
  readonly removal?: Pick<ProjectMemberRemovalCoordinator, 'remove'>;
}

function decodedCreate(data: unknown): CreateCloudProjectRequest {
  const decoded = collabControlOperationCodec('createCloudProject').decodeRequest(data);
  if (decoded.status !== 'ok') {
    throw new ProjectJsonRouteFailure(400, decoded.error);
  }
  return decoded.value;
}

export class CloudProjectMembershipRoutes {
  readonly #administration: CloudProjectMembershipRoutesOptions['administration'];
  readonly #claims: CloudProjectMembershipRoutesOptions['claims'];
  readonly #creation: Pick<CloudProjectCreationCoordinator, 'create'>;
  readonly #invitation: Pick<
    ProjectInvitationAuthority,
    'create' | 'list' | 'revoke'
  > | undefined;
  readonly #join: Pick<CloudProjectJoinCoordinator, 'join'> | undefined;
  readonly #removal: Pick<ProjectMemberRemovalCoordinator, 'remove'> | undefined;
  readonly #leave: Pick<LeaveCoordinator, 'leave'> | undefined;
  readonly #transport: ProjectJsonTransport;

  constructor(options: CloudProjectMembershipRoutesOptions) {
    this.#administration = options.administration;
    this.#claims = options.claims;
    this.#creation = options.creation;
    this.#invitation = options.invitation;
    this.#join = options.join;
    this.#removal = options.removal;
    this.#leave = options.leave;
    this.#transport = new ProjectJsonTransport(options);
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    if (match?.kind !== 'project-operation') return false;
    const operation = match.operation;
    if (!this.#owns(operation)) return false;
    void this.#transport.handle(request, response, context => (
      this.#dispatch(operation, match.projectId, context)
    )).catch(() => this.#transport.sendUnexpected(response));
    return true;
  }

  #owns(
    operation: CollabControlOperation | 'getProjectSnapshot',
  ): operation is CollabControlOperation {
    if (operation === 'createCloudProject') return true;
    if (operation === 'joinCloudProject') return this.#join !== undefined;
    if (operation === 'removeMember') return this.#removal !== undefined;
    if (operation === 'leaveProject') return this.#leave !== undefined;
    if (this.#invitation !== undefined && (
      operation === 'createProjectInvitation'
      || operation === 'listProjectInvitations'
      || operation === 'revokeProjectInvitation'
    )) return true;
    if (this.#claims !== undefined && (
      operation === 'reissueTransferredMembershipClaim'
      || operation === 'revokeTransferredMembershipClaim'
    )) return true;
    return this.#administration !== undefined && (
      operation === 'listProjectMembers'
      || operation === 'createManagerResponsibilityOffer'
      || operation === 'listCurrentManagerResponsibilityOffers'
      || operation === 'getManagerResponsibilityOffer'
      || operation === 'acknowledgeManagerResponsibility'
      || operation === 'declineManagerResponsibility'
      || operation === 'cancelManagerResponsibilityOffer'
      || operation === 'promoteManager'
      || operation === 'demoteManager'
    );
  }

  #dispatch(
    operation: CollabControlOperation,
    pathProjectId: string,
    context: ProjectJsonRequestContext,
  ): Promise<unknown> {
    if (operation === 'createCloudProject') return this.#create(pathProjectId, context);
    const codec = collabControlOperationCodec(operation);
    const decoded = codec.decodeRequest(context.data);
    if (decoded.status !== 'ok') {
      throw new ProjectJsonRouteFailure(400, decoded.error);
    }
    const request = decoded.value as { readonly projectId: string };
    if (request.projectId !== pathProjectId) throw projectProtocolFailure('projectId');
    if (operation === 'createProjectInvitation' && this.#invitation !== undefined) {
      return this.#invitation.create(
        context.principal,
        decoded.value as Parameters<ProjectInvitationAuthority['create']>[1],
        { signal: context.signal },
      );
    }
    if (operation === 'listProjectInvitations' && this.#invitation !== undefined) {
      return this.#invitation.list(
        context.principal,
        decoded.value,
        { signal: context.signal },
      );
    }
    if (operation === 'revokeProjectInvitation' && this.#invitation !== undefined) {
      return this.#invitation.revoke(
        context.principal,
        decoded.value as Parameters<ProjectInvitationAuthority['revoke']>[1],
        { signal: context.signal },
      );
    }
    if (operation === 'joinCloudProject' && this.#join !== undefined) {
      return this.#join.join(
        context.principal,
        decoded.value as Parameters<CloudProjectJoinCoordinator['join']>[1],
        { signal: context.signal },
      );
    }
    if (operation === 'removeMember' && this.#removal !== undefined) {
      return this.#removal.remove(
        context.principal,
        decoded.value as Parameters<ProjectMemberRemovalCoordinator['remove']>[1],
        { signal: context.signal },
      );
    }
    if (operation === 'leaveProject' && this.#leave !== undefined) {
      return this.#leave.leave(
        context.principal,
        decoded.value as Parameters<LeaveCoordinator['leave']>[1],
        { signal: context.signal },
      );
    }
    if (operation === 'reissueTransferredMembershipClaim' && this.#claims) {
      return this.#claims.reissue(
        context.principal,
        decoded.value as Parameters<TransferredMembershipClaimAuthority['reissue']>[1],
        { signal: context.signal },
      );
    }
    if (operation === 'revokeTransferredMembershipClaim' && this.#claims) {
      return this.#claims.revoke(
        context.principal,
        decoded.value as Parameters<TransferredMembershipClaimAuthority['revoke']>[1],
        { signal: context.signal },
      );
    }
    if (this.#administration !== undefined) {
      const options = { signal: context.signal };
      if (operation === 'listProjectMembers') {
        return this.#administration.listMembers(
          context.principal,
          decoded.value,
          options,
        );
      }
      if (operation === 'createManagerResponsibilityOffer') {
        return this.#administration.createOffer(
          context.principal,
          decoded.value as Parameters<ProjectMembershipAdministrationAuthority['createOffer']>[1],
          options,
        );
      }
      if (operation === 'listCurrentManagerResponsibilityOffers') {
        return this.#administration.listOffers(
          context.principal,
          decoded.value,
          options,
        );
      }
      if (operation === 'getManagerResponsibilityOffer') {
        return this.#administration.getOffer(
          context.principal,
          decoded.value as Parameters<ProjectMembershipAdministrationAuthority['getOffer']>[1],
          options,
        );
      }
      if (operation === 'acknowledgeManagerResponsibility') {
        return this.#administration.acknowledgeOffer(
          context.principal,
          decoded.value as Parameters<ProjectMembershipAdministrationAuthority['acknowledgeOffer']>[1],
          options,
        );
      }
      if (operation === 'declineManagerResponsibility') {
        return this.#administration.declineOffer(
          context.principal,
          decoded.value as Parameters<ProjectMembershipAdministrationAuthority['declineOffer']>[1],
          options,
        );
      }
      if (operation === 'cancelManagerResponsibilityOffer') {
        return this.#administration.cancelOffer(
          context.principal,
          decoded.value as Parameters<ProjectMembershipAdministrationAuthority['cancelOffer']>[1],
          options,
        );
      }
      if (operation === 'promoteManager') {
        return this.#administration.promote(
          context.principal,
          decoded.value as Parameters<ProjectMembershipAdministrationAuthority['promote']>[1],
          options,
        );
      }
      if (operation === 'demoteManager') {
        return this.#administration.demote(
          context.principal,
          decoded.value as Parameters<ProjectMembershipAdministrationAuthority['demote']>[1],
          options,
        );
      }
    }
    return Promise.reject(new Error('cloud-project-membership.operation-unavailable'));
  }

  async #create(
    pathProjectId: string,
    context: ProjectJsonRequestContext,
  ): Promise<unknown> {
    const request = decodedCreate(context.data);
    if (request.projectId !== pathProjectId) throw projectProtocolFailure('projectId');
    return collabControlOperationCodec('createCloudProject').decodeResponse(
      await this.#creation.create(context.principal, request, {
        signal: context.signal,
      }),
    );
  }
}
