import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CollabError } from '@claudian-collab/protocol';

import type { ProjectMembershipAdministrationPersistence } from '../../src/coordination/ProjectMembershipPersistence.js';
import { ProjectMembershipAdministrationAuthority } from '../../src/project-authority/membership/ProjectMembershipAdministrationAuthority.js';
import { createVaultCredentialPrincipal } from '../../src/request-context/RequestPrincipal.js';

const NOW = '2026-08-30T05:00:00.000Z';
const PROJECT_ID = 'project-membership-admin';
const PRINCIPAL = createVaultCredentialPrincipal({
  principalId: 'principal-admin',
});

function offer(state: 'acknowledged' | 'offered' = 'offered') {
  return {
    acknowledgedAt: state === 'acknowledged' ? NOW : null,
    expiresAt: '2026-08-31T05:00:00.000Z',
    managerSetGenerationAtOffer: 1,
    offeredAt: NOW,
    offerId: 'offer-one',
    purpose: 'manager-promotion' as const,
    revision: state === 'acknowledged' ? 2 : 1,
    sourceManagerMemberId: 'member-manager',
    state,
    targetMemberId: 'member-target',
    targetMembershipRevisionAtOffer: 2,
    terminalAt: null,
  };
}

class MemoryAdministration implements ProjectMembershipAdministrationPersistence {
  readonly calls: string[] = [];
  status: 'created' | 'final-manager' | 'permanently-stale' | 'replayed' | 'stale' = 'created';

  listProjectMembers(input: Parameters<ProjectMembershipAdministrationPersistence['listProjectMembers']>[0]) {
    this.calls.push(`members:${input.actorRole}`);
    return Promise.resolve({
      managerSetGeneration: 1,
      members: [{
        bindingState: input.actorRole === 'manager' ? 'unbound' as const : 'hidden' as const,
        displayName: 'Target member',
        importedClaimState: input.actorRole === 'manager'
          ? 'original-active' as const : 'hidden' as const,
        importedClaimGeneration: input.actorRole === 'manager' ? 0 : null,
        memberId: 'member-target',
        membershipRevision: 2,
        role: 'member' as const,
      }],
      projectId: PROJECT_ID,
    });
  }

  createManagerResponsibilityOffer() {
    this.calls.push('create-offer');
    return Promise.resolve({ response: { offer: offer() }, status: this.status });
  }

  listCurrentManagerResponsibilityOffers() {
    this.calls.push('list-offers');
    return Promise.resolve([offer()]);
  }

  getManagerResponsibilityOffer() {
    this.calls.push('get-offer');
    return Promise.resolve(offer());
  }

  transitionManagerResponsibilityOffer(input: Parameters<ProjectMembershipAdministrationPersistence['transitionManagerResponsibilityOffer']>[0]) {
    this.calls.push(input.operation);
    return Promise.resolve({ response: { offer: offer('acknowledged') }, status: this.status });
  }

  promoteManager() {
    this.calls.push('promote');
    return Promise.resolve({
      response: {
        managerSetGeneration: 2,
        membershipRevision: 3,
        offerRevision: 3,
        projectId: PROJECT_ID,
        promotedMemberId: 'member-target',
      },
      status: this.status,
    });
  }

  demoteManager() {
    this.calls.push('demote');
    return Promise.resolve({
      response: {
        demotedMemberId: 'member-target',
        managerSetGeneration: 2,
        membershipRevision: 3,
        projectId: PROJECT_ID,
      },
      status: this.status,
    });
  }
}

function fixture(role: 'manager' | 'member' = 'manager') {
  const persistence = new MemoryAdministration();
  const writeAdmission = {
    run: async <T>(_principal: unknown, _projectId: unknown, operation: (write: unknown) => Promise<T>) => (
      operation({
        memberId: role === 'manager' ? 'member-manager' : 'member-target',
        role,
        transact: <U>(transaction: (scope: { membership: ProjectMembershipAdministrationPersistence; appendProjectEvent(): Promise<unknown> }) => Promise<U>) => transaction({
          appendProjectEvent: () => Promise.resolve({}),
          membership: persistence,
        }),
      })
    ),
  };
  return {
    authority: new ProjectMembershipAdministrationAuthority({
      clock: () => new Date(NOW),
      offerIdFactory: () => 'offer-one',
      writeAdmission: writeAdmission as never,
    }),
    persistence,
  };
}

describe('ProjectMembershipAdministrationAuthority', () => {
  it('redacts administrative member state for ordinary Members', async () => {
    const ordinary = fixture('member');
    const result = await ordinary.authority.listMembers(PRINCIPAL, { projectId: PROJECT_ID });
    const member = result.members[0];
    assert.ok(member);
    assert.equal(member.bindingState, 'hidden');
    assert.equal(member.importedClaimState, 'hidden');
    assert.equal(JSON.stringify(result).includes('principal'), false);
  });

  it('runs durable offer acknowledgement and exact promotion without presence', async () => {
    const { authority, persistence } = fixture();
    assert.equal((await authority.createOffer(PRINCIPAL, {
      expectedManagerSetGeneration: 1,
      expectedTargetMembershipRevision: 2,
      idempotencyKey: 'offer-key',
      projectId: PROJECT_ID,
      purpose: 'manager-promotion',
      targetMemberId: 'member-target',
    })).offer.state, 'offered');
    assert.equal((await authority.acknowledgeOffer(PRINCIPAL, {
      expectedOfferRevision: 1,
      idempotencyKey: 'ack-key',
      offerId: 'offer-one',
      projectId: PROJECT_ID,
    })).offer.state, 'acknowledged');
    assert.deepEqual(await authority.promote(PRINCIPAL, {
      expectedManagerSetGeneration: 1,
      expectedOfferRevision: 2,
      expectedTargetMembershipRevision: 2,
      idempotencyKey: 'promote-key',
      managerResponsibilityOfferId: 'offer-one',
      projectId: PROJECT_ID,
      targetMemberId: 'member-target',
    }), {
      managerSetGeneration: 2,
      membershipRevision: 3,
      offerRevision: 3,
      projectId: PROJECT_ID,
      promotedMemberId: 'member-target',
    });
    assert.deepEqual(persistence.calls, ['create-offer', 'acknowledgeManagerResponsibility', 'promote']);
  });

  it('preserves proven negative settlement without promoting ambiguous errors', async () => {
    const request = {
      expectedManagerSetGeneration: 1, expectedTargetMembershipRevision: 2,
      idempotencyKey: 'demote-negative', projectId: PROJECT_ID, targetMemberId: 'member-target',
    };
    for (const status of ['permanently-stale', 'stale', 'final-manager'] as const) {
      const { authority, persistence } = fixture();
      persistence.status = status;
      await assert.rejects(authority.demote(PRINCIPAL, request), {
        code: 'authority-not-synchronized',
        name: status === 'permanently-stale' ? 'ProjectMutationRejection' : 'CollabError',
      });
    }
  });

  it('maps stale state and final-Manager demotion to fixed canonical errors', async () => {
    const stale = fixture();
    stale.persistence.status = 'stale';
    await assert.rejects(stale.authority.demote(PRINCIPAL, {
      expectedManagerSetGeneration: 1,
      expectedTargetMembershipRevision: 2,
      idempotencyKey: 'demote-key',
      projectId: PROJECT_ID,
      targetMemberId: 'member-target',
    }), (error: unknown) => error instanceof CollabError
      && error.code === 'authority-not-synchronized');
    const finalManager = fixture();
    finalManager.persistence.status = 'final-manager';
    await assert.rejects(finalManager.authority.demote(PRINCIPAL, {
      expectedManagerSetGeneration: 1,
      expectedTargetMembershipRevision: 2,
      idempotencyKey: 'demote-key',
      projectId: PROJECT_ID,
      targetMemberId: 'member-target',
    }), (error: unknown) => error instanceof CollabError
      && error.code === 'authority-not-synchronized');
  });
});
