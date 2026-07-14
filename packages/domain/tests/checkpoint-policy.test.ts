import { describe, expect, test } from 'vitest';

import { evaluateManagementCheckpoint } from '../src/index.js';
import type { ManagementCheckpointV1 } from '@agentbean/contracts';

const checkpoint: ManagementCheckpointV1 = {
  schemaVersion: 1,
  managementRunId: 'run-1',
  revision: 3,
  authoritative: {
    lastEventSequence: 12,
    taskGraphRevision: 4,
    openTaskIds: ['task-open'],
    waitingInvocationIds: ['invocation-waiting'],
    completedInvocationIds: ['invocation-completed'],
    memoryCapsuleIds: ['capsule-1'],
  },
  contextHints: {
    objective: 'Coordinate work',
    planSummary: 'Wait for one invocation',
    completedInvocationSummaries: [{ invocationId: 'invocation-completed', summary: 'Done' }],
    unresolvedQuestions: [],
    nextAction: 'wait',
  },
  updatedAt: 100,
};

const facts = {
  managementRunId: 'run-1',
  lastEventSequence: 12,
  taskGraphRevision: 4,
  openTaskIds: ['task-open'],
  waitingInvocationIds: ['invocation-waiting'],
  completedInvocationIds: ['invocation-completed'],
  validMemoryCapsuleIds: ['capsule-1'],
};

describe('Phase 0 checkpoint policy', () => {
  test('returns context hints only after every authoritative reference validates', () => {
    expect(evaluateManagementCheckpoint({ checkpoint, facts })).toEqual({
      kind: 'usable',
      contextHints: checkpoint.contextHints,
    });
  });

  test.each([
    ['facts from another ManagementRun', { ...facts, managementRunId: 'run-2' }, 'management-run-mismatch'],
    ['event gap', { ...facts, lastEventSequence: 13 }, 'event-sequence-mismatch'],
    ['task graph revision lag', { ...facts, taskGraphRevision: 5 }, 'task-graph-revision-mismatch'],
    ['closed task still referenced as open', { ...facts, openTaskIds: [] }, 'missing-open-task'],
    ['completed Invocation still referenced as waiting', {
      ...facts,
      waitingInvocationIds: [],
      completedInvocationIds: ['invocation-waiting', 'invocation-completed'],
    }, 'missing-waiting-invocation'],
    ['non-terminal Invocation still referenced as completed', {
      ...facts,
      waitingInvocationIds: ['invocation-waiting', 'invocation-completed'],
      completedInvocationIds: [],
    }, 'missing-completed-invocation'],
    ['expired or revoked Memory Capsule', { ...facts, validMemoryCapsuleIds: [] }, 'invalid-memory-capsule'],
  ] as const)('requires rebuild for %s and discards context hints', (_name, invalidFacts, reason) => {
    const result = evaluateManagementCheckpoint({ checkpoint, facts: invalidFacts });
    expect(result).toMatchObject({ kind: 'rebuild_required', reasons: expect.arrayContaining([reason]) });
    expect(result).not.toHaveProperty('contextHints');
  });

  test('requires rebuild when current facts introduce Phase 2 DAG or claim fields absent from an old checkpoint', () => {
    const phase2Facts = {
      ...facts,
      taskSnapshots: [{ taskId: 'task-open', taskRevision: 2, taskAttempt: 1,
        status: 'in_progress' as const, claimLeaseId: 'claim-1' }],
      activeClaimLeaseIds: ['claim-1'],
    };
    expect(evaluateManagementCheckpoint({ checkpoint, facts: phase2Facts })).toMatchObject({
      kind: 'rebuild_required', reasons: ['task-graph-revision-mismatch'],
    });
  });
});
