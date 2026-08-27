import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defaultAuthorityTransferExpiresAt,
  selectAuthorityTransferExpiresAt,
} from '../../src/project-authority/lifecycle/AuthorityTransferExpiry.js';

describe('authority transfer expiry', () => {
  it('owns the exact 30-day policy and rejects non-forward selections', () => {
    const createdAt = '2026-08-27T00:00:00.000Z';
    assert.equal(
      defaultAuthorityTransferExpiresAt(createdAt),
      '2026-09-26T00:00:00.000Z',
    );
    assert.equal(
      selectAuthorityTransferExpiresAt(value => value, createdAt),
      undefined,
    );
  });
});
