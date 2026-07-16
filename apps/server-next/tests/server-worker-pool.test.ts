import { describe, expect, test } from 'vitest';

import type { ManagementWorkerRegisterV2 } from '../../../packages/contracts/src/index.js';
import { createServerWorkerPool } from '../src/application/management/server-worker-pool.js';

describe('Phase 4 Server Worker Pool', () => {
  test('keeps Worker identity stable across reconnect and rejects stale connections', () => {
    const harness = createHarness();
    const first = harness.pool.registerWorker({ connectionId: 'connection-1', capability: capability() });
    const reconnected = harness.pool.registerWorker({ connectionId: 'connection-2', capability: capability() });
    expect(first).toMatchObject({ ok: true, workerId: expect.any(String) });
    expect(reconnected).toMatchObject({ ok: true, workerId: (first as { workerId: string }).workerId });

    expect(harness.pool.disconnect('connection-1')).toEqual({ activeManagementRunIds: [] });
    expect(harness.pool.heartbeat({
      connectionId: 'connection-1', workerInstanceId: 'server-instance-1', activeLeaseCount: 0,
    })).toMatchObject({ ok: false, diagnosticCode: 'SERVER_WORKER_CONNECTION_STALE' });
    expect(harness.pool.heartbeat({
      connectionId: 'connection-2', workerInstanceId: 'server-instance-1', activeLeaseCount: 0,
    })).toMatchObject({ ok: true, connected: true, lastHeartbeatAt: 10 });
    expect(harness.pool.snapshot().workers).toMatchObject([{
      workerId: (first as { workerId: string }).workerId,
      workerPoolId: 'pool-1', profileId: 'profile-1', connected: true,
      runtimeVersion: '0.1.0', supportedProtocolVersions: [1, 2], supportedPhases: [1, 2, 3],
      providerCredentialRef: 'provider-credential-default',
      capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
    }]);
  });

  test('fails closed for pool, credential reference, readiness, and capacity drift', () => {
    const harness = createHarness();
    expect(harness.pool.registerWorker({
      connectionId: 'wrong-pool',
      capability: capability({ host: { kind: 'server', workerPoolId: 'pool-other' } }),
    })).toMatchObject({ ok: false, diagnosticCode: 'SERVER_WORKER_POOL_MISMATCH' });
    expect(harness.pool.registerWorker({
      connectionId: 'wrong-credential',
      capability: capability({ providerCredentialRef: 'credential-other' }),
    })).toMatchObject({ ok: false, diagnosticCode: 'SERVER_WORKER_CREDENTIAL_REFERENCE_MISMATCH' });
    expect(harness.pool.registerWorker({
      connectionId: 'unavailable',
      capability: capability({ credentialStatus: 'unavailable', providerId: undefined, modelId: undefined }),
    })).toMatchObject({ ok: false, errorCode: 'UNAVAILABLE', diagnosticCode: 'SERVER_WORKER_CREDENTIAL_UNAVAILABLE' });
    expect(harness.pool.registerWorker({
      connectionId: 'capacity-drift',
      capability: capability({ capacity: { maxConcurrentLeases: 1, activeLeaseCount: 2 } }),
    })).toMatchObject({ ok: false, diagnosticCode: 'SERVER_WORKER_CAPABILITY_INVALID' });
    expect(harness.pool.registerWorker({ connectionId: 'stable-capacity', capability: capability() }))
      .toMatchObject({ ok: true });
    expect(harness.pool.registerWorker({
      connectionId: 'changed-capacity',
      capability: capability({ capacity: { maxConcurrentLeases: 2, activeLeaseCount: 0 } }),
    })).toMatchObject({ ok: false, diagnosticCode: 'SERVER_WORKER_FIXED_CAPACITY_MISMATCH' });
    expect(JSON.stringify(harness.pool.snapshot()))
      .not.toMatch(/"(?:apiKey|providerSecret|shell|cwd|browser|filesystem)"/i);
  });

  test('expires a Worker that stops heartbeating before assigning new capacity', () => {
    const harness = createHarness();
    const registered = harness.pool.registerWorker({ connectionId: 'connection-1', capability: capability() });
    expect(registered).toMatchObject({ ok: true });
    harness.clock.now = 41;

    expect(harness.pool.expireStaleWorkers()).toEqual([(registered as { workerId: string }).workerId]);
    expect(harness.pool.requestCapacity({
      managementRunId: 'run-stale', teamId: 'team-1', profileId: 'profile-1',
    })).toMatchObject({ kind: 'queued', reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED' });
    expect(harness.pool.snapshot().workers).toMatchObject([{ connected: false }]);
  });

  test('requeues reservations when their Worker heartbeat expires', () => {
    const harness = createHarness();
    const registered = harness.pool.registerWorker({ connectionId: 'connection-1', capability: capability() });
    const workerId = (registered as { workerId: string }).workerId;
    expect(harness.pool.requestCapacity({
      managementRunId: 'run-expired', teamId: 'team-1', profileId: 'profile-1',
    })).toMatchObject({ kind: 'assigned', workerId });
    harness.clock.now = 41;

    expect(harness.pool.expireStaleWorkers()).toEqual([workerId]);
    expect(harness.pool.snapshot().queue).toEqual([{
      managementRunId: 'run-expired', teamId: 'team-1', profileId: 'profile-1',
      enqueuedAt: 41, reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED',
    }]);
    expect(harness.pool.requestCapacity({
      managementRunId: 'run-expired', teamId: 'team-1', profileId: 'profile-1',
    })).toMatchObject({ kind: 'queued', managementRunId: 'run-expired' });
  });

  test('requeues reservations on disconnect and allows cancellation to remove the stale queue entry', () => {
    const harness = createHarness();
    const registered = harness.pool.registerWorker({ connectionId: 'connection-1', capability: capability() });
    const workerId = (registered as { workerId: string }).workerId;
    harness.pool.requestCapacity({
      managementRunId: 'run-disconnected', teamId: 'team-1', profileId: 'profile-1',
    });

    expect(harness.pool.disconnect('connection-1')).toEqual({
      workerId,
      activeManagementRunIds: ['run-disconnected'],
    });
    expect(harness.pool.snapshot().queue).toMatchObject([{ managementRunId: 'run-disconnected' }]);
    expect(harness.pool.releaseCapacity({ workerId, managementRunId: 'run-disconnected' }))
      .toEqual({ released: true });
    expect(harness.pool.snapshot().queue).toEqual([]);
  });

  test('adds reported remote load to new local reservations', () => {
    const harness = createHarness();
    harness.pool.registerWorker({
      connectionId: 'connection-1',
      capability: capability({ capacity: { maxConcurrentLeases: 2, activeLeaseCount: 1 } }),
    });

    expect(harness.pool.requestCapacity({
      managementRunId: 'run-1', teamId: 'team-1', profileId: 'profile-1',
    })).toMatchObject({ kind: 'assigned' });
    expect(harness.pool.requestCapacity({
      managementRunId: 'run-2', teamId: 'team-1', profileId: 'profile-1',
    })).toMatchObject({ kind: 'queued', reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED' });
    expect(harness.pool.snapshot().workers).toMatchObject([{
      capacity: { maxConcurrentLeases: 2, activeLeaseCount: 2 },
    }]);
  });

  test('keeps delimiter-containing Worker identities distinct', () => {
    const harness = createHarness();
    const first = harness.pool.registerWorker({
      connectionId: 'connection-1',
      capability: capability({ profileId: 'a', workerInstanceId: 'b|c' }),
    });
    const second = harness.pool.registerWorker({
      connectionId: 'connection-2',
      capability: capability({ profileId: 'a|b', workerInstanceId: 'c' }),
    });

    expect(first).toMatchObject({ ok: true, workerId: expect.any(String) });
    expect(second).toMatchObject({ ok: true, workerId: expect.any(String) });
    expect((second as { workerId: string }).workerId).not.toBe((first as { workerId: string }).workerId);
    expect(harness.pool.snapshot().workers).toHaveLength(2);
  });

  test('queues capacity overflow visibly and assigns it after a fixed slot is released', () => {
    const harness = createHarness();
    const registration = harness.pool.registerWorker({
      connectionId: 'connection-1', capability: capability({ capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 } }),
    });
    expect(registration).toMatchObject({ ok: true });
    const workerId = (registration as { workerId: string }).workerId;

    expect(harness.pool.requestCapacity({
      managementRunId: 'run-1', teamId: 'team-1', profileId: 'profile-1',
    })).toEqual({ kind: 'assigned', managementRunId: 'run-1', workerId, workerPoolId: 'pool-1', profileId: 'profile-1' });
    expect(harness.pool.requestCapacity({
      managementRunId: 'run-2', teamId: 'team-1', profileId: 'profile-1',
    })).toMatchObject({ kind: 'queued', managementRunId: 'run-2', reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED' });
    expect(harness.pool.snapshot().queue).toEqual([{
      managementRunId: 'run-2', teamId: 'team-1', profileId: 'profile-1',
      enqueuedAt: 10, reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED',
    }]);

    expect(harness.pool.releaseCapacity({ workerId, managementRunId: 'run-1' })).toEqual({ released: true });
    expect(harness.pool.requestCapacity({
      managementRunId: 'run-2', teamId: 'team-1', profileId: 'profile-1',
    })).toEqual({ kind: 'assigned', managementRunId: 'run-2', workerId, workerPoolId: 'pool-1', profileId: 'profile-1' });
    expect(harness.pool.snapshot().queue).toEqual([]);
  });
});

function capability(overrides: Partial<ManagementWorkerRegisterV2> = {}): ManagementWorkerRegisterV2 {
  return {
    schemaVersion: 2,
    workerInstanceId: 'server-instance-1',
    profileId: 'profile-1',
    runtimeVersion: '0.1.0',
    supportedProtocolVersions: [1, 2],
    supportedPhases: [1, 2, 3],
    credentialStatus: 'production_ready',
    providerId: 'provider-1',
    modelId: 'model-1',
    host: { kind: 'server', workerPoolId: 'pool-1' },
    providerCredentialRef: 'provider-credential-default',
    capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
    ...overrides,
  };
}

function createHarness() {
  let id = 0;
  const clock = { now: 10 };
  return {
    clock,
    pool: createServerWorkerPool({
      workerPoolId: 'pool-1',
      providerCredentialRef: 'provider-credential-default',
      heartbeatTimeoutMs: 30,
      clock: { now: () => clock.now },
      ids: { nextId: () => `server-worker-${++id}` },
    }),
  };
}
