import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  matchCollabCloudRoute,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import { ProjectWriteAdmissionError } from '../../project-authority/admission/ProjectWriteAdmission.js';
import {
  DevelopmentPrincipalError,
  type DevelopmentPrincipalAdapter,
} from '../../request-context/DevelopmentPrincipalAdapter.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import { GitRepositoryError } from '../../repositories/GitRepositoryAuthority.js';
import {
  GitSmartHttpRouteFailure,
  gitProtocol,
  headerValues,
  nextRequestChunk,
  optionalContentLength,
  waitForDrain,
} from './GitSmartHttpTransport.js';

export interface ProjectReceivePackAdvertisementOptions {
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly signal?: AbortSignal;
}

export interface ProjectReceivePackOptions {
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly onResponseChunk: (
    chunk: Buffer,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly request: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface GitReceivePackWriteAuthority {
  advertiseReceivePack(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options?: ProjectReceivePackAdvertisementOptions,
  ): Promise<Buffer>;
  runReceivePack(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options: ProjectReceivePackOptions,
  ): Promise<void>;
}

export interface GitReceivePackRoutesOptions {
  readonly authority: GitReceivePackWriteAuthority;
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly operationTimeoutMs: number;
  readonly principalAdapter: DevelopmentPrincipalAdapter;
}

async function* boundedRequestBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const contentLength = optionalContentLength(request);
  if (contentLength !== undefined && contentLength > maximumBytes) {
    throw new GitSmartHttpRouteFailure(413);
  }
  let bytes = 0;
  const iterator = request[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await nextRequestChunk(iterator, signal);
      if (next.done) break;
      const raw = next.value;
      if (!Buffer.isBuffer(raw)) throw new GitSmartHttpRouteFailure(400);
      bytes += raw.length;
      if (bytes > maximumBytes) throw new GitSmartHttpRouteFailure(413);
      yield raw;
    }
  } catch (error: unknown) {
    if (error instanceof GitSmartHttpRouteFailure) throw error;
    throw new GitSmartHttpRouteFailure(signal.aborted ? 408 : 400);
  }
  if (contentLength !== undefined && contentLength !== bytes) {
    throw new GitSmartHttpRouteFailure(400);
  }
}

function admissionStatus(error: ProjectWriteAdmissionError): number {
  switch (error.code) {
    case 'authorization-denied': return 404;
    case 'cancelled': return 408;
    case 'recovery-required':
    case 'state-conflict': return 409;
    case 'closed':
    case 'dependency-failed': return 503;
  }
}

function repositoryStatus(error: GitRepositoryError): number {
  switch (error.code) {
    case 'busy': return 503;
    case 'cancelled':
    case 'timeout': return 408;
    case 'closed':
    case 'git-unavailable':
    case 'process-failed':
    case 'unsupported-git': return 503;
    case 'input-limit':
    case 'output-limit': return 413;
    case 'placement-rejected':
    case 'placement-unavailable':
    case 'repository-corrupt':
    case 'repository-unavailable': return 409;
    case 'storage-unavailable': return 503;
  }
}

export class GitReceivePackRoutes {
  readonly #authority: GitReceivePackWriteAuthority;
  readonly #maximumRequestBytes: number;
  readonly #maximumResponseBytes: number;
  readonly #operationTimeoutMs: number;
  readonly #principalAdapter: DevelopmentPrincipalAdapter;

  constructor(options: GitReceivePackRoutesOptions) {
    if (
      !Number.isSafeInteger(options.maximumRequestBytes)
      || options.maximumRequestBytes < 1
      || !Number.isSafeInteger(options.maximumResponseBytes)
      || options.maximumResponseBytes < 1
      || !Number.isSafeInteger(options.operationTimeoutMs)
      || options.operationTimeoutMs < 1
    ) {
      throw new TypeError('git-receive-pack-routes.options-invalid');
    }
    this.#authority = options.authority;
    this.#maximumRequestBytes = options.maximumRequestBytes;
    this.#maximumResponseBytes = options.maximumResponseBytes;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#principalAdapter = options.principalAdapter;
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    const receivePack = match?.kind === 'git-receive-pack';
    const advertisement = match?.kind === 'git-info-refs'
      && match.service === 'git-receive-pack';
    if (!receivePack && !advertisement) return false;
    void this.#handle(
      request,
      response,
      match.projectId,
      advertisement ? 'advertisement' : 'rpc',
    ).catch((error: unknown) => this.#sendFailure(request, response, error));
    return true;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    projectId: CollabProjectId,
    operation: 'advertisement' | 'rpc',
  ): Promise<void> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const onResponseClose = (): void => {
      if (!response.writableEnded) abort();
    };
    request.once('aborted', abort);
    request.once('error', abort);
    response.once('close', onResponseClose);
    const timeout = setTimeout(abort, this.#operationTimeoutMs);
    timeout.unref();
    try {
      let principal: IngressPrincipal;
      try {
        principal = this.#principalAdapter.bind({
          headerValues: headerValues(request, 'x-claudian-development-actor'),
          localAddress: request.socket.localAddress,
          remoteAddress: request.socket.remoteAddress,
        });
      } catch (error: unknown) {
        if (error instanceof DevelopmentPrincipalError) {
          throw new GitSmartHttpRouteFailure(403);
        }
        throw error;
      }
      const protocol = gitProtocol(request);
      if (operation === 'advertisement') {
        const advertised = await this.#authority.advertiseReceivePack(
          principal,
          projectId,
          {
            ...(protocol === undefined ? {} : { gitProtocol: protocol }),
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) throw new GitSmartHttpRouteFailure(408);
        const prefix = Buffer.from('001f# service=git-receive-pack\n0000', 'ascii');
        const body = Buffer.concat([prefix, advertised]);
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': body.length,
          'content-type': 'application/x-git-receive-pack-advertisement',
          expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
          pragma: 'no-cache',
        });
        response.end(body);
        return;
      }

      const contentTypes = headerValues(request, 'content-type');
      const encodings = headerValues(request, 'content-encoding');
      if (
        contentTypes.length !== 1
        || contentTypes[0] !== 'application/x-git-receive-pack-request'
      ) {
        throw new GitSmartHttpRouteFailure(415);
      }
      if (
        encodings.length > 1
        || (encodings[0] !== undefined && encodings[0] !== 'identity')
      ) {
        throw new GitSmartHttpRouteFailure(415);
      }
      const declaredLength = optionalContentLength(request);
      if (declaredLength !== undefined && declaredLength > this.#maximumRequestBytes) {
        throw new GitSmartHttpRouteFailure(413);
      }
      let responseBytes = 0;
      const startResponse = (): void => {
        if (response.headersSent) return;
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/x-git-receive-pack-result',
          expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
          pragma: 'no-cache',
        });
      };
      await this.#authority.runReceivePack(principal, projectId, {
        ...(protocol === undefined ? {} : { gitProtocol: protocol }),
        maximumRequestBytes: this.#maximumRequestBytes,
        maximumResponseBytes: this.#maximumResponseBytes,
        onResponseChunk: async (chunk, supervisorSignal) => {
          const responseSignal = AbortSignal.any([
            controller.signal,
            supervisorSignal,
          ]);
          if (responseSignal.aborted || response.destroyed) {
            throw new GitSmartHttpRouteFailure(408);
          }
          responseBytes += chunk.length;
          if (responseBytes > this.#maximumResponseBytes) {
            throw new GitSmartHttpRouteFailure(413);
          }
          startResponse();
          if (!response.write(chunk)) await waitForDrain(response, responseSignal);
        },
        request: boundedRequestBody(
          request,
          this.#maximumRequestBytes,
          controller.signal,
        ),
        signal: controller.signal,
      });
      startResponse();
      response.end();
    } finally {
      clearTimeout(timeout);
      if (controller.signal.aborted && !request.complete) request.destroy();
      request.off('aborted', abort);
      request.off('error', abort);
      response.off('close', onResponseClose);
    }
  }

  #sendFailure(
    request: IncomingMessage,
    response: ServerResponse,
    error: unknown,
  ): void {
    if (response.destroyed) {
      if (!request.complete) request.destroy();
      return;
    }
    if (response.headersSent) {
      response.destroy();
      if (!request.complete) request.destroy();
      return;
    }
    const status = error instanceof GitSmartHttpRouteFailure
      ? error.status
      : error instanceof ProjectWriteAdmissionError
        ? admissionStatus(error)
        : error instanceof GitRepositoryError
          ? repositoryStatus(error)
          : 500;
    response.writeHead(status, {
      'cache-control': 'no-store',
      ...(!request.complete ? { connection: 'close' } : {}),
      'content-length': 0,
    });
    if (!request.complete) {
      response.once('finish', () => request.destroy());
    }
    response.end();
  }
}
