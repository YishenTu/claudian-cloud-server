import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { collabControlOperationCodec } from '@claudian-collab/protocol';
import { it } from 'node:test';

import {
  createTerminalProjectContinuityArtifact,
  decodeTerminalProjectContinuityArtifact,
} from '../../src/environment-maintenance/restore/TerminalProjectContinuityArtifact.js';

it('preserves multiple handoff fences and their return authority after responder expiry', () => {
  const records = [3, 5].map(generation => ({
    kind: 'tombstone' as const,
    recordId: `handoff-${String(generation)}`,
    revision: 1,
    value: {
      authorityGeneration: generation,
      projectId: 'cycle-project',
      resultSha256: 'a'.repeat(64),
      retiredAt: '2026-09-09T01:00:00.000Z',
      terminalExpiresAt: '2026-10-09T01:00:00.000Z',
      terminalOperationId: `handoff-${String(generation)}`,
      terminalOperationKind: 'authority-transfer' as const,
      returnHostMemberId: 'member-host',
      returnPrincipalId: 'principal:host',
      returnAuthorityFingerprint: 'b'.repeat(64),
    },
  }));
  const artifact = createTerminalProjectContinuityArtifact('cycle-project', records);
  const [first, second] = records;
  assert.ok(first && second);
  assert.deepEqual(decodeTerminalProjectContinuityArtifact(artifact.json, { projectId: 'cycle-project', sha256: artifact.sha256 }).records, records);
  assert.throws(() => createTerminalProjectContinuityArtifact('cycle-project', [
    first, { ...second, value: { ...second.value, authorityGeneration: 3 } },
  ]));
  assert.throws(() => createTerminalProjectContinuityArtifact('cycle-project', [
    { ...first, value: { ...first.value, returnHostMemberId: null } },
  ]));
});

it('rejects a later handoff after permanent retirement', () => {
  const records = [3, 5].map(generation => ({
    kind: 'tombstone' as const, recordId: `operation-${String(generation)}`, revision: 1,
    value: {
      authorityGeneration: generation, projectId: 'cycle-project', resultSha256: 'a'.repeat(64),
      retiredAt: '2026-09-09T01:00:00.000Z', terminalExpiresAt: '2026-10-09T01:00:00.000Z',
      terminalOperationId: `operation-${String(generation)}`,
      terminalOperationKind: generation === 3 ? 'retire' as const : 'authority-transfer' as const,
      returnHostMemberId: null, returnPrincipalId: null, returnAuthorityFingerprint: null,
    },
  }));
  assert.throws(() => createTerminalProjectContinuityArtifact('cycle-project', records), /tombstone/u);
});

it('requires each retained responder to match its exact tombstone', () => {
  const responseJson = JSON.stringify(collabControlOperationCodec('retireProject').decodeResponse({
    acknowledgementRequired: true, kind: 'project-retired', projectId: 'cycle-project',
    retiredAt: '2026-09-09T01:00:00.000Z', retirementId: 'retirement-5',
    terminalExpiresAt: '2026-10-09T01:00:00.000Z',
  }));
  const responder = {
    kind: 'terminal-responder' as const, recordId: 'retirement-5', revision: 1,
    value: {
      acknowledgements: [], eligibleMemberIds: [], expiresAt: '2026-10-09T01:00:00.000Z',
      operation: 'retireProject' as const, operationId: 'retirement-5', projectId: 'cycle-project', responseJson,
    },
  };
  const tombstone = {
    kind: 'tombstone' as const, recordId: 'retirement-5', revision: 1,
    value: {
      authorityGeneration: 5, projectId: 'cycle-project',
      resultSha256: createHash('sha256').update(responseJson).digest('hex'),
      retiredAt: '2026-09-09T01:00:00.000Z', terminalExpiresAt: '2026-10-09T01:00:00.000Z',
      terminalOperationId: 'retirement-5', terminalOperationKind: 'retire' as const,
      returnHostMemberId: null, returnPrincipalId: null, returnAuthorityFingerprint: null,
    },
  };
  assert.doesNotThrow(() => createTerminalProjectContinuityArtifact('cycle-project', [responder, tombstone]));
  for (const patch of [
    { resultSha256: 'c'.repeat(64) },
    { terminalExpiresAt: '2026-10-10T01:00:00.000Z' },
    { terminalOperationKind: 'authority-transfer' as const },
  ]) {
    assert.throws(() => createTerminalProjectContinuityArtifact('cycle-project', [
      responder, { ...tombstone, value: { ...tombstone.value, ...patch } },
    ]), /links/u);
  }
});
