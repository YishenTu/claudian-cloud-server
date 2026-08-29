import { Client } from 'pg';

import type { EnvironmentRestoreTargetPort } from './EnvironmentRestoreCommand.js';

export interface PostgresEnvironmentRestoreTargetOptions {
  readonly connectionString: string;
  readonly createClient?: () => PostgresEnvironmentRestoreTargetClient;
}

export interface PostgresEnvironmentRestoreTargetClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string): Promise<{
    readonly rows: readonly {
      readonly authority_volume_id: string | null;
    }[];
  }>;
}

const VOLUME_ID_PATTERN = /^[0-9a-f]{32}$/u;

function fail(): never {
  throw new Error('postgres-environment-restore-target.error.unavailable');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) fail();
}

/** Reads the pre-provisioned target identity without publishing its file marker. */
export class PostgresEnvironmentRestoreTarget
implements EnvironmentRestoreTargetPort {
  readonly #createClient: () => PostgresEnvironmentRestoreTargetClient;

  constructor(options: PostgresEnvironmentRestoreTargetOptions) {
    if (options.connectionString.length === 0) {
      throw new TypeError('postgres-environment-restore-target.options-invalid');
    }
    this.#createClient = options.createClient ?? (() => {
      const client = new Client({ connectionString: options.connectionString });
      return {
        connect: async () => {
          await client.connect();
        },
        end: () => client.end(),
        query: (sql) => client.query<{ readonly authority_volume_id: string | null }>(sql),
      };
    });
  }

  async read(signal: AbortSignal): ReturnType<EnvironmentRestoreTargetPort['read']> {
    assertActive(signal);
    const client = this.#createClient();
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= client.end().catch(() => undefined);
      return closePromise;
    };
    const abort = (): void => {
      void close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect();
      assertActive(signal);
      const result = await client.query(
        `SELECT current_setting(
           'claudian_cloud.authority_volume_id',
           true
         ) AS authority_volume_id`,
      );
      const authorityVolumeId = result.rows[0]?.authority_volume_id;
      if (
        authorityVolumeId === null
        || authorityVolumeId === undefined
        || !VOLUME_ID_PATTERN.test(authorityVolumeId)
      ) return fail();
      return Object.freeze({
        authorityVolumeId,
        authorityVolumeIdentity: authorityVolumeId,
      });
    } catch {
      return fail();
    } finally {
      signal.removeEventListener('abort', abort);
      await close();
    }
  }
}
