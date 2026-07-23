/**
 * #714 operation restriction 事实依据 + 错误归因纠正 + 成员可见性纯规则（切片核心）。
 *
 * 职责：在 #710 `evaluateRestriction`（fail-closed「只能禁用已暴露 operation」）之上，叠加
 * AC#5（restriction 事实依据对 Agent owner 可见 + 错误归因纠正入口）与 AC#6（普通成员只看
 * 当前 Task 匹配所需理由，不看全量依据/纠错/其他 Team 信息）。无 server 依赖、无 IO，可单测。
 *
 * 关键不变量（与 contracts `reliability.ts` 注释一致）：
 * - AC#4：restriction 仍由 #710 `evaluateRestriction` 保证「只能禁用 active manifest 已暴露
 *   operation，不能新增 Capability/Skill 或改 Manifest」。本模块不改写该收紧语义。
 * - AC#5：事实依据必须扎根**当前 Team 已确认归因事实**——引用捏造/不存在的事实 fail-closed。
 *   错误归因纠错入口允许 Agent owner 标记误判；acknowledged 的事实在 reliability 计算中降权
 *   （见 reliability-policy `excludedFactRefs`），但**不自动删除**（保留审计链）。
 * - AC#6：成员视图裁剪掉 factualBasis、纠错记录与审计字段；只留「哪些 operation 被禁用」+
 *   「是否有依据」。
 */
import type {
  AgentExposureRestrictionWithBasisDto,
  AttributionCorrectionReasonCode,
  MemberVisibleRestrictionDto,
  ReliabilityAttributionFactDto,
  ReliabilityFactSourceRefDto,
  RestrictionFactualBasisEntryDto,
} from '@agentbean/contracts';
import { reliabilityFactRefKey } from './reliability-policy.js';

export const OPERATION_RESTRICTION_ERROR = {
  BASIS_CITES_UNKNOWN_FACT: 'OPERATION_RESTRICTION_BASIS_CITES_UNKNOWN_FACT',
  BASIS_CITES_MISALIGNED_FACT: 'OPERATION_RESTRICTION_BASIS_CITES_MISALIGNED_FACT',
} as const;

// ── AC#5：restriction 事实依据扎根校验 ──

export interface EvaluateRestrictionFactualBasisInput {
  /** 本次 restriction 拟禁用的 operation 名（capability/skill，lowercase；调用方已用 #710 evaluateRestriction 校验过「已暴露」）。 */
  readonly disabledOperations: readonly string[];
  readonly basis: readonly RestrictionFactualBasisEntryDto[];
  /** 当前 Team+Agent 的已确认归因事实（调用方已按 team/agent 过滤）。basis 引用必须在此解析。 */
  readonly confirmedFacts: readonly ReliabilityAttributionFactDto[];
}

export type EvaluateRestrictionFactualBasisResult =
  | {
      readonly ok: true;
      readonly validatedBasis: readonly RestrictionFactualBasisEntryDto[];
      /** 被禁用但无任何依据条目的 operation（governance 决定是否接受无依据禁用）。 */
      readonly hasUnbasedDisabledOperations: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code:
        | typeof OPERATION_RESTRICTION_ERROR.BASIS_CITES_UNKNOWN_FACT
        | typeof OPERATION_RESTRICTION_ERROR.BASIS_CITES_MISALIGNED_FACT;
      readonly message: string;
    };

/**
 * AC#5：校验 restriction 事实依据只引用当前 Team 真实已确认归因事实，且**归因到同一 operation**。
 * - basis 中任何 citedFactRef 无法在 confirmedFacts 中解析 → fail-closed（BASIS_CITES_UNKNOWN_FACT：
 *   禁止捏造/引用未审核/跨 Team 的事实作为禁用依据）。
 * - citedFactRef 解析到的事实其 operationKey 与 basis 条目的 operationKey 不一致 → fail-closed
 *   （BASIS_CITES_MISALIGNED_FACT：禁用 operation X 的依据必须是 X 的已确认归因，不能挪用其他
 *   operation 的事实——否则依据与禁用对象不对应，破坏 AC#5「依据可审计且对应」）。
 * 去重保序返回 validatedBasis。
 *
 * 不强制「每个禁用必须有依据」——是否接受无依据禁用由 governance 决定；但**有依据就必须真实且对齐**。
 */
export function evaluateRestrictionFactualBasis(
  input: EvaluateRestrictionFactualBasisInput,
): EvaluateRestrictionFactualBasisResult {
  // ref-key → 该已确认事实归因到的 operationKey（lowercase）。
  const refToOp = new Map(
    input.confirmedFacts.map((f) => [reliabilityFactRefKey(f.sourceRef), String(f.operationKey).toLowerCase()]),
  );

  const validated: RestrictionFactualBasisEntryDto[] = [];
  for (const entry of input.basis) {
    const entryOp = String(entry.operationKey).toLowerCase();
    const seenInEntry = new Set<string>();
    const dedupedRefs: ReliabilityFactSourceRefDto[] = [];
    for (const ref of entry.citedFactRefs) {
      const key = reliabilityFactRefKey(ref);
      const op = refToOp.get(key);
      if (op === undefined) {
        return {
          ok: false,
          code: OPERATION_RESTRICTION_ERROR.BASIS_CITES_UNKNOWN_FACT,
          message: `Restriction basis cites unknown fact: ${ref.kind}::${ref.id}`,
        };
      }
      if (op !== entryOp) {
        return {
          ok: false,
          code: OPERATION_RESTRICTION_ERROR.BASIS_CITES_MISALIGNED_FACT,
          message: `Restriction basis for operation "${entry.operationKey}" cites a fact attributed to "${op}"`,
        };
      }
      if (!seenInEntry.has(key)) {
        seenInEntry.add(key);
        dedupedRefs.push(ref);
      }
    }
    validated.push({ ...entry, citedFactRefs: dedupedRefs });
  }

  const basedOps = new Set(input.basis.map((b) => String(b.operationKey).toLowerCase()));
  const hasUnbasedDisabledOperations = input.disabledOperations
    .map((o) => String(o).toLowerCase())
    .filter((op) => !basedOps.has(op));

  return { ok: true, validatedBasis: validated, hasUnbasedDisabledOperations };
}

// ── AC#5：错误归因纠正入口（Agent owner 提交） ──

export interface EvaluateAttributionCorrectionInput {
  /** 调用方解析的 Agent owner 链路授权（canManageAgent）。fail-closed：非拥有者 → false。 */
  readonly isAgentOwner: boolean;
  readonly factRef: ReliabilityFactSourceRefDto;
  /** 当前 Team+Agent 的已确认事实引用集合（验证 factRef 真实存在）。 */
  readonly confirmedFactRefs: readonly ReliabilityFactSourceRefDto[];
  readonly reason: string;
}

export type AttributionCorrectionDecision =
  | { readonly kind: 'recorded'; readonly status: 'pending'; readonly reasonCode: AttributionCorrectionReasonCode }
  | { readonly kind: 'rejected'; readonly reasonCode: AttributionCorrectionReasonCode };

/**
 * AC#5：Agent owner 对某条已确认归因事实提出错误归因纠正。
 * - 非 Agent owner → rejected（NOT_AGENT_OWNER）。
 * - factRef 不在当前 Team 已确认事实中 → rejected（INVALID_FACT_REF）：不能对不存在的事实纠错。
 * - reason 空白 → rejected（INVALID_REASON）：纠错必须说明理由，可审计。
 * - 否则 → recorded pending。**不自动删除事实**；由 owner/admin 审阅后 acknowledge（降权）或 reject。
 */
export function evaluateAttributionCorrection(
  input: EvaluateAttributionCorrectionInput,
): AttributionCorrectionDecision {
  if (!input.isAgentOwner) {
    return { kind: 'rejected', reasonCode: 'ATTRIBUTION_CORRECTION_NOT_AGENT_OWNER' };
  }
  const known = new Set(input.confirmedFactRefs.map(reliabilityFactRefKey));
  if (!known.has(reliabilityFactRefKey(input.factRef))) {
    return { kind: 'rejected', reasonCode: 'ATTRIBUTION_CORRECTION_INVALID_FACT_REF' };
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return { kind: 'rejected', reasonCode: 'ATTRIBUTION_CORRECTION_INVALID_REASON' };
  }
  return { kind: 'recorded', status: 'pending', reasonCode: 'ATTRIBUTION_CORRECTION_RECORDED_PENDING' };
}

// ── AC#5：owner/admin 审阅纠错（acknowledge = 降权 / reject = 驳回） ──

export interface ResolveAttributionCorrectionInput {
  /** Team Owner/Admin 可审阅（governance 层）。fail-closed：非 owner/admin → false。 */
  readonly isTeamOwnerOrAdmin: boolean;
  readonly decision: 'acknowledge' | 'reject';
  readonly factRef: ReliabilityFactSourceRefDto;
}

export type AttributionCorrectionResolution =
  | {
      readonly kind: 'acknowledged';
      readonly reasonCode: AttributionCorrectionReasonCode;
      /** 供 reliability-policy `excludedFactRefs` 消费，将该事实排除出后续计算（降权，不删除）。 */
      readonly downweightedFactRef: ReliabilityFactSourceRefDto;
    }
  | { readonly kind: 'rejected_decision'; readonly reasonCode: AttributionCorrectionReasonCode }
  | { readonly kind: 'denied'; readonly reasonCode: AttributionCorrectionReasonCode };

/**
 * AC#5：Team Owner/Admin 审阅一条 pending 纠错。
 * - 非 owner/admin → denied（NOT_AUTHORIZED_TO_RESOLVE）。
 * - acknowledge → acknowledged：产出 downweightedFactRef，调用方据此构造 reliability 计算的
 *   excludedFactRefs（事实降权，不删除，审计链保留）。
 * - reject → rejected_decision：事实保留，纠错被驳回。
 */
export function resolveAttributionCorrection(
  input: ResolveAttributionCorrectionInput,
): AttributionCorrectionResolution {
  if (!input.isTeamOwnerOrAdmin) {
    return { kind: 'denied', reasonCode: 'ATTRIBUTION_CORRECTION_NOT_AUTHORIZED_TO_RESOLVE' };
  }
  if (input.decision === 'acknowledge') {
    return {
      kind: 'acknowledged',
      reasonCode: 'ATTRIBUTION_CORRECTION_FACT_DOWNWEIGHTED',
      downweightedFactRef: input.factRef,
    };
  }
  return { kind: 'rejected_decision', reasonCode: 'ATTRIBUTION_CORRECTION_REJECTED' };
}

// ── AC#6：restriction 成员可见性裁剪 ──

/**
 * AC#6：把 owner/admin 全量 restriction（含事实依据）裁剪为普通成员可见视图。
 * 成员只看到「哪些公开 operation 被禁用」+「是否有事实依据」；factualBasis 正文/引用、纠错记录、
 * updatedBy/manifestId 等审计细节一律剥离（防止依据细节与争议过程泄漏给普通成员）。
 */
export function redactRestrictionForMemberView(
  restriction: AgentExposureRestrictionWithBasisDto,
): MemberVisibleRestrictionDto {
  return {
    teamId: restriction.teamId,
    agentId: restriction.agentId,
    disabledCapabilities: restriction.disabledCapabilities,
    disabledSkills: restriction.disabledSkills,
    hasFactualBasis: restriction.factualBasis.length > 0,
  };
}
