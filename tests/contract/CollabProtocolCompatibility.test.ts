import assert from 'node:assert/strict';
import { glob, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_CLOUD_CAPABILITIES,
  COLLAB_CLOUD_JSON_OPERATIONS,
  COLLAB_CONTROL_OPERATION_CODECS,
  COLLAB_PROTOCOL_VERSION,
  collabCloudCapabilitiesRoute,
  collabCloudCapabilityDocument,
  collabCloudGitRoute,
  collabCloudProjectEventsRoute,
  collabCloudProjectOperationRoute,
  collabControlOperationCodec,
  collabDevelopmentBootstrapRoute,
  decodeCollabCloudCapabilityDocument,
  decodeCollabProtocolEnvelope,
} from '@claudian-collab/protocol';

const expectedOperations = [
  'acceptCloudToLanTransferTarget',
  'acceptLanToCloudTransferTarget',
  'acceptRequest',
  'acknowledgeManagerResponsibility',
  'acknowledgeProjectRetirement',
  'acknowledgeTransferredMembershipClaimBatch',
  'acknowledgeTransferredMembershipClaimRedemption',
  'beginCloudToLanTransfer',
  'beginLanToCloudTransfer',
  'cancelManagerResponsibilityOffer',
  'cancelProjectAuthorityTransfer',
  'claimTransferredMembership',
  'closeTicket',
  'commitLanToCloudRelinquishment',
  'confirmCloudToLanTargetActive',
  'createCloudProject',
  'createComment',
  'createManagerResponsibilityOffer',
  'createProjectInvitation',
  'createTicket',
  'createTicketComment',
  'declineManagerResponsibility',
  'demoteManager',
  'ensureMyRequest',
  'getAuthorityTransferReceiptVerifier',
  'getManagerResponsibilityOffer',
  'getProjectAuthorityTransfer',
  'getRequest',
  'getTicket',
  'getTransferredMembershipClaim',
  'joinCloudProject',
  'leaveProject',
  'listCurrentManagerResponsibilityOffers',
  'listProjectInvitations',
  'listProjectMembers',
  'listRequestComments',
  'listTicketAcceptedRelations',
  'listTicketComments',
  'listTickets',
  'promoteManager',
  'reissueTransferredMembershipClaim',
  'removeMember',
  'reopenTicket',
  'reportCloudToLanTargetStaged',
  'requestLanToCloudTransfer',
  'retireProject',
  'revokeProjectInvitation',
  'revokeTransferredMembershipClaim',
  'rotateTransferredMembershipClaims',
  'updateMyRequestMetadata',
  'updateTicketContent',
] as const;

const repositoryRoot = resolve(import.meta.dirname, '../..');

describe('canonical Collab protocol consumer contract', () => {
  it('loads wire version 6, Cloud binding 2, and one operation inventory from the package root', () => {
    assert.equal(COLLAB_PROTOCOL_VERSION, 6);
    assert.equal(COLLAB_CLOUD_BINDING_VERSION, 2);
    assert.deepEqual(
      Object.keys(COLLAB_CONTROL_OPERATION_CODECS).sort(),
      [...expectedOperations].sort(),
    );
    assert.deepEqual(COLLAB_CLOUD_JSON_OPERATIONS, [
      'getProjectSnapshot',
      ...Object.keys(COLLAB_CONTROL_OPERATION_CODECS),
    ]);
  });

  it('consumes the exact package-owned Cloud routes', () => {
    assert.deepEqual(collabCloudCapabilitiesRoute(), {
      match: { kind: 'capabilities' },
      method: 'GET',
      target: '/collab/capabilities',
    });
    assert.equal(
      collabCloudProjectOperationRoute('project-a', 'getProjectSnapshot').target,
      '/v2/projects/project-a/operations/getProjectSnapshot',
    );
    assert.equal(
      collabCloudProjectEventsRoute('project-a', 12).target,
      '/v2/projects/project-a/events?afterSequence=12',
    );
    assert.equal(
      collabCloudGitRoute('project-a', 'info-refs', 'git-upload-pack').target,
      '/v2/projects/project-a/repository.git/info/refs?service=git-upload-pack',
    );
    assert.equal(
      collabDevelopmentBootstrapRoute('activateDevelopmentBootstrap', 'attempt-a').target,
      '/v2/development/bootstrap/attempts/attempt-a/activate',
    );
  });

  it('builds the exact capability document and fails closed on incompatible versions', () => {
    const limits = {
      maxCheckpointCoordinationBytes:
        COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
      maxCheckpointManifestUtf8Bytes:
        COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
      maxCheckpointRepositoryBundleBytes:
        COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
      maxCheckpointStagingBytes:
        COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
      maxDevelopmentBootstrapGitBundleBytes: 1024 * 1024 * 1024,
      maxDevelopmentBootstrapManifestUtf8Bytes: 64 * 1024,
      maxDevelopmentBootstrapReportUtf8Bytes: 64 * 1024,
      maxEventReplay: 500,
      maxGitReceivePackBytes: 256 * 1024 * 1024,
      maxJsonPayloadUtf8Bytes: 512 * 1024,
      maxRepositoryBytes: 1024 * 1024 * 1024,
    };
    const document = collabCloudCapabilityDocument(
      [...COLLAB_CLOUD_CAPABILITIES],
      limits,
    );
    assert.deepEqual(document, {
      bindingVersions: [2],
      capabilities: [...COLLAB_CLOUD_CAPABILITIES],
      limits,
      protocolVersions: [6],
      schemaVersion: 2,
    });
    assert.throws(
      () => decodeCollabCloudCapabilityDocument({
        ...document,
        bindingVersions: [1],
      }),
      (error: unknown) => (
        error instanceof Error
        && error.message === 'collab.error.protocol-version-unsupported'
      ),
    );
    assert.throws(
      () => decodeCollabCloudCapabilityDocument({
        ...document,
        protocolVersions: [4],
      }),
      (error: unknown) => (
        error instanceof Error
        && error.message === 'collab.error.protocol-version-unsupported'
      ),
    );
  });

  it('decodes the accepted envelope and rejects unknown envelope fields', () => {
    const accepted = {
      data: { projectId: 'project-a' },
      protocolVersion: 6,
      requestId: 'request-a',
    };

    assert.deepEqual(decodeCollabProtocolEnvelope(accepted), {
      status: 'ok',
      value: accepted,
    });
    const rejected = decodeCollabProtocolEnvelope({
      ...accepted,
      credential: 'must-not-cross-the-protocol-boundary',
    });
    assert.equal(rejected.status, 'invalid');
    assert.equal(rejected.error.code, 'protocol-payload-invalid');
    assert.deepEqual(rejected.error.safeContext, { field: 'envelope' });
  });

  it('uses the canonical operation decoder compatibility behavior', () => {
    const decoded = collabControlOperationCodec('ensureMyRequest').decodeRequest({
      description: 'Ready for review',
      expectedMainOid: '1'.repeat(40),
      headOid: '2'.repeat(40),
      idempotencyKey: 'request-one',
      ingressPrincipal: { accountId: 'attacker-controlled' },
      memberId: 'attacker-controlled',
      projectId: 'project-a',
    });

    assert.deepEqual(decoded, {
      status: 'ok',
      value: {
        description: 'Ready for review',
        expectedMainOid: '1'.repeat(40),
        headOid: '2'.repeat(40),
        idempotencyKey: 'request-one',
        projectId: 'project-a',
      },
    });
    assert.equal(
      collabControlOperationCodec('createTicketComment').decodeRequest({
        body: 'Looks good',
        futureField: true,
        idempotencyKey: 'comment-one',
        projectId: 'project-a',
        ticketId: 'ticket-a',
      }).status,
      'invalid',
    );
  });

  it('keeps production imports at the package root and defines no parallel Cloud routes', async () => {
    for await (const path of glob('src/**/*.ts', { cwd: repositoryRoot })) {
      const source = await readFile(resolve(repositoryRoot, path), 'utf8');
      assert.doesNotMatch(source, /@claudian-collab\/protocol\//u, path);
      assert.doesNotMatch(
        source,
        /['"`]\/(?:collab\/capabilities|v2\/(?:development|projects)\/)/u,
        path,
      );
    }
  });
});
