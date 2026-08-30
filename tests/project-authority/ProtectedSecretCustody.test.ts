import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  ProtectedSecretCustody,
  ProtectedSecretCustodyError,
} from '../../src/project-authority/lifecycle/ProtectedSecretCustody.js';

const KEY = Buffer.alloc(32, 9);
const NONCE = Buffer.from(
  '000000090000004a00000000314159270102030405060708',
  'hex',
);
const SECRET = Buffer.alloc(32, 7).toString('base64url');
const INVITATION_ASSOCIATED_DATA = JSON.stringify({
  envelopeVersion: 1,
  invitationId: 'invitation-one',
  projectId: 'project-custody',
  purpose: 'cloud-project-invitation',
});

function custody(key: Uint8Array = KEY): ProtectedSecretCustody {
  return new ProtectedSecretCustody({
    activeKeyId: 'secret-key-current',
    keys: [{ key, keyId: 'secret-key-current', keyVersion: 3 }],
    nonceFactory: () => NONCE,
  });
}

describe('ProtectedSecretCustody', () => {
  it('seals a domain-bound secret with an independently derived digest', async () => {
    const envelope = await custody().seal({
      associatedData: INVITATION_ASSOCIATED_DATA,
      secret: SECRET,
    });

    assert.deepEqual(envelope, {
      algorithm: 'xchacha20-poly1305',
      associatedDataSha256: createHash('sha256')
        .update(INVITATION_ASSOCIATED_DATA, 'utf8')
        .digest('hex'),
      ciphertext: 'CI4Y1UW9KqmbxmAv6UYa4pA8EBLb4tJfT_hyFeFDhjdDpqPVfgP9K6UzzA',
      keyId: 'secret-key-current',
      keyVersion: 3,
      nonce: NONCE.toString('base64url'),
      tag: 'oz9E8XlZMAqRtq8_K3dcNA',
    });
    assert.equal(JSON.stringify(envelope).includes(SECRET), false);
    assert.equal(await custody().open({
      associatedData: INVITATION_ASSOCIATED_DATA,
      envelope,
    }), SECRET);
  });

  it('fails closed across purpose, key, ciphertext, and nonce boundaries', async () => {
    const envelope = await custody().seal({
      associatedData: INVITATION_ASSOCIATED_DATA,
      secret: SECRET,
    });
    const rejects = (value: Promise<unknown>) => assert.rejects(
      value,
      (error: unknown) => error instanceof ProtectedSecretCustodyError,
    );

    await rejects(custody().open({
      associatedData: INVITATION_ASSOCIATED_DATA.replace('invitation', 'claim'),
      envelope,
    }));
    await rejects(custody(Buffer.alloc(32, 8)).open({
      associatedData: INVITATION_ASSOCIATED_DATA,
      envelope,
    }));
    await rejects(custody().open({
      associatedData: INVITATION_ASSOCIATED_DATA,
      envelope: { ...envelope, ciphertext: 'AA' },
    }));
    await rejects(custody().open({
      associatedData: INVITATION_ASSOCIATED_DATA,
      envelope: { ...envelope, nonce: 'AA' },
    }));
  });
});
