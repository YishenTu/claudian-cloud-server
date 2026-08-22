import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_LIMITS,
  CollabError,
  collabCloudErrorEnvelope,
  collabCloudSuccessEnvelope,
  decodeCollabProtocolEnvelope,
  isCollabOpaqueId,
  matchCollabCloudRoute,
  type CollabCloudProjectSnapshot,
  type CollabProjectId,
} from '@claudian/collab-protocol';

import {
  ProjectReadAuthorityError,
} from '../../project-authority/reads/ProjectReadAuthority.js';
import {
  DevelopmentPrincipalError,
  type DevelopmentPrincipalAdapter,
} from '../../request-context/DevelopmentPrincipalAdapter.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';

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

class RouteFailure extends Error {
  readonly error: CollabError;
  readonly status: number;

  constructor(status: number, error: CollabError) {
    super('project-snapshot-route.failure');
    this.name = 'RouteFailure';
    this.error = error;
    this.status = status;
  }
}

function protocolFailure(field: string): RouteFailure {
  return new RouteFailure(400, new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { field },
  }));
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
    throw protocolFailure('content-length');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw protocolFailure('content-length');
  return parsed;
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentTypes = headerValues(request, 'content-type');
  if (
    contentTypes.length !== 1
    || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentTypes[0] ?? '')
  ) {
    throw protocolFailure('content-type');
  }
  const encodings = headerValues(request, 'content-encoding');
  if (encodings.length > 1 || (encodings[0] !== undefined && encodings[0] !== 'identity')) {
    throw protocolFailure('content-encoding');
  }
  const contentLength = optionalContentLength(request);
  if (contentLength !== undefined && contentLength > maximumBytes) {
    throw new RouteFailure(413, new CollabError({
      code: 'quota-exceeded',
      safeContext: { limit: maximumBytes, quota: 'json-payload' },
    }));
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
      if (!Buffer.isBuffer(chunk)) throw protocolFailure('body');
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        throw new RouteFailure(413, new CollabError({
          code: 'quota-exceeded',
          safeContext: { limit: maximumBytes, quota: 'json-payload' },
        }));
      }
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    if (error instanceof RouteFailure) throw error;
    throw protocolFailure('body');
  }
  if (contentLength !== undefined && contentLength !== bytes) {
    throw protocolFailure('content-length');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw protocolFailure('body');
  }
}

async function nextRequestChunk(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) {
    throw new RouteFailure(503, new CollabError({ code: 'operation-failed' }));
  }
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new RouteFailure(
          503,
          new CollabError({ code: 'operation-failed', recoveryActions: ['retry'] }),
        ));
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

function authorityFailure(error: ProjectReadAuthorityError): RouteFailure {
  switch (error.code) {
    case 'authorization-denied':
    case 'project-not-found':
      return new RouteFailure(404, new CollabError({ code: 'project-not-found' }));
    case 'project-too-large':
      return new RouteFailure(413, new CollabError({
        code: 'quota-exceeded',
        safeContext: { quota: 'project-snapshot' },
      }));
    case 'recovery-required':
    case 'state-conflict':
      return new RouteFailure(409, new CollabError({
        code: 'authority-not-synchronized',
        recoveryActions: ['retry'],
      }));
    case 'cancelled':
    case 'closed':
    case 'dependency-failed':
      return new RouteFailure(503, new CollabError({
        code: 'operation-failed',
        recoveryActions: ['retry'],
      }));
  }
}

export class ProjectSnapshotRoutes {
  readonly #authority: ProjectSnapshotHandler;
  readonly #maximumJsonBytes: number;
  readonly #operationTimeoutMs: number;
  readonly #principalAdapter: DevelopmentPrincipalAdapter;
  readonly #requestIdFactory: () => string;

  constructor(options: ProjectSnapshotRoutesOptions) {
    if (
      !Number.isSafeInteger(options.maximumJsonBytes)
      || options.maximumJsonBytes < 1
      || options.maximumJsonBytes > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes
      || !Number.isSafeInteger(options.operationTimeoutMs)
      || options.operationTimeoutMs < 1
    ) {
      throw new TypeError('project-snapshot-routes.options-invalid');
    }
    this.#authority = options.authority;
    this.#maximumJsonBytes = options.maximumJsonBytes;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#principalAdapter = options.principalAdapter;
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    if (
      match?.kind !== 'project-operation'
      || match.operation !== 'getProjectSnapshot'
    ) {
      return false;
    }
    void this.#handle(request, response, match.projectId)
      .catch((error: unknown) => this.#sendFailure(response, error));
    return true;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    pathProjectId: string,
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
    let requestId = this.#newRequestId();
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
          throw new RouteFailure(403, new CollabError({
            code: 'authentication-failed',
          }));
        }
        throw error;
      }
      const body = await readJsonBody(request, this.#maximumJsonBytes, controller.signal);
      const envelope = decodeCollabProtocolEnvelope(body);
      if (envelope.status !== 'ok') {
        throw new RouteFailure(400, envelope.error);
      }
      if (!isCollabOpaqueId(envelope.value.requestId)) {
        throw protocolFailure('requestId');
      }
      requestId = envelope.value.requestId;
      const decoded = COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC
        .decodeRequest(envelope.value.data);
      if (decoded.status !== 'ok') {
        throw new RouteFailure(400, decoded.error);
      }
      if (decoded.value.projectId !== pathProjectId) {
        throw protocolFailure('projectId');
      }
      const result = await this.#authority.getProjectSnapshot(
        principal,
        decoded.value.projectId,
        { signal: controller.signal },
      );
      let validated: CollabCloudProjectSnapshot;
      try {
        validated = COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeResponse(result);
      } catch {
        throw new RouteFailure(500, new CollabError({ code: 'operation-failed' }));
      }
      this.#sendJson(
        response,
        200,
        collabCloudSuccessEnvelope(requestId, validated),
      );
    } catch (error: unknown) {
      const failure = error instanceof RouteFailure
        ? error
        : error instanceof ProjectReadAuthorityError
          ? authorityFailure(error)
          : new RouteFailure(500, new CollabError({ code: 'operation-failed' }));
      this.#sendJson(
        response,
        failure.status,
        collabCloudErrorEnvelope(requestId, failure.error),
      );
    } finally {
      clearTimeout(timeout);
      if (controller.signal.aborted && !request.complete) request.destroy();
      request.off('aborted', abort);
      request.off('error', abort);
      response.off('close', onResponseClose);
    }
  }

  #newRequestId(): string {
    const requestId = this.#requestIdFactory();
    return isCollabOpaqueId(requestId) ? requestId : 'server-request-error';
  }

  #sendFailure(response: ServerResponse, _error: unknown): void {
    if (response.headersSent || response.destroyed) return;
    this.#sendJson(
      response,
      500,
      collabCloudErrorEnvelope(
        this.#newRequestId(),
        new CollabError({ code: 'operation-failed' }),
      ),
    );
  }

  #sendJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent || response.destroyed) return;
    const encoded = JSON.stringify(value);
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(encoded),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(encoded);
  }
}
