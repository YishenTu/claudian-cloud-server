import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  parseOptionalContentLength,
  requestHeaderValues,
} from '../httpRequestHeaders.js';

export class GitSmartHttpRouteFailure extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`git-smart-http-route.failure.${String(status)}`);
    this.name = 'GitSmartHttpRouteFailure';
    this.status = status;
  }
}

export { requestHeaderValues as headerValues };

export function optionalContentLength(
  request: IncomingMessage,
): number | undefined {
  return parseOptionalContentLength(
    request,
    () => new GitSmartHttpRouteFailure(400),
  );
}

export function gitProtocol(
  request: IncomingMessage,
): 'version=1' | 'version=2' | undefined {
  const values = requestHeaderValues(request, 'git-protocol');
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
