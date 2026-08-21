import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CoordinationError } from '../../src/coordination/CoordinationError.js';
import {
  developmentBootstrapUploadLockKey,
  projectLockKey,
} from '../../src/coordination/ProjectLockKey.js';

describe('projectLockKey', () => {
  it('matches the version-1 SHA-256 signed-big-endian specification literals', () => {
    assert.equal(projectLockKey('project-a'), 3_522_477_925_219_416_340n);
    assert.equal(projectLockKey('project-b'), 4_432_586_529_342_015_050n);
    assert.equal(projectLockKey('A'), -4_431_238_873_753_205_584n);
    assert.equal(
      projectLockKey('01HXTESTPROJECT00000000000000'),
      7_383_407_818_228_345_440n,
    );
  });

  it('derives a distinct attempt-scoped upload fence key', () => {
    assert.notEqual(
      developmentBootstrapUploadLockKey('project-a', 'attempt-a'),
      projectLockKey('project-a'),
    );
    assert.notEqual(
      developmentBootstrapUploadLockKey('project-a', 'attempt-a'),
      developmentBootstrapUploadLockKey('project-a', 'attempt-b'),
    );
  });

  it('rejects invalid Project IDs without reflecting them', () => {
    const secret = '../private-project';
    assert.throws(
      () => projectLockKey(secret),
      error => {
        assert.ok(error instanceof CoordinationError);
        assert.equal(error.code, 'invalid-project');
        assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
        return true;
      },
    );
  });
});
