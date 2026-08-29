/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/require-await */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ENVIRONMENT_RESTORE_PHASES,
  EnvironmentRestoreCoordinator,
  EnvironmentRestoreCoordinatorError,
  decodeEnvironmentRestoreJournal,
  type EnvironmentRestoreCatalog,
  type EnvironmentRestoreCoordinatorOptions,
  type EnvironmentRestoreJournal,
  type EnvironmentRestorePhase,
  type EnvironmentRestoreRepositoryPublication,
} from '../../src/environment-maintenance/restore/EnvironmentRestoreCoordinator.js';
import { EnvironmentBackupCatalogVerifier } from '../../src/environment-maintenance/restore/EnvironmentBackupCatalog.js';

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const CATALOG_SHA = 'c'.repeat(64);
const TARGET_VOLUME_ID = 'd'.repeat(32);

function runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
  return operation();
}

function catalog(): EnvironmentRestoreCatalog {
  return Object.freeze({
    authorityId: 'cloud-authority-a',
    authorityVolumeIdentity: 'authority-volume-a',
    catalogId: 'backup-catalog-a',
    catalogSha256: CATALOG_SHA,
    coordinationSchemaVersion: 9,
    createdAt: '2026-08-29T00:00:00.000Z',
    maximumServerBuild: 'cloud-build-a',
    minimumServerBuild: 'cloud-build-a',
    projects: Object.freeze([
      Object.freeze({
        authorityGeneration: 4,
        backupId: 'backup-project-a',
        checkpointSha256: SHA_A,
        expiresAt: '2026-09-29T00:00:00.000Z',
        placementGeneration: 7,
        projectId: PROJECT_A,
      }),
      Object.freeze({
        authorityGeneration: 2,
        backupId: 'backup-project-b',
        checkpointSha256: SHA_B,
        expiresAt: '2026-09-29T00:00:00.000Z',
        placementGeneration: 3,
        projectId: PROJECT_B,
      }),
    ]),
    repositoryFormatVersion: 1,
    restoreEpoch: 3,
  });
}

function repositoryPublications(): readonly EnvironmentRestoreRepositoryPublication[] {
  return Object.freeze([
    Object.freeze({
      artifactKey: '1'.repeat(64),
      bundleByteCount: 101,
      bundleSha256: '2'.repeat(64),
      objectFormat: 'sha256',
      operationId: 'restore-operation-a',
      placementGeneration: 8,
      projectId: PROJECT_A,
      publicationMarkerSha256: 'e'.repeat(64),
      refs: Object.freeze([
        Object.freeze({ name: 'refs/heads/main', oid: SHA_A }),
        Object.freeze({
          name: 'refs/heads/members/member-manager',
          oid: SHA_A,
        }),
      ]),
      repositoryStorageKey: 'restore-project-a',
      status: 'inactive',
      storageNodeId: 'local',
      validationMarkerSha256: '3'.repeat(64),
    }),
    Object.freeze({
      artifactKey: '4'.repeat(64),
      bundleByteCount: 202,
      bundleSha256: '5'.repeat(64),
      objectFormat: 'sha256',
      operationId: 'restore-operation-a',
      placementGeneration: 4,
      projectId: PROJECT_B,
      publicationMarkerSha256: 'f'.repeat(64),
      refs: Object.freeze([
        Object.freeze({ name: 'refs/heads/main', oid: SHA_B }),
        Object.freeze({
          name: 'refs/heads/members/member-manager',
          oid: SHA_B,
        }),
      ]),
      repositoryStorageKey: 'restore-project-b',
      status: 'inactive',
      storageNodeId: 'local',
      validationMarkerSha256: '6'.repeat(64),
    }),
  ]);
}

function journalAt(phase: EnvironmentRestorePhase): EnvironmentRestoreJournal {
  const phaseIndex = ENVIRONMENT_RESTORE_PHASES.indexOf(phase);
  return Object.freeze({
    authorityId: 'cloud-authority-a',
    authorityVolumeId: TARGET_VOLUME_ID,
    authorityVolumeIdentity: 'authority-volume-restored',
    catalogId: 'backup-catalog-a',
    catalogSha256: CATALOG_SHA,
    coordinationSchemaVersion: 9,
    createdAt: '2026-08-29T00:00:00.000Z',
    ...(phaseIndex >= ENVIRONMENT_RESTORE_PHASES.indexOf('database-created')
      ? { databaseIdentity: TARGET_VOLUME_ID }
      : {}),
    maximumServerBuild: 'cloud-build-a',
    minimumServerBuild: 'cloud-build-a',
    operationId: 'restore-operation-a',
    phase,
    projects: catalog().projects,
    ...(phaseIndex >= ENVIRONMENT_RESTORE_PHASES.indexOf('repositories-staged')
      ? { repositories: repositoryPublications() }
      : {}),
    repositoryFormatVersion: 1,
    restoreEpoch: 4,
    schemaVersion: 1,
    updatedAt: '2026-08-29T00:00:00.000Z',
  });
}

function unreachableOptions(input: Readonly<{
  readonly backup: EnvironmentRestoreCoordinatorOptions['backup'];
  readonly inspect: EnvironmentRestoreCoordinatorOptions['state']['inspect'];
}>): EnvironmentRestoreCoordinatorOptions {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected');
  };
  return {
    backup: input.backup,
    continuity: {
      verifyBeforeCreation: unexpected,
      verifyRestored: unexpected,
    },
    coordination: {
      assertEmpty: unexpected,
      classifyOrRemoveRestoreOwnedDatabase: unexpected,
      createDatabase: unexpected,
      importCoordination: unexpected,
      publishAuthority: unexpected,
      verifyDatabaseIdentity: unexpected,
      verifyRestored: unexpected,
    },
    repositories: {
      assertEmpty: unexpected,
      publish: unexpected,
      removeRestoreOwned: unexpected,
      removeRestoreStaging: unexpected,
      stage: unexpected,
      verifyRestored: unexpected,
    },
    state: {
      runExclusive,
      advance: unexpected,
      create: unexpected,
      inspect: input.inspect,
      preparePair: unexpected,
      recoverPublishedAuthority: unexpected,
      remove: unexpected,
      requestCleanup: unexpected,
    },
  };
}

describe('EnvironmentRestoreCoordinator', () => {
  it('maps malformed persisted journal values to a sanitized state conflict', () => {
    for (const malformed of [
      {
        ...journalAt('validated'),
        minimumServerBuild: 1,
      },
      {
        ...journalAt('repositories-staged'),
        repositories: [{
          ...repositoryPublications()[0],
          storageNodeId: 1,
        }],
      },
    ]) {
      assert.throws(
        () => decodeEnvironmentRestoreJournal(malformed),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'state-conflict');
          return true;
        },
      );
    }
  });

  it('fails startup closed when a pair marker exists without its journal', async () => {
    const coordinator = new EnvironmentRestoreCoordinator(unreachableOptions({
      backup: { validate: async () => catalog() },
      inspect: async () => Object.freeze({
        journal: undefined,
        pair: Object.freeze({ authorityVolumeId: TARGET_VOLUME_ID }),
      }),
    }));

    await assert.rejects(
      coordinator.recover(),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'recovery-required');
        return true;
      },
    );
  });

  it('preserves permanent catalog failures before target inspection', async () => {
    const calls: string[] = [];
    const backup = new EnvironmentBackupCatalogVerifier({
      coordinationSchemaVersion: 9,
      repositoryFormatVersion: 1,
      serverBuild: 'cloud-build-a',
      source: {
        readCatalog: async () => {
          calls.push('backup.read');
          return Object.freeze({ malformed: true });
        },
        verifyProjectBackup: async () => {
          throw new Error('unexpected');
        },
      },
    });
    const coordinator = new EnvironmentRestoreCoordinator(unreachableOptions({
      backup,
      inspect: async () => {
        calls.push('state.inspect');
        return Object.freeze({ journal: undefined, pair: 'absent' as const });
      },
    }));

    await assert.rejects(
      coordinator.restore({
        authorityVolumeId: TARGET_VOLUME_ID,
        authorityVolumeIdentity: 'authority-volume-restored',
        catalogId: 'backup-catalog-a',
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'invalid-backup');
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.deepEqual(calls, ['backup.read']);
  });

  it('rejects a catalog whose maximum journal cannot be durable', async () => {
    const calls: string[] = [];
    const projects = Object.freeze(Array.from({ length: 300 }, (_, index) => {
      const suffix = index.toString().padStart(3, '0');
      return Object.freeze({
        authorityGeneration: 1,
        backupId: `backup-${suffix}`,
        checkpointSha256: 'a'.repeat(64),
        expiresAt: '2026-09-29T00:00:00.000Z',
        placementGeneration: 1,
        projectId: `project-${suffix}`,
      });
    }));
    const coordinator = new EnvironmentRestoreCoordinator(unreachableOptions({
      backup: {
        validate: async () => {
          calls.push('backup');
          return Object.freeze({ ...catalog(), projects });
        },
      },
      inspect: async () => {
        calls.push('state.inspect');
        return Object.freeze({ journal: undefined, pair: 'absent' as const });
      },
    }));

    await assert.rejects(
      coordinator.restore({
        authorityVolumeId: TARGET_VOLUME_ID,
        authorityVolumeIdentity: 'authority-volume-restored',
        catalogId: 'backup-catalog-a',
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'invalid-backup');
        return true;
      },
    );
    assert.deepEqual(calls, ['backup']);
  });

  it('restores two Projects through the exact nine phases before readiness opens', async () => {
    const phases: EnvironmentRestorePhase[] = [];
    const calls: string[] = [];
    let journal: EnvironmentRestoreJournal | undefined;
    const publications = repositoryPublications();

    const coordinator = new EnvironmentRestoreCoordinator({
      backup: {
        validate: async input => {
          calls.push('backup.validate');
          assert.equal(input.catalogId, 'backup-catalog-a');
          assert.equal(input.expectedCatalogSha256, CATALOG_SHA);
          return catalog();
        },
      },
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
      continuity: {
        verifyBeforeCreation: async input => {
          calls.push('continuity.verify-before-creation');
          assert.deepEqual(input.catalog.projects.map(project => project.projectId), [
            PROJECT_A,
            PROJECT_B,
          ]);
        },
        verifyRestored: async input => {
          calls.push('continuity.verify-restored');
          assert.equal(input.restoreEpoch, 4);
        },
      },
      coordination: {
        assertEmpty: async () => {
          calls.push('coordination.assert-empty');
        },
        createDatabase: async input => {
          calls.push('coordination.create-database');
          assert.equal(input.authorityVolumeId, TARGET_VOLUME_ID);
          return Object.freeze({ authorityVolumeId: TARGET_VOLUME_ID });
        },
        importCoordination: async input => {
          calls.push('coordination.import');
          assert.equal(input.restoreEpoch, 4);
        },
        publishAuthority: async input => {
          calls.push('coordination.publish');
          assert.deepEqual(input.repositories, publications);
        },
        verifyDatabaseIdentity: async expected => {
          calls.push('coordination.verify-database-identity');
          assert.equal(expected, TARGET_VOLUME_ID);
        },
        verifyRestored: async input => {
          calls.push('coordination.verify-restored');
          assert.equal(input.repositories.length, 2);
        },
        classifyOrRemoveRestoreOwnedDatabase: async () => {
          throw new Error('unexpected-cleanup');
        },
      },
      repositories: {
        assertEmpty: async () => {
          calls.push('repositories.assert-empty');
        },
        publish: async input => {
          calls.push('repositories.publish');
          assert.deepEqual(input.repositories, publications);
        },
        removeRestoreOwned: async () => {
          throw new Error('unexpected-cleanup');
        },
        removeRestoreStaging: async () => {
          throw new Error('unexpected-cleanup');
        },
        stage: async input => {
          calls.push('repositories.stage');
          assert.equal(input.projects.length, 2);
          return publications;
        },
        verifyRestored: async input => {
          calls.push('repositories.verify-restored');
          assert.deepEqual(input.repositories, publications);
        },
      },
      state: {
        runExclusive,
        advance: async input => {
          assert.equal(journal?.phase, input.expectedPhase);
          journal = Object.freeze({ ...input.next });
          phases.push(journal.phase);
          return journal;
        },
        create: async input => {
          assert.equal(journal, undefined);
          journal = Object.freeze({ ...input });
          phases.push(journal.phase);
          return journal;
        },
        inspect: async () => Object.freeze({ journal, pair: 'absent' as const }),
        preparePair: async input => {
          assert.equal(journal?.phase, 'repositories-staged');
          assert.equal(input.authorityVolumeId, TARGET_VOLUME_ID);
          journal = Object.freeze({ ...input.next });
          phases.push(journal.phase);
          return journal;
        },
        recoverPublishedAuthority: async input => input.next,
        requestCleanup: async input => Object.freeze({ ...input.next }),
        remove: async () => {
          throw new Error('unexpected-cleanup');
        },
      },
    });

    const result = await coordinator.restore({
      authorityVolumeId: TARGET_VOLUME_ID,
      authorityVolumeIdentity: 'authority-volume-restored',
      catalogId: 'backup-catalog-a',
      expectedCatalogSha256: CATALOG_SHA,
      operationId: 'restore-operation-a',
    });

    assert.deepEqual(result, {
      catalogId: 'backup-catalog-a',
      catalogSha256: CATALOG_SHA,
      completedAt: '2026-08-29T00:00:00.000Z',
      operationId: 'restore-operation-a',
      projectCount: 2,
      restoreEpoch: 4,
      state: 'completed',
    });
    assert.deepEqual(phases, [
      'validated',
      'database-created',
      'coordination-imported',
      'repositories-staged',
      'pair-prepared',
      'repositories-published',
      'authority-published',
      'verified',
      'completed',
    ]);
    assert.deepEqual(calls, [
      'backup.validate',
      'continuity.verify-before-creation',
      'coordination.assert-empty',
      'repositories.assert-empty',
      'coordination.create-database',
      'coordination.verify-database-identity',
      'coordination.import',
      'repositories.stage',
      'repositories.publish',
      'coordination.publish',
      'coordination.verify-restored',
      'repositories.verify-restored',
      'continuity.verify-restored',
    ]);
  });

  it('recovers forward after process failure following every durable phase', async () => {
    for (const failedPhase of ENVIRONMENT_RESTORE_PHASES) {
      let failureEnabled = true;
      let journal: EnvironmentRestoreJournal | undefined;
      let pair: 'absent' | Readonly<{ readonly authorityVolumeId: string }> = 'absent';
      const publications = repositoryPublications();
      const failAfter = (phase: EnvironmentRestorePhase): void => {
        if (failureEnabled && phase === failedPhase) {
          throw new Error('simulated-process-exit');
        }
      };
      const options: EnvironmentRestoreCoordinatorOptions = {
        backup: {
          validate: async () => catalog(),
        },
        clock: () => new Date('2026-08-29T00:00:00.000Z'),
        continuity: {
          verifyBeforeCreation: async () => undefined,
          verifyRestored: async () => undefined,
        },
        coordination: {
          assertEmpty: async () => undefined,
          createDatabase: async () => Object.freeze({
            authorityVolumeId: TARGET_VOLUME_ID,
          }),
          importCoordination: async () => undefined,
          publishAuthority: async () => undefined,
          classifyOrRemoveRestoreOwnedDatabase: async () => 'removed' as const,
          verifyDatabaseIdentity: async () => undefined,
          verifyRestored: async () => undefined,
        },
        repositories: {
          assertEmpty: async () => undefined,
          publish: async () => undefined,
          removeRestoreOwned: async () => 'removed' as const,
          removeRestoreStaging: async () => 'removed' as const,
          stage: async () => publications,
          verifyRestored: async () => undefined,
        },
        state: {
          runExclusive,
          advance: async input => {
            assert.equal(journal?.phase, input.expectedPhase);
            journal = Object.freeze({ ...input.next });
            failAfter(journal.phase);
            return journal;
          },
          create: async input => {
            journal = Object.freeze({ ...input });
            failAfter(journal.phase);
            return journal;
          },
          inspect: async () => Object.freeze({ journal, pair }),
          preparePair: async input => {
            pair = Object.freeze({ authorityVolumeId: input.authorityVolumeId });
            journal = Object.freeze({ ...input.next });
            failAfter(journal.phase);
            return journal;
          },
          recoverPublishedAuthority: async input => {
            journal = Object.freeze({ ...input.next });
            return journal;
          },
          requestCleanup: async input => {
            journal = Object.freeze({ ...input.next });
            return journal;
          },
          remove: async () => 'removed' as const,
        },
      };
      const first = new EnvironmentRestoreCoordinator(options);
      await assert.rejects(
        first.restore({
          authorityVolumeId: TARGET_VOLUME_ID,
          authorityVolumeIdentity: 'authority-volume-restored',
          catalogId: 'backup-catalog-a',
          expectedCatalogSha256: CATALOG_SHA,
          operationId: 'restore-operation-a',
        }),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'dependency-failed');
          return true;
        },
        failedPhase,
      );

      failureEnabled = false;
      const restarted = new EnvironmentRestoreCoordinator(options);
      const result = await restarted.recover();
      assert.equal(result?.state, 'completed', failedPhase);
      assert.equal(journal?.phase, 'completed', failedPhase);
      assert.deepEqual(pair, { authorityVolumeId: TARGET_VOLUME_ID }, failedPhase);
    }
  });

  it('verifies the live database identity before any resumed mutation', async () => {
    const databaseCreatedIndex = ENVIRONMENT_RESTORE_PHASES.indexOf(
      'database-created',
    );
    for (const phase of ENVIRONMENT_RESTORE_PHASES.slice(databaseCreatedIndex)) {
      const calls: string[] = [];
      const unexpectedMutation = async (): Promise<never> => {
        calls.push('mutation');
        throw new Error('unexpected-mutation');
      };
      const phaseIndex = ENVIRONMENT_RESTORE_PHASES.indexOf(phase);
      const pair = phaseIndex >= ENVIRONMENT_RESTORE_PHASES.indexOf(
        'repositories-staged',
      )
        ? Object.freeze({ authorityVolumeId: TARGET_VOLUME_ID })
        : 'absent' as const;
      const coordinator = new EnvironmentRestoreCoordinator({
        backup: { validate: async () => catalog() },
        continuity: {
          verifyBeforeCreation: async () => { calls.push('continuity'); },
          verifyRestored: unexpectedMutation,
        },
        coordination: {
          assertEmpty: unexpectedMutation,
          classifyOrRemoveRestoreOwnedDatabase: async () => 'removed' as const,
          createDatabase: unexpectedMutation,
          importCoordination: unexpectedMutation,
          publishAuthority: unexpectedMutation,
          verifyDatabaseIdentity: async () => {
            calls.push('identity');
            throw new EnvironmentRestoreCoordinatorError('pair-mismatch');
          },
          verifyRestored: unexpectedMutation,
        },
        repositories: {
          assertEmpty: unexpectedMutation,
          publish: unexpectedMutation,
          removeRestoreOwned: async () => 'removed' as const,
          removeRestoreStaging: async () => 'removed' as const,
          stage: unexpectedMutation,
          verifyRestored: unexpectedMutation,
        },
        state: {
          runExclusive,
          advance: unexpectedMutation,
          create: unexpectedMutation,
          inspect: async () => Object.freeze({ journal: journalAt(phase), pair }),
          preparePair: unexpectedMutation,
          recoverPublishedAuthority: unexpectedMutation,
          remove: async () => 'removed' as const,
          requestCleanup: unexpectedMutation,
        },
      });

      await assert.rejects(
        coordinator.recover(),
        (error: unknown) => {
          assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
          assert.equal(error.code, 'pair-mismatch');
          return true;
        },
        phase,
      );
      assert.deepEqual(calls, ['continuity', 'identity'], phase);
    }
  });

  it('removes a database created before its response was lost', async () => {
    let databaseExists = false;
    let journal: EnvironmentRestoreJournal | undefined;
    const coordinator = new EnvironmentRestoreCoordinator({
      backup: { validate: async () => catalog() },
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
      continuity: {
        verifyBeforeCreation: async () => undefined,
        verifyRestored: async () => undefined,
      },
      coordination: {
        assertEmpty: async () => undefined,
        classifyOrRemoveRestoreOwnedDatabase: async () => {
          assert.equal(databaseExists, true);
          databaseExists = false;
          return 'removed' as const;
        },
        createDatabase: async () => {
          databaseExists = true;
          throw new Error('lost-create-database-response');
        },
        importCoordination: async () => { throw new Error('unexpected'); },
        publishAuthority: async () => { throw new Error('unexpected'); },
        verifyDatabaseIdentity: async () => { throw new Error('unexpected'); },
        verifyRestored: async () => { throw new Error('unexpected'); },
      },
      repositories: {
        assertEmpty: async () => undefined,
        publish: async () => { throw new Error('unexpected'); },
        removeRestoreOwned: async () => { throw new Error('unexpected'); },
        removeRestoreStaging: async () => { throw new Error('unexpected'); },
        stage: async () => { throw new Error('unexpected'); },
        verifyRestored: async () => { throw new Error('unexpected'); },
      },
      state: {
        runExclusive,
        advance: async input => input.next,
        create: async input => {
          journal = input;
          return input;
        },
        inspect: async () => Object.freeze({ journal, pair: 'absent' as const }),
        preparePair: async input => input.next,
        recoverPublishedAuthority: async input => input.next,
        remove: async () => {
          journal = undefined;
          return 'removed' as const;
        },
        requestCleanup: async input => {
          journal = input.next;
          return input.next;
        },
      },
    });

    await assert.rejects(
      coordinator.restore({
        authorityVolumeId: TARGET_VOLUME_ID,
        authorityVolumeIdentity: 'authority-volume-restored',
        catalogId: 'backup-catalog-a',
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'dependency-failed');
        return true;
      },
    );
    assert.equal(journal?.phase, 'validated');

    assert.equal(await coordinator.cancel({
      expectedCatalogSha256: CATALOG_SHA,
      operationId: 'restore-operation-a',
    }), 'cancelled');
    assert.equal(databaseExists, false);
    assert.equal(journal, undefined);
  });

  it('removes repository staging committed before its response was lost', async () => {
    let databaseExists = false;
    let stagingExists = false;
    let journal: EnvironmentRestoreJournal | undefined;
    const coordinator = new EnvironmentRestoreCoordinator({
      backup: { validate: async () => catalog() },
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
      continuity: {
        verifyBeforeCreation: async () => undefined,
        verifyRestored: async () => undefined,
      },
      coordination: {
        assertEmpty: async () => undefined,
        classifyOrRemoveRestoreOwnedDatabase: async () => {
          databaseExists = false;
          return 'removed' as const;
        },
        createDatabase: async () => {
          databaseExists = true;
          return Object.freeze({ authorityVolumeId: TARGET_VOLUME_ID });
        },
        importCoordination: async () => undefined,
        publishAuthority: async () => { throw new Error('unexpected'); },
        verifyDatabaseIdentity: async () => undefined,
        verifyRestored: async () => { throw new Error('unexpected'); },
      },
      repositories: {
        assertEmpty: async () => undefined,
        publish: async () => { throw new Error('unexpected'); },
        removeRestoreOwned: async () => { throw new Error('unexpected'); },
        removeRestoreStaging: async input => {
          assert.equal(input.operationId, 'restore-operation-a');
          assert.deepEqual(input.projects, catalog().projects);
          stagingExists = false;
          return 'removed' as const;
        },
        stage: async () => {
          stagingExists = true;
          throw new Error('lost-stage-response');
        },
        verifyRestored: async () => { throw new Error('unexpected'); },
      },
      state: {
        runExclusive,
        advance: async input => {
          journal = input.next;
          return input.next;
        },
        create: async input => {
          journal = input;
          return input;
        },
        inspect: async () => Object.freeze({ journal, pair: 'absent' as const }),
        preparePair: async input => input.next,
        recoverPublishedAuthority: async input => input.next,
        remove: async () => {
          journal = undefined;
          return 'removed' as const;
        },
        requestCleanup: async input => {
          journal = input.next;
          return input.next;
        },
      },
    });

    await assert.rejects(
      coordinator.restore({
        authorityVolumeId: TARGET_VOLUME_ID,
        authorityVolumeIdentity: 'authority-volume-restored',
        catalogId: 'backup-catalog-a',
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'dependency-failed');
        return true;
      },
    );
    assert.equal(journal?.phase, 'coordination-imported');

    assert.equal(await coordinator.cancel({
      expectedCatalogSha256: CATALOG_SHA,
      operationId: 'restore-operation-a',
    }), 'cancelled');
    assert.equal(databaseExists, false);
    assert.equal(stagingExists, false);
    assert.equal(journal, undefined);
  });

  it('fences cancellation while a restore mutation is in flight', async () => {
    let active = false;
    let databaseExists = false;
    let journal: EnvironmentRestoreJournal | undefined;
    let releaseStage = (): void => undefined;
    let stagingExists = false;
    let stageStarted = (): void => undefined;
    const stageGate = new Promise<void>(resolve => { releaseStage = resolve; });
    const stageStartedGate = new Promise<void>(resolve => { stageStarted = resolve; });
    const exclusive = async <Result>(
      operation: () => Promise<Result>,
    ): Promise<Result> => {
      if (active) {
        throw new EnvironmentRestoreCoordinatorError('recovery-required');
      }
      active = true;
      try {
        return await operation();
      } finally {
        active = false;
      }
    };
    const coordinator = new EnvironmentRestoreCoordinator({
      backup: { validate: async () => catalog() },
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
      continuity: {
        verifyBeforeCreation: async () => undefined,
        verifyRestored: async () => undefined,
      },
      coordination: {
        assertEmpty: async () => undefined,
        classifyOrRemoveRestoreOwnedDatabase: async () => {
          databaseExists = false;
          return 'removed' as const;
        },
        createDatabase: async () => {
          databaseExists = true;
          return Object.freeze({ authorityVolumeId: TARGET_VOLUME_ID });
        },
        importCoordination: async () => undefined,
        publishAuthority: async () => undefined,
        verifyDatabaseIdentity: async () => undefined,
        verifyRestored: async () => undefined,
      },
      repositories: {
        assertEmpty: async () => undefined,
        publish: async () => { stagingExists = false; },
        removeRestoreOwned: async () => 'removed' as const,
        removeRestoreStaging: async () => {
          stagingExists = false;
          return 'removed' as const;
        },
        stage: async () => {
          stageStarted();
          await stageGate;
          stagingExists = true;
          return repositoryPublications();
        },
        verifyRestored: async () => undefined,
      },
      state: {
        runExclusive: exclusive,
        advance: async input => {
          if (journal?.phase !== input.expectedPhase) {
            throw new EnvironmentRestoreCoordinatorError('state-conflict');
          }
          journal = input.next;
          return input.next;
        },
        create: async input => {
          journal = input;
          return input;
        },
        inspect: async () => Object.freeze({ journal, pair: 'absent' as const }),
        preparePair: async input => {
          journal = input.next;
          return input.next;
        },
        recoverPublishedAuthority: async input => input.next,
        remove: async () => {
          journal = undefined;
          return 'removed' as const;
        },
        requestCleanup: async input => {
          journal = input.next;
          return input.next;
        },
      },
    });

    const restore = coordinator.restore({
      authorityVolumeId: TARGET_VOLUME_ID,
      authorityVolumeIdentity: 'authority-volume-restored',
      catalogId: 'backup-catalog-a',
      expectedCatalogSha256: CATALOG_SHA,
      operationId: 'restore-operation-a',
    });
    await stageStartedGate;
    const cancellation = await coordinator.cancel({
      expectedCatalogSha256: CATALOG_SHA,
      operationId: 'restore-operation-a',
    }).then(
      value => Object.freeze({ status: 'fulfilled' as const, value }),
      (error: unknown) => Object.freeze({ status: 'rejected' as const, error }),
    );
    releaseStage();
    const restoreOutcome = await restore.then(
      value => Object.freeze({ status: 'fulfilled' as const, value }),
      (error: unknown) => Object.freeze({ status: 'rejected' as const, error }),
    );

    assert.equal(cancellation.status, 'rejected');
    if (cancellation.status === 'rejected') {
      assert.ok(cancellation.error instanceof EnvironmentRestoreCoordinatorError);
      assert.equal(cancellation.error.code, 'recovery-required');
    }
    assert.equal(restoreOutcome.status, 'fulfilled');
    assert.equal(databaseExists, true);
    assert.equal(stagingExists, false);
    assert.equal(journal?.phase, 'completed');
  });

  it('re-verifies a completed restore before startup can trust readiness', async () => {
    const calls: string[] = [];
    const completed = journalAt('completed');
    const coordinator = new EnvironmentRestoreCoordinator({
      backup: { validate: async () => catalog() },
      continuity: {
        verifyBeforeCreation: async () => { calls.push('continuity.open'); },
        verifyRestored: async () => { calls.push('continuity.verify'); },
      },
      coordination: {
        assertEmpty: async () => { throw new Error('unexpected'); },
        createDatabase: async () => { throw new Error('unexpected'); },
        importCoordination: async () => { throw new Error('unexpected'); },
        publishAuthority: async () => { throw new Error('unexpected'); },
        classifyOrRemoveRestoreOwnedDatabase: async () => 'removed' as const,
        verifyDatabaseIdentity: async () => undefined,
        verifyRestored: async () => { calls.push('coordination.verify'); },
      },
      repositories: {
        assertEmpty: async () => { throw new Error('unexpected'); },
        publish: async () => { throw new Error('unexpected'); },
        removeRestoreOwned: async () => 'removed' as const,
        removeRestoreStaging: async () => 'removed' as const,
        stage: async () => { throw new Error('unexpected'); },
        verifyRestored: async () => { calls.push('repositories.verify'); },
      },
      state: {
        runExclusive,
        advance: async input => input.next,
        create: async input => input,
        inspect: async () => Object.freeze({
          journal: completed,
          pair: Object.freeze({ authorityVolumeId: TARGET_VOLUME_ID }),
        }),
        preparePair: async input => input.next,
        recoverPublishedAuthority: async input => input.next,
        requestCleanup: async input => input.next,
        remove: async () => 'removed' as const,
      },
    });

    assert.equal((await coordinator.recover())?.state, 'completed');
    assert.deepEqual(calls, [
      'continuity.open',
      'coordination.verify',
      'repositories.verify',
      'continuity.verify',
    ]);
  });

  it('rejects unavailable claim continuity before inspecting or creating target state', async () => {
    const calls: string[] = [];
    const coordinator = new EnvironmentRestoreCoordinator({
      backup: { validate: async () => catalog() },
      continuity: {
        verifyBeforeCreation: async () => {
          calls.push('continuity');
          throw new EnvironmentRestoreCoordinatorError('continuity-unavailable');
        },
        verifyRestored: async () => undefined,
      },
      coordination: {
        assertEmpty: async () => { calls.push('coordination'); },
        createDatabase: async () => { throw new Error('unexpected'); },
        importCoordination: async () => undefined,
        publishAuthority: async () => undefined,
        classifyOrRemoveRestoreOwnedDatabase: async () => 'removed' as const,
        verifyDatabaseIdentity: async () => undefined,
        verifyRestored: async () => undefined,
      },
      repositories: {
        assertEmpty: async () => { calls.push('repositories'); },
        publish: async () => undefined,
        removeRestoreOwned: async () => 'removed' as const,
        removeRestoreStaging: async () => 'removed' as const,
        stage: async () => repositoryPublications(),
        verifyRestored: async () => undefined,
      },
      state: {
        runExclusive,
        advance: async input => input.next,
        create: async input => {
          calls.push('state.create');
          return input;
        },
        inspect: async () => {
          calls.push('state.inspect');
          return Object.freeze({ journal: undefined, pair: 'absent' as const });
        },
        preparePair: async input => input.next,
        recoverPublishedAuthority: async input => input.next,
        requestCleanup: async input => input.next,
        remove: async () => 'removed' as const,
      },
    });

    await assert.rejects(
      coordinator.restore({
        authorityVolumeId: TARGET_VOLUME_ID,
        authorityVolumeIdentity: 'authority-volume-restored',
        catalogId: 'backup-catalog-a',
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'continuity-unavailable');
        return true;
      },
    );
    assert.deepEqual(calls, ['continuity']);
  });

  it('rejects a non-empty coordination store before creating restore state', async () => {
    const calls: string[] = [];
    const coordinator = new EnvironmentRestoreCoordinator({
      backup: { validate: async () => catalog() },
      continuity: {
        verifyBeforeCreation: async () => { calls.push('continuity'); },
        verifyRestored: async () => undefined,
      },
      coordination: {
        assertEmpty: async () => {
          calls.push('coordination.assert-empty');
          throw new EnvironmentRestoreCoordinatorError('non-empty');
        },
        createDatabase: async () => { throw new Error('unexpected'); },
        importCoordination: async () => undefined,
        publishAuthority: async () => undefined,
        classifyOrRemoveRestoreOwnedDatabase: async () => 'removed' as const,
        verifyDatabaseIdentity: async () => undefined,
        verifyRestored: async () => undefined,
      },
      repositories: {
        assertEmpty: async () => { calls.push('repositories.assert-empty'); },
        publish: async () => undefined,
        removeRestoreOwned: async () => 'removed' as const,
        removeRestoreStaging: async () => 'removed' as const,
        stage: async () => repositoryPublications(),
        verifyRestored: async () => undefined,
      },
      state: {
        runExclusive,
        advance: async input => input.next,
        create: async input => {
          calls.push('state.create');
          return input;
        },
        inspect: async () => {
          calls.push('state.inspect');
          return Object.freeze({ journal: undefined, pair: 'absent' as const });
        },
        preparePair: async input => input.next,
        recoverPublishedAuthority: async input => input.next,
        requestCleanup: async input => input.next,
        remove: async () => 'removed' as const,
      },
    });

    await assert.rejects(
      coordinator.restore({
        authorityVolumeId: TARGET_VOLUME_ID,
        authorityVolumeIdentity: 'authority-volume-restored',
        catalogId: 'backup-catalog-a',
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'non-empty');
        return true;
      },
    );
    assert.deepEqual(calls, [
      'continuity',
      'state.inspect',
      'coordination.assert-empty',
    ]);
  });

  it('recovers forward without repository cleanup after a lost publish response', async () => {
    const calls: string[] = [];
    let authorityCommitted = false;
    let losePublishResponse = true;
    let journal: EnvironmentRestoreJournal | undefined = journalAt('pair-prepared');
    const pair = Object.freeze({ authorityVolumeId: TARGET_VOLUME_ID });
    const options = {
      backup: { validate: async () => catalog() },
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
      continuity: {
        verifyBeforeCreation: async () => undefined,
        verifyRestored: async () => { calls.push('continuity.verify'); },
      },
      coordination: {
        assertEmpty: async () => { throw new Error('unexpected'); },
        classifyOrRemoveRestoreOwnedDatabase: async () => {
          calls.push('coordination.classify');
          return authorityCommitted ? 'authority-published' as const : 'removed' as const;
        },
        createDatabase: async () => { throw new Error('unexpected'); },
        importCoordination: async () => { throw new Error('unexpected'); },
        publishAuthority: async () => {
          calls.push('coordination.publish');
          authorityCommitted = true;
          if (losePublishResponse) {
            losePublishResponse = false;
            throw new Error('lost-authority-publish-response');
          }
        },
        verifyDatabaseIdentity: async () => undefined,
        verifyRestored: async () => { calls.push('coordination.verify'); },
      },
      repositories: {
        assertEmpty: async () => { throw new Error('unexpected'); },
        publish: async () => { calls.push('repositories.publish'); },
        removeRestoreOwned: async () => {
          calls.push('repositories.remove');
          return 'removed' as const;
        },
        removeRestoreStaging: async () => {
          calls.push('repositories.remove-staging');
          return 'removed' as const;
        },
        stage: async () => { throw new Error('unexpected'); },
        verifyRestored: async () => { calls.push('repositories.verify'); },
      },
      state: {
        runExclusive,
        advance: async input => {
          journal = Object.freeze({ ...input.next });
          return journal;
        },
        create: async input => input,
        inspect: async () => Object.freeze({ journal, pair }),
        preparePair: async input => input.next,
        recoverPublishedAuthority: async input => {
          journal = Object.freeze({ ...input.next });
          calls.push('state.forward-fence');
          return journal;
        },
        requestCleanup: async input => {
          journal = Object.freeze({ ...input.next });
          return journal;
        },
        remove: async () => {
          calls.push('state.remove');
          return 'removed' as const;
        },
      },
    } satisfies EnvironmentRestoreCoordinatorOptions;
    const coordinator = new EnvironmentRestoreCoordinator(options);

    await assert.rejects(
      coordinator.restore({
        authorityVolumeId: TARGET_VOLUME_ID,
        authorityVolumeIdentity: 'authority-volume-restored',
        catalogId: 'backup-catalog-a',
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'dependency-failed');
        return true;
      },
    );
    assert.equal(journal?.phase, 'repositories-published');

    await assert.rejects(
      coordinator.cancel({
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'recovery-required');
        return true;
      },
    );
    assert.equal(journal?.phase, 'authority-published');
    assert.equal(journal?.cleanupRequestedAt, undefined);
    assert.equal(calls.includes('repositories.remove'), false);
    assert.equal(calls.includes('state.remove'), false);

    assert.equal((await coordinator.recover())?.state, 'completed');
    assert.equal(journal?.phase, 'completed');
    assert.deepEqual(calls, [
      'repositories.publish',
      'coordination.publish',
      'coordination.classify',
      'state.forward-fence',
      'coordination.verify',
      'repositories.verify',
      'continuity.verify',
    ]);
  });

  it('removes only exact restore-owned state before authority publication', async () => {
    const calls: string[] = [];
    let journal: EnvironmentRestoreJournal | undefined = journalAt(
      'repositories-published',
    );
    const options = {
      backup: { validate: async () => catalog() },
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
      continuity: {
        verifyBeforeCreation: async () => undefined,
        verifyRestored: async () => undefined,
      },
      coordination: {
        assertEmpty: async () => undefined,
        createDatabase: async () => Object.freeze({
          authorityVolumeId: TARGET_VOLUME_ID,
        }),
        importCoordination: async () => undefined,
        publishAuthority: async () => undefined,
        classifyOrRemoveRestoreOwnedDatabase: async input => {
          calls.push(`coordination:${input.operationId}`);
          return 'removed' as const;
        },
        verifyDatabaseIdentity: async () => undefined,
        verifyRestored: async () => undefined,
      },
      repositories: {
        assertEmpty: async () => undefined,
        publish: async () => undefined,
        removeRestoreOwned: async input => {
          calls.push(`repositories:${String(input.repositories.length)}`);
          return 'removed' as const;
        },
        removeRestoreStaging: async input => {
          calls.push(`staging:${String(input.projects.length)}`);
          return 'removed' as const;
        },
        stage: async () => repositoryPublications(),
        verifyRestored: async () => undefined,
      },
      state: {
        runExclusive,
        advance: async input => input.next,
        create: async input => input,
        inspect: async () => Object.freeze({
          journal,
          pair: Object.freeze({ authorityVolumeId: TARGET_VOLUME_ID }),
        }),
        preparePair: async input => input.next,
        recoverPublishedAuthority: async input => input.next,
        requestCleanup: async input => {
          journal = Object.freeze({ ...input.next });
          return journal;
        },
        remove: async input => {
          calls.push(`state:${input.phase}`);
          journal = undefined;
          return 'removed' as const;
        },
      },
    } satisfies EnvironmentRestoreCoordinatorOptions;
    const coordinator = new EnvironmentRestoreCoordinator(options);

    assert.equal(await coordinator.cancel({
      expectedCatalogSha256: CATALOG_SHA,
      operationId: 'restore-operation-a',
    }), 'cancelled');
    assert.deepEqual(calls, [
      'coordination:restore-operation-a',
      'repositories:2',
      'staging:2',
      'state:repositories-published',
    ]);
    assert.equal(journal, undefined);

    journal = journalAt('repositories-staged');
    calls.length = 0;
    assert.equal(await coordinator.cancel({
      expectedCatalogSha256: CATALOG_SHA,
      operationId: 'restore-operation-a',
    }), 'cancelled');
    assert.deepEqual(calls, [
      'coordination:restore-operation-a',
      'repositories:2',
      'staging:2',
      'state:repositories-staged',
    ]);

    journal = journalAt('authority-published');
    calls.length = 0;
    await assert.rejects(
      coordinator.cancel({
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'recovery-required');
        return true;
      },
    );
    assert.deepEqual(calls, []);
  });

  it('resumes an exact pre-publication cleanup after a lost process', async () => {
    const calls: string[] = [];
    let failRepositoryCleanup = true;
    let journal: EnvironmentRestoreJournal | undefined = journalAt(
      'repositories-published',
    );
    let pair: 'absent' | Readonly<{ readonly authorityVolumeId: string }> =
      Object.freeze({ authorityVolumeId: TARGET_VOLUME_ID });
    const options = {
      backup: { validate: async () => catalog() },
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
      continuity: {
        verifyBeforeCreation: async () => undefined,
        verifyRestored: async () => undefined,
      },
      coordination: {
        assertEmpty: async () => undefined,
        createDatabase: async () => Object.freeze({
          authorityVolumeId: TARGET_VOLUME_ID,
        }),
        importCoordination: async () => undefined,
        publishAuthority: async () => {
          throw new Error('must-not-publish-during-cleanup');
        },
        classifyOrRemoveRestoreOwnedDatabase: async () => {
          calls.push('coordination.remove');
          return 'removed' as const;
        },
        verifyDatabaseIdentity: async () => undefined,
        verifyRestored: async () => undefined,
      },
      repositories: {
        assertEmpty: async () => undefined,
        publish: async () => undefined,
        removeRestoreOwned: async () => {
          calls.push('repositories.remove');
          if (failRepositoryCleanup) throw new Error('simulated-process-exit');
          return 'removed' as const;
        },
        removeRestoreStaging: async () => {
          calls.push('repositories.remove-staging');
          return 'removed' as const;
        },
        stage: async () => repositoryPublications(),
        verifyRestored: async () => undefined,
      },
      state: {
        runExclusive,
        advance: async input => input.next,
        create: async input => input,
        inspect: async () => Object.freeze({ journal, pair }),
        preparePair: async input => input.next,
        recoverPublishedAuthority: async input => input.next,
        requestCleanup: async input => {
          journal = Object.freeze({ ...input.next });
          return journal;
        },
        remove: async () => {
          calls.push('state.remove');
          journal = undefined;
          pair = 'absent';
          return 'removed' as const;
        },
      },
    } satisfies EnvironmentRestoreCoordinatorOptions;
    const coordinator = new EnvironmentRestoreCoordinator(options);
    await assert.rejects(
      coordinator.cancel({
        expectedCatalogSha256: CATALOG_SHA,
        operationId: 'restore-operation-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentRestoreCoordinatorError);
        assert.equal(error.code, 'dependency-failed');
        return true;
      },
    );
    assert.equal(journal?.cleanupRequestedAt, '2026-08-29T00:00:00.000Z');

    failRepositoryCleanup = false;
    const restarted = new EnvironmentRestoreCoordinator({
      ...options,
      clock: () => new Date('2026-08-29T00:00:00.000Z'),
    });
    assert.equal(await restarted.recover(), undefined);
    assert.deepEqual(calls, [
      'coordination.remove',
      'repositories.remove',
      'coordination.remove',
      'repositories.remove',
      'repositories.remove-staging',
      'state.remove',
    ]);
    assert.equal(journal, undefined);
    assert.equal(pair, 'absent');
  });
});
