import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  collabControlOperationCodec,
  matchCollabCloudRoute,
  type CollabControlOperation,
  type CollabControlOperationMap,
} from '@claudian/collab-protocol';

import type { ProjectAcceptCoordinator } from '../../project-authority/acceptance/ProjectAcceptCoordinator.js';
import type { ProjectRequestAuthority } from '../../project-authority/requests/ProjectRequestAuthority.js';
import type { ProjectTicketAuthority } from '../../project-authority/tickets/ProjectTicketAuthority.js';
import type { DevelopmentPrincipalAdapter } from '../../request-context/DevelopmentPrincipalAdapter.js';
import {
  ProjectJsonRouteFailure,
  ProjectJsonTransport,
  projectProtocolFailure,
  type ProjectJsonRequestContext,
} from './ProjectJsonTransport.js';

type ActiveCollaborationOperation = Exclude<
  CollabControlOperation,
  'getProjectSnapshot'
>;

function unsupportedOperation(operation: never): never {
  throw new TypeError(`project-collaboration-routes.unsupported.${String(operation)}`);
}

export interface ProjectCollaborationRoutesOptions {
  readonly acceptAuthority: ProjectAcceptCoordinator;
  readonly maximumJsonBytes: number;
  readonly operationTimeoutMs: number;
  readonly principalAdapter: DevelopmentPrincipalAdapter;
  readonly requestAuthority: ProjectRequestAuthority;
  readonly requestIdFactory?: () => string;
  readonly ticketAuthority: ProjectTicketAuthority;
}

function decodedRequest<Operation extends ActiveCollaborationOperation>(
  operation: Operation,
  data: unknown,
): ReturnType<typeof collabControlOperationCodec<Operation>>['decodeRequest'] extends (
  input: unknown,
) => unknown
  ? CollabControlOperationMap[Operation]['request']
  : never {
  const decoded = collabControlOperationCodec(operation).decodeRequest(data);
  if (decoded.status !== 'ok') {
    throw new ProjectJsonRouteFailure(400, decoded.error);
  }
  return decoded.value as never;
}

function assertPathProject(
  pathProjectId: string,
  request: Readonly<{ readonly projectId: string }>,
): void {
  if (request.projectId !== pathProjectId) throw projectProtocolFailure('projectId');
}

export class ProjectCollaborationRoutes {
  readonly #acceptAuthority: ProjectAcceptCoordinator;
  readonly #requestAuthority: ProjectRequestAuthority;
  readonly #ticketAuthority: ProjectTicketAuthority;
  readonly #transport: ProjectJsonTransport;

  constructor(options: ProjectCollaborationRoutesOptions) {
    this.#acceptAuthority = options.acceptAuthority;
    this.#requestAuthority = options.requestAuthority;
    this.#ticketAuthority = options.ticketAuthority;
    this.#transport = new ProjectJsonTransport(options);
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    if (
      match?.kind !== 'project-operation'
      || match.operation === 'getProjectSnapshot'
    ) {
      return false;
    }
    void this.#transport.handle(request, response, context => (
      this.#dispatch(
        match.operation as ActiveCollaborationOperation,
        match.projectId,
        context,
      )
    )).catch(() => this.#transport.sendUnexpected(response));
    return true;
  }

  async #dispatch(
    operation: ActiveCollaborationOperation,
    pathProjectId: string,
    context: ProjectJsonRequestContext,
  ): Promise<unknown> {
    const options = { signal: context.signal };
    switch (operation) {
      case 'acceptRequest': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#acceptAuthority.accept(context.principal, request, options),
        );
      }
      case 'getRequest': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#requestAuthority.getRequest(context.principal, request, options),
        );
      }
      case 'listRequestComments': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#requestAuthority.listRequestComments(
            context.principal,
            request,
            options,
          ),
        );
      }
      case 'ensureMyRequest': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#requestAuthority.ensureMyRequest(
            context.principal,
            request,
            options,
          ),
        );
      }
      case 'createComment': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#requestAuthority.createComment(context.principal, request, options),
        );
      }
      case 'updateMyRequestMetadata': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#requestAuthority.updateMyRequestMetadata(
            context.principal,
            request,
            options,
          ),
        );
      }
      case 'listTickets': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.listTickets(context.principal, request, options),
        );
      }
      case 'getTicket': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.getTicket(context.principal, request, options),
        );
      }
      case 'listTicketComments': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.listTicketComments(
            context.principal,
            request,
            options,
          ),
        );
      }
      case 'listTicketAcceptedRelations': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.listTicketAcceptedRelations(
            context.principal,
            request,
            options,
          ),
        );
      }
      case 'createTicket': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.createTicket(context.principal, request, options),
        );
      }
      case 'updateTicketContent': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.updateTicketContent(
            context.principal,
            request,
            options,
          ),
        );
      }
      case 'createTicketComment': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.createTicketComment(
            context.principal,
            request,
            options,
          ),
        );
      }
      case 'closeTicket': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.closeTicket(context.principal, request, options),
        );
      }
      case 'reopenTicket': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.reopenTicket(context.principal, request, options),
        );
      }
    }
    return unsupportedOperation(operation);
  }
}
