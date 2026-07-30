import { createHash } from 'node:crypto';
import type { ID, UnixMs } from '../../../../packages/contracts/src/common.js';
import type {
  TaskActionRequiredV1,
  TaskFailureClassificationV1,
  TaskRemediationCommandEnvelopeV1,
  TaskRemediationCommandName,
  TaskRemediationCommandReceiptV1,
  TaskRemediationCommandResponseV1,
  TaskRemediationCommandOutputUnionV1,
  RetryRemediationStateV1,
} from '../../../../packages/contracts/src/task-failure-remediation.js';
import {
  TASK_REMEDIATION_ENVELOPE_SCHEMA_VERSION,
  canonicalizeTaskRemediationCommand,
  parseTaskRemediationCommandEnvelopeV1,
  parseTaskRemediationInputV1,
} from '../../../../packages/contracts/src/task-failure-remediation.js';
import {
  authorizeRemediationCommand,
  buildOrAggregateActionRequired,
  buildProgressChallenge,
  classifyTaskFailure,
  evaluateActionRequiredSignal,
  evaluateAttemptConsumption,
  evaluateConditionalReassignment,
  evaluateLateWrite,
  evaluateRootImpactFromSubtaskFailure,
  openRemediationState,
  resolveProgressChallenge,
} from '../../../../packages/domain/src/task-failure-remediation-policy.js';
import type { TaskFailureRemediationUnitOfWork } from './task-failure-remediation-unit-of-work.js';
import type {
  TaskActionRequiredRecord,
  TaskFailureRemediationRepositories,
  TaskRemediationCommandReceiptRecord,
  TaskRemediationStateRecord,
} from './task-failure-remediation-repositories.js';

/**
 * #928 Task failure / SLA / remediation command handler。
 *
 * envelope → canonical hash → 幂等 → domain policy → 原子提交。
 */

export interface TaskFailureRemediationHandlerDeps {
  readonly unitOfWork: TaskFailureRemediationUnitOfWork;
  readonly ids: { nextId(): string };
  readonly clock: { now(): UnixMs };
  /** 版本化 errorCode → class 映射（可热更，但历史 classification 冻结 taxonomyVersion）。 */
  readonly errorCodeMap?: Readonly<Partial<Record<string, import('../../../../packages/contracts/src/task-failure-remediation.js').TaskFailureClass>>>;
  /** 默认 progress grace。 */
  readonly defaultGraceMs?: number;
  /** 当前 task 运行时门控（由调用方注入）。 */
  readonly taskRuntime?: {
    getTaskMeta(taskId: ID): Promise<{
      taskRevision: number;
      rootTaskId: ID;
      rootStatus: 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled' | 'closed';
      maxStartedAttempts: number;
      startedAttemptsConsumed: number;
      currentAttempt: number;
      currentFencingToken: number;
      eligibilityOk: boolean;
      capacityOk: boolean;
      inputsStillValid: boolean;
      hasQualifiedCandidates: boolean;
      unknownExternalEffect: boolean;
    } | null>;
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function computeCommandHash(
  commandName: TaskRemediationCommandName,
  commandSchemaVersion: number,
  payload: unknown,
): string {
  return `sha256:${sha256Hex(canonicalizeTaskRemediationCommand(commandName, commandSchemaVersion, payload))}`;
}

function buildResponse(
  commandName: TaskRemediationCommandName,
  outcome: TaskRemediationCommandResponseV1['outcome'],
  stableCode: string,
  retryDirective: TaskRemediationCommandResponseV1['retryDirective'],
  extra: Partial<TaskRemediationCommandResponseV1> = {},
): TaskRemediationCommandResponseV1 {
  return {
    schemaVersion: TASK_REMEDIATION_ENVELOPE_SCHEMA_VERSION,
    commandName,
    outcome,
    retryDirective,
    stableCode,
    ...extra,
  };
}

function toReceiptV1(record: TaskRemediationCommandReceiptRecord): TaskRemediationCommandReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: record.receiptId,
    commandName: record.commandName,
    commandSchemaVersion: record.commandSchemaVersion,
    idempotencyKey: record.idempotencyKey,
    commandHash: record.commandHash,
    outcome: record.outcome,
    committedRevisions: record.committedRevisions,
    eventRefs: record.eventRefs,
    commitTime: record.commitTime,
    resultAvailable: record.resultAvailable,
  };
}

function parseEnvelope(
  raw: unknown,
  expected: TaskRemediationCommandName,
): TaskRemediationCommandEnvelopeV1 {
  const envelope = parseTaskRemediationCommandEnvelopeV1(raw);
  if (envelope.commandName !== expected) {
    throw new Error(`TASK_REMEDIATION_COMMAND_MISMATCH: expected ${expected}, got ${envelope.commandName}`);
  }
  return envelope;
}

function classificationToV1(record: {
  taxonomyVersion: number;
  failureClass: TaskFailureClassificationV1['failureClass'];
  autoRetryAllowed: boolean;
  excludeSameAgent: boolean;
  requiresHumanEscalation: boolean;
  fingerprint: string;
  classifiedAt: number;
  id?: string;
}): TaskFailureClassificationV1 {
  return {
    schemaVersion: 1,
    taxonomyVersion: record.taxonomyVersion,
    failureClass: record.failureClass,
    autoRetryAllowed: record.autoRetryAllowed,
    excludeSameAgent: record.excludeSameAgent,
    requiresHumanEscalation: record.requiresHumanEscalation,
    fingerprint: record.fingerprint,
    classifiedAt: record.classifiedAt,
    sourceReportId: record.id,
  };
}

function remediationToV1(record: TaskRemediationStateRecord): RetryRemediationStateV1 {
  return {
    schemaVersion: 1,
    remediationId: record.id,
    taskId: record.taskId,
    taskRevision: record.taskRevision,
    sourceAttempt: record.sourceAttempt,
    state: record.state,
    failureClass: record.failureClass,
    fingerprint: record.fingerprint,
    remainingBudget: record.remainingBudget,
    notBefore: record.notBefore ?? undefined,
    cooldownMs: record.cooldownMs ?? undefined,
    nextWakeAt: record.nextWakeAt ?? undefined,
    exclusionReasons: record.exclusionReasonsJson
      ? (JSON.parse(record.exclusionReasonsJson) as string[])
      : undefined,
    policyRevision: record.policyRevision,
    escalationKey: record.escalationKey ?? undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function actionRequiredToV1(record: TaskActionRequiredRecord): TaskActionRequiredV1 {
  return {
    schemaVersion: 1,
    actionRequiredId: record.id,
    escalationKey: record.escalationKey,
    taskId: record.taskId,
    taskRevision: record.taskRevision,
    sourceAttempt: record.sourceAttempt,
    failureClass: record.failureClass,
    remainingBudget: record.remainingBudget,
    allowedCommands: JSON.parse(record.allowedCommandsJson) as TaskRemediationCommandName[],
    confirmationToken: record.confirmationToken,
    status: record.status,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    resolvedAt: record.resolvedAt ?? undefined,
    resolvedByCommand: record.resolvedByCommand ?? undefined,
  };
}

async function commitReceipt(
  repos: TaskFailureRemediationRepositories,
  input: {
    commandName: TaskRemediationCommandName;
    idempotencyKey: string;
    commandHash: string;
    now: UnixMs;
    ids: { nextId(): string };
    result: TaskRemediationCommandOutputUnionV1;
    taskId: ID;
    taskRevision: number;
  },
): Promise<TaskRemediationCommandReceiptRecord> {
  const receipt: TaskRemediationCommandReceiptRecord = {
    receiptId: input.ids.nextId(),
    commandName: input.commandName,
    commandSchemaVersion: 1,
    idempotencyKey: input.idempotencyKey,
    commandHash: input.commandHash,
    outcome: 'applied',
    committedRevisions: [{ streamKind: 'task', streamId: input.taskId, revision: input.taskRevision }],
    eventRefs: [{ streamKind: 'task-remediation', streamId: input.taskId, sequence: input.now }],
    commitTime: input.now,
    resultAvailable: true,
    resultJson: JSON.stringify(input.result),
  };
  await repos.receipts.create(receipt);
  await repos.receipts.createTombstone({
    idempotencyKey: input.idempotencyKey,
    commandHash: input.commandHash,
    receiptId: receipt.receiptId,
    createdAt: input.now,
  });
  return receipt;
}

async function replayOrConflict(
  repos: TaskFailureRemediationRepositories,
  commandName: TaskRemediationCommandName,
  idempotencyKey: string,
  commandHash: string,
): Promise<TaskRemediationCommandResponseV1 | null> {
  const existing = await repos.receipts.getByIdempotencyKey(idempotencyKey);
  if (!existing) return null;
  if (existing.commandHash !== commandHash) {
    return buildResponse(commandName, 'conflict', 'IDEMPOTENCY_CONFLICT', 'reread_then_new_command', {
      conflictReason: 'command_hash_mismatch',
    });
  }
  return buildResponse(commandName, 'replayed', 'REPLAYED', 'none', {
    receipt: toReceiptV1(existing),
    result: existing.resultJson
      ? (JSON.parse(existing.resultJson) as TaskRemediationCommandOutputUnionV1)
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Public command handlers
// ---------------------------------------------------------------------------

export async function handleClassifyFailure(
  deps: TaskFailureRemediationHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<TaskRemediationCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'classify-failure');
  const input = parseTaskRemediationInputV1('classify-failure', rawInput);
  const commandHash = computeCommandHash('classify-failure', envelope.commandSchemaVersion, input);
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(repos, 'classify-failure', envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const start = await repos.executionStarts.get({
      taskId: input.taskId,
      taskAttempt: input.taskAttempt,
    });
    const meta = await deps.taskRuntime?.getTaskMeta(input.taskId);
    const budgetRow = await repos.budgets.get(input.taskId);
    const maxAttempts = budgetRow?.maxStartedAttempts
      ?? meta?.maxStartedAttempts
      ?? 3;
    const consumed = budgetRow?.startedAttemptsConsumed
      ?? meta?.startedAttemptsConsumed
      ?? 0;

    const consumption = evaluateAttemptConsumption({
      hasExecutionStart: start !== null,
      event: 'failure',
      maxStartedAttempts: maxAttempts,
      startedAttemptsConsumed: consumed,
    });
    if (consumption.kind === 'rejected') {
      return buildResponse('classify-failure', 'rejected', 'INVALID_BUDGET', 'user_action', {
        rejectReason: consumption.reason,
      });
    }

    // 权威预算回写：开工后 failure 才消耗；allocation-round-only 保持原值。
    const nextBudget = consumption.kind === 'consume'
      ? consumption.budget
      : { maxStartedAttempts: maxAttempts, startedAttemptsConsumed: consumed, remaining: budgetRemaining(maxAttempts, consumed) };
    await repos.budgets.upsert({
      taskId: input.taskId,
      maxStartedAttempts: nextBudget.maxStartedAttempts,
      startedAttemptsConsumed: nextBudget.startedAttemptsConsumed,
      updatedAt: now,
    });

    const classification = classifyTaskFailure({
      report: input.report,
      now,
      serverDetectedSignals: input.serverDetectedSignals,
      errorCodeMap: deps.errorCodeMap,
    });

    const classificationId = deps.ids.nextId();
    await repos.classifications.create({
      id: classificationId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      taskAttempt: input.taskAttempt,
      claimLeaseId: input.claimLeaseId,
      taxonomyVersion: classification.taxonomyVersion,
      failureClass: classification.failureClass,
      autoRetryAllowed: classification.autoRetryAllowed,
      excludeSameAgent: classification.excludeSameAgent,
      requiresHumanEscalation: classification.requiresHumanEscalation,
      fingerprint: classification.fingerprint,
      reportJson: JSON.stringify(input.report),
      classifiedAt: now,
    });

    const remaining = nextBudget.remaining;

    const fence = await repos.fences.get({ taskId: input.taskId, taskAttempt: input.taskAttempt });
    const reassignment = evaluateConditionalReassignment({
      classification,
      remainingBudget: remaining,
      oldAttemptFenced: fence !== null,
      eligibilityOk: meta?.eligibilityOk ?? true,
      capacityOk: meta?.capacityOk ?? true,
      inputsStillValid: meta?.inputsStillValid ?? true,
      unknownExternalEffect: input.serverDetectedSignals?.unknownExternalEffect
        ?? meta?.unknownExternalEffect
        ?? false,
      hasQualifiedCandidates: meta?.hasQualifiedCandidates ?? true,
      hasAlternateCandidates: meta?.hasQualifiedCandidates ?? true,
      now,
    });

    const existingRemediation = await repos.remediations.getOpenByTaskId(input.taskId);
    const remediationOpen = openRemediationState({
      remediationId: existingRemediation?.id ?? deps.ids.nextId(),
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      sourceAttempt: input.taskAttempt,
      classification,
      remainingBudget: remaining,
      now,
      policyRevision: 1,
      decision: reassignment.kind === 'offer_allowed'
        ? reassignment
        : reassignment.kind === 'blocked' || reassignment.kind === 'escalate'
          ? reassignment
          : { kind: 'pending_classification' },
    });

    const remediationRecord = {
      id: remediationOpen.remediationId,
      taskId: remediationOpen.taskId,
      taskRevision: remediationOpen.taskRevision,
      sourceAttempt: remediationOpen.sourceAttempt,
      state: remediationOpen.state,
      failureClass: remediationOpen.failureClass,
      fingerprint: remediationOpen.fingerprint,
      remainingBudget: remediationOpen.remainingBudget,
      notBefore: remediationOpen.notBefore ?? null,
      cooldownMs: remediationOpen.cooldownMs ?? null,
      nextWakeAt: remediationOpen.nextWakeAt ?? null,
      exclusionReasonsJson: remediationOpen.exclusionReasons
        ? JSON.stringify(remediationOpen.exclusionReasons)
        : null,
      policyRevision: remediationOpen.policyRevision,
      escalationKey: remediationOpen.escalationKey ?? null,
      classificationId,
      createdAt: existingRemediation?.createdAt ?? now,
      updatedAt: now,
    };
    // CONTEXT：同一失败一条 remediation lineage（upsert，禁止多条开放记录）
    if (existingRemediation) await repos.remediations.update(remediationRecord);
    else await repos.remediations.create(remediationRecord);

    // 子任务失败不得改写 root 终态/状态（#928 AC）
    if (meta) {
      const rootImpact = evaluateRootImpactFromSubtaskFailure({
        subtaskFailed: true,
        rootStatus: meta.rootStatus,
      });
      if (rootImpact.kind !== 'root_unchanged') {
        return buildResponse('classify-failure', 'rejected', 'ROOT_IMPACT_FORBIDDEN', 'user_action', {
          rejectReason: rootImpact.kind === 'rejected' ? rootImpact.reason : 'root_must_stay_unchanged',
        });
      }
    }

    let actionRequiredV1: TaskActionRequiredV1 | undefined;
    if (classification.requiresHumanEscalation || reassignment.kind === 'escalate') {
      const existing = await repos.actionRequired.getOpenByEscalationKey(
        `${input.taskId}:${classification.fingerprint}`,
      );
      const ar = buildOrAggregateActionRequired({
        actionRequiredId: existing?.id ?? deps.ids.nextId(),
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        sourceAttempt: input.taskAttempt,
        classification,
        remainingBudget: remaining,
        confirmationToken: existing?.confirmationToken ?? deps.ids.nextId(),
        now,
        existing: existing ? actionRequiredToV1(existing) : undefined,
      });
      const record: TaskActionRequiredRecord = {
        id: ar.actionRequiredId,
        escalationKey: ar.escalationKey,
        taskId: ar.taskId,
        taskRevision: ar.taskRevision,
        sourceAttempt: ar.sourceAttempt,
        failureClass: ar.failureClass,
        remainingBudget: ar.remainingBudget,
        allowedCommandsJson: JSON.stringify(ar.allowedCommands),
        confirmationToken: ar.confirmationToken,
        status: ar.status,
        revision: ar.revision,
        createdAt: ar.createdAt,
        updatedAt: ar.updatedAt,
        resolvedAt: null,
        resolvedByCommand: null,
      };
      if (existing) await repos.actionRequired.update(record);
      else await repos.actionRequired.create(record);
      actionRequiredV1 = ar;
    }

    const result: TaskRemediationCommandOutputUnionV1 = {
      commandName: 'classify-failure',
      classificationId,
      classification: classificationToV1({ ...classification, id: classificationId }),
      remediation: remediationToV1({
        id: remediationOpen.remediationId,
        taskId: remediationOpen.taskId,
        taskRevision: remediationOpen.taskRevision,
        sourceAttempt: remediationOpen.sourceAttempt,
        state: remediationOpen.state,
        failureClass: remediationOpen.failureClass,
        fingerprint: remediationOpen.fingerprint,
        remainingBudget: remediationOpen.remainingBudget,
        notBefore: remediationOpen.notBefore ?? null,
        cooldownMs: remediationOpen.cooldownMs ?? null,
        nextWakeAt: remediationOpen.nextWakeAt ?? null,
        exclusionReasonsJson: remediationOpen.exclusionReasons
          ? JSON.stringify(remediationOpen.exclusionReasons)
          : null,
        policyRevision: remediationOpen.policyRevision,
        escalationKey: remediationOpen.escalationKey ?? null,
        classificationId,
        createdAt: now,
        updatedAt: now,
      }),
      actionRequired: actionRequiredV1,
    };

    const receipt = await commitReceipt(repos, {
      commandName: 'classify-failure',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
    });

    return buildResponse('classify-failure', 'applied', 'CLASSIFIED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

function budgetRemaining(max: number, consumed: number): number {
  return Math.max(0, max - consumed);
}

export async function handleIssueProgressChallenge(
  deps: TaskFailureRemediationHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<TaskRemediationCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'issue-progress-challenge');
  const input = parseTaskRemediationInputV1('issue-progress-challenge', rawInput);
  const commandHash = computeCommandHash('issue-progress-challenge', envelope.commandSchemaVersion, input);
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(repos, 'issue-progress-challenge', envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const existingOpen = await repos.challenges.getOpenByTaskId(input.taskId);
    if (existingOpen) {
      return buildResponse('issue-progress-challenge', 'no_op', 'CHALLENGE_ALREADY_OPEN', 'none', {
        result: {
          commandName: 'issue-progress-challenge',
          challenge: {
            schemaVersion: 1,
            challengeId: existingOpen.id,
            taskId: existingOpen.taskId,
            taskRevision: existingOpen.taskRevision,
            taskAttempt: existingOpen.taskAttempt,
            claimLeaseId: existingOpen.claimLeaseId,
            graceDeadlineAt: existingOpen.graceDeadlineAt,
            issuedAt: existingOpen.issuedAt,
          },
          slaFact: 'progress_at_risk',
          taskStatusUnchanged: true,
        },
      });
    }

    const challenge = buildProgressChallenge({
      challengeId: deps.ids.nextId(),
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      taskAttempt: input.taskAttempt,
      claimLeaseId: input.claimLeaseId,
      now,
      graceMs: Math.max(0, input.graceDeadlineAt - now) || (deps.defaultGraceMs ?? 60_000),
    });

    await repos.challenges.create({
      id: challenge.challengeId,
      taskId: challenge.taskId,
      taskRevision: challenge.taskRevision,
      taskAttempt: challenge.taskAttempt,
      claimLeaseId: challenge.claimLeaseId,
      graceDeadlineAt: challenge.graceDeadlineAt,
      issuedAt: challenge.issuedAt,
      resolvedAt: null,
      resolution: null,
    });

    const result: TaskRemediationCommandOutputUnionV1 = {
      commandName: 'issue-progress-challenge',
      challenge,
      slaFact: 'progress_at_risk',
      taskStatusUnchanged: true,
    };
    const receipt = await commitReceipt(repos, {
      commandName: 'issue-progress-challenge',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
    });
    return buildResponse('issue-progress-challenge', 'applied', 'PROGRESS_AT_RISK', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleFenceStaleAttempt(
  deps: TaskFailureRemediationHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<TaskRemediationCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'fence-stale-attempt');
  const input = parseTaskRemediationInputV1('fence-stale-attempt', rawInput);
  const commandHash = computeCommandHash('fence-stale-attempt', envelope.commandSchemaVersion, input);
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(repos, 'fence-stale-attempt', envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const existing = await repos.fences.get({ taskId: input.taskId, taskAttempt: input.taskAttempt });
    if (existing) {
      const result: TaskRemediationCommandOutputUnionV1 = {
        commandName: 'fence-stale-attempt',
        taskId: input.taskId,
        fencedAttempt: existing.taskAttempt,
        fencingToken: existing.fencingToken,
        lateWritesRejected: true,
      };
      return buildResponse('fence-stale-attempt', 'no_op', 'ALREADY_FENCED', 'none', { result });
    }

    await repos.fences.create({
      taskId: input.taskId,
      taskAttempt: input.taskAttempt,
      fencingToken: input.fencingToken,
      fencedAt: now,
      reason: input.reason,
    });

    const result: TaskRemediationCommandOutputUnionV1 = {
      commandName: 'fence-stale-attempt',
      taskId: input.taskId,
      fencedAttempt: input.taskAttempt,
      fencingToken: input.fencingToken,
      lateWritesRejected: true,
    };
    const receipt = await commitReceipt(repos, {
      commandName: 'fence-stale-attempt',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
    });
    return buildResponse('fence-stale-attempt', 'applied', 'ATTEMPT_FENCED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleAcknowledgeActionRequired(
  deps: TaskFailureRemediationHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<TaskRemediationCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'acknowledge-action-required');
  const input = parseTaskRemediationInputV1('acknowledge-action-required', rawInput);
  const commandHash = computeCommandHash('acknowledge-action-required', envelope.commandSchemaVersion, input);
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(
      repos, 'acknowledge-action-required', envelope.idempotencyKey, commandHash,
    );
    if (replay) return replay;

    const ar = await repos.actionRequired.getById(input.actionRequiredId);
    if (!ar) {
      return buildResponse('acknowledge-action-required', 'rejected', 'NOT_FOUND', 'user_action', {
        rejectReason: 'action_required_not_found',
      });
    }

    const signalResult = evaluateActionRequiredSignal(actionRequiredToV1(ar), input.signal);
    // 故意不更新 status —— read/seen/dismiss 不解决
    const result: TaskRemediationCommandOutputUnionV1 = {
      commandName: 'acknowledge-action-required',
      actionRequiredId: input.actionRequiredId,
      stillOpen: true,
      signalIgnored: signalResult.signalIgnored,
    };
    const receipt = await commitReceipt(repos, {
      commandName: 'acknowledge-action-required',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      taskId: ar.taskId,
      taskRevision: ar.taskRevision,
    });
    return buildResponse('acknowledge-action-required', 'applied', 'STILL_OPEN', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleRetryAttempt(
  deps: TaskFailureRemediationHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<TaskRemediationCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'retry-attempt');
  const input = parseTaskRemediationInputV1('retry-attempt', rawInput);
  const commandHash = computeCommandHash('retry-attempt', envelope.commandSchemaVersion, input);
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(repos, 'retry-attempt', envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const ar = await repos.actionRequired.getById(input.actionRequiredId);
    if (!ar) {
      return buildResponse('retry-attempt', 'rejected', 'NOT_FOUND', 'user_action', {
        rejectReason: 'action_required_not_found',
      });
    }

    const auth = authorizeRemediationCommand({
      commandName: 'retry-attempt',
      actionRequired: actionRequiredToV1(ar),
      confirmationToken: input.confirmationToken,
      expectedEscalationRevision: input.expectedEscalationRevision,
      actorHasRootTerminationAuthority: false,
    });
    if (auth.kind === 'rejected') {
      return buildResponse('retry-attempt', 'rejected', auth.reason.toUpperCase(), 'user_action', {
        rejectReason: auth.reason,
      });
    }

    const rem = await repos.remediations.getOpenByTaskId(input.taskId);
    const updated: TaskRemediationStateRecord = rem
      ? {
          ...rem,
          state: 'retry_pending',
          updatedAt: now,
          notBefore: now,
          nextWakeAt: now,
        }
      : {
          id: deps.ids.nextId(),
          taskId: input.taskId,
          taskRevision: input.expectedTaskRevision,
          sourceAttempt: ar.sourceAttempt,
          state: 'retry_pending',
          failureClass: ar.failureClass,
          fingerprint: ar.escalationKey.split(':').slice(1).join(':') || ar.escalationKey,
          remainingBudget: ar.remainingBudget,
          notBefore: now,
          cooldownMs: null,
          nextWakeAt: now,
          exclusionReasonsJson: null,
          policyRevision: 1,
          escalationKey: ar.escalationKey,
          classificationId: null,
          createdAt: now,
          updatedAt: now,
        };

    if (rem) await repos.remediations.update(updated);
    else await repos.remediations.create(updated);

    await repos.actionRequired.update({
      ...ar,
      status: 'resolved',
      resolvedAt: now,
      resolvedByCommand: 'retry-attempt',
      updatedAt: now,
    });

    const result: TaskRemediationCommandOutputUnionV1 = {
      commandName: 'retry-attempt',
      taskId: input.taskId,
      taskRevision: input.expectedTaskRevision,
      remediation: remediationToV1(updated),
    };
    const receipt = await commitReceipt(repos, {
      commandName: 'retry-attempt',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      taskId: input.taskId,
      taskRevision: input.expectedTaskRevision,
    });
    return buildResponse('retry-attempt', 'applied', 'RETRY_AUTHORIZED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleRequestConditionalReassignment(
  deps: TaskFailureRemediationHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<TaskRemediationCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'request-conditional-reassignment');
  const input = parseTaskRemediationInputV1('request-conditional-reassignment', rawInput);
  const commandHash = computeCommandHash(
    'request-conditional-reassignment', envelope.commandSchemaVersion, input,
  );
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(
      repos, 'request-conditional-reassignment', envelope.idempotencyKey, commandHash,
    );
    if (replay) return replay;

    const classificationRow = await repos.classifications.getById(input.classificationId);
    if (!classificationRow) {
      return buildResponse('request-conditional-reassignment', 'rejected', 'NOT_FOUND', 'user_action', {
        rejectReason: 'classification_not_found',
      });
    }

    const fence = await repos.fences.get({
      taskId: input.taskId,
      taskAttempt: input.sourceAttempt,
    });
    const meta = await deps.taskRuntime?.getTaskMeta(input.taskId);
    if (meta && meta.taskRevision !== input.expectedTaskRevision) {
      return buildResponse('request-conditional-reassignment', 'freshness_hold', 'STALE_REVISION', 'reread_then_new_command', {
        freshnessReason: 'task_revision_mismatch',
      });
    }

    const classification = classificationToV1(classificationRow);
    const budgetRow = await repos.budgets.get(input.taskId);
    const remaining = budgetRow
      ? budgetRemaining(budgetRow.maxStartedAttempts, budgetRow.startedAttemptsConsumed)
      : meta
        ? budgetRemaining(meta.maxStartedAttempts, meta.startedAttemptsConsumed)
        : 0;

    const decision = evaluateConditionalReassignment({
      classification,
      remainingBudget: remaining,
      oldAttemptFenced: fence !== null,
      eligibilityOk: meta?.eligibilityOk ?? false,
      capacityOk: meta?.capacityOk ?? false,
      inputsStillValid: meta?.inputsStillValid ?? false,
      unknownExternalEffect: meta?.unknownExternalEffect ?? false,
      hasQualifiedCandidates: meta?.hasQualifiedCandidates ?? false,
      hasAlternateCandidates: meta?.hasQualifiedCandidates ?? false,
      now,
      notBefore: input.notBefore,
    });

    const existingRemediation = await repos.remediations.getOpenByTaskId(input.taskId);
    const remediationOpen = openRemediationState({
      remediationId: existingRemediation?.id ?? deps.ids.nextId(),
      taskId: input.taskId,
      taskRevision: input.expectedTaskRevision,
      sourceAttempt: input.sourceAttempt,
      classification,
      remainingBudget: remaining,
      now,
      policyRevision: 1,
      notBefore: input.notBefore,
      decision: decision.kind === 'offer_allowed' || decision.kind === 'blocked' || decision.kind === 'escalate'
        ? decision
        : { kind: 'pending_classification' },
    });

    const remediationRecord = {
      id: remediationOpen.remediationId,
      taskId: remediationOpen.taskId,
      taskRevision: remediationOpen.taskRevision,
      sourceAttempt: remediationOpen.sourceAttempt,
      state: remediationOpen.state,
      failureClass: remediationOpen.failureClass,
      fingerprint: remediationOpen.fingerprint,
      remainingBudget: remediationOpen.remainingBudget,
      notBefore: remediationOpen.notBefore ?? null,
      cooldownMs: remediationOpen.cooldownMs ?? null,
      nextWakeAt: remediationOpen.nextWakeAt ?? null,
      exclusionReasonsJson: remediationOpen.exclusionReasons
        ? JSON.stringify(remediationOpen.exclusionReasons)
        : null,
      policyRevision: remediationOpen.policyRevision,
      escalationKey: remediationOpen.escalationKey ?? null,
      classificationId: input.classificationId,
      createdAt: existingRemediation?.createdAt ?? now,
      updatedAt: now,
    };
    if (existingRemediation) await repos.remediations.update(remediationRecord);
    else await repos.remediations.create(remediationRecord);

    let actionRequiredV1: TaskActionRequiredV1 | undefined;
    let offerId: string | undefined;
    let decisionOut: 'offer_allowed' | 'escalated' | 'blocked' = 'blocked';

    if (decision.kind === 'offer_allowed') {
      decisionOut = 'offer_allowed';
      offerId = deps.ids.nextId(); // 仅占位；真实 Offer 发布走既有 allocation 链路
    } else if (decision.kind === 'escalate') {
      decisionOut = 'escalated';
      const existing = await repos.actionRequired.getOpenByEscalationKey(
        `${input.taskId}:${classification.fingerprint}`,
      );
      const ar = buildOrAggregateActionRequired({
        actionRequiredId: existing?.id ?? deps.ids.nextId(),
        taskId: input.taskId,
        taskRevision: input.expectedTaskRevision,
        sourceAttempt: input.sourceAttempt,
        classification,
        remainingBudget: remaining,
        confirmationToken: existing?.confirmationToken ?? deps.ids.nextId(),
        now,
        existing: existing ? actionRequiredToV1(existing) : undefined,
      });
      const record: TaskActionRequiredRecord = {
        id: ar.actionRequiredId,
        escalationKey: ar.escalationKey,
        taskId: ar.taskId,
        taskRevision: ar.taskRevision,
        sourceAttempt: ar.sourceAttempt,
        failureClass: ar.failureClass,
        remainingBudget: ar.remainingBudget,
        allowedCommandsJson: JSON.stringify(ar.allowedCommands),
        confirmationToken: ar.confirmationToken,
        status: ar.status,
        revision: ar.revision,
        createdAt: ar.createdAt,
        updatedAt: ar.updatedAt,
        resolvedAt: null,
        resolvedByCommand: null,
      };
      if (existing) await repos.actionRequired.update(record);
      else await repos.actionRequired.create(record);
      actionRequiredV1 = ar;
    } else {
      decisionOut = 'blocked';
    }

    const result: TaskRemediationCommandOutputUnionV1 = {
      commandName: 'request-conditional-reassignment',
      decision: decisionOut,
      offerId,
      remediation: remediationToV1({
        id: remediationOpen.remediationId,
        taskId: remediationOpen.taskId,
        taskRevision: remediationOpen.taskRevision,
        sourceAttempt: remediationOpen.sourceAttempt,
        state: remediationOpen.state,
        failureClass: remediationOpen.failureClass,
        fingerprint: remediationOpen.fingerprint,
        remainingBudget: remediationOpen.remainingBudget,
        notBefore: remediationOpen.notBefore ?? null,
        cooldownMs: remediationOpen.cooldownMs ?? null,
        nextWakeAt: remediationOpen.nextWakeAt ?? null,
        exclusionReasonsJson: remediationOpen.exclusionReasons
          ? JSON.stringify(remediationOpen.exclusionReasons)
          : null,
        policyRevision: remediationOpen.policyRevision,
        escalationKey: remediationOpen.escalationKey ?? null,
        classificationId: input.classificationId,
        createdAt: now,
        updatedAt: now,
      }),
      actionRequired: actionRequiredV1,
    };

    const receipt = await commitReceipt(repos, {
      commandName: 'request-conditional-reassignment',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      taskId: input.taskId,
      taskRevision: input.expectedTaskRevision,
    });
    return buildResponse('request-conditional-reassignment', 'applied', 'REASSIGNMENT_EVALUATED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

// ---------------------------------------------------------------------------
// Scheduler / reconciliation helpers
// ---------------------------------------------------------------------------

/**
 * 扫描 grace 到期 challenge，原子 fencing。用于 server reconciliation loop。
 */
export async function reconcileExpiredProgressChallenges(
  deps: TaskFailureRemediationHandlerDeps,
  limit = 50,
): Promise<{ readonly fenced: number }> {
  const now = deps.clock.now();
  return deps.unitOfWork.runInTransaction(async (repos) => {
    const expired = await repos.challenges.listGraceExpired({ now, limit });
    let fenced = 0;
    for (const challenge of expired) {
      const decision = resolveProgressChallenge({
        challenge: {
          schemaVersion: 1,
          challengeId: challenge.id,
          taskId: challenge.taskId,
          taskRevision: challenge.taskRevision,
          taskAttempt: challenge.taskAttempt,
          claimLeaseId: challenge.claimLeaseId,
          graceDeadlineAt: challenge.graceDeadlineAt,
          issuedAt: challenge.issuedAt,
        },
        now,
        hasStructuredProgress: false,
        skipForSafety: false,
      });
      if (decision.kind !== 'fence') continue;

      await repos.challenges.update({
        ...challenge,
        resolvedAt: now,
        resolution: 'grace_expired',
      });

      const existingFence = await repos.fences.get({
        taskId: challenge.taskId,
        taskAttempt: challenge.taskAttempt,
      });
      if (!existingFence) {
        const meta = await deps.taskRuntime?.getTaskMeta(challenge.taskId);
        await repos.fences.create({
          taskId: challenge.taskId,
          taskAttempt: challenge.taskAttempt,
          fencingToken: (meta?.currentFencingToken ?? 1) + 1,
          fencedAt: now,
          reason: 'grace_expired',
        });
      }
      fenced += 1;
    }
    return { fenced };
  });
}

/**
 * 迟到写入门控：daemon 提交结果前调用。
 */
export async function guardLateResultWrite(
  deps: TaskFailureRemediationHandlerDeps,
  input: {
    readonly taskId: ID;
    readonly writeAttempt: number;
    readonly writeFencingToken: number;
  },
): Promise<{ readonly accepted: boolean; readonly reason?: string }> {
  return deps.unitOfWork.runInTransaction(async (repos) => {
    const meta = await deps.taskRuntime?.getTaskMeta(input.taskId);
    if (!meta) return { accepted: false, reason: 'task_not_found' };
    const fence = await repos.fences.get({
      taskId: input.taskId,
      taskAttempt: input.writeAttempt,
    });
    const decision = evaluateLateWrite({
      writeAttempt: input.writeAttempt,
      writeFencingToken: input.writeFencingToken,
      currentAttempt: meta.currentAttempt,
      currentFencingToken: meta.currentFencingToken,
      currentAttemptFenced: fence !== null,
    });
    if (decision.kind === 'accept') return { accepted: true };
    return { accepted: false, reason: decision.reason };
  });
}
