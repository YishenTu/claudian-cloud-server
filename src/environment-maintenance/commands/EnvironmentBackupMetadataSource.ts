export interface EnvironmentBackupMetadata {
  readonly authorityId: string;
  readonly authorityVolumeIdentity: string;
  readonly restoreEpoch: number;
}

interface RestoreJournalFacts {
  readonly authorityId: unknown;
  readonly authorityVolumeId: unknown;
  readonly authorityVolumeIdentity: unknown;
  readonly phase: unknown;
  readonly restoreEpoch: unknown;
}

interface RestoreStateInspection {
  readonly journal: RestoreJournalFacts | undefined;
  readonly pair:
    | 'absent'
    | 'ambiguous'
    | Readonly<{ readonly authorityVolumeId: string }>;
}

export interface EnvironmentBackupMetadataSourceOptions {
  readonly state: Readonly<{
    inspect(): Promise<RestoreStateInspection>;
  }>;
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VOLUME_ID_PATTERN = /^[0-9a-f]{32}$/u;

function fail(): never {
  throw new Error('environment-backup-metadata.error.unavailable');
}

export class EnvironmentBackupMetadataSource {
  readonly #state: EnvironmentBackupMetadataSourceOptions['state'];

  constructor(options: EnvironmentBackupMetadataSourceOptions) {
    this.#state = options.state;
  }

  async read(): Promise<EnvironmentBackupMetadata> {
    const inspected = await this.#state.inspect();
    if (
      typeof inspected.pair !== 'object'
      || !VOLUME_ID_PATTERN.test(inspected.pair.authorityVolumeId)
    ) return fail();
    const journal = inspected.journal;
    if (journal === undefined) {
      return Object.freeze({
        authorityId: inspected.pair.authorityVolumeId,
        authorityVolumeIdentity: inspected.pair.authorityVolumeId,
        restoreEpoch: 1,
      });
    }
    if (
      journal.phase !== 'completed'
      || journal.authorityVolumeId !== inspected.pair.authorityVolumeId
      || typeof journal.authorityId !== 'string'
      || !IDENTITY_PATTERN.test(journal.authorityId)
      || typeof journal.authorityVolumeIdentity !== 'string'
      || !IDENTITY_PATTERN.test(journal.authorityVolumeIdentity)
      || typeof journal.restoreEpoch !== 'number'
      || !Number.isSafeInteger(journal.restoreEpoch)
      || journal.restoreEpoch <= 0
    ) return fail();
    return Object.freeze({
      authorityId: journal.authorityId,
      authorityVolumeIdentity: journal.authorityVolumeIdentity,
      restoreEpoch: journal.restoreEpoch,
    });
  }
}
