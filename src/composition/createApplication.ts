import type { ServerConfig } from '../config/ServerConfig.js';
import type { SafeLogger } from '../observability/SafeLogger.js';
import {
  HttpServer,
  type HttpServerAddress,
} from '../server/HttpServer.js';

export interface Application {
  close(): Promise<void>;
  start(): Promise<HttpServerAddress>;
}

export interface CreateApplicationOptions {
  readonly config: ServerConfig;
  readonly logger: SafeLogger;
}

type ApplicationState =
  | 'created'
  | 'ready'
  | 'starting'
  | 'stopped'
  | 'stopping';

class CloudApplication implements Application {
  readonly #config: ServerConfig;
  readonly #httpServer: HttpServer;
  readonly #logger: SafeLogger;
  #address: HttpServerAddress | undefined;
  #closePromise: Promise<void> | undefined;
  #startPromise: Promise<HttpServerAddress> | undefined;
  #state: ApplicationState = 'created';

  constructor(options: CreateApplicationOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#httpServer = new HttpServer({
      config: options.config.http,
      isReady: () => this.#state === 'ready',
    });
  }

  start(): Promise<HttpServerAddress> {
    if (this.#address !== undefined) return Promise.resolve(this.#address);
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#state === 'stopped' || this.#state === 'stopping') {
      return Promise.reject(new Error('application-closed'));
    }

    this.#state = 'starting';
    this.#logger.info('server.starting', {
      profile: this.#config.deploymentProfile,
    });
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #start(): Promise<HttpServerAddress> {
    try {
      const address = await this.#httpServer.start();
      this.#address = address;
      this.#state = 'ready';
      this.#logger.info('server.listening', {
        port: address.port,
        profile: this.#config.deploymentProfile,
      });
      return address;
    } catch (cause: unknown) {
      this.#state = 'stopped';
      this.#logger.error('server.startup-failed', {
        reason: 'http-listen-failed',
      });
      throw new Error('application-start-failed', { cause });
    }
  }

  async #close(): Promise<void> {
    if (this.#state === 'stopped') return;
    if (this.#state === 'starting' && this.#startPromise !== undefined) {
      try {
        await this.#startPromise;
      } catch {
        return;
      }
    }
    if (this.#state === 'created') {
      this.#state = 'stopped';
      return;
    }

    this.#state = 'stopping';
    this.#logger.info('server.stopping', {
      state: 'draining',
    });
    try {
      await this.#httpServer.close(this.#config.shutdownTimeoutMs);
      this.#address = undefined;
      this.#state = 'stopped';
      this.#logger.info('server.stopped');
    } catch (cause: unknown) {
      this.#state = 'stopped';
      this.#logger.error('server.shutdown-failed', {
        reason: 'http-close-failed',
      });
      throw new Error('application-close-failed', { cause });
    }
  }
}

export function createApplication(options: CreateApplicationOptions): Application {
  return new CloudApplication(options);
}
