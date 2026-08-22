import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class GitSmartHttpRouteFailure extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`git-smart-http-route.failure.${String(status)}`);
    this.name = 'GitSmartHttpRouteFailure';
    this.status = status;
  }
}

export function headerValues(
  request: IncomingMessage,
  expectedName: string,
): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLocaleLowerCase('en-US') === expectedName && value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

export function optionalContentLength(
  request: IncomingMessage,
): number | undefined {
  const values = headerValues(request, 'content-length');
  if (values.length === 0) return undefined;
  const value = values[0];
  if (
    values.length !== 1
    || value === undefined
    || !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    throw new GitSmartHttpRouteFailure(400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new GitSmartHttpRouteFailure(400);
  return parsed;
}

export function gitProtocol(
  request: IncomingMessage,
): 'version=1' | 'version=2' | undefined {
  const values = headerValues(request, 'git-protocol');
  if (values.length === 0) return undefined;
  if (
    values.length !== 1
    || (values[0] !== 'version=1' && values[0] !== 'version=2')
  ) {
    throw new GitSmartHttpRouteFailure(400);
  }
  return values[0];
}

export async function nextRequestChunk(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) throw new GitSmartHttpRouteFailure(408);
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new GitSmartHttpRouteFailure(408));
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

export async function waitForDrain(
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) {
    throw new GitSmartHttpRouteFailure(408);
  }
  let abortListener: (() => void) | undefined;
  try {
    await Promise.race([
      once(response, 'drain').then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new GitSmartHttpRouteFailure(408));
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
