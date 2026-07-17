import { describe, expect, test, vi } from 'vitest';

import type {
  ManagementLeaseOfferV1,
  ManagementWorkerRegisterV2,
} from '../../../packages/contracts/src/index.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createServerWorkerPool } from '../src/application/management/server-worker-pool.js';
import { createServerWorkerScheduler } from '../src/application/management/server-worker-scheduler.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('Phase 4 Server Worker Scheduler', () => {
  test('offers a rooted ManagedRun and completes the Server lease lifecycle', async () => {
    const repositories = createInMemoryRepositories();
    const clock = { now: 10 };
    let id = 0;
    const ids = { nextId: () => `id-${++id}` };
    const kernel = createManagementKernel({
      repositories: repositories.management,
      unitOfWork: repositories.managementUnitOfWork,
      clock: { now: () => clock.now },
      ids,
    });
    const offers: ManagementLeaseOfferV1[] = [];
    const pool = createServerWorkerPool({
      workerPoolId: 'pool-1',
      providerCredentialRef: 'credential-ref-1',
      clock: { now: () => clock.now },
      ids,
    });
    const registered = pool.registerWorker({
      connectionId: 'connection-1',
      capability: capability(),
      transport: {
        async emitLeaseOffer(offer) {
          offers.push(offer);
          return { ok: true };
        },
      },
    });
    expect(registered).toMatchObject({ ok: true, workerId: expect.any(String) });
    const scheduler = createServerWorkerScheduler({
      pool,
      management: repositories.management,
      kernel,
      clock: { now: () => clock.now },
      ids,
      leaseTokens: { nextToken: () => 'lease-token-1' },
    });
    const placementPolicy = {
      placement: 'managed' as const,
      allowServerContext: true,
      requireLocalModelCredentials: false,
    };
    await expect(scheduler.managementPreflight({
      placementPolicy,
      managementPhase: 2,
      targetAvailable: true,
    })).resolves.toMatchObject({
      preflight: {
        workerAvailable: true,
        credentialAvailable: true,
        placementAllowed: true,
        targetAvailable: true,
      },
      profileId: 'profile-1',
    });
    const { run } = await kernel.createOrResumeRun({
      teamId: 'team-1',
      channelId: 'channel-1',
      rootTaskId: 'task-1',
      rootMessageId: 'message-1',
      requestKey: 'request-1',
      requestHash: 'request-hash-1',
      placementPolicy,
      budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
      managementPhase: 2,
    });

    const scheduled = await scheduler.scheduleManagementRun({
      managementRunId: run.id,
      profileId: 'profile-1',
    });
    expect(scheduled).toMatchObject({
      ok: true,
      workerId: (registered as { workerId: string }).workerId,
      workerPoolId: 'pool-1',
    });
    expect(offers).toHaveLength(1);

    const acquired = await scheduler.acquireLease('connection-1', {
      schemaVersion: 1,
      offerId: offers[0]!.offerId,
      workerInstanceId: 'server-instance-1',
    });
    expect(acquired).toMatchObject({ ok: true, leaseToken: 'lease-token-1', fencingToken: 1 });
    if (!acquired.ok) throw new Error('Server lease acquisition expected');
    await expect(repositories.management.leases.get(run.id)).resolves.toMatchObject({
      workerId: acquired.workerId,
      host: { kind: 'server', workerPoolId: 'pool-1', profileId: 'profile-1' },
    });

    clock.now = 20;
    await expect(scheduler.renewLease('connection-1', {
      schemaVersion: 1,
      managementRunId: run.id,
      workerId: acquired.workerId,
      leaseToken: acquired.leaseToken,
      fencingToken: acquired.fencingToken,
      idempotencyKey: 'renew-1',
    })).resolves.toMatchObject({ ok: true, expiresAt: 300_020 });

    clock.now = 30;
    await expect(scheduler.releaseLease('connection-1', {
      schemaVersion: 1,
      managementRunId: run.id,
      workerId: acquired.workerId,
      leaseToken: acquired.leaseToken,
      fencingToken: acquired.fencingToken,
      idempotencyKey: 'release-1',
      reasonCode: 'COMPLETED',
    })).resolves.toMatchObject({ ok: true, releasedAt: 30 });
    expect(pool.snapshot().workers).toMatchObject([{
      capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
    }]);
  });

  test('keeps a managed Run queued when Server capacity is full without a Device fallback', async () => {
    const repositories = createInMemoryRepositories();
    const clock = { now: 10 };
    let id = 0;
    const ids = { nextId: () => `queue-id-${++id}` };
    const kernel = createManagementKernel({
      repositories: repositories.management,
      unitOfWork: repositories.managementUnitOfWork,
      clock: { now: () => clock.now },
      ids,
    });
    const offers: ManagementLeaseOfferV1[] = [];
    const pool = createServerWorkerPool({
      workerPoolId: 'pool-1',
      providerCredentialRef: 'credential-ref-1',
      clock: { now: () => clock.now },
      ids,
    });
    pool.registerWorker({
      connectionId: 'connection-full',
      capability: capability({ capacity: { maxConcurrentLeases: 1, activeLeaseCount: 1 } }),
      transport: { async emitLeaseOffer(offer) { offers.push(offer); return { ok: true }; } },
    });
    const scheduler = createServerWorkerScheduler({
      pool,
      management: repositories.management,
      kernel,
      clock: { now: () => clock.now },
      ids,
      leaseTokens: { nextToken: () => 'unused-token' },
    });
    const placementPolicy = {
      placement: 'managed' as const,
      allowServerContext: true,
      requireLocalModelCredentials: false,
    };
    await expect(scheduler.managementPreflight({
      placementPolicy,
      managementPhase: 2,
      targetAvailable: true,
    })).resolves.toMatchObject({ preflight: { workerAvailable: true }, profileId: 'profile-1' });
    const { run } = await kernel.createOrResumeRun({
      teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'task-queued', rootMessageId: 'message-queued',
      requestKey: 'request-queued', requestHash: 'hash-queued', placementPolicy,
      budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 }, managementPhase: 2,
    });

    await expect(scheduler.scheduleManagementRun({
      managementRunId: run.id,
      profileId: 'profile-1',
    })).resolves.toMatchObject({
      ok: false,
      diagnosticCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED',
      retryable: true,
    });
    expect(offers).toEqual([]);
    expect(pool.snapshot().queue).toMatchObject([{
      managementRunId: run.id,
      teamId: 'team-1',
      profileId: 'profile-1',
      reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED',
    }]);
  });

  test('offers the oldest queued Run when a Server lease releases capacity', async () => {
    const harness = await createSchedulerHarness();
    const firstRun = await harness.createRun('first');
    const secondRun = await harness.createRun('second');

    await harness.scheduler.scheduleManagementRun({ managementRunId: firstRun.id, profileId: 'profile-1' });
    const acquired = await harness.scheduler.acquireLease('connection-1', {
      schemaVersion: 1,
      offerId: harness.offers[0]!.offerId,
      workerInstanceId: 'server-instance-1',
    });
    if (!acquired.ok) throw new Error('Server lease acquisition expected');

    await expect(harness.scheduler.scheduleManagementRun({
      managementRunId: secondRun.id,
      profileId: 'profile-1',
    })).resolves.toMatchObject({ diagnosticCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED' });

    await harness.scheduler.releaseLease('connection-1', {
      schemaVersion: 1,
      managementRunId: firstRun.id,
      workerId: acquired.workerId,
      leaseToken: acquired.leaseToken,
      fencingToken: acquired.fencingToken,
      idempotencyKey: 'release-first',
      reasonCode: 'COMPLETED',
    });

    expect(harness.offers).toHaveLength(2);
    expect(harness.offers[1]).toMatchObject({ managementRunId: secondRun.id });
    expect(harness.pool.snapshot().queue).toEqual([]);
  });

  test('actively expires an unacquired offer, releases capacity, and retries the Run', async () => {
    vi.useFakeTimers();
    try {
      const harness = await createSchedulerHarness({ offerTimeoutMs: 100 });
      const run = await harness.createRun('expires');

      await harness.scheduler.scheduleManagementRun({ managementRunId: run.id, profileId: 'profile-1' });
      expect(harness.offers).toHaveLength(1);

      harness.clock.now = 111;
      await vi.advanceTimersByTimeAsync(100);

      expect(harness.offers).toHaveLength(2);
      expect(harness.offers[1]).toMatchObject({ managementRunId: run.id });
      expect(harness.offers[1]!.offerId).not.toBe(harness.offers[0]!.offerId);
      await harness.scheduler.acquireLease('connection-1', {
        schemaVersion: 1,
        offerId: harness.offers[1]!.offerId,
        workerInstanceId: 'server-instance-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

async function createSchedulerHarness(options: { offerTimeoutMs?: number } = {}) {
  const repositories = createInMemoryRepositories();
  const clock = { now: 10 };
  let id = 0;
  const ids = { nextId: () => `harness-id-${++id}` };
  const kernel = createManagementKernel({
    repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork,
    clock: { now: () => clock.now },
    ids,
  });
  const offers: ManagementLeaseOfferV1[] = [];
  const pool = createServerWorkerPool({
    workerPoolId: 'pool-1',
    providerCredentialRef: 'credential-ref-1',
    clock: { now: () => clock.now },
    ids,
  });
  pool.registerWorker({
    connectionId: 'connection-1',
    capability: capability(),
    transport: { async emitLeaseOffer(offer) { offers.push(offer); return { ok: true }; } },
  });
  const scheduler = createServerWorkerScheduler({
    pool,
    management: repositories.management,
    kernel,
    clock: { now: () => clock.now },
    ids,
    leaseTokens: { nextToken: () => `lease-token-${id}` },
    ...(options.offerTimeoutMs ? { defaultOfferTimeoutMs: options.offerTimeoutMs } : {}),
  });
  const placementPolicy = {
    placement: 'managed' as const,
    allowServerContext: true,
    requireLocalModelCredentials: false,
  };
  async function createRun(key: string) {
    const { run } = await kernel.createOrResumeRun({
      teamId: 'team-1',
      channelId: 'channel-1',
      rootTaskId: `task-${key}`,
      rootMessageId: `message-${key}`,
      requestKey: `request-${key}`,
      requestHash: `hash-${key}`,
      placementPolicy,
      budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
      managementPhase: 2,
    });
    return run;
  }
  return { clock, offers, pool, scheduler, createRun };
}

function capability(
  overrides: Partial<ManagementWorkerRegisterV2> = {},
): ManagementWorkerRegisterV2 {
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
    providerCredentialRef: 'credential-ref-1',
    capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
    ...overrides,
  };
}
