import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defaultAuthorityTransferExpiresAt,
} from '../../src/project-authority/lifecycle/AuthorityTransferExpiry.js';
import type {
  LanToCloudTransferCoordinatorOptions,
} from '../../src/project-authority/lifecycle/lan-to-cloud/LanToCloudTransferCoordinator.js';
import type {
  CloudToLanTransferCoordinatorOptions,
} from '../../src/project-authority/lifecycle/cloud-to-lan/CloudToLanTransferCoordinator.js';

describe('authority transfer expiry', () => {
  it('owns the exact, non-overridable 30-day policy', () => {
    const createdAt = '2026-08-27T00:00:00.000Z';
    assert.equal(
      defaultAuthorityTransferExpiresAt(createdAt),
      '2026-09-26T00:00:00.000Z',
    );
    const lanOptions = {
      // @ts-expect-error expiry policy is not a composition option
      expiresAtFactory: () => createdAt,
    } satisfies Partial<LanToCloudTransferCoordinatorOptions>;
    const cloudOptions = {
      // @ts-expect-error expiry policy is not a composition option
      expiresAtFactory: () => createdAt,
    } satisfies Partial<CloudToLanTransferCoordinatorOptions>;
    assert.deepEqual([lanOptions, cloudOptions].map(Object.keys), [
      ['expiresAtFactory'],
      ['expiresAtFactory'],
    ]);
  });
});
