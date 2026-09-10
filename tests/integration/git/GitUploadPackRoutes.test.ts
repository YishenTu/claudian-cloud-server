import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
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
  it('decodes gzip within wire and decoded limits and rejects malformed encodings safely', async () => {
    const received: Buffer[] = [];
    const route = new GitUploadPackRoutes({
      authority: {
        advertiseUploadPack: () => Promise.resolve(Buffer.alloc(0)),
        runUploadPack: (_principal, _projectId, options) => {
          received.push(options.request);
          return Promise.resolve();
        },
      },
      maximumRequestBytes: 128,
      maximumResponseBytes: 1_024,
      operationTimeoutMs: 1_000,
      principalAdapter: new DevelopmentPrincipalAdapter({ profile: 'loopback-development' }),
    });
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 }, isReady: () => true, routes: [route],
    });
    const literal = Buffer.from('0000');
    const compressed = gzipSync(literal);
    const wireOversize = gzipSync(Buffer.from(Array.from({ length: 128 }, (_, index) => index)));
    assert.ok(wireOversize.length > 128);
    try {
      const address = await server.start();
      const url = `http://${address.host}:${String(address.port)}${collabCloudGitRoute('project-a', 'git-upload-pack').target}`;
      for (const example of [
        { encoding: 'identity', body: literal, status: 200, decoded: literal },
        { encoding: 'gzip', body: compressed, status: 200, decoded: literal },
        { encoding: 'GZip', body: compressed, status: 200, decoded: literal },
        { encoding: 'gzip', body: Buffer.concat([compressed, compressed]), status: 200, decoded: Buffer.from('00000000') },
        { encoding: 'gzip', body: gzipSync(Buffer.alloc(128, 120)), status: 200, decoded: Buffer.alloc(128, 120) },
        { encoding: 'gzip', body: gzipSync(Buffer.alloc(129, 120)), status: 413 },
        { encoding: 'gzip', body: wireOversize, status: 413 },
        { encoding: 'gzip', body: Buffer.from('private-invalid-gzip-body'), status: 400 },
        { encoding: 'gzip', body: compressed.subarray(0, -3), status: 400 },
        { encoding: 'gzip', body: Buffer.alloc(0), status: 400 },
        { encoding: 'gzip, gzip', body: compressed, status: 415 },
        { encoding: 'br', body: compressed, status: 415 },
      ]) {
        const before = received.length;
        const response = await fetch(url, {
          method: 'POST', body: example.body,
          headers: {
            'content-type': 'application/x-git-upload-pack-request',
            'content-encoding': example.encoding,
            'x-claudian-development-actor': 'member-a',
          },
        });
        assert.equal(response.status, example.status, example.encoding);
        assert.equal(await response.text(), '');
        if (example.decoded !== undefined) {
          assert.equal(received.length, before + 1);
          assert.deepEqual(received.at(-1), example.decoded);
        } else {
          assert.equal(received.length, before);
        }
      }
    } finally {
      await server.close(1_000);
    }
  });

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

  it('serves authenticated full clones and fetches with gzip requests and twenty Member refs', async () => {
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
    let gzipRequests = 0;
    const server = new HttpServer({
      config: { host: '127.0.0.1', port: 0 },
      isReady: () => true,
      routes: [{
        handle(request, response) {
          if (request.headers['content-encoding'] === 'gzip') gzipRequests += 1;
          return route.handle(request, response);
        },
      }],
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
      const members = Array.from({ length: 20 }, (_, index) => `refs/heads/members/member-${String(index)}`);
      for (const name of members) {
        await execFileAsync(GIT_EXECUTABLE, ['update-ref', name, mainOid.trim()], { cwd: work });
      }
      expectedRefs = [COLLAB_MAIN_REF, ...members].map(name => ({ name, oid: mainOid.trim() }));
      await execFileAsync(GIT_EXECUTABLE, [
        'clone',
        '--bare',
        work,
        repositoryPath(root, placement),
      ]);

      const address = await server.start();
      const origin = `http://${address.host}:${String(address.port)}`;
      const repositoryUrl = `${origin}/v6/projects/project-a/repository.git`;
      await execFileAsync(GIT_EXECUTABLE, [
        '-c',
        'http.extraHeader=x-claudian-development-actor: member-a',
        'clone',
        repositoryUrl,
        checkout,
      ]);
      assert.equal(await readFile(join(checkout, 'cloud.txt'), 'utf8'), 'cloud authority\n');
      assert.equal(revalidations >= 2, true);
      assert.ok(gzipRequests > 0);
      const clonedRefs = (await execFileAsync(GIT_EXECUTABLE, [
        'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/members',
      ], { cwd: checkout })).stdout.trim().split('\n');
      assert.equal(clonedRefs.length, 20);
      const cloneGzipRequests = gzipRequests;
      await execFileAsync(GIT_EXECUTABLE, [
        '-c', 'http.extraHeader=x-claudian-development-actor: member-a',
        'fetch', '--refetch', 'origin',
      ], { cwd: checkout });
      assert.ok(gzipRequests > cloneGzipRequests);
      assert.equal(await readFile(join(checkout, 'cloud.txt'), 'utf8'), 'cloud authority\n');


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

  it('cancels a stalled gzip upload-pack body at the route deadline', async () => {
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
      let responseStatus: number | undefined;
      const settled = new Promise<void>(resolve => {
        const client = httpRequest({
          headers: {
            'content-length': '100',
            'content-encoding': 'gzip',
            'content-type': 'application/x-git-upload-pack-request',
            'x-claudian-development-actor': 'member-a',
          },
          host: address.host,
          method: 'POST',
          path: collabCloudGitRoute('project-a', 'git-upload-pack').target,
          port: address.port,
        }, response => {
          responseStatus = response.statusCode;
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
      assert.ok(responseStatus === undefined || responseStatus === 408);
      assert.equal(runCount, 0);
    } finally {
      await server.close(1_000);
    }
  });

  it('closes rejected or cancelled incomplete gzip uploads before admitting Git work', async () => {
    for (const mode of ['declared-limit', 'chunked-limit', 'disconnect', 'shutdown'] as const) {
      let runCount = 0;
      let markHandled!: () => void;
      const handled = new Promise<void>(resolve => { markHandled = resolve; });
      let markClosed!: () => void;
      const closed = new Promise<void>(resolve => { markClosed = resolve; });
      const route = new GitUploadPackRoutes({
        authority: {
          advertiseUploadPack: () => Promise.resolve(Buffer.alloc(0)),
          runUploadPack: () => { runCount += 1; return Promise.resolve(); },
        },
        maximumRequestBytes: 128,
        maximumResponseBytes: 1_024,
        operationTimeoutMs: 2_000,
        principalAdapter: new DevelopmentPrincipalAdapter({ profile: 'loopback-development' }),
      });
      const server = new HttpServer({
        config: { host: '127.0.0.1', port: 0 }, isReady: () => true,
        routes: [{
          handle(request, response) {
            request.once('close', markClosed);
            const accepted = route.handle(request, response);
            markHandled();
            return accepted;
          },
        }],
      });
      try {
        const address = await server.start();
        let status: number | undefined;
        let resolveResponse!: () => void;
        const responseEnded = new Promise<void>(resolve => { resolveResponse = resolve; });
        const client = httpRequest({
          host: address.host, port: address.port, method: 'POST',
          path: collabCloudGitRoute('project-a', 'git-upload-pack').target,
          headers: {
            'content-type': 'application/x-git-upload-pack-request',
            'content-encoding': 'gzip',
            'x-claudian-development-actor': 'member-a',
            ...(mode === 'declared-limit' ? { 'content-length': '256' } : {}),
          },
        }, response => {
          status = response.statusCode;
          response.resume();
          response.once('end', resolveResponse);
        });
        client.once('error', resolveResponse);
        client.write(mode === 'chunked-limit' ? Buffer.alloc(256, 120) : Buffer.from([0x1f, 0x8b]));
        await handled;
        if (mode === 'disconnect') client.destroy();
        if (mode === 'shutdown') await server.close(20);
        await Promise.race([
          Promise.all([closed, responseEnded]),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`gzip-upload-not-settled:${mode}`)), 1_000).unref();
          }),
        ]);
        if (mode === 'declared-limit' || mode === 'chunked-limit') assert.equal(status, 413);
        assert.equal(runCount, 0);
      } finally {
        await server.close(1_000);
      }
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
