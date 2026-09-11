import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CollabError,
  type JoinCloudProjectRequest,
  type JoinCloudProjectResponse,
} from '@claudian-collab/protocol';

import type {
  PrepareProjectJoinInput,
  ProjectInvitationRecord,
  ProjectJoinJournal,
  ProjectJoinPersistence,
} from '../../src/coordination/ProjectMembershipPersistence.js';
import {
  CloudProjectJoinCoordinator,
} from '../../src/project-authority/membership/CloudProjectJoinCoordinator.js';
import type { ProjectMembershipRepository } from '../../src/project-authority/membership/ProjectMembershipRepository.js';
import { createVaultCredentialPrincipal } from '../../src/request-context/RequestPrincipal.js';

const NOW = '2026-08-30T04:00:00.000Z';
const MAIN = 'a'.repeat(40);
const SECRET = Buffer.alloc(32, 6).toString('base64url');
const REQUEST: JoinCloudProjectRequest = {
  displayName: 'Joining Member',
  idempotencyKey: 'join-key-one',
  invitationId: 'invitation-one',
  projectId: 'project-join',
  secret: SECRET,
};
const PRINCIPAL = createVaultCredentialPrincipal({
  principalId: 'principal-joining',
});

class MemoryJoinPersistence implements ProjectJoinPersistence {
  failAfter: string | undefined;
  invitationUnavailable = false;
  journal: ProjectJoinJournal | undefined;
  invitation: ProjectInvitationRecord = Object.freeze({
    createdAt: '2026-08-30T03:00:00.000Z',
    envelope: undefined,
    expiresAt: '2026-08-31T03:00:00.000Z',
    idempotencyKey: 'issue-key',
    invitationId: REQUEST.invitationId,
    issuedByMemberId: 'member-manager',
    projectId: REQUEST.projectId,
    requestFingerprint: '1'.repeat(64),
    revision: 1,
    secretReplayExpiresAt: '2026-09-29T03:00:00.000Z',
    secretSha256: '4a872257959354dd4a92153e63a96c473254e71e9363f791b5097ff5ccab0f1f',
    state: 'active',
    terminalAt: null,
  });
  readonly phases: string[] = [];

  private commit(journal: ProjectJoinJournal): void {
    this.journal = Object.freeze(journal);
    this.phases.push(journal.phase);
    if (this.failAfter === journal.phase) {
      this.failAfter = undefined;
      throw new Error('injected-after-durable-phase');
    }
  }

  findInvitationForJoin(): Promise<ProjectInvitationRecord | undefined> {
    return Promise.resolve(this.invitationUnavailable ? undefined : this.invitation);
  }

  readMembershipReservationCount(): Promise<bigint> { return Promise.resolve(2n); }
  readInvitationRecord(): Promise<ProjectInvitationRecord | undefined> { return Promise.resolve(this.invitation); }

  findJoinByPrincipal(): Promise<ProjectJoinJournal | undefined> {
    return Promise.resolve(this.journal);
  }

  findJoinByPrincipalOperation(): Promise<ProjectJoinJournal | undefined> {
    return Promise.resolve(this.journal);
  }

  getNonterminalJoin(): Promise<ProjectJoinJournal | undefined> {
    return Promise.resolve(this.journal?.phase === 'completed' ? undefined : this.journal);
  }

  readPrincipalBindingState(): Promise<string | undefined> { return Promise.resolve(undefined); }

  insertJoin(input: PrepareProjectJoinInput) {
    this.commit({
      ...input,
      phase: 'prepared',
      response: undefined,
      updatedAt: input.preparedAt,
    });
    assert.ok(this.journal);
    return Promise.resolve(this.journal);
  }

  advanceJoin(input: Readonly<{
    readonly expectedPhase: 'prepared' | 'membership-pending';
    readonly nextPhase: 'membership-pending' | 'personal-ref-created';
    readonly operationId: string;
    readonly updatedAt: string;
  }>): Promise<'advanced' | 'replayed'> {
    assert.ok(this.journal);
    if (this.journal.phase === input.nextPhase) return Promise.resolve('replayed');
    assert.equal(this.journal.phase, input.expectedPhase);
    this.commit({ ...this.journal, phase: input.nextPhase, updatedAt: input.updatedAt });
    return Promise.resolve('advanced');
  }

  activateJoin(input: Readonly<{
    readonly joinedAt: string;
    readonly operationId: string;
    readonly response: JoinCloudProjectResponse;
  }>): Promise<'activated' | 'replayed'> {
    assert.ok(this.journal);
    this.commit({
      ...this.journal,
      phase: 'membership-active',
      response: input.response,
      updatedAt: input.joinedAt,
    });
    return Promise.resolve('activated');
  }

  completeJoin(input: Readonly<{ readonly completedAt: string; readonly operationId: string }>) {
    assert.ok(this.journal?.response);
    this.commit({ ...this.journal, phase: 'completed', updatedAt: input.completedAt });
    return Promise.resolve(this.journal.response);
  }

}

function fixture() {
  const order: string[] = [];
  const persistence = new MemoryJoinPersistence();
  let competingMutation = false;
  const repository = {
    creates: 0,
    createMemberPersonalRef() {
      order.push('ref');
      this.creates += 1;
      return Promise.resolve(this.creates === 1 ? 'created' : 'replayed');
    },
    deleteMemberPersonalRef() { throw new Error('unused'); },
    reserveMembershipRefOperation() {
      order.push('reservation');
      return Promise.resolve({
        close: () => {
          order.push('reservation-close');
          return Promise.resolve();
        },
        projectId: REQUEST.projectId,
      });
    },
  } as ProjectMembershipRepository & {
    creates: number;
    reserveMembershipRefOperation(): Promise<Readonly<{
      close(): Promise<void>;
      readonly projectId: string;
    }>>;
  };
  const scope = {
    accept: {
      getNonterminal: () => Promise.resolve(competingMutation ? {} : undefined),
    },
    appendProjectEvent: () => Promise.resolve({}),
    getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(undefined),
    getProject: () => Promise.resolve({
      expectedMainOid: MAIN,
      managerSetGeneration: 1,
      serviceState: 'active',
    }),
    getRepositoryPlacement: () => Promise.resolve({
      active: true,
      generation: 1,
      projectId: REQUEST.projectId,
      repositoryStorageKey: 'repo_join',
      storageNodeId: 'node-a',
    }),
    membership: persistence,
    portability: {
      getNonterminalLifecycleJournal: () => Promise.resolve(undefined),
    },
  };
  const coordination = {
    acquireProjectLease: () => {
      order.push('lease');
      return Promise.resolve({
      close: () => {
        order.push('lease-close');
        return Promise.resolve();
      },
      withProjectScope: <T>(operation: (value: typeof scope) => Promise<T>) => operation(scope),
      });
    },
  };
  const coordinator = new CloudProjectJoinCoordinator({
    clock: () => new Date(NOW),
    coordination: coordination as never,
    memberIdFactory: () => 'member-joining',
    operationIdFactory: () => 'join-operation-one',
    repository,
  });
  return {
    coordinator,
    order,
    persistence,
    repository,
    setCompetingMutation(value: boolean) { competingMutation = value; },
  };
}

describe('CloudProjectJoinCoordinator', () => {
  it('advances one invitation through pending membership, exact Git ref, and activation', async () => {
    const { coordinator, order, persistence, repository } = fixture();
    const expected: JoinCloudProjectResponse = {
      joinedAt: NOW,
      mainOid: MAIN,
      managerSetGeneration: 1,
      memberId: 'member-joining',
      membershipRevision: 2,
      personalRef: 'refs/heads/members/member-joining',
      projectId: REQUEST.projectId,
      role: 'member',
    };

    assert.deepEqual(await coordinator.join(PRINCIPAL, REQUEST), expected);
    assert.deepEqual(persistence.phases, [
      'prepared',
      'membership-pending',
      'personal-ref-created',
      'membership-active',
      'completed',
    ]);
    assert.equal(repository.creates, 1);
    assert.deepEqual(order, [
      'reservation',
      'lease',
      'ref',
      'lease-close',
      'reservation-close',
    ]);
    assert.deepEqual(await coordinator.join(PRINCIPAL, REQUEST), expected);
    assert.equal(repository.creates, 1);
  });

  it('recovers forward after every durable Join phase without changing its plan', async () => {
    for (const phase of [
      'prepared',
      'membership-pending',
      'personal-ref-created',
      'membership-active',
    ]) {
      const { coordinator, persistence } = fixture();
      persistence.failAfter = phase;
      await assert.rejects(coordinator.join(PRINCIPAL, REQUEST));
      await coordinator.recoverProject(REQUEST.projectId);
      assert.ok(persistence.journal);
      assert.equal(persistence.journal.phase, 'completed');
      assert.equal(persistence.journal.principalId, PRINCIPAL.principalId);
      assert.equal(persistence.journal.expectedMainOid, MAIN);
    }
  });

  it('fails closed for invalid secrets and untrusted principals', async () => {
    const invalid = fixture();
    await assert.rejects(invalid.coordinator.join(PRINCIPAL, {
      ...REQUEST,
      secret: Buffer.alloc(32, 5).toString('base64url'),
    }), (error: unknown) => error instanceof CollabError
      && error.code === 'authorization-denied');
    await assert.rejects(invalid.coordinator.join({
      principalId: 'private-development',
      provenance: { kind: 'private-development' },
    }, REQUEST), (error: unknown) => error instanceof CollabError
      && error.code === 'authorization-denied');
  });

  it('proves invalid invitation rejection only before an exact Join journal exists', async () => {
    for (const state of ['revoked', 'expired'] as const) {
      const { coordinator, persistence } = fixture();
      persistence.invitation = { ...persistence.invitation, state };
      await assert.rejects(coordinator.join(PRINCIPAL, REQUEST), {
        code: 'authorization-denied', name: 'ProjectMutationRejection',
      });
      assert.equal(persistence.journal, undefined);
    }
    const invalid = fixture();
    await assert.rejects(invalid.coordinator.join(PRINCIPAL, {
      ...REQUEST, secret: Buffer.alloc(32, 5).toString('base64url'),
    }), { code: 'authorization-denied', name: 'ProjectMutationRejection' });

    const missing = fixture();
    missing.persistence.invitationUnavailable = true;
    await assert.rejects(missing.coordinator.join(PRINCIPAL, REQUEST), {
      code: 'authorization-denied', name: 'CollabError',
    });
    const untrusted = fixture();
    untrusted.persistence.invitation = { ...untrusted.persistence.invitation, state: 'revoked' };
    await assert.rejects(untrusted.coordinator.join({
      principalId: 'untrusted', provenance: { kind: 'private-development' },
    }, REQUEST), { code: 'authorization-denied', name: 'CollabError' });

    const replay = fixture();
    const completed = await replay.coordinator.join(PRINCIPAL, REQUEST);
    replay.persistence.invitation = { ...replay.persistence.invitation, state: 'expired' };
    assert.deepEqual(await replay.coordinator.join(PRINCIPAL, REQUEST), completed);

    const pending = fixture();
    pending.persistence.failAfter = 'prepared';
    await assert.rejects(pending.coordinator.join(PRINCIPAL, REQUEST));
    pending.persistence.invitation = { ...pending.persistence.invitation, state: 'expired' };
    assert.deepEqual(await pending.coordinator.join(PRINCIPAL, REQUEST), completed);
  });

  it('does not prepare Join while another Project mutation requires recovery', async () => {
    const fixtureValue = fixture();
    fixtureValue.setCompetingMutation(true);

    await assert.rejects(
      fixtureValue.coordinator.join(PRINCIPAL, REQUEST),
      (error: unknown) => error instanceof CollabError
        && error.code === 'authority-not-synchronized',
    );
    assert.equal(fixtureValue.persistence.journal, undefined);
    assert.equal(fixtureValue.repository.creates, 0);
  });
});
