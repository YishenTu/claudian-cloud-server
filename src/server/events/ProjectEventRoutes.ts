import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  COLLAB_CLOUD_BINDING_LIMITS,
  decodeCollabCloudProjectEventMessage,
  matchCollabCloudRoute,
  type CollabProjectId,
} from '@claudian-collab/protocol';
import { WebSocket, WebSocketServer } from 'ws';

import type {
  ProjectEventReadResult,
} from '../../project-authority/reads/ProjectReadAuthority.js';
import { ProjectReadAuthorityError } from '../../project-authority/reads/ProjectReadAuthority.js';
import type { ProjectEventWakeup } from '../../project-authority/reads/ProjectEventWakeup.js';
import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import {
  RequestPrincipalBinding,
  RequestPrincipalBindingError,
  type RequestPrincipalBindingOptions,
} from '../../request-context/RequestPrincipalBinding.js';
import type {
  ProjectEventAdmission,
  PendingProjectEventPermit,
  ProjectEventPermit,
} from '../../resource-admission/ProjectEventAdmission.js';

export interface ProjectEventHandler {
  getProjectEvents(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    afterSequence: number,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<ProjectEventReadResult>;
}

export interface ProjectEventRoutesOptions
  extends RequestPrincipalBindingOptions {
  readonly admission: Pick<ProjectEventAdmission, 'acquirePending'>;
  readonly authority: ProjectEventHandler;
  readonly heartbeatMs?: number;
  readonly maximumBufferedBytes: number;
  readonly wakeup: ProjectEventWakeup;
}

class SlowConsumerError extends Error {}

function releasePermit(permit: ProjectEventPermit | undefined): undefined {
  permit?.release();
  return undefined;
}

function rejectUpgrade(
  socket: Duplex,
  status: 403 | 404 | 409 | 413 | 503,
): void {
  const reason = {
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    413: 'Content Too Large',
    503: 'Service Unavailable',
  }[status];
  socket.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function authorityStatus(error: ProjectReadAuthorityError): 404 | 409 | 413 | 503 {
  switch (error.code) {
    case 'authorization-denied':
    case 'project-not-found': return 404;
    case 'recovery-required':
    case 'state-conflict': return 409;
    case 'project-too-large': return 413;
    case 'cancelled':
    case 'closed':
    case 'dependency-failed': return 503;
  }
}

export class ProjectEventRoutes {
  readonly #admission: Pick<ProjectEventAdmission, 'acquirePending'>;
  readonly #authority: ProjectEventHandler;
  readonly #controllers = new Set<AbortController>();
  readonly #heartbeatMs: number;
  readonly #maximumBufferedBytes: number;
  readonly #principalBinding: RequestPrincipalBinding;
  readonly #pending = new Set<Promise<void>>();
  readonly #pendingSockets = new Set<Duplex>();
  readonly #projectPolls = new Map<CollabProjectId, Promise<void>>();
  readonly #sessions = new Set<Promise<void>>();
  readonly #sockets = new Set<WebSocket>();
  readonly #wakeup: ProjectEventWakeup;
  readonly #webSocketServer = new WebSocketServer({
    maxPayload: 1,
    noServer: true,
    perMessageDeflate: false,
  });
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: ProjectEventRoutesOptions) {
    const heartbeatMs = options.heartbeatMs
      ?? COLLAB_CLOUD_BINDING_LIMITS.eventHeartbeatMs;
    if (
      !Number.isSafeInteger(heartbeatMs)
      || heartbeatMs < 1
      || !Number.isSafeInteger(options.maximumBufferedBytes)
      || options.maximumBufferedBytes < 1
    ) {
      throw new TypeError('project-event-routes.options-invalid');
    }
    this.#admission = options.admission;
    this.#authority = options.authority;
    this.#heartbeatMs = heartbeatMs;
    this.#maximumBufferedBytes = options.maximumBufferedBytes;
    this.#principalBinding = new RequestPrincipalBinding(options);
    this.#wakeup = options.wakeup;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      for (const controller of this.#controllers) controller.abort();
      for (const socket of this.#pendingSockets) socket.destroy();
      for (const socket of this.#sockets) socket.terminate();
      this.#closePromise = Promise.allSettled([
        ...this.#pending,
        ...this.#sessions,
      ]).then(() => undefined);
    }
    return this.#closePromise;
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    if (match?.kind !== 'project-events') return false;
    if (this.#closed) {
      rejectUpgrade(socket, 503);
      return true;
    }
    let principal: IngressPrincipal;
    try {
      principal = this.#principalBinding.bind(request);
    } catch (error: unknown) {
      if (error instanceof RequestPrincipalBindingError) {
        rejectUpgrade(socket, 403);
        return true;
      }
      rejectUpgrade(socket, 503);
      return true;
    }
    let permit: PendingProjectEventPermit;
    try {
      permit = this.#admission.acquirePending();
    } catch {
      rejectUpgrade(socket, 503);
      return true;
    }
    this.#startPendingUpgrade(
      request,
      socket,
      head,
      permit,
      principal,
      match.projectId,
      match.afterSequence,
    );
    return true;
  }

  #startPendingUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    pendingPermit: PendingProjectEventPermit,
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    afterSequence: number,
  ): void {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    this.#controllers.add(controller);
    this.#pendingSockets.add(socket);
    socket.once('close', abort);
    socket.once('error', abort);
    const pending = this.#authorizeAndUpgrade(
      request,
      socket,
      head,
      pendingPermit,
      principal,
      projectId,
      afterSequence,
      controller.signal,
    ).finally(() => {
      pendingPermit.release();
      socket.off('close', abort);
      socket.off('error', abort);
      this.#pendingSockets.delete(socket);
      this.#controllers.delete(controller);
    });
    const tracked = pending.then(() => undefined, () => undefined);
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  async #authorizeAndUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    pendingPermit: PendingProjectEventPermit,
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    afterSequence: number,
    signal: AbortSignal,
  ): Promise<void> {
    let activePermit: ProjectEventPermit | undefined;
    try {
      await this.#pollProjectEvents(
        projectId,
        () => this.#authority.getProjectEvents(
          principal,
          projectId,
          afterSequence,
          { signal },
        ),
      );
      if (this.#closed || signal.aborted || socket.destroyed) return;
      activePermit = pendingPermit.promote(projectId);
      this.#webSocketServer.handleUpgrade(request, socket, head, webSocket => {
        const permit = activePermit;
        activePermit = undefined;
        if (permit === undefined) {
          webSocket.terminate();
          return;
        }
        this.#startSession(
          webSocket,
          permit,
          principal,
          projectId,
          afterSequence,
        );
      });
      activePermit = releasePermit(activePermit);
    } catch (error: unknown) {
      activePermit = releasePermit(activePermit);
      if (!signal.aborted && !this.#closed && !socket.destroyed) {
        rejectUpgrade(
          socket,
          error instanceof ProjectReadAuthorityError
            ? authorityStatus(error)
            : 503,
        );
      }
    }
  }

  #startSession(
    socket: WebSocket,
    permit: ProjectEventPermit,
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    afterSequence: number,
  ): void {
    this.#sockets.add(socket);
    const session = this.#runSession(
      socket,
      principal,
      projectId,
      afterSequence,
    ).finally(() => {
      this.#sockets.delete(socket);
      permit.release();
    });
    const tracked = session.then(() => undefined, () => undefined);
    this.#sessions.add(tracked);
    void tracked.finally(() => this.#sessions.delete(tracked));
  }

  async #runSession(
    socket: WebSocket,
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    initialSequence: number,
  ): Promise<void> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    let cursor = initialSequence;
    let missedHeartbeats = 0;
    let wakeVersion = 0;
    let wakeResolver: (() => void) | undefined;
    const abort = (): void => {
      controller.abort();
      wakeResolver?.();
      wakeResolver = undefined;
    };
    const onAbort = (): void => {
      wakeResolver?.();
      wakeResolver = undefined;
    };
    controller.signal.addEventListener('abort', onAbort);
    const onClose = (): void => abort();
    const onError = (): void => abort();
    const onMessage = (): void => socket.terminate();
    const onPong = (): void => {
      missedHeartbeats = 0;
    };
    socket.on('close', onClose);
    socket.on('error', onError);
    socket.on('message', onMessage);
    socket.on('pong', onPong);
    const unsubscribe = this.#wakeup.subscribe(projectId, () => {
      wakeVersion += 1;
      wakeResolver?.();
      wakeResolver = undefined;
    });
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (
        missedHeartbeats
        >= COLLAB_CLOUD_BINDING_LIMITS.eventMissedHeartbeatLimit
      ) {
        socket.terminate();
        return;
      }
      socket.ping();
      missedHeartbeats += 1;
    }, this.#heartbeatMs);
    heartbeat.unref();
    const socketClosed = socket.readyState === WebSocket.CLOSED
      ? Promise.resolve()
      : new Promise<void>(resolve => socket.once('close', () => resolve()));
    const closeSocket = async (code: number): Promise<void> => {
      if (socket.readyState === WebSocket.OPEN) socket.close(code);
      if (socket.readyState === WebSocket.CLOSED) return;
      const forced = setTimeout(() => socket.terminate(), (
        this.#heartbeatMs * COLLAB_CLOUD_BINDING_LIMITS.eventMissedHeartbeatLimit
      ));
      forced.unref();
      try {
        await socketClosed;
      } finally {
        clearTimeout(forced);
      }
    };
    try {
      for (;;) {
        if (
          this.#closed
          || controller.signal.aborted
          || socket.readyState !== WebSocket.OPEN
        ) return;
        const observedWakeVersion = wakeVersion;
        const result = await this.#pollProjectEvents(
          projectId,
          () => this.#authority.getProjectEvents(
            principal,
            projectId,
            cursor,
            { signal: controller.signal },
          ),
        );
        if (result.kind === 'snapshot-required') {
          await this.#send(socket, {
            kind: 'snapshot.required',
            latestSequence: result.latestSequence,
          });
          await closeSocket(1000);
          return;
        }
        for (const event of result.events) {
          const validated = decodeCollabCloudProjectEventMessage(event);
          if (validated.kind === 'snapshot.required') throw new Error('event-invalid');
          await this.#send(socket, validated);
          cursor = validated.sequence;
        }
        cursor = result.latestSequence;
        if (wakeVersion !== observedWakeVersion) continue;
        await new Promise<void>(resolve => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(durablePoll);
            if (wakeResolver === finish) wakeResolver = undefined;
            resolve();
          };
          const durablePoll = setTimeout(finish, this.#heartbeatMs);
          durablePoll.unref();
          wakeResolver = finish;
          if (controller.signal.aborted) finish();
        });
      }
    } catch (error: unknown) {
      if (
        !(error instanceof SlowConsumerError)
        && !controller.signal.aborted
        && !this.#closed
        && socket.readyState === WebSocket.OPEN
      ) {
        await closeSocket(1011);
      } else {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        await socketClosed;
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
      controller.abort();
      controller.signal.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      wakeResolver?.();
      socket.off('close', onClose);
      socket.off('error', onError);
      socket.off('message', onMessage);
      socket.off('pong', onPong);
    }
  }

  #send(socket: WebSocket, value: unknown): Promise<void> {
    const encoded = JSON.stringify(value);
    const bytes = Buffer.byteLength(encoded);
    if (
      bytes > this.#maximumBufferedBytes
      || socket.bufferedAmount + bytes > this.#maximumBufferedBytes
    ) {
      return Promise.reject(new SlowConsumerError());
    }
    return new Promise<void>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error('socket-closed'));
        return;
      }
      socket.send(encoded, error => {
        if (error) reject(new Error('socket-send-failed'));
        else resolve();
      });
    });
  }

  #pollProjectEvents<T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const preceding = this.#projectPolls.get(projectId) ?? Promise.resolve();
    const result = preceding.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#projectPolls.set(projectId, settled);
    void settled.finally(() => {
      if (this.#projectPolls.get(projectId) === settled) {
        this.#projectPolls.delete(projectId);
      }
    });
    return result;
  }
}
