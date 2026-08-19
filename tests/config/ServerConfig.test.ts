import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigError,
  decodeServerConfig,
} from '../../src/config/ServerConfig.js';

const validSource = {
  CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
  CLAUDIAN_CLOUD_PORT: '8787',
} as const;

describe('decodeServerConfig', () => {
  it('decodes an immutable loopback configuration', () => {
    const config = decodeServerConfig(validSource);

    assert.deepEqual(config, {
      http: {
        host: '127.0.0.1',
        port: 8787,
      },
      shutdownTimeoutMs: 15_000,
    });
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.http), true);
  });

  it('rejects the removed deployment profile selector', () => {
    assert.throws(
      () => decodeServerConfig({
        ...validSource,
        CLAUDIAN_CLOUD_DEPLOYMENT_PROFILE: 'private-development',
      }),
      (error: unknown) => {
        assert.equal(error instanceof ConfigError, true);
        assert.equal((error as ConfigError).code, 'unknown-field');
        assert.equal(
          (error as ConfigError).field,
          'CLAUDIAN_CLOUD_DEPLOYMENT_PROFILE',
        );
        return true;
      },
    );
  });

  it('rejects the removed shutdown timeout selector', () => {
    assert.throws(
      () => decodeServerConfig({
        ...validSource,
        CLAUDIAN_CLOUD_SHUTDOWN_TIMEOUT_MS: '15000',
      }),
      (error: unknown) => {
        assert.equal(error instanceof ConfigError, true);
        assert.equal((error as ConfigError).code, 'unknown-field');
        assert.equal(
          (error as ConfigError).field,
          'CLAUDIAN_CLOUD_SHUTDOWN_TIMEOUT_MS',
        );
        return true;
      },
    );
  });

  it('rejects a non-loopback bind', () => {
    assert.throws(
      () => decodeServerConfig({
        ...validSource,
        CLAUDIAN_CLOUD_BIND_HOST: '0.0.0.0',
      }),
      (error: unknown) => {
        assert.equal(error instanceof ConfigError, true);
        assert.deepEqual((error as ConfigError).toJSON(), {
          code: 'profile-conflict',
          field: 'CLAUDIAN_CLOUD_BIND_HOST',
          message: 'config.error.profile-conflict',
          name: 'ConfigError',
        });
        return true;
      },
    );
  });

  it('rejects unknown Cloud fields without serializing their values', () => {
    const credential = 'private-vps-password';
    assert.throws(
      () => decodeServerConfig({
        ...validSource,
        CLAUDIAN_CLOUD_DATABASE_PASSWORD: credential,
      }),
      (error: unknown) => {
        assert.equal(error instanceof ConfigError, true);
        assert.equal(JSON.stringify(error).includes(credential), false);
        assert.deepEqual((error as ConfigError).toJSON(), {
          code: 'unknown-field',
          field: 'CLAUDIAN_CLOUD_DATABASE_PASSWORD',
          message: 'config.error.unknown-field',
          name: 'ConfigError',
        });
        return true;
      },
    );
  });

  it('rejects trusted-ingress settings before an adapter exists', () => {
    assert.throws(
      () => decodeServerConfig({
        ...validSource,
        CLAUDIAN_CLOUD_TRUSTED_INGRESS_MODE: 'header-assertion',
      }),
      (error: unknown) => {
        assert.equal(error instanceof ConfigError, true);
        assert.equal((error as ConfigError).code, 'profile-conflict');
        assert.equal(
          (error as ConfigError).field,
          'CLAUDIAN_CLOUD_TRUSTED_INGRESS_MODE',
        );
        return true;
      },
    );
  });

  it('rejects malformed numeric limits', () => {
    for (const [field, value] of [
      ['CLAUDIAN_CLOUD_PORT', '0'],
      ['CLAUDIAN_CLOUD_PORT', '65536'],
      ['CLAUDIAN_CLOUD_PORT', '1.5'],
    ] as const) {
      assert.throws(
        () => decodeServerConfig({ ...validSource, [field]: value }),
        (error: unknown) => {
          assert.equal(error instanceof ConfigError, true);
          assert.equal((error as ConfigError).code, 'invalid-field');
          assert.equal((error as ConfigError).field, field);
          return true;
        },
      );
    }
  });
});
