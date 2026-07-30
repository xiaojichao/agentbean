import { describe, expect, test } from 'vitest';
import type {
  TaskFailureReportV1,
  TaskProgressChallengeV1,
  UnacceptedHandoffMaterialRefV1,
} from '@agentbean/contracts';
import {
  authorizeRemediationCommand,
  bindUnacceptedHandoffMaterial,
  buildOrAggregateActionRequired,
  buildProgressChallenge,
  canWakeRemediation,
  classifyTaskFailure,
  computeRetryNotBefore,
  evaluateActionRequiredSignal,
  evaluateAttemptConsumption,
  evaluateConditionalReassignment,
  evaluateLateWrite,
  evaluateRootImpactFromSubtaskFailure,
  evaluateTaskSla,
  openRemediationState,
  resolveProgressChallenge,
} from '../src/task-failure-remediation-policy.js';

// #928 domain policy tests —— 覆盖验收标准。

const baseReport: TaskFailureReportV1 = {
  schemaVersion: 1,
  taskId: 'task-1',
  taskRevision: 2,
  taskAttempt: 1,
  claimLeaseId: 'lease-1',
  errorCode: 'ENV_TRANSIENT',
  observableFacts: ['exit_code=1', 'stderr=timeout'],
  reportedBy: 'daemon',
  reportedAt: 1000,
};

const errorCodeMap = {
  ENV_TRANSIENT: 'transient_environment' as const,
  AGENT_DOWN: 'agent_unavailable' as const,
  SKILL_MISSING: 'capability_mismatch' as const,
  BAD_INPUT: 'invalid_input_or_contract' as const,
  FORBIDDEN: 'permission_or_policy_blocked' as const,
};

describe('evaluateAttemptConsumption — Task execution start 边界', () => {
  test('offer reject 不消耗 attempt', () => {
    const d = evaluateAttemptConsumption({
      hasExecutionStart: false,
      event: 'offer_reject',
      maxStartedAttempts: 3,
      startedAttemptsConsumed: 0,
    });
    expect(d.kind).toBe('allocation_round_only');
    if (d.kind === 'allocation_round_only') {
      expect(d.budget.remaining).toBe(3);
      expect(d.endsAllocationRoundOnly).toBe(true);
    }
  });

  test('开工前 relinquish 不消耗 attempt', () => {
    const d = evaluateAttemptConsumption({
      hasExecutionStart: false,
      event: 'pre_start_relinquish',
      maxStartedAttempts: 3,
      startedAttemptsConsumed: 1,
    });
    expect(d.kind).toBe('allocation_round_only');
    if (d.kind === 'allocation_round_only') {
      expect(d.budget.startedAttemptsConsumed).toBe(1);
    }
  });

  test('开工后 failure 消耗 attempt', () => {
    const d = evaluateAttemptConsumption({
      hasExecutionStart: true,
      event: 'failure',
      maxStartedAttempts: 3,
      startedAttemptsConsumed: 0,
    });
    expect(d.kind).toBe('consume');
    if (d.kind === 'consume') {
      expect(d.budget.startedAttemptsConsumed).toBe(1);
      expect(d.budget.remaining).toBe(2);
    }
  });

  test('开工后 fence/timeout 消耗 attempt', () => {
    expect(evaluateAttemptConsumption({
      hasExecutionStart: true, event: 'fence', maxStartedAttempts: 2, startedAttemptsConsumed: 0,
    }).kind).toBe('consume');
    expect(evaluateAttemptConsumption({
      hasExecutionStart: true, event: 'timeout', maxStartedAttempts: 2, startedAttemptsConsumed: 1,
    })).toMatchObject({ kind: 'consume', budget: { remaining: 0 } });
  });
});

describe('classifyTaskFailure — 版本化 taxonomy', () => {
  test('映射 errorCode → transient_environment 可自动重试', () => {
    const c = classifyTaskFailure({ report: baseReport, now: 2000, errorCodeMap });
    expect(c.failureClass).toBe('transient_environment');
    expect(c.autoRetryAllowed).toBe(true);
    expect(c.taxonomyVersion).toBe(1);
  });

  test('unknown errorCode 默认 unknown，不可自动重试', () => {
    const c = classifyTaskFailure({
      report: { ...baseReport, errorCode: 'WEIRD' },
      now: 2000,
      errorCodeMap,
    });
    expect(c.failureClass).toBe('unknown');
    expect(c.autoRetryAllowed).toBe(false);
    expect(c.requiresHumanEscalation).toBe(true);
  });

  test('server 权限撤销优先于 report', () => {
    const c = classifyTaskFailure({
      report: baseReport,
      now: 2000,
      errorCodeMap,
      serverDetectedSignals: { permissionRevoked: true },
    });
    expect(c.failureClass).toBe('permission_or_policy_blocked');
    expect(c.autoRetryAllowed).toBe(false);
  });

  test('unknown external effect → unknown + escalation', () => {
    const c = classifyTaskFailure({
      report: baseReport,
      now: 2000,
      errorCodeMap,
      serverDetectedSignals: { unknownExternalEffect: true },
    });
    expect(c.failureClass).toBe('unknown');
    expect(c.requiresHumanEscalation).toBe(true);
  });

  test('capability_mismatch 排除同 agent 但可改派其他 agent', () => {
    const c = classifyTaskFailure({
      report: { ...baseReport, errorCode: 'SKILL_MISSING' },
      now: 2000,
      errorCodeMap,
    });
    expect(c.failureClass).toBe('capability_mismatch');
    expect(c.excludeSameAgent).toBe(true);
    expect(c.autoRetryAllowed).toBe(true);
    expect(c.requiresHumanEscalation).toBe(false);
  });
});

describe('evaluateConditionalReassignment', () => {
  const okClassification = classifyTaskFailure({ report: baseReport, now: 1, errorCodeMap });

  const base = {
    classification: okClassification,
    remainingBudget: 2,
    oldAttemptFenced: true,
    eligibilityOk: true,
    capacityOk: true,
    inputsStillValid: true,
    unknownExternalEffect: false,
    hasQualifiedCandidates: true,
    now: 5000,
  };

  test('条件全满足 → offer_allowed', () => {
    expect(evaluateConditionalReassignment(base).kind).toBe('offer_allowed');
  });

  test('unknown 不自动重试', () => {
    const unknown = classifyTaskFailure({
      report: { ...baseReport, errorCode: 'X' }, now: 1,
    });
    const d = evaluateConditionalReassignment({ ...base, classification: unknown });
    expect(d.kind).toBe('escalate');
    if (d.kind === 'escalate') expect(d.reason).toContain('class_not_auto_retryable');
  });

  test('权限阻塞不自动重试', () => {
    const blocked = classifyTaskFailure({
      report: { ...baseReport, errorCode: 'FORBIDDEN' }, now: 1, errorCodeMap,
    });
    expect(evaluateConditionalReassignment({ ...base, classification: blocked }).kind).toBe('escalate');
  });

  test('预算耗尽不自动重试', () => {
    const d = evaluateConditionalReassignment({ ...base, remainingBudget: 0 });
    expect(d).toMatchObject({ kind: 'escalate', reason: 'budget_exhausted' });
  });

  test('无候选 → allocation_blocked escalation', () => {
    const d = evaluateConditionalReassignment({ ...base, hasQualifiedCandidates: false });
    expect(d).toMatchObject({ kind: 'escalate', reason: 'no_qualified_candidates', remediationState: 'allocation_blocked' });
  });

  test('旧 attempt 未 fencing → blocked', () => {
    const d = evaluateConditionalReassignment({ ...base, oldAttemptFenced: false });
    expect(d).toMatchObject({ kind: 'blocked', reason: 'old_attempt_not_fenced' });
  });

  test('cooldown notBefore 未到 → blocked', () => {
    const d = evaluateConditionalReassignment({ ...base, notBefore: 9000, now: 5000 });
    expect(d).toMatchObject({ kind: 'blocked', reason: 'cooldown_not_elapsed' });
  });

  test('unknown external effect 不自动改派', () => {
    const d = evaluateConditionalReassignment({ ...base, unknownExternalEffect: true });
    expect(d).toMatchObject({ kind: 'escalate', reason: 'unknown_external_effect' });
  });

  test('capability_mismatch 无其他候选 → escalate', () => {
    const mismatch = classifyTaskFailure({
      report: { ...baseReport, errorCode: 'SKILL_MISSING' }, now: 1, errorCodeMap,
    });
    const d = evaluateConditionalReassignment({
      ...base,
      classification: mismatch,
      hasAlternateCandidates: false,
    });
    expect(d).toMatchObject({ kind: 'escalate', reason: 'no_alternate_agent_after_exclude' });
  });

  test('capability_mismatch 有其他候选 → offer_allowed', () => {
    const mismatch = classifyTaskFailure({
      report: { ...baseReport, errorCode: 'SKILL_MISSING' }, now: 1, errorCodeMap,
    });
    const d = evaluateConditionalReassignment({
      ...base,
      classification: mismatch,
      hasAlternateCandidates: true,
    });
    expect(d.kind).toBe('offer_allowed');
  });
});

describe('evaluateTaskSla — notice/heartbeat 不立即改派', () => {
  test('仅 heartbeat 丢失且 progress 未超时 → healthy', () => {
    const d = evaluateTaskSla({
      clocks: [{ kind: 'progress', startedAt: 0, deadlineAt: 10_000, paused: false }],
      now: 5000,
      lastHeartbeatAt: 1000,
      lastStructuredProgressAt: 4000,
    });
    expect(d.kind).toBe('healthy');
  });

  test('notice 送达不构成 progress，progress 超时 → challenge 而非立即 fence', () => {
    const d = evaluateTaskSla({
      clocks: [{ kind: 'progress', startedAt: 0, deadlineAt: 1000, paused: false }],
      now: 2000,
      lastNoticeDeliveredAt: 1500,
      lastHeartbeatAt: 1900,
    });
    expect(d.kind).toBe('issue_challenge');
  });

  test('grace 内仍无 structured progress → healthy（保持 in_progress）', () => {
    const challenge = buildProgressChallenge({
      challengeId: 'ch-1', taskId: 'task-1', taskRevision: 1, taskAttempt: 1,
      claimLeaseId: 'lease-1', now: 1000, graceMs: 5000,
    });
    const d = evaluateTaskSla({
      clocks: [],
      now: 3000,
      openChallenge: challenge,
      lastHeartbeatAt: 2900,
    });
    expect(d.kind).toBe('healthy');
  });

  test('grace 到期 → fence no_progress_timeout', () => {
    const challenge = buildProgressChallenge({
      challengeId: 'ch-1', taskId: 'task-1', taskRevision: 1, taskAttempt: 1,
      claimLeaseId: 'lease-1', now: 1000, graceMs: 500,
    });
    const d = evaluateTaskSla({
      clocks: [],
      now: 2000,
      openChallenge: challenge,
    });
    expect(d).toMatchObject({ kind: 'fence', reason: 'grace_expired', failureClass: 'no_progress_timeout' });
  });

  test('grace 内 structured progress → healthy', () => {
    const challenge = buildProgressChallenge({
      challengeId: 'ch-1', taskId: 'task-1', taskRevision: 1, taskAttempt: 1,
      claimLeaseId: 'lease-1', now: 1000, graceMs: 5000,
    });
    const d = evaluateTaskSla({
      clocks: [],
      now: 2000,
      openChallenge: challenge,
      lastStructuredProgressAt: 1500,
    });
    expect(d.kind).toBe('healthy');
  });

  test('权限撤销可跳过 grace 直接 fence', () => {
    const d = evaluateTaskSla({
      clocks: [],
      now: 1000,
      permissionRevoked: true,
    });
    expect(d).toMatchObject({ kind: 'fence', reason: 'permission_revoked' });
  });
});

describe('evaluateLateWrite — fencing 后迟到写入拒绝', () => {
  test('旧 attempt 写入拒绝', () => {
    expect(evaluateLateWrite({
      writeAttempt: 1, writeFencingToken: 1,
      currentAttempt: 2, currentFencingToken: 2, currentAttemptFenced: false,
    })).toEqual({ kind: 'reject', reason: 'stale_attempt' });
  });

  test('旧 fencing token 拒绝', () => {
    expect(evaluateLateWrite({
      writeAttempt: 2, writeFencingToken: 1,
      currentAttempt: 2, currentFencingToken: 3, currentAttemptFenced: false,
    })).toEqual({ kind: 'reject', reason: 'stale_fencing_token' });
  });

  test('已 fenced 的 attempt 拒绝迟到 delivery', () => {
    expect(evaluateLateWrite({
      writeAttempt: 1, writeFencingToken: 5,
      currentAttempt: 1, currentFencingToken: 5, currentAttemptFenced: true,
    })).toEqual({ kind: 'reject', reason: 'attempt_fenced' });
  });

  test('当前有效 write 接受', () => {
    expect(evaluateLateWrite({
      writeAttempt: 2, writeFencingToken: 3,
      currentAttempt: 2, currentFencingToken: 3, currentAttemptFenced: false,
    })).toEqual({ kind: 'accept' });
  });
});

describe('action_required — read/seen/dismiss 不解决', () => {
  const classification = classifyTaskFailure({
    report: { ...baseReport, errorCode: 'WEIRD' }, now: 1,
  });

  test('构建 action_required 含具名命令', () => {
    const ar = buildOrAggregateActionRequired({
      actionRequiredId: 'ar-1',
      taskId: 'task-1',
      taskRevision: 2,
      sourceAttempt: 1,
      classification,
      remainingBudget: 0,
      confirmationToken: 'tok-1',
      now: 10,
    });
    expect(ar.status).toBe('open');
    expect(ar.allowedCommands).toContain('retry-attempt');
    expect(ar.allowedCommands).toContain('increase-attempt-budget');
    expect(ar.allowedCommands).not.toContain('terminate-root-task');
  });

  test('相同 fingerprint 聚合不递增 revision', () => {
    const first = buildOrAggregateActionRequired({
      actionRequiredId: 'ar-1', taskId: 'task-1', taskRevision: 2, sourceAttempt: 1,
      classification, remainingBudget: 0, confirmationToken: 'tok-1', now: 10,
    });
    const second = buildOrAggregateActionRequired({
      actionRequiredId: 'ar-2', taskId: 'task-1', taskRevision: 2, sourceAttempt: 1,
      classification, remainingBudget: 0, confirmationToken: 'tok-2', now: 20,
      existing: first,
    });
    expect(second.revision).toBe(1);
    expect(second.actionRequiredId).toBe('ar-1');
  });

  test('read/seen/dismiss 仍 open', () => {
    const ar = buildOrAggregateActionRequired({
      actionRequiredId: 'ar-1', taskId: 'task-1', taskRevision: 2, sourceAttempt: 1,
      classification, remainingBudget: 0, confirmationToken: 'tok-1', now: 10,
    });
    for (const signal of ['read', 'seen', 'dismiss', 'notice_failed', 'chat_message'] as const) {
      const r = evaluateActionRequiredSignal(ar, signal);
      expect(r.stillOpen).toBe(true);
      expect(r.signalIgnored).toBe(signal);
    }
  });

  test('具名 command 需 token + revision', () => {
    const ar = buildOrAggregateActionRequired({
      actionRequiredId: 'ar-1', taskId: 'task-1', taskRevision: 2, sourceAttempt: 1,
      classification, remainingBudget: 0, confirmationToken: 'tok-1', now: 10,
    });
    expect(authorizeRemediationCommand({
      commandName: 'retry-attempt',
      actionRequired: ar,
      confirmationToken: 'tok-1',
      expectedEscalationRevision: 1,
      actorHasRootTerminationAuthority: false,
    }).kind).toBe('authorized');

    expect(authorizeRemediationCommand({
      commandName: 'retry-attempt',
      actionRequired: ar,
      confirmationToken: 'wrong',
      expectedEscalationRevision: 1,
      actorHasRootTerminationAuthority: false,
    })).toMatchObject({ kind: 'rejected', reason: 'invalid_confirmation_token' });

    expect(authorizeRemediationCommand({
      commandName: 'retry-attempt',
      actionRequired: ar,
      confirmationToken: 'tok-1',
      expectedEscalationRevision: 9,
      actorHasRootTerminationAuthority: false,
    })).toMatchObject({ kind: 'rejected', reason: 'stale_escalation_revision' });
  });
});

describe('root task isolation', () => {
  test('子任务失败不改变 root', () => {
    expect(evaluateRootImpactFromSubtaskFailure({
      subtaskFailed: true,
      rootStatus: 'in_progress',
    })).toEqual({ kind: 'root_unchanged' });
  });
});

describe('handoff material provenance', () => {
  const material: UnacceptedHandoffMaterialRefV1 = {
    schemaVersion: 1,
    materialId: 'mat-1',
    taskId: 'task-1',
    sourceAttempt: 1,
    claimLeaseId: 'lease-1',
    provenanceHash: 'sha256:abc',
  };

  test('非显式绑定拒绝', () => {
    expect(bindUnacceptedHandoffMaterial({
      material, newContractId: 'contract-2', explicitBind: false,
    })).toMatchObject({ kind: 'rejected', reason: 'explicit_bind_required' });
  });

  test('显式绑定成功', () => {
    const d = bindUnacceptedHandoffMaterial({
      material, newContractId: 'contract-2', explicitBind: true,
    });
    expect(d.kind).toBe('bound');
    if (d.kind === 'bound') expect(d.material.boundToContractId).toBe('contract-2');
  });
});

describe('remediation lineage + cooldown', () => {
  test('open remediation for escalate', () => {
    const classification = classifyTaskFailure({
      report: { ...baseReport, errorCode: 'WEIRD' }, now: 1,
    });
    const state = openRemediationState({
      remediationId: 'rem-1',
      taskId: 'task-1',
      taskRevision: 2,
      sourceAttempt: 1,
      classification,
      remainingBudget: 0,
      now: 100,
      policyRevision: 1,
      decision: { kind: 'escalate', reason: 'budget_exhausted', remediationState: 'escalation_pending' },
    });
    expect(state.state).toBe('escalation_pending');
    expect(state.escalationKey).toContain('task-1:');
  });

  test('notBefore 门禁', () => {
    expect(canWakeRemediation({ now: 100, notBefore: 200 })).toBe(false);
    expect(canWakeRemediation({ now: 200, notBefore: 200 })).toBe(true);
    expect(computeRetryNotBefore({
      now: 1000, failureClass: 'transient_environment', attemptNumber: 2, baseCooldownMs: 100,
    })).toBe(1200);
  });
});

describe('resolveProgressChallenge', () => {
  const challenge: TaskProgressChallengeV1 = buildProgressChallenge({
    challengeId: 'ch-1', taskId: 't', taskRevision: 1, taskAttempt: 1,
    claimLeaseId: 'l', now: 1000, graceMs: 500,
  });

  test('structured progress 解除', () => {
    expect(resolveProgressChallenge({
      challenge, now: 1200, hasStructuredProgress: true, skipForSafety: false,
    })).toMatchObject({ kind: 'resolved', resolution: 'progress_received', fenced: false });
  });

  test('grace 到期 fence', () => {
    expect(resolveProgressChallenge({
      challenge, now: 2000, hasStructuredProgress: false, skipForSafety: false,
    })).toMatchObject({ kind: 'fence', fenced: true, failureClass: 'no_progress_timeout' });
  });
});
