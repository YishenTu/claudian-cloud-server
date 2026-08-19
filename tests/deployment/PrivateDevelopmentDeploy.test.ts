import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

const deployScript = resolve(
  import.meta.dirname,
  '../../deploy/private-development/deploy.sh',
);

interface DeploymentFixture {
  readonly checkout: string;
  readonly dockerLog: string;
  readonly environmentFile: string;
  readonly fakeBinaryDirectory: string;
  readonly root: string;
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
  const dockerLog = join(root, 'docker.log');
  const environmentFile = join(root, 'server.env');

  await mkdir(seed);
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(seed, 'init', '--initial-branch=main');
  git(seed, 'config', 'user.email', 'deployment-test@example.invalid');
  git(seed, 'config', 'user.name', 'Deployment Test');
  await mkdir(join(seed, 'deploy/private-development'), { recursive: true });
  await writeFile(
    join(seed, 'deploy/private-development/compose.yaml'),
    'services:\n  cloud-server:\n    image: ${CLAUDIAN_CLOUD_IMAGE}\n',
  );
  await writeFile(
    join(seed, 'deploy/private-development/Dockerfile'),
    'FROM scratch\n',
  );
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
printf 'image=%s|%s\\n' "\${CLAUDIAN_CLOUD_IMAGE:-}" "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "compose" && "$*" == *" ps --quiet cloud-server"* ]]; then
  printf '%s\\n' existing-container
  exit 0
fi
if [[ "$1" == "inspect" ]]; then
  printf '%s\\n' claudian-cloud-server:previous
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" up "* && "\${FAKE_DEPLOY_FAIL_NEW:-0}" == "1" && "\${CLAUDIAN_CLOUD_IMAGE:-}" != "claudian-cloud-server:previous" ]]; then
  exit 17
fi
exit 0
`,
  );
  await chmod(fakeDocker, 0o755);
  await writeFile(environmentFile, 'CLAUDIAN_CLOUD_PORT=8787\n');

  return {
    checkout,
    dockerLog,
    environmentFile,
    fakeBinaryDirectory,
    root,
    targetRevision,
  };
}

function runDeployment(
  fixture: DeploymentFixture,
  extraEnvironment: Readonly<Record<string, string>> = {},
) {
  return spawnSync('bash', [deployScript], {
    cwd: fixture.checkout,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDIAN_DEPLOY_BUILD_NETWORK: 'host',
      CLAUDIAN_DEPLOY_ENV_FILE: fixture.environmentFile,
      FAKE_DOCKER_LOG: fixture.dockerLog,
      PATH: `${fixture.fakeBinaryDirectory}:${process.env.PATH ?? ''}`,
      ...extraEnvironment,
    },
  });
}

describe('private-development deployment', () => {
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

  it('deploys the fetched commit under an immutable revision image', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(git(fixture.checkout, 'rev-parse', 'HEAD'), fixture.targetRevision);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.match(
        dockerLog,
        new RegExp(`build .*--network host .*--tag claudian-cloud-server:${fixture.targetRevision}`),
      );
      assert.match(
        dockerLog,
        new RegExp(`image=claudian-cloud-server:${fixture.targetRevision}\\|compose .* up `),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('restores the observed image when the replacement is unhealthy', async () => {
    const fixture = await createFixture();
    try {
      const result = runDeployment(fixture, {
        FAKE_DEPLOY_FAIL_NEW: '1',
      });

      assert.notEqual(result.status, 0);
      const dockerLog = await readFile(fixture.dockerLog, 'utf8');
      assert.match(
        dockerLog,
        new RegExp(`image=claudian-cloud-server:${fixture.targetRevision}\\|compose .* up `),
      );
      assert.match(
        dockerLog,
        /image=claudian-cloud-server:previous\|compose .* up /,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
