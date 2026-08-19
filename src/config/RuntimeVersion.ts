const SUPPORTED_NODE_MAJOR = 24;

export class RuntimeVersionError extends Error {
  readonly code = 'unsupported-node-version' as const;

  constructor() {
    super('runtime.error.unsupported-node-version');
    this.name = 'RuntimeVersionError';
  }

  toJSON(): Readonly<Record<string, string>> {
    return {
      code: this.code,
      message: this.message,
      name: this.name,
    };
  }
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const major = Number.parseInt(version.split('.', 1)[0] ?? '', 10);
  if (major !== SUPPORTED_NODE_MAJOR) throw new RuntimeVersionError();
}
