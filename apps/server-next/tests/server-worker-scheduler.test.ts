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
  test('waits for lease expiry, takes over on another Server Worker, and fences the stale Worker', async () => {
    vi.useFakeTimers();
    try {
      const harness = await createSchedulerHarness({ leaseTtlMs: 100 });
      harness.registerWorker('connection-2', 'server-instance-2');
      const run = await harness.createRun('takeover');

      await harness.scheduler.scheduleManagementRun({ managementRunId: run.id, profileId: 'profile-1' });
      const first = await harness.scheduler.acquireLease('connection-1', {
        schemaVersion: 1,
        offerId: harness.offers[0]!.offerId,
        workerInstanceId: 'server-instance-1',
      });
      if (!first.ok) throw new Error('first Server lease expected');

      harness.clock.now = 50;
      harness.scheduler.disconnect('connection-1');
      const reconnected = await harness.registerThroughScheduler(
        'connection-1-reconnected',
        'server-instance-1',
      );
      expect(reconnected).toMatchObject({ ok: true, workerId: first.workerId });
      await expect(harness.scheduler.renewLease('connection-1-reconnected', {
        schemaVersion: 1,
        managementRunId: run.id,
        workerId: first.workerId,
        leaseToken: first.leaseToken,
        fencingToken: first.fencingToken,
        idempotencyKey: 'stale-early-reconnect-renew',
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'NOT_AUTHORIZED',
        diagnosticCode: 'MANAGEMENT_WORKER_RECOVERY_PENDING',
      });
      await expect(harness.scheduler.fetchCheckpoint('connection-1-reconnected', {
        schemaVersion: 1,
        managementRunId: run.id,
        workerId: first.workerId,
        leaseToken: first.leaseToken,
        fencingToken: first.fencingToken,
      })).rejects.toMatchObject({ code: 'MANAGEMENT_WORKER_RECOVERY_PENDING' });
      await vi.advanceTimersByTimeAsync(59);
      expect(harness.offers).toHaveLength(1);

      harness.clock.now = 111;
      await vi.advanceTimersByTimeAsync(41);
      await vi.waitFor(() => expect(harness.offers).toHaveLength(2));
      expect(harness.offers[1]).toMatchObject({
        managementRunId: run.id,
        workerId: harness.workerIds.get('connection-2'),
      });
      const second = await harness.scheduler.acquireLease('connection-2', {
        schemaVersion: 1,
        offerId: harness.offers[1]!.offerId,
        workerInstanceId: 'server-instance-2',
      });
      expect(second).toMatchObject({ ok: true, fencingToken: 2 });
      if (!second.ok) throw new Error('takeover Server lease expected');

      await expect(harness.scheduler.renewLease('connection-1', {
        schemaVersion: 1,
        managementRunId: run.id,
        workerId: first.workerId,
        leaseToken: first.leaseToken,
        fencingToken: first.fencingToken,
        idempotencyKey: 'stale-disconnected-renew',
      })).resolves.toMatchObject({
        ok: false,
        diagnosticCode: 'MANAGEMENT_WORKER_CONNECTION_MISMATCH',
      });
      await expect(harness.scheduler.fetchCheckpoint('connection-1', {
        schemaVersion: 1,
        managementRunId: run.id,
        workerId: first.workerId,
        leaseToken: first.leaseToken,
        fencingToken: first.fencingToken,
      })).rejects.toMatchObject({ code: 'MANAGEMENT_WORKER_CONNECTION_MISMATCH' });

      await expect(harness.scheduler.renewLease('connection-1-reconnected', {
        schemaVersion: 1,
        managementRunId: run.id,
        workerId: first.workerId,
        leaseToken: first.leaseToken,
        fencingToken: first.fencingToken,
        idempotencyKey: 'stale-reconnected-renew',
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'NOT_AUTHORIZED',
        diagnosticCode: expect.stringMatching(/^LEASE_/),
      });
      await expect(harness.scheduler.fetchCheckpoint('connection-1-reconnected', {
        schemaVersion: 1,
        managementRunId: run.id,
        workerId: first.workerId,
        leaseToken: first.leaseToken,
        fencingToken: first.fencingToken,
      })).rejects.toMatchObject({ code: expect.stringMatching(/^LEASE_/) });
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps recovery queued without Device fallback and resumes when a Server Worker reconnects', async () => {
    vi.useFakeTimers();
    try {
      const harness = await createSchedulerHarness({ leaseTtlMs: 100 });
      const run = await harness.createRun('reconnect');
      await harness.scheduler.scheduleManagementRun({ managementRunId: run.id, profileId: 'profile-1' });
      const first = await harness.scheduler.acquireLease('connection-1', {
        schemaVersion: 1, offerId: harness.offers[0]!.offerId, workerInstanceId: 'server-instance-1',
      });
      if (!first.ok) throw new Error('first Server lease expected');

      harness.clock.now = 50;
      harness.scheduler.disconnect('connection-1');
      harness.clock.now = 111;
      await vi.advanceTimersByTimeAsync(100);
      expect(harness.offers).toHaveLength(1);
      expect(harness.pool.snapshot().queue).toMatchObject([{
        managementRunId: run.id,
        reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED',
      }]);

      await harness.registerThroughScheduler('connection-2', 'server-instance-2');
      await vi.waitFor(() => expect(harness.offers).toHaveLength(2));
      expect(harness.offers[1]).toMatchObject({ managementRunId: run.id });
    } finally {
      vi.useRealTimers();
    }
  });

  test('rebuilds recovery checkpoint from current facts and never reuses stale model hints', async () => {
    vi.useFakeTimers();
    try {
      const harness = await createSchedulerHarness({ leaseTtlMs: 100 });
      harness.registerWorker('connection-2', 'server-instance-2');
      const run = await harness.createRun('facts');
      await harness.repositories.messages.append({
        id: 'message-facts', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-facts',
        senderKind: 'human', senderId: 'user-1', body: 'authoritative objective', createdAt: 1,
      });
      await harness.repositories.tasks.create({
        id: 'task-facts', teamId: 'team-1', channelId: 'channel-1', title: 'Root task',
        status: 'in_progress', creatorId: 'user-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1,
      });
      await harness.repositories.management.invocations.create(invocation(run.id, 'invocation-completed', 2));
      await harness.repositories.management.dispatchAttempts.create({
        id: 'attempt-completed', invocationId: 'invocation-completed', dispatchId: 'dispatch-completed',
        attemptNumber: 1, status: 'succeeded', startedAt: 3, completedAt: 4,
      });
      await harness.repositories.management.invocations.create(invocation(run.id, 'invocation-waiting', 5));
      await harness.repositories.management.checkpoints.put({
        schemaVersion: 1, managementRunId: run.id, revision: 1,
        authoritative: {
          lastEventSequence: 1, taskGraphRevision: 0, openTaskIds: ['ghost-task'],
          waitingInvocationIds: [], completedInvocationIds: [], memoryCapsuleIds: ['stale-capsule'],
        },
        contextHints: {
          objective: 'stale objective', planSummary: 'repeat everything',
          completedInvocationSummaries: [{ invocationId: 'invocation-completed', summary: 'untrusted' }],
          unresolvedQuestions: ['stale question'], nextAction: 'repeat dispatch',
        },
        updatedAt: 6,
      });

      await harness.scheduler.scheduleManagementRun({ managementRunId: run.id, profileId: 'profile-1' });
      const first = await harness.scheduler.acquireLease('connection-1', {
        schemaVersion: 1, offerId: harness.offers[0]!.offerId, workerInstanceId: 'server-instance-1',
      });
      if (!first.ok) throw new Error('first Server lease expected');
      harness.clock.now = 50;
      harness.scheduler.disconnect('connection-1');
      harness.clock.now = 111;
      await vi.advanceTimersByTimeAsync(100);
      const second = await harness.scheduler.acquireLease('connection-2', {
        schemaVersion: 1, offerId: harness.offers[1]!.offerId, workerInstanceId: 'server-instance-2',
      });
      if (!second.ok) throw new Error('takeover Server lease expected');

      const recovery = await harness.scheduler.fetchCheckpoint('connection-2', {
        schemaVersion: 1,
        managementRunId: run.id,
        workerId: second.workerId,
        leaseToken: second.leaseToken,
        fencingToken: second.fencingToken,
        knownCheckpointRevision: 0,
      });
      expect(recovery.checkpoint?.authoritative).toMatchObject({
        openTaskIds: ['task-facts'],
        waitingInvocationIds: ['invocation-waiting'],
        completedInvocationIds: ['invocation-completed'],
        memoryCapsuleIds: ['capsule-current'],
      });
      expect(recovery.checkpoint?.contextHints).toEqual({
        objective: 'authoritative objective',
        planSummary: '',
        completedInvocationSummaries: [],
        unresolvedQuestions: [],
      });
      expect(JSON.stringify(recovery)).not.toContain('repeat everything');
      expect(JSON.stringify(recovery)).not.toContain('repeat dispatch');
    } finally {
      vi.useRealTimers();
    }
  });

  test('recovers a Run when the old Worker stops heartbeating without a clean disconnect', async () => {
    vi.useFakeTimers();
    try {
      const harness = await createSchedulerHarness({ leaseTtlMs: 100, heartbeatTimeoutMs: 30 });
      const run = await harness.createRun('heartbeat-crash');
      await harness.scheduler.scheduleManagementRun({ managementRunId: run.id, profileId: 'profile-1' });
      const first = await harness.scheduler.acquireLease('connection-1', {
        schemaVersion: 1, offerId: harness.offers[0]!.offerId, workerInstanceId: 'server-instance-1',
      });
      if (!first.ok) throw new Error('first Server lease expected');

      harness.clock.now = 41;
      await expect(harness.scheduler.managementPreflight({
        placementPolicy: {
          placement: 'managed',
          allowServerContext: true,
          requireLocalModelCredentials: false,
        },
        managementPhase: 2,
        targetAvailable: true,
      })).resolves.toMatchObject({ preflight: { workerAvailable: false } });
      expect(harness.pool.snapshot().queue).toMatchObject([{ managementRunId: run.id }]);
      await harness.registerThroughScheduler('connection-2', 'server-instance-2');
      expect(harness.offers).toHaveLength(1);

      harness.clock.now = 100;
      expect(harness.pool.heartbeat({
        connectionId: 'connection-2', workerInstanceId: 'server-instance-2', activeLeaseCount: 0,
      })).toMatchObject({ ok: true });
      harness.clock.now = 111;
      await vi.advanceTimersByTimeAsync(100);
      await expect(harness.repositories.management.runs.getById(run.id))
        .resolves.toMatchObject({ status: 'recovering' });
      await vi.waitFor(() => expect(harness.offers).toHaveLength(2));
      expect(harness.offers[1]).toMatchObject({
        managementRunId: run.id,
        workerId: harness.workerIds.get('connection-2'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('inherits the initiating user private scope, audits only metadata, and fails closed after revocation', async () => {
    const harness = await createSchedulerHarness();
    await seedPrivateRunContext(harness.repositories);
    const run = await harness.createRun('private');
    await harness.scheduler.scheduleManagementRun({ managementRunId: run.id, profileId: 'profile-1' });
    const acquired = await harness.scheduler.acquireLease('connection-1', {
      schemaVersion: 1,
      offerId: harness.offers[0]!.offerId,
      workerInstanceId: 'server-instance-1',
    });
    if (!acquired.ok) throw new Error('Server lease acquisition expected');
    const request = {
      schemaVersion: 1 as const,
      commandId: 'command-private',
      managementRunId: run.id,
      workerId: acquired.workerId,
      toolCallId: 'tool-private',
      toolName: 'context.get_visible_thread' as const,
      input: {},
    };

    await expect(harness.scheduler.executeTool('connection-1', request)).resolves.toMatchObject({
      ok: true,
      output: { messages: [{ body: 'private body' }] },
    });
    const allowedAudits = await harness.repositories.management.accessAudits.list(run.id);
    expect(allowedAudits.map((audit) => [audit.action, audit.decision])).toEqual([
      ['access', 'allowed'],
      ['transmit', 'allowed'],
    ]);
    expect(JSON.stringify(allowedAudits)).not.toContain('private body');
    expect(JSON.stringify(allowedAudits)).not.toContain('lease-token');

    await harness.repositories.channels.update({
      channelId: 'channel-1',
      changes: { humanMemberIds: [], updatedAt: 20 },
    });
    await expect(harness.scheduler.executeTool('connection-1', request)).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_AUTHORIZED',
      diagnosticCode: 'SERVER_WORKER_CHANNEL_FORBIDDEN',
    });
    const revokedAudits = await harness.repositories.management.accessAudits.list(run.id);
    expect(revokedAudits).toContainEqual(expect.objectContaining({
      userId: 'user-1',
      action: 'permission-change',
      decision: 'denied',
      diagnosticCode: 'SERVER_WORKER_CHANNEL_FORBIDDEN',
    }));
    expect(revokedAudits).toContainEqual(expect.objectContaining({
      userId: 'user-1',
      action: 'access',
      decision: 'denied',
      diagnosticCode: 'SERVER_WORKER_CHANNEL_FORBIDDEN',
    }));
  });

  test('rejects a cross-Team channel before any context is transmitted', async () => {
    const harness = await createSchedulerHarness();
    await seedPrivateRunContext(harness.repositories, 'team-2');
    const run = await harness.createRun('private');
    await harness.scheduler.scheduleManagementRun({ managementRunId: run.id, profileId: 'profile-1' });
    const acquired = await harness.scheduler.acquireLease('connection-1', {
      schemaVersion: 1, offerId: harness.offers[0]!.offerId, workerInstanceId: 'server-instance-1',
    });
    if (!acquired.ok) throw new Error('Server lease acquisition expected');
    await expect(harness.scheduler.executeTool('connection-1', {
      schemaVersion: 1, commandId: 'cross-team', managementRunId: run.id,
      workerId: acquired.workerId, toolCallId: 'cross-team-tool',
      toolName: 'context.get_root_message', input: {},
    })).resolves.toMatchObject({
      ok: false,
      diagnosticCode: 'SERVER_WORKER_CHANNEL_SCOPE_MISMATCH',
    });
    expect(await harness.repositories.management.accessAudits.list(run.id)).toMatchObject([{
      action: 'access', decision: 'denied', scopeId: 'channel-1',
    }]);
  });

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

  test('does not expire or retry an offer before its transport ACK settles', async () => {
    vi.useFakeTimers();
    try {
      let settleAck: ((value: { ok: false }) => void) | undefined;
      const harness = await createSchedulerHarness({
        offerTimeoutMs: 100,
        emitLeaseOffer: async () => new Promise<{ ok: false }>((resolve) => { settleAck = resolve; }),
      });
      const run = await harness.createRun('slow-ack');

      const scheduling = harness.scheduler.scheduleManagementRun({
        managementRunId: run.id,
        profileId: 'profile-1',
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(harness.offers).toHaveLength(1);
      expect(harness.pool.snapshot().workers[0]!.capacity.activeLeaseCount).toBe(1);
      settleAck?.({ ok: false });
      await expect(scheduling).resolves.toMatchObject({ diagnosticCode: 'MANAGEMENT_WORKER_OFFER_REJECTED' });
      expect(harness.pool.snapshot().workers[0]!.capacity.activeLeaseCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('coalesces concurrent scheduling calls for the same Run into one offer', async () => {
    let settleAck: ((value: { ok: true }) => void) | undefined;
    const harness = await createSchedulerHarness({
      emitLeaseOffer: async () => new Promise<{ ok: true }>((resolve) => { settleAck = resolve; }),
    });
    const run = await harness.createRun('concurrent');
    const input = { managementRunId: run.id, profileId: 'profile-1' };

    const first = harness.scheduler.scheduleManagementRun(input);
    const second = harness.scheduler.scheduleManagementRun(input);
    await vi.waitFor(() => expect(harness.offers.length).toBeGreaterThan(0));

    expect(harness.offers).toHaveLength(1);
    settleAck?.({ ok: true });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(harness.offers).toHaveLength(1);
  });
});

async function createSchedulerHarness(options: {
  offerTimeoutMs?: number;
  leaseTtlMs?: number;
  heartbeatTimeoutMs?: number;
  emitLeaseOffer?: (offer: ManagementLeaseOfferV1) => Promise<unknown>;
} = {}) {
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
  const workerIds = new Map<string, string>();
  const pool = createServerWorkerPool({
    workerPoolId: 'pool-1',
    providerCredentialRef: 'credential-ref-1',
    clock: { now: () => clock.now },
    ids,
    ...(options.heartbeatTimeoutMs ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs } : {}),
  });
  function registerWorker(connectionId: string, workerInstanceId: string) {
    const registered = pool.registerWorker({
      connectionId,
      capability: capability({ workerInstanceId }),
      transport: {
        async emitLeaseOffer(offer) {
          offers.push(offer);
          return options.emitLeaseOffer?.(offer) ?? { ok: true };
        },
      },
    });
    if (registered.ok) workerIds.set(connectionId, registered.workerId);
    return registered;
  }
  registerWorker('connection-1', 'server-instance-1');
  const scheduler = createServerWorkerScheduler({
    pool,
    management: repositories.management,
    messages: repositories.messages,
    taskCoordinationUnitOfWork: repositories.taskCoordinationUnitOfWork,
    memoryCapsules: {
      async listValidMemoryCapsuleIds() { return ['capsule-current']; },
    },
    repositories,
    executeTool: async (request) => ({
      schemaVersion: request.schemaVersion,
      ...('managementPhase' in request ? { managementPhase: request.managementPhase } : {}),
      commandId: request.commandId,
      managementRunId: request.managementRunId,
      workerId: request.workerId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      ok: true,
      output: request.toolName === 'context.get_visible_thread'
        ? { revision: 1, messages: [{ id: 'message-private', senderKind: 'human',
            senderId: 'user-1', body: 'private body', createdAt: 1 }] }
        : { message: { id: 'message-private', senderKind: 'human', senderId: 'user-1',
            body: 'private body', createdAt: 1 } },
    } as Awaited<ReturnType<import('../src/application/management/management-tool-executor.js').ManagementToolExecutor>>),
    kernel,
    clock: { now: () => clock.now },
    ids,
    leaseTokens: { nextToken: () => `lease-token-${id}` },
    ...(options.leaseTtlMs ? { leaseTtlMs: options.leaseTtlMs } : {}),
    ...(options.offerTimeoutMs ? { defaultOfferTimeoutMs: options.offerTimeoutMs } : {}),
  });
  async function registerThroughScheduler(connectionId: string, workerInstanceId: string) {
    const registered = await scheduler.registerWorker({
      connectionId,
      capability: capability({ workerInstanceId }),
      transport: {
        async emitLeaseOffer(offer) {
          offers.push(offer);
          return options.emitLeaseOffer?.(offer) ?? { ok: true };
        },
      },
    });
    if (registered.ok) workerIds.set(connectionId, registered.workerId);
    return registered;
  }
  const placementPolicy = {
    placement: 'managed' as const,
    allowServerContext: true,
    requireLocalModelCredentials: false,
  };
  async function createRun(key: string) {
    const { run } = await kernel.createOrResumeRun({
      teamId: 'team-1',
      initiatedByUserId: 'user-1',
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
  return { clock, offers, pool, repositories, scheduler, workerIds, registerWorker,
    registerThroughScheduler, createRun };
}

function invocation(managementRunId: string, id: string, createdAt: number) {
  return {
    schemaVersion: 1 as const,
    id,
    managementRunId,
    intentHash: `${id}-hash`,
    idempotencyKey: `${id}-key`,
    createdAt,
    intent: {
      schemaVersion: 1 as const,
      teamId: 'team-1',
      channelId: 'channel-1',
      targetAgentId: 'agent-1',
      targetKind: 'custom' as const,
      objective: id,
      acceptanceCriteria: [],
      dependencyResults: [],
      attachmentIds: [],
    },
  };
}

async function seedPrivateRunContext(
  repositories: ReturnType<typeof createInMemoryRepositories>,
  channelTeamId = 'team-1',
) {
  await repositories.teams.create({
    id: 'team-1', name: 'Team 1', path: 'team-1', visibility: 'private', ownerId: 'user-1', createdAt: 1,
  });
  await repositories.teams.addMember({
    teamId: 'team-1', userId: 'user-1', username: 'user-1', role: 'owner', joinedAt: 1,
  });
  await repositories.channels.create({
    id: 'channel-1', teamId: channelTeamId, kind: 'channel', name: 'private', visibility: 'private',
    createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1'], agentMemberIds: [],
  });
  await repositories.messages.append({
    id: 'message-private', teamId: channelTeamId, channelId: 'channel-1', threadId: 'message-private',
    senderKind: 'human', senderId: 'user-1', body: 'private body', createdAt: 1,
  });
  await repositories.tasks.create({
    id: 'task-private', teamId: channelTeamId, channelId: 'channel-1', title: 'Private task',
    status: 'in_progress', creatorId: 'user-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1,
  });
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
