import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

interface RenderedVolumeMount {
  readonly read_only?: boolean;
  readonly source: string;
  readonly target: string;
  readonly type: 'bind' | 'volume';
}

interface RenderedService {
  readonly command?: readonly string[];
  readonly depends_on?: Readonly<Record<string, {
    readonly condition: string;
  }>>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly image?: string;
  readonly network_mode?: string;
  readonly ports?: readonly unknown[];
  readonly profiles?: readonly string[];
  readonly restart?: string;
  readonly user?: string;
  readonly volumes?: readonly RenderedVolumeMount[];
}

interface RenderedCompose {
  readonly services: Readonly<Record<string, RenderedService>>;
  readonly volumes: Readonly<Record<string, { readonly name: string }>>;
}

interface CompositionFixture {
  readonly backupArtifactRoot: string;
  readonly bootstrapEnvironmentFile: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly exportArtifactRoot: string;
  readonly image: string;
  readonly keyringFile: string;
  readonly migrationEnvironmentFile: string;
  readonly postgresEnvironmentFile: string;
  readonly postgresPort: number;
  readonly projectName: string;
  readonly root: string;
  readonly runtimeEnvironmentFile: string;
  readonly runtimePort: number;
  readonly wrongRoleMigrationEnvironmentFile: string;
}

const repositoryRoot = resolve(import.meta.dirname, '../..');
const composeFile = resolve(repositoryRoot, 'deploy/compose.yaml');
const postgresImage = 'postgres@sha256:7d2695c3aa88e792e8b3b233e7e4adb296a20412c6c0ca361e3edaaacfada108';
const runPersistentComposition = process.env.CLAUDIAN_TEST_PERSISTENT_COMPOSE === '1';
const testServerBuild = 'd'.repeat(40);

function composeEnvironment(options: {
  readonly backupArtifactRoot?: string;
  readonly bootstrapEnvironmentFile: string;
  readonly exportArtifactRoot?: string;
  readonly image?: string;
  readonly keyringFile?: string;
  readonly migrationEnvironmentFile: string;
  readonly postgresEnvironmentFile: string;
  readonly postgresPort: number;
  readonly runtimeEnvironmentFile: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDIAN_CLOUD_BOOTSTRAP_ENV_FILE: options.bootstrapEnvironmentFile,
    ...(options.backupArtifactRoot === undefined ? {} : {
      CLAUDIAN_CLOUD_BACKUP_ARTIFACT_ROOT: options.backupArtifactRoot,
    }),
    ...(options.keyringFile === undefined ? {} : {
      CLAUDIAN_CLOUD_CLAIM_CUSTODY_KEYRING_FILE: options.keyringFile,
    }),
    CLAUDIAN_CLOUD_ENV_FILE: options.runtimeEnvironmentFile,
    ...(options.exportArtifactRoot === undefined ? {} : {
      CLAUDIAN_CLOUD_EXPORT_ARTIFACT_ROOT: options.exportArtifactRoot,
    }),
    CLAUDIAN_CLOUD_MIGRATION_ENV_FILE: options.migrationEnvironmentFile,
    CLAUDIAN_CLOUD_POSTGRES_ENV_FILE: options.postgresEnvironmentFile,
    CLAUDIAN_CLOUD_POSTGRES_PORT: String(options.postgresPort),
    ...(options.image === undefined ? {} : { CLAUDIAN_CLOUD_IMAGE: options.image }),
  };
}

function renderCompose(environment: NodeJS.ProcessEnv): RenderedCompose {
  const rendered = execFileSync(
    'docker',
    [
      'compose',
      '--file',
      composeFile,
      '--profile',
      '*',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(rendered) as RenderedCompose;
}

function service(model: RenderedCompose, name: string): RenderedService {
  const value = model.services[name];
  assert.ok(value, `missing Compose service ${name}`);
  return value;
}

function volumeMount(
  composeService: RenderedService,
  target: string,
): RenderedVolumeMount {
  const mount = composeService.volumes?.find(candidate => candidate.target === target);
  assert.ok(mount, `missing volume mount ${target}`);
  return mount;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('persistent-composition-port-unavailable'));
        return;
      }
      server.close(error => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function databaseUrl(
  role: string,
  password: string,
  port: number,
  database: string,
): string {
  const url = new URL('postgresql://127.0.0.1');
  url.username = role;
  url.password = password;
  url.port = String(port);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createFixture(): Promise<CompositionFixture> {
  const root = await mkdtemp(join(tmpdir(), 'claudian-persistent-compose-'));
  const token = randomBytes(8).toString('hex');
  const bootstrapPassword = `bootstrap_${randomBytes(16).toString('hex')}`;
  const migrationPassword = `migration_${randomBytes(16).toString('hex')}`;
  const runtimePassword = `runtime_${randomBytes(16).toString('hex')}`;
  const postgresPort = await availablePort();
  let runtimePort = await availablePort();
  while (runtimePort === postgresPort) runtimePort = await availablePort();

  const postgresEnvironmentFile = join(root, 'postgres.env');
  const backupArtifactRoot = join(root, 'backup-artifacts');
  const bootstrapEnvironmentFile = join(root, 'bootstrap.env');
  const migrationEnvironmentFile = join(root, 'migration.env');
  const keyringFile = join(root, 'claim-custody-keyring.json');
  const exportArtifactRoot = join(root, 'export-artifacts');
  const wrongRoleMigrationEnvironmentFile = join(root, 'migration-wrong-role.env');
  const runtimeEnvironmentFile = join(root, 'server.env');
  const receiptKeys = generateKeyPairSync('ed25519');
  const migrationUrl = databaseUrl(
    'claudian_cloud_migration',
    migrationPassword,
    postgresPort,
    'claudian_cloud',
  );
  const runtimeUrl = databaseUrl(
    'claudian_cloud_runtime',
    runtimePassword,
    postgresPort,
    'claudian_cloud',
  );

  await Promise.all([
    mkdir(backupArtifactRoot, { mode: 0o700 }),
    mkdir(exportArtifactRoot, { mode: 0o700 }),
    writeFile(postgresEnvironmentFile, [
      'POSTGRES_USER=claudian_cloud_bootstrap',
      `POSTGRES_PASSWORD=${bootstrapPassword}`,
      'POSTGRES_DB=postgres',
      '',
    ].join('\n'), { mode: 0o600 }),
    writeFile(bootstrapEnvironmentFile, [
      'PGHOST=127.0.0.1',
      `PGPORT=${String(postgresPort)}`,
      'PGUSER=claudian_cloud_bootstrap',
      `PGPASSWORD=${bootstrapPassword}`,
      'PGDATABASE=postgres',
      `CLAUDIAN_CLOUD_POSTGRES_MIGRATION_PASSWORD=${migrationPassword}`,
      `CLAUDIAN_CLOUD_POSTGRES_RUNTIME_PASSWORD=${runtimePassword}`,
      '',
    ].join('\n'), { mode: 0o600 }),
    writeFile(migrationEnvironmentFile, [
      `CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL=${migrationUrl}`,
      '',
    ].join('\n'), { mode: 0o600 }),
    writeFile(wrongRoleMigrationEnvironmentFile, [
      `CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL=${runtimeUrl}`,
      '',
    ].join('\n'), { mode: 0o600 }),
    writeFile(runtimeEnvironmentFile, [
      'CLAUDIAN_CLOUD_BIND_HOST=127.0.0.1',
      'CLAUDIAN_CLOUD_GIT_EXECUTABLE=/usr/bin/git',
      `CLAUDIAN_CLOUD_PORT=${String(runtimePort)}`,
      `CLAUDIAN_CLOUD_POSTGRES_URL=${runtimeUrl}`,
      'CLAUDIAN_CLOUD_REPOSITORY_ROOT=/var/lib/claudian-cloud/repositories',
      'CLAUDIAN_CLOUD_STAGING_ROOT=/var/lib/claudian-cloud/staging',
      'CLAUDIAN_CLOUD_STORAGE_NODE_ID=persistent-test-node',
      '',
    ].join('\n'), { mode: 0o600 }),
    writeFile(keyringFile, JSON.stringify({
      activeEncryptionKeyId: 'persistent-encryption-key',
      activeReceiptKeyId: 'persistent-receipt-key',
      encryptionKeys: [{
        key: Buffer.alloc(32, 7).toString('base64url'),
        keyId: 'persistent-encryption-key',
        keyVersion: 1,
      }],
      receiptKeys: [{
        keyId: 'persistent-receipt-key',
        keyVersion: 1,
        privateKey: receiptKeys.privateKey.export({
          format: 'der',
          type: 'pkcs8',
        }).toString('base64url'),
        publicKey: receiptKeys.publicKey.export({
          format: 'der',
          type: 'spki',
        }).toString('base64url'),
      }],
      schemaVersion: 1,
    }), { mode: 0o400 }),
  ]);

  const image = `claudian-cloud-server:persistent-${token}`;
  return {
    bootstrapEnvironmentFile,
    environment: composeEnvironment({
      backupArtifactRoot,
      bootstrapEnvironmentFile,
      exportArtifactRoot,
      image,
      keyringFile,
      migrationEnvironmentFile,
      postgresEnvironmentFile,
      postgresPort,
      runtimeEnvironmentFile,
    }),
    backupArtifactRoot,
    exportArtifactRoot,
    image,
    keyringFile,
    migrationEnvironmentFile,
    postgresEnvironmentFile,
    postgresPort,
    projectName: `claudian-persistent-${token}`,
    root,
    runtimeEnvironmentFile,
    runtimePort,
    wrongRoleMigrationEnvironmentFile,
  };
}

function runCompose(
  fixture: CompositionFixture,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = fixture.environment,
): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '--file',
      composeFile,
      '--project-name',
      fixture.projectName,
      ...arguments_,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 4 * 1_024 * 1_024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function runComposeExpectingFailure(
  fixture: CompositionFixture,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = fixture.environment,
): void {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--file',
      composeFile,
      '--project-name',
      fixture.projectName,
      ...arguments_,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 4 * 1_024 * 1_024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
}

describe('persistent local Compose model', () => {
  it('isolates credentials and binds PostgreSQL and Cloud to persistent loopback authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-compose-model-'));
    const postgresEnvironmentFile = join(root, 'postgres.env');
    const bootstrapEnvironmentFile = join(root, 'bootstrap.env');
    const migrationEnvironmentFile = join(root, 'migration.env');
    const runtimeEnvironmentFile = join(root, 'server.env');
    await Promise.all([
      writeFile(postgresEnvironmentFile, [
        'POSTGRES_USER=claudian_cloud_bootstrap',
        'POSTGRES_PASSWORD=bootstrap-secret-value',
        'POSTGRES_DB=postgres',
        '',
      ].join('\n')),
      writeFile(bootstrapEnvironmentFile, [
        'PGHOST=127.0.0.1',
        'PGPORT=55432',
        'PGUSER=claudian_cloud_bootstrap',
        'PGPASSWORD=bootstrap-secret-value',
        'PGDATABASE=postgres',
        'CLAUDIAN_CLOUD_POSTGRES_MIGRATION_PASSWORD=migration-secret-value',
        'CLAUDIAN_CLOUD_POSTGRES_RUNTIME_PASSWORD=runtime-secret-value',
        '',
      ].join('\n')),
      writeFile(migrationEnvironmentFile, [
        'CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL=postgresql://claudian_cloud_migration:migration-secret-value@127.0.0.1:55432/claudian_cloud',
        '',
      ].join('\n')),
      writeFile(runtimeEnvironmentFile, [
        'CLAUDIAN_CLOUD_BIND_HOST=127.0.0.1',
        'CLAUDIAN_CLOUD_PORT=49152',
        'CLAUDIAN_CLOUD_POSTGRES_URL=postgresql://claudian_cloud_runtime:runtime-secret-value@127.0.0.1:55432/claudian_cloud',
        'CLAUDIAN_CLOUD_REPOSITORY_ROOT=/var/lib/claudian-cloud/repositories',
        'CLAUDIAN_CLOUD_STAGING_ROOT=/var/lib/claudian-cloud/staging',
        'CLAUDIAN_CLOUD_STORAGE_NODE_ID=local-node',
        'CLAUDIAN_CLOUD_GIT_EXECUTABLE=/usr/bin/git',
        '',
      ].join('\n')),
    ]);

    try {
      const model = renderCompose(composeEnvironment({
        bootstrapEnvironmentFile,
        migrationEnvironmentFile,
        postgresEnvironmentFile,
        postgresPort: 55_432,
        runtimeEnvironmentFile,
      }));
      const postgres = service(model, 'postgres');
      const bootstrap = service(model, 'cloud-bootstrap');
      const migration = service(model, 'cloud-migration');
      const runtime = service(model, 'cloud-server');

      assert.deepEqual(Object.keys(model.volumes).sort(), [
        'cloud-authority',
        'postgres-data',
      ]);
      assert.equal(postgres.network_mode, 'host');
      assert.equal(postgres.ports, undefined);
      assert.match(postgres.command?.join(' ') ?? '', /listen_addresses=127\.0\.0\.1/);
      assert.match(postgres.command?.join(' ') ?? '', /port=55432/);
      assert.equal(postgres.restart, 'unless-stopped');
      assert.equal(postgres.image, postgresImage);
      assert.equal(
        volumeMount(postgres, '/var/lib/postgresql').source,
        'postgres-data',
      );

      assert.deepEqual(bootstrap.profiles, ['bootstrap']);
      assert.equal(bootstrap.user, '0:0');
      assert.equal(bootstrap.depends_on?.postgres?.condition, 'service_healthy');
      assert.equal(
        volumeMount(bootstrap, '/var/lib/claudian-cloud').source,
        'cloud-authority',
      );
      assert.equal(bootstrap.environment?.CLAUDIAN_CLOUD_POSTGRES_URL, undefined);
      assert.ok(bootstrap.environment?.PGPASSWORD);
      assert.ok(
        bootstrap.environment.CLAUDIAN_CLOUD_POSTGRES_MIGRATION_PASSWORD,
      );
      assert.ok(
        bootstrap.environment.CLAUDIAN_CLOUD_POSTGRES_RUNTIME_PASSWORD,
      );

      assert.deepEqual(migration.profiles, ['migration']);
      assert.equal(migration.user, '10001:10001');
      assert.equal(migration.volumes, undefined);
      assert.deepEqual(Object.keys(migration.environment ?? {}), [
        'CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL',
      ]);

      assert.equal(runtime.network_mode, 'host');
      assert.equal(runtime.ports, undefined);
      assert.deepEqual(runtime.depends_on, {
        'cloud-project-recovery': {
          condition: 'service_completed_successfully',
          required: true,
        },
      });
      assert.equal(runtime.user, '10001:10001');
      assert.equal(runtime.restart, 'unless-stopped');
      assert.equal(
        volumeMount(runtime, '/var/lib/claudian-cloud').source,
        'cloud-authority',
      );
      const projectRecovery = service(model, 'cloud-project-recovery');
      assert.deepEqual(projectRecovery.depends_on, {
        'cloud-restore-recovery': {
          condition: 'service_completed_successfully',
          required: true,
        },
      });
      assert.equal(runtime.environment?.PGPASSWORD, undefined);
      assert.equal(
        runtime.environment?.CLAUDIAN_CLOUD_POSTGRES_MIGRATION_PASSWORD,
        undefined,
      );
      assert.equal(
        runtime.environment?.CLAUDIAN_CLOUD_POSTGRES_RUNTIME_PASSWORD,
        undefined,
      );
      assert.match(
        runtime.environment?.CLAUDIAN_CLOUD_POSTGRES_URL ?? '',
        /claudian_cloud_runtime/,
      );
      assert.equal(service(model, 'postgres').environment?.POSTGRES_USER, 'claudian_cloud_bootstrap');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('proves clean provisioning, restart, fail-closed roles/schema, and paired-volume loss', {
    skip: !runPersistentComposition,
    timeout: 300_000,
  }, async () => {
    const fixture = await createFixture();
    let imageBuilt = false;
    try {
      execFileSync(
        'docker',
        [
          'build',
          '--build-arg',
          `CLAUDIAN_SERVER_BUILD=${testServerBuild}`,
          '--file',
          resolve(repositoryRoot, 'deploy/Dockerfile'),
          '--tag',
          fixture.image,
          '.',
        ],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: fixture.environment,
          maxBuffer: 4 * 1_024 * 1_024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      imageBuilt = true;
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--user',
          '0:0',
          '--mount',
          `type=bind,source=${fixture.keyringFile},target=/keyring`,
          fixture.image,
          '/bin/chown',
          '10001:10001',
          '/keyring',
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      assert.equal(
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--user',
            '10001:10001',
            '--mount',
            `type=bind,source=${fixture.keyringFile},target=/keyring,readonly`,
            fixture.image,
            '/usr/bin/stat',
            '--format=%u:%g:%a:%F',
            '/keyring',
          ],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ).trim(),
        '10001:10001:400:regular file',
      );
      for (const artifactRoot of [
        fixture.backupArtifactRoot,
        fixture.exportArtifactRoot,
      ]) {
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--user',
            '0:0',
            '--mount',
            `type=bind,source=${artifactRoot},target=/artifacts`,
            fixture.image,
            '/bin/chown',
            '10001:10001',
            '/artifacts',
          ],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      }

      runCompose(fixture, ['up', '--detach', '--wait', 'postgres']);
      const interruptedAuthorityId = randomBytes(16).toString('hex');
      runCompose(fixture, [
        '--profile',
        'bootstrap',
        'run',
        '--rm',
        '--entrypoint',
        '/bin/bash',
        'cloud-bootstrap',
        '-c',
        [
          'install -d -m 0700 -o 10001 -g 10001 /var/lib/claudian-cloud',
          `printf '%s' '${interruptedAuthorityId}' > /var/lib/claudian-cloud/.authority-volume-id.pending`,
          'chown 10001:10001 /var/lib/claudian-cloud/.authority-volume-id.pending',
          'chmod 0600 /var/lib/claudian-cloud/.authority-volume-id.pending',
          "psql --no-psqlrc --set ON_ERROR_STOP=on --command='CREATE ROLE claudian_cloud_migration'",
          "psql --no-psqlrc --set ON_ERROR_STOP=on --command='CREATE DATABASE claudian_cloud OWNER claudian_cloud_migration'",
        ].join(' && '),
      ]);
      runCompose(fixture, [
        '--profile',
        'bootstrap',
        'run',
        '--rm',
        'cloud-bootstrap',
      ]);
      runComposeExpectingFailure(fixture, [
        'run',
        '--rm',
        '--no-deps',
        'cloud-server',
      ]);
      runComposeExpectingFailure(
        fixture,
        [
          '--profile',
          'migration',
          'run',
          '--rm',
          '--no-deps',
          'cloud-migration',
        ],
        {
          ...fixture.environment,
          CLAUDIAN_CLOUD_MIGRATION_ENV_FILE:
            fixture.wrongRoleMigrationEnvironmentFile,
        },
      );

      runCompose(fixture, [
        '--profile',
        'migration',
        'run',
        '--rm',
        '--no-deps',
        'cloud-migration',
      ]);
      runCompose(fixture, [
        '--profile',
        'bootstrap',
        'run',
        '--rm',
        'cloud-bootstrap',
      ]);
      runCompose(fixture, [
        'run',
        '--rm',
        '--no-deps',
        'cloud-project-recovery',
      ]);

      const markerBeforeRestart = runCompose(fixture, [
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        '/bin/sh',
        'cloud-server',
        '-c',
        'cat /var/lib/claudian-cloud/.authority-volume-id',
      ]);
      assert.match(markerBeforeRestart, /^[0-9a-f]{32}$/);
      assert.equal(markerBeforeRestart, interruptedAuthorityId);

      try {
        runCompose(fixture, ['up', '--detach', '--no-deps', '--wait', 'cloud-server']);
      } catch {
        assert.fail(runCompose(fixture, ['logs', '--no-color', 'cloud-server']));
      }
      const ready = await fetch(
        `http://127.0.0.1:${String(fixture.runtimePort)}/readyz`,
      );
      assert.equal(ready.status, 200);

      runCompose(fixture, ['restart', 'postgres']);
      runCompose(fixture, ['up', '--detach', '--wait', 'postgres']);
      runCompose(fixture, ['restart', 'cloud-server']);
      runCompose(fixture, ['up', '--detach', '--no-deps', '--wait', 'cloud-server']);
      const markerAfterRestart = runCompose(fixture, [
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        '/bin/sh',
        'cloud-server',
        '-c',
        'cat /var/lib/claudian-cloud/.authority-volume-id',
      ]);
      assert.equal(markerAfterRestart, markerBeforeRestart);

      runCompose(fixture, ['down', '--remove-orphans']);
      const authorityVolume = `${fixture.projectName}_cloud-authority`;
      const postgresVolume = `${fixture.projectName}_postgres-data`;
      execFileSync('docker', ['volume', 'rm', authorityVolume], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(
        execFileSync(
          'docker',
          ['volume', 'inspect', postgresVolume, '--format', '{{.Name}}'],
          { encoding: 'utf8' },
        ).trim(),
        postgresVolume,
      );
      runComposeExpectingFailure(fixture, [
        '--profile',
        'bootstrap',
        'run',
        '--rm',
        'cloud-bootstrap',
      ]);
      runComposeExpectingFailure(fixture, [
        'run',
        '--rm',
        '--no-deps',
        'cloud-server',
      ]);
    } finally {
      try {
        runCompose(fixture, ['down', '--volumes', '--remove-orphans']);
      } catch {
        // Continue cleaning the isolated image and environment files.
      }
      if (imageBuilt) {
        try {
          execFileSync('docker', ['image', 'rm', '--force', fixture.image], {
            stdio: 'ignore',
          });
        } catch {
          // The isolated test image may already be absent.
        }
      }
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
