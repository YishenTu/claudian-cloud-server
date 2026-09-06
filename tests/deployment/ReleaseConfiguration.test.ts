import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const nodeImage = 'node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203';

function docker(args: readonly string[], input?: string) {
  return spawnSync('docker', [...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 1024 * 1024,
  });
}

describe('Release configuration', () => {
  it('leaves a fresh host retryable when the release image cannot be downloaded', () => {
    const result = docker([
      'run', '--rm', '--interactive', '--network', 'none',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--mount', `type=bind,source=${root},target=/source,readonly`,
      '--entrypoint', 'bash', nodeImage,
    ], `
      set -eu
      mkdir -p /tmp/release/deploy /tmp/bin
      cp /source/deploy/configure.sh /tmp/release/deploy/configure.sh
      cp /source/deploy/initializeConfig.ts /tmp/release/deploy/initializeConfig.ts
      printf '%s\\n' 'CLAUDIAN_CLOUD_IMAGE=ghcr.io/yishentu/claudian-cloud-server@sha256:${'a'.repeat(64)}' > /tmp/release/release.env
      printf '#!/bin/sh\\nexit 79\\n' > /tmp/bin/docker
      chmod +x /tmp/bin/docker
      status=0
      PATH=/tmp/bin:$PATH bash /tmp/release/deploy/configure.sh || status=$?
      test "$status" = 79
      if test -e /etc/claudian-cloud-server; then
        printf '%s\\n' 'configuration-left-behind'
        exit 1
      fi
      printf '%s\\n' 'download-failure-retryable'
    `);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, 'download-failure-retryable\n');
  });

  it('creates separate credentials and a usable protected keyring without overwriting an installation', async () => {
    const initialize = await readFile(resolve(root, 'deploy/initializeConfig.ts'), 'utf8');
    const volume = `claudian-release-config-${randomUUID()}`;
    assert.equal(docker(['volume', 'create', volume]).status, 0);
    const run = [
      'run', '--rm', '--interactive', '--network', 'none', '--read-only',
      '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
      '--security-opt', 'no-new-privileges:true',
      '--mount', `type=volume,source=${volume},target=/config`,
      '--mount', `type=bind,source=${resolve(root, '.env.example')},target=/template,readonly`,
      '--entrypoint', 'node', nodeImage, '--input-type=module-typescript',
    ];
    try {
      const first = docker(run, initialize);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stdout, 'Configuration created.\n');

      const verification = docker([
        'run', '--rm', '--interactive', '--network', 'none', '--read-only',
        '--mount', `type=volume,source=${volume},target=/config,readonly`,
        '--entrypoint', 'node', nodeImage, '--input-type=module',
      ], `
        import assert from 'node:assert/strict';
        import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
        import { readFileSync, statSync, readdirSync } from 'node:fs';
        function env(name) {
          return Object.fromEntries(readFileSync('/config/' + name, 'utf8').split('\\n')
            .filter(line => line && !line.startsWith('#'))
            .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        }
        const postgres = env('postgres.env');
        const bootstrap = env('bootstrap.env');
        const migration = env('migration.env');
        const runtime = env('server.env');
        assert.ok(postgres.POSTGRES_PASSWORD === bootstrap.PGPASSWORD);
        const migrationPassword = bootstrap.CLAUDIAN_CLOUD_POSTGRES_MIGRATION_PASSWORD;
        const runtimePassword = bootstrap.CLAUDIAN_CLOUD_POSTGRES_RUNTIME_PASSWORD;
        assert.ok(new Set([postgres.POSTGRES_PASSWORD, migrationPassword, runtimePassword]).size === 3);
        for (const password of [postgres.POSTGRES_PASSWORD, migrationPassword, runtimePassword]) {
          assert.ok(/^[a-f0-9]{48}$/.test(password));
        }
        assert.ok(new URL(migration.CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL).password === migrationPassword);
        assert.ok(new URL(runtime.CLAUDIAN_CLOUD_POSTGRES_URL).password === runtimePassword);
        assert.ok(!Object.values(runtime).includes(postgres.POSTGRES_PASSWORD));
        assert.ok(!('CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL' in runtime));
        assert.equal(runtime.CLAUDIAN_CLOUD_BIND_HOST, '127.0.0.1');
        assert.equal(runtime.CLAUDIAN_CLOUD_PRINCIPAL_PROFILE, 'vault-credential');
        const keyring = JSON.parse(readFileSync('/config/claim-custody-keyring.json', 'utf8'));
        assert.equal(keyring.schemaVersion, 1);
        assert.ok(keyring.encryptionKeys.some(key => key.keyId === keyring.activeEncryptionKeyId));
        assert.equal(Buffer.from(keyring.encryptionKeys[0].key, 'base64url').length, 32);
        const receipt = keyring.receiptKeys[0];
        assert.equal(receipt.keyId, keyring.activeReceiptKeyId);
        const privateKey = createPrivateKey({ key: Buffer.from(receipt.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
        const publicKey = createPublicKey({ key: Buffer.from(receipt.publicKey, 'base64url'), format: 'der', type: 'spki' });
        const message = Buffer.from('release configuration receipt');
        assert.ok(verify(null, message, publicKey, sign(null, message, privateKey)));
        const keyStat = statSync('/config/claim-custody-keyring.json');
        assert.equal(keyStat.uid, 10001);
        assert.equal(keyStat.gid, 10001);
        assert.equal(keyStat.mode & 0o777, 0o400);
        for (const name of ['postgres.env', 'bootstrap.env', 'migration.env', 'server.env']) {
          assert.equal(statSync('/config/' + name).mode & 0o777, 0o600);
        }
        assert.equal(readdirSync('/config').length, 5);
        process.stdout.write('configuration-valid\\n');
      `);
      assert.equal(verification.status, 0, verification.stderr);
      assert.equal(verification.stdout, 'configuration-valid\n');

      const replay = docker(run, initialize);
      assert.equal(replay.status, 1);
      assert.equal(replay.stdout, '');
      assert.equal(replay.stderr, 'configuration.error: directory-not-empty\n');
    } finally {
      assert.equal(docker(['volume', 'rm', volume]).status, 0);
    }
  });
});
