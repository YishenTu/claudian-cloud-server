import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeMigrationConfig } from '../../src/config/MigrationConfig.js';
import { ConfigError } from '../../src/config/ServerConfig.js';
import { readEnvironmentExample } from './environmentExample.js';

describe('decodeMigrationConfig', () => {
  it('accepts the committed migration environment example', () => {
    assert.doesNotThrow(() => decodeMigrationConfig(
      readEnvironmentExample('.env.migration.example'),
    ));
  });

  it('decodes only an immutable PostgreSQL migration credential', () => {
    const config = decodeMigrationConfig({
      CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL:
        'postgresql://cloud-migration:secret@127.0.0.1/cloud',
    });

    assert.deepEqual(config, {
      postgresUrl: 'postgresql://cloud-migration:secret@127.0.0.1/cloud',
    });
    assert.equal(Object.isFrozen(config), true);
  });

  it('rejects runtime and trusted-ingress fields', () => {
    for (const [field, value, code] of [
      ['CLAUDIAN_CLOUD_BIND_HOST', '127.0.0.1', 'unknown-field'],
      ['CLAUDIAN_CLOUD_TRUSTED_INGRESS_MODE', 'header', 'profile-conflict'],
    ] as const) {
      assert.throws(
        () => decodeMigrationConfig({
          CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL:
            'postgresql://migration:secret@127.0.0.1/cloud',
          [field]: value,
        }),
        (error: unknown) => {
          assert.equal(error instanceof ConfigError, true);
          assert.equal((error as ConfigError).code, code);
          assert.equal((error as ConfigError).field, field);
          return true;
        },
      );
    }
  });

  it('never serializes a missing or malformed credential value', () => {
    for (const postgresUrl of [
      undefined,
      'secret-not-a-postgres-url',
    ]) {
      assert.throws(
        () => decodeMigrationConfig({
          CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL: postgresUrl,
        }),
        (error: unknown) => {
          assert.equal(error instanceof ConfigError, true);
          assert.equal(JSON.stringify(error).includes('secret'), false);
          return true;
        },
      );
    }
  });
});
