import { createHash } from 'node:crypto';
import type { ID, UnixMs } from '../../../../packages/contracts/src/common.js';
import type {
  InvocationAuthorizationCommandEnvelopeV1,
  InvocationAuthorizationCommandName,
  InvocationAuthorizationCommandOutputUnionV1,
  InvocationAuthorizationCommandReceiptV1,
  InvocationAuthorizationCommandResponseV1,
} from '../../../../packages/contracts/src/invocation-authorization.js';
import {
  INVOCATION_AUTHORIZATION_ENVELOPE_SCHEMA_VERSION,
  canonicalizeInvocationAuthorizationCommand,
  parseInvocationAuthorizationCommandEnvelopeV1,
  parseInvocationAuthorizationInputV1,
} from '../../../../packages/contracts/src/invocation-authorization.js';
import {
  classifyEffectOutcome,
  evaluateActionApproval,
  evaluateInvocationAuthorization,
  resolveEffectIdempotency,
} from '../../../../packages/domain/src/invocation-authorization-policy.js';
import type { InvocationAuthorizationUnitOfWork } from './invocation-authorization-unit-of-work.js';
import type {
  InvocationAuthorizationCommandReceiptRecord,
  InvocationAuthorizationFactRecord,
} from './invocation-authorization-repositories.js';
import type { LeaseAuthorityInput } from './management/management-kernel.js';
import { authorizeManagementWrite } from './management/management-kernel.js';

/**
 * #927 Invocation authorization / Action approval / Effect outcome command handler。
 *
 * 与 message-tracer-handlers.ts / promotion-gate-handler.ts 同构的 transport-independent
 * command handler：envelope 解析 → canonical hash → 幂等查重 → domain policy → 原子提交。
 *
 * ADR-0067：Command response outcome 固定八态；receipt/tombstone 同事务写。
 */

export interface InvocationAuthorizationHandlerDeps {
  readonly unitOfWork: InvocationAuthorizationUnitOfWork;
  readonly ids: { nextId(): string };
  readonly clock: { now(): UnixMs };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function computeCommandHash(
  commandName: InvocationAuthorizationCommandName,
  commandSchemaVersion: number,
  payload: unknown,
): string {
  const canonical = canonicalizeInvocationAuthorizationCommand(commandName, commandSchemaVersion, payload);
  return `sha256:${sha256Hex(canonical)}`;
}

function toReceiptV1(record: InvocationAuthorizationCommandReceiptRecord): InvocationAuthorizationCommandReceiptV1 {
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

function parseAndCheckEnvelope(
  rawEnvelope: unknown,
  expected: InvocationAuthorizationCommandName,
): InvocationAuthorizationCommandEnvelopeV1 {
  const envelope = parseInvocationAuthorizationCommandEnvelopeV1(rawEnvelope) as InvocationAuthorizationCommandEnvelopeV1;
  if (envelope.commandName !== expected) {
    throw new Error(`INVOCATION_AUTHORIZATION_COMMAND_MISMATCH: expected ${expected}, got ${envelope.commandName}`);
  }
  return envelope;
}

function buildResponse(
  commandName: InvocationAuthorizationCommandName,
  outcome: InvocationAuthorizationCommandResponseV1['outcome'],
  stableCode: string,
  retryDirective: InvocationAuthorizationCommandResponseV1['retryDirective'],
  extra: Partial<InvocationAuthorizationCommandResponseV1> = {},
): InvocationAuthorizationCommandResponseV1 {
  return {
    schemaVersion: INVOCATION_AUTHORIZATION_ENVELOPE_SCHEMA_VERSION,
    commandName,
    outcome,
    retryDirective,
    stableCode,
    ...extra,
  };
}

function replayResponse(record: InvocationAuthorizationCommandReceiptRecord): InvocationAuthorizationCommandResponseV1 {
  return buildResponse(record.commandName, 'replayed', 'REPLAYED', 'none', { receipt: toReceiptV1(record) });
}

function conflictResponse(commandName: InvocationAuthorizationCommandName, reason: string): InvocationAuthorizationCommandResponseV1 {
  return buildResponse(commandName, 'conflict', 'IDEMPOTENCY_CONFLICT', 'reread_then_new_command', { conflictReason: reason });
}

function rejectedResponse(
  commandName: InvocationAuthorizationCommandName,
  code: string,
  retryDirective: InvocationAuthorizationCommandResponseV1['retryDirective'] = 'user_action',
): InvocationAuthorizationCommandResponseV1 {
  return buildResponse(commandName, 'rejected', code, retryDirective);
}

// ---------------------------------------------------------------------------
// authorize-invocation handler
// ---------------------------------------------------------------------------

export interface AuthorizeInvocationInput {
  readonly envelope: unknown;
  readonly payload: unknown;
  readonly authority: LeaseAuthorityInput;
  readonly teamId: ID;
}

export type AuthorizeInvocationHandler = (input: AuthorizeInvocationInput) => Promise<InvocationAuthorizationCommandResponseV1>;

export function createAuthorizeInvocationHandler(deps: InvocationAuthorizationHandlerDeps): AuthorizeInvocationHandler {
  return async ({ envelope: rawEnvelope, payload: rawPayload, authority, teamId }) => {
    const envelope = parseAndCheckEnvelope(rawEnvelope, 'authorize-invocation');
    const input = parseInvocationAuthorizationInputV1('authorize-invocation', rawPayload);
    const commandHash = computeCommandHash('authorize-invocation', envelope.commandSchemaVersion, rawPayload);
    const operationHash = sha256Hex(
      canonicalizeInvocationAuthorizationCommand('authorize-invocation', envelope.commandSchemaVersion, rawPayload),
    );

    return deps.unitOfWork.run(async (repos) => {
      const now = deps.clock.now();
      await authorizeManagementWrite(repos.management, authority, now);

      const existingReceipt = await repos.authorization.receipts.getReceiptByIdempotencyKey(envelope.idempotencyKey);
      if (existingReceipt) {
        return existingReceipt.commandHash === commandHash
          ? replayResponse(existingReceipt)
          : conflictResponse('authorize-invocation', 'idempotency_conflict');
      }

      const existingFact = await repos.authorization.authorizationFacts.getByIdempotencyKey({
        managementRunId: input.managementRunId,
        idempotencyKey: envelope.idempotencyKey,
      });
      const decision = evaluateInvocationAuthorization({
        managementRunId: input.managementRunId,
        invocationId: input.invocationId,
        requestedOperationHash: operationHash,
        existing: existingFact
          ? {
              authorizationId: existingFact.id,
              operationHash: existingFact.operationHash,
              frozenRevision: existingFact.frozenRevision,
              frozenAttempt: existingFact.frozenAttempt,
              frozenClaimLeaseId: existingFact.claimLeaseId,
              state: existingFact.state,
            }
          : undefined,
        currentTaskRevision: input.taskContext.taskRevision,
        currentTaskAttempt: input.taskContext.taskAttempt,
        currentClaimLeaseId: input.taskContext.claimLeaseId,
        claimActive: true,
        deadlineAt: input.operationScope.deadlineAt,
        now,
      });

      if (decision.kind === 'rejected') return rejectedResponse('authorize-invocation', 'AUTHORIZATION_REJECTED');
      if (decision.kind === 'conflict') {
        return buildResponse('authorize-invocation', 'conflict', 'AUTHORIZATION_CONFLICT', 'reread_then_new_command', { conflictReason: decision.reason });
      }

      if (decision.kind === 'replayed') {
        const receiptId = deps.ids.nextId();
        const result: InvocationAuthorizationCommandOutputUnionV1 = {
          commandName: 'authorize-invocation',
          authorizationId: decision.authorizationId,
          managementRunId: input.managementRunId,
          invocationId: input.invocationId,
          frozenRevision: input.taskContext.taskRevision,
          frozenAttempt: input.taskContext.taskAttempt,
          authorizedEffectIdentities: input.operationScope.plannedEffectIdentities,
          requiresActionApproval: input.operationScope.riskLevel === 'high',
        };
        const receiptRecord: InvocationAuthorizationCommandReceiptRecord = {
          receiptId, teamId, commandName: 'authorize-invocation',
          commandSchemaVersion: envelope.commandSchemaVersion, idempotencyKey: envelope.idempotencyKey,
          commandHash, outcome: 'no_op', committedRevisions: [], eventRefs: [],
          resultAvailable: true, resultJson: JSON.stringify(result), commitTime: now, createdAt: now,
        };
        await repos.authorization.receipts.createReceipt(receiptRecord);
        await repos.authorization.receipts.createTombstone({
          id: deps.ids.nextId(), teamId, commandName: 'authorize-invocation',
          idempotencyKey: envelope.idempotencyKey, commandHash, receiptId,
          outcome: 'no_op', resultAvailable: true, createdAt: now,
        });
        return buildResponse('authorize-invocation', 'replayed', 'AUTHORIZATION_REPLAYED', 'none', { receipt: toReceiptV1(receiptRecord), result });
      }

      // applied
      const authorizationId = deps.ids.nextId();
      const fact: InvocationAuthorizationFactRecord = {
        id: authorizationId, managementRunId: input.managementRunId, invocationId: input.invocationId,
        idempotencyKey: envelope.idempotencyKey, operationHash, inputHash: input.operationScope.inputHash,
        riskLevel: input.operationScope.riskLevel, deadlineAt: input.operationScope.deadlineAt ?? null,
        plannedEffectIdentitiesJson: JSON.stringify(input.operationScope.plannedEffectIdentities),
        taskId: input.taskContext.taskId, frozenRevision: decision.frozenRevision,
        frozenAttempt: decision.frozenAttempt, claimLeaseId: input.taskContext.claimLeaseId,
        state: 'active', createdAt: now, supersededAt: null,
      };
      await repos.authorization.authorizationFacts.create(fact);

      const result: InvocationAuthorizationCommandOutputUnionV1 = {
        commandName: 'authorize-invocation', authorizationId, managementRunId: input.managementRunId,
        invocationId: input.invocationId, frozenRevision: decision.frozenRevision,
        frozenAttempt: decision.frozenAttempt, authorizedEffectIdentities: input.operationScope.plannedEffectIdentities,
        requiresActionApproval: input.operationScope.riskLevel === 'high',
      };
      const receiptId = deps.ids.nextId();
      const receiptRecord: InvocationAuthorizationCommandReceiptRecord = {
        receiptId, teamId, commandName: 'authorize-invocation',
        commandSchemaVersion: envelope.commandSchemaVersion, idempotencyKey: envelope.idempotencyKey,
        commandHash, outcome: 'applied',
        committedRevisions: [{ streamKind: 'invocation-authorization', streamId: `${input.managementRunId}:${input.invocationId}`, revision: 1 }],
        eventRefs: [], resultAvailable: true, resultJson: JSON.stringify(result), commitTime: now, createdAt: now,
      };
      await repos.authorization.receipts.createReceipt(receiptRecord);
      await repos.authorization.receipts.createTombstone({
        id: deps.ids.nextId(), teamId, commandName: 'authorize-invocation',
        idempotencyKey: envelope.idempotencyKey, commandHash, receiptId,
        outcome: 'applied', resultAvailable: true, createdAt: now,
      });
      return buildResponse('authorize-invocation', 'applied', 'AUTHORIZATION_APPLIED', 'none', { receipt: toReceiptV1(receiptRecord), result });
    });
  };
}

// ---------------------------------------------------------------------------
// approve-action handler
// ---------------------------------------------------------------------------

export interface ApproveActionInput {
  readonly envelope: unknown;
  readonly payload: unknown;
  readonly approverId: ID;
  readonly authority: LeaseAuthorityInput;
  readonly teamId: ID;
}

export type ApproveActionHandler = (input: ApproveActionInput) => Promise<InvocationAuthorizationCommandResponseV1>;

export function createApproveActionHandler(deps: InvocationAuthorizationHandlerDeps): ApproveActionHandler {
  return async ({ envelope: rawEnvelope, payload: rawPayload, approverId, authority, teamId }) => {
    const envelope = parseAndCheckEnvelope(rawEnvelope, 'approve-action');
    const input = parseInvocationAuthorizationInputV1('approve-action', rawPayload);
    const commandHash = computeCommandHash('approve-action', envelope.commandSchemaVersion, rawPayload);

    return deps.unitOfWork.run(async (repos) => {
      const now = deps.clock.now();
      await authorizeManagementWrite(repos.management, authority, now);

      const existingReceipt = await repos.authorization.receipts.getReceiptByIdempotencyKey(envelope.idempotencyKey);
      if (existingReceipt) {
        return existingReceipt.commandHash === commandHash
          ? replayResponse(existingReceipt)
          : conflictResponse('approve-action', 'idempotency_conflict');
      }

      const existingFact = await repos.authorization.authorizationFacts.getByInvocationId(input.invocationId);
      if (!existingFact) return rejectedResponse('approve-action', 'AUTHORIZATION_NOT_FOUND');

      const existingApproval = await repos.authorization.actionApprovals.getByEffectDedupKey({
        managementRunId: input.managementRunId, invocationId: input.invocationId,
        effectKind: input.effectIdentity.effectKind, dedupKey: input.effectIdentity.dedupKey,
      });
      const decision = evaluateActionApproval({
        actionRef: input.actionRef,
        effectIdentity: input.effectIdentity,
        authorizationState: existingFact.state,
        authorizationFrozenRevision: existingFact.frozenRevision,
        currentRevision: input.taskRevision,
        existingApproval: existingApproval
          ? {
              approvalId: existingApproval.id, actionRef: existingApproval.actionRef,
              effectKind: existingApproval.effectKind, dedupKey: existingApproval.dedupKey,
              contentHash: existingApproval.contentHash, state: existingApproval.state,
            }
          : undefined,
      });

      if (decision.kind === 'rejected') return rejectedResponse('approve-action', 'APPROVAL_REJECTED');

      if (decision.kind === 'replayed') {
        const receiptId = deps.ids.nextId();
        const replayApproval = await repos.authorization.actionApprovals.getByEffectDedupKey({
          managementRunId: input.managementRunId, invocationId: input.invocationId,
          effectKind: input.effectIdentity.effectKind, dedupKey: input.effectIdentity.dedupKey,
        });
        const result: InvocationAuthorizationCommandOutputUnionV1 = {
          commandName: 'approve-action', approvalId: decision.approvalId, actionRef: input.actionRef,
          effectIdentity: input.effectIdentity, approverId: replayApproval?.approverId ?? approverId,
          approvedRevision: replayApproval?.approvedRevision ?? input.taskRevision,
        };
        const receiptRecord: InvocationAuthorizationCommandReceiptRecord = {
          receiptId, teamId, commandName: 'approve-action',
          commandSchemaVersion: envelope.commandSchemaVersion, idempotencyKey: envelope.idempotencyKey,
          commandHash, outcome: 'no_op', committedRevisions: [], eventRefs: [],
          resultAvailable: true, resultJson: JSON.stringify(result), commitTime: now, createdAt: now,
        };
        await repos.authorization.receipts.createReceipt(receiptRecord);
        await repos.authorization.receipts.createTombstone({
          id: deps.ids.nextId(), teamId, commandName: 'approve-action',
          idempotencyKey: envelope.idempotencyKey, commandHash, receiptId,
          outcome: 'no_op', resultAvailable: true, createdAt: now,
        });
        return buildResponse('approve-action', 'replayed', 'APPROVAL_REPLAYED', 'none', { receipt: toReceiptV1(receiptRecord), result });
      }

      // applied
      const approvalId = deps.ids.nextId();
      await repos.authorization.actionApprovals.create({
        id: approvalId, managementRunId: input.managementRunId, invocationId: input.invocationId,
        authorizationReceiptId: input.authorizationReceiptId, actionRef: input.actionRef,
        effectKind: input.effectIdentity.effectKind, dedupKey: input.effectIdentity.dedupKey,
        contentHash: input.effectIdentity.contentHash, approvedRevision: input.taskRevision,
        approvedAttempt: input.taskAttempt, claimLeaseId: input.claimLeaseId, approverId,
        state: 'applied', createdAt: now,
      });
      const result: InvocationAuthorizationCommandOutputUnionV1 = {
        commandName: 'approve-action', approvalId, actionRef: input.actionRef,
        effectIdentity: input.effectIdentity, approverId, approvedRevision: input.taskRevision,
      };
      const receiptId = deps.ids.nextId();
      const receiptRecord: InvocationAuthorizationCommandReceiptRecord = {
        receiptId, teamId, commandName: 'approve-action',
        commandSchemaVersion: envelope.commandSchemaVersion, idempotencyKey: envelope.idempotencyKey,
        commandHash, outcome: 'applied',
        committedRevisions: [{ streamKind: 'action-approval', streamId: `${input.managementRunId}:${input.invocationId}:${input.actionRef}`, revision: 1 }],
        eventRefs: [], resultAvailable: true, resultJson: JSON.stringify(result), commitTime: now, createdAt: now,
      };
      await repos.authorization.receipts.createReceipt(receiptRecord);
      await repos.authorization.receipts.createTombstone({
        id: deps.ids.nextId(), teamId, commandName: 'approve-action',
        idempotencyKey: envelope.idempotencyKey, commandHash, receiptId,
        outcome: 'applied', resultAvailable: true, createdAt: now,
      });
      return buildResponse('approve-action', 'applied', 'APPROVAL_APPLIED', 'none', { receipt: toReceiptV1(receiptRecord), result });
    });
  };
}

// ---------------------------------------------------------------------------
// report-effect-outcome handler
// ---------------------------------------------------------------------------

export interface ReportEffectOutcomeInput {
  readonly envelope: unknown;
  readonly payload: unknown;
  readonly authority: LeaseAuthorityInput;
  readonly teamId: ID;
  readonly isExternalEffectUnknown: boolean;
}

export type ReportEffectOutcomeHandler = (input: ReportEffectOutcomeInput) => Promise<InvocationAuthorizationCommandResponseV1>;

export function createReportEffectOutcomeHandler(deps: InvocationAuthorizationHandlerDeps): ReportEffectOutcomeHandler {
  return async ({ envelope: rawEnvelope, payload: rawPayload, authority, teamId, isExternalEffectUnknown }) => {
    const envelope = parseAndCheckEnvelope(rawEnvelope, 'report-effect-outcome');
    const input = parseInvocationAuthorizationInputV1('report-effect-outcome', rawPayload);
    const commandHash = computeCommandHash('report-effect-outcome', envelope.commandSchemaVersion, rawPayload);

    return deps.unitOfWork.run(async (repos) => {
      const now = deps.clock.now();
      await authorizeManagementWrite(repos.management, authority, now);

      const existingReceipt = await repos.authorization.receipts.getReceiptByIdempotencyKey(envelope.idempotencyKey);
      if (existingReceipt) {
        return existingReceipt.commandHash === commandHash
          ? replayResponse(existingReceipt)
          : conflictResponse('report-effect-outcome', 'idempotency_conflict');
      }

      const existingOutcome = await repos.authorization.effectOutcomes.getByEffectIdentity({
        managementRunId: input.managementRunId, invocationId: input.invocationId,
        effectKind: input.effectIdentity.effectKind, dedupKey: input.effectIdentity.dedupKey,
      });
      const dedupDecision = resolveEffectIdempotency({
        effectIdentity: input.effectIdentity,
        existing: existingOutcome
          ? {
              effectOutcomeId: existingOutcome.id, effectKind: existingOutcome.effectKind,
              dedupKey: existingOutcome.dedupKey, contentHash: existingOutcome.contentHash,
              outcome: existingOutcome.outcome, externalEffectUnknown: existingOutcome.externalEffectUnknown,
            }
          : undefined,
        requestedOutcome: input.outcome,
      });

      if (dedupDecision.kind === 'conflict') {
        return buildResponse('report-effect-outcome', 'conflict', 'EFFECT_OUTCOME_CONFLICT', 'reread_then_new_command', { conflictReason: dedupDecision.reason });
      }

      if (dedupDecision.kind === 'replay') {
        const receiptId = deps.ids.nextId();
        const replayEffect = existingOutcome!;
        const result: InvocationAuthorizationCommandOutputUnionV1 = {
          commandName: 'report-effect-outcome', effectOutcomeId: replayEffect.id,
          effectIdentity: input.effectIdentity, outcome: replayEffect.outcome,
          externalEffectUnknown: replayEffect.externalEffectUnknown, actionRequired: replayEffect.actionRequired,
        };
        const receiptRecord: InvocationAuthorizationCommandReceiptRecord = {
          receiptId, teamId, commandName: 'report-effect-outcome',
          commandSchemaVersion: envelope.commandSchemaVersion, idempotencyKey: envelope.idempotencyKey,
          commandHash, outcome: 'no_op', committedRevisions: [], eventRefs: [],
          resultAvailable: true, resultJson: JSON.stringify(result), commitTime: now, createdAt: now,
        };
        await repos.authorization.receipts.createReceipt(receiptRecord);
        await repos.authorization.receipts.createTombstone({
          id: deps.ids.nextId(), teamId, commandName: 'report-effect-outcome',
          idempotencyKey: envelope.idempotencyKey, commandHash, receiptId,
          outcome: 'no_op', resultAvailable: true, createdAt: now,
        });
        return buildResponse('report-effect-outcome', 'replayed', 'EFFECT_OUTCOME_REPLAYED', 'none', { receipt: toReceiptV1(receiptRecord), result });
      }

      // create → applied
      const classification = classifyEffectOutcome({ outcome: input.outcome, isExternalEffectUnknown });
      const effectOutcomeId = deps.ids.nextId();
      await repos.authorization.effectOutcomes.create({
        id: effectOutcomeId, managementRunId: input.managementRunId, invocationId: input.invocationId,
        effectKind: input.effectIdentity.effectKind, dedupKey: input.effectIdentity.dedupKey,
        contentHash: input.effectIdentity.contentHash, outcome: classification.outcome,
        externalEffectUnknown: classification.externalEffectUnknown, actionRequired: classification.actionRequired,
        resultRef: input.resultRef ?? null, errorMessage: input.errorMessage ?? null, createdAt: now,
      });
      const result: InvocationAuthorizationCommandOutputUnionV1 = {
        commandName: 'report-effect-outcome', effectOutcomeId, effectIdentity: input.effectIdentity,
        outcome: classification.outcome, externalEffectUnknown: classification.externalEffectUnknown,
        actionRequired: classification.actionRequired,
      };
      // ADR-0067 §21：External effect unknown + action_required 必须禁止自动重试。
      const retryDirective = classification.actionRequired ? 'user_action' as const : 'none' as const;
      const receiptId = deps.ids.nextId();
      const receiptRecord: InvocationAuthorizationCommandReceiptRecord = {
        receiptId, teamId, commandName: 'report-effect-outcome',
        commandSchemaVersion: envelope.commandSchemaVersion, idempotencyKey: envelope.idempotencyKey,
        commandHash, outcome: 'applied',
        committedRevisions: [{ streamKind: 'effect-outcome', streamId: `${input.managementRunId}:${input.invocationId}:${input.effectIdentity.effectKind}:${input.effectIdentity.dedupKey}`, revision: 1 }],
        eventRefs: [], resultAvailable: true, resultJson: JSON.stringify(result), commitTime: now, createdAt: now,
      };
      await repos.authorization.receipts.createReceipt(receiptRecord);
      await repos.authorization.receipts.createTombstone({
        id: deps.ids.nextId(), teamId, commandName: 'report-effect-outcome',
        idempotencyKey: envelope.idempotencyKey, commandHash, receiptId,
        outcome: 'applied', resultAvailable: true, createdAt: now,
      });
      return buildResponse('report-effect-outcome', 'applied', 'EFFECT_OUTCOME_RECORDED', retryDirective, { receipt: toReceiptV1(receiptRecord), result });
    });
  };
}
