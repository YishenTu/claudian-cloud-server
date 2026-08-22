import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GitProcessError,
  GitProcessSupervisor,
} from '../../../src/repositories/GitProcessSupervisor.js';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function remainsPending(operation: Promise<unknown>, label: string): Promise<void> {
  let settled = false;
  void operation.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false, label);
}

async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}`)), 1_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function expectProcessError(
  operation: Promise<unknown>,
  code: GitProcessError['code'],
): Promise<void> {
  await assert.rejects(within(operation, code), error => (
    error instanceof GitProcessError && error.code === code
  ));
}

describe('GitProcessSupervisor streaming lifecycle', () => {
  it('aborts and contains a pending stdout write before timeout or close settles', async () => {
    {
      const callbackEntered = deferred();
      const callbackCancelled = deferred();
      const supervisor = new GitProcessSupervisor({
        gitExecutable: '/bin/sh',
        operationTimeoutMs: 100,
        outputMaxBytes: 1_024,
      });
      const operation = supervisor.runStreamingCommand({
        arguments: ['-c', 'printf streamed-output'],
        cwd: '/tmp',
        failureCode: 'process-failed',
        onStdoutChunk: (_chunk, signal) => {
          callbackEntered.resolve();
          return new Promise<void>(resolve => {
            signal.addEventListener('abort', () => {
              callbackCancelled.resolve();
              resolve();
            }, { once: true });
          });
        },
        stdoutMaxBytes: 1_024,
      });

      await within(callbackEntered.promise, 'timeout-callback');
      await expectProcessError(operation, 'timeout');
      await within(callbackCancelled.promise, 'timeout-callback-cancelled');
      await within(supervisor.runCommand({
        arguments: ['-c', 'exit 0'],
        captureOutput: true,
        cwd: '/tmp',
        failureCode: 'process-failed',
      }), 'replacement-command');
      await within(supervisor.close(), 'timeout-close');
    }

    {
      const callbackEntered = deferred();
      const callbackCancelled = deferred();
      const supervisor = new GitProcessSupervisor({
        gitExecutable: '/bin/sh',
        operationTimeoutMs: 5_000,
        outputMaxBytes: 1_024,
      });
      const operation = supervisor.runStreamingCommand({
        arguments: ['-c', 'printf streamed-output'],
        cwd: '/tmp',
        failureCode: 'process-failed',
        onStdoutChunk: (_chunk, signal) => {
          callbackEntered.resolve();
          return new Promise<void>(resolve => {
            signal.addEventListener('abort', () => {
              callbackCancelled.resolve();
              resolve();
            }, { once: true });
          });
        },
        stdoutMaxBytes: 1_024,
      });

      await within(callbackEntered.promise, 'close-callback');
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      const closing = supervisor.close();
      await expectProcessError(operation, 'closed');
      await within(callbackCancelled.promise, 'close-callback-cancelled');
      await within(closing, 'supervisor-close');
    }
  });

  it('does not declare shutdown quiescent while a streaming callback still owns state', async () => {
    const callbackEntered = deferred();
    const releaseCallback = deferred();
    const supervisor = new GitProcessSupervisor({
      gitExecutable: '/bin/sh',
      operationTimeoutMs: 5_000,
      outputMaxBytes: 1_024,
    });
    const operation = supervisor.runStreamingCommand({
      arguments: ['-c', 'printf streamed-output'],
      cwd: '/tmp',
      failureCode: 'process-failed',
      onStdoutChunk: () => {
        callbackEntered.resolve();
        return releaseCallback.promise;
      },
      stdoutMaxBytes: 1_024,
    });

    await within(callbackEntered.promise, 'quiescent-callback');
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    const closing = supervisor.close();
    await remainsPending(operation, 'operation settled before callback containment');
    await remainsPending(closing, 'close settled before callback containment');
    releaseCallback.resolve();
    await expectProcessError(operation, 'closed');
    await within(closing, 'quiescent-close');
  });
});
