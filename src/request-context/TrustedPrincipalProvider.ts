import {
  createTrustedIngressPrincipal,
  type IngressPrincipal,
} from './IngressPrincipal.js';

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class TrustedPrincipalError extends Error {
  readonly code = 'invalid-assertion' as const;

  constructor() {
    super('trusted-principal.error.invalid-assertion');
    this.name = 'TrustedPrincipalError';
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      name: this.name,
    });
  }
}

function dataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(descriptor => (
    descriptor.get !== undefined || descriptor.set !== undefined
  ))) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) return false;
  const keys = ownKeys as string[];
  const allowed = new Set([...required, ...optional]);
  return keys.length >= required.length
    && required.every(key => Object.hasOwn(value, key))
    && keys.every(key => allowed.has(key));
}

function opaqueId(value: unknown): string | undefined {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

export class TrustedPrincipalProvider {
  bind(assertion: unknown): IngressPrincipal {
    const source = dataRecord(assertion);
    if (
      source === undefined
      || !hasExactKeys(source, ['principalId', 'provenance'], ['deviceCredentialId'])
    ) throw new TrustedPrincipalError();

    const principalId = opaqueId(source.principalId);
    const deviceCredentialId = source.deviceCredentialId === undefined
      ? undefined
      : opaqueId(source.deviceCredentialId);
    const provenance = dataRecord(source.provenance);
    if (
      principalId === undefined
      || (source.deviceCredentialId !== undefined && deviceCredentialId === undefined)
      || provenance === undefined
      || !hasExactKeys(provenance, ['kind', 'providerId'])
      || provenance.kind !== 'operator-protected-channel'
    ) throw new TrustedPrincipalError();
    const providerId = opaqueId(provenance.providerId);
    if (providerId === undefined) throw new TrustedPrincipalError();

    return createTrustedIngressPrincipal({
      ...(deviceCredentialId === undefined ? {} : { deviceCredentialId }),
      principalId,
      providerId,
    });
  }
}
