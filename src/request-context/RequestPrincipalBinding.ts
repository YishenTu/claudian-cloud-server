import type { IncomingMessage } from 'node:http';

import type { DevelopmentPrincipalAdapter } from './DevelopmentPrincipalAdapter.js';
import type { IngressPrincipal } from './IngressPrincipal.js';
import type { TrustedPrincipalProvider } from './TrustedPrincipalProvider.js';

export interface TrustedProjectPrincipalBinding {
  readonly establishedAssertion: (request: IncomingMessage) => unknown;
  readonly provider: TrustedPrincipalProvider;
}

export interface RequestPrincipalBindingOptions {
  readonly principalAdapter?: DevelopmentPrincipalAdapter;
  readonly trustedPrincipal?: TrustedProjectPrincipalBinding;
}

export class RequestPrincipalBindingError extends Error {
  constructor() {
    super('request-principal-binding.error.invalid-assertion');
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
    if (
      name?.toLocaleLowerCase('en-US') === expectedName
      && value !== undefined
    ) values.push(value);
  }
  return values;
}

export class RequestPrincipalBinding {
  readonly #principalAdapter: DevelopmentPrincipalAdapter | undefined;
  readonly #trustedPrincipal: TrustedProjectPrincipalBinding | undefined;

  constructor(options: RequestPrincipalBindingOptions) {
    if (
      (options.principalAdapter === undefined)
      === (options.trustedPrincipal === undefined)
    ) throw new TypeError('request-principal-binding.options-invalid');
    this.#principalAdapter = options.principalAdapter;
    this.#trustedPrincipal = options.trustedPrincipal;
  }

  bind(request: IncomingMessage): IngressPrincipal {
    try {
      if (this.#trustedPrincipal !== undefined) {
        return this.#trustedPrincipal.provider.bind(
          this.#trustedPrincipal.establishedAssertion(request),
        );
      }
      const adapter = this.#principalAdapter;
      if (adapter === undefined) throw new RequestPrincipalBindingError();
      return adapter.bind({
        headerValues: headerValues(request, 'x-claudian-development-actor'),
        localAddress: request.socket.localAddress,
        remoteAddress: request.socket.remoteAddress,
      });
    } catch {
      throw new RequestPrincipalBindingError();
    }
  }
}
