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
  it('streams stdin with backpressure before settling streamed stdout', async () => {
    const firstInputProduced = deferred();
    const releaseSecondInput = deferred();
    const output: Buffer[] = [];
    const supervisor = new GitProcessSupervisor({
      gitExecutable: '/bin/sh',
      operationTimeoutMs: 5_000,
      outputMaxBytes: 1_024,
    });
    const operation = supervisor.runStreamingCommand({
      arguments: ['-c', 'cat'],
      cwd: '/tmp',
      failureCode: 'process-failed',
      inputStream: (async function* input(): AsyncGenerator<Uint8Array> {
        yield Buffer.from('first');
        firstInputProduced.resolve();
        await releaseSecondInput.promise;
        yield Buffer.from('-second');
      })(),
      onStdoutChunk: chunk => { output.push(chunk); },
      stdoutMaxBytes: 1_024,
    });

    await within(firstInputProduced.promise, 'first-input');
    await remainsPending(operation, 'operation settled before streamed input ended');
    releaseSecondInput.resolve();
    await within(operation, 'streamed-input-operation');
    assert.equal(Buffer.concat(output).toString('utf8'), 'first-second');
    await supervisor.close();
  });

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

  it('cancels a stalled input iterator before shutdown settles', async () => {
    let returnCalls = 0;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: () => {
          returnCalls += 1;
          return Promise.reject(new Error('iterator-return-rejected'));
        },
      }),
    };
    const supervisor = new GitProcessSupervisor({
      gitExecutable: '/bin/sh',
      operationTimeoutMs: 5_000,
      outputMaxBytes: 1_024,
    });
    const operation = supervisor.runStreamingCommand({
      arguments: ['-c', 'cat'],
      cwd: '/tmp',
      failureCode: 'process-failed',
      inputStream: input,
      onStdoutChunk: () => undefined,
      stdoutMaxBytes: 1_024,
    });
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    const closing = supervisor.close();
    await expectProcessError(operation, 'closed');
    await within(closing, 'stalled-input-close');
    assert.equal(returnCalls, 1);
  });

  it('contains iterator return cleanup before operation and shutdown settle', async () => {
    const returnEntered = deferred();
    const releaseReturn = deferred();
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: async () => {
          returnEntered.resolve();
          await releaseReturn.promise;
          return { done: true, value: undefined };
        },
      }),
    };
    const supervisor = new GitProcessSupervisor({
      gitExecutable: '/bin/sh',
      operationTimeoutMs: 5_000,
      outputMaxBytes: 1_024,
    });
    const operation = supervisor.runStreamingCommand({
      arguments: ['-c', 'cat'],
      cwd: '/tmp',
      failureCode: 'process-failed',
      inputStream: input,
      onStdoutChunk: () => undefined,
      stdoutMaxBytes: 1_024,
    });
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    const closing = supervisor.close();
    await within(returnEntered.promise, 'iterator-return-entered');
    await remainsPending(operation, 'operation settled before iterator return cleanup');
    await remainsPending(closing, 'close settled before iterator return cleanup');
    releaseReturn.resolve();
    await expectProcessError(operation, 'closed');
    await within(closing, 'iterator-return-close');
  });

  it('preserves a streamed input boundary error after terminating Git', async () => {
    const boundaryError = new Error('transport-boundary-rejected');
    const supervisor = new GitProcessSupervisor({
      gitExecutable: '/bin/sh',
      operationTimeoutMs: 5_000,
      outputMaxBytes: 1_024,
    });
    const operation = supervisor.runStreamingCommand({
      arguments: ['-c', 'cat'],
      cwd: '/tmp',
      failureCode: 'process-failed',
      inputStream: (async function* input(): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield Buffer.from('partial');
        throw boundaryError;
      })(),
      onStdoutChunk: () => undefined,
      stdoutMaxBytes: 1_024,
    });

    await assert.rejects(within(operation, 'streamed-input-boundary'), error => (
      error === boundaryError
    ));
    await within(supervisor.close(), 'streamed-input-boundary-close');
  });
});
