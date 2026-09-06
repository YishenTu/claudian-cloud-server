import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { COLLAB_MAIN_REF, collabCloudGitRoute } from '@claudian-collab/protocol';

import {
  ProjectReadAuthorityError,
} from '../../../src/project-authority/reads/ProjectReadAuthority.js';
import { DevelopmentPrincipalAdapter } from '../../../src/request-context/DevelopmentPrincipalAdapter.js';
import type { RequestPrincipal } from '../../../src/request-context/RequestPrincipal.js';
import { ResourceAdmission } from '../../../src/resource-admission/ResourceAdmission.js';
import {
  GitRepositoryAuthority,
  GitRepositoryError,
} from '../../../src/repositories/GitRepositoryAuthority.js';
import {
  createRepositoryPlacementLease,
  type RepositoryPlacementLease,
  type RepositoryPlacementValidator,
} from '../../../src/repositories/RepositoryPlacement.js';
import { GitUploadPackRoutes } from '../../../src/server/git/GitUploadPackRoutes.js';
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

describe('GitUploadPackRoutes', () => {
  it('maps every pre-output RPC failure before committing success headers', async () => {
    const route = new GitUploadPackRoutes({
      authority: {
        advertiseUploadPack: () => Promise.resolve(Buffer.alloc(0)),
        runUploadPack: (_principal, projectId) => {
          if (projectId === 'project-busy') {
            return Promise.reject(new GitRepositoryError('busy'));
          }
          return Promise.reject(new ProjectReadAuthorityError(
            projectId === 'project-unrelated'
              ? 'authorization-denied'
              : 'project-not-found',
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
      const origin = `http://${address.host}:${String(address.port)}`;
      const statuses = [];
      for (const projectId of [
        'project-unrelated',
        'project-unknown',
        'project-busy',
      ]) {
        const response = await fetch(
          `${origin}${collabCloudGitRoute(projectId, 'git-upload-pack').target}`,
          {
            body: '0000',
            headers: {
              'content-type': 'application/x-git-upload-pack-request',
              'x-claudian-development-actor': 'member-a',
            },
            method: 'POST',
          },
        );
        statuses.push(response.status);
        await response.arrayBuffer();
      }
      assert.deepEqual(statuses, [404, 404, 503]);
    } finally {
      await server.close(1_000);
    }
  });

  it('honors supervisor-owned cancellation at the response callback boundary', async () => {
    const route = new GitUploadPackRoutes({
      authority: {
        advertiseUploadPack: () => Promise.resolve(Buffer.alloc(0)),
        runUploadPack: async (_principal, _projectId, options) => {
          const supervisor = new AbortController();
          supervisor.abort();
          await (options.onResponseChunk as (
            chunk: Buffer,
            signal: AbortSignal,
          ) => Promise<void>)(Buffer.from('pack'), supervisor.signal);
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
      const response = await fetch(
        `http://${address.host}:${String(address.port)}${collabCloudGitRoute(
          'project-a',
          'git-upload-pack',
        ).target}`,
        {
          body: '0000',
          headers: {
            'content-type': 'application/x-git-upload-pack-request',
            'x-claudian-development-actor': 'member-a',
          },
          method: 'POST',
        },
      );
      assert.equal(response.status, 408);
      await response.arrayBuffer();
    } finally {
      await server.close(1_000);
    }
  });

  it('serves a real authenticated Git advertisement and clone without paths in transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-upload-pack-'));
    const work = join(root, 'work');
    const checkout = join(root, 'checkout');
    const placement = createRepositoryPlacementLease({
      active: true,
      generation: 1,
      projectId: 'project-a',
      repositoryStorageKey: 'repository-a',
      storageNodeId: 'node-a',
    });
    const admission = new ResourceAdmission({
      maxChildren: 2,
      maxChildrenPerProject: 1,
      queueMax: 2,
      queueMaxPerProject: 1,
      queueTimeoutMs: 100,
    });
    const repository = new GitRepositoryAuthority({
      gitExecutable: GIT_EXECUTABLE,
      operationTimeoutMs: 2_000,
      outputMaxBytes: 1024 * 1024,
      placementValidator: new CurrentPlacementValidator(),
      repositoryRoot: root,
      resourceAdmission: admission,
      storageNodeId: 'node-a',
    });
    let expectedRefs: readonly { readonly name: string; readonly oid?: string }[] = [];
    let revalidations = 0;
    const authorize = (principal: RequestPrincipal): void => {
      if (principal.principalId !== 'member-a') {
        throw new ProjectReadAuthorityError('authorization-denied');
      }
      revalidations += 1;
    };
    const authority = {
      advertiseUploadPack: (
        principal: RequestPrincipal,
        _projectId: string,
        options?: Readonly<{
          readonly gitProtocol?: 'version=1' | 'version=2';
          readonly signal?: AbortSignal;
        }>,
      ): Promise<Buffer> => {
        authorize(principal);
        return repository.advertiseUploadPack(
          placement,
          {
            expectedRefs,
            ...(options?.gitProtocol === undefined
              ? {}
              : { gitProtocol: options.gitProtocol }),
            revalidateAuthority: () => {
              authorize(principal);
              return Promise.resolve();
            },
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          },
        );
      },
      runUploadPack: (
        principal: RequestPrincipal,
        _projectId: string,
        options: Parameters<GitRepositoryAuthority['runUploadPack']>[1],
      ): Promise<void> => {
        authorize(principal);
        return repository.runUploadPack(placement, {
          ...options,
          expectedRefs,
          revalidateAuthority: () => {
            authorize(principal);
            return Promise.resolve();
          },
        });
      },
    };
    const route = new GitUploadPackRoutes({
      authority,
      maximumRequestBytes: 1024 * 1024,
      maximumResponseBytes: 1024 * 1024 * 1024,
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
      await execFileAsync(GIT_EXECUTABLE, ['init', '--initial-branch=main', work]);
      await execFileAsync(GIT_EXECUTABLE, ['config', 'user.email', 'test@example.invalid'], {
        cwd: work,
      });
      await execFileAsync(GIT_EXECUTABLE, ['config', 'user.name', 'Test User'], {
        cwd: work,
      });
      await writeFile(join(work, 'cloud.txt'), 'cloud authority\n');
      await execFileAsync(GIT_EXECUTABLE, ['add', 'cloud.txt'], { cwd: work });
      await execFileAsync(GIT_EXECUTABLE, ['commit', '-m', 'fixture'], { cwd: work });
      const { stdout: mainOid } = await execFileAsync(
        GIT_EXECUTABLE,
        ['rev-parse', 'HEAD'],
        { cwd: work, encoding: 'utf8' },
      );
      expectedRefs = [{ name: COLLAB_MAIN_REF, oid: mainOid.trim() }];
      await execFileAsync(GIT_EXECUTABLE, [
        'clone',
        '--bare',
        work,
        repositoryPath(root, placement),
      ]);

      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      const repositoryUrl = `${origin}/v5/projects/project-a/repository.git`;
      await execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'clone',
        repositoryUrl,
        checkout,
      ]);
      assert.equal(await readFile(join(checkout, 'cloud.txt'), 'utf8'), 'cloud authority\n');
      assert.equal(revalidations >= 2, true);

      await assert.rejects(
        execFileAsync(GIT_EXECUTABLE, ['ls-remote', repositoryUrl]),
        error => {
          assert.doesNotMatch(String(error), new RegExp(root));
          return true;
        },
      );

      const invalid = await fetch(
        `${origin}${collabCloudGitRoute('project-a', 'git-upload-pack').target}`,
        {
          body: 'invalid',
          headers: {
            'content-type': 'text/plain',
            'x-claudian-development-actor': 'member-a',
          },
          method: 'POST',
        },
      );
      assert.equal(invalid.status, 415);
    } finally {
      await server.close(1_000);
      await repository.close();
      await admission.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('cancels a stalled partial upload-pack body at the route deadline', async () => {
    let runCount = 0;
    const route = new GitUploadPackRoutes({
      authority: {
        advertiseUploadPack: () => Promise.resolve(Buffer.alloc(0)),
        runUploadPack: () => {
          runCount += 1;
          return Promise.resolve();
        },
      },
      maximumRequestBytes: 1_024,
      maximumResponseBytes: 1_024,
      operationTimeoutMs: 20,
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
      const settled = new Promise<void>(resolve => {
        const client = httpRequest({
          headers: {
            'content-length': '100',
            'content-type': 'application/x-git-upload-pack-request',
            'x-claudian-development-actor': 'member-a',
          },
          host: address.host,
          method: 'POST',
          path: collabCloudGitRoute('project-a', 'git-upload-pack').target,
          port: address.port,
        }, response => {
          response.resume();
          response.once('end', resolve);
        });
        client.once('error', () => resolve());
        client.write('x');
      });
      await Promise.race([
        settled,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('partial-body-not-cancelled')), 1_000).unref();
        }),
      ]);
      assert.equal(runCount, 0);
    } finally {
      await server.close(1_000);
    }
  });

  it('stops producing upload-pack output while the client applies backpressure', async () => {
    const chunkCount = 512;
    const chunk = Buffer.alloc(64 * 1_024, 1);
    let produced = 0;
    let productionCompleted = false;
    let markProductionCompleted!: () => void;
    const completed = new Promise<void>(resolve => {
      markProductionCompleted = resolve;
    });
    const route = new GitUploadPackRoutes({
      authority: {
        advertiseUploadPack: () => Promise.resolve(Buffer.alloc(0)),
        runUploadPack: async (_principal, _projectId, options) => {
          const signal = new AbortController().signal;
          for (let index = 0; index < chunkCount; index += 1) {
            await options.onResponseChunk(chunk, signal);
            produced += 1;
          }
          productionCompleted = true;
          markProductionCompleted();
        },
      },
      maximumRequestBytes: 1_024,
      maximumResponseBytes: chunkCount * chunk.length,
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
      const address = await server.start();
      let resumeResponse!: () => void;
      let markHeadersReceived!: () => void;
      const headersReceived = new Promise<void>(resolve => {
        markHeadersReceived = resolve;
      });
      const responseEnded = new Promise<void>((resolve, reject) => {
        const client = httpRequest({
          headers: {
            'content-type': 'application/x-git-upload-pack-request',
            'x-claudian-development-actor': 'member-a',
          },
          host: address.host,
          method: 'POST',
          path: collabCloudGitRoute('project-a', 'git-upload-pack').target,
          port: address.port,
        }, response => {
          response.pause();
          resumeResponse = () => response.resume();
          markHeadersReceived();
          response.once('end', resolve);
          response.once('error', reject);
        });
        client.once('error', reject);
        client.end('0000');
      });

      await headersReceived;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      assert.equal(productionCompleted, false);
      assert.equal(produced < chunkCount, true);
      resumeResponse();
      await Promise.all([completed, responseEnded]);
      assert.equal(produced, chunkCount);
    } finally {
      await server.close(1_000);
    }
  });

  it('cancels admitted response work when the client disconnects or the server closes', async () => {
    for (const settlement of ['disconnect', 'shutdown'] as const) {
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      let markCancelled!: () => void;
      const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
      const route = new GitUploadPackRoutes({
        authority: {
          advertiseUploadPack: () => Promise.resolve(Buffer.alloc(0)),
          runUploadPack: (_principal, _projectId, options) => new Promise(
            (_resolve, reject) => {
              markStarted();
              options.signal?.addEventListener('abort', () => {
                markCancelled();
                reject(new ProjectReadAuthorityError('cancelled'));
              }, { once: true });
            },
          ),
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
        const client = httpRequest({
          headers: {
            'content-type': 'application/x-git-upload-pack-request',
            'x-claudian-development-actor': 'member-a',
          },
          host: address.host,
          method: 'POST',
          path: collabCloudGitRoute('project-a', 'git-upload-pack').target,
          port: address.port,
        });
        client.on('error', () => undefined);
        client.end('0000');
        await started;
        if (settlement === 'disconnect') client.destroy();
        else void server.close(20);
        await cancelled;
      } finally {
        await server.close(1_000);
      }
    }
  });
});
