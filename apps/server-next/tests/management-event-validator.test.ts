import { describe, expect, test } from 'vitest';
import {
  hashManagementCommandInput,
  hashManagementEventPayload,
  parseMemoryToolManagementEvent,
  parsePhase1ManagementEvent,
  parseTaskCoordinationManagementEvent,
} from '../src/application/management/management-event-validator.js';

describe('Phase 3 Memory tool receipt validator', () => {
  test('accepts an exact body-free receipt and rejects payload drift', () => {
    const event = {
      schemaVersion: 1, id: 'event-memory', managementRunId: 'run-1', sequence: 2,
      type: 'memory-tool-completed', actorKind: 'manager', actorId: 'worker-1',
      idempotencyKey: 'memory-command', payload: {
        toolName: 'memory.create_capsule', resultReferenceId: 'capsule-1', requestHash: 'sha256:request',
        output: { capsuleRef: { schemaVersion: 1, id: 'capsule-1', teamId: 'team-1',
          managementRunId: 'run-1', targetAgentId: 'agent-1', contentHash: 'sha256:content',
          authorizationDecisionId: 'decision-1', expiresAt: 100 } },
      }, createdAt: 10,
    } as const;
    expect(parseMemoryToolManagementEvent(event)).toEqual(event);
    expect(() => parseMemoryToolManagementEvent({ ...event,
      payload: { ...event.payload, prompt: 'must-not-persist' } })).toThrow(/INVALID_MANAGEMENT_EVENT/);
    expect(() => parseMemoryToolManagementEvent({ ...event,
      payload: { ...event.payload, output: { ...event.payload.output, content: 'must-not-persist' } } }))
      .toThrow(/INVALID_MANAGEMENT_EVENT/);
  });
});

describe('Phase 1 management event validator', () => {
  test('accepts the writable Phase 1 subset and produces a stable canonical hash', () => {
    const event = parsePhase1ManagementEvent({
      schemaVersion: 1, id: 'event-1', managementRunId: 'run-1', sequence: 1,
      type: 'run-failed', actorKind: 'manager', actorId: 'worker-1', idempotencyKey: 'failure-1',
      payload: { recoverable: true, errorCode: 'MODEL_UNAVAILABLE' }, createdAt: 10,
    });
    expect(event.type).toBe('run-failed');
    expect(hashManagementEventPayload(event)).toBe(hashManagementEventPayload({
      type: 'run-failed', payload: { errorCode: 'MODEL_UNAVAILABLE', recoverable: true },
    }));
  });

  test.each([
    { name: 'top-level extra key', patch: { secret: 'raw-token' } },
    { name: 'payload extra key', patch: { payload: { errorCode: 'E', recoverable: true, prompt: 'secret' } } },
    { name: 'later-phase task event', patch: { type: 'task-created', payload: { taskId: 'task-1', taskRevision: 1 } } },
    { name: 'invalid terminal status', patch: { type: 'dispatch-attempt-completed', payload: { invocationId: 'inv-1', dispatchId: 'dispatch-1', attemptNumber: 1, status: 'running' } } },
  ])('rejects $name', ({ patch }) => {
    expect(() => parsePhase1ManagementEvent({
      schemaVersion: 1, id: 'event-1', managementRunId: 'run-1', sequence: 1,
      type: 'run-failed', actorKind: 'manager', idempotencyKey: 'key-1',
      payload: { errorCode: 'E', recoverable: true }, createdAt: 10,
      ...patch,
    })).toThrow(/INVALID_MANAGEMENT_EVENT/);
  });
});

describe('Task coordination management event validator', () => {
  test('accepts exact Task command events and hashes optional command fields canonically', () => {
    const event = parseTaskCoordinationManagementEvent({
      schemaVersion: 1, id: 'event-2', managementRunId: 'run-1', sequence: 2,
      type: 'task-published-for-claim', actorKind: 'manager', actorId: 'worker-1',
      idempotencyKey: 'publish-1', payload: { taskId: 'task-1', taskRevision: 2,
        requiredCapabilities: ['research'] }, createdAt: 20,
    });
    expect(event.type).toBe('task-published-for-claim');
    expect(hashManagementCommandInput({ taskId: 'task-1', assigneeId: undefined }))
      .toBe(hashManagementCommandInput({ taskId: 'task-1' }));
    expect(parseTaskCoordinationManagementEvent({
      schemaVersion: 1, id: 'event-delivery', managementRunId: 'run-1', sequence: 3,
      type: 'subtask-delivered', actorKind: 'agent', actorId: 'agent-1',
      idempotencyKey: 'delivery-1', payload: { deliveryId: 'delivery-1', taskId: 'task-1',
        taskRevision: 2, taskAttempt: 1, claimLeaseId: 'claim-1',
        invocationId: 'invocation-1' }, createdAt: 20,
    })).toMatchObject({ type: 'subtask-delivered' });
  });

  test('keeps Phase 1 and Task command exact sets isolated', () => {
    expect(() => parseTaskCoordinationManagementEvent({
      schemaVersion: 1, id: 'event-1', managementRunId: 'run-1', sequence: 1,
      type: 'run-failed', actorKind: 'manager', idempotencyKey: 'failure-1',
      payload: { errorCode: 'E', recoverable: true }, createdAt: 10,
    })).toThrow(/INVALID_MANAGEMENT_EVENT:type/);
    expect(() => parseTaskCoordinationManagementEvent({
      schemaVersion: 1, id: 'event-2', managementRunId: 'run-1', sequence: 2,
      type: 'task-assigned', actorKind: 'manager', idempotencyKey: 'assign-1',
      payload: { taskId: 'task-1', taskRevision: 2, agentId: 'agent-1', secret: 'x' },
      createdAt: 20,
    })).toThrow(/INVALID_MANAGEMENT_EVENT:keys/);
  });
});
