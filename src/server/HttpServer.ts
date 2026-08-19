import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { HttpConfig } from '../config/ServerConfig.js';
import { HealthRoutes } from './health/HealthRoutes.js';

export interface HttpServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface HttpServerOptions {
  readonly config: HttpConfig;
  readonly isReady: () => boolean;
}

export class HttpServer {
  readonly #config: HttpConfig;
  readonly #healthRoutes: HealthRoutes;
  readonly #server: Server;
  #address: HttpServerAddress | undefined;
  #closePromise: Promise<void> | undefined;
  #startPromise: Promise<HttpServerAddress> | undefined;

  constructor(options: HttpServerOptions) {
    this.#config = options.config;
    this.#healthRoutes = new HealthRoutes({ isReady: options.isReady });
    this.#server = createServer((request, response) => {
      this.#handleRequest(request, response);
    });
  }

  start(): Promise<HttpServerAddress> {
    if (this.#address !== undefined) return Promise.resolve(this.#address);
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#closePromise !== undefined) {
      return Promise.reject(new Error('http-server-closed'));
    }

    this.#startPromise = new Promise<HttpServerAddress>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off('error', onError);
        const address = this.#server.address();
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

      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen({
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
    if (!this.#server.listening) return;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#server.closeAllConnections();
      }, timeoutMs);
      timeout.unref();

      this.#server.close((error) => {
        clearTimeout(timeout);
        this.#address = undefined;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (this.#healthRoutes.handle(request, response)) return;
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
