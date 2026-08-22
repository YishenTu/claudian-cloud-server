import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { collabMemberRef } from '@claudian/collab-protocol';

import { GitReceivePackPolicy } from '../../../src/repositories/GitReceivePackPolicy.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';

async function git(
  cwd: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, arguments_, {
    cwd,
    encoding: 'utf8',
    ...(environment === undefined
      ? {}
      : { env: { ...process.env, ...environment } }),
  });
  return result.stdout.trim();
}

describe('GitReceivePackPolicy', () => {
  it('rejects unreachable objects bundled with an authorized fast-forward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-receive-policy-extra-'));
    const work = join(root, 'work');
    const bare = join(root, 'bare.git');
    const personalRef = collabMemberRef('member-a');
    try {
      await git(root, ['init', '--initial-branch=main', work]);
      await git(work, ['config', 'user.name', 'Policy Test']);
      await git(work, ['config', 'user.email', 'policy@example.invalid']);
      await writeFile(join(work, 'base.txt'), 'base\n');
      await git(work, ['add', 'base.txt']);
      await git(work, ['commit', '-m', 'base']);
      await git(work, ['branch', 'members/member-a']);
      await git(root, ['clone', '--bare', work, bare]);
      const oldOid = await git(bare, ['rev-parse', personalRef]);

      await writeFile(join(work, 'personal.txt'), 'personal\n');
      await git(work, ['add', 'personal.txt']);
      await git(work, ['commit', '-m', 'personal']);
      const newOid = await git(work, ['rev-parse', 'HEAD']);
      const unrelatedPath = join(root, 'unrelated.txt');
      await writeFile(unrelatedPath, 'unrelated object\n');
      const unrelatedOid = await git(work, ['hash-object', '-w', unrelatedPath]);
      const delta = (await git(work, [
        'rev-list',
        '--objects',
        newOid,
        `^${oldOid}`,
      ])).split('\n').map(line => line.split(' ', 1)[0]).filter(Boolean);
      const packed = spawnSync(GIT_EXECUTABLE, ['pack-objects', '--stdout'], {
        cwd: work,
        encoding: null,
        input: Buffer.from(`${[...delta, unrelatedOid].join('\n')}\n`, 'ascii'),
        maxBuffer: 1024 * 1024,
      });
      assert.equal(packed.status, 0);
      assert.ok(Buffer.isBuffer(packed.stdout));

      const policy = new GitReceivePackPolicy({
        gitExecutable: GIT_EXECUTABLE,
        maximumBlobBytes: 1024,
        maximumExpandedTreeEntries: 100,
        maximumMetadataOutputBytes: 1024 * 1024,
        maximumRepositoryBytes: 1024 * 1024,
        maximumTreeEntries: 8,
        repositoryRoot: root,
      });
      const prepared = await policy.prepare('project-a', personalRef);
      const command = Buffer.from(
        `${oldOid} ${newOid} ${personalRef}\0report-status\n`,
        'utf8',
      );
      const request = Buffer.concat([
        Buffer.from((command.length + 4).toString(16).padStart(4, '0'), 'ascii'),
        command,
        Buffer.from('0000', 'ascii'),
        packed.stdout,
      ]);
      const received = spawnSync(
        GIT_EXECUTABLE,
        ['receive-pack', '--stateless-rpc', '.'],
        {
          cwd: bare,
          encoding: null,
          env: { ...process.env, ...prepared.environment },
          input: request,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(received.error, undefined);
      assert.equal(received.status, 0);
      assert.equal(await prepared.readResult(), undefined);
      assert.equal(await git(bare, ['rev-parse', personalRef]), oldOid);
      await assert.rejects(git(bare, ['cat-file', '-e', unrelatedOid]));
      await prepared.close();
      policy.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects a projected repository quota overflow and removes restart-orphaned hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-receive-policy-'));
    const work = join(root, 'work');
    const bare = join(root, 'bare.git');
    const personalRef = collabMemberRef('member-a');
    try {
      await git(root, ['init', '--initial-branch=main', work]);
      await git(work, ['config', 'user.name', 'Policy Test']);
      await git(work, ['config', 'user.email', 'policy@example.invalid']);
      await writeFile(join(work, 'base.txt'), 'base\n');
      await git(work, ['add', 'base.txt']);
      await git(work, ['commit', '-m', 'base']);
      await git(work, ['branch', 'members/member-a']);
      await git(root, ['clone', '--bare', work, bare]);
      const oldOid = await git(bare, ['rev-parse', personalRef]);
      const initialBytes = (await git(bare, [
        'cat-file',
        '--batch-all-objects',
        '--batch-check=%(objectsize)',
      ])).split('\n').reduce((total, line) => total + Number(line), 0);
      const policyOptions = {
        gitExecutable: GIT_EXECUTABLE,
        maximumBlobBytes: initialBytes + 128,
        maximumExpandedTreeEntries: 100,
        maximumMetadataOutputBytes: 1024 * 1024,
        maximumRepositoryBytes: initialBytes + 128,
        maximumTreeEntries: 8,
        repositoryRoot: root,
      };
      const policy = new GitReceivePackPolicy(policyOptions);
      const prepared = await policy.prepare('project-a', personalRef);
      const receiveWrapper = join(root, 'receive-wrapper');
      await writeFile(
        receiveWrapper,
        `#!${process.execPath}\n`
          + "const { spawnSync } = require('node:child_process');\n"
          + `Object.assign(process.env, ${JSON.stringify(prepared.environment)});\n`
          + `const result = spawnSync(${JSON.stringify(GIT_EXECUTABLE)}, `
          + "['receive-pack', ...process.argv.slice(2)], "
          + "{ env: process.env, stdio: 'inherit' });\n"
          + 'process.exit(result.status ?? 1);\n',
        { mode: 0o700 },
      );
      await chmod(receiveWrapper, 0o700);

      await writeFile(join(work, 'quota.txt'), 'q'.repeat(256));
      await git(work, ['add', 'quota.txt']);
      await git(work, ['commit', '-m', 'quota overflow']);
      const overlappingStartup = new GitReceivePackPolicy(policyOptions);
      await overlappingStartup.verifyCapability();
      overlappingStartup.close();
      await assert.rejects(git(
        work,
        ['push', `--receive-pack=${receiveWrapper}`, bare, `HEAD:${personalRef}`],
      ));
      assert.equal(await prepared.readResult(), undefined);
      assert.equal(await git(bare, ['rev-parse', personalRef]), oldOid);
      await prepared.close();

      const stale = await policy.prepare('project-a', personalRef);
      policy.close();
      const restarted = new GitReceivePackPolicy(policyOptions);
      await restarted.verifyCapability();
      assert.equal(
        (await readdir(join(root, '.claudian-receive-pack'))).length,
        1,
      );
      await restarted.cleanupProject('project-a');
      assert.deepEqual(await readdir(join(root, '.claudian-receive-pack')), []);
      restarted.close();
      void stale;
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
