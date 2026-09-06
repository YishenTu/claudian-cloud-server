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
  ProjectRecoveryError,
} from '../../src/project-authority/admission/ProjectWriteAdmission.js';
import {
  ProjectLifecycleRecoveryDispatcher,
  type ProjectLifecycleRecoveryOwner,
} from '../../src/project-authority/lifecycle/ProjectLifecycleRecoveryDispatcher.js';
import {
  ProjectRecoveryCoordinator,
} from '../../src/project-authority/recovery/ProjectRecoveryCoordinator.js';
import {
  createDevelopmentPrincipal,
} from '../../src/request-context/RequestPrincipal.js';

const CREATED_AT = '2026-08-25T00:00:00.000Z';

function journal(
  kind: ProjectLifecycleJournalRecord['kind'] = 'backup',
): ProjectLifecycleJournalRecord {
  return Object.freeze({
    actorMemberId: undefined,
    batchRevision: undefined,
    batchSha256: undefined,
    checkpointSha256: undefined,
    createdAt: CREATED_AT,
    direction: kind === 'authority-transfer' ? 'lan-to-cloud' : undefined,
    expectedAuthorityGeneration: 1,
    idempotencyKey: `intent-${kind}`,
    kind,
    operationId: `operation-${kind}`,
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

class MemoryLifecycleCoordination {
  current: ProjectLifecycleJournalRecord | undefined;
  readonly events: string[] = [];
  readonly settled = new Map<string, ProjectLifecycleJournalRecord>();

  constructor(current: ProjectLifecycleJournalRecord | undefined) {
    this.current = current;
  }

  acquireProjectLease(projectId: CollabProjectId): Promise<PinnedProjectLease> {
    this.events.push(`lease:${projectId}`);
    let closed = false;
    return Promise.resolve({
      close: () => {
        if (!closed) {
          closed = true;
          this.events.push(`close:${projectId}`);
        }
        return Promise.resolve();
      },
      drainDevelopmentBootstrapUploads: () => Promise.resolve(),
      handoffToDevelopmentBootstrapUpload: () => Promise.reject(
        new Error('unexpected-upload-handoff'),
      ),
      withProjectScope: <T>(
        operation: (scope: ProjectScope) => Promise<T>,
      ): Promise<T> => operation({
        accept: { getNonterminal: () => Promise.resolve(undefined) },
        findDevelopmentActorMember: () => Promise.resolve(undefined),
        findPrincipalMember: () => Promise.resolve(undefined),
        findMembership: () => Promise.resolve(undefined),
        getNonterminalDevelopmentBootstrapAttempt: () => Promise.resolve(
          undefined,
        ),
        membership: {
          getNonterminalJoin: () => Promise.resolve(undefined),
        },
        portability: {
          getLifecycleJournal: (operationId: string) => Promise.resolve(
            this.current?.operationId === operationId
              ? this.current
              : this.settled.get(operationId),
          ),
          getNonterminalLifecycleJournal: () => Promise.resolve(
            this.current?.state === 'active'
              || this.current?.state === 'recovery-required'
              ? this.current
              : undefined,
          ),
        },
      } as unknown as ProjectScope),
    });
  }

  withProjectReadScope<Result>(
    _projectId: CollabProjectId,
    _operation: (scope: ProjectReadScope) => Promise<Result>,
  ): Promise<Result> {
    return Promise.reject(new Error('unexpected-read-scope'));
  }

  settleWithSuccessor(
    settled: ProjectLifecycleJournalRecord,
    successor: ProjectLifecycleJournalRecord,
  ): void {
    this.settled.set(settled.operationId, settled);
    this.current = successor;
  }
}

function owners(
  selected: ProjectLifecycleRecoveryOwner,
): ConstructorParameters<typeof ProjectLifecycleRecoveryDispatcher>[0]['owners'] {
  const unexpected: ProjectLifecycleRecoveryOwner = {
    recover: () => Promise.reject(new Error('unexpected-owner')),
  };
  return Object.freeze({
    authorityTransfer: unexpected,
    backup: selected,
    deletion: unexpected,
    export: unexpected,
    leave: unexpected,
    retire: unexpected,
  });
}

function handoffOwners(
  coordination: MemoryLifecycleCoordination,
  calls: string[],
  successorKind: ProjectLifecycleJournalRecord['kind'] = 'delete',
): ConstructorParameters<typeof ProjectLifecycleRecoveryDispatcher>[0]['owners'] {
  const unexpected: ProjectLifecycleRecoveryOwner = {
    recover: input => {
      calls.push(`unexpected:${input.journal.kind}`);
      return Promise.reject(new Error('unexpected-owner'));
    },
  };
  const createSuccessor: ProjectLifecycleRecoveryOwner = {
    recover: input => {
      calls.push(`${input.journal.kind}:${input.journal.operationId}`);
      coordination.settleWithSuccessor(
        Object.freeze({
          ...input.journal,
          phase: 'completed',
          state: 'completed',
        }),
        journal(successorKind),
      );
      return Promise.resolve('settled');
    },
  };
  return Object.freeze({
    authorityTransfer: createSuccessor,
    backup: unexpected,
    deletion: {
      recover: (
        input: Parameters<ProjectLifecycleRecoveryOwner['recover']>[0],
      ) => {
        calls.push(`delete:${input.journal.operationId}`);
        coordination.current = Object.freeze({
          ...input.journal,
          phase: 'completed',
          state: 'completed',
        });
        return Promise.resolve('settled' as const);
      },
    },
    export: unexpected,
    leave: unexpected,
    retire: createSuccessor,
  });
}

async function expectRecoveryError(
  operation: Promise<unknown>,
  code: ProjectRecoveryError['code'],
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ProjectRecoveryError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('ProjectLifecycleRecoveryDispatcher', () => {
  it('strictly drains lifecycle catalog candidates before maintenance work', async () => {
    const record = journal();
    const coordination = new MemoryLifecycleCoordination(record);
    const dispatcher = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: owners({
        recover: input => {
          coordination.current = Object.freeze({
            ...input.journal,
            phase: 'completed',
            state: 'completed',
          });
          return Promise.resolve('settled');
        },
      }),
    });

    await dispatcher.recoverAll({
      listRecoveryCandidates: () => Promise.resolve({
        candidates: [{
          kind: record.kind,
          operationId: record.operationId,
          projectId: record.projectId,
          scheduledAt: record.scheduledAt,
        }],
        nextCursor: undefined,
      }),
    });

    assert.equal(coordination.current?.state, 'completed');
    dispatcher.close();
  });

  it('fails a strict catalog drain when external proof is still required', async () => {
    const record = Object.freeze({
      ...journal('authority-transfer'),
      direction: 'lan-to-cloud' as const,
      phase: 'repository-published',
    });
    const coordination = new MemoryLifecycleCoordination(record);
    const waiting: ProjectLifecycleRecoveryOwner = {
      recover: () => Promise.resolve('waiting-for-external-proof'),
    };
    const dispatcher = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: Object.freeze({
        ...owners(waiting),
        authorityTransfer: waiting,
      }),
    });

    await expectRecoveryError(dispatcher.recoverAll({
      listRecoveryCandidates: () => Promise.resolve({
        candidates: [{
          kind: record.kind,
          operationId: record.operationId,
          projectId: record.projectId,
          scheduledAt: record.scheduledAt,
        }],
        nextCursor: undefined,
      }),
    }), 'recovery-required');
    dispatcher.close();
  });

  it('preserves externally waiting candidates during the serving startup gate', async () => {
    const record = Object.freeze({
      ...journal('authority-transfer'),
      direction: 'cloud-to-lan' as const,
      phase: 'cancel-intent',
    });
    const coordination = new MemoryLifecycleCoordination(record);
    const waiting: ProjectLifecycleRecoveryOwner = {
      recover: () => Promise.resolve('waiting-for-external-proof'),
    };
    const dispatcher = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: Object.freeze({
        ...owners(waiting),
        authorityTransfer: waiting,
      }),
    });

    await dispatcher.recoverAvailable({
      listRecoveryCandidates: () => Promise.resolve({
        candidates: [{
          kind: record.kind,
          operationId: record.operationId,
          projectId: record.projectId,
          scheduledAt: record.scheduledAt,
        }],
        nextCursor: undefined,
      }),
    });

    assert.ok(coordination.current);
    assert.equal(coordination.current.phase, 'cancel-intent');
    assert.equal(coordination.current.state, 'active');
    dispatcher.close();
  });

  it('re-reads an exact candidate under one Project lease before dispatch', async () => {
    const record = journal();
    const coordination = new MemoryLifecycleCoordination(record);
    const seen: ProjectLifecycleJournalRecord[] = [];
    const dispatcher = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: owners({
        reserveRecovery: projectId => {
          coordination.events.push(`reserve:${projectId}`);
          return Promise.resolve({
            close: () => {
              coordination.events.push(`release:${projectId}`);
              return Promise.resolve();
            },
          });
        },
        recover: input => {
          seen.push(input.journal);
          coordination.events.push(`owner:${input.journal.operationId}`);
          coordination.current = Object.freeze({
            ...input.journal,
            phase: 'completed',
            state: 'completed',
          });
          return Promise.resolve('settled');
        },
      }),
    });

    await dispatcher.recoverCandidate({
      kind: record.kind,
      operationId: record.operationId,
      projectId: record.projectId,
      scheduledAt: record.scheduledAt,
    });

    assert.deepEqual(seen, [record]);
    assert.deepEqual(coordination.events, [
      'lease:project-a',
      'close:project-a',
      'reserve:project-a',
      'lease:project-a',
      'owner:operation-backup',
      'close:project-a',
      'release:project-a',
      'lease:project-a',
      'close:project-a',
    ]);
    dispatcher.close();
  });

  it('restarts reservation preflight when the journal advances before lease reacquisition', async () => {
    const observed = Object.freeze({
      ...journal('authority-transfer'),
      direction: 'cloud-to-lan' as const,
      phase: 'cloud-relinquished',
    });
    const coordination = new MemoryLifecycleCoordination(observed);
    const reservations: string[] = [];
    const authorityTransfer: ProjectLifecycleRecoveryOwner = {
      reserveRecovery: (_projectId, candidate) => {
        reservations.push(candidate.phase);
        if (candidate.phase === 'cloud-relinquished') {
          coordination.current = Object.freeze({
            ...candidate,
            phase: 'lan-activated',
            updatedAt: '2026-08-25T00:00:01.000Z',
          });
          return Promise.resolve(undefined);
        }
        return Promise.resolve({ close: () => Promise.resolve() });
      },
      recover: input => {
        assert.equal(input.journal.phase, 'lan-activated');
        assert.ok(input.repositoryReservation);
        coordination.current = Object.freeze({
          ...input.journal,
          phase: 'completed',
          state: 'completed',
        });
        return Promise.resolve('settled');
      },
    };
    const unexpected: ProjectLifecycleRecoveryOwner = {
      recover: () => Promise.reject(new Error('unexpected-owner')),
    };
    const dispatcher = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: {
        authorityTransfer,
        backup: unexpected,
        deletion: unexpected,
        export: unexpected,
        leave: unexpected,
        retire: unexpected,
      },
    });

    await dispatcher.recoverCandidate({
      kind: observed.kind,
      operationId: observed.operationId,
      projectId: observed.projectId,
      scheduledAt: observed.scheduledAt,
    });

    assert.deepEqual(reservations, ['cloud-relinquished', 'lan-activated']);
    dispatcher.close();
  });

  it('discovers the unique nonterminal journal for on-demand recovery', async () => {
    const record = journal();
    const coordination = new MemoryLifecycleCoordination(record);
    const dispatcher = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: owners({
        recover: input => {
          coordination.current = Object.freeze({
            ...input.journal,
            phase: 'completed',
            state: 'completed',
          });
          return Promise.resolve('settled');
        },
      }),
    });

    await dispatcher.recoverProject(record.projectId);
    coordination.current = undefined;
    await dispatcher.recoverProject(record.projectId);
    dispatcher.close();
  });

  it('preserves external-proof waits during startup and fences ordinary admission', async () => {
    for (const phase of ['source-quiesced', 'target-cleaned']) {
      const record = Object.freeze({
        ...journal('authority-transfer'),
        phase,
      });
      const coordination = new MemoryLifecycleCoordination(record);
      const dispatcher = new ProjectLifecycleRecoveryDispatcher({
        coordination,
        owners: Object.freeze({
          ...owners({
            recover: () => Promise.resolve(
              'waiting-for-external-proof' as const,
            ),
          }),
          authorityTransfer: {
            recover: () => Promise.resolve(
              'waiting-for-external-proof' as const,
            ),
          },
        }),
      });

      await dispatcher.recoverCandidate({
        kind: record.kind,
        operationId: record.operationId,
        projectId: record.projectId,
        scheduledAt: record.scheduledAt,
      });
      assert.equal(coordination.current, record);
      await expectRecoveryError(
        dispatcher.recoverProject(record.projectId),
        'recovery-required',
      );
      assert.equal(coordination.current, record);
      dispatcher.close();
    }
  });

  it('fails closed for contradictory and isolated journal state', async () => {
    const record = journal();
    const coordination = new MemoryLifecycleCoordination(record);
    const dispatcher = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: owners({ recover: () => Promise.resolve('settled') }),
    });
    await expectRecoveryError(dispatcher.recoverCandidate({
      kind: 'export',
      operationId: record.operationId,
      projectId: record.projectId,
      scheduledAt: record.scheduledAt,
    }), 'dependency-failed');

    coordination.current = Object.freeze({
      ...record,
      recoveryFromPhase: record.phase,
      state: 'recovery-required',
    });
    await expectRecoveryError(
      dispatcher.recoverProject(record.projectId),
      'recovery-required',
    );
    dispatcher.close();
  });

  it('routes catalog lifecycle candidates without teaching the mixed dispatcher phases', async () => {
    const candidates = [
      {
        kind: 'backup' as const,
        operationId: 'operation-backup',
        projectId: 'project-a',
        scheduledAt: CREATED_AT,
      },
      {
        kind: 'accept' as const,
        operationId: 'operation-accept',
        projectId: 'project-b',
        scheduledAt: CREATED_AT,
      },
      {
        kind: 'create-project' as const,
        operationId: 'operation-create',
        projectId: 'project-c',
        scheduledAt: CREATED_AT,
      },
      {
        kind: 'join-project' as const,
        operationId: 'operation-join',
        projectId: 'project-d',
        scheduledAt: CREATED_AT,
      },
    ];
    const calls: string[] = [];
    const coordinator = new ProjectRecoveryCoordinator({
      accept: {
        recoverProject: projectId => {
          calls.push(`accept:${projectId}`);
          return Promise.resolve();
        },
      },
      activation: { recoverProject: () => Promise.resolve() },
      catalog: {
        listRecoveryCandidates: () => Promise.resolve({
          candidates,
          nextCursor: undefined,
        }),
      },
      creation: {
        recoverProject: projectId => {
          calls.push(`create:${projectId}`);
          return Promise.resolve();
        },
      },
      isolation: {
        acquireProjectLease: () => Promise.reject(
          new Error('unexpected-isolation'),
        ),
      },
      lifecycle: {
        recoverCandidate: candidate => {
          calls.push(`lifecycle:${candidate.kind}:${candidate.operationId}`);
          return Promise.resolve();
        },
        recoverProject: () => Promise.resolve(),
      },
      membership: {
        recoverProject: projectId => {
          calls.push(`join:${projectId}`);
          return Promise.resolve();
        },
      },
    });

    await coordinator.recoverAll();
    assert.deepEqual(calls, [
      'lifecycle:backup:operation-backup',
      'accept:project-b',
      'create:project-c',
      'join:project-d',
    ]);
    coordinator.close();
  });

  it('isolates an unknown catalog kind and continues unrelated recovery', async () => {
    const calls: string[] = [];
    let serviceState: 'active' | 'recovery-required' = 'active';
    const catalog = {
      acquireProjectLease: (
        projectId: CollabProjectId,
      ): Promise<PinnedProjectLease> => {
        calls.push(`lease:${projectId}`);
        return Promise.resolve({
          close: () => {
            calls.push(`close:${projectId}`);
            return Promise.resolve();
          },
          drainDevelopmentBootstrapUploads: () => Promise.resolve(),
          handoffToDevelopmentBootstrapUpload: () => Promise.reject(
            new Error('unexpected-upload-handoff'),
          ),
          withProjectScope: <T>(
            operation: (scope: ProjectScope) => Promise<T>,
          ): Promise<T> => operation({
            isolateProjectRecovery: () => {
              calls.push(`isolate:${projectId}`);
              serviceState = 'recovery-required';
              return Promise.resolve('advanced');
            },
            getProject: () => Promise.resolve({
              activatedAt: CREATED_AT,
              authorityGeneration: 1,
              authorityStateRevision: serviceState === 'active' ? 1 : 2,
              createdAt: CREATED_AT,
              expectedMainOid: '1'.repeat(40),
              managerSetGeneration: 1,
              projectId,
              projectName: 'Project A',
              serviceState,
            }),
          } as unknown as ProjectScope),
        });
      },
      listRecoveryCandidates: () => Promise.resolve({
        candidates: [
          {
            kind: 'unknown' as const,
            operationId: 'operation-future',
            projectId: 'project-a',
            scheduledAt: CREATED_AT,
            unrecognizedKind: 'future-operation',
          },
          {
            kind: 'accept' as const,
            operationId: 'operation-accept',
            projectId: 'project-b',
            scheduledAt: CREATED_AT,
          },
        ],
        nextCursor: undefined,
      }),
    };
    const coordinator = new ProjectRecoveryCoordinator({
      accept: {
        recoverProject: projectId => {
          calls.push(`accept:${projectId}`);
          return Promise.resolve();
        },
      },
      activation: { recoverProject: () => Promise.resolve() },
      catalog,
      isolation: catalog,
    });

    await coordinator.recoverAll();
    assert.equal(serviceState, 'recovery-required');
    assert.deepEqual(calls, [
      'lease:project-a',
      'isolate:project-a',
      'close:project-a',
      'accept:project-b',
    ]);
    coordinator.close();
  });

  it('keeps a Project active when an unknown candidate becomes stale under its lease', async () => {
    const calls: string[] = [];
    const coordinator = new ProjectRecoveryCoordinator({
      accept: { recoverProject: () => Promise.resolve() },
      activation: { recoverProject: () => Promise.resolve() },
      catalog: {
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [{
            kind: 'unknown' as const,
            operationId: 'operation-future',
            projectId: 'project-a',
            scheduledAt: CREATED_AT,
            unrecognizedKind: 'future-operation',
          }],
          nextCursor: undefined,
        }),
      },
      isolation: {
        acquireProjectLease: (projectId): Promise<PinnedProjectLease> => (
          Promise.resolve({
            close: () => Promise.resolve(),
            drainDevelopmentBootstrapUploads: () => Promise.resolve(),
            handoffToDevelopmentBootstrapUpload: () => Promise.reject(
              new Error('unexpected-upload-handoff'),
            ),
            withProjectScope: <T>(
              operation: (scope: ProjectScope) => Promise<T>,
            ): Promise<T> => operation({
              isolateProjectRecovery: () => {
                calls.push(`stale:${projectId}`);
                return Promise.resolve('stale' as never);
              },
              getProject: () => Promise.resolve({
                activatedAt: CREATED_AT,
                authorityGeneration: 1,
                authorityStateRevision: 1,
                createdAt: CREATED_AT,
                expectedMainOid: '1'.repeat(40),
                managerSetGeneration: 1,
                projectId,
                projectName: 'Project A',
                serviceState: 'active',
              }),
            } as unknown as ProjectScope),
          })
        ),
      },
    });

    await coordinator.recoverAll();
    assert.deepEqual(calls, ['stale:project-a']);
    coordinator.close();
  });

  it('replays exact terminal state after an ambiguous owner response', async () => {
    const record = journal();
    const coordination = new MemoryLifecycleCoordination(record);
    let ownerCalls = 0;
    const dispatcher = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: owners({
        recover: input => {
          ownerCalls += 1;
          coordination.current = Object.freeze({
            ...input.journal,
            phase: 'completed',
            state: 'completed',
          });
          return Promise.reject(new Error('/private/lost-owner-response'));
        },
      }),
    });
    const candidate = {
      kind: record.kind,
      operationId: record.operationId,
      projectId: record.projectId,
      scheduledAt: record.scheduledAt,
    };

    await expectRecoveryError(
      dispatcher.recoverCandidate(candidate),
      'dependency-failed',
    );
    await dispatcher.recoverCandidate(candidate);
    assert.equal(ownerCalls, 1);
    dispatcher.close();
  });

  it('drains a Retire-to-deletion handoff during mixed startup recovery', async () => {
    const record = journal('retire');
    const coordination = new MemoryLifecycleCoordination(record);
    const calls: string[] = [];
    const lifecycle = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: handoffOwners(coordination, calls),
    });
    const recovery = new ProjectRecoveryCoordinator({
      accept: { recoverProject: () => Promise.resolve() },
      activation: { recoverProject: () => Promise.resolve() },
      catalog: {
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [{
            kind: record.kind,
            operationId: record.operationId,
            projectId: record.projectId,
            scheduledAt: record.scheduledAt,
          }],
          nextCursor: undefined,
        }),
      },
      isolation: coordination,
      lifecycle,
    });

    await recovery.recoverAll();
    assert.deepEqual(calls, [
      'retire:operation-retire',
      'delete:operation-delete',
    ]);
    recovery.close();
    lifecycle.close();
  });

  it('drains a Retire-to-deletion handoff through ordinary write admission', async () => {
    const coordination = new MemoryLifecycleCoordination(journal('retire'));
    const calls: string[] = [];
    const lifecycle = new ProjectLifecycleRecoveryDispatcher({
      coordination,
      owners: handoffOwners(coordination, calls),
    });
    const recovery = new ProjectRecoveryCoordinator({
      accept: { recoverProject: () => Promise.resolve() },
      activation: { recoverProject: () => Promise.resolve() },
      catalog: {
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [],
          nextCursor: undefined,
        }),
      },
      isolation: coordination,
      lifecycle,
    });
    const admission = new ProjectWriteAdmission({ coordination, recovery });

    await assert.rejects(admission.run(
      createDevelopmentPrincipal('former-member'),
      'project-a',
      () => Promise.reject(new Error('unexpected-write')),
    ), error => {
      assert.ok(error instanceof ProjectWriteAdmissionError);
      assert.equal(error.code, 'authorization-denied');
      return true;
    });
    assert.deepEqual(calls, [
      'retire:operation-retire',
      'delete:operation-delete',
    ]);
    await admission.close();
    recovery.close();
    lifecycle.close();
  });

  it('rejects every non-deletion successor without dispatching its owner', async () => {
    for (const successorKind of [
      'authority-transfer',
      'backup',
      'export',
      'leave',
      'retire',
    ] as const) {
      const record = journal('retire');
      const coordination = new MemoryLifecycleCoordination(record);
      const calls: string[] = [];
      const dispatcher = new ProjectLifecycleRecoveryDispatcher({
        coordination,
        owners: handoffOwners(coordination, calls, successorKind),
      });

      await expectRecoveryError(dispatcher.recoverCandidate({
        kind: record.kind,
        operationId: record.operationId,
        projectId: record.projectId,
        scheduledAt: record.scheduledAt,
      }), 'dependency-failed');
      assert.deepEqual(calls, ['retire:operation-retire']);
      dispatcher.close();
    }
  });

  it('allows only Cloud-to-LAN authority transfer to hand off to deletion', async () => {
    for (const [direction, expectedCode, expectedCalls] of [
      [
        'cloud-to-lan',
        undefined,
        ['authority-transfer:operation-authority-transfer', 'delete:operation-delete'],
      ],
      [
        'lan-to-cloud',
        'dependency-failed',
        ['authority-transfer:operation-authority-transfer'],
      ],
    ] as const) {
      const record = Object.freeze({
        ...journal('authority-transfer'),
        direction,
      });
      const coordination = new MemoryLifecycleCoordination(record);
      const calls: string[] = [];
      const dispatcher = new ProjectLifecycleRecoveryDispatcher({
        coordination,
        owners: handoffOwners(coordination, calls),
      });
      const recovery = dispatcher.recoverCandidate({
        kind: record.kind,
        operationId: record.operationId,
        projectId: record.projectId,
        scheduledAt: record.scheduledAt,
      });

      if (expectedCode === undefined) {
        await recovery;
      } else {
        await expectRecoveryError(recovery, expectedCode);
      }
      assert.deepEqual(calls, expectedCalls);
      dispatcher.close();
    }
  });

  it('rejects deletion after a cancelled Retire or Cloud-to-LAN transfer', async () => {
    for (const source of [
      Object.freeze({
        ...journal('retire'),
        phase: 'cancelled',
        state: 'cancelled' as const,
      }),
      Object.freeze({
        ...journal('authority-transfer'),
        direction: 'cloud-to-lan' as const,
        phase: 'cancelled',
        state: 'cancelled' as const,
      }),
    ]) {
      const successor = journal('delete');
      const coordination = new MemoryLifecycleCoordination(successor);
      coordination.settled.set(source.operationId, source);
      const calls: string[] = [];
      const dispatcher = new ProjectLifecycleRecoveryDispatcher({
        coordination,
        owners: handoffOwners(coordination, calls),
      });

      await expectRecoveryError(dispatcher.recoverCandidate({
        kind: source.kind,
        operationId: source.operationId,
        projectId: source.projectId,
        scheduledAt: source.scheduledAt,
      }), 'dependency-failed');
      assert.deepEqual(calls, []);
      dispatcher.close();
    }
  });
});
