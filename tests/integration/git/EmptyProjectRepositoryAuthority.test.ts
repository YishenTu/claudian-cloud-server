import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  EmptyProjectRepositoryAuthority,
  EmptyProjectRepositoryError,
  type EmptyProjectPublicationPlan,
} from '../../../src/repositories/EmptyProjectRepositoryAuthority.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = 'project_cloud_empty';
const INITIAL_COMMIT = '6b1a12d6d3b4714801617caa850adf32f9858bf5';
const COMMIT_CONTENT = `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
author Claudian Cloud <cloud@claudian.invalid> 1788051723 +0000
committer Claudian Cloud <cloud@claudian.invalid> 1788051723 +0000

Initialize Collab project
`;
const PLAN: EmptyProjectPublicationPlan = Object.freeze({
  authorEmail: 'cloud@claudian.invalid',
  authorName: 'Claudian Cloud',
  commitMessage: 'Initialize Collab project',
  commitTimestampSeconds: 1788051723,
  emptyTreeOid: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  initialCommitOid: INITIAL_COMMIT,
  mainRef: 'refs/heads/main',
  objectFormat: 'sha1',
  personalRef: 'refs/heads/members/member_initial_manager',
  planSha256: 'b'.repeat(64),
  projectId: PROJECT_ID,
  repositoryStorageKey: 'repo_cloud_empty',
  storageNodeId: 'node-a',
  timezone: '+0000',
});

function admission(): ResourceAdmission {
  return new ResourceAdmission({
    maxChildren: 3,
    maxChildrenPerProject: 1,
    queueMax: 2,
    queueMaxPerProject: 1,
    queueTimeoutMs: 100,
  });
}

describe('EmptyProjectRepositoryAuthority', () => {
  it('publishes and exactly replays one deterministic empty repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-empty-project-'));
    const resources = admission();
    const authority = new EmptyProjectRepositoryAuthority({
      gitExecutable: '/usr/bin/git',
      operationTimeoutMs: 5_000,
      outputMaxBytes: 64 * 1_024,
      repositoryRoot: root,
      resourceAdmission: resources,
      storageNodeId: 'node-a',
    });
    try {
      const reservation = await authority.reserve(PROJECT_ID);
      const published = await authority.publish(reservation, PLAN);
      assert.equal(published.status, 'published');
      await authority.verify(
        reservation,
        PLAN,
        published.publicationMarkerSha256,
      );
      const replay = await authority.publish(reservation, PLAN);
      assert.deepEqual(replay, {
        publicationMarkerSha256: published.publicationMarkerSha256,
        status: 'replayed',
      });

      const repository = join(
        root,
        Buffer.from(PROJECT_ID, 'utf8').toString('hex'),
        PLAN.repositoryStorageKey,
      );
      const refs = await execFileAsync('/usr/bin/git', [
        '--git-dir', repository,
        'for-each-ref',
        '--format=%(refname) %(objectname)',
      ]);
      assert.deepEqual(refs.stdout.trim().split('\n'), [
        `refs/heads/main ${INITIAL_COMMIT}`,
        `refs/heads/members/member_initial_manager ${INITIAL_COMMIT}`,
      ]);
      const commit = await execFileAsync('/usr/bin/git', [
        '--git-dir', repository,
        'cat-file',
        'commit',
        INITIAL_COMMIT,
      ]);
      assert.equal(commit.stdout, COMMIT_CONTENT);
      const marker = JSON.parse(await readFile(
        join(repository, '.claudian-cloud-creation.json'),
        'utf8',
      )) as Readonly<Record<string, unknown>>;
      assert.equal(marker.planSha256, PLAN.planSha256);
      assert.equal(marker.initialCommitOid, INITIAL_COMMIT);
    } finally {
      await authority.close();
      await resources.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('fails closed without replacing a divergent canonical ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-empty-conflict-'));
    const resources = admission();
    const authority = new EmptyProjectRepositoryAuthority({
      gitExecutable: '/usr/bin/git',
      operationTimeoutMs: 5_000,
      outputMaxBytes: 64 * 1_024,
      repositoryRoot: root,
      resourceAdmission: resources,
      storageNodeId: 'node-a',
    });
    try {
      const reservation = await authority.reserve(PROJECT_ID);
      await authority.publish(reservation, PLAN);
      const repository = join(
        root,
        Buffer.from(PROJECT_ID, 'utf8').toString('hex'),
        PLAN.repositoryStorageKey,
      );
      const divergent = await execFileAsync('/usr/bin/git', [
        '--git-dir', repository,
        'commit-tree',
        PLAN.emptyTreeOid,
        '-m', 'Divergent commit',
      ], {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-08-30T01:03:03Z',
          GIT_AUTHOR_EMAIL: 'other@claudian.invalid',
          GIT_AUTHOR_NAME: 'Other',
          GIT_COMMITTER_DATE: '2026-08-30T01:03:03Z',
          GIT_COMMITTER_EMAIL: 'other@claudian.invalid',
          GIT_COMMITTER_NAME: 'Other',
        },
      });
      const divergentOid = divergent.stdout.trim();
      await execFileAsync('/usr/bin/git', [
        '--git-dir', repository,
        'update-ref',
        'refs/heads/main',
        divergentOid,
      ]);
      await assert.rejects(
        authority.publish(reservation, PLAN),
        (error: unknown) => error instanceof EmptyProjectRepositoryError
          && error.code === 'state-conflict',
      );
      const main = await execFileAsync('/usr/bin/git', [
        '--git-dir', repository,
        'rev-parse',
        'refs/heads/main',
      ]);
      assert.equal(main.stdout.trim(), divergentOid);
    } finally {
      await authority.close();
      await resources.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
