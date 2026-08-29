import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/postgres/PostgresCoordination.js';
import {
  ActiveRepositoryIntegrityGate,
  type ActiveRepositoryIntegrityCoordination,
  type ActiveRepositoryIntegrityRepository,
} from '../../src/project-authority/lifecycle/ActiveRepositoryIntegrityGate.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

const placement = createRepositoryPlacementLease({
  active: true,
  generation: 1,
  projectId: 'project-active',
  repositoryStorageKey: 'repository_active',
  storageNodeId: 'node-a',
});

function scope(options: { readonly bothManagers?: boolean } = {}): ProjectScope {
  return {
    findDevelopmentActorMember: () => Promise.resolve(undefined),
    findMembership: () => Promise.resolve(undefined),
    getActiveDevelopmentBootstrapAttempt: () => Promise.resolve(undefined),
    getDevelopmentBootstrapAttempt: () => Promise.resolve(undefined),
    getDevelopmentBootstrapRecoveryAttempt: () => Promise.resolve(undefined),
    getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(undefined),
    getProject: () => Promise.resolve({
      activatedAt: '2026-08-21T00:00:00.000Z',
      createdAt: '2026-08-21T00:00:00.000Z',
      expectedMainOid: 'a'.repeat(40),
      managerSetGeneration: 0,
      projectId: 'project-active',
      projectName: 'Active project',
      serviceState: 'active',
    }),
    getRepositoryPlacement: () => Promise.resolve(placement),
    listMemberships: () => Promise.resolve([{
      displayName: 'Alice',
      memberId: 'member-a',
      revision: 1n,
      role: 'manager',
      status: 'active',
    }, {
      displayName: 'Bob',
      memberId: 'member-b',
      revision: 1n,
      role: options.bothManagers ? 'manager' : 'member',
      status: 'active',
    }]),
  } as unknown as ProjectScope;
}

describe('ActiveRepositoryIntegrityGate', () => {
  it('can verify without mutating receive-pack state', async () => {
    let cleaned = false;
    const coordination: ActiveRepositoryIntegrityCoordination = {
      acquireProjectLease: () => Promise.resolve({
        close: () => Promise.resolve(),
        drainDevelopmentBootstrapUploads: () => Promise.resolve(),
        handoffToDevelopmentBootstrapUpload: () => Promise.resolve({
          close: () => Promise.resolve(),
        }),
        withProjectScope: operation => operation(scope()),
      } satisfies PinnedProjectLease),
      listActiveRepositoryPlacements: () => Promise.resolve({
        nextCursor: undefined,
        placements: [placement],
      }),
    };
    const repository: ActiveRepositoryIntegrityRepository = {
      cleanupReceivePackState: () => {
        cleaned = true;
        return Promise.resolve();
      },
      verifyIntegrity: () => Promise.resolve({ status: 'valid' }),
    };
    await new ActiveRepositoryIntegrityGate({
      cleanupReceivePackState: false,
      coordination,
      repository,
    }).verifyAll();
    assert.equal(cleaned, false);
  });

  it('re-enters Project scope and verifies exact authoritative refs', async () => {
    const calls: unknown[] = [];
    const coordination: ActiveRepositoryIntegrityCoordination = {
      acquireProjectLease: () => Promise.resolve({
        close: () => Promise.resolve(),
        drainDevelopmentBootstrapUploads: () => Promise.resolve(),
        handoffToDevelopmentBootstrapUpload: () => Promise.resolve({
          close: () => Promise.resolve(),
        }),
        withProjectScope: operation => operation(scope()),
      } satisfies PinnedProjectLease),
      listActiveRepositoryPlacements: options => Promise.resolve({
        nextCursor: undefined,
        placements: options?.after === undefined ? [placement] : [],
      }),
    };
    const repository: ActiveRepositoryIntegrityRepository = {
      cleanupReceivePackState: accepted => {
        calls.push({ cleanup: accepted });
        return Promise.resolve();
      },
      verifyIntegrity: (accepted, options) => {
        calls.push({ accepted, options });
        return Promise.resolve({ status: 'valid' });
      },
    };
    await new ActiveRepositoryIntegrityGate({ coordination, repository })
      .verifyAll();

    assert.deepEqual(calls, [{
      cleanup: placement,
    }, {
      accepted: placement,
      options: {
        expectedRefs: [{
          name: 'refs/heads/main',
          oid: 'a'.repeat(40),
        }, {
          name: 'refs/heads/members/member-a',
        }, {
          name: 'refs/heads/members/member-b',
        }],
      },
    }]);
  });

  it('accepts an active Project with more than one Manager', async () => {
    const coordination: ActiveRepositoryIntegrityCoordination = {
      acquireProjectLease: () => Promise.resolve({
        close: () => Promise.resolve(),
        drainDevelopmentBootstrapUploads: () => Promise.resolve(),
        handoffToDevelopmentBootstrapUpload: () => Promise.resolve({
          close: () => Promise.resolve(),
        }),
        withProjectScope: operation => operation(scope({ bothManagers: true })),
      } satisfies PinnedProjectLease),
      listActiveRepositoryPlacements: () => Promise.resolve({
        nextCursor: undefined,
        placements: [placement],
      }),
    };
    const repository: ActiveRepositoryIntegrityRepository = {
      cleanupReceivePackState: () => Promise.resolve(),
      verifyIntegrity: () => Promise.resolve({ status: 'valid' }),
    };

    await new ActiveRepositoryIntegrityGate({ coordination, repository })
      .verifyAll();
  });

  it('verifies every active Member while ignoring historical memberships', async () => {
    const historicalScope = {
      ...scope(),
      listMemberships: () => Promise.resolve([{
        displayName: 'Alice',
        memberId: 'member-a',
        revision: 1n,
        role: 'manager' as const,
        status: 'active' as const,
      }, {
        displayName: 'Bob',
        memberId: 'member-b',
        revision: 2n,
        role: 'member' as const,
        status: 'left' as const,
      }, {
        displayName: 'Carol',
        memberId: 'member-c',
        revision: 1n,
        role: 'member' as const,
        status: 'active' as const,
      }, {
        displayName: 'Dylan',
        memberId: 'member-d',
        revision: 1n,
        role: 'member' as const,
        status: 'active' as const,
      }]),
    } as unknown as ProjectScope;
    let expectedRefs: readonly { readonly name: string }[] = [];
    const coordination: ActiveRepositoryIntegrityCoordination = {
      acquireProjectLease: () => Promise.resolve({
        close: () => Promise.resolve(),
        drainDevelopmentBootstrapUploads: () => Promise.resolve(),
        handoffToDevelopmentBootstrapUpload: () => Promise.resolve({
          close: () => Promise.resolve(),
        }),
        withProjectScope: operation => operation(historicalScope),
      } satisfies PinnedProjectLease),
      listActiveRepositoryPlacements: () => Promise.resolve({
        nextCursor: undefined,
        placements: [placement],
      }),
    };
    const repository: ActiveRepositoryIntegrityRepository = {
      cleanupReceivePackState: () => Promise.resolve(),
      verifyIntegrity: (_accepted, options) => {
        expectedRefs = options.expectedRefs;
        return Promise.resolve({ status: 'valid' });
      },
    };

    await new ActiveRepositoryIntegrityGate({ coordination, repository })
      .verifyAll();

    assert.deepEqual(expectedRefs.map(ref => ref.name), [
      'refs/heads/main',
      'refs/heads/members/member-a',
      'refs/heads/members/member-c',
      'refs/heads/members/member-d',
    ]);
  });

  it('propagates maintenance cancellation into repository verification', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const coordination: ActiveRepositoryIntegrityCoordination = {
      acquireProjectLease: () => Promise.resolve({
        close: () => Promise.resolve(),
        drainDevelopmentBootstrapUploads: () => Promise.resolve(),
        handoffToDevelopmentBootstrapUpload: () => Promise.resolve({
          close: () => Promise.resolve(),
        }),
        withProjectScope: operation => operation(scope()),
      } satisfies PinnedProjectLease),
      listActiveRepositoryPlacements: () => Promise.resolve({
        nextCursor: undefined,
        placements: [placement],
      }),
    };
    const repository: ActiveRepositoryIntegrityRepository = {
      cleanupReceivePackState: () => Promise.resolve(),
      verifyIntegrity: (_placement, options) => {
        received = options.signal;
        return Promise.resolve({ status: 'valid' });
      },
    };

    await new ActiveRepositoryIntegrityGate({ coordination, repository })
      .verifyAll(controller.signal);
    assert.equal(received, controller.signal);
  });
});
