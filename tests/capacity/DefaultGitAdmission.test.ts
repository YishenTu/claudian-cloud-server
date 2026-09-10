import assert from 'node:assert/strict';
import { it } from 'node:test';

import { decodeServerConfig } from '../../src/config/ServerConfig.js';
import { ResourceAdmission } from '../../src/resource-admission/ResourceAdmission.js';

it('absorbs a multi-Project read burst while keeping a write lane available with default budgets', async () => {
  const config = decodeServerConfig({
    CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
    CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
    CLAUDIAN_CLOUD_PORT: '8787',
    CLAUDIAN_CLOUD_POSTGRES_URL: 'postgresql://runtime:synthetic@127.0.0.1/cloud',
    CLAUDIAN_CLOUD_PRINCIPAL_PROFILE: 'vault-credential',
    CLAUDIAN_CLOUD_REPOSITORY_ROOT: '/srv/claudian/repositories',
    CLAUDIAN_CLOUD_STAGING_ROOT: '/srv/claudian/staging',
    CLAUDIAN_CLOUD_STORAGE_NODE_ID: 'node-a',
  });
  const admission = new ResourceAdmission(config.gitAdmission);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let completedReads = 0;
  const reads = Array.from({ length: 80 }, (_, index) => admission.acquireGitChild({
    classification: 'read', projectId: `project-${String(index % 40)}`,
  }).then(async permit => {
    try {
      await barrier;
      completedReads += 1;
    } finally {
      permit.release();
    }
  }));
  const settled = Promise.allSettled(reads);
  try {
    const write = await admission.acquireGitChild({ classification: 'write', projectId: 'project-write' });
    assert.equal(completedReads, 0);
    write.release();
    release();
    const results = await settled;
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 80);
    assert.equal(completedReads, 80);
  } finally {
    release();
    await settled;
    await admission.close();
  }
});
