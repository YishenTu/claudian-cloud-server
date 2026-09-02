import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import {
  ProjectAuthoritySourceFence,
} from '../../src/project-authority/lifecycle/cloud-to-lan/ProjectAuthoritySourceFence.js';

const PROJECT_ID = 'project-source-fence';
const TRANSFER_ID = 'transfer-source-fence';
const CLEANUP_SHA256 = 'a'.repeat(64);

function lease(targetProof: string | undefined): PinnedProjectLease {
  const scope = {
    getProject: () => Promise.resolve({
      authorityGeneration: 4,
      serviceState: 'active',
    }),
    portability: {
      getAuthorityTransferRecovery: () => Promise.resolve({
        sourceReopenSha256: CLEANUP_SHA256,
        targetProof,
      }),
      getLifecycleJournal: () => Promise.resolve({
        direction: 'cloud-to-lan',
        kind: 'authority-transfer',
        phase: 'target-cleaned',
        projectId: PROJECT_ID,
      }),
    },
  } as unknown as ProjectScope;
  return {
    close: () => Promise.resolve(),
    drainDevelopmentBootstrapUploads: () => Promise.resolve(),
    handoffToDevelopmentBootstrapUpload: () => Promise.reject(new Error('not-supported')),
    withProjectScope: operation => operation(scope),
  };
}

describe('ProjectAuthoritySourceFence', () => {
  it('accepts an active source only when no target ever accepted the transfer', async () => {
    const fence = new ProjectAuthoritySourceFence();
    const input = {
      cleanupSha256: CLEANUP_SHA256,
      expectedAuthorityGeneration: 4,
      lease: lease(undefined),
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    };

    await fence.reopen(input);
    await assert.rejects(fence.reopen({
      ...input,
      lease: lease('accepted-target-evidence'),
    }), /project-authority-source-fence\.invalid-state/u);
  });
});
