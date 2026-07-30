import type { ID } from '@agentbean/contracts';
import type { PromotionObjectiveSnapshotV1, PromotionTriggerKind } from '@agentbean/contracts';

/**
 * Promotion gate 纯策略（issue #922 / #894 / #900 / ADR-0067）。
 *
 * 这些纯函数是无副作用的 Server 判定器：在 promotion handler 的事务提交前，按 source lineage、
 * objective/scope/risk snapshot、Freshness basis 与 authorization 边界做幂等收敛、去重、conflict、
 * freshness hold 与授权判定（#894 §5/§6/§8）。它们不读不写存储，由 handler 在事务内查询既有事实
 * 后喂入，保证幂等与冲突判定可独立测试与跨端复用。
 */

// ---------------------------------------------------------------------------
// 高风险 action 边界（#894 §8：promotion authorization 不授予高风险 action）
// ---------------------------------------------------------------------------

/**
 * promotion 只授权创建 root Task 与启动 PI orchestration；删除、发布、付款、外发数据与生产变更等
 * 高风险动作仍需独立 action approval（#894 §8）。本 gate 拒绝夹带这些 action 的请求。
 */
export const PROMOTION_HIGH_RISK_ACTIONS = [
  'delete', 'publish', 'payment', 'data-export', 'production-change',
] as const;

export type PromotionHighRiskAction = (typeof PROMOTION_HIGH_RISK_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Objective snapshot canonicalization（收敛比对的语义核心，#894 §6/§8）
// ---------------------------------------------------------------------------

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

/**
 * 对 objective/scope/risk/data snapshot 做确定性序列化（键字母序、跳过 undefined）。
 * 同 source lineage 下 canonical 相等 = 收敛到同一 root Task；不等 = 无副作用 conflict。
 */
export function canonicalizePromotionObjectiveSnapshot(snapshot: PromotionObjectiveSnapshotV1): string {
  return JSON.stringify(canonicalizeValue(snapshot));
}

// ---------------------------------------------------------------------------
// Convergence（#894 §6：唯一 gate 幂等收敛与 conflict）
// ---------------------------------------------------------------------------

export interface PromotionConvergenceInput {
  readonly sourceLineageKey: string;
  readonly requestedSnapshot: PromotionObjectiveSnapshotV1;
  /** 同 source lineage 的既有 root Task 与创建时 snapshot（handler 查既有 source relation 喂入）。 */
  readonly existing?: {
    readonly lineageKey: string;
    readonly taskId: ID;
    readonly snapshot: PromotionObjectiveSnapshotV1;
  };
}

export type PromotionConvergenceDecision =
  | { readonly kind: 'create' }
  | { readonly kind: 'converged'; readonly existingTaskId: ID }
  | { readonly kind: 'conflict'; readonly reason: string };

/**
 * 同 source lineage 一致请求收敛返回同一 root Task；不一致请求返回无副作用 conflict，不允许先到先得。
 * 不同 lineage 永不收敛（lineage 是收敛键）。
 */
export function evaluatePromotionConvergence(input: PromotionConvergenceInput): PromotionConvergenceDecision {
  if (!input.existing) return { kind: 'create' };
  // lineage 是收敛键：不同 lineage 的既有 Task 不参与收敛（handler 应按 lineage 查，函数二次防御）。
  if (input.existing.lineageKey !== input.sourceLineageKey) return { kind: 'create' };
  if (canonicalizePromotionObjectiveSnapshot(input.requestedSnapshot)
    === canonicalizePromotionObjectiveSnapshot(input.existing.snapshot)) {
    return { kind: 'converged', existingTaskId: input.existing.taskId };
  }
  return { kind: 'conflict', reason: 'different-objective-snapshot' };
}

// ---------------------------------------------------------------------------
// Authorization（#894 §1/§8：只有结构化 human trigger 可触发；不授予高风险 action）
// ---------------------------------------------------------------------------

export interface PromotionAuthorizationInput {
  readonly triggerKind: PromotionTriggerKind;
  /** 非 human trigger 只能由 Server 的 proposal/policy/escalation handler 完成授权后置 true。 */
  readonly trustedStructuredTrigger?: boolean;
  /** 请求的动作；orchestration-only（create-task/start-orchestration）允许，高风险 action 拒绝。 */
  readonly requestedActions?: readonly string[];
}

export type PromotionAuthorizationDecision =
  | { readonly allowed: true }
  | { readonly denied: true; readonly reason: string };

/**
 * promotion authorization 只授权创建 root Task 与启动 PI orchestration。
 * 普通自然语言、@Agent、DM、Thread owner 都不是合法 human trigger；夹带高风险 action 的请求一律拒绝。
 */
export function evaluatePromotionAuthorization(input: PromotionAuthorizationInput): PromotionAuthorizationDecision {
  // 二次防御：envelope exact-key 校验已拒绝非登记 trigger；本函数对任何非 human-structured 一律拒绝。
  if (input.triggerKind !== 'human-structured' && input.trustedStructuredTrigger !== true) {
    return { denied: true, reason: 'not-human-trigger' };
  }
  const actions = input.requestedActions ?? [];
  const highRisk = actions.find((action) =>
    (PROMOTION_HIGH_RISK_ACTIONS as readonly string[]).includes(action));
  if (highRisk) {
    return { denied: true, reason: `high-risk-action:${highRisk}` };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Freshness（#894 §5：来源 revision 锚定，旧 token 不能跨 revision 复用）
// ---------------------------------------------------------------------------

export interface PromotionFreshnessInput {
  readonly requestedSourceRevision?: number;
  readonly currentSourceRevision?: number;
  /** 来源已被编辑或删除（handler 检测来源变化喂入）。 */
  readonly sourceChanged?: boolean;
}

export type PromotionFreshnessDecision =
  | { readonly ok: true }
  | { readonly hold: true; readonly reason: string };

/**
 * 来源编辑/删除、相关上下文、权限或风险边界变化时，旧请求进入 Freshness hold，不创建 Task。
 */
export function evaluatePromotionFreshness(input: PromotionFreshnessInput): PromotionFreshnessDecision {
  if (input.sourceChanged) return { hold: true, reason: 'source-changed' };
  if (input.requestedSourceRevision !== undefined && input.currentSourceRevision === undefined) {
    return { hold: true, reason: 'source-revision-unavailable' };
  }
  if (input.requestedSourceRevision !== undefined
    && input.currentSourceRevision !== undefined
    && input.requestedSourceRevision < input.currentSourceRevision) {
    return { hold: true, reason: 'source-revision-advanced' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Outcome classification（#900 §18 command 处理链顺序：authority → freshness → 幂等冲突 → 提交）
// ---------------------------------------------------------------------------

export interface PromotionClassificationInput {
  readonly authorization: PromotionAuthorizationDecision;
  readonly freshness: PromotionFreshnessDecision;
  readonly convergence: PromotionConvergenceDecision;
}

export type PromotionOutcomeClassification =
  | { readonly outcome: 'rejected'; readonly reason: string }
  | { readonly outcome: 'freshness_hold'; readonly reason: string }
  | { readonly outcome: 'conflict'; readonly reason: string }
  | { readonly outcome: 'applied' }
  | { readonly outcome: 'replayed'; readonly existingTaskId: ID };

/**
 * 组合 authorization / freshness / convergence 得到 response outcome。优先级即 #900 §18 门禁顺序：
 * 鉴权失败 → rejected；来源过期 → freshness_hold；lineage 冲突 → conflict；新建 → applied；幂等命中 → replayed。
 */
export function classifyPromotionOutcome(input: PromotionClassificationInput): PromotionOutcomeClassification {
  if ('denied' in input.authorization) {
    return { outcome: 'rejected', reason: input.authorization.reason };
  }
  if ('hold' in input.freshness) {
    return { outcome: 'freshness_hold', reason: input.freshness.reason };
  }
  if (input.convergence.kind === 'conflict') {
    return { outcome: 'conflict', reason: input.convergence.reason };
  }
  if (input.convergence.kind === 'converged') {
    return { outcome: 'replayed', existingTaskId: input.convergence.existingTaskId };
  }
  return { outcome: 'applied' };
}
