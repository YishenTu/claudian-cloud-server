import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const protocolPackageName = '@claudian-collab/protocol';
const protocolVersion = '4.4.1';
const protocolRegistryArtifact = 'https://registry.npmjs.org/@claudian-collab/protocol/-/protocol-4.4.1.tgz';
const protocolIntegrity = 'sha512-m62BckiHeylswydQNeBs/4y5OUNlbb2qpLpI4O+WWMrlz0y3g7JdWfnqEMcKEHJO4UNmSmuJXgIZl4amu68xmw==';

interface PackageManifest {
  readonly dependencies: Readonly<Record<string, string>>;
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
  it('consumes the reviewed protocol registry artifact', async () => {
    const manifest = await readJson<PackageManifest>(
      resolve(repositoryRoot, 'package.json'),
    );
    const lock = await readJson<PackageLock>(
      resolve(repositoryRoot, 'package-lock.json'),
    );
    const installedProtocol = await readJson<PackageManifest>(
      resolve(repositoryRoot, `node_modules/${protocolPackageName}/package.json`),
    );
    const protocolLock = lock.packages[`node_modules/${protocolPackageName}`];

    assert.equal(manifest.dependencies[protocolPackageName], protocolVersion);
    assert.equal(installedProtocol.version, protocolVersion);
    assert.ok(protocolLock);
    assert.equal(protocolLock.version, protocolVersion);
    assert.equal(protocolLock.resolved, protocolRegistryArtifact);
    assert.equal(protocolLock.integrity, protocolIntegrity);
  });

  it('does not retain a vendored protocol package', async () => {
    await assert.rejects(access(resolve(repositoryRoot, 'vendor')));
  });

});
