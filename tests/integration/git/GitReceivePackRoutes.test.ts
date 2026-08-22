import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  COLLAB_MAIN_REF,
  collabCloudGitRoute,
  collabMemberRef,
} from '@claudian/collab-protocol';

import { DevelopmentPrincipalAdapter } from '../../../src/request-context/DevelopmentPrincipalAdapter.js';
import { ProjectWriteAdmissionError } from '../../../src/project-authority/admission/ProjectWriteAdmission.js';
import type { IngressPrincipal } from '../../../src/request-context/IngressPrincipal.js';
import {
  GitRepositoryAuthority,
  GitRepositoryError,
} from '../../../src/repositories/GitRepositoryAuthority.js';
import {
  createRepositoryPlacementLease,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from '../../../src/repositories/RepositoryPlacement.js';
import { GitReceiveAdmission } from '../../../src/resource-admission/GitReceiveAdmission.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';
import {
  GitReceivePackRoutes,
  type GitReceivePackWriteAuthority,
} from '../../../src/server/git/GitReceivePackRoutes.js';
import { HttpServer } from '../../../src/server/HttpServer.js';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';

class CurrentPlacementValidator implements RepositoryPlacementValidator {
  isCurrent(_placement: RepositoryPlacementLease): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function repositoryPath(root: string, placement: RepositoryPlacementLease): string {
  return join(
    root,
    Buffer.from(placement.projectId, 'utf8').toString('hex'),
    placement.repositoryStorageKey,
  );
}

describe('GitReceivePackRoutes', () => {
  it('closes an incomplete request after rejecting it before body admission', async () => {
    const route = new GitReceivePackRoutes({
      authority: {
        advertiseReceivePack: () => Promise.resolve(Buffer.alloc(0)),
        runReceivePack: () => Promise.reject(new GitRepositoryError('busy')),
      },
      maximumRequestBytes: 1_024,
      maximumResponseBytes: 1_024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      routes: [route],
    });
    try {
      const address = await server.start();
      const result = await new Promise<Readonly<{ closed: boolean; status: number }>>(
        (resolve, reject) => {
          const client = httpRequest({
            headers: {
              'content-length': '100',
              'content-type': 'application/x-git-receive-pack-request',
              'x-claudian-development-actor': 'member-a',
            },
            host: address.host,
            method: 'POST',
            path: collabCloudGitRoute('project-a', 'git-receive-pack').target,
            port: address.port,
          });
          const timeout = setTimeout(() => {
            client.destroy();
            reject(new Error('incomplete-rejected-request-not-closed'));
          }, 1_000);
          timeout.unref();
          client.once('error', reject);
          client.once('response', response => {
            response.resume();
            const status = response.statusCode ?? 0;
            response.once('end', () => {
              client.once('close', () => {
                clearTimeout(timeout);
                resolve({ closed: true, status });
              });
            });
          });
          client.write('x');
        },
      );
      assert.deepEqual(result, { closed: true, status: 503 });
    } finally {
      await server.close(1_000);
    }
  });

  it('maps write admission and repository saturation before response output', async () => {
    const route = new GitReceivePackRoutes({
      authority: {
        advertiseReceivePack: () => Promise.resolve(Buffer.alloc(0)),
        runReceivePack: (_principal, projectId) => {
          if (projectId === 'project-busy') {
            return Promise.reject(new GitRepositoryError('busy'));
          }
          return Promise.reject(new ProjectWriteAdmissionError(
            'authorization-denied',
          ));
        },
      },
      maximumRequestBytes: 1_024,
      maximumResponseBytes: 1_024,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      routes: [route],
    });
    try {
      const address = await server.start();
      const statuses = await Promise.all(['project-denied', 'project-busy'].map(
        async projectId => {
          const response = await fetch(
            `http://${address.host}:${String(address.port)}${collabCloudGitRoute(
              projectId,
              'git-receive-pack',
            ).target}`,
            {
              body: '0000',
              headers: {
                'content-type': 'application/x-git-receive-pack-request',
                'x-claudian-development-actor': 'member-a',
              },
              method: 'POST',
            },
          );
          await response.arrayBuffer();
          return response.status;
        },
      ));
      assert.deepEqual(statuses, [404, 503]);
    } finally {
      await server.close(1_000);
    }
  });

  it('adapts the package receive-pack routes as bounded streaming Git transport', async () => {
    const observed: Buffer[] = [];
    let actorId: string | undefined;
    const route = new GitReceivePackRoutes({
      authority: {
        advertiseReceivePack: (principal, projectId) => {
          actorId = principal.actorId;
          assert.equal(projectId, 'project-a');
          return Promise.resolve(Buffer.from('0000', 'ascii'));
        },
        runReceivePack: async (principal, projectId, options) => {
          actorId = principal.actorId;
          assert.equal(projectId, 'project-a');
          for await (const chunk of options.request) observed.push(Buffer.from(chunk));
          await options.onResponseChunk(
            Buffer.from('0008NAK\n', 'ascii'),
            new AbortController().signal,
          );
        },
      },
      maximumRequestBytes: 32,
      maximumResponseBytes: 32,
      operationTimeoutMs: 2_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      routes: [route],
    });
    try {
      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      const headers = {
        'x-claudian-development-actor': 'actor-a',
      };
      const advertised = await fetch(
        `${origin}${collabCloudGitRoute(
          'project-a',
          'info-refs',
          'git-receive-pack',
        ).target}`,
        { headers },
      );
      assert.equal(advertised.status, 200);
      assert.equal(
        advertised.headers.get('content-type'),
        'application/x-git-receive-pack-advertisement',
      );
      assert.equal(
        Buffer.from(await advertised.arrayBuffer()).toString('ascii'),
        '001f# service=git-receive-pack\n00000000',
      );

      const rpc = await fetch(
        `${origin}${collabCloudGitRoute('project-a', 'git-receive-pack').target}`,
        {
          body: '0008body',
          headers: {
            ...headers,
            'content-type': 'application/x-git-receive-pack-request',
          },
          method: 'POST',
        },
      );
      assert.equal(rpc.status, 200);
      assert.equal(
        rpc.headers.get('content-type'),
        'application/x-git-receive-pack-result',
      );
      assert.equal(
        Buffer.from(await rpc.arrayBuffer()).toString('ascii'),
        '0008NAK\n',
      );
      assert.equal(Buffer.concat(observed).toString('ascii'), '0008body');
      assert.equal(actorId, 'actor-a');

      const oversized = await fetch(
        `${origin}${collabCloudGitRoute('project-a', 'git-receive-pack').target}`,
        {
          body: Buffer.alloc(33),
          headers: {
            ...headers,
            'content-type': 'application/x-git-receive-pack-request',
          },
          method: 'POST',
        },
      );
      assert.equal(oversized.status, 413);
    } finally {
      await server.close(1_000);
    }
  });

  it('fast-forwards only the authenticated caller personal ref through real Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-receive-pack-'));
    const work = join(root, 'work');
    const placement = createRepositoryPlacementLease({
      active: true,
      generation: 1,
      projectId: 'project-a',
      repositoryStorageKey: 'repository-a',
      storageNodeId: 'node-a',
    });
    const resources = new ResourceAdmission({
      maxChildren: 3,
      maxChildrenPerProject: 2,
      maxReadChildren: 2,
      maxWriteChildren: 2,
      queueMax: 4,
      queueMaxPerProject: 2,
      queueTimeoutMs: 100,
    });
    const receiveAdmission = new GitReceiveAdmission({
      capacityTimeoutMs: 100,
      freeSpaceFloorBytes: 1,
      maxConcurrentReceives: 2,
      maxConcurrentReceivesPerProject: 1,
      maximumRequestBytes: 1_024,
      repositoryRoot: root,
      reservationBytes: 64 * 1_024 * 1_024,
    }, {
      availableBytes: () => Promise.resolve(4n * 1_024n * 1_024n * 1_024n),
    });
    const repository = new GitRepositoryAuthority({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 5_000,
      outputMaxBytes: 1024 * 1024,
      placementValidator: new CurrentPlacementValidator(),
      receiveAdmission,
      receivePolicy: {
        maximumBlobBytes: 32,
        maximumExpandedTreeEntries: 100_000,
        maximumRepositoryBytes: 1024 * 1024 * 1024,
        maximumTreeEntries: 8,
      },
      repositoryRoot: root,
      resourceAdmission: resources,
      storageNodeId: 'node-a',
    });
    let mainOid = '';
    let latestReceiveError: unknown;
    const personalRef = collabMemberRef('member-a');
    const authority: GitReceivePackWriteAuthority = {
      advertiseReceivePack: async (
        principal: IngressPrincipal,
        _projectId: string,
        options?: Readonly<{
          readonly gitProtocol?: 'version=1' | 'version=2';
          readonly signal?: AbortSignal;
        }>,
      ): Promise<Buffer> => {
        assert.equal(principal.actorId, 'member-a');
        const reservation = await repository.reserveReceivePack('project-a', options);
        try {
          return await repository.advertiseReceivePack(reservation, placement, {
            expectedMainOid: mainOid,
            ...(options?.gitProtocol === undefined
              ? {}
              : { gitProtocol: options.gitProtocol }),
            memberId: 'member-a',
            personalRef,
            revalidateAuthority: () => Promise.resolve(),
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          });
        } finally {
          await reservation.close();
        }
      },
      runReceivePack: async (
        principal: IngressPrincipal,
        _projectId: string,
        options: Parameters<GitReceivePackWriteAuthority['runReceivePack']>[2],
      ): Promise<void> => {
        assert.equal(principal.actorId, 'member-a');
        const reservation = await repository.reserveReceivePack('project-a', options);
        try {
          try {
            await repository.runReceivePack(reservation, placement, {
              ...options,
              expectedMainOid: mainOid,
              memberId: 'member-a',
              personalRef,
              revalidateAuthority: () => Promise.resolve(),
            });
          } catch (error: unknown) {
            latestReceiveError = error;
            throw error;
          }
        } finally {
          await reservation.close();
        }
      },
    };
    const route = new GitReceivePackRoutes({
      authority,
      maximumRequestBytes: 1_024,
      maximumResponseBytes: 1024 * 1024,
      operationTimeoutMs: 5_000,
      principalAdapter: new DevelopmentPrincipalAdapter({
        profile: 'loopback-development',
      }),
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      routes: [route],
    });
    try {
      await execFileAsync(GIT_EXECUTABLE, ['init', '--initial-branch=main', work]);
      await execFileAsync(GIT_EXECUTABLE, ['config', 'user.email', 'test@example.invalid'], {
        cwd: work,
      });
      await execFileAsync(GIT_EXECUTABLE, ['config', 'user.name', 'Test User'], {
        cwd: work,
      });
      await writeFile(join(work, 'cloud.txt'), 'base\n');
      await execFileAsync(GIT_EXECUTABLE, ['add', 'cloud.txt'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'base'], { cwd: work });
      mainOid = (await execFileAsync(
        GIT_EXECUTABLE,
        ['rev-parse', 'HEAD'],
        { cwd: work, encoding: 'utf8' },
      )).stdout.trim();
      await execFileAsync(GIT_EXECUTABLE, ['branch', 'members/member-a'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, [
        'clone',
        '--bare',
        work,
        repositoryPath(root, placement),
      ]);

      await writeFile(join(work, 'cloud.txt'), 'personal update\n');
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-am', 'personal'], { cwd: work });
      const personalOid = (await execFileAsync(
        GIT_EXECUTABLE,
        ['rev-parse', 'HEAD'],
        { cwd: work, encoding: 'utf8' },
      )).stdout.trim();
      const address = await server.start();
      const repositoryUrl = `http://${address.host}:${String(
        address.port,
      )}/v1/projects/project-a/repository.git`;
      await execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        repositoryUrl,
        `HEAD:${personalRef}`,
      ], { cwd: work });

      assert.equal(
        (await execFileAsync(
          GIT_EXECUTABLE,
          ['rev-parse', personalRef],
          { cwd: repositoryPath(root, placement), encoding: 'utf8' },
        )).stdout.trim(),
        personalOid,
      );
      assert.equal(
        (await execFileAsync(
          GIT_EXECUTABLE,
          ['rev-parse', COLLAB_MAIN_REF],
          { cwd: repositoryPath(root, placement), encoding: 'utf8' },
        )).stdout.trim(),
        mainOid,
      );
      assert.equal(await readFile(join(work, 'cloud.txt'), 'utf8'), 'personal update\n');

      await assert.rejects(execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        repositoryUrl,
        `HEAD:${collabMemberRef('member-new')}`,
      ], { cwd: work }));
      await assert.rejects(execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        repositoryUrl,
        `:${personalRef}`,
      ], { cwd: work }));
      await execFileAsync(GIT_EXECUTABLE, ['reset', '--hard', mainOid], { cwd: work });
      await assert.rejects(execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        '--force',
        repositoryUrl,
        `HEAD:${personalRef}`,
      ], { cwd: work }));
      await execFileAsync(GIT_EXECUTABLE, ['reset', '--hard', personalOid], { cwd: work });
      await writeFile(join(work, 'second.txt'), 'second personal update\n');
      await execFileAsync(GIT_EXECUTABLE, ['add', 'second.txt'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'multiple'], { cwd: work });
      await assert.rejects(execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        repositoryUrl,
        `HEAD:${personalRef}`,
        `HEAD:${COLLAB_MAIN_REF}`,
      ], { cwd: work }));
      assert.equal(
        (await execFileAsync(
          GIT_EXECUTABLE,
          ['rev-parse', COLLAB_MAIN_REF],
          { cwd: repositoryPath(root, placement), encoding: 'utf8' },
        )).stdout.trim(),
        mainOid,
      );
      assert.equal(
        (await execFileAsync(
          GIT_EXECUTABLE,
          ['rev-parse', personalRef],
          { cwd: repositoryPath(root, placement), encoding: 'utf8' },
        )).stdout.trim(),
        personalOid,
      );

      await execFileAsync(GIT_EXECUTABLE, ['reset', '--hard', personalOid], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['clean', '-fd'], { cwd: work });
      await writeFile(join(work, 'oversized.txt'), 'x'.repeat(33));
      await execFileAsync(GIT_EXECUTABLE, ['add', 'oversized.txt'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'oversized blob'], { cwd: work });
      await assert.rejects(execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        repositoryUrl,
        `HEAD:${personalRef}`,
      ], { cwd: work }));

      await execFileAsync(GIT_EXECUTABLE, ['reset', '--hard', personalOid], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['clean', '-fd'], { cwd: work });
      await writeFile(join(work, 'CON'), 'reserved\n');
      await execFileAsync(GIT_EXECUTABLE, ['add', 'CON'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'reserved path'], { cwd: work });
      await assert.rejects(execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        repositoryUrl,
        `HEAD:${personalRef}`,
      ], { cwd: work }));

      await execFileAsync(GIT_EXECUTABLE, ['reset', '--hard', personalOid], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['clean', '-fd'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${mainOid},submodule`,
      ], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'invalid mode'], { cwd: work });
      await assert.rejects(execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        repositoryUrl,
        `HEAD:${personalRef}`,
      ], { cwd: work }));

      await execFileAsync(GIT_EXECUTABLE, ['reset', '--hard', personalOid], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['clean', '-fd'], { cwd: work });
      for (let index = 0; index < 8; index += 1) {
        await writeFile(join(work, `tree-${String(index)}.txt`), 'tree\n');
      }
      await execFileAsync(GIT_EXECUTABLE, ['add', '.'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'wide tree'], { cwd: work });
      await assert.rejects(execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        repositoryUrl,
        `HEAD:${personalRef}`,
      ], { cwd: work }));
      assert.equal(
        (await execFileAsync(
          GIT_EXECUTABLE,
          ['rev-parse', personalRef],
          { cwd: repositoryPath(root, placement), encoding: 'utf8' },
        )).stdout.trim(),
        personalOid,
      );

      const personalTreeOid = (await execFileAsync(
        GIT_EXECUTABLE,
        ['rev-parse', `${personalOid}^{tree}`],
        { cwd: work, encoding: 'utf8' },
      )).stdout.trim();
      const malformedCommitPath = join(root, 'malformed-commit');
      await writeFile(
        malformedCommitPath,
        `tree ${personalTreeOid}\n`
          + `parent ${personalOid}\n`
          + 'committer Test User <test@example.invalid> 0 +0000\n'
          + '\nmissing required author header\n',
      );
      const malformedCommitOid = (await execFileAsync(
        GIT_EXECUTABLE,
        ['hash-object', '--literally', '-t', 'commit', '-w', malformedCommitPath],
        { cwd: work, encoding: 'utf8' },
      )).stdout.trim();
      await assert.rejects(execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'push',
        repositoryUrl,
        `${malformedCommitOid}:${personalRef}`,
      ], { cwd: work }));
      assert.equal(
        (await execFileAsync(
          GIT_EXECUTABLE,
          ['rev-parse', personalRef],
          { cwd: repositoryPath(root, placement), encoding: 'utf8' },
        )).stdout.trim(),
        personalOid,
      );
      assert.deepEqual(await readdir(join(root, '.claudian-receive-pack')), []);
      assert.deepEqual(
        (await readdir(join(repositoryPath(root, placement), 'objects')))
          .filter(name => name.startsWith('incoming-')),
        [],
      );

      const chunkedOverflowStatus = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          headers: {
            'content-type': 'application/x-git-receive-pack-request',
            'transfer-encoding': 'chunked',
            'x-claudian-development-actor': 'member-a',
          },
          host: address.host,
          method: 'POST',
          path: collabCloudGitRoute('project-a', 'git-receive-pack').target,
          port: address.port,
        });
        request.once('error', reject);
        request.once('response', response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        });
        request.end(Buffer.alloc(1_025));
      });
      assert.equal(latestReceiveError?.constructor.name, 'GitSmartHttpRouteFailure');
      assert.equal(chunkedOverflowStatus, 413);
    } finally {
      await server.close(1_000);
      await repository.close();
      await receiveAdmission.close();
      await resources.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('cancels a stalled body, disconnect, and shutdown at the streaming boundary', async () => {
    for (const settlement of ['deadline', 'disconnect', 'shutdown'] as const) {
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      let markCancelled!: () => void;
      const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
      const route = new GitReceivePackRoutes({
        authority: {
          advertiseReceivePack: () => Promise.resolve(Buffer.alloc(0)),
          runReceivePack: async (_principal, _projectId, options) => {
            markStarted();
            options.signal?.addEventListener('abort', markCancelled, { once: true });
            for await (const chunk of options.request) {
              // The partial request remains owned until cancellation.
              assert.ok(chunk.byteLength > 0);
            }
            if (options.signal?.aborted === true) {
              throw new ProjectWriteAdmissionError('cancelled');
            }
          },
        },
        maximumRequestBytes: 1_024,
        maximumResponseBytes: 1_024,
        operationTimeoutMs: settlement === 'deadline' ? 20 : 2_000,
        principalAdapter: new DevelopmentPrincipalAdapter({
          profile: 'loopback-development',
        }),
      });
      const server = new HttpServer({
        config: { host: '127.0.0.1', port: 0 },
        isReady: () => true,
        routes: [route],
      });
      try {
        const address = await server.start();
        const client = httpRequest({
          headers: {
            'content-length': '100',
            'content-type': 'application/x-git-receive-pack-request',
            'x-claudian-development-actor': 'member-a',
          },
          host: address.host,
          method: 'POST',
          path: collabCloudGitRoute('project-a', 'git-receive-pack').target,
          port: address.port,
        });
        client.on('error', () => undefined);
        client.write('x');
        await started;
        if (settlement === 'disconnect') client.destroy();
        if (settlement === 'shutdown') void server.close(20);
        await Promise.race([
          cancelled,
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('receive-not-cancelled')), 1_000).unref();
          }),
        ]);
      } finally {
        await server.close(1_000);
      }
    }
  });
});
