import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import {
  CollabError,
  type CollabProjectCheckpointManifest,
  decodeCollabAuthorityTransferStatus,
  encodeCollabProjectCheckpointManifestCanonicalJson,
  encodeCollabProjectCheckpointManifestDigestInput,
} from '@claudian-collab/protocol';

import {
  productionCheckpointAttemptIdentity,
  type ProductionCheckpointStagingPort,
  type StagedProductionCheckpointArtifact,
} from '../../src/onboarding/production/ProductionCheckpointStaging.js';
import { AuthorityTransferArtifactAuthority } from '../../src/project-authority/lifecycle/AuthorityTransferArtifactAuthority.js';

const status = decodeCollabAuthorityTransferStatus({
  batchRevision: null,
  batchSha256: null,
  checkpointSha256: '1'.repeat(64),
  createdAt: '2026-09-02T00:00:00.000Z',
  direction: 'cloud-to-lan',
  expiresAt: '2026-10-02T00:00:00.000Z',
  phase: 'cancel-intent',
  projectId: 'project-artifact-authority',
  relinquishmentProof: null,
  sourceAuthority: { generation: 1, kind: 'cloud' },
  state: 'active',
  targetAuthority: { generation: 2, kind: 'lan' },
  targetUrl: 'https://lan.example.test',
  transferId: 'transfer-artifact-authority',
  updatedAt: '2026-09-02T00:00:01.000Z',
});

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uploadManifest(): Buffer {
  const unsigned: CollabProjectCheckpointManifest = {
    artifacts: Object.freeze([
      Object.freeze({
        byteCount: 1,
        name: 'coordination.ndjson',
        sha256: sha256('c'),
      }),
      Object.freeze({
        byteCount: 1,
        name: 'repository.bundle',
        sha256: sha256('r'),
      }),
    ]),
    coordinationFormatVersion: 1,
    createdAt: '2026-09-02T00:00:00.000Z',
    expectedMainOid: 'a'.repeat(40),
    gitObjectFormat: 'sha1',
    manifestSchemaVersion: 1,
    manifestSha256: '0'.repeat(64),
    operationId: status.transferId,
    profile: 'authority-transfer',
    projectId: status.projectId,
    protocolVersion: 10,
    refs: Object.freeze([
      Object.freeze({ name: 'refs/heads/main', oid: 'a'.repeat(40) }),
    ]),
    sourceAuthority: Object.freeze({ generation: 1, kind: 'lan' }),
    targetAuthority: Object.freeze({ generation: 2, kind: 'cloud' }),
  };
  const manifest = Object.freeze({
    ...unsigned,
    manifestSha256: sha256(
      encodeCollabProjectCheckpointManifestDigestInput(unsigned),
    ),
  });
  return Buffer.from(
    encodeCollabProjectCheckpointManifestCanonicalJson(manifest),
    'utf8',
  );
}

describe('AuthorityTransferArtifactAuthority', () => {
  it('advances LAN-to-Cloud after the final checkpoint artifact is durable', async () => {
    const active = decodeCollabAuthorityTransferStatus({
      ...status,
      checkpointSha256: null,
      direction: 'lan-to-cloud',
      phase: 'source-quiesced',
      sourceAuthority: { generation: 1, kind: 'lan' },
      targetAuthority: { generation: 2, kind: 'cloud' },
    });
    const manifest = uploadManifest();
    const attempt = productionCheckpointAttemptIdentity({
      expiresAt: active.expiresAt,
      operationId: active.transferId,
      projectId: active.projectId,
    });
    const artifacts: StagedProductionCheckpointArtifact[] = [{
      ...attempt,
      byteCount: manifest.byteLength,
      name: 'checkpoint.json' as const,
      sha256: sha256(manifest),
    }, {
      ...attempt,
      byteCount: 1,
      name: 'coordination.ndjson' as const,
      sha256: sha256('c'),
    }];
    let completions = 0;
    const staging: ProductionCheckpointStagingPort = {
      discardAttempt: () => Promise.resolve('removed'),
      expireAttempt: () => Promise.resolve('retained'),
      inspectAttempt: () => Promise.resolve(Object.freeze({
        artifacts: Object.freeze([...artifacts]),
        attempt,
      })),
      prepareAttempt: () => Promise.resolve(attempt),
      readArtifact: async input => {
        if (input.artifact.name !== 'checkpoint.json') throw new Error('unexpected');
        await input.onChunk(manifest, new AbortController().signal);
      },
      receiveArtifact: input => {
        const stored = Object.freeze({
          ...input.attempt,
          byteCount: input.expectedByteCount,
          name: input.artifact,
          sha256: input.expectedSha256,
        });
        artifacts.push(stored);
        return Promise.resolve(stored);
      },
    };
    const authority = new AuthorityTransferArtifactAuthority({
      downloadTransfer: {
        getCheckpointDownloadStatus: () => Promise.reject(new Error('unused')),
      },
      staging,
      uploadTransfer: {
        completeCheckpoint: () => {
          completions += 1;
          return Promise.resolve(active);
        },
        getCheckpointUploadStatus: () => Promise.resolve(active),
      },
    });

    await authority.upload({
      artifact: 'repository.bundle',
      body: Readable.from(['r']),
      principalId: 'principal-source',
      projectId: active.projectId,
      signal: new AbortController().signal,
      transferId: active.transferId,
    });

    assert.equal(completions, 1);
  });

  it('does not expose a captured checkpoint after cancellation begins', async () => {
    let stagingCalls = 0;
    const unavailable = (): never => {
      stagingCalls += 1;
      throw new Error('staging-must-not-be-entered');
    };
    const staging: ProductionCheckpointStagingPort = {
      discardAttempt: unavailable,
      expireAttempt: unavailable,
      inspectAttempt: unavailable,
      prepareAttempt: unavailable,
      readArtifact: unavailable,
      receiveArtifact: unavailable,
    };
    const authority = new AuthorityTransferArtifactAuthority({
      downloadTransfer: {
        getCheckpointDownloadStatus: () => Promise.resolve(status),
      },
      staging,
      uploadTransfer: {
        completeCheckpoint: () => Promise.reject(new Error('unused')),
        getCheckpointUploadStatus: () => Promise.reject(new Error('unused')),
      },
    });

    await assert.rejects(authority.download({
      artifact: 'checkpoint.json',
      principalId: 'principal-target',
      projectId: status.projectId,
      signal: new AbortController().signal,
      transferId: status.transferId,
    }), (error: unknown) => error instanceof CollabError
      && error.code === 'authorization-denied');
    assert.equal(stagingCalls, 0);
  });

  it('rejects a stale upload without deleting recovery-owned checkpoint state', async () => {
    const active = decodeCollabAuthorityTransferStatus({
      ...status,
      checkpointSha256: null,
      direction: 'lan-to-cloud',
      phase: 'source-quiesced',
      sourceAuthority: { generation: 1, kind: 'lan' },
      targetAuthority: { generation: 2, kind: 'cloud' },
    });
    const cancelled = decodeCollabAuthorityTransferStatus({
      ...active,
      phase: 'cancelled',
      state: 'cancelled',
      updatedAt: '2026-09-02T00:00:02.000Z',
    });
    let statusReads = 0;
    let discarded = 0;
    const staging: ProductionCheckpointStagingPort = {
      discardAttempt: () => {
        discarded += 1;
        return Promise.resolve('removed');
      },
      expireAttempt: () => Promise.resolve('retained'),
      inspectAttempt: () => Promise.reject(new Error('unused')),
      prepareAttempt: input => Promise.resolve(productionCheckpointAttemptIdentity(input)),
      readArtifact: () => Promise.reject(new Error('unused')),
      receiveArtifact: input => Promise.resolve(Object.freeze({
        ...input.attempt,
        byteCount: input.expectedByteCount,
        name: input.artifact,
        sha256: input.expectedSha256,
      })),
    };
    const authority = new AuthorityTransferArtifactAuthority({
      downloadTransfer: {
        getCheckpointDownloadStatus: () => Promise.reject(new Error('unused')),
      },
      staging,
      uploadTransfer: {
        completeCheckpoint: () => Promise.reject(new Error('unused')),
        getCheckpointUploadStatus: () => Promise.resolve(
          statusReads++ === 0 ? active : cancelled,
        ),
      },
    });
    const bytes = uploadManifest();

    await assert.rejects(authority.upload({
      artifact: 'checkpoint.json',
      body: Readable.from([bytes]),
      principalId: 'principal-source',
      projectId: status.projectId,
      signal: new AbortController().signal,
      transferId: status.transferId,
    }), (error: unknown) => error instanceof CollabError
      && error.code === 'authorization-denied');
    assert.equal(statusReads, 2);
    assert.equal(discarded, 0);
  });
});
