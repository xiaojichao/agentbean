import { describe, expect, test, vi } from 'vitest';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createManagementToolExecutor, createPhase2InvocationToolHandlers, createPhase2ManagementToolHandlers } from '../src/application/management/management-tool-executor.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import { createSubtaskAcceptanceService } from '../src/application/management/subtask-acceptance-service.js';
import { createInMemoryManagementPersistence } from '../src/infra/memory/management-repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { createSubtaskEvidenceHarness } from './subtask-evidence-harness.js';

describe('management tool executor', () => {
  test('routes agents.invoke by envelope version without overriding the frozen-target Phase 1 handler', async () => {
    const phase1 = vi.fn(async () => ({ invocationId: 'phase1-invocation', status: 'succeeded' as const }));
    const phase2 = vi.fn(async () => ({ invocationId: 'phase2-invocation', status: 'succeeded' as const,
      deliveryId: 'phase2-delivery', evidenceRefs: [{ kind: 'message' as const,
        id: 'phase2-message', snapshotHash: 'server-hash', capturedAt: 1 }] }));
    const execute = createManagementToolExecutor({
      kernel: { authorizeWrite: vi.fn() } as never,
      handlers: { 'agents.invoke': phase1 },
      phase2Handlers: { 'agents.invoke': phase2 },
    });
    const authority = { commandId: 'command', managementRunId: 'run-1', workerId: 'worker-1',
      toolCallId: 'call', toolName: 'agents.invoke' as const, leaseToken: 'token', fencingToken: 1,
      idempotencyKey: 'key' };
    await expect(execute({ schemaVersion: 1, ...authority,
      input: { objective: 'Phase 1', attachmentIds: [] } })).resolves.toMatchObject({
      schemaVersion: 1, ok: true, output: { invocationId: 'phase1-invocation' },
    });
    await expect(execute({ schemaVersion: 2, managementPhase: 2, ...authority,
      input: { taskId: 'task-1', expectedTaskRevision: 1, taskAttempt: 1,
        claimLeaseId: 'claim-1', objective: 'Phase 2', attachmentIds: [] } })).resolves.toMatchObject({
      schemaVersion: 2, managementPhase: 2, ok: true,
      output: { invocationId: 'phase2-invocation' },
    });
    expect(phase1).toHaveBeenCalledTimes(1);
    expect(phase2).toHaveBeenCalledTimes(1);
  });

  test('allows wired reads but fences writes before reporting later-task handlers unavailable', async () => {
    const persistence = createInMemoryManagementPersistence();
    let id = 0;
    const kernel = createManagementKernel({ ...persistence, clock: { now: () => 10 }, ids: { nextId: () => `id-${++id}` } });
    const { run } = await kernel.createOrResumeRun({
      teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1',
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 2, maxDepth: 1, maxExternalInvocations: 2 },
    });
    await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
    const execute = createManagementToolExecutor({
      kernel,
      handlers: {
        'context.get_management_state': async () => ({ status: 'running', checkpointRevision: 0, lastEventSequence: 2 }),
      },
    });

    await expect(execute({ schemaVersion: 1, commandId: 'command-read', managementRunId: run.id, workerId: 'worker-1', toolCallId: 'tool-read', toolName: 'context.get_management_state', input: {} })).resolves.toMatchObject({ ok: true, output: { lastEventSequence: 2 } });
    await expect(execute({ schemaVersion: 1, commandId: 'command-write', managementRunId: run.id, workerId: 'worker-1', toolCallId: 'tool-write', toolName: 'agents.invoke', input: { objective: 'do work', attachmentIds: [] }, leaseToken: 'token', fencingToken: 1, idempotencyKey: 'invoke-1' })).resolves.toMatchObject({ ok: false, errorCode: 'UNAVAILABLE', diagnosticCode: 'TOOL_NOT_WIRED' });
    await expect(execute({ schemaVersion: 1, commandId: 'command-stale', managementRunId: run.id, workerId: 'worker-1', toolCallId: 'tool-stale', toolName: 'agents.invoke', input: { objective: 'do work', attachmentIds: [] }, leaseToken: 'token', fencingToken: 2, idempotencyKey: 'invoke-2' })).resolves.toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED', diagnosticCode: 'LEASE_FUTURE_FENCING_TOKEN' });
  });

  test('does not echo arbitrary handler errors through client diagnostics', async () => {
    const persistence = createInMemoryManagementPersistence();
    const kernel = createManagementKernel({ ...persistence, clock: { now: () => 10 }, ids: { nextId: () => 'unused' } });
    const execute = createManagementToolExecutor({ kernel, handlers: { 'context.get_root_message': async () => { throw new Error('provider secret sk-live-123'); } } });
    const result = await execute({ schemaVersion: 1, commandId: 'command-1', managementRunId: 'run-1', workerId: 'worker-1', toolCallId: 'tool-1', toolName: 'context.get_root_message', input: {} });
    expect(result).toMatchObject({ ok: false, diagnosticCode: 'TOOL_EXECUTION_FAILED' });
    expect(JSON.stringify(result)).not.toContain('sk-live-123');
  });

  test('routes Phase 2 Task tools through the coordination kernel and reads wait state from Server truth', async () => {
    const repositories = createInMemoryRepositories();
    let sequence = 0;
    const clock = { now: () => 100 };
    const ids = { nextId: () => sequence++ === 0 ? 'run-1' : `id-${sequence}` };
    await repositories.tasks.create({ id: 'root-task', teamId: 'team-1', title: 'Root',
      description: 'root objective', status: 'todo', creatorId: 'user-1', channelId: 'channel-1',
      tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1 });
    const managementKernel = createManagementKernel({ repositories: repositories.management,
      unitOfWork: repositories.managementUnitOfWork, clock, ids });
    await managementKernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1',
      rootTaskId: 'root-task', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1',
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
    await managementKernel.acquireLease({ managementRunId: 'run-1', workerId: 'worker-1',
      host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'lease-token', ttlMs: 1_000 });
    const taskKernel = createTaskCoordinationKernel({ unitOfWork: repositories.taskCoordinationUnitOfWork,
      clock, ids });
    const authority = { managementRunId: 'run-1', workerId: 'worker-1', leaseToken: 'lease-token', fencingToken: 1 };
    await taskKernel.createRootCoordination({ authority, idempotencyKey: 'root-coordination',
      taskId: 'root-task', claimPolicy: 'open', requiredCapabilities: [], acceptanceCriteria: [], maxAttempts: 1 });
    const acceptanceService = createSubtaskAcceptanceService({
      unitOfWork: repositories.taskCoordinationUnitOfWork, clock, ids });
    const execute = createManagementToolExecutor({ kernel: managementKernel,
      handlers: createPhase2ManagementToolHandlers({ kernel: taskKernel, acceptanceService }) });
    const envelope = { schemaVersion: 2 as const, managementPhase: 2 as const,
      managementRunId: 'run-1', workerId: 'worker-1', leaseToken: 'lease-token', fencingToken: 1 };

    const created = await execute({ ...envelope, commandId: 'create-1', toolCallId: 'call-create',
      toolName: 'tasks.create_subtasks', idempotencyKey: 'create-subtasks', input: {
        parentTaskId: 'root-task', subtasks: [{ clientKey: 'research', title: 'Research',
          claimPolicy: 'open', requiredCapabilities: ['research'], acceptanceCriteria: [], maxAttempts: 2 }],
      } });
    expect(created).toMatchObject({ schemaVersion: 2, managementPhase: 2, ok: true });
    if (!created.ok || created.toolName !== 'tasks.create_subtasks') throw new Error('missing task result');
    const taskId = created.output.taskIds[0]!;
    await expect(execute({ ...envelope, commandId: 'wait-1', toolCallId: 'call-wait',
      toolName: 'tasks.wait', idempotencyKey: 'wait-1', input: { taskIds: [taskId] } }))
      .resolves.toMatchObject({ ok: true, output: { readyTaskIds: [], waitingTaskIds: [taskId] } });
    await taskKernel.transitionTaskState({ authority, idempotencyKey: 'review-task', taskId,
      expectedTaskRevision: 1, from: 'todo', to: 'in_review' });
    await expect(execute({ ...envelope, commandId: 'wait-2', toolCallId: 'call-wait-2',
      toolName: 'tasks.wait', idempotencyKey: 'wait-2', input: { taskIds: [taskId] } }))
      .resolves.toMatchObject({ ok: true, output: { readyTaskIds: [taskId], waitingTaskIds: [] } });
    await expect(execute({ ...envelope, commandId: 'retry-stale', toolCallId: 'call-retry',
      toolName: 'tasks.retry', idempotencyKey: 'retry-stale', input: {
        taskId, expectedTaskRevision: 2, reasonCode: 'RETRY',
      } })).resolves.toMatchObject({ ok: false, errorCode: 'CONFLICT', diagnosticCode: 'TASK_REVISION_FUTURE' });
  });

  test('wires all eight Phase 2 Task tools to coordination kernel commands', async () => {
    const kernel = {
      createSubtasks: vi.fn(async () => ({ taskIds: ['task-1'], taskGraphRevision: 2 })),
      addDependency: vi.fn(async () => ({ taskId: 'task-1', taskRevision: 2, taskGraphRevision: 3 })),
      publishForClaim: vi.fn(async () => ({ taskId: 'task-1', taskRevision: 2, status: 'todo' })),
      assignTask: vi.fn(async () => ({ taskId: 'task-1', taskRevision: 3, agentId: 'agent-1' })),
      waitForTasks: vi.fn(async () => ({ readyTaskIds: [], waitingTaskIds: ['task-1'], taskSnapshots: [
        { taskId: 'task-1', taskRevision: 1, taskAttempt: 1, status: 'todo' as const },
      ] })),
      retryTask: vi.fn(async () => ({ taskId: 'task-1', taskRevision: 3, attempt: 2 })),
      acceptSubtask: vi.fn(async () => ({ taskId: 'task-1', taskRevision: 3, status: 'done' })),
      reportBlocked: vi.fn(async () => ({ taskId: 'task-1', status: 'todo', reportedAt: 100 })),
    };
    const handlers = createPhase2ManagementToolHandlers({ kernel: kernel as never,
      acceptanceService: { decide: kernel.acceptSubtask } as never });
    expect(Object.keys(handlers).sort()).toEqual([
      'tasks.accept_subtask', 'tasks.add_dependency', 'tasks.assign', 'tasks.create_subtasks',
      'tasks.publish_for_claim', 'tasks.report_blocked', 'tasks.retry', 'tasks.wait',
    ]);
    const base = { schemaVersion: 2 as const, managementPhase: 2 as const, commandId: 'command',
      managementRunId: 'run-1', workerId: 'worker-1', toolCallId: 'call', leaseToken: 'token',
      fencingToken: 1, idempotencyKey: 'key' };
    await handlers['tasks.add_dependency']!({ ...base, toolName: 'tasks.add_dependency',
      input: { taskId: 'task-1', dependencyTaskId: 'task-0', expectedTaskRevision: 1 } });
    await handlers['tasks.publish_for_claim']!({ ...base, toolName: 'tasks.publish_for_claim',
      input: { taskId: 'task-1', expectedTaskRevision: 1 } });
    await handlers['tasks.assign']!({ ...base, toolName: 'tasks.assign',
      input: { taskId: 'task-1', agentId: 'agent-1', expectedTaskRevision: 2 } });
    await handlers['tasks.retry']!({ ...base, toolName: 'tasks.retry',
      input: { taskId: 'task-1', expectedTaskRevision: 3, reasonCode: 'RETRY' } });
    await handlers['tasks.report_blocked']!({ ...base, toolName: 'tasks.report_blocked',
      input: { taskId: 'task-1', expectedTaskRevision: 3, reasonCode: 'BLOCKED' } });
    expect(kernel.addDependency).toHaveBeenCalledTimes(1);
    expect(kernel.publishForClaim).toHaveBeenCalledTimes(1);
    expect(kernel.assignTask).toHaveBeenCalledTimes(1);
    expect(kernel.retryTask).toHaveBeenCalledTimes(1);
    expect(kernel.reportBlocked).toHaveBeenCalledTimes(1);
  });

  test('finalizes a succeeded Phase 2 Invocation into a canonical delivery result', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const handlers = createPhase2InvocationToolHandlers({ repositories: harness.repositories,
      kernel: { recordInvocationTerminal: vi.fn() } as never, clock: harness.clock,
      ids: harness.ids, onDispatchCreated: vi.fn() });
    const result = await handlers['agents.invoke']!({ schemaVersion: 2, managementPhase: 2,
      commandId: 'command-invoke', managementRunId: harness.run.id, workerId: 'worker-1',
      toolCallId: 'call-invoke', toolName: 'agents.invoke', leaseToken: 'token', fencingToken: 1,
      idempotencyKey: 'invoke-1', input: { taskId: 'task-child', expectedTaskRevision: 1,
        taskAttempt: 1, claimLeaseId: 'claim-child', objective: '完成 child', attachmentIds: [] } });
    expect(result).toMatchObject({ invocationId: 'invocation-1', status: 'succeeded',
      deliveryId: expect.any(String), evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ kind: 'message', id: 'delivery-message' }),
      ]) });
    await expect(handlers['agents.invoke']!({ schemaVersion: 2, managementPhase: 2,
      commandId: 'command-invoke-replay', managementRunId: harness.run.id, workerId: 'worker-1',
      toolCallId: 'call-invoke-replay', toolName: 'agents.invoke', leaseToken: 'token', fencingToken: 1,
      idempotencyKey: 'invoke-1', input: { taskId: 'task-child', expectedTaskRevision: 1,
        taskAttempt: 1, claimLeaseId: 'claim-child', objective: '完成 child', attachmentIds: [] } }))
      .resolves.toEqual(result);
    await expect(harness.repositories.tasks.getById('task-child'))
      .resolves.toMatchObject({ status: 'in_review' });
  });
});
