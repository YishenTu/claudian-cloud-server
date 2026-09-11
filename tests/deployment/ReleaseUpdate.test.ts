import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const dockerExecutable = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
const oldReference = `ghcr.io/yishentu/claudian-cloud-server@sha256:${'a'.repeat(64)}`;
const newReference = `ghcr.io/yishentu/claudian-cloud-server@sha256:${'b'.repeat(64)}`;
const oldImage = `sha256:${'c'.repeat(64)}`;
const newImage = `sha256:${'d'.repeat(64)}`;
const revision = 'e'.repeat(40);

interface ReleaseFixture {
  readonly root: string;
  readonly installation: string;
  readonly binaryDirectory: string;
  readonly assets: string;
  readonly calls: string;
  readonly stateDirectory: string;
  readonly fence: string;
}

interface Call {
  readonly tool: string;
  readonly args: readonly string[];
  readonly image?: string;
  readonly fenced?: boolean;
}

async function fixture(): Promise<ReleaseFixture> {
  const temporary = await mkdtemp(join(tmpdir(), 'claudian-release-update-'));
  const assets = join(temporary, 'assets');
  const oldAssets = join(temporary, 'old-assets');
  const binaryDirectory = join(temporary, 'bin');
  const stateDirectory = join(temporary, 'state');
  await mkdir(binaryDirectory);
  await mkdir(stateDirectory);
  for (const [image, build, output] of [
    [oldReference, 'f'.repeat(40), oldAssets],
    [newReference, revision, assets],
  ] as const) {
    execFileSync(process.execPath, [join(root, 'scripts/packageRelease.ts'), image, build, output]);
  }
  execFileSync('tar', ['-xzf', join(oldAssets, 'claudian-cloud-server.tar.gz'), '-C', temporary]);
  const installation = join(temporary, 'claudian-cloud-server');
  await writeFile(join(installation, 'release.env'), [
    `CLAUDIAN_CLOUD_IMAGE=${oldReference}`,
    'CLAUDIAN_DEPLOY_CPUS=2.25',
    'CLAUDIAN_DEPLOY_MEMORY=1536m',
    'CLAUDIAN_CLOUD_POSTGRES_PORT=5544',
    '',
  ].join('\n'));
  const calls = join(temporary, 'calls.jsonl');
  await writeFile(calls, '');
  const fence = join(stateDirectory, 'deploy-forward');
  const docker = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const image = process.env.CLAUDIAN_CLOUD_IMAGE;
const fenced = fs.existsSync(process.env.TEST_UPDATE_FENCE);
fs.appendFileSync(process.env.TEST_UPDATE_CALLS, JSON.stringify({tool:'docker', args, image, fenced}) + '\\n');
if (args[0] === 'pull' && process.env.TEST_PULL_FAIL === '1') process.exit(1);
if (args[0] === 'run' && args.includes('--entrypoint') && args.includes('node')) {
  process.stdout.write(JSON.parse(fs.readFileSync(0, 'utf8')).name);
} else if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(args.at(-1) === '${oldReference}' || args.at(-1) === '${oldImage}' ? '${oldImage}' : '${newImage}');
} else if (args[0] === 'inspect') {
  process.stdout.write(args.join(' ').includes('.State.Running') ? (fs.existsSync(process.env.TEST_UPDATE_STOPPED) ? 'false' : 'true') : '${oldImage}');
} else if (args[0] === 'compose') {
  if (args.includes('config') && process.env.TEST_REAL_COMPOSE === '1') {
    const child = require('node:child_process').spawnSync(process.env.TEST_DOCKER_EXECUTABLE, args, {stdio:'inherit'});
    process.exit(child.status ?? 1);
  } else if (args.includes('config') && !args.includes('--quiet')) {
    process.stdout.write(JSON.stringify({
      name: 'claudian-cloud-server',
      services: {'cloud-server': {image: image || '${oldImage}', network_mode:'host', environment:{CLAUDIAN_CLOUD_PORT:'8787'}}}
    }));
  } else if (args.includes('stop')) {
    fs.writeFileSync(process.env.TEST_UPDATE_STOPPED, 'stopped');
  } else if (args.includes('up')) {
    fs.rmSync(process.env.TEST_UPDATE_STOPPED, {force:true});
  } else if (args.includes('ps')) {
    if (process.env.TEST_MISSING_CONTAINER !== '1') process.stdout.write('existing-cloud-server');
  } else if (args.includes('run') && args.includes('cloud-verify-authority') && process.env.TEST_VERIFY_CRASH === '1') {
    process.kill(process.ppid, 'SIGKILL');
  } else if (args.includes('run') && args.includes('cloud-verify-authority') && process.env.TEST_VERIFY_FAIL === '1') {
    process.exit(1);
  } else if (args.includes('run') && args.includes('cloud-restore-recovery')) {
    if (process.env.TEST_RECOVERY_CRASH === '1') process.kill(process.ppid, 'SIGKILL');
    if (process.env.TEST_RECOVERY_FAIL === '1') process.exit(1);
  } else if (args.includes('exec') && process.env.TEST_READY_FAIL === '1') {
    process.exit(1);
  }
}
`;
  const curl = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_UPDATE_CALLS, JSON.stringify({tool:'curl', args}) + '\\n');
const url = args.at(-1);
const output = args[args.indexOf('--output') + 1];
const name = url.endsWith('.sha256') ? 'claudian-cloud-server.tar.gz.sha256' : 'claudian-cloud-server.tar.gz';
fs.copyFileSync(path.join(process.env.TEST_UPDATE_ASSETS, name), output);
if (process.env.TEST_BAD_CHECKSUM === '1' && name.endsWith('.sha256')) {
  fs.writeFileSync(output, '${'0'.repeat(64)}  claudian-cloud-server.tar.gz\\n');
}
`;
  await writeFile(join(binaryDirectory, 'docker'), docker);
  await writeFile(join(binaryDirectory, 'curl'), curl);
  await chmod(join(binaryDirectory, 'docker'), 0o755);
  await chmod(join(binaryDirectory, 'curl'), 0o755);
  return { root: temporary, installation, binaryDirectory, assets, calls, stateDirectory, fence };
}

function run(
  value: ReleaseFixture,
  args: readonly string[] = ['--update'],
  environment: Readonly<Record<string, string>> = {},
): SpawnSyncReturns<string> {
  return spawnSync('bash', [join(value.installation, 'deploy/deploy.sh'), ...args], {
    cwd: value.installation,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${value.binaryDirectory}:${process.env.PATH ?? ''}`,
      CLAUDIAN_DEPLOY_LOCK_FILE: join(value.stateDirectory, 'deploy.lock'),
      CLAUDIAN_DEPLOY_FORWARD_STATE_FILE: value.fence,
      TEST_UPDATE_FENCE: value.fence,
      TEST_UPDATE_CALLS: value.calls,
      TEST_UPDATE_ASSETS: value.assets,
      TEST_UPDATE_STOPPED: join(value.stateDirectory, 'server-stopped'),
      TEST_DOCKER_EXECUTABLE: dockerExecutable,
      ...environment,
    },
  });
}

async function calls(value: ReleaseFixture): Promise<readonly Call[]> {
  return (await readFile(value.calls, 'utf8')).trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line) as Call);
}

function argumentAfter(call: Call, flag: string): string {
  const index = call.args.indexOf(flag);
  assert.notEqual(index, -1);
  const value = call.args[index + 1];
  assert.ok(value);
  return value;
}

function operation(value: readonly Call[], name: string): Call | undefined {
  return value.find(call => call.tool === 'docker' && call.args.includes(name));
}

describe('prebuilt release updates', () => {
  it('updates an extracted installation and keeps its settings for subsequent Compose commands', async () => {
    const value = await fixture();
    try {
      const before = await readFile(join(value.installation, 'release.env'), 'utf8');
      const result = run(value);
      assert.equal(result.status, 0, result.stderr);
      const observed = await calls(value);
      assert.equal(observed.filter(call => call.tool === 'curl').length, 2);
      assert.ok(observed.filter(call => call.tool === 'curl').every(call => (
        call.args.at(-1)?.includes('/releases/latest/download/')
      )));
      assert.ok(operation(observed, 'pull')?.args.includes(newReference));
      assert.equal(operation(observed, 'cloud-restore-recovery')?.fenced, true);
      assert.equal(operation(observed, 'exec')?.fenced, true);
      assert.match(result.stdout, /deployment\.ready/);
      await assert.rejects(readFile(value.fence));
      assert.equal(await readFile(join(value.installation, 'release.env'), 'utf8'), before);
      const compose = run(value, ['--compose', 'ps', '--all']);
      assert.equal(compose.status, 0, compose.stderr);
      const last = (await calls(value)).at(-1);
      assert.ok(last);
      assert.ok(last.args.includes('ps'));
      const retained = await readFile(argumentAfter(last, '--env-file'), 'utf8');
      assert.match(retained, /CLAUDIAN_DEPLOY_CPUS=2\.25/);
      assert.match(retained, /CLAUDIAN_DEPLOY_MEMORY=1536m/);
      assert.match(retained, /CLAUDIAN_CLOUD_POSTGRES_PORT=5544/);
      assert.ok(retained.includes(newReference));
      const directory = run(value, ['--directory']);
      assert.equal(directory.status, 0, directory.stderr);
      assert.equal(join(directory.stdout.trim(), 'release.env'), argumentAfter(last, '--env-file'));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects a corrupt release before stopping the current application', async () => {
    const value = await fixture();
    try {
      const result = run(value, ['--update', 'v1.2.3'], { TEST_BAD_CHECKSUM: '1' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /checksum/);
      const observed = await calls(value);
      assert.ok(observed.filter(call => call.tool === 'curl').every(call => (
        call.args.at(-1)?.includes('/releases/download/v1.2.3/')
      )));
      assert.equal(operation(observed, 'stop'), undefined);
      await assert.rejects(readFile(value.fence));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('keeps the current application running when the image pull fails', async () => {
    const value = await fixture();
    try {
      const result = run(value, ['--update'], { TEST_PULL_FAIL: '1' });
      assert.equal(result.status, 1);
      assert.equal(operation(await calls(value), 'stop'), undefined);
      await assert.rejects(readFile(value.fence));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('reopens the previous image only when authority verification fails before recovery', async () => {
    const value = await fixture();
    try {
      const result = run(value, ['--update'], { TEST_VERIFY_FAIL: '1' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /candidate-authority-verification-failed/);
      const observed = await calls(value);
      const reopened = observed.find(call => call.tool === 'docker' && call.args.includes('up'));
      assert.equal(reopened?.image, oldImage);
      assert.equal(operation(observed, 'cloud-restore-recovery'), undefined);
      await assert.rejects(readFile(value.fence));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('resumes the cached candidate after process death without fetching a newly requested version', async () => {
    const value = await fixture();
    try {
      const interrupted = run(value, ['--update'], { TEST_RECOVERY_CRASH: '1' });
      assert.equal(interrupted.signal, 'SIGKILL');
      // Allow the platform lock implementation to recognize the terminated owner.
      await delay(2_000);
      assert.match(await readFile(value.fence, 'utf8'), new RegExp(revision));
      const before = await calls(value);
      const result = run(value, ['--update', 'v9.9.9']);
      assert.equal(result.status, 0, result.stderr);
      const resumed = (await calls(value)).slice(before.length);
      assert.equal(resumed.some(call => call.tool === 'curl' || call.args[0] === 'pull'), false);
      assert.equal(resumed.find(call => call.args.includes('up'))?.image, newImage);
      await assert.rejects(readFile(value.fence));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('retains the recovery fence until the application is ready', async () => {
    const value = await fixture();
    try {
      const result = run(value, ['--update'], { TEST_READY_FAIL: '1' });
      assert.equal(result.status, 1);
      assert.match(await readFile(value.fence, 'utf8'), new RegExp(revision));
      assert.equal(operation(await calls(value), 'exec')?.fenced, true);
      const completed = run(value);
      assert.equal(completed.status, 0, completed.stderr);
      await assert.rejects(readFile(value.fence));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('freezes the real Compose model and retains its literal credentials, mounts, and project name', async () => {
    const value = await fixture();
    try {
      const files = [
        ['.env.example', 'CLAUDIAN_CLOUD_ENV_FILE'],
        ['.env.postgres.example', 'CLAUDIAN_CLOUD_POSTGRES_ENV_FILE'],
        ['.env.bootstrap.example', 'CLAUDIAN_CLOUD_BOOTSTRAP_ENV_FILE'],
        ['.env.migration.example', 'CLAUDIAN_CLOUD_MIGRATION_ENV_FILE'],
      ] as const;
      let overrides = '\nCOMPOSE_PROJECT_NAME=release-update-custom\n';
      for (const [template, key] of files) {
        const path = join(value.root, template);
        let content = await readFile(join(root, template), 'utf8');
        if (key === 'CLAUDIAN_CLOUD_ENV_FILE') {
          content = content.replace(/^CLAUDIAN_CLOUD_POSTGRES_URL=.*$/mu,
            "CLAUDIAN_CLOUD_POSTGRES_URL='postgresql://runtime:canary-$cash@127.0.0.1:5544/claudian_cloud'");
        }
        await writeFile(path, content);
        overrides += `${key}=${path}\n`;
      }
      const installedEnvironment = join(value.installation, 'release.env');
      await writeFile(installedEnvironment, (await readFile(installedEnvironment, 'utf8')) + overrides);
      const result = run(value, ['--update'], { TEST_REAL_COMPOSE: '1', TEST_READY_FAIL: '1' });
      assert.equal(result.status, 1, result.stderr);
      const start = (await calls(value)).find(call => call.args.includes('up'));
      assert.ok(start);
      const path = argumentAfter(start, '--file');
      const content = await readFile(path, 'utf8');
      const model = JSON.parse(content) as {
        name: string;
        services: { 'cloud-server': {
          cpus: number;
          mem_limit: number | string;
          image: string;
          environment: Record<string, string>;
          network_mode: string;
          user: string;
          volumes: readonly { source: string; target: string; type: string }[];
        }; postgres: { environment: { PGPORT: string } } };
        volumes: { 'cloud-authority': { name: string } };
      };
      assert.equal(model.name, 'release-update-custom');
      assert.equal(model.services['cloud-server'].image, newImage);
      assert.equal(model.services['cloud-server'].cpus, 2.25);
      assert.equal(String(model.services['cloud-server'].mem_limit), '1610612736');
      assert.equal(model.services['cloud-server'].environment.CLAUDIAN_CLOUD_POSTGRES_URL,
        'postgresql://runtime:canary-$$cash@127.0.0.1:5544/claudian_cloud');
      assert.equal(model.services.postgres.environment.PGPORT, '5544');
      assert.equal(model.services['cloud-server'].network_mode, 'host');
      assert.equal(model.services['cloud-server'].user, '10001:10001');
      assert.equal(model.volumes['cloud-authority'].name, 'release-update-custom_cloud-authority');
      const roundtrip = JSON.parse(execFileSync(dockerExecutable, [
        'compose', '--env-file', '/dev/null', '--file', path, '--profile', '*', 'config', '--format', 'json',
      ], { encoding: 'utf8' })) as unknown;
      assert.deepEqual(roundtrip, model);
      assert.doesNotMatch(result.stdout + result.stderr, /canary|postgresql:\/\//u);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects a changed recovery snapshot before another recovery operation', async () => {
    const value = await fixture();
    try {
      assert.equal(run(value, ['--update'], { TEST_READY_FAIL: '1' }).status, 1);
      const before = await calls(value);
      const start = before.find(call => call.args.includes('up'));
      assert.ok(start);
      const path = argumentAfter(start, '--file');
      await writeFile(path, (await readFile(path, 'utf8')) + '\n');
      const result = run(value);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /release-candidate-changed/);
      assert.deepEqual(await calls(value), before);
      assert.match(await readFile(value.fence, 'utf8'), /release-recovery-started-v1/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('runs every release maintenance command without starting dependencies', async () => {
    const value = await fixture();
    try {
      const result = run(value);
      assert.equal(result.status, 0, result.stderr);
      const maintenance = (await calls(value)).filter(call => (
        call.tool === 'docker' && call.args[0] === 'compose' && call.args.includes('run')
      ));
      assert.equal(maintenance.length, 3);
      for (const call of maintenance) assert.ok(call.args.includes('--no-deps'), call.args.join(' '));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('retries a stopped installation after a crash before the recovery fence', async () => {
    const value = await fixture();
    try {
      const interrupted = run(value, ['--update'], { TEST_VERIFY_CRASH: '1' });
      assert.equal(interrupted.signal, 'SIGKILL');
      // Allow the platform lock implementation to recognize the terminated owner.
      await delay(2_000);
      await assert.rejects(readFile(value.fence));
      assert.equal(await readFile(join(value.stateDirectory, 'server-stopped'), 'utf8'), 'stopped');
      const result = run(value);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /deployment\.ready/);
      await assert.rejects(readFile(join(value.stateDirectory, 'server-stopped')));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects a competing updater while another deployment holds the shared lock', async () => {
    const value = await fixture();
    const holder = spawn('bash', ['-c', `
      set -e
      if command -v flock >/dev/null 2>&1; then
        exec 9> "$TEST_LOCK_FILE"
        flock --exclusive --nonblock 9
      else
        shlock -f "$TEST_LOCK_FILE" -p "$$"
        trap 'rm -f "$TEST_LOCK_FILE"' EXIT
      fi
      printf 'locked\\n'
      read -r release
    `], { env: { ...process.env, TEST_LOCK_FILE: join(value.stateDirectory, 'deploy.lock') } });
    try {
      const [locked] = await once(holder.stdout, 'data') as [Buffer];
      assert.equal(locked.toString().trim(), 'locked');
      const result = run(value);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /deployment-already-running/);
      assert.deepEqual(await calls(value), []);
    } finally {
      const closed = once(holder, 'close');
      holder.stdin.end('release\n');
      await closed;
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects archive links before extraction or stopping the application', async () => {
    const value = await fixture();
    try {
      const contents = await mkdtemp(join(value.root, 'archive-contents-'));
      const archive = join(value.assets, 'claudian-cloud-server.tar.gz');
      execFileSync('tar', ['-xzf', archive, '-C', contents]);
      await symlink('/outside-the-release', join(contents, 'claudian-cloud-server/deploy/link'));
      execFileSync('tar', ['-czf', archive, '-C', contents, 'claudian-cloud-server']);
      const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
      await writeFile(`${archive}.sha256`, `${digest}  claudian-cloud-server.tar.gz\n`);
      const result = run(value);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /release-archive-invalid/);
      assert.equal(operation(await calls(value), 'pull'), undefined);
      assert.equal(operation(await calls(value), 'stop'), undefined);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });


  it('recreates a lost application container when resuming the fenced candidate', async () => {
    const value = await fixture();
    try {
      assert.equal(run(value, ['--update'], { TEST_READY_FAIL: '1' }).status, 1);
      assert.match(await readFile(value.fence, 'utf8'), /release-recovery-started-v1/);
      const before = (await calls(value)).length;
      const result = run(value, ['--update'], { TEST_MISSING_CONTAINER: '1' });
      assert.equal(result.status, 0, result.stderr);
      const resumed = (await calls(value)).slice(before);
      assert.equal(resumed.find(call => call.args.includes('up'))?.image, newImage);
      assert.match(result.stdout, /deployment\.ready/);
      await assert.rejects(readFile(value.fence));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

});
