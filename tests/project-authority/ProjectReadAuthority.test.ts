import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLLAB_MAIN_REF,
  collabMemberRef,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type { ProjectReadScope } from '../../src/coordination/ProjectCoordination.js';
import {
  ProjectReadAuthority,
  ProjectReadAuthorityError,
  type ProjectReadAuthorityCoordination,
  type ProjectReadRepository,
} from '../../src/project-authority/reads/ProjectReadAuthority.js';
import { createDevelopmentPrincipal } from '../../src/request-context/RequestPrincipal.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

const CREATED = '2026-08-21T00:00:00.000Z';
const MAIN_OID = 'a'.repeat(40);

interface MemoryState {
  activeAttempt: boolean;
  activeJoin: boolean;
  activeLifecycle: boolean;
  eventSequence: number;
  expectedMainOid: string;
  membershipStatus: 'active' | 'left';
  placementAvailable: boolean;
  projectAvailable: boolean;
  serviceState: 'active' | 'recovery-required';
}

class MemoryCoordination implements ProjectReadAuthorityCoordination {
  readonly state: MemoryState = {
    activeAttempt: false,
    activeJoin: false,
    activeLifecycle: false,
    eventSequence: 2,
    expectedMainOid: MAIN_OID,
    membershipStatus: 'active',
    placementAvailable: true,
    projectAvailable: true,
    serviceState: 'active',
  };
  memberCount = 2;

  withProjectReadScope<T>(
    projectId: CollabProjectId,
    operation: (scope: ProjectReadScope) => Promise<T>,
  ): Promise<T> {
    const members = Array.from({ length: this.memberCount }, (_, index) => {
      const number = index + 1;
      return Object.freeze({
        activatedAt: CREATED,
        createdAt: CREATED,
        displayName: `Member ${String(number).padStart(3, '0')}`,
        memberId: `member-${String(number).padStart(3, '0')}`,
        revision: 1n,
        role: number === 1 ? 'manager' as const : 'member' as const,
        status: number === 1 ? this.state.membershipStatus : 'active' as const,
      });
    });
    const activeMembers = members
      .filter(member => member.status === 'active')
      .map(member => Object.freeze({ ...member, status: 'active' as const }));
    const scope: ProjectReadScope = {
      accept: undefined as never,
      collaboration: {
        snapshot: {
          read: () => Promise.resolve({
            kind: 'snapshot' as const,
            snapshot: {
              openRequests: [],
              openTicketCount: 0,
              ticketHighlights: [],
            },
          }),
        },
      } as never,
      findDevelopmentActorMember: principalId => Promise.resolve(
        principalId === 'member-001' ? 'member-001' : undefined,
      ),
      findPrincipalMember: principalId => Promise.resolve(
        principalId === 'member-001' ? 'member-001' : undefined,
      ),
      findMembership: memberId => Promise.resolve(
        members.find(member => member.memberId === memberId),
      ),
      getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(
        this.state.activeAttempt
          ? ({ state: 'recovery-required' } as never)
          : undefined,
      ),
      getProject: () => Promise.resolve(
        this.state.projectAvailable
          ? {
            activatedAt: CREATED,
            authorityGeneration: 1,
            authorityStateRevision: 1,
            createdAt: CREATED,
            expectedMainOid: this.state.expectedMainOid,
            managerSetGeneration: 1,
            projectId,
            projectName: 'Read Project',
            serviceState: this.state.serviceState,
          }
          : undefined,
      ),
      getProjectEventSequence: () => Promise.resolve(this.state.eventSequence),
      getRepositoryPlacement: () => Promise.resolve(
        this.state.placementAvailable
          ? createRepositoryPlacementLease({
            active: true,
            generation: 1,
            projectId,
            repositoryStorageKey: 'repository-a',
            storageNodeId: 'node-a',
          })
          : undefined,
      ),
      listActiveSnapshotMemberships: () => Promise.resolve(activeMembers),
      membership: {
        getNonterminalJoin: () => Promise.resolve(
          this.state.activeJoin ? ({ phase: 'membership-pending' } as never) : undefined,
        ),
      },
      portability: {
        getNonterminalLifecycleJournal: () => Promise.resolve(
          this.state.activeLifecycle ? ({ kind: 'remove-member' } as never) : undefined,
        ),
      },
      readProjectEvents: ({ afterSequence }) => Promise.resolve({
        events: afterSequence === 0 ? [
          {
            kind: 'membership.updated',
            occurredAt: CREATED,
            payload: { memberId: 'member-001' },
            projectId,
            protocolVersion: 9,
            sequence: 1,
          },
          {
            kind: 'main.updated',
            occurredAt: CREATED,
            payload: { mainOid: MAIN_OID, requestId: 'request-001' },
            projectId,
            protocolVersion: 9,
            sequence: 2,
          },
        ] : [],
        latestSequence: this.state.eventSequence,
        retainedFromSequence: 1,
      }),
    };
    return operation(scope);
  }
}

class MemoryRepository implements ProjectReadRepository {
  readonly checks: string[] = [];
  readonly expectedRefChecks: string[][] = [];
  mainOid = MAIN_OID;
  onUploadAdmitted: (() => void) | undefined;
  onVerify: (() => void) | undefined;

  advertiseUploadPack(
    _placement: Parameters<ProjectReadRepository['advertiseUploadPack']>[0],
    options: Parameters<ProjectReadRepository['advertiseUploadPack']>[1],
  ): Promise<Buffer> {
    this.expectedRefChecks.push(options.expectedRefs.map(ref => ref.name));
    this.onUploadAdmitted?.();
    return options.revalidateAuthority().then(() => Buffer.from('advertisement'));
  }

  runUploadPack(
    _placement: Parameters<ProjectReadRepository['runUploadPack']>[0],
    options: Parameters<ProjectReadRepository['runUploadPack']>[1],
  ): Promise<void> {
    this.expectedRefChecks.push(options.expectedRefs.map(ref => ref.name));
    this.onUploadAdmitted?.();
    return options.revalidateAuthority().then(() => options.onResponseChunk(
      Buffer.from('pack'),
      options.signal ?? new AbortController().signal,
    ));
  }

  verifyProjectRead(input: Parameters<ProjectReadRepository['verifyProjectRead']>[0]) {
    this.checks.push(`${input.placement.projectId}:${input.expectedMainOid}`);
    this.expectedRefChecks.push(input.expectedRefs.map(ref => ref.name));
    this.onVerify?.();
    if (input.expectedMainOid !== this.mainOid) {
      return Promise.reject(new Error('main-mismatch'));
    }
    return Promise.resolve();
  }
}

function authority() {
  const coordination = new MemoryCoordination();
  const repository = new MemoryRepository();
  return {
    coordination,
    read: new ProjectReadAuthority({ coordination, repository }),
    repository,
  };
}

async function expectReadError(
  operation: Promise<unknown>,
  code: ProjectReadAuthorityError['code'],
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ProjectReadAuthorityError);
    assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify(error), /repository-a|member-001|Read Project/);
    return true;
  });
}

describe('ProjectReadAuthority', () => {
  it('constructs the exact bounded Project snapshot and revalidates it', async () => {
    const { read, repository } = authority();
    const snapshot = await read.getProjectSnapshot(
      createDevelopmentPrincipal('member-001'),
      'project-a',
    );

    assert.deepEqual(snapshot, {
      currentMember: {
        activatedAt: CREATED,
        createdAt: CREATED,
        displayName: 'Member 001',
        id: 'member-001',
        personalRef: collabMemberRef('member-001'),
        role: 'manager',
        status: 'active',
      },
      eventSequence: 2,
      members: [
        {
          activatedAt: CREATED,
          createdAt: CREATED,
          displayName: 'Member 001',
          id: 'member-001',
          personalRef: collabMemberRef('member-001'),
          role: 'manager',
          status: 'active',
        },
        {
          activatedAt: CREATED,
          createdAt: CREATED,
          displayName: 'Member 002',
          id: 'member-002',
          personalRef: collabMemberRef('member-002'),
          role: 'member',
          status: 'active',
        },
      ],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityGeneration: 1,
        createdAt: CREATED,
        expectedMainOid: MAIN_OID,
        id: 'project-a',
        mainRef: COLLAB_MAIN_REF,
        name: 'Read Project',
      },
      ticketHighlights: [],
    });
    assert.deepEqual(repository.checks, [
      `project-a:${MAIN_OID}`,
      `project-a:${MAIN_OID}`,
    ]);
    assert.deepEqual(repository.expectedRefChecks, [
      [
        COLLAB_MAIN_REF,
        collabMemberRef('member-001'),
        collabMemberRef('member-002'),
      ],
      [
        COLLAB_MAIN_REF,
        collabMemberRef('member-001'),
        collabMemberRef('member-002'),
      ],
    ]);
  });

  it('makes an unknown Project indistinguishable from an unrelated Project', async () => {
    const unrelated = authority();
    unrelated.coordination.state.activeAttempt = true;
    await expectReadError(
      unrelated.read.getProjectSnapshot(
        createDevelopmentPrincipal('outsider'),
        'project-a',
      ),
      'project-not-found',
    );

    const unknown = authority();
    unknown.coordination.state.projectAvailable = false;
    await expectReadError(
      unknown.read.getProjectSnapshot(
        createDevelopmentPrincipal('outsider'),
        'project-unknown',
      ),
      'project-not-found',
    );

    const inactive = authority();
    inactive.coordination.state.activeAttempt = true;
    inactive.coordination.state.membershipStatus = 'left';
    await expectReadError(
      inactive.read.getProjectSnapshot(
        createDevelopmentPrincipal('member-001'),
        'project-a',
      ),
      'project-not-found',
    );
  });

  it('fails closed on authorization, recovery, collection, and revalidation changes', async () => {
    {
      const { read } = authority();
      await expectReadError(
        read.getProjectSnapshot(
          createDevelopmentPrincipal('outsider'),
          'project-a',
        ),
        'project-not-found',
      );
    }
    {
      const { coordination, read } = authority();
      coordination.state.serviceState = 'recovery-required';
      await expectReadError(
        read.getProjectSnapshot(
          createDevelopmentPrincipal('member-001'),
          'project-a',
        ),
        'recovery-required',
      );
    }
    {
      const { coordination, read } = authority();
      coordination.state.activeAttempt = true;
      await expectReadError(
        read.getProjectSnapshot(
          createDevelopmentPrincipal('member-001'),
          'project-a',
        ),
        'recovery-required',
      );
    }
    {
      const { coordination, read } = authority();
      coordination.state.activeJoin = true;
      await expectReadError(
        read.getProjectSnapshot(
          createDevelopmentPrincipal('member-001'),
          'project-a',
        ),
        'recovery-required',
      );
    }
    {
      const { coordination, read } = authority();
      coordination.state.activeLifecycle = true;
      await expectReadError(
        read.getProjectSnapshot(
          createDevelopmentPrincipal('member-001'),
          'project-a',
        ),
        'recovery-required',
      );
    }
    {
      const { coordination, read } = authority();
      coordination.state.placementAvailable = false;
      await expectReadError(
        read.getProjectSnapshot(
          createDevelopmentPrincipal('member-001'),
          'project-a',
        ),
        'state-conflict',
      );
    }
    {
      const { coordination, read } = authority();
      coordination.memberCount = 101;
      await expectReadError(
        read.getProjectSnapshot(
          createDevelopmentPrincipal('member-001'),
          'project-a',
        ),
        'project-too-large',
      );
    }
    {
      const { coordination, read, repository } = authority();
      const original = repository.verifyProjectRead.bind(repository);
      let checks = 0;
      repository.verifyProjectRead = async input => {
        await original(input);
        checks += 1;
        if (checks === 1) coordination.state.membershipStatus = 'left';
      };
      await expectReadError(
        read.getProjectSnapshot(
          createDevelopmentPrincipal('member-001'),
          'project-a',
        ),
        'project-not-found',
      );
    }
  });

  it('returns only contiguous bounded replay or snapshot-required', async () => {
    const { coordination, read, repository } = authority();
    const principal = createDevelopmentPrincipal('member-001');
    assert.deepEqual(await read.getProjectEvents(principal, 'project-a', 0), {
      events: [
        {
          kind: 'membership.updated',
          occurredAt: CREATED,
          payload: { memberId: 'member-001' },
          projectId: 'project-a',
          protocolVersion: 9,
          sequence: 1,
        },
        {
          kind: 'main.updated',
          occurredAt: CREATED,
          payload: { mainOid: MAIN_OID, requestId: 'request-001' },
          projectId: 'project-a',
          protocolVersion: 9,
          sequence: 2,
        },
      ],
      kind: 'events',
      latestSequence: 2,
    });

    coordination.state.eventSequence = 501;
    assert.deepEqual(await read.getProjectEvents(principal, 'project-a', 0), {
      kind: 'snapshot-required',
      latestSequence: 501,
    });
    assert.deepEqual(await read.getProjectEvents(principal, 'project-a', 502), {
      kind: 'snapshot-required',
      latestSequence: 501,
    });
    assert.equal(repository.checks.length, 6);
  });

  it('fails event replay when final repository revalidation changes', async () => {
    const { read, repository } = authority();
    let checks = 0;
    const original = repository.verifyProjectRead.bind(repository);
    repository.verifyProjectRead = async input => {
      checks += 1;
      await original(input);
      if (checks === 1) repository.mainOid = 'b'.repeat(40);
    };
    await expectReadError(
      read.getProjectEvents(
        createDevelopmentPrincipal('member-001'),
        'project-a',
        0,
      ),
      'dependency-failed',
    );
    assert.equal(checks, 2);
  });

  it('revalidates explicit upload-pack authority immediately before Git proceeds', async () => {
    const { coordination, read, repository } = authority();
    const principal = createDevelopmentPrincipal('member-001');
    let checks = 0;
    repository.onVerify = () => {
      checks += 1;
      if (checks === 1) coordination.state.eventSequence = 3;
    };
    const result = await read.advertiseUploadPack(
      principal,
      'project-a',
    );
    assert.equal(result.toString('utf8'), 'advertisement');
    assert.equal(checks, 2);
    assert.deepEqual(repository.expectedRefChecks.at(-1), [
      COLLAB_MAIN_REF,
      collabMemberRef('member-001'),
      collabMemberRef('member-002'),
    ]);

    const rejected = authority();
    let rejectedChecks = 0;
    rejected.repository.onVerify = () => {
      rejectedChecks += 1;
      if (rejectedChecks === 1) {
        rejected.coordination.state.membershipStatus = 'left';
      }
    };
    await expectReadError(
      rejected.read.advertiseUploadPack(principal, 'project-a'),
      'project-not-found',
    );

    const queued = authority();
    queued.repository.onUploadAdmitted = () => {
      queued.coordination.state.membershipStatus = 'left';
    };
    await expectReadError(
      queued.read.advertiseUploadPack(principal, 'project-a'),
      'project-not-found',
    );
  });

  it('aborts admitted reads during close and rejects later admission once', async () => {
    const { read, repository } = authority();
    let observedSignal: AbortSignal | undefined;
    repository.verifyProjectRead = input => new Promise((_resolve, reject) => {
      observedSignal = input.signal;
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });
    const pending = read.getProjectSnapshot(
      createDevelopmentPrincipal('member-001'),
      'project-a',
    );
    await new Promise(resolve => setImmediate(resolve));
    const closing = read.close();
    await expectReadError(pending, 'cancelled');
    await closing;
    assert.equal(observedSignal?.aborted, true);
    await expectReadError(
      read.getProjectSnapshot(
        createDevelopmentPrincipal('member-001'),
        'project-a',
      ),
      'closed',
    );
    await new Promise(resolve => setImmediate(resolve));
  });
});
