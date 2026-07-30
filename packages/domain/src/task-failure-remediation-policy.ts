/**
 * #928 Task failure classification / SLA / conditional reassignment / remediation
 * domain policy（纯函数，ADR-0065）。
 *
 * 无 IO、无 server 依赖。Server handler 在事务内组合这些决策。
 */
import type {
  AttemptTerminationEvent,
  ExecutionRetryBudgetV1,
  NonResolvingActionRequiredSignal,
  RemediationState,
  TaskActionRequiredV1,
  TaskFailureClass,
  TaskFailureClassificationV1,
  TaskFailureReportV1,
  TaskProgressChallengeV1,
  TaskRemediationCommandName,
  UnacceptedHandoffMaterialRefV1,
} from '@agentbean/contracts';
import {
  TASK_FAILURE_TAXONOMY_VERSION,
} from '@agentbean/contracts';

// ---------------------------------------------------------------------------
// Attempt budget —— Task execution start 才是消耗边界
// ---------------------------------------------------------------------------

export interface EvaluateAttemptConsumptionInput {
  /** 是否已有 Task execution start 事件（开工）。 */
  readonly hasExecutionStart: boolean;
  readonly event: AttemptTerminationEvent;
  readonly maxStartedAttempts: number;
  readonly startedAttemptsConsumed: number;
}

export type AttemptConsumptionDecision =
  | {
      readonly kind: 'consume';
      readonly budget: ExecutionRetryBudgetV1;
      readonly endsAllocationRoundOnly: false;
    }
  | {
      readonly kind: 'allocation_round_only';
      readonly budget: ExecutionRetryBudgetV1;
      readonly endsAllocationRoundOnly: true;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

function budgetOf(max: number, consumed: number): ExecutionRetryBudgetV1 {
  return {
    schemaVersion: 1,
    maxStartedAttempts: max,
    startedAttemptsConsumed: consumed,
    remaining: Math.max(0, max - consumed),
  };
}

/**
 * Offer 拒绝/过期、开工前 relinquish/fence 只结束 allocation round，不消耗 attempt。
 * 开工后的 failure/timeout/relinquish/fence 才消耗当前 attempt。
 */
export function evaluateAttemptConsumption(
  input: EvaluateAttemptConsumptionInput,
): AttemptConsumptionDecision {
  if (!Number.isSafeInteger(input.maxStartedAttempts) || input.maxStartedAttempts < 1) {
    return { kind: 'rejected', reason: 'invalid_max_attempts' };
  }
  if (!Number.isSafeInteger(input.startedAttemptsConsumed) || input.startedAttemptsConsumed < 0) {
    return { kind: 'rejected', reason: 'invalid_consumed' };
  }

  const preStartEvents: AttemptTerminationEvent[] = [
    'offer_reject',
    'offer_expire',
    'pre_start_relinquish',
    'pre_start_fence',
  ];
  const postStartEvents: AttemptTerminationEvent[] = [
    'failure',
    'timeout',
    'relinquish',
    'fence',
  ];

  if (preStartEvents.includes(input.event) || !input.hasExecutionStart) {
    // 即使 event 名义上是 failure，若尚未 execution start，仍只结束 allocation round。
    if (!input.hasExecutionStart || preStartEvents.includes(input.event)) {
      return {
        kind: 'allocation_round_only',
        budget: budgetOf(input.maxStartedAttempts, input.startedAttemptsConsumed),
        endsAllocationRoundOnly: true,
      };
    }
  }

  if (!postStartEvents.includes(input.event)) {
    return { kind: 'rejected', reason: 'unknown_termination_event' };
  }

  const nextConsumed = input.startedAttemptsConsumed + 1;
  return {
    kind: 'consume',
    budget: budgetOf(input.maxStartedAttempts, nextConsumed),
    endsAllocationRoundOnly: false,
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const AUTO_RETRY_CLASSES: ReadonlySet<TaskFailureClass> = new Set([
  'transient_environment',
  'agent_unavailable',
  'no_progress_timeout',
]);

const ESCALATE_CLASSES: ReadonlySet<TaskFailureClass> = new Set([
  'invalid_input_or_contract',
  'permission_or_policy_blocked',
  'deadline_exceeded',
  'unknown',
]);

export interface ClassifyTaskFailureInput {
  readonly report: TaskFailureReportV1;
  readonly now: number;
  readonly serverDetectedSignals?: {
    readonly permissionRevoked?: boolean;
    readonly deadlineExceeded?: boolean;
    readonly hardStopReached?: boolean;
    readonly leaseExpired?: boolean;
    readonly unknownExternalEffect?: boolean;
  };
  /** Server 已确认的结构化 errorCode → class 映射（版本化 taxonomy）。 */
  readonly errorCodeMap?: Readonly<Partial<Record<string, TaskFailureClass>>>;
}

function fingerprintOf(failureClass: TaskFailureClass, report: TaskFailureReportV1): string {
  const facts = [...report.observableFacts].sort().join('|');
  return `${failureClass}:${report.errorCode}:${facts}`;
}

/**
 * Server 权威分类。Agent/daemon 的 report 只是输入；不得自报 retryable。
 * Server 检测到的权限/deadline/unknown external effect 优先于 report errorCode。
 */
export function classifyTaskFailure(input: ClassifyTaskFailureInput): TaskFailureClassificationV1 {
  const signals = input.serverDetectedSignals ?? {};
  let failureClass: TaskFailureClass = 'unknown';

  if (signals.unknownExternalEffect) {
    failureClass = 'unknown';
  } else if (signals.permissionRevoked) {
    failureClass = 'permission_or_policy_blocked';
  } else if (signals.hardStopReached || signals.deadlineExceeded) {
    failureClass = 'deadline_exceeded';
  } else if (signals.leaseExpired) {
    failureClass = 'agent_unavailable';
  } else if (input.errorCodeMap?.[input.report.errorCode]) {
    failureClass = input.errorCodeMap[input.report.errorCode]!;
  } else {
    // 保守：未映射 errorCode 一律 unknown，禁止自动重试。
    failureClass = 'unknown';
  }

  // capability_mismatch 允许改派其他 Agent，但必须排除同一 Agent（ADR-0065）。
  const excludeSameAgent = failureClass === 'capability_mismatch';
  const autoRetryAllowed = AUTO_RETRY_CLASSES.has(failureClass) || excludeSameAgent;
  const requiresHumanEscalation = ESCALATE_CLASSES.has(failureClass) && !excludeSameAgent;

  return {
    schemaVersion: 1,
    taxonomyVersion: TASK_FAILURE_TAXONOMY_VERSION,
    failureClass,
    autoRetryAllowed,
    excludeSameAgent,
    requiresHumanEscalation,
    fingerprint: fingerprintOf(failureClass, input.report),
    classifiedAt: input.now,
  };
}

// ---------------------------------------------------------------------------
// Conditional reassignment
// ---------------------------------------------------------------------------

export interface EvaluateConditionalReassignmentInput {
  readonly classification: TaskFailureClassificationV1;
  readonly remainingBudget: number;
  readonly oldAttemptFenced: boolean;
  readonly eligibilityOk: boolean;
  readonly capacityOk: boolean;
  readonly inputsStillValid: boolean;
  readonly unknownExternalEffect: boolean;
  readonly hasQualifiedCandidates: boolean;
  /**
   * 排除失败 Agent 后是否仍有合格候选。
   * capability_mismatch 时 must be true 才允许改派（ADR-0065：不得重试同一 Agent）。
   */
  readonly hasAlternateCandidates?: boolean;
  readonly now: number;
  readonly notBefore?: number;
  readonly hardStopAt?: number;
  readonly minExecutionWindowMs?: number;
}

export type ConditionalReassignmentDecision =
  | { readonly kind: 'offer_allowed'; readonly notBefore?: number }
  | { readonly kind: 'blocked'; readonly reason: string; readonly remediationState: RemediationState }
  | { readonly kind: 'escalate'; readonly reason: string; readonly remediationState: RemediationState };

/**
 * 只有分类允许、预算充足、旧 attempt 已 fencing、输入有效、无 unknown 外部效果、
 * 有候选且 cooldown/期限门槛通过时，才允许创建新 Offer（不直接 claim）。
 */
export function evaluateConditionalReassignment(
  input: EvaluateConditionalReassignmentInput,
): ConditionalReassignmentDecision {
  if (input.unknownExternalEffect) {
    return { kind: 'escalate', reason: 'unknown_external_effect', remediationState: 'escalation_pending' };
  }
  if (!input.classification.autoRetryAllowed) {
    return {
      kind: 'escalate',
      reason: `class_not_auto_retryable:${input.classification.failureClass}`,
      remediationState: 'escalation_pending',
    };
  }
  if (input.remainingBudget <= 0) {
    return { kind: 'escalate', reason: 'budget_exhausted', remediationState: 'escalation_pending' };
  }
  if (!input.oldAttemptFenced) {
    return { kind: 'blocked', reason: 'old_attempt_not_fenced', remediationState: 'retry_pending' };
  }
  if (!input.inputsStillValid) {
    return { kind: 'escalate', reason: 'inputs_invalid', remediationState: 'escalation_pending' };
  }
  if (!input.hasQualifiedCandidates) {
    return { kind: 'escalate', reason: 'no_qualified_candidates', remediationState: 'allocation_blocked' };
  }
  // capability_mismatch：必须有其他 Agent 候选，禁止同一 Agent 盲重试。
  if (input.classification.excludeSameAgent && input.hasAlternateCandidates === false) {
    return {
      kind: 'escalate',
      reason: 'no_alternate_agent_after_exclude',
      remediationState: 'allocation_blocked',
    };
  }
  if (!input.eligibilityOk || !input.capacityOk) {
    return { kind: 'blocked', reason: 'eligibility_or_capacity', remediationState: 'allocation_blocked' };
  }
  if (input.notBefore !== undefined && input.now < input.notBefore) {
    return { kind: 'blocked', reason: 'cooldown_not_elapsed', remediationState: 'retry_pending' };
  }
  if (input.hardStopAt !== undefined) {
    const minWindow = input.minExecutionWindowMs ?? 0;
    if (input.now + minWindow >= input.hardStopAt) {
      return { kind: 'escalate', reason: 'hard_stop_window_insufficient', remediationState: 'escalation_pending' };
    }
  }

  return { kind: 'offer_allowed', notBefore: input.notBefore };
}

// ---------------------------------------------------------------------------
// SLA clocks + progress challenge
// ---------------------------------------------------------------------------

export interface SlaClockSnapshot {
  readonly kind: 'allocation' | 'start' | 'progress' | 'attempt_deadline';
  readonly startedAt: number;
  readonly deadlineAt: number;
  /** 仅 Server 确认的 waiting 可暂停；heartbeat/notice 不算。 */
  readonly paused: boolean;
}

export interface EvaluateSlaInput {
  readonly clocks: readonly SlaClockSnapshot[];
  readonly now: number;
  /** 最后一次有效结构化 progress/checkpoint（不是 heartbeat）。 */
  readonly lastStructuredProgressAt?: number;
  /** heartbeat 仅用于 lease；不得当作 progress。 */
  readonly lastHeartbeatAt?: number;
  /** notice 送达不构成 challenge 成功或 progress。 */
  readonly lastNoticeDeliveredAt?: number;
  readonly openChallenge?: TaskProgressChallengeV1;
  readonly hardStopAt?: number;
  readonly permissionRevoked?: boolean;
  readonly leaseExpired?: boolean;
  readonly explicitRelinquish?: boolean;
}

export type SlaEvaluationDecision =
  | { readonly kind: 'healthy' }
  | { readonly kind: 'issue_challenge'; readonly clockKind: 'progress'; readonly graceSuggestedFrom: number }
  | { readonly kind: 'fence'; readonly reason: 'grace_expired' | 'hard_stop' | 'permission_revoked' | 'lease_expired' | 'safety'; readonly failureClass: TaskFailureClass }
  | { readonly kind: 'escalate'; readonly reason: string; readonly failureClass: TaskFailureClass }
  | { readonly kind: 'sla_breach'; readonly clockKind: 'allocation' | 'start' | 'attempt_deadline' };

/**
 * notice/heartbeat 暂时丢失不立即改派。
 * progress SLA 首次超时 → progress_at_risk challenge；grace 内仅有效 progress 解除。
 */
export function evaluateTaskSla(input: EvaluateSlaInput): SlaEvaluationDecision {
  if (input.hardStopAt !== undefined && input.now >= input.hardStopAt) {
    return { kind: 'fence', reason: 'hard_stop', failureClass: 'deadline_exceeded' };
  }
  if (input.permissionRevoked) {
    return { kind: 'fence', reason: 'permission_revoked', failureClass: 'permission_or_policy_blocked' };
  }
  if (input.leaseExpired) {
    return { kind: 'fence', reason: 'lease_expired', failureClass: 'agent_unavailable' };
  }
  if (input.explicitRelinquish) {
    return { kind: 'fence', reason: 'safety', failureClass: 'agent_unavailable' };
  }

  // 开放 challenge：grace 内只有 structured progress 可解除；到期 fence。
  if (input.openChallenge && input.openChallenge.resolvedAt === undefined) {
    if (
      input.lastStructuredProgressAt !== undefined
      && input.lastStructuredProgressAt >= input.openChallenge.issuedAt
    ) {
      return { kind: 'healthy' };
    }
    // heartbeat / notice 不解除 challenge
    if (input.now >= input.openChallenge.graceDeadlineAt) {
      return { kind: 'fence', reason: 'grace_expired', failureClass: 'no_progress_timeout' };
    }
    return { kind: 'healthy' }; // still in grace, task stays in_progress
  }

  for (const clock of input.clocks) {
    if (clock.paused) continue;
    if (input.now < clock.deadlineAt) continue;

    if (clock.kind === 'progress') {
      // 首次 progress 超时 → challenge，不立刻改派
      return {
        kind: 'issue_challenge',
        clockKind: 'progress',
        graceSuggestedFrom: input.now,
      };
    }
    if (clock.kind === 'allocation' || clock.kind === 'start' || clock.kind === 'attempt_deadline') {
      return { kind: 'sla_breach', clockKind: clock.kind };
    }
  }

  return { kind: 'healthy' };
}

export interface IssueProgressChallengeInput {
  readonly challengeId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly now: number;
  readonly graceMs: number;
}

export function buildProgressChallenge(input: IssueProgressChallengeInput): TaskProgressChallengeV1 {
  return {
    schemaVersion: 1,
    challengeId: input.challengeId,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    taskAttempt: input.taskAttempt,
    claimLeaseId: input.claimLeaseId,
    graceDeadlineAt: input.now + input.graceMs,
    issuedAt: input.now,
  };
}

export interface ResolveProgressChallengeInput {
  readonly challenge: TaskProgressChallengeV1;
  readonly now: number;
  readonly hasStructuredProgress: boolean;
  readonly skipForSafety: boolean;
}

export type ResolveProgressChallengeDecision =
  | { readonly kind: 'resolved'; readonly resolution: 'progress_received' | 'skipped_for_safety'; readonly fenced: false }
  | { readonly kind: 'fence'; readonly resolution: 'grace_expired'; readonly fenced: true; readonly failureClass: 'no_progress_timeout' }
  | { readonly kind: 'still_open' }
  | { readonly kind: 'already_resolved'; readonly resolution: NonNullable<TaskProgressChallengeV1['resolution']> };

export function resolveProgressChallenge(
  input: ResolveProgressChallengeInput,
): ResolveProgressChallengeDecision {
  if (input.challenge.resolvedAt !== undefined && input.challenge.resolution) {
    return { kind: 'already_resolved', resolution: input.challenge.resolution };
  }
  if (input.skipForSafety) {
    return { kind: 'resolved', resolution: 'skipped_for_safety', fenced: false };
  }
  if (input.hasStructuredProgress) {
    return { kind: 'resolved', resolution: 'progress_received', fenced: false };
  }
  if (input.now >= input.challenge.graceDeadlineAt) {
    return {
      kind: 'fence',
      resolution: 'grace_expired',
      fenced: true,
      failureClass: 'no_progress_timeout',
    };
  }
  return { kind: 'still_open' };
}

// ---------------------------------------------------------------------------
// Fencing late writes
// ---------------------------------------------------------------------------

export interface EvaluateLateWriteInput {
  readonly writeAttempt: number;
  readonly writeFencingToken: number;
  readonly currentAttempt: number;
  readonly currentFencingToken: number;
  readonly currentAttemptFenced: boolean;
}

export type LateWriteDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'reject'; readonly reason: 'stale_attempt' | 'stale_fencing_token' | 'attempt_fenced' };

/**
 * grace 后旧 claim/attempt 被 fencing，迟到写入不能覆盖当前结果。
 */
export function evaluateLateWrite(input: EvaluateLateWriteInput): LateWriteDecision {
  if (input.writeAttempt < input.currentAttempt) {
    return { kind: 'reject', reason: 'stale_attempt' };
  }
  if (input.writeFencingToken < input.currentFencingToken) {
    return { kind: 'reject', reason: 'stale_fencing_token' };
  }
  if (input.currentAttemptFenced && input.writeAttempt === input.currentAttempt) {
    return { kind: 'reject', reason: 'attempt_fenced' };
  }
  return { kind: 'accept' };
}

// ---------------------------------------------------------------------------
// Remediation lineage + action_required
// ---------------------------------------------------------------------------

export interface OpenRemediationInput {
  readonly remediationId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly sourceAttempt: number;
  readonly classification: TaskFailureClassificationV1;
  readonly remainingBudget: number;
  readonly now: number;
  readonly policyRevision: number;
  readonly notBefore?: number;
  readonly cooldownMs?: number;
  readonly decision: ConditionalReassignmentDecision | { readonly kind: 'pending_classification' };
}

export function openRemediationState(input: OpenRemediationInput) {
  let state: RemediationState = 'retry_pending';
  let escalationKey: string | undefined;
  let exclusionReasons: string[] | undefined;

  if (input.decision.kind === 'escalate') {
    state = input.decision.remediationState;
    escalationKey = `${input.taskId}:${input.classification.fingerprint}`;
    exclusionReasons = [input.decision.reason];
  } else if (input.decision.kind === 'blocked') {
    state = input.decision.remediationState;
    exclusionReasons = [input.decision.reason];
  } else if (input.decision.kind === 'offer_allowed') {
    state = 'retry_pending';
  }

  const nextWakeAt = input.notBefore ?? (input.cooldownMs !== undefined ? input.now + input.cooldownMs : undefined);

  return {
    schemaVersion: 1 as const,
    remediationId: input.remediationId,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    sourceAttempt: input.sourceAttempt,
    state,
    failureClass: input.classification.failureClass,
    fingerprint: input.classification.fingerprint,
    remainingBudget: input.remainingBudget,
    notBefore: input.notBefore,
    cooldownMs: input.cooldownMs,
    nextWakeAt,
    exclusionReasons,
    policyRevision: input.policyRevision,
    escalationKey,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

const HUMAN_REMEDIATION_COMMANDS: readonly TaskRemediationCommandName[] = [
  'retry-attempt',
  'increase-attempt-budget',
  'revise-subtask-contract',
  'extend-deadline',
  'cancel-subtask',
  'terminate-root-task',
];

export interface BuildActionRequiredInput {
  readonly actionRequiredId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly sourceAttempt: number;
  readonly classification: TaskFailureClassificationV1;
  readonly remainingBudget: number;
  readonly confirmationToken: string;
  readonly now: number;
  readonly existing?: TaskActionRequiredV1;
  /** 是否允许根终止（仅当 authority 具备时）。 */
  readonly allowTerminateRoot?: boolean;
}

/**
 * 稳定 escalation key 聚合；重复故障不轰炸。
 * 实质变化才递增 revision。
 */
export function buildOrAggregateActionRequired(
  input: BuildActionRequiredInput,
): TaskActionRequiredV1 {
  const escalationKey = `${input.taskId}:${input.classification.fingerprint}`;
  const allowedCommands = HUMAN_REMEDIATION_COMMANDS.filter(
    (c) => input.allowTerminateRoot || c !== 'terminate-root-task',
  );

  if (input.existing && input.existing.escalationKey === escalationKey && input.existing.status === 'open') {
    // 相同事实聚合：不递增 revision（除非预算/revision/允许命令实质变化）
    const materialChange =
      input.existing.taskRevision !== input.taskRevision
      || input.existing.remainingBudget !== input.remainingBudget
      || input.existing.allowedCommands.join(',') !== allowedCommands.join(',');

    if (!materialChange) {
      return {
        ...input.existing,
        updatedAt: input.now,
      };
    }
    return {
      ...input.existing,
      taskRevision: input.taskRevision,
      sourceAttempt: input.sourceAttempt,
      remainingBudget: input.remainingBudget,
      allowedCommands,
      revision: input.existing.revision + 1,
      confirmationToken: input.confirmationToken,
      updatedAt: input.now,
    };
  }

  return {
    schemaVersion: 1,
    actionRequiredId: input.actionRequiredId,
    escalationKey,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    sourceAttempt: input.sourceAttempt,
    failureClass: input.classification.failureClass,
    remainingBudget: input.remainingBudget,
    allowedCommands,
    confirmationToken: input.confirmationToken,
    status: 'open',
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * read/seen/dismiss/notice_failed/chat_message 不能解决 action_required。
 */
export function evaluateActionRequiredSignal(
  actionRequired: TaskActionRequiredV1,
  signal: NonResolvingActionRequiredSignal,
): { readonly stillOpen: true; readonly signalIgnored: NonResolvingActionRequiredSignal } {
  void actionRequired;
  return { stillOpen: true, signalIgnored: signal };
}

export interface AuthorizeRemediationCommandInput {
  readonly commandName: TaskRemediationCommandName;
  readonly actionRequired: TaskActionRequiredV1;
  readonly confirmationToken: string;
  readonly expectedEscalationRevision: number;
  readonly actorHasRootTerminationAuthority: boolean;
}

export type AuthorizeRemediationCommandDecision =
  | { readonly kind: 'authorized' }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * 具名 remediation command：绑定 token + escalation revision。
 */
export function authorizeRemediationCommand(
  input: AuthorizeRemediationCommandInput,
): AuthorizeRemediationCommandDecision {
  if (input.actionRequired.status !== 'open') {
    return { kind: 'rejected', reason: 'action_required_not_open' };
  }
  if (input.actionRequired.confirmationToken !== input.confirmationToken) {
    return { kind: 'rejected', reason: 'invalid_confirmation_token' };
  }
  if (input.actionRequired.revision !== input.expectedEscalationRevision) {
    return { kind: 'rejected', reason: 'stale_escalation_revision' };
  }
  if (!input.actionRequired.allowedCommands.includes(input.commandName)) {
    return { kind: 'rejected', reason: 'command_not_allowed' };
  }
  if (input.commandName === 'terminate-root-task' && !input.actorHasRootTerminationAuthority) {
    return { kind: 'rejected', reason: 'missing_root_termination_authority' };
  }
  return { kind: 'authorized' };
}

// ---------------------------------------------------------------------------
// Root task isolation —— 子任务失败不自动终结 root
// ---------------------------------------------------------------------------

export interface EvaluateRootImpactInput {
  readonly subtaskFailed: boolean;
  readonly rootStatus: 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled' | 'closed';
}

export type RootImpactDecision =
  | { readonly kind: 'root_unchanged' }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * 子任务失败不自动终结 root Task（#928 AC / ADR-0065）。
 */
export function evaluateRootImpactFromSubtaskFailure(
  input: EvaluateRootImpactInput,
): RootImpactDecision {
  if (!input.subtaskFailed) return { kind: 'root_unchanged' };
  // 终态 root 不可变；非终态也保持不变——失败只影响子任务与 remediation。
  return { kind: 'root_unchanged' };
}

// ---------------------------------------------------------------------------
// Unaccepted handoff material provenance
// ---------------------------------------------------------------------------

export interface BindHandoffMaterialInput {
  readonly material: UnacceptedHandoffMaterialRefV1;
  readonly newContractId: string;
  readonly explicitBind: boolean;
}

export type BindHandoffMaterialDecision =
  | { readonly kind: 'bound'; readonly material: UnacceptedHandoffMaterialRefV1 }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * 只有新合同显式绑定后可参考 Unaccepted handoff material。
 */
export function bindUnacceptedHandoffMaterial(
  input: BindHandoffMaterialInput,
): BindHandoffMaterialDecision {
  if (!input.explicitBind) {
    return { kind: 'rejected', reason: 'explicit_bind_required' };
  }
  if (input.material.boundToContractId !== undefined) {
    return { kind: 'rejected', reason: 'already_bound' };
  }
  return {
    kind: 'bound',
    material: {
      ...input.material,
      boundToContractId: input.newContractId,
    },
  };
}

// ---------------------------------------------------------------------------
// Cooldown / notBefore helpers
// ---------------------------------------------------------------------------

export interface ComputeRetryNotBeforeInput {
  readonly now: number;
  readonly failureClass: TaskFailureClass;
  readonly attemptNumber: number;
  readonly baseCooldownMs: number;
}

/**
 * 指数退避 notBefore；unknown/权限类不应进入此路径（由 classification 拦截）。
 */
export function computeRetryNotBefore(input: ComputeRetryNotBeforeInput): number {
  const exponent = Math.max(0, input.attemptNumber - 1);
  const delay = input.baseCooldownMs * (2 ** Math.min(exponent, 8));
  return input.now + delay;
}

export function canWakeRemediation(input: {
  readonly now: number;
  readonly notBefore?: number;
  readonly nextWakeAt?: number;
}): boolean {
  if (input.notBefore !== undefined && input.now < input.notBefore) return false;
  if (input.nextWakeAt !== undefined && input.now < input.nextWakeAt) return false;
  return true;
}
