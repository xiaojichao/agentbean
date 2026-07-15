import { describe, expect, test } from 'vitest';

import {
  canonicalizeAgentInvocationIntent,
  resolveInvocationIdempotency,
} from '../src/index.js';
import type { AgentInvocationIntentV1 } from '@agentbean/contracts';

const intent: AgentInvocationIntentV1 = {
  schemaVersion: 1,
  teamId: 'team-1',
  channelId: 'channel-1',
  targetAgentId: 'agent-1',
  targetKind: 'custom',
  objective: 'Implement the task',
  taskContext: {
    taskId: 'task-1',
    rootTaskId: 'task-root',
    taskRevision: 2,
    taskAttempt: 1,
    claimLeaseId: 'claim-1',
  },
  acceptanceCriteria: [{
    id: 'criterion-1',
    description: 'Tests pass',
    evidenceRequired: true,
    allowedEvidenceKinds: ['workspace-run'],
  }],
  dependencyResults: [{
    invocationId: 'invocation-0',
    resultRevision: 1,
    artifactIds: ['artifact-1'],
  }],
  memoryCapsuleRef: {
    schemaVersion: 1,
    id: 'capsule-1',
    teamId: 'team-1',
    managementRunId: 'run-1',
    targetAgentId: 'agent-1',
    contentHash: 'sha256:capsule-1',
    authorizationDecisionId: 'decision-1',
    expiresAt: 100,
  },
  attachmentIds: ['attachment-1'],
  deadlineAt: 100,
};

describe('Phase 0 Invocation policy', () => {
  test('canonical serialization is stable across object insertion order', () => {
    const reordered = {
      deadlineAt: intent.deadlineAt,
      attachmentIds: intent.attachmentIds,
      memoryCapsuleRef: intent.memoryCapsuleRef,
      dependencyResults: intent.dependencyResults,
      acceptanceCriteria: intent.acceptanceCriteria,
      taskContext: intent.taskContext,
      objective: intent.objective,
      targetKind: intent.targetKind,
      targetAgentId: intent.targetAgentId,
      channelId: intent.channelId,
      teamId: intent.teamId,
      schemaVersion: 1 as const,
    } satisfies AgentInvocationIntentV1;

    expect(canonicalizeAgentInvocationIntent(reordered)).toBe(canonicalizeAgentInvocationIntent(intent));
    expect(canonicalizeAgentInvocationIntent(intent)).toContain('"schemaVersion":1');
  });

  test('same idempotency key and intent hash returns the existing Invocation', () => {
    expect(resolveInvocationIdempotency({
      existing: {
        invocationId: 'invocation-1', managementRunId: 'run-1', idempotencyKey: 'key-1', intentHash: 'hash-1',
      },
      requestedManagementRunId: 'run-1',
      requestedIdempotencyKey: 'key-1',
      requestedIntentHash: 'hash-1',
    })).toEqual({ kind: 'existing', invocationId: 'invocation-1' });
  });

  test('same idempotency key with a different intent hash is a conflict', () => {
    expect(resolveInvocationIdempotency({
      existing: {
        invocationId: 'invocation-1', managementRunId: 'run-1', idempotencyKey: 'key-1', intentHash: 'hash-1',
      },
      requestedManagementRunId: 'run-1',
      requestedIdempotencyKey: 'key-1',
      requestedIntentHash: 'hash-2',
    })).toEqual({
      kind: 'conflict',
      invocationId: 'invocation-1',
      existingIntentHash: 'hash-1',
      requestedIntentHash: 'hash-2',
    });
  });

  test('no existing matching key creates a new immutable Invocation intent', () => {
    expect(resolveInvocationIdempotency({
      requestedManagementRunId: 'run-1',
      requestedIdempotencyKey: 'key-new',
      requestedIntentHash: 'hash-new',
    })).toEqual({ kind: 'create' });
  });

  test('the same bare key in a different ManagementRun does not collide', () => {
    expect(resolveInvocationIdempotency({
      existing: {
        invocationId: 'invocation-1', managementRunId: 'run-1', idempotencyKey: 'key-1', intentHash: 'hash-1',
      },
      requestedManagementRunId: 'run-2',
      requestedIdempotencyKey: 'key-1',
      requestedIntentHash: 'hash-1',
    })).toEqual({ kind: 'create' });
  });
});
