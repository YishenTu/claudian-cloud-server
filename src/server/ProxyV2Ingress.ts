import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d,
  0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);
const FIXED_HEADER_BYTES = 16;
const IPV4_ADDRESS_BYTES = 12;
const IPV6_ADDRESS_BYTES = 36;

export interface ProxyV2IngressOptions {
  readonly preambleTimeoutMs: number;
  readonly allowedSources: readonly string[];
  readonly providerId: string;
}

/** Consumes only operator-supplied PROXY v2 framing and retains no address metadata. */
export class ProxyV2Ingress {
  readonly #admitted = new WeakSet<Socket>();
  readonly #preambleTimeoutMs: number;
  readonly #allowedSources: ReadonlySet<string>;
  readonly #providerId: string;

  constructor(options: ProxyV2IngressOptions) {
    if (
      !Number.isSafeInteger(options.preambleTimeoutMs)
      || options.preambleTimeoutMs < 1
      || options.preambleTimeoutMs > 60_000
    ) throw new TypeError('proxy-v2-ingress.preamble-timeout-invalid');
    this.#preambleTimeoutMs = options.preambleTimeoutMs;
    this.#allowedSources = new Set(options.allowedSources);
    this.#providerId = options.providerId;
  }

  establishedAssertion(request: IncomingMessage): unknown {
    if (!this.#admitted.has(request.socket)) return undefined;
    const principal = assertionHeader(request, 'x-claudian-ingress-principal');
    const device = assertionHeader(request, 'x-claudian-ingress-device-credential');
    if (principal === undefined || principal === null || device === null) return undefined;
    return {
      principalId: principal,
      ...(device === undefined ? {} : { deviceCredentialId: device }),
      provenance: {
        kind: 'operator-protected-channel',
        providerId: this.#providerId,
      },
    };
  }

  accept(socket: Socket, acceptHttp: (socket: Socket) => void): void {
    socket.pause();
    let buffered = Buffer.alloc(0);
    let parsed: number | undefined;
    let settled = false;
    const timeout = setTimeout(() => reject(), this.#preambleTimeoutMs);
    timeout.unref();

    const clearPreambleListeners = (retainError: boolean): void => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('end', onEnd);
      if (!retainError) {
        socket.off('close', onClose);
        socket.off('error', onError);
      }
    };

    const reject = (): void => {
      if (settled) return;
      settled = true;
      clearPreambleListeners(true);
      socket.destroy();
    };
    const accept = (bytes: Buffer, admitted = false): void => {
      if (settled) return;
      settled = true;
      clearPreambleListeners(false);
      if (admitted) this.#admitted.add(socket);
      if (bytes.length > 0) socket.unshift(bytes);
      acceptHttp(socket);
      socket.resume();
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (parsed === undefined) {
        const prefixLength = Math.min(buffered.length, SIGNATURE.length);
        if (!buffered.subarray(0, prefixLength).equals(SIGNATURE.subarray(0, prefixLength))) {
          accept(buffered);
          return;
        }
        if (buffered.length < FIXED_HEADER_BYTES) return;
        const family = buffered[13];
        const expectedAddressBytes = family === 0x11
          ? IPV4_ADDRESS_BYTES
          : family === 0x21
            ? IPV6_ADDRESS_BYTES
            : undefined;
        if (
          buffered[12] !== 0x21
          || expectedAddressBytes === undefined
          || buffered.readUInt16BE(14) !== expectedAddressBytes
        ) {
          reject();
          return;
        }
        if (buffered.length < FIXED_HEADER_BYTES + expectedAddressBytes) return;
        parsed = this.#parseHeader(buffered);
        if (parsed === undefined) {
          reject();
          return;
        }
      }
      if (buffered.length <= parsed) return;
      const remainder = buffered.subarray(parsed);
      const prefixLength = Math.min(remainder.length, SIGNATURE.length);
      if (remainder.subarray(0, prefixLength).equals(SIGNATURE.subarray(0, prefixLength))) {
        if (remainder.length < SIGNATURE.length) return;
        reject();
        return;
      }
      accept(remainder, true);
    };
    const onEnd = (): void => reject();
    const onError = (): void => reject();
    const onClose = (): void => {
      clearPreambleListeners(false);
      settled = true;
    };

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.resume();
  }

  #parseHeader(
    value: Buffer,
  ): number | undefined {
    const family = value[13];
    const expectedAddressBytes = family === 0x11
      ? IPV4_ADDRESS_BYTES
      : family === 0x21
        ? IPV6_ADDRESS_BYTES
        : undefined;
    if (value[12] !== 0x21 || expectedAddressBytes === undefined) return undefined;
    const addressBytes = value.readUInt16BE(14);
    if (addressBytes !== expectedAddressBytes) return undefined;
    const totalBytes = FIXED_HEADER_BYTES + addressBytes;
    const sourceAddress = family === 0x11
      ? ipv4Address(value.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + 4))
      : ipv6Address(value.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + 16));
    return this.#allowedSources.has(sourceAddress) ? totalBytes : undefined;
  }
}

function ipv4Address(value: Buffer): string {
  return [...value].join('.');
}

function ipv6Address(value: Buffer): string {
  if (
    value.subarray(0, 10).every(byte => byte === 0)
    && value[10] === 0xff
    && value[11] === 0xff
  ) return `::ffff:${ipv4Address(value.subarray(12, 16))}`;
  const groups = Array.from({ length: 8 }, (_unused, index) => (
    value.readUInt16BE(index * 2).toString(16)
  ));
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== '0') {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < groups.length && groups[end] === '0') end += 1;
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  if (bestStart < 0) return groups.join(':');
  const left = groups.slice(0, bestStart).join(':');
  const right = groups.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

function assertionHeader(request: IncomingMessage, name: string): string | null | undefined {
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue;
    if (value !== undefined) return null;
    value = request.rawHeaders[index + 1];
  }
  return value;
}
