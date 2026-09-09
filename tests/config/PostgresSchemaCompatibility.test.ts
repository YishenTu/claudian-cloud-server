import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CURRENT_POSTGRES_SCHEMA_VERSION,
  supportsPostgresSchemaVersion,
} from '../../src/config/PostgresSchemaCompatibility.js';
import { CURRENT_POSTGRES_SCHEMA } from '../../src/coordination/postgres/PostgresSchema.js';

describe('Postgres schema compatibility', () => {
  it('declares one exact current schema', () => {
    assert.equal(CURRENT_POSTGRES_SCHEMA_VERSION, 12);
    assert.equal(
      CURRENT_POSTGRES_SCHEMA.version,
      CURRENT_POSTGRES_SCHEMA_VERSION,
    );
  });

  it('accepts only the current safe-integer version', () => {
    assert.equal(supportsPostgresSchemaVersion(12), true);
    for (const value of [11, 13, 12.5, Number.NaN, '12', undefined]) {
      assert.equal(supportsPostgresSchemaVersion(value), false);
    }
  });
});
