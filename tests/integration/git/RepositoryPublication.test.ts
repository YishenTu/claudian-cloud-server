import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ValidatedBootstrapRepository } from '../../../src/repositories/GitBundleImporter.js';
import {
  BootstrapRepositoryIntegrityError,
  type BootstrapRepositoryIntegrityPort,
} from '../../../src/repositories/BootstrapRepositoryIntegrityVerifier.js';
import {
  RepositoryPublication,
  RepositoryPublicationError,
} from '../../../src/repositories/RepositoryPublication.js';

interface PublicationFixture {
  readonly attempt: string;
  readonly authorityRoot: string;
  readonly repository: ValidatedBootstrapRepository;
  readonly repositoryRoot: string;
  readonly stagedRepository: string;
  readonly stagingRoot: string;
}

function artifactKey(projectId: string, attemptId: string): string {
  return createHash('sha256').update(`${projectId}\0${attemptId}`, 'utf8').digest('hex');
}

async function createFixture(suffix: string): Promise<PublicationFixture> {
  const authorityRoot = await mkdtemp(join(tmpdir(), `claudian-publication-${suffix}-`));
  const repositoryRoot = join(authorityRoot, 'repositories');
  const stagingRoot = join(authorityRoot, 'staging');
  const projectId = `project-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const attempt = join(
    stagingRoot,
    Buffer.from(projectId).toString('hex'),
    Buffer.from(attemptId).toString('hex'),
  );
  const stagedRepository = join(attempt, 'repository');
  await Promise.all([
    mkdir(repositoryRoot),
    mkdir(stagedRepository, { recursive: true }),
  ]);
  const validation = `${JSON.stringify({
    exact: `validation-${suffix}`,
    schemaVersion: 1,
  })}\n`;
  const markerSha256 = createHash('sha256').update(validation).digest('hex');
  await writeFile(
    join(attempt, '.claudian-cloud-attempt.json'),
    `${JSON.stringify({
      artifactKey: artifactKey(projectId, attemptId),
      attemptId,
      projectId,
      schemaVersion: 1,
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(stagedRepository, '.claudian-cloud-validation.json'),
    validation,
    { mode: 0o600 },
  );
  const oid = 'a'.repeat(40);
  return {
    attempt,
    authorityRoot,
    repository: Object.freeze({
      artifactKey: artifactKey(projectId, attemptId),
      attemptId,
      bundleByteCount: 1024,
      bundleSha256: 'b'.repeat(64),
      markerSha256,
      objectFormat: 'sha1',
      projectId,
      refs: Object.freeze([{
        name: 'refs/heads/main',
        oid,
      }, {
        name: `refs/heads/members/member-${suffix}-a`,
        oid,
      }, {
        name: `refs/heads/members/member-${suffix}-b`,
        oid,
      }]),
    }),
    repositoryRoot,
    stagedRepository,
    stagingRoot,
  };
}

async function expectPublicationError(
  operation: Promise<unknown>,
  code: RepositoryPublicationError['code'],
  forbidden: readonly string[] = [],
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof RepositoryPublicationError);
    assert.equal(error.code, code);
    for (const value of forbidden) {
      assert.equal(JSON.stringify(error).includes(value), false);
    }
    return true;
  });
}

function publication(
  fixture: PublicationFixture,
  integrityVerifier: BootstrapRepositoryIntegrityPort = {
    verify: () => Promise.resolve(),
  },
  syncDirectory?: (path: string) => Promise<void>,
): RepositoryPublication {
  return new RepositoryPublication({
    integrityVerifier,
    repositoryRoot: fixture.repositoryRoot,
    ...(syncDirectory === undefined ? {} : { syncDirectory }),
    stagingRoot: fixture.stagingRoot,
    storageNodeId: 'node-a',
  });
}

describe('RepositoryPublication', () => {
  it('rejects a marker-exact repository when live Git integrity changes', async () => {
    const fixture = await createFixture('live-integrity');
    let valid = true;
    const owner = publication(fixture, {
      verify: () => valid
        ? Promise.resolve()
        : Promise.reject(new BootstrapRepositoryIntegrityError(
          'repository-invalid',
        )),
    });
    try {
      const prepared = await owner.prepare({
        generation: 1,
        repository: fixture.repository,
        repositoryStorageKey: 'storage_live_integrity',
      });
      valid = false;
      await expectPublicationError(
        owner.inspect(prepared),
        'repository-invalid',
        [fixture.authorityRoot],
      );
    } finally {
      owner.close();
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('prepares one exact marker and atomically publishes with replay', async () => {
    const fixture = await createFixture('happy');
    const owner = publication(fixture);
    try {
      const input = {
        generation: 1,
        repository: fixture.repository,
        repositoryStorageKey: 'storage_happy',
      } as const;
      const plan = owner.plan(input);
      await assert.rejects(stat(join(
        fixture.stagedRepository,
        '.claudian-cloud-publication.json',
      )), { code: 'ENOENT' });
      const prepared = await owner.prepare(input);
      assert.deepEqual(prepared, plan);
      assert.deepEqual(await owner.inspect(prepared), { state: 'staged' });
      assert.equal(Object.isFrozen(prepared), true);
      assert.equal(JSON.stringify(prepared).includes(fixture.authorityRoot), false);
      const marker = join(
        fixture.stagedRepository,
        '.claudian-cloud-publication.json',
      );
      assert.equal((await stat(marker)).mode & 0o777, 0o600);
      assert.equal(
        createHash('sha256').update(await readFile(marker)).digest('hex'),
        prepared.publicationMarkerSha256,
      );

      const published = await owner.publish(prepared);
      assert.equal(published.status, 'published');
      assert.deepEqual(await owner.inspect(prepared), { state: 'published' });
      const replayPrepared = await owner.prepare({
        generation: 1,
        repository: fixture.repository,
        repositoryStorageKey: 'storage_happy',
      });
      assert.deepEqual(replayPrepared, prepared);
      assert.equal((await owner.publish(prepared)).status, 'replayed');

      assert.equal(await owner.cleanupAttempt(prepared), 'cleaned');
      assert.equal(await owner.cleanupAttempt(prepared), 'replayed');
      assert.deepEqual(await owner.inspect(prepared), { state: 'published' });
      await assert.rejects(stat(fixture.attempt), { code: 'ENOENT' });
    } finally {
      owner.close();
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('durably establishes the canonical Project directory before publication', async () => {
    const fixture = await createFixture('project-directory-sync');
    const syncedDirectories: string[] = [];
    const owner = publication(
      fixture,
      { verify: () => Promise.resolve() },
      path => {
        syncedDirectories.push(path);
        return Promise.resolve();
      },
    );
    try {
      const prepared = await owner.prepare({
        generation: 1,
        repository: fixture.repository,
        repositoryStorageKey: 'storage_project_directory_sync',
      });
      syncedDirectories.length = 0;

      await owner.publish(prepared);

      assert.equal(syncedDirectories.includes(fixture.repositoryRoot), true);
    } finally {
      owner.close();
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

  it('rejects an authority root replaced after preparation', async () => {
    const fixture = await createFixture('root');
    const owner = publication(fixture);
    const replaced = `${fixture.stagingRoot}-replaced`;
    try {
      const prepared = await owner.prepare({
        generation: 1,
        repository: fixture.repository,
        repositoryStorageKey: 'storage_root',
      });
      await rename(fixture.stagingRoot, replaced);
      await mkdir(fixture.stagingRoot);
      await expectPublicationError(
        owner.inspect(prepared),
        'storage-unavailable',
        [fixture.authorityRoot],
      );
    } finally {
      owner.close();
      await rm(fixture.authorityRoot, { force: true, recursive: true });
      await rm(replaced, { force: true, recursive: true });
    }
  });

  it('fails closed for both, neither, and changed marker observations', async () => {
    const both = await createFixture('both');
    const bothOwner = publication(both);
    try {
      const prepared = await bothOwner.prepare({
        generation: 1,
        repository: both.repository,
        repositoryStorageKey: 'storage_both',
      });
      const target = join(
        both.repositoryRoot,
        Buffer.from('project-both').toString('hex'),
        'storage_both',
      );
      await mkdir(join(
        both.repositoryRoot,
        Buffer.from('project-both').toString('hex'),
      ));
      await cp(both.stagedRepository, target, { recursive: true });
      await expectPublicationError(
        bothOwner.inspect(prepared),
        'ambiguous-state',
        [both.authorityRoot],
      );
    } finally {
      bothOwner.close();
      await rm(both.authorityRoot, { force: true, recursive: true });
    }

    const missing = await createFixture('missing');
    const missingOwner = publication(missing);
    try {
      const prepared = await missingOwner.prepare({
        generation: 1,
        repository: missing.repository,
        repositoryStorageKey: 'storage_missing',
      });
      await rm(missing.stagedRepository, { recursive: true });
      await expectPublicationError(
        missingOwner.inspect(prepared),
        'missing-state',
        [missing.authorityRoot],
      );
    } finally {
      missingOwner.close();
      await rm(missing.authorityRoot, { force: true, recursive: true });
    }

    const changed = await createFixture('changed');
    const changedOwner = publication(changed);
    try {
      const prepared = await changedOwner.prepare({
        generation: 1,
        repository: changed.repository,
        repositoryStorageKey: 'storage_changed',
      });
      await writeFile(
        join(changed.stagedRepository, '.claudian-cloud-publication.json'),
        'private-marker-sentinel',
      );
      await expectPublicationError(
        changedOwner.inspect(prepared),
        'marker-conflict',
        [changed.authorityRoot, 'private-marker-sentinel'],
      );
    } finally {
      changedOwner.close();
      await rm(changed.authorityRoot, { force: true, recursive: true });
    }
  });

  it('recovers a stale publication-marker partial without accepting a symlink', async () => {
    const fixture = await createFixture('partial');
    const owner = publication(fixture);
    const partial = join(
      fixture.stagedRepository,
      '..claudian-cloud-publication.json.part',
    );
    try {
      await writeFile(partial, 'interrupted-marker');
      const prepared = await owner.prepare({
        generation: 1,
        repository: fixture.repository,
        repositoryStorageKey: 'storage_partial',
      });
      assert.deepEqual(await owner.inspect(prepared), { state: 'staged' });

      await rm(join(fixture.stagedRepository, '.claudian-cloud-publication.json'));
      await symlink(
        join(fixture.stagedRepository, '.claudian-cloud-validation.json'),
        partial,
      );
      await expectPublicationError(
        owner.prepare({
          generation: 1,
          repository: fixture.repository,
          repositoryStorageKey: 'storage_partial',
        }),
        'marker-conflict',
        [fixture.authorityRoot],
      );
    } finally {
      owner.close();
      await rm(fixture.authorityRoot, { force: true, recursive: true });
    }
  });

});
