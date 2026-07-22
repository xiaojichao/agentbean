import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('Phase 2 Task DAG view', () => {
  test('returns a permission-filtered DAG with dependency, claim, attempt, acceptance and raw result refs', async () => {
    const repositories = createInMemoryRepositories();
    await seed(repositories);
    let id = 0;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: () => `generated-${++id}` },
    });

    const result = await app.getTaskDag({ userId: 'user-1', teamId: 'team-1', rootTaskId: 'task-child' });
    expect(result).toMatchObject({
      ok: true,
      dag: {
        rootTaskId: 'task-root',
        graphRevision: 2,
        events: [{ sequence: 1 }, { sequence: 2 }],
      },
    });
    if (!result.ok) throw new Error('Task DAG expected');
    expect(result.dag.nodes).toHaveLength(2);
    expect(result.dag.nodes.find((node) => node.task.id === 'task-child')).toMatchObject({
      taskRevision: 1,
      coordination: {
        parentTaskId: 'task-root',
        dependencyTaskIds: ['task-root'],
        attempt: 2,
      },
      claim: { agentId: 'agent-1', status: 'active', taskAttempt: 2 },
      latestDelivery: { id: 'delivery-1', invocationId: 'invocation-1' },
      canonicalAcceptance: { decision: 'accepted', decidedBy: 'manager' },
      resultRefs: [
        { kind: 'invocation', id: 'invocation-1' },
        { kind: 'message', id: 'message-result' },
      ],
    });
    await expect(app.getTaskDag({ userId: 'outsider', teamId: 'team-1', rootTaskId: 'task-root' }))
      .resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('projects root task immutable revision history with change reason (#709 AC7)', async () => {
    const repositories = createInMemoryRepositories();
    await seed(repositories);
    let id = 0;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: () => `generated-${++id}` },
    });
    // 模拟重大变化创建不可变 revision 2（append-only，保留 revision 1 历史 + 变更原因）。
    // 生产 reviseInTransaction 把新 objective 写入 description（非 title），故此处改 description 以反映真实行为。
    await repositories.tasks.updateAtRevision({
      taskId: 'task-root',
      expectedRevision: 1,
      nextRevision: 2,
      reasonCode: 'TASK_REVISED',
      changes: { description: 'Root revised objective', updatedAt: 10 },
    });

    const result = await app.getTaskDag({ userId: 'user-1', teamId: 'team-1', rootTaskId: 'task-root' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected dag');
    expect(result.dag.revisionHistory).toEqual([
      expect.objectContaining({
        revision: 1, objective: 'Root', superseded: true,
        supersededByRevision: 2, supersededReasonCode: 'TASK_REVISED',
      }),
      expect.objectContaining({
        revision: 2, objective: 'Root revised objective', superseded: false, supersededByRevision: null,
      }),
    ]);
  });
});

async function seed(repositories: ReturnType<typeof createInMemoryRepositories>) {
  await repositories.users.create({ id: 'user-1', username: 'owner', role: 'user', passwordHash: 'hash', primaryTeamId: 'team-1', currentTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', username: 'owner', role: 'owner', joinedAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'all', visibility: 'public', createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'] });
  await repositories.tasks.create({ id: 'task-root', teamId: 'team-1', title: 'Root', status: 'in_progress', creatorId: 'user-1', channelId: 'channel-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
  await repositories.tasks.create({ id: 'task-child', teamId: 'team-1', title: 'Child', status: 'done', creatorId: 'user-1', assigneeId: 'agent-1', channelId: 'channel-1', tags: [], sortOrder: 2, createdAt: 2, updatedAt: 2 });
  await repositories.management.runs.create({
    schemaVersion: 2, managementPhase: 2, id: 'run-1', teamId: 'team-1', channelId: 'channel-1',
    rootTaskId: 'task-root', rootMessageId: 'message-root', mode: 'managed', status: 'running',
    placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
    checkpointRevision: 0, budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
    createdAt: 1, updatedAt: 2,
  });
  for (const [sequence, taskId] of [[1, 'task-root'], [2, 'task-child']] as const) {
    await repositories.management.events.append({
      event: { schemaVersion: 1, id: `event-${sequence}`, managementRunId: 'run-1', sequence,
        type: 'task-created', actorKind: 'manager', actorId: 'worker-1', idempotencyKey: `event-${sequence}`,
        payload: { taskId, ...(taskId === 'task-child' ? { parentTaskId: 'task-root' } : {}), taskRevision: 1 },
        createdAt: sequence },
      payloadHash: `hash-${sequence}`,
    });
  }
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1, taskId: 'task-root', teamId: 'team-1', managementRunId: 'run-1', rootTaskId: 'task-root', nodeKind: 'root', reviewPolicy: 'human', claimPolicy: 'open', requiredCapabilities: [], taskRevision: 1, attempt: 1, maxAttempts: 1, createdAt: 1, updatedAt: 1 });
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1, taskId: 'task-child', teamId: 'team-1', managementRunId: 'run-1', rootTaskId: 'task-root', parentTaskId: 'task-root', nodeKind: 'subtask', reviewPolicy: 'manager', claimPolicy: 'open', requiredCapabilities: ['research'], taskRevision: 1, attempt: 2, maxAttempts: 3, createdAt: 2, updatedAt: 2 });
  await repositories.taskCoordination.criteria.create({ taskId: 'task-child', id: 'criterion-1', description: '完成研究', evidenceRequired: true, introducedRevision: 1, position: 0 });
  await repositories.taskCoordination.dependencies.create({ taskId: 'task-child', dependencyTaskId: 'task-root', taskRevision: 1 });
  await repositories.taskCoordination.claimLeases.create({ id: 'claim-1', teamId: 'team-1', taskId: 'task-child', taskRevision: 1, taskAttempt: 2, agentId: 'agent-1', leaseTokenHash: 'secret-hash', leaseFingerprint: 'fingerprint', fencingToken: 2, status: 'active', acquiredAt: 3, heartbeatAt: 3, expiresAt: 30 });
  await repositories.management.invocations.create({ schemaVersion: 1, id: 'invocation-1', managementRunId: 'run-1', intent: { schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1', targetKind: 'custom', objective: 'Child', taskContext: { taskId: 'task-child', rootTaskId: 'task-root', taskRevision: 1, taskAttempt: 2, claimLeaseId: 'claim-1' }, acceptanceCriteria: [], dependencyResults: [], attachmentIds: [] }, intentHash: 'intent-hash', idempotencyKey: 'invocation-key', createdAt: 3 });
  await repositories.taskCoordination.evidenceSnapshots.create({ id: 'snapshot-1', teamId: 'team-1', taskId: 'task-child', taskRevision: 1, taskAttempt: 2, invocationId: 'invocation-1', kind: 'message', sourceId: 'message-result', snapshotHash: 'snapshot-hash', snapshot: {}, capturedAt: 4 });
  await repositories.taskCoordination.deliveries.create({ schemaVersion: 1, id: 'delivery-1', teamId: 'team-1', taskId: 'task-child', taskRevision: 1, taskAttempt: 2, claimLeaseId: 'claim-1', invocationId: 'invocation-1', idempotencyKey: 'delivery-key', summary: '研究完成', claims: [], evidenceRefs: [{ kind: 'message', id: 'message-result', snapshotHash: 'snapshot-hash', capturedAt: 4 }], createdAt: 4 });
  await repositories.taskCoordination.acceptances.create({ schemaVersion: 1, id: 'acceptance-1', teamId: 'team-1', taskId: 'task-child', deliveryId: 'delivery-1', expectedTaskRevision: 1, taskAttempt: 2, claimLeaseId: 'claim-1', decision: 'accepted', criteriaResults: [{ criterionId: 'criterion-1', passed: true, evidenceRefs: [] }], reason: '证据完整', decidedBy: 'manager', decidedAt: 5, decisionVersion: 1, canonical: true });
}
