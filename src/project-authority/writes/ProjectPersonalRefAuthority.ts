import {
  collabMemberRef,
  type CollabGitOid,
  type CollabMemberId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type { IngressPrincipal } from '../../request-context/IngressPrincipal.js';
import type { RepositoryPlacementLease } from '../../repositories/RepositoryPlacement.js';
import {
  ProjectWriteAdmission,
  ProjectWriteAdmissionError,
  type ProjectRecoveryPort,
  type ProjectWriteAdmissionCoordination,
} from '../admission/ProjectWriteAdmission.js';

export interface ProjectReceivePackReservation {
  readonly projectId: CollabProjectId;
  close(): Promise<void>;
}

export interface ProjectPersonalRefAdvertisementOptions {
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly signal?: AbortSignal;
}

export interface ProjectPersonalRefReceiveOptions {
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly onResponseChunk: (
    chunk: Buffer,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly request: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface ProjectPersonalRefRepositoryOperation {
  readonly expectedMainOid: CollabGitOid;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal: AbortSignal;
}

export interface ProjectPersonalRefRepository {
  advertiseReceivePack(
    reservation: ProjectReceivePackReservation,
    placement: RepositoryPlacementLease,
    options: ProjectPersonalRefRepositoryOperation & ProjectPersonalRefAdvertisementOptions,
  ): Promise<Buffer>;
  reserveReceivePack(
    projectId: CollabProjectId,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<ProjectReceivePackReservation>;
  runReceivePack(
    reservation: ProjectReceivePackReservation,
    placement: RepositoryPlacementLease,
    options: ProjectPersonalRefRepositoryOperation & ProjectPersonalRefReceiveOptions,
  ): Promise<void>;
}

export interface ProjectPersonalRefAuthorityOptions {
  readonly coordination: ProjectWriteAdmissionCoordination;
  readonly recovery: ProjectRecoveryPort;
  readonly repository: ProjectPersonalRefRepository;
}

export class ProjectPersonalRefAuthority {
  readonly #admission: ProjectWriteAdmission;
  readonly #controllers = new Set<AbortController>();
  readonly #repository: ProjectPersonalRefRepository;
  readonly #running = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: ProjectPersonalRefAuthorityOptions) {
    this.#admission = new ProjectWriteAdmission({
      coordination: options.coordination,
      recovery: options.recovery,
    });
    this.#repository = options.repository;
  }

  advertiseReceivePack(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options: ProjectPersonalRefAdvertisementOptions = {},
  ): Promise<Buffer> {
    return this.#run(options.signal, async signal => {
      await this.#admission.preflight(principal, projectId, { signal });
      return this.#withReservation(
        projectId,
        signal,
        reservation => this.#admission.run(
          principal,
          projectId,
          write => this.#repository.advertiseReceivePack(
            reservation,
            write.placement,
            {
              expectedMainOid: write.expectedMainOid,
              ...(options.gitProtocol === undefined
                ? {}
                : { gitProtocol: options.gitProtocol }),
              memberId: write.memberId,
              personalRef: collabMemberRef(write.memberId),
              revalidateAuthority: write.revalidate,
              signal,
            },
          ),
          { signal },
        ),
      );
    });
  }

  runReceivePack(
    principal: IngressPrincipal,
    projectId: CollabProjectId,
    options: ProjectPersonalRefReceiveOptions,
  ): Promise<void> {
    return this.#run(options.signal, async signal => {
      await this.#admission.preflight(principal, projectId, { signal });
      return this.#withReservation(
        projectId,
        signal,
        reservation => this.#admission.run(
          principal,
          projectId,
          write => this.#repository.runReceivePack(
            reservation,
            write.placement,
            {
              ...options,
              expectedMainOid: write.expectedMainOid,
              memberId: write.memberId,
              personalRef: collabMemberRef(write.memberId),
              revalidateAuthority: write.revalidate,
              signal,
            },
          ),
          { signal },
        ),
      );
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      const admissionClose = this.#admission.close();
      for (const controller of this.#controllers) controller.abort();
      this.#closePromise = Promise.allSettled([
        admissionClose,
        ...this.#running,
      ]).then(() => undefined);
    }
    return this.#closePromise;
  }

  async #withReservation<T>(
    projectId: CollabProjectId,
    signal: AbortSignal,
    operation: (reservation: ProjectReceivePackReservation) => Promise<T>,
  ): Promise<T> {
    const reservation = await this.#repository.reserveReceivePack(projectId, { signal });
    try {
      return await operation(reservation);
    } finally {
      await reservation.close();
    }
  }

  #run<T>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new ProjectWriteAdmissionError('closed'));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted === true) controller.abort();
    this.#controllers.add(controller);
    const result = Promise.resolve().then(() => operation(controller.signal));
    const tracked = result.then(() => undefined, () => undefined).finally(() => {
      externalSignal?.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
    });
    this.#running.add(tracked);
    void tracked.finally(() => this.#running.delete(tracked));
    return result;
  }
}
