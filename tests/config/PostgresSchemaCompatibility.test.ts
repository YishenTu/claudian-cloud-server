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
    assert.equal(CURRENT_POSTGRES_SCHEMA_VERSION, 10);
    assert.deepEqual(RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY, {
      maximumVersion: 10,
      minimumVersion: 10,
    });
    assert.equal(Object.isFrozen(RUNTIME_POSTGRES_SCHEMA_COMPATIBILITY), true);
    assert.equal(
      POSTGRES_SCHEMAS.at(-1)?.version,
      CURRENT_POSTGRES_SCHEMA_VERSION,
    );
  });

  it('accepts only the immediate predecessor for offline upgrade maintenance', () => {
    assert.deepEqual(MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY, {
      maximumVersion: 10,
      minimumVersion: 9,
    });
    assert.equal(
      supportsPostgresSchemaVersion(
        9,
        MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY,
      ),
      true,
    );
    assert.equal(
      supportsPostgresSchemaVersion(
        8,
        MAINTENANCE_POSTGRES_SCHEMA_COMPATIBILITY,
      ),
      false,
    );
  });

  it('accepts only safe integer versions inside the declared interval', () => {
    assert.equal(supportsPostgresSchemaVersion(10), true);
    for (const value of [9, 11, 10.5, Number.NaN, '10', undefined]) {
      assert.equal(supportsPostgresSchemaVersion(value), false);
    }
  });
});
