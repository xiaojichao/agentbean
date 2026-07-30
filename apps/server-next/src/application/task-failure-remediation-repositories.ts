import type { ID, UnixMs } from '../../../../packages/contracts/src/common.js';
import type {
  RemediationState,
  TaskFailureClass,
  TaskRemediationCommandName,
} from '../../../../packages/contracts/src/task-failure-remediation.js';

/**
 * #928 failure classification / SLA / remediation 仓储接口。
 */

export interface TaskFailureClassificationRecord {
  readonly id: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
  readonly taxonomyVersion: number;
  readonly failureClass: TaskFailureClass;
  readonly autoRetryAllowed: boolean;
  readonly excludeSameAgent: boolean;
  readonly requiresHumanEscalation: boolean;
  readonly fingerprint: string;
  readonly reportJson: string;
  readonly classifiedAt: UnixMs;
}

export interface TaskRemediationStateRecord {
  readonly id: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly sourceAttempt: number;
  readonly state: RemediationState;
  readonly failureClass: TaskFailureClass;
  readonly fingerprint: string;
  readonly remainingBudget: number;
  readonly notBefore: UnixMs | null;
  readonly cooldownMs: number | null;
  readonly nextWakeAt: UnixMs | null;
  readonly exclusionReasonsJson: string | null;
  readonly policyRevision: number;
  readonly escalationKey: string | null;
  readonly classificationId: ID | null;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface TaskProgressChallengeRecord {
  readonly id: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
  readonly graceDeadlineAt: UnixMs;
  readonly issuedAt: UnixMs;
  readonly resolvedAt: UnixMs | null;
  readonly resolution: 'progress_received' | 'grace_expired' | 'skipped_for_safety' | null;
}

export interface TaskActionRequiredRecord {
  readonly id: ID;
  readonly escalationKey: string;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly sourceAttempt: number;
  readonly failureClass: TaskFailureClass;
  readonly remainingBudget: number;
  readonly allowedCommandsJson: string;
  readonly confirmationToken: string;
  readonly status: 'open' | 'resolved';
  readonly revision: number;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
  readonly resolvedAt: UnixMs | null;
  readonly resolvedByCommand: TaskRemediationCommandName | null;
}

export interface TaskAttemptFenceRecord {
  readonly taskId: ID;
  readonly taskAttempt: number;
  readonly fencingToken: number;
  readonly fencedAt: UnixMs;
  readonly reason: string;
}

export interface TaskExecutionStartRecord {
  readonly taskId: ID;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
  readonly startedAt: UnixMs;
}

/** 子任务 execution retry budget 权威快照（与 Task meta 同步，本切片 memory 持久化）。 */
export interface TaskRetryBudgetRecord {
  readonly taskId: ID;
  readonly maxStartedAttempts: number;
  readonly startedAttemptsConsumed: number;
  readonly updatedAt: UnixMs;
}

export interface TaskRemediationCommandReceiptRecord {
  readonly receiptId: ID;
  readonly commandName: TaskRemediationCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: 'applied' | 'no_op';
  readonly committedRevisions: readonly { streamKind: string; streamId: ID; revision: number }[];
  readonly eventRefs: readonly { streamKind: string; streamId: ID; sequence: number }[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
  readonly resultJson: string | null;
}

export interface TaskRemediationIdempotencyTombstoneRecord {
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly receiptId: ID;
  readonly createdAt: UnixMs;
}

export interface TaskFailureClassificationRepository {
  create(record: TaskFailureClassificationRecord): Promise<TaskFailureClassificationRecord>;
  getById(id: ID): Promise<TaskFailureClassificationRecord | null>;
  getByTaskAttempt(input: { taskId: ID; taskAttempt: number }): Promise<TaskFailureClassificationRecord | null>;
}

export interface TaskRemediationStateRepository {
  create(record: TaskRemediationStateRecord): Promise<TaskRemediationStateRecord>;
  update(record: TaskRemediationStateRecord): Promise<void>;
  getById(id: ID): Promise<TaskRemediationStateRecord | null>;
  getOpenByTaskId(taskId: ID): Promise<TaskRemediationStateRecord | null>;
  listDue(input: { now: UnixMs; limit: number }): Promise<readonly TaskRemediationStateRecord[]>;
}

export interface TaskProgressChallengeRepository {
  create(record: TaskProgressChallengeRecord): Promise<TaskProgressChallengeRecord>;
  update(record: TaskProgressChallengeRecord): Promise<void>;
  getById(id: ID): Promise<TaskProgressChallengeRecord | null>;
  getOpenByTaskId(taskId: ID): Promise<TaskProgressChallengeRecord | null>;
  listGraceExpired(input: { now: UnixMs; limit: number }): Promise<readonly TaskProgressChallengeRecord[]>;
}

export interface TaskActionRequiredRepository {
  create(record: TaskActionRequiredRecord): Promise<TaskActionRequiredRecord>;
  update(record: TaskActionRequiredRecord): Promise<void>;
  getById(id: ID): Promise<TaskActionRequiredRecord | null>;
  getOpenByEscalationKey(escalationKey: string): Promise<TaskActionRequiredRecord | null>;
}

export interface TaskAttemptFenceRepository {
  create(record: TaskAttemptFenceRecord): Promise<TaskAttemptFenceRecord>;
  get(input: { taskId: ID; taskAttempt: number }): Promise<TaskAttemptFenceRecord | null>;
  getLatest(taskId: ID): Promise<TaskAttemptFenceRecord | null>;
}

export interface TaskExecutionStartRepository {
  create(record: TaskExecutionStartRecord): Promise<TaskExecutionStartRecord>;
  get(input: { taskId: ID; taskAttempt: number }): Promise<TaskExecutionStartRecord | null>;
}

export interface TaskRetryBudgetRepository {
  get(taskId: ID): Promise<TaskRetryBudgetRecord | null>;
  upsert(record: TaskRetryBudgetRecord): Promise<void>;
}

export interface TaskRemediationReceiptRepository {
  create(record: TaskRemediationCommandReceiptRecord): Promise<TaskRemediationCommandReceiptRecord>;
  getByIdempotencyKey(idempotencyKey: string): Promise<TaskRemediationCommandReceiptRecord | null>;
  createTombstone(record: TaskRemediationIdempotencyTombstoneRecord): Promise<void>;
  getTombstone(idempotencyKey: string): Promise<TaskRemediationIdempotencyTombstoneRecord | null>;
}

export interface TaskFailureRemediationRepositories {
  readonly classifications: TaskFailureClassificationRepository;
  readonly remediations: TaskRemediationStateRepository;
  readonly challenges: TaskProgressChallengeRepository;
  readonly actionRequired: TaskActionRequiredRepository;
  readonly fences: TaskAttemptFenceRepository;
  readonly executionStarts: TaskExecutionStartRepository;
  readonly budgets: TaskRetryBudgetRepository;
  readonly receipts: TaskRemediationReceiptRepository;
}
