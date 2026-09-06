import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  CollabError,
  matchCollabCloudRoute,
  type CollabCloudProjectSnapshot,
  type CollabProjectId,
  type CollabProjectRetirementResult,
} from '@claudian-collab/protocol';

import {
  ProjectReadAuthorityError,
} from '../../project-authority/reads/ProjectReadAuthority.js';
import type { RequestPrincipal } from '../../request-context/RequestPrincipal.js';
import {
  ProjectJsonRouteFailure,
  ProjectJsonTransport,
  projectProtocolFailure,
  type ProjectJsonTransportOptions,
} from './ProjectJsonTransport.js';

export interface ProjectSnapshotHandler {
  getProjectSnapshot(
    principal: RequestPrincipal,
    projectId: CollabProjectId,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<CollabCloudProjectSnapshot>;
}

export interface ProjectRetirementTerminalHandler {
  getRetirementTerminal(
    principalId: string,
    projectId: string,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<CollabProjectRetirementResult | null>;
}

export interface ProjectSnapshotRoutesOptions
  extends ProjectJsonTransportOptions {
  readonly authority: ProjectSnapshotHandler;
  readonly retirementTerminal?: ProjectRetirementTerminalHandler;
}

function authorityFailure(error: ProjectReadAuthorityError): ProjectJsonRouteFailure {
  switch (error.code) {
    case 'authorization-denied':
    case 'project-not-found':
      return new ProjectJsonRouteFailure(
        404,
        new CollabError({ code: 'project-not-found' }),
      );
    case 'project-too-large':
      return new ProjectJsonRouteFailure(413, new CollabError({
        code: 'quota-exceeded',
        safeContext: { quota: 'project-snapshot' },
      }));
    case 'recovery-required':
    case 'state-conflict':
      return new ProjectJsonRouteFailure(409, new CollabError({
        code: 'authority-not-synchronized',
        recoveryActions: ['retry'],
      }));
    case 'cancelled':
    case 'closed':
    case 'dependency-failed':
      return new ProjectJsonRouteFailure(503, new CollabError({
        code: 'operation-failed',
        recoveryActions: ['retry'],
      }));
  }
}

export class ProjectSnapshotRoutes {
  readonly #authority: ProjectSnapshotHandler;
  readonly #retirementTerminal: ProjectRetirementTerminalHandler | undefined;
  readonly #transport: ProjectJsonTransport;

  constructor(options: ProjectSnapshotRoutesOptions) {
    this.#authority = options.authority;
    this.#retirementTerminal = options.retirementTerminal;
    this.#transport = new ProjectJsonTransport(options);
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    if (
      match?.kind !== 'project-operation'
      || match.operation !== 'getProjectSnapshot'
    ) {
      return false;
    }
    void this.#transport.handle(request, response, async context => {
      const decoded = COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeRequest(context.data);
      if (decoded.status !== 'ok') {
        throw new ProjectJsonRouteFailure(400, decoded.error);
      }
      if (decoded.value.projectId !== match.projectId) {
        throw projectProtocolFailure('projectId');
      }
      try {
        const result = await this.#authority.getProjectSnapshot(
          context.principal,
          decoded.value.projectId,
          { signal: context.signal },
        );
        return COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeResponse(result);
      } catch (error: unknown) {
        if (error instanceof ProjectReadAuthorityError) {
          if (
            this.#retirementTerminal !== undefined
            && (
              error.code === 'authorization-denied'
              || error.code === 'project-not-found'
              || error.code === 'recovery-required'
            )
          ) {
            let terminal: CollabProjectRetirementResult | null;
            try {
              terminal = await this.#retirementTerminal.getRetirementTerminal(
                context.principal.principalId,
                decoded.value.projectId,
                { signal: context.signal },
              );
            } catch {
              throw new ProjectJsonRouteFailure(503, new CollabError({
                code: 'operation-failed',
                recoveryActions: ['retry'],
              }));
            }
            if (terminal !== null) {
              throw new ProjectJsonRouteFailure(410, new CollabError({
                code: 'project-retired',
                safeContext: {
                  operationId: terminal.retirementId,
                  projectId: terminal.projectId,
                  retiredAt: terminal.retiredAt,
                },
              }));
            }
          }
          throw authorityFailure(error);
        }
        if (error instanceof ProjectJsonRouteFailure) throw error;
        throw new ProjectJsonRouteFailure(
          500,
          new CollabError({ code: 'operation-failed' }),
        );
      }
    }).catch(() => this.#transport.sendUnexpected(response));
    return true;
  }
}
