import { describe, expect, test } from 'vitest';

import { hashManagementCheckpointAuthoritative } from '../src/application/management/management-checkpoint.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createPiOrchestrationRuntime } from '../src/application/management/pi-orchestration-runtime.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('#924 Server-owned PI orchestration runtime', () => {
  test('rejects a second non-terminal run/claim for the same root Task without leaving an orphan run', async () => {
    const harness = await createHarness();
    await expect(harness.kernel.createOrResumeRun({
      teamId: 'team-1',
      initiatedByUserId: 'user-1',
      channelId: 'channel-1',
      rootTaskId: 'task-1',
      rootMessageId: 'message-other',
      requestKey: 'request-other',
      requestHash: 'hash-other',
      placementPolicy: {
        placement: 'managed',
        allowServerContext: true,
        requireLocalModelCredentials: false,
      },
      budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
      managementPhase: 2,
    })).rejects.toThrow('active PI orchestration claim already exists');

    const reservation = await harness.repositories.management.reservations.getByRequestKey({
      teamId: 'team-1',
      requestKey: 'request-other',
    });
    expect(reservation).toBeNull();
  });

  test('lets only one replica dequeue the same runnable root run', async () => {
    const harness = await createHarness();
    await seedOrchestration(harness, {
      managementRunId: harness.runId,
      rootTaskId: 'task-1',
      priority: 10,
      eligibleAt: 0,
      enqueuedAt: 1,
    });
    const replica = createPiOrchestrationRuntime({
      unitOfWork: harness.repositories.taskCoordinationUnitOfWork,
      clock: harness.clock,
      ids: harness.ids,
    });

    const results = await Promise.all([
      harness.runtime.dequeueRunnable({
        workerId: 'replica-a',
        workerPoolId: 'pool-a',
        profileId: 'profile-a',
        leaseToken: 'token-a',
        ttlMs: 100,
      }),
      replica.dequeueRunnable({
        workerId: 'replica-b',
        workerPoolId: 'pool-b',
        profileId: 'profile-b',
        leaseToken: 'token-b',
        ttlMs: 100,
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(harness.repositories.management.leases.get(harness.runId))
      .resolves.toMatchObject({ fencingToken: 1 });
    await expect(harness.repositories.management.events.list(harness.runId))
      .resolves.toMatchObject([
        { event: { type: 'run-started' } },
        { event: { type: 'worker-leased' } },
      ]);
  });

  test('deterministically dequeues a runnable run and atomically acquires its server driver lease', async () => {
    const harness = await createHarness();
    await seedOrchestration(harness, {
      managementRunId: harness.runId,
      rootTaskId: 'task-1',
      priority: 20,
      eligibleAt: 5,
      enqueuedAt: 10,
    });
    const second = await createRun(harness, 'task-2', 'message-2', 'request-2');
    await seedOrchestration(harness, {
      managementRunId: second,
      rootTaskId: 'task-2',
      priority: 10,
      eligibleAt: 1,
      enqueuedAt: 1,
    });

    const dequeued = await harness.runtime.dequeueRunnable({
      workerId: 'pi-worker-1',
      workerPoolId: 'pi-pool-1',
      profileId: 'pi-profile-1',
      leaseToken: 'driver-secret',
      ttlMs: 100,
    });

    expect(dequeued).toMatchObject({
      managementRunId: harness.runId,
      rootTaskId: 'task-1',
      lease: { fencingToken: 1, host: { kind: 'server' } },
    });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'running', activeWorkerId: 'pi-worker-1' });
    await expect(harness.repositories.management.leases.get(harness.runId))
      .resolves.toMatchObject({ workerId: 'pi-worker-1', fencingToken: 1 });
  });

  test('wait command keeps the orchestration claim, releases the driver lease and replays from one receipt', async () => {
    const harness = await createHarness();
    await seedOrchestration(harness, {
      managementRunId: harness.runId,
      rootTaskId: 'task-1',
      priority: 10,
      eligibleAt: 0,
      enqueuedAt: 1,
    });
    const dequeued = await harness.runtime.dequeueRunnable({
      workerId: 'pi-worker-1',
      workerPoolId: 'pi-pool-1',
      profileId: 'pi-profile-1',
      leaseToken: 'driver-secret',
      ttlMs: 100,
    });
    if (!dequeued) throw new Error('expected runnable run');
    const authority = {
      managementRunId: harness.runId,
      workerId: 'pi-worker-1',
      leaseToken: 'driver-secret',
      fencingToken: dequeued.lease.fencingToken,
    };
    const input = {
      authority,
      idempotencyKey: 'wait-child-task',
      expectedRunRevision: dequeued.runRevision,
      expectedSchedulingRevision: 1,
      command: {
        kind: 'wait' as const,
        reasonCode: 'WAITING_FOR_CHILD_TASK',
        eligibleAt: 500,
        deadline: { kind: 'child-task-wake', dueAt: 500 },
      },
    };

    const first = await harness.runtime.commitCommand(input);
    const replay = await harness.runtime.commitCommand(input);

    expect(first.disposition).toBe('applied');
    expect(replay).toEqual({ ...first, disposition: 'replayed' });
    await expect(harness.repositories.management.orchestrationClaims.getByRunId(harness.runId))
      .resolves.toMatchObject({ state: 'active' });
    await expect(harness.repositories.management.scheduling.get(harness.runId))
      .resolves.toMatchObject({
        state: 'waiting',
        eligibleAt: 500,
        revision: 2,
        waitingReason: 'WAITING_FOR_CHILD_TASK',
      });
    await expect(harness.repositories.management.leases.get(harness.runId))
      .resolves.toMatchObject({ releasedAt: 10 });
    await expect(harness.repositories.management.commandReceipts.list(harness.runId))
      .resolves.toHaveLength(1);
    await expect(harness.repositories.management.outbox.list(harness.runId))
      .resolves.toHaveLength(1);

    await expect(harness.runtime.commitCommand({
      ...input,
      idempotencyKey: 'late-old-worker',
      expectedRunRevision: first.runRevision,
      expectedSchedulingRevision: first.schedulingRevision,
      command: { kind: 'wait', reasonCode: 'LATE', eligibleAt: 600 },
    })).rejects.toMatchObject({ code: 'LEASE_LEASE_RELEASED' });
    await expect(harness.repositories.management.commandReceipts.list(harness.runId))
      .resolves.toHaveLength(1);
  });

  test('Server wake makes a waiting run runnable and a different PI worker reacquires with a higher fence', async () => {
    const harness = await createHarness();
    await seedOrchestration(harness, {
      managementRunId: harness.runId,
      rootTaskId: 'task-1',
      priority: 10,
      eligibleAt: 0,
      enqueuedAt: 1,
    });
    const firstDriver = await harness.runtime.dequeueRunnable({
      workerId: 'pi-worker-1',
      workerPoolId: 'pi-pool-1',
      profileId: 'pi-profile-1',
      leaseToken: 'driver-secret-1',
      ttlMs: 100,
    });
    if (!firstDriver) throw new Error('expected first driver');
    const waiting = await harness.runtime.commitCommand({
      authority: {
        managementRunId: harness.runId,
        workerId: 'pi-worker-1',
        leaseToken: 'driver-secret-1',
        fencingToken: firstDriver.lease.fencingToken,
      },
      idempotencyKey: 'wait-before-wake',
      expectedRunRevision: firstDriver.runRevision,
      expectedSchedulingRevision: 1,
      command: { kind: 'wait', reasonCode: 'WAITING_FOR_CHILD_TASK', eligibleAt: 500 },
    });

    const wakeInput = {
      managementRunId: harness.runId,
      idempotencyKey: 'wake-child-completed',
      expectedRunRevision: waiting.runRevision,
      expectedSchedulingRevision: waiting.schedulingRevision,
      eligibleAt: 10,
    };
    const wake = await harness.runtime.wakeWaiting(wakeInput);
    const wakeReplay = await harness.runtime.wakeWaiting(wakeInput);
    expect(wake.disposition).toBe('applied');
    expect(wakeReplay).toEqual({ ...wake, disposition: 'replayed' });
    await expect(harness.repositories.management.scheduling.get(harness.runId))
      .resolves.toMatchObject({ state: 'runnable', waitingReason: undefined });

    const secondDriver = await harness.runtime.dequeueRunnable({
      workerId: 'pi-worker-2',
      workerPoolId: 'pi-pool-2',
      profileId: 'pi-profile-2',
      leaseToken: 'driver-secret-2',
      ttlMs: 100,
    });
    expect(secondDriver).toMatchObject({
      managementRunId: harness.runId,
      lease: { fencingToken: 2, host: { kind: 'server', workerPoolId: 'pi-pool-2' } },
    });
  });

  test('rolls back task mutation and every orchestration fact when outbox persistence fails', async () => {
    const harness = await createHarness();
    await seedOrchestration(harness, {
      managementRunId: harness.runId,
      rootTaskId: 'task-1',
      priority: 10,
      eligibleAt: 0,
      enqueuedAt: 1,
    });
    const dequeued = await harness.runtime.dequeueRunnable({
      workerId: 'pi-worker-1',
      workerPoolId: 'pi-pool-1',
      profileId: 'pi-profile-1',
      leaseToken: 'driver-secret',
      ttlMs: 100,
    });
    if (!dequeued) throw new Error('expected runnable run');

    const runtime = createPiOrchestrationRuntime({
      unitOfWork: {
        run(operation) {
          return harness.repositories.taskCoordinationUnitOfWork.run((repositories) =>
            operation({
              ...repositories,
              management: {
                ...repositories.management,
                outbox: {
                  ...repositories.management.outbox,
                  async create() {
                    throw new Error('INJECTED_OUTBOX_FAILURE');
                  },
                },
              },
            }));
        },
      },
      clock: harness.clock,
      ids: harness.ids,
    });

    await expect(runtime.commitCommand({
      authority: {
        managementRunId: harness.runId,
        workerId: 'pi-worker-1',
        leaseToken: 'driver-secret',
        fencingToken: dequeued.lease.fencingToken,
      },
      idempotencyKey: 'atomic-failure',
      expectedRunRevision: dequeued.runRevision,
      expectedSchedulingRevision: 1,
      command: { kind: 'wait', reasonCode: 'WAIT', eligibleAt: 500 },
      async applyTaskChanges(repositories) {
        await repositories.tasks.create({
          id: 'should-roll-back',
          teamId: 'team-1',
          title: 'must not persist',
          status: 'todo',
          creatorId: 'user-1',
          channelId: 'channel-1',
          tags: [],
          sortOrder: 0,
          createdAt: 10,
          updatedAt: 10,
        });
      },
    })).rejects.toThrow('INJECTED_OUTBOX_FAILURE');

    expect(await harness.repositories.tasks.getById('should-roll-back')).toBeNull();
    await expect(harness.repositories.management.scheduling.get(harness.runId))
      .resolves.toMatchObject({ state: 'runnable', revision: 1 });
    await expect(harness.repositories.management.commandReceipts.list(harness.runId))
      .resolves.toHaveLength(0);
    await expect(harness.repositories.management.events.list(harness.runId))
      .resolves.toHaveLength(2);
  });

  test('persists recovery_pending when checkpoint integrity cannot be explained and is idempotent', async () => {
    const harness = await createHarness();
    await seedOrchestration(harness, {
      managementRunId: harness.runId,
      rootTaskId: 'task-1',
      priority: 10,
      eligibleAt: 0,
      enqueuedAt: 1,
    });
    await harness.repositories.management.checkpoints.put({
      schemaVersion: 1,
      managementRunId: harness.runId,
      revision: 1,
      authoritative: {
        runRevision: 1,
        eventSchemaVersion: 1,
        contentHash: 'tampered',
        lastEventSequence: 1,
        taskGraphRevision: 1,
        openTaskIds: ['task-1'],
        waitingInvocationIds: [],
        completedInvocationIds: [],
        memoryCapsuleIds: [],
      },
      contextHints: {
        objective: 'root objective',
        planSummary: '',
        completedInvocationSummaries: [],
        unresolvedQuestions: [],
      },
      updatedAt: 10,
    });

    const first = await harness.runtime.reconcileRun({
      managementRunId: harness.runId,
      objective: 'root objective',
    });
    const replay = await harness.runtime.reconcileRun({
      managementRunId: harness.runId,
      objective: 'root objective',
    });

    expect(first).toMatchObject({ kind: 'recovery_pending', reasonCode: 'CHECKPOINT_HASH_MISMATCH' });
    expect(replay).toEqual(first);
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ recoveryState: 'recovery_pending' });
    await expect(harness.repositories.management.scheduling.get(harness.runId))
      .resolves.toMatchObject({ state: 'recovery_pending' });
  });

  test('distinguishes an explainable stale checkpoint from an impossible future checkpoint', async () => {
    const staleHarness = await createHarness();
    await seedOrchestration(staleHarness, {
      managementRunId: staleHarness.runId,
      rootTaskId: 'task-1',
      priority: 10,
      eligibleAt: 0,
      enqueuedAt: 1,
    });
    const staleAuthoritative = {
      runRevision: 0,
      eventSchemaVersion: 1 as const,
      lastEventSequence: 0,
      taskGraphRevision: 1,
      openTaskIds: ['task-1'],
      waitingInvocationIds: [],
      completedInvocationIds: [],
      memoryCapsuleIds: [],
    };
    await staleHarness.repositories.management.checkpoints.put({
      schemaVersion: 1,
      managementRunId: staleHarness.runId,
      revision: 1,
      authoritative: {
        ...staleAuthoritative,
        contentHash: hashManagementCheckpointAuthoritative(staleAuthoritative),
      },
      contextHints: {
        objective: 'stale objective',
        planSummary: '',
        completedInvocationSummaries: [],
        unresolvedQuestions: [],
      },
      updatedAt: 1,
    });
    await expect(staleHarness.runtime.reconcileRun({
      managementRunId: staleHarness.runId,
      objective: 'root objective',
    })).resolves.toEqual({
      kind: 'rebuild_required',
      reasons: ['run-revision-stale', 'event-sequence-stale'],
    });
    await expect(staleHarness.repositories.management.runs.getById(staleHarness.runId))
      .resolves.toMatchObject({ recoveryState: 'healthy' });

    const futureHarness = await createHarness();
    await seedOrchestration(futureHarness, {
      managementRunId: futureHarness.runId,
      rootTaskId: 'task-1',
      priority: 10,
      eligibleAt: 0,
      enqueuedAt: 1,
    });
    const futureAuthoritative = {
      ...staleAuthoritative,
      runRevision: 99,
      lastEventSequence: 99,
    };
    await futureHarness.repositories.management.checkpoints.put({
      schemaVersion: 1,
      managementRunId: futureHarness.runId,
      revision: 1,
      authoritative: {
        ...futureAuthoritative,
        contentHash: hashManagementCheckpointAuthoritative(futureAuthoritative),
      },
      contextHints: {
        objective: 'future objective',
        planSummary: '',
        completedInvocationSummaries: [],
        unresolvedQuestions: [],
      },
      updatedAt: 1,
    });
    await expect(futureHarness.runtime.reconcileRun({
      managementRunId: futureHarness.runId,
      objective: 'root objective',
    })).resolves.toEqual({
      kind: 'recovery_pending',
      reasonCode: 'CHECKPOINT_FUTURE_RUN_REVISION',
    });
  });
});

async function createHarness() {
  const repositories = createInMemoryRepositories();
  let id = 0;
  const clock = { now: () => 10 };
  const ids = { nextId: () => `runtime-${++id}` };
  const kernel = createManagementKernel({
    repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork,
    clock,
    ids,
  });
  const created = await kernel.createOrResumeRun({
    teamId: 'team-1',
    initiatedByUserId: 'user-1',
    channelId: 'channel-1',
    rootTaskId: 'task-1',
    rootMessageId: 'message-1',
    requestKey: 'request-1',
    requestHash: 'hash-1',
    placementPolicy: {
      placement: 'managed',
      allowServerContext: true,
      requireLocalModelCredentials: false,
    },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
    managementPhase: 2,
  });
  return {
    repositories,
    kernel,
    clock,
    ids,
    runId: created.run.id,
    runtime: createPiOrchestrationRuntime({
      unitOfWork: repositories.taskCoordinationUnitOfWork,
      clock,
      ids,
    }),
  };
}

async function createRun(
  harness: Awaited<ReturnType<typeof createHarness>>,
  rootTaskId: string,
  rootMessageId: string,
  requestKey: string,
): Promise<string> {
  const result = await harness.kernel.createOrResumeRun({
    teamId: 'team-1',
    initiatedByUserId: 'user-1',
    channelId: 'channel-1',
    rootTaskId,
    rootMessageId,
    requestKey,
    requestHash: `hash:${requestKey}`,
    placementPolicy: {
      placement: 'managed',
      allowServerContext: true,
      requireLocalModelCredentials: false,
    },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
    managementPhase: 2,
  });
  return result.run.id;
}

async function seedOrchestration(
  harness: Awaited<ReturnType<typeof createHarness>>,
  input: {
    managementRunId: string;
    rootTaskId: string;
    priority: number;
    eligibleAt: number;
    enqueuedAt: number;
  },
): Promise<void> {
  await harness.repositories.managementUnitOfWork.run(async (repositories) => {
    const claim = {
      managementRunId: input.managementRunId,
      rootTaskId: input.rootTaskId,
      state: 'active',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    } as const;
    if (await repositories.orchestrationClaims.getByRunId(input.managementRunId)) {
      await repositories.orchestrationClaims.update(claim);
    } else {
      await repositories.orchestrationClaims.create(claim);
    }
    const scheduling = {
      managementRunId: input.managementRunId,
      state: 'runnable',
      eligibleAt: input.eligibleAt,
      enqueuedAt: input.enqueuedAt,
      priority: input.priority,
      revision: 1,
      updatedAt: 1,
    } as const;
    if (await repositories.scheduling.get(input.managementRunId)) {
      await repositories.scheduling.update(scheduling);
    } else {
      await repositories.scheduling.create(scheduling);
    }
  });
}
