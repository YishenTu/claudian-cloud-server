import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '../..');
const protocolArtifact = 'claudian-collab-protocol-0.4.0.tgz';
const protocolIntegrity = 'sha512-4IDJr55ohdCcgn/RLpMghevuUxf5vwc3VIEgJr5HowzbmGuUNpGjHbn4wuMkOXGKBD0lvm85D4du5Sfwq8OfbQ==';
const protocolSha256 = 'e45d8cbe8b4d7558f66547acf5ad6c74bfc1362226a4642562c2d707c25786b1';

interface PackageManifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly version: string;
}

interface PackageLock {
  readonly packages: Readonly<Partial<Record<string, {
    readonly integrity?: string;
    readonly resolved?: string;
    readonly version?: string;
  }>>>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

describe('Cloud transport dependency baseline', () => {
  it('pins the exact merged protocol artifact and WebSocket dependencies', async () => {
    const manifest = await readJson<PackageManifest>(
      resolve(repositoryRoot, 'package.json'),
    );
    const lock = await readJson<PackageLock>(
      resolve(repositoryRoot, 'package-lock.json'),
    );
    const installedProtocol = await readJson<PackageManifest>(
      resolve(repositoryRoot, 'node_modules/@claudian/collab-protocol/package.json'),
    );
    const installedWs = await readJson<PackageManifest>(
      resolve(repositoryRoot, 'node_modules/ws/package.json'),
    );
    const installedWsTypes = await readJson<PackageManifest>(
      resolve(repositoryRoot, 'node_modules/@types/ws/package.json'),
    );
    const protocolLock = lock.packages['node_modules/@claudian/collab-protocol'];

    assert.equal(
      manifest.dependencies['@claudian/collab-protocol'],
      `file:vendor/${protocolArtifact}`,
    );
    assert.equal(manifest.dependencies.ws, '8.21.3');
    assert.equal(manifest.devDependencies['@types/ws'], '8.18.1');
    assert.equal(installedProtocol.version, '0.4.0');
    assert.equal(installedWs.version, '8.21.3');
    assert.equal(installedWsTypes.version, '8.18.1');
    assert.ok(protocolLock);
    assert.equal(protocolLock.version, '0.4.0');
    assert.equal(
      protocolLock.resolved,
      `file:vendor/${protocolArtifact}`,
    );
    assert.equal(
      protocolLock.integrity,
      protocolIntegrity,
    );
    assert.equal(lock.packages['node_modules/ws']?.version, '8.21.3');
    assert.equal(lock.packages['node_modules/@types/ws']?.version, '8.18.1');
    assert.equal(lock.packages['node_modules/bufferutil'], undefined);
    assert.equal(lock.packages['node_modules/utf-8-validate'], undefined);
  });

  it('vendors only the exact 34-file producer artifact with recorded provenance', async () => {
    assert.deepEqual((await readdir(resolve(repositoryRoot, 'vendor'))).sort(), [
      'README.md',
      protocolArtifact,
    ]);
    const provenance = await readFile(
      resolve(repositoryRoot, 'vendor/README.md'),
      'utf8',
    );
    assert.match(
      provenance,
      /c0522e04ffc083e9e6bda15cfa8411d4784e2205/,
    );
    assert.match(
      provenance,
      new RegExp(protocolSha256),
    );

    const artifact = await readFile(
      resolve(repositoryRoot, 'vendor', protocolArtifact),
    );
    assert.equal(createHash('sha256').update(artifact).digest('hex'), protocolSha256);

    const { stdout } = await execFileAsync('tar', [
      '-tzf',
      resolve(repositoryRoot, 'vendor', protocolArtifact),
    ]);
    const inventory = stdout.trim().split('\n').sort();
    assert.equal(inventory.length, 34);
    assert.deepEqual(inventory.slice(0, 4), [
      'package/README.md',
      'package/dist/CollabCloudBinding.d.ts',
      'package/dist/CollabCloudBinding.js',
      'package/dist/CollabCloudProjectEvent.d.ts',
    ]);
    assert.deepEqual(inventory.slice(-2), [
      'package/dist/types.js',
      'package/package.json',
    ]);
  });

  it('loads the exact ws server API without optional native accelerators', async () => {
    const ws = await import('ws');

    assert.equal(typeof ws.WebSocket, 'function');
    assert.equal(typeof ws.WebSocketServer, 'function');
    assert.equal(typeof ws.createWebSocketStream, 'function');
  });
});
