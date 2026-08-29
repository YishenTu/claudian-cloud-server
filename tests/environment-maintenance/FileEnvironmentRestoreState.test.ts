import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  EnvironmentRestoreCoordinatorError,
  encodeEnvironmentRestoreJournal,
  type EnvironmentRestoreJournal,
  type EnvironmentRestoreRepositoryPublication,
} from '../../src/environment-maintenance/restore/EnvironmentRestoreCoordinator.js';
import { FileEnvironmentRestoreState } from '../../src/environment-maintenance/restore/FileEnvironmentRestoreState.js';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CATALOG_SHA = 'c'.repeat(64);
const TARGET_VOLUME_ID = 'd'.repeat(32);

function journal(
  phase: EnvironmentRestoreJournal['phase'],
  repositories?: readonly EnvironmentRestoreRepositoryPublication[],
): EnvironmentRestoreJournal {
  const phaseIndex = [
    'validated',
    'database-created',
    'coordination-imported',
    'repositories-staged',
    'pair-prepared',
    'repositories-published',
    'authority-published',
    'verified',
    'completed',
  ].indexOf(phase);
  return Object.freeze({
    authorityId: 'cloud-authority-a',
    authorityVolumeId: TARGET_VOLUME_ID,
    authorityVolumeIdentity: 'authority-volume-restored',
    catalogId: 'backup-catalog-a',
    catalogSha256: CATALOG_SHA,
    coordinationSchemaVersion: 9,
    createdAt: '2026-08-29T00:00:00.000Z',
    ...(phaseIndex >= 1 ? { databaseIdentity: TARGET_VOLUME_ID } : {}),
    maximumServerBuild: 'cloud-build-a',
    minimumServerBuild: 'cloud-build-a',
    operationId: 'restore-operation-a',
    phase,
    projects: Object.freeze([Object.freeze({
      authorityGeneration: 4,
      backupId: 'backup-project-a',
      checkpointSha256: 'a'.repeat(64),
      expiresAt: '2026-09-29T00:00:00.000Z',
      placementGeneration: 7,
      projectId: PROJECT,
    })]),
    ...(phaseIndex < 3
      ? {}
      : { repositories: repositories ?? repositoryPublications() }),
    repositoryFormatVersion: 1,
    restoreEpoch: 4,
    schemaVersion: 1,
    terminalProjects: Object.freeze([]),
    updatedAt: '2026-08-29T00:00:00.000Z',
  });
}

function repositoryPublications(): readonly EnvironmentRestoreRepositoryPublication[] {
  return Object.freeze([Object.freeze({
    artifactKey: '1'.repeat(64),
    bundleByteCount: 101,
    bundleSha256: '2'.repeat(64),
    objectFormat: 'sha256',
    operationId: 'restore-operation-a',
    placementGeneration: 8,
    projectId: PROJECT,
    publicationMarkerSha256: 'e'.repeat(64),
    refs: Object.freeze([
      Object.freeze({ name: 'refs/heads/main', oid: 'a'.repeat(64) }),
      Object.freeze({
        name: 'refs/heads/members/member-manager',
        oid: 'a'.repeat(64),
      }),
    ]),
    repositoryStorageKey: 'restore-project-a',
    status: 'inactive',
    storageNodeId: 'local',
    validationMarkerSha256: '3'.repeat(64),
  })]);
}

describe('FileEnvironmentRestoreState', () => {
  it('inspects settled metadata without creating or recovering private state', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    const lock = join(authorityRoot, '.environment-restore-state.lock');
    const marker = join(authorityRoot, '.authority-volume-id');
    const journalPath = join(authorityRoot, '.environment-restore-journal.json');
    try {
      await writeFile(
        journalPath,
        encodeEnvironmentRestoreJournal(journal('completed')),
        { mode: 0o600 },
      );
      await writeFile(marker, `${TARGET_VOLUME_ID}\n`, { mode: 0o600 });

      assert.deepEqual(
        await new FileEnvironmentRestoreState({ authorityRoot })
          .inspectSettled(),
        {
          journal: journal('completed'),
          pair: { authorityVolumeId: TARGET_VOLUME_ID },
        },
      );
      await assert.rejects(lstat(lock), { code: 'ENOENT' });
      assert.equal(
        await readFile(journalPath, 'utf8'),
        encodeEnvironmentRestoreJournal(journal('completed')),
      );
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('rejects a filesystem root as the authority target', () => {
    assert.throws(
      () => new FileEnvironmentRestoreState({ authorityRoot: '/' }),
      /environment-restore-state\.options-invalid/u,
    );
  });

  it('fails closed for an unsafe lock inode and retains the fixed inode', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    const lock = join(authorityRoot, '.environment-restore-state.lock');
    try {
      await writeFile(lock, '', { mode: 0o640 });
      await assert.rejects(
        new FileEnvironmentRestoreState({ authorityRoot }).create(
          journal('validated'),
        ),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'recovery-required');
          return true;
        },
      );
      await chmod(lock, 0o600);
      const before = await lstat(lock, { bigint: true });
      assert.equal(
        (await new FileEnvironmentRestoreState({ authorityRoot }).create(
          journal('validated'),
        )).phase,
        'validated',
      );
      const after = await lstat(lock, { bigint: true });
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino);
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('maps an already-aborted operation to one sanitized error code', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    const controller = new AbortController();
    controller.abort('private-reason');
    try {
      await assert.rejects(
        new FileEnvironmentRestoreState({ authorityRoot }).runExclusive(
          () => Promise.resolve(),
          controller.signal,
        ),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'cancelled');
          return true;
        },
      );
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('does not enter an operation cancelled while its kernel lock is acquired', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    const controller = new AbortController();
    let entered = false;
    try {
      const pending = new FileEnvironmentRestoreState({ authorityRoot })
        .runExclusive(() => {
          entered = true;
          return Promise.resolve();
        }, controller.signal);
      controller.abort('private-reason');
      await assert.rejects(
        pending,
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'cancelled');
          return true;
        },
      );
      assert.equal(entered, false);
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('holds one operation lease across external dependency work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-restore-operation-lock-'));
    const authorityRoot = join(root, 'authority');
    await mkdir(authorityRoot, { mode: 0o700 });
    let enter = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const owner = new FileEnvironmentRestoreState({ authorityRoot });
      const contender = new FileEnvironmentRestoreState({ authorityRoot });
      const held = owner.runExclusive(async () => {
        enter();
        await gate;
      });
      await entered;
      await assert.rejects(
        contender.runExclusive(() => Promise.resolve()),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'recovery-required');
          return true;
        },
      );
      release();
      await held;
      await contender.runExclusive(() => Promise.resolve());
    } finally {
      release();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('does not reclaim a live owner whose event loop is paused', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'claudian-restore-live-lock-'));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        [
          "const { FileEnvironmentRestoreState } = await import('./src/environment-maintenance/restore/FileEnvironmentRestoreState.js');",
          'const state = new FileEnvironmentRestoreState({ authorityRoot: process.argv[1] });',
          'await state.runExclusive(async () => {',
          "  process.stdout.write('locked\\n');",
          '  const until = Date.now() + 4_000;',
          '  while (Date.now() < until) {}',
          '});',
        ].join('\n'),
        authorityRoot,
      ],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      const output = await new Promise<string>(resolve => {
        child.stdout.once('data', (chunk: Buffer) => {
          resolve(chunk.toString('utf8'));
        });
      });
      assert.match(output, /locked/u);
      await new Promise(resolve => setTimeout(resolve, 2_500));
      await assert.rejects(
        new FileEnvironmentRestoreState({ authorityRoot }).runExclusive(
          () => Promise.resolve(),
        ),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'recovery-required');
          return true;
        },
      );
      const code = await new Promise<number | null>(resolve => {
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
      await new FileEnvironmentRestoreState({ authorityRoot }).runExclusive(
        () => Promise.resolve(),
      );
    } finally {
      child.kill('SIGKILL');
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('reclaims the exact operation lock after its process is killed', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'claudian-restore-dead-lock-'));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        [
          "const { FileEnvironmentRestoreState } = await import('./src/environment-maintenance/restore/FileEnvironmentRestoreState.js');",
          'const state = new FileEnvironmentRestoreState({ authorityRoot: process.argv[1] });',
          'await state.runExclusive(async () => {',
          "  process.stdout.write('locked\\n');",
          '  await new Promise(() => undefined);',
          '});',
        ].join('\n'),
        authorityRoot,
      ],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      const output = await new Promise<string>(resolve => {
        child.stdout.once('data', (chunk: Buffer) => {
          resolve(chunk.toString('utf8'));
        });
      });
      assert.match(output, /locked/u);
      child.kill('SIGKILL');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
      await new FileEnvironmentRestoreState({ authorityRoot }).runExclusive(
        () => Promise.resolve(),
      );
    } finally {
      child.kill('SIGKILL');
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('rejects an oversized journal before changing durable state', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    const projects = Object.freeze(Array.from({ length: 12_000 }, (_, index) => {
      const suffix = index.toString(16).padStart(12, '0');
      return Object.freeze({
        authorityGeneration: 1,
        backupId: `backup-${suffix}`,
        checkpointSha256: 'a'.repeat(64),
        expiresAt: '2026-09-29T00:00:00.000Z',
        placementGeneration: 1,
        projectId: `00000000-0000-4000-8000-${suffix}`,
      });
    }));
    const oversized = Object.freeze({
      ...journal('validated'),
      projects,
    });
    assert.ok(
      Buffer.byteLength(encodeEnvironmentRestoreJournal(oversized), 'utf8')
        > 2 * 1024 * 1024,
    );
    try {
      const state = new FileEnvironmentRestoreState({ authorityRoot });
      await assert.rejects(
        state.create(oversized),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'recovery-required');
          return true;
        },
      );
      assert.deepEqual(await state.inspect(), {
        journal: undefined,
        pair: 'absent',
      });
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('fails closed for widened journal permissions and a symlink pair marker', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    const journalPath = join(authorityRoot, '.environment-restore-journal.json');
    const marker = join(authorityRoot, '.authority-volume-id');
    const foreign = join(authorityRoot, 'foreign-marker');
    const recoveryRequired = (error: unknown): boolean => {
      assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
      assert.equal(error.code, 'recovery-required');
      return true;
    };
    try {
      const state = new FileEnvironmentRestoreState({ authorityRoot });
      await state.create(journal('validated'));
      await chmod(journalPath, 0o640);
      await assert.rejects(state.inspect(), recoveryRequired);
      await chmod(journalPath, 0o600);

      await writeFile(foreign, `${TARGET_VOLUME_ID}\n`, { mode: 0o600 });
      await symlink(foreign, marker);
      await assert.rejects(state.inspect(), recoveryRequired);
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('recognizes an original bootstrap authority marker without a newline', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    try {
      await writeFile(
        join(authorityRoot, '.authority-volume-id'),
        TARGET_VOLUME_ID,
        { mode: 0o600 },
      );
      assert.deepEqual(
        await new FileEnvironmentRestoreState({ authorityRoot }).inspect(),
        {
          journal: undefined,
          pair: { authorityVolumeId: TARGET_VOLUME_ID },
        },
      );
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('rejects a journal part that changes immutable restore identity', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    try {
      const state = new FileEnvironmentRestoreState({ authorityRoot });
      const current = await state.create(journal('validated'));
      await writeFile(
        join(authorityRoot, '.environment-restore-journal.json.part'),
        encodeEnvironmentRestoreJournal({
          ...current,
          authorityId: 'foreign-authority',
        }),
        { mode: 0o600 },
      );
      await assert.rejects(
        state.inspect(),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'recovery-required');
          return true;
        },
      );
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('rejects a late-phase journal part without its current journal', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    try {
      await writeFile(
        join(authorityRoot, '.environment-restore-journal.json.part'),
        encodeEnvironmentRestoreJournal(journal('repositories-staged')),
        { mode: 0o600 },
      );
      await assert.rejects(
        new FileEnvironmentRestoreState({ authorityRoot }).inspect(),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'recovery-required');
          return true;
        },
      );
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('durably converts cleanup into a forward authority fence', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    try {
      const state = new FileEnvironmentRestoreState({ authorityRoot });
      let current = await state.create(journal('validated'));
      current = await state.advance({
        expectedPhase: 'validated',
        next: journal('database-created'),
      });
      current = await state.advance({
        expectedPhase: 'database-created',
        next: journal('coordination-imported'),
      });
      current = await state.advance({
        expectedPhase: 'coordination-imported',
        next: journal('repositories-staged'),
      });
      current = await state.preparePair({
        authorityVolumeId: TARGET_VOLUME_ID,
        expectedPhase: 'repositories-staged',
        next: journal('pair-prepared'),
      });
      current = await state.advance({
        expectedPhase: 'pair-prepared',
        next: journal('repositories-published'),
      });
      current = await state.requestCleanup({
        expectedPhase: 'repositories-published',
        next: Object.freeze({
          ...current,
          cleanupRequestedAt: '2026-08-29T00:00:00.000Z',
        }),
      });
      const withoutCleanup = { ...current };
      Reflect.deleteProperty(withoutCleanup, 'cleanupRequestedAt');
      const published = await state.recoverPublishedAuthority({
        expectedPhase: 'repositories-published',
        next: Object.freeze({
          ...withoutCleanup,
          phase: 'authority-published',
        }),
      });

      assert.equal(published.phase, 'authority-published');
      assert.equal(published.cleanupRequestedAt, undefined);
      assert.equal((await state.inspect()).journal?.phase, 'authority-published');
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('finishes exact cleanup after the marker removal loses its process', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    const marker = join(authorityRoot, '.authority-volume-id');
    let failAfterMarkerRemoval = true;
    try {
      const state = new FileEnvironmentRestoreState({
        authorityRoot,
        removeFile: async path => {
          await rm(path, { force: true });
          if (path === marker && failAfterMarkerRemoval) {
            failAfterMarkerRemoval = false;
            throw new Error('simulated-process-exit-after-marker-removal');
          }
        },
      });
      await state.create(journal('validated'));
      await state.advance({
        expectedPhase: 'validated',
        next: journal('database-created'),
      });
      await state.advance({
        expectedPhase: 'database-created',
        next: journal('coordination-imported'),
      });
      await state.advance({
        expectedPhase: 'coordination-imported',
        next: journal('repositories-staged'),
      });
      let current = await state.preparePair({
        authorityVolumeId: TARGET_VOLUME_ID,
        expectedPhase: 'repositories-staged',
        next: journal('pair-prepared'),
      });
      current = await state.requestCleanup({
        expectedPhase: 'pair-prepared',
        next: Object.freeze({
          ...current,
          cleanupRequestedAt: '2026-08-29T00:00:00.000Z',
        }),
      });
      await assert.rejects(
        state.remove({
          expectedCatalogSha256: CATALOG_SHA,
          operationId: 'restore-operation-a',
          phase: current.phase,
        }),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'recovery-required');
          return true;
        },
      );
      await assert.rejects(lstat(marker), { code: 'ENOENT' });
      assert.equal(
        (await lstat(
          join(authorityRoot, '.environment-restore-removal.json'),
        )).isFile(),
        true,
      );

      assert.deepEqual(
        await new FileEnvironmentRestoreState({ authorityRoot }).inspect(),
        { journal: undefined, pair: 'absent' },
      );
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('durably pairs the private journal and marker and removes only owned state', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    const marker = join(authorityRoot, '.authority-volume-id');
    const markerPart = `${marker}.part`;
    const journalPath = join(authorityRoot, '.environment-restore-journal.json');
    const unrelated = join(authorityRoot, 'operator-note');
    try {
      await writeFile(unrelated, 'preserve\n', { mode: 0o600 });
      const state = new FileEnvironmentRestoreState({ authorityRoot });
      assert.deepEqual(await state.inspect(), {
        journal: undefined,
        pair: 'absent',
      });

      let current = await state.create(journal('validated'));
      assert.equal(current.phase, 'validated');
      assert.equal(Number((await lstat(journalPath, { bigint: true })).mode & 0o777n), 0o600);

      current = await state.advance({
        expectedPhase: 'validated',
        next: journal('database-created'),
      });
      current = await state.advance({
        expectedPhase: 'database-created',
        next: journal('coordination-imported'),
      });
      const repositories = repositoryPublications();
      current = await state.advance({
        expectedPhase: 'coordination-imported',
        next: journal('repositories-staged', repositories),
      });

      await writeFile(markerPart, `${TARGET_VOLUME_ID}\n`, { mode: 0o600 });
      assert.deepEqual((await state.inspect()).pair, {
        authorityVolumeId: TARGET_VOLUME_ID,
      });
      current = await state.preparePair({
        authorityVolumeId: TARGET_VOLUME_ID,
        expectedPhase: 'repositories-staged',
        next: journal('pair-prepared', repositories),
      });
      assert.equal(current.phase, 'pair-prepared');
      assert.equal(await readFile(marker, 'utf8'), `${TARGET_VOLUME_ID}\n`);
      assert.equal(Number((await lstat(marker, { bigint: true })).mode & 0o777n), 0o600);
      await assert.rejects(lstat(markerPart), { code: 'ENOENT' });

      current = await state.requestCleanup({
        expectedPhase: 'pair-prepared',
        next: Object.freeze({
          ...current,
          cleanupRequestedAt: '2026-08-29T00:00:00.000Z',
        }),
      });
      assert.equal(await state.remove({
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
        phase: 'pair-prepared',
      }), 'removed');
      assert.equal(await readFile(unrelated, 'utf8'), 'preserve\n');
      assert.deepEqual(await state.inspect(), {
        journal: undefined,
        pair: 'absent',
      });
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });

  it('reports a foreign pair-marker part as ambiguous without exposing its value', async () => {
    const authorityRoot = await mkdtemp(join(tmpdir(), 'cloud-restore-state-'));
    try {
      const state = new FileEnvironmentRestoreState({ authorityRoot });
      await state.create(journal('repositories-staged'));
      await writeFile(
        join(authorityRoot, '.authority-volume-id.part'),
        `${'e'.repeat(32)}\n`,
        { mode: 0o600 },
      );
      assert.equal((await state.inspect()).pair, 'ambiguous');
    } finally {
      await rm(authorityRoot, { force: true, recursive: true });
    }
  });
});
