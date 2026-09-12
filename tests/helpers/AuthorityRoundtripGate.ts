import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createApplication } from '../../src/composition/createApplication.js';
import { decodeServerConfig } from '../../src/config/ServerConfig.js';
import { decodeClaimCustodyKeyring } from '../../src/config/ClaimCustodyKeyringConfig.js';
import { PostgresSchemaInitializer } from '../../src/coordination/postgres/PostgresSchemaInitializer.js';
import { SafeLogger } from '../../src/observability/SafeLogger.js';
import { acquirePostgresTestDatabase } from './PostgresTestDatabase.js';

const clientRoot = process.argv[2];
const publishedLan = process.argv[3] === '--published-lan';
let overlappingQueryWarning = false;
const observeWarning = (warning: Error): void => {
  if (warning.message.startsWith('Calling client.query() when the client is already executing')) {
    overlappingQueryWarning = true;
  }
};
process.on('warning', observeWarning);
if (clientRoot === undefined || !isAbsolute(clientRoot)) {
  throw new Error('authority-roundtrip-gate.client-checkout-required');
}
const database = await acquirePostgresTestDatabase(process.env);
const root = await mkdtemp(join(tmpdir(), 'claudian-authority-roundtrip-server-'));
let app: ReturnType<typeof createApplication> | undefined;
try {
  await new PostgresSchemaInitializer({ connectionString: database.migrationUrl }).apply();
  const repositoryRoot = join(root, 'repositories');
  const stagingRoot = join(root, 'staging');
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });
  await writeFile(join(root, '.authority-volume-id'), `${database.authorityVolumeId}\n`, { mode: 0o600 });
  const pair = generateKeyPairSync('ed25519');
  const keyring = decodeClaimCustodyKeyring({
    activeEncryptionKeyId: 'encryption-roundtrip', activeReceiptKeyId: 'receipt-roundtrip',
    encryptionKeys: [{ key: randomBytes(32).toString('base64url'), keyId: 'encryption-roundtrip', keyVersion: 1 }],
    receiptKeys: [{ keyId: 'receipt-roundtrip', keyVersion: 1,
      privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    }], schemaVersion: 1,
  });
  const config = decodeServerConfig({
    CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
    CLAUDIAN_CLOUD_PORT: '8787',
    CLAUDIAN_CLOUD_PRINCIPAL_PROFILE: 'vault-credential',
    CLAUDIAN_CLOUD_POSTGRES_URL: database.runtimeUrl,
    CLAUDIAN_CLOUD_STORAGE_NODE_ID: 'roundtrip-local',
    CLAUDIAN_CLOUD_REPOSITORY_ROOT: repositoryRoot,
    CLAUDIAN_CLOUD_STAGING_ROOT: stagingRoot,
    CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
  });
  app = createApplication({ config: { ...config, http: { host: '127.0.0.1', port: 0 } }, keyring,
    logger: new SafeLogger({ now: () => new Date(), write: () => undefined }),
  });
  const address = await app.start();
  const result = await promisify(execFile)('npm', publishedLan ? [
    'run', 'test:lan-compatibility',
  ] : [
    'run', 'test:unit', '--', '--runInBand', '--runTestsByPath',
    'tests/integration/app/collab/gates/CloudAuthorityRoundtripGate.test.ts',
  ], {
    cwd: clientRoot,
    env: {
      ...process.env,
      CLAUDIAN_AUTHORITY_TRANSFER_SERVER_URL: `http://${address.host}:${String(address.port)}`,
    },
    maxBuffer: 1024 * 1024,
    timeout: 240_000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await app?.close();
  await database.close();
  await rm(root, { force: true, recursive: true });
  process.off('warning', observeWarning);
}
assert.equal(overlappingQueryWarning, false, 'Project transactions must settle each query before submitting another');
