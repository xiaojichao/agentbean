import { describe, expect, test } from 'vitest';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createPhase1ManagementToolHandlers } from '../src/application/management/management-tool-executor.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('Phase 2 managed multi-agent recovery and root delivery', () => {
  test('failed Invocation advances one controlled attempt and exhausts into waiting_for_user', async () => {
    const harness = await createHarness();
    await startAttempt(harness, 'claim-a-1', 1, 'invoke-a-1');
    const first = await harness.gateway.invokeTask({ authority: harness.authority,
      idempotencyKey: 'invoke-a-1', taskId: 'task-a', expectedTaskRevision: 1,
      taskAttempt: 1, claimLeaseId: 'claim-a-1', objective: '执行 A', attachmentIds: [] });
    await expect(harness.app.receiveDispatchError({ dispatchId: first.view.activeDispatchId!,
      agentId: 'agent-1', error: 'TRANSIENT_TRANSPORT_FAILURE' }))
      .resolves.toMatchObject({ ok: true });
    await expect(harness.repositories.tasks.getById('task-a'))
      .resolves.toMatchObject({ status: 'todo', revision: 1 });
    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId('task-a'))
      .resolves.toMatchObject({ attempt: 2 });
    await expect(harness.repositories.taskCoordination.claimLeases.getById('claim-a-1'))
      .resolves.toMatchObject({ status: 'invalidated' });

    await harness.repositories.agents.upsert(agent('agent-1'));
    await startAttempt(harness, 'claim-a-2', 2, 'invoke-a-2');
    const second = await harness.gateway.invokeTask({ authority: harness.authority,
      idempotencyKey: 'invoke-a-2', taskId: 'task-a', expectedTaskRevision: 1,
      taskAttempt: 2, claimLeaseId: 'claim-a-2', objective: '重试 A', attachmentIds: [] });
    await expect(harness.app.receiveDispatchError({ dispatchId: second.view.activeDispatchId!,
      agentId: 'agent-1', error: 'SECOND_FAILURE' })).resolves.toMatchObject({ ok: true });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'waiting_for_user' });
    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId('task-a'))
      .resolves.toMatchObject({ attempt: 2 });
    expect((await harness.repositories.management.events.list(harness.runId))
      .some(({ event }) => event.type === 'waiting-for-user'
        && event.payload.reasonCode === 'SECOND_FAILURE')).toBe(true);
  });

  test('root delivery requires every current leaf acceptance and human rejection creates a new revision', async () => {
    const harness = await createHarness();
    await seedAcceptedLeaf(harness, 'task-a', 'agent-1', 'claim-a', 'invocation-a', 'delivery-a');
    await seedAcceptedLeaf(harness, 'task-b', 'agent-2', 'claim-b', 'invocation-b', 'delivery-b');
    const handlers = createPhase1ManagementToolHandlers({ repositories: harness.repositories,
      kernel: harness.managementKernel, taskCoordinationKernel: harness.taskKernel,
      clock: harness.clock, ids: harness.ids, onDispatchCreated: () => undefined });
    const base = { schemaVersion: 1 as const, managementRunId: harness.runId,
      workerId: 'worker-1', toolCallId: 'root-delivery-call',
      toolName: 'review.submit_root_delivery' as const, leaseToken: 'manager-token',
      fencingToken: 1, idempotencyKey: 'root-delivery' };

    await expect(handlers['review.submit_root_delivery']!({ ...base,
      commandId: 'root-delivery-incomplete', input: { body: '不完整汇总',
        contributingInvocationIds: ['invocation-a'] } }))
      .rejects.toThrow('MANAGEMENT_ROOT_DELIVERY_CONTRIBUTIONS_INCOMPLETE');
    expect((await harness.repositories.messages.listByThread({ channelId: 'channel-1',
      threadId: 'root-message', limit: 50 }))
      .some((message) => message.meta?.managementCommandId === 'root-delivery-incomplete')).toBe(false);

    await expect(handlers['review.submit_root_delivery']!({ ...base,
      commandId: 'root-delivery-complete', input: { body: '两项结果均已验收',
        contributingInvocationIds: ['invocation-b', 'invocation-a'] } }))
      .resolves.toEqual(expect.objectContaining({ status: 'in_review' }));
    await expect(harness.repositories.tasks.getById('task-root'))
      .resolves.toMatchObject({ status: 'in_review', revision: 1 });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'in_review' });

    await expect(harness.app.updateTask({ userId: 'user-1', teamId: 'team-1',
      taskId: 'task-root', status: 'in_progress' }))
      .resolves.toMatchObject({ ok: true, task: { status: 'in_progress', revision: 2 } });
    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId('task-root'))
      .resolves.toMatchObject({ taskRevision: 2, attempt: 1 });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'running' });
    await expect(harness.taskKernel.reopenRootTaskFromHuman({ managementRunId: harness.runId,
      taskId: 'task-root', userId: 'user-1', expectedTaskRevision: 1 }))
      .resolves.toMatchObject({ disposition: 'existing', task: { revision: 2 } });
    await expect(harness.repositories.taskCoordination.acceptances.getCanonicalByDelivery('delivery-a'))
      .resolves.toMatchObject({ decision: 'accepted', expectedTaskRevision: 1 });
    expect((await harness.repositories.management.events.list(harness.runId))
      .some(({ event }) => event.type === 'task-revised'
        && event.payload.taskId === 'task-root'
        && event.payload.reasonCode === 'HUMAN_REJECTED_ROOT_DELIVERY')).toBe(true);
  });
});

async function createHarness() {
  const repositories = createInMemoryRepositories();
  let id = 0;
  const clock = { now: () => 20 };
  const ids = { nextId: () => `multi-${++id}` };
  await repositories.users.create({ id: 'user-1', username: 'user', role: 'user',
    passwordHash: 'unused', primaryTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team',
    visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1',
    username: 'user', role: 'owner', joinedAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel',
    name: 'general', visibility: 'public', humanMemberIds: ['user-1'],
    agentMemberIds: ['agent-1', 'agent-2'], createdAt: 1 });
  await repositories.agents.upsert(agent('agent-1'));
  await repositories.agents.upsert(agent('agent-2'));
  await repositories.messages.append({ id: 'root-message', teamId: 'team-1',
    channelId: 'channel-1', threadId: 'root-message', senderKind: 'human',
    senderId: 'user-1', body: '完成双 Agent 任务', createdAt: 1,
    meta: { taskId: 'task-root' } });
  await repositories.tasks.create({ id: 'task-root', teamId: 'team-1',
    channelId: 'channel-1', title: 'Root', status: 'in_progress', creatorId: 'user-1',
    tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1 });
  for (const [index, taskId] of ['task-a', 'task-b'].entries()) {
    await repositories.tasks.create({ id: taskId, teamId: 'team-1', channelId: 'channel-1',
      title: taskId, status: 'todo', creatorId: 'user-1', tags: [], sortOrder: index + 1,
      createdAt: 1, updatedAt: 1 });
  }
  const managementKernel = createManagementKernel({ repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const { run } = await managementKernel.createOrResumeRun({ teamId: 'team-1',
    channelId: 'channel-1', rootTaskId: 'task-root', rootMessageId: 'root-message',
    requestKey: 'multi-agent', requestHash: 'multi-agent-hash', placementPolicy: {
      placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
  await managementKernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' },
    leaseToken: 'manager-token', ttlMs: 1_000 });
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1,
    taskId: 'task-root', teamId: 'team-1', managementRunId: run.id, nodeKind: 'root',
    reviewPolicy: 'human', claimPolicy: 'open', requiredCapabilities: [], attempt: 1,
    maxAttempts: 1, taskRevision: 1, createdAt: 1, updatedAt: 1 });
  for (const taskId of ['task-a', 'task-b']) {
    await repositories.taskCoordination.coordinations.create({ schemaVersion: 1,
      taskId, teamId: 'team-1', rootTaskId: 'task-root', parentTaskId: 'task-root',
      managementRunId: run.id, nodeKind: 'subtask', reviewPolicy: 'manager',
      claimPolicy: 'open', requiredCapabilities: [], attempt: 1, maxAttempts: 2,
      taskRevision: 1, createdAt: 1, updatedAt: 1 });
  }
  const taskKernel = createTaskCoordinationKernel({
    unitOfWork: repositories.taskCoordinationUnitOfWork, clock, ids });
  return { repositories, clock, ids, runId: run.id, managementKernel, taskKernel,
    gateway: createInvocationGateway({ repositories, clock, ids }),
    app: createServerNextUseCases({ repositories, clock, ids, managementKernel,
      taskCoordinationKernel: taskKernel }),
    authority: { managementRunId: run.id, workerId: 'worker-1',
      leaseToken: 'manager-token', fencingToken: 1 },
  };
}

async function startAttempt(harness: Awaited<ReturnType<typeof createHarness>>,
  claimLeaseId: string, taskAttempt: number, _invocationKey: string) {
  await harness.repositories.tasks.update({ taskId: 'task-a',
    changes: { status: 'in_progress', assigneeId: 'agent-1', updatedAt: 20 } });
  await harness.repositories.taskCoordination.claimLeases.create({ id: claimLeaseId,
    teamId: 'team-1', taskId: 'task-a', taskRevision: 1, taskAttempt,
    agentId: 'agent-1', leaseTokenHash: `hash-${taskAttempt}`,
    leaseFingerprint: `fingerprint-${taskAttempt}`, fencingToken: taskAttempt,
    status: 'active', acquiredAt: 10, heartbeatAt: 10, expiresAt: 1_000 });
}

async function seedAcceptedLeaf(harness: Awaited<ReturnType<typeof createHarness>>,
  taskId: string, agentId: string, claimLeaseId: string,
  invocationId: string, deliveryId: string) {
  await harness.repositories.tasks.update({ taskId,
    changes: { status: 'done', assigneeId: agentId, updatedAt: 20 } });
  await harness.repositories.taskCoordination.claimLeases.create({ id: claimLeaseId,
    teamId: 'team-1', taskId, taskRevision: 1, taskAttempt: 1, agentId,
    leaseTokenHash: `hash-${claimLeaseId}`, leaseFingerprint: `fp-${claimLeaseId}`,
    fencingToken: 1, status: 'active', acquiredAt: 5, heartbeatAt: 10, expiresAt: 1_000 });
  await harness.repositories.management.invocations.create({ schemaVersion: 1,
    id: invocationId, managementRunId: harness.runId, intent: { schemaVersion: 1,
      teamId: 'team-1', channelId: 'channel-1', targetAgentId: agentId,
      targetKind: 'custom', objective: `完成 ${taskId}`, taskContext: { taskId,
        rootTaskId: 'task-root', taskRevision: 1, taskAttempt: 1, claimLeaseId },
      acceptanceCriteria: [], dependencyResults: [], attachmentIds: [] },
    intentHash: `hash-${invocationId}`, idempotencyKey: `key-${invocationId}`, createdAt: 5 });
  const dispatchId = `dispatch-${invocationId}`;
  await harness.repositories.dispatches.create({ id: dispatchId, teamId: 'team-1',
    channelId: 'channel-1', messageId: 'root-message', agentId, status: 'succeeded',
    requestId: `request-${invocationId}`, prompt: `完成 ${taskId}`,
    createdAt: 5, updatedAt: 10, completedAt: 10 });
  await harness.repositories.management.dispatchAttempts.create({ id: `attempt-${invocationId}`,
    invocationId, dispatchId, attemptNumber: 1, status: 'succeeded',
    startedAt: 5, completedAt: 10 });
  await harness.repositories.taskCoordination.deliveries.create({ schemaVersion: 1,
    id: deliveryId, teamId: 'team-1', taskId, taskRevision: 1, taskAttempt: 1,
    claimLeaseId, invocationId, summary: `${taskId} done`, claims: [], evidenceRefs: [],
    idempotencyKey: `key-${deliveryId}`, createdAt: 10 });
  await harness.repositories.taskCoordination.acceptances.create({ schemaVersion: 1,
    id: `acceptance-${deliveryId}`, teamId: 'team-1', taskId, deliveryId,
    expectedTaskRevision: 1, taskAttempt: 1, claimLeaseId, decision: 'accepted',
    criteriaResults: [], reason: 'accepted', decidedBy: 'manager', decidedAt: 12,
    decisionVersion: 1, canonical: true });
}

function agent(id: string) {
  return { id, primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: id,
    adapterKind: 'codex' as const, category: 'executor-hosted' as const,
    source: 'custom' as const, status: 'online' as const };
}
