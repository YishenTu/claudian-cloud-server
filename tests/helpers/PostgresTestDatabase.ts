import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';

export const POSTGRES_TEST_IMAGE = 'postgres@sha256:7d2695c3aa88e792e8b3b233e7e4adb296a20412c6c0ca361e3edaaacfada108';
export const POSTGRES_TEST_CONTAINER_LABEL = 'com.claudian.cloud.test-postgres=true';

export interface PostgresTestDatabase {
  readonly adminUrl: string;
  readonly migrationUrl: string;
  readonly mode: 'container' | 'external';
  readonly runtimeUrl: string;
  close(): Promise<void>;
}

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const execFileAsync = promisify(execFile);
const ADMIN_ROLE = 'claudian_test_admin';
const MIGRATION_ROLE = 'claudian_cloud_migration';
const RUNTIME_ROLE = 'claudian_cloud_runtime';

function randomToken(bytes = 18): string {
  return randomBytes(bytes).toString('hex');
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

function requiredExternalUrl(source: EnvironmentSource, field: string): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
      || parsed.pathname.length <= 1
    ) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('postgres-test-database-config-invalid');
  }
  return value;
}

function externalDatabase(source: EnvironmentSource): PostgresTestDatabase | undefined {
  const adminUrl = requiredExternalUrl(source, 'CLAUDIAN_TEST_POSTGRES_ADMIN_URL');
  const migrationUrl = requiredExternalUrl(source, 'CLAUDIAN_TEST_POSTGRES_MIGRATION_URL');
  const runtimeUrl = requiredExternalUrl(source, 'CLAUDIAN_TEST_POSTGRES_RUNTIME_URL');
  const present = [adminUrl, migrationUrl, runtimeUrl].filter(value => value !== undefined);
  if (present.length === 0) return undefined;
  if (adminUrl === undefined || migrationUrl === undefined || runtimeUrl === undefined) {
    throw new Error('postgres-test-database-config-incomplete');
  }
  return Object.freeze({
    adminUrl,
    close: () => Promise.resolve(),
    migrationUrl,
    mode: 'external' as const,
    runtimeUrl,
  });
}

async function docker(arguments_: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('docker', arguments_, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    throw new Error('postgres-test-database-container-failed');
  }
}

async function stopContainer(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await docker(['rm', '--force', '--volumes', containerName]);
    } catch {
      // A crashed --rm container may already be absent.
    }
    const remaining = await docker([
      'ps',
      '--all',
      '--filter',
      `label=${POSTGRES_TEST_CONTAINER_LABEL}`,
      '--format',
      '{{.Names}}',
    ]);
    if (!remaining.split('\n').includes(containerName)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('postgres-test-database-cleanup-failed');
}

async function publishedPort(containerName: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const output = await docker(['port', containerName, '5432/tcp']);
      const match = /:(\d+)$/.exec(output.split('\n', 1)[0] ?? '');
      const port = Number(match?.[1]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // The container can exist before Docker publishes its port.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('postgres-test-database-port-unavailable');
}

async function waitForPostgres(connectionString: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {
        // The failed connection may not have an open socket to close.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('postgres-test-database-readiness-timeout');
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error('postgres-test-identifier-invalid');
  }
  return `"${identifier}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function provisionDatabase(options: {
  readonly adminPassword: string;
  readonly database: string;
  readonly migrationPassword: string;
  readonly port: number;
  readonly runtimePassword: string;
}): Promise<void> {
  const bootstrapUrl = databaseUrl(
    ADMIN_ROLE,
    options.adminPassword,
    options.port,
    'postgres',
  );
  await waitForPostgres(bootstrapUrl);
  const client = new Client({ connectionString: bootstrapUrl });
  try {
    await client.connect();
    await client.query(
      `CREATE ROLE ${quoteIdentifier(MIGRATION_ROLE)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quoteLiteral(options.migrationPassword)}`,
    );
    await client.query(
      `CREATE ROLE ${quoteIdentifier(RUNTIME_ROLE)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quoteLiteral(options.runtimePassword)}`,
    );
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(options.database)} OWNER ${quoteIdentifier(MIGRATION_ROLE)}`,
    );
    await client.query(
      `REVOKE ALL ON DATABASE ${quoteIdentifier(options.database)} FROM PUBLIC`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(options.database)} TO ${quoteIdentifier(MIGRATION_ROLE)}, ${quoteIdentifier(RUNTIME_ROLE)}`,
    );
  } finally {
    await client.end();
  }
}

async function startContainerDatabase(): Promise<PostgresTestDatabase> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'claudian-postgres-'));
  const containerName = `claudian-postgres-${randomToken(8)}`;
  const adminPassword = randomToken();
  const migrationPassword = randomToken();
  const runtimePassword = randomToken();
  const database = `cloud_test_${randomToken(8)}`;
  const environmentFile = join(temporaryRoot, 'postgres.env');
  let containerStarted = false;

  try {
    await writeFile(
      environmentFile,
      [
        `POSTGRES_USER=${ADMIN_ROLE}`,
        `POSTGRES_PASSWORD=${adminPassword}`,
        'POSTGRES_DB=postgres',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    await docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--label',
      POSTGRES_TEST_CONTAINER_LABEL,
      '--env-file',
      environmentFile,
      '--publish',
      '127.0.0.1::5432/tcp',
      POSTGRES_TEST_IMAGE,
    ]);
    containerStarted = true;
    const port = await publishedPort(containerName);
    await provisionDatabase({
      adminPassword,
      database,
      migrationPassword,
      port,
      runtimePassword,
    });

    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      adminUrl: databaseUrl(ADMIN_ROLE, adminPassword, port, database),
      close: () => {
        closePromise ??= Promise.all([
          stopContainer(containerName),
          rm(temporaryRoot, { force: true, recursive: true }),
        ]).then(() => undefined);
        return closePromise;
      },
      migrationUrl: databaseUrl(MIGRATION_ROLE, migrationPassword, port, database),
      mode: 'container' as const,
      runtimeUrl: databaseUrl(RUNTIME_ROLE, runtimePassword, port, database),
    });
  } catch {
    let cleanupFailed = false;
    if (containerStarted) {
      try {
        await stopContainer(containerName);
      } catch {
        cleanupFailed = true;
      }
    }
    await rm(temporaryRoot, { force: true, recursive: true });
    if (cleanupFailed) {
      throw new Error('postgres-test-database-cleanup-failed');
    }
    throw new Error('postgres-test-database-start-failed');
  }
}

export async function acquirePostgresTestDatabase(
  source: EnvironmentSource = process.env,
): Promise<PostgresTestDatabase> {
  return externalDatabase(source) ?? startContainerDatabase();
}

export async function withPostgresTestDatabase<T>(
  operation: (database: PostgresTestDatabase) => Promise<T>,
  source: EnvironmentSource = process.env,
): Promise<T> {
  const database = await acquirePostgresTestDatabase(source);
  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}
