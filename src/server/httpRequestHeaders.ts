import type { IncomingMessage } from 'node:http';

export function requestHeaderValues(
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

export function parseOptionalContentLength(
  request: IncomingMessage,
  invalid: () => Error,
): number | undefined {
  const values = requestHeaderValues(request, 'content-length');
  if (values.length === 0) return undefined;
  const value = values[0];
  if (
    values.length !== 1
    || value === undefined
    || !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    throw invalid();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalid();
  return parsed;
}
