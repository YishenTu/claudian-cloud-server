import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CollabCheckpointBackupRecord } from '@claudian-collab/protocol';

import type {
  PinnedProjectLease,
  ProjectScope,
} from '../../src/coordination/ProjectCoordination.js';
import { CloudBackupExportCheckpointSource } from '../../src/project-authority/checkpoint/CloudBackupExportCheckpointSource.js';
import type { ExactRepositoryOperationReservation } from '../../src/repositories/RepositoryCheckpointAuthority.js';
import { createRepositoryPlacementLease } from '../../src/repositories/RepositoryPlacement.js';

const CREATED_AT = '2026-08-28T00:00:00.000Z';
const MAIN_OID = 'a'.repeat(40);
const MEMBER_OID = 'b'.repeat(40);
const records: readonly CollabCheckpointBackupRecord[] = Object.freeze([
  Object.freeze({
    kind: 'project',
    recordId: 'project-a',
    revision: 1,
    value: Object.freeze({
      activatedAt: CREATED_AT,
      authorityGeneration: 3,
      createdAt: CREATED_AT,
      expectedMainOid: MAIN_OID,
      managerSetGeneration: 1,
      name: 'Project A',
      projectId: 'project-a',
    }),
  }),
  Object.freeze({
    kind: 'member',
    recordId: 'member-manager',
    revision: 1,
    value: Object.freeze({
      activatedAt: CREATED_AT,
      createdAt: CREATED_AT,
      displayName: 'Manager',
      memberId: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      projectId: 'project-a',
      revokedAt: null,
      role: 'manager',
      status: 'active',
      updatedAt: CREATED_AT,
    }),
  }),
]);

describe('CloudBackupExportCheckpointSource', () => {
  it('uses one repeatable SQL snapshot and the pre-acquired Git reservation', async () => {
    const placement = createRepositoryPlacementLease({
      active: true,
      generation: 4,
      projectId: 'project-a',
      repositoryStorageKey: 'repository-a',
      storageNodeId: 'node-a',
    });
    let scopeOptions: unknown;
    const scope = {
      checkpoint: {
        readProjectCheckpointRecords(input: Readonly<{
          readonly excludedOperationId: string;
          readonly profile: string;
          readonly snapshotAt: string;
        }>) {
          assert.equal(input.excludedOperationId, 'export-one');
          assert.equal(input.profile, 'export');
          assert.equal(input.snapshotAt, CREATED_AT);
          return Promise.resolve(records);
        },
      },
      getProject: () => Promise.resolve(Object.freeze({
        projectId: 'project-a',
        serviceState: 'maintenance',
      })),
      getRepositoryPlacement: () => Promise.resolve(placement),
    } as unknown as ProjectScope;
    const lease = {
      close: () => Promise.resolve(),
      drainDevelopmentBootstrapUploads: () => Promise.resolve(),
      handoffToDevelopmentBootstrapUpload: () => Promise.reject(
        new Error('unexpected-upload-handoff'),
      ),
      withProjectScope<Value>(
        operation: (value: ProjectScope) => Promise<Value>,
        options?: unknown,
      ) {
        scopeOptions = options;
        return operation(scope);
      },
    } as PinnedProjectLease;
    const repositoryReservation = Object.freeze({
      close: () => Promise.resolve(),
      projectId: 'project-a',
    }) as ExactRepositoryOperationReservation;
    const reservation = Object.freeze({
      close: () => Promise.resolve(),
      maximumCoordinationBytes: 1024 * 1024,
      projectId: 'project-a',
      repositoryReservation,
    });
    let observedReservation: ExactRepositoryOperationReservation | undefined;
    const source = new CloudBackupExportCheckpointSource({
      metadata: Object.freeze({
        authorityId: 'authority-a',
        authorityVolumeIdentity: 'authority-volume-a',
        coordinationSchemaVersion: 9,
        repositoryFormatVersion: 1,
        restoreEpoch: 1,
        serverBuild: 'cloud-build-a',
      }),
      repository: {
        inventoryRefs(input, suppliedReservation) {
          assert.deepEqual(input.memberIds, ['member-manager']);
          assert.deepEqual(input.placement, placement);
          observedReservation = suppliedReservation;
          return Promise.resolve(Object.freeze([
            Object.freeze({ name: 'refs/heads/main', oid: MAIN_OID }),
            Object.freeze({
              name: 'refs/heads/members/member-manager',
              oid: MEMBER_OID,
            }),
          ]));
        },
      },
    });

    const signal = new AbortController().signal;
    const snapshot = await source.snapshot({
      lease,
      operationId: 'export-one',
      profile: 'export',
      projectId: 'project-a',
      repositoryReservation: reservation,
      signal,
      snapshotAt: CREATED_AT,
    });

    assert.deepEqual(scopeOptions, {
      signal,
      snapshot: 'repeatable-read',
    });
    assert.equal(observedReservation, repositoryReservation);
    assert.equal(snapshot.records, records);
  });
});
