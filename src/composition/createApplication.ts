import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_LIMITS,
} from '@claudian-collab/protocol';

import type { ServerConfig } from '../config/ServerConfig.js';
import { CoordinationError } from '../coordination/CoordinationError.js';
import { PostgresCoordination } from '../coordination/postgres/PostgresCoordination.js';
import { DevelopmentBootstrapProfile } from '../onboarding/development/DevelopmentBootstrapProfile.js';
import { DevelopmentBootstrapExpiryReconciler } from '../onboarding/development/DevelopmentBootstrapExpiryReconciler.js';
import type { SafeLogger } from '../observability/SafeLogger.js';
import { ProjectAcceptCoordinator } from '../project-authority/acceptance/ProjectAcceptCoordinator.js';
import { ProjectActivationCoordinator } from '../project-authority/lifecycle/ProjectActivationCoordinator.js';
import { ProjectReadAuthority } from '../project-authority/reads/ProjectReadAuthority.js';
import { ProjectRequestAuthority } from '../project-authority/requests/ProjectRequestAuthority.js';
import { ProjectTicketAuthority } from '../project-authority/tickets/ProjectTicketAuthority.js';
import { ProjectPersonalRefAuthority } from '../project-authority/writes/ProjectPersonalRefAuthority.js';
import { ProjectRecoveryCoordinator } from '../project-authority/recovery/ProjectRecoveryCoordinator.js';
import { ProjectEventWakeup } from '../project-authority/reads/ProjectEventWakeup.js';
import { ActiveRepositoryIntegrityGate } from '../project-authority/lifecycle/ActiveRepositoryIntegrityGate.js';
import { GitBundleImporter } from '../repositories/GitBundleImporter.js';
import { BootstrapRepositoryIntegrityVerifier } from '../repositories/BootstrapRepositoryIntegrityVerifier.js';
import { DevelopmentBootstrapUploadGate } from '../project-authority/lifecycle/DevelopmentBootstrapUploadGate.js';
import {
  GitRepositoryAuthority,
  GitRepositoryError,
} from '../repositories/GitRepositoryAuthority.js';
import {
  RepositoryPublication,
  RepositoryPublicationError,
} from '../repositories/RepositoryPublication.js';
import { DevelopmentPrincipalAdapter } from '../request-context/DevelopmentPrincipalAdapter.js';
import { BootstrapUploadAdmission } from '../resource-admission/BootstrapUploadAdmission.js';
import { ProjectEventAdmission } from '../resource-admission/ProjectEventAdmission.js';
import { GitReceiveAdmission } from '../resource-admission/GitReceiveAdmission.js';
import { ResourceAdmission } from '../resource-admission/ResourceAdmission.js';
import { CloudCapabilitiesRoute } from '../server/CloudCapabilitiesRoute.js';
import { DevelopmentBootstrapRoutes } from '../server/DevelopmentBootstrapRoutes.js';
import { ProjectSnapshotRoutes } from '../server/control/ProjectSnapshotRoutes.js';
import { ProjectCollaborationRoutes } from '../server/control/ProjectCollaborationRoutes.js';
import { ProjectEventRoutes } from '../server/events/ProjectEventRoutes.js';
import { GitUploadPackRoutes } from '../server/git/GitUploadPackRoutes.js';
import { GitReceivePackRoutes } from '../server/git/GitReceivePackRoutes.js';
import {
  HttpServer,
  type HttpServerAddress,
} from '../server/HttpServer.js';
import {
  AuthorityVolumePairError,
  AuthorityVolumePairVerifier,
} from './AuthorityVolumePairVerifier.js';

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

type StartupPhase = 'authority' | 'http' | 'postgres' | 'recovery' | 'repository';

function startupFailureReason(
  phase: StartupPhase,
  error: unknown,
): string {
  if (phase === 'authority') {
    return error instanceof AuthorityVolumePairError
      ? 'authority-volume-mismatch'
      : 'authority-volume-unavailable';
  }
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
    if (
      error instanceof GitRepositoryError
      || error instanceof RepositoryPublicationError
    ) return error.code;
    return 'repository-unavailable';
  }
  if (phase === 'recovery') return 'project-recovery-failed';
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
  readonly #acceptCoordinator: ProjectAcceptCoordinator;
  readonly #activationCoordinator: ProjectActivationCoordinator;
  readonly #activeRepositoryIntegrity: ActiveRepositoryIntegrityGate;
  readonly #authorityVolumePair: AuthorityVolumePairVerifier;
  readonly #bootstrapUploadAdmission: BootstrapUploadAdmission;
  readonly #bootstrapRepositoryIntegrity: BootstrapRepositoryIntegrityVerifier;
  readonly #bundleImporter: GitBundleImporter;
  readonly #bootstrapExpiryReconciler: DevelopmentBootstrapExpiryReconciler;
  readonly #httpServer: HttpServer;
  readonly #logger: SafeLogger;
  readonly #projectEventRoutes: ProjectEventRoutes;
  readonly #projectEventAdmission: ProjectEventAdmission;
  readonly #projectEventWakeup: ProjectEventWakeup;
  readonly #projectReadAuthority: ProjectReadAuthority;
  readonly #projectRequestAuthority: ProjectRequestAuthority;
  readonly #projectPersonalRefAuthority: ProjectPersonalRefAuthority;
  readonly #projectTicketAuthority: ProjectTicketAuthority;
  readonly #repositoryAuthority: GitRepositoryAuthority;
  readonly #repositoryPublication: RepositoryPublication;
  readonly #recoveryCoordinator: ProjectRecoveryCoordinator;
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
    this.#projectEventWakeup = new ProjectEventWakeup();
    this.#coordination = new PostgresCoordination({
      onProjectEventCommitted: projectId => this.#projectEventWakeup.notify(projectId),
      ordinaryPoolMax: options.config.postgres.ordinaryPoolMax,
      pinnedPoolMax: options.config.postgres.pinnedPoolMax,
      projectLockTimeoutMs: options.config.postgres.projectLockTimeoutMs,
      reservedPoolMax: options.config.postgres.reservedPoolMax,
      runtimeConnectionString: options.config.postgres.url,
      shutdownTimeoutMs: options.config.shutdownTimeoutMs,
    });
    this.#repositoryAuthority = new GitRepositoryAuthority({
      gitExecutable: options.config.repository.gitExecutable,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      outputMaxBytes: options.config.repository.outputMaxBytes,
      placementValidator: this.#coordination,
      receiveAdmission: new GitReceiveAdmission({
        capacityTimeoutMs: options.config.gitAdmission.queueTimeoutMs,
        freeSpaceFloorBytes:
          options.config.developmentBootstrap.stagingFreeSpaceFloorBytes,
        maxConcurrentReceives: options.config.gitAdmission.maxWriteChildren,
        maxConcurrentReceivesPerProject: 1,
        maximumRequestBytes:
          COLLAB_CLOUD_BINDING_LIMITS.maxGitReceivePackBytes,
        repositoryRoot: options.config.repository.root,
        reservationBytes: options.config.developmentBootstrap.maxRepositoryBytes,
      }),
      receivePolicy: {
        maximumBlobBytes: COLLAB_LIMITS.maxBlobBytes,
        maximumExpandedTreeEntries: 100_000,
        maximumRepositoryBytes:
          options.config.developmentBootstrap.maxRepositoryBytes,
        maximumTreeEntries: COLLAB_LIMITS.maxChangedPaths,
      },
      repositoryRoot: options.config.repository.root,
      resourceAdmission: this.#resourceAdmission,
      storageNodeId: options.config.repository.storageNodeId,
    });
    this.#projectReadAuthority = new ProjectReadAuthority({
      coordination: this.#coordination,
      repository: this.#repositoryAuthority,
    });
    this.#projectEventAdmission = new ProjectEventAdmission(options.config.eventAdmission);
    this.#authorityVolumePair = new AuthorityVolumePairVerifier({
      coordination: this.#coordination,
      repositoryRoot: options.config.repository.root,
      stagingRoot: options.config.developmentBootstrap.stagingRoot,
    });
    this.#bootstrapUploadAdmission = new BootstrapUploadAdmission({
      maxConcurrentUploads: options.config.developmentBootstrap.maxConcurrentUploads,
      maxUploadsPerAttempt: options.config.developmentBootstrap.maxUploadsPerAttempt,
      queueMax: options.config.developmentBootstrap.queueMax,
      queueTimeoutMs: options.config.developmentBootstrap.queueTimeoutMs,
      stagingFreeSpaceFloorBytes:
        options.config.developmentBootstrap.stagingFreeSpaceFloorBytes,
      stagingReservationBytes:
        options.config.developmentBootstrap.stagingReservationBytes,
      stagingRoot: options.config.developmentBootstrap.stagingRoot,
    });
    this.#bundleImporter = new GitBundleImporter({
      gitExecutable: options.config.repository.gitExecutable,
      maximumBlobBytes: COLLAB_LIMITS.maxBlobBytes,
      maximumBundleBytes: options.config.developmentBootstrap.maxBundleBytes,
      maximumExpandedTreeEntries: 100_000,
      maximumMetadataOutputBytes: options.config.repository.outputMaxBytes,
      maximumRepositoryBytes: options.config.developmentBootstrap.maxRepositoryBytes,
      maximumTreeEntries: COLLAB_LIMITS.maxChangedPaths,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      resourceAdmission: this.#resourceAdmission,
      stagingRoot: options.config.developmentBootstrap.stagingRoot,
      uploadAdmission: this.#bootstrapUploadAdmission,
      uploadIdleTimeoutMs: options.config.developmentBootstrap.uploadIdleTimeoutMs,
      uploadTotalTimeoutMs: options.config.developmentBootstrap.uploadDeadlineMs,
    });
    const developmentBootstrapUploadGate = new DevelopmentBootstrapUploadGate();
    this.#bootstrapRepositoryIntegrity = new BootstrapRepositoryIntegrityVerifier({
      gitExecutable: options.config.repository.gitExecutable,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      outputMaxBytes: options.config.repository.outputMaxBytes,
      resourceAdmission: this.#resourceAdmission,
    });
    this.#repositoryPublication = new RepositoryPublication({
      integrityVerifier: this.#bootstrapRepositoryIntegrity,
      repositoryRoot: options.config.repository.root,
      stagingRoot: options.config.developmentBootstrap.stagingRoot,
      storageNodeId: options.config.repository.storageNodeId,
    });
    this.#activationCoordinator = new ProjectActivationCoordinator({
      attemptCleaner: this.#bundleImporter,
      coordination: this.#coordination,
      publication: this.#repositoryPublication,
      uploadGate: developmentBootstrapUploadGate,
    });
    this.#acceptCoordinator = new ProjectAcceptCoordinator({
      coordination: this.#coordination,
      repository: this.#repositoryAuthority,
    });
    this.#recoveryCoordinator = new ProjectRecoveryCoordinator({
      accept: this.#acceptCoordinator,
      activation: this.#activationCoordinator,
      catalog: this.#coordination,
      isolation: this.#coordination,
    });
    this.#projectRequestAuthority = new ProjectRequestAuthority({
      coordination: this.#coordination,
      recovery: this.#recoveryCoordinator,
      repository: this.#repositoryAuthority,
    });
    this.#projectTicketAuthority = new ProjectTicketAuthority({
      coordination: this.#coordination,
      recovery: this.#recoveryCoordinator,
    });
    this.#projectPersonalRefAuthority = new ProjectPersonalRefAuthority({
      coordination: this.#coordination,
      recovery: this.#recoveryCoordinator,
      repository: this.#repositoryAuthority,
    });
    this.#activeRepositoryIntegrity = new ActiveRepositoryIntegrityGate({
      coordination: this.#coordination,
      repository: this.#repositoryAuthority,
    });
    this.#bootstrapExpiryReconciler = new DevelopmentBootstrapExpiryReconciler({
      catalog: this.#coordination,
      settlement: this.#activationCoordinator,
    });
    const bootstrapProfile = new DevelopmentBootstrapProfile({
      attemptTtlMs: options.config.developmentBootstrap.attemptTtlMs,
      importer: this.#bundleImporter,
      persistence: this.#coordination,
      settlement: this.#activationCoordinator,
      uploadGate: developmentBootstrapUploadGate,
    });
    const capabilitiesRoute = new CloudCapabilitiesRoute({
      enabledCapabilities: new Set([
        'development-bootstrap',
        'accept',
        'git-receive-pack-personal-ref',
        'git-upload-pack',
        'project-events',
        'project-snapshot',
        'requests',
        'tickets',
      ]),
      limits: {
        maxCheckpointCoordinationBytes:
          COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
        maxCheckpointManifestUtf8Bytes:
          COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
        maxCheckpointRepositoryBundleBytes:
          COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
        maxCheckpointStagingBytes:
          COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
        maxDevelopmentBootstrapGitBundleBytes:
          options.config.developmentBootstrap.maxBundleBytes,
        maxDevelopmentBootstrapManifestUtf8Bytes:
          COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapManifestUtf8Bytes,
        maxDevelopmentBootstrapReportUtf8Bytes:
          COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapReportUtf8Bytes,
        maxEventReplay: COLLAB_CLOUD_BINDING_LIMITS.maxEventReplay,
        maxGitReceivePackBytes: COLLAB_CLOUD_BINDING_LIMITS.maxGitReceivePackBytes,
        maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
        maxRepositoryBytes: options.config.developmentBootstrap.maxRepositoryBytes,
      },
    });
    const principalAdapter = new DevelopmentPrincipalAdapter({
      profile: 'loopback-development',
    });
    const bootstrapRoutes = new DevelopmentBootstrapRoutes({
      maximumJsonBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
      principalAdapter,
      profile: bootstrapProfile,
    });
    const projectSnapshotRoutes = new ProjectSnapshotRoutes({
      authority: this.#projectReadAuthority,
      maximumJsonBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      principalAdapter,
    });
    const projectCollaborationRoutes = new ProjectCollaborationRoutes({
      acceptAuthority: this.#acceptCoordinator,
      maximumJsonBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      principalAdapter,
      requestAuthority: this.#projectRequestAuthority,
      ticketAuthority: this.#projectTicketAuthority,
    });
    this.#projectEventRoutes = new ProjectEventRoutes({
      admission: this.#projectEventAdmission,
      authority: this.#projectReadAuthority,
      maximumBufferedBytes: options.config.repository.outputMaxBytes,
      principalAdapter,
      wakeup: this.#projectEventWakeup,
    });
    const gitUploadPackRoutes = new GitUploadPackRoutes({
      authority: this.#projectReadAuthority,
      maximumRequestBytes: options.config.repository.outputMaxBytes,
      maximumResponseBytes: options.config.developmentBootstrap.maxRepositoryBytes,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      principalAdapter,
    });
    const gitReceivePackRoutes = new GitReceivePackRoutes({
      authority: this.#projectPersonalRefAuthority,
      maximumRequestBytes: COLLAB_CLOUD_BINDING_LIMITS.maxGitReceivePackBytes,
      maximumResponseBytes: options.config.repository.outputMaxBytes,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      principalAdapter,
    });
    this.#httpServer = new HttpServer({
      config: options.config.http,
      isReady: () => this.#state === 'ready',
      routes: [
        capabilitiesRoute,
        bootstrapRoutes,
        projectSnapshotRoutes,
        projectCollaborationRoutes,
        gitReceivePackRoutes,
        gitUploadPackRoutes,
      ],
      upgradeRoutes: [this.#projectEventRoutes],
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
      await this.#repositoryPublication.verifyCapability();
      this.#assertStarting();

      phase = 'authority';
      await this.#authorityVolumePair.verify();
      this.#assertStarting();

      phase = 'recovery';
      await this.#recoveryCoordinator.recoverAll();
      await this.#bootstrapExpiryReconciler.reconcileAll();
      phase = 'repository';
      await this.#activeRepositoryIntegrity.verifyAll();
      this.#bootstrapExpiryReconciler.start();
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
    const results: boolean[] = [];

    const httpClose = this.#httpServer.close(Math.max(1, deadline - Date.now()));
    this.#recoveryCoordinator.close();
    const eventAdmissionClose = this.#projectEventAdmission.close();
    const eventClose = this.#projectEventRoutes.close();
    this.#projectEventWakeup.close();
    const readClose = this.#projectReadAuthority.close();
    const requestClose = this.#projectRequestAuthority.close();
    const acceptClose = this.#acceptCoordinator.close();
    const personalRefClose = this.#projectPersonalRefAuthority.close();
    const ticketClose = this.#projectTicketAuthority.close();
    results.push(await settleBefore(eventClose, deadline));
    results.push(await settleBefore(eventAdmissionClose, deadline));
    results.push(await settleBefore(readClose, deadline));
    results.push(await settleBefore(requestClose, deadline));
    results.push(await settleBefore(acceptClose, deadline));
    results.push(await settleBefore(personalRefClose, deadline));
    results.push(await settleBefore(ticketClose, deadline));
    results.push(await settleBefore(httpClose, deadline));
    results.push(await settleBefore(this.#bootstrapExpiryReconciler.close(), deadline));
    results.push(await settleBefore(this.#activationCoordinator.close(), deadline));
    results.push(await settleBefore(this.#bundleImporter.close(), deadline));
    results.push(await settleBefore(this.#bootstrapUploadAdmission.close(), deadline));
    this.#repositoryPublication.close();
    results.push(await settleBefore(this.#bootstrapRepositoryIntegrity.close(), deadline));
    results.push(await settleBefore(this.#repositoryAuthority.close(), deadline));
    results.push(await settleBefore(this.#resourceAdmission.close(), deadline));
    results.push(await settleBefore(this.#coordination.close(), deadline));

    if (results.includes(false)) throw new ApplicationError('shutdown-failed');
  }
}

export function createApplication(options: CreateApplicationOptions): Application {
  return new CloudApplication(options);
}
