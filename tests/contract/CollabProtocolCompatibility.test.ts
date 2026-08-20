import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLLAB_CONTROL_OPERATION_CODECS,
  COLLAB_PROTOCOL_VERSION,
  collabControlOperationCodec,
  decodeCollabProtocolEnvelope,
} from '@claudian/collab-protocol';

const expectedOperations = [
  'acceptRequest',
  'closeTicket',
  'createComment',
  'createTicket',
  'createTicketComment',
  'ensureMyRequest',
  'getRequest',
  'getTicket',
  'listRequestComments',
  'listTicketAcceptedRelations',
  'listTicketComments',
  'listTickets',
  'reopenTicket',
  'updateMyRequestMetadata',
  'updateTicketContent',
] as const;

describe('canonical Collab protocol consumer contract', () => {
  it('loads wire version 3 and the accepted operation inventory from the package root', () => {
    assert.equal(COLLAB_PROTOCOL_VERSION, 3);
    assert.deepEqual(
      Object.keys(COLLAB_CONTROL_OPERATION_CODECS).sort(),
      [...expectedOperations].sort(),
    );
  });

  it('decodes the accepted envelope and rejects unknown envelope fields', () => {
    const accepted = {
      data: { projectId: 'project-a' },
      protocolVersion: 3,
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
});
