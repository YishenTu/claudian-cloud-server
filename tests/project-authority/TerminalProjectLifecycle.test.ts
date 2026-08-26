/* eslint-disable @typescript-eslint/require-await */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import type {
  AdvanceProjectLifecycleJournalInput,
  ProjectDeletionIntentRecord,
  ProjectLifecycleJournalRecord,
  PutProjectLifecycleJournalInput,
  TerminalResponderRecord,
} from '../../src/coordination/PortabilityLifecyclePersistence.js';
import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import type { RepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';
import { RepositoryCheckpointError } from '../../src/repositories/RepositoryCheckpointAuthority.js';
import {
  DeletionCoordinator,
  DeletionCoordinatorError,
} from '../../src/project-authority/lifecycle/delete/DeletionCoordinator.js';
import {
  LeaveCoordinator,
  LeaveCoordinatorError,
} from '../../src/project-authority/lifecycle/leave/LeaveCoordinator.js';
import {
  RetireCoordinator,
  RetireCoordinatorError,
} from '../../src/project-authority/lifecycle/retire/RetireCoordinator.js';
import {
  TerminalResponderExpiry,
} from '../../src/project-authority/lifecycle/retire/TerminalResponderExpiry.js';

const PROJECT_ID = 'project-terminal-lifecycle';
const MANAGER_ID = 'member-manager';
const MEMBER_ID = 'member-member';
const MANAGER_PRINCIPAL = 'principal:manager';
const MEMBER_PRINCIPAL = 'principal:member';
const OTHER_PRINCIPAL = 'principal:other';
const NOW = '2026-08-27T00:00:00.000Z';
const MAIN_OID = '1'.repeat(40);
const MEMBER_OID = '2'.repeat(40);
const SHA = '3'.repeat(64);

function repositoryReservation() {
  return Object.freeze({
    async close() {},
    projectId: PROJECT_ID,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function journal(
  kind: ProjectLifecycleJournalRecord['kind'],
  operationId: string,
  phase: string,
): ProjectLifecycleJournalRecord {
  return Object.freeze({
    actorMemberId: MANAGER_ID,
    batchRevision: undefined,
    batchSha256: undefined,
    checkpointSha256: undefined,
    createdAt: NOW,
    direction: undefined,
    expectedAuthorityGeneration: 4,
    idempotencyKey: operationId,
    kind,
    operationId,
    phase,
    projectId: PROJECT_ID,
    recoveryFromPhase: undefined,
    requestFingerprint: SHA,
    resultSha256: undefined,
    scheduledAt: NOW,
    state: 'active',
    updatedAt: NOW,
  });
}

function deletionHarness(phase: ProjectDeletionIntentRecord['phase']) {
  let current = journal('delete', 'delete-one', phase);
  let repositoryRemovals = 0;
  let coordinationRemovals = 0;
  const intent = (): ProjectDeletionIntentRecord => Object.freeze({
    authorizationSha256: SHA,
    authorizedMemberId: MANAGER_ID,
    createdAt: NOW,
    operationId: current.operationId,
    phase: current.phase as ProjectDeletionIntentRecord['phase'],
    placementGeneration: 7,
    reason: 'retire',
    repositoryStorageKey: 'repository_terminal',
    resultSha256: current.resultSha256,
    storageNodeId: 'local',
    terminalOperationId: 'retire-one',
    terminalOperationKind: 'retire',
    updatedAt: current.updatedAt,
  });
  const portability = {
    async getDeletionIntent(operationId: string) {
      return operationId === current.operationId ? intent() : undefined;
    },
    async getLifecycleJournal(operationId: string) {
      return operationId === current.operationId ? current : undefined;
    },
    async advanceLifecycleJournal(input: AdvanceProjectLifecycleJournalInput) {
      assert.equal(input.expectedPhase, current.phase);
      current = Object.freeze({
        ...current,
        phase: input.nextPhase,
        resultSha256: input.resultSha256 ?? current.resultSha256,
        state: input.nextState,
        updatedAt: input.updatedAt,
      });
      return 'advanced' as const;
    },
    async removeProjectCoordinationContent() {
      coordinationRemovals += 1;
      current = Object.freeze({ ...current, phase: 'coordination-removed' });
      return 'advanced' as const;
    },
    async getProjectTombstone() {
      return {
        authorityGeneration: 4,
        projectId: PROJECT_ID,
        resultSha256: SHA,
        retiredAt: NOW,
        terminalExpiresAt: '2026-09-26T00:00:00.000Z',
        terminalOperationId: 'retire-one',
        terminalOperationKind: 'retire' as const,
      };
    },
  };
  const lease = {
    async close() {},
    async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
      return operation({ portability } as unknown as ProjectScope);
    },
  } as PinnedProjectLease;
  const coordinator = new DeletionCoordinator({
    clock: () => new Date('2026-08-27T00:00:01.000Z'),
    coordination: { async acquireProjectLease() { return lease; } },
    repository: {
      async reserveExactRepositoryOperation() { return repositoryReservation(); },
      async verifyExactRepository() {},
      async removeExactRepository() {
        repositoryRemovals += 1;
        return 'removed' as const;
      },
    },
  });
  return {
    coordinator,
    current: () => current,
    coordinationRemovals: () => coordinationRemovals,
    lease,
    reservation: repositoryReservation(),
    repositoryRemovals: () => repositoryRemovals,
  };
}

describe('terminal Project lifecycle', () => {
  it('recovers every durable deletion phase without reopening authority', async () => {
    for (const phase of [
      'traffic-denied',
      'repository-delete-intent',
      'repository-removed',
      'coordination-removed',
      'tombstoned',
    ] as const) {
      const harness = deletionHarness(phase);

      await harness.coordinator.recover({
        journal: harness.current(),
        lease: harness.lease,
        repositoryReservation: harness.reservation,
      });

      assert.equal(harness.current().state, 'completed');
      assert.equal(harness.current().phase, 'completed');
      assert.equal(
        harness.repositoryRemovals(),
        phase === 'traffic-denied' || phase === 'repository-delete-intent' ? 1 : 0,
      );
      assert.equal(
        harness.coordinationRemovals(),
        phase === 'traffic-denied'
          || phase === 'repository-delete-intent'
          || phase === 'repository-removed' ? 1 : 0,
      );
    }
  });

  it('requires an exact pre-existing deletion authorization', async () => {
    const harness = deletionHarness('repository-delete-intent');
    await assert.rejects(
      harness.coordinator.resumeAuthorized({
        authorizationSha256: '4'.repeat(64),
        operationId: 'delete-one',
        projectId: PROJECT_ID,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DeletionCoordinatorError);
        assert.equal(error.code, 'authorization-denied');
        return true;
      },
    );
    assert.equal(harness.repositoryRemovals(), 0);
  });

  it('settles Leave before deleting only the exact personal ref', async () => {
    const placement: RepositoryPlacementLease = Object.freeze({
      active: true,
      generation: 7,
      projectId: PROJECT_ID,
      repositoryStorageKey: 'repository_terminal',
      storageNodeId: 'local',
    });
    let settled = false;
    let verified = false;
    let deletedRef: string | undefined;
    let leaveJournal: ProjectLifecycleJournalRecord | undefined;
    let leaveReplay: Readonly<{
      readonly completedAt: string | undefined;
      readonly createdAt: string;
      readonly expiresAt: string;
      readonly expectedPersonalRefOid: string;
      readonly intentId: string;
      readonly memberId: string;
      readonly operationId: string;
      readonly resultSha256: string | undefined;
      readonly state: 'completed' | 'recovering';
    }> | undefined;
    const portability = {
      async findProjectPrincipalBinding() {
        return {
          boundAt: NOW,
          memberId: MEMBER_ID,
          principalId: MEMBER_PRINCIPAL,
          revokedAt: undefined,
          state: 'active' as const,
        };
      },
      async getLifecycleJournal() { return leaveJournal; },
      async getLeaveFormerPrincipalReplay() { return leaveReplay; },
      async findLeaveFormerPrincipalReplay() { return leaveReplay; },
      async putLifecycleJournal(input: PutProjectLifecycleJournalInput) {
        leaveJournal = Object.freeze({
          ...input,
          batchRevision: undefined, batchSha256: undefined,
          checkpointSha256: undefined, recoveryFromPhase: undefined,
          resultSha256: undefined, state: 'active' as const,
          updatedAt: input.createdAt,
        });
        return 'created' as const;
      },
      async settleLeaveMembership() {
        assert.equal(verified, true);
        settled = true;
        return 'settled' as const;
      },
      async putLeaveFormerPrincipalReplay(input: {
        readonly createdAt: string; readonly expiresAt: string;
        readonly expectedPersonalRefOid: string; readonly intentId: string;
        readonly memberId: string; readonly operationId: string;
      }) {
        leaveReplay = { ...input, completedAt: undefined, resultSha256: undefined,
          state: 'recovering' };
        return 'created' as const;
      },
      async advanceLifecycleJournal(input: AdvanceProjectLifecycleJournalInput) {
        assert.ok(leaveJournal);
        leaveJournal = { ...leaveJournal, phase: input.nextPhase,
          resultSha256: input.resultSha256, state: input.nextState,
          updatedAt: input.updatedAt };
        return 'advanced' as const;
      },
      async completeLeaveFormerPrincipalReplay(input: {
        readonly completedAt: string; readonly resultSha256: string;
      }) {
        assert.ok(leaveReplay);
        leaveReplay = { ...leaveReplay, completedAt: input.completedAt,
          resultSha256: input.resultSha256, state: 'completed' };
        return 'advanced' as const;
      },
    };
    const lease = {
      async close() {},
      async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
        return operation({
          appendProjectEvent: async () => ({}) as never,
          findMembership: async () => ({
            displayName: 'Member', memberId: MEMBER_ID, revision: 2n,
            role: 'member', status: settled ? 'left' : 'active',
          }),
          getRepositoryPlacement: async () => placement,
          getProject: async () => ({ activatedAt: NOW, authorityGeneration: 4,
            authorityStateRevision: 1, createdAt: NOW, expectedMainOid: MAIN_OID,
            managerSetGeneration: 1, projectId: PROJECT_ID,
            projectName: 'Terminal', serviceState: 'active' as const }),
          portability,
        } as unknown as ProjectScope);
      },
    } as PinnedProjectLease;
    const coordinator = new LeaveCoordinator({
      clock: () => new Date(NOW),
      coordination: { async acquireProjectLease() { return lease; } },
      repository: {
        async reserveExactRepositoryOperation() { return repositoryReservation(); },
        async verifyExactPersonalRef(_reservation, input) {
          assert.equal(settled, false);
          assert.equal(input.personalRef, 'refs/heads/members/member-member');
          assert.equal(input.expectedOid, MEMBER_OID);
          verified = true;
        },
        async deleteExactPersonalRef(_reservation, input) {
          assert.equal(settled, true);
          deletedRef = input.personalRef;
          assert.equal(input.expectedOid, MEMBER_OID);
          return 'deleted' as const;
        },
      },
    });

    const result = await coordinator.leave({
      principalId: MEMBER_PRINCIPAL,
      request: {
        expectedPersonalRefOid: MEMBER_OID,
        idempotencyKey: 'leave-one',
        projectId: PROJECT_ID,
      },
    });

    assert.equal(result.kind, 'member-left');
    assert.equal(verified, true);
    assert.equal(deletedRef, 'refs/heads/members/member-member');
  });

  it('blocks the last Manager before settlement', async () => {
    const coordinator = new LeaveCoordinator({
      clock: () => new Date(NOW),
      coordination: {
        async acquireProjectLease() {
          return {
            async close() {},
            async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
              return operation({
                findMembership: async () => ({
                  displayName: 'Manager', memberId: MANAGER_ID, revision: 1n,
                  role: 'manager', status: 'active',
                }),
                getRepositoryPlacement: async () => ({
                  active: true, generation: 7, projectId: PROJECT_ID,
                  repositoryStorageKey: 'repository_terminal', storageNodeId: 'local',
                }),
                getProject: async () => ({ activatedAt: NOW,
                  authorityGeneration: 4, authorityStateRevision: 1,
                  createdAt: NOW, expectedMainOid: MAIN_OID,
                  managerSetGeneration: 1, projectId: PROJECT_ID,
                  projectName: 'Terminal', serviceState: 'active' as const }),
                listMemberships: async () => [{
                  displayName: 'Manager', memberId: MANAGER_ID, revision: 1n,
                  role: 'manager' as const, status: 'active' as const,
                }],
                portability: {
                  async findProjectPrincipalBinding() {
                    return { boundAt: NOW, memberId: MANAGER_ID,
                      principalId: MANAGER_PRINCIPAL, revokedAt: undefined,
                      state: 'active' as const };
                  },
                  async getLifecycleJournal() { return undefined; },
                  async findLeaveFormerPrincipalReplay() { return undefined; },
                  async putLifecycleJournal() { return 'created' as const; },
                  async settleLeaveMembership() { return 'last-manager' as const; },
                },
              } as unknown as ProjectScope);
            },
          } as PinnedProjectLease;
        },
      },
      repository: {
        async reserveExactRepositoryOperation() { return repositoryReservation(); },
        async verifyExactPersonalRef() { throw new Error('must not verify'); },
        async deleteExactPersonalRef() { throw new Error('must not delete'); },
      },
    });

    await assert.rejects(
      coordinator.leave({
        principalId: MANAGER_PRINCIPAL,
        request: { expectedPersonalRefOid: MEMBER_OID,
          idempotencyKey: 'leave-manager', projectId: PROJECT_ID },
      }),
      (error: unknown) => {
        assert.ok(error instanceof LeaveCoordinatorError);
        assert.equal(error.code, 'manager-succession-required');
        return true;
      },
    );
  });

  it('rejects a stale personal ref before membership settlement', async () => {
    let leaveJournal: ProjectLifecycleJournalRecord | undefined;
    let settlements = 0;
    const coordinator = new LeaveCoordinator({
      clock: () => new Date(NOW),
      coordination: {
        async acquireProjectLease() {
          return {
            async close() {},
            async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
              return operation({
                findMembership: async () => ({
                  displayName: 'Member', memberId: MEMBER_ID, revision: 2n,
                  role: 'member', status: 'active',
                }),
                getRepositoryPlacement: async () => ({
                  active: true, generation: 7, projectId: PROJECT_ID,
                  repositoryStorageKey: 'repository_terminal', storageNodeId: 'local',
                }),
                getProject: async () => ({ activatedAt: NOW,
                  authorityGeneration: 4, authorityStateRevision: 1,
                  createdAt: NOW, expectedMainOid: MAIN_OID,
                  managerSetGeneration: 1, projectId: PROJECT_ID,
                  projectName: 'Terminal', serviceState: 'active' as const }),
                portability: {
                  async findProjectPrincipalBinding(principalId: string) {
                    return { boundAt: NOW,
                      memberId: principalId === MEMBER_PRINCIPAL
                        ? MEMBER_ID : MANAGER_ID,
                      principalId, revokedAt: undefined,
                      state: 'active' as const };
                  },
                  async getLifecycleJournal() { return leaveJournal; },
                  async findLeaveFormerPrincipalReplay() { return undefined; },
                  async putLifecycleJournal(input: PutProjectLifecycleJournalInput) {
                    leaveJournal = Object.freeze({
                      ...input,
                      batchRevision: undefined, batchSha256: undefined,
                      checkpointSha256: undefined, recoveryFromPhase: undefined,
                      resultSha256: undefined, state: 'active' as const,
                      updatedAt: input.createdAt,
                    });
                    return 'created' as const;
                  },
                  async settleLeaveMembership() {
                    settlements += 1;
                    return 'settled' as const;
                  },
                },
              } as unknown as ProjectScope);
            },
          } as PinnedProjectLease;
        },
      },
      repository: {
        async reserveExactRepositoryOperation() { return repositoryReservation(); },
        async verifyExactPersonalRef() {
          throw new RepositoryCheckpointError('repository-invalid');
        },
        async deleteExactPersonalRef() { throw new Error('must not delete'); },
      },
    });

    await assert.rejects(coordinator.leave({
      principalId: MEMBER_PRINCIPAL,
      request: { projectId: PROJECT_ID,
        idempotencyKey: 'leave-stale-ref', expectedPersonalRefOid: MEMBER_OID },
    }), (error: unknown) => error instanceof LeaveCoordinatorError
      && error.code === 'state-conflict');
    assert.equal(settlements, 0);
    assert.equal(leaveJournal, undefined);
    await assert.rejects(coordinator.leave({
      principalId: OTHER_PRINCIPAL,
      request: { expectedPersonalRefOid: MEMBER_OID,
        idempotencyKey: 'leave-stale-ref', projectId: PROJECT_ID },
    }), (error: unknown) => error instanceof LeaveCoordinatorError
      && error.code === 'state-conflict');
    assert.equal(settlements, 0);
  });

  it('atomically terminalizes Manager-authorized Retire before deletion', async () => {
    let serviceState = 'active';
    let retireCompleted = false;
    let deletionCreated = false;
    let repositoryVerified = false;
    const portability = {
      async findProjectPrincipalBinding() {
        return { boundAt: NOW, memberId: MANAGER_ID,
          principalId: MANAGER_PRINCIPAL, revokedAt: undefined,
          state: 'active' as const };
      },
      async getLifecycleJournal() { return undefined; },
      async putLifecycleJournal(input: { readonly kind: string }) {
        assert.equal(repositoryVerified, true);
        if (input.kind === 'delete') deletionCreated = true;
        return 'created' as const;
      },
      async listActiveProjectPrincipalBindings() {
        return [{ boundAt: NOW, memberId: MANAGER_ID,
          principalId: MANAGER_PRINCIPAL, revokedAt: undefined,
          state: 'active' as const }];
      },
      async putTerminalResponder() { return 'created' as const; },
      async putProjectTombstone() { return 'created' as const; },
      async putDeletionIntent() { return 'created' as const; },
      async advanceLifecycleJournal(input: AdvanceProjectLifecycleJournalInput) {
        if (input.nextState === 'completed') retireCompleted = true;
        return 'advanced' as const;
      },
      async getTerminalResponder() { return undefined; },
    };
    const coordinator = new RetireCoordinator({
      clock: () => new Date(NOW),
      coordination: {
        async acquireProjectLease() {
          return {
            async close() {},
            async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
              return operation({
                appendProjectEvent: async () => ({}) as never,
                findMembership: async () => ({ displayName: 'Manager',
                  memberId: MANAGER_ID, revision: 1n, role: 'manager', status: 'active' }),
                getProject: async () => ({ activatedAt: NOW, authorityGeneration: 4,
                  authorityStateRevision: 1, createdAt: NOW, expectedMainOid: MAIN_OID,
                  managerSetGeneration: 1, projectId: PROJECT_ID,
                  projectName: 'Terminal', serviceState }),
                getRepositoryPlacement: async () => ({ active: true, generation: 7,
                  projectId: PROJECT_ID, repositoryStorageKey: 'repository_terminal',
                  storageNodeId: 'local' }),
                advanceProjectAuthorityState: async () => {
                  assert.equal(retireCompleted, true);
                  serviceState = 'deleting';
                  return 'advanced' as const;
                },
                portability,
              } as unknown as ProjectScope);
            },
          } as PinnedProjectLease;
        },
      },
      repository: {
        async reserveExactRepositoryOperation() { return repositoryReservation(); },
        async verifyExactRepository() { repositoryVerified = true; },
      },
    });

    const result = await coordinator.retire({
      principalId: MANAGER_PRINCIPAL,
      request: { expectedAuthorityGeneration: 4, expectedMainOid: MAIN_OID,
        idempotencyKey: 'retire-one', projectId: PROJECT_ID },
    });

    assert.equal(result.kind, 'project-retired');
    assert.equal(serviceState, 'deleting');
    assert.equal(deletionCreated, true);
    assert.equal(repositoryVerified, true);
  });

  it('replays Retire only to its exact initiating Manager after acknowledgement', async () => {
    const request = {
      expectedAuthorityGeneration: 4,
      expectedMainOid: MAIN_OID,
      idempotencyKey: 'retire-replay',
      projectId: PROJECT_ID,
    };
    const retirementId = `retire_${sha256(
      `${PROJECT_ID}\0${request.idempotencyKey}`,
    ).slice(0, 48)}`;
    const result = {
      acknowledgementRequired: true as const,
      kind: 'project-retired' as const,
      projectId: PROJECT_ID,
      retiredAt: NOW,
      retirementId,
      terminalExpiresAt: '2026-09-26T00:00:00.000Z',
    };
    const responseJson = JSON.stringify(result);
    const retirementJournal = Object.freeze({
      ...journal('retire', retirementId, 'completed'),
      actorMemberId: MANAGER_ID,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: sha256(JSON.stringify(request)),
      resultSha256: sha256(responseJson),
      state: 'completed' as const,
    });
    const responder = Object.freeze({
      acknowledgements: [{
        acknowledgedAt: NOW,
        memberId: MANAGER_ID,
        principalId: MANAGER_PRINCIPAL,
      }],
      createdAt: NOW,
      eligiblePrincipals: [{
        memberId: MEMBER_ID,
        principalId: MEMBER_PRINCIPAL,
      }],
      expiresAt: result.terminalExpiresAt,
      operationId: retirementId,
      operationKind: 'retire' as const,
      replayAuthorization: undefined,
      responseJson,
      responseSha256: sha256(responseJson),
    });
    const coordinator = new RetireCoordinator({
      clock: () => new Date(NOW),
      coordination: {
        async acquireProjectLease() {
          return {
            async close() {},
            async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
              return operation({ portability: {
                async getLifecycleJournal() { return retirementJournal; },
                async getTerminalResponder() { return responder; },
              } } as unknown as ProjectScope);
            },
          } as PinnedProjectLease;
        },
      },
      repository: {
        async reserveExactRepositoryOperation() { return repositoryReservation(); },
        async verifyExactRepository() { throw new Error('must not verify'); },
      },
    });

    await assert.rejects(
      coordinator.retire({ principalId: MEMBER_PRINCIPAL, request }),
      (error: unknown) => error instanceof RetireCoordinatorError
        && error.code === 'authorization-denied',
    );
    assert.deepEqual(
      await coordinator.retire({ principalId: MANAGER_PRINCIPAL, request }),
      result,
    );
  });

  it('rejects Retire acknowledgement at the terminal deadline before cleanup', async () => {
    const retirementId = 'retire-expired-acknowledgement';
    const expiresAt = '2026-09-26T00:00:00.000Z';
    let acknowledgements = 0;
    const responder = Object.freeze({
      acknowledgements: [],
      createdAt: NOW,
      eligiblePrincipals: [{
        memberId: MANAGER_ID,
        principalId: MANAGER_PRINCIPAL,
      }],
      expiresAt,
      operationId: retirementId,
      operationKind: 'retire' as const,
      replayAuthorization: undefined,
      responseJson: '{}',
      responseSha256: sha256('{}'),
    });
    const coordinator = new RetireCoordinator({
      clock: () => new Date(expiresAt),
      coordination: {
        async acquireProjectLease() {
          return {
            async close() {},
            async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
              return operation({ portability: {
                async acknowledgeTerminalResponder() {
                  acknowledgements += 1;
                  return 'advanced' as const;
                },
                async getTerminalResponder() { return responder; },
              } } as unknown as ProjectScope);
            },
          } as PinnedProjectLease;
        },
      },
      repository: {
        async reserveExactRepositoryOperation() {
          throw new Error('must not reserve');
        },
        async verifyExactRepository() { throw new Error('must not verify'); },
      },
    });

    await assert.rejects(coordinator.acknowledge({
      principalId: MANAGER_PRINCIPAL,
      request: {
        idempotencyKey: 'retire-expired-acknowledgement',
        projectId: PROJECT_ID,
        retirementId,
      },
    }), (error: unknown) => error instanceof RetireCoordinatorError
      && error.code === 'expired');
    assert.equal(acknowledgements, 0);
  });

  it('rejects non-Manager Retire without closing admission', async () => {
    const coordinator = new RetireCoordinator({
      clock: () => new Date(NOW),
      coordination: {
        async acquireProjectLease() {
          return {
            async close() {},
            async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
              return operation({
                findMembership: async () => ({ displayName: 'Member',
                  memberId: MEMBER_ID, revision: 1n, role: 'member', status: 'active' }),
                portability: { async findProjectPrincipalBinding() {
                  return { boundAt: NOW, memberId: MEMBER_ID,
                    principalId: MEMBER_PRINCIPAL, revokedAt: undefined,
                    state: 'active' as const };
                }, async getTerminalResponder() { return undefined; } },
              } as unknown as ProjectScope);
            },
          } as PinnedProjectLease;
        },
      },
      repository: {
        async reserveExactRepositoryOperation() { return repositoryReservation(); },
        async verifyExactRepository() { throw new Error('must not verify'); },
      },
    });
    await assert.rejects(
      coordinator.retire({ principalId: MEMBER_PRINCIPAL,
        request: { expectedAuthorityGeneration: 4, expectedMainOid: MAIN_OID,
          idempotencyKey: 'retire-denied', projectId: PROJECT_ID } }),
      (error: unknown) => {
        assert.ok(error instanceof RetireCoordinatorError);
        assert.equal(error.code, 'authorization-denied');
        return true;
      },
    );
  });

  it('expires terminal response data only after acknowledgement or deadline', async () => {
    let responder: TerminalResponderRecord | undefined = Object.freeze({
      acknowledgements: [], createdAt: NOW,
      eligiblePrincipals: [{ memberId: MANAGER_ID, principalId: MANAGER_PRINCIPAL }],
      expiresAt: '2026-09-26T00:00:00.000Z', operationId: 'retire-one',
      operationKind: 'retire', replayAuthorization: undefined,
      responseJson: '{}', responseSha256: sha256('{}'),
    });
    let cleaned = false;
    const expiry = new TerminalResponderExpiry({
      coordination: { async acquireProjectLease() {
        return { async close() {},
          async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
            return operation({ portability: {
              async getTerminalResponder() { return responder; },
              async removeTerminalResponder() { responder = undefined; return 'advanced' as const; },
              async cleanupTerminalArtifacts() { cleaned = true; return 'advanced' as const; },
            } } as unknown as ProjectScope);
          } } as PinnedProjectLease;
      } },
    });

    await expiry.expire({ operationId: 'retire-one', operationKind: 'retire',
      projectId: PROJECT_ID, removedAt: '2026-09-26T00:00:00.000Z' });
    assert.equal(responder, undefined);
    assert.equal(cleaned, true);
  });
});
