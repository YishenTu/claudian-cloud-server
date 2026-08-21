import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  BootstrapRepositoryIntegrityError,
  BootstrapRepositoryIntegrityVerifier,
} from '../../../src/repositories/BootstrapRepositoryIntegrityVerifier.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT, [...arguments_], {
    cwd,
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    },
  });
  return result.stdout.trim();
}

describe('BootstrapRepositoryIntegrityVerifier', () => {
  it('requires a live bare repository with the exact object format and refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-bootstrap-integrity-'));
    const work = join(root, 'work');
    const bare = join(root, 'repository');
    const admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 1_000,
    });
    const verifier = new BootstrapRepositoryIntegrityVerifier({
      gitExecutable: GIT,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 64 * 1024,
      resourceAdmission: admission,
    });
    try {
      await git(root, ['init', '--initial-branch=main', work]);
      await git(work, ['config', 'user.email', 'test@example.invalid']);
      await git(work, ['config', 'user.name', 'Test User']);
      await writeFile(join(work, 'file.txt'), 'content\n');
      await git(work, ['add', 'file.txt']);
      await git(work, ['commit', '-m', 'fixture']);
      const oid = await git(work, ['rev-parse', 'HEAD']);
      await git(work, ['branch', 'members/member-a']);
      await git(work, ['branch', 'members/Member-B']);
      await git(root, ['clone', '--bare', work, bare]);
      const input = {
        objectFormat: 'sha1' as const,
        projectId: 'project-integrity',
        refs: [{ name: 'refs/heads/main', oid }, {
          name: 'refs/heads/members/member-a',
          oid,
        }, {
          name: 'refs/heads/members/Member-B', oid }],
        repositoryPath: bare,
      };

      await verifier.verify(input);
      await git(bare, ['update-ref', '-d', 'refs/heads/members/Member-B']);
      await assert.rejects(verifier.verify(input), error => {
        assert.ok(error instanceof BootstrapRepositoryIntegrityError);
        assert.equal(error.code, 'repository-invalid');
        assert.doesNotMatch(JSON.stringify(error), /claudian-bootstrap-integrity/u);
        return true;
      });
    } finally {
      await verifier.close();
      await admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
