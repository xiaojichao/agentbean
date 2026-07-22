import type { ID, UnixMs } from './common.js';

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
