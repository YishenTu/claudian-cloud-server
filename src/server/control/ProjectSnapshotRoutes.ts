import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  CollabError,
  matchCollabCloudRoute,
  type CollabCloudProjectSnapshot,
  type CollabProjectId,
} from '@claudian/collab-protocol';

import {
  ProjectReadAuthorityError,
} from '../../project-authority/reads/ProjectReadAuthority.js';
import type { DevelopmentPrincipalAdapter } from '../../request-context/DevelopmentPrincipalAdapter.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import {
  ProjectJsonRouteFailure,
  ProjectJsonTransport,
  projectProtocolFailure,
} from './ProjectJsonTransport.js';

export interface ProjectSnapshotHandler {
  getProjectSnapshot(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<CollabCloudProjectSnapshot>;
}

export interface ProjectSnapshotRoutesOptions {
  readonly authority: ProjectSnapshotHandler;
  readonly maximumJsonBytes: number;
  readonly operationTimeoutMs: number;
  readonly principalAdapter: DevelopmentPrincipalAdapter;
  readonly requestIdFactory?: () => string;
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
  readonly #transport: ProjectJsonTransport;

  constructor(options: ProjectSnapshotRoutesOptions) {
    this.#authority = options.authority;
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
        if (error instanceof ProjectReadAuthorityError) throw authorityFailure(error);
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
