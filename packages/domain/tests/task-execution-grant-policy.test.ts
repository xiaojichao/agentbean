import { describe, expect, test } from 'vitest';

import {
  evaluateExecutionGrantIssuance,
  evaluateExecutionGrantRevocation,
  type TaskExecutionGrantRecord,
} from '../src/index.js';

const issuanceInput = {
  teamId: 'team-1',
  managementRunId: 'run-1',
  taskId: 'task-1',
  taskRevision: 2,
  taskAttempt: 1,
  claimLeaseId: 'lease-1',
  agentId: 'agent-1',
  grantedAt: 100,
};

function activeGrant(overrides: Partial<TaskExecutionGrantRecord> = {}): TaskExecutionGrantRecord {
  return {
    teamId: 'team-1',
    managementRunId: 'run-1',
    taskId: 'task-1',
    taskRevision: 2,
    taskAttempt: 1,
    claimLeaseId: 'lease-1',
    agentId: 'agent-1',
    state: 'active',
    grantedAt: 100,
    ...overrides,
  };
}

describe('#925 execution context grant policy', () => {
  describe('evaluateExecutionGrantIssuance', () => {
    test('subtask claim success issues an active grant bound to agent/revision/attempt/claim', () => {
      const decision = evaluateExecutionGrantIssuance({ ...issuanceInput, nodeKind: 'subtask' });
      expect(decision).toEqual({
        kind: 'issued',
        grant: {
          teamId: 'team-1',
          managementRunId: 'run-1',
          taskId: 'task-1',
          taskRevision: 2,
          taskAttempt: 1,
          claimLeaseId: 'lease-1',
          agentId: 'agent-1',
          state: 'active',
          grantedAt: 100,
        },
      });
    });

    test('root Task node is never granted execution context (defense in depth)', () => {
      const decision = evaluateExecutionGrantIssuance({ ...issuanceInput, nodeKind: 'root' });
      expect(decision).toEqual({ kind: 'refused', reason: 'root-not-executable' });
    });

    test('#966 颁发的 grant 透传 workspaceRevisionId（Agent 执行输入的固定 revision）', () => {
      const decision = evaluateExecutionGrantIssuance({
        ...issuanceInput, nodeKind: 'subtask', workspaceRevisionId: 'ws-rev-1',
      });
      expect(decision.kind).toBe('issued');
      if (decision.kind !== 'issued') return;
      expect(decision.grant.workspaceRevisionId).toBe('ws-rev-1');
    });

    test('#966 workspaceRevisionId 可选：频道无 workspace 时为 undefined', () => {
      const decision = evaluateExecutionGrantIssuance({ ...issuanceInput, nodeKind: 'subtask' });
      expect(decision.kind).toBe('issued');
      if (decision.kind !== 'issued') return;
      expect(decision.grant.workspaceRevisionId).toBeUndefined();
    });
  });

  describe('evaluateExecutionGrantRevocation', () => {
    test('task-revised revokes when bound revision differs from current', () => {
      const decision = evaluateExecutionGrantRevocation({
        grant: activeGrant({ taskRevision: 2 }),
        cause: 'task-revised',
        currentTaskRevision: 3,
        now: 200,
      });
      expect(decision).toEqual({ kind: 'revoke', reason: 'task-revised', revokedAt: 200 });
    });

    test('task-revised keeps grant when revision is unchanged', () => {
      const decision = evaluateExecutionGrantRevocation({
        grant: activeGrant({ taskRevision: 2 }),
        cause: 'task-revised',
        currentTaskRevision: 2,
        now: 200,
      });
      expect(decision).toEqual({ kind: 'keep' });
    });

    test('claim-released always revokes an active grant', () => {
      const decision = evaluateExecutionGrantRevocation({
        grant: activeGrant(),
        cause: 'claim-released',
        now: 200,
      });
      expect(decision).toEqual({ kind: 'revoke', reason: 'claim-released', revokedAt: 200 });
    });

    test('claim-expired always revokes an active grant', () => {
      const decision = evaluateExecutionGrantRevocation({
        grant: activeGrant(),
        cause: 'claim-expired',
        now: 200,
      });
      expect(decision).toEqual({ kind: 'revoke', reason: 'claim-expired', revokedAt: 200 });
    });

    test('already-revoked grant stays revoked (idempotent)', () => {
      const decision = evaluateExecutionGrantRevocation({
        grant: activeGrant({ state: 'revoked', revokedAt: 150, revocationReason: 'claim-released' }),
        cause: 'task-revised',
        currentTaskRevision: 3,
        now: 200,
      });
      expect(decision).toEqual({ kind: 'keep' });
    });
  });
});
