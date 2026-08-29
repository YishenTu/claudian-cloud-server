import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMaintenanceCommand } from '../../src/composition/createMaintenanceCommand.js';
import { MaintenanceCommandError } from '../../src/environment-maintenance/commands/MaintenanceCommandRegistry.js';

describe('maintenance command composition', () => {
  it('routes every non-migration command to its operation owner', async () => {
    const calls: string[] = [];
    const runtime = createMaintenanceCommand({
      operations: {
        backup: () => { calls.push('backup'); return Promise.resolve(); },
        exportProject: () => { calls.push('export-project'); return Promise.resolve(); },
        reconcileExports: () => { calls.push('reconcile-exports'); return Promise.resolve(); },
        recoverProjects: () => { calls.push('recover-projects'); return Promise.resolve(); },
        recoverRestore: () => { calls.push('recover-restore'); return Promise.resolve(); },
        restore: () => { calls.push('restore'); return Promise.resolve(); },
        resumeDelete: () => { calls.push('resume-delete'); return Promise.resolve(); },
        verifyAuthority: () => { calls.push('verify-authority'); return Promise.resolve(); },
        verifyBackup: () => { calls.push('verify-backup'); return Promise.resolve(); },
      },
      source: {},
      write() {},
    });
    const signal = new AbortController().signal;
    for (const command of [
      'backup',
      'verify-backup',
      'restore',
      'recover-restore',
      'recover-projects',
      'export-project',
      'reconcile-exports',
      'resume-delete',
      'verify-authority',
    ]) await runtime.run([command], signal);
    assert.deepEqual(calls, [
      'backup',
      'verify-backup',
      'restore',
      'recover-restore',
      'recover-projects',
      'export-project',
      'reconcile-exports',
      'resume-delete',
      'verify-authority',
    ]);
  });

  it('rejects positional data instead of exposing it in process arguments', async () => {
    const runtime = createMaintenanceCommand({
      operations: {
        backup: () => Promise.resolve(),
        exportProject: () => Promise.resolve(),
        reconcileExports: () => Promise.resolve(),
        recoverProjects: () => Promise.resolve(),
        recoverRestore: () => Promise.resolve(),
        restore: () => Promise.resolve(),
        resumeDelete: () => Promise.resolve(),
        verifyAuthority: () => Promise.resolve(),
        verifyBackup: () => Promise.resolve(),
      },
      source: {},
      write() {},
    });
    await assert.rejects(
      runtime.run(['backup', 'secret'], new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceCommandError);
        assert.equal(error.code, 'invalid-command');
        assert.doesNotMatch(error.message, /secret/u);
        return true;
      },
    );
  });
});
