import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import {
  CollabError,
  decodeCollabProjectCheckpointManifest,
  encodeCollabProjectCheckpointManifestCanonicalJson,
  encodeCollabProjectCheckpointManifestDigestInput,
  type CollabAuthorityTransferStatus,
  type CollabCloudAuthorityTransferArtifact,
  type CollabProjectCheckpointManifest,
} from '@claudian-collab/protocol';

import {
  productionCheckpointAttemptIdentity,
  type PreparedProductionCheckpointAttempt,
  type ProductionCheckpointStagingPort,
  type StagedProductionCheckpointArtifact,
} from '../../onboarding/production/ProductionCheckpointStaging.js';
import type { CloudToLanTransferCoordinator } from './cloud-to-lan/CloudToLanTransferCoordinator.js';
import type { LanToCloudTransferCoordinator } from './lan-to-cloud/LanToCloudTransferCoordinator.js';
import type {
  AuthorityTransferArtifactAuthority as ArtifactAuthority,
  AuthorityTransferArtifactDownload,
  AuthorityTransferArtifactUpload,
} from '../../server/transfer/AuthorityTransferArtifactRoutes.js';

const MAXIMUM_MANIFEST_BYTES = 1_048_576;

function failure(code: 'authorization-denied' | 'operation-failed'): never {
  throw new CollabError({
    code,
    ...(code === 'operation-failed' ? { recoveryActions: ['retry'] as const } : {}),
  });
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactManifest(bytes: Buffer): CollabProjectCheckpointManifest {
  if (bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_MANIFEST_BYTES) {
    return failure('operation-failed');
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const manifest = decodeCollabProjectCheckpointManifest(
      JSON.parse(text) as unknown,
    );
    if (
      manifest.profile !== 'authority-transfer'
      || encodeCollabProjectCheckpointManifestCanonicalJson(manifest) !== text
      || sha256(encodeCollabProjectCheckpointManifestDigestInput(manifest))
        !== manifest.manifestSha256
    ) return failure('operation-failed');
    return manifest;
  } catch (error: unknown) {
    if (error instanceof CollabError && error.code === 'operation-failed') throw error;
    return failure('operation-failed');
  }
}

async function bodyBytes(body: Readable, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const value of body) {
    if (signal.aborted) return failure('operation-failed');
    if (!(value instanceof Uint8Array)) return failure('operation-failed');
    const chunk = Buffer.from(value);
    byteCount += chunk.byteLength;
    if (byteCount > MAXIMUM_MANIFEST_BYTES) return failure('operation-failed');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, byteCount);
}

function artifactFact(
  manifest: CollabProjectCheckpointManifest,
  artifact: CollabCloudAuthorityTransferArtifact,
): Readonly<{ readonly byteCount: number; readonly sha256: string }> {
  if (artifact === 'checkpoint.json') return failure('operation-failed');
  const fact = manifest.artifacts.find(candidate => candidate.name === artifact);
  if (fact === undefined) return failure('operation-failed');
  return fact;
}

export interface AuthorityTransferArtifactAuthorityOptions {
  readonly downloadTransfer: Pick<
    CloudToLanTransferCoordinator,
    'getCheckpointDownloadStatus'
  >;
  readonly staging: ProductionCheckpointStagingPort;
  readonly uploadTransfer: Pick<
    LanToCloudTransferCoordinator,
    'completeCheckpoint' | 'getCheckpointUploadStatus'
  >;
}

/** Adapts the canonical transfer owner to its exact durable staging attempt. */
export class AuthorityTransferArtifactAuthority implements ArtifactAuthority {
  readonly #downloadTransfer: AuthorityTransferArtifactAuthorityOptions['downloadTransfer'];
  readonly #staging: ProductionCheckpointStagingPort;
  readonly #uploadTransfer: AuthorityTransferArtifactAuthorityOptions['uploadTransfer'];

  constructor(options: AuthorityTransferArtifactAuthorityOptions) {
    this.#downloadTransfer = options.downloadTransfer;
    this.#staging = options.staging;
    this.#uploadTransfer = options.uploadTransfer;
  }

  async upload(input: AuthorityTransferArtifactUpload): Promise<void> {
    const status = await this.#uploadStatus(input);
    if (!this.#uploadAllowed(status)) return failure('authorization-denied');
    const attempt = productionCheckpointAttemptIdentity({
      expiresAt: status.expiresAt,
      operationId: input.transferId,
      projectId: input.projectId,
    });
    try {
      await this.#staging.prepareAttempt(attempt, input.signal);
      if (input.artifact === 'checkpoint.json') {
        const bytes = await bodyBytes(input.body, input.signal);
        const manifest = exactManifest(bytes);
        this.#assertManifest(manifest, status, 'lan', 'cloud');
        await this.#staging.receiveArtifact({
          artifact: input.artifact,
          attempt,
          body: Readable.from([bytes]),
          expectedByteCount: bytes.byteLength,
          expectedSha256: sha256(bytes),
          signal: input.signal,
        });
        await this.#confirmUploadAuthorization(input, attempt, status);
        await this.#completeUploadIfReady(input, attempt, manifest);
        return;
      }
      const manifest = await this.#manifest(attempt, input.signal);
      this.#assertManifest(manifest, status, 'lan', 'cloud');
      const expected = artifactFact(manifest, input.artifact);
      await this.#staging.receiveArtifact({
        artifact: input.artifact,
        attempt,
        body: input.body,
        expectedByteCount: expected.byteCount,
        expectedSha256: expected.sha256,
        signal: input.signal,
      });
      await this.#confirmUploadAuthorization(input, attempt, status);
      await this.#completeUploadIfReady(input, attempt, manifest);
    } catch (error: unknown) {
      if (error instanceof CollabError) throw error;
      return failure('operation-failed');
    }
  }

  async download(input: Parameters<ArtifactAuthority['download']>[0]): Promise<
    AuthorityTransferArtifactDownload
  > {
    const status = await this.#downloadStatus(input);
    if (
      status.direction !== 'cloud-to-lan'
      || status.checkpointSha256 === null
      || status.state !== 'active'
      || ![
        'checkpoint-captured',
        'target-staged',
        'claims-retained',
        'cloud-relinquished',
      ].includes(status.phase)
    ) return failure('authorization-denied');
    const attempt = productionCheckpointAttemptIdentity({
      expiresAt: status.expiresAt,
      operationId: input.transferId,
      projectId: input.projectId,
    });
    try {
      const inspected = await this.#staging.inspectAttempt(attempt, input.signal);
      const artifact = inspected.artifacts.find(value => value.name === input.artifact);
      if (artifact === undefined) return failure('operation-failed');
      const body = this.#readable(attempt, artifact, input.signal);
      return Object.freeze({ body, byteCount: artifact.byteCount });
    } catch (error: unknown) {
      if (error instanceof CollabError) throw error;
      return failure('operation-failed');
    }
  }

  async #downloadStatus(input: Readonly<{
    readonly principalId: string;
    readonly projectId: string;
    readonly transferId: string;
  }>): Promise<CollabAuthorityTransferStatus> {
    try {
      return await this.#downloadTransfer.getCheckpointDownloadStatus({
        principalId: input.principalId,
        request: {
          projectId: input.projectId,
          transferId: input.transferId,
        },
      });
    } catch {
      return failure('authorization-denied');
    }
  }

  async #uploadStatus(input: Readonly<{
    readonly principalId: string;
    readonly projectId: string;
    readonly transferId: string;
  }>): Promise<CollabAuthorityTransferStatus> {
    try {
      return await this.#uploadTransfer.getCheckpointUploadStatus({
        principalId: input.principalId,
        request: {
          projectId: input.projectId,
          transferId: input.transferId,
        },
      });
    } catch {
      return failure('authorization-denied');
    }
  }

  #uploadAllowed(status: CollabAuthorityTransferStatus): boolean {
    return status.direction === 'lan-to-cloud'
      && status.state === 'active'
      && [
        'source-quiesced',
        'checkpoint-received',
        'checkpoint-validated',
      ].includes(status.phase);
  }

  async #confirmUploadAuthorization(
    input: AuthorityTransferArtifactUpload,
    attempt: PreparedProductionCheckpointAttempt,
    initial: CollabAuthorityTransferStatus,
  ): Promise<void> {
    let current: CollabAuthorityTransferStatus | undefined;
    try {
      current = await this.#uploadStatus(input);
    } catch {
      current = undefined;
    }
    if (
      current !== undefined
      && this.#uploadAllowed(current)
      && current.projectId === initial.projectId
      && current.transferId === initial.transferId
      && current.expiresAt === initial.expiresAt
      && current.sourceAuthority.kind === initial.sourceAuthority.kind
      && current.sourceAuthority.generation === initial.sourceAuthority.generation
      && current.targetAuthority.kind === initial.targetAuthority.kind
      && current.targetAuthority.generation === initial.targetAuthority.generation
    ) return;
    return failure('authorization-denied');
  }

  async #completeUploadIfReady(
    input: AuthorityTransferArtifactUpload,
    attempt: PreparedProductionCheckpointAttempt,
    manifest: CollabProjectCheckpointManifest,
  ): Promise<void> {
    const inspected = await this.#staging.inspectAttempt(attempt, input.signal);
    const expected = new Map<string, Readonly<{
      readonly byteCount: number;
      readonly sha256: string;
    }>>([
      ['checkpoint.json', {
        byteCount: Buffer.byteLength(
          encodeCollabProjectCheckpointManifestCanonicalJson(manifest),
        ),
        sha256: sha256(
          encodeCollabProjectCheckpointManifestCanonicalJson(manifest),
        ),
      }],
      ...manifest.artifacts.map(artifact => [artifact.name, artifact] as const),
    ]);
    if (
      inspected.artifacts.length !== expected.size
      || inspected.artifacts.some(artifact => {
        const fact = expected.get(artifact.name);
        return fact === undefined
          || fact.byteCount !== artifact.byteCount
          || fact.sha256 !== artifact.sha256;
      })
    ) return;
    await this.#uploadTransfer.completeCheckpoint({
      principalId: input.principalId,
      projectId: input.projectId,
      transferId: input.transferId,
    });
  }

  async #manifest(
    attempt: PreparedProductionCheckpointAttempt,
    signal: AbortSignal,
  ): Promise<CollabProjectCheckpointManifest> {
    const inspected = await this.#staging.inspectAttempt(attempt, signal);
    const artifact = inspected.artifacts.find(value => value.name === 'checkpoint.json');
    if (artifact === undefined || artifact.byteCount > MAXIMUM_MANIFEST_BYTES) {
      return failure('operation-failed');
    }
    const chunks: Buffer[] = [];
    let byteCount = 0;
    await this.#staging.readArtifact({
      artifact,
      attempt,
      onChunk: chunk => {
        byteCount += chunk.byteLength;
        if (byteCount > MAXIMUM_MANIFEST_BYTES) return failure('operation-failed');
        chunks.push(Buffer.from(chunk));
      },
      signal,
    });
    if (byteCount !== artifact.byteCount) return failure('operation-failed');
    return exactManifest(Buffer.concat(chunks, byteCount));
  }

  #assertManifest(
    manifest: CollabProjectCheckpointManifest,
    status: CollabAuthorityTransferStatus,
    sourceKind: 'cloud' | 'lan',
    targetKind: 'cloud' | 'lan',
  ): void {
    if (
      manifest.projectId !== status.projectId
      || manifest.operationId !== status.transferId
      || manifest.sourceAuthority.kind !== sourceKind
      || manifest.sourceAuthority.generation !== status.sourceAuthority.generation
      || manifest.targetAuthority?.kind !== targetKind
      || manifest.targetAuthority.generation !== status.targetAuthority.generation
    ) failure('authorization-denied');
  }

  #readable(
    attempt: PreparedProductionCheckpointAttempt,
    artifact: StagedProductionCheckpointArtifact,
    signal: AbortSignal,
  ): Readable {
    const body = new PassThrough();
    body.on('error', () => undefined);
    void this.#staging.readArtifact({
      artifact,
      attempt,
      onChunk: async chunk => {
        if (!body.write(chunk)) await once(body, 'drain', { signal });
      },
      signal,
    }).then(
      () => body.end(),
      () => body.destroy(new CollabError({ code: 'operation-failed' })),
    );
    return body;
  }
}
