import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BACKUP_ARTIFACT_ROOT,
  BACKUP_CATALOG_ROOT,
  EXPORT_ARTIFACT_ROOT,
  MaintenanceCommandConfigError,
  decodeMaintenanceCommandConfig,
  serverConfigSource,
} from '../../src/config/MaintenanceCommandConfig.js';

const operationId = 'a'.repeat(64);
const projectId = '11111111-1111-4111-8111-111111111111';

describe('MaintenanceCommandConfig', () => {
  it('owns fixed private container roots and exact per-command inputs', () => {
    assert.equal(
      BACKUP_ARTIFACT_ROOT,
      '/var/lib/claudian-cloud-backups/artifacts',
    );
    assert.equal(
      BACKUP_CATALOG_ROOT,
      '/var/lib/claudian-cloud-backups/catalogs',
    );
    assert.equal(
      EXPORT_ARTIFACT_ROOT,
      '/var/lib/claudian-cloud-exports/artifacts',
    );
    assert.deepEqual(decodeMaintenanceCommandConfig({
      CLAUDIAN_CLOUD_MAINTENANCE_EXPIRES_AT: '2026-09-01T00:00:00.000Z',
      CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID: operationId,
      CLAUDIAN_CLOUD_MAINTENANCE_PROJECT_ID: projectId,
    }, 'export-project'), {
      expiresAt: '2026-09-01T00:00:00.000Z',
      operationId,
      projectId,
    });
    assert.deepEqual(decodeMaintenanceCommandConfig({
      CLAUDIAN_CLOUD_MAINTENANCE_AUTHORIZATION_SHA256: 'b'.repeat(64),
      CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID: operationId,
      CLAUDIAN_CLOUD_MAINTENANCE_PROJECT_ID: projectId,
    }, 'resume-delete'), {
      authorizationSha256: 'b'.repeat(64),
      operationId,
      projectId,
    });
  });

  it('requires only the exact inputs used by each command', () => {
    assert.deepEqual(decodeMaintenanceCommandConfig({
      CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID: operationId,
    }, 'backup'), { operationId });
    assert.throws(
      () => decodeMaintenanceCommandConfig({
        CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID: operationId,
      }, 'export-project'),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceCommandConfigError);
        assert.equal(error.code, 'invalid-maintenance-config');
        return true;
      },
    );
    assert.throws(
      () => decodeMaintenanceCommandConfig({
        CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID: '../secret',
      }, 'verify-backup'),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceCommandConfigError);
        assert.equal(error.code, 'invalid-maintenance-config');
        assert.doesNotMatch(error.message, /secret/u);
        return true;
      },
    );
    assert.throws(
      () => decodeMaintenanceCommandConfig({
        CLAUDIAN_CLOUD_MAINTENANCE_AUTHORIZATION_SHA256: 'b'.repeat(64),
        CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID: operationId,
      }, 'backup'),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceCommandConfigError);
        assert.equal(error.code, 'invalid-maintenance-config');
        return true;
      },
    );
  });

  it('removes maintenance-only fields before strict server decoding', () => {
    assert.deepEqual(serverConfigSource({
      CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
      CLAUDIAN_CLOUD_MAINTENANCE_AUTHORIZATION_SHA256: 'b'.repeat(64),
      CLAUDIAN_CLOUD_MAINTENANCE_EXPIRES_AT: '2026-09-01T00:00:00.000Z',
      CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID: operationId,
      CLAUDIAN_CLOUD_MAINTENANCE_PROJECT_ID: projectId,
      CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL:
        'postgresql://migration:secret@127.0.0.1/cloud',
      CLAUDIAN_CLOUD_PORT: '8788',
      CLAUDIAN_CLOUD_PROJECT_RECOVERY_REQUIRED: 'true',
      CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED: 'true',
    }), {
      CLAUDIAN_CLOUD_BIND_HOST: '127.0.0.1',
      CLAUDIAN_CLOUD_PORT: '8788',
    });
  });
});
