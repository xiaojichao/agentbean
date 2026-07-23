/**
 * #713 Claim relinquishment / authority revocation / manifest commitment gate —— 纯规则。
 *
 * 职责：在既有 task-claim-policy 的 Claim/Lease 基础设施之上，补齐三条闭环：
 * - AC#5：Agent 携带当前 authority 显式 relinquish Claim（区别于底层 release，产 cause/detail
 *   供 PI 决定重新规划、交接或失败；后续动作不在 domain 推导，见 ADR 0025）。
 * - AC#4：System/Team 安全权限撤销优先于旧承诺，强制停止进行中的受影响操作，不需 Agent proof。
 * - AC#2：过期/撤回/被取代的 Manifest 不能用于发布新 Task 或新 Offer。
 *
 * 关键不变量（与 task-claim-policy 一致，复用而非重造）：
 * - AC#3：accepted claim 形成独立履约承诺，manifest 后续变化不自动取消——根源是
 *   `validateProof` 只校验 task 字段、不读 manifest revision。本模块同样不读 manifest 来
 *   判定 claim 终止，仅用 inspectTaskClaim 的 active/expired/released/invalid 分类。
 * - AC#6：relinquishment/revocation/到期/重新认领均经 inspectTaskClaim 门控，fencing token
 *   单调（reopened 时 +1，由 evaluateTaskClaimAcquire 保证）；旧 authority（released/过期
 *   lease）的操作经 validateProof fail-closed（claim-released/claim-expired）。
 *
 * 接线契约（domain 无法保证，须由 server 持久化层负责）：
 * - 并发单赢家：本模块为纯决策，无持久化屏障；接线层须按 fencingToken/lease row 做 CAS。
 * - AC#6 重新获取门禁：被撤销 authority 的 agent 若用新 token 走裸 evaluateTaskClaimAcquire，
 *   reopened-released 会对任意 agentId 放行（结构性缺口，见黄金缺口测试）。接线层须经
 *   evaluateOfferAcceptance 的 qualified 门控，且权限撤销须传播到资格状态，不得为被撤销
 *   agent 调用裸 acquire。disqualifiedAgentIds 输入为后续跟踪增强，本切片不改已合并函数。
 *
 * 无 server 依赖、无 IO。
 */
import type { AgentExposureManifestStatus, ManifestCommitmentUsabilityReason } from '@agentbean/contracts';
import {
  evaluateTaskClaimRelease,
  inspectTaskClaim,
  type TaskClaimAuthorizationFailure,
  type TaskClaimAuthorizationProof,
  type TaskClaimLeaseRecord,
} from './task-claim-policy.js';

// ── cause 联合（domain canonical；contracts 有对应 CAUSE_CODE 投影常量）──

/** Agent 显式 relinquish Claim 的成因（AC#5）。 */
export type ClaimRelinquishmentCause =
  | 'agent_voluntary' // Agent 主动退出，不再承接
  | 'task_unfeasible' // Agent 报告无法完成该 Task
  | 'agent_unavailable' // 可用性变更为 unavailable
  | 'context_changed'; // 运行环境变化（detail 建议）

/** System/Team 安全权限撤销成因（AC#4）。 */
export type AuthorityRevocationCause =
  | 'permission_revoked' // 显式撤销该 Agent 对该 Task 的授权
  | 'membership_revoked' // Agent 不再属于该 Team
  | 'safety_override' // 系统级安全策略强制停止
  | 'manifest_revoked'; // Agent Exposure Manifest 被 owner 撤回（#710）

/** lease 终态分类（inspectTaskClaim 的非 active 子集）。 */
type ClaimTerminalStatus = 'released' | 'expired' | 'invalid';

// ── AC#5/AC#6：Agent 显式 relinquish ──

export interface EvaluateClaimRelinquishmentInput {
  readonly lease?: TaskClaimLeaseRecord;
  readonly proof: TaskClaimAuthorizationProof;
  readonly now: number;
  readonly cause: ClaimRelinquishmentCause;
  readonly detail?: string;
}

export type ClaimRelinquishmentDecision =
  | { readonly kind: 'relinquished'; readonly lease: TaskClaimLeaseRecord; readonly cause: ClaimRelinquishmentCause; readonly detail?: string }
  | { readonly kind: 'already_relinquished'; readonly lease: TaskClaimLeaseRecord; readonly cause: ClaimRelinquishmentCause }
  | { readonly kind: 'no_active_claim' }
  | { readonly kind: 'rejected'; readonly reason: TaskClaimAuthorizationFailure };

/**
 * AC#5/AC#6：Agent 携带当前 authority 显式 relinquish Claim。
 * 先 inspectTaskClaim 分类（避免过期 lease 落到 release 的 rejected:claim-expired，V3 修复）：
 * - released → already_relinquished（幂等）。
 * - expired/invalid/无 lease → no_active_claim（claim 已不存在，绝不写 releasedAt）。
 * - active → 委托 evaluateTaskClaimRelease（复用 proof fencing）；released → relinquished，
 *   stale proof → rejected（真正的旧 authority fail-closed）。
 */
export function evaluateClaimRelinquishment(input: EvaluateClaimRelinquishmentInput): ClaimRelinquishmentDecision {
  const { lease } = input;
  if (!lease) return { kind: 'no_active_claim' };
  const status = inspectTaskClaim(lease, input.now);
  if (status.kind === 'released') {
    return { kind: 'already_relinquished', lease, cause: input.cause };
  }
  if (status.kind === 'expired' || status.kind === 'invalid' || status.kind === 'unclaimed') {
    return { kind: 'no_active_claim' };
  }
  // active → 委托既有 release（proof-gated fencing，stale fail-closed）
  const release = evaluateTaskClaimRelease({ lease, proof: input.proof, now: input.now });
  if (release.kind === 'released') {
    return { kind: 'relinquished', lease: release.lease, cause: input.cause, detail: input.detail };
  }
  if (release.kind === 'already-released') {
    return { kind: 'already_relinquished', lease: release.lease, cause: input.cause };
  }
  // rejected：active lease 但 proof 不匹配（旧/篡改 authority）
  return { kind: 'rejected', reason: release.reason };
}

// ── AC#4/AC#6：System/Team 安全权限撤销 ──

export interface EvaluateAuthorityRevocationInput {
  readonly lease?: TaskClaimLeaseRecord;
  readonly now: number;
  readonly cause: AuthorityRevocationCause;
  readonly detail?: string;
}

export type AuthorityRevocationDecision =
  | { readonly kind: 'revoked'; readonly lease: TaskClaimLeaseRecord; readonly cause: AuthorityRevocationCause; readonly detail?: string }
  | { readonly kind: 'already_terminal'; readonly lease: TaskClaimLeaseRecord; readonly status: ClaimTerminalStatus }
  | { readonly kind: 'no_active_claim' };

/**
 * AC#4/AC#6：System/Team 安全权限撤销，强制停止进行中的受影响操作，不需 Agent proof。
 * 安全优先于旧承诺——即使 agent 持有有效 authority（proof）也强制 release。
 * 必须 inspectTaskClaim 门控（V1 修复）：
 * - active → revoked，设 releasedAt=now（仅 active 态保证 now<expiresAt 且无时钟回退，
 *   releasedAt<expiresAt 不变量成立）。
 * - released/expired/invalid → already_terminal，绝不写 releasedAt（否则过期 lease 违反
 *   releasedAt<expiresAt 变 invalid、fencing token 冻结、永远无法重开）。
 * revoked 后 agent 用旧 proof 操作 → validateProof 返回 claim-released（fail-closed，AC#6）。
 */
export function evaluateAuthorityRevocation(input: EvaluateAuthorityRevocationInput): AuthorityRevocationDecision {
  const { lease } = input;
  if (!lease) return { kind: 'no_active_claim' };
  const status = inspectTaskClaim(lease, input.now);
  if (status.kind === 'active') {
    return { kind: 'revoked', lease: { ...lease, releasedAt: input.now }, cause: input.cause, detail: input.detail };
  }
  if (status.kind === 'unclaimed') {
    return { kind: 'no_active_claim' };
  }
  // released / expired / invalid
  return { kind: 'already_terminal', lease, status: status.kind };
}

// ── AC#2：Manifest 用于新承诺的有效性门禁 ──

export interface EvaluateManifestUsabilityInput {
  readonly status: AgentExposureManifestStatus;
  readonly validUntil: number | null;
  readonly now: number;
}

export type ManifestCommitmentUsability =
  | { readonly usable: true }
  | { readonly usable: false; readonly reason: ManifestCommitmentUsabilityReason };

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * AC#2：判定 Manifest 能否用于发布新 Task 或新 Offer。
 * 仅 active 且 validUntil 未过期（>now）→ 可用；draft/superseded/expired/revoked，或 active
 * 但 validUntil<=now → 不可用（reason 对应状态）。validUntil 非 safe int → fail-closed 不可用。
 * 边界 `validUntil<=now → expired` 对齐 evaluatePublishWindow（agent-exposure-policy.ts）。
 */
export function evaluateManifestUsabilityForCommitment(
  input: EvaluateManifestUsabilityInput,
): ManifestCommitmentUsability {
  if (input.status !== 'active') {
    return { usable: false, reason: input.status };
  }
  if (input.validUntil === null) return { usable: true };
  if (!isSafeNonNegativeInteger(input.validUntil) || input.validUntil <= input.now) {
    return { usable: false, reason: 'expired' };
  }
  return { usable: true };
}
