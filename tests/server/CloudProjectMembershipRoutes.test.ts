import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import {
  CollabError,
  collabCloudProjectOperationRoute,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudSuccessEnvelope,
} from '@claudian-collab/protocol';

import { TrustedPrincipalProvider } from '../../src/request-context/TrustedPrincipalProvider.js';
import { CloudProjectMembershipRoutes } from '../../src/server/control/CloudProjectMembershipRoutes.js';

const PROJECT_ID = 'project_cloud_route';
const TIMESTAMP = '2026-08-30T01:02:03.000Z';
const MAIN = 'a'.repeat(40);
const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
  servers.clear();
});

describe('CloudProjectMembershipRoutes creation entry', () => {
  it('maps a personal-ref divergence to one state conflict', async () => {
    const routes = new CloudProjectMembershipRoutes({
      creation: { create: () => { throw new Error('unused'); } },
      join: {
        join: () => Promise.reject(new CollabError({
          code: 'personal-ref-diverged',
        })),
      },
      maximumJsonBytes: 64 * 1024,
      operationTimeoutMs: 2_000,
      trustedPrincipal: {
        establishedAssertion: () => ({
          principalId: 'principal_route',
          provenance: {
            kind: 'operator-protected-channel',
            providerId: 'test-provider',
          },
        }),
        provider: new TrustedPrincipalProvider(),
      },
    });
    const server = createServer((request, response) => {
      if (!routes.handle(request, response)) {
        response.writeHead(404);
        response.end();
      }
    });
    servers.add(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const route = collabCloudProjectOperationRoute(PROJECT_ID, 'joinCloudProject');
    const response = await fetch(
      `http://127.0.0.1:${String(address.port)}${route.target}`,
      {
        body: JSON.stringify({
          data: {
            displayName: 'Joined member',
            idempotencyKey: 'join-diverged-route-key',
            invitationId: 'invitation-route',
            projectId: PROJECT_ID,
            secret: Buffer.alloc(32, 7).toString('base64url'),
          },
          protocolVersion: 6,
          requestId: 'request-join-diverged',
        }),
        headers: { 'content-type': 'application/json' },
        method: route.method,
      },
    );
    assert.equal(response.status, 409);
    assert.equal(
      decodeCollabCloudErrorEnvelope(await response.json()).error.code,
      'personal-ref-diverged',
    );
  });

  it('uses only an injected established principal and dispatches exact creation', async () => {
    const calls: unknown[] = [];
    const responseValue = {
      createdAt: TIMESTAMP,
      mainOid: MAIN,
      managerSetGeneration: 1 as const,
      memberId: 'member_initial',
      membershipRevision: 2 as const,
      personalRef: 'refs/heads/members/member_initial',
      projectId: PROJECT_ID,
      role: 'manager' as const,
    };
    const routes = new CloudProjectMembershipRoutes({
      creation: {
        create: (principal, request, options) => {
          calls.push({ principal, request, signal: options?.signal });
          return Promise.resolve(responseValue);
        },
      },
      maximumJsonBytes: 64 * 1024,
      operationTimeoutMs: 2_000,
      trustedPrincipal: {
        establishedAssertion: () => ({
          principalId: 'principal_route',
          provenance: {
            kind: 'operator-protected-channel',
            providerId: 'test-provider',
          },
        }),
        provider: new TrustedPrincipalProvider(),
      },
    });
    const server = createServer((request, response) => {
      if (!routes.handle(request, response)) {
        response.writeHead(404);
        response.end();
      }
    });
    servers.add(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const route = collabCloudProjectOperationRoute(PROJECT_ID, 'createCloudProject');
    const response = await fetch(
      `http://127.0.0.1:${String(address.port)}${route.target}`,
      {
        body: JSON.stringify({
          data: {
            idempotencyKey: 'create_key',
            managerDisplayName: 'Initial Manager',
            projectId: PROJECT_ID,
            projectName: 'Cloud Route Project',
          },
          protocolVersion: 6,
          requestId: 'route_request',
        }),
        headers: {
          'content-type': 'application/json',
          'x-claudian-development-actor': 'must-not-be-read',
        },
        method: route.method,
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      decodeCollabCloudSuccessEnvelope(await response.json()).data,
      responseValue,
    );
    assert.equal(calls.length, 1);
    const call = calls[0] as {
      readonly principal: Readonly<Record<string, unknown>>;
      readonly request: Readonly<Record<string, unknown>>;
      readonly signal: AbortSignal;
    };
    assert.deepEqual(call.principal, {
      principalId: 'principal_route',
      provenance: {
        kind: 'operator-protected-channel',
        providerId: 'test-provider',
      },
    });
    assert.equal(call.request.projectId, PROJECT_ID);
    assert.equal(call.signal.aborted, false);
  });

  it('dispatches invitation and Join operations only to their owning controllers', async () => {
    const operations: string[] = [];
    const offer = {
      acknowledgedAt: null,
      expiresAt: '2026-08-31T01:02:03.000Z',
      managerSetGenerationAtOffer: 1,
      offeredAt: TIMESTAMP,
      offerId: 'offer-route',
      purpose: 'manager-promotion' as const,
      revision: 1,
      sourceManagerMemberId: 'member-manager',
      state: 'offered' as const,
      targetMemberId: 'member-target',
      targetMembershipRevisionAtOffer: 2,
      terminalAt: null,
    };
    const routes = new CloudProjectMembershipRoutes({
      administration: {
        acknowledgeOffer: () => {
          operations.push('acknowledgeManagerResponsibility');
          return Promise.resolve({ offer });
        },
        cancelOffer: () => {
          operations.push('cancelManagerResponsibilityOffer');
          return Promise.resolve({ offer });
        },
        createOffer: () => {
          operations.push('createManagerResponsibilityOffer');
          return Promise.resolve({ offer });
        },
        declineOffer: () => {
          operations.push('declineManagerResponsibility');
          return Promise.resolve({ offer });
        },
        demote: () => {
          operations.push('demoteManager');
          return Promise.resolve({
            demotedMemberId: 'member-target',
            managerSetGeneration: 2,
            membershipRevision: 3,
            projectId: PROJECT_ID,
          });
        },
        getOffer: () => {
          operations.push('getManagerResponsibilityOffer');
          return Promise.resolve({ offer });
        },
        listMembers: () => {
          operations.push('listProjectMembers');
          return Promise.resolve({
            managerSetGeneration: 1,
            members: [{
              bindingState: 'unbound' as const,
              displayName: 'Target',
              importedClaimState: 'not-applicable' as const,
              memberId: 'member-target',
              membershipRevision: 2,
              role: 'member' as const,
            }],
            projectId: PROJECT_ID,
          });
        },
        listOffers: () => {
          operations.push('listCurrentManagerResponsibilityOffers');
          return Promise.resolve({ offers: [offer], projectId: PROJECT_ID });
        },
        promote: () => {
          operations.push('promoteManager');
          return Promise.resolve({
            managerSetGeneration: 2,
            membershipRevision: 3,
            offerRevision: 2,
            projectId: PROJECT_ID,
            promotedMemberId: 'member-target',
          });
        },
      },
      claims: {
        reissue: () => {
          operations.push('reissueTransferredMembershipClaim');
          return Promise.resolve({
            claim: Buffer.alloc(32, 6).toString('base64url'),
            claimGeneration: 1,
            createdAt: TIMESTAMP,
            expiresAt: '2026-09-29T01:02:03.000Z',
            memberId: 'member-target',
            projectId: PROJECT_ID,
            secretReplayExpiresAt: '2026-09-29T01:02:03.000Z',
          });
        },
        revoke: () => {
          operations.push('revokeTransferredMembershipClaim');
          return Promise.resolve({
            claimGeneration: 1,
            memberId: 'member-target',
            projectId: PROJECT_ID,
            revokedAt: TIMESTAMP,
            state: 'revoked' as const,
          });
        },
      },
      creation: { create: () => { throw new Error('unused'); } },
      invitation: {
        create: (_principal, request) => {
          operations.push('createProjectInvitation');
          return Promise.resolve({
            createdAt: TIMESTAMP,
            expiresAt: '2026-08-31T01:02:03.000Z',
            invitationId: 'invitation-route',
            issuedState: 'active' as const,
            projectId: request.projectId,
            secret: Buffer.alloc(32, 7).toString('base64url'),
            secretReplayExpiresAt: '2026-09-29T01:02:03.000Z',
          });
        },
        list: (_principal, request) => {
          operations.push('listProjectInvitations');
          return Promise.resolve({
            invitations: [],
            managerSetGeneration: 1,
            projectId: request.projectId,
          });
        },
        revoke: (_principal, request) => {
          operations.push('revokeProjectInvitation');
          return Promise.resolve({
            invitationId: request.invitationId,
            projectId: request.projectId,
            revision: 2,
            revokedAt: TIMESTAMP,
            state: 'revoked' as const,
          });
        },
      },
      join: {
        join: (_principal, request) => {
          operations.push('joinCloudProject');
          return Promise.resolve({
            joinedAt: TIMESTAMP,
            mainOid: MAIN,
            managerSetGeneration: 1,
            memberId: 'member-joined',
            membershipRevision: 2 as const,
            personalRef: 'refs/heads/members/member-joined',
            projectId: request.projectId,
            role: 'member' as const,
          });
        },
      },
      removal: {
        remove: (_principal, request) => {
          operations.push('removeMember');
          return Promise.resolve({
            discardedRequestId: null,
            managerSetGeneration: 1,
            memberId: request.targetMemberId,
            projectId: request.projectId,
            removedAt: TIMESTAMP,
            status: 'revoked' as const,
          });
        },
      },
      leave: {
        leave: (_principal, request) => {
          operations.push('leaveProject');
          return Promise.resolve({
            discardedRequestId: null,
            leftAt: TIMESTAMP,
            managerSetGeneration: 1,
            memberId: 'member-route',
            projectId: request.projectId,
            promotedSuccessorMemberId: null,
            status: 'left' as const,
          });
        },
      },
      maximumJsonBytes: 64 * 1024,
      operationTimeoutMs: 2_000,
      trustedPrincipal: {
        establishedAssertion: () => ({
          principalId: 'principal_route',
          provenance: { kind: 'operator-protected-channel', providerId: 'test-provider' },
        }),
        provider: new TrustedPrincipalProvider(),
      },
    });
    const server = createServer((request, response) => {
      if (!routes.handle(request, response)) {
        response.writeHead(404);
        response.end();
      }
    });
    servers.add(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${String(address.port)}`;
    const requests = [
      ['createProjectInvitation', {
        expectedManagerSetGeneration: 1,
        idempotencyKey: 'invite-route-key',
        projectId: PROJECT_ID,
      }],
      ['listProjectInvitations', { projectId: PROJECT_ID }],
      ['revokeProjectInvitation', {
        expectedInvitationRevision: 1,
        expectedManagerSetGeneration: 1,
        idempotencyKey: 'revoke-route-key',
        invitationId: 'invitation-route',
        projectId: PROJECT_ID,
      }],
      ['joinCloudProject', {
        displayName: 'Joined member',
        idempotencyKey: 'join-route-key',
        invitationId: 'invitation-route',
        projectId: PROJECT_ID,
        secret: Buffer.alloc(32, 7).toString('base64url'),
      }],
      ['listProjectMembers', { projectId: PROJECT_ID }],
      ['reissueTransferredMembershipClaim', {
        expectedClaimGeneration: 0,
        expectedManagerSetGeneration: 1,
        expectedMembershipRevision: 2,
        idempotencyKey: 'reissue-route-key',
        memberId: 'member-target',
        projectId: PROJECT_ID,
      }],
      ['revokeTransferredMembershipClaim', {
        expectedClaimGeneration: 1,
        expectedManagerSetGeneration: 1,
        expectedMembershipRevision: 2,
        idempotencyKey: 'revoke-claim-route-key',
        memberId: 'member-target',
        projectId: PROJECT_ID,
      }],
      ['createManagerResponsibilityOffer', {
        expectedManagerSetGeneration: 1,
        expectedTargetMembershipRevision: 2,
        idempotencyKey: 'create-offer-route-key',
        projectId: PROJECT_ID,
        purpose: 'manager-promotion',
        targetMemberId: 'member-target',
      }],
      ['listCurrentManagerResponsibilityOffers', { projectId: PROJECT_ID }],
      ['getManagerResponsibilityOffer', {
        offerId: 'offer-route',
        projectId: PROJECT_ID,
      }],
      ['acknowledgeManagerResponsibility', {
        expectedOfferRevision: 1,
        idempotencyKey: 'ack-offer-route-key',
        offerId: 'offer-route',
        projectId: PROJECT_ID,
      }],
      ['declineManagerResponsibility', {
        expectedOfferRevision: 1,
        idempotencyKey: 'decline-offer-route-key',
        offerId: 'offer-route',
        projectId: PROJECT_ID,
      }],
      ['cancelManagerResponsibilityOffer', {
        expectedOfferRevision: 1,
        idempotencyKey: 'cancel-offer-route-key',
        offerId: 'offer-route',
        projectId: PROJECT_ID,
      }],
      ['promoteManager', {
        expectedManagerSetGeneration: 1,
        expectedOfferRevision: 2,
        expectedTargetMembershipRevision: 2,
        idempotencyKey: 'promote-route-key',
        managerResponsibilityOfferId: 'offer-route',
        projectId: PROJECT_ID,
        targetMemberId: 'member-target',
      }],
      ['demoteManager', {
        expectedManagerSetGeneration: 1,
        expectedTargetMembershipRevision: 2,
        idempotencyKey: 'demote-route-key',
        projectId: PROJECT_ID,
        targetMemberId: 'member-target',
      }],
      ['removeMember', {
        expectedManagerSetGeneration: 1,
        expectedTargetMembershipRevision: 2,
        idempotencyKey: 'remove-route-key',
        projectId: PROJECT_ID,
        targetMemberId: 'member-target',
      }],
      ['leaveProject', {
        expectedManagerSetGeneration: 1,
        expectedMembershipRevision: 2,
        expectedOfferRevision: null,
        expectedPersonalRefOid: MAIN,
        idempotencyKey: 'leave-route-key',
        managerResponsibilityOfferId: null,
        projectId: PROJECT_ID,
      }],
    ] as const;
    for (const [operation, data] of requests) {
      const route = collabCloudProjectOperationRoute(PROJECT_ID, operation);
      const response = await fetch(`${base}${route.target}`, {
        body: JSON.stringify({ data, protocolVersion: 6, requestId: `request-${operation}` }),
        headers: { 'content-type': 'application/json' },
        method: route.method,
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(operations, requests.map(([operation]) => operation));
  });
});
