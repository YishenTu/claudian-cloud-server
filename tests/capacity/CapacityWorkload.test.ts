import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SINGLE_HOST_CAPACITY_PROFILE,
  createCapacityWorkload,
  digestCapacityWorkload,
  isCapacityOperationEvent,
  type CapacityOperationEvent,
  type CapacityResourceClaims,
} from './CapacityWorkload.js';

const GIBIBYTE = 1024 ** 3;

describe('deterministic single-host capacity workload', () => {
  it('creates the accepted 100-Project workload without retaining seed content', () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'private-project-content-must-not-enter-evidence',
    });

    assert.equal(workload.durationMs, 60 * 60 * 1_000);
    assert.equal(workload.accounts.length, 80);
    assert.equal(workload.projects.length, 100);
    assert.equal(
      workload.projects.reduce((total, project) => total + project.membershipCount, 0),
      240,
    );
    assert.deepEqual(
      [...new Set(workload.projects.flatMap(project => project.memberAccountOrdinals))]
        .sort((left, right) => left - right),
      workload.accounts.map(account => account.ordinal),
    );
    assert.ok(workload.projects.every(project => (
      project.memberAccountOrdinals.length === project.membershipCount
      && new Set(project.memberAccountOrdinals).size === project.membershipCount
    )));
    assert.equal(workload.subscribedProjectOrdinals.length, 50);
    assert.equal(new Set(workload.subscribedProjectOrdinals).size, 50);
    assert.equal(workload.limits.runningGitChildren, 2);
    assert.equal(workload.limits.admittedGitRequests, 6);
    assert.equal(workload.limits.cloneRequests, 1);
    assert.equal(workload.limits.fetchRequests, 3);
    assert.equal(workload.limits.pushRequests, 2);
    assert.equal(workload.limits.controlRequestsInFlight, 32);
    assert.equal(workload.limits.ordinaryPostgresTransactions, 8);
    assert.equal(workload.limits.pinnedProjectLeaseConnections, 2);
    assert.equal(workload.limits.reservedRecoveryConnections, 2);
    assert.equal(workload.limits.perProjectGitReads, 2);
    assert.equal(workload.limits.perProjectQueuedRequests, 4);
    assert.equal(workload.limits.concurrentPublishes, 2);
    assert.equal(workload.limits.concurrentAccepts, 1);
    assert.equal(workload.measurement.resourceSampleIntervalMs, 60_000);
    assert.deepEqual(workload.measurement.projectGitProcessingWindowEndAtMs, [
      30 * 60 * 1_000,
      60 * 60 * 1_000,
    ]);
    assert.deepEqual(workload.measurement.projectStorageSnapshotAtMs, [
      0,
      30 * 60 * 1_000,
      60 * 60 * 1_000,
    ]);

    const repositoryBytes = workload.projects.reduce(
      (total, project) => total + project.repositoryBytes,
      0,
    );
    assert.ok(repositoryBytes >= 6 * GIBIBYTE);
    assert.ok(repositoryBytes <= 20 * GIBIBYTE);

    const serialized = JSON.stringify(workload);
    assert.doesNotMatch(serialized, /private-project-content/i);
    assert.match(workload.seedSha256, /^[0-9a-f]{64}$/);
  });

  it('replays the same ordered plan from one seed and changes it for another seed', () => {
    const first = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'capacity-seed-a',
    });
    const replay = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'capacity-seed-a',
    });
    const different = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'capacity-seed-b',
    });

    assert.equal(digestCapacityWorkload(first), digestCapacityWorkload(replay));
    assert.notEqual(digestCapacityWorkload(first), digestCapacityWorkload(different));
    assert.deepEqual(first.events, replay.events);
    assert.ok(first.events.every((event, index, events) => (
      index === 0 || (events[index - 1]?.atMs ?? Number.POSITIVE_INFINITY) <= event.atMs
    )));
  });

  it('bounds the one-hour and eight-hour workload sizes', () => {
    const oneHour = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'single-host-recovery-workload-v1',
    });
    const soak = createCapacityWorkload({
      scenario: 'eight-hour-soak',
      seed: 'single-host-recovery-workload-v1',
    });

    assert.equal(oneHour.events.length, 2_741);
    assert.equal(soak.events.length, 21_165);
    assert.equal(oneHour.projects.reduce(
      (total, project) => total + project.repositoryBytes,
      0,
    ), 13_086_228_480);
    assert.equal(soak.projects.reduce(
      (total, project) => total + project.repositoryBytes,
      0,
    ), 13_086_228_480);
    assert.equal(oneHour.durationMs, 3_600_000);
    assert.equal(soak.durationMs, 28_800_000);
  });

  it('schedules both transfers, backup interference, restart faults, and a reconnect storm', () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'capacity-interference',
    });

    const lanToCloud = workload.events.find(event => (
      event.kind === 'lan-to-cloud-transfer'
    ));
    const cloudToLan = workload.events.find(event => (
      event.kind === 'cloud-to-lan-transfer'
    ));
    assert.ok(lanToCloud);
    assert.ok(cloudToLan);
    assert.ok(workload.events.some(event => (
      event.kind === 'backup' && event.atMs === lanToCloud.atMs
    )));
    assert.ok(workload.events.some(event => (
      event.kind === 'backup' && event.atMs === cloudToLan.atMs
    )));
    assert.deepEqual(
      workload.events
        .filter(event => event.kind === 'process-restart')
        .map(event => event.interruptedKind)
        .sort(),
      [
        'accept',
        'backup',
        'cloud-to-lan-transfer',
        'git-push',
        'lan-to-cloud-transfer',
        'publish',
      ],
    );
    for (const restart of workload.events.filter(event => (
      event.kind === 'process-restart'
    ))) {
      const interrupted = workload.events.find(event => (
        event.sequence === restart.interruptedSequence
      ));
      assert.ok(interrupted);
      assert.equal(interrupted.kind, restart.interruptedKind);
      assert.equal(interrupted.projectOrdinal, restart.projectOrdinal);
      assert.equal(interrupted.trafficClass, 'fault-injection');
      assert.ok(interrupted.atMs < restart.atMs);
      assert.ok(workload.events.some(event => (
        event.kind === 'recovery-verification'
        && event.projectOrdinal === restart.projectOrdinal
        && event.atMs > restart.atMs
        && event.atMs <= restart.atMs + 5_000
      )));
    }

    const reconnects = workload.events.filter(event => event.kind === 'reconnect');
    assert.equal(reconnects.length, 50);
    assert.equal(new Set(reconnects.map(event => event.atMs)).size, 1);
    assert.deepEqual(
      reconnects.map(event => event.projectOrdinal).sort((left, right) => left - right),
      [...workload.subscribedProjectOrdinals].sort((left, right) => left - right),
    );
  });

  it('holds the complete accepted ceiling probe through an exact sample event', () => {
    const workload = createCapacityWorkload({
      scenario: 'one-hour-mixed',
      seed: 'capacity-process-bounds',
    });
    const sample = workload.events.find(event => (
      event.kind === 'resource-sample' && event.probeKind === 'capacity-envelope'
    ));
    assert.ok(sample?.kind === 'resource-sample');
    const children = sample.ceilingProbeSequences.map(sequence => (
      workload.events.find(event => event.sequence === sequence)
    ));
    assert.ok(children.every(child => child?.kind !== 'process-restart'
      && child?.kind !== 'resource-sample'));
    const operations = children.filter((event): event is CapacityOperationEvent => (
      event !== undefined && isCapacityOperationEvent(event)
    ));
    const claimTotal = (key: keyof CapacityResourceClaims): number => operations.reduce(
      (total, event) => (
      total + (event.resourceClaims?.[key] ?? 0)
      ),
      0,
    );
    assert.equal(sample.atMs, workload.durationMs / 2);
    assert.equal(operations.length, 41);
    assert.equal(operations.filter(event => event.kind === 'control-read').length, 32);
    assert.equal(claimTotal('controlRequests'), workload.limits.controlRequestsInFlight);
    assert.equal(
      claimTotal('ordinaryPostgresTransactions'),
      workload.limits.ordinaryPostgresTransactions,
    );
    assert.equal(claimTotal('admittedGitRequests'), workload.limits.admittedGitRequests);
    assert.equal(claimTotal('cloneRequests'), workload.limits.cloneRequests);
    assert.equal(claimTotal('fetchRequests'), workload.limits.fetchRequests);
    assert.equal(claimTotal('pushRequests'), workload.limits.pushRequests);
    assert.equal(claimTotal('gitChildren'), workload.limits.runningGitChildren);
    assert.equal(
      operations.reduce((total, event) => total + event.gitChildCount, 0),
      9,
    );
    assert.equal(claimTotal('perProjectGitReads'), workload.limits.perProjectGitReads);
    assert.equal(
      claimTotal('perProjectQueuedRequests'),
      workload.limits.perProjectQueuedRequests,
    );
    const perProjectClaimOperations = operations.filter(event => (
      (event.resourceClaims?.perProjectGitReads ?? 0) > 0
      || (event.resourceClaims?.perProjectQueuedRequests ?? 0) > 0
    ));
    assert.equal(
      new Set(perProjectClaimOperations.map(event => event.projectOrdinal)).size,
      1,
    );
    assert.equal(claimTotal('publishes'), workload.limits.concurrentPublishes);
    assert.equal(claimTotal('accepts'), workload.limits.concurrentAccepts);
    assert.ok(operations.every(event => (
      event.atMs === sample.atMs
      && event.sequence < sample.sequence
      && !event.overloadProbe
      && event.trafficClass === 'ordinary'
    )));
    const overload = workload.events.find(event => (
      event.kind === 'control-read'
      && event.atMs === sample.atMs
      && event.overloadProbe
    ));
    assert.ok(overload?.kind === 'control-read');
    assert.equal(overload.resourceClaims, null);
    const subscriptionSample = workload.events.find(event => (
      event.kind === 'resource-sample' && event.probeKind === 'subscription-storm'
    ));
    assert.ok(subscriptionSample?.kind === 'resource-sample');
    assert.equal(subscriptionSample.ceilingProbeSequences.length, 50);
    assert.deepEqual(
      workload.events
        .filter(event => event.kind === 'resource-sample')
        .map(event => event.atMs),
      Array.from(
        { length: workload.durationMs / 60_000 + 1 },
        (_, index) => index * 60_000,
      ),
    );
  });

  it('generates the accepted eight-hour soak from the same fixed profile', () => {
    const workload = createCapacityWorkload({
      scenario: 'eight-hour-soak',
      seed: 'capacity-soak',
    });

    assert.equal(workload.durationMs, 8 * 60 * 60 * 1_000);
    assert.equal(workload.profile, SINGLE_HOST_CAPACITY_PROFILE.profile);
    assert.equal(workload.projects.length, SINGLE_HOST_CAPACITY_PROFILE.projects);
    assert.ok(workload.events.length > 10_000);
    const lastEvent = workload.events.at(-1);
    assert.ok(lastEvent);
    assert.equal(lastEvent.atMs, workload.durationMs);
    assert.equal(lastEvent.kind, 'resource-sample');
  });
});
