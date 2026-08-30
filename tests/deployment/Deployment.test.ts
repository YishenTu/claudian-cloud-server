import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const deployScript = resolve(import.meta.dirname, '../../deploy/deploy.sh');
const previousImage = `sha256:${'a'.repeat(64)}`;
const candidateImage = `sha256:${'b'.repeat(64)}`;

interface Fixture {
  readonly checkout: string;
  readonly dockerLog: string;
  readonly environmentFile: string;
  readonly fakeBinaryDirectory: string;
  readonly lockFile: string;
  readonly postgresEnvironmentFile: string;
  readonly root: string;
  readonly stateFile: string;
  readonly targetRevision: string;
}

function git(cwd: string, ...arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'claudian-deploy-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'checkout');
  const fakeBinaryDirectory = join(root, 'bin');
  const dockerLog = join(root, 'docker.log');
  const environmentFile = join(root, 'server.env');
  const postgresEnvironmentFile = join(root, 'postgres.env');
  const lockFile = join(root, 'deploy.lock');
  const stateFile = join(root, 'deploy-forward');

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
  git(seed, 'commit', '-m', 'test: add deployment revision');
  git(seed, 'push', 'origin', 'main');
  const targetRevision = git(seed, 'rev-parse', 'HEAD');

  await mkdir(fakeBinaryDirectory);
  const fakeDocker = join(fakeBinaryDirectory, 'docker');
  await writeFile(
    fakeDocker,
    `#!/usr/bin/env bash
set -u
printf 'image=%s|migration=%s|%s\n' \
  "\${CLAUDIAN_CLOUD_IMAGE:-}" \
  "\${CLAUDIAN_CLOUD_MIGRATION_ENV_FILE:-}" \
  "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "compose" && "$*" == *" ps --all --quiet cloud-server"* ]]; then
  printf '%s\n' existing-cloud-server
  exit 0
fi
if [[ "$1" == "inspect" && "$*" == *"{{.Image}}"* ]]; then
  printf '%s\n' '${previousImage}'
  exit 0
fi
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  printf '%s\n' "\${FAKE_CANDIDATE_IMAGE:-${candidateImage}}"
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-verify-authority"* \
    && ! "\${CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID:-}" =~ ^[0-9a-f]{64}$ ]]; then
  exit 45
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-verify-authority"* \
    && "\${FAKE_VERIFY_AUTHORITY_FAIL:-0}" == "1" ]]; then
  exit 41
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-restore-recovery"* \
    && "\${FAKE_KILL_DEPLOY_AFTER_RECOVERY_START:-0}" == "1" ]]; then
  kill -KILL "$PPID"
  exit 46
fi
if [[ "$1" == "compose" && "$*" == *" run --rm cloud-restore-recovery"* \
    && "\${FAKE_RESTORE_RECOVERY_FAIL:-0}" == "1" ]]; then
  exit 42
fi
if [[ "$1" == "compose" && "$*" == *" run --rm --no-deps cloud-project-recovery"* \
    && "\${FAKE_PROJECT_RECOVERY_FAIL:-0}" == "1" ]]; then
  exit 43
fi
if [[ "$1" == "compose" && "$*" == *" up "* \
    && "\${CLAUDIAN_CLOUD_IMAGE:-}" == '${candidateImage}' \
    && "\${FAKE_CANDIDATE_START_FAIL:-0}" == "1" ]]; then
  exit 44
fi
exit 0
`,
  );
  await chmod(fakeDocker, 0o755);
  await writeFile(environmentFile, 'CLAUDIAN_CLOUD_POSTGRES_URL=postgres://runtime\n');
  await writeFile(postgresEnvironmentFile, 'POSTGRES_PASSWORD=test\n');

  return {
    checkout,
    dockerLog,
    environmentFile,
    fakeBinaryDirectory,
    lockFile,
    postgresEnvironmentFile,
    root,
    stateFile,
    targetRevision,
  };
}

function run(
  fixture: Fixture,
  extraEnvironment: Readonly<Record<string, string>> = {},
): SpawnSyncReturns<string> {
  return spawnSync('bash', [deployScript], {
    cwd: fixture.checkout,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.fakeBinaryDirectory}:${process.env.PATH ?? ''}`,
      CLAUDIAN_DEPLOY_ENV_FILE: fixture.environmentFile,
      CLAUDIAN_DEPLOY_LOCK_FILE: fixture.lockFile,
      CLAUDIAN_DEPLOY_POSTGRES_ENV_FILE: fixture.postgresEnvironmentFile,
      CLAUDIAN_DEPLOY_REF: 'origin/main',
      CLAUDIAN_DEPLOY_FORWARD_STATE_FILE: fixture.stateFile,
      CLAUDIAN_DEPLOY_WAIT_TIMEOUT_SECONDS: '5',
      FAKE_DOCKER_LOG: fixture.dockerLog,
      ...extraEnvironment,
    },
  });
}

async function log(fixture: Fixture): Promise<string> {
  return readFile(fixture.dockerLog, 'utf8');
}

function assertOrdered(value: string, operations: readonly string[]): void {
  let cursor = -1;
  for (const operation of operations) {
    const next = value.indexOf(operation, cursor + 1);
    assert.notEqual(next, -1, operation);
    assert.ok(next > cursor, operation);
    cursor = next;
  }
}

describe('deployment', () => {
  it('replaces a running current-schema server with one immutable candidate', async () => {
    const fixture = await createFixture();
    try {
      const result = run(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(
        `deployment\\.ready revision=${fixture.targetRevision} image=${candidateImage}`,
      ));
      const calls = await log(fixture);
      assertOrdered(calls, [
        '|build ',
        '|compose --file deploy/compose.yaml --project-name claudian-cloud-server stop cloud-server',
        `${candidateImage}|migration=|compose --file deploy/compose.yaml --project-name claudian-cloud-server run --rm cloud-verify-authority`,
        'run --rm cloud-restore-recovery',
        'run --rm --no-deps cloud-project-recovery',
        'up --detach --no-build --no-deps --wait --wait-timeout 5 cloud-server',
      ]);
      assert.doesNotMatch(calls, /cloud-migration|dist\/migrate|cloud-backup/);
      assert.doesNotMatch(calls, /migration=[^|]/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('restarts the unchanged previous image when read-only verification fails', async () => {
    const fixture = await createFixture();
    try {
      const result = run(fixture, { FAKE_VERIFY_AUTHORITY_FAIL: '1' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /candidate-authority-verification-failed/);
      const calls = await log(fixture);
      assert.match(calls, new RegExp(
        `${previousImage}\\|migration=\\|compose .* up .* --no-deps .*cloud-server`,
      ));
      assert.doesNotMatch(calls, /cloud-restore-recovery|cloud-project-recovery/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed after recovery has started', async () => {
    const fixture = await createFixture();
    try {
      const result = run(fixture, { FAKE_RESTORE_RECOVERY_FAIL: '1' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /candidate-restore-recovery-failed/);
      const calls = await log(fixture);
      assert.doesNotMatch(calls, new RegExp(`${previousImage}\\|.* up `));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('does not reopen the previous image when candidate startup fails', async () => {
    const fixture = await createFixture();
    try {
      const result = run(fixture, { FAKE_CANDIDATE_START_FAIL: '1' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /candidate-start-failed/);
      const calls = await log(fixture);
      assertOrdered(calls, [
        'run --rm cloud-restore-recovery',
        'run --rm --no-deps cloud-project-recovery',
        `${candidateImage}|migration=|compose`,
      ]);
      assert.doesNotMatch(calls, new RegExp(`${previousImage}\\|.* up `));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('validates the built image identity before stopping the server', async () => {
    const fixture = await createFixture();
    try {
      const result = run(fixture, { FAKE_CANDIDATE_IMAGE: 'not-an-image' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /candidate-image-identity-invalid/);
      assert.doesNotMatch(await log(fixture), /stop cloud-server/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects dirty checkouts and lock paths inside the checkout', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.checkout, 'dirty.txt'), 'dirty\n');
      const dirty = run(fixture);
      assert.equal(dirty.status, 1);
      assert.match(dirty.stderr, /dirty-checkout/);
      await rm(join(fixture.checkout, 'dirty.txt'));

      const inside = run(fixture, {
        CLAUDIAN_DEPLOY_LOCK_FILE: join(fixture.checkout, 'deploy.lock'),
      });
      assert.equal(inside.status, 1);
      assert.match(inside.stderr, /deployment-lock-inside-checkout/);

      const insideState = run(fixture, {
        CLAUDIAN_DEPLOY_FORWARD_STATE_FILE: join(
          fixture.checkout,
          'deploy-forward',
        ),
      });
      assert.equal(insideState.status, 1);
      assert.match(
        insideState.stderr,
        /deployment-forward-state-inside-checkout/,
      );

      await writeFile(fixture.stateFile, 'malformed\n');
      const malformedState = run(fixture);
      assert.equal(malformedState.status, 1);
      assert.match(
        malformedState.stderr,
        /deployment-forward-state-invalid/,
      );
      await rm(fixture.stateFile);

      await mkdir(fixture.lockFile);
      const locked = run(fixture);
      assert.equal(locked.status, 1);
      assert.match(locked.stderr, /deployment-lock-invalid/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('recovers a stale process lock after a host failure', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(fixture.lockFile, '999999\n');
      await delay(2_000);
      const result = run(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /deployment\.ready/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('resumes only the exact candidate after a crash once recovery starts', async () => {
    const fixture = await createFixture();
    try {
      const interrupted = run(fixture, {
        FAKE_KILL_DEPLOY_AFTER_RECOVERY_START: '1',
      });
      assert.equal(interrupted.signal, 'SIGKILL');
      await delay(2_000);
      git(
        fixture.checkout,
        'remote',
        'set-url',
        'origin',
        join(fixture.root, 'unavailable.git'),
      );

      const resumed = run(fixture, { FAKE_VERIFY_AUTHORITY_FAIL: '1' });
      assert.equal(resumed.status, 0, resumed.stderr);
      const calls = await log(fixture);
      assert.equal(calls.match(/cloud-verify-authority/gu)?.length, 1);
      assert.doesNotMatch(
        calls,
        new RegExp(`image=${previousImage}[^\\n]* up `),
      );
      await assert.rejects(readFile(fixture.stateFile));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
