import { describe, expect, test, vi } from 'vitest';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import {
  createManagementToolExecutor,
  createPhase1ManagementToolHandlers,
} from '../src/application/management/management-tool-executor.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('Phase 1 managed single-Agent vertical slice', () => {
  test('light request invokes one real Agent and completes the Run with the Agent reply', async () => {
    const harness = await createHarness();
    const invocationPromise = harness.execute(invokeRequest(harness, 'invoke-light'));
    const dispatch = await waitForDispatch(harness);

    const delivered = await harness.app.receiveDispatchResult({
      dispatchId: dispatch.id,
      agentId: 'agent-1',
      body: '真实 Agent 回复',
    });
    expect(delivered).toMatchObject({
      ok: true,
      message: { senderKind: 'agent', senderId: 'agent-1', body: '真实 Agent 回复' },
    });
    await expect(invocationPromise).resolves.toMatchObject({
      ok: true,
      output: { invocationId: expect.any(String), status: 'succeeded' },
    });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'completed' });
    expect(await harness.repositories.dispatches.listByTeam('team-1')).toHaveLength(1);
    expect(await harness.repositories.management.invocations.listByRun(harness.runId)).toHaveLength(1);
    expect(harness.onDispatchCreated).toHaveBeenCalledTimes(1);

    await expect(harness.execute(invokeRequest(harness, 'invoke-light'))).resolves.toMatchObject({
      ok: true,
      output: { status: 'succeeded' },
    });
    expect(await harness.repositories.dispatches.listByTeam('team-1')).toHaveLength(1);
  });

  test('root Task waits for PI management delivery and human done before completing', async () => {
    const harness = await createHarness({ rootTask: true });
    const invocationPromise = harness.execute(invokeRequest(harness, 'invoke-task'));
    const dispatch = await waitForDispatch(harness);
    await harness.app.receiveDispatchResult({
      dispatchId: dispatch.id,
      agentId: 'agent-1',
      body: 'Agent 原始交付',
    });
    const invocation = await invocationPromise;
    expect(invocation).toMatchObject({ ok: true, output: { status: 'succeeded' } });
    const invocationId = (invocation as { output: { invocationId: string } }).output.invocationId;
    await expect(harness.repositories.tasks.getById('task-1')).resolves.toMatchObject({ status: 'in_progress' });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({ status: 'running' });
    await expect(harness.app.updateTask({
      userId: 'user-1', teamId: 'team-1', taskId: 'task-1', status: 'done',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(harness.repositories.tasks.getById('task-1')).resolves.toMatchObject({ status: 'in_progress' });

    const reviewRequest = {
      schemaVersion: 1 as const,
      commandId: 'review-task',
      managementRunId: harness.runId,
      workerId: 'worker-1',
      toolCallId: 'review-task',
      toolName: 'review.submit_root_delivery' as const,
      input: { body: '请审核最终交付', contributingInvocationIds: [invocationId] },
      leaseToken: 'lease-token',
      fencingToken: 1,
      idempotencyKey: 'review-task',
    };
    const reviewed = await harness.execute(reviewRequest);
    expect(reviewed).toMatchObject({ ok: true, output: { status: 'in_review', deliveryMessageId: expect.any(String) } });
    await expect(harness.repositories.tasks.getById('task-1')).resolves.toMatchObject({ status: 'in_review' });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({ status: 'in_review' });
    const deliveryId = (reviewed as { output: { deliveryMessageId: string } }).output.deliveryMessageId;
    await expect(harness.repositories.messages.getById(deliveryId)).resolves.toMatchObject({
      senderKind: 'system',
      senderId: 'system',
      meta: { kind: 'management-delivery', managementRunId: harness.runId },
    });
    await expect(harness.execute(reviewRequest)).resolves.toMatchObject({
      ok: true,
      output: { deliveryMessageId: deliveryId, status: 'in_review' },
    });

    await expect(harness.app.updateTask({
      userId: 'user-1', teamId: 'team-1', taskId: 'task-1', status: 'done',
    })).resolves.toMatchObject({ ok: true, task: { status: 'done' } });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({ status: 'completed' });
    const deliveries = (await harness.repositories.messages.listByThread({
      channelId: 'channel-1', threadId: 'message-1', limit: 50,
    })).filter((message) => message.meta?.kind === 'management-delivery');
    expect(deliveries).toHaveLength(1);
  });

  test('failed external execution fails the Run and replay never creates a second Dispatch', async () => {
    const harness = await createHarness();
    const invocationPromise = harness.execute(invokeRequest(harness, 'invoke-failed'));
    const dispatch = await waitForDispatch(harness);
    await harness.app.receiveDispatchError({ dispatchId: dispatch.id, agentId: 'agent-1', error: 'boom' });
    await expect(invocationPromise).resolves.toMatchObject({ ok: true, output: { status: 'failed' } });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({ status: 'failed' });
    await expect(harness.execute(invokeRequest(harness, 'invoke-failed'))).resolves.toMatchObject({
      ok: true, output: { status: 'failed' },
    });
    expect(await harness.repositories.dispatches.listByTeam('team-1')).toHaveLength(1);
  });

  test('human cancel terminates the Invocation and replay never creates a second Dispatch', async () => {
    const harness = await createHarness();
    const invocationPromise = harness.execute(invokeRequest(harness, 'invoke-cancelled'));
    const dispatch = await waitForDispatch(harness);

    await expect(harness.app.cancelDispatch({ userId: 'user-1', dispatchId: dispatch.id }))
      .resolves.toMatchObject({ ok: true, dispatch: { status: 'cancelled' } });
    await expect(invocationPromise).resolves.toMatchObject({ ok: true, output: { status: 'cancelled' } });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(harness.execute(invokeRequest(harness, 'invoke-cancelled')))
      .resolves.toMatchObject({ ok: true, output: { status: 'cancelled' } });
    expect(await harness.repositories.dispatches.listByTeam('team-1')).toHaveLength(1);
  });

  test('dispatch timeout fails the Run and replay never creates a second Dispatch', async () => {
    const harness = await createHarness();
    const invocationPromise = harness.execute(invokeRequest(harness, 'invoke-timeout'));
    await waitForDispatch(harness);

    await expect(harness.app.failTimedOutDispatches({ olderThan: Number.MAX_SAFE_INTEGER }))
      .resolves.toMatchObject({ ok: true, dispatches: [{ status: 'timed_out' }] });
    await expect(invocationPromise).resolves.toMatchObject({ ok: true, output: { status: 'timed_out' } });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({ status: 'failed' });
    await expect(harness.execute(invokeRequest(harness, 'invoke-timeout')))
      .resolves.toMatchObject({ ok: true, output: { status: 'timed_out' } });
    expect(await harness.repositories.dispatches.listByTeam('team-1')).toHaveLength(1);
  });

  test('offline Device makes Dispatch emission fail closed instead of waiting forever', async () => {
    const harness = await createHarness({ dispatchEmitFailure: true });

    await expect(harness.execute(invokeRequest(harness, 'invoke-offline'))).resolves.toMatchObject({
      ok: false,
      diagnosticCode: 'MANAGEMENT_DISPATCH_EMIT_FAILED',
    });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({ status: 'failed' });
    expect(await harness.repositories.dispatches.listByTeam('team-1')).toMatchObject([{ status: 'failed' }]);
  });
});

function invokeRequest(harness: Awaited<ReturnType<typeof createHarness>>, commandId: string) {
  return {
    schemaVersion: 1 as const,
    commandId,
    managementRunId: harness.runId,
    workerId: 'worker-1',
    toolCallId: commandId,
    toolName: 'agents.invoke' as const,
    input: { objective: '处理用户请求', attachmentIds: [] },
    leaseToken: 'lease-token',
    fencingToken: 1,
    idempotencyKey: commandId,
  };
}

async function waitForDispatch(harness: Awaited<ReturnType<typeof createHarness>>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const dispatch = (await harness.repositories.dispatches.listByTeam('team-1'))[0];
    if (dispatch) return dispatch;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('managed Dispatch was not created');
}

async function createHarness(options: { rootTask?: boolean; dispatchEmitFailure?: boolean } = {}) {
  const repositories = createInMemoryRepositories();
  let now = 10;
  let id = 0;
  const clock = { now: () => ++now };
  const ids = { nextId: () => `id-${++id}` };
  await repositories.users.create({ id: 'user-1', username: 'owner', role: 'user', passwordHash: 'hash', primaryTeamId: 'team-1', currentTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', username: 'owner', role: 'owner', joinedAt: 1 });
  await repositories.devices.upsertHello({ id: 'device-1', teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'profile-1', status: 'online', createdAt: 1, updatedAt: 1 });
  await repositories.agents.upsert({ id: 'agent-1', identityKey: 'agent-1', name: 'Agent', category: 'custom', adapterKind: 'custom', ownerId: 'user-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], deviceId: 'device-1', status: 'online', createdAt: 1, updatedAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'all', visibility: 'public', createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'] });
  if (options.rootTask) {
    await repositories.tasks.create({ id: 'task-1', teamId: 'team-1', title: 'Root Task', status: 'in_progress', creatorId: 'user-1', assigneeId: 'agent-1', channelId: 'channel-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
  }
  await repositories.messages.append({
    id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1', senderKind: 'human', senderId: 'user-1', body: '@Agent 处理', createdAt: 1,
    ...(options.rootTask ? { meta: { taskId: 'task-1' } } : {}),
  });
  const kernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const run = await kernel.createOrResumeRun({
    teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1',
    ...(options.rootTask ? { rootTaskId: 'task-1' } : {}),
    frozenTarget: { agentId: 'agent-1', kind: 'custom' },
    requestKey: 'request-1', requestHash: 'hash-1',
    placementPolicy: { placement: 'device', allowedDeviceIds: ['device-1'], allowServerContext: false, requireLocalModelCredentials: true },
    budget: { maxSubtasks: 1, maxDepth: 1, maxExternalInvocations: 1 },
  });
  await kernel.acquireLease({
    managementRunId: run.run.id,
    workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' },
    leaseToken: 'lease-token',
    ttlMs: 60_000,
  });
  const onDispatchCreated = options.dispatchEmitFailure
    ? vi.fn(async () => { throw new Error('device offline'); })
    : vi.fn();
  const handlers = createPhase1ManagementToolHandlers({ repositories, kernel, clock, ids, onDispatchCreated, pollIntervalMs: 1, terminalTimeoutMs: 2_000 });
  const execute = createManagementToolExecutor({ kernel,
    managementMemoryUnitOfWork: repositories.managementMemoryUnitOfWork, handlers });
  const app = createServerNextUseCases({ repositories, clock, ids, managementKernel: kernel });
  return { repositories, kernel, execute, app, onDispatchCreated, runId: run.run.id };
}
