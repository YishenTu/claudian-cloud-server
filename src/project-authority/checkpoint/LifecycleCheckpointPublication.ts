import type { CollabIsoTimestamp } from '@claudian-collab/protocol';
import type { CollabCheckpointProfile } from '@claudian-collab/protocol';

import {
  productionCheckpointAttemptIdentity,
  ProductionCheckpointStagingError,
  type InspectedProductionCheckpointAttempt,
  type PreparedProductionCheckpointAttempt,
  type ProductionCheckpointDeliveryCatalogPort,
  type ProductionCheckpointDeliveryPage,
  type ProductionCheckpointStagingPort,
  type StagedProductionCheckpointArtifact,
} from '../../onboarding/production/ProductionCheckpointStaging.js';

const RETAINED_UNTIL = '9999-12-31T23:59:59.999Z' as CollabIsoTimestamp;

export interface LifecycleCheckpointPublicationStore
  extends ProductionCheckpointStagingPort {
  readonly listDueAttemptDeliveries?:
    ProductionCheckpointDeliveryCatalogPort['listDueAttemptDeliveries'];
  readonly registerAttemptDelivery?:
    ProductionCheckpointDeliveryCatalogPort['registerAttemptDelivery'];
  releaseAttemptReservation(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ExportCheckpointPublicationPort
  extends ProductionCheckpointStagingPort {
  listDueDeliveries(
    options: Parameters<
      ProductionCheckpointDeliveryCatalogPort['listDueAttemptDeliveries']
    >[0],
    signal?: AbortSignal,
  ): Promise<ProductionCheckpointDeliveryPage>;
  registerDelivery(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<'registered' | 'replayed'>;
}

function exactPreparedAttempt(
  attempt: PreparedProductionCheckpointAttempt,
): PreparedProductionCheckpointAttempt {
  const exact = productionCheckpointAttemptIdentity(attempt);
  if (exact.attemptKey !== attempt.attemptKey) {
    throw new ProductionCheckpointStagingError('invalid-attempt');
  }
  return exact;
}

function retainedAttempt(
  attempt: PreparedProductionCheckpointAttempt,
): PreparedProductionCheckpointAttempt {
  const exact = exactPreparedAttempt(attempt);
  return Object.freeze({ ...exact, expiresAt: RETAINED_UNTIL });
}

/**
 * Owns published checkpoint retention independently from onboarding expiry.
 * Deletion is explicit and may only be invoked by lifecycle/retention policy.
 */
export class LifecycleCheckpointPublication
implements ProductionCheckpointStagingPort {
  readonly #profile: Extract<CollabCheckpointProfile, 'backup' | 'export'>;
  readonly #store: LifecycleCheckpointPublicationStore;

  constructor(
    store: LifecycleCheckpointPublicationStore,
    profile: Extract<CollabCheckpointProfile, 'backup' | 'export'>,
  ) {
    const candidate: unknown = profile;
    if (candidate !== 'backup' && candidate !== 'export') {
      throw new TypeError('lifecycle-checkpoint-publication.profile-invalid');
    }
    this.#profile = profile;
    if (
      profile === 'export'
      && (
        typeof store.listDueAttemptDeliveries !== 'function'
        || typeof store.registerAttemptDelivery !== 'function'
      )
    ) {
      throw new TypeError('lifecycle-checkpoint-publication.store-invalid');
    }
    this.#store = store;
  }

  #storedAttempt(
    attempt: PreparedProductionCheckpointAttempt,
  ): PreparedProductionCheckpointAttempt {
    return retainedAttempt(attempt);
  }

  async discardAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<'removed' | 'replayed'> {
    return await this.#store.discardAttempt(this.#storedAttempt(attempt), signal);
  }

  async expireAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    expiredBefore: CollabIsoTimestamp,
    signal?: AbortSignal,
  ): Promise<'expired' | 'replayed' | 'retained'> {
    const external = exactPreparedAttempt(attempt);
    if (this.#profile === 'backup' || external.expiresAt > expiredBefore) {
      return await Promise.resolve('retained');
    }
    return await this.#store.discardAttempt(retainedAttempt(external), signal)
      .then(result => result === 'removed' ? 'expired' : 'replayed');
  }

  listDueDeliveries(
    options: Parameters<
      ProductionCheckpointDeliveryCatalogPort['listDueAttemptDeliveries']
    >[0],
    signal?: AbortSignal,
  ): Promise<ProductionCheckpointDeliveryPage> {
    if (this.#profile !== 'export') {
      return Promise.reject(new ProductionCheckpointStagingError(
        'invalid-attempt',
      ));
    }
    const list = this.#store.listDueAttemptDeliveries;
    if (list === undefined) {
      return Promise.reject(new ProductionCheckpointStagingError(
        'storage-unavailable',
      ));
    }
    return list.call(this.#store, options, signal).then(page => (
      Object.freeze({
        deliveries: Object.freeze(page.deliveries.map(exactPreparedAttempt)),
        nextCursor: page.nextCursor,
      })
    ));
  }

  registerDelivery(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<'registered' | 'replayed'> {
    if (this.#profile !== 'export') {
      return Promise.reject(new ProductionCheckpointStagingError(
        'invalid-attempt',
      ));
    }
    const external = exactPreparedAttempt(attempt);
    const register = this.#store.registerAttemptDelivery;
    if (register === undefined) {
      return Promise.reject(new ProductionCheckpointStagingError(
        'storage-unavailable',
      ));
    }
    return register.call(this.#store, {
      attempt: retainedAttempt(external),
      expiresAt: external.expiresAt,
    }, signal);
  }

  async inspectAttempt(
    attempt: PreparedProductionCheckpointAttempt,
    signal?: AbortSignal,
  ): Promise<InspectedProductionCheckpointAttempt> {
    const external = exactPreparedAttempt(attempt);
    const stored = this.#storedAttempt(external);
    return await this.#store.inspectAttempt(stored, signal).then(
      inspected => Object.freeze({
        artifacts: inspected.artifacts,
        attempt: external,
      }),
    );
  }

  prepareAttempt(
    input: Readonly<{
      readonly expiresAt: CollabIsoTimestamp;
      readonly operationId: string;
      readonly projectId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<PreparedProductionCheckpointAttempt> {
    const external = productionCheckpointAttemptIdentity(input);
    const stored = this.#storedAttempt(external);
    return this.#store.prepareAttempt(stored, signal).then(async () => {
      await this.#store.releaseAttemptReservation(stored);
      return external;
    });
  }

  async readArtifact(
    input: Parameters<ProductionCheckpointStagingPort['readArtifact']>[0],
  ): Promise<void> {
    const attempt = this.#storedAttempt(input.attempt);
    await this.#store.prepareAttempt(attempt, input.signal);
    try {
      return await this.#store.readArtifact(Object.freeze({
        ...input,
        attempt,
      }));
    } finally {
      await this.#store.releaseAttemptReservation(attempt);
    }
  }

  async receiveArtifact(
    input: Parameters<ProductionCheckpointStagingPort['receiveArtifact']>[0],
  ): Promise<StagedProductionCheckpointArtifact> {
    const attempt = this.#storedAttempt(input.attempt);
    await this.#store.prepareAttempt(attempt, input.signal);
    try {
      return await this.#store.receiveArtifact(Object.freeze({
        ...input,
        attempt,
      }));
    } finally {
      await this.#store.releaseAttemptReservation(attempt);
    }
  }
}
