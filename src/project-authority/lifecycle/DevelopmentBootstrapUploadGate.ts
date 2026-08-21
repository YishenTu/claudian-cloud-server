export type DevelopmentBootstrapUploadGateErrorCode = 'closed';

export class DevelopmentBootstrapUploadGateError extends Error {
  readonly code: DevelopmentBootstrapUploadGateErrorCode;

  constructor(code: DevelopmentBootstrapUploadGateErrorCode) {
    super(`development-bootstrap-upload-gate.error.${code}`);
    this.name = 'DevelopmentBootstrapUploadGateError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
    });
  }
}

export interface DevelopmentBootstrapUploadLease {
  release(): void;
}

interface AttemptGate {
  active: number;
  closed: boolean;
  readonly drained: Promise<void>;
  readonly resolveDrained: () => void;
}

function createAttemptGate(): AttemptGate {
  let resolveDrained = (): void => undefined;
  const drained = new Promise<void>(resolve => {
    resolveDrained = resolve;
  });
  return {
    active: 0,
    closed: false,
    drained,
    resolveDrained,
  };
}

export class DevelopmentBootstrapUploadGate {
  readonly #attempts = new Map<string, AttemptGate>();

  acquire(attemptId: string): DevelopmentBootstrapUploadLease {
    const gate = this.#attempts.get(attemptId) ?? createAttemptGate();
    if (gate.closed) throw new DevelopmentBootstrapUploadGateError('closed');
    this.#attempts.set(attemptId, gate);
    gate.active += 1;
    let released = false;
    return Object.freeze({
      release: (): void => {
        if (released) return;
        released = true;
        gate.active -= 1;
        if (gate.active !== 0) return;
        if (gate.closed) gate.resolveDrained();
        if (this.#attempts.get(attemptId) === gate) {
          this.#attempts.delete(attemptId);
        }
      },
    });
  }

  closeAndDrain(attemptId: string): Promise<void> {
    const gate = this.#attempts.get(attemptId) ?? createAttemptGate();
    this.#attempts.set(attemptId, gate);
    gate.closed = true;
    if (gate.active === 0) {
      gate.resolveDrained();
      this.#attempts.delete(attemptId);
    }
    return gate.drained;
  }
}
