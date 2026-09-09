import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ActiveClaimCustodyKeyReferenceGate,
} from '../../src/project-authority/lifecycle/ActiveClaimCustodyKeyReferenceGate.js';
import {
  ClaimCustodyKeyReferenceVerifier,
} from '../../src/environment-maintenance/commands/ClaimCustodyKeyReferenceVerifier.js';

const projectId = '11111111-1111-4111-8111-111111111111';

describe('ActiveClaimCustodyKeyReferenceGate', () => {
  it('rejects a rotated-away Cloud source key before Cloud-to-LAN proof', async () => {
    const targetPublicKey = Buffer.alloc(32, 1).toString('base64url');
    const sourcePublicKey = Buffer.alloc(32, 2).toString('base64url');
    const records = [{
      kind: 'lifecycle-journal',
      value: {
        direction: 'cloud-to-lan',
        operationId: 'transfer-active',
        operationKind: 'authority-transfer',
      },
    }, {
      kind: 'authority-transfer-recovery',
      value: {
        relinquishmentProof: null,
        sourceAuthority: { generation: 1, kind: 'cloud' },
        targetAuthority: { generation: 2, kind: 'lan' },
        targetEvidence: {
          receiptKeyId: 'lan-target-key',
          receiptPublicKey: targetPublicKey,
        },
        transferId: 'transfer-active',
      },
    }, {
      kind: 'transfer-receipt-key',
      value: {
        receiptKeyId: 'cloud-source-key',
        receiptPublicKey: sourcePublicKey,
        transferId: 'transfer-active',
      },
    }, {
      kind: 'transfer-receipt-key',
      value: {
        receiptKeyId: 'lan-target-key',
        receiptPublicKey: targetPublicKey,
        transferId: 'transfer-active',
      },
    }];
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => Promise.resolve(),
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            checkpoint: {
              readProjectCheckpointRecords: () => Promise.resolve(records),
            },
            getProject: () => Promise.resolve({
              projectId,
              serviceState: 'read-only-transition',
            }),
            getRepositoryPlacement: () => Promise.resolve({
              generation: 1,
              projectId,
              repositoryStorageKey: 'repo-a',
              storageNodeId: 'node-a',
            }),
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: [{
            active: true,
            generation: 1,
            projectId,
            repositoryStorageKey: 'repo-a',
            storageNodeId: 'node-a',
          }],
        }),
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [],
          nextCursor: undefined,
        }),
        listTerminalProjectContinuity: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [],
        }),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 12,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: '0.0.0',
        }),
      },
      verifier: new ClaimCustodyKeyReferenceVerifier({
        custody: { open: () => Promise.resolve('unused') },
        keyring: {
          assertReferences: ({ receiptKeyIds }) => {
            if (receiptKeyIds.includes('cloud-source-key')) {
              throw new Error('rotated-away-source-key');
            }
          },
          assertReceiptPublicKey() {},
        },
      }),
    });

    await assert.rejects(
      gate.verifyAll(new AbortController().signal),
      /active-claim-custody-key-reference\.error\.unavailable/u,
    );
  });

  it('rejects a rotated-away Cloud target key during incoming transfer', async () => {
    const receiptPublicKey = Buffer.alloc(32, 3).toString('base64url');
    const records = [{
      kind: 'lifecycle-journal',
      value: {
        direction: 'lan-to-cloud',
        operationId: 'transfer-incoming',
        operationKind: 'authority-transfer',
      },
    }];
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => Promise.resolve(),
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            checkpoint: {
              readTerminalProjectContinuityRecords: () => Promise.resolve(records),
            },
            portability: {
              getAuthorityTransferRecovery: () => Promise.resolve({
                sourceAuthority: { generation: 1, kind: 'lan' },
                sourceProof: JSON.stringify({
                  checkpointManifestSha256: '1'.repeat(64),
                  principalId: 'principal:source',
                  proof: 'opaque-proof',
                  receiptKeyId: 'cloud-target-key',
                  receiptPublicKey,
                  schemaVersion: 1,
                }),
                targetAuthority: { generation: 2, kind: 'cloud' },
                transferId: 'transfer-incoming',
              }),
              getLifecycleJournal: () => Promise.resolve({
                direction: 'lan-to-cloud',
                kind: 'authority-transfer',
                operationId: 'transfer-incoming',
                phase: 'source-quiesced',
                projectId,
              }),
            },
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: [],
        }),
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [{
            kind: 'authority-transfer',
            operationId: 'transfer-incoming',
            projectId,
            scheduledAt: '2026-09-03T00:00:00.000Z',
          }],
          nextCursor: undefined,
        }),
        listTerminalProjectContinuity: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [],
        }),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 12,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: '0.0.0',
        }),
      },
      verifier: new ClaimCustodyKeyReferenceVerifier({
        custody: { open: () => Promise.resolve('unused') },
        keyring: {
          assertReferences: ({ receiptKeyIds }) => {
            if (receiptKeyIds.includes('cloud-target-key')) {
              throw new Error('rotated-away-target-key');
            }
          },
          assertReceiptPublicKey() {},
        },
      }),
    });

    await assert.rejects(
      gate.verifyAll(new AbortController().signal),
      /active-claim-custody-key-reference\.error\.unavailable/u,
    );
  });

  for (const active of [false, true]) {
  it(`checks retained terminal continuity with active Project ${String(active)}`, async () => {
    const placement = { active: true, generation: 1, projectId, repositoryStorageKey: 'repo-a', storageNodeId: 'node-a' };
    const activeRecords = [{ kind: 'project' }];
    const records = [{ kind: 'tombstone', value: { projectId } }];
    const verified: unknown[] = [];
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => Promise.resolve(),
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            checkpoint: {
              readTerminalProjectContinuityRecords: () => Promise.resolve(records),
              readProjectCheckpointRecords: () => Promise.resolve(activeRecords),
            },
            getProject: () => Promise.resolve(active ? { projectId, serviceState: 'active' } : undefined),
            getRepositoryPlacement: () => Promise.resolve(active ? placement : undefined),
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: active ? [placement] : [],
        }),
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [],
          nextCursor: undefined,
        }),
        listTerminalProjectContinuity: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [projectId],
        }),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 9,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: 'development',
        }),
      },
      verifier: {
        verify: value => {
          verified.push(value);
          return Promise.resolve();
        },
      },
    });

    await gate.verifyAll(new AbortController().signal);
    assert.deepEqual(verified, active ? [activeRecords, records] : [records]);
  });

  }

  it('checks canonical backup records for every active Project', async () => {
    const verified: unknown[] = [];
    let closed = false;
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => {
            closed = true;
            return Promise.resolve();
          },
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            checkpoint: {
              readProjectCheckpointRecords: (input: {
                readonly excludedOperationId?: string;
                readonly profile: string;
              }) => {
                assert.equal(input.profile, 'backup');
                assert.equal(input.excludedOperationId, undefined);
                return Promise.resolve([{ kind: 'project' }]);
              },
            },
            getProject: () => Promise.resolve({
              projectId,
              serviceState: 'active',
            }),
            getRepositoryPlacement: () => Promise.resolve({
              generation: 1,
              projectId,
              repositoryStorageKey: 'repo-a',
              storageNodeId: 'node-a',
            }),
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: [{
            active: true,
            generation: 1,
            projectId,
            repositoryStorageKey: 'repo-a',
            storageNodeId: 'node-a',
          }],
        }),
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [],
          nextCursor: undefined,
        }),
        listTerminalProjectContinuity: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [],
        }),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 9,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: '0.0.0',
        }),
      },
      verifier: {
        verify: records => {
          verified.push(records);
          return Promise.resolve();
        },
      },
    });

    await gate.verifyAll(new AbortController().signal);
    assert.deepEqual(verified, [[{ kind: 'project' }]]);
    assert.equal(closed, true);
  });

  it('checks a retained placement while authority transfer awaits target proof', async () => {
    const verified: unknown[] = [];
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => Promise.resolve(),
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            checkpoint: {
              readProjectCheckpointRecords: () => Promise.resolve([
                { kind: 'authority-transfer-recovery' },
              ]),
            },
            getProject: () => Promise.resolve({
              projectId,
              serviceState: 'read-only-transition',
            }),
            getRepositoryPlacement: () => Promise.resolve({
              generation: 1,
              projectId,
              repositoryStorageKey: 'repo-a',
              storageNodeId: 'node-a',
            }),
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: [{
            active: true,
            generation: 1,
            projectId,
            repositoryStorageKey: 'repo-a',
            storageNodeId: 'node-a',
          }],
        }),
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [],
          nextCursor: undefined,
        }),
        listTerminalProjectContinuity: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [],
        }),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 9,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: '0.0.0',
        }),
      },
      verifier: {
        verify: records => {
          verified.push(records);
          return Promise.resolve();
        },
      },
    });

    await gate.verifyAll(new AbortController().signal);
    assert.deepEqual(verified, [[{ kind: 'authority-transfer-recovery' }]]);
  });

  it('checks a recovery-catalog transfer after the Cloud source relinquishes', async () => {
    const records = [
      { kind: 'protected-claim-envelope', value: { keyId: 'claim-key-old' } },
      { kind: 'transfer-receipt-key', value: { receiptKeyId: 'receipt-key-old' } },
    ];
    const verified: unknown[] = [];
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => Promise.resolve(),
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            checkpoint: {
              readTerminalProjectContinuityRecords: () => Promise.resolve(records),
            },
            portability: {
              getAuthorityTransferRecovery: () => Promise.resolve({
                relinquishmentProof: undefined,
                sourceAuthority: { generation: 1, kind: 'cloud' },
                sourceProof: undefined,
                targetAuthority: { generation: 2, kind: 'lan' },
                targetProof: undefined,
                transferId: 'transfer-a',
              }),
              getLifecycleJournal: () => Promise.resolve({
                direction: 'cloud-to-lan',
                kind: 'authority-transfer',
                operationId: 'transfer-a',
                projectId,
              }),
            },
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: [],
        }),
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [{
            kind: 'authority-transfer',
            operationId: 'transfer-a',
            projectId,
            scheduledAt: '2026-09-03T00:00:00.000Z',
          }],
          nextCursor: undefined,
        }),
        listTerminalProjectContinuity: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [],
        }),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 12,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: '0.0.0',
        }),
      },
      verifier: {
        verify: value => {
          verified.push(value);
          return Promise.resolve();
        },
      },
    });

    await gate.verifyAll(new AbortController().signal);
    assert.equal(verified.length, 1);
    assert.deepEqual(
      (verified[0] as readonly { readonly kind: string }[]).map(record => record.kind),
      [
        'protected-claim-envelope',
        'transfer-receipt-key',
        'lifecycle-journal',
        'authority-transfer-recovery',
      ],
    );
  });

  for (const phase of ['source-quiesced', 'checkpoint-received'] as const) {
    it(`checks incoming LAN-to-Cloud key continuity at ${phase}`, async () => {
      const verified: unknown[] = [];
      const gate = new ActiveClaimCustodyKeyReferenceGate({
        coordination: {
          acquireProjectLease: () => Promise.resolve({
            close: () => Promise.resolve(),
            withProjectScope: (operation: (scope: never) => unknown) => operation({
              checkpoint: {
                readTerminalProjectContinuityRecords: () => Promise.resolve([]),
              },
              portability: {
                getAuthorityTransferRecovery: () => Promise.resolve({
                  relinquishmentProof: undefined,
                  sourceAuthority: { generation: 1, kind: 'lan' },
                  sourceProof: JSON.stringify({
                    receiptKeyId: 'cloud-target-key',
                    receiptPublicKey: Buffer.alloc(32, 4).toString('base64url'),
                  }),
                  targetAuthority: { generation: 2, kind: 'cloud' },
                  targetProof: undefined,
                  transferId: 'transfer-a',
                }),
                getLifecycleJournal: () => Promise.resolve({
                  direction: 'lan-to-cloud',
                  kind: 'authority-transfer',
                  operationId: 'transfer-a',
                  phase,
                  projectId,
                }),
              },
            } as never),
          } as never),
          listActiveRepositoryPlacements: () => Promise.resolve({
            nextCursor: undefined,
            placements: [],
          }),
          listRecoveryCandidates: () => Promise.resolve({
            candidates: [{
              kind: 'authority-transfer',
              operationId: 'transfer-a',
              projectId,
              scheduledAt: '2026-09-03T00:00:00.000Z',
            }],
            nextCursor: undefined,
          }),
          listTerminalProjectContinuity: () => Promise.resolve({
            nextCursor: undefined,
            projectIds: [],
          }),
        } as never,
        metadata: {
          read: () => Promise.resolve({
            authorityId: 'authority-a',
            authorityVolumeIdentity: 'volume-a',
            coordinationSchemaVersion: 12,
            repositoryFormatVersion: 1,
            restoreEpoch: 1,
            serverBuild: '0.0.0',
          }),
        },
        verifier: {
          verify: value => {
            verified.push(value);
            return Promise.resolve();
          },
        },
      });

      await gate.verifyAll(new AbortController().signal);
      assert.equal(verified.length, 1);
      assert.deepEqual(
        (verified[0] as readonly { readonly kind: string }[]).map(record => record.kind),
        ['lifecycle-journal', 'authority-transfer-recovery'],
      );
    });
  }

  it('fails closed when the active placement changes under the lease', async () => {
    const gate = new ActiveClaimCustodyKeyReferenceGate({
      coordination: {
        acquireProjectLease: () => Promise.resolve({
          close: () => Promise.resolve(),
          withProjectScope: (operation: (scope: never) => unknown) => operation({
            getProject: () => Promise.resolve({ projectId, serviceState: 'active' }),
            getRepositoryPlacement: () => Promise.resolve(undefined),
          } as never),
        } as never),
        listActiveRepositoryPlacements: () => Promise.resolve({
          nextCursor: undefined,
          placements: [{
            active: true,
            generation: 1,
            projectId,
            repositoryStorageKey: 'repo-a',
            storageNodeId: 'node-a',
          }],
        }),
        listRecoveryCandidates: () => Promise.resolve({
          candidates: [],
          nextCursor: undefined,
        }),
        listTerminalProjectContinuity: () => Promise.resolve({
          nextCursor: undefined,
          projectIds: [],
        }),
      } as never,
      metadata: {
        read: () => Promise.resolve({
          authorityId: 'authority-a',
          authorityVolumeIdentity: 'volume-a',
          coordinationSchemaVersion: 9,
          repositoryFormatVersion: 1,
          restoreEpoch: 1,
          serverBuild: '0.0.0',
        }),
      },
      verifier: { verify: () => Promise.resolve() },
    });
    await assert.rejects(
      gate.verifyAll(new AbortController().signal),
      /active-claim-custody-key-reference\.error\.unavailable/u,
    );
  });
});
