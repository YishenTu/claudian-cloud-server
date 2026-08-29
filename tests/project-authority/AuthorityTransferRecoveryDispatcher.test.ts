import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ProjectLifecycleJournalRecord,
} from '../../src/coordination/PortabilityLifecyclePersistence.js';
import type {
  ProjectLifecycleRecoveryOwner,
} from '../../src/project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import {
  AuthorityTransferRecoveryDispatcher,
} from '../../src/project-authority/lifecycle/AuthorityTransferRecoveryDispatcher.js';

const CREATED_AT = '2026-08-28T00:00:00.000Z';

function journal(
  direction: 'cloud-to-lan' | 'lan-to-cloud',
): ProjectLifecycleJournalRecord {
  return Object.freeze({
    actorMemberId: 'member-manager',
    batchRevision: undefined,
    batchSha256: undefined,
    checkpointSha256: undefined,
    createdAt: CREATED_AT,
    direction,
    expectedAuthorityGeneration: 3,
    idempotencyKey: 'transfer-intent',
    kind: 'authority-transfer',
    operationId: 'transfer-a',
    phase: 'lan-activated',
    projectId: 'project-a',
    recoveryFromPhase: undefined,
    requestFingerprint: 'a'.repeat(64),
    resultSha256: undefined,
    scheduledAt: CREATED_AT,
    state: 'active',
    updatedAt: CREATED_AT,
  });
}

describe('AuthorityTransferRecoveryDispatcher', () => {
  it('delegates reservation and recovery to the journal direction owner', async () => {
    const events: string[] = [];
    const reservation = Object.freeze({ close: () => Promise.resolve() });
    const owner = (name: string): ProjectLifecycleRecoveryOwner => ({
      reserveRecovery: (_projectId, observed) => {
        events.push(`${name}:reserve:${String(observed.direction)}`);
        return Promise.resolve(reservation);
      },
      recover: input => {
        events.push(`${name}:recover:${String(input.journal.direction)}`);
        return Promise.resolve(
          name === 'cloud' ? 'settled' : 'waiting-for-external-proof',
        );
      },
    });
    const dispatcher = new AuthorityTransferRecoveryDispatcher({
      cloudToLan: owner('cloud'),
      lanToCloud: owner('lan'),
    });

    for (const direction of ['cloud-to-lan', 'lan-to-cloud'] as const) {
      const observed = journal(direction);
      assert.equal(
        await dispatcher.reserveRecovery(observed.projectId, observed),
        reservation,
      );
      assert.equal(await dispatcher.recover({
        journal: observed,
        lease: {} as never,
        repositoryReservation: reservation,
      }), direction === 'cloud-to-lan'
        ? 'settled'
        : 'waiting-for-external-proof');
    }

    assert.deepEqual(events, [
      'cloud:reserve:cloud-to-lan',
      'cloud:recover:cloud-to-lan',
      'lan:reserve:lan-to-cloud',
      'lan:recover:lan-to-cloud',
    ]);
  });

  it('fails closed for a non-transfer or missing direction', () => {
    const unexpected: ProjectLifecycleRecoveryOwner = {
      recover: () => Promise.reject(new Error('unexpected-owner')),
    };
    const dispatcher = new AuthorityTransferRecoveryDispatcher({
      cloudToLan: unexpected,
      lanToCloud: unexpected,
    });
    const invalid = Object.freeze({
      ...journal('cloud-to-lan'),
      direction: undefined,
    });

    assert.throws(
      () => dispatcher.recover({ journal: invalid, lease: {} as never }),
      /project-recovery\.error\.dependency-failed/u,
    );
  });
});
