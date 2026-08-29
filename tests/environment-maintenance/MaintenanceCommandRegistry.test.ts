import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAINTENANCE_COMMANDS,
  MaintenanceCommandError,
  MaintenanceCommandRegistry,
} from '../../src/environment-maintenance/commands/MaintenanceCommandRegistry.js';

describe('MaintenanceCommandRegistry', () => {
  it('dispatches only the complete compiled maintenance inventory', async () => {
    const calls: string[] = [];
    const registry = new MaintenanceCommandRegistry(Object.fromEntries(
      MAINTENANCE_COMMANDS.map(command => [
        command,
        (input: Readonly<{
          readonly arguments: readonly string[];
          readonly signal: AbortSignal;
        }>) => {
          calls.push(`${command}:${input.arguments.join(',')}`);
          return Promise.resolve();
        },
      ]),
    ));

    for (const command of MAINTENANCE_COMMANDS) {
      await registry.run(
        command === 'migration' ? [command, 'preflight'] : [command],
        new AbortController().signal,
      );
    }

    assert.deepEqual(calls, [
      'backup:',
      'verify-backup:',
      'restore:',
      'recover-restore:',
      'recover-projects:',
      'export-project:',
      'reconcile-exports:',
      'resume-delete:',
      'verify-authority:',
      'migration:preflight',
    ]);
  });

  it('rejects an absent or unknown command without exposing arguments', async () => {
    const secret = 'private-maintenance-token';
    const registry = new MaintenanceCommandRegistry(Object.fromEntries(
      MAINTENANCE_COMMANDS.map(command => [
        command,
        () => Promise.resolve(),
      ]),
    ));

    for (const arguments_ of [[], ['unknown', secret]]) {
      const error = await registry.run(
        arguments_,
        new AbortController().signal,
      ).then(() => undefined, (failure: unknown) => failure);

      assert.ok(error instanceof MaintenanceCommandError);
      assert.equal(error.code, 'invalid-command');
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret, 'u'));
    }
  });

  it('fails closed on cancellation before invoking an owner', async () => {
    let invoked = false;
    const registry = new MaintenanceCommandRegistry(Object.fromEntries(
      MAINTENANCE_COMMANDS.map(command => [command, () => {
        invoked = true;
        return Promise.resolve();
      }]),
    ));
    const controller = new AbortController();
    controller.abort('operator-signal');

    await assert.rejects(
      registry.run(['backup'], controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceCommandError);
        assert.equal(error.code, 'cancelled');
        return true;
      },
    );
    assert.equal(invoked, false);
  });
});
