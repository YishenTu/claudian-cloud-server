import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from 'pg';

import type { CreateProjectInvitationPersistenceInput, ProjectMembershipPersistence } from '../../../src/coordination/ProjectMembershipPersistence.js';
import { PostgresCoordination } from '../../../src/coordination/postgres/PostgresCoordination.js';
import { PostgresMigrator } from '../../../src/coordination/postgres/PostgresMigrator.js';
import {
  type PostgresTestDatabase,
  withPostgresTestDatabase,
} from '../../helpers/PostgresTestDatabase.js';

const PROJECT_ID = 'project_invitation_sql';
const MEMBER_ID = 'member_invitation_manager';
const CREATED = '2026-08-30T02:00:00.000Z';
const INPUT: CreateProjectInvitationPersistenceInput = Object.freeze({
  createdAt: CREATED,
  envelope: Object.freeze({
    algorithm: 'xchacha20-poly1305',
    associatedDataSha256: 'a'.repeat(64),
    ciphertext: Buffer.alloc(43, 2).toString('base64url'),
    createdAt: CREATED,
    expiresAt: '2026-08-31T02:00:00.000Z',
    invitationId: 'invitation_sql_one',
    keyId: 'invitation-key',
    keyVersion: 1,
    nonce: Buffer.alloc(24, 3).toString('base64url'),
    projectId: PROJECT_ID,
    tag: Buffer.alloc(16, 4).toString('base64url'),
  }),
  expectedManagerSetGeneration: 1,
  expiresAt: '2026-08-31T02:00:00.000Z',
  idempotencyKey: 'invitation_sql_key',
  invitationId: 'invitation_sql_one',
  issuedByMemberId: MEMBER_ID,
  projectId: PROJECT_ID,
  requestFingerprint: 'b'.repeat(64),
  secretReplayExpiresAt: '2026-09-29T02:00:00.000Z',
  secretSha256: 'c'.repeat(64),
  terminalAt: null,
});

function coordination(database: PostgresTestDatabase): PostgresCoordination {
  return new PostgresCoordination({
    ordinaryPoolMax: 4,
    pinnedPoolMax: 2,
    projectLockTimeoutMs: 2_000,
    reservedPoolMax: 1,
    runtimeConnectionString: database.runtimeUrl,
    shutdownTimeoutMs: 2_000,
  });
}

async function seed(database: PostgresTestDatabase): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [PROJECT_ID],
    );
    await client.query(
      `INSERT INTO claudian_cloud.projects (
         project_id, project_name, manager_set_generation,
         expected_main_oid, service_state, created_at, activated_at
       ) VALUES ($1, 'Invitation Project', 1, $2, 'active', $3, $3)`,
      [PROJECT_ID, 'a'.repeat(40), CREATED],
    );
    await client.query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, display_name, role, status, revision,
         created_at, updated_at, activated_at
       ) VALUES
         ($1, $2, 'Invitation Manager', 'manager', 'active', 2, $3, $3, $3),
         ($1, 'member_admin_target', 'Administration Target', 'member',
          'active', 2, $3, $3, $3),
         ($1, 'member_admin_second_manager', 'Second Manager', 'manager',
          'active', 2, $3, $3, $3)`,
      [PROJECT_ID, MEMBER_ID, CREATED],
    );
    await client.query(
      `INSERT INTO claudian_cloud.project_principal_bindings (
         project_id, principal_id, member_id, state, bound_at, revoked_at
       ) VALUES ($1, 'principal.admin.target', 'member_admin_target',
                 'active', $2, NULL)`,
      [PROJECT_ID, CREATED],
    );
    await client.query(
      `INSERT INTO claudian_cloud.repository_placements (
         project_id, storage_node_id, repository_storage_key, generation,
         active, created_at, updated_at
       ) VALUES ($1, 'node-a', 'repo_invitation_sql', 1, true, $2, $2)`,
      [PROJECT_ID, CREATED],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

async function seedCapacityMembers(
  database: PostgresTestDatabase,
  count: number,
): Promise<void> {
  const client = new Client({ connectionString: database.migrationUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('claudian_cloud.project_id', $1, true)",
      [PROJECT_ID],
    );
    await client.query(
      `INSERT INTO claudian_cloud.project_memberships (
         project_id, member_id, display_name, role, status, revision,
         created_at, updated_at, activated_at
       )
       SELECT $1,
              'member_capacity_' || lpad(value::text, 3, '0'),
              'Capacity Member ' || value::text,
              'member', 'active', 1, $2, $2, $2
         FROM generate_series(1, $3) AS value`,
      [PROJECT_ID, CREATED, count],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

function invitationInput(
  invitationId: string,
  idempotencyKey: string,
  digestCharacter: string,
): CreateProjectInvitationPersistenceInput {
  return Object.freeze({
    ...INPUT,
    envelope: Object.freeze({
      ...INPUT.envelope,
      invitationId,
    }),
    idempotencyKey,
    invitationId,
    requestFingerprint: digestCharacter.repeat(64),
    secretSha256: digestCharacter.repeat(64),
  });
}

describe('Postgres Project invitation persistence', () => {
  it('revokes and scrubs Cloud-only membership authorities at relinquishment', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          await lease.withProjectScope(async scope => {
            assert.equal((await scope.membership.createInvitation(INPUT)).status, 'created');
            assert.equal((await scope.membership.createManagerResponsibilityOffer({
              actorMemberId: MEMBER_ID,
              expectedManagerSetGeneration: 1,
              expectedTargetMembershipRevision: 2,
              expiresAt: '2026-08-31T02:00:00.000Z',
              idempotencyKey: 'offer_relinquishment_key',
              offeredAt: CREATED,
              offerId: 'offer_relinquishment',
              projectId: PROJECT_ID,
              purpose: 'manager-promotion',
              requestFingerprint: 'd'.repeat(64),
              targetMemberId: 'member_admin_target',
            })).status, 'created');

            assert.equal(await scope.membership.relinquishCloudMembershipAuthorities({
              relinquishedAt: '2026-08-30T03:00:00.000Z',
              retainedOutgoingTransferId: 'outgoing_transfer_relinquishment',
            }), 'advanced');
            assert.equal(await scope.membership.relinquishCloudMembershipAuthorities({
              relinquishedAt: '2026-08-30T03:00:00.000Z',
              retainedOutgoingTransferId: 'outgoing_transfer_relinquishment',
            }), 'replayed');

            const invitations = await scope.membership.listInvitations(
              '2026-08-30T03:00:00.000Z',
            );
            assert.equal(invitations.invitations[0]?.state, 'revoked');
            assert.equal(invitations.invitations[0].envelope, undefined);
            assert.equal((await scope.membership.getManagerResponsibilityOffer({
              actorMemberId: MEMBER_ID,
              actorRole: 'manager',
              now: '2026-08-30T03:00:00.000Z',
              offerId: 'offer_relinquishment',
            }))?.state, 'cancelled');
            assert.deepEqual(await scope.membership.listCurrentManagerResponsibilityOffers({
              actorMemberId: MEMBER_ID,
              actorRole: 'manager',
              now: '2026-08-30T03:00:00.000Z',
            }), []);
          });
        } finally {
          await lease.close();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('persists Removal and atomically revokes the target authority surfaces', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          const prepared = await lease.withProjectScope(scope => (
            scope.membership.prepareRemoval({
              actorMemberId: MEMBER_ID,
              expectedManagerSetGeneration: 1,
              expectedPersonalRefOid: 'a'.repeat(40),
              expectedTargetMembershipRevision: 2,
              idempotencyKey: 'remove_sql_key',
              operationId: 'remove_sql_operation',
              personalRef: 'refs/heads/members/member_admin_target',
              placementGeneration: 1,
              preparedAt: '2026-08-30T03:00:00.000Z',
              projectId: PROJECT_ID,
              repositoryStorageKey: 'repo_invitation_sql',
              requestFingerprint: 'f'.repeat(64),
              storageNodeId: 'node-a',
              targetMemberId: 'member_admin_target',
            })
          ));
          assert.equal(prepared.status, 'created');
          const settled = await lease.withProjectScope(scope => (
            scope.membership.settleRemoval({
              operationId: 'remove_sql_operation',
              removedAt: '2026-08-30T03:01:00.000Z',
            })
          ));
          assert.deepEqual(settled, {
            response: {
              discardedRequestId: null,
              managerSetGeneration: 1,
              memberId: 'member_admin_target',
              projectId: PROJECT_ID,
              removedAt: '2026-08-30T03:01:00.000Z',
              status: 'revoked',
            },
            status: 'settled',
          });
          assert.equal(
            (await lease.withProjectScope(scope => (
              scope.findMembership('member_admin_target')
            )))?.status,
            'revoked',
          );
          assert.equal(
            (await lease.withProjectScope(scope => (
              scope.portability.findProjectPrincipalBinding('principal.admin.target')
            )))?.state,
            'revoked',
          );
        } finally {
          await lease.close();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('atomically promotes an acknowledged successor when the final Manager leaves', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const migration = new Client({ connectionString: database.migrationUrl });
      try {
        await migration.connect();
        await migration.query('BEGIN');
        await migration.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        await migration.query(
          `UPDATE claudian_cloud.project_memberships
              SET status = 'revoked', revoked_at = $2, revision = revision + 1,
                  updated_at = $2
            WHERE project_id = $1 AND member_id = 'member_admin_second_manager'`,
          [PROJECT_ID, '2026-08-30T03:00:00.000Z'],
        );
        await migration.query('COMMIT');
      } finally {
        await migration.end();
      }
      const store = coordination(database);
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          const offer = await lease.withProjectScope(scope => (
            scope.membership.createManagerResponsibilityOffer({
              actorMemberId: MEMBER_ID,
              expectedManagerSetGeneration: 1,
              expectedTargetMembershipRevision: 2,
              expiresAt: '2026-08-31T04:00:00.000Z',
              idempotencyKey: 'leave_offer_key',
              offeredAt: '2026-08-30T04:00:00.000Z',
              offerId: 'leave_offer_sql',
              projectId: PROJECT_ID,
              purpose: 'manager-leave',
              requestFingerprint: '9'.repeat(64),
              targetMemberId: 'member_admin_target',
            })
          ));
          assert.equal(offer.status, 'created');
          const acknowledged = await lease.withProjectScope(scope => (
            scope.membership.transitionManagerResponsibilityOffer({
              actorMemberId: 'member_admin_target',
              actorRole: 'member',
              expectedOfferRevision: 1,
              idempotencyKey: 'leave_offer_ack_key',
              nextState: 'acknowledged',
              offerId: 'leave_offer_sql',
              operation: 'acknowledgeManagerResponsibility',
              requestFingerprint: '8'.repeat(64),
              transitionedAt: '2026-08-30T04:01:00.000Z',
            })
          ));
          assert.equal(acknowledged.status, 'created');
          await lease.withProjectScope(async scope => {
            await scope.portability.putLifecycleJournal({
              actorMemberId: MEMBER_ID,
              createdAt: '2026-08-30T04:02:00.000Z',
              direction: undefined,
              expectedAuthorityGeneration: 1,
              expectedPersonalRefOid: 'a'.repeat(40),
              idempotencyKey: 'leave_final_manager_key',
              kind: 'leave',
              operationId: 'leave_final_manager_operation',
              phase: 'prepared',
              projectId: PROJECT_ID,
              requestFingerprint: '7'.repeat(64),
              scheduledAt: '2026-08-30T04:02:00.000Z',
            });
            await scope.portability.putLeaveProjectRequestFacts({
              expectedManagerSetGeneration: 1,
              expectedMembershipRevision: 2,
              expectedOfferRevision: 2,
              managerResponsibilityOfferId: 'leave_offer_sql',
              operationId: 'leave_final_manager_operation',
              projectId: PROJECT_ID,
            });
          });
          const settled = await lease.withProjectScope(scope => (
            scope.portability.settleLeaveMembership({
              expectedManagerSetGeneration: 1,
              expectedMembershipRevision: 2n,
              expectedOfferRevision: 2,
              leftAt: '2026-08-30T04:03:00.000Z',
              managerResponsibilityOfferId: 'leave_offer_sql',
              memberId: MEMBER_ID,
              operationId: 'leave_final_manager_operation',
            })
          ));
          assert.deepEqual(settled, {
            response: {
              discardedRequestId: null,
              leftAt: '2026-08-30T04:03:00.000Z',
              managerSetGeneration: 2,
              memberId: MEMBER_ID,
              projectId: PROJECT_ID,
              promotedSuccessorMemberId: 'member_admin_target',
              status: 'left',
            },
            status: 'settled',
          });
          assert.deepEqual(
            await lease.withProjectScope(scope => (
              scope.findMembership('member_admin_target')
            )),
            {
              displayName: 'Administration Target',
              memberId: 'member_admin_target',
              revision: 3n,
              role: 'manager',
              status: 'active',
            },
          );
        } finally {
          await lease.close();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('atomically reserves capacity, replays exact custody, revokes, and scrubs plaintext replay', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          assert.equal(await lease.withProjectScope(async scope => (
            await scope.membership.createInvitation(INPUT)
          )).then(value => value.status), 'created');
          const replay = await lease.withProjectScope(scope => (
            scope.membership.createInvitation(INPUT)
          ));
          assert.equal(replay.status, 'replayed');
          assert.deepEqual(replay.record?.envelope, INPUT.envelope);
          const listed = await lease.withProjectScope(scope => (
            scope.membership.listInvitations(CREATED)
          ));
          assert.equal(listed.invitations.length, 1);
          assert.equal(listed.invitations[0]?.state, 'active');
          const revoked = await lease.withProjectScope(scope => (
            scope.membership.revokeInvitation({
              actorMemberId: MEMBER_ID,
              expectedInvitationRevision: 1,
              expectedManagerSetGeneration: 1,
              idempotencyKey: 'revoke_sql_key',
              invitationId: INPUT.invitationId,
              projectId: PROJECT_ID,
              requestFingerprint: 'd'.repeat(64),
              revokedAt: '2026-08-30T03:00:00.000Z',
            })
          ));
          assert.equal(revoked.status, 'revoked');
          assert.ok(revoked.record);
          assert.equal(revoked.record.revision, 2);
          assert.equal(revoked.record.state, 'revoked');
          await lease.withProjectScope(scope => scope.membership.listInvitations(
            '2026-09-29T02:00:00.000Z',
          ));
          const scrubbed = await lease.withProjectScope(scope => (
            scope.membership.createInvitation(INPUT)
          ));
          assert.equal(scrubbed.status, 'replay-expired');
        } finally {
          await lease.close();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('stores membership operation results in the shared idempotency relation', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.createInvitation(INPUT)
          ))).status, 'created');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.revokeInvitation({
              actorMemberId: MEMBER_ID,
              expectedInvitationRevision: 1,
              expectedManagerSetGeneration: 1,
              idempotencyKey: 'revoke_shared_result_key',
              invitationId: INPUT.invitationId,
              projectId: PROJECT_ID,
              requestFingerprint: 'd'.repeat(64),
              revokedAt: '2026-08-30T03:00:00.000Z',
            })
          ))).status, 'revoked');
        } finally {
          await lease.close();
        }
      } finally {
        await store.close();
      }

      const client = new Client({ connectionString: database.migrationUrl });
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('claudian_cloud.project_id', $1, true)",
          [PROJECT_ID],
        );
        const result = await client.query<{
          readonly legacy_relation: string | null;
          readonly operation: string;
        }>(
          `SELECT to_regclass(
                    'claudian_cloud.project_membership_idempotency_results'
                  )::text AS legacy_relation,
                  operation
             FROM claudian_cloud.idempotency_results
            WHERE project_id = $1
              AND member_id = $2
              AND idempotency_key = 'revoke_shared_result_key'`,
          [PROJECT_ID, MEMBER_ID],
        );
        assert.deepEqual(result.rows, [{
          legacy_relation: null,
          operation: 'revokeProjectInvitation',
        }]);
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    });
  });

  it('persists the forward-only Join phases and atomically activates membership', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          await lease.withProjectScope(scope => scope.membership.createInvitation(INPUT));
          const prepared = await lease.withProjectScope(scope => scope.membership.prepareJoin({
            displayName: 'Joined Member',
            expectedMainOid: 'a'.repeat(40),
            idempotencyKey: 'join_sql_key',
            invitationId: INPUT.invitationId,
            invitationRevision: 1,
            managerSetGeneration: 1,
            memberId: 'member_joined_sql',
            operationId: 'join_sql_operation',
            personalRef: 'refs/heads/members/member_joined_sql',
            placementGeneration: 1,
            preparedAt: '2026-08-30T04:00:00.000Z',
            principalId: 'principal.joined.sql',
            principalSha256: 'e'.repeat(64),
            projectId: PROJECT_ID,
            repositoryStorageKey: 'repo_invitation_sql',
            requestFingerprint: 'f'.repeat(64),
            secretSha256: INPUT.secretSha256,
            storageNodeId: 'node-a',
          }));
          assert.equal(prepared.status, 'created');
          assert.equal(prepared.journal?.phase, 'prepared');
          await lease.withProjectScope(scope => scope.membership.advanceJoin({
            expectedPhase: 'prepared',
            nextPhase: 'membership-pending',
            operationId: 'join_sql_operation',
            updatedAt: '2026-08-30T04:00:00.000Z',
          }));
          await lease.withProjectScope(scope => scope.membership.advanceJoin({
            expectedPhase: 'membership-pending',
            nextPhase: 'personal-ref-created',
            operationId: 'join_sql_operation',
            updatedAt: '2026-08-30T04:00:00.000Z',
          }));
          const response = {
            joinedAt: '2026-08-30T04:00:00.000Z',
            mainOid: 'a'.repeat(40),
            managerSetGeneration: 1,
            memberId: 'member_joined_sql',
            membershipRevision: 2 as const,
            personalRef: 'refs/heads/members/member_joined_sql',
            projectId: PROJECT_ID,
            role: 'member' as const,
          };
          await lease.withProjectScope(async scope => {
            assert.equal(await scope.membership.activateJoin({
              joinedAt: response.joinedAt,
              operationId: 'join_sql_operation',
              response,
            }), 'activated');
            await scope.appendProjectEvent({
              kind: 'membership.updated',
              occurredAt: response.joinedAt,
              payload: { memberId: response.memberId },
            });
          });
          assert.deepEqual(await lease.withProjectScope(scope => (
            scope.membership.completeJoin({
              completedAt: response.joinedAt,
              operationId: 'join_sql_operation',
            })
          )), response);
        } finally {
          await lease.close();
        }

        const client = new Client({ connectionString: database.migrationUrl });
        try {
          await client.connect();
          await client.query('BEGIN');
          await client.query(
            "SELECT set_config('claudian_cloud.project_id', $1, true)",
            [PROJECT_ID],
          );
          const result = await client.query(`SELECT membership.status,
                  membership.revision::text AS revision,
                  binding.state AS binding_state,
                  invitation.state AS invitation_state,
                  journal.phase,
                  (SELECT count(*)::text
                     FROM claudian_cloud.recovery_candidates
                    WHERE project_id = $1) AS candidate_count
             FROM claudian_cloud.project_memberships AS membership
             JOIN claudian_cloud.project_principal_bindings AS binding
               USING (project_id, member_id)
             JOIN claudian_cloud.cloud_project_join_journals AS journal
               USING (project_id, member_id)
             JOIN claudian_cloud.project_invitations AS invitation
               USING (project_id, invitation_id)
            WHERE membership.project_id = $1 AND membership.member_id = $2`, [
            PROJECT_ID,
            'member_joined_sql',
          ]);
          assert.deepEqual(result.rows, [{
            binding_state: 'active',
            candidate_count: '0',
            invitation_state: 'redeemed',
            phase: 'completed',
            revision: '2',
            status: 'active',
          }]);
          await client.query('COMMIT');
        } finally {
          await client.end();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('counts one pending Join as one durable membership slot', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      await seedCapacityMembers(database, 95);
      const store = coordination(database);
      const secondInvitation = invitationInput(
        'invitation_capacity_second',
        'invitation_capacity_second_key',
        'd',
      );
      const thirdInvitation = invitationInput(
        'invitation_capacity_third',
        'invitation_capacity_third_key',
        'e',
      );
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          await lease.withProjectScope(scope => scope.membership.createInvitation(INPUT));
          await lease.withProjectScope(scope => scope.membership.prepareJoin({
            displayName: 'Capacity Joined Member',
            expectedMainOid: 'a'.repeat(40),
            idempotencyKey: 'join_capacity_key',
            invitationId: INPUT.invitationId,
            invitationRevision: 1,
            managerSetGeneration: 1,
            memberId: 'member_joined_capacity',
            operationId: 'join_capacity_operation',
            personalRef: 'refs/heads/members/member_joined_capacity',
            placementGeneration: 1,
            preparedAt: '2026-08-30T04:00:00.000Z',
            principalId: 'principal.joined.capacity',
            principalSha256: 'f'.repeat(64),
            projectId: PROJECT_ID,
            repositoryStorageKey: 'repo_invitation_sql',
            requestFingerprint: '1'.repeat(64),
            secretSha256: INPUT.secretSha256,
            storageNodeId: 'node-a',
          }));
          await lease.withProjectScope(scope => scope.membership.advanceJoin({
            expectedPhase: 'prepared',
            nextPhase: 'membership-pending',
            operationId: 'join_capacity_operation',
            updatedAt: '2026-08-30T04:00:00.000Z',
          }));

          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.createInvitation(secondInvitation)
          ))).status, 'created');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.createInvitation(thirdInvitation)
          ))).status, 'quota');
        } finally {
          await lease.close();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('distinguishes permanently stale demotion from replay and future expected state', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          const request = {
            actorMemberId: MEMBER_ID,
            demotedAt: CREATED,
            expectedManagerSetGeneration: 1,
            expectedTargetMembershipRevision: 2,
            idempotencyKey: 'demote_committed',
            projectId: PROJECT_ID,
            requestFingerprint: 'a'.repeat(64),
            targetMemberId: 'member_admin_second_manager',
          };
          const apply = (input: typeof request) => lease.withProjectScope(scope => (
            scope.membership.demoteManager(input)
          ));
          const committed = await apply(request);
          assert.equal(committed.status, 'created');
          assert.deepEqual(await apply(request), {
            response: committed.response,
            status: 'replayed',
          });
          const delayed = { ...request, idempotencyKey: 'demote_rejected' };
          assert.deepEqual(await apply(delayed), { status: 'permanently-stale' });
          assert.deepEqual(await apply(delayed), { status: 'permanently-stale' });
          assert.deepEqual(await apply({
            ...request,
            expectedManagerSetGeneration: 3,
            expectedTargetMembershipRevision: 3,
            idempotencyKey: 'demote_future',
          }), { status: 'final-manager' });
        } finally { await lease.close(); }
      } finally { await store.close(); }
    });
  });

  it('settles delayed management requests only for strictly advanced durable generations', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      const lease = await store.acquireProjectLease(PROJECT_ID);
      try {
        await lease.withProjectScope(scope => scope.membership.createInvitation(INPUT));
        await lease.withProjectScope(scope => scope.membership.demoteManager({
          actorMemberId: MEMBER_ID, demotedAt: CREATED,
          expectedManagerSetGeneration: 1, expectedTargetMembershipRevision: 2,
          idempotencyKey: 'advance_generation', projectId: PROJECT_ID,
          requestFingerprint: 'a'.repeat(64), targetMemberId: 'member_admin_second_manager',
        }));
        const attempts: readonly [string, (membership: ProjectMembershipPersistence,
          expectedManagerSetGeneration: number) => Promise<{ readonly status: string }>][] = [
          ['create invitation', (membership, expectedManagerSetGeneration) => membership.createInvitation({
            ...invitationInput('new_invitation', 'new_invitation_key', 'd'), expectedManagerSetGeneration,
          })],
          ['revoke invitation', (membership, expectedManagerSetGeneration) => membership.revokeInvitation({
            actorMemberId: MEMBER_ID, expectedInvitationRevision: 1, expectedManagerSetGeneration,
            idempotencyKey: 'stale_revoke', invitationId: INPUT.invitationId, projectId: PROJECT_ID,
            requestFingerprint: 'e'.repeat(64), revokedAt: CREATED,
          })],
          ['create offer', (membership, expectedManagerSetGeneration) => membership.createManagerResponsibilityOffer({
            actorMemberId: MEMBER_ID, expectedManagerSetGeneration, expectedTargetMembershipRevision: 2,
            expiresAt: INPUT.expiresAt, idempotencyKey: 'stale_offer', offeredAt: CREATED,
            offerId: 'stale_offer', projectId: PROJECT_ID, purpose: 'manager-promotion',
            requestFingerprint: 'f'.repeat(64), targetMemberId: 'member_admin_target',
          })],
          ['promote', (membership, expectedManagerSetGeneration) => membership.promoteManager({
            actorMemberId: MEMBER_ID, expectedManagerSetGeneration, expectedOfferRevision: 1,
            expectedTargetMembershipRevision: 2, idempotencyKey: 'stale_promote',
            managerResponsibilityOfferId: 'missing_offer', projectId: PROJECT_ID, promotedAt: CREATED,
            requestFingerprint: '1'.repeat(64), targetMemberId: 'member_admin_target',
          })],
          ['remove', (membership, expectedManagerSetGeneration) => membership.prepareRemoval({
            actorMemberId: MEMBER_ID, expectedManagerSetGeneration, expectedPersonalRefOid: 'a'.repeat(40),
            expectedTargetMembershipRevision: 2, idempotencyKey: 'stale_remove', operationId: 'stale_remove',
            personalRef: 'refs/heads/members/member_admin_target', placementGeneration: 1,
            preparedAt: CREATED, projectId: PROJECT_ID, repositoryStorageKey: 'repo_invitation_sql',
            requestFingerprint: '2'.repeat(64), storageNodeId: 'node-a', targetMemberId: 'member_admin_target',
          })],
          ['revoke claim', (membership, expectedManagerSetGeneration) => membership.revokeTransferredMembershipClaim({
            actorMemberId: MEMBER_ID, expectedClaimGeneration: 0, expectedManagerSetGeneration,
            expectedMembershipRevision: 2, idempotencyKey: 'stale_claim_revoke',
            memberId: 'member_admin_target', projectId: PROJECT_ID,
            requestFingerprint: '3'.repeat(64), revokedAt: CREATED,
          })],
          ['reissue claim', (membership, expectedManagerSetGeneration) => membership.reissueTransferredMembershipClaim({
            actorMemberId: MEMBER_ID, claimGeneration: 1, claimSha256: '4'.repeat(64),
            createdAt: CREATED, envelope: { ...INPUT.envelope, claimGeneration: 1,
              memberId: 'member_admin_target', transferId: 'transfer_old' },
            expectedClaimGeneration: 0, expectedManagerSetGeneration, expectedMembershipRevision: 2,
            expiresAt: INPUT.expiresAt, idempotencyKey: 'stale_claim_reissue', memberId: 'member_admin_target',
            projectId: PROJECT_ID, requestFingerprint: '5'.repeat(64),
            secretReplayExpiresAt: INPUT.secretReplayExpiresAt, transferId: 'transfer_old',
          })],
        ];
        for (const [name, attempt] of attempts) {
          assert.equal((await lease.withProjectScope(scope => attempt(scope.membership, 1))).status,
            'permanently-stale', name);
          assert.equal((await lease.withProjectScope(scope => attempt(scope.membership, 1))).status,
            'permanently-stale', `${name} delayed replay`);
          assert.notEqual((await lease.withProjectScope(scope => attempt(scope.membership, 3))).status,
            'permanently-stale', `${name} future generation`);
        }
        assert.equal((await lease.withProjectScope(scope => scope.membership.createInvitation(INPUT))).status,
          'replayed');
      } finally { await lease.close(); await store.close(); }
    });
  });

  it('settles advanced invitation and offer revisions after exact replay lookup', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      const lease = await store.acquireProjectLease(PROJECT_ID);
      try {
        await lease.withProjectScope(async scope => {
          await scope.membership.createInvitation(INPUT);
          const revoke = { actorMemberId: MEMBER_ID, expectedInvitationRevision: 1,
            expectedManagerSetGeneration: 1, idempotencyKey: 'revision_revoke',
            invitationId: INPUT.invitationId, projectId: PROJECT_ID,
            requestFingerprint: 'a'.repeat(64), revokedAt: CREATED };
          assert.equal((await scope.membership.revokeInvitation(revoke)).status, 'revoked');
          assert.equal((await scope.membership.revokeInvitation(revoke)).status, 'replayed');
          assert.equal((await scope.membership.revokeInvitation({ ...revoke,
            idempotencyKey: 'revision_delayed_revoke' })).status, 'permanently-stale');
          assert.equal((await scope.membership.revokeInvitation({ ...revoke,
            idempotencyKey: 'revision_future_revoke', expectedInvitationRevision: 3 })).status, 'stale-invitation');
          await scope.membership.createManagerResponsibilityOffer({
            actorMemberId: MEMBER_ID, expectedManagerSetGeneration: 1, expectedTargetMembershipRevision: 2,
            expiresAt: INPUT.expiresAt, idempotencyKey: 'revision_offer', offeredAt: CREATED,
            offerId: 'revision_offer', projectId: PROJECT_ID, purpose: 'manager-promotion',
            requestFingerprint: 'b'.repeat(64), targetMemberId: 'member_admin_target',
          });
          const transition = { actorMemberId: 'member_admin_target', actorRole: 'member' as const,
            expectedOfferRevision: 1, idempotencyKey: 'revision_ack', nextState: 'acknowledged' as const,
            offerId: 'revision_offer', operation: 'acknowledgeManagerResponsibility' as const,
            requestFingerprint: 'c'.repeat(64), transitionedAt: CREATED };
          assert.equal((await scope.membership.transitionManagerResponsibilityOffer(transition)).status, 'created');
          assert.equal((await scope.membership.transitionManagerResponsibilityOffer(transition)).status, 'replayed');
          for (const expectedOfferRevision of [1, 3]) {
            assert.equal((await scope.membership.transitionManagerResponsibilityOffer({ ...transition,
              actorMemberId: MEMBER_ID, actorRole: 'manager', expectedOfferRevision,
              idempotencyKey: 'revision_cancel', nextState: 'cancelled', operation: 'cancelManagerResponsibilityOffer',
            })).status, expectedOfferRevision === 1 ? 'permanently-stale' : 'stale');
            assert.equal((await scope.membership.promoteManager({
              actorMemberId: MEMBER_ID, expectedManagerSetGeneration: 1, expectedOfferRevision,
              expectedTargetMembershipRevision: 2, idempotencyKey: 'revision_promote',
              managerResponsibilityOfferId: 'revision_offer', projectId: PROJECT_ID, promotedAt: CREATED,
              requestFingerprint: 'd'.repeat(64), targetMemberId: 'member_admin_target',
            })).status, expectedOfferRevision === 1 ? 'permanently-stale' : 'stale');
          }
        });
      } finally { await lease.close(); await store.close(); }
    });
  });

  it('projects redacted members and atomically transfers Manager responsibility', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          const ordinary = await lease.withProjectScope(scope => (
            scope.membership.listProjectMembers({ actorRole: 'member', now: CREATED })
          ));
          const target = ordinary.members.find(value => (
            value.memberId === 'member_admin_target'
          ));
          assert.ok(target);
          assert.equal(target.bindingState, 'hidden');
          assert.equal(target.importedClaimState, 'hidden');

          const created = await lease.withProjectScope(scope => (
            scope.membership.createManagerResponsibilityOffer({
              actorMemberId: MEMBER_ID,
              expectedManagerSetGeneration: 1,
              expectedTargetMembershipRevision: 2,
              expiresAt: '2026-08-31T02:00:00.000Z',
              idempotencyKey: 'offer_sql_key',
              offerId: 'offer_sql_one',
              offeredAt: CREATED,
              projectId: PROJECT_ID,
              purpose: 'manager-promotion',
              requestFingerprint: '1'.repeat(64),
              targetMemberId: 'member_admin_target',
            })
          ));
          assert.equal(created.status, 'created');
          assert.equal(created.response?.offer.state, 'offered');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.listCurrentManagerResponsibilityOffers({
              actorMemberId: 'member_admin_target',
              actorRole: 'member',
              now: CREATED,
            })
          ))).length, 1);

          const acknowledged = await lease.withProjectScope(scope => (
            scope.membership.transitionManagerResponsibilityOffer({
              actorMemberId: 'member_admin_target',
              actorRole: 'member',
              expectedOfferRevision: 1,
              idempotencyKey: 'ack_sql_key',
              nextState: 'acknowledged',
              offerId: 'offer_sql_one',
              operation: 'acknowledgeManagerResponsibility',
              requestFingerprint: '2'.repeat(64),
              transitionedAt: '2026-08-30T02:01:00.000Z',
            })
          ));
          assert.ok(acknowledged.response);
          assert.equal(acknowledged.response.offer.revision, 2);
          assert.equal(acknowledged.response.offer.state, 'acknowledged');

          const promoted = await lease.withProjectScope(scope => (
            scope.membership.promoteManager({
              actorMemberId: MEMBER_ID,
              expectedManagerSetGeneration: 1,
              expectedOfferRevision: 2,
              expectedTargetMembershipRevision: 2,
              idempotencyKey: 'promote_sql_key',
              managerResponsibilityOfferId: 'offer_sql_one',
              projectId: PROJECT_ID,
              promotedAt: '2026-08-30T02:02:00.000Z',
              requestFingerprint: '3'.repeat(64),
              targetMemberId: 'member_admin_target',
            })
          ));
          assert.deepEqual(promoted.response, {
            managerSetGeneration: 2,
            membershipRevision: 3,
            offerRevision: 3,
            projectId: PROJECT_ID,
            promotedMemberId: 'member_admin_target',
          });
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.promoteManager({
              actorMemberId: MEMBER_ID,
              expectedManagerSetGeneration: 1,
              expectedOfferRevision: 2,
              expectedTargetMembershipRevision: 2,
              idempotencyKey: 'promote_sql_key',
              managerResponsibilityOfferId: 'offer_sql_one',
              projectId: PROJECT_ID,
              promotedAt: '2026-08-30T02:02:00.000Z',
              requestFingerprint: '3'.repeat(64),
              targetMemberId: 'member_admin_target',
            })
          ))).status, 'replayed');

          const demoted = await lease.withProjectScope(scope => (
            scope.membership.demoteManager({
              actorMemberId: MEMBER_ID,
              demotedAt: '2026-08-30T02:03:00.000Z',
              expectedManagerSetGeneration: 2,
              expectedTargetMembershipRevision: 3,
              idempotencyKey: 'demote_sql_key',
              projectId: PROJECT_ID,
              requestFingerprint: '4'.repeat(64),
              targetMemberId: 'member_admin_target',
            })
          ));
          assert.deepEqual(demoted.response, {
            demotedMemberId: 'member_admin_target',
            managerSetGeneration: 3,
            membershipRevision: 4,
            projectId: PROJECT_ID,
          });
        } finally {
          await lease.close();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('compacts terminal responsibility payloads after 30 days without reusing idempotency', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      const terminalAt = '2026-08-30T03:00:00.000Z';
      const retainedAt = '2026-09-29T02:59:59.999Z';
      const compactedAt = '2026-09-29T03:00:00.000Z';
      try {
        const lease = await store.acquireProjectLease(PROJECT_ID);
        try {
          const createOffer = (
            offerId: string,
            idempotencyKey: string,
            requestFingerprint: string,
            expectedManagerSetGeneration: number,
            expectedTargetMembershipRevision: number,
            offeredAt = CREATED,
          ) => lease.withProjectScope(scope => (
            scope.membership.createManagerResponsibilityOffer({
              actorMemberId: MEMBER_ID,
              expectedManagerSetGeneration,
              expectedTargetMembershipRevision,
              expiresAt: offeredAt === CREATED
                ? '2026-08-31T02:00:00.000Z'
                : '2026-08-31T03:00:00.000Z',
              idempotencyKey,
              offerId,
              offeredAt,
              projectId: PROJECT_ID,
              purpose: 'manager-promotion',
              requestFingerprint,
              targetMemberId: 'member_admin_target',
            })
          ));

          assert.equal((await createOffer(
            'offer_compact_consumed',
            'offer_compact_consumed_key',
            '1'.repeat(64),
            1,
            2,
          )).status, 'created');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.transitionManagerResponsibilityOffer({
              actorMemberId: 'member_admin_target',
              actorRole: 'member',
              expectedOfferRevision: 1,
              idempotencyKey: 'offer_compact_ack_key',
              nextState: 'acknowledged',
              offerId: 'offer_compact_consumed',
              operation: 'acknowledgeManagerResponsibility',
              requestFingerprint: '2'.repeat(64),
              transitionedAt: terminalAt,
            })
          ))).status, 'created');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.promoteManager({
              actorMemberId: MEMBER_ID,
              expectedManagerSetGeneration: 1,
              expectedOfferRevision: 2,
              expectedTargetMembershipRevision: 2,
              idempotencyKey: 'offer_compact_promote_key',
              managerResponsibilityOfferId: 'offer_compact_consumed',
              projectId: PROJECT_ID,
              promotedAt: terminalAt,
              requestFingerprint: '3'.repeat(64),
              targetMemberId: 'member_admin_target',
            })
          ))).status, 'created');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.demoteManager({
              actorMemberId: MEMBER_ID,
              demotedAt: terminalAt,
              expectedManagerSetGeneration: 2,
              expectedTargetMembershipRevision: 3,
              idempotencyKey: 'offer_compact_demote_key',
              projectId: PROJECT_ID,
              requestFingerprint: '4'.repeat(64),
              targetMemberId: 'member_admin_target',
            })
          ))).status, 'created');

          assert.equal((await createOffer(
            'offer_compact_declined',
            'offer_compact_declined_key',
            '5'.repeat(64),
            3,
            4,
            terminalAt,
          )).status, 'created');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.transitionManagerResponsibilityOffer({
              actorMemberId: 'member_admin_target',
              actorRole: 'member',
              expectedOfferRevision: 1,
              idempotencyKey: 'offer_compact_decline_key',
              nextState: 'declined',
              offerId: 'offer_compact_declined',
              operation: 'declineManagerResponsibility',
              requestFingerprint: '6'.repeat(64),
              transitionedAt: terminalAt,
            })
          ))).status, 'created');

          assert.equal((await createOffer(
            'offer_compact_cancelled',
            'offer_compact_cancelled_key',
            '7'.repeat(64),
            3,
            4,
            terminalAt,
          )).status, 'created');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.transitionManagerResponsibilityOffer({
              actorMemberId: MEMBER_ID,
              actorRole: 'manager',
              expectedOfferRevision: 1,
              idempotencyKey: 'offer_compact_cancel_key',
              nextState: 'cancelled',
              offerId: 'offer_compact_cancelled',
              operation: 'cancelManagerResponsibilityOffer',
              requestFingerprint: '8'.repeat(64),
              transitionedAt: terminalAt,
            })
          ))).status, 'created');

          await lease.withProjectScope(scope => (
            scope.membership.reconcileExpirations(retainedAt)
          ));
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.getManagerResponsibilityOffer({
              actorMemberId: MEMBER_ID,
              actorRole: 'manager',
              now: retainedAt,
              offerId: 'offer_compact_consumed',
            })
          )))?.state, 'consumed');
          const offeredReplay = await createOffer(
            'offer_compact_consumed',
            'offer_compact_consumed_key',
            '1'.repeat(64),
            1,
            2,
          );
          assert.equal(offeredReplay.status, 'replayed');
          assert.equal(offeredReplay.response?.offer.state, 'offered');

          await lease.withProjectScope(scope => (
            scope.membership.reconcileExpirations(compactedAt)
          ));
          assert.equal(await lease.withProjectScope(scope => (
            scope.membership.getManagerResponsibilityOffer({
              actorMemberId: MEMBER_ID,
              actorRole: 'manager',
              now: compactedAt,
              offerId: 'offer_compact_consumed',
            })
          )), undefined);
          assert.equal((await createOffer(
            'offer_compact_consumed',
            'offer_compact_consumed_key',
            '1'.repeat(64),
            1,
            2,
          )).status, 'conflict');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.transitionManagerResponsibilityOffer({
              actorMemberId: 'member_admin_target',
              actorRole: 'member',
              expectedOfferRevision: 1,
              idempotencyKey: 'offer_compact_ack_key',
              nextState: 'acknowledged',
              offerId: 'offer_compact_consumed',
              operation: 'acknowledgeManagerResponsibility',
              requestFingerprint: '2'.repeat(64),
              transitionedAt: compactedAt,
            })
          ))).status, 'conflict');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.promoteManager({
              actorMemberId: MEMBER_ID,
              expectedManagerSetGeneration: 1,
              expectedOfferRevision: 2,
              expectedTargetMembershipRevision: 2,
              idempotencyKey: 'offer_compact_promote_key',
              managerResponsibilityOfferId: 'offer_compact_consumed',
              projectId: PROJECT_ID,
              promotedAt: compactedAt,
              requestFingerprint: '3'.repeat(64),
              targetMemberId: 'member_admin_target',
            })
          ))).status, 'conflict');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.transitionManagerResponsibilityOffer({
              actorMemberId: 'member_admin_target',
              actorRole: 'member',
              expectedOfferRevision: 1,
              idempotencyKey: 'offer_compact_decline_key',
              nextState: 'declined',
              offerId: 'offer_compact_declined',
              operation: 'declineManagerResponsibility',
              requestFingerprint: '6'.repeat(64),
              transitionedAt: compactedAt,
            })
          ))).status, 'conflict');
          assert.equal((await lease.withProjectScope(scope => (
            scope.membership.transitionManagerResponsibilityOffer({
              actorMemberId: MEMBER_ID,
              actorRole: 'manager',
              expectedOfferRevision: 1,
              idempotencyKey: 'offer_compact_cancel_key',
              nextState: 'cancelled',
              offerId: 'offer_compact_cancelled',
              operation: 'cancelManagerResponsibilityOffer',
              requestFingerprint: '8'.repeat(64),
              transitionedAt: compactedAt,
            })
          ))).status, 'conflict');
        } finally {
          await lease.close();
        }

        const client = new Client({ connectionString: database.migrationUrl });
        try {
          await client.connect();
          await client.query('BEGIN');
          await client.query(
            "SELECT set_config('claudian_cloud.project_id', $1, true)",
            [PROJECT_ID],
          );
          const counts = await client.query<{
            readonly demote_results: string;
            readonly offers: string;
            readonly offer_results: string;
            readonly tombstones: string;
          }>(
            `SELECT
               (SELECT count(*) FROM claudian_cloud.manager_responsibility_offers
                 WHERE project_id = $1)::text AS offers,
               (SELECT count(*)
                  FROM claudian_cloud.idempotency_results
                 WHERE project_id = $1
                   AND operation <> 'demoteManager')::text AS offer_results,
               (SELECT count(*)
                  FROM claudian_cloud.idempotency_results
                 WHERE project_id = $1
                   AND operation = 'demoteManager')::text AS demote_results,
               (SELECT count(*)
                  FROM claudian_cloud.project_membership_idempotency_tombstones
                 WHERE project_id = $1)::text AS tombstones`,
            [PROJECT_ID],
          );
          assert.deepEqual(counts.rows, [{
            demote_results: '1',
            offer_results: '0',
            offers: '0',
            tombstones: '7',
          }]);
          await client.query('COMMIT');
        } finally {
          await client.end();
        }
      } finally {
        await store.close();
      }
    });
  });

  it('serializes concurrent responsibility offers to one current target authority', async () => {
    await withPostgresTestDatabase(async database => {
      await new PostgresMigrator({ connectionString: database.migrationUrl }).apply();
      await seed(database);
      const store = coordination(database);
      try {
        const offer = (
          actorMemberId: string,
          offerId: string,
          idempotencyKey: string,
          requestFingerprint: string,
        ) => store.withProjectScope(PROJECT_ID, scope => (
          scope.membership.createManagerResponsibilityOffer({
            actorMemberId,
            expectedManagerSetGeneration: 1,
            expectedTargetMembershipRevision: 2,
            expiresAt: '2026-08-31T02:00:00.000Z',
            idempotencyKey,
            offerId,
            offeredAt: CREATED,
            projectId: PROJECT_ID,
            purpose: 'manager-promotion',
            requestFingerprint,
            targetMemberId: 'member_admin_target',
          })
        ));
        const results = await Promise.all([
          offer(MEMBER_ID, 'offer_concurrent_a', 'offer_concurrent_key_a', '5'.repeat(64)),
          offer(
            'member_admin_second_manager',
            'offer_concurrent_b',
            'offer_concurrent_key_b',
            '6'.repeat(64),
          ),
        ]);
        assert.deepEqual(results.map(result => result.status).sort(), [
          'created',
          'stale',
        ]);
      } finally {
        await store.close();
      }
    });
  });
});
