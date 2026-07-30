import type { ID, UnixMs } from './common.js';
import {
  COMMAND_PROVENANCE_KINDS,
  type CommandProvenanceKind,
  type CommandProvenanceRefV1,
} from './message-tracer.js';

/**
 * Task failure classification / SLA / conditional reassignment / human remediation
 * （issue #928 / ADR-0065）。
 *
 * 失败不新增 failed TaskStatus，也不自动终结根 Task。Server 用版本化 taxonomy 形成
 * 权威分类；只有允许的类别在预算内可自动改派（只发 Offer）。SLA 与 challenge/grace
 * 为独立非 TaskStatus 事实；升级为独立 action_required，read/seen/dismiss 不能解决。
 */

// ---------------------------------------------------------------------------
// Taxonomy + remediation vocabulary
// ---------------------------------------------------------------------------

/** 版本化 failure taxonomy（CONTEXT.md Task failure classification）。 */
export const TASK_FAILURE_CLASSES = [
  'transient_environment',
  'agent_unavailable',
  'capability_mismatch',
  'invalid_input_or_contract',
  'permission_or_policy_blocked',
  'deadline_exceeded',
  'no_progress_timeout',
  'unknown',
] as const;
export type TaskFailureClass = (typeof TASK_FAILURE_CLASSES)[number];

export const TASK_FAILURE_TAXONOMY_VERSION = 1;

/** 终止 attempt 的事件（是否消耗 budget 由 domain 判定）。 */
export const ATTEMPT_TERMINATION_EVENTS = [
  'failure',
  'timeout',
  'relinquish',
  'fence',
  'offer_reject',
  'offer_expire',
  'pre_start_relinquish',
  'pre_start_fence',
] as const;
export type AttemptTerminationEvent = (typeof ATTEMPT_TERMINATION_EVENTS)[number];

export const REMEDIATION_STATES = [
  'retry_pending',
  'allocation_blocked',
  'escalation_pending',
  'recovery_pending',
  'resolved',
] as const;
export type RemediationState = (typeof REMEDIATION_STATES)[number];

export const SLA_CLOCK_KINDS = [
  'allocation',
  'start',
  'progress',
  'attempt_deadline',
] as const;
export type SlaClockKind = (typeof SLA_CLOCK_KINDS)[number];

export const SLA_FACT_KINDS = [
  'healthy',
  'progress_at_risk',
  'no_progress_timeout',
  'allocation_sla_breached',
  'start_sla_breached',
  'attempt_deadline_exceeded',
  'hard_stop',
] as const;
export type SlaFactKind = (typeof SLA_FACT_KINDS)[number];

export const TASK_REMEDIATION_COMMAND_NAMES = [
  'classify-failure',
  'issue-progress-challenge',
  'resolve-progress-challenge',
  'fence-stale-attempt',
  'request-conditional-reassignment',
  'retry-attempt',
  'increase-attempt-budget',
  'revise-subtask-contract',
  'extend-deadline',
  'cancel-subtask',
  'terminate-root-task',
  'acknowledge-action-required',
] as const;
export type TaskRemediationCommandName = (typeof TASK_REMEDIATION_COMMAND_NAMES)[number];

export const TASK_REMEDIATION_ENVELOPE_SCHEMA_VERSION = 1;
export const TASK_REMEDIATION_COMMAND_SCHEMA_VERSION = 1;
export const TASK_REMEDIATION_COMMAND_HASH_VERSION = 1;

export const TASK_REMEDIATION_RECEIPT_OUTCOMES = ['applied', 'no_op'] as const;
export type TaskRemediationReceiptOutcome = (typeof TASK_REMEDIATION_RECEIPT_OUTCOMES)[number];

export const TASK_REMEDIATION_OUTCOMES = [
  'applied', 'no_op', 'replayed', 'freshness_hold',
  'conflict', 'rejected', 'temporarily_unavailable', 'outcome_unknown',
] as const;
export type TaskRemediationOutcome = (typeof TASK_REMEDIATION_OUTCOMES)[number];

export const TASK_REMEDIATION_RETRY_DIRECTIVES = [
  'none', 'same_key', 'reread_then_new_command', 'user_action',
] as const;
export type TaskRemediationRetryDirective = (typeof TASK_REMEDIATION_RETRY_DIRECTIVES)[number];

/** 不能解决 action_required 的伪动作（#928 AC）。 */
export const NON_RESOLVING_ACTION_REQUIRED_SIGNALS = [
  'read',
  'seen',
  'dismiss',
  'notice_failed',
  'chat_message',
] as const;
export type NonResolvingActionRequiredSignal =
  (typeof NON_RESOLVING_ACTION_REQUIRED_SIGNALS)[number];

// ---------------------------------------------------------------------------
// Core records
// ---------------------------------------------------------------------------

export interface TaskFailureReportV1 {
  readonly schemaVersion: 1;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
  readonly errorCode: string;
  readonly observableFacts: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly reportedBy: 'agent' | 'daemon' | 'server';
  readonly reportedAt: UnixMs;
}

export interface TaskFailureClassificationV1 {
  readonly schemaVersion: 1;
  readonly taxonomyVersion: number;
  readonly failureClass: TaskFailureClass;
  readonly autoRetryAllowed: boolean;
  /** capability_mismatch 时禁止重试同一 agent。 */
  readonly excludeSameAgent: boolean;
  readonly requiresHumanEscalation: boolean;
  readonly fingerprint: string;
  readonly classifiedAt: UnixMs;
  readonly sourceReportId?: ID;
}

export interface ExecutionRetryBudgetV1 {
  readonly schemaVersion: 1;
  readonly maxStartedAttempts: number;
  readonly startedAttemptsConsumed: number;
  readonly remaining: number;
}

export interface RetryRemediationStateV1 {
  readonly schemaVersion: 1;
  readonly remediationId: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly sourceAttempt: number;
  readonly state: RemediationState;
  readonly failureClass: TaskFailureClass;
  readonly fingerprint: string;
  readonly remainingBudget: number;
  readonly notBefore?: UnixMs;
  readonly cooldownMs?: number;
  readonly nextWakeAt?: UnixMs;
  readonly exclusionReasons?: readonly string[];
  readonly policyRevision: number;
  readonly escalationKey?: string;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface TaskProgressChallengeV1 {
  readonly schemaVersion: 1;
  readonly challengeId: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
  readonly graceDeadlineAt: UnixMs;
  readonly issuedAt: UnixMs;
  readonly resolvedAt?: UnixMs;
  readonly resolution?: 'progress_received' | 'grace_expired' | 'skipped_for_safety';
}

export interface TaskActionRequiredV1 {
  readonly schemaVersion: 1;
  readonly actionRequiredId: ID;
  readonly escalationKey: string;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly sourceAttempt: number;
  readonly failureClass: TaskFailureClass;
  readonly remainingBudget: number;
  readonly allowedCommands: readonly TaskRemediationCommandName[];
  readonly confirmationToken: string;
  readonly status: 'open' | 'resolved';
  readonly revision: number;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
  readonly resolvedAt?: UnixMs;
  readonly resolvedByCommand?: TaskRemediationCommandName;
}

export interface UnacceptedHandoffMaterialRefV1 {
  readonly schemaVersion: 1;
  readonly materialId: ID;
  readonly taskId: ID;
  readonly sourceAttempt: number;
  readonly claimLeaseId: ID;
  readonly provenanceHash: string;
  readonly boundToContractId?: ID;
}

// ---------------------------------------------------------------------------
// Command envelope + I/O maps
// ---------------------------------------------------------------------------

export interface TaskRemediationCommandEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly commandName: TaskRemediationCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly causationRef?: CommandProvenanceRefV1;
  readonly sourceRefs?: readonly CommandProvenanceRefV1[];
}

export interface TaskRemediationCommandInputMapV1 {
  readonly 'classify-failure': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly claimLeaseId: ID;
    readonly report: TaskFailureReportV1;
    readonly serverDetectedSignals?: {
      readonly permissionRevoked?: boolean;
      readonly deadlineExceeded?: boolean;
      readonly hardStopReached?: boolean;
      readonly leaseExpired?: boolean;
      readonly unknownExternalEffect?: boolean;
    };
  };
  readonly 'issue-progress-challenge': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly claimLeaseId: ID;
    readonly graceDeadlineAt: UnixMs;
  };
  readonly 'resolve-progress-challenge': {
    readonly challengeId: ID;
    readonly taskId: ID;
    readonly expectedTaskRevision: number;
    readonly resolution: 'progress_received' | 'grace_expired' | 'skipped_for_safety';
    readonly progressCheckpointId?: ID;
  };
  readonly 'fence-stale-attempt': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly claimLeaseId: ID;
    readonly fencingToken: number;
    readonly reason: 'grace_expired' | 'hard_stop' | 'permission_revoked' | 'lease_expired' | 'safety';
  };
  readonly 'request-conditional-reassignment': {
    readonly taskId: ID;
    readonly expectedTaskRevision: number;
    readonly sourceAttempt: number;
    readonly expectedFencingToken: number;
    readonly classificationId: ID;
    readonly notBefore?: UnixMs;
  };
  readonly 'retry-attempt': {
    readonly taskId: ID;
    readonly expectedTaskRevision: number;
    readonly actionRequiredId: ID;
    readonly confirmationToken: string;
    readonly expectedEscalationRevision: number;
  };
  readonly 'increase-attempt-budget': {
    readonly taskId: ID;
    readonly expectedTaskRevision: number;
    readonly actionRequiredId: ID;
    readonly confirmationToken: string;
    readonly expectedEscalationRevision: number;
    readonly additionalAttempts: number;
  };
  readonly 'revise-subtask-contract': {
    readonly taskId: ID;
    readonly expectedTaskRevision: number;
    readonly actionRequiredId: ID;
    readonly confirmationToken: string;
    readonly expectedEscalationRevision: number;
    readonly contractPatchHash: string;
  };
  readonly 'extend-deadline': {
    readonly taskId: ID;
    readonly expectedTaskRevision: number;
    readonly actionRequiredId: ID;
    readonly confirmationToken: string;
    readonly expectedEscalationRevision: number;
    readonly newDueAt?: UnixMs;
    readonly newHardStopAt?: UnixMs;
  };
  readonly 'cancel-subtask': {
    readonly taskId: ID;
    readonly expectedTaskRevision: number;
    readonly actionRequiredId: ID;
    readonly confirmationToken: string;
    readonly expectedEscalationRevision: number;
    readonly reason: string;
  };
  readonly 'terminate-root-task': {
    readonly rootTaskId: ID;
    readonly expectedTaskRevision: number;
    readonly actionRequiredId: ID;
    readonly confirmationToken: string;
    readonly expectedEscalationRevision: number;
    readonly reason: string;
  };
  readonly 'acknowledge-action-required': {
    readonly actionRequiredId: ID;
    readonly signal: NonResolvingActionRequiredSignal;
  };
}

export interface TaskRemediationCommandOutputMapV1 {
  readonly 'classify-failure': {
    readonly classificationId: ID;
    readonly classification: TaskFailureClassificationV1;
    readonly remediation: RetryRemediationStateV1;
    readonly actionRequired?: TaskActionRequiredV1;
  };
  readonly 'issue-progress-challenge': {
    readonly challenge: TaskProgressChallengeV1;
    readonly slaFact: 'progress_at_risk';
    readonly taskStatusUnchanged: true;
  };
  readonly 'resolve-progress-challenge': {
    readonly challengeId: ID;
    readonly resolution: 'progress_received' | 'grace_expired' | 'skipped_for_safety';
    readonly fenced: boolean;
  };
  readonly 'fence-stale-attempt': {
    readonly taskId: ID;
    readonly fencedAttempt: number;
    readonly fencingToken: number;
    readonly lateWritesRejected: true;
  };
  readonly 'request-conditional-reassignment': {
    readonly decision: 'offer_allowed' | 'escalated' | 'blocked';
    readonly offerId?: ID;
    readonly remediation: RetryRemediationStateV1;
    readonly actionRequired?: TaskActionRequiredV1;
  };
  readonly 'retry-attempt': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly remediation: RetryRemediationStateV1;
  };
  readonly 'increase-attempt-budget': {
    readonly taskId: ID;
    readonly budget: ExecutionRetryBudgetV1;
  };
  readonly 'revise-subtask-contract': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly contractPatchHash: string;
  };
  readonly 'extend-deadline': {
    readonly taskId: ID;
    readonly dueAt?: UnixMs;
    readonly hardStopAt?: UnixMs;
  };
  readonly 'cancel-subtask': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly status: 'cancelled';
  };
  readonly 'terminate-root-task': {
    readonly rootTaskId: ID;
    readonly taskRevision: number;
    readonly status: 'cancelled' | 'closed';
  };
  readonly 'acknowledge-action-required': {
    readonly actionRequiredId: ID;
    readonly stillOpen: true;
    readonly signalIgnored: NonResolvingActionRequiredSignal;
  };
}

export type TaskRemediationCommandOutputUnionV1 =
  | ({ readonly commandName: 'classify-failure' } & TaskRemediationCommandOutputMapV1['classify-failure'])
  | ({ readonly commandName: 'issue-progress-challenge' } & TaskRemediationCommandOutputMapV1['issue-progress-challenge'])
  | ({ readonly commandName: 'resolve-progress-challenge' } & TaskRemediationCommandOutputMapV1['resolve-progress-challenge'])
  | ({ readonly commandName: 'fence-stale-attempt' } & TaskRemediationCommandOutputMapV1['fence-stale-attempt'])
  | ({ readonly commandName: 'request-conditional-reassignment' } & TaskRemediationCommandOutputMapV1['request-conditional-reassignment'])
  | ({ readonly commandName: 'retry-attempt' } & TaskRemediationCommandOutputMapV1['retry-attempt'])
  | ({ readonly commandName: 'increase-attempt-budget' } & TaskRemediationCommandOutputMapV1['increase-attempt-budget'])
  | ({ readonly commandName: 'revise-subtask-contract' } & TaskRemediationCommandOutputMapV1['revise-subtask-contract'])
  | ({ readonly commandName: 'extend-deadline' } & TaskRemediationCommandOutputMapV1['extend-deadline'])
  | ({ readonly commandName: 'cancel-subtask' } & TaskRemediationCommandOutputMapV1['cancel-subtask'])
  | ({ readonly commandName: 'terminate-root-task' } & TaskRemediationCommandOutputMapV1['terminate-root-task'])
  | ({ readonly commandName: 'acknowledge-action-required' } & TaskRemediationCommandOutputMapV1['acknowledge-action-required']);

export interface TaskRemediationEventRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
}

export interface TaskRemediationRevisionRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

export interface TaskRemediationCommandReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: ID;
  readonly commandName: TaskRemediationCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: 'applied' | 'no_op';
  readonly committedRevisions: readonly TaskRemediationRevisionRefV1[];
  readonly eventRefs: readonly TaskRemediationEventRefV1[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
}

export interface TaskRemediationCommandResponseV1 {
  readonly schemaVersion: 1;
  readonly commandName: TaskRemediationCommandName;
  readonly outcome: TaskRemediationOutcome;
  readonly retryDirective: TaskRemediationRetryDirective;
  readonly stableCode: string;
  readonly receipt?: TaskRemediationCommandReceiptV1;
  readonly result?: TaskRemediationCommandOutputUnionV1;
  readonly conflictReason?: string;
  readonly rejectReason?: string;
  readonly freshnessReason?: string;
}

// ---------------------------------------------------------------------------
// Exact-key runtime schema
// ---------------------------------------------------------------------------

const TASK_REMEDIATION_PAYLOAD_INVALID = 'TASK_REMEDIATION_PAYLOAD_INVALID';

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertId(value: unknown): void {
  if (!nonEmpty(value)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertCommandName(value: unknown): asserts value is TaskRemediationCommandName {
  if (!TASK_REMEDIATION_COMMAND_NAMES.includes(value as TaskRemediationCommandName)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertFailureClass(value: unknown): asserts value is TaskFailureClass {
  if (!TASK_FAILURE_CLASSES.includes(value as TaskFailureClass)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertRemediationState(value: unknown): asserts value is RemediationState {
  if (!REMEDIATION_STATES.includes(value as RemediationState)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertNonResolvingSignal(value: unknown): asserts value is NonResolvingActionRequiredSignal {
  if (!NON_RESOLVING_ACTION_REQUIRED_SIGNALS.includes(value as NonResolvingActionRequiredSignal)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertCommandProvenanceRef(value: unknown): void {
  assertExactKeys(value, ['kind', 'id', 'revision', 'sequence', 'scope', 'hash'], ['kind', 'id']);
  if (!COMMAND_PROVENANCE_KINDS.includes(value.kind as CommandProvenanceKind)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  assertId(value.id);
  if (value.revision !== undefined) assertInteger(value.revision, 0);
  if (value.sequence !== undefined) assertInteger(value.sequence, 0);
  if (value.scope !== undefined && !nonEmpty(value.scope)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  if (value.hash !== undefined && !nonEmpty(value.hash)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertStringArray(value: unknown): void {
  if (!Array.isArray(value) || value.some((item) => !nonEmpty(item))) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertFailureReport(value: unknown): void {
  assertExactKeys(
    value,
    ['schemaVersion', 'taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId', 'errorCode',
      'observableFacts', 'evidenceRefs', 'reportedBy', 'reportedAt'],
    ['schemaVersion', 'taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId', 'errorCode',
      'observableFacts', 'reportedBy', 'reportedAt'],
  );
  if (value.schemaVersion !== 1) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertId(value.taskId);
  assertInteger(value.taskRevision, 0);
  assertInteger(value.taskAttempt, 0);
  assertId(value.claimLeaseId);
  if (!nonEmpty(value.errorCode)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertStringArray(value.observableFacts);
  if (value.evidenceRefs !== undefined) assertStringArray(value.evidenceRefs);
  if (value.reportedBy !== 'agent' && value.reportedBy !== 'daemon' && value.reportedBy !== 'server') {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  assertInteger(value.reportedAt, 0);
}

function assertFailureClassification(value: unknown): void {
  assertExactKeys(
    value,
    ['schemaVersion', 'taxonomyVersion', 'failureClass', 'autoRetryAllowed', 'excludeSameAgent',
      'requiresHumanEscalation', 'fingerprint', 'classifiedAt', 'sourceReportId'],
    ['schemaVersion', 'taxonomyVersion', 'failureClass', 'autoRetryAllowed', 'excludeSameAgent',
      'requiresHumanEscalation', 'fingerprint', 'classifiedAt'],
  );
  if (value.schemaVersion !== 1) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertInteger(value.taxonomyVersion, 1);
  assertFailureClass(value.failureClass);
  if (typeof value.autoRetryAllowed !== 'boolean') throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  if (typeof value.excludeSameAgent !== 'boolean') throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  if (typeof value.requiresHumanEscalation !== 'boolean') {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.fingerprint)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertInteger(value.classifiedAt, 0);
  if (value.sourceReportId !== undefined) assertId(value.sourceReportId);
}

function assertRetryRemediationState(value: unknown): void {
  assertExactKeys(
    value,
    ['schemaVersion', 'remediationId', 'taskId', 'taskRevision', 'sourceAttempt', 'state',
      'failureClass', 'fingerprint', 'remainingBudget', 'notBefore', 'cooldownMs', 'nextWakeAt',
      'exclusionReasons', 'policyRevision', 'escalationKey', 'createdAt', 'updatedAt'],
    ['schemaVersion', 'remediationId', 'taskId', 'taskRevision', 'sourceAttempt', 'state',
      'failureClass', 'fingerprint', 'remainingBudget', 'policyRevision', 'createdAt', 'updatedAt'],
  );
  if (value.schemaVersion !== 1) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertId(value.remediationId);
  assertId(value.taskId);
  assertInteger(value.taskRevision, 0);
  assertInteger(value.sourceAttempt, 0);
  assertRemediationState(value.state);
  assertFailureClass(value.failureClass);
  if (!nonEmpty(value.fingerprint)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertInteger(value.remainingBudget, 0);
  if (value.notBefore !== undefined) assertInteger(value.notBefore, 0);
  if (value.cooldownMs !== undefined) assertInteger(value.cooldownMs, 0);
  if (value.nextWakeAt !== undefined) assertInteger(value.nextWakeAt, 0);
  if (value.exclusionReasons !== undefined) assertStringArray(value.exclusionReasons);
  assertInteger(value.policyRevision, 0);
  if (value.escalationKey !== undefined && !nonEmpty(value.escalationKey)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  assertInteger(value.createdAt, 0);
  assertInteger(value.updatedAt, 0);
}

function assertActionRequired(value: unknown): void {
  assertExactKeys(
    value,
    ['schemaVersion', 'actionRequiredId', 'escalationKey', 'taskId', 'taskRevision', 'sourceAttempt',
      'failureClass', 'remainingBudget', 'allowedCommands', 'confirmationToken', 'status',
      'revision', 'createdAt', 'updatedAt', 'resolvedAt', 'resolvedByCommand'],
    ['schemaVersion', 'actionRequiredId', 'escalationKey', 'taskId', 'taskRevision', 'sourceAttempt',
      'failureClass', 'remainingBudget', 'allowedCommands', 'confirmationToken', 'status',
      'revision', 'createdAt', 'updatedAt'],
  );
  if (value.schemaVersion !== 1) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertId(value.actionRequiredId);
  if (!nonEmpty(value.escalationKey)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertId(value.taskId);
  assertInteger(value.taskRevision, 0);
  assertInteger(value.sourceAttempt, 0);
  assertFailureClass(value.failureClass);
  assertInteger(value.remainingBudget, 0);
  if (!Array.isArray(value.allowedCommands)
    || value.allowedCommands.some((c) => !TASK_REMEDIATION_COMMAND_NAMES.includes(c as TaskRemediationCommandName))) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.confirmationToken)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  if (value.status !== 'open' && value.status !== 'resolved') {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  assertInteger(value.revision, 1);
  assertInteger(value.createdAt, 0);
  assertInteger(value.updatedAt, 0);
  if (value.resolvedAt !== undefined) assertInteger(value.resolvedAt, 0);
  if (value.resolvedByCommand !== undefined) assertCommandName(value.resolvedByCommand);
}

function assertProgressChallenge(value: unknown): void {
  assertExactKeys(
    value,
    ['schemaVersion', 'challengeId', 'taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId',
      'graceDeadlineAt', 'issuedAt', 'resolvedAt', 'resolution'],
    ['schemaVersion', 'challengeId', 'taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId',
      'graceDeadlineAt', 'issuedAt'],
  );
  if (value.schemaVersion !== 1) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertId(value.challengeId);
  assertId(value.taskId);
  assertInteger(value.taskRevision, 0);
  assertInteger(value.taskAttempt, 0);
  assertId(value.claimLeaseId);
  assertInteger(value.graceDeadlineAt, 0);
  assertInteger(value.issuedAt, 0);
  if (value.resolvedAt !== undefined) assertInteger(value.resolvedAt, 0);
  if (value.resolution !== undefined
    && value.resolution !== 'progress_received'
    && value.resolution !== 'grace_expired'
    && value.resolution !== 'skipped_for_safety') {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertServerDetectedSignals(value: unknown): void {
  assertExactKeys(
    value,
    ['permissionRevoked', 'deadlineExceeded', 'hardStopReached', 'leaseExpired', 'unknownExternalEffect'],
    [],
  );
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== 'boolean') throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertClassifyFailureInput(value: unknown): void {
  assertExactKeys(
    value,
    ['taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId', 'report', 'serverDetectedSignals'],
    ['taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId', 'report'],
  );
  assertId(value.taskId);
  assertInteger(value.taskRevision, 0);
  assertInteger(value.taskAttempt, 0);
  assertId(value.claimLeaseId);
  assertFailureReport(value.report);
  if (value.serverDetectedSignals !== undefined) assertServerDetectedSignals(value.serverDetectedSignals);
}

function assertIssueProgressChallengeInput(value: unknown): void {
  assertExactKeys(
    value,
    ['taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId', 'graceDeadlineAt'],
    ['taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId', 'graceDeadlineAt'],
  );
  assertId(value.taskId);
  assertInteger(value.taskRevision, 0);
  assertInteger(value.taskAttempt, 0);
  assertId(value.claimLeaseId);
  assertInteger(value.graceDeadlineAt, 0);
}

function assertResolveProgressChallengeInput(value: unknown): void {
  assertExactKeys(
    value,
    ['challengeId', 'taskId', 'expectedTaskRevision', 'resolution', 'progressCheckpointId'],
    ['challengeId', 'taskId', 'expectedTaskRevision', 'resolution'],
  );
  assertId(value.challengeId);
  assertId(value.taskId);
  assertInteger(value.expectedTaskRevision, 0);
  if (value.resolution !== 'progress_received'
    && value.resolution !== 'grace_expired'
    && value.resolution !== 'skipped_for_safety') {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  if (value.progressCheckpointId !== undefined) assertId(value.progressCheckpointId);
}

function assertFenceStaleAttemptInput(value: unknown): void {
  assertExactKeys(
    value,
    ['taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId', 'fencingToken', 'reason'],
    ['taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId', 'fencingToken', 'reason'],
  );
  assertId(value.taskId);
  assertInteger(value.taskRevision, 0);
  assertInteger(value.taskAttempt, 0);
  assertId(value.claimLeaseId);
  assertInteger(value.fencingToken, 1);
  if (value.reason !== 'grace_expired'
    && value.reason !== 'hard_stop'
    && value.reason !== 'permission_revoked'
    && value.reason !== 'lease_expired'
    && value.reason !== 'safety') {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
}

function assertRequestConditionalReassignmentInput(value: unknown): void {
  assertExactKeys(
    value,
    ['taskId', 'expectedTaskRevision', 'sourceAttempt', 'expectedFencingToken', 'classificationId', 'notBefore'],
    ['taskId', 'expectedTaskRevision', 'sourceAttempt', 'expectedFencingToken', 'classificationId'],
  );
  assertId(value.taskId);
  assertInteger(value.expectedTaskRevision, 0);
  assertInteger(value.sourceAttempt, 0);
  assertInteger(value.expectedFencingToken, 1);
  assertId(value.classificationId);
  if (value.notBefore !== undefined) assertInteger(value.notBefore, 0);
}

function assertEscalationBoundInput(value: unknown, extraAllowed: readonly string[], extraRequired: readonly string[]): void {
  assertExactKeys(
    value,
    ['taskId', 'expectedTaskRevision', 'actionRequiredId', 'confirmationToken', 'expectedEscalationRevision',
      ...extraAllowed],
    ['taskId', 'expectedTaskRevision', 'actionRequiredId', 'confirmationToken', 'expectedEscalationRevision',
      ...extraRequired],
  );
  assertId(value.taskId);
  assertInteger(value.expectedTaskRevision, 0);
  assertId(value.actionRequiredId);
  if (!nonEmpty(value.confirmationToken)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertInteger(value.expectedEscalationRevision, 1);
}

function assertTaskRemediationInput(commandName: TaskRemediationCommandName, value: unknown): void {
  switch (commandName) {
    case 'classify-failure':
      assertClassifyFailureInput(value);
      return;
    case 'issue-progress-challenge':
      assertIssueProgressChallengeInput(value);
      return;
    case 'resolve-progress-challenge':
      assertResolveProgressChallengeInput(value);
      return;
    case 'fence-stale-attempt':
      assertFenceStaleAttemptInput(value);
      return;
    case 'request-conditional-reassignment':
      assertRequestConditionalReassignmentInput(value);
      return;
    case 'retry-attempt':
      assertEscalationBoundInput(value, [], []);
      return;
    case 'increase-attempt-budget':
      assertEscalationBoundInput(value, ['additionalAttempts'], ['additionalAttempts']);
      assertInteger((value as Record<string, unknown>).additionalAttempts, 1);
      return;
    case 'revise-subtask-contract':
      assertEscalationBoundInput(value, ['contractPatchHash'], ['contractPatchHash']);
      if (!nonEmpty((value as Record<string, unknown>).contractPatchHash)) {
        throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
      }
      return;
    case 'extend-deadline':
      assertEscalationBoundInput(value, ['newDueAt', 'newHardStopAt'], []);
      if ((value as Record<string, unknown>).newDueAt !== undefined) {
        assertInteger((value as Record<string, unknown>).newDueAt, 0);
      }
      if ((value as Record<string, unknown>).newHardStopAt !== undefined) {
        assertInteger((value as Record<string, unknown>).newHardStopAt, 0);
      }
      return;
    case 'cancel-subtask':
      assertEscalationBoundInput(value, ['reason'], ['reason']);
      if (!nonEmpty((value as Record<string, unknown>).reason)) {
        throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
      }
      return;
    case 'terminate-root-task': {
      assertExactKeys(
        value,
        ['rootTaskId', 'expectedTaskRevision', 'actionRequiredId', 'confirmationToken',
          'expectedEscalationRevision', 'reason'],
        ['rootTaskId', 'expectedTaskRevision', 'actionRequiredId', 'confirmationToken',
          'expectedEscalationRevision', 'reason'],
      );
      assertId(value.rootTaskId);
      assertInteger(value.expectedTaskRevision, 0);
      assertId(value.actionRequiredId);
      if (!nonEmpty(value.confirmationToken)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
      assertInteger(value.expectedEscalationRevision, 1);
      if (!nonEmpty(value.reason)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
      return;
    }
    case 'acknowledge-action-required':
      assertExactKeys(value, ['actionRequiredId', 'signal'], ['actionRequiredId', 'signal']);
      assertId(value.actionRequiredId);
      assertNonResolvingSignal(value.signal);
      return;
    default: {
      const _exhaustive: never = commandName;
      void _exhaustive;
      throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
    }
  }
}

function assertRevisionRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'revision'], ['streamKind', 'streamId', 'revision']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  assertInteger(value.revision, 0);
}

function assertEventRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'sequence'], ['streamKind', 'streamId', 'sequence']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  assertInteger(value.sequence, 0);
}

function assertCommandReceipt(value: unknown): void {
  assertExactKeys(
    value,
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey',
      'commandHash', 'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable'],
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey',
      'commandHash', 'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable'],
  );
  if (value.schemaVersion !== 1) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertId(value.receiptId);
  assertCommandName(value.commandName);
  assertInteger(value.commandSchemaVersion, 1);
  assertId(value.idempotencyKey);
  assertId(value.commandHash);
  if (!TASK_REMEDIATION_RECEIPT_OUTCOMES.includes(value.outcome as TaskRemediationReceiptOutcome)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  if (!Array.isArray(value.committedRevisions)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  value.committedRevisions.forEach(assertRevisionRef);
  if (!Array.isArray(value.eventRefs)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  value.eventRefs.forEach(assertEventRef);
  assertInteger(value.commitTime, 0);
  if (typeof value.resultAvailable !== 'boolean') throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
}

// ---------------------------------------------------------------------------
// Parsers + canonical hash
// ---------------------------------------------------------------------------

export function parseTaskFailureReportV1(value: unknown): TaskFailureReportV1 {
  assertFailureReport(value);
  return structuredClone(value) as unknown as TaskFailureReportV1;
}

export function parseTaskFailureClassificationV1(value: unknown): TaskFailureClassificationV1 {
  assertFailureClassification(value);
  return structuredClone(value) as unknown as TaskFailureClassificationV1;
}

export function parseRetryRemediationStateV1(value: unknown): RetryRemediationStateV1 {
  assertRetryRemediationState(value);
  return structuredClone(value) as unknown as RetryRemediationStateV1;
}

export function parseTaskActionRequiredV1(value: unknown): TaskActionRequiredV1 {
  assertActionRequired(value);
  return structuredClone(value) as unknown as TaskActionRequiredV1;
}

export function parseTaskProgressChallengeV1(value: unknown): TaskProgressChallengeV1 {
  assertProgressChallenge(value);
  return structuredClone(value) as unknown as TaskProgressChallengeV1;
}

export function parseTaskRemediationCommandEnvelopeV1(value: unknown): TaskRemediationCommandEnvelopeV1 {
  assertExactKeys(
    value,
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'causationRef', 'sourceRefs'],
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey'],
  );
  if (value.schemaVersion !== TASK_REMEDIATION_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  assertCommandName(value.commandName);
  if (value.commandSchemaVersion !== TASK_REMEDIATION_COMMAND_SCHEMA_VERSION) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  assertId(value.idempotencyKey);
  if (value.causationRef !== undefined) assertCommandProvenanceRef(value.causationRef);
  if (value.sourceRefs !== undefined) {
    if (!Array.isArray(value.sourceRefs)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
    value.sourceRefs.forEach(assertCommandProvenanceRef);
  }
  return structuredClone(value) as unknown as TaskRemediationCommandEnvelopeV1;
}

export function parseTaskRemediationInputV1<K extends TaskRemediationCommandName>(
  commandName: K,
  value: unknown,
): TaskRemediationCommandInputMapV1[K] {
  assertTaskRemediationInput(commandName, value);
  return structuredClone(value) as TaskRemediationCommandInputMapV1[K];
}

export function parseTaskRemediationCommandReceiptV1(value: unknown): TaskRemediationCommandReceiptV1 {
  assertCommandReceipt(value);
  return structuredClone(value) as unknown as TaskRemediationCommandReceiptV1;
}

export function parseTaskRemediationCommandResponseV1(value: unknown): TaskRemediationCommandResponseV1 {
  assertExactKeys(
    value,
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode', 'receipt', 'result',
      'conflictReason', 'rejectReason', 'freshnessReason'],
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode'],
  );
  if (value.schemaVersion !== 1) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  assertCommandName(value.commandName);
  if (!TASK_REMEDIATION_OUTCOMES.includes(value.outcome as TaskRemediationOutcome)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  if (!TASK_REMEDIATION_RETRY_DIRECTIVES.includes(value.retryDirective as TaskRemediationRetryDirective)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  if (value.receipt !== undefined) assertCommandReceipt(value.receipt);
  if (value.result !== undefined) {
    if (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
      || (value.result as Record<string, unknown>).commandName !== value.commandName) {
      throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
    }
  }
  if (value.conflictReason !== undefined && !nonEmpty(value.conflictReason)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  if (value.rejectReason !== undefined && !nonEmpty(value.rejectReason)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  if (value.freshnessReason !== undefined && !nonEmpty(value.freshnessReason)) {
    throw new Error(TASK_REMEDIATION_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as TaskRemediationCommandResponseV1;
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = canonicalizeValue(entry);
    }
    return sorted;
  }
  return value;
}

export function canonicalizeTaskRemediationCommand(
  commandName: TaskRemediationCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return JSON.stringify(canonicalizeValue({
    v: TASK_REMEDIATION_COMMAND_HASH_VERSION,
    commandName,
    commandSchemaVersion,
    input,
  }));
}
