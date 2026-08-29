import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EnvironmentBackupCommand,
  EnvironmentBackupCommandError,
} from '../../src/environment-maintenance/commands/EnvironmentBackupCommand.js';
import type { CreateBackupExportInput } from '../../src/project-authority/checkpoint/BackupExportCoordinator.js';

describe('EnvironmentBackupCommand', () => {
  it('publishes retained continuity for a terminal-only Project', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const records = Object.freeze([Object.freeze({
      kind: 'tombstone' as const,
      recordId: projectId,
      revision: 1,
      value: Object.freeze({
        authorityGeneration: 2,
        projectId,
        retiredAt: '2026-08-28T00:00:00.000Z',
        terminalExpiresAt: '2026-09-28T00:00:00.000Z',
      }),
    })]);
    let terminalPublished = false;
    let terminalVerified = false;
    let catalogJson = '';
    const command = new EnvironmentBackupCommand({
      backup: { create: () => assert.fail('unexpected active backup') },
      catalog: {
        publish: value => {
          catalogJson = value.json;
          return Promise.resolve('published');
        },
        publishTerminalProject: value => {
          terminalPublished = true;
          assert.equal(value.projectId, projectId);
          assert.deepEqual(value.records, records);
          return Promise.resolve('published');
        },
      },
      metadata: {
        authorityId: 'authority-a',
        authorityVolumeIdentity: 'volume-a',
        coordinationSchemaVersion: 9,
        repositoryFormatVersion: 1,
        restoreEpoch: 1,
        serverBuild: 'development',
      },
      projects: {
        list: () => Promise.resolve({ nextCursor: undefined, projectIds: [] }),
        listTerminal: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [projectId],
        }),
        readFacts: () => assert.fail('unexpected facts'),
        readTerminalRecords: () => Promise.resolve(records as never),
      },
      terminalRecords: {
        verify: value => {
          terminalVerified = true;
          assert.equal(value, records);
          return Promise.resolve();
        },
      },
    });

    const result = await command.run({
      catalogId: 'catalog-terminal',
      signal: new AbortController().signal,
    });

    const document = JSON.parse(catalogJson) as {
      readonly projects: readonly unknown[];
      readonly terminalProjects: ReadonlyArray<{
        readonly artifactByteCount: number;
        readonly artifactSha256: string;
        readonly projectId: string;
      }>;
    };
    assert.equal(terminalPublished, true);
    assert.equal(terminalVerified, true);
    assert.equal(result.projectCount, 1);
    assert.deepEqual(document.projects, []);
    assert.equal(document.terminalProjects.length, 1);
    const [terminalProject] = document.terminalProjects;
    assert.ok(terminalProject !== undefined);
    assert.equal(terminalProject.projectId, projectId);
    assert.ok(terminalProject.artifactByteCount > 0);
    assert.match(terminalProject.artifactSha256, /^[0-9a-f]{64}$/u);
  });

  it('publishes one deterministic environment catalog after every Project backup', async () => {
    const backups: Readonly<Record<string, Readonly<{
      readonly authorityGeneration: number;
      readonly placementGeneration: number;
    }>>> = {
      'project-a': { authorityGeneration: 1, placementGeneration: 3 },
      'project-b': { authorityGeneration: 2, placementGeneration: 4 },
    };
    const creates: CreateBackupExportInput[] = [];
    const factReads: unknown[] = [];
    let publishedJson = '';
    const command = new EnvironmentBackupCommand({
      backup: {
        create: input => {
          creates.push(input);
          return Promise.resolve(Object.freeze({
            checkpointSha256: input.projectId === 'project-a'
              ? 'a'.repeat(64)
              : 'b'.repeat(64),
            createdAt: '2026-08-29T00:00:00.000Z',
            expiresAt: input.expiresAt,
            operationId: input.operationId,
            profile: 'backup' as const,
            projectId: input.projectId,
            state: 'published' as const,
          }));
        },
      },
      catalog: {
        publish: value => {
          publishedJson = value.json;
          return Promise.resolve('published');
        },
      },
      metadata: {
        authorityId: 'authority-a',
        authorityVolumeIdentity: 'volume-a',
        coordinationSchemaVersion: 9,
        repositoryFormatVersion: 1,
        restoreEpoch: 1,
        serverBuild: '0.0.0',
      },
      projects: {
        list: input => Promise.resolve(input.after === undefined
          ? Object.freeze({ nextCursor: 'project-a', projectIds: ['project-a'] })
          : Object.freeze({ nextCursor: undefined, projectIds: ['project-b'] })),
        readFacts: (projectId, backupId) => {
          factReads.push({ backupId, projectId });
          const facts = backups[projectId];
          assert.ok(facts);
          return Promise.resolve(facts);
        },
      },
      terminalRecords: { verify: () => assert.fail('unexpected terminal records') },
    });

    const result = await command.run({
      catalogId: 'catalog-a',
      signal: new AbortController().signal,
    });

    assert.equal(creates.length, 2);
    assert.deepEqual(creates.map(input => input.profile), ['backup', 'backup']);
    assert.equal(new Set(creates.map(input => input.operationId)).size, 2);
    assert.deepEqual(factReads, creates.map(input => ({
      backupId: input.operationId,
      projectId: input.projectId,
    })));
    assert.ok(creates.every(input => input.expiresAt
      === '9999-12-31T23:59:59.999Z'));
    const document = JSON.parse(publishedJson) as {
      readonly catalogSha256: string;
      readonly createdAt: string;
      readonly projects: readonly { readonly projectId: string }[];
    };
    assert.equal(document.createdAt, '2026-08-29T00:00:00.000Z');
    assert.equal(result.catalogSha256, document.catalogSha256);
    assert.equal(result.projectCount, 2);
    assert.deepEqual(
      document.projects.map(project => project.projectId),
      ['project-a', 'project-b'],
    );
  });

  it('rejects an empty authority and pre-aborted operation', async () => {
    const command = new EnvironmentBackupCommand({
      backup: { create: () => assert.fail('unexpected backup') },
      catalog: { publish: () => assert.fail('unexpected publication') },
      metadata: {
        authorityId: 'authority-a',
        authorityVolumeIdentity: 'volume-a',
        coordinationSchemaVersion: 9,
        repositoryFormatVersion: 1,
        restoreEpoch: 1,
        serverBuild: '0.0.0',
      },
      projects: {
        list: () => Promise.resolve({ nextCursor: undefined, projectIds: [] }),
        readFacts: () => assert.fail('unexpected facts'),
      },
      terminalRecords: { verify: () => assert.fail('unexpected terminal records') },
    });
    await assert.rejects(
      command.run({
        catalogId: 'catalog-a',
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentBackupCommandError);
        assert.equal(error.code, 'state-conflict');
        return true;
      },
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      command.run({ catalogId: 'catalog-a', signal: controller.signal }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentBackupCommandError);
        assert.equal(error.code, 'cancelled');
        return true;
      },
    );
  });
});
