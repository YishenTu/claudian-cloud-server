import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

interface PackageManifest {
  readonly scripts: Readonly<Record<string, string>>;
}

const repositoryRoot = resolve(import.meta.dirname, '../..');

describe('foundation verification lanes', () => {
  it('keeps fast, PostgreSQL, Git, and deployment evidence explicit', async () => {
    const packageManifest = JSON.parse(await readFile(
      resolve(repositoryRoot, 'package.json'),
      'utf8',
    )) as PackageManifest;

    assert.equal(
      packageManifest.scripts.verify,
      'npm run verify:fast && npm run verify:postgres && npm run verify:git',
    );
    assert.equal(packageManifest.scripts['verify:postgres'], 'npm run test:postgres');
    assert.equal(packageManifest.scripts['verify:git'], 'npm run test:git');
    assert.match(
      packageManifest.scripts['verify:fast'] ?? '',
      /test:contract.*test:application.*test:deployment.*build/,
    );
    assert.match(
      packageManifest.scripts['verify:deployment'] ?? '',
      /docker build.*--build-arg CLAUDIAN_SERVER_BUILD=[0-9a-f]{40}.*verify-runtime-image/,
    );
  });

  it('runs the lanes separately with a pinned PostgreSQL 18 service', async () => {
    const workflow = await readFile(
      resolve(repositoryRoot, '.github/workflows/ci.yml'),
      'utf8',
    );

    assert.match(workflow, /^ {2}fast:\n/m);
    assert.match(workflow, /^ {2}postgres:\n/m);
    assert.match(workflow, /^ {2}git:\n/m);
    assert.match(workflow, /^ {2}deployment:\n/m);
    assert.match(
      workflow,
      /postgres@sha256:7d2695c3aa88e792e8b3b233e7e4adb296a20412c6c0ca361e3edaaacfada108/,
    );
    assert.match(workflow, /CLAUDIAN_TEST_POSTGRES_ADMIN_URL/);
    assert.match(workflow, /CLAUDIAN_TEST_POSTGRES_MIGRATION_URL/);
    assert.match(workflow, /CLAUDIAN_TEST_POSTGRES_RUNTIME_URL/);
    assert.doesNotMatch(workflow, /^ {2}verify:\n/m);
  });
});
