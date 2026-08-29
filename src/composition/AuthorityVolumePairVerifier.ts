import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getgid, getuid } from 'node:process';

const AUTHORITY_VOLUME_ID_PATTERN = /^[0-9a-f]{32}\n?$/u;
const AUTHORITY_DIRECTORY_MODE = 0o700;
const AUTHORITY_MARKER_MODE = 0o600;

export class AuthorityVolumePairError extends Error {
  constructor() {
    super('authority-volume-pair.error.mismatch');
    this.name = 'AuthorityVolumePairError';
  }
}

export interface AuthorityVolumeIdentityVerifier {
  verifyAuthorityVolumeId(expected: string): Promise<void>;
}

export interface AuthorityVolumePairVerifierOptions {
  readonly coordination: AuthorityVolumeIdentityVerifier;
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
}

export class AuthorityVolumePairVerifier {
  readonly #authorityRoot: string;
  readonly #coordination: AuthorityVolumeIdentityVerifier;

  constructor(options: AuthorityVolumePairVerifierOptions) {
    const repositoryAuthorityRoot = dirname(options.repositoryRoot);
    if (repositoryAuthorityRoot !== dirname(options.stagingRoot)) {
      throw new TypeError('authority-volume-pair.options-invalid');
    }
    this.#authorityRoot = repositoryAuthorityRoot;
    this.#coordination = options.coordination;
  }

  async verify(): Promise<string> {
    const markerPath = join(this.#authorityRoot, '.authority-volume-id');
    try {
      const [root, marker, value] = await Promise.all([
        lstat(this.#authorityRoot, { bigint: true }),
        lstat(markerPath, { bigint: true }),
        readFile(markerPath, 'utf8'),
      ]);
      const uid = getuid?.();
      const gid = getgid?.();
      if (
        uid === undefined
        || gid === undefined
        || !root.isDirectory()
        || root.isSymbolicLink()
        || root.uid !== BigInt(uid)
        || root.gid !== BigInt(gid)
        || Number(root.mode & 0o777n) !== AUTHORITY_DIRECTORY_MODE
        || !marker.isFile()
        || marker.isSymbolicLink()
        || marker.uid !== BigInt(uid)
        || marker.gid !== BigInt(gid)
        || Number(marker.mode & 0o777n) !== AUTHORITY_MARKER_MODE
        || !AUTHORITY_VOLUME_ID_PATTERN.test(value)
      ) {
        throw new AuthorityVolumePairError();
      }
      const authorityVolumeId = value.trim();
      await this.#coordination.verifyAuthorityVolumeId(authorityVolumeId);
      return authorityVolumeId;
    } catch (error: unknown) {
      if (error instanceof AuthorityVolumePairError) throw error;
      throw new AuthorityVolumePairError();
    }
  }
}
