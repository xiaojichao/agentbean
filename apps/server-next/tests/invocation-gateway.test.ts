import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyGlobalMigrations, applyTeamMigrations, createSqliteRepositories, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

describe('Phase 1 Invocation Gateway', () => {
  test('validates the frozen target, permission, Team, channel, attachment, and target kind', async () => {
    const harness = await createHarness();
    const cases = [
      [{ frozenTargetAgentId: 'agent-2' }, 'INVOCATION_FROZEN_TARGET_MISMATCH'],
      [{ allowedTargetAgentIds: [] }, 'INVOCATION_TARGET_FORBIDDEN'],
      [{ intent: { ...intent(), teamId: 'team-2' } }, 'INVOCATION_TEAM_MISMATCH'],
      [{ intent: { ...intent(), channelId: 'channel-2' } }, 'INVOCATION_CHANNEL_MISMATCH'],
      [{ intent: { ...intent(), targetKind: 'agentos-hosted' as const } }, 'INVOCATION_TARGET_KIND_MISMATCH'],
      [{ intent: { ...intent(), attachmentIds: ['artifact-other-channel'] } }, 'INVOCATION_ATTACHMENT_FORBIDDEN'],
    ] as const;

    for (const [changes, code] of cases) {
      await expect(harness.gateway.invoke({ ...invokeInput(harness.authority), ...changes }))
        .rejects.toMatchObject({ code });
    }
  });

  test('atomically creates immutable Invocation, canonical Dispatch, attempt, and two events', async () => {
    const harness = await createHarness();
    const created = await harness.gateway.invoke(invokeInput(harness.authority));

    expect(created.disposition).toBe('created');
    expect(created.view).toMatchObject({ status: 'pending', dispatchAttempts: [{ attemptNumber: 1, status: 'queued' }] });
    const events = await harness.repositories.management.events.list(harness.authority.managementRunId);
    expect(events.map(({ event }) => event.type)).toEqual([
      'run-started', 'worker-leased', 'invocation-created', 'dispatch-attempt-started',
    ]);
    await expect(harness.repositories.dispatches.getById(created.view.dispatchAttempts[0]!.dispatchId))
      .resolves.toMatchObject({ requestId: `management:${created.view.id}:1`, prompt: '完成目标' });
  });

  test('rolls back Invocation and Dispatch when a typed event cannot be committed', async () => {
    const harness = await createHarness();
    const append = harness.repositories.management.events.append;
    harness.repositories.management.events.append = async (record) => {
      if (record.event.type === 'invocation-created') throw new Error('EVENT_WRITE_FAILED');
      return append(record);
    };

    await expect(harness.gateway.invoke(invokeInput(harness.authority))).rejects.toThrow('EVENT_WRITE_FAILED');
    await expect(harness.repositories.management.invocations.listByRun(harness.authority.managementRunId)).resolves.toEqual([]);
    await expect(harness.repositories.dispatches.listByTeam('team-1')).resolves.toEqual([]);
  });

  test('persists the same Invocation/Dispatch lifecycle through SQLite', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    try {
      applyGlobalMigrations(globalDb);
      applyTeamMigrations(teamDb);
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      let id = 0;
      const clock = { now: () => 20 };
      const ids = { nextId: () => `sqlite-${++id}` };
      await repositories.users.create({ id: 'user-1', username: 'user', role: 'user', passwordHash: 'unused', createdAt: 1, updatedAt: 1 });
      await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
      await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
      await repositories.agents.upsert({ id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent', adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online' });
      await repositories.messages.append({ id: 'message-1', teamId: 'team-1', channelId: 'channel-1', senderKind: 'human', senderId: 'user-1', body: '完成目标', createdAt: 1 });
      await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1', uploaderId: 'user-1', filename: 'spec.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
      const kernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock, ids });
      const { run } = await kernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1', placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
      await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
      const authority = { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 };
      const gateway = createInvocationGateway({ repositories, clock, ids });

      const created = await gateway.invoke(invokeInput(authority));
      await gateway.completeAttempt({ dispatchId: created.view.dispatchAttempts[0]!.dispatchId, status: 'succeeded' });
      await expect(gateway.getView(created.view.id)).resolves.toMatchObject({ status: 'succeeded', dispatchAttempts: [{ attemptNumber: 1, status: 'succeeded' }] });
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });

  test('returns the existing Invocation for the same key/hash and rejects intent drift', async () => {
    const harness = await createHarness();
    const first = await harness.gateway.invoke(invokeInput(harness.authority));
    const replay = await harness.gateway.invoke(invokeInput(harness.authority));

    expect(replay).toEqual({ disposition: 'existing', view: first.view });
    await expect(harness.gateway.invoke({
      ...invokeInput(harness.authority),
      intent: { ...intent(), objective: '偷偷换目标' },
    })).rejects.toMatchObject({ code: 'INVOCATION_IDEMPOTENCY_CONFLICT' });
    await expect(harness.repositories.management.invocations.listByRun(harness.authority.managementRunId)).resolves.toHaveLength(1);
  });

  test('blocks active retries and only creates attempt +1 after an explicit terminal retry', async () => {
    const harness = await createHarness();
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    await expect(harness.gateway.retry({ authority: harness.authority, invocationId: created.view.id }))
      .rejects.toMatchObject({ code: 'INVOCATION_ACTIVE_ATTEMPT' });

    const firstDispatchId = created.view.dispatchAttempts[0]!.dispatchId;
    const completed = await harness.gateway.completeAttempt({ dispatchId: firstDispatchId, status: 'failed', error: 'PROVIDER_DOWN' });
    await expect(harness.gateway.completeAttempt({ dispatchId: firstDispatchId, status: 'failed', error: 'PROVIDER_DOWN' }))
      .resolves.toEqual({ ...completed, changed: false });
    const retried = await harness.gateway.retry({ authority: harness.authority, invocationId: created.view.id });
    expect(retried).toMatchObject({ status: 'pending', dispatchAttempts: [{ attemptNumber: 1, status: 'failed' }, { attemptNumber: 2, status: 'queued' }] });
  });

  test('keeps a late result on its original Dispatch without overwriting a newer attempt', async () => {
    const harness = await createHarness();
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    const firstDispatchId = created.view.dispatchAttempts[0]!.dispatchId;
    await harness.gateway.completeAttempt({ dispatchId: firstDispatchId, status: 'timed_out', error: 'DISPATCH_TIMEOUT' });
    const retried = await harness.gateway.retry({ authority: harness.authority, invocationId: created.view.id });
    const secondDispatchId = retried.dispatchAttempts[1]!.dispatchId;

    await harness.gateway.completeAttempt({ dispatchId: firstDispatchId, status: 'succeeded' });
    await expect(harness.gateway.getView(created.view.id)).resolves.toMatchObject({
      status: 'pending',
      activeDispatchId: secondDispatchId,
      dispatchAttempts: [
        { dispatchId: firstDispatchId, attemptNumber: 1, status: 'succeeded' },
        { dispatchId: secondDispatchId, attemptNumber: 2, status: 'queued' },
      ],
    });
  });

  test('derives Invocation status only from canonical Dispatch rows', async () => {
    const harness = await createHarness();
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    const attempt = (await harness.repositories.management.dispatchAttempts.list(created.view.id))[0]!;
    await harness.repositories.management.dispatchAttempts.update({ ...attempt, status: 'succeeded', completedAt: 30 });

    await expect(harness.gateway.getView(created.view.id)).resolves.toMatchObject({
      status: 'pending',
      dispatchAttempts: [{ status: 'queued' }],
    });
  });
});

describe('Phase 2 claim-bound Invocation Gateway', () => {
  test('derives target, criteria and dependency results from authoritative Server state', async () => {
    const harness = await createPhase2Harness({ withDependency: true });
    const created = await harness.gateway.invokeTask(phase2InvokeInput(harness.authority));

    expect(created.disposition).toBe('created');
    expect(created.view.intent).toMatchObject({
      targetAgentId: 'agent-1', targetKind: 'custom',
      taskContext: { taskId: 'task-child', rootTaskId: 'task-root', taskRevision: 1,
        taskAttempt: 1, claimLeaseId: 'claim-child' },
      acceptanceCriteria: [{ id: 'criterion-child', description: '完成 child' }],
      dependencyResults: [{ invocationId: 'invocation-dependency', resultRevision: 1,
        artifactIds: ['artifact-dependency'], workspaceRunId: 'workspace-dependency' }],
    });
  });

  test.each([
    ['stale revision', { expectedTaskRevision: 2 }, 'INVOCATION_TASK_REVISION_STALE'],
    ['stale attempt', { taskAttempt: 2 }, 'INVOCATION_TASK_ATTEMPT_STALE'],
    ['stale claim', { claimLeaseId: 'claim-stale' }, 'INVOCATION_CLAIM_STALE'],
    ['expired deadline', { deadlineAt: 20 }, 'INVOCATION_DEADLINE_EXPIRED'],
    ['forbidden attachment', { attachmentIds: ['artifact-other-channel'] }, 'INVOCATION_ATTACHMENT_FORBIDDEN'],
  ] as const)('fails closed for %s', async (_label, changes, code) => {
    const harness = await createPhase2Harness();
    await expect(harness.gateway.invokeTask({ ...phase2InvokeInput(harness.authority), ...changes }))
      .rejects.toMatchObject({ code });
  });

  test('rejects unmet dependencies and a second active Invocation for the same Task attempt', async () => {
    const blocked = await createPhase2Harness({ withDependency: true, dependencyDone: false });
    await expect(blocked.gateway.invokeTask(phase2InvokeInput(blocked.authority)))
      .rejects.toMatchObject({ code: 'INVOCATION_DEPENDENCIES_NOT_READY' });

    const harness = await createPhase2Harness();
    await harness.gateway.invokeTask(phase2InvokeInput(harness.authority));
    await expect(harness.gateway.invokeTask({
      ...phase2InvokeInput(harness.authority), idempotencyKey: 'invoke-child-second',
    })).rejects.toMatchObject({ code: 'INVOCATION_TASK_ATTEMPT_ACTIVE' });
  });

  test('creates the claim-bound Invocation through the SQLite atomic unit of work', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    try {
      applyGlobalMigrations(globalDb);
      applyTeamMigrations(teamDb);
      const harness = await createPhase2Harness({}, createSqliteRepositories({ globalDb, teamDb }));
      await expect(harness.gateway.invokeTask(phase2InvokeInput(harness.authority)))
        .resolves.toMatchObject({ disposition: 'created', view: { status: 'pending',
          intent: { targetAgentId: 'agent-1', taskContext: { claimLeaseId: 'claim-child' } } } });
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });
});

async function createHarness() {
  const repositories = createInMemoryRepositories();
  let id = 0;
  const dependencies = { repositories, clock: { now: () => 20 }, ids: { nextId: () => `id-${++id}` } };
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
  await repositories.channels.create({ id: 'channel-2', teamId: 'team-1', kind: 'channel', name: 'other', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
  await repositories.agents.upsert({ id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent', adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online' });
  await repositories.messages.append({ id: 'message-1', teamId: 'team-1', channelId: 'channel-1', senderKind: 'human', senderId: 'user-1', body: '完成目标', createdAt: 1 });
  await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1', uploaderId: 'user-1', filename: 'spec.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
  await repositories.artifacts.create({ id: 'artifact-other-channel', teamId: 'team-1', channelId: 'channel-2', uploaderId: 'user-1', filename: 'secret.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
  const kernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock: dependencies.clock, ids: dependencies.ids });
  const { run } = await kernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1', placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
  await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
  return {
    repositories,
    gateway: createInvocationGateway(dependencies),
    authority: { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 },
  };
}

function intent() {
  return { schemaVersion: 1 as const, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1', targetKind: 'custom' as const, objective: '完成目标', acceptanceCriteria: [], dependencyResults: [], attachmentIds: ['artifact-1'] };
}

function invokeInput(authority: { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number }) {
  return { authority, frozenTargetAgentId: 'agent-1', allowedTargetAgentIds: ['agent-1'] as readonly string[], idempotencyKey: 'invoke-1', intent: intent() };
}

async function createPhase2Harness(
  options: { withDependency?: boolean; dependencyDone?: boolean } = {},
  repositories = createInMemoryRepositories(),
) {
  let id = 0;
  const clock = { now: () => 20 };
  const ids = { nextId: () => `phase2-${++id}` };
  await repositories.users.create({ id: 'user-1', username: 'user', role: 'user', passwordHash: 'unused', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
  await repositories.channels.create({ id: 'channel-2', teamId: 'team-1', kind: 'channel', name: 'other', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: [], createdAt: 1 });
  await repositories.agents.upsert({ id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent', adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online' });
  await repositories.messages.append({ id: 'message-1', teamId: 'team-1', channelId: 'channel-1', senderKind: 'human', senderId: 'user-1', body: '完成 DAG', createdAt: 1 });
  await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1', uploaderId: 'user-1', filename: 'spec.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
  await repositories.artifacts.create({ id: 'artifact-other-channel', teamId: 'team-1', channelId: 'channel-2', uploaderId: 'user-1', filename: 'secret.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
  await repositories.tasks.create({ id: 'task-root', teamId: 'team-1', channelId: 'channel-1', title: 'Root', status: 'in_progress', creatorId: 'user-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1 });
  await repositories.tasks.create({ id: 'task-child', teamId: 'team-1', channelId: 'channel-1', title: 'Child', description: '执行 child', status: 'in_progress', creatorId: 'user-1', assigneeId: 'agent-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
  const managementKernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const { run } = await managementKernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'task-root', rootMessageId: 'message-1', requestKey: 'request-phase2', requestHash: 'hash-phase2', placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
  await managementKernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1, taskId: 'task-root', teamId: 'team-1', managementRunId: run.id, nodeKind: 'root', reviewPolicy: 'manager', claimPolicy: 'open', requiredCapabilities: [], attempt: 1, maxAttempts: 2, taskRevision: 1, createdAt: 1, updatedAt: 1 });
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1, taskId: 'task-child', teamId: 'team-1', rootTaskId: 'task-root', parentTaskId: 'task-root', managementRunId: run.id, nodeKind: 'subtask', reviewPolicy: 'manager', claimPolicy: 'open', requiredCapabilities: [], attempt: 1, maxAttempts: 2, taskRevision: 1, createdAt: 1, updatedAt: 1 });
  await repositories.taskCoordination.criteria.create({ id: 'criterion-child', taskId: 'task-child', description: '完成 child', evidenceRequired: true, introducedRevision: 1, position: 0 });
  await repositories.taskCoordination.claimLeases.create({ id: 'claim-child', teamId: 'team-1', taskId: 'task-child', taskRevision: 1, taskAttempt: 1, agentId: 'agent-1', leaseTokenHash: 'hash', leaseFingerprint: 'fingerprint', fencingToken: 1, status: 'active', acquiredAt: 1, heartbeatAt: 10, expiresAt: 100 });
  if (options.withDependency) {
    await repositories.tasks.create({ id: 'task-dependency', teamId: 'team-1', channelId: 'channel-1', title: 'Dependency', status: options.dependencyDone === false ? 'in_review' : 'done', creatorId: 'user-1', assigneeId: 'agent-1', tags: [], sortOrder: 2, createdAt: 1, updatedAt: 1 });
    await repositories.taskCoordination.coordinations.create({ schemaVersion: 1, taskId: 'task-dependency', teamId: 'team-1', rootTaskId: 'task-root', parentTaskId: 'task-root', managementRunId: run.id, nodeKind: 'subtask', reviewPolicy: 'manager', claimPolicy: 'open', requiredCapabilities: [], attempt: 1, maxAttempts: 2, taskRevision: 1, createdAt: 1, updatedAt: 1 });
    await repositories.taskCoordination.dependencies.create({ taskId: 'task-child', dependencyTaskId: 'task-dependency', taskRevision: 1 });
    if (options.dependencyDone !== false) {
      await repositories.taskCoordination.claimLeases.create({ id: 'claim-dependency', teamId: 'team-1', taskId: 'task-dependency', taskRevision: 1, taskAttempt: 1, agentId: 'agent-1', leaseTokenHash: 'hash-dep', leaseFingerprint: 'fingerprint-dep', fencingToken: 1, status: 'released', acquiredAt: 1, heartbeatAt: 10, expiresAt: 100, releasedAt: 15 });
      await repositories.taskCoordination.evidenceSnapshots.create({ id: 'snapshot-artifact', teamId: 'team-1', taskId: 'task-dependency', taskRevision: 1, taskAttempt: 1, invocationId: 'invocation-dependency', kind: 'artifact', sourceId: 'artifact-dependency', snapshotHash: 'sha256:artifact', snapshot: {}, capturedAt: 12 });
      await repositories.taskCoordination.evidenceSnapshots.create({ id: 'snapshot-workspace', teamId: 'team-1', taskId: 'task-dependency', taskRevision: 1, taskAttempt: 1, invocationId: 'invocation-dependency', kind: 'workspace-run', sourceId: 'workspace-dependency', snapshotHash: 'sha256:workspace', snapshot: {}, capturedAt: 12 });
      await repositories.taskCoordination.deliveries.create({ schemaVersion: 1, id: 'delivery-dependency', teamId: 'team-1', taskId: 'task-dependency', taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-dependency', invocationId: 'invocation-dependency', summary: 'dependency done', claims: [], evidenceRefs: [{ kind: 'artifact', id: 'artifact-dependency', snapshotHash: 'sha256:artifact', capturedAt: 12 }, { kind: 'workspace-run', id: 'workspace-dependency', snapshotHash: 'sha256:workspace', capturedAt: 12 }], idempotencyKey: 'delivery-dependency', createdAt: 12 });
      await repositories.taskCoordination.acceptances.create({ schemaVersion: 1, id: 'acceptance-dependency', teamId: 'team-1', taskId: 'task-dependency', deliveryId: 'delivery-dependency', expectedTaskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-dependency', decision: 'accepted', criteriaResults: [], reason: 'ok', decidedBy: 'manager', decidedAt: 14, decisionVersion: 1, canonical: true });
    }
  }
  return { repositories, gateway: createInvocationGateway({ repositories, clock, ids }), authority: { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 } };
}

function phase2InvokeInput(authority: { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number }) {
  return { authority, idempotencyKey: 'invoke-child', taskId: 'task-child', expectedTaskRevision: 1,
    taskAttempt: 1, claimLeaseId: 'claim-child', objective: '执行 child', attachmentIds: ['artifact-1'] };
}
