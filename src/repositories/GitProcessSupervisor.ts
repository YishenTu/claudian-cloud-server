import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';

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

interface RunningGitProcess {
  readonly settled: Promise<unknown>;
  terminate(code: GitProcessErrorCode): void;
}

const TERMINATION_GRACE_MS = 250;
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
    if (output.trim() !== 'true') {
      throw new GitProcessError('repository-corrupt');
    }
  }

  async verifyVersion(): Promise<void> {
    const output = await this.#runProcess({
      arguments: ['--version'],
      captureOutput: true,
      cwd: undefined,
      failureCode: 'git-unavailable',
      signal: undefined,
    });
    const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output.trim());
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
    readonly arguments: readonly string[];
    readonly captureOutput: boolean;
    readonly cwd: string | undefined;
    readonly failureCode: GitProcessErrorCode;
    readonly signal: AbortSignal | undefined;
  }): Promise<string> {
    if (this.#closed) return Promise.reject(new GitProcessError('closed'));
    if (options.signal?.aborted === true) {
      return Promise.reject(new GitProcessError('cancelled'));
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.#gitExecutable,
        [...options.arguments],
        {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          detached: true,
          env: GIT_ENVIRONMENT,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch {
      return Promise.reject(new GitProcessError('git-unavailable'));
    }
    child.stdin.end();

    let rejectSettled!: (error: GitProcessError) => void;
    let resolveSettled!: (output: string) => void;
    let terminationCode: GitProcessErrorCode | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let outputBytes = 0;
    let settled = false;
    const capturedOutput: Buffer[] = [];

    const settledPromise = new Promise<string>((resolve, reject) => {
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
      resolveSettled(Buffer.concat(capturedOutput).toString('utf8'));
    };
    const settleFailure = (code: GitProcessErrorCode): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectSettled(new GitProcessError(code));
    };
    const terminate = (code: GitProcessErrorCode): void => {
      if (settled || terminationCode !== undefined) return;
      terminationCode = code;
      signalProcessGroup(child, 'SIGTERM');
      terminationTimer = setTimeout(() => {
        if (!settled) signalProcessGroup(child, 'SIGKILL');
      }, TERMINATION_GRACE_MS);
      terminationTimer.unref();
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
      this.#operationTimeoutMs,
    );
    operationTimer.unref();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      countOutput(chunk, options.captureOutput);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      countOutput(chunk, false);
    });
    child.once('error', () => settleFailure('git-unavailable'));
    child.once('close', (code, processSignal) => {
      if (terminationCode !== undefined) {
        settleFailure(terminationCode);
      } else if (processSignal !== null) {
        settleFailure('process-failed');
      } else if (code === 0) {
        settleSuccess();
      } else {
        settleFailure(options.failureCode);
      }
    });
    return settledPromise;
  }
}
