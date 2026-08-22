import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';
import type { Writable } from 'node:stream';

export type GitProcessErrorCode =
  | 'cancelled'
  | 'closed'
  | 'git-unavailable'
  | 'output-limit'
  | 'process-failed'
  | 'repository-corrupt'
  | 'timeout'
  | 'unsupported-git';

export class GitProcessError extends Error {
  readonly code: GitProcessErrorCode;

  constructor(code: GitProcessErrorCode) {
    super(`git-process.error.${code}`);
    this.name = 'GitProcessError';
    this.code = code;
  }
}

export interface GitProcessSupervisorOptions {
  readonly gitExecutable: string;
  readonly operationTimeoutMs: number;
  readonly outputMaxBytes: number;
}

export interface GitProcessCommand {
  readonly acceptedExitCodes?: readonly number[];
  readonly arguments: readonly string[];
  readonly captureOutput: boolean;
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly failureCode: GitProcessErrorCode;
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly input?: Buffer | string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface GitProcessStreamingCommand {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly failureCode: GitProcessErrorCode;
  readonly gitProtocol?: 'version=1' | 'version=2';
  readonly input?: Buffer | string;
  readonly inputStream?: AsyncIterable<Uint8Array>;
  readonly onStdoutChunk: (
    chunk: Buffer,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly stdoutMaxBytes: number;
  readonly timeoutMs?: number;
}

interface RunningGitProcess {
  readonly settled: Promise<unknown>;
  terminate(code: GitProcessErrorCode): void;
}

const TERMINATION_GRACE_MS = 250;
const INPUT_RETURN_CLEANUP_MS = 1_000;
const MINIMUM_GIT_MAJOR = 2;
const MINIMUM_GIT_MINOR = 39;
const GIT_ENVIRONMENT = Object.freeze({
  GIT_ASKPASS: '/bin/false',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_DIR: '.',
  GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  SSH_ASKPASS: '/bin/false',
});

function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function waitForDrain(
  stream: Writable,
  signal: AbortSignal,
  failureCode: () => GitProcessErrorCode,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onDrain = (): void => settle(resolve);
    const onClose = (): void => settle(() => {
      reject(new GitProcessError(failureCode()));
    });
    const onAbort = (): void => settle(() => {
      reject(new GitProcessError(failureCode()));
    });
    stream.once('drain', onDrain);
    stream.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function nextInputChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
  failureCode: () => GitProcessErrorCode,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) throw new GitProcessError(failureCode());
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new GitProcessError(failureCode()));
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }),
    ]);
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

async function containIteratorReturn(
  iterator: AsyncIterator<Uint8Array>,
): Promise<void> {
  if (iterator.return === undefined) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let returned: Promise<void>;
  try {
    returned = Promise.resolve(iterator.return()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return;
  }
  try {
    await Promise.race([
      returned,
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, INPUT_RETURN_CLEANUP_MS);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export class GitProcessSupervisor {
  readonly #gitExecutable: string;
  readonly #operationTimeoutMs: number;
  readonly #outputMaxBytes: number;
  readonly #running = new Set<RunningGitProcess>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: GitProcessSupervisorOptions) {
    this.#gitExecutable = options.gitExecutable;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#outputMaxBytes = options.outputMaxBytes;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      const running = [...this.#running];
      for (const process of running) process.terminate('closed');
      this.#closePromise = Promise.allSettled(
        running.map(process => process.settled),
      ).then(() => undefined);
    }
    return this.#closePromise;
  }

  runIntegrityCheck(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#runProcess({
      arguments: [
        'fsck',
        '--full',
        '--strict',
        '--no-dangling',
        '--no-progress',
      ],
      captureOutput: false,
      cwd: repositoryPath,
      failureCode: 'repository-corrupt',
      signal,
    }).then(() => undefined);
  }

  runCommand(command: GitProcessCommand): Promise<Buffer> {
    return this.#runProcess({
      ...(command.acceptedExitCodes === undefined
        ? {}
        : { acceptedExitCodes: command.acceptedExitCodes }),
      arguments: command.arguments,
      captureOutput: command.captureOutput,
      cwd: command.cwd,
      ...(command.environment === undefined
        ? {}
        : { environment: command.environment }),
      failureCode: command.failureCode,
      ...(command.input === undefined ? {} : { input: command.input }),
      ...(command.gitProtocol === undefined
        ? {}
        : { gitProtocol: command.gitProtocol }),
      signal: command.signal,
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    });
  }

  runStreamingCommand(command: GitProcessStreamingCommand): Promise<void> {
    if (command.input !== undefined && command.inputStream !== undefined) {
      return Promise.reject(new GitProcessError('process-failed'));
    }
    return this.#runProcess({
      arguments: command.arguments,
      captureOutput: false,
      cwd: command.cwd,
      ...(command.environment === undefined
        ? {}
        : { environment: command.environment }),
      failureCode: command.failureCode,
      ...(command.input === undefined ? {} : { input: command.input }),
      ...(command.inputStream === undefined
        ? {}
        : { inputStream: command.inputStream }),
      ...(command.gitProtocol === undefined
        ? {}
        : { gitProtocol: command.gitProtocol }),
      signal: command.signal,
      stdoutStream: {
        maximumBytes: command.stdoutMaxBytes,
        onChunk: command.onStdoutChunk,
      },
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    }).then(() => undefined);
  }

  async verifyBareRepository(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const output = await this.#runProcess({
      arguments: ['rev-parse', '--is-bare-repository'],
      captureOutput: true,
      cwd: repositoryPath,
      failureCode: 'repository-corrupt',
      signal,
    });
    if (output.toString('utf8').trim() !== 'true') {
      throw new GitProcessError('repository-corrupt');
    }
  }

  async verifyVersion(signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    const output = await this.#runProcess({
      arguments: ['--version'],
      captureOutput: true,
      cwd: undefined,
      failureCode: 'git-unavailable',
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(
      output.toString('utf8').trim(),
    );
    const major = Number(match?.[1]);
    const minor = Number(match?.[2]);
    if (
      !Number.isSafeInteger(major)
      || !Number.isSafeInteger(minor)
      || major < MINIMUM_GIT_MAJOR
      || (major === MINIMUM_GIT_MAJOR && minor < MINIMUM_GIT_MINOR)
    ) {
      throw new GitProcessError('unsupported-git');
    }
  }

  #runProcess(options: {
    readonly acceptedExitCodes?: readonly number[];
    readonly arguments: readonly string[];
    readonly captureOutput: boolean;
    readonly cwd: string | undefined;
    readonly environment?: Readonly<Record<string, string>>;
    readonly failureCode: GitProcessErrorCode;
    readonly gitProtocol?: 'version=1' | 'version=2';
    readonly input?: Buffer | string;
    readonly inputStream?: AsyncIterable<Uint8Array>;
    readonly signal: AbortSignal | undefined;
    readonly stdoutStream?: Readonly<{
      maximumBytes: number;
      onChunk: (chunk: Buffer, signal: AbortSignal) => Promise<void> | void;
    }>;
    readonly timeoutMs?: number;
  }): Promise<Buffer> {
    if (this.#closed) return Promise.reject(new GitProcessError('closed'));
    if (options.signal?.aborted === true) {
      return Promise.reject(new GitProcessError('cancelled'));
    }
    if (
      options.acceptedExitCodes !== undefined
      && (
        options.acceptedExitCodes.length === 0
        || options.acceptedExitCodes.some(code => (
          !Number.isSafeInteger(code) || code < 0 || code > 255
        ))
        || new Set(options.acceptedExitCodes).size !== options.acceptedExitCodes.length
      )
    ) {
      return Promise.reject(new GitProcessError('process-failed'));
    }

    let child: ChildProcessWithoutNullStreams;
    if (options.environment !== undefined && Object.entries(options.environment).some(
      ([name, value]) => (
        !/^(?:CLAUDIAN_RECEIVE_[A-Z0-9_]+|GIT_CONFIG_(?:COUNT|KEY_[0-9]+|VALUE_[0-9]+))$/u.test(name)
        || value.includes('\0')
        || value.includes('\n')
        || Object.hasOwn(GIT_ENVIRONMENT, name)
      ),
    )) {
      return Promise.reject(new GitProcessError('process-failed'));
    }
    try {
      child = spawn(
        this.#gitExecutable,
        [...options.arguments],
        {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          detached: true,
          env: {
            ...GIT_ENVIRONMENT,
            ...options.environment,
            ...(options.gitProtocol === undefined
              ? {}
              : { GIT_PROTOCOL: options.gitProtocol }),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch {
      return Promise.reject(new GitProcessError('git-unavailable'));
    }
    child.stdin.on('error', () => {
      // An early child exit may close stdin before the bounded input is written.
    });

    let rejectSettled!: (error: Error) => void;
    let resolveSettled!: (output: Buffer) => void;
    let terminationCode: GitProcessErrorCode | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let outputBytes = 0;
    let pendingStreamWrites = 0;
    let inputSettled = options.inputStream === undefined;
    let inputFailure: Error | undefined;
    let streamedStdoutBytes = 0;
    let childClosed = false;
    let successfulClose = false;
    let settled = false;
    let streamQueue = Promise.resolve();
    const capturedOutput: Buffer[] = [];
    const streamController = new AbortController();

    const settledPromise = new Promise<Buffer>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    const cleanup = (): void => {
      clearTimeout(operationTimer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      options.signal?.removeEventListener('abort', onAbort);
      this.#running.delete(running);
    };
    const settleSuccess = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveSettled(Buffer.concat(capturedOutput));
    };
    const settleSuccessfulClose = (): void => {
      if (successfulClose && pendingStreamWrites === 0 && inputSettled) {
        settleSuccess();
      }
    };
    const settleFailure = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectSettled(error);
    };
    const settleTerminated = (): void => {
      if (
        terminationCode !== undefined
        && childClosed
        && pendingStreamWrites === 0
        && inputSettled
      ) {
        settleFailure(inputFailure ?? new GitProcessError(terminationCode));
      }
    };
    const terminate = (code: GitProcessErrorCode): void => {
      if (settled || terminationCode !== undefined) return;
      terminationCode = code;
      streamController.abort();
      if (!childClosed) {
        signalProcessGroup(child, 'SIGTERM');
        terminationTimer = setTimeout(() => {
          if (!settled && !childClosed) signalProcessGroup(child, 'SIGKILL');
        }, TERMINATION_GRACE_MS);
        terminationTimer.unref();
      }
      settleTerminated();
    };
    const onAbort = (): void => terminate('cancelled');
    const countOutput = (chunk: Buffer, capture: boolean): void => {
      outputBytes += chunk.length;
      if (capture && outputBytes <= this.#outputMaxBytes) {
        capturedOutput.push(chunk);
      }
      if (outputBytes > this.#outputMaxBytes) terminate('output-limit');
    };
    const running: RunningGitProcess = Object.freeze({
      settled: settledPromise,
      terminate,
    });
    this.#running.add(running);

    const operationTimer = setTimeout(
      () => terminate('timeout'),
      options.timeoutMs === undefined
        ? this.#operationTimeoutMs
        : Math.min(this.#operationTimeoutMs, options.timeoutMs),
    );
    operationTimer.unref();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.inputStream === undefined) {
      child.stdin.end(options.input);
    } else {
      const inputStream = options.inputStream;
      void (async (): Promise<void> => {
        const iterator = inputStream[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await nextInputChunk(
              iterator,
              streamController.signal,
              () => terminationCode ?? options.failureCode,
            );
            if (next.done) break;
            const value = next.value;
            if (streamController.signal.aborted) {
              throw new GitProcessError(terminationCode ?? 'cancelled');
            }
            if (!(value instanceof Uint8Array)) {
              throw new GitProcessError(options.failureCode);
            }
            const chunk = Buffer.from(value);
            if (chunk.length === 0) continue;
            if (!child.stdin.write(chunk)) {
              await waitForDrain(
                child.stdin,
                streamController.signal,
                () => terminationCode ?? options.failureCode,
              );
            }
          }
          if (!streamController.signal.aborted && !child.stdin.destroyed) {
            child.stdin.end();
          }
        } catch (error: unknown) {
          inputFailure = error instanceof Error
            ? error
            : new GitProcessError(options.failureCode);
          terminate(terminationCode ?? options.failureCode);
        } finally {
          if (streamController.signal.aborted) await containIteratorReturn(iterator);
          inputSettled = true;
          settleSuccessfulClose();
          settleTerminated();
        }
      })();
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.stdoutStream === undefined) {
        countOutput(chunk, options.captureOutput);
        return;
      }
      streamedStdoutBytes += chunk.length;
      if (streamedStdoutBytes > options.stdoutStream.maximumBytes) {
        terminate('output-limit');
        return;
      }
      child.stdout.pause();
      pendingStreamWrites += 1;
      streamQueue = streamQueue
        .then(() => {
          if (terminationCode !== undefined) return;
          return options.stdoutStream?.onChunk(chunk, streamController.signal);
        })
        .then(
          () => {
            pendingStreamWrites -= 1;
            if (terminationCode === undefined) {
              if (pendingStreamWrites === 0) child.stdout.resume();
              settleSuccessfulClose();
            } else {
              settleTerminated();
            }
          },
          () => {
            pendingStreamWrites -= 1;
            terminate(options.failureCode);
            settleTerminated();
          },
        );
    });
    child.stderr.on('data', (chunk: Buffer) => {
      countOutput(chunk, false);
    });
    child.once('error', () => {
      childClosed = true;
      terminate('git-unavailable');
      settleTerminated();
    });
    child.once('close', (code, processSignal) => {
      childClosed = true;
      if (terminationCode !== undefined) {
        settleTerminated();
      } else if (processSignal !== null) {
        terminate('process-failed');
        settleTerminated();
      } else if ((options.acceptedExitCodes ?? [0]).includes(code ?? -1)) {
        successfulClose = true;
        settleSuccessfulClose();
      } else {
        terminate(options.failureCode);
        settleTerminated();
      }
    });
    return settledPromise;
  }
}
