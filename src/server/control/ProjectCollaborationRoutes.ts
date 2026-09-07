import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
  COLLAB_PROJECT_MEMBERSHIP_OPERATIONS,
  COLLAB_PROJECT_RETIREMENT_OPERATIONS,
  collabControlOperationCodec,
  matchCollabCloudRoute,
  type CollabControlOperation,
  type CollabControlOperationMap,
} from '@claudian-collab/protocol';

import type { ProjectAcceptCoordinator } from '../../project-authority/acceptance/ProjectAcceptCoordinator.js';
import type { ProjectRequestAuthority } from '../../project-authority/requests/ProjectRequestAuthority.js';
import type { ProjectTicketAuthority } from '../../project-authority/tickets/ProjectTicketAuthority.js';
import {
  ProjectJsonRouteFailure,
  ProjectJsonTransport,
  projectProtocolFailure,
  type ProjectJsonRequestContext,
  type ProjectJsonTransportOptions,
} from './ProjectJsonTransport.js';

type RoutedElsewhereOperation =
  | typeof COLLAB_AUTHORITY_TRANSFER_OPERATIONS[number]
  | typeof COLLAB_PROJECT_MEMBERSHIP_OPERATIONS[number]
  | typeof COLLAB_PROJECT_RETIREMENT_OPERATIONS[number];

type ActiveCollaborationOperation = Exclude<
  CollabControlOperation,
  'getProjectSnapshot' | RoutedElsewhereOperation
>;

const ROUTED_ELSEWHERE_OPERATION_SET: ReadonlySet<string> = new Set([
  ...COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
  ...COLLAB_PROJECT_MEMBERSHIP_OPERATIONS,
  ...COLLAB_PROJECT_RETIREMENT_OPERATIONS,
]);

function isActiveCollaborationOperation(
  operation: CollabControlOperation,
): operation is ActiveCollaborationOperation {
  return !ROUTED_ELSEWHERE_OPERATION_SET.has(operation);
}

function unsupportedOperation(operation: never): never {
  throw new TypeError(`project-collaboration-routes.unsupported.${String(operation)}`);
}

export interface ProjectCollaborationRoutesOptions
  extends ProjectJsonTransportOptions {
  readonly acceptAuthority: ProjectAcceptCoordinator;
  readonly requestAuthority: ProjectRequestAuthority;
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
    if (match?.kind !== 'project-operation') {
      return false;
    }
    const operation = match.operation;
    if (
      operation === 'getProjectSnapshot'
      || !isActiveCollaborationOperation(operation)
    ) {
      return false;
    }
    void this.#transport.handle(request, response, context => (
      this.#dispatch(
        operation,
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
      case 'resolveTicketNumber': {
        const request = decodedRequest(operation, context.data);
        assertPathProject(pathProjectId, request);
        return collabControlOperationCodec(operation).decodeResponse(
          await this.#ticketAuthority.resolveTicketNumber(context.principal, request, options),
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
