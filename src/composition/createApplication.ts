import type { ServerConfig } from '../config/ServerConfig.js';
import { CoordinationError } from '../coordination/CoordinationError.js';
import { PostgresCoordination } from '../coordination/postgres/PostgresCoordination.js';
import type { SafeLogger } from '../observability/SafeLogger.js';
import {
  GitRepositoryAuthority,
  GitRepositoryError,
} from '../repositories/GitRepositoryAuthority.js';
import { ResourceAdmission } from '../resource-admission/ResourceAdmission.js';
import {
  HttpServer,
  type HttpServerAddress,
} from '../server/HttpServer.js';

export type ApplicationErrorCode =
  | 'closed'
  | 'shutdown-failed'
  | 'startup-failed';

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode) {
    super(`application.error.${code}`);
    this.name = 'ApplicationError';
    this.code = code;
  }
}

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

type StartupPhase = 'http' | 'postgres' | 'repository';

function startupFailureReason(
  phase: StartupPhase,
  error: unknown,
): string {
  if (phase === 'postgres') {
    if (
      error instanceof CoordinationError
      && error.code === 'schema-incompatible'
    ) {
      return 'schema-incompatible';
    }
    return 'postgres-unavailable';
  }
  if (phase === 'repository') {
    if (error instanceof GitRepositoryError) return error.code;
    return 'repository-unavailable';
  }
  return 'http-listen-failed';
}

async function settleBefore(
  operation: Promise<unknown>,
  deadline: number,
): Promise<boolean> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), remaining);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class CloudApplication implements Application {
  readonly #config: ServerConfig;
  readonly #coordination: PostgresCoordination;
  readonly #httpServer: HttpServer;
  readonly #logger: SafeLogger;
  readonly #repositoryAuthority: GitRepositoryAuthority;
  readonly #resourceAdmission: ResourceAdmission;
  #address: HttpServerAddress | undefined;
  #closePromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #startPromise: Promise<HttpServerAddress> | undefined;
  #state: ApplicationState = 'created';

  constructor(options: CreateApplicationOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#resourceAdmission = new ResourceAdmission(options.config.gitAdmission);
    this.#coordination = new PostgresCoordination({
      ordinaryPoolMax: options.config.postgres.ordinaryPoolMax,
      pinnedPoolMax: options.config.postgres.pinnedPoolMax,
      projectLockTimeoutMs: options.config.postgres.projectLockTimeoutMs,
      reservedPoolMax: options.config.postgres.reservedPoolMax,
      runtimeConnectionString: options.config.postgres.url,
    });
    this.#repositoryAuthority = new GitRepositoryAuthority({
      gitExecutable: options.config.repository.gitExecutable,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      outputMaxBytes: options.config.repository.outputMaxBytes,
      placementValidator: this.#coordination,
      repositoryRoot: options.config.repository.root,
      resourceAdmission: this.#resourceAdmission,
      storageNodeId: options.config.repository.storageNodeId,
    });
    this.#httpServer = new HttpServer({
      config: options.config.http,
      isReady: () => this.#state === 'ready',
    });
  }

  start(): Promise<HttpServerAddress> {
    if (this.#state === 'stopped' || this.#state === 'stopping') {
      return Promise.reject(new ApplicationError('closed'));
    }
    if (this.#address !== undefined) return Promise.resolve(this.#address);
    if (this.#startPromise !== undefined) return this.#startPromise;

    this.#state = 'starting';
    this.#logger.info('server.starting');
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#state === 'stopped') {
      this.#closePromise = this.#disposePromise ?? Promise.resolve();
      return this.#closePromise;
    }
    this.#state = 'stopping';
    this.#logger.info('server.stopping', { state: 'draining' });
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #start(): Promise<HttpServerAddress> {
    let phase: StartupPhase = 'postgres';
    try {
      await this.#coordination.verifySchemaCompatibility();
      this.#assertStarting();

      phase = 'repository';
      await this.#repositoryAuthority.verifyCapability();
      this.#assertStarting();

      phase = 'http';
      const address = await this.#httpServer.start();
      this.#assertStarting();

      this.#address = address;
      this.#state = 'ready';
      this.#logger.info('server.listening', { port: address.port });
      return address;
    } catch (error: unknown) {
      const closing = this.#state === 'stopping';
      this.#state = 'stopping';
      if (!closing) {
        this.#logger.error('server.startup-failed', {
          reason: startupFailureReason(phase, error),
        });
      }
      try {
        await this.#dispose();
      } catch {
        // Startup always reports one sanitized failure regardless of cleanup detail.
      }
      this.#state = 'stopped';
      throw new ApplicationError('startup-failed');
    }
  }

  async #close(): Promise<void> {
    let failed = false;
    try {
      await this.#dispose();
    } catch {
      failed = true;
    }
    if (this.#startPromise !== undefined) {
      try {
        await this.#startPromise;
      } catch {
        // Disposal owns the final shutdown result.
      }
    }
    this.#address = undefined;
    this.#state = 'stopped';
    if (failed) {
      this.#logger.error('server.shutdown-failed', {
        reason: 'owner-close-failed',
      });
      throw new ApplicationError('shutdown-failed');
    }
    this.#logger.info('server.stopped');
  }

  #assertStarting(): void {
    if (this.#state !== 'starting') throw new ApplicationError('closed');
  }

  #dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeOwners();
    return this.#disposePromise;
  }

  async #disposeOwners(): Promise<void> {
    const deadline = Date.now() + this.#config.shutdownTimeoutMs;
    const admissionDrain = this.#resourceAdmission.close();
    const results: boolean[] = [];

    results.push(await settleBefore(this.#repositoryAuthority.close(), deadline));
    results.push(await settleBefore(admissionDrain, deadline));
    results.push(await settleBefore(this.#coordination.close(), deadline));
    results.push(await settleBefore(
      this.#httpServer.close(Math.max(1, deadline - Date.now())),
      deadline,
    ));

    if (results.includes(false)) throw new ApplicationError('shutdown-failed');
  }
}

export function createApplication(options: CreateApplicationOptions): Application {
  return new CloudApplication(options);
}
