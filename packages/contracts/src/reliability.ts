import type { ID, UnixMs } from './common.js';

/**
 * #714 Team-local reliability 与 operation restriction 契约。
 *
 * 产品边界（ADR 0026、计划 §4「候选排序」、issue #714）：
 * PI 可以根据当前 Team 内**可观测且已确认归因**的履约事实形成 reliability signal，
 * 仅用于合格候选之间的排序与风险提示。PI 的主观评价、未经审核的结果或其他 Team 的
 * 历史不能直接成为当前 Team 的负面事实（AC#1/AC#2）。
 *
 * 安全合同（AC#3）：reliability 永远不能补齐 required Capability/Skill，也不能删除
 * Agent Exposure Manifest 中的 Skill——公开声明仍由 Agent owner 控制。本组 DTO 只描述
 * 「已在公开 operation 上观测到的已确认归因结果」与「Team Owner/Admin 对已暴露 operation
 * 的收紧」，绝不携带 capability/skill 的新增语义。reliability 的唯一消费者是候选排序
 * tie-breaker（domain `rankQualifiedCandidates`），结构性不进入 capability/skill 集合。
 *
 * 安全合同（AC#6）：reliability 全量信号与 restriction 事实依据只对 Agent owner /
 * Team Owner/Admin 可见；普通成员只看到「理解当前 Task 匹配所需」的裁剪视图，看不到全量
 * reliability、其他 Team 信息或被纠错争议中的依据细节。
 *
 * 与 #710 Exposure 的关系：restriction（禁用已暴露 operation）由 #710 `evaluateRestriction`
 * fail-closed 保证「只能禁用已公开、不能新增」；#714 在其上叠加「事实依据 + 纠错入口 +
 * 成员可见性裁剪」，不改变 restriction 的收紧语义。
 */

// ── AC#1：可观测且已确认归因的履约结果（closed union） ──

/**
 * 已确认归因的履约 outcome（AC#1）。只有这五种形成 reliability 事实：
 * - 正向：`accepted`（明确接受 Offer）/ `completed`（交付验收通过）/ `manual_verified`（人工验收通过）。
 * - 负向：`timed_out`（超时未交付）/ `relinquished`（主动放弃 claim）。
 *
 * 刻意**不**包含：模型主观评价、未审核交付、self-reported 成功、其他 Team 的历史——
 * 这些没有合法的 outcome 值，无法构造为 ReliabilityAttributionFactDto（AC#2 结构性保证）。
 */
export const RELIABILITY_OUTCOME_KINDS = [
  'accepted',
  'completed',
  'manual_verified',
  'timed_out',
  'relinquished',
] as const;
export type ReliabilityOutcomeKind = (typeof RELIABILITY_OUTCOME_KINDS)[number];

/** 正向 outcome（提升可靠性置信度）。 */
export const POSITIVE_RELIABILITY_OUTCOMES: readonly ReliabilityOutcomeKind[] = [
  'accepted',
  'completed',
  'manual_verified',
];
/** 负向 outcome（形成当前 Team 负面事实，唯一能降低 reliability score 的来源）。 */
export const NEGATIVE_RELIABILITY_OUTCOMES: readonly ReliabilityOutcomeKind[] = [
  'timed_out',
  'relinquished',
];

/** reliability 事实的来源事实类型（可审计引用，不含主观评价正文）。 */
export type ReliabilityFactSourceKind =
  | 'offer' // Task Offer 响应（accepted/rejected）
  | 'acceptance' // 子任务验收决定（accepted/rejected/needs_human）
  | 'invocation' // Agent Invocation 终态（succeeded/failed/timed_out/cancelled）
  | 'task' // Task 状态终态（done/closed）
  | 'claim'; // Task claim lease 终态（released/relinquished/expired）

export interface ReliabilityFactSourceRefDto {
  readonly kind: ReliabilityFactSourceKind;
  readonly id: ID;
}

/**
 * AC#1/AC#2：一条已确认归因的履约事实。
 * `teamId` 锁定当前 Team（跨 Team 事实由 domain 过滤丢弃）；`operationKey` 是该事实归因到的
 * 公开 operation（capability 名或 skill 名，调用方负责 lowercase 规范化）。
 */
export interface ReliabilityAttributionFactDto {
  readonly teamId: ID;
  readonly agentId: ID;
  readonly operationKey: string;
  readonly outcome: ReliabilityOutcomeKind;
  readonly sourceRef: ReliabilityFactSourceRefDto;
  readonly confirmedAt: UnixMs;
}

// ── AC#3：reliability signal（排序 + 风险提示，无供给改写能力） ──

/**
 * reliability 风险提示码（canonical，server 投影/审计共享，消除字符串漂移）。
 * 与 domain `ReliabilityRiskHint` 同义；这里仅含可投影给 owner/admin 视图的稳定码。
 */
export const RELIABILITY_RISK_HINT = {
  HIGH_TIMEOUT_RATE: 'RELIABILITY_RISK_HIGH_TIMEOUT_RATE',
  HIGH_RELINQUISH_RATE: 'RELIABILITY_RISK_HIGH_RELINQUISH_RATE',
  LOW_SAMPLE: 'RELIABILITY_RISK_LOW_SAMPLE',
} as const;
export type ReliabilityRiskHintCode =
  (typeof RELIABILITY_RISK_HINT)[keyof typeof RELIABILITY_RISK_HINT];

/**
 * 单个 operation 的可靠性条目。
 * `score` ∈ [0,1]，越高越可靠。**无任何已确认事实时由 domain 返回 neutral（1.0）**——
 * 即「无数据」永不形成负面事实（AC#2），reliability 只能凭已确认负向 outcome 降分。
 */
export interface OperationReliabilityEntryDto {
  readonly operationKey: string;
  readonly score: number;
  readonly accepted: number;
  readonly completed: number;
  readonly manualVerified: number;
  readonly timedOut: number;
  readonly relinquished: number;
  readonly total: number;
  readonly riskHints: readonly ReliabilityRiskHintCode[];
}

/**
 * 单 Agent 在当前 Team 的 reliability signal（owner/admin 可见全量；成员经裁剪）。
 * `overallScore` 是跨 operation 的样本加权汇总，用作跨 Agent 排序 tie-breaker 输入。
 * 无任何事实时整体 neutral（1.0）。
 */
export interface ReliabilitySignalDto {
  readonly teamId: ID;
  readonly agentId: ID;
  readonly overallScore: number;
  readonly perOperation: readonly OperationReliabilityEntryDto[];
}

// ── AC#6：可见性级别（owner/admin 全量 vs 成员裁剪） ──

/**
 * reliability / restriction 视图的可见性级别（AC#6）。
 * - `owner`：Agent owner / Team Owner/Admin——看全量 signal、restriction 事实依据与纠错记录。
 * - `member`：普通成员——只看「理解当前 Task 匹配所需」的裁剪视图，不看全量 reliability、
 *   其他 operation 的依据或纠错争议细节。
 */
export type ReliabilityVisibilityLevel = 'owner' | 'member';

/**
 * AC#6 成员可见的裁剪 reliability 条目：仅保留与当前 Task 匹配相关的 operation，
 * 且只暴露「是否影响本次匹配」的简短理由码，不含全量计数与纠错上下文。
 */
export interface MemberVisibleReliabilityEntryDto {
  readonly operationKey: string;
  /** 是否因已确认负向事实而降低本次匹配排序（true=有风险提示，影响排序）。 */
  readonly affectsRanking: boolean;
  readonly riskHint: ReliabilityRiskHintCode | null;
}

export interface MemberVisibleReliabilityDto {
  readonly agentId: ID;
  readonly entries: readonly MemberVisibleReliabilityEntryDto[];
}

/**
 * AC#6 成员可见的 restriction 裁剪视图：只暴露「哪些公开 operation 被禁用」+「是否有事实依据」，
 * 刻意**不**含 factualBasis 正文/引用、纠错记录、updatedBy/manifestId 等审计细节——这些只对
 * Agent owner / Team Owner/Admin 可见。普通成员只需知道某 operation 在本 Team 不可用来理解
 * 当前 Task 匹配，不需看到依据或争议过程。
 */
export interface MemberVisibleRestrictionDto {
  readonly teamId: ID;
  readonly agentId: ID;
  readonly disabledCapabilities: readonly string[];
  readonly disabledSkills: readonly string[];
  readonly hasFactualBasis: boolean;
}

// ── AC#5：restriction 事实依据 + 错误归因纠正入口 ──

/**
 * AC#5：restriction 的单条事实依据。Team Owner/Admin 禁用某 operation 时，必须附带你所依据的
 * 已确认归因事实引用（指向当前 Team 的 ReliabilityAttributionFactDto）。该依据对 Agent owner
 * 可见，并提供纠错入口（Agent owner 可对错误归因提出争议）。
 */
export interface RestrictionFactualBasisEntryDto {
  readonly operationKey: string;
  /** 依据所引用的已确认事实来源（当前 Team 内）。空 = 无事实依据的禁用（domain fail-closed 拒绝）。 */
  readonly citedFactRefs: readonly ReliabilityFactSourceRefDto[];
  /** 人类可读简述（为何禁用），对 Agent owner 可见。 */
  readonly summary: string;
}

/**
 * AC#4/AC#5：带事实依据的 Team restriction（#710 restriction + #714 依据 + 纠错引用）。
 * 仍是「只能禁用 active manifest 已暴露 operation」（#710 `evaluateRestriction` fail-closed）；
 * #714 额外要求依据可审计、可纠错。
 */
export interface AgentExposureRestrictionWithBasisDto {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly manifestId: ID;
  readonly disabledCapabilities: readonly string[];
  readonly disabledSkills: readonly string[];
  readonly factualBasis: readonly RestrictionFactualBasisEntryDto[];
  readonly updatedBy: ID;
  readonly updatedAt: UnixMs;
}

/** 归因纠错请求状态（AC#5）。pending=已提出待审；acknowledged=owner/admin 已确认纠错（事实降权）；rejected=纠错被驳回。 */
export type AttributionCorrectionStatus = 'pending' | 'acknowledged' | 'rejected';

/**
 * AC#5 纠正决定码（canonical，server 投影/审计共享）。
 * 与 domain `AttributionCorrectionDecision` 同义。
 */
export const ATTRIBUTION_CORRECTION_REASON_CODE = {
  RECORDED_PENDING: 'ATTRIBUTION_CORRECTION_RECORDED_PENDING',
  FACT_DOWNWEIGHTED: 'ATTRIBUTION_CORRECTION_FACT_DOWNWEIGHTED',
  REJECTED: 'ATTRIBUTION_CORRECTION_REJECTED',
  INVALID_FACT_REF: 'ATTRIBUTION_CORRECTION_INVALID_FACT_REF',
  INVALID_REASON: 'ATTRIBUTION_CORRECTION_INVALID_REASON',
  NOT_AGENT_OWNER: 'ATTRIBUTION_CORRECTION_NOT_AGENT_OWNER',
  NOT_AUTHORIZED_TO_RESOLVE: 'ATTRIBUTION_CORRECTION_NOT_AUTHORIZED_TO_RESOLVE',
} as const;
export type AttributionCorrectionReasonCode =
  (typeof ATTRIBUTION_CORRECTION_REASON_CODE)[keyof typeof ATTRIBUTION_CORRECTION_REASON_CODE];

/**
 * AC#5：Agent owner 对某条已确认归因事实提出错误归因纠正。
 * 纠错**不**自动删除事实（保留审计链）；domain `evaluateAttributionCorrection` 产出 pending
 * 记录，由 owner/admin 审阅后 acknowledged（该事实在后续 reliability 计算中降权）或 rejected。
 */
export interface SubmitAttributionCorrectionInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly factRef: ReliabilityFactSourceRefDto;
  readonly reason: string;
}

export interface AttributionCorrectionRecordDto {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly factRef: ReliabilityFactSourceRefDto;
  readonly reason: string;
  readonly status: AttributionCorrectionStatus;
  readonly submittedBy: ID;
  readonly submittedAt: UnixMs;
  readonly reviewedAt: UnixMs | null;
}
