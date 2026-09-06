import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chown, readdir, readFile, writeFile } from 'node:fs/promises';

// Runs once inside the release image, with only an empty configuration directory mounted.
async function initialize() {
  if ((await readdir('/config')).length !== 0) {
    process.stderr.write('configuration.error: directory-not-empty\n');
    process.exitCode = 1;
    return;
  }
  const template = await readFile('/template', 'utf8');
  const bootstrapPassword = randomBytes(24).toString('hex');
  const migrationPassword = randomBytes(24).toString('hex');
  const runtimePassword = randomBytes(24).toString('hex');
  const receipt = generateKeyPairSync('ed25519');
  const keyring = {
    schemaVersion: 1,
    activeEncryptionKeyId: 'encryption-1',
    activeReceiptKeyId: 'receipt-1',
    encryptionKeys: [{
      keyId: 'encryption-1', keyVersion: 1,
      key: randomBytes(32).toString('base64url'),
    }],
    receiptKeys: [{
      keyId: 'receipt-1', keyVersion: 1,
      privateKey: receipt.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      publicKey: receipt.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    }],
  };
  const files = {
    'postgres.env': [
      'POSTGRES_USER=claudian_cloud_bootstrap',
      `POSTGRES_PASSWORD=${bootstrapPassword}`,
      'POSTGRES_DB=postgres',
    ].join('\n') + '\n',
    'bootstrap.env': [
      'PGHOST=127.0.0.1',
      'PGPORT=5432',
      'PGUSER=claudian_cloud_bootstrap',
      `PGPASSWORD=${bootstrapPassword}`,
      'PGDATABASE=postgres',
      `CLAUDIAN_CLOUD_POSTGRES_MIGRATION_PASSWORD=${migrationPassword}`,
      `CLAUDIAN_CLOUD_POSTGRES_RUNTIME_PASSWORD=${runtimePassword}`,
    ].join('\n') + '\n',
    'migration.env': `CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL=postgresql://claudian_cloud_migration:${migrationPassword}@127.0.0.1:5432/claudian_cloud\n`,
    'server.env': template
      .replace(/^CLAUDIAN_CLOUD_POSTGRES_URL=.*$/mu,
        `CLAUDIAN_CLOUD_POSTGRES_URL=postgresql://claudian_cloud_runtime:${runtimePassword}@127.0.0.1:5432/claudian_cloud`),
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(`/config/${name}`, contents, { flag: 'wx', mode: 0o600 });
  }
  await writeFile('/config/claim-custody-keyring.json', JSON.stringify(keyring) + '\n', {
    flag: 'wx', mode: 0o400,
  });
  await chown('/config/claim-custody-keyring.json', 10001, 10001);
  process.stdout.write('Configuration created.\n');
}

initialize().catch(() => {
  process.stderr.write('configuration.error: initialization-failed\n');
  process.exitCode = 1;
});
