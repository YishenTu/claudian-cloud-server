export type SafeLogEvent =
  | 'server.reconciliation-failed'
  | 'server.recovery-incomplete'
  | 'server.listening'
  | 'server.shutdown-failed'
  | 'server.starting'
  | 'server.startup-failed'
  | 'server.stopped'
  | 'server.stopping';

export type SafeLogLevel = 'error' | 'info' | 'warn';

export interface SafeLoggerOptions {
  readonly now: () => Date;
  readonly write: (line: string) => void;
}

type SafeLogContextValue = number | string;
type SafeLogContext = Readonly<Record<string, SafeLogContextValue>>;
type ContextRule = 'integer' | 'number' | 'token';

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CONTEXT_RULES: Readonly<Record<string, ContextRule>> = Object.freeze({
  durationMs: 'number',
  isolated: 'integer',
  offline: 'integer',
  waiting: 'integer',
  port: 'integer',
  protocolVersion: 'integer',
  reason: 'token',
  signal: 'token',
  state: 'token',
  statusCode: 'integer',
});

function sanitizeValue(rule: ContextRule, value: unknown): SafeLogContextValue | undefined {
  switch (rule) {
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    case 'token':
      return typeof value === 'string' && TOKEN_PATTERN.test(value)
        ? value
        : undefined;
  }
}

function sanitizeContext(context: Readonly<Record<string, unknown>>): SafeLogContext {
  const sanitized: Record<string, SafeLogContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    const rule = CONTEXT_RULES[key];
    if (rule === undefined) continue;
    const safeValue = sanitizeValue(rule, value);
    if (safeValue !== undefined) sanitized[key] = safeValue;
  }
  return Object.freeze(sanitized);
}

export class SafeLogger {
  readonly #now: () => Date;
  readonly #write: (line: string) => void;

  constructor(options: SafeLoggerOptions) {
    this.#now = options.now;
    this.#write = options.write;
  }

  error(event: SafeLogEvent, context: Readonly<Record<string, unknown>> = {}): void {
    this.#emit('error', event, context);
  }

  info(event: SafeLogEvent, context: Readonly<Record<string, unknown>> = {}): void {
    this.#emit('info', event, context);
  }

  warn(event: SafeLogEvent, context: Readonly<Record<string, unknown>> = {}): void {
    this.#emit('warn', event, context);
  }

  #emit(
    level: SafeLogLevel,
    event: SafeLogEvent,
    context: Readonly<Record<string, unknown>>,
  ): void {
    this.#write(`${JSON.stringify({
      context: sanitizeContext(context),
      event,
      level,
      timestamp: this.#now().toISOString(),
    })}\n`);
  }
}
