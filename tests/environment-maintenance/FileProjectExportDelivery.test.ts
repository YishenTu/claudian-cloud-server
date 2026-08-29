import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { FileProjectExportDelivery } from '../../src/environment-maintenance/commands/FileProjectExportDelivery.js';
import { productionCheckpointAttemptIdentity } from '../../src/onboarding/production/ProductionCheckpointStaging.js';
import type { LifecycleCheckpointPublication } from '../../src/project-authority/checkpoint/LifecycleCheckpointPublication.js';

const projectId = 'project-export-delivery';
const operationId = 'export-delivery-operation';
const expiresAt = '2026-09-01T00:00:00.000Z';
const contents = new Map([
  ['checkpoint.json', Buffer.from('{"checkpoint":true}', 'utf8')],
  ['coordination.ndjson', Buffer.from('{"record":true}\n', 'utf8')],
  ['repository.bundle', Buffer.from('bundle bytes', 'utf8')],
]);

describe('FileProjectExportDelivery', () => {
  it('publishes exact operator-owned files and replays without staging ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-export-delivery-'));
    try {
      const attempt = productionCheckpointAttemptIdentity({
        expiresAt,
        operationId,
        projectId,
      });
      const artifacts = [...contents].map(([name, content]) => ({
        attemptKey: attempt.attemptKey,
        byteCount: content.byteLength,
        name,
        operationId,
        projectId,
        sha256: createHash('sha256').update(content).digest('hex'),
      }));
      const delivery = new FileProjectExportDelivery({
        publication: {
          inspectAttempt: () => Promise.resolve({ artifacts, attempt }),
          readArtifact: async (
            input: Parameters<LifecycleCheckpointPublication['readArtifact']>[0],
          ) => {
            const content = contents.get(input.artifact.name);
            assert.ok(content);
            await input.onChunk(content, input.signal ?? new AbortController().signal);
          },
        } as never,
        root,
      });
      const input = {
        checkpointSha256: 'a'.repeat(64),
        createdAt: '2026-08-29T00:00:00.000Z',
        expiresAt,
        operationId,
        profile: 'export' as const,
        projectId,
        signal: new AbortController().signal,
        state: 'published' as const,
      };

      await delivery.deliver(input);
      await delivery.deliver(input);

      const projectDirectory = join(
        root,
        'delivered',
        Buffer.from(projectId).toString('hex'),
      );
      const finalDirectory = join(
        projectDirectory,
        Buffer.from(operationId).toString('hex'),
      );
      assert.deepEqual((await readdir(projectDirectory)).sort(), [
        Buffer.from(operationId).toString('hex'),
      ]);
      assert.deepEqual((await readdir(finalDirectory)).sort(), [
        'checkpoint.json',
        'coordination.ndjson',
        'repository.bundle',
      ]);
      for (const [name, content] of contents) {
        assert.deepEqual(await readFile(join(finalDirectory, name)), content);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
