import type { ID, UnixMs } from './common.js';
import {
  COMMAND_PROVENANCE_KINDS,
  type CommandProvenanceKind,
  type CommandProvenanceRefV1,
} from './message-tracer.js';

/**
 * Invocation authorization / Action approval / Effect identity 命令合同
 * （issue #927 / ADR-0067 Command registry 的 Invocation/Action approval family）。
 *
 * ADR-0067 §21：Task claim 只授权承担责任，Invocation authorization 只授权一次限域操作，
 * Action approval 只授权绑定当前 revision 与 Effect identity 的高风险效果。三者严格分离。
 *
 * 三个具名 command：
 * - `authorize-invocation`：显式将 invocation 绑定到 revision/attempt/claim，冻结 operation scope
 *   与 effect identities
 * - `approve-action`：独立、revision-bound 的高风险 action/effect 审批，Server 推导合法 approver
 * - `report-effect-outcome`：报告外部 effect 的终端结果；`unknown` 时持久化
 *   External effect unknown + action_required，禁止自动重试
 *
 * 与 Message tracer / Promotion gate 共享 transport-independent envelope、exact-key runtime
 * schema、版本化 outcome/receipt 与业务幂等身份。
 */

// ---------------------------------------------------------------------------
// Contract capabilities —— Command registry 的 Invocation / Action approval family
// ---------------------------------------------------------------------------

export const INVOCATION_AUTHORIZATION_COMMAND_NAMES = [
  'authorize-invocation',
  'approve-action',
  'report-effect-outcome',
] as const;

export type InvocationAuthorizationCommandName =
  (typeof INVOCATION_AUTHORIZATION_COMMAND_NAMES)[number];

export const INVOCATION_AUTHORIZATION_ENVELOPE_SCHEMA_VERSION = 1;
export const INVOCATION_AUTHORIZATION_COMMAND_SCHEMA_VERSION = 1;
export const INVOCATION_AUTHORIZATION_COMMAND_HASH_VERSION = 1;

export const INVOCATION_AUTHORIZATION_RECEIPT_OUTCOMES = ['applied', 'no_op'] as const;
export type InvocationAuthorizationReceiptOutcome =
  (typeof INVOCATION_AUTHORIZATION_RECEIPT_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Effect identity —— 外部效果的稳定去重标识（#927 AC：同一 Effect identity 不重复产生外部效果）
// ---------------------------------------------------------------------------

export interface EffectScopeV1 {
  readonly managementRunId: ID;
  readonly invocationId: ID;
}

export interface EffectIdentityV1 {
  readonly schemaVersion: 1;
  readonly effectKind: string;
  readonly scope: EffectScopeV1;
  readonly dedupKey: string;
  readonly contentHash: string;
}

export const INVOCATION_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type InvocationRiskLevel = (typeof INVOCATION_RISK_LEVELS)[number];

export interface InvocationOperationScopeV1 {
  readonly operationKind: string;
  readonly inputHash: string;
  readonly plannedEffectIdentities: readonly EffectIdentityV1[];
  readonly riskLevel: InvocationRiskLevel;
  readonly deadlineAt?: UnixMs;
}

// ---------------------------------------------------------------------------
// Command envelope + input/output maps（ADR-0067）
// ---------------------------------------------------------------------------

export interface InvocationAuthorizationCommandEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly commandName: InvocationAuthorizationCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly causationRef?: CommandProvenanceRefV1;
  readonly sourceRefs?: readonly CommandProvenanceRefV1[];
}

export interface InvocationAuthorizationCommandInputMapV1 {
  readonly 'authorize-invocation': {
    readonly managementRunId: ID;
    readonly invocationId: ID;
    readonly taskContext: {
      readonly taskId: ID;
      readonly taskRevision: number;
      readonly taskAttempt: number;
      readonly claimLeaseId: ID;
    };
    readonly operationScope: InvocationOperationScopeV1;
    readonly clientRequestId?: string;
  };
  readonly 'approve-action': {
    readonly managementRunId: ID;
    readonly invocationId: ID;
    readonly authorizationReceiptId: ID;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly claimLeaseId: ID;
    readonly actionRef: string;
    readonly effectIdentity: EffectIdentityV1;
    readonly clientRequestId?: string;
  };
  readonly 'report-effect-outcome': {
    readonly managementRunId: ID;
    readonly invocationId: ID;
    readonly effectIdentity: EffectIdentityV1;
    readonly outcome: 'succeeded' | 'failed' | 'unknown';
    readonly resultRef?: string;
    readonly errorMessage?: string;
    readonly clientRequestId?: string;
  };
}

export interface InvocationAuthorizationEventRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
}

export interface InvocationAuthorizationRevisionRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

export interface InvocationAuthorizationCommandOutputMapV1 {
  readonly 'authorize-invocation': {
    readonly authorizationId: ID;
    readonly managementRunId: ID;
    readonly invocationId: ID;
    readonly frozenRevision: number;
    readonly frozenAttempt: number;
    readonly authorizedEffectIdentities: readonly EffectIdentityV1[];
    readonly requiresActionApproval: boolean;
  };
  readonly 'approve-action': {
    readonly approvalId: ID;
    readonly actionRef: string;
    readonly effectIdentity: EffectIdentityV1;
    readonly approverId: ID;
    readonly approvedRevision: number;
  };
  readonly 'report-effect-outcome': {
    readonly effectOutcomeId: ID;
    readonly effectIdentity: EffectIdentityV1;
    readonly outcome: 'succeeded' | 'failed' | 'unknown';
    readonly externalEffectUnknown: boolean;
    readonly actionRequired: boolean;
  };
}

export type InvocationAuthorizationCommandOutputUnionV1 =
  | ({ readonly commandName: 'authorize-invocation' } & InvocationAuthorizationCommandOutputMapV1['authorize-invocation'])
  | ({ readonly commandName: 'approve-action' } & InvocationAuthorizationCommandOutputMapV1['approve-action'])
  | ({ readonly commandName: 'report-effect-outcome' } & InvocationAuthorizationCommandOutputMapV1['report-effect-outcome']);

export interface InvocationAuthorizationCommandReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: ID;
  readonly commandName: InvocationAuthorizationCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: 'applied' | 'no_op';
  readonly committedRevisions: readonly InvocationAuthorizationRevisionRefV1[];
  readonly eventRefs: readonly InvocationAuthorizationEventRefV1[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
}

export const INVOCATION_AUTHORIZATION_OUTCOMES = [
  'applied', 'no_op', 'replayed', 'freshness_hold',
  'conflict', 'rejected', 'temporarily_unavailable', 'outcome_unknown',
] as const;
export type InvocationAuthorizationOutcome = (typeof INVOCATION_AUTHORIZATION_OUTCOMES)[number];

export const INVOCATION_AUTHORIZATION_RETRY_DIRECTIVES = [
  'none', 'same_key', 'reread_then_new_command', 'user_action',
] as const;
export type InvocationAuthorizationRetryDirective =
  (typeof INVOCATION_AUTHORIZATION_RETRY_DIRECTIVES)[number];

export interface InvocationAuthorizationCommandResponseV1 {
  readonly schemaVersion: 1;
  readonly commandName: InvocationAuthorizationCommandName;
  readonly outcome: InvocationAuthorizationOutcome;
  readonly retryDirective: InvocationAuthorizationRetryDirective;
  readonly stableCode: string;
  readonly receipt?: InvocationAuthorizationCommandReceiptV1;
  readonly result?: InvocationAuthorizationCommandOutputUnionV1;
  readonly conflictReason?: string;
  readonly freshnessReason?: string;
}

// ---------------------------------------------------------------------------
// Exact-key runtime schema 校验
// ---------------------------------------------------------------------------

const INVOCATION_AUTHORIZATION_PAYLOAD_INVALID = 'INVOCATION_AUTHORIZATION_PAYLOAD_INVALID';

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertId(value: unknown): void {
  if (!nonEmpty(value)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertCommandName(value: unknown): asserts value is InvocationAuthorizationCommandName {
  if (!INVOCATION_AUTHORIZATION_COMMAND_NAMES.includes(
    value as typeof INVOCATION_AUTHORIZATION_COMMAND_NAMES[number],
  )) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertRiskLevel(value: unknown): asserts value is InvocationRiskLevel {
  if (!INVOCATION_RISK_LEVELS.includes(value as typeof INVOCATION_RISK_LEVELS[number])) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertEffectOutcome(value: unknown): asserts value is 'succeeded' | 'failed' | 'unknown' {
  if (value !== 'succeeded' && value !== 'failed' && value !== 'unknown') {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertCommandProvenanceRef(value: unknown): void {
  assertExactKeys(value, ['kind', 'id', 'revision', 'sequence', 'scope', 'hash'], ['kind', 'id']);
  if (!COMMAND_PROVENANCE_KINDS.includes(value.kind as CommandProvenanceKind)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  assertId(value.id);
  if (value.revision !== undefined) assertInteger(value.revision, 0);
  if (value.sequence !== undefined) assertInteger(value.sequence, 0);
  if (value.scope !== undefined && !nonEmpty(value.scope)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  if (value.hash !== undefined && !nonEmpty(value.hash)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertEffectScope(value: unknown): void {
  assertExactKeys(value, ['managementRunId', 'invocationId'], ['managementRunId', 'invocationId']);
  assertId(value.managementRunId);
  assertId(value.invocationId);
}

function assertEffectIdentity(value: unknown): void {
  assertExactKeys(
    value,
    ['schemaVersion', 'effectKind', 'scope', 'dedupKey', 'contentHash'],
    ['schemaVersion', 'effectKind', 'scope', 'dedupKey', 'contentHash'],
  );
  if (value.schemaVersion !== 1) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  if (!nonEmpty(value.effectKind)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  assertEffectScope(value.scope);
  if (!nonEmpty(value.dedupKey)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  if (!nonEmpty(value.contentHash)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
}

function assertEffectIdentityArray(value: unknown): void {
  if (!Array.isArray(value)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  value.forEach(assertEffectIdentity);
}

function assertOperationScope(value: unknown): void {
  assertExactKeys(
    value,
    ['operationKind', 'inputHash', 'plannedEffectIdentities', 'riskLevel', 'deadlineAt'],
    ['operationKind', 'inputHash', 'plannedEffectIdentities', 'riskLevel'],
  );
  if (!nonEmpty(value.operationKind)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  if (!nonEmpty(value.inputHash)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  assertEffectIdentityArray(value.plannedEffectIdentities);
  assertRiskLevel(value.riskLevel);
  if (value.deadlineAt !== undefined) assertInteger(value.deadlineAt, 0);
}

function assertTaskContext(value: unknown): void {
  assertExactKeys(
    value,
    ['taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId'],
    ['taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId'],
  );
  assertId(value.taskId);
  assertInteger(value.taskRevision, 0);
  assertInteger(value.taskAttempt, 0);
  assertId(value.claimLeaseId);
}

function assertAuthorizeInvocationInput(value: unknown): void {
  assertExactKeys(
    value,
    ['managementRunId', 'invocationId', 'taskContext', 'operationScope', 'clientRequestId'],
    ['managementRunId', 'invocationId', 'taskContext', 'operationScope'],
  );
  assertId(value.managementRunId);
  assertId(value.invocationId);
  assertTaskContext(value.taskContext);
  assertOperationScope(value.operationScope);
  if (value.clientRequestId !== undefined && !nonEmpty(value.clientRequestId)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertApproveActionInput(value: unknown): void {
  assertExactKeys(
    value,
    ['managementRunId', 'invocationId', 'authorizationReceiptId', 'taskRevision', 'taskAttempt',
      'claimLeaseId', 'actionRef', 'effectIdentity', 'clientRequestId'],
    ['managementRunId', 'invocationId', 'authorizationReceiptId', 'taskRevision', 'taskAttempt',
      'claimLeaseId', 'actionRef', 'effectIdentity'],
  );
  assertId(value.managementRunId);
  assertId(value.invocationId);
  assertId(value.authorizationReceiptId);
  assertInteger(value.taskRevision, 0);
  assertInteger(value.taskAttempt, 0);
  assertId(value.claimLeaseId);
  if (!nonEmpty(value.actionRef)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  assertEffectIdentity(value.effectIdentity);
  if (value.clientRequestId !== undefined && !nonEmpty(value.clientRequestId)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertReportEffectOutcomeInput(value: unknown): void {
  assertExactKeys(
    value,
    ['managementRunId', 'invocationId', 'effectIdentity', 'outcome', 'resultRef', 'errorMessage',
      'clientRequestId'],
    ['managementRunId', 'invocationId', 'effectIdentity', 'outcome'],
  );
  assertId(value.managementRunId);
  assertId(value.invocationId);
  assertEffectIdentity(value.effectIdentity);
  assertEffectOutcome(value.outcome);
  if (value.resultRef !== undefined && !nonEmpty(value.resultRef)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  if (value.errorMessage !== undefined && !nonEmpty(value.errorMessage)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  if (value.clientRequestId !== undefined && !nonEmpty(value.clientRequestId)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertInvocationAuthorizationInput(
  commandName: InvocationAuthorizationCommandName,
  value: unknown,
): void {
  if (commandName === 'authorize-invocation') { assertAuthorizeInvocationInput(value); return; }
  if (commandName === 'approve-action') { assertApproveActionInput(value); return; }
  assertReportEffectOutcomeInput(value);
}

function assertAuthorizeInvocationOutput(value: unknown): void {
  assertExactKeys(
    value,
    ['commandName', 'authorizationId', 'managementRunId', 'invocationId', 'frozenRevision',
      'frozenAttempt', 'authorizedEffectIdentities', 'requiresActionApproval'],
    ['commandName', 'authorizationId', 'managementRunId', 'invocationId', 'frozenRevision',
      'frozenAttempt', 'authorizedEffectIdentities', 'requiresActionApproval'],
  );
  if (value.commandName !== 'authorize-invocation') {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  assertId(value.authorizationId);
  assertId(value.managementRunId);
  assertId(value.invocationId);
  assertInteger(value.frozenRevision, 0);
  assertInteger(value.frozenAttempt, 0);
  assertEffectIdentityArray(value.authorizedEffectIdentities);
  if (typeof value.requiresActionApproval !== 'boolean') {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertApproveActionOutput(value: unknown): void {
  assertExactKeys(
    value,
    ['commandName', 'approvalId', 'actionRef', 'effectIdentity', 'approverId', 'approvedRevision'],
    ['commandName', 'approvalId', 'actionRef', 'effectIdentity', 'approverId', 'approvedRevision'],
  );
  if (value.commandName !== 'approve-action') {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  assertId(value.approvalId);
  if (!nonEmpty(value.actionRef)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  assertEffectIdentity(value.effectIdentity);
  assertId(value.approverId);
  assertInteger(value.approvedRevision, 0);
}

function assertReportEffectOutcomeOutput(value: unknown): void {
  assertExactKeys(
    value,
    ['commandName', 'effectOutcomeId', 'effectIdentity', 'outcome', 'externalEffectUnknown',
      'actionRequired'],
    ['commandName', 'effectOutcomeId', 'effectIdentity', 'outcome', 'externalEffectUnknown',
      'actionRequired'],
  );
  if (value.commandName !== 'report-effect-outcome') {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  assertId(value.effectOutcomeId);
  assertEffectIdentity(value.effectIdentity);
  assertEffectOutcome(value.outcome);
  if (typeof value.externalEffectUnknown !== 'boolean') {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  if (typeof value.actionRequired !== 'boolean') {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

function assertInvocationAuthorizationOutput(value: unknown): void {
  assertExactKeys(
    value,
    ['commandName', 'authorizationId', 'managementRunId', 'invocationId', 'frozenRevision',
      'frozenAttempt', 'authorizedEffectIdentities', 'requiresActionApproval', 'approvalId',
      'actionRef', 'effectIdentity', 'approverId', 'approvedRevision', 'effectOutcomeId',
      'outcome', 'externalEffectUnknown', 'actionRequired'],
    ['commandName'],
  );
  if (value.commandName === 'authorize-invocation') { assertAuthorizeInvocationOutput(value); return; }
  if (value.commandName === 'approve-action') { assertApproveActionOutput(value); return; }
  assertReportEffectOutcomeOutput(value);
}

function assertRevisionRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'revision'], ['streamKind', 'streamId', 'revision']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  assertInteger(value.revision, 0);
}

function assertEventRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'sequence'], ['streamKind', 'streamId', 'sequence']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
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
  if (value.schemaVersion !== 1) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  assertId(value.receiptId);
  assertCommandName(value.commandName);
  assertInteger(value.commandSchemaVersion, 1);
  assertId(value.idempotencyKey);
  assertId(value.commandHash);
  if (!INVOCATION_AUTHORIZATION_RECEIPT_OUTCOMES.includes(
    value.outcome as typeof INVOCATION_AUTHORIZATION_RECEIPT_OUTCOMES[number],
  )) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  if (!Array.isArray(value.committedRevisions)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  value.committedRevisions.forEach(assertRevisionRef);
  if (!Array.isArray(value.eventRefs)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  value.eventRefs.forEach(assertEventRef);
  assertInteger(value.commitTime, 0);
  if (typeof value.resultAvailable !== 'boolean') {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
}

// ---------------------------------------------------------------------------
// Parsers（exact-key + structuredClone，防外部可变引用外泄）
// ---------------------------------------------------------------------------

export function parseEffectIdentityV1(value: unknown): EffectIdentityV1 {
  assertEffectIdentity(value);
  return structuredClone(value) as unknown as EffectIdentityV1;
}

export function parseInvocationOperationScopeV1(value: unknown): InvocationOperationScopeV1 {
  assertOperationScope(value);
  return structuredClone(value) as unknown as InvocationOperationScopeV1;
}

export function parseInvocationAuthorizationCommandEnvelopeV1(
  value: unknown,
): InvocationAuthorizationCommandEnvelopeV1 {
  assertExactKeys(
    value,
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'causationRef', 'sourceRefs'],
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey'],
  );
  if (value.schemaVersion !== INVOCATION_AUTHORIZATION_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  assertCommandName(value.commandName);
  if (value.commandSchemaVersion !== INVOCATION_AUTHORIZATION_COMMAND_SCHEMA_VERSION) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  assertId(value.idempotencyKey);
  if (value.causationRef !== undefined) assertCommandProvenanceRef(value.causationRef);
  if (value.sourceRefs !== undefined) {
    if (!Array.isArray(value.sourceRefs)) {
      throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
    }
    value.sourceRefs.forEach(assertCommandProvenanceRef);
  }
  return structuredClone(value) as unknown as InvocationAuthorizationCommandEnvelopeV1;
}

export function parseInvocationAuthorizationInputV1<K extends InvocationAuthorizationCommandName>(
  commandName: K,
  value: unknown,
): InvocationAuthorizationCommandInputMapV1[K] {
  assertInvocationAuthorizationInput(commandName, value);
  return structuredClone(value) as InvocationAuthorizationCommandInputMapV1[K];
}

export function parseInvocationAuthorizationCommandReceiptV1(
  value: unknown,
): InvocationAuthorizationCommandReceiptV1 {
  assertCommandReceipt(value);
  return structuredClone(value) as unknown as InvocationAuthorizationCommandReceiptV1;
}

export function parseInvocationAuthorizationCommandResponseV1(
  value: unknown,
): InvocationAuthorizationCommandResponseV1 {
  assertExactKeys(
    value,
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode', 'receipt', 'result',
      'conflictReason', 'freshnessReason'],
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode'],
  );
  if (value.schemaVersion !== 1) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  assertCommandName(value.commandName);
  if (!INVOCATION_AUTHORIZATION_OUTCOMES.includes(
    value.outcome as typeof INVOCATION_AUTHORIZATION_OUTCOMES[number],
  )) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  if (!INVOCATION_AUTHORIZATION_RETRY_DIRECTIVES.includes(
    value.retryDirective as typeof INVOCATION_AUTHORIZATION_RETRY_DIRECTIVES[number],
  )) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  if (value.receipt !== undefined) assertCommandReceipt(value.receipt);
  if (value.result !== undefined) {
    if (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
      || (value.result as Record<string, unknown>).commandName !== value.commandName) {
      throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
    }
    assertInvocationAuthorizationOutput(value.result);
  }
  if (value.conflictReason !== undefined && !nonEmpty(value.conflictReason)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  if (value.freshnessReason !== undefined && !nonEmpty(value.freshnessReason)) {
    throw new Error(INVOCATION_AUTHORIZATION_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as InvocationAuthorizationCommandResponseV1;
}

// ---------------------------------------------------------------------------
// Canonical serialization —— 幂等 conflict 判定的语义核心（#900 §3 / ADR-0067）
// ---------------------------------------------------------------------------

const NON_CONTENT_FIELDS: ReadonlySet<string> = new Set(['clientRequestId']);

function canonicalizeValue(value: unknown, exclude: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeValue(entry, exclude));
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (exclude.has(key)) continue;
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = canonicalizeValue(entry, exclude);
    }
    return sorted;
  }
  return value;
}

export function canonicalizeInvocationAuthorizationCommand(
  commandName: InvocationAuthorizationCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return JSON.stringify(canonicalizeValue({
    v: INVOCATION_AUTHORIZATION_COMMAND_HASH_VERSION,
    commandName,
    commandSchemaVersion,
    input,
  }, NON_CONTENT_FIELDS));
}
