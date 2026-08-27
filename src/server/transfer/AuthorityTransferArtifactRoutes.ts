import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  COLLAB_PROJECT_CHECKPOINT_ARTIFACTS,
  CollabError,
  collabCloudErrorEnvelope,
  matchCollabCloudRoute,
  type CollabCloudAuthorityTransferArtifact,
} from '@claudian-collab/protocol';

import {
  DevelopmentPrincipalError,
  type DevelopmentPrincipalAdapter,
} from '../../request-context/DevelopmentPrincipalAdapter.js';

export interface AuthorityTransferArtifactUpload {
  readonly artifact: CollabCloudAuthorityTransferArtifact;
  readonly body: Readable;
  readonly principalId: string;
  readonly projectId: string;
  readonly signal: AbortSignal;
  readonly transferId: string;
}

export interface AuthorityTransferArtifactDownload {
  readonly body: Readable;
  readonly byteCount: number;
}

export interface AuthorityTransferArtifactAuthority {
  download(input: Readonly<{
    readonly artifact: CollabCloudAuthorityTransferArtifact;
    readonly principalId: string;
    readonly projectId: string;
    readonly signal: AbortSignal;
    readonly transferId: string;
  }>): Promise<AuthorityTransferArtifactDownload>;
  upload(input: AuthorityTransferArtifactUpload): Promise<void>;
}

export interface AuthorityTransferArtifactRoutesOptions {
  readonly authority: AuthorityTransferArtifactAuthority;
  readonly limits: Readonly<Record<CollabCloudAuthorityTransferArtifact, number>>;
  readonly operationTimeoutMs: number;
  readonly principalAdapter: DevelopmentPrincipalAdapter;
  readonly requestIdFactory?: () => string;
}

class ArtifactRouteFailure extends Error {
  readonly error: CollabError;
  readonly status: number;

  constructor(status: number, error: CollabError) {
    super('authority-transfer-artifact-route.failure');
    this.name = 'ArtifactRouteFailure';
    this.error = error;
    this.status = status;
  }
}

function protocolFailure(field: string): ArtifactRouteFailure {
  return new ArtifactRouteFailure(400, new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { field },
  }));
}

function quotaFailure(limit: number): ArtifactRouteFailure {
  return new ArtifactRouteFailure(413, new CollabError({
    code: 'quota-exceeded',
    safeContext: { limit, quota: 'checkpoint-artifact' },
  }));
}

function headerValues(request: IncomingMessage, expectedName: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLowerCase() === expectedName && value !== undefined) values.push(value);
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
  ) throw protocolFailure('content-length');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw protocolFailure('content-length');
  return parsed;
}

function statusForError(error: CollabError): number {
  switch (error.code) {
    case 'authentication-failed':
    case 'authorization-denied':
    case 'membership-claim-invalid': return 403;
    case 'authority-transfer-not-found':
    case 'project-not-found': return 404;
    case 'membership-claim-expired':
    case 'membership-claim-revoked':
    case 'project-retired': return 410;
    case 'authority-transfer-cancellation-forbidden':
    case 'authority-transfer-stale':
    case 'authority-not-synchronized':
    case 'idempotency-conflict':
    case 'membership-claim-already-redeemed': return 409;
    case 'operation-timeout': return 408;
    case 'quota-exceeded': return 413;
    case 'protocol-payload-invalid':
    case 'protocol-version-unsupported': return 400;
    default: return 500;
  }
}

function boundedMeter(
  maximumBytes: number,
  expectedBytes?: number,
): Transform {
  let bytes = 0;
  return new Transform({
    flush(callback) {
      if (expectedBytes !== undefined && bytes !== expectedBytes) {
        callback(protocolFailure('content-length'));
        return;
      }
      callback();
    },
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        callback(quotaFailure(maximumBytes));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function settleOperationBeforeAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLateResult: (result: T) => void,
): Promise<T> {
  const timeoutFailure = (): ArtifactRouteFailure => new ArtifactRouteFailure(
    408,
    new CollabError({ code: 'operation-timeout', recoveryActions: ['retry'] }),
  );
  const disposeWhenSettled = (): void => {
    void operation.then(result => {
      try {
        disposeLateResult(result);
      } catch {
        // Disposal is best-effort and must not expose owner details.
      }
    }, () => undefined);
  };
  if (signal.aborted) {
    disposeWhenSettled();
    throw timeoutFailure();
  }
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abortListener = () => {
          reject(timeoutFailure());
        };
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }),
    ]);
  } catch (error: unknown) {
    disposeWhenSettled();
    throw error;
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

export class AuthorityTransferArtifactRoutes {
  readonly #authority: AuthorityTransferArtifactAuthority;
  readonly #limits: AuthorityTransferArtifactRoutesOptions['limits'];
  readonly #operationTimeoutMs: number;
  readonly #principalAdapter: DevelopmentPrincipalAdapter;
  readonly #requestIdFactory: () => string;

  constructor(options: AuthorityTransferArtifactRoutesOptions) {
    if (
      !Number.isSafeInteger(options.operationTimeoutMs)
      || options.operationTimeoutMs < 1
      || COLLAB_PROJECT_CHECKPOINT_ARTIFACTS.some(artifact => (
        !Number.isSafeInteger(options.limits[artifact])
        || options.limits[artifact] < 1
      ))
    ) throw new TypeError('authority-transfer-artifact-routes.options-invalid');
    this.#authority = options.authority;
    this.#limits = Object.freeze({ ...options.limits });
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#principalAdapter = options.principalAdapter;
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    if (match?.kind !== 'authority-transfer-artifact') return false;
    void this.#handle(request, response, match).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        this.#sendFailure(response, new ArtifactRouteFailure(
          500,
          new CollabError({ code: 'operation-failed' }),
        ));
      } else if (!response.destroyed) response.destroy();
    });
    return true;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    match: Extract<
      NonNullable<ReturnType<typeof matchCollabCloudRoute>>,
      { readonly kind: 'authority-transfer-artifact' }
    >,
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
      let principalId: string;
      try {
        principalId = this.#principalAdapter.bind({
          headerValues: headerValues(request, 'x-claudian-development-actor'),
          localAddress: request.socket.localAddress,
          remoteAddress: request.socket.remoteAddress,
        }).actorId;
      } catch (error: unknown) {
        if (error instanceof DevelopmentPrincipalError) {
          throw new ArtifactRouteFailure(
            403,
            new CollabError({ code: 'authentication-failed' }),
          );
        }
        throw error;
      }
      if (match.direction === 'upload') {
        await this.#upload(request, match, principalId, controller.signal);
        response.writeHead(204, {
          'cache-control': 'no-store',
          'content-length': '0',
        });
        response.end();
      } else {
        await this.#download(response, match, principalId, controller.signal);
      }
    } catch (error: unknown) {
      const failure = error instanceof ArtifactRouteFailure
        ? error
        : error instanceof CollabError
          ? new ArtifactRouteFailure(statusForError(error), error)
          : controller.signal.aborted
            ? new ArtifactRouteFailure(408, new CollabError({
              code: 'operation-timeout',
              recoveryActions: ['retry'],
            }))
            : new ArtifactRouteFailure(
              500,
              new CollabError({ code: 'operation-failed' }),
            );
      if (!request.complete) response.shouldKeepAlive = false;
      if (!response.headersSent) this.#sendFailure(response, failure);
      else if (!response.destroyed) response.destroy();
    } finally {
      clearTimeout(timeout);
      if (controller.signal.aborted && !request.complete) request.destroy();
      request.off('aborted', abort);
      request.off('error', abort);
      response.off('close', onResponseClose);
    }
  }

  async #upload(
    request: IncomingMessage,
    match: Readonly<{
      readonly artifact: CollabCloudAuthorityTransferArtifact;
      readonly projectId: string;
      readonly transferId: string;
    }>,
    principalId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const contentTypes = headerValues(request, 'content-type');
    if (contentTypes.length !== 1 || contentTypes[0] !== 'application/octet-stream') {
      throw protocolFailure('content-type');
    }
    const encodings = headerValues(request, 'content-encoding');
    if (encodings.length > 1 || (encodings[0] !== undefined && encodings[0] !== 'identity')) {
      throw protocolFailure('content-encoding');
    }
    const maximumBytes = this.#limits[match.artifact];
    const contentLength = optionalContentLength(request);
    if (contentLength !== undefined && contentLength > maximumBytes) {
      throw quotaFailure(maximumBytes);
    }
    const body = boundedMeter(maximumBytes, contentLength);
    const streaming = pipeline(request, body, { signal });
    try {
      await Promise.all([
        streaming,
        this.#authority.upload({
          artifact: match.artifact,
          body,
          principalId,
          projectId: match.projectId,
          signal,
          transferId: match.transferId,
        }),
      ]);
    } catch (error: unknown) {
      body.destroy();
      throw error;
    }
  }

  async #download(
    response: ServerResponse,
    match: Readonly<{
      readonly artifact: CollabCloudAuthorityTransferArtifact;
      readonly projectId: string;
      readonly transferId: string;
    }>,
    principalId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await settleOperationBeforeAbort(this.#authority.download({
      artifact: match.artifact,
      principalId,
      projectId: match.projectId,
      signal,
      transferId: match.transferId,
    }), signal, late => late.body.destroy());
    const maximumBytes = this.#limits[match.artifact];
    if (
      !(result.body instanceof Readable)
    ) throw new CollabError({ code: 'operation-failed' });
    if (
      !Number.isSafeInteger(result.byteCount)
      || result.byteCount < 1
      || result.byteCount > maximumBytes
    ) {
      result.body.destroy();
      throw new CollabError({ code: 'operation-failed' });
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': String(result.byteCount),
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    await pipeline(
      result.body,
      boundedMeter(maximumBytes, result.byteCount),
      response,
      { signal },
    );
  }

  #sendFailure(response: ServerResponse, failure: ArtifactRouteFailure): void {
    const encoded = JSON.stringify(collabCloudErrorEnvelope(
      this.#requestIdFactory(),
      failure.error,
    ));
    response.writeHead(failure.status, {
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(encoded)),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(encoded);
  }
}
