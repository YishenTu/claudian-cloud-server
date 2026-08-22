import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  matchCollabCloudRoute,
  type CollabProjectId,
} from '@claudian/collab-protocol';

import {
  ProjectReadAuthorityError,
  type ProjectUploadPackAdvertisementOptions,
  type ProjectUploadPackOptions,
} from '../../project-authority/reads/ProjectReadAuthority.js';
import {
  DevelopmentPrincipalError,
  type DevelopmentPrincipalAdapter,
} from '../../request-context/DevelopmentPrincipalAdapter.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import { GitRepositoryError } from '../../repositories/GitRepositoryAuthority.js';

export interface GitUploadPackReadAuthority {
  advertiseUploadPack(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options?: ProjectUploadPackAdvertisementOptions,
  ): Promise<Buffer>;
  runUploadPack(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options: ProjectUploadPackOptions,
  ): Promise<void>;
}

export interface GitUploadPackRoutesOptions {
  readonly authority: GitUploadPackReadAuthority;
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly operationTimeoutMs: number;
  readonly principalAdapter: DevelopmentPrincipalAdapter;
}

class GitRouteFailure extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`git-upload-pack-route.failure.${String(status)}`);
    this.name = 'GitRouteFailure';
    this.status = status;
  }
}

function headerValues(request: IncomingMessage, expectedName: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLocaleLowerCase('en-US') === expectedName && value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

function optionalContentLength(request: IncomingMessage): number | undefined {
  const values = headerValues(request, 'content-length');
  if (values.length === 0) return undefined;
  const value = values[0];
  if (
    values.length !== 1
    || value === undefined
    || !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    throw new GitRouteFailure(400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new GitRouteFailure(400);
  return parsed;
}

function gitProtocol(
  request: IncomingMessage,
): 'version=1' | 'version=2' | undefined {
  const values = headerValues(request, 'git-protocol');
  if (values.length === 0) return undefined;
  if (
    values.length !== 1
    || (values[0] !== 'version=1' && values[0] !== 'version=2')
  ) {
    throw new GitRouteFailure(400);
  }
  return values[0];
}

function authorityStatus(error: ProjectReadAuthorityError): number {
  switch (error.code) {
    case 'authorization-denied':
    case 'project-not-found': return 404;
    case 'recovery-required':
    case 'state-conflict': return 409;
    case 'cancelled': return 408;
    case 'closed':
    case 'dependency-failed': return 503;
    case 'project-too-large': return 413;
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
    case 'output-limit': return 413;
    case 'placement-rejected':
    case 'placement-unavailable':
    case 'repository-corrupt':
    case 'repository-unavailable': return 409;
  }
}

async function readRequestBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const contentLength = optionalContentLength(request);
  if (contentLength !== undefined && contentLength > maximumBytes) {
    throw new GitRouteFailure(413);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const iterator = request[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await nextRequestChunk(iterator, signal);
      if (next.done) break;
      const raw = next.value;
      const chunk: unknown = raw;
      if (!Buffer.isBuffer(chunk)) throw new GitRouteFailure(400);
      bytes += chunk.length;
      if (bytes > maximumBytes) throw new GitRouteFailure(413);
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    if (error instanceof GitRouteFailure) throw error;
    throw new GitRouteFailure(signal.aborted ? 408 : 400);
  }
  if (contentLength !== undefined && contentLength !== bytes) {
    throw new GitRouteFailure(400);
  }
  return Buffer.concat(chunks);
}

async function nextRequestChunk(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) throw new GitRouteFailure(408);
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new GitRouteFailure(408));
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }),
    ]);
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

async function waitForDrain(
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) throw new GitRouteFailure(408);
  let abortListener: (() => void) | undefined;
  try {
    await Promise.race([
      once(response, 'drain').then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new GitRouteFailure(408));
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }),
    ]);
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

export class GitUploadPackRoutes {
  readonly #authority: GitUploadPackReadAuthority;
  readonly #maximumRequestBytes: number;
  readonly #maximumResponseBytes: number;
  readonly #operationTimeoutMs: number;
  readonly #principalAdapter: DevelopmentPrincipalAdapter;

  constructor(options: GitUploadPackRoutesOptions) {
    if (
      !Number.isSafeInteger(options.maximumRequestBytes)
      || options.maximumRequestBytes < 1
      || !Number.isSafeInteger(options.maximumResponseBytes)
      || options.maximumResponseBytes < 1
      || !Number.isSafeInteger(options.operationTimeoutMs)
      || options.operationTimeoutMs < 1
    ) {
      throw new TypeError('git-upload-pack-routes.options-invalid');
    }
    this.#authority = options.authority;
    this.#maximumRequestBytes = options.maximumRequestBytes;
    this.#maximumResponseBytes = options.maximumResponseBytes;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#principalAdapter = options.principalAdapter;
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    const uploadPack = match?.kind === 'git-upload-pack';
    const advertisement = match?.kind === 'git-info-refs'
      && match.service === 'git-upload-pack';
    if (!uploadPack && !advertisement) return false;
    void this.#handle(
      request,
      response,
      match.projectId,
      advertisement ? 'advertisement' : 'rpc',
    ).catch((error: unknown) => this.#sendFailure(response, error));
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
          throw new GitRouteFailure(403);
        }
        throw error;
      }
      const protocol = gitProtocol(request);
      if (operation === 'advertisement') {
        const advertised = await this.#authority.advertiseUploadPack(
          principal,
          projectId,
          {
            ...(protocol === undefined ? {} : { gitProtocol: protocol }),
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) throw new GitRouteFailure(408);
        const prefix = Buffer.from('001e# service=git-upload-pack\n0000', 'ascii');
        const body = Buffer.concat([prefix, advertised]);
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': body.length,
          'content-type': 'application/x-git-upload-pack-advertisement',
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
        || contentTypes[0] !== 'application/x-git-upload-pack-request'
      ) {
        throw new GitRouteFailure(415);
      }
      if (
        encodings.length > 1
        || (encodings[0] !== undefined && encodings[0] !== 'identity')
      ) {
        throw new GitRouteFailure(415);
      }
      const body = await readRequestBody(
        request,
        this.#maximumRequestBytes,
        controller.signal,
      );
      const startResponse = (): void => {
        if (response.headersSent) return;
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/x-git-upload-pack-result',
          expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
          pragma: 'no-cache',
        });
      };
      await this.#authority.runUploadPack(
        principal,
        projectId,
        {
          ...(protocol === undefined ? {} : { gitProtocol: protocol }),
          maximumResponseBytes: this.#maximumResponseBytes,
          onResponseChunk: async (chunk, supervisorSignal) => {
            const responseSignal = AbortSignal.any([
              controller.signal,
              supervisorSignal,
            ]);
            if (responseSignal.aborted || response.destroyed) {
              throw new GitRouteFailure(408);
            }
            startResponse();
            if (!response.write(chunk)) {
              await waitForDrain(response, responseSignal);
            }
          },
          request: body,
          signal: controller.signal,
        },
      );
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

  #sendFailure(response: ServerResponse, error: unknown): void {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof GitRouteFailure
      ? error.status
      : error instanceof ProjectReadAuthorityError
        ? authorityStatus(error)
        : error instanceof GitRepositoryError
          ? repositoryStatus(error)
          : 500;
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-length': 0,
    });
    response.end();
  }
}
