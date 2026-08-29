import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const deployScript = resolve(import.meta.dirname, '../../deploy/deploy.sh');
const previousImage = `sha256:${'a'.repeat(64)}`;
const candidateImage = `sha256:${'b'.repeat(64)}`;
const repairedCandidateImage = `sha256:${'c'.repeat(64)}`;

interface DeploymentFixture {
  readonly attemptStateFile: string;
  readonly checkout: string;
  readonly durabilityLog: string;
  readonly dockerLog: string;
  readonly environmentFile: string;
  readonly fakeBinaryDirectory: string;
  readonly migrationEnvironmentFile: string;
  readonly postgresEnvironmentFile: string;
  readonly restoreEnvironmentFile: string;
  readonly restoreBootstrapEnvironmentFile: string;
  readonly restoreMigrationEnvironmentFile: string;
  readonly restorePostgresEnvironmentFile: string;
  readonly root: string;
  readonly schemaStateFile: string;
  readonly targetRevision: string;
}

function git(cwd: string, ...arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function createFixture(): Promise<DeploymentFixture> {
  const root = await mkdtemp(join(tmpdir(), 'claudian-deploy-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'checkout');
  const fakeBinaryDirectory = join(root, 'bin');
  const durabilityLog = join(root, 'durability.log');
  const dockerLog = join(root, 'docker.log');
  const environmentFile = join(root, 'server.env');
  const migrationEnvironmentFile = join(root, 'migration.env');
  const postgresEnvironmentFile = join(root, 'postgres.env');
  const restoreEnvironmentFile = join(root, 'restore-server.env');
  const restoreBootstrapEnvironmentFile = join(root, 'restore-bootstrap.env');
  const restoreMigrationEnvironmentFile = join(root, 'restore-migration.env');
  const restorePostgresEnvironmentFile = join(root, 'restore-postgres.env');
  const attemptStateFile = join(root, 'deploy-attempt');
  const schemaStateFile = join(root, 'schema-version');

  await mkdir(seed);
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(seed, 'init', '--initial-branch=main');
  git(seed, 'config', 'user.email', 'deployment-test@example.invalid');
  git(seed, 'config', 'user.name', 'Deployment Test');
  await mkdir(join(seed, 'deploy'), { recursive: true });
  await writeFile(
    join(seed, 'deploy/compose.yaml'),
    'services:\n  cloud-server:\n    image: ${CLAUDIAN_CLOUD_IMAGE}\n',
  );
  await writeFile(join(seed, 'deploy/Dockerfile'), 'FROM scratch\n');
  await writeFile(join(seed, 'version.txt'), 'first\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'test: add first revision');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '--set-upstream', 'origin', 'main');
  git(root, 'clone', remote, checkout);

  await writeFile(join(seed, 'version.txt'), 'second\n');
  git(seed, 'add', 'version.txt');
  git(seed, 'commit', '-m', 'test: add deployable revision');
  git(seed, 'push', 'origin', 'main');
  const targetRevision = git(seed, 'rev-parse', 'HEAD');

  await mkdir(fakeBinaryDirectory);
  const fakeDocker = join(fakeBinaryDirectory, 'docker');
  await writeFile(
    fakeDocker,
    `#!/usr/bin/env bash
set -u
schema_state_file="$FAKE_SCHEMA_STATE_FILE"
if [[ "\${CLAUDIAN_CLOUD_POSTGRES_PORT:-}" == "55432" ]]; then
  schema_state_file="$FAKE_SCHEMA_STATE_FILE.restore"
fi
printf 'image=%s|operation=%s|%s\n' "\${CLAUDIAN_CLOUD_IMAGE:-}" "\${CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID:-}" "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "volume" && "$2" == "ls" ]]; then
  if [[ "\${FAKE_RESTORE_VOLUME_LIST_FAIL:-0}" == "1" ]]; then
    exit 33
  fi
  if [[ "\${FAKE_RESTORE_TARGET_COLLISION:-0}" == "1" \
      || -f "$FAKE_RESTORE_OWNERSHIP_STATE_FILE" ]]; then
    printf '%s\n' \
      claudian-cloud-restore-test_cloud-authority \
      claudian-cloud-restore-test_postgres-data
  fi
  exit 0
fi
if [[ "$1" == "volume" && "$2" == "inspect" ]]; then
  if [[ "\${FAKE_RESTORE_VOLUME_INSPECT_FAIL:-0}" == "1" ]]; then
    exit 34
  fi
  if [[ "\${FAKE_RESTORE_TARGET_COLLISION:-0}" == "1" ]]; then
    if [[ "$*" == *"--format"* ]]; then
      printf '%s\n' foreign-owner
    fi
    exit 0
  fi
  if [[ -f "$FAKE_RESTORE_OWNERSHIP_STATE_FILE" ]]; then
    if [[ "$*" == *"--format"* ]]; then
      sed -n '1p' "$FAKE_RESTORE_OWNERSHIP_STATE_FILE"
    fi
    exit 0
  fi
  exit 1
fi
if [[ "$1" == "inspect" && "$*" == *"com.claudian.restore-owner"* ]]; then
  if [[ "\${FAKE_RESTORE_CONTAINER_COLLISION:-0}" == "1" ]]; then
    printf '%s\n' foreign-owner
    exit 0
  fi
  if [[ -f "$FAKE_RESTORE_OWNERSHIP_STATE_FILE" ]]; then
    sed -n '1p' "$FAKE_RESTORE_OWNERSHIP_STATE_FILE"
    exit 0
  fi
  exit 1
fi
if [[ "$1" == "compose" \
    && "$*" == *"--project-name claudian-cloud-restore-test"* \
    && "$*" == *" ps --all --quiet"* \
    && "$*" != *" ps --all --quiet cloud-server"* ]]; then
  if [[ "\${FAKE_RESTORE_TARGET_COLLISION:-0}" == "1" \
      || "\${FAKE_RESTORE_CONTAINER_COLLISION:-0}" == "1" ]]; then
    printf '%s\n' foreign-restore-container
  fi
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" ps --all --quiet cloud-server"* ]]; then
  printf '%s\n' existing-container
  exit 0
fi
if [[ "$1" == "inspect" && "$*" == *"{{.Image}}"* ]]; then
  printf '%s\n' ${previousImage}
  exit 0
fi
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  printf '%s\n' "\${FAKE_CANDIDATE_IMAGE:-${candidateImage}}"
  exit 0
fi
if [[ "$1" == "build" && -n "\${FAKE_DEPLOY_PAUSE_FILE:-}" ]]; then
  if mkdir "\${FAKE_DEPLOY_PAUSE_FILE}.claim" 2>/dev/null; then
    : > "\${FAKE_DEPLOY_PAUSE_FILE}.entered"
    while [[ ! -e "\${FAKE_DEPLOY_PAUSE_FILE}.release" ]]; do
      sleep 0.01
    done
  fi
fi
if [[ "$1" == "run" && "$*" == *" dist/migrate.js target"* ]]; then
  printf '10\n'
  exit 0
fi
if [[ "$1" == "run" && "$*" == *" dist/migrate.js supports "* ]]; then
  version="\${*: -1}"
  if [[ "\${FAKE_PREVIOUS_SUPPORTS_UNAVAILABLE:-0}" == "1" \
      && "$*" == *"${previousImage}"* ]]; then
    exit 2
  fi
  if [[ ("$*" == *"${candidateImage}"* && "$version" == "10") \
      || ("$*" == *"${candidateImage}"* \
        && "\${FAKE_CANDIDATE_SUPPORTS_BEFORE:-1}" == "1" \
        && "$version" == "\${FAKE_SCHEMA_BEFORE:-10}") \
      || ("$*" == *"${previousImage}"* \
        && "$version" == "\${FAKE_SCHEMA_BEFORE:-10}") \
      || "$version" == "\${FAKE_PREVIOUS_SUPPORTS_VERSION:-}" \
      || "\${FAKE_PREVIOUS_SUPPORTS_TARGET:-0}" == "1" ]]; then
    exit 0
  fi
  exit 2
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-migration node dist/migrate.js preflight"* ]]; then
  if [[ "\${FAKE_PREFLIGHT_FAIL:-0}" == "1" ]]; then
    exit 25
  fi
  if [[ -f "$schema_state_file" ]]; then
    sed -n '1p' "$schema_state_file"
  else
    printf '%s\n' "\${FAKE_SCHEMA_BEFORE:-10}"
  fi
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-migration"* && "$*" != *" preflight"* ]]; then
  if [[ "\${FAKE_MIGRATION_FAIL_AFTER_ADVANCE:-0}" == "1" && ! -f "$schema_state_file.attempted" ]]; then
    printf '9\n' > "$schema_state_file"
    : > "$schema_state_file.attempted"
    exit 18
  fi
  if [[ "\${FAKE_MIGRATION_FAIL:-0}" == "1" ]]; then
    exit 19
  fi
  printf '10\n' > "$schema_state_file"
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-backup"* && "\${FAKE_BACKUP_FAIL:-0}" == "1" ]]; then
  exit 20
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-backup"* \
    && "\${FAKE_PREVIOUS_BACKUP_UNAVAILABLE:-0}" == "1" \
    && "\${CLAUDIAN_CLOUD_IMAGE:-}" == "${previousImage}" ]]; then
  exit 28
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-backup"* ]]; then
  printf '%s\n' "\${CLAUDIAN_CLOUD_IMAGE:-}" > "$FAKE_SCHEMA_STATE_FILE.backup-image"
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-bootstrap"* \
    && "\${CLAUDIAN_CLOUD_POSTGRES_PORT:-}" == "55432" \
    && "\${CLAUDIAN_CLOUD_BOOTSTRAP_MODE:-}" != "restore-target" ]]; then
  exit 29
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-verify-backup"* ]]; then
  if [[ "\${FAKE_VERIFY_BACKUP_FAIL:-0}" == "1" ]]; then
    exit 21
  fi
  if [[ -f "$FAKE_SCHEMA_STATE_FILE.backup-image" \
      && "$(sed -n '1p' "$FAKE_SCHEMA_STATE_FILE.backup-image")" \
        != "\${CLAUDIAN_CLOUD_IMAGE:-}" ]]; then
    exit 30
  fi
  if [[ "\${CLAUDIAN_CLOUD_POSTGRES_PORT:-}" == "55432" ]]; then
    printf '%s\n' "\${FAKE_BACKUP_SCHEMA:-\${FAKE_SCHEMA_BEFORE:-10}}" > "$schema_state_file"
  fi
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-verify-authority"* \
    && "\${FAKE_PREVIOUS_MAINTENANCE_UNAVAILABLE:-0}" == "1" \
    && "\${CLAUDIAN_CLOUD_IMAGE:-}" == "${previousImage}" ]]; then
  exit 31
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-restore" ]]; then
  if [[ "\${FAKE_RESTORE_FAIL:-0}" == "1" ]]; then
    exit 22
  fi
  if [[ -f "$FAKE_SCHEMA_STATE_FILE.backup-image" \
      && "$(sed -n '1p' "$FAKE_SCHEMA_STATE_FILE.backup-image")" \
        != "\${CLAUDIAN_CLOUD_IMAGE:-}" ]]; then
    exit 30
  fi
  printf '%s\n' "\${FAKE_BACKUP_SCHEMA:-\${FAKE_SCHEMA_BEFORE:-10}}" > "$schema_state_file"
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-verify-authority"* ]]; then
  if [[ "\${FAKE_VERIFY_AUTHORITY_FAIL:-0}" == "1" \
      && "$*" == *"--project-name claudian-cloud-server"* ]]; then
    exit 23
  fi
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" stop cloud-server"* \
    && "\${FAKE_CANDIDATE_STOP_FAIL:-0}" == "1" \
    && "\${CLAUDIAN_CLOUD_IMAGE:-}" != "${previousImage}" ]]; then
  exit 32
fi
if [[ "$1" == "compose" \
    && "$*" == *"--project-name claudian-cloud-restore-test down --volumes"* ]]; then
  rm -f -- "$FAKE_RESTORE_OWNERSHIP_STATE_FILE"
  exit 0
fi
if [[ "$1" == "compose" \
    && "$*" == *"--project-name claudian-cloud-restore-test up "* \
    && "$*" == *" postgres" ]]; then
  printf '%s\n' "\${CLAUDIAN_CLOUD_RESTORE_OWNERSHIP_ID:-}" > \
    "$FAKE_RESTORE_OWNERSHIP_STATE_FILE"
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *"--project-name claudian-cloud-server up "* && "\${FAKE_DEPLOY_FAIL_NEW:-0}" == "1" && "\${CLAUDIAN_CLOUD_IMAGE:-}" != "${previousImage}" ]]; then
  exit 17
fi
if [[ "$1" == "compose" && "$*" == *"--project-name claudian-cloud-server up "* \
    && "\${CLAUDIAN_CLOUD_IMAGE:-}" == "${candidateImage}" \
    && "$(sed -n '1s/ .*//p' "$FAKE_ATTEMPT_STATE_FILE" 2>/dev/null)" == "backup-active" ]]; then
  exit 24
fi
exit 0
`,
  );
  await chmod(fakeDocker, 0o755);
  const fakeDd = join(fakeBinaryDirectory, 'dd');
  await writeFile(
    fakeDd,
    `#!/usr/bin/env bash
set -u
count=0
if [[ -f "$FAKE_DURABILITY_COUNT_FILE" ]]; then
  read -r count < "$FAKE_DURABILITY_COUNT_FILE"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$FAKE_DURABILITY_COUNT_FILE"
printf 'file\n' >> "$FAKE_DURABILITY_LOG"
if [[ "\${FAKE_DURABILITY_FAIL_AT:-0}" == "$count" ]]; then
  exit 26
fi
`,
  );
  await chmod(fakeDd, 0o755);
  const fakeSync = join(fakeBinaryDirectory, 'sync');
  await writeFile(
    fakeSync,
    `#!/usr/bin/env bash
set -u
count=0
if [[ -f "$FAKE_DURABILITY_COUNT_FILE" ]]; then
  read -r count < "$FAKE_DURABILITY_COUNT_FILE"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$FAKE_DURABILITY_COUNT_FILE"
printf 'directory\n' >> "$FAKE_DURABILITY_LOG"
if [[ "\${FAKE_DURABILITY_FAIL_AT:-0}" == "$count" ]]; then
  exit 27
fi
`,
  );
  await chmod(fakeSync, 0o755);
  await writeFile(environmentFile, 'CLAUDIAN_CLOUD_PORT=8787\n');
  await writeFile(
    migrationEnvironmentFile,
    'CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL=postgresql://migration.invalid/db\n',
  );
  await writeFile(postgresEnvironmentFile, 'POSTGRES_DB=postgres\n');
  await writeFile(restoreEnvironmentFile, 'CLAUDIAN_CLOUD_PORT=8788\n');
  await writeFile(restoreBootstrapEnvironmentFile, 'POSTGRES_USER=restore\n');
  await writeFile(
    restoreMigrationEnvironmentFile,
    'CLAUDIAN_CLOUD_POSTGRES_MIGRATION_URL=postgresql://restore.invalid/db\n',
  );
  await writeFile(restorePostgresEnvironmentFile, 'POSTGRES_DB=restore\n');

  return {
    attemptStateFile,
    checkout,
    durabilityLog,
    dockerLog,
    environmentFile,
    fakeBinaryDirectory,
    migrationEnvironmentFile,
    postgresEnvironmentFile,
    restoreEnvironmentFile,
    restoreBootstrapEnvironmentFile,
    restoreMigrationEnvironmentFile,
    restorePostgresEnvironmentFile,
    root,
    schemaStateFile,
    targetRevision,
  };
}

function deploymentEnvironment(
  fixture: DeploymentFixture,
  extraEnvironment: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDIAN_DEPLOY_BUILD_NETWORK: 'host',
    CLAUDIAN_DEPLOY_ATTEMPT_STATE_FILE: fixture.attemptStateFile,
    CLAUDIAN_DEPLOY_ENV_FILE: fixture.environmentFile,
    CLAUDIAN_DEPLOY_MIGRATION_ENV_FILE: fixture.migrationEnvironmentFile,
    CLAUDIAN_DEPLOY_POSTGRES_ENV_FILE: fixture.postgresEnvironmentFile,
    CLAUDIAN_DEPLOY_RESTORE_BOOTSTRAP_ENV_FILE:
      fixture.restoreBootstrapEnvironmentFile,
    CLAUDIAN_DEPLOY_RESTORE_COMPOSE_PROJECT: 'claudian-cloud-restore-test',
    CLAUDIAN_DEPLOY_RESTORE_ENV_FILE: fixture.restoreEnvironmentFile,
    CLAUDIAN_DEPLOY_RESTORE_MIGRATION_ENV_FILE:
      fixture.restoreMigrationEnvironmentFile,
    CLAUDIAN_DEPLOY_RESTORE_OWNERSHIP_ID: 'd'.repeat(64),
    CLAUDIAN_DEPLOY_RESTORE_POSTGRES_ENV_FILE:
      fixture.restorePostgresEnvironmentFile,
    CLAUDIAN_DEPLOY_RESTORE_POSTGRES_PORT: '55432',
    FAKE_DOCKER_LOG: fixture.dockerLog,
    FAKE_DURABILITY_LOG: fixture.durabilityLog,
    FAKE_DURABILITY_COUNT_FILE: `${fixture.durabilityLog}.count`,
    FAKE_ATTEMPT_STATE_FILE: fixture.attemptStateFile,
    FAKE_RESTORE_OWNERSHIP_STATE_FILE: `${fixture.schemaStateFile}.restore-owner`,
    FAKE_SCHEMA_STATE_FILE: fixture.schemaStateFile,
    PATH: `${fixture.fakeBinaryDirectory}:${process.env.PATH ?? ''}`,
    ...extraEnvironment,
  };
}

function runDeployment(
  fixture: DeploymentFixture,
  extraEnvironment: Readonly<Record<string, string>> = {},
) {
  return spawnSync('bash', [deployScript], {
    cwd: fixture.checkout,
    encoding: 'utf8',
    env: deploymentEnvironment(fixture, extraEnvironment),
  });
}

async function runDeploymentAsync(
  fixture: DeploymentFixture,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number | null; readonly stderr: string }> {
  const child = spawn('bash', [deployScript], {
    cwd: fixture.checkout,
    env: deploymentEnvironment(fixture, extraEnvironment),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', status => resolvePromise({ status, stderr }));
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await readFile(path).then(() => true).catch(() => false)) {
      return;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function expectRollback(dockerLog: string): void {
  assert.match(
    dockerLog,
    new RegExp(`image=${previousImage}\\|operation=[0-9a-f]{64}\\|compose .* up `),
  );
  assert.doesNotMatch(
    dockerLog,
    new RegExp(
      `image=${previousImage}\\|operation=[0-9a-f]{64}\\|compose .* run --rm cloud-restore-recovery`,
    ),
  );
}

describe('deployment', () => {
  it('rejects a persistent attempt marker inside the checkout before dirty-state checks', async () => {
    const fixture = await createFixture();
    const inCheckoutState = join(fixture.checkout, 'deploy-attempt');
    try {
      await writeFile(
        inCheckoutState,
        `forward-only ${fixture.targetRevision} ${'c'.repeat(64)}\n`,
      );

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = runDeployment(fixture, {
          CLAUDIAN_DEPLOY_ATTEMPT_STATE_FILE: inCheckoutState,
          FAKE_ATTEMPT_STATE_FILE: inCheckoutState,
        });

        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          /deployment\.error: deployment-attempt-state-inside-checkout/,
        );
      }
      assert.equal(await readFile(fixture.dockerLog, 'utf8').catch(() => ''), '');
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('serializes the complete deployment attempt through one external lock', async () => {
    const fixture = await createFixture();
    const pauseFile = join(fixture.root, 'deploy-pause');
    let firstDeployment: Promise<{
      readonly status: number | null;
      readonly stderr: string;
    }> | undefined;
    try {
      firstDeployment = runDeploymentAsync(fixture, {
        FAKE_DEPLOY_PAUSE_FILE: pauseFile,
      });
      await waitForFile(`${pauseFile}.entered`);

      const concurrent = runDeployment(fixture, {
        FAKE_DEPLOY_PAUSE_FILE: pauseFile,
      });

      assert.equal(concurrent.status, 1);
      assert.match(
        concurrent.stderr,
        /deployment\.error: deployment-already-running/,
      );
      await writeFile(`${pauseFile}.release`, '');
      const first = await firstDeployment;
      assert.equal(first.status, 0, first.stderr);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.equal(dockerLog.match(/\|build /g)?.length, 1);
    } finally {
      await writeFile(`${pauseFile}.release`, '').catch(() => undefined);
      await firstDeployment?.catch(() => undefined);
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rejects an unowned populated restore Compose target before volume deletion', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_RESTORE_TARGET_COLLISION: '1',
      });

      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /deployment\.error: backup-restore-target-provision-failed/u,
      );
      assert.match(result.stderr, /deployment\.rolled-back/u);
      expectRollback(await readFile(fixture.dockerLog, 'utf8'));
      assert.doesNotMatch(
        await readFile(fixture.dockerLog, 'utf8'),
        /--project-name claudian-cloud-restore-test down --volumes/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rejects a foreign orphan even when an expected restore volume is owned', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(`${fixture.schemaStateFile}.restore-owner`, 'd'.repeat(64));
      const result = runDeployment(fixture, {
        FAKE_RESTORE_CONTAINER_COLLISION: '1',
      });

      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /deployment\.error: backup-restore-target-provision-failed/u,
      );
      assert.match(result.stderr, /deployment\.rolled-back/u);
      expectRollback(await readFile(fixture.dockerLog, 'utf8'));
      assert.doesNotMatch(
        await readFile(fixture.dockerLog, 'utf8'),
        /--project-name claudian-cloud-restore-test down --volumes/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('fails closed and rolls back when an existing volume cannot be inspected', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(`${fixture.schemaStateFile}.restore-owner`, 'd'.repeat(64));
      const result = runDeployment(fixture, {
        FAKE_RESTORE_VOLUME_INSPECT_FAIL: '1',
      });

      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /deployment\.error: backup-restore-target-provision-failed/u,
      );
      assert.match(result.stderr, /deployment\.rolled-back/u);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      expectRollback(dockerLog);
      assert.doesNotMatch(
        dockerLog,
        /--project-name claudian-cloud-restore-test down --volumes/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('persists every attempt-state publication and removal in crash-safe order', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        (await readFile(fixture.durabilityLog, 'utf8')).trim().split('\n'),
        [
          'file',
          'directory',
          'file',
          'directory',
          'file',
          'directory',
          'file',
          'directory',
          'directory',
        ],
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('fails before migration when the schema-forward fence cannot be persisted', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_DURABILITY_FAIL_AT: '6',
        FAKE_SCHEMA_BEFORE: '8',
      });

      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /deployment\.error: deployment-attempt-state-settlement-failed/,
      );
      assert.match(
        await readFile(fixture.attemptStateFile, 'utf8'),
        /^schema-forward /,
      );
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.doesNotMatch(dockerLog, / run --rm cloud-migration\n/);
      assert.doesNotMatch(
        dockerLog,
        /--project-name claudian-cloud-server up --detach/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('sanitizes external marker utility failures without exposing the configured path', async () => {
    const fixture = await createFixture();
    const sentinel = 'operator-marker-path-sentinel';
    const attemptStateFile = join(fixture.root, sentinel);
    try {
      const fakeMv = join(fixture.fakeBinaryDirectory, 'mv');
      await writeFile(
        fakeMv,
        `#!/usr/bin/env bash
printf 'injected mv failure: %s\n' "$*" >&2
exit 29
`,
      );
      await chmod(fakeMv, 0o755);

      const result = runDeployment(fixture, {
        CLAUDIAN_DEPLOY_ATTEMPT_STATE_FILE: attemptStateFile,
        FAKE_ATTEMPT_STATE_FILE: attemptStateFile,
      });

      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /deployment\.error: deployment-attempt-state-settlement-failed/,
      );
      assert.doesNotMatch(result.stderr, new RegExp(sentinel));
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rejects an uncommitted checkout before fetching or building', async () => {
    const fixture = await createFixture();
    try {
      const initialRevision = git(fixture.checkout, 'rev-parse', 'HEAD');
      await writeFile(join(fixture.checkout, 'local-change.txt'), 'dirty\n');

      const result = runDeployment(fixture);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /deployment\.error: dirty-checkout/);
      assert.equal(git(fixture.checkout, 'rev-parse', 'HEAD'), initialRevision);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('runs the verified upgrade sequence under immutable image identities', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(git(fixture.checkout, 'rev-parse', 'HEAD'), fixture.targetRevision);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.equal(await readFile(fixture.attemptStateFile, 'utf8').catch(() => ''), '');
      assert.match(
        dockerLog,
        new RegExp(
          `build .*--network host .*--build-arg CLAUDIAN_SERVER_BUILD=${fixture.targetRevision} .*--tag claudian-cloud-server:${fixture.targetRevision}`,
        ),
      );
      assert.match(
        dockerLog,
        new RegExp(`image=${candidateImage}\\|operation=[0-9a-f]{64}\\|compose .* up `),
      );
      assert.doesNotMatch(
        dockerLog,
        new RegExp(`image=claudian-cloud-server:${fixture.targetRevision}\\|operation=.*\\|compose .* up `),
      );
      const stop = dockerLog.indexOf(' stop cloud-server');
      const backup = dockerLog.indexOf(' run --rm cloud-backup');
      const verifyBackup = dockerLog.indexOf(' run --rm cloud-verify-backup');
      const preflightPositions = [...dockerLog.matchAll(
        / run --rm cloud-migration node dist\/migrate\.js preflight/g,
      )].map(match => match.index);
      const schemaProbe = preflightPositions[0] ?? -1;
      const restoredSchemaProbe = preflightPositions[1] ?? -1;
      const preflight = preflightPositions[2] ?? -1;
      const migrate = dockerLog.indexOf(' run --rm cloud-migration\n');
      const start = dockerLog.lastIndexOf(' up --detach');
      const verifyAuthority = dockerLog.lastIndexOf(' run --rm cloud-verify-authority');
      const recoverRestore = dockerLog.lastIndexOf(
        ' run --rm cloud-restore-recovery',
      );
      assert.equal(
        stop < backup
          && stop < schemaProbe
          && schemaProbe < backup
          && backup < verifyBackup
          && verifyBackup < restoredSchemaProbe
          && restoredSchemaProbe < preflight
          && preflight < migrate
          && migrate < verifyAuthority
          && verifyAuthority < recoverRestore
          && recoverRestore < start,
        true,
      );
      assert.match(
        dockerLog,
        new RegExp(`image=${candidateImage}\\|operation=[0-9a-f]{64}\\|compose .* run --rm cloud-backup`),
      );
      assert.doesNotMatch(
        dockerLog,
        new RegExp(`image=${previousImage}\\|operation=.*\\|compose .* run --rm cloud-backup`),
      );
      assert.match(
        dockerLog,
        new RegExp(
          `image=${candidateImage}\\|operation=[0-9a-f]{64}\\|compose .* --project-name claudian-cloud-restore-test run --rm cloud-verify-backup`,
        ),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('uses a schema-compatible candidate when the predecessor lacks backup commands', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_SCHEMA_BEFORE: '9',
        FAKE_PREVIOUS_BACKUP_UNAVAILABLE: '1',
      });

      assert.equal(result.status, 0, result.stderr);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.match(
        dockerLog,
        new RegExp(`image=${candidateImage}\\|operation=[0-9a-f]{64}\\|compose .* run --rm cloud-backup`),
      );
      assert.doesNotMatch(
        dockerLog,
        new RegExp(`image=${previousImage}\\|operation=[0-9a-f]{64}\\|compose .* run --rm cloud-backup`),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('restores the observed image when failure occurs without advancement', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, { FAKE_DEPLOY_FAIL_NEW: '1' });

      assert.notEqual(result.status, 0);
      expectRollback(await readFile(fixture.dockerLog, 'utf8'));
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rotates the backup operation after rollback reopens writes', async () => {
    const fixture = await createFixture();
    try {
      const first = runDeployment(fixture, { FAKE_DEPLOY_FAIL_NEW: '1' });
      assert.notEqual(first.status, 0);
      const second = runDeployment(fixture, { FAKE_DEPLOY_FAIL_NEW: '1' });
      assert.notEqual(second.status, 0);

      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      const operationIds = [...dockerLog.matchAll(
        /operation=([0-9a-f]{64})\|compose .* run --rm cloud-backup/g,
      )].map(match => match[1]);
      assert.equal(operationIds.length, 2);
      assert.notEqual(operationIds[0], operationIds[1]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rotates the backup operation after an ambiguous candidate start', async () => {
    const fixture = await createFixture();
    try {
      const failure = {
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_SCHEMA_BEFORE: '8',
      };
      assert.notEqual(runDeployment(fixture, failure).status, 0);
      assert.notEqual(runDeployment(fixture, failure).status, 0);

      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      const operationIds = [...dockerLog.matchAll(
        /operation=([0-9a-f]{64})\|compose .* run --rm cloud-backup/g,
      )].map(match => match[1]);
      assert.equal(operationIds.length, 2);
      assert.notEqual(operationIds[0], operationIds[1]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('reuses the verified backup identity across a schema-forward repair', async () => {
    const fixture = await createFixture();
    try {
      const failed = runDeployment(fixture, {
        FAKE_VERIFY_AUTHORITY_FAIL: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });
      assert.notEqual(failed.status, 0);

      const repair = join(fixture.root, 'repair');
      git(fixture.root, 'clone', join(fixture.root, 'remote.git'), repair);
      git(repair, 'config', 'user.email', 'deployment-test@example.invalid');
      git(repair, 'config', 'user.name', 'Deployment Test');
      await writeFile(join(repair, 'repair.txt'), 'fixed-forward\n');
      git(repair, 'add', 'repair.txt');
      git(repair, 'commit', '-m', 'fix: repair candidate');
      git(repair, 'push', 'origin', 'main');

      const repaired = runDeployment(fixture, {
        CLAUDIAN_DEPLOY_FAILURE_MODE: 'restore',
        FAKE_CANDIDATE_IMAGE: repairedCandidateImage,
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });
      assert.notEqual(repaired.status, 0);
      assert.match(repaired.stderr, /deployment\.restored-backup/u);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      const operationIds = [...dockerLog.matchAll(
        /operation=([0-9a-f]{64})\|compose .* run --rm cloud-backup/g,
      )].map(match => match[1]);
      assert.equal(operationIds.length, 1);
      const operationId = operationIds[0];
      assert.ok(operationId !== undefined);
      assert.match(
        dockerLog,
        new RegExp(
          `image=${candidateImage}\\|operation=${operationId}\\|compose .* --project-name claudian-cloud-restore-test run --rm cloud-restore`,
        ),
      );
      assert.doesNotMatch(
        dockerLog,
        new RegExp(
          `image=${repairedCandidateImage}\\|operation=${operationId}\\|compose .* --project-name claudian-cloud-restore-test run --rm cloud-restore`,
        ),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('never reopens an incompatible old image after an earlier migration advanced', async () => {
    const fixture = await createFixture();
    try {
      const advanced = runDeployment(fixture, {
        FAKE_SCHEMA_BEFORE: '8',
        FAKE_VERIFY_AUTHORITY_FAIL: '1',
      });
      assert.notEqual(advanced.status, 0);
      assert.match(
        await readFile(fixture.attemptStateFile, 'utf8'),
        /^schema-forward /,
      );

      const retry = runDeployment(fixture, {
        FAKE_PREFLIGHT_FAIL: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });

      assert.notEqual(retry.status, 0);
      assert.match(
        await readFile(fixture.attemptStateFile, 'utf8'),
        /^schema-forward /,
      );
      assert.doesNotMatch(
        await readFile(fixture.dockerLog, 'utf8'),
        new RegExp(`image=${previousImage}\\|operation=[0-9a-f]{64}\\|compose .* up `),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('refuses an incompatible old image after schema advancement', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });

      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /deployment\.error: candidate-failed-after-schema-advancement/,
      );
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.doesNotMatch(
        dockerLog,
        new RegExp(`image=${previousImage}\\|operation=[0-9a-f]{64}\\|compose .* up `),
      );
      assert.equal(
        dockerLog.match(/ run --rm cloud-restore\n/g)?.length ?? 0,
        0,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('restarts the fixed-forward candidate before attempting a recovery backup', async () => {
    const fixture = await createFixture();
    try {
      const failed = runDeployment(fixture, {
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });
      assert.notEqual(failed.status, 0);
      assert.match(
        await readFile(fixture.attemptStateFile, 'utf8'),
        /^forward-only /,
      );
      const backupCountBefore = (
        await readFile(fixture.dockerLog, 'utf8')
      ).match(/ run --rm cloud-backup\n/g)?.length ?? 0;

      const recovered = runDeployment(fixture, {
        FAKE_BACKUP_FAIL: '1',
        FAKE_SCHEMA_BEFORE: '10',
      });

      assert.equal(recovered.status, 0, recovered.stderr);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.equal(
        dockerLog.match(/ run --rm cloud-backup\n/g)?.length ?? 0,
        backupCountBefore,
      );
      assert.equal(
        await readFile(fixture.attemptStateFile, 'utf8').catch(() => ''),
        '',
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('aborts fixed-forward recovery when candidate quiescence is unproven', async () => {
    const fixture = await createFixture();
    try {
      const failed = runDeployment(fixture, {
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });
      assert.notEqual(failed.status, 0);
      const backupCountBefore = (
        await readFile(fixture.dockerLog, 'utf8')
      ).match(/ run --rm cloud-backup\n/g)?.length ?? 0;

      const recovered = runDeployment(fixture, {
        FAKE_CANDIDATE_STOP_FAIL: '1',
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_SCHEMA_BEFORE: '10',
      });

      assert.equal(recovered.status, 1);
      assert.match(
        recovered.stderr,
        /deployment\.error: forward-recovery-runtime-stop-failed/u,
      );
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.equal(
        dockerLog.match(/ run --rm cloud-backup\n/g)?.length ?? 0,
        backupCountBefore,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('allows rollback after advancement only with explicit old-image support', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_PREVIOUS_SUPPORTS_TARGET: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });

      assert.notEqual(result.status, 0);
      expectRollback(await readFile(fixture.dockerLog, 'utf8'));
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('uses an explicit verified empty-restore fallback after advancement', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        CLAUDIAN_DEPLOY_FAILURE_MODE: 'restore',
        CLAUDIAN_DEPLOY_RESTORE_COMPOSE_PROJECT: 'claudian-cloud-restore-test',
        CLAUDIAN_DEPLOY_RESTORE_ENV_FILE: fixture.restoreEnvironmentFile,
        CLAUDIAN_DEPLOY_RESTORE_MIGRATION_ENV_FILE:
          fixture.restoreMigrationEnvironmentFile,
        CLAUDIAN_DEPLOY_RESTORE_POSTGRES_ENV_FILE:
          fixture.restorePostgresEnvironmentFile,
        CLAUDIAN_DEPLOY_RESTORE_POSTGRES_PORT: '55432',
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });

      assert.notEqual(result.status, 0);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      const restore = dockerLog.indexOf(' run --rm cloud-restore');
      const verify = dockerLog.lastIndexOf(' run --rm cloud-verify-authority');
      const rollback = dockerLog.lastIndexOf(`image=${previousImage}`);
      assert.equal(restore >= 0 && restore < verify && verify < rollback, true);
      assert.match(result.stderr, /deployment\.restored-backup/);
      assert.match(
        dockerLog,
        new RegExp(
          `image=${candidateImage}\\|operation=[0-9a-f]{64}\\|compose .* --project-name claudian-cloud-restore-test run --rm cloud-restore`,
        ),
      );
      assert.match(
        dockerLog,
        new RegExp(
          `image=${candidateImage}\\|operation=[0-9a-f]{64}\\|compose .* --project-name claudian-cloud-restore-test run --rm cloud-verify-authority`,
        ),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('uses candidate maintenance to verify a first-upgrade restored authority', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        CLAUDIAN_DEPLOY_FAILURE_MODE: 'restore',
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_PREVIOUS_BACKUP_UNAVAILABLE: '1',
        FAKE_PREVIOUS_MAINTENANCE_UNAVAILABLE: '1',
        FAKE_SCHEMA_BEFORE: '9',
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /deployment\.restored-backup/u);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.match(
        dockerLog,
        new RegExp(
          `image=${candidateImage}\\|operation=[0-9a-f]{64}\\|compose .* --project-name claudian-cloud-restore-test run --rm cloud-verify-authority`,
        ),
      );
      assert.doesNotMatch(
        dockerLog,
        new RegExp(
          `image=${previousImage}\\|operation=[0-9a-f]{64}\\|compose .* --project-name claudian-cloud-restore-test run --rm cloud-verify-authority`,
        ),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('restores with the exact image that produced a pre-upgrade-schema backup', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        CLAUDIAN_DEPLOY_FAILURE_MODE: 'restore',
        FAKE_CANDIDATE_SUPPORTS_BEFORE: '0',
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /deployment\.restored-backup/);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.match(
        dockerLog,
        new RegExp(
          `image=${previousImage}\\|operation=[0-9a-f]{64}\\|compose .* run --rm cloud-backup`,
        ),
      );
      assert.match(
        dockerLog,
        new RegExp(
          `image=${previousImage}\\|operation=[0-9a-f]{64}\\|compose .* --project-name claudian-cloud-restore-test run --rm cloud-restore`,
        ),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('fails closed on retry while the restored authority remains selected', async () => {
    const fixture = await createFixture();
    const restoreEnvironment = {
      CLAUDIAN_DEPLOY_FAILURE_MODE: 'restore',
      CLAUDIAN_DEPLOY_RESTORE_COMPOSE_PROJECT: 'claudian-cloud-restore-test',
      CLAUDIAN_DEPLOY_RESTORE_ENV_FILE: fixture.restoreEnvironmentFile,
      CLAUDIAN_DEPLOY_RESTORE_MIGRATION_ENV_FILE:
        fixture.restoreMigrationEnvironmentFile,
      CLAUDIAN_DEPLOY_RESTORE_POSTGRES_ENV_FILE:
        fixture.restorePostgresEnvironmentFile,
      CLAUDIAN_DEPLOY_RESTORE_POSTGRES_PORT: '55432',
      FAKE_DEPLOY_FAIL_NEW: '1',
      FAKE_SCHEMA_BEFORE: '8',
    } as const;
    try {
      const restored = runDeployment(fixture, restoreEnvironment);
      assert.notEqual(restored.status, 0);
      assert.match(
        await readFile(fixture.attemptStateFile, 'utf8'),
        /^restored-active /,
      );
      const dockerLogBeforeRetry = await readFile(fixture.dockerLog, 'utf8');

      const retry = runDeployment(fixture, restoreEnvironment);

      assert.equal(retry.status, 1);
      assert.match(
        retry.stderr,
        /deployment\.error: restored-authority-active/,
      );
      assert.equal(await readFile(fixture.dockerLog, 'utf8'), dockerLogBeforeRetry);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('restores the verified backup schema after a committed-prefix retry', async () => {
    const fixture = await createFixture();
    try {
      const partial = runDeployment(fixture, {
        FAKE_MIGRATION_FAIL: '1',
        FAKE_MIGRATION_FAIL_AFTER_ADVANCE: '1',
        FAKE_SCHEMA_BEFORE: '7',
      });
      assert.notEqual(partial.status, 0);
      assert.equal(await readFile(fixture.schemaStateFile, 'utf8'), '9\n');

      const restored = runDeployment(fixture, {
        CLAUDIAN_DEPLOY_FAILURE_MODE: 'restore',
        CLAUDIAN_DEPLOY_RESTORE_COMPOSE_PROJECT: 'claudian-cloud-restore-test',
        CLAUDIAN_DEPLOY_RESTORE_ENV_FILE: fixture.restoreEnvironmentFile,
        CLAUDIAN_DEPLOY_RESTORE_MIGRATION_ENV_FILE:
          fixture.restoreMigrationEnvironmentFile,
        CLAUDIAN_DEPLOY_RESTORE_POSTGRES_ENV_FILE:
          fixture.restorePostgresEnvironmentFile,
        CLAUDIAN_DEPLOY_RESTORE_POSTGRES_PORT: '55432',
        FAKE_BACKUP_SCHEMA: '7',
        FAKE_DEPLOY_FAIL_NEW: '1',
        FAKE_SCHEMA_BEFORE: '7',
      });

      assert.notEqual(restored.status, 0);
      assert.match(restored.stderr, /deployment\.restored-backup/);
      assert.equal(
        await readFile(`${fixture.schemaStateFile}.restore`, 'utf8'),
        '7\n',
      );
      assert.match(
        await readFile(fixture.attemptStateFile, 'utf8'),
        /^restored-active /,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rejects restore fallback without a distinct empty target', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        CLAUDIAN_DEPLOY_FAILURE_MODE: 'restore',
        CLAUDIAN_DEPLOY_RESTORE_COMPOSE_PROJECT: '',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /deployment\.error: restore-target-required/);
      assert.equal(
        await readFile(fixture.dockerLog, 'utf8').catch(() => ''),
        '',
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rolls back a failed transaction when the schema did not advance', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_MIGRATION_FAIL: '1',
        FAKE_SCHEMA_BEFORE: '8',
      });

      assert.notEqual(result.status, 0);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      expectRollback(dockerLog);
      assert.equal(
        dockerLog.match(/ run --rm cloud-restore\n/g)?.length ?? 0,
        0,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rolls back at the verified backup schema without a predecessor probe', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_MIGRATION_FAIL: '1',
        FAKE_PREVIOUS_SUPPORTS_UNAVAILABLE: '1',
      });

      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /deployment\.error: migration-failed-before-schema-advancement/,
      );
      expectRollback(await readFile(fixture.dockerLog, 'utf8'));
      assert.equal(await readFile(fixture.attemptStateFile, 'utf8').catch(() => ''), '');
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('recovers fixed-forward after a committed migration prefix loses its response', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_MIGRATION_FAIL_AFTER_ADVANCE: '1',
        FAKE_SCHEMA_BEFORE: '7',
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.schemaStateFile, 'utf8'), '10\n');
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.equal(
        dockerLog.match(/ run --rm cloud-migration\n/g)?.length,
        2,
      );
      assert.doesNotMatch(
        dockerLog,
        new RegExp(`image=${previousImage}\\|operation=[0-9a-f]{64}\\|compose .* up `),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rolls back a failed fixed-forward retry only to a compatible image', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_MIGRATION_FAIL: '1',
        FAKE_MIGRATION_FAIL_AFTER_ADVANCE: '1',
        FAKE_PREVIOUS_SUPPORTS_VERSION: '9',
        FAKE_SCHEMA_BEFORE: '7',
      });

      assert.notEqual(result.status, 0);
      expectRollback(await readFile(fixture.dockerLog, 'utf8'));
      assert.match(
        result.stderr,
        /deployment\.error: migration-failed-after-compatible-schema-advancement/,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
