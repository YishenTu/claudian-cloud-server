import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_LIMITS,
  type CollabCloudCapability,
} from '@claudian-collab/protocol';
import { dirname } from 'node:path';

import type { ClaimCustodyKeyringConfig } from '../config/ClaimCustodyKeyringConfig.js';
import { CURRENT_POSTGRES_SCHEMA_VERSION } from '../config/PostgresSchemaCompatibility.js';
import {
  REPOSITORY_FORMAT_VERSION,
  SERVER_BUILD,
} from '../config/ServerBuild.js';
import type { ServerConfig } from '../config/ServerConfig.js';
import { CoordinationError } from '../coordination/CoordinationError.js';
import { PostgresCoordination } from '../coordination/postgres/PostgresCoordination.js';
import { DevelopmentBootstrapProfile } from '../onboarding/development/DevelopmentBootstrapProfile.js';
import { DevelopmentBootstrapExpiryReconciler } from '../onboarding/development/DevelopmentBootstrapExpiryReconciler.js';
import type { SafeLogger } from '../observability/SafeLogger.js';
import { ProjectAcceptCoordinator } from '../project-authority/acceptance/ProjectAcceptCoordinator.js';
import { CloudProjectCreationCoordinator } from '../project-authority/creation/CloudProjectCreationCoordinator.js';
import { CloudProjectJoinCoordinator } from '../project-authority/membership/CloudProjectJoinCoordinator.js';
import { ProjectInvitationAuthority } from '../project-authority/membership/ProjectInvitationAuthority.js';
import { ProjectMembershipAdministrationAuthority } from '../project-authority/membership/ProjectMembershipAdministrationAuthority.js';
import { ProjectMemberRemovalCoordinator } from '../project-authority/membership/ProjectMemberRemovalCoordinator.js';
import { ProjectMembershipExpiryReconciler } from '../project-authority/membership/ProjectMembershipExpiryReconciler.js';
import { LeaveCoordinator } from '../project-authority/lifecycle/leave/LeaveCoordinator.js';
import { TransferredMembershipClaimAuthority } from '../project-authority/membership/TransferredMembershipClaimAuthority.js';
import { ProjectWriteAdmission } from '../project-authority/admission/ProjectWriteAdmission.js';
import { ProtectedSecretCustody } from '../project-authority/lifecycle/ProtectedSecretCustody.js';
import { ProjectActivationCoordinator } from '../project-authority/lifecycle/ProjectActivationCoordinator.js';
import { ProjectReadAuthority } from '../project-authority/reads/ProjectReadAuthority.js';
import { ProjectRequestAuthority } from '../project-authority/requests/ProjectRequestAuthority.js';
import { ProjectTicketAuthority } from '../project-authority/tickets/ProjectTicketAuthority.js';
import { ProjectPersonalRefAuthority } from '../project-authority/writes/ProjectPersonalRefAuthority.js';
import { ProjectRecoveryCoordinator } from '../project-authority/recovery/ProjectRecoveryCoordinator.js';
import { ProjectEventWakeup } from '../project-authority/reads/ProjectEventWakeup.js';
import { ActiveRepositoryIntegrityGate } from '../project-authority/lifecycle/ActiveRepositoryIntegrityGate.js';
import { ActiveClaimCustodyKeyReferenceGate } from '../project-authority/lifecycle/ActiveClaimCustodyKeyReferenceGate.js';
import { XChaCha20ClaimCustody } from '../project-authority/lifecycle/cloud-to-lan/XChaCha20ClaimCustody.js';
import { ClaimCustodyKeyReferenceVerifier } from '../environment-maintenance/commands/ClaimCustodyKeyReferenceVerifier.js';
import { EnvironmentBackupMetadataSource } from '../environment-maintenance/commands/EnvironmentBackupMetadataSource.js';
import { FileEnvironmentRestoreState } from '../environment-maintenance/restore/FileEnvironmentRestoreState.js';
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
import { EmptyProjectRepositoryAuthority } from '../repositories/EmptyProjectRepositoryAuthority.js';
import { RepositoryCheckpointAuthority } from '../repositories/RepositoryCheckpointAuthority.js';
import { DevelopmentPrincipalAdapter } from '../request-context/DevelopmentPrincipalAdapter.js';
import { TrustedPrincipalProvider } from '../request-context/TrustedPrincipalProvider.js';
import { BootstrapUploadAdmission } from '../resource-admission/BootstrapUploadAdmission.js';
import { ProjectEventAdmission } from '../resource-admission/ProjectEventAdmission.js';
import { GitReceiveAdmission } from '../resource-admission/GitReceiveAdmission.js';
import { ResourceAdmission } from '../resource-admission/ResourceAdmission.js';
import { CloudCapabilitiesRoute } from '../server/CloudCapabilitiesRoute.js';
import { DevelopmentBootstrapRoutes } from '../server/DevelopmentBootstrapRoutes.js';
import { ProjectSnapshotRoutes } from '../server/control/ProjectSnapshotRoutes.js';
import { ProjectCollaborationRoutes } from '../server/control/ProjectCollaborationRoutes.js';
import { ProjectLifecycleRoutes } from '../server/control/ProjectLifecycleRoutes.js';
import { CloudProjectMembershipRoutes } from '../server/control/CloudProjectMembershipRoutes.js';
import type { TrustedProjectPrincipalBinding } from '../server/control/ProjectJsonTransport.js';
import { ProjectEventRoutes } from '../server/events/ProjectEventRoutes.js';
import { GitUploadPackRoutes } from '../server/git/GitUploadPackRoutes.js';
import { GitReceivePackRoutes } from '../server/git/GitReceivePackRoutes.js';
import { AuthorityTransferArtifactRoutes } from '../server/transfer/AuthorityTransferArtifactRoutes.js';
import {
  HttpServer,
  type HttpServerAddress,
} from '../server/HttpServer.js';
import { ProxyV2Ingress } from '../server/ProxyV2Ingress.js';
import {
  AuthorityVolumePairError,
  AuthorityVolumePairVerifier,
} from './AuthorityVolumePairVerifier.js';
import type { CloudLifecycleRuntime } from './CloudLifecycleRuntime.js';
import { createProductionCloudLifecycleRuntime } from './ProductionCloudLifecycleRuntime.js';

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
  readonly keyring?: ClaimCustodyKeyringConfig;
  readonly lifecycle?: CloudLifecycleRuntime;
  readonly logger: SafeLogger;
  readonly trustedPrincipal?: TrustedProjectPrincipalBinding;
}

type ApplicationState =
  | 'created'
  | 'ready'
  | 'starting'
  | 'stopped'
  | 'stopping';

type StartupPhase =
  | 'authority'
  | 'http'
  | 'keyring'
  | 'postgres'
  | 'recovery'
  | 'repository';

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
  if (phase === 'keyring') return 'keyring-reference-unavailable';
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
  readonly #creationCoordinator: CloudProjectCreationCoordinator;
  readonly #joinCoordinator: CloudProjectJoinCoordinator;
  readonly #invitationAuthority: ProjectInvitationAuthority | undefined;
  readonly #membershipAdministrationAuthority: ProjectMembershipAdministrationAuthority;
  readonly #memberRemovalCoordinator: ProjectMemberRemovalCoordinator;
  readonly #membershipExpiryReconciler: ProjectMembershipExpiryReconciler;
  readonly #leaveCoordinator: LeaveCoordinator;
  readonly #transferredMembershipClaimAuthority: TransferredMembershipClaimAuthority | undefined;
  readonly #membershipWriteAdmission: ProjectWriteAdmission;
  readonly #activationCoordinator: ProjectActivationCoordinator;
  readonly #activeRepositoryIntegrity: ActiveRepositoryIntegrityGate;
  readonly #activeKeyReferences: ActiveClaimCustodyKeyReferenceGate | undefined;
  readonly #authorityVolumePair: AuthorityVolumePairVerifier;
  readonly #bootstrapUploadAdmission: BootstrapUploadAdmission;
  readonly #bootstrapRepositoryIntegrity: BootstrapRepositoryIntegrityVerifier;
  readonly #bundleImporter: GitBundleImporter;
  readonly #bootstrapExpiryReconciler: DevelopmentBootstrapExpiryReconciler;
  readonly #httpServer: HttpServer;
  readonly #logger: SafeLogger;
  readonly #lifecycle: CloudLifecycleRuntime | undefined;
  readonly #projectEventRoutes: ProjectEventRoutes;
  readonly #projectEventAdmission: ProjectEventAdmission;
  readonly #projectEventWakeup: ProjectEventWakeup;
  readonly #projectReadAuthority: ProjectReadAuthority;
  readonly #projectRequestAuthority: ProjectRequestAuthority;
  readonly #projectPersonalRefAuthority: ProjectPersonalRefAuthority;
  readonly #projectTicketAuthority: ProjectTicketAuthority;
  readonly #repositoryAuthority: GitRepositoryAuthority;
  readonly #emptyProjectRepository: EmptyProjectRepositoryAuthority;
  readonly #repositoryPublication: RepositoryPublication;
  readonly #membershipRepositoryMaintenance: RepositoryCheckpointAuthority;
  readonly #recoveryCoordinator: ProjectRecoveryCoordinator;
  readonly #resourceAdmission: ResourceAdmission;
  readonly #startupController = new AbortController();
  #address: HttpServerAddress | undefined;
  #closePromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #startPromise: Promise<HttpServerAddress> | undefined;
  #state: ApplicationState = 'created';

  constructor(options: CreateApplicationOptions) {
    const configuredIngress = options.config.trustedIngress;
    if (
      configuredIngress !== undefined
      && options.trustedPrincipal !== undefined
    ) throw new TypeError('application.principal-binding-conflict');
    if (
      (options.config.principalProfile === 'trusted-ingress')
      !== (configuredIngress !== undefined)
    ) throw new TypeError('application.principal-profile-invalid');
    const productionIngress = configuredIngress === undefined
      ? undefined
      : new ProxyV2Ingress({
          preambleTimeoutMs: configuredIngress.preambleTimeoutMs,
          allowedSources: configuredIngress.allowedSources,
          providerId: configuredIngress.providerId,
        });
    const trustedPrincipal = options.trustedPrincipal ?? (
      productionIngress === undefined
        ? undefined
        : {
            establishedAssertion: productionIngress.establishedAssertion.bind(
              productionIngress,
            ),
            provider: new TrustedPrincipalProvider(),
          }
    );
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
    this.#emptyProjectRepository = new EmptyProjectRepositoryAuthority({
      gitExecutable: options.config.repository.gitExecutable,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      outputMaxBytes: options.config.repository.outputMaxBytes,
      repositoryRoot: options.config.repository.root,
      resourceAdmission: this.#resourceAdmission,
      storageNodeId: options.config.repository.storageNodeId,
    });
    this.#membershipRepositoryMaintenance = new RepositoryCheckpointAuthority({
      gitExecutable: options.config.repository.gitExecutable,
      maximumBlobBytes: COLLAB_LIMITS.maxBlobBytes,
      maximumBundleBytes: options.config.developmentBootstrap.maxBundleBytes,
      maximumExpandedTreeEntries: 100_000,
      maximumRepositoryBytes: options.config.developmentBootstrap.maxRepositoryBytes,
      maximumTreeEntries: COLLAB_LIMITS.maxChangedPaths,
      operationRoot: options.config.developmentBootstrap.stagingRoot,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      outputMaxBytes: options.config.repository.outputMaxBytes,
      placementValidator: this.#coordination,
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
    this.#creationCoordinator = new CloudProjectCreationCoordinator({
      coordination: this.#coordination,
      repository: this.#emptyProjectRepository,
      storageNodeId: options.config.repository.storageNodeId,
    });
    this.#joinCoordinator = new CloudProjectJoinCoordinator({
      coordination: this.#coordination,
      repository: this.#repositoryAuthority,
    });
    this.#memberRemovalCoordinator = new ProjectMemberRemovalCoordinator({
      coordination: this.#coordination,
      repository: this.#membershipRepositoryMaintenance,
    });
    this.#leaveCoordinator = new LeaveCoordinator({
      coordination: this.#coordination,
      repository: this.#membershipRepositoryMaintenance,
    });
    if (
      productionIngress !== undefined
      && options.lifecycle === undefined
      && options.keyring === undefined
    ) throw new TypeError('application.production-lifecycle-keyring-required');
    this.#lifecycle = options.lifecycle ?? (
      productionIngress === undefined || options.keyring === undefined
        ? undefined
        : createProductionCloudLifecycleRuntime({
            config: options.config,
            coordination: this.#coordination,
            importer: this.#bundleImporter,
            keyring: options.keyring,
            leave: this.#leaveCoordinator,
            removal: this.#memberRemovalCoordinator,
            repository: this.#membershipRepositoryMaintenance,
          })
    );
    this.#recoveryCoordinator = new ProjectRecoveryCoordinator({
      accept: this.#acceptCoordinator,
      activation: this.#activationCoordinator,
      catalog: this.#coordination,
      creation: this.#creationCoordinator,
      isolation: this.#coordination,
      leave: this.#leaveCoordinator,
      membership: this.#joinCoordinator,
      removal: this.#memberRemovalCoordinator,
      ...(this.#lifecycle === undefined
        ? {}
        : { lifecycle: this.#lifecycle.recovery }),
    });
    this.#membershipWriteAdmission = new ProjectWriteAdmission({
      coordination: this.#coordination,
      recovery: this.#recoveryCoordinator,
    });
    const protectedSecretCustody = options.keyring === undefined
      ? undefined
      : new ProtectedSecretCustody({
          activeKeyId: options.keyring.activeEncryptionKeyId,
          keys: options.keyring.encryptionKeys,
        });
    this.#invitationAuthority = protectedSecretCustody === undefined
      ? undefined
      : new ProjectInvitationAuthority({
        custody: protectedSecretCustody,
        writeAdmission: this.#membershipWriteAdmission,
      });
    this.#transferredMembershipClaimAuthority = protectedSecretCustody === undefined
      ? undefined
      : new TransferredMembershipClaimAuthority({
        custody: protectedSecretCustody,
        writeAdmission: this.#membershipWriteAdmission,
      });
    this.#membershipAdministrationAuthority = new ProjectMembershipAdministrationAuthority({
      writeAdmission: this.#membershipWriteAdmission,
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
    const metadataSource = new EnvironmentBackupMetadataSource({
      state: new FileEnvironmentRestoreState({
        authorityRoot: dirname(options.config.repository.root),
      }),
    });
    this.#activeKeyReferences = options.keyring === undefined
      ? undefined
      : new ActiveClaimCustodyKeyReferenceGate({
        coordination: this.#coordination,
        metadata: {
          read: async () => Object.freeze({
            ...await metadataSource.read(),
            coordinationSchemaVersion: CURRENT_POSTGRES_SCHEMA_VERSION,
            repositoryFormatVersion: REPOSITORY_FORMAT_VERSION,
            serverBuild: SERVER_BUILD,
          }),
        },
        verifier: new ClaimCustodyKeyReferenceVerifier({
          custody: new XChaCha20ClaimCustody({
            activeKeyId: options.keyring.activeEncryptionKeyId,
            keys: options.keyring.encryptionKeys,
          }),
          membershipCustody: new ProtectedSecretCustody({
            activeKeyId: options.keyring.activeEncryptionKeyId,
            keys: options.keyring.encryptionKeys,
          }),
          keyring: options.keyring,
        }),
      });
    this.#bootstrapExpiryReconciler = new DevelopmentBootstrapExpiryReconciler({
      catalog: this.#coordination,
      settlement: this.#activationCoordinator,
    });
    this.#membershipExpiryReconciler = new ProjectMembershipExpiryReconciler({
      coordination: this.#coordination,
    });
    const bootstrapProfile = new DevelopmentBootstrapProfile({
      attemptTtlMs: options.config.developmentBootstrap.attemptTtlMs,
      importer: this.#bundleImporter,
      persistence: this.#coordination,
      settlement: this.#activationCoordinator,
      uploadGate: developmentBootstrapUploadGate,
    });
    const enabledCapabilities = new Set<CollabCloudCapability>([
        'accept',
        'git-receive-pack-personal-ref',
        'git-upload-pack',
        'project-events',
        'project-snapshot',
        'requests',
        'tickets',
      ] as const);
    if (
      trustedPrincipal === undefined
      && options.config.principalProfile === 'private-development'
    ) {
      enabledCapabilities.add('development-bootstrap');
    }
    if (this.#lifecycle !== undefined) {
      enabledCapabilities.add('authority-transfer');
      enabledCapabilities.add('project-retirement');
    }
    if (trustedPrincipal !== undefined) {
      enabledCapabilities.add('cloud-project-create');
      enabledCapabilities.add('cloud-project-join');
      enabledCapabilities.add('cloud-project-leave');
      enabledCapabilities.add('cloud-project-manager-responsibility');
      enabledCapabilities.add('cloud-project-membership');
      if (this.#invitationAuthority !== undefined) {
        enabledCapabilities.add('cloud-project-invitations');
      }
      if (this.#transferredMembershipClaimAuthority !== undefined) {
        enabledCapabilities.add('cloud-imported-membership-claims');
      }
    }
    const capabilitiesRoute = new CloudCapabilitiesRoute({
      enabledCapabilities,
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
    const principalBinding = trustedPrincipal === undefined
      ? {
        principalAdapter: new DevelopmentPrincipalAdapter({
          profile: 'loopback-development',
        }),
      }
      : { trustedPrincipal };
    const principalAdapter = 'principalAdapter' in principalBinding
      ? principalBinding.principalAdapter
      : undefined;
    const bootstrapRoutes = principalAdapter === undefined
      ? undefined
      : new DevelopmentBootstrapRoutes({
        maximumJsonBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
        principalAdapter,
        profile: bootstrapProfile,
      });
    const lifecycleControl = this.#lifecycle?.control;
    const projectSnapshotRoutes = new ProjectSnapshotRoutes({
      authority: this.#projectReadAuthority,
      maximumJsonBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      ...principalBinding,
      ...(lifecycleControl === undefined
        ? {}
        : { retirementTerminal: lifecycleControl }),
    });
    const projectCollaborationRoutes = new ProjectCollaborationRoutes({
      acceptAuthority: this.#acceptCoordinator,
      maximumJsonBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      ...principalBinding,
      requestAuthority: this.#projectRequestAuthority,
      ticketAuthority: this.#projectTicketAuthority,
    });
    const cloudProjectMembershipRoutes = trustedPrincipal === undefined
      ? undefined
      : new CloudProjectMembershipRoutes({
        administration: this.#membershipAdministrationAuthority,
        creation: this.#creationCoordinator,
        join: this.#joinCoordinator,
        leave: this.#leaveCoordinator,
        maximumJsonBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
        operationTimeoutMs: options.config.repository.operationTimeoutMs,
        removal: this.#memberRemovalCoordinator,
        ...(this.#invitationAuthority === undefined
          ? {}
          : { invitation: this.#invitationAuthority }),
        ...(this.#transferredMembershipClaimAuthority === undefined
          ? {}
          : { claims: this.#transferredMembershipClaimAuthority }),
        ...principalBinding,
      });
    const projectLifecycleRoutes = this.#lifecycle === undefined
      ? undefined
      : new ProjectLifecycleRoutes({
        control: this.#lifecycle.control,
        maximumJsonBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
        operationTimeoutMs: options.config.repository.operationTimeoutMs,
        ...principalBinding,
      });
    const authorityTransferArtifactRoutes = this.#lifecycle === undefined
      ? undefined
      : new AuthorityTransferArtifactRoutes({
        authority: this.#lifecycle.artifacts,
        limits: {
          'checkpoint.json': COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
          'coordination.ndjson': COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
          'repository.bundle':
            COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
        },
        operationTimeoutMs: options.config.developmentBootstrap.uploadDeadlineMs,
        ...principalBinding,
      });
    this.#projectEventRoutes = new ProjectEventRoutes({
      admission: this.#projectEventAdmission,
      authority: this.#projectReadAuthority,
      maximumBufferedBytes: options.config.repository.outputMaxBytes,
      ...principalBinding,
      wakeup: this.#projectEventWakeup,
    });
    const gitUploadPackRoutes = new GitUploadPackRoutes({
      authority: this.#projectReadAuthority,
      maximumRequestBytes: options.config.repository.outputMaxBytes,
      maximumResponseBytes: options.config.developmentBootstrap.maxRepositoryBytes,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      ...principalBinding,
    });
    const gitReceivePackRoutes = new GitReceivePackRoutes({
      authority: this.#projectPersonalRefAuthority,
      maximumRequestBytes: COLLAB_CLOUD_BINDING_LIMITS.maxGitReceivePackBytes,
      maximumResponseBytes: options.config.repository.outputMaxBytes,
      operationTimeoutMs: options.config.repository.operationTimeoutMs,
      ...principalBinding,
    });
    this.#httpServer = new HttpServer({
      config: options.config.http,
      ...(productionIngress === undefined
        ? {}
        : { connectionIngress: productionIngress }),
      isReady: () => this.#state === 'ready',
      routes: [
        capabilitiesRoute,
        ...(bootstrapRoutes === undefined ? [] : [bootstrapRoutes]),
        projectSnapshotRoutes,
        ...(cloudProjectMembershipRoutes === undefined
          ? []
          : [cloudProjectMembershipRoutes]),
        projectCollaborationRoutes,
        ...(projectLifecycleRoutes === undefined ? [] : [projectLifecycleRoutes]),
        ...(authorityTransferArtifactRoutes === undefined
          ? []
          : [authorityTransferArtifactRoutes]),
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
      await this.#lifecycle?.reconcileAll();
      await this.#bootstrapExpiryReconciler.reconcileAll();
      await this.#membershipExpiryReconciler.reconcileAll();
      phase = 'keyring';
      await this.#activeKeyReferences?.verifyAll(
        this.#startupController.signal,
      );
      phase = 'repository';
      await this.#activeRepositoryIntegrity.verifyAll();
      this.#assertStarting();

      phase = 'http';
      const address = await this.#httpServer.start();
      this.#assertStarting();

      this.#address = address;
      this.#state = 'ready';
      this.#bootstrapExpiryReconciler.start();
      this.#membershipExpiryReconciler.start();
      this.#lifecycle?.start();
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
    this.#startupController.abort('closed');
    const deadline = Date.now() + this.#config.shutdownTimeoutMs;
    const results: boolean[] = [];

    const httpClose = this.#httpServer.close(Math.max(1, deadline - Date.now()));
    this.#recoveryCoordinator.close();
    const lifecycleClose = this.#lifecycle?.close(
      Math.max(1, deadline - Date.now()),
    ) ?? Promise.resolve();
    const eventAdmissionClose = this.#projectEventAdmission.close();
    const eventClose = this.#projectEventRoutes.close();
    this.#projectEventWakeup.close();
    const readClose = this.#projectReadAuthority.close();
    const requestClose = this.#projectRequestAuthority.close();
    const acceptClose = this.#acceptCoordinator.close();
    const creationClose = this.#creationCoordinator.close();
    const joinClose = this.#joinCoordinator.close();
    const memberRemovalClose = this.#memberRemovalCoordinator.close();
    const leaveClose = this.#leaveCoordinator.close();
    const membershipWriteClose = this.#membershipWriteAdmission.close();
    const personalRefClose = this.#projectPersonalRefAuthority.close();
    const ticketClose = this.#projectTicketAuthority.close();
    results.push(await settleBefore(eventClose, deadline));
    results.push(await settleBefore(eventAdmissionClose, deadline));
    results.push(await settleBefore(readClose, deadline));
    results.push(await settleBefore(requestClose, deadline));
    results.push(await settleBefore(acceptClose, deadline));
    results.push(await settleBefore(creationClose, deadline));
    results.push(await settleBefore(joinClose, deadline));
    results.push(await settleBefore(memberRemovalClose, deadline));
    results.push(await settleBefore(leaveClose, deadline));
    results.push(await settleBefore(membershipWriteClose, deadline));
    results.push(await settleBefore(personalRefClose, deadline));
    results.push(await settleBefore(ticketClose, deadline));
    results.push(await settleBefore(httpClose, deadline));
    results.push(await settleBefore(lifecycleClose, deadline));
    results.push(await settleBefore(this.#bootstrapExpiryReconciler.close(), deadline));
    results.push(await settleBefore(this.#membershipExpiryReconciler.close(), deadline));
    results.push(await settleBefore(this.#activationCoordinator.close(), deadline));
    results.push(await settleBefore(
      this.#membershipRepositoryMaintenance.close(),
      deadline,
    ));
    results.push(await settleBefore(this.#bundleImporter.close(), deadline));
    results.push(await settleBefore(this.#bootstrapUploadAdmission.close(), deadline));
    this.#repositoryPublication.close();
    results.push(await settleBefore(this.#bootstrapRepositoryIntegrity.close(), deadline));
    results.push(await settleBefore(this.#repositoryAuthority.close(), deadline));
    results.push(await settleBefore(this.#emptyProjectRepository.close(), deadline));
    results.push(await settleBefore(this.#resourceAdmission.close(), deadline));
    results.push(await settleBefore(this.#coordination.close(), deadline));

    if (results.includes(false)) throw new ApplicationError('shutdown-failed');
  }
}

export function createApplication(options: CreateApplicationOptions): Application {
  return new CloudApplication(options);
}
