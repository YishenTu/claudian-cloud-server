import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  GitBundleImportError,
  type ImportRepositoryCheckpointInput,
  type RepositoryCheckpointStagingPort,
  type ValidatedRepositoryCheckpoint,
} from './GitBundleImporter.js';

/** Bridges a bounded artifact reader to the importer's consumed/replayed contract. */
export async function importRepositoryCheckpoint(
  repository: RepositoryCheckpointStagingPort,
  input: Omit<ImportRepositoryCheckpointInput, 'body' | 'signal'> & {
    readonly signal: AbortSignal;
  },
  readSource: (input: Readonly<{
    readonly onChunk: (chunk: Buffer, signal: AbortSignal) => Promise<void>;
    readonly signal: AbortSignal;
  }>) => Promise<void>,
): Promise<ValidatedRepositoryCheckpoint> {
  const body = new PassThrough({ highWaterMark: 64 * 1024 });
  // A replay can leave the readable side unobserved when delivery is cancelled.
  body.on('error', () => undefined);
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const delivery: { failure: Error | undefined; settled: boolean } = {
    failure: undefined,
    settled: false,
  };
  const pump = Promise.resolve().then(() => readSource({
    onChunk: async chunk => {
      signal.throwIfAborted();
      if (!body.write(chunk)) await once(body, 'drain', { signal });
    },
    signal,
  })).then(
    () => {
      delivery.settled = true;
      body.end();
    },
    (error: unknown) => {
      delivery.failure = error instanceof Error
        ? error
        : new GitBundleImportError('storage-unavailable');
      delivery.settled = true;
      body.destroy(new GitBundleImportError('storage-unavailable'));
    },
  );
  try {
    let imported: ValidatedRepositoryCheckpoint | undefined;
    let importFailure: Error | undefined;
    try {
      imported = await repository.importCheckpoint({ ...input, body });
    } catch (error: unknown) {
      importFailure = error instanceof Error
        ? error
        : new GitBundleImportError('storage-unavailable');
    }
    const replayed = imported?.bundleInputDisposition === 'replayed';
    const returnedEarly = imported?.bundleInputDisposition === 'consumed' && !delivery.settled;
    const failedBeforeImport = delivery.failure !== undefined;
    if (!delivery.settled) {
      if (returnedEarly) {
        body.resume();
      } else {
        controller.abort('cancelled');
        body.destroy();
      }
    }
    await pump;
    if (input.signal.aborted) {
      throw new GitBundleImportError(input.signal.reason === 'closed' ? 'closed' : 'cancelled');
    }
    if (failedBeforeImport && delivery.failure !== undefined && !replayed) throw delivery.failure;
    if (importFailure !== undefined) throw importFailure;
    if (delivery.failure !== undefined && !replayed) throw delivery.failure;
    if (returnedEarly) throw new GitBundleImportError('artifact-invalid');
    if (imported === undefined) throw new GitBundleImportError('storage-unavailable');
    return imported;
  } finally {
    controller.abort('cancelled');
    body.destroy();
    await pump;
  }
}
