import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
  COLLAB_PROJECT_RETIREMENT_OPERATIONS,
  CollabError,
  collabControlOperationCodec,
  matchCollabCloudRoute,
  type CollabAuthorityTransferOperation,
  type CollabControlOperationMap,
  type CollabProjectRetirementOperation,
  type CollabProjectRetirementResult,
} from '@claudian-collab/protocol';

import type { DevelopmentPrincipalAdapter } from '../../request-context/DevelopmentPrincipalAdapter.js';
import {
  ProjectJsonRouteFailure,
  ProjectJsonTransport,
  projectProtocolFailure,
  type ProjectJsonRequestContext,
} from './ProjectJsonTransport.js';

type CloudAuthorityTransferOperation = Exclude<
  CollabAuthorityTransferOperation,
  'acceptLanToCloudTransferTarget' | 'requestLanToCloudTransfer'
>;

export type CloudLifecycleOperation =
  | CloudAuthorityTransferOperation
  | CollabProjectRetirementOperation;

export interface CloudLifecycleOperationContext<
  Operation extends CloudLifecycleOperation,
> {
  readonly principalId: string;
  readonly request: CollabControlOperationMap[Operation]['request'];
  readonly signal: AbortSignal;
}

export interface CloudLifecycleControl {
  execute<Operation extends CloudLifecycleOperation>(
    operation: Operation,
    context: CloudLifecycleOperationContext<Operation>,
  ): Promise<CollabControlOperationMap[Operation]['response']>;
  getRetirementTerminal?(
    principalId: string,
    projectId: string,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<CollabProjectRetirementResult | null>;
}

export interface ProjectLifecycleRoutesOptions {
  readonly control: CloudLifecycleControl;
  readonly maximumJsonBytes: number;
  readonly operationTimeoutMs: number;
  readonly principalAdapter: DevelopmentPrincipalAdapter;
  readonly requestIdFactory?: () => string;
}

const AUTHORITY_TRANSFER_OPERATION_SET: ReadonlySet<string> = new Set(
  COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
);
const RETIREMENT_OPERATION_SET: ReadonlySet<string> = new Set(
  COLLAB_PROJECT_RETIREMENT_OPERATIONS,
);

function isCloudLifecycleOperation(
  operation: string,
): operation is CloudLifecycleOperation {
  if (
    operation === 'acceptLanToCloudTransferTarget'
    || operation === 'requestLanToCloudTransfer'
  ) return false;
  return AUTHORITY_TRANSFER_OPERATION_SET.has(operation)
    || RETIREMENT_OPERATION_SET.has(operation);
}

function decodeRequest<Operation extends CloudLifecycleOperation>(
  operation: Operation,
  value: unknown,
): CollabControlOperationMap[Operation]['request'] {
  const decoded = collabControlOperationCodec(operation).decodeRequest(value);
  if (decoded.status !== 'ok') {
    throw new ProjectJsonRouteFailure(400, decoded.error);
  }
  return decoded.value;
}

function assertPathProject(
  projectId: string,
  request: Readonly<{ readonly projectId: string }>,
): void {
  if (request.projectId !== projectId) throw projectProtocolFailure('projectId');
}

export class ProjectLifecycleRoutes {
  readonly #control: CloudLifecycleControl;
  readonly #transport: ProjectJsonTransport;

  constructor(options: ProjectLifecycleRoutesOptions) {
    this.#control = options.control;
    this.#transport = new ProjectJsonTransport(options);
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    if (
      match?.kind !== 'project-operation'
      || !isCloudLifecycleOperation(match.operation)
    ) return false;
    const operation = match.operation;
    void this.#transport.handle(request, response, context => (
      this.#dispatch(operation, match.projectId, context)
    )).catch(() => this.#transport.sendUnexpected(response));
    return true;
  }

  async #dispatch<Operation extends CloudLifecycleOperation>(
    operation: Operation,
    pathProjectId: string,
    context: ProjectJsonRequestContext,
  ): Promise<CollabControlOperationMap[Operation]['response']> {
    const request = decodeRequest(operation, context.data);
    assertPathProject(pathProjectId, request);
    const response = await this.#control.execute(operation, {
      principalId: context.principal.actorId,
      request,
      signal: context.signal,
    });
    try {
      return collabControlOperationCodec(operation).decodeResponse(response);
    } catch {
      throw new ProjectJsonRouteFailure(
        500,
        new CollabError({ code: 'operation-failed' }),
      );
    }
  }
}
