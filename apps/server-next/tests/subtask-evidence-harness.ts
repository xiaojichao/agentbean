import { createManagementKernel } from '../src/application/management/management-kernel.js';
import type { SubmitSubtaskDeliveryInput } from '../src/application/management/subtask-delivery-service.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

export async function createSubtaskEvidenceHarness(
  repositories: ServerNextRepositories = createInMemoryRepositories(),
) {
  let sequence = 0;
  let now = 20;
  const clock = { now: () => now };
  const ids = { nextId: () => `evidence-${++sequence}` };
  await repositories.users.create({ id: 'user-1', username: 'user', role: 'user',
    passwordHash: 'unused', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team',
    visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel',
    name: 'general', visibility: 'public', humanMemberIds: ['user-1'],
    agentMemberIds: ['agent-1'], createdAt: 1 });
  await repositories.channels.create({ id: 'channel-2', teamId: 'team-1', kind: 'channel',
    name: 'private', visibility: 'private', humanMemberIds: ['user-1'],
    agentMemberIds: [], createdAt: 1 });
  await repositories.agents.upsert({ id: 'agent-1', primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'], name: 'Agent', adapterKind: 'codex',
    category: 'executor-hosted', source: 'custom', status: 'online' });
  await repositories.messages.append({ id: 'root-message', teamId: 'team-1',
    channelId: 'channel-1', senderKind: 'human', senderId: 'user-1',
    body: '完成目标', createdAt: 1 });
  await repositories.tasks.create({ id: 'task-root', teamId: 'team-1', channelId: 'channel-1',
    title: 'Root', status: 'in_progress', creatorId: 'user-1', tags: [], sortOrder: 0,
    createdAt: 1, updatedAt: 1 });
  await repositories.tasks.create({ id: 'task-child', teamId: 'team-1', channelId: 'channel-1',
    title: 'Child', description: '完成 child', status: 'in_progress', creatorId: 'user-1',
    assigneeId: 'agent-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
  const managementKernel = createManagementKernel({ repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const { run } = await managementKernel.createOrResumeRun({ teamId: 'team-1',
    channelId: 'channel-1', rootTaskId: 'task-root', rootMessageId: 'root-message',
    requestKey: 'request-1', requestHash: 'hash-1', placementPolicy: { placement: 'device',
      allowServerContext: false, requireLocalModelCredentials: true },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
  await managementKernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 1_000 });
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1,
    taskId: 'task-root', teamId: 'team-1', managementRunId: run.id, nodeKind: 'root',
    reviewPolicy: 'manager', claimPolicy: 'open', requiredCapabilities: [], attempt: 1,
    maxAttempts: 2, taskRevision: 1, createdAt: 1, updatedAt: 1 });
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1,
    taskId: 'task-child', teamId: 'team-1', rootTaskId: 'task-root', parentTaskId: 'task-root',
    managementRunId: run.id, nodeKind: 'subtask', reviewPolicy: 'manager', claimPolicy: 'open',
    requiredCapabilities: [], attempt: 1, maxAttempts: 2, taskRevision: 1,
    createdAt: 1, updatedAt: 1 });
  await repositories.taskCoordination.criteria.create({ id: 'criterion-child',
    taskId: 'task-child', description: '必须提供消息证据', evidenceRequired: true,
    allowedEvidenceKinds: ['message'], introducedRevision: 1, position: 0 });
  await repositories.taskCoordination.claimLeases.create({ id: 'claim-child', teamId: 'team-1',
    taskId: 'task-child', taskRevision: 1, taskAttempt: 1, agentId: 'agent-1',
    leaseTokenHash: 'hash', leaseFingerprint: 'fingerprint', fencingToken: 1, status: 'active',
    acquiredAt: 1, heartbeatAt: 10, expiresAt: 1_000 });
  const intent = { schemaVersion: 1 as const, teamId: 'team-1',
      channelId: 'channel-1', targetAgentId: 'agent-1', targetKind: 'custom',
      objective: '完成 child', taskContext: { taskId: 'task-child', rootTaskId: 'task-root',
        taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-child' },
      acceptanceCriteria: [{ id: 'criterion-child', description: '必须提供消息证据',
        evidenceRequired: true, allowedEvidenceKinds: ['message'] }],
      dependencyResults: [], attachmentIds: [] } as const;
  await repositories.management.invocations.create({ schemaVersion: 1, id: 'invocation-1',
    managementRunId: run.id, intent,
    intentHash: createHash('sha256').update(canonicalizeAgentInvocationIntent(intent)).digest('hex'),
    idempotencyKey: 'invoke-1', createdAt: 10 });
  await repositories.dispatches.create({ id: 'dispatch-1', teamId: 'team-1',
    channelId: 'channel-1', messageId: 'root-message', agentId: 'agent-1', status: 'succeeded',
    requestId: 'management:invocation-1:1', prompt: '完成 child', createdAt: 10,
    updatedAt: 15, completedAt: 15 });
  await repositories.management.dispatchAttempts.create({ id: 'attempt-1',
    invocationId: 'invocation-1', dispatchId: 'dispatch-1', attemptNumber: 1,
    status: 'succeeded', startedAt: 10, completedAt: 15 });
  await repositories.messages.append({ id: 'delivery-message', teamId: 'team-1',
    channelId: 'channel-1', threadId: 'root-message', senderKind: 'agent', senderId: 'agent-1',
    body: 'child 已完成', createdAt: 15, meta: { dispatchId: 'dispatch-1' } });
  await repositories.workspaceRuns.create({ id: 'workspace-1', teamId: 'team-1',
    channelId: 'channel-1', messageId: 'delivery-message', sourceMessageId: 'root-message',
    dispatchId: 'dispatch-1', agentId: 'agent-1', status: 'succeeded', command: 'npm test',
    exitCode: 0, startedAt: 11, completedAt: 14, createdAt: 11, updatedAt: 14,
    artifactIds: ['artifact-1'] });
  await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1',
    channelId: 'channel-1', messageId: 'delivery-message', dispatchId: 'dispatch-1',
    workspaceRunId: 'workspace-1', uploaderId: 'agent-1', filename: 'result.txt',
    mimeType: 'text/plain', sizeBytes: 12, sha256: 'artifact-sha', createdAt: 14 });
  await repositories.artifacts.create({ id: 'artifact-private', teamId: 'team-1',
    channelId: 'channel-2', uploaderId: 'user-1', filename: 'secret.txt',
    mimeType: 'text/plain', sizeBytes: 1, createdAt: 14 });

  const authority = { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token',
    fencingToken: 1 };
  const deliveryInput: SubmitSubtaskDeliveryInput = { authority,
    idempotencyKey: 'delivery-1', taskId: 'task-child', expectedTaskRevision: 1,
    taskAttempt: 1, claimLeaseId: 'claim-child', invocationId: 'invocation-1',
    summary: 'child 已完成', locators: [{ kind: 'message', id: 'delivery-message' },
      { kind: 'artifact', id: 'artifact-1' }, { kind: 'workspace-run', id: 'workspace-1' },
      { kind: 'invocation', id: 'invocation-1' }, { kind: 'task', id: 'task-child' }] };
  return { repositories, clock, ids, authority, deliveryInput, run,
    setNow(value: number) { now = value; } };
}
import { createHash } from 'node:crypto';
import { canonicalizeAgentInvocationIntent } from '../../../packages/domain/src/index.js';
