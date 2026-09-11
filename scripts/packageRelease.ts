import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const [image, revision, output] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');

async function packageRelease() {
  if (typeof image !== 'string'
    || !/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(image)
    || typeof revision !== 'string' || !/^[a-f0-9]{40}$/u.test(revision) || !output) {
    process.stderr.write('release.error: invalid-input\n');
    process.exitCode = 1;
    return;
  }
  await mkdir(output);
  const temporary = await mkdtemp(join(tmpdir(), 'claudian-release-'));
  try {
    const bundle = join(temporary, 'claudian-cloud-server');
    await mkdir(join(bundle, 'deploy'), { recursive: true });
    for (const path of [
      'README.md', 'LICENSE', '.env.example',
      'deploy/README.md', 'deploy/compose.yaml', 'deploy/bootstrap-postgres.sh',
      'deploy/configure.sh', 'deploy/initializeConfig.ts',
      'deploy/deploy.sh', 'deploy/release-update.sh',
    ]) {
      await copyFile(join(root, path), join(bundle, path));
    }
    await writeFile(join(bundle, 'release.env'), `CLAUDIAN_CLOUD_IMAGE=${image}\n`);
    await writeFile(join(bundle, 'revision.txt'), `${revision}\n`);
    const archive = resolve(output, 'claudian-cloud-server.tar.gz');
    await promisify(execFile)('tar', ['-czf', archive, '-C', temporary, 'claudian-cloud-server']);
    const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(`${archive}.sha256`, `${checksum}  claudian-cloud-server.tar.gz\n`);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

packageRelease().catch(() => {
  process.stderr.write('release.error: packaging-failed\n');
  process.exitCode = 1;
});
