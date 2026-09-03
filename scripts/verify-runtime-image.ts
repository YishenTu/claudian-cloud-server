import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  COLLAB_PROTOCOL_VERSION,
  collabCloudCapabilitiesRoute,
  collabCloudProjectOperationRoute,
  decodeCollabCloudCapabilityDocument,
} from '@claudian-collab/protocol';

import { PostgresMigrator } from '../src/coordination/postgres/PostgresMigrator.js';
import { acquirePostgresTestDatabase } from '../tests/helpers/PostgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const IMAGE = 'claudian-cloud-server:local';
const EXPECTED_SERVER_BUILD = 'c'.repeat(40);

async function docker(arguments_: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('docker', [...arguments_], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    throw new Error('runtime-image-docker-failed');
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('runtime-image-port-unavailable');
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

function parseEvents(chunks: readonly string[]): readonly string[] {
  return chunks.join('')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const value: unknown = JSON.parse(line);
      if (
        typeof value !== 'object'
        || value === null
        || !('event' in value)
        || typeof value.event !== 'string'
      ) {
        throw new Error('runtime-image-log-invalid');
      }
      return value.event;
    });
}

async function waitForHealth(
  origin: string,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('runtime-image-exited-before-ready');
    }
    try {
      const response = await fetch(`${origin}/readyz`);
      if (response.status === 200) return;
    } catch {
      // The listener is expected to refuse connections during startup checks.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('runtime-image-readiness-timeout');
}

function proxyV2Ipv4Frame(): Buffer {
  return Buffer.from([
    0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51,
    0x55, 0x49, 0x54, 0x0a, 0x21, 0x11, 0x00, 0x0c,
    100, 64, 0, 10,
    127, 0, 0, 1,
    0x30, 0x39, 0x22, 0x53,
  ]);
}

async function rawRequest(port: number, chunks: readonly Buffer[]): Promise<string> {
  const socket = createConnection({ host: '127.0.0.1', port });
  const response: Buffer[] = [];
  socket.on('data', chunk => response.push(Buffer.from(chunk)));
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  for (const chunk of chunks) socket.write(chunk);
  await once(socket, 'close');
  return Buffer.concat(response).toString('utf8');
}

async function verifyRuntimeImage(): Promise<void> {
  assert.equal(
    await docker(['image', 'inspect', IMAGE, '--format', '{{.Config.User}} {{.Config.StopSignal}}']),
    '10001:10001 SIGTERM',
  );
  assert.match(
    await docker(['run', '--rm', '--entrypoint', '/usr/bin/git', IMAGE, '--version']),
    /^git version (?:2\.(?:39|[4-9][0-9])|[3-9]\.)/,
  );
  assert.equal(
    await docker([
      'run',
      '--rm',
      '--entrypoint',
      'node',
      IMAGE,
      '--input-type=module',
      '--eval',
      "process.stdout.write((await import('/app/dist/config/ServerBuild.js')).SERVER_BUILD)",
    ]),
    EXPECTED_SERVER_BUILD,
  );

  const database = await acquirePostgresTestDatabase();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'claudian-runtime-image-'));
  const token = randomBytes(8).toString('hex');
  const containerName = `claudian-runtime-${token}`;
  const volumeName = `claudian-runtime-repositories-${token}`;
  const backupVolumeName = `claudian-runtime-backups-${token}`;
  const exportVolumeName = `claudian-runtime-exports-${token}`;
  const keyringVolumeName = `claudian-runtime-keyring-${token}`;
  const environmentFile = join(temporaryRoot, 'server.env');
  const keyringFile = join(temporaryRoot, 'keyring.json');
  let child: ReturnType<typeof spawn> | undefined;
  let backupVolumeCreated = false;
  let exportVolumeCreated = false;
  let keyringVolumeCreated = false;
  let volumeCreated = false;

  try {
    await new PostgresMigrator({
      connectionString: database.migrationUrl,
    }).apply();
    const port = await findAvailablePort();
    await writeFile(
      environmentFile,
      [
        'CLAUDIAN_CLOUD_BIND_HOST=127.0.0.1',
        'CLAUDIAN_CLOUD_GIT_EXECUTABLE=/usr/bin/git',
        `CLAUDIAN_CLOUD_PORT=${String(port)}`,
        `CLAUDIAN_CLOUD_POSTGRES_URL=${database.runtimeUrl}`,
        'CLAUDIAN_CLOUD_PRINCIPAL_PROFILE=trusted-ingress',
        'CLAUDIAN_CLOUD_REPOSITORY_ROOT=/var/lib/claudian-cloud/repositories',
        'CLAUDIAN_CLOUD_STAGING_ROOT=/var/lib/claudian-cloud/staging',
        'CLAUDIAN_CLOUD_STORAGE_NODE_ID=image-test-node',
        'CLAUDIAN_CLOUD_TRUSTED_INGRESS_MODE=proxy-v2',
        'CLAUDIAN_CLOUD_TRUSTED_INGRESS_PROVIDER_ID=runtime-image',
        `CLAUDIAN_CLOUD_TRUSTED_INGRESS_SOURCE_MAP=${JSON.stringify([{
          principalId: 'principal-runtime-image',
          sourceAddress: '100.64.0.10',
        }])}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const pair = generateKeyPairSync('ed25519');
    await writeFile(keyringFile, JSON.stringify({
      activeEncryptionKeyId: 'runtime-image-encryption-key',
      activeReceiptKeyId: 'runtime-image-receipt-key',
      encryptionKeys: [{
        key: Buffer.alloc(32, 7).toString('base64url'),
        keyId: 'runtime-image-encryption-key',
        keyVersion: 1,
      }],
      receiptKeys: [{
        keyId: 'runtime-image-receipt-key',
        keyVersion: 1,
        privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' })
          .toString('base64url'),
        publicKey: pair.publicKey.export({ format: 'der', type: 'spki' })
          .toString('base64url'),
      }],
      schemaVersion: 1,
    }), { mode: 0o600 });

    await docker(['volume', 'create', volumeName]);
    volumeCreated = true;
    await docker(['volume', 'create', backupVolumeName]);
    backupVolumeCreated = true;
    await docker(['volume', 'create', exportVolumeName]);
    exportVolumeCreated = true;
    await docker(['volume', 'create', keyringVolumeName]);
    keyringVolumeCreated = true;
    await docker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--mount',
      `source=${keyringVolumeName},target=/run/secrets`,
      '--mount',
      `type=bind,source=${temporaryRoot},target=/input,readonly`,
      '--entrypoint',
      '/bin/sh',
      IMAGE,
      '-c',
      'cp /input/keyring.json /run/secrets/claudian_claim_custody_keyring && chown 10001:10001 /run/secrets/claudian_claim_custody_keyring && chmod 0400 /run/secrets/claudian_claim_custody_keyring',
    ]);
    await docker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--mount',
      `source=${volumeName},target=/var/lib/claudian-cloud`,
      '--entrypoint',
      '/bin/sh',
      IMAGE,
      '-c',
      'mkdir -p /var/lib/claudian-cloud/repositories /var/lib/claudian-cloud/staging && chmod 0700 /var/lib/claudian-cloud && chown -R 10001:10001 /var/lib/claudian-cloud && umask 077 && printf "%s\\n" "$1" > /var/lib/claudian-cloud/.authority-volume-id && chown 10001:10001 /var/lib/claudian-cloud/.authority-volume-id',
      'runtime-image-bootstrap',
      database.authorityVolumeId,
    ]);
    await docker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--mount',
      `source=${backupVolumeName},target=/var/lib/claudian-cloud-backups/artifacts`,
      '--mount',
      `source=${exportVolumeName},target=/var/lib/claudian-cloud-exports/artifacts`,
      '--entrypoint',
      '/bin/sh',
      IMAGE,
      '-c',
      'chown 10001:10001 /var/lib/claudian-cloud-backups/artifacts /var/lib/claudian-cloud-exports/artifacts && chmod 0700 /var/lib/claudian-cloud-backups/artifacts /var/lib/claudian-cloud-exports/artifacts',
    ]);
    assert.equal(await docker([
      'run',
      '--rm',
      '--network',
      'host',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--user',
      '10001:10001',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--env-file',
      environmentFile,
      '--mount',
      `source=${volumeName},target=/var/lib/claudian-cloud`,
      '--mount',
      `source=${backupVolumeName},target=/var/lib/claudian-cloud-backups/artifacts`,
      '--mount',
      `source=${exportVolumeName},target=/var/lib/claudian-cloud-exports/artifacts`,
      '--mount',
      `source=${keyringVolumeName},target=/run/secrets,readonly`,
      IMAGE,
      'node',
      'dist/main.js',
      'maintenance',
      'recover-projects',
    ]), '');

    child = spawn('docker', [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      'host',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--user',
      '10001:10001',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--env-file',
      environmentFile,
      '--mount',
      `source=${volumeName},target=/var/lib/claudian-cloud`,
      '--mount',
      `source=${keyringVolumeName},target=/run/secrets,readonly`,
      IMAGE,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => stdout.push(String(chunk)));
    child.stderr?.on('data', chunk => stderr.push(String(chunk)));

    const origin = `http://127.0.0.1:${String(port)}`;
    await waitForHealth(origin, child);
    const live = await fetch(`${origin}/livez`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'alive' });
    const ready = await fetch(`${origin}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready' });
    const capabilityRoute = collabCloudCapabilitiesRoute();
    const capabilities = decodeCollabCloudCapabilityDocument(await (
      await fetch(`${origin}${capabilityRoute.target}`)
    ).json());
    assert.equal(capabilities.capabilities.includes('cloud-project-create'), true);
    assert.equal(capabilities.capabilities.includes('authority-transfer'), true);

    const protectedProjectId = 'project-runtime-image-missing';
    const protectedRoute = collabCloudProjectOperationRoute(
      protectedProjectId,
      'getProjectSnapshot',
    );
    const protectedBody = JSON.stringify({
      data: { projectId: protectedProjectId },
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      requestId: 'runtime-image-snapshot',
    });
    const protectedHttp = Buffer.from([
      `${protectedRoute.method} ${protectedRoute.target} HTTP/1.1`,
      'Host: cloud',
      'Connection: close',
      'Content-Type: application/json',
      `Content-Length: ${String(Buffer.byteLength(protectedBody))}`,
      '',
      protectedBody,
    ].join('\r\n'));
    const mapped = await rawRequest(port, [proxyV2Ipv4Frame(), protectedHttp]);
    assert.match(mapped, /^HTTP\/1\.1 404 Not Found/mu);
    const untrusted = await fetch(`${origin}${protectedRoute.target}`, {
      body: protectedBody,
      headers: {
        'content-type': 'application/json',
        'x-claudian-trusted-principal': 'principal-runtime-image',
      },
      method: protectedRoute.method,
    });
    assert.equal(untrusted.status, 403);
    const missing = await fetch(`${origin}/control/private-sentinel`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { status: 'not-found' });

    const exited = once(child, 'exit');
    await docker(['stop', '--time', '20', containerName]);
    const [exitCode, signal] = await exited as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.equal(exitCode, 0);
    assert.equal(signal, null);
    assert.equal(stderr.join(''), '');
    assert.deepEqual(parseEvents(stdout), [
      'server.starting',
      'server.listening',
      'server.stopping',
      'server.stopped',
    ]);
  } finally {
    if (
      child !== undefined
      && child.exitCode === null
      && child.signalCode === null
    ) {
      try {
        await docker(['rm', '--force', containerName]);
      } catch {
        // Continue cleanup after a failed or already-removed test container.
      }
    }
    if (volumeCreated) {
      try {
        await docker(['volume', 'rm', '--force', volumeName]);
      } catch {
        // The final generic failure remains sanitized below.
      }
    }
    if (backupVolumeCreated) {
      try {
        await docker(['volume', 'rm', '--force', backupVolumeName]);
      } catch {
        // The final generic failure remains sanitized below.
      }
    }
    if (exportVolumeCreated) {
      try {
        await docker(['volume', 'rm', '--force', exportVolumeName]);
      } catch {
        // The final generic failure remains sanitized below.
      }
    }
    if (keyringVolumeCreated) {
      try {
        await docker(['volume', 'rm', '--force', keyringVolumeName]);
      } catch {
        // The final generic failure remains sanitized below.
      }
    }
    await rm(temporaryRoot, { force: true, recursive: true });
    await database.close();
  }
}

try {
  await verifyRuntimeImage();
} catch {
  process.stderr.write('runtime image verification failed\n');
  process.exitCode = 1;
}
