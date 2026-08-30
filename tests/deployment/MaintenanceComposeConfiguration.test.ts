import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

interface Mount {
  readonly read_only?: boolean;
  readonly source: string;
  readonly target: string;
  readonly type: string;
}

interface Service {
  readonly cap_drop?: readonly string[];
  readonly command?: readonly string[];
  readonly depends_on?: Readonly<Record<string, Readonly<{
    readonly condition?: string;
  }>>>;
  readonly entrypoint?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly labels?: Readonly<Record<string, string>>;
  readonly profiles?: readonly string[];
  readonly read_only?: boolean;
  readonly restart?: string;
  readonly security_opt?: readonly string[];
  readonly user?: string;
  readonly volumes?: readonly Mount[];
}

interface Model {
  readonly services: Readonly<Record<string, Service>>;
  readonly volumes: Readonly<Record<string, Readonly<{
    readonly labels?: Readonly<Record<string, string>>;
  }>>>;
}

const repositoryRoot = resolve(import.meta.dirname, '../..');
const keyringTarget = '/run/secrets/claudian_claim_custody_keyring';
const restoreOwnershipId = 'd'.repeat(64);

function render(): Model {
  return JSON.parse(execFileSync('docker', [
    'compose',
    '--file', resolve(repositoryRoot, 'deploy/compose.yaml'),
    '--profile', '*',
    'config',
    '--format', 'json',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDIAN_CLOUD_BOOTSTRAP_ENV_FILE: resolve(repositoryRoot, '.env.bootstrap.example'),
      CLAUDIAN_CLOUD_ENV_FILE: resolve(repositoryRoot, '.env.example'),
      CLAUDIAN_CLOUD_MIGRATION_ENV_FILE: resolve(repositoryRoot, '.env.migration.example'),
      CLAUDIAN_CLOUD_POSTGRES_ENV_FILE: resolve(repositoryRoot, '.env.postgres.example'),
      CLAUDIAN_CLOUD_CLAIM_CUSTODY_KEYRING_FILE: '/operator/claim-keyring.json',
      CLAUDIAN_CLOUD_BACKUP_ARTIFACT_ROOT: '/operator/backups/artifacts',
      CLAUDIAN_CLOUD_BACKUP_CATALOG_ROOT: '/operator/backups/catalogs',
      CLAUDIAN_CLOUD_EXPORT_ARTIFACT_ROOT: '/operator/exports/artifacts',
      CLAUDIAN_CLOUD_RESTORE_OWNERSHIP_ID: restoreOwnershipId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })) as Model;
}

function service(model: Model, name: string): Service {
  const value = model.services[name];
  assert.ok(value, `missing service ${name}`);
  return value;
}

function hasKeyring(value: Service): boolean {
  return value.volumes?.some(mount => (
    mount.source === '/operator/claim-keyring.json'
      && mount.target === keyringTarget
      && mount.type === 'bind'
      && mount.read_only === true
  )) === true;
}

function mount(
  value: Service,
  source: string,
  target: string,
  readOnly: boolean,
): boolean {
  return value.volumes?.some(candidate => (
    candidate.source === source
      && candidate.target === target
      && candidate.type === 'bind'
      && (candidate.read_only ?? false) === readOnly
  )) === true;
}

function authorityMount(value: Service, readOnly: boolean): boolean {
  return value.volumes?.some(candidate => (
    candidate.source === 'cloud-authority'
      && candidate.target === '/var/lib/claudian-cloud'
      && candidate.type === 'volume'
      && (candidate.read_only ?? false) === readOnly
  )) === true;
}

describe('maintenance Compose configuration', () => {
  it('binds every restore container and volume to the operator ownership identity', () => {
    const model = render();
    for (const [name, value] of Object.entries(model.services)) {
      assert.equal(
        value.labels?.['com.claudian.restore-owner'],
        restoreOwnershipId,
        name,
      );
    }
    for (const name of ['cloud-authority', 'postgres-data']) {
      assert.equal(
        model.volumes[name]?.labels?.['com.claudian.restore-owner'],
        restoreOwnershipId,
        name,
      );
    }
  });

  it('routes every one-shot profile through the compiled maintenance entry', () => {
    const model = render();
    const commands = {
      'cloud-backup': 'backup',
      'cloud-export-project': 'export-project',
      'cloud-migration': 'migration',
      'cloud-reconcile-exports': 'reconcile-exports',
      'cloud-restore': 'restore',
      'cloud-resume-delete': 'resume-delete',
      'cloud-verify-authority': 'verify-authority',
      'cloud-verify-backup': 'verify-backup',
    } as const;

    for (const [name, command] of Object.entries(commands)) {
      const current = service(model, name);
      assert.deepEqual(current.command, [
        'node', 'dist/main.js', 'maintenance', command,
      ]);
      assert.deepEqual(current.profiles, [command]);
      assert.equal(current.user, '10001:10001');
      assert.equal(current.read_only, true);
      assert.equal(current.restart, 'no');
      assert.ok(current.cap_drop?.includes('ALL'));
      assert.ok(current.security_opt?.includes('no-new-privileges:true'));
    }
  });

  it('exposes the fixed read-only keyring only to continuity owners', () => {
    const model = render();
    for (const name of [
      'cloud-server',
      'cloud-backup',
      'cloud-verify-backup',
      'cloud-restore',
      'cloud-restore-recovery',
      'cloud-project-recovery',
      'cloud-verify-authority',
    ]) assert.equal(hasKeyring(service(model, name)), true, name);

    for (const name of [
      'cloud-bootstrap',
      'cloud-migration',
      'cloud-export-project',
      'cloud-resume-delete',
      'cloud-reconcile-exports',
      'postgres',
    ]) assert.equal(hasKeyring(service(model, name)), false, name);
  });

  it('exposes the migration credential only to offline schema owners', () => {
    const model = render();
    for (const name of [
      'cloud-migration',
      'cloud-restore',
      'cloud-restore-recovery',
      'cloud-verify-backup',
    ]) {
      assert.ok(
        service(model, name).environment
          ?.CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL,
        name,
      );
    }
    for (const name of [
      'cloud-bootstrap',
      'cloud-backup',
      'cloud-export-project',
      'cloud-project-recovery',
      'cloud-reconcile-exports',
      'cloud-resume-delete',
      'cloud-server',
      'cloud-verify-authority',
      'postgres',
    ]) {
      assert.equal(
        service(model, name).environment
          ?.CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL,
        undefined,
        name,
      );
    }
  });

  it('binds only the exact artifact roots needed by each command', () => {
    const model = render();
    const backupArtifacts = '/var/lib/claudian-cloud-backups/artifacts';
    const backupCatalogs = '/var/lib/claudian-cloud-backups/catalogs';
    const exportArtifacts = '/var/lib/claudian-cloud-exports/artifacts';

    assert.equal(mount(
      service(model, 'cloud-backup'),
      '/operator/backups/artifacts',
      backupArtifacts,
      false,
    ), true);
    assert.equal(mount(
      service(model, 'cloud-backup'),
      '/operator/backups/catalogs',
      backupCatalogs,
      false,
    ), true);
    for (const name of [
      'cloud-verify-backup',
      'cloud-restore',
      'cloud-restore-recovery',
    ]) {
      assert.equal(mount(
        service(model, name),
        '/operator/backups/artifacts',
        backupArtifacts,
        true,
      ), true, name);
      assert.equal(mount(
        service(model, name),
        '/operator/backups/catalogs',
        backupCatalogs,
        true,
      ), true, name);
    }
    assert.equal(mount(
      service(model, 'cloud-export-project'),
      '/operator/exports/artifacts',
      exportArtifacts,
      false,
    ), true);
    assert.equal(mount(
      service(model, 'cloud-reconcile-exports'),
      '/operator/exports/artifacts',
      exportArtifacts,
      false,
    ), true);
    assert.equal(mount(
      service(model, 'cloud-project-recovery'),
      '/operator/backups/artifacts',
      backupArtifacts,
      false,
    ), true);
    assert.equal(mount(
      service(model, 'cloud-project-recovery'),
      '/operator/exports/artifacts',
      exportArtifacts,
      false,
    ), true);
    assert.equal(
      service(model, 'cloud-project-recovery').volumes?.some(
        candidate => candidate.target === backupCatalogs,
      ) ?? false,
      false,
    );
    for (const name of [
      'cloud-migration',
      'cloud-resume-delete',
      'cloud-server',
      'cloud-verify-authority',
    ]) {
      const current = service(model, name);
      assert.equal(current.volumes?.some(item => (
        item.target === backupArtifacts
          || item.target === backupCatalogs
          || item.target === exportArtifacts
      )) ?? false, false, name);
    }
  });

  it('uses an isolated writable authority only for clean-restore verification', () => {
    const model = render();
    assert.equal(authorityMount(service(model, 'cloud-verify-backup'), false), true);
    assert.equal(authorityMount(service(model, 'cloud-verify-authority'), true), true);
  });

  it('starts the pre-provisioned clean restore database before restore or verification', () => {
    const model = render();
    for (const name of ['cloud-restore', 'cloud-verify-backup']) {
      assert.equal(
        service(model, name).depends_on?.postgres?.condition,
        'service_healthy',
        name,
      );
    }
    assert.equal(
      service(model, 'cloud-bootstrap').environment?.CLAUDIAN_CLOUD_BOOTSTRAP_MODE,
      'authority',
    );
  });

  it('recovers the private restore journal before the server can start', () => {
    const model = render();
    const recovery = service(model, 'cloud-restore-recovery');
    assert.deepEqual(recovery.entrypoint?.slice(0, 2), ['/bin/sh', '-ec']);
    assert.match(
      recovery.entrypoint[2] ?? '',
      /exec node dist\/main\.js maintenance recover-restore/u,
    );
    assert.equal(
      recovery.environment?.CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED,
      'true',
    );
    assert.equal(recovery.read_only, true);
    assert.equal(recovery.restart, 'no');
    const projectRecovery = service(model, 'cloud-project-recovery');
    assert.deepEqual(projectRecovery.entrypoint?.slice(0, 2), ['/bin/sh', '-ec']);
    assert.match(
      projectRecovery.entrypoint[2] ?? '',
      /exec node dist\/main\.js maintenance recover-projects/u,
    );
    assert.equal(projectRecovery.profiles, undefined);
    assert.equal(projectRecovery.user, '10001:10001');
    assert.equal(projectRecovery.read_only, true);
    assert.equal(projectRecovery.restart, 'no');
    assert.equal(
      projectRecovery.depends_on?.['cloud-restore-recovery']?.condition,
      'service_completed_successfully',
    );
    assert.equal(
      service(model, 'cloud-server')
        .depends_on?.['cloud-project-recovery']?.condition,
      'service_completed_successfully',
    );
  });
});
