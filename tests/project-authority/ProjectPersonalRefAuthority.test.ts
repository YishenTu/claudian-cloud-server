import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collabMemberRef,
  type CollabMemberId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  PinnedProjectLease,
  ProjectReadScope,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import { ProjectWriteAdmissionError } from '../../src/project-authority/admission/ProjectWriteAdmission.js';
import {
  ProjectPersonalRefAuthority,
  type ProjectPersonalRefRepository,
} from '../../src/project-authority/writes/ProjectPersonalRefAuthority.js';
import { createDevelopmentIngressPrincipal } from '../../src/request-context/IngressPrincipal.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

const MAIN_OID = '1111111111111111111111111111111111111111';

async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timeout:${label}`)), 1_000);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class MemoryCoordination {
  readonly #tails = new Map<CollabProjectId, Promise<void>>();

  constructor(readonly events: string[]) {}

  async acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease> {
    this.events.push(`lock-request:${projectId}`);
    const previous = this.#tails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.#tails.set(projectId, previous.then(() => current));
    await previous;
    this.events.push(`lock-acquired:${projectId}`);
    let closed = false;
    return {
      close: () => {
        if (!closed) {
          closed = true;
          this.events.push(`lock-released:${projectId}`);
          release();
        }
        return Promise.resolve();
      },
      drainDevelopmentBootstrapUploads: () => Promise.resolve(),
      handoffToDevelopmentBootstrapUpload: () => Promise.reject(
        new Error('unexpected-upload-handoff'),
      ),
      withProjectScope: async <T>(
        operation: (scope: ProjectScope) => Promise<T>,
      ): Promise<T> => operation({
        accept: { getNonterminal: () => Promise.resolve(undefined) },
        findDevelopmentActorMember: (actorId: string) => Promise.resolve(
          actorId,
        ),
        findMembership: (memberId: CollabMemberId) => Promise.resolve({
          displayName: memberId,
          memberId,
          revision: 1n,
          role: 'member' as const,
          status: 'active' as const,
        }),
        getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(undefined),
        portability: {
          getNonterminalLifecycleJournal: () => Promise.resolve(undefined),
        },
        getProject: () => Promise.resolve({
          activatedAt: '2026-08-22T00:00:00.000Z',
          createdAt: '2026-08-22T00:00:00.000Z',
          expectedMainOid: MAIN_OID,
          managerSetGeneration: 1,
          projectId,
          projectName: projectId,
          serviceState: 'active' as const,
        }),
        getRepositoryPlacement: () => Promise.resolve(
          createRepositoryPlacementLease({
            active: true,
            generation: 1,
            projectId,
            repositoryStorageKey: `repo_${projectId.replaceAll('-', '_')}`,
            storageNodeId: 'node-a',
          }),
        ),
      } as unknown as ProjectScope),
    };
  }

  withProjectReadScope<T>(
    projectId: CollabProjectId,
    operation: (scope: ProjectReadScope) => Promise<T>,
  ): Promise<T> {
    return operation({
      findDevelopmentActorMember: (actorId: string) => Promise.resolve(actorId),
      findMembership: (memberId: CollabMemberId) => Promise.resolve({
        displayName: memberId,
        memberId,
        revision: 1n,
        role: 'member' as const,
        status: 'active' as const,
      }),
      getProject: () => Promise.resolve({
        activatedAt: '2026-08-22T00:00:00.000Z',
        createdAt: '2026-08-22T00:00:00.000Z',
        expectedMainOid: MAIN_OID,
        managerSetGeneration: 1,
        projectId,
        projectName: projectId,
        serviceState: 'active' as const,
      }),
    } as unknown as ProjectReadScope);
  }
}

class MemoryRepository implements ProjectPersonalRefRepository {
  readonly entered: CollabProjectId[] = [];
  readonly #releaseByProject = new Map<CollabProjectId, () => void>();

  constructor(readonly events: string[]) {}

  reserveReceivePack(projectId: CollabProjectId) {
    this.events.push(`resource:${projectId}`);
    return Promise.resolve(Object.freeze({
      close: () => {
        this.events.push(`resource-release:${projectId}`);
        return Promise.resolve();
      },
      projectId,
    }));
  }

  advertiseReceivePack(): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(0));
  }

  runReceivePack(
    reservation: Parameters<ProjectPersonalRefRepository['runReceivePack']>[0],
    placement: Parameters<ProjectPersonalRefRepository['runReceivePack']>[1],
    options: Parameters<ProjectPersonalRefRepository['runReceivePack']>[2],
  ): Promise<void> {
    assert.equal(reservation.projectId, placement.projectId);
    assert.equal(options.personalRef, collabMemberRef(options.memberId));
    assert.equal(options.expectedMainOid, MAIN_OID);
    this.entered.push(placement.projectId);
    this.events.push(`entered:${placement.projectId}`);
    return new Promise<void>(resolve => {
      this.#releaseByProject.set(placement.projectId, resolve);
    });
  }

  release(projectId: CollabProjectId): void {
    const release = this.#releaseByProject.get(projectId);
    if (release === undefined) throw new Error('project-not-entered');
    this.#releaseByProject.delete(projectId);
    release();
  }
}

describe('ProjectPersonalRefAuthority', () => {
  it('denies an unrelated actor before Project-keyed receive capacity', async () => {
    const events: string[] = [];
    const repository = new MemoryRepository(events);
    const coordination = {
      acquireProjectLease: (): Promise<PinnedProjectLease> => Promise.resolve({
        close: () => Promise.resolve(),
        drainDevelopmentBootstrapUploads: () => Promise.resolve(),
        handoffToDevelopmentBootstrapUpload: () => Promise.reject(
          new Error('unexpected-upload-handoff'),
        ),
        withProjectScope: <T>(
          operation: (scope: ProjectScope) => Promise<T>,
        ): Promise<T> => operation({
          findDevelopmentActorMember: () => Promise.resolve(undefined),
          findMembership: () => Promise.resolve(undefined),
          portability: {
            getNonterminalLifecycleJournal: () => Promise.resolve(undefined),
          },
        } as unknown as ProjectScope),
      }),
      withProjectReadScope: <T>(
        _projectId: CollabProjectId,
        operation: (scope: ProjectReadScope) => Promise<T>,
      ): Promise<T> => operation({
        findDevelopmentActorMember: () => Promise.resolve(undefined),
        findMembership: () => Promise.resolve(undefined),
      } as unknown as ProjectReadScope),
    };
    const authority = new ProjectPersonalRefAuthority({
      coordination,
      recovery: { recoverProject: () => Promise.resolve() },
      repository,
    });
    try {
      await assert.rejects(
        authority.advertiseReceivePack(
          createDevelopmentIngressPrincipal('unrelated-member'),
          'project-a',
        ),
        error => (
          error instanceof ProjectWriteAdmissionError
          && error.code === 'authorization-denied'
        ),
      );
      assert.deepEqual(events, []);
    } finally {
      await authority.close();
    }
  });

  it('keeps recovery state hidden when membership is revoked after preflight', async () => {
    for (const recoveryShape of ['attempt', 'service'] as const) {
      const events: string[] = [];
      const repository = new MemoryRepository(events);
      let leaseCount = 0;
      const coordination = {
        acquireProjectLease: (projectId: CollabProjectId): Promise<PinnedProjectLease> => {
          leaseCount += 1;
          const preflight = leaseCount === 1;
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
                preflight ? 'member-a' : undefined,
              ),
              findMembership: () => Promise.resolve(preflight
                ? {
                    displayName: 'Member A',
                    memberId: 'member-a',
                    revision: 1n,
                    role: 'member' as const,
                    status: 'active' as const,
                  }
                : undefined),
              getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(
                !preflight && recoveryShape === 'attempt'
                  ? ({ state: 'recovery-required' } as never)
                  : undefined,
              ),
              portability: {
                getNonterminalLifecycleJournal: () => Promise.resolve(undefined),
              },
              getProject: () => Promise.resolve({
                activatedAt: '2026-08-22T00:00:00.000Z',
                createdAt: '2026-08-22T00:00:00.000Z',
                expectedMainOid: MAIN_OID,
                managerSetGeneration: 1,
                projectId,
                projectName: projectId,
                serviceState: !preflight && recoveryShape === 'service'
                  ? 'recovery-required' as const
                  : 'active' as const,
              }),
              getRepositoryPlacement: () => Promise.resolve(
                createRepositoryPlacementLease({
                  active: true,
                  generation: 1,
                  projectId,
                  repositoryStorageKey: 'repository-project-a',
                  storageNodeId: 'node-a',
                }),
              ),
            } as unknown as ProjectScope),
          });
        },
        withProjectReadScope: <T>(
          _projectId: CollabProjectId,
          operation: (scope: ProjectReadScope) => Promise<T>,
        ): Promise<T> => operation({
          findDevelopmentActorMember: () => Promise.resolve('member-a'),
          findMembership: () => Promise.resolve({
            displayName: 'Member A',
            memberId: 'member-a',
            revision: 1n,
            role: 'member' as const,
            status: 'active' as const,
          }),
        } as unknown as ProjectReadScope),
      };
      const authority = new ProjectPersonalRefAuthority({
        coordination,
        recovery: { recoverProject: () => Promise.resolve() },
        repository,
      });
      try {
        await assert.rejects(
          authority.advertiseReceivePack(
            createDevelopmentIngressPrincipal('member-a'),
            'project-a',
          ),
          error => (
            error instanceof ProjectWriteAdmissionError
            && error.code === 'authorization-denied'
          ),
        );
        assert.deepEqual(events, [
          'resource:project-a',
          'resource-release:project-a',
        ]);
      } finally {
        await authority.close();
      }
    }
  });

  it('does not reserve receive capacity when preflight recovery is cancelled', async () => {
    for (const settlement of ['abort', 'close'] as const) {
      let recoveryEntered!: () => void;
      const entered = new Promise<void>(resolve => { recoveryEntered = resolve; });
      const events: string[] = [];
      const repository = new MemoryRepository(events);
      const activeMember = {
        displayName: 'Member A',
        memberId: 'member-a' as const,
        revision: 1n,
        role: 'member' as const,
        status: 'active' as const,
      };
      const coordination = {
        acquireProjectLease: (projectId: CollabProjectId): Promise<PinnedProjectLease> => (
          Promise.resolve({
            close: () => Promise.resolve(),
            drainDevelopmentBootstrapUploads: () => Promise.resolve(),
            handoffToDevelopmentBootstrapUpload: () => Promise.reject(
              new Error('unexpected-upload-handoff'),
            ),
            withProjectScope: <T>(
              operation: (scope: ProjectScope) => Promise<T>,
            ): Promise<T> => operation({
              accept: { getNonterminal: () => Promise.resolve(undefined) },
              findDevelopmentActorMember: () => Promise.resolve('member-a'),
              findMembership: () => Promise.resolve(activeMember),
              getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve({
                projectId,
                state: 'collecting',
              } as never),
              portability: {
                getNonterminalLifecycleJournal: () => Promise.resolve(undefined),
              },
            } as unknown as ProjectScope),
          })
        ),
        withProjectReadScope: <T>(
          _projectId: CollabProjectId,
          operation: (scope: ProjectReadScope) => Promise<T>,
        ): Promise<T> => operation({
          findDevelopmentActorMember: () => Promise.resolve('member-a'),
          findMembership: () => Promise.resolve(activeMember),
        } as unknown as ProjectReadScope),
      };
      const authority = new ProjectPersonalRefAuthority({
        coordination,
        recovery: {
          recoverProject: () => {
            recoveryEntered();
            return new Promise<void>(() => undefined);
          },
        },
        repository,
      });
      const controller = new AbortController();
      const operation = authority.advertiseReceivePack(
        createDevelopmentIngressPrincipal('member-a'),
        'project-a',
        { signal: controller.signal },
      );
      await within(entered, `${settlement}-recovery-entered`);

      const closing = settlement === 'close'
        ? authority.close()
        : undefined;
      if (settlement === 'abort') controller.abort();
      await assert.rejects(
        within(operation, `${settlement}-operation`),
        error => (
          error instanceof ProjectWriteAdmissionError
          && error.code === (settlement === 'close' ? 'closed' : 'cancelled')
        ),
      );
      if (closing !== undefined) await within(closing, 'recovery-close');
      else await authority.close();
      assert.deepEqual(events, []);
    }
  });

  it('reserves capacity before the canonical write lane and serializes only one Project', async () => {
    const events: string[] = [];
    const coordination = new MemoryCoordination(events);
    const repository = new MemoryRepository(events);
    const authority = new ProjectPersonalRefAuthority({
      coordination,
      recovery: { recoverProject: () => Promise.resolve() },
      repository,
    });
    const options = {
      maximumRequestBytes: 1_024,
      maximumResponseBytes: 1_024,
      onResponseChunk: () => undefined,
      request: (async function* request(): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield Buffer.from('0000');
      })(),
    };
    try {
      const first = authority.runReceivePack(
        createDevelopmentIngressPrincipal('member-a'),
        'project-a',
        options,
      );
      while (!repository.entered.includes('project-a')) await Promise.resolve();

      const sameProject = authority.runReceivePack(
        createDevelopmentIngressPrincipal('member-a'),
        'project-a',
        options,
      );
      const otherProject = authority.runReceivePack(
        createDevelopmentIngressPrincipal('member-b'),
        'project-b',
        options,
      );
      while (!repository.entered.includes('project-b')) await Promise.resolve();
      assert.deepEqual(repository.entered, ['project-a', 'project-b']);
      const projectALockRequests = events.flatMap((event, index) => (
        event === 'lock-request:project-a' ? [index] : []
      ));
      const projectAResource = events.indexOf('resource:project-a');
      assert.equal(
        (projectALockRequests[0] ?? Number.POSITIVE_INFINITY)
          < projectAResource,
        true,
      );
      assert.equal(
        projectAResource
          < (projectALockRequests[1] ?? Number.NEGATIVE_INFINITY),
        true,
      );

      repository.release('project-a');
      await first;
      while (repository.entered.filter(id => id === 'project-a').length < 2) {
        await Promise.resolve();
      }
      repository.release('project-a');
      repository.release('project-b');
      await Promise.all([sameProject, otherProject]);
    } finally {
      await authority.close();
    }
  });
});
