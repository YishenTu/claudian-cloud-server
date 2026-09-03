import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from 'node:net';
import type { Duplex } from 'node:stream';

import type { HttpConfig } from '../config/ServerConfig.js';
import { HealthRoutes } from './health/HealthRoutes.js';

export interface HttpServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface HttpRouteHandler {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

export interface HttpUpgradeHandler {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean;
}

export interface HttpServerOptions {
  readonly config: HttpConfig;
  readonly connectionIngress?: Readonly<{
    accept(socket: Socket, acceptHttp: (socket: Socket) => void): void;
  }>;
  readonly isReady: () => boolean;
  readonly routes?: readonly HttpRouteHandler[];
  readonly upgradeRoutes?: readonly HttpUpgradeHandler[];
}

export class HttpServer {
  readonly #config: HttpConfig;
  readonly #activeHttpSockets = new Map<Socket, number>();
  readonly #healthRoutes: HealthRoutes;
  readonly #listener: TcpServer;
  readonly #routes: readonly HttpRouteHandler[];
  readonly #server: Server;
  readonly #pendingIngressSockets = new Set<Socket>();
  readonly #sockets = new Set<Socket>();
  readonly #upgradeRoutes: readonly HttpUpgradeHandler[];
  readonly #upgradedSockets = new Set<Socket>();
  #address: HttpServerAddress | undefined;
  #closePromise: Promise<void> | undefined;
  #startPromise: Promise<HttpServerAddress> | undefined;

  constructor(options: HttpServerOptions) {
    this.#config = options.config;
    this.#healthRoutes = new HealthRoutes({ isReady: options.isReady });
    this.#routes = Object.freeze([...(options.routes ?? [])]);
    this.#upgradeRoutes = Object.freeze([...(options.upgradeRoutes ?? [])]);
    this.#server = createServer((request, response) => {
      const socket = request.socket;
      this.#activeHttpSockets.set(
        socket,
        (this.#activeHttpSockets.get(socket) ?? 0) + 1,
      );
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        const remaining = (this.#activeHttpSockets.get(socket) ?? 1) - 1;
        if (remaining < 1) this.#activeHttpSockets.delete(socket);
        else this.#activeHttpSockets.set(socket, remaining);
        if (this.#closePromise !== undefined) socket.destroy();
      };
      response.once('finish', settle);
      response.once('close', settle);
      this.#handleRequest(request, response);
    });
    const track = (socket: Socket): void => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    };
    this.#listener = options.connectionIngress === undefined
      ? this.#server
      : createTcpServer({ pauseOnConnect: true }, socket => {
          track(socket);
          this.#pendingIngressSockets.add(socket);
          socket.once('close', () => this.#pendingIngressSockets.delete(socket));
          options.connectionIngress?.accept(socket, accepted => {
            this.#pendingIngressSockets.delete(accepted);
            this.#server.emit('connection', accepted);
          });
        });
    if (this.#listener === this.#server) {
      this.#server.on('connection', track);
    }
    this.#server.on('upgrade', (request, socket, head) => {
      const accepted = socket as Socket;
      this.#upgradedSockets.add(accepted);
      accepted.once('close', () => this.#upgradedSockets.delete(accepted));
      for (const route of this.#upgradeRoutes) {
        if (route.handleUpgrade(request, socket, head)) return;
      }
      socket.end(
        'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    });
  }

  start(): Promise<HttpServerAddress> {
    if (this.#address !== undefined) return Promise.resolve(this.#address);
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#closePromise !== undefined) {
      return Promise.reject(new Error('http-server-closed'));
    }

    this.#startPromise = new Promise<HttpServerAddress>((resolve, reject) => {
      const onClose = (): void => {
        this.#listener.off('error', onError);
        this.#listener.off('listening', onListening);
        reject(new Error('http-server-closed'));
      };
      const onError = (error: Error): void => {
        this.#listener.off('close', onClose);
        this.#listener.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#listener.off('close', onClose);
        this.#listener.off('error', onError);
        const address = this.#listener.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('http-server-address-unavailable'));
          return;
        }
        this.#address = Object.freeze({
          host: address.address,
          port: address.port,
        });
        resolve(this.#address);
      };

      this.#listener.once('close', onClose);
      this.#listener.once('error', onError);
      this.#listener.once('listening', onListening);
      this.#listener.listen({
        host: this.#config.host,
        port: this.#config.port,
      });
    });

    return this.#startPromise;
  }

  close(timeoutMs: number): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#close(timeoutMs);
    return this.#closePromise;
  }

  async #close(timeoutMs: number): Promise<void> {
    if (this.#startPromise === undefined && !this.#listener.listening) return;

    for (const socket of this.#pendingIngressSockets) socket.destroy();
    for (const socket of this.#sockets) {
      if (
        !this.#activeHttpSockets.has(socket)
        && !this.#upgradedSockets.has(socket)
      ) socket.destroy();
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        for (const socket of this.#sockets) socket.destroy();
      }, timeoutMs);
      timeout.unref();

      this.#listener.close((error) => {
        clearTimeout(timeout);
        this.#address = undefined;
        if (
          error
          && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ) {
          reject(error);
        }
        else resolve();
      });
    });
  }

  #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (this.#healthRoutes.handle(request, response)) return;
    for (const route of this.#routes) {
      if (route.handle(request, response)) return;
    }
    this.#sendJson(response, 404, { status: 'not-found' });
  }

  #sendJson(
    response: ServerResponse,
    statusCode: number,
    body: Readonly<Record<string, string>>,
  ): void {
    const encoded = JSON.stringify(body);
    response.writeHead(statusCode, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(encoded),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(encoded);
  }
}
