export type CoordinationErrorCode =
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'dependency-failed'
  | 'invalid-member'
  | 'invalid-project'
  | 'lease-busy'
  | 'schema-incompatible';

export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode;
  readonly retryable: boolean;

  constructor(code: CoordinationErrorCode) {
    super(`coordination.error.${code}`);
    this.name = 'CoordinationError';
    this.code = code;
    this.retryable = code === 'busy' || code === 'lease-busy';
  }

  toJSON(): Readonly<Record<string, boolean | string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
      retryable: this.retryable,
    });
  }
}
