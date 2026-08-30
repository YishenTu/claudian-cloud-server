import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  ProjectLifecycleJournalRecord,
} from '../../src/coordination/PortabilityLifecyclePersistence.js';
import type {
  PinnedProjectLease,
  ProjectReadScope,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import {
  ProjectWriteAdmission,
  ProjectWriteAdmissionError,
} from '../../src/project-authority/admission/ProjectWriteAdmission.js';
import {
  createDevelopmentIngressPrincipal,
} from '../../src/request-context/IngressPrincipal.js';
import {
  createRepositoryPlacementLease,
} from '../../src/repositories/RepositoryPlacement.js';

const MAIN_OID = '1'.repeat(40);
const CREATED_AT = '2026-08-25T00:00:00.000Z';

function activeLifecycle(): ProjectLifecycleJournalRecord {
  return Object.freeze({
    actorMemberId: undefined,
    batchRevision: undefined,
    batchSha256: undefined,
    checkpointSha256: undefined,
    createdAt: CREATED_AT,
    direction: undefined,
    expectedAuthorityGeneration: 1,
    idempotencyKey: 'intent-backup',
    kind: 'backup',
    operationId: 'operation-backup',
    phase: 'prepared',
    projectId: 'project-a',
    recoveryFromPhase: undefined,
    requestFingerprint: 'a'.repeat(64),
    resultSha256: undefined,
    scheduledAt: CREATED_AT,
    state: 'active',
    updatedAt: CREATED_AT,
  });
}

class MemoryCoordination {
  joinActive = false;
  lifecycle: ProjectLifecycleJournalRecord | undefined = activeLifecycle();
  leaseCount = 0;
  membershipAvailable = true;

  acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease> {
    this.leaseCount += 1;
    return Promise.resolve({
      close: () => Promise.resolve(),
      drainDevelopmentBootstrapUploads: () => Promise.resolve(),
      handoffToDevelopmentBootstrapUpload: () => Promise.reject(
        new Error('unexpected-upload-handoff'),
      ),
      withProjectScope: <T>(
        operation: (scope: ProjectScope) => Promise<T>,
      ): Promise<T> => operation({
        accept: { getNonterminal: () => Promise.resolve(undefined) },
        findDevelopmentActorMember: () => Promise.resolve(
          this.membershipAvailable ? 'member-manager' : undefined,
        ),
        findPrincipalMember: () => Promise.resolve(
          this.membershipAvailable ? 'member-manager' : undefined,
        ),
        findMembership: () => Promise.resolve({
          displayName: 'Manager',
          memberId: 'member-manager',
          revision: 1n,
          role: 'manager',
          status: 'active',
        }),
        getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(
          undefined,
        ),
        getProject: () => Promise.resolve({
          activatedAt: CREATED_AT,
          authorityGeneration: 1,
          authorityStateRevision: 1,
          createdAt: CREATED_AT,
          expectedMainOid: MAIN_OID,
          managerSetGeneration: 1,
          projectId,
          projectName: 'Project A',
          serviceState: 'active',
        }),
        getRepositoryPlacement: () => Promise.resolve(
          createRepositoryPlacementLease({
            active: true,
            generation: 1,
            projectId,
            repositoryStorageKey: 'repo_project_a',
            storageNodeId: 'node-a',
          }),
        ),
        membership: {
          getNonterminalJoin: () => Promise.resolve(
            this.joinActive ? ({ phase: 'membership-pending' } as never) : undefined,
          ),
        },
        portability: {
          getNonterminalLifecycleJournal: () => Promise.resolve(this.lifecycle),
        },
      } as unknown as ProjectScope),
    });
  }

  withProjectReadScope<T>(
    _projectId: CollabProjectId,
    _operation: (scope: ProjectReadScope) => Promise<T>,
  ): Promise<T> {
    return Promise.reject(new Error('unexpected-read-scope'));
  }
}

describe('ProjectWriteAdmission', () => {
  it('recovers a nonterminal lifecycle journal before ordinary authorization', async () => {
    const coordination = new MemoryCoordination();
    let recoveryCount = 0;
    const admission = new ProjectWriteAdmission({
      coordination,
      recovery: {
        recoverProject: projectId => {
          assert.equal(projectId, 'project-a');
          recoveryCount += 1;
          coordination.lifecycle = undefined;
          return Promise.resolve();
        },
      },
    });

    assert.equal(await admission.run(
      createDevelopmentIngressPrincipal('member-manager'),
      'project-a',
      write => Promise.resolve(write.projectId),
    ), 'project-a');
    assert.equal(recoveryCount, 1);
    assert.equal(coordination.leaseCount, 2);
    await admission.close();
  });

  it('recovers a nonterminal Join before admitting an ordinary write', async () => {
    const coordination = new MemoryCoordination();
    coordination.lifecycle = undefined;
    coordination.joinActive = true;
    let recoveryCount = 0;
    const admission = new ProjectWriteAdmission({
      coordination,
      recovery: {
        recoverProject: () => {
          recoveryCount += 1;
          coordination.joinActive = false;
          return Promise.resolve();
        },
      },
    });

    assert.equal(await admission.run(
      createDevelopmentIngressPrincipal('member-manager'),
      'project-a',
      write => Promise.resolve(write.projectId),
    ), 'project-a');
    assert.equal(recoveryCount, 1);
    assert.equal(coordination.leaseCount, 2);
    await admission.close();
  });

  it('resumes an authorized deletion after its membership rows are gone', async () => {
    const coordination = new MemoryCoordination();
    coordination.lifecycle = Object.freeze({
      ...activeLifecycle(),
      idempotencyKey: 'intent-delete',
      kind: 'delete',
      operationId: 'operation-delete',
    });
    coordination.membershipAvailable = false;
    let recoveryCount = 0;
    const admission = new ProjectWriteAdmission({
      coordination,
      recovery: {
        recoverProject: () => {
          recoveryCount += 1;
          coordination.lifecycle = undefined;
          return Promise.resolve();
        },
      },
    });

    await assert.rejects(admission.run(
      createDevelopmentIngressPrincipal('former-member'),
      'project-a',
      () => Promise.reject(new Error('unexpected-operation')),
    ), error => {
      assert.ok(error instanceof ProjectWriteAdmissionError);
      assert.equal(error.code, 'authorization-denied');
      return true;
    });
    assert.equal(recoveryCount, 1);
    assert.equal(coordination.leaseCount, 2);
    await admission.close();
  });
});
