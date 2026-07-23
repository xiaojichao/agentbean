/**
 * #712 Task Offer 四类响应与显式接受 —— 纯规则（切片 C 核心）。
 *
 * 职责：把 PI → Agent 的结构化 Task Offer 与 Agent 的四类显式响应
 * (accepted / rejected / needs_info / counter_proposed) 收敛为可单测的纯决策，取代旧
 * 「Device 收到 Offer 即 canAcceptOffer: () => true 并立即 acquire」的隐式接受（AC#7）。
 *
 * 关键不变量（与 contracts `agent-exposure.ts` TaskOfferDto 注释一致）：
 * - AC#3：Offer 到达 / ACK 只表示「可响应」。本模块唯一能产出 Lease 的入口是
 *   `evaluateOfferAcceptance`，且它仅在被显式 accepted 调用时运行；ACK 与 decline 路径
 *   永不产出 Lease、永不把 status 推进到 accepted。
 * - AC#4：accepted → Claim 在同一决策内成立（newStatus='accepted' 与 lease 同生）。
 *   服务端在同事务提交二者；事务失败两者皆不落库（接线见切片 C 后续）。
 * - AC#5：rejected / needs_info / counter_proposed / expired / invalidated / overtaken
 *   均不产 Lease（producesLease=false / kind!=='claim_granted'）。
 * - AC#6：并发接受同一开放 Offer 时只有一个 Agent 获得有效 Claim，fencing token 单调——
 *   本模块直接委托既有 `evaluateTaskClaimAcquire`（initial=1，重开=+1，active-claim-held
 *   → overtaken），不另造租约逻辑（计划 §4「保留既有原子 Claim/Lease 实现」）。
 * - AC#8：显式 @Agent（hardSpecified）只决定服务端优先询问谁，不进入本模块任何决策——
 *   被点名 Agent 仍需显式 accepted 才产 Claim，仍可 rejected。
 *
 * 无 server 依赖、无 IO。调用方（切片 C 后续的 broker/service）负责持久化与事务。
 */
import type { TaskOfferStatus } from '@agentbean/contracts';
import {
  evaluateTaskClaimAcquire,
  type TaskClaimAcquireInput,
  type TaskClaimAcquireRejection,
  type TaskClaimLeaseRecord,
} from './task-claim-policy.js';
import type { AgentEligibilityState } from './agent-eligibility.js';

// ── AC#1/AC#5：Offer 当前是否仍可被有效接受 ──

export type OfferInvalidationReason =
  | 'expired' // 超过 offerExpiresAt 未被有效接受
  | 'task_revision_changed' // task 已产生新 revision（#709 append-only），旧 Offer fence 失效
  | 'manifest_superseded' // agent active Exposure Manifest 被新 revision 取代（#710）
  | 'not_open'; // 已是终态（accepted/rejected/...），ACK 不复活

export interface EvaluateOfferValidityInput {
  readonly status: TaskOfferStatus;
  readonly offerExpiresAt: number;
  /** 发布时冻结的 Task revision（fence）。 */
  readonly offerTaskRevision: number;
  /** 发布时冻结的 Agent active Manifest revision（fence）。 */
  readonly offerManifestRevision: number;
  readonly now: number;
  /** Task 当前 revision（#709 可因重大变更递增）。 */
  readonly currentTaskRevision: number;
  /** Agent 当前 active Manifest revision（#710 supersede 后递增）。 */
  readonly currentManifestRevision: number;
}

export type OfferValidity =
  | { readonly acceptable: true }
  | { readonly acceptable: false; readonly reason: OfferInvalidationReason };

/**
 * AC#1/AC#5：判定 Offer 是否仍可被有效接受。
 * 检查顺序：终态 → 过期 → task revision fence → manifest revision fence。
 * 任一不满足 → 不可接受（accept/decline 路径据此拒绝，不产 Lease）。
 */
export function evaluateOfferValidity(input: EvaluateOfferValidityInput): OfferValidity {
  if (input.status !== 'open') return { acceptable: false, reason: 'not_open' };
  if (input.now >= input.offerExpiresAt) return { acceptable: false, reason: 'expired' };
  if (input.offerTaskRevision !== input.currentTaskRevision) {
    return { acceptable: false, reason: 'task_revision_changed' };
  }
  if (input.offerManifestRevision !== input.currentManifestRevision) {
    return { acceptable: false, reason: 'manifest_superseded' };
  }
  return { acceptable: true };
}

// ── AC#2/AC#4/AC#5/AC#6：accepted 响应 → 是否产出 Claim ──

export interface EvaluateOfferAcceptanceInput {
  /**
   * AC#4 守卫：接受者必须 qualified（来自 `evaluateAgentEligibility`）。
   * not_qualified / unknown 均不接受（unknown 不能凭「未知」获得 Claim）。
   */
  readonly eligibility: { readonly state: AgentEligibilityState };
  readonly validity: OfferValidity;
  /**
   * 委托既有原子 Claim 逻辑。`current` 携带该 task/attempt 的既有 lease：
   * - 无 current / current 已过期或释放 → granted，fencing 单调递增（AC#6）。
   * - current 仍 active 且属他 Agent → active-claim-held → overtaken（AC#6 败者）。
   */
  readonly acquire: TaskClaimAcquireInput;
}

export type OfferAcceptanceDecision =
  | { readonly kind: 'claim_granted'; readonly newStatus: 'accepted'; readonly lease: TaskClaimLeaseRecord }
  | { readonly kind: 'overtaken'; readonly reason: 'active_claim_held' }
  | {
      readonly kind: 'not_accepted';
      readonly reason: 'offer_invalid' | 'agent_not_qualified' | 'claim_rejected';
      readonly acquireRejection?: TaskClaimAcquireRejection;
    };

/**
 * AC#2 accepted / AC#4 原子 / AC#5 / AC#6：处理 accepted 响应。
 * 只有「Offer 仍有效 + Agent qualified + 既有 Claim 策略放行」三者同时成立才产出 Claim；
 * 否则落入 overtaken（并发败者）或 not_accepted（不产 Lease）。
 */
export function evaluateOfferAcceptance(input: EvaluateOfferAcceptanceInput): OfferAcceptanceDecision {
  if (!input.validity.acceptable) return { kind: 'not_accepted', reason: 'offer_invalid' };
  if (input.eligibility.state !== 'qualified') return { kind: 'not_accepted', reason: 'agent_not_qualified' };

  const decision = evaluateTaskClaimAcquire(input.acquire);
  if (decision.kind === 'granted' || decision.kind === 'existing') {
    return { kind: 'claim_granted', newStatus: 'accepted', lease: decision.lease };
  }
  // decision.kind === 'rejected'
  if (decision.reason === 'active-claim-held') {
    return { kind: 'overtaken', reason: 'active_claim_held' };
  }
  return { kind: 'not_accepted', reason: 'claim_rejected', acquireRejection: decision.reason };
}

// ── AC#2/AC#5：rejected / needs_info / counter_proposed —— 均不产 Lease ──

export interface EvaluateOfferDeclineInput {
  readonly kind: 'rejected' | 'needs_info' | 'counter_proposed';
  readonly validity: OfferValidity;
}

export type OfferDeclineDecision =
  | {
      readonly kind: 'response_recorded';
      readonly newStatus: 'rejected' | 'needs_info' | 'counter_proposed';
      readonly producesLease: false;
    }
  | { readonly kind: 'not_accepted'; readonly reason: 'offer_invalid' };

/**
 * AC#2/AC#5：处理三类非 accepted 响应。有效 Offer 上的响应被记录为对应终态，永不产 Lease。
 * 对已失效 Offer 的响应不落终态（避免用迟到的 reject 覆盖 expired/invalidated）。
 */
export function evaluateOfferDecline(input: EvaluateOfferDeclineInput): OfferDeclineDecision {
  if (!input.validity.acceptable) return { kind: 'not_accepted', reason: 'offer_invalid' };
  return { kind: 'response_recorded', newStatus: input.kind, producesLease: false };
}

// ── AC#3：Offer 状态机完整性（ACK 永不产生状态转移 / Claim） ──

/**
 * AC#3：校验 Offer 状态转移合法性。
 * - from === to：幂等重放（含 open→open＝ACK 无操作）合法。
 * - open → 任意他态（响应/失效）合法：ACK 不会把 Offer 推进到 accepted 或任何终态。
 * - 其余（终态 → 他态）：非法，终态不复活。
 *
 * 唯一能把 Offer 变为 accepted 的是 `evaluateOfferAcceptance` 的 claim_granted 决策，
 * 而非 ACK——这从状态机层面保证「ACK ≠ Claim」（AC#3）。
 *
 * 末行对当前联合里的全部终态返回 false；对未来新增的任何非 open 状态也 fail-closed
 * 返回 false，强制作者显式声明其转移，而非静默放行（状态机安全默认）。
 */
export function isValidOfferStatusTransition(from: TaskOfferStatus, to: TaskOfferStatus): boolean {
  if (from === to) return true;
  if (from === 'open') return true; // open → 任意他态（响应/失效）合法
  return false; // 终态 → 他态非法；未知非 open 状态 fail-closed
}

// ── AC#1（#713）：revision 变化使「所有」未接受旧 Offer 失效（批量聚合）──

/**
 * selectInvalidatableOpenOffers 的窄视图：仅需 fence 判定字段，刻意不耦合完整 TaskOfferDto，
 * 让 domain 决策与持久化形状解耦（接入层投影成此视图后调用）。
 */
export interface InvalidatableOfferView {
  readonly id: string;
  readonly status: TaskOfferStatus;
  readonly offerExpiresAt: number;
  readonly offerTaskRevision: number;
  readonly offerManifestRevision: number;
}

export interface SelectInvalidatableOpenOffersInput {
  readonly offers: readonly InvalidatableOfferView[];
  readonly currentTaskRevision: number;
  readonly currentManifestRevision: number;
  readonly now: number;
}

export interface InvalidatableOffer {
  readonly id: string;
  readonly reason: OfferInvalidationReason;
}

/**
 * AC#1：当 task 产生新 revision（#709）或 agent active manifest 被新 revision 取代（#710）时，
 * 选出所有「仍 open 但因 revision/过期变得不可接受」的 Offer——接线层据此原子翻转 invalidated。
 * 终态 Offer（accepted/rejected/...）排除；纯 map+filter，复用 evaluateOfferValidity 单点判定，
 * 无新逻辑。返回集合即接线层必须移动的 Offer，避免手写循环导致两个 Offer 以不同原因翻转。
 */
export function selectInvalidatableOpenOffers(
  input: SelectInvalidatableOpenOffersInput,
): readonly InvalidatableOffer[] {
  const result: InvalidatableOffer[] = [];
  for (const offer of input.offers) {
    if (offer.status !== 'open') continue; // 终态不再处理
    const validity = evaluateOfferValidity({
      status: offer.status,
      offerExpiresAt: offer.offerExpiresAt,
      offerTaskRevision: offer.offerTaskRevision,
      offerManifestRevision: offer.offerManifestRevision,
      now: input.now,
      currentTaskRevision: input.currentTaskRevision,
      currentManifestRevision: input.currentManifestRevision,
    });
    if (!validity.acceptable) {
      result.push({ id: offer.id, reason: validity.reason });
    }
  }
  return result;
}

// ── AC#5（#715）：定向 vs 开放 Offer 分配策略（混合 Task allocation） ──

export interface OfferAllocationPolicyInput {
  /**
   * 显式 @Agent（hard target）。调用方需已确认 `resolveHardSpecifiedTarget === 'eligible'`
   * （同 evaluateOfferAcceptance 信任 eligibility.state 的信任模型）。存在时直接定向。
   */
  readonly hardSpecifiedAgentId?: string;
  /** 经 eligibility 过滤 + rankQualifiedCandidates 排序后的合格候选 agent id 列表（降序）。 */
  readonly rankedQualifiedAgentIds: readonly string[];
  /**
   * 排名前两位的候选排序键元组是否全等（"候选相近"）。domain 无法客观测量排序距离，
   * 由调用方比较 rankQualifiedCandidates 的 top-2 键得出。
   */
  readonly topCandidatesTied: boolean;
  /** 负载数据陈旧或缺失（"负载不确定"）。调用方标记。 */
  readonly loadUncertain: boolean;
}

export type OfferAllocationPolicyDecision =
  | { readonly kind: 'targeted'; readonly targetAgentId: string }
  | { readonly kind: 'open' }
  | { readonly kind: 'not_decidable'; readonly reason: 'no_qualified_candidate' };

/**
 * AC#5：为单个节点选择定向 Offer（显式 @Agent / 单一明确候选）或开放 Offer
 * （候选相近 / 负载不确定）。依 ADR 0002 混合分配语义。
 *
 * 决策顺序：
 * 1. hardSpecifiedAgentId 存在 → targeted（AC#5「@Agent → 定向」，最高优先；调用方保证 eligible）。
 * 2. 无合格候选 → not_decidable（交上游 evaluateTaskDecomposability 升级用户调整）。
 * 3. 单一合格候选 → targeted（ADR 0002「候选明确的简单任务定向指派」）。
 * 4. 多候选且（topCandidatesTied || loadUncertain）→ open（AC#5「候选相近/负载不确定 → 开放」）。
 * 5. 多候选且有明显赢家 → targeted（排名第一）。
 *
 * 调用方映射：targeted → TaskCoordinationDto.claimPolicy='targeted' + targetAgentId；
 * open → claimPolicy='open'；not_decidable → 不发布 Offer，升级 AC#4。
 */
export function decideOfferAllocationPolicy(input: OfferAllocationPolicyInput): OfferAllocationPolicyDecision {
  const hardSpecifiedAgentId = input.hardSpecifiedAgentId;
  if (hardSpecifiedAgentId !== undefined && hardSpecifiedAgentId.length > 0) {
    return { kind: 'targeted', targetAgentId: hardSpecifiedAgentId };
  }
  const ranked = input.rankedQualifiedAgentIds;
  if (ranked.length === 0) {
    return { kind: 'not_decidable', reason: 'no_qualified_candidate' };
  }
  const topCandidate = ranked[0];
  if (topCandidate === undefined) {
    return { kind: 'not_decidable', reason: 'no_qualified_candidate' };
  }
  if (ranked.length === 1) {
    return { kind: 'targeted', targetAgentId: topCandidate };
  }
  // ranked.length >= 2
  if (input.topCandidatesTied || input.loadUncertain) {
    return { kind: 'open' };
  }
  return { kind: 'targeted', targetAgentId: topCandidate };
}
