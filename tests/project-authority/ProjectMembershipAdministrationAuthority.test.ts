import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CollabError } from '@claudian-collab/protocol';

import type { ProjectMembershipAdministrationPersistence, ProjectMembershipResultPersistence, ManagerRoleChangeInput, TransitionResponsibilityOfferInput } from '../../src/coordination/ProjectMembershipPersistence.js';
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

class MemoryAdministration implements ProjectMembershipAdministrationPersistence, ProjectMembershipResultPersistence {
  managerSetGeneration = 1;
  targetRevision = 2n;
  targetRole: 'member' | 'manager' = 'member';
  managerCount = 2;
  currentOffer: ReturnType<typeof offer> | undefined;
  readonly results = new Map<string, { requestFingerprint: string; response: unknown }>();

  countActiveManagers() { return Promise.resolve(BigInt(this.managerCount)); }
  async expireClaimOverrides() {}
  async expireResponsibilityOffers() {}
  findConflictingResponsibilityOffer() { return Promise.resolve(this.currentOffer?.offerId); }
  insertResponsibilityOffer() { this.currentOffer = offer(); return Promise.resolve(this.currentOffer); }
  transitionResponsibilityOffer(input: TransitionResponsibilityOfferInput) {
    assert.equal(input.nextState, 'acknowledged');
    this.currentOffer = offer('acknowledged');
    return Promise.resolve(this.currentOffer);
  }
  readCurrentResponsibilityOffers() { return Promise.resolve(this.currentOffer ? [this.currentOffer] : []); }
  readResponsibilityOffer() { return Promise.resolve(this.currentOffer); }
  readMemberAdministrationFacts() {
    return Promise.resolve([{
      bindingState: 'unbound', claimExpiresAt: '2026-09-30T00:00:00.000Z', claimState: 'unclaimed',
      displayName: 'Target member', memberId: 'member-target', overrideClaimGeneration: null,
      overrideState: null, revision: Number(this.targetRevision), role: this.targetRole,
    }]);
  }
  applyManagerRoleChange(input: ManagerRoleChangeInput) {
    this.targetRole = input.role;
    this.targetRevision += 1n;
    this.managerSetGeneration += 1;
    return Promise.resolve();
  }
  findMembershipResult(actor: string, operation: string, key: string) {
    return Promise.resolve(this.results.get(`${actor}:${operation}:${key}`));
  }
  hasMembershipResultTombstone() { return Promise.resolve(false); }
  storeMembershipResult(actor: string, operation: string, key: string, requestFingerprint: string, response: object) {
    this.results.set(`${actor}:${operation}:${key}`, { requestFingerprint, response });
    return Promise.resolve();
  }
}

function fixture(role: 'manager' | 'member' = 'manager') {
  const persistence = new MemoryAdministration();
  const writeAdmission = {
    run: async <T>(principal: { principalId: string }, _projectId: unknown, operation: (write: unknown) => Promise<T>) => {
      const memberId = role === 'member' || principal.principalId === 'principal-target' ? 'member-target' : 'member-manager';
      return operation({
        memberId,
        role: memberId === 'member-target' ? persistence.targetRole : 'manager',
        transact: <U>(transaction: (scope: unknown) => Promise<U>) => transaction({
          appendProjectEvent: () => Promise.resolve({}),
          findMembership: (id: string) => Promise.resolve({
            displayName: id, memberId: id, revision: id === 'member-target' ? persistence.targetRevision : 1n,
            role: id === 'member-target' ? persistence.targetRole : 'manager', status: 'active',
          }),
          getProject: () => Promise.resolve({ managerSetGeneration: persistence.managerSetGeneration }),
          listMemberships: () => Promise.resolve(Array.from({ length: persistence.managerCount }, (_, i) => ({
            memberId: `member-manager-${String(i)}`, revision: 1n, role: 'manager', status: 'active', displayName: 'Manager',
          }))),
          membership: persistence,
        }),
      });
    },
  };
  return {
    authority: new ProjectMembershipAdministrationAuthority({
      clock: () => new Date(NOW), offerIdFactory: () => 'offer-one', writeAdmission: writeAdmission as never,
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
    assert.equal((await authority.acknowledgeOffer(createVaultCredentialPrincipal({ principalId: 'principal-target' }), {
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
    assert.equal(persistence.targetRole, 'manager');
    assert.equal(persistence.managerSetGeneration, 2);
  });

  it('preserves proven negative settlement without promoting ambiguous errors', async () => {
    const request = {
      expectedManagerSetGeneration: 1, expectedTargetMembershipRevision: 2,
      idempotencyKey: 'demote-negative', projectId: PROJECT_ID, targetMemberId: 'member-target',
    };
    for (const status of ['permanently-stale', 'stale', 'final-manager'] as const) {
      const { authority, persistence } = fixture();
      persistence.targetRole = 'manager';
      if (status === 'permanently-stale') persistence.managerSetGeneration = 2;
      if (status === 'stale') persistence.targetRevision = 1n;
      if (status === 'final-manager') persistence.managerCount = 1;
      await assert.rejects(authority.demote(PRINCIPAL, request), {
        code: 'authority-not-synchronized',
        name: status === 'permanently-stale' ? 'ProjectMutationRejection' : 'CollabError',
      });
    }
  });

  it('maps stale state and final-Manager demotion to fixed canonical errors', async () => {
    const stale = fixture();
    stale.persistence.targetRevision = 1n;
    await assert.rejects(stale.authority.demote(PRINCIPAL, {
      expectedManagerSetGeneration: 1,
      expectedTargetMembershipRevision: 2,
      idempotencyKey: 'demote-key',
      projectId: PROJECT_ID,
      targetMemberId: 'member-target',
    }), (error: unknown) => error instanceof CollabError
      && error.code === 'authority-not-synchronized');
    const finalManager = fixture();
    finalManager.persistence.managerCount = 1;
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
