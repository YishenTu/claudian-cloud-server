import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  COLLAB_LIMITS,
  CollabError,
  collabCloudErrorEnvelope,
  collabCloudSuccessEnvelope,
  decodeCollabProtocolEnvelope,
  developmentBootstrapOperationCodec,
  isCollabOpaqueId,
  matchCollabCloudRoute,
  type ActivateDevelopmentBootstrapRequest,
  type BeginDevelopmentBootstrapRequest,
  type CancelDevelopmentBootstrapRequest,
  type DevelopmentBootstrapAttemptStatus,
  type DevelopmentBootstrapOperation,
  type GetDevelopmentBootstrapRequest,
  type SubmitDevelopmentBootstrapReportRequest,
} from '@claudian-collab/protocol';

import {
  DevelopmentBootstrapProfileError,
  type PutDevelopmentBootstrapGitBundleInput,
} from '../onboarding/development/DevelopmentBootstrapProfile.js';
import { ProjectActivationCoordinatorError } from '../project-authority/lifecycle/ProjectActivationCoordinator.js';
import {
  DevelopmentPrincipalError,
  type DevelopmentPrincipalAdapter,
} from '../request-context/DevelopmentPrincipalAdapter.js';
import type { IngressPrincipal } from '../request-context/IngressPrincipal.js';

export interface DevelopmentBootstrapRequestHandler {
  activateDevelopmentBootstrap(
    principal: IngressPrincipal,
    request: ActivateDevelopmentBootstrapRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
  beginDevelopmentBootstrap(
    principal: IngressPrincipal,
    request: BeginDevelopmentBootstrapRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
  cancelDevelopmentBootstrap(
    principal: IngressPrincipal,
    request: CancelDevelopmentBootstrapRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
  getDevelopmentBootstrap(
    principal: IngressPrincipal,
    request: GetDevelopmentBootstrapRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
  putDevelopmentBootstrapGitBundle(
    principal: IngressPrincipal,
    input: PutDevelopmentBootstrapGitBundleInput,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
  submitDevelopmentBootstrapReport(
    principal: IngressPrincipal,
    request: SubmitDevelopmentBootstrapReportRequest,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
}

export interface DevelopmentBootstrapRoutesOptions {
  readonly maximumJsonBytes: number;
  readonly principalAdapter: DevelopmentPrincipalAdapter;
  readonly profile: DevelopmentBootstrapRequestHandler;
  readonly requestIdFactory?: () => string;
}

class RouteFailure extends Error {
  readonly error: CollabError;
  readonly status: number;

  constructor(status: number, error: CollabError) {
    super('development-bootstrap-route.failure');
    this.name = 'RouteFailure';
    this.error = error;
    this.status = status;
  }
}

class RequestFailure extends Error {
  readonly failure: unknown;
  readonly requestId: string;

  constructor(requestId: string, failure: unknown) {
    super('development-bootstrap-route.request-failed');
    this.name = 'RequestFailure';
    this.failure = failure;
    this.requestId = requestId;
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
  try {
    for await (const raw of request) {
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

function profileFailure(error: DevelopmentBootstrapProfileError): RouteFailure {
  switch (error.code) {
    case 'attempt-not-found':
      return new RouteFailure(404, new CollabError({ code: 'project-not-found' }));
    case 'authorization-denied':
      return new RouteFailure(403, new CollabError({ code: 'authorization-denied' }));
    case 'comparison-mismatch':
    case 'host-stop-mismatch':
    case 'repository-mismatch':
    case 'state-conflict':
      return new RouteFailure(409, new CollabError({
        code: 'authority-not-synchronized',
      }));
    case 'closed':
    case 'dependency-failed':
      return new RouteFailure(503, new CollabError({
        code: 'operation-failed',
        recoveryActions: ['retry'],
      }));
  }
}

function activationFailure(error: ProjectActivationCoordinatorError): RouteFailure {
  if (error.code === 'state-conflict' || error.code === 'recovery-required') {
    return new RouteFailure(409, new CollabError({
      code: 'authority-not-synchronized',
    }));
  }
  return new RouteFailure(503, new CollabError({
    code: 'operation-failed',
    recoveryActions: ['retry'],
  }));
}

function collabFailure(error: CollabError): RouteFailure {
  if (
    error.code === 'protocol-payload-invalid'
    || error.code === 'protocol-version-unsupported'
  ) {
    return new RouteFailure(400, error);
  }
  return new RouteFailure(500, error);
}

export class DevelopmentBootstrapRoutes {
  readonly #maximumJsonBytes: number;
  readonly #principalAdapter: DevelopmentPrincipalAdapter;
  readonly #profile: DevelopmentBootstrapRequestHandler;
  readonly #requestIdFactory: () => string;

  constructor(options: DevelopmentBootstrapRoutesOptions) {
    if (
      !Number.isSafeInteger(options.maximumJsonBytes)
      || options.maximumJsonBytes < 1
      || options.maximumJsonBytes > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes
    ) {
      throw new TypeError('development-bootstrap-routes.options-invalid');
    }
    this.#maximumJsonBytes = options.maximumJsonBytes;
    this.#principalAdapter = options.principalAdapter;
    this.#profile = options.profile;
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    if (match?.kind !== 'development-bootstrap') return false;
    void this.#handle(request, response, match.operation, match.attemptId)
      .catch((error: unknown) => this.#sendFailure(response, error));
    return true;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    operation: DevelopmentBootstrapOperation,
    attemptId: string | undefined,
  ): Promise<void> {
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

    if (operation === 'getDevelopmentBootstrap') {
      if (attemptId === undefined) throw protocolFailure('attemptId');
      const result = await this.#profile.getDevelopmentBootstrap(
        principal,
        { attemptId },
      );
      this.#sendSuccess(response, requestId, operation, result);
      return;
    }

    if (operation === 'putDevelopmentBootstrapGitBundle') {
      if (attemptId === undefined) throw protocolFailure('attemptId');
      const contentTypes = headerValues(request, 'content-type');
      const encodings = headerValues(request, 'content-encoding');
      if (
        contentTypes.length !== 1
        || contentTypes[0] !== 'application/x-git-bundle'
      ) {
        throw protocolFailure('content-type');
      }
      if (
        encodings.length > 1
        || (encodings[0] !== undefined && encodings[0] !== 'identity')
      ) {
        throw protocolFailure('content-encoding');
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const onResponseClose = (): void => {
        if (!response.writableEnded) abort();
      };
      request.once('aborted', abort);
      request.once('error', abort);
      response.once('close', onResponseClose);
      const contentLength = optionalContentLength(request);
      let result: DevelopmentBootstrapAttemptStatus;
      try {
        result = await this.#profile.putDevelopmentBootstrapGitBundle(
          principal,
          {
            attemptId,
            body: request,
            contentEncoding: encodings[0] ?? 'identity',
            ...(contentLength === undefined ? {} : { contentLength }),
            contentType: contentTypes[0],
            signal: controller.signal,
          },
        );
      } finally {
        request.off('aborted', abort);
        request.off('error', abort);
        response.off('close', onResponseClose);
      }
      this.#sendSuccess(response, requestId, operation, result);
      return;
    }

    const body = await readJsonBody(request, this.#maximumJsonBytes);
    const envelope = decodeCollabProtocolEnvelope(body);
    if (envelope.status !== 'ok') throw collabFailure(envelope.error);
    if (!isCollabOpaqueId(envelope.value.requestId)) {
      throw protocolFailure('requestId');
    }
    requestId = envelope.value.requestId;
    const decoded = developmentBootstrapOperationCodec(operation)
      .decodeRequest(envelope.value.data);
    if (decoded.status !== 'ok') throw collabFailure(decoded.error);

    let result: DevelopmentBootstrapAttemptStatus;
    switch (operation) {
      case 'activateDevelopmentBootstrap': {
        const operationRequest = decoded.value as ActivateDevelopmentBootstrapRequest;
        this.#assertPathAttempt(attemptId, operationRequest.attemptId);
        result = await this.#profile.activateDevelopmentBootstrap(
          principal,
          operationRequest,
        );
        break;
      }
      case 'beginDevelopmentBootstrap':
        if (attemptId !== undefined) throw protocolFailure('attemptId');
        result = await this.#profile.beginDevelopmentBootstrap(
          principal,
          decoded.value as BeginDevelopmentBootstrapRequest,
        );
        break;
      case 'cancelDevelopmentBootstrap': {
        const operationRequest = decoded.value as CancelDevelopmentBootstrapRequest;
        this.#assertPathAttempt(attemptId, operationRequest.attemptId);
        result = await this.#profile.cancelDevelopmentBootstrap(
          principal,
          operationRequest,
        );
        break;
      }
      case 'submitDevelopmentBootstrapReport': {
        const operationRequest = decoded.value as SubmitDevelopmentBootstrapReportRequest;
        this.#assertPathAttempt(attemptId, operationRequest.attemptId);
        result = await this.#profile.submitDevelopmentBootstrapReport(
          principal,
          operationRequest,
        );
        break;
      }
    }
    this.#sendSuccess(response, requestId, operation, result);
    } catch (error: unknown) {
      throw new RequestFailure(requestId, error);
    }
  }

  #assertPathAttempt(pathAttemptId: string | undefined, bodyAttemptId: string): void {
    if (pathAttemptId === undefined || pathAttemptId !== bodyAttemptId) {
      throw protocolFailure('attemptId');
    }
  }

  #newRequestId(): string {
    const requestId = this.#requestIdFactory();
    if (!isCollabOpaqueId(requestId)) return 'server-request-error';
    return requestId;
  }

  #sendSuccess(
    response: ServerResponse,
    requestId: string,
    operation: DevelopmentBootstrapOperation,
    result: DevelopmentBootstrapAttemptStatus,
  ): void {
    let validated: DevelopmentBootstrapAttemptStatus;
    try {
      validated = developmentBootstrapOperationCodec(operation).decodeResponse(result);
    } catch (error: unknown) {
      if (error instanceof CollabError) throw collabFailure(error);
      throw error;
    }
    this.#sendJson(response, 200, collabCloudSuccessEnvelope(requestId, validated));
  }

  #sendFailure(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.destroyed) return;
    const requestId = error instanceof RequestFailure
      ? error.requestId
      : this.#newRequestId();
    const source = error instanceof RequestFailure ? error.failure : error;
    const failure = source instanceof RouteFailure
      ? source
      : source instanceof DevelopmentBootstrapProfileError
        ? profileFailure(source)
        : source instanceof ProjectActivationCoordinatorError
          ? activationFailure(source)
        : source instanceof CollabError
          ? collabFailure(source)
          : new RouteFailure(500, new CollabError({ code: 'operation-failed' }));
    this.#sendJson(
      response,
      failure.status,
      collabCloudErrorEnvelope(requestId, failure.error),
    );
  }

  #sendJson(response: ServerResponse, status: number, value: unknown): void {
    const encoded = JSON.stringify(value);
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(encoded),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(encoded);
  }
}
