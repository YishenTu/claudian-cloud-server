import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigError,
  decodeServerConfig,
} from '../../src/config/ServerConfig.js';
import { readEnvironmentExample } from './environmentExample.js';

const validSource = {
  CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
  CLAUDIAN_CLOUD_GIT_EXECUTABLE: '/usr/bin/git',
  CLAUDIAN_CLOUD_PORT: '8787',
  CLAUDIAN_CLOUD_POSTGRES_URL: 'postgresql://cloud-runtime:secret@127.0.0.1/cloud',
  CLAUDIAN_CLOUD_PRINCIPAL_PROFILE: 'private-development',
  CLAUDIAN_CLOUD_REPOSITORY_ROOT: '/srv/claudian/repositories',
  CLAUDIAN_CLOUD_STAGING_ROOT: '/srv/claudian/staging',
  CLAUDIAN_CLOUD_STORAGE_NODE_ID: 'node-a',
} as const;

describe('decodeServerConfig', () => {
  it('accepts the committed runtime environment example', () => {
    assert.doesNotThrow(() => decodeServerConfig(
      readEnvironmentExample('.env.example'),
    ));
  });

  it('decodes an immutable loopback configuration', () => {
    const config = decodeServerConfig(validSource);

    assert.deepEqual(config, {
      developmentBootstrap: {
        attemptTtlMs: 86_400_000,
        maxBundleBytes: 1_073_741_824,
        maxConcurrentUploads: 1,
        maxRepositoryBytes: 1_073_741_824,
        maxUploadsPerAttempt: 1,
        queueMax: 4,
        queueTimeoutMs: 10_000,
        stagingFreeSpaceFloorBytes: 1_073_741_824,
        stagingReservationBytes: 2_147_483_648,
        stagingRoot: '/srv/claudian/staging',
        uploadDeadlineMs: 900_000,
        uploadIdleTimeoutMs: 30_000,
      },
      eventAdmission: {
        maxConnections: 64,
        maxConnectionsPerProject: 16,
        maxPendingAuthorizations: 16,
      },
      gitAdmission: {
        maxChildren: 2,
        maxChildrenPerProject: 1,
        maxQueuedReads: 5,
        maxQueuedWrites: 5,
        maxReadChildren: 1,
        maxWriteChildren: 1,
        queueMax: 6,
        queueMaxPerProject: 4,
        queueTimeoutMs: 10_000,
      },
      http: {
        host: '127.0.0.1',
        port: 8787,
      },
      postgres: {
        ordinaryPoolMax: 8,
        pinnedPoolMax: 2,
        projectLockTimeoutMs: 2_000,
        reservedPoolMax: 2,
        url: 'postgresql://cloud-runtime:secret@127.0.0.1/cloud',
      },
      principalProfile: 'private-development',
      repository: {
        gitExecutable: '/usr/bin/git',
        operationTimeoutMs: 300_000,
        outputMaxBytes: 1_048_576,
        root: '/srv/claudian/repositories',
        storageNodeId: 'node-a',
      },
      shutdownTimeoutMs: 15_000,
    });
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.developmentBootstrap), true);
    assert.equal(Object.isFrozen(config.eventAdmission), true);
    assert.equal(Object.isFrozen(config.gitAdmission), true);
    assert.equal(Object.isFrozen(config.http), true);
    assert.equal(Object.isFrozen(config.postgres), true);
    assert.equal(Object.isFrozen(config.repository), true);
  });

  it('rejects unknown configuration fields', () => {
    assert.throws(
      () => decodeServerConfig({
        ...validSource,
        CLAUDIAN_CLOUD_UNSUPPORTED_OPTION: 'private-development',
      }),
      (error: unknown) => {
        assert.equal(error instanceof ConfigError, true);
        assert.equal((error as ConfigError).code, 'unknown-field');
        assert.equal(
          (error as ConfigError).field,
          'CLAUDIAN_CLOUD_UNSUPPORTED_OPTION',
        );
        return true;
      },
    );
  });

  it('rejects an implicit principal profile', () => {
    const source: Record<string, string> = { ...validSource };
    delete source.CLAUDIAN_CLOUD_PRINCIPAL_PROFILE;
    assert.throws(
      () => decodeServerConfig(source),
      (error: unknown) => {
        assert.equal(error instanceof ConfigError, true);
        assert.equal((error as ConfigError).code, 'missing-field');
        assert.equal((error as ConfigError).field, 'CLAUDIAN_CLOUD_PRINCIPAL_PROFILE');
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

  it('selects Vault credential verification without ingress configuration', () => {
    const config = decodeServerConfig({
      ...validSource,
      CLAUDIAN_CLOUD_PRINCIPAL_PROFILE: 'vault-credential',
    });
    assert.equal(config.principalProfile, 'vault-credential');
  });

  it('rejects unsupported principal profiles', () => {
    for (const principalProfile of ['unsupported', '', 'VAULT-CREDENTIAL']) {
      assert.throws(() => decodeServerConfig({
        ...validSource,
        CLAUDIAN_CLOUD_PRINCIPAL_PROFILE: principalProfile,
      }), ConfigError);
    }
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

  it('requires every external location and credential field', () => {
    for (const field of [
      'CLAUDIAN_CLOUD_BIND_HOST',
      'CLAUDIAN_CLOUD_GIT_EXECUTABLE',
      'CLAUDIAN_CLOUD_PORT',
      'CLAUDIAN_CLOUD_POSTGRES_URL',
      'CLAUDIAN_CLOUD_REPOSITORY_ROOT',
      'CLAUDIAN_CLOUD_STAGING_ROOT',
      'CLAUDIAN_CLOUD_STORAGE_NODE_ID',
    ] as const) {
      const source = Object.fromEntries(
        Object.entries(validSource).filter(([candidate]) => candidate !== field),
      );
      assert.throws(
        () => decodeServerConfig(source),
        (error: unknown) => {
          assert.equal(error instanceof ConfigError, true);
          assert.equal((error as ConfigError).code, 'missing-field');
          assert.equal((error as ConfigError).field, field);
          return true;
        },
      );
    }
  });

  it('decodes explicit safety-limit overrides', () => {
    const config = decodeServerConfig({
      ...validSource,
      CLAUDIAN_CLOUD_GIT_MAX_CHILDREN: '8',
      CLAUDIAN_CLOUD_GIT_MAX_CHILDREN_PER_PROJECT: '2',
      CLAUDIAN_CLOUD_GIT_MAX_QUEUED_READS: '12',
      CLAUDIAN_CLOUD_GIT_MAX_QUEUED_WRITES: '10',
      CLAUDIAN_CLOUD_GIT_MAX_READ_CHILDREN: '6',
      CLAUDIAN_CLOUD_GIT_MAX_WRITE_CHILDREN: '4',
      CLAUDIAN_CLOUD_GIT_OPERATION_TIMEOUT_MS: '600000',
      CLAUDIAN_CLOUD_GIT_OUTPUT_MAX_BYTES: '2097152',
      CLAUDIAN_CLOUD_GIT_QUEUE_MAX: '20',
      CLAUDIAN_CLOUD_GIT_QUEUE_MAX_PER_PROJECT: '8',
      CLAUDIAN_CLOUD_GIT_QUEUE_TIMEOUT_MS: '5000',
      CLAUDIAN_CLOUD_BOOTSTRAP_MAX_BUNDLE_BYTES: '536870912',
      CLAUDIAN_CLOUD_BOOTSTRAP_MAX_REPOSITORY_BYTES: '536870912',
      CLAUDIAN_CLOUD_BOOTSTRAP_QUEUE_MAX: '8',
      CLAUDIAN_CLOUD_BOOTSTRAP_QUEUE_TIMEOUT_MS: '5000',
      CLAUDIAN_CLOUD_BOOTSTRAP_STAGING_FREE_SPACE_FLOOR_BYTES: '536870912',
      CLAUDIAN_CLOUD_BOOTSTRAP_STAGING_RESERVATION_BYTES: '1073741824',
      CLAUDIAN_CLOUD_BOOTSTRAP_UPLOAD_DEADLINE_MS: '600000',
      CLAUDIAN_CLOUD_BOOTSTRAP_UPLOAD_IDLE_TIMEOUT_MS: '15000',
      CLAUDIAN_CLOUD_POSTGRES_ORDINARY_POOL_MAX: '16',
      CLAUDIAN_CLOUD_POSTGRES_PINNED_POOL_MAX: '4',
      CLAUDIAN_CLOUD_POSTGRES_RESERVED_POOL_MAX: '4',
      CLAUDIAN_CLOUD_PROJECT_LOCK_TIMEOUT_MS: '3000',
      CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS: '200',
      CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS_PER_PROJECT: '40',
      CLAUDIAN_CLOUD_EVENT_MAX_PENDING_AUTHORIZATIONS: '20',
    });

    assert.deepEqual(config.gitAdmission, {
      maxChildren: 8,
      maxChildrenPerProject: 2,
      maxQueuedReads: 12,
      maxQueuedWrites: 10,
      maxReadChildren: 6,
      maxWriteChildren: 4,
      queueMax: 20,
      queueMaxPerProject: 8,
      queueTimeoutMs: 5_000,
    });
    assert.deepEqual(config.eventAdmission, {
      maxConnections: 200,
      maxConnectionsPerProject: 40,
      maxPendingAuthorizations: 20,
    });
    assert.deepEqual(config.developmentBootstrap, {
      attemptTtlMs: 86_400_000,
      maxBundleBytes: 536_870_912,
      maxConcurrentUploads: 1,
      maxRepositoryBytes: 536_870_912,
      maxUploadsPerAttempt: 1,
      queueMax: 8,
      queueTimeoutMs: 5_000,
      stagingFreeSpaceFloorBytes: 536_870_912,
      stagingReservationBytes: 1_073_741_824,
      stagingRoot: validSource.CLAUDIAN_CLOUD_STAGING_ROOT,
      uploadDeadlineMs: 600_000,
      uploadIdleTimeoutMs: 15_000,
    });
    assert.deepEqual(config.postgres, {
      ordinaryPoolMax: 16,
      pinnedPoolMax: 4,
      projectLockTimeoutMs: 3_000,
      reservedPoolMax: 4,
      url: validSource.CLAUDIAN_CLOUD_POSTGRES_URL,
    });
    assert.deepEqual(config.repository, {
      gitExecutable: validSource.CLAUDIAN_CLOUD_GIT_EXECUTABLE,
      operationTimeoutMs: 600_000,
      outputMaxBytes: 2_097_152,
      root: validSource.CLAUDIAN_CLOUD_REPOSITORY_ROOT,
      storageNodeId: validSource.CLAUDIAN_CLOUD_STORAGE_NODE_ID,
    });
  });

  it('rejects unsafe safety-limit values at their owning fields', () => {
    for (const [field, value] of [
      ['CLAUDIAN_CLOUD_GIT_MAX_CHILDREN', '1'],
      ['CLAUDIAN_CLOUD_GIT_MAX_CHILDREN_PER_PROJECT', '64'],
      ['CLAUDIAN_CLOUD_GIT_MAX_QUEUED_READS', '6'],
      ['CLAUDIAN_CLOUD_GIT_MAX_QUEUED_WRITES', '6'],
      ['CLAUDIAN_CLOUD_GIT_MAX_READ_CHILDREN', '2'],
      ['CLAUDIAN_CLOUD_GIT_MAX_WRITE_CHILDREN', '2'],
      ['CLAUDIAN_CLOUD_GIT_OPERATION_TIMEOUT_MS', '999'],
      ['CLAUDIAN_CLOUD_GIT_OUTPUT_MAX_BYTES', '1023'],
      ['CLAUDIAN_CLOUD_GIT_QUEUE_MAX', '1'],
      ['CLAUDIAN_CLOUD_GIT_QUEUE_MAX_PER_PROJECT', '1024'],
      ['CLAUDIAN_CLOUD_GIT_QUEUE_TIMEOUT_MS', '99'],
      ['CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS', '1'],
      ['CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS_PER_PROJECT', '64'],
      ['CLAUDIAN_CLOUD_EVENT_MAX_PENDING_AUTHORIZATIONS', '0'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_ATTEMPT_TTL_MS', '7200000'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_ATTEMPT_TTL_MS', '899999'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_MAX_BUNDLE_BYTES', '1073741825'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_MAX_REPOSITORY_BYTES', '1073741825'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_QUEUE_MAX', '0'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_QUEUE_TIMEOUT_MS', '99'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_STAGING_FREE_SPACE_FLOOR_BYTES', '67108863'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_STAGING_RESERVATION_BYTES', '2147483647'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_UPLOAD_DEADLINE_MS', '30000'],
      ['CLAUDIAN_CLOUD_BOOTSTRAP_UPLOAD_IDLE_TIMEOUT_MS', '30001'],
      ['CLAUDIAN_CLOUD_POSTGRES_ORDINARY_POOL_MAX', '0'],
      ['CLAUDIAN_CLOUD_POSTGRES_PINNED_POOL_MAX', '65'],
      ['CLAUDIAN_CLOUD_POSTGRES_RESERVED_POOL_MAX', '17'],
      ['CLAUDIAN_CLOUD_PROJECT_LOCK_TIMEOUT_MS', '99'],
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

  it('reserves global child and queue capacity for another Project', () => {
    for (const [globalField, perProjectField] of [
      [
        'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN',
        'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN_PER_PROJECT',
      ],
      [
        'CLAUDIAN_CLOUD_GIT_QUEUE_MAX',
        'CLAUDIAN_CLOUD_GIT_QUEUE_MAX_PER_PROJECT',
      ],
      [
        'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN',
        'CLAUDIAN_CLOUD_GIT_MAX_READ_CHILDREN',
      ],
      [
        'CLAUDIAN_CLOUD_GIT_MAX_CHILDREN',
        'CLAUDIAN_CLOUD_GIT_MAX_WRITE_CHILDREN',
      ],
      [
        'CLAUDIAN_CLOUD_GIT_QUEUE_MAX',
        'CLAUDIAN_CLOUD_GIT_MAX_QUEUED_READS',
      ],
      [
        'CLAUDIAN_CLOUD_GIT_QUEUE_MAX',
        'CLAUDIAN_CLOUD_GIT_MAX_QUEUED_WRITES',
      ],
    ] as const) {
      assert.throws(
        () => decodeServerConfig({
          ...validSource,
          CLAUDIAN_CLOUD_GIT_MAX_CHILDREN_PER_PROJECT: '1',
          CLAUDIAN_CLOUD_GIT_QUEUE_MAX_PER_PROJECT: '3',
          [globalField]: '4',
          [perProjectField]: '4',
        }),
        (error: unknown) => {
          assert.equal(error instanceof ConfigError, true);
          assert.equal((error as ConfigError).code, 'invalid-field');
          assert.equal((error as ConfigError).field, perProjectField);
          return true;
        },
      );
    }
  });

  it('reserves event connection capacity for another Project', () => {
    assert.throws(
      () => decodeServerConfig({
        ...validSource,
        CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS: '4',
        CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS_PER_PROJECT: '4',
      }),
      (error: unknown) => {
        assert.equal(error instanceof ConfigError, true);
        assert.equal((error as ConfigError).code, 'invalid-field');
        assert.equal(
          (error as ConfigError).field,
          'CLAUDIAN_CLOUD_EVENT_MAX_CONNECTIONS_PER_PROJECT',
        );
        return true;
      },
    );
  });

  it('rejects malformed URLs, operational IDs, and ambiguous paths safely', () => {
    const secret = 'secret-malformed-value';
    for (const [field, value] of [
      ['CLAUDIAN_CLOUD_POSTGRES_URL', `${secret}://cloud`],
      ['CLAUDIAN_CLOUD_POSTGRES_URL', `postgresql://runtime:${secret}@127.0.0.1`],
      ['CLAUDIAN_CLOUD_STORAGE_NODE_ID', `node/${secret}`],
      ['CLAUDIAN_CLOUD_REPOSITORY_ROOT', `relative/${secret}`],
      ['CLAUDIAN_CLOUD_REPOSITORY_ROOT', `/tmp/../${secret}`],
      ['CLAUDIAN_CLOUD_STAGING_ROOT', `relative/${secret}`],
      ['CLAUDIAN_CLOUD_STAGING_ROOT', '/srv/other/staging'],
      ['CLAUDIAN_CLOUD_GIT_EXECUTABLE', `relative/${secret}`],
    ] as const) {
      assert.throws(
        () => decodeServerConfig({ ...validSource, [field]: value }),
        (error: unknown) => {
          assert.equal(error instanceof ConfigError, true);
          assert.equal((error as ConfigError).code, 'invalid-field');
          assert.equal((error as ConfigError).field, field);
          assert.equal(JSON.stringify(error).includes(secret), false);
          return true;
        },
      );
    }
  });
});
