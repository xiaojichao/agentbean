import type { ID, UnixMs } from './common.js';
import type { ChannelCoordinationRiskLevel } from './pi-coordination.js';

/**
 * #710 Team Agent Exposure Manifest。
 *
 * Agent owner 按 Team 发布的不可变公开契约：Capabilities、Skills、约束、可用状态、
 * 版本与有效期。PI 与普通成员只读消费当前 Team 的 active 投影；Team Owner/Admin
 * 只能收紧（禁用已公开 operation），不能新增 Capability/Skill 或查看隐藏供给。
 *
 * 安全合同（AC#6）：本文件所有 DTO 全程不含 sourcePath、adapterKind、scope、
 * 内部工具、权限或依赖——这些是 Agent/Adapter 内部实现，永不进入 Exposure。
 * 现有 `AgentDto.skills`（含 sourcePath）保留为 daemon 上报来源，仅供 owner
 * 在发布 Manifest 时参考，不直接进入 PI context、候选诊断或成员 UI。
 */

/** Manifest 生命周期状态（AC#2：同 team+agent 仅一个 active）。 */
export type AgentExposureManifestStatus =
  | 'draft' // owner 编辑中，未发布，PI 不可见
  | 'active' // 当前生效，PI/成员唯一可消费的 revision
  | 'superseded' // 被同 team+agent 的新 active 取代
  | 'expired' // 超过 validUntil
  | 'revoked'; // owner 主动撤回

/** 公开 Capability：owner 声明的能力契约（非内部 skill 名）。 */
export interface AgentExposureCapabilityDto {
  readonly name: string;
  readonly description: string;
}

/**
 * 公开 Skill 投影：仅 name + description。
 * 刻意不含 `SkillDto` 的 sourcePath / adapterKind / scope（AC#6）。
 */
export interface AgentExposureSkillDto {
  readonly name: string;
  readonly description: string;
}

/** owner 声明的 operation 约束（如 "只读" / "不可联网"）。 */
export interface AgentExposureConstraintDto {
  readonly kind: string;
  readonly description: string;
}

/** 公开可用状态。unavailable 时 PI 不向该 agent 派发。 */
export interface AgentExposureAvailabilityDto {
  readonly status: 'available' | 'unavailable';
  readonly reason?: string;
}

/** 默认可用状态（owner 未显式指定时）。 */
export const DEFAULT_AGENT_EXPOSURE_AVAILABILITY: AgentExposureAvailabilityDto = {
  status: 'available',
};

/** 不可变 Manifest revision（owner 管理视图，含审计字段）。 */
export interface AgentExposureManifestRevisionDto {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  /** 同 team+agent 下单调递增，从 1 起。 */
  readonly revision: number;
  readonly status: AgentExposureManifestStatus;
  readonly capabilities: readonly AgentExposureCapabilityDto[];
  readonly skills: readonly AgentExposureSkillDto[];
  readonly constraints: readonly AgentExposureConstraintDto[];
  readonly availability: AgentExposureAvailabilityDto;
  readonly validFrom: UnixMs;
  /** null = 长期有效。 */
  readonly validUntil: UnixMs | null;
  /** draft 时为 null。 */
  readonly publishedBy: ID | null;
  readonly publishedAt: UnixMs | null;
  /** 被取代时指向新 active manifest id。 */
  readonly supersededById: ID | null;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/**
 * PI / 成员只读 active 投影（AC#3）。
 * 刻意只暴露公开字段 + revision/validUntil（用于 Offer fence），不含 owner/审计/internal。
 */
export interface AgentExposureActiveProjectionDto {
  readonly manifestId: ID;
  readonly agentId: ID;
  readonly revision: number;
  readonly capabilities: readonly AgentExposureCapabilityDto[];
  readonly skills: readonly AgentExposureSkillDto[];
  readonly constraints: readonly AgentExposureConstraintDto[];
  readonly availability: AgentExposureAvailabilityDto;
  readonly validUntil: UnixMs | null;
}

/**
 * Team Owner/Admin 收紧（AC#4）：只能禁用 active manifest 已暴露的 operation。
 * locked 到具体 manifestId（revision fence）；manifest supersede 后需针对新 revision 重设。
 */
export interface AgentExposureRestrictionDto {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly manifestId: ID;
  readonly disabledCapabilities: readonly string[];
  readonly disabledSkills: readonly string[];
  readonly updatedBy: ID;
  readonly updatedAt: UnixMs;
}

/** PI Team 页只读 coverage 条目（AC#5）：per-agent 公开能力 + 收紧 + 约束。 */
export interface AgentTeamCoverageEntryDto {
  readonly agentId: ID;
  readonly agentName: string;
  readonly hasActive: boolean;
  readonly activeRevision: number | null;
  readonly available: boolean;
  readonly exposedCapabilities: readonly string[];
  readonly disabledCapabilities: readonly string[];
  readonly constraints: readonly AgentExposureConstraintDto[];
}

export interface AgentTeamCoverageDto {
  readonly teamId: ID;
  readonly entries: readonly AgentTeamCoverageEntryDto[];
}

// ---- Inputs ----

export interface CreateAgentExposureDraftInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly capabilities: readonly AgentExposureCapabilityDto[];
  readonly skills: readonly AgentExposureSkillDto[];
  readonly constraints?: readonly AgentExposureConstraintDto[];
  readonly availability?: AgentExposureAvailabilityDto;
  readonly validFrom?: UnixMs;
  readonly validUntil?: UnixMs | null;
}

export interface UpdateAgentExposureDraftInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly manifestId: ID;
  readonly capabilities: readonly AgentExposureCapabilityDto[];
  readonly skills: readonly AgentExposureSkillDto[];
  readonly constraints?: readonly AgentExposureConstraintDto[];
  readonly availability?: AgentExposureAvailabilityDto;
  readonly validUntil?: UnixMs | null;
}

export interface PublishAgentExposureInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly manifestId: ID;
}

export interface RevokeAgentExposureInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly agentId: ID;
}

export interface ListAgentExposureRevisionsInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly agentId: ID;
}

export interface GetAgentExposureActiveInput {
  readonly teamId: ID;
  readonly agentId: ID;
  /** 由 socket bind 层从 authenticatedUser 注入；服务端据此做 Team 成员校验（AC#3 隔离）。 */
  readonly userId?: ID;
}

export interface GetAgentTeamCoverageInput {
  readonly userId: ID;
  readonly teamId: ID;
}

export interface UpsertAgentExposureRestrictionInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly disabledCapabilities: readonly string[];
  readonly disabledSkills: readonly string[];
}

// ---- Results ----

export interface CreateAgentExposureDraftResult {
  readonly manifest: AgentExposureManifestRevisionDto;
}

export interface PublishAgentExposureResult {
  readonly manifest: AgentExposureManifestRevisionDto;
  /** 被 supersede 的旧 active manifest id（若有）。 */
  readonly supersededManifestId: ID | null;
}

export interface ListAgentExposureRevisionsResult {
  readonly revisions: readonly AgentExposureManifestRevisionDto[];
  readonly activeRestriction: AgentExposureRestrictionDto | null;
}

export interface GetAgentExposureActiveResult {
  readonly projection: AgentExposureActiveProjectionDto | null;
}

// ── #711 Agent 候选资格可解释投影（Task/PI coverage 视图消费，AC#1/AC#7） ──
//
// 安全要点（AC#4/AC#7）：本组 DTO 是 server 投影、web 渲染共享的唯一资格判定形状。
// 仅含公开 capability/skill 名与状态 + 人类可读判定码；绝不含 sourcePath、其他 Team
// 的 manifest、Agent 内部 skill inventory、权限或依赖。unknown 态的 reason 一律
// `undeclared`，绝不报 `missing`——否则等于推断 Agent 内部缺失，违反 exposure 合同。

/**
 * 资格判定状态。与 domain `AgentEligibilityState` 同形，作为契约供 server/web 共享。
 * - qualified：硬门槛（required Capability/Skill）全部满足。
 * - not_qualified：当前有效声明明确缺失某硬门槛（公开「不做」）。
 * - unknown：无法获得当前有效声明（未声明/过期/不可达），不能推断内部存在与否。
 */
export type AgentEligibilityStateDto = 'qualified' | 'not_qualified' | 'unknown';

/**
 * 单项硬要求匹配状态。`undeclared` 仅在 unknown 态出现，表示「无法判定」——既非缺失
 * 也非存在；coverage 视图据此显示「未声明/未知」（AC#4）。
 */
export type CapabilityMatchStatusDto = 'covered' | 'missing' | 'undeclared';
export type SkillMatchStatusDto = 'covered' | 'missing' | 'undeclared';

/** unknown 态成因（AC#4）。contracts canonical，server 投影与 web 渲染共享同一份。 */
export type AgentEligibilityUnknownCause = 'undeclared' | 'expired' | 'unreachable';

export interface CapabilityMatchReasonDto {
  readonly name: string;
  readonly status: CapabilityMatchStatusDto;
}
export interface SkillMatchReasonDto {
  readonly name: string;
  readonly status: SkillMatchStatusDto;
}
export interface PreferredSkillMatchDto {
  readonly name: string;
  readonly matched: boolean;
}

/**
 * 资格判定判定码（人类可读，视图/审计用）。canonical 常量，server 投影与 web 渲染
 * 共用，避免两端各自硬编码字符串漂移。不含内部信息。
 */
export const ELIGIBILITY_REASON_CODE = {
  QUALIFIED: 'ELIGIBILITY_QUALIFIED',
  MISSING_HARD_REQUIREMENT: 'ELIGIBILITY_MISSING_HARD_REQUIREMENT',
  UNDECLARED: 'ELIGIBILITY_UNDECLARED',
  MANIFEST_EXPIRED: 'ELIGIBILITY_MANIFEST_EXPIRED',
  MANIFEST_UNREACHABLE: 'ELIGIBILITY_MANIFEST_UNREACHABLE',
} as const;

/** 判定码字面量联合，作为 reasonCode 字段的精确类型（防拼写漂移）。 */
export type EligibilityReasonCodeValue =
  (typeof ELIGIBILITY_REASON_CODE)[keyof typeof ELIGIBILITY_REASON_CODE];

/**
 * unknown 成因 → 判定码（canonical，server 投影与 web 渲染共用此映射，消除三包重复）。
 * 默认臂 fail-closed 到 UNDECLARED：任何意外输入（含运行时 `as` 脏值）仍产出可读码，
 * 不返回 undefined（AC#4「不留空、不推断」）。
 */
export function eligibilityUnknownCauseReasonCode(
  cause: AgentEligibilityUnknownCause,
): EligibilityReasonCodeValue {
  switch (cause) {
    case 'expired':
      return ELIGIBILITY_REASON_CODE.MANIFEST_EXPIRED;
    case 'unreachable':
      return ELIGIBILITY_REASON_CODE.MANIFEST_UNREACHABLE;
    case 'undeclared':
    default:
      return ELIGIBILITY_REASON_CODE.UNDECLARED;
  }
}

/**
 * 单 Agent 对一组任务要求的资格判定投影（AC#7）。
 * 一个 Task 的 coverage 视图 = 多个 AgentEligibilityResultDto；一个 Agent 的 coverage
 * 视图 = 该 Agent 在多组要求下的判定。仅暴露公开字段，绝不泄漏其他 Team/Agent 内部。
 */
export interface AgentEligibilityResultDto {
  readonly agentId: ID;
  readonly agentName: string;
  readonly state: AgentEligibilityStateDto;
  readonly available: boolean;
  readonly capabilities: readonly CapabilityMatchReasonDto[];
  readonly requiredSkills: readonly SkillMatchReasonDto[];
  readonly preferredSkills: readonly PreferredSkillMatchDto[];
  /** not_qualified 时汇总缺失硬门槛（公开名）；qualified/unknown 时为空。 */
  readonly missingHardRequirements: readonly string[];
  readonly reasonCode: EligibilityReasonCodeValue;
}

// ── #712 Task Offer：PI → Agent 的结构化工作要约与四类显式响应 ──
//
// 产品边界（计划 §4「Agent 自治」、§6.4）：PI 只能向合格 Agent 发布固定字段 Offer；
// Agent 必须显式返回 accepted/rejected/needs_info/counter_proposed，只有对仍有效 Offer
// 的 accepted 才原子创建 Claim/Lease（AC#3/AC#4）。ACK 仅表示「可响应」，永不等于
// Dispatch/Claim/Lease/assignee（AC#3）。rejected/needs_info/counter_proposed/expired/
// invalidated 均不产 Lease（AC#5）。并发接受同一开放 Offer 时仅一个 Agent 获得有效
// Claim，fencing token 单调（AC#6，复用既有 task-claim-policy）。显式 @Agent（hardSpecified）
// 只决定优先询问对象，绝不强迫 Agent 接受（AC#8）。
//
// 本组 DTO 是 server 投影与（切片 C/E）Agent 协议共享的唯一 Offer 形状。安全合同同
// Exposure：仅含公开 capability/skill 名与任务结构化字段，绝不含 sourcePath、其他 Team
// manifest、Provider/Model 身份或内部工具。

/** Offer 生命周期状态（AC#3/AC#5）。ACK 不改变状态；仅响应或失效转移。 */
export type TaskOfferStatus =
  | 'open' // 已发布，等待 Agent 响应；ACK 停留此态（AC#3）
  | 'accepted' // 某 Agent 明确 accepted 且（服务端同事务）创建了 Claim/Lease（AC#4）
  | 'rejected' // 某 Agent 明确 rejected（AC#2/AC#5）
  | 'needs_info' // 某 Agent 请求补充信息（AC#2/AC#5）
  | 'counter_proposed' // 某 Agent 提出调整（AC#2/AC#5）
  | 'expired' // 超过 offerExpiresAt 未被有效接受（AC#5）
  | 'invalidated' // task revision 变化或 manifest supersede 使其失效（AC#5/AC#6）
  | 'overtaken'; // 并发接受中被另一 Agent 抢先获得 Claim（AC#6 败者）

/**
 * Agent 对 Offer 的四种明确响应（AC#2）。
 * 任何其他值（含「无响应 / 仅 ACK」）都不构成 accepted，不产 Claim（AC#3/AC#5）。
 */
export type TaskOfferResponseKind =
  | 'accepted'
  | 'rejected'
  | 'needs_info'
  | 'counter_proposed';

/** Offer 风险等级；沿用协调 Decision 风险语义，避免两份同集合联合漂移。 */
export type TaskOfferRiskLevel = ChannelCoordinationRiskLevel;

/**
 * AC#1：Offer 固定的「工作内容」字段组（发布时冻结，Agent 可见契约）。
 * 与 Exposure 同源：requiredCapabilities / requiredSkills 必须由候选 Agent 的 active
 * Manifest 公开声明（#711 硬门槛），preferredSkills 仅参与排序。
 */
export interface TaskOfferObjectiveDto {
  readonly objective: string;
  readonly inputs: readonly string[];
  readonly deliverables: readonly string[];
  readonly constraints: readonly string[];
  readonly riskLevel: TaskOfferRiskLevel;
  readonly requiredCapabilities: readonly string[];
  readonly requiredSkills: readonly string[];
  readonly preferredSkills: readonly string[];
}

/**
 * AC#1：Offer 主体（持久化投影 + Agent 可见契约）。
 * taskRevision / manifestRevision 在发布时冻结，作为 accept 时的 fence（AC#5/AC#6）：
 * task 产生新 revision（#709）或 agent active manifest 被新 revision 取代时，旧 Offer 失效。
 */
export interface TaskOfferDto {
  readonly id: ID;
  readonly teamId: ID;
  readonly taskId: ID;
  readonly agentId: ID;
  /** 发布时冻结的 Task revision（AC#1/AC#5 fence）。 */
  readonly taskRevision: number;
  readonly taskAttempt: number;
  /** 发布时冻结的 Agent active Exposure Manifest revision（AC#1/AC#6 fence）。 */
  readonly manifestRevision: number;
  readonly objective: TaskOfferObjectiveDto;
  /** Offer TTL（AC#1）；offerExpiresAt = createdAt + offerTtlMs，超过且未有效接受 → expired。 */
  readonly offerTtlMs: number;
  readonly offerExpiresAt: UnixMs;
  /**
   * 显式 @Agent 硬指定（AC#8）：仅决定优先询问该 Agent，绝不强迫其接受。
   * hardSpecified=true 的 Offer 仍需 Agent 显式 accepted 才产 Claim，仍可被 rejected。
   */
  readonly hardSpecified: boolean;
  readonly status: TaskOfferStatus;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/**
 * Agent 对 Offer 的响应记录（AC#2/AC#5）。
 * - needs_info：detail = 请求的补充信息描述。
 * - counter_proposed：detail = 调整建议（目标/交付/约束/工期等的差异）。
 * - rejected：detail = 拒绝原因（可选）。
 * - accepted：detail 留空（Claim 由服务端同事务创建，不经此字段）。
 */
export interface TaskOfferResponseRecordDto {
  readonly offerId: ID;
  readonly agentId: ID;
  readonly kind: TaskOfferResponseKind;
  readonly detail: string | null;
  readonly respondedAt: UnixMs;
}

/**
 * Offer 失效成因码（canonical，server 投影/审计共享，消除字符串漂移）。
 * 与 domain `OfferInvalidationReason` 同义；这里仅含可投影给 Task 视图/审计的稳定码。
 */
export const TASK_OFFER_INVALIDATION_REASON_CODE = {
  EXPIRED: 'TASK_OFFER_EXPIRED',
  TASK_REVISION_CHANGED: 'TASK_OFFER_TASK_REVISION_CHANGED',
  MANIFEST_SUPERSEDED: 'TASK_OFFER_MANIFEST_SUPERSEDED',
  NOT_OPEN: 'TASK_OFFER_NOT_OPEN',
} as const;

export type TaskOfferInvalidationReasonCode =
  (typeof TASK_OFFER_INVALIDATION_REASON_CODE)[keyof typeof TASK_OFFER_INVALIDATION_REASON_CODE];
