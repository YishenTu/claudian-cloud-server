import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  CollabError,
  type CreateProjectInvitationRequest,
  type CreateProjectInvitationResponse,
} from '@claudian-collab/protocol';

import type {
  CreateProjectInvitationPersistenceInput,
  ProjectInvitationRecord,
  ProjectInvitationPersistence,
  RevokeProjectInvitationPersistenceInput,
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
  rejection: 'permanently-stale' | undefined;

  createInvitation(
    input: CreateProjectInvitationPersistenceInput,
  ): Promise<Readonly<{
    readonly record?: ProjectInvitationRecord;
    readonly status: 'permanently-stale' | 'conflict' | 'created' | 'quota' | 'replayed' | 'replay-expired' | 'stale-generation';
  }>> {
    if (this.rejection !== undefined) return Promise.resolve({ status: this.rejection });
    if (this.managerSetGeneration !== input.expectedManagerSetGeneration) {
      return Promise.resolve({ status: 'stale-generation' });
    }
    if (this.invitation !== undefined) {
      return Promise.resolve(
        this.invitation.issuedByMemberId === input.issuedByMemberId
        && this.invitation.idempotencyKey === input.idempotencyKey
        && this.invitation.requestFingerprint === input.requestFingerprint
          ? { record: this.invitation, status: 'replayed' }
          : { status: 'conflict' },
      );
    }
    if (this.capacity >= 100) return Promise.resolve({ status: 'quota' });
    this.invitation = Object.freeze({ ...input, revision: 1, state: 'active' });
    this.capacity += 1;
    return Promise.resolve({ record: this.invitation, status: 'created' });
  }

  listInvitations(): Promise<Readonly<{
    readonly invitations: readonly ProjectInvitationRecord[];
    readonly managerSetGeneration: number;
  }>> {
    return Promise.resolve({
      invitations: this.invitation === undefined ? [] : [this.invitation],
      managerSetGeneration: this.managerSetGeneration,
    });
  }

  revokeInvitation(
    input: RevokeProjectInvitationPersistenceInput,
  ): Promise<Readonly<{
    readonly record?: ProjectInvitationRecord;
    readonly status: 'permanently-stale' | 'conflict' | 'replayed' | 'revoked' | 'stale-generation' | 'stale-invitation';
  }>> {
    if (this.rejection !== undefined) return Promise.resolve({ status: this.rejection });
    if (input.expectedManagerSetGeneration !== this.managerSetGeneration) {
      return Promise.resolve({ status: 'stale-generation' });
    }
    if (
      this.invitation === undefined
      || input.invitationId !== this.invitation.invitationId
      || input.expectedInvitationRevision !== this.invitation.revision
    ) return Promise.resolve({ status: 'stale-invitation' });
    this.invitation = Object.freeze({
      ...this.invitation,
      revision: 2,
      state: 'revoked',
      terminalAt: input.revokedAt,
    });
    return Promise.resolve({ record: this.invitation, status: 'revoked' });
  }
}

function fixture(role: 'manager' | 'member' = 'manager') {
  const persistence = new MemoryMembershipPersistence();
  const writeAdmission = {
    run: async <T>(
      _principal: unknown,
      _projectId: unknown,
      operation: (write: unknown) => Promise<T>,
    ): Promise<T> => operation({
      memberId: 'member-manager',
      role,
      transact: <U>(
        transaction: (scope: { membership: ProjectInvitationPersistence }) => Promise<U>,
      ) => transaction({ membership: persistence }),
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

  it('preserves negative-settlement evidence from invitation persistence', async () => {
    const { authority, persistence } = fixture();
    persistence.rejection = 'permanently-stale';
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
