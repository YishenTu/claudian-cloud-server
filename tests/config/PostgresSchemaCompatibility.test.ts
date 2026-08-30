import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CURRENT_POSTGRES_SCHEMA_VERSION,
  MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY,
  RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY,
  supportsPostgresSchemaVersion,
} from '../../src/config/PostgresSchemaCompatibility.js';
import { POSTGRES_SCHEMAS } from '../../src/coordination/postgres/PostgresSchema.js';

describe('Postgres schema compatibility', () => {
  it('declares one immutable exact runtime schema interval', () => {
    assert.equal(CURRENT_POSTGRES_SCHEMA_VERSION, 11);
    assert.deepEqual(RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY, {
      maximumVersion: 11,
      minimumVersion: 11,
    });
    assert.equal(Object.isFrozen(RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY), true);
    assert.equal(
      POSTGRES_SCHEMAS.at(-1)?.version,
      CURRENT_POSTGRES_SCHEMA_VERSION,
    );
  });

  it('accepts only the immediate predecessor for offline upgrade maintenance', () => {
    assert.deepEqual(MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY, {
      maximumVersion: 11,
      minimumVersion: 10,
    });
    assert.equal(
      supportsPostgresSchemaVersion(
        10,
        MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY,
      ),
      true,
    );
    assert.equal(
      supportsPostgresSchemaVersion(
        9,
        MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY,
      ),
      false,
    );
  });

  it('accepts only safe integer versions inside the declared interval', () => {
    assert.equal(supportsPostgresSchemaVersion(11), true);
    for (const value of [10, 12, 11.5, Number.NaN, '11', undefined]) {
      assert.equal(supportsPostgresSchemaVersion(value), false);
    }
  });
});
