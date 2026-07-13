import { describe, expect, test } from 'vitest';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('managed Dispatch lifecycle bridge', () => {
  test('records a canonical terminal Dispatch/event without completing the managed root Task', async () => {
    const harness = await createHarness(true);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    const dispatchId = created.view.dispatchAttempts[0]!.dispatchId;

    await expect(harness.usecases.receiveDispatchResult({ dispatchId, agentId: 'agent-1', body: '原始交付' }))
      .resolves.toMatchObject({ ok: true, dispatch: { status: 'succeeded' } });
    await expect(harness.repositories.tasks.getById('task-1')).resolves.toMatchObject({ status: 'in_progress' });
    const events = await harness.repositories.management.events.list(harness.authority.managementRunId);
    expect(events.filter(({ event }) => event.type === 'dispatch-attempt-completed')).toHaveLength(1);
    await expect(harness.gateway.getView(created.view.id)).resolves.toMatchObject({ status: 'succeeded' });
  });

  test('keeps the existing direct result path unchanged', async () => {
    const harness = await createHarness(false);
    await harness.repositories.dispatches.create({ id: 'direct-dispatch', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1', agentId: 'agent-1', status: 'queued', requestId: 'direct-1', prompt: '完成目标', createdAt: 1, updatedAt: 1 });

    await expect(harness.usecases.receiveDispatchResult({ dispatchId: 'direct-dispatch', agentId: 'agent-1', body: '直接交付' }))
      .resolves.toMatchObject({ ok: true, task: { status: 'in_review' } });
    await expect(harness.repositories.tasks.getById('task-1')).resolves.toMatchObject({ status: 'in_review' });
  });

  test.each([
    ['cancelled', async (h: Awaited<ReturnType<typeof createHarness>>, dispatchId: string) => h.usecases.cancelDispatch({ dispatchId, userId: 'user-1' })],
    ['timed_out', async (h: Awaited<ReturnType<typeof createHarness>>) => h.usecases.failTimedOutDispatches({ olderThan: 21 })],
    ['failed', async (h: Awaited<ReturnType<typeof createHarness>>, dispatchId: string) => h.usecases.receiveDispatchError({ dispatchId, agentId: 'agent-1', error: '失败' })],
  ] as const)('bridges %s into one terminal event', async (status, finish) => {
    const harness = await createHarness(true);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    const dispatchId = created.view.dispatchAttempts[0]!.dispatchId;
    await finish(harness, dispatchId);
    await expect(harness.gateway.getView(created.view.id)).resolves.toMatchObject({ status });
    const events = await harness.repositories.management.events.list(harness.authority.managementRunId);
    expect(events.filter(({ event }) => event.type === 'dispatch-attempt-completed')).toHaveLength(1);
  });
});

async function createHarness(withManagementRun: boolean) {
  const repositories = createInMemoryRepositories();
  let id = 0;
  const clock = { now: () => 20 };
  const ids = { nextId: () => `id-${++id}` };
  await repositories.users.create({ id: 'user-1', username: 'user', passwordHash: 'hash', role: 'user', primaryTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', username: 'user', role: 'owner', joinedAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
  await repositories.agents.upsert({ id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent', adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online' });
  await repositories.messages.append({ id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1', senderKind: 'human', senderId: 'user-1', body: '完成目标', createdAt: 1, meta: { taskId: 'task-1' } });
  await repositories.tasks.create({ id: 'task-1', teamId: 'team-1', channelId: 'channel-1', title: '完成目标', status: 'in_progress', creatorId: 'user-1', assigneeId: 'agent-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
  const kernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const run = withManagementRun
    ? (await kernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'task-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1', placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } })).run
    : undefined;
  if (run) await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
  return {
    repositories,
    gateway: createInvocationGateway({ repositories, clock, ids }),
    usecases: createServerNextUseCases({ repositories, clock, ids }),
    authority: { managementRunId: run?.id ?? 'unused', workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 },
  };
}

function invokeInput(authority: { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number }) {
  return { authority, frozenTargetAgentId: 'agent-1', allowedTargetAgentIds: ['agent-1'], idempotencyKey: 'invoke-1', intent: { schemaVersion: 1 as const, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1', targetKind: 'custom' as const, objective: '完成目标', taskContext: { taskId: 'task-1', rootTaskId: 'task-1', taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-1' }, acceptanceCriteria: [], dependencyResults: [], attachmentIds: [] } };
}
