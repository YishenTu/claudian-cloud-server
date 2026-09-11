/* eslint-disable @typescript-eslint/require-await */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ProjectMemberRemovalJournal,
} from '../../src/coordination/ProjectMembershipPersistence.js';
import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import {
  ProjectMemberRemovalCoordinator,
} from '../../src/project-authority/membership/ProjectMemberRemovalCoordinator.js';
import { createVaultCredentialPrincipal } from '../../src/request-context/RequestPrincipal.js';

const PROJECT_ID = 'project-removal';
const MANAGER_ID = 'member-manager';
const MEMBER_ID = 'member-target';
const PERSONAL_OID = '1'.repeat(40);
const NOW = '2026-08-30T10:00:00.000Z';

describe('ProjectMemberRemovalCoordinator', () => {
  it('settles membership before deleting the exact persisted personal ref', async () => {
    const effects: string[] = [];
    let competingLifecycle = true;
    let stalePreparedJournal = true;
    let journal: ProjectMemberRemovalJournal | undefined;
    const response = Object.freeze({
      discardedRequestId: 'request-open',
      managerSetGeneration: 3,
      memberId: MEMBER_ID,
      projectId: PROJECT_ID,
      removedAt: NOW,
      status: 'revoked' as const,
    });
    const membership = {
      async getNonterminalJoin() { return undefined; },
      async getRemoval() { return journal; },
      async insertRemoval(input: Omit<
        ProjectMemberRemovalJournal,
        'phase' | 'response' | 'updatedAt'
      >) {
        journal = Object.freeze({
          ...input,
          phase: 'prepared' as const,
          response: undefined,
          updatedAt: input.preparedAt,
        });
        return journal;
      },
      async readMemberExitFacts() {
        return {
          activeManagerCount: 1n, leftAt: null, managerSetGeneration: 3,
          openRequestId: 'request-open', revision: 7n, role: 'member' as const,
          status: journal !== undefined && stalePreparedJournal ? 'revoked' as const : 'active' as const,
        };
      },
      async applyMemberExit() { effects.push('settle'); },
      async recordRemovalSettlement(input: { readonly response: typeof response }) {
        assert.ok(journal);
        journal = Object.freeze({ ...journal, phase: 'membership-revoked' as const, response: input.response });
      },
      async advanceRemoval() {
        assert.ok(journal);
        journal = Object.freeze({
          ...journal,
          phase: 'personal-ref-removed' as const,
        });
        return 'advanced' as const;
      },
      async completeRemoval() {
        effects.push('complete');
        assert.ok(journal);
        journal = Object.freeze({ ...journal, phase: 'completed' as const });
        return response;
      },
    };
    const lease = {
      async close() {},
      async withProjectScope<T>(operation: (scope: ProjectScope) => Promise<T>) {
        return operation({
          accept: { async getNonterminal() { return undefined; } },
          appendProjectEvent: async () => {
            effects.push('event');
            return {} as never;
          },
          findMembership: async (memberId: string) => ({
            displayName: memberId === MANAGER_ID ? 'Manager' : 'Member',
            memberId,
            revision: memberId === MANAGER_ID ? 4n : 7n,
            role: memberId === MANAGER_ID ? 'manager' : 'member',
            status: 'active',
          }),
          getNonterminalDevelopmentBootstrapAttempt: async () => undefined,
          getProject: async () => ({
            activatedAt: NOW,
            authorityGeneration: 1,
            authorityStateRevision: 1,
            createdAt: NOW,
            expectedMainOid: PERSONAL_OID,
            managerSetGeneration: 3,
            projectId: PROJECT_ID,
            projectName: 'Removal',
            serviceState: 'active',
          }),
          getRepositoryPlacement: async () => ({
            active: true,
            generation: 2,
            projectId: PROJECT_ID,
            repositoryStorageKey: 'repository_removal',
            storageNodeId: 'local',
          }),
          membership,
          portability: {
            async findProjectPrincipalBinding() {
              return {
                boundAt: NOW,
                memberId: MANAGER_ID,
                principalId: 'principal:manager',
                revokedAt: undefined,
                state: 'active' as const,
              };
            },
            async getNonterminalLifecycleJournal() {
              return competingLifecycle ? { operationId: 'accept-active' } : undefined;
            },
          },
        } as unknown as ProjectScope);
      },
    } as PinnedProjectLease;
    const coordinator = new ProjectMemberRemovalCoordinator({
      clock: () => new Date(NOW),
      coordination: { async acquireProjectLease() { return lease; } },
      repository: {
        async reserveExactRepositoryOperation() {
          return { async close() {}, projectId: PROJECT_ID };
        },
        async readExactPersonalRef(_reservation, input) {
          effects.push('read');
          assert.equal(input.personalRef, `refs/heads/members/${MEMBER_ID}`);
          return PERSONAL_OID;
        },
        async verifyExactPersonalRef(_reservation, input) {
          effects.push('verify');
          assert.equal(input.expectedOid, PERSONAL_OID);
        },
        async deleteExactPersonalRef(_reservation, input) {
          effects.push('delete');
          assert.equal(input.expectedOid, PERSONAL_OID);
          return 'deleted' as const;
        },
      },
    });

    const principal = createVaultCredentialPrincipal({
      principalId: 'principal:manager',
    });
    const request = {
      expectedManagerSetGeneration: 3,
      expectedTargetMembershipRevision: 7,
      idempotencyKey: 'remove-target',
      projectId: PROJECT_ID,
      targetMemberId: MEMBER_ID,
    } as const;

    await assert.rejects(
      coordinator.remove(principal, request),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'authority-not-synchronized',
    );
    assert.equal(journal, undefined);
    assert.deepEqual(effects, []);

    competingLifecycle = false;
    for (const staleRequest of [
      { ...request, expectedManagerSetGeneration: 2 },
      { ...request, expectedTargetMembershipRevision: 6 },
    ]) {
      await assert.rejects(coordinator.remove(principal, staleRequest), {
        code: 'authority-not-synchronized', name: 'ProjectMutationRejection',
      });
      assert.equal(journal, undefined);
      assert.deepEqual(effects, []);
    }

    await assert.rejects(coordinator.remove(principal, request), {
      code: 'authority-not-synchronized', name: 'CollabError',
    });
    assert.equal((await membership.getRemoval())?.phase, 'prepared');
    assert.deepEqual(effects, ['read', 'verify']);
    stalePreparedJournal = false;
    assert.deepEqual(await coordinator.remove(
      principal,
      request,
    ), response);
    assert.deepEqual(effects, [
      'read',
      'verify',
      'verify',
      'settle',
      'event',
      'delete',
      'complete',
    ]);
  });
});
