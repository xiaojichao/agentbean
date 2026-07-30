import type { EffectIdentityV1 } from '@agentbean/contracts';

/**
 * #927 Invocation authorization / Action approval / Effect identity domain policy（纯函数）。
 *
 * ADR-0067 §21：Task claim 只授权承担责任，Invocation authorization 只授权一次限域操作，
 * Action approval 只授权绑定当前 revision 与 Effect identity 的高风险效果。
 *
 * 本模块提供纯函数决策，不读写存储、不产生副作用。
 * 供 server handler 在事务内调用，与服务层策略（claim validation、lease check）组合。
 */

// ---------------------------------------------------------------------------
// Effect identity canonical serialization
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('EFFECT_IDENTITY_NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error('EFFECT_IDENTITY_UNSUPPORTED_VALUE');
}

/**
 * Effect identity 的 canonical 串。用于 dedup 判定：同 effect identity → 相同 canonical 串。
 * 键序固定、递归、跳过 undefined，使对象键顺序不影响相等判定。
 */
export function canonicalizeEffectIdentity(effect: EffectIdentityV1): string {
  return canonicalJson(effect);
}

// ---------------------------------------------------------------------------
// Invocation Authorization —— revision/attempt/claim 绑定校验
// ---------------------------------------------------------------------------

export interface ExistingAuthorizationRecord {
  readonly authorizationId: string;
  readonly operationHash: string;
  readonly frozenRevision: number;
  readonly frozenAttempt: number;
  readonly frozenClaimLeaseId: string;
  readonly state: 'active' | 'superseded' | 'revoked';
}

export interface EvaluateInvocationAuthorizationInput {
  readonly managementRunId: string;
  readonly invocationId: string;
  readonly requestedOperationHash: string;
  readonly existing?: ExistingAuthorizationRecord;
  readonly currentTaskRevision: number;
  readonly currentTaskAttempt: number;
  readonly currentClaimLeaseId: string;
  readonly claimActive: boolean;
  readonly deadlineAt?: number;
  readonly now: number;
}

export type InvocationAuthorizationDecision =
  | { readonly kind: 'authorized'; readonly frozenRevision: number; readonly frozenAttempt: number }
  | { readonly kind: 'replayed'; readonly authorizationId: string }
  | { readonly kind: 'conflict'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * 校验 invocation authorization 的 revision/attempt/claim 绑定。
 *
 * - 无既有 authorization → authorized（建新，冻结当前 revision/attempt）
 * - 既有 + revision/attempt/claim 匹配 + operation hash 匹配 → replayed（幂等）
 * - 既有 + operation hash 不同 → conflict（同 key 异语义）
 * - revision/attempt/claim 任一变化 → rejected（旧 authorization 失效，需新建）
 * - deadline 过期 → rejected
 * - claim 不 active → rejected
 *
 * #927 AC：旧 claim/attempt/revision 的 Invocation 被拒绝。
 */
export function evaluateInvocationAuthorization(
  input: EvaluateInvocationAuthorizationInput,
): InvocationAuthorizationDecision {
  // deadline 过期优先于其他校验。
  if (input.deadlineAt !== undefined && input.deadlineAt <= input.now) {
    return { kind: 'rejected', reason: 'deadline_expired' };
  }
  // claim 必须 active。
  if (!input.claimActive) {
    return { kind: 'rejected', reason: 'claim_inactive' };
  }
  if (!input.existing) {
    return {
      kind: 'authorized',
      frozenRevision: input.currentTaskRevision,
      frozenAttempt: input.currentTaskAttempt,
    };
  }
  // 同 idempotency key 下既有 authorization 的 operation hash 与本次不同 → conflict。
  if (input.existing.operationHash !== input.requestedOperationHash) {
    return { kind: 'conflict', reason: 'operation_hash_mismatch' };
  }
  // revision/attempt/claim 任一不匹配 → rejected。
  if (input.existing.frozenRevision !== input.currentTaskRevision) {
    return { kind: 'rejected', reason: 'revision_changed' };
  }
  if (input.existing.frozenAttempt !== input.currentTaskAttempt) {
    return { kind: 'rejected', reason: 'attempt_changed' };
  }
  if (input.existing.frozenClaimLeaseId !== input.currentClaimLeaseId) {
    return { kind: 'rejected', reason: 'claim_lease_changed' };
  }
  // state 已 superseded/revoked → 拒绝重放。
  if (input.existing.state !== 'active') {
    return { kind: 'rejected', reason: `authorization_${input.existing.state}` };
  }
  return { kind: 'replayed', authorizationId: input.existing.authorizationId };
}

// ---------------------------------------------------------------------------
// Action Approval —— 独立审批校验
// ---------------------------------------------------------------------------

export interface ExistingApprovalRecord {
  readonly approvalId: string;
  readonly actionRef: string;
  readonly effectKind: string;
  readonly dedupKey: string;
  readonly contentHash: string;
  readonly state: 'applied' | 'no_op';
}

export interface EvaluateActionApprovalInput {
  readonly actionRef: string;
  readonly effectIdentity: EffectIdentityV1;
  readonly authorizationState: 'active' | 'superseded' | 'revoked';
  readonly authorizationFrozenRevision: number;
  readonly currentRevision: number;
  readonly existingApproval?: ExistingApprovalRecord;
}

export type ActionApprovalDecision =
  | { readonly kind: 'approved' }
  | { readonly kind: 'replayed'; readonly approvalId: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * 校验 action approval 的合法性。
 *
 * - authorization 必须 active；superseded/revoked → rejected
 * - revision 必须匹配 authorization 冻结的 revision → 否则 rejected
 *   （#927 AC：旧 revision 的 approval 被拒绝）
 * - 同 effect identity 已有 applied approval → replayed
 * - 其余 → approved
 *
 * 注意：approver 合法性与「effect 是否在 authorized planned scope 内」由 handler 校验
 * （查询 team/user 权限 + plannedEffectIdentitiesJson membership），不在本纯函数范围。
 */
export function evaluateActionApproval(
  input: EvaluateActionApprovalInput,
): ActionApprovalDecision {
  // authorization 必须 active。
  if (input.authorizationState !== 'active') {
    return { kind: 'rejected', reason: `authorization_${input.authorizationState}` };
  }
  // revision 必须匹配（#927 AC：旧 revision 的 approval 被拒绝）。
  if (input.authorizationFrozenRevision !== input.currentRevision) {
    return { kind: 'rejected', reason: 'revision_stale' };
  }
  // 同 effect identity 已有 applied approval → replayed。
  if (input.existingApproval?.state === 'applied') {
    return { kind: 'replayed', approvalId: input.existingApproval.approvalId };
  }
  return { kind: 'approved' };
}

// ---------------------------------------------------------------------------
// Effect Idempotency（#927 AC：同一 Effect identity 不重复产生外部效果）
// ---------------------------------------------------------------------------

export interface ExistingEffectRecord {
  readonly effectOutcomeId: string;
  readonly effectKind: string;
  readonly dedupKey: string;
  readonly contentHash: string;
  readonly outcome: 'succeeded' | 'failed' | 'unknown';
  readonly externalEffectUnknown: boolean;
}

export interface ResolveEffectIdempotencyInput {
  readonly effectIdentity: EffectIdentityV1;
  readonly existing?: ExistingEffectRecord;
  readonly requestedOutcome: 'succeeded' | 'failed' | 'unknown';
}

export type EffectIdempotencyDecision =
  | { readonly kind: 'create' }
  | { readonly kind: 'replay'; readonly effectOutcomeId: string }
  | { readonly kind: 'conflict'; readonly reason: string };

/**
 * 同 effect identity 下的三类决断：
 *
 * - 无既有记录 → create（新建）
 * - 既有记录 + contentHash 匹配 + outcome 匹配 → replay（幂等返回既有结果）
 * - 既有记录 + contentHash 不同 → conflict（同 identity 异 content，拒绝覆盖）
 * - 既有记录 + contentHash 匹配 + outcome 不同 → conflict（终态不可改写）
 *
 * #927 AC：同一 Effect identity 不重复产生外部效果；cancellation 不能伪造外部效果已撤销。
 */
export function resolveEffectIdempotency(
  input: ResolveEffectIdempotencyInput,
): EffectIdempotencyDecision {
  if (!input.existing) {
    return { kind: 'create' };
  }
  // contentHash 必须完全匹配（#927 AC：同一 Effect identity 不重复产生外部效果）。
  if (input.existing.contentHash !== input.effectIdentity.contentHash) {
    return { kind: 'conflict', reason: 'content_hash_mismatch' };
  }
  // outcome 必须一致（终态不可改写；cancellation 不能伪造外部效果已撤销）。
  if (input.existing.outcome !== input.requestedOutcome) {
    return { kind: 'conflict', reason: 'outcome_mismatch' };
  }
  return { kind: 'replay', effectOutcomeId: input.existing.effectOutcomeId };
}

// ---------------------------------------------------------------------------
// Effect Outcome Classification（#927 AC：network timeout ≠ External effect unknown）
// ---------------------------------------------------------------------------

export interface ClassifyEffectOutcomeInput {
  readonly outcome: 'succeeded' | 'failed' | 'unknown';
  /**
   * 调用方（handler）根据 external system 的 idempotency/query 能力判断：
   * - effect 已被外部系统确认提交（如 HTTP 202 accepted）但返回结果不可知 → true
   * - 纯网络超时、外部系统 idempotent → false（可安全重试）
   *
   * ADR-0067 §21：只在外系统不支持幂等且不可查询时，`unknown` 才升级为
   * External effect unknown + action_required。
   */
  readonly isExternalEffectUnknown: boolean;
}

export type EffectOutcomeClassification =
  | { readonly outcome: 'succeeded' | 'failed'; readonly externalEffectUnknown: false; readonly actionRequired: false }
  | { readonly outcome: 'unknown'; readonly externalEffectUnknown: true; readonly actionRequired: true }
  | { readonly outcome: 'unknown'; readonly externalEffectUnknown: false; readonly actionRequired: false };

/**
 * 分类 effect outcome。
 *
 * - succeeded / failed → terminal，不需要 action。
 * - unknown + isExternalEffectUnknown → externalEffectUnknown=true、actionRequired=true
 *   （ADR-0067 §21：持久化 External effect unknown + action_required，禁止自动重试）
 * - unknown + !isExternalEffectUnknown → 可安全重试（如 network timeout 但外部 idempotent），
 *   actionRequired=false
 *
 * #927 AC：network timeout 不把 Command outcome_unknown 与 External effect unknown 混为一谈。
 */
export function classifyEffectOutcome(
  input: ClassifyEffectOutcomeInput,
): EffectOutcomeClassification {
  if (input.outcome === 'succeeded') {
    return { outcome: 'succeeded', externalEffectUnknown: false, actionRequired: false };
  }
  if (input.outcome === 'failed') {
    return { outcome: 'failed', externalEffectUnknown: false, actionRequired: false };
  }
  // outcome === 'unknown'
  if (input.isExternalEffectUnknown) {
    return { outcome: 'unknown', externalEffectUnknown: true, actionRequired: true };
  }
  return { outcome: 'unknown', externalEffectUnknown: false, actionRequired: false };
}
