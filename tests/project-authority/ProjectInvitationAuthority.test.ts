import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  CollabError,
  type CreateProjectInvitationRequest,
  type CreateProjectInvitationResponse,
} from '@claudian-collab/protocol';

import type {
  InsertProjectInvitationInput,
  ProjectInvitationRecord,
  ProjectInvitationPersistence,
  RevokeInvitationRowInput,
} from '../../src/coordination/ProjectMembershipPersistence.js';
import {
  ProjectInvitationAuthority,
} from '../../src/project-authority/membership/ProjectInvitationAuthority.js';
import { ProtectedSecretCustody } from '../../src/project-authority/lifecycle/ProtectedSecretCustody.js';
import { createVaultCredentialPrincipal } from '../../src/request-context/RequestPrincipal.js';

const NOW = '2026-08-30T02:00:00.000Z';
const SECRET = Buffer.alloc(32, 6).toString('base64url');
const REQUEST: CreateProjectInvitationRequest = {
  expectedManagerSetGeneration: 1,
  idempotencyKey: 'invite-key-one',
  projectId: 'project-invitations',
};
const PRINCIPAL = createVaultCredentialPrincipal({
  principalId: 'principal-manager',
});

class MemoryMembershipPersistence implements ProjectInvitationPersistence {
  invitation: ProjectInvitationRecord | undefined;
  managerSetGeneration = 1;
  capacity = 1;
  readonly results = new Map<string, { requestFingerprint: string; response: unknown }>();
  expireInvitations(): Promise<void> { return Promise.resolve(); }
  findSecretReplayTombstone(): Promise<string | undefined> { return Promise.resolve(undefined); }
  readMembershipReservationCount(): Promise<bigint> { return Promise.resolve(BigInt(this.capacity)); }
  readInvitationIssuance(actor: string, key: string): Promise<ProjectInvitationRecord | undefined> {
    return Promise.resolve(this.invitation?.issuedByMemberId === actor && this.invitation.idempotencyKey === key ? this.invitation : undefined);
  }
  readInvitationRecord(id: string): Promise<ProjectInvitationRecord | undefined> {
    return Promise.resolve(this.invitation?.invitationId === id ? this.invitation : undefined);
  }
  readInvitations(): Promise<readonly ProjectInvitationRecord[]> { return Promise.resolve(this.invitation === undefined ? [] : [this.invitation]); }
  insertInvitation(input: InsertProjectInvitationInput): Promise<ProjectInvitationRecord> {
    assert.equal(this.invitation, undefined);
    this.invitation = Object.freeze({ ...input, revision: 1, state: 'active' });
    this.capacity += 1;
    return Promise.resolve(this.invitation);
  }
  revokeInvitationRow(input: RevokeInvitationRowInput): Promise<ProjectInvitationRecord> {
    assert.ok(this.invitation);
    assert.equal(input.invitationId, this.invitation.invitationId);
    assert.equal(input.expectedInvitationRevision, this.invitation.revision);
    this.invitation = Object.freeze({ ...this.invitation, revision: 2, state: 'revoked', terminalAt: input.revokedAt });
    return Promise.resolve(this.invitation);
  }
  findMembershipResult(actor: string, operation: string, key: string) {
    return Promise.resolve(this.results.get(JSON.stringify([actor, operation, key])));
  }
  storeMembershipResult(actor: string, operation: string, key: string, requestFingerprint: string, response: unknown): Promise<void> {
    this.results.set(JSON.stringify([actor, operation, key]), { requestFingerprint, response });
    return Promise.resolve();
  }

}

function fixture(role: 'manager' | 'member' = 'manager') {
  const persistence = new MemoryMembershipPersistence();
  const scope = {
    membership: persistence,
    getProject: () => Promise.resolve({ managerSetGeneration: persistence.managerSetGeneration }),
    findMembership: () => Promise.resolve({ role, status: 'active' }),
  };
  const writeAdmission = {
    run: async <T>(
      _principal: unknown,
      _projectId: unknown,
      operation: (write: unknown) => Promise<T>,
    ): Promise<T> => operation({
      memberId: 'member-manager',
      role,
      transact: <U>(
        transaction: (value: typeof scope) => Promise<U>,
      ) => transaction(scope),
    }),
  };
  return {
    authority: new ProjectInvitationAuthority({
      clock: () => new Date(NOW),
      custody: new ProtectedSecretCustody({
        activeKeyId: 'invitation-key',
        keys: [{ key: Buffer.alloc(32, 4), keyId: 'invitation-key', keyVersion: 1 }],
        nonceFactory: () => Buffer.alloc(24, 3),
      }),
      invitationIdFactory: () => 'invitation-one',
      secretFactory: () => SECRET,
      writeAdmission: writeAdmission as never,
    }),
    persistence,
  };
}

describe('ProjectInvitationAuthority', () => {
  it('issues an exact 24-hour protected invitation and replays the secret', async () => {
    const { authority, persistence } = fixture();
    const expected: CreateProjectInvitationResponse = {
      createdAt: NOW,
      expiresAt: '2026-08-31T02:00:00.000Z',
      invitationId: 'invitation-one',
      issuedState: 'active',
      projectId: REQUEST.projectId,
      secret: SECRET,
      secretReplayExpiresAt: '2026-09-29T02:00:00.000Z',
    };

    assert.deepEqual(await authority.create(PRINCIPAL, REQUEST), expected);
    assert.deepEqual(await authority.create(PRINCIPAL, REQUEST), expected);
    assert.equal(persistence.capacity, 2);
    assert.equal(persistence.invitation?.secretSha256, createHash('sha256')
      .update(SECRET, 'utf8').digest('hex'));
    assert.equal(JSON.stringify(persistence.invitation).includes(SECRET), false);
  });

  it('lists bounded metadata, revokes by exact revisions, and never returns a secret', async () => {
    const { authority } = fixture();
    await authority.create(PRINCIPAL, REQUEST);

    const listed = await authority.list(PRINCIPAL, { projectId: REQUEST.projectId });
    assert.equal(JSON.stringify(listed).includes(SECRET), false);
    assert.deepEqual(listed.invitations, [{
      createdAt: NOW,
      expiresAt: '2026-08-31T02:00:00.000Z',
      invitationId: 'invitation-one',
      revision: 1,
      state: 'active',
      terminalAt: null,
    }]);
    assert.deepEqual(await authority.revoke(PRINCIPAL, {
      expectedInvitationRevision: 1,
      expectedManagerSetGeneration: 1,
      idempotencyKey: 'revoke-one',
      invitationId: 'invitation-one',
      projectId: REQUEST.projectId,
    }), {
      invitationId: 'invitation-one',
      projectId: REQUEST.projectId,
      revision: 2,
      revokedAt: NOW,
      state: 'revoked',
    });
  });

  it('classifies strictly advanced invitation expectations as permanent rejections', async () => {
    const { authority, persistence } = fixture();
    persistence.managerSetGeneration = 2;
    const expected = { code: 'authority-not-synchronized', name: 'ProjectMutationRejection' };
    await assert.rejects(authority.create(PRINCIPAL, REQUEST), expected);
    await assert.rejects(authority.revoke(PRINCIPAL, {
      projectId: REQUEST.projectId, invitationId: 'invitation-one', expectedInvitationRevision: 1,
      expectedManagerSetGeneration: 1, idempotencyKey: 'revoke-negative',
    }), expected);
  });

  it('rejects non-Managers, stale generations, and exhausted reservations', async () => {
    const member = fixture('member');
    await assert.rejects(member.authority.create(PRINCIPAL, REQUEST), (error: unknown) => (
      error instanceof CollabError && error.code === 'authorization-denied'
    ));

    const stale = fixture();
    stale.persistence.managerSetGeneration = 2;
    await assert.rejects(stale.authority.create(PRINCIPAL, REQUEST), (error: unknown) => (
      error instanceof CollabError && error.code === 'authority-not-synchronized'
    ));

    const full = fixture();
    full.persistence.capacity = 100;
    await assert.rejects(full.authority.create(PRINCIPAL, REQUEST), (error: unknown) => (
      error instanceof CollabError && error.code === 'quota-exceeded'
    ));
  });
});
