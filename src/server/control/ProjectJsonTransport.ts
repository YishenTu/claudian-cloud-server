import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  COLLAB_LIMITS,
  CollabError,
  collabCloudErrorEnvelope,
  collabCloudSuccessEnvelope,
  decodeCollabProtocolEnvelope,
  isCollabOpaqueId,
} from '@claudian-collab/protocol';

import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import {
  RequestPrincipalBinding,
  RequestPrincipalBindingError,
  type RequestPrincipalBindingOptions,
  type TrustedProjectPrincipalBinding,
} from '../../request-context/RequestPrincipalBinding.js';
import {
  parseOptionalContentLength,
  requestHeaderValues,
} from '../httpRequestHeaders.js';

export type { TrustedProjectPrincipalBinding };

export interface ProjectJsonTransportOptions
  extends RequestPrincipalBindingOptions {
  readonly maximumJsonBytes: number;
  readonly operationTimeoutMs: number;
  readonly requestIdFactory?: () => string;
}

export interface ProjectJsonRequestContext {
  readonly data: unknown;
  readonly principal: IngressPrincipal;
  readonly signal: AbortSignal;
}

export class ProjectJsonRouteFailure extends Error {
  readonly error: CollabError;
  readonly status: number;

  constructor(status: number, error: CollabError) {
    super('project-json-route.failure');
    this.name = 'ProjectJsonRouteFailure';
    this.error = error;
    this.status = status;
  }
}

export function projectProtocolFailure(field: string): ProjectJsonRouteFailure {
  return new ProjectJsonRouteFailure(400, new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { field },
  }));
}

function optionalContentLength(request: IncomingMessage): number | undefined {
  return parseOptionalContentLength(
    request,
    () => projectProtocolFailure('content-length'),
  );
}

async function nextRequestChunk(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) {
    throw new ProjectJsonRouteFailure(
      503,
      new CollabError({ code: 'operation-failed', recoveryActions: ['retry'] }),
    );
  }
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new ProjectJsonRouteFailure(
          503,
          new CollabError({ code: 'operation-failed', recoveryActions: ['retry'] }),
        ));
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }),
    ]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

async function settleOperationBeforeAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const timeoutFailure = (): ProjectJsonRouteFailure => new ProjectJsonRouteFailure(
    408,
    new CollabError({ code: 'operation-timeout', recoveryActions: ['retry'] }),
  );
  if (signal.aborted) throw timeoutFailure();
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(timeoutFailure());
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }),
    ]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentTypes = requestHeaderValues(request, 'content-type');
  if (
    contentTypes.length !== 1
    || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentTypes[0] ?? '')
  ) {
    throw projectProtocolFailure('content-type');
  }
  const encodings = requestHeaderValues(request, 'content-encoding');
  if (encodings.length > 1 || (encodings[0] !== undefined && encodings[0] !== 'identity')) {
    throw projectProtocolFailure('content-encoding');
  }
  const contentLength = optionalContentLength(request);
  if (contentLength !== undefined && contentLength > maximumBytes) {
    throw new ProjectJsonRouteFailure(413, new CollabError({
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
      const raw: unknown = next.value;
      if (!Buffer.isBuffer(raw)) throw projectProtocolFailure('body');
      bytes += raw.length;
      if (bytes > maximumBytes) {
        throw new ProjectJsonRouteFailure(413, new CollabError({
          code: 'quota-exceeded',
          safeContext: { limit: maximumBytes, quota: 'json-payload' },
        }));
      }
      chunks.push(raw);
    }
  } catch (error: unknown) {
    if (error instanceof ProjectJsonRouteFailure) throw error;
    throw projectProtocolFailure('body');
  }
  if (contentLength !== undefined && contentLength !== bytes) {
    throw projectProtocolFailure('content-length');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw projectProtocolFailure('body');
  }
}

function statusForCollabError(error: CollabError): number {
  switch (error.code) {
    case 'authentication-failed':
    case 'authorization-denied': return 403;
    case 'project-not-found':
    case 'ticket-not-found': return 404;
    case 'membership-revoked': return 410;
    case 'membership-claim-expired':
    case 'membership-claim-revoked':
    case 'project-retired': return 410;
    case 'authority-transfer-not-found': return 404;
    case 'operation-timeout': return 408;
    case 'authority-transfer-cancellation-forbidden':
    case 'authority-transfer-stale':
    case 'authority-not-synchronized':
    case 'idempotency-conflict':
    case 'membership-claim-already-redeemed':
    case 'personal-ref-diverged':
    case 'request-head-not-pushed':
    case 'request-not-open':
    case 'stale-main':
    case 'stale-request-head':
    case 'stale-request-metadata':
    case 'stale-ticket': return 409;
    case 'quota-exceeded': return 413;
    case 'protocol-payload-invalid':
    case 'protocol-version-unsupported': return 400;
    case 'membership-claim-invalid': return 403;
    default: return 500;
  }
}

export class ProjectJsonTransport {
  readonly #maximumJsonBytes: number;
  readonly #operationTimeoutMs: number;
  readonly #principalBinding: RequestPrincipalBinding;
  readonly #requestIdFactory: () => string;

  constructor(options: ProjectJsonTransportOptions) {
    if (
      !Number.isSafeInteger(options.maximumJsonBytes)
      || options.maximumJsonBytes < 1
      || options.maximumJsonBytes > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes
      || !Number.isSafeInteger(options.operationTimeoutMs)
      || options.operationTimeoutMs < 1
    ) {
      throw new TypeError('project-json-transport.options-invalid');
    }
    this.#maximumJsonBytes = options.maximumJsonBytes;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#principalBinding = new RequestPrincipalBinding(options);
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    operation: (context: ProjectJsonRequestContext) => Promise<unknown>,
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
        principal = this.#principalBinding.bind(request);
      } catch (error: unknown) {
        if (error instanceof RequestPrincipalBindingError) {
          throw new ProjectJsonRouteFailure(
            403,
            new CollabError({ code: 'authentication-failed' }),
          );
        }
        throw error;
      }
      const body = await readJsonBody(
        request,
        this.#maximumJsonBytes,
        controller.signal,
      );
      const envelope = decodeCollabProtocolEnvelope(body);
      if (envelope.status !== 'ok') {
        throw new ProjectJsonRouteFailure(400, envelope.error);
      }
      if (!isCollabOpaqueId(envelope.value.requestId)) {
        throw projectProtocolFailure('requestId');
      }
      requestId = envelope.value.requestId;
      const data = await settleOperationBeforeAbort(operation({
        data: envelope.value.data,
        principal,
        signal: controller.signal,
      }), controller.signal);
      this.#sendJson(response, 200, collabCloudSuccessEnvelope(requestId, data));
    } catch (error: unknown) {
      const failure = error instanceof ProjectJsonRouteFailure
        ? error
        : error instanceof CollabError
          ? new ProjectJsonRouteFailure(statusForCollabError(error), error)
          : new ProjectJsonRouteFailure(
            500,
            new CollabError({ code: 'operation-failed' }),
          );
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

  sendUnexpected(response: ServerResponse): void {
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

  #newRequestId(): string {
    const requestId = this.#requestIdFactory();
    return isCollabOpaqueId(requestId) ? requestId : 'server-request-error';
  }

  #sendJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent || response.destroyed) return;
    let encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) {
      encoded = JSON.stringify(collabCloudErrorEnvelope(
        this.#newRequestId(),
        new CollabError({ code: 'operation-failed' }),
      ));
      status = 500;
    }
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(encoded),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(encoded);
  }
}
