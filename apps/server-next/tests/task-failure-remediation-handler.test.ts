import { describe, expect, test } from 'vitest';
import type { TaskFailureReportV1 } from '../../../../packages/contracts/src/task-failure-remediation.js';
import {
  guardLateResultWrite,
  handleAcknowledgeActionRequired,
  handleClassifyFailure,
  handleFenceStaleAttempt,
  handleIssueProgressChallenge,
  handleRequestConditionalReassignment,
  handleRetryAttempt,
  reconcileExpiredProgressChallenges,
  type TaskFailureRemediationHandlerDeps,
} from '../src/application/task-failure-remediation-handler.js';
import { createMemoryTaskFailureRemediationUnitOfWork } from '../src/application/task-failure-remediation-unit-of-work.js';
import {
  cloneTaskFailureRemediationMemoryState,
  createInMemoryTaskFailureRemediationRepositories,
  createTaskFailureRemediationMemoryState,
  restoreTaskFailureRemediationMemoryState,
} from '../src/infra/memory/task-failure-remediation-repositories.js';

function createDeps(overrides?: {
  remainingBudget?: number;
  hasCandidates?: boolean;
  unknownExternalEffect?: boolean;
  currentAttempt?: number;
  currentFencingToken?: number;
}): { deps: TaskFailureRemediationHandlerDeps; state: ReturnType<typeof createTaskFailureRemediationMemoryState> } {
  const state = createTaskFailureRemediationMemoryState();
  const repos = createInMemoryTaskFailureRemediationRepositories(state);
  let seq = 0;
  const deps: TaskFailureRemediationHandlerDeps = {
    unitOfWork: createMemoryTaskFailureRemediationUnitOfWork({
      repos,
      snapshot: () => cloneTaskFailureRemediationMemoryState(state),
      restore: (snap) => restoreTaskFailureRemediationMemoryState(
        state,
        snap as ReturnType<typeof createTaskFailureRemediationMemoryState>,
      ),
    }),
    ids: { nextId: () => `id-${++seq}` },
    clock: { now: () => 10_000 },
    errorCodeMap: {
      ENV_TRANSIENT: 'transient_environment',
      FORBIDDEN: 'permission_or_policy_blocked',
    },
    defaultGraceMs: 1000,
    taskRuntime: {
      async getTaskMeta(taskId) {
        return {
          taskRevision: 2,
          rootTaskId: 'root-1',
          rootStatus: 'in_progress',
          maxStartedAttempts: 3,
          startedAttemptsConsumed: overrides?.remainingBudget !== undefined
            ? 3 - overrides.remainingBudget
            : 0,
          currentAttempt: overrides?.currentAttempt ?? 1,
          currentFencingToken: overrides?.currentFencingToken ?? 1,
          eligibilityOk: true,
          capacityOk: true,
          inputsStillValid: true,
          hasQualifiedCandidates: overrides?.hasCandidates ?? true,
          unknownExternalEffect: overrides?.unknownExternalEffect ?? false,
        };
      },
    },
  };
  return { deps, state };
}

const report: TaskFailureReportV1 = {
  schemaVersion: 1,
  taskId: 'task-1',
  taskRevision: 2,
  taskAttempt: 1,
  claimLeaseId: 'lease-1',
  errorCode: 'ENV_TRANSIENT',
  observableFacts: ['timeout'],
  reportedBy: 'daemon',
  reportedAt: 9000,
};

describe('handleClassifyFailure', () => {
  test('unknown class → action_required，不自动重试', async () => {
    const { deps } = createDeps();
    const res = await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 'c1' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        report: { ...report, errorCode: 'WEIRD' },
      },
    );
    expect(res.outcome).toBe('applied');
    expect(res.result?.commandName).toBe('classify-failure');
    if (res.result?.commandName === 'classify-failure') {
      expect(res.result.classification.failureClass).toBe('unknown');
      expect(res.result.classification.autoRetryAllowed).toBe(false);
      expect(res.result.actionRequired?.status).toBe('open');
      expect(res.result.remediation.state).toBe('escalation_pending');
    }
  });

  test('权限阻塞 → escalate', async () => {
    const { deps } = createDeps();
    const res = await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 'c2' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        report: { ...report, errorCode: 'FORBIDDEN' },
        serverDetectedSignals: { permissionRevoked: true },
      },
    );
    expect(res.outcome).toBe('applied');
    if (res.result?.commandName === 'classify-failure') {
      expect(res.result.classification.failureClass).toBe('permission_or_policy_blocked');
      expect(res.result.actionRequired).toBeDefined();
    }
  });

  test('预算耗尽 + 可重试类 → escalate', async () => {
    const { deps, state } = createDeps({ remainingBudget: 0 });
    // 标记已开工，使 failure 消耗 attempt 路径完整
    await deps.unitOfWork.runInTransaction(async (repos) => {
      await repos.executionStarts.create({
        taskId: 'task-1', taskAttempt: 1, claimLeaseId: 'lease-1', startedAt: 1,
      });
      await repos.fences.create({
        taskId: 'task-1', taskAttempt: 1, fencingToken: 2, fencedAt: 2, reason: 'grace_expired',
      });
    });
    void state;
    const res = await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 'c3' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        report,
      },
    );
    if (res.result?.commandName === 'classify-failure') {
      // remainingBudget 0 → escalate
      expect(res.result.remediation.state).toBe('escalation_pending');
      expect(res.result.actionRequired).toBeDefined();
    }
  });

  test('幂等 replay', async () => {
    const { deps } = createDeps();
    const envelope = {
      schemaVersion: 1 as const,
      commandName: 'classify-failure' as const,
      commandSchemaVersion: 1,
      idempotencyKey: 'same',
    };
    const input = {
      taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1', report,
    };
    const first = await handleClassifyFailure(deps, envelope, input);
    const second = await handleClassifyFailure(deps, envelope, input);
    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('replayed');
  });

  test('开工后 failure 持久化预算消耗', async () => {
    const { deps, state } = createDeps({ remainingBudget: 3 });
    await deps.unitOfWork.runInTransaction(async (repos) => {
      await repos.executionStarts.create({
        taskId: 'task-1', taskAttempt: 1, claimLeaseId: 'lease-1', startedAt: 1,
      });
    });
    await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 'budget-1' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1', report,
      },
    );
    const budget = state.budgets.get('task-1');
    expect(budget?.startedAttemptsConsumed).toBe(1);
    expect(budget?.maxStartedAttempts).toBe(3);
  });

  test('同一 task 开放 remediation lineage 唯一', async () => {
    const { deps, state } = createDeps();
    await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 'lineage-1' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        report: { ...report, errorCode: 'WEIRD' },
      },
    );
    // 不同 idempotency 的第二次分类应 upsert 同一 lineage，而非再开一条
    await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 'lineage-2' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        report: { ...report, errorCode: 'WEIRD' },
      },
    );
    const open = [...state.remediations.values()].filter((r) => r.taskId === 'task-1' && r.state !== 'resolved');
    expect(open).toHaveLength(1);
  });
});

describe('progress challenge + fencing reconciliation', () => {
  test('issue challenge 不改变 task status 标志', async () => {
    const { deps } = createDeps();
    const res = await handleIssueProgressChallenge(
      deps,
      { schemaVersion: 1, commandName: 'issue-progress-challenge', commandSchemaVersion: 1, idempotencyKey: 'ch1' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        graceDeadlineAt: 11_000,
      },
    );
    expect(res.outcome).toBe('applied');
    if (res.result?.commandName === 'issue-progress-challenge') {
      expect(res.result.slaFact).toBe('progress_at_risk');
      expect(res.result.taskStatusUnchanged).toBe(true);
    }
  });

  test('reconcile 到期 challenge → fence', async () => {
    const state = createTaskFailureRemediationMemoryState();
    const repos = createInMemoryTaskFailureRemediationRepositories(state);
    let seq = 0;
    let now = 1000;
    const deps: TaskFailureRemediationHandlerDeps = {
      unitOfWork: createMemoryTaskFailureRemediationUnitOfWork({
        repos,
        snapshot: () => cloneTaskFailureRemediationMemoryState(state),
        restore: (snap) => restoreTaskFailureRemediationMemoryState(
          state, snap as typeof state,
        ),
      }),
      ids: { nextId: () => `id-${++seq}` },
      clock: { now: () => now },
      taskRuntime: {
        async getTaskMeta() {
          return {
            taskRevision: 1, rootTaskId: 'root', rootStatus: 'in_progress',
            maxStartedAttempts: 3, startedAttemptsConsumed: 0,
            currentAttempt: 1, currentFencingToken: 1,
            eligibilityOk: true, capacityOk: true, inputsStillValid: true,
            hasQualifiedCandidates: true, unknownExternalEffect: false,
          };
        },
      },
    };

    await handleIssueProgressChallenge(
      deps,
      { schemaVersion: 1, commandName: 'issue-progress-challenge', commandSchemaVersion: 1, idempotencyKey: 'ch-exp' },
      {
        taskId: 'task-1', taskRevision: 1, taskAttempt: 1, claimLeaseId: 'lease-1',
        graceDeadlineAt: 1500,
      },
    );

    now = 2000;
    const result = await reconcileExpiredProgressChallenges(deps);
    expect(result.fenced).toBe(1);

    const fence = await repos.fences.get({ taskId: 'task-1', taskAttempt: 1 });
    expect(fence).not.toBeNull();
    expect(fence?.reason).toBe('grace_expired');
  });
});

describe('late result concurrency / fencing', () => {
  test('fenced attempt 拒绝迟到 daemon 结果', async () => {
    const { deps } = createDeps({ currentAttempt: 1, currentFencingToken: 2 });
    await handleFenceStaleAttempt(
      deps,
      { schemaVersion: 1, commandName: 'fence-stale-attempt', commandSchemaVersion: 1, idempotencyKey: 'f1' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        fencingToken: 2, reason: 'grace_expired',
      },
    );

    const late = await guardLateResultWrite(deps, {
      taskId: 'task-1',
      writeAttempt: 1,
      writeFencingToken: 2,
    });
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe('attempt_fenced');
  });

  test('stale fencing token 拒绝', async () => {
    const { deps } = createDeps({ currentAttempt: 2, currentFencingToken: 5 });
    const late = await guardLateResultWrite(deps, {
      taskId: 'task-1',
      writeAttempt: 2,
      writeFencingToken: 3,
    });
    expect(late).toEqual({ accepted: false, reason: 'stale_fencing_token' });
  });

  test('当前 attempt 合法写入接受', async () => {
    const { deps } = createDeps({ currentAttempt: 2, currentFencingToken: 5 });
    const ok = await guardLateResultWrite(deps, {
      taskId: 'task-1',
      writeAttempt: 2,
      writeFencingToken: 5,
    });
    expect(ok).toEqual({ accepted: true });
  });
});

describe('action_required signals + human remediation', () => {
  test('read/seen/dismiss 不关闭 action_required', async () => {
    const { deps, state } = createDeps();
    const classified = await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 'ar-c' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        report: { ...report, errorCode: 'WEIRD' },
      },
    );
    expect(classified.result?.commandName).toBe('classify-failure');
    if (classified.result?.commandName !== 'classify-failure' || !classified.result.actionRequired) {
      throw new Error('expected action_required');
    }
    const arId = classified.result.actionRequired.actionRequiredId;

    for (const signal of ['read', 'seen', 'dismiss'] as const) {
      const ack = await handleAcknowledgeActionRequired(
        deps,
        {
          schemaVersion: 1,
          commandName: 'acknowledge-action-required',
          commandSchemaVersion: 1,
          idempotencyKey: `ack-${signal}`,
        },
        { actionRequiredId: arId, signal },
      );
      expect(ack.outcome).toBe('applied');
      if (ack.result?.commandName === 'acknowledge-action-required') {
        expect(ack.result.stillOpen).toBe(true);
      }
    }

    const still = [...state.actionRequired.values()].find((r) => r.id === arId);
    expect(still?.status).toBe('open');
  });

  test('具名 retry-attempt 解决 action_required', async () => {
    const { deps, state } = createDeps();
    const classified = await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 'ar-r' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        report: { ...report, errorCode: 'WEIRD' },
      },
    );
    if (classified.result?.commandName !== 'classify-failure' || !classified.result.actionRequired) {
      throw new Error('expected action_required');
    }
    const ar = classified.result.actionRequired;

    const retry = await handleRetryAttempt(
      deps,
      { schemaVersion: 1, commandName: 'retry-attempt', commandSchemaVersion: 1, idempotencyKey: 'retry-1' },
      {
        taskId: 'task-1',
        expectedTaskRevision: 2,
        actionRequiredId: ar.actionRequiredId,
        confirmationToken: ar.confirmationToken,
        expectedEscalationRevision: ar.revision,
      },
    );
    expect(retry.outcome).toBe('applied');
    const row = state.actionRequired.get(ar.actionRequiredId);
    expect(row?.status).toBe('resolved');
    expect(row?.resolvedByCommand).toBe('retry-attempt');
  });
});

describe('conditional reassignment', () => {
  test('无候选 escalate allocation_blocked', async () => {
    const { deps } = createDeps({ hasCandidates: false, remainingBudget: 2 });
    // first classify + fence
    await deps.unitOfWork.runInTransaction(async (repos) => {
      await repos.executionStarts.create({
        taskId: 'task-1', taskAttempt: 1, claimLeaseId: 'lease-1', startedAt: 1,
      });
      await repos.fences.create({
        taskId: 'task-1', taskAttempt: 1, fencingToken: 2, fencedAt: 2, reason: 'grace_expired',
      });
    });
    const classified = await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 're-c' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        report,
      },
    );
    if (classified.result?.commandName !== 'classify-failure') throw new Error('bad');

    const re = await handleRequestConditionalReassignment(
      deps,
      {
        schemaVersion: 1,
        commandName: 'request-conditional-reassignment',
        commandSchemaVersion: 1,
        idempotencyKey: 're-1',
      },
      {
        taskId: 'task-1',
        expectedTaskRevision: 2,
        sourceAttempt: 1,
        expectedFencingToken: 2,
        classificationId: classified.result.classificationId,
      },
    );
    expect(re.outcome).toBe('applied');
    if (re.result?.commandName === 'request-conditional-reassignment') {
      expect(re.result.decision).toBe('escalated');
      expect(re.result.actionRequired).toBeDefined();
    }
  });

  test('条件满足且已 fence → offer_allowed', async () => {
    const { deps } = createDeps({ hasCandidates: true, remainingBudget: 2 });
    await deps.unitOfWork.runInTransaction(async (repos) => {
      await repos.executionStarts.create({
        taskId: 'task-1', taskAttempt: 1, claimLeaseId: 'lease-1', startedAt: 1,
      });
      await repos.fences.create({
        taskId: 'task-1', taskAttempt: 1, fencingToken: 2, fencedAt: 2, reason: 'grace_expired',
      });
    });
    const classified = await handleClassifyFailure(
      deps,
      { schemaVersion: 1, commandName: 'classify-failure', commandSchemaVersion: 1, idempotencyKey: 're-ok-c' },
      {
        taskId: 'task-1', taskRevision: 2, taskAttempt: 1, claimLeaseId: 'lease-1',
        report,
      },
    );
    if (classified.result?.commandName !== 'classify-failure') throw new Error('bad');

    const re = await handleRequestConditionalReassignment(
      deps,
      {
        schemaVersion: 1,
        commandName: 'request-conditional-reassignment',
        commandSchemaVersion: 1,
        idempotencyKey: 're-ok',
      },
      {
        taskId: 'task-1',
        expectedTaskRevision: 2,
        sourceAttempt: 1,
        expectedFencingToken: 2,
        classificationId: classified.result.classificationId,
      },
    );
    if (re.result?.commandName === 'request-conditional-reassignment') {
      expect(re.result.decision).toBe('offer_allowed');
      expect(re.result.offerId).toBeDefined();
    }
  });
});
