import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CollabError } from '@claudian-collab/protocol';

import {
  CloudLifecycleControlAdapter,
} from '../../src/server/control/CloudLifecycleControl.js';
import { LanToCloudTransferCoordinatorError } from '../../src/project-authority/lifecycle/lan-to-cloud/LanToCloudTransferCoordinator.js';
import { RetireCoordinatorError } from '../../src/project-authority/lifecycle/retire/RetireCoordinator.js';

const PROJECT_ID = 'project-lifecycle-control';
const TRANSFER_ID = 'transfer-lifecycle-control';
const EXPIRES_AT = '2026-09-27T00:00:00.000Z';

function coordinator(methods: Readonly<Record<string, (...args: never[]) => unknown>>): never {
  return methods as never;
}

function adapter(calls: string[]) {
  return new CloudLifecycleControlAdapter({
    cloudToLan: coordinator({
      acceptTarget: () => calls.push('cloud.acceptTarget'),
      acknowledgeRedemption: () => calls.push('cloud.acknowledgeRedemption'),
      begin: () => calls.push('cloud.begin'),
      confirmTargetActive: () => calls.push('cloud.confirmTargetActive'),
      getClaim: () => calls.push('cloud.getClaim'),
      reportTargetStaged: () => calls.push('cloud.reportTargetStaged'),
    }),
    expiresAtFactory: () => EXPIRES_AT,
    lanToCloud: coordinator({
      acknowledgeClaimBatch: () => calls.push('lan.acknowledgeClaimBatch'),
      begin: () => calls.push('lan.begin'),
      claimMembership: () => calls.push('lan.claimMembership'),
      commitRelinquishment: () => calls.push('lan.commitRelinquishment'),
      rotateClaims: () => calls.push('lan.rotateClaims'),
    }),
    retire: coordinator({
      acknowledge: () => calls.push('retire.acknowledge'),
      retire: () => calls.push('retire.retire'),
    }),
    transfer: coordinator({
      cancel: () => calls.push('transfer.cancel'),
      getStatus: () => calls.push('transfer.getStatus'),
    }),
  });
}

function context(request: unknown) {
  return {
    principalId: 'member-manager',
    request,
    signal: new AbortController().signal,
  } as never;
}

describe('CloudLifecycleControlAdapter', () => {
  it('dispatches direction-specific and terminal operations to their exact owners', async () => {
    const calls: string[] = [];
    const control = adapter(calls);
    await control.execute('beginLanToCloudTransfer', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('rotateTransferredMembershipClaims', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('acknowledgeTransferredMembershipClaimBatch', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('claimTransferredMembership', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('commitLanToCloudRelinquishment', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('beginCloudToLanTransfer', context({ projectId: PROJECT_ID }));
    await control.execute('acceptCloudToLanTransferTarget', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('reportCloudToLanTargetStaged', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('confirmCloudToLanTargetActive', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('getTransferredMembershipClaim', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('acknowledgeTransferredMembershipClaimRedemption', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('getProjectAuthorityTransfer', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('cancelProjectAuthorityTransfer', context({
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    }));
    await control.execute('retireProject', context({ projectId: PROJECT_ID }));
    await control.execute('acknowledgeProjectRetirement', context({
      projectId: PROJECT_ID,
    }));

    assert.deepEqual(calls, [
      'lan.begin',
      'lan.rotateClaims',
      'lan.acknowledgeClaimBatch',
      'lan.claimMembership',
      'lan.commitRelinquishment',
      'cloud.begin',
      'cloud.acceptTarget',
      'cloud.reportTargetStaged',
      'cloud.confirmTargetActive',
      'cloud.getClaim',
      'cloud.acknowledgeRedemption',
      'transfer.getStatus',
      'transfer.cancel',
      'retire.retire',
      'retire.acknowledge',
    ]);
  });

  it('passes the trusted principal and configured expiry to begin', async () => {
    let observed: unknown;
    const control = new CloudLifecycleControlAdapter({
      cloudToLan: coordinator({}),
      expiresAtFactory: () => EXPIRES_AT,
      lanToCloud: coordinator({
        begin: (input: never) => {
          observed = input;
          return undefined;
        },
      }),
      retire: coordinator({}),
      transfer: coordinator({}),
    });
    const request = { projectId: PROJECT_ID, transferId: TRANSFER_ID };
    await control.execute('beginLanToCloudTransfer', context(request));
    assert.deepEqual(observed, {
      expiresAt: EXPIRES_AT,
      principalId: 'member-manager',
      request,
    });
  });

  it('maps owner failures to safe package errors', async () => {
    const control = new CloudLifecycleControlAdapter({
      cloudToLan: coordinator({}),
      expiresAtFactory: () => EXPIRES_AT,
      lanToCloud: coordinator({}),
      retire: coordinator({}),
      transfer: coordinator({
        getStatus: () => {
          throw new LanToCloudTransferCoordinatorError('state-conflict');
        },
      }),
    });
    await assert.rejects(
      control.execute('getProjectAuthorityTransfer', context({
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      })),
      (error: unknown) => (
        error instanceof CollabError
        && error.code === 'authority-transfer-stale'
        && !JSON.stringify(error).includes('state-conflict')
      ),
    );
  });

  it('does not enter an owner after request cancellation', async () => {
    let invoked = false;
    const control = new CloudLifecycleControlAdapter({
      cloudToLan: coordinator({}),
      expiresAtFactory: () => EXPIRES_AT,
      lanToCloud: coordinator({}),
      retire: coordinator({}),
      transfer: coordinator({
        getStatus: () => {
          invoked = true;
        },
      }),
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(control.execute('getProjectAuthorityTransfer', {
      principalId: 'member-manager',
      request: { projectId: PROJECT_ID, transferId: TRANSFER_ID },
      signal: controller.signal,
    }), (error: unknown) => (
      error instanceof CollabError && error.code === 'operation-timeout'
    ));
    assert.equal(invoked, false);
  });

  it('maps retirement expiry to the retirement terminal error', async () => {
    const control = new CloudLifecycleControlAdapter({
      cloudToLan: coordinator({}),
      expiresAtFactory: () => EXPIRES_AT,
      lanToCloud: coordinator({}),
      retire: coordinator({
        acknowledge: () => Promise.reject(new RetireCoordinatorError('expired')),
      }),
      transfer: coordinator({}),
    });

    await assert.rejects(
      control.execute('acknowledgeProjectRetirement', context({
        idempotencyKey: 'acknowledge-retirement-expiry',
        projectId: PROJECT_ID,
        retirementId: 'retire-lifecycle-control',
      })),
      (error: unknown) => (
        error instanceof CollabError && error.code === 'project-retired'
      ),
    );
  });
});
