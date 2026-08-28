import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CURRENT_POSTGRES_SCHEMA_VERSION,
  RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY,
  supportsPostgresSchemaVersion,
} from '../../src/config/PostgresSchemaCompatibility.js';
import { POSTGRES_SCHEMAS } from '../../src/coordination/postgres/PostgresSchema.js';

describe('Postgres schema compatibility', () => {
  it('declares one immutable exact runtime schema interval', () => {
    assert.equal(CURRENT_POSTGRES_SCHEMA_VERSION, 9);
    assert.deepEqual(RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY, {
      maximumVersion: 9,
      minimumVersion: 9,
    });
    assert.equal(Object.isFrozen(RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY), true);
    assert.equal(
      POSTGRES_SCHEMAS.at(-1)?.version,
      CURRENT_POSTGRES_SCHEMA_VERSION,
    );
  });

  it('accepts only safe integer versions inside the declared interval', () => {
    assert.equal(supportsPostgresSchemaVersion(9), true);
    for (const value of [8, 10, 9.5, Number.NaN, '9', undefined]) {
      assert.equal(supportsPostgresSchemaVersion(value), false);
    }
  });
});
