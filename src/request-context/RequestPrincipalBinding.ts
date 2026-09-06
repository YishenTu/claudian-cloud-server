import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { DevelopmentPrincipalAdapter } from './DevelopmentPrincipalAdapter.js';
import { createVaultCredentialPrincipal, type RequestPrincipal } from './RequestPrincipal.js';

export interface RequestPrincipalBindingOptions {
  readonly principalAdapter?: DevelopmentPrincipalAdapter;
}

export class RequestPrincipalBindingError extends Error {
  constructor() {
    super('request-principal-binding.error.invalid-credential');
    this.name = 'RequestPrincipalBindingError';
  }
}

function headerValues(
  request: IncomingMessage,
  expectedName: string,
): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLowerCase() === expectedName && value !== undefined) values.push(value);
  }
  return values;
}

export class RequestPrincipalBinding {
  readonly #principalAdapter: DevelopmentPrincipalAdapter | undefined;

  constructor(options: RequestPrincipalBindingOptions) {
    this.#principalAdapter = options.principalAdapter;
  }

  bind(request: IncomingMessage): RequestPrincipal {
    try {
      if (this.#principalAdapter !== undefined) {
        return this.#principalAdapter.bind({
          headerValues: headerValues(request, 'x-claudian-development-actor'),
          localAddress: request.socket.localAddress,
          remoteAddress: request.socket.remoteAddress,
        });
      }
      const values = headerValues(request, 'authorization');
      const value = values[0];
      if (
        values.length !== 1
        || value === undefined
        || value.slice(0, 7).toLowerCase() !== 'bearer '
        || !/^[a-f0-9]{64}$/u.test(value.slice(7))
      ) {
        throw new RequestPrincipalBindingError();
      }
      const principalId = `vault-${createHash('sha256').update(value.slice(7), 'utf8').digest('hex')}`;
      return createVaultCredentialPrincipal({ principalId });
    } catch {
      throw new RequestPrincipalBindingError();
    }
  }
}
