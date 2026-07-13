import { describe, expect, test } from 'vitest';

import {
  PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES,
  parseManagementWorkerRegisterV2,
  parseManagementWorkerSessionContextV2,
  parsePhase2TaskToolRequestV2,
} from '../src/index.js';

describe('Phase 2 management worker contracts', () => {
  test('freezes Phase 1 plus eight Task tools without Memory tools', () => {
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).toHaveLength(19);
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).toContain('tasks.create_subtasks');
    expect(PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES).toContain('tasks.report_blocked');
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
  });

  test('parses only Phase 2 Task tool requests with write authority', () => {
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
    expect(() => parsePhase2TaskToolRequestV2({ ...value, toolName: 'agents.invoke' }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parsePhase2TaskToolRequestV2({ ...value, leaseToken: '' }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
    expect(() => parsePhase2TaskToolRequestV2({ ...value, input: { taskIds: ['task-1'], prompt: 'forbidden' } }))
      .toThrow(/MANAGEMENT_WORKER_V2_PAYLOAD_INVALID/);
  });
});
