import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const protocolPackageName = '@claudian-collab/protocol';
const protocolVersion = '4.1.3';
const protocolRegistryArtifact = 'https://registry.npmjs.org/@claudian-collab/protocol/-/protocol-4.1.3.tgz';
const protocolIntegrity = 'sha512-WU1Z8GXd5B6wLmZxHnl3MqI6DCkNF+5QTDzIT/pOGy0xoyQwHc2UP6V9MzlZPZ66k+85ppZcmUjb9kfYQHw0mg==';

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
  it('pins the exact registry protocol and WebSocket dependencies', async () => {
    const manifest = await readJson<PackageManifest>(
      resolve(repositoryRoot, 'package.json'),
    );
    const lock = await readJson<PackageLock>(
      resolve(repositoryRoot, 'package-lock.json'),
    );
    const installedProtocol = await readJson<PackageManifest>(
      resolve(repositoryRoot, `node_modules/${protocolPackageName}/package.json`),
    );
    const installedWs = await readJson<PackageManifest>(
      resolve(repositoryRoot, 'node_modules/ws/package.json'),
    );
    const installedWsTypes = await readJson<PackageManifest>(
      resolve(repositoryRoot, 'node_modules/@types/ws/package.json'),
    );
    const protocolLock = lock.packages[`node_modules/${protocolPackageName}`];

    assert.equal(manifest.dependencies[protocolPackageName], protocolVersion);
    assert.equal(manifest.dependencies['@claudian/collab-protocol'], undefined);
    assert.equal(manifest.dependencies.ws, '8.21.3');
    assert.equal(manifest.devDependencies['@types/ws'], '8.18.1');
    assert.equal(installedProtocol.version, protocolVersion);
    assert.equal(installedWs.version, '8.21.3');
    assert.equal(installedWsTypes.version, '8.18.1');
    assert.ok(protocolLock);
    assert.equal(protocolLock.version, protocolVersion);
    assert.equal(protocolLock.resolved, protocolRegistryArtifact);
    assert.equal(protocolLock.integrity, protocolIntegrity);
    assert.equal(lock.packages['node_modules/ws']?.version, '8.21.3');
    assert.equal(lock.packages['node_modules/@types/ws']?.version, '8.18.1');
    assert.equal(lock.packages['node_modules/bufferutil'], undefined);
    assert.equal(lock.packages['node_modules/utf-8-validate'], undefined);
  });

  it('does not retain a vendored protocol package', async () => {
    await assert.rejects(access(resolve(repositoryRoot, 'vendor')));
  });

  it('loads the exact ws server API without optional native accelerators', async () => {
    const ws = await import('ws');

    assert.equal(typeof ws.WebSocket, 'function');
    assert.equal(typeof ws.WebSocketServer, 'function');
    assert.equal(typeof ws.createWebSocketStream, 'function');
  });

  it('loads the Step 14 contract only from the exact installed registry artifact', async () => {
    const protocol = await import('@claudian-collab/protocol');

    assert.equal(protocol.COLLAB_PROTOCOL_VERSION, 8);
    assert.equal(protocol.COLLAB_CLOUD_BINDING_VERSION, 4);
    assert.equal(protocol.COLLAB_PROJECT_BACKUP_COORDINATION_FORMAT_VERSION, 3);
    assert.deepEqual(protocol.COLLAB_PROJECT_MEMBERSHIP_OPERATIONS, [
      'createCloudProject',
      'createProjectInvitation',
      'listProjectInvitations',
      'revokeProjectInvitation',
      'joinCloudProject',
      'listProjectMembers',
      'reissueTransferredMembershipClaim',
      'revokeTransferredMembershipClaim',
      'createManagerResponsibilityOffer',
      'listCurrentManagerResponsibilityOffers',
      'getManagerResponsibilityOffer',
      'acknowledgeManagerResponsibility',
      'declineManagerResponsibility',
      'cancelManagerResponsibilityOffer',
      'promoteManager',
      'demoteManager',
      'removeMember',
      'leaveProject',
    ]);
  });
});
