import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CURRENT_POSTGRES_SCHEMA_VERSION,
  supportsPostgresSchemaVersion,
} from '../../src/config/PostgresSchemaCompatibility.js';
import { POSTGRES_SCHEMAS } from '../../src/coordination/postgres/PostgresSchema.js';

describe('Postgres schema compatibility', () => {
  it('declares one exact current schema', () => {
    assert.equal(CURRENT_POSTGRES_SCHEMA_VERSION, 11);
    assert.equal(
      POSTGRES_SCHEMAS.at(-1)?.version,
      CURRENT_POSTGRES_SCHEMA_VERSION,
    );
  });

  it('accepts only the current safe-integer version', () => {
    assert.equal(supportsPostgresSchemaVersion(11), true);
    for (const value of [10, 12, 11.5, Number.NaN, '11', undefined]) {
      assert.equal(supportsPostgresSchemaVersion(value), false);
    }
  });
});
