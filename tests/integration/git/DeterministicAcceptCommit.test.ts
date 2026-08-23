import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  COLLAB_MAIN_REF,
  collabMemberRef,
} from '@claudian-collab/protocol';

import type { PrepareAcceptInput } from '../../../src/coordination/AcceptPersistence.js';
import {
  GitRepositoryAuthority,
} from '../../../src/repositories/GitRepositoryAuthority.js';
import {
  ProjectAcceptRepositoryError,
  type ProjectAcceptRepository,
} from '../../../src/project-authority/acceptance/ProjectAcceptRepository.js';
import {
  createRepositoryPlacementLease,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from '../../../src/repositories/RepositoryPlacement.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const PREPARED_AT = '2026-08-24T01:02:03.000Z';
const MEMBER_ID = 'member-author';
const PERSONAL_REF = collabMemberRef(MEMBER_ID);

class CurrentPlacement implements RepositoryPlacementValidator {
  isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function placement(storageKey: string): RepositoryPlacementLease {
  return createRepositoryPlacementLease({
    active: true,
    generation: 3,
    projectId: 'project-accept',
    repositoryStorageKey: storageKey,
    storageNodeId: 'node-a',
  });
}

function repositoryPath(
  root: string,
  repositoryPlacement: RepositoryPlacementLease,
): string {
  return join(
    root,
    Buffer.from(repositoryPlacement.projectId, 'utf8').toString('hex'),
    repositoryPlacement.repositoryStorageKey,
  );
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, [...args], {
    cwd,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

async function createRepository(
  root: string,
  options: Readonly<{ readonly portableCollision?: boolean }> = {},
) {
  const work = join(root, 'work');
  const accepted = placement('accept_repository');
  const bare = repositoryPath(root, accepted);
  await mkdir(work, { recursive: true });
  await git(work, ['init', '--initial-branch=main']);
  await git(work, ['config', 'user.name', 'Fixture User']);
  await git(work, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(work, 'base.txt'), 'base\n');
  await git(work, ['add', 'base.txt']);
  await git(work, ['commit', '-m', 'Base']);
  const baseOid = await git(work, ['rev-parse', 'HEAD']);

  const mainPath = options.portableCollision === true
    ? join('portable', 'name.txt')
    : 'main.txt';
  await mkdir(join(work, 'portable'), { recursive: true });
  await writeFile(join(work, mainPath), 'main\n');
  await git(work, ['add', mainPath]);
  await git(work, ['commit', '-m', 'Main change']);
  const mainOid = await git(work, ['rev-parse', 'HEAD']);

  await git(work, ['checkout', '-b', 'member', baseOid]);
  const memberPath = options.portableCollision === true
    ? join('portable', 'NAME.txt')
    : 'member.txt';
  await mkdir(join(work, 'portable'), { recursive: true });
  await writeFile(join(work, memberPath), 'member\n');
  await git(work, ['add', memberPath]);
  await git(work, ['commit', '-m', 'Member change']);
  const headOid = await git(work, ['rev-parse', 'HEAD']);

  await mkdir(bare, { recursive: true });
  await git(bare, ['init', '--bare']);
  await git(work, ['push', bare, `${mainOid}:${COLLAB_MAIN_REF}`]);
  await git(work, ['push', bare, `${headOid}:${PERSONAL_REF}`]);
  return { accepted, bare, baseOid, headOid, mainOid };
}

async function allObjectIds(repository: string): Promise<readonly string[]> {
  const output = await git(repository, [
    'cat-file',
    '--batch-all-objects',
    '--batch-check=%(objectname)',
  ]);
  return output.split('\n').filter(Boolean).sort();
}

function acceptRepository(authority: GitRepositoryAuthority): ProjectAcceptRepository {
  const expected = authority as Partial<ProjectAcceptRepository>;
  assert.equal(typeof expected.inspectAccept, 'function');
  assert.equal(typeof expected.materializeAcceptResult, 'function');
  assert.equal(typeof expected.settleAcceptMain, 'function');
  assert.equal(typeof expected.reserveAccept, 'function');
  return expected as ProjectAcceptRepository;
}

describe('deterministic Accept repository operations', () => {
  it('materializes exact persisted commit bytes and compare-and-swaps only main', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-cloud-accept-git-'));
    const resources = new ResourceAdmission({
      maxChildren: 3,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 1_000,
    });
    const authority = new GitRepositoryAuthority({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 1_024 * 1_024,
      placementValidator: new CurrentPlacement(),
      repositoryRoot: root,
      resourceAdmission: resources,
      storageNodeId: 'node-a',
    });
    try {
      const fixture = await createRepository(root);
      const repository = acceptRepository(authority);
      const reservation = await repository.reserveAccept(fixture.accepted.projectId);
      let revalidations = 0;
      const inspection = await repository.inspectAccept(reservation, {
        expectedHeadOid: fixture.headOid,
        expectedMainOid: fixture.mainOid,
        personalRef: PERSONAL_REF,
        placement: fixture.accepted,
        projectId: fixture.accepted.projectId,
        relationCommitOids: [fixture.headOid],
        revalidateAuthority: () => {
          revalidations += 1;
          return Promise.resolve();
        },
        signal: new AbortController().signal,
      });
      assert.equal(inspection.kind, 'merge');
      assert.equal(inspection.objectFormat, 'sha1');
      assert.ok(inspection.treeOid);

      const plan: PrepareAcceptInput = {
        actorMemberId: 'member-manager',
        commit: {
          authorEmail: 'collab@claudian.local',
          authorName: 'Claudian Collab',
          committerEmail: 'collab@claudian.local',
          committerName: 'Claudian Collab',
          message: 'Accept request request-one\n',
          parents: [fixture.mainOid, fixture.headOid],
          timezone: '+0000',
          treeOid: inspection.treeOid,
        },
        expectedHeadOid: fixture.headOid,
        expectedMainOid: fixture.mainOid,
        expectedRequestRevision: 1,
        idempotencyKey: 'accept-key',
        mainRef: COLLAB_MAIN_REF,
        objectFormat: inspection.objectFormat,
        operationId: 'accept-operation',
        personalRef: PERSONAL_REF,
        placement: {
          generation: fixture.accepted.generation,
          projectId: fixture.accepted.projectId,
          repositoryStorageKey: fixture.accepted.repositoryStorageKey,
          storageNodeId: fixture.accepted.storageNodeId,
        },
        preparedAt: PREPARED_AT,
        relations: [],
        requestFingerprint: 'f'.repeat(64),
        requestId: 'request-one',
        requestMemberId: MEMBER_ID,
        resultKind: 'merge',
      };

      const resultOid = await repository.materializeAcceptResult(reservation, plan);
      assert.equal(
        await repository.materializeAcceptResult(reservation, plan),
        resultOid,
      );
      const epoch = Math.floor(Date.parse(PREPARED_AT) / 1_000);
      assert.equal(
        await git(fixture.bare, ['cat-file', 'commit', resultOid]),
        [
          `tree ${inspection.treeOid}`,
          `parent ${fixture.mainOid}`,
          `parent ${fixture.headOid}`,
          `author Claudian Collab <collab@claudian.local> ${String(epoch)} +0000`,
          `committer Claudian Collab <collab@claudian.local> ${String(epoch)} +0000`,
          '',
          'Accept request request-one',
        ].join('\n'),
      );
      assert.equal(await git(fixture.bare, ['rev-parse', PERSONAL_REF]), fixture.headOid);
      assert.equal(
        await repository.settleAcceptMain(reservation, { ...plan, resultOid }),
        'advanced',
      );
      assert.equal(
        await repository.settleAcceptMain(reservation, { ...plan, resultOid }),
        'replayed',
      );
      assert.equal(
        await repository.materializeAcceptResult(reservation, plan),
        resultOid,
      );
      assert.equal(await git(fixture.bare, ['rev-parse', COLLAB_MAIN_REF]), resultOid);
      assert.equal(await git(fixture.bare, ['rev-parse', PERSONAL_REF]), fixture.headOid);
      assert.equal(revalidations, 1);
      await reservation.close();
    } finally {
      await authority.close();
      await resources.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('settles an already-contained head without writing any Git object or ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-cloud-accept-contained-'));
    const resources = new ResourceAdmission({
      maxChildren: 3,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 1_000,
    });
    const authority = new GitRepositoryAuthority({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 1_024 * 1_024,
      placementValidator: new CurrentPlacement(),
      repositoryRoot: root,
      resourceAdmission: resources,
      storageNodeId: 'node-a',
    });
    try {
      const fixture = await createRepository(root);
      await git(fixture.bare, ['update-ref', PERSONAL_REF, fixture.baseOid]);
      const repository = acceptRepository(authority);
      const reservation = await repository.reserveAccept(fixture.accepted.projectId);
      const before = await allObjectIds(fixture.bare);
      const inspection = await repository.inspectAccept(reservation, {
        expectedHeadOid: fixture.baseOid,
        expectedMainOid: fixture.mainOid,
        personalRef: PERSONAL_REF,
        placement: fixture.accepted,
        projectId: fixture.accepted.projectId,
        relationCommitOids: [fixture.baseOid],
        revalidateAuthority: () => Promise.resolve(),
        signal: new AbortController().signal,
      });
      assert.deepEqual(inspection, { kind: 'contained', objectFormat: 'sha1' });
      const plan: PrepareAcceptInput = {
        actorMemberId: 'member-manager',
        expectedHeadOid: fixture.baseOid,
        expectedMainOid: fixture.mainOid,
        expectedRequestRevision: 1,
        idempotencyKey: 'accept-contained-key',
        mainRef: COLLAB_MAIN_REF,
        objectFormat: inspection.objectFormat,
        operationId: 'accept-contained-operation',
        personalRef: PERSONAL_REF,
        placement: {
          generation: fixture.accepted.generation,
          projectId: fixture.accepted.projectId,
          repositoryStorageKey: fixture.accepted.repositoryStorageKey,
          storageNodeId: fixture.accepted.storageNodeId,
        },
        preparedAt: PREPARED_AT,
        relations: [],
        requestFingerprint: 'e'.repeat(64),
        requestId: 'request-contained',
        requestMemberId: MEMBER_ID,
        resultKind: 'contained',
      };

      const resultOid = await repository.materializeAcceptResult(reservation, plan);
      assert.equal(resultOid, fixture.mainOid);
      assert.equal(
        await repository.settleAcceptMain(reservation, { ...plan, resultOid }),
        'replayed',
      );
      assert.deepEqual(await allObjectIds(fixture.bare), before);
      assert.equal(await git(fixture.bare, ['rev-parse', COLLAB_MAIN_REF]), fixture.mainOid);
      assert.equal(await git(fixture.bare, ['rev-parse', PERSONAL_REF]), fixture.baseOid);
      await reservation.close();
    } finally {
      await authority.close();
      await resources.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects a clean Git merge whose resulting paths collide portably', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-cloud-accept-paths-'));
    const resources = new ResourceAdmission({
      maxChildren: 3,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 1_000,
    });
    const authority = new GitRepositoryAuthority({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 1_024 * 1_024,
      placementValidator: new CurrentPlacement(),
      repositoryRoot: root,
      resourceAdmission: resources,
      storageNodeId: 'node-a',
    });
    try {
      const fixture = await createRepository(root, { portableCollision: true });
      const repository = acceptRepository(authority);
      const reservation = await repository.reserveAccept(fixture.accepted.projectId);
      await assert.rejects(
        repository.inspectAccept(reservation, {
          expectedHeadOid: fixture.headOid,
          expectedMainOid: fixture.mainOid,
          personalRef: PERSONAL_REF,
          placement: fixture.accepted,
          projectId: fixture.accepted.projectId,
          relationCommitOids: [],
          revalidateAuthority: () => Promise.resolve(),
          signal: new AbortController().signal,
        }),
        error => (
          error instanceof ProjectAcceptRepositoryError
          && error.code === 'unsupported-tree'
        ),
      );
      assert.equal(await git(fixture.bare, ['rev-parse', COLLAB_MAIN_REF]), fixture.mainOid);
      await reservation.close();
    } finally {
      await authority.close();
      await resources.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
