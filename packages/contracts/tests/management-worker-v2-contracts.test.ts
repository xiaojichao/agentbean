import { describe, expect, test } from 'vitest';

import {
  PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES,
  parseAgentCollaborationProposalV1,
  parseManagementWorkerRegisterV2,
  parseManagementWorkerSessionContextV2,
  parsePhase2TaskToolRequestV2,
  parsePhase2TaskToolResultV2,
} from '../src/index.js';

describe('Phase 2 management worker contracts', () => {
  test('parses exact external collaboration proposals and rejects hidden fields', () => {
    const proposal = { schemaVersion: 1, sourceInvocationId: 'invocation-a', sourceAgentId: 'agent-a',
      sourceTaskContext: { taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'claim-a' },
      toAgentId: 'agent-b', kind: 'consult', objective: '请 B 复核', reason: '需要第二视角',
      contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
      returnMode: 'return_to_manager' };
    expect(parseAgentCollaborationProposalV1(proposal)).toEqual(proposal);
    expect(() => parseAgentCollaborationProposalV1({ ...proposal, providerSecret: 'forbidden' }))
      .toThrow('AGENT_COLLABORATION_PROPOSAL_INVALID');
  });

  test('freezes Phase 1 plus Task and serial handoff tools without Memory tools', () => {
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).toHaveLength(22);
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).toContain('tasks.create_subtasks');
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).toContain('tasks.report_blocked');
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).toContain('agents.list_available');
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).toContain('handoffs.request');
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).toContain('handoffs.await_result');
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).not.toContain('memory.search' as never);
  });

  test('parses an exact V2 worker registration and rejects phase drift', () => {
    const value = {
      schemaVersion: 2,
      workerInstanceId: 'worker-instance-1',
      profileId: 'profile-1',
      runtimeVersion: '0.1.0',
      supportedProtocolVersions: [1, 2],
      supportedPhases: [1, 2],
      credentialStatus: 'production_ready',
      providerId: 'provider-1',
      modelId: 'model-1',
      capacity: { maxConcurrentLeases: 2, activeLeaseCount: 0 },
    };
    expect(parseManagementWorkerRegisterV2(value)).toEqual(value);
    expect(() => parseManagementWorkerRegisterV2({ ...value, supportedPhases: [1] }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parseManagementWorkerRegisterV2({ ...value, secret: 'forbidden' }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
  });

  test('allows a target-free Phase 2 session context but requires a root Task', () => {
    const value = {
      schemaVersion: 2,
      managementPhase: 2,
      teamId: 'team-1',
      channelId: 'channel-1',
      rootMessageId: 'message-1',
      rootTaskId: 'task-root',
      visibleThread: { revision: 1, messages: [] },
    };
    expect(parseManagementWorkerSessionContextV2(value)).toEqual(value);
    const { rootTaskId: _rootTaskId, ...withoutRootTask } = value;
    expect(() => parseManagementWorkerSessionContextV2(withoutRootTask))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parseManagementWorkerSessionContextV2({
      ...value,
      frozenTarget: { agentId: '', kind: 'unknown' },
    })).toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
  });

  test('parses Phase 2 Task tools and claim-bound agents.invoke with write authority', () => {
    const value = {
      schemaVersion: 2,
      managementPhase: 2,
      commandId: 'command-1',
      managementRunId: 'run-1',
      workerId: 'worker-1',
      toolCallId: 'tool-call-1',
      toolName: 'tasks.wait',
      leaseToken: 'lease-token',
      fencingToken: 1,
      idempotencyKey: 'idempotency-1',
      input: { taskIds: ['task-1'] },
    };
    expect(parsePhase2TaskToolRequestV2(value)).toEqual(value);
    expect(parsePhase2TaskToolRequestV2({
      ...value,
      toolName: 'agents.invoke',
      input: {
        taskId: 'task-1', expectedTaskRevision: 3, taskAttempt: 2, claimLeaseId: 'claim-1',
        objective: '完成子任务', attachmentIds: ['artifact-1'], deadlineAt: 1_000,
      },
    })).toMatchObject({ schemaVersion: 2, managementPhase: 2, toolName: 'agents.invoke' });
    expect(parsePhase2TaskToolRequestV2({
      ...value,
      toolName: 'agents.invoke',
      input: {
        taskId: 'task-1', expectedTaskRevision: 3, taskAttempt: 2, claimLeaseId: 'claim-1',
        targetAgentId: 'agent-local-guess', objective: '完成子任务', attachmentIds: [],
      },
    })).toMatchObject({ toolName: 'agents.invoke', input: { targetAgentId: 'agent-local-guess' } });
    expect(() => parsePhase2TaskToolRequestV2({ ...value, leaseToken: '' }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parsePhase2TaskToolRequestV2({
      ...value,
      toolName: 'context.get_root_task',
      input: {},
    })).toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    for (const field of ['commandId', 'workerId', 'toolCallId', 'idempotencyKey'] as const) {
      expect(() => parsePhase2TaskToolRequestV2({ ...value, [field]: '' }))
        .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    }
    expect(() => parsePhase2TaskToolRequestV2({ ...value, input: { taskIds: ['task-1'], prompt: 'forbidden' } }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
  });

  test('parses serial handoff requests and results with exact proposal fences', () => {
    const envelope = {
      schemaVersion: 2,
      managementPhase: 2,
      commandId: 'command-handoff',
      managementRunId: 'run-1',
      workerId: 'worker-1',
      toolCallId: 'tool-handoff',
      leaseToken: 'lease-token',
      fencingToken: 1,
      idempotencyKey: 'handoff-1',
    };
    expect(parsePhase2TaskToolRequestV2({
      ...envelope,
      toolName: 'agents.list_available',
      input: { includeBusy: false },
    })).toMatchObject({ toolName: 'agents.list_available' });
    expect(parsePhase2TaskToolRequestV2({
      ...envelope,
      toolName: 'handoffs.request',
      input: {
        sourceProposalId: 'proposal-1',
        sourceInvocationId: 'invocation-a',
        toAgentId: 'agent-b',
        kind: 'continuation',
        objective: '继续完成剩余工作',
        reason: 'Agent B 更适合收尾',
        contextRefIds: ['message-1'],
        dependencyInvocationIds: ['invocation-a'],
        attachmentIds: [],
        acceptanceCriteria: [],
        returnMode: 'deliver_to_root',
      },
    })).toMatchObject({ toolName: 'handoffs.request', input: { kind: 'continuation' } });
    expect(parsePhase2TaskToolResultV2({
      schemaVersion: 2,
      managementPhase: 2,
      commandId: envelope.commandId,
      managementRunId: envelope.managementRunId,
      workerId: envelope.workerId,
      toolCallId: envelope.toolCallId,
      toolName: 'handoffs.request',
      ok: true,
      output: { handoffId: 'handoff-1', invocationId: 'invocation-b', status: 'requested' },
    })).toMatchObject({ toolName: 'handoffs.request', output: { status: 'requested' } });
    expect(parsePhase2TaskToolResultV2({
      schemaVersion: 2, managementPhase: 2, commandId: envelope.commandId,
      managementRunId: envelope.managementRunId, workerId: envelope.workerId,
      toolCallId: envelope.toolCallId, toolName: 'handoffs.await_result', ok: true,
      output: { handoffId: 'handoff-1', invocationId: 'invocation-b', status: 'returned',
        result: { schemaVersion: 1, invocationId: 'invocation-b', agentId: 'agent-b',
          status: 'succeeded', body: '内部结果', artifactIds: [], memoryCandidateIds: [],
          startedAt: 1, completedAt: 2 } },
    })).toMatchObject({ toolName: 'handoffs.await_result',
      output: { result: { body: '内部结果' } } });
    expect(() => parsePhase2TaskToolRequestV2({
      ...envelope,
      toolName: 'handoffs.request',
      input: {
        toAgentId: 'agent-b', kind: 'delegate', objective: '并行做', reason: 'no',
        contextRefIds: [], dependencyInvocationIds: [], attachmentIds: [],
        acceptanceCriteria: [], returnMode: 'return_to_manager',
      },
    })).toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
  });

  test('parses exact Phase 2 Task tool results and rejects envelope drift', () => {
    const value = {
      schemaVersion: 2, managementPhase: 2, commandId: 'command-1',
      managementRunId: 'run-1', workerId: 'worker-1', toolCallId: 'call-1',
      toolName: 'tasks.wait', ok: true,
      output: { readyTaskIds: ['task-ready'], waitingTaskIds: ['task-waiting'], taskSnapshots: [
        { taskId: 'task-ready', taskRevision: 1, taskAttempt: 1, status: 'done' },
        { taskId: 'task-waiting', taskRevision: 2, taskAttempt: 1,
          status: 'in_progress', claimLeaseId: 'claim-1', claimedAgentId: 'agent-1' },
      ] },
    };
    expect(parsePhase2TaskToolResultV2(value)).toEqual(value);
    expect(() => parsePhase2TaskToolResultV2({ ...value, managementPhase: 1 }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parsePhase2TaskToolResultV2({ ...value, providerSecret: 'forbidden' }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parsePhase2TaskToolResultV2({ ...value,
      output: { ...value.output, localGuess: true } }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parsePhase2TaskToolResultV2({ ...value, diagnosticCode: 'should-not-exist' }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);

    const invokeResult = { ...value, toolName: 'agents.invoke', output: {
      invocationId: 'invocation-1', status: 'succeeded', deliveryId: 'delivery-1',
      evidenceRefs: [{ kind: 'message', id: 'message-1', snapshotHash: 'server-hash',
        snapshotRevision: 2, capturedAt: 20 }],
    } };
    expect(parsePhase2TaskToolResultV2(invokeResult)).toEqual(invokeResult);
    expect(() => parsePhase2TaskToolResultV2({ ...invokeResult,
      output: { invocationId: 'invocation-1', status: 'succeeded' } }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parsePhase2TaskToolResultV2({ ...invokeResult,
      output: { ...invokeResult.output, evidenceRefs: [{ ...invokeResult.output.evidenceRefs[0],
        snapshotHash: '' }] } })).toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
  });

  test('parses dependency inputs and rejects invalid subtask policy or evidence kinds', () => {
    const envelope = {
      schemaVersion: 2,
      managementPhase: 2,
      commandId: 'command-1',
      managementRunId: 'run-1',
      workerId: 'worker-1',
      toolCallId: 'tool-call-1',
      leaseToken: 'lease-token',
      fencingToken: 1,
      idempotencyKey: 'idempotency-1',
    };
    expect(parsePhase2TaskToolRequestV2({
      ...envelope,
      toolName: 'tasks.add_dependency',
      input: { taskId: 'task-1', dependencyTaskId: 'task-0', expectedTaskRevision: 1 },
    })).toMatchObject({ toolName: 'tasks.add_dependency' });
    const draft = {
      clientKey: 'draft-1',
      title: 'Implement slice',
      claimPolicy: 'open',
      requiredCapabilities: [],
      acceptanceCriteria: [{ id: 'criterion-1', description: 'Verified', evidenceRequired: true, allowedEvidenceKinds: ['task'] }],
      maxAttempts: 2,
    };
    expect(() => parsePhase2TaskToolRequestV2({
      ...envelope,
      toolName: 'tasks.create_subtasks',
      input: { parentTaskId: 'task-root', subtasks: [{ ...draft, targetAgentId: '' }] },
    })).toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parsePhase2TaskToolRequestV2({
      ...envelope,
      toolName: 'tasks.create_subtasks',
      input: {
        parentTaskId: 'task-root',
        subtasks: [{ ...draft, acceptanceCriteria: [{ ...draft.acceptanceCriteria[0], allowedEvidenceKinds: ['provider-secret'] }] }],
      },
    })).toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
  });
});
