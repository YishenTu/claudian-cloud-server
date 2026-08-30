import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProjectReadScope } from '../../src/coordination/ProjectCoordination.js';
import {
  ProjectCollaborationReadAdmission,
  ProjectCollaborationReadAdmissionError,
} from '../../src/project-authority/admission/ProjectCollaborationReadAdmission.js';
import { createDevelopmentIngressPrincipal } from '../../src/request-context/IngressPrincipal.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

function fixture() {
  let activeJoin = false;
  let activeLifecycle = false;
  const scope = {
    findDevelopmentActorMember: () => Promise.resolve('member-a'),
    findMembership: () => Promise.resolve({
      displayName: 'Member A',
      memberId: 'member-a',
      revision: 1n,
      role: 'member' as const,
      status: 'active' as const,
    }),
    findPrincipalMember: () => Promise.resolve('member-a'),
    getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(undefined),
    getProject: () => Promise.resolve({
      expectedMainOid: 'a'.repeat(40),
      projectId: 'project-a',
      serviceState: 'active' as const,
    }),
    getRepositoryPlacement: () => Promise.resolve(
      createRepositoryPlacementLease({
        active: true,
        generation: 1,
        projectId: 'project-a',
        repositoryStorageKey: 'repository-a',
        storageNodeId: 'node-a',
      }),
    ),
    membership: {
      getNonterminalJoin: () => Promise.resolve(
        activeJoin ? ({ phase: 'membership-pending' } as never) : undefined,
      ),
    },
    portability: {
      getNonterminalLifecycleJournal: () => Promise.resolve(
        activeLifecycle ? ({ kind: 'leave' } as never) : undefined,
      ),
    },
  } as unknown as ProjectReadScope;
  const admission = new ProjectCollaborationReadAdmission({
    withProjectReadScope: (_projectId, operation) => operation(scope),
  });
  return {
    admission,
    setActiveJoin(value: boolean) {
      activeJoin = value;
    },
    setActiveLifecycle(value: boolean) {
      activeLifecycle = value;
    },
  };
}

async function expectRecoveryRequired(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, error => (
    error instanceof ProjectCollaborationReadAdmissionError
    && error.code === 'recovery-required'
  ));
}

describe('ProjectCollaborationReadAdmission', () => {
  it('fences an existing or newly prepared Join from ordinary reads', async () => {
    const existing = fixture();
    existing.setActiveJoin(true);
    await expectRecoveryRequired(existing.admission.run(
      createDevelopmentIngressPrincipal('member-a'),
      'project-a',
      () => Promise.reject(new Error('unexpected-read')),
    ));
    await existing.admission.close();

    const revalidation = fixture();
    await expectRecoveryRequired(revalidation.admission.run(
      createDevelopmentIngressPrincipal('member-a'),
      'project-a',
      read => {
        revalidation.setActiveJoin(true);
        return read.revalidate();
      },
    ));
    await revalidation.admission.close();

    const lifecycle = fixture();
    lifecycle.setActiveLifecycle(true);
    await expectRecoveryRequired(lifecycle.admission.run(
      createDevelopmentIngressPrincipal('member-a'),
      'project-a',
      () => Promise.reject(new Error('unexpected-read')),
    ));
    await lifecycle.admission.close();
  });
});
