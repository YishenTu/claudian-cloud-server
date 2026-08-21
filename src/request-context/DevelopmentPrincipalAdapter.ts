import { isCollabMemberId } from '@claudian/collab-protocol';

import {
  createDevelopmentIngressPrincipal,
  type IngressPrincipal,
} from './IngressPrincipal.js';

export type DevelopmentPrincipalErrorCode =
  | 'invalid-assertion'
  | 'non-loopback'
  | 'unsupported-profile';

export class DevelopmentPrincipalError extends Error {
  readonly code: DevelopmentPrincipalErrorCode;

  constructor(code: DevelopmentPrincipalErrorCode) {
    super(`development-principal.error.${code}`);
    this.name = 'DevelopmentPrincipalError';
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

export interface DevelopmentPrincipalAdapterOptions {
  readonly profile: 'external' | 'loopback-development';
}

export interface DevelopmentPrincipalAssertion {
  readonly headerValues: readonly string[];
  readonly localAddress: string | undefined;
  readonly remoteAddress: string | undefined;
}

const LOOPBACK_ADDRESSES = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

export class DevelopmentPrincipalAdapter {
  readonly #profile: DevelopmentPrincipalAdapterOptions['profile'];

  constructor(options: DevelopmentPrincipalAdapterOptions) {
    this.#profile = options.profile;
  }

  bind(assertion: DevelopmentPrincipalAssertion): IngressPrincipal {
    if (this.#profile !== 'loopback-development') {
      throw new DevelopmentPrincipalError('unsupported-profile');
    }
    if (
      assertion.localAddress === undefined
      || assertion.remoteAddress === undefined
      || !LOOPBACK_ADDRESSES.has(assertion.localAddress)
      || !LOOPBACK_ADDRESSES.has(assertion.remoteAddress)
    ) {
      throw new DevelopmentPrincipalError('non-loopback');
    }
    const actorId = assertion.headerValues[0];
    if (
      assertion.headerValues.length !== 1
      || actorId === undefined
      || actorId.trim() !== actorId
      || !isCollabMemberId(actorId)
    ) {
      throw new DevelopmentPrincipalError('invalid-assertion');
    }
    return createDevelopmentIngressPrincipal(actorId);
  }
}
