import type { ID, UnixMs } from './common.js';
import type { MemorySourceRefDto } from './management-memory.js';
import type { FormalMemoryKind } from './formal-memory.js';

/**
 * #718 Team-scoped Agent Memory 投影。
 *
 * Agent owner 把 Agent 的（Device-local / 内部）memory 显式投影成面向特定 Team 的
 * 公开内容。投影是独立实体（ADR-0017：经作用域扩展确认的最小化投影，独立于源），
 * 由 Agent owner 管理，Team Owner/Admin 决定本 Team 是否使用（CONTEXT.md:110-113）。
 *
 * 安全合同（AC#4/AC#6）：投影只暴露 owner 主动发布的公开内容（kind/content/summary/
 * tags），永不包含 Agent 内部 Session、私有历史、Device-local 原文或其他 Team 投影。
 * 投影内容是 owner 手动录入的最小化公开视图，不是 device-local 文件的直接引用
 * （Server 不持有 Device-local 数据，见 Phase 3 P3-12）。
 *
 * 数据模型镜像 #710 Agent Exposure：owner 发布 draft→active→superseded 生命周期 +
 * Team opt-in 收紧。差异：opt-in 默认 opted-out（memory 比 capability 更敏感，AC#5
 * 要求明确授权），而 #710 restriction 默认全开。
 */

/** 投影生命周期状态（AC#2：同 team+agent 仅一个 active）。 */
export type AgentMemoryProjectionStatus =
  | 'draft' // owner 编辑中，未发布，PI/Team 不可见
  | 'active' // 当前生效，opt-in 后 Team/PI 可消费的唯一 revision
  | 'superseded' // 被同 team+agent 的新 active 取代
  | 'expired' // 超过 validUntil（service 懒过期）
  | 'withdrawn'; // owner 主动撤回（AC#2 撤回 / AC#7 立即退出 context）

/**
 * Owner 管理视图（含审计字段）。
 * kind 复用 FormalMemoryKind：projection 内容即"职责/偏好/可复用经验"，
 * 对应 fact/decision/rule/preference 四类，与 PI Memory Center 统一渲染。
 */
export interface AgentMemoryProjectionDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  /** 同 team+agent 下单调递增，从 1 起。 */
  readonly revision: number;
  readonly status: AgentMemoryProjectionStatus;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly validFrom: UnixMs;
  /** null = 长期有效。 */
  readonly validUntil: UnixMs | null;
  /** draft 时为 null。 */
  readonly publishedBy: ID | null;
  readonly publishedAt: UnixMs | null;
  /** 被取代时指向新 active projection id。 */
  readonly supersededById: ID | null;
  /** withdrawn 时记录撤回者/时间（AC#2/AC#7 审计）。 */
  readonly withdrawnBy?: ID;
  readonly withdrawnAt?: UnixMs;
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/**
 * PI / Team 成员只读消费视图（AC#6：PI Memory Center 只消费当前 Team 已启用投影）。
 * 刻意只暴露消费所需公开字段 + revision/validUntil，不含 owner/审计/sourceRefs 原文。
 * sourceRefs 在消费视图省略——投影内容本身已是公开最小化视图，来源引用仅供 owner 审计。
 */
export interface AgentMemoryProjectionConsumptionDto {
  readonly projectionId: ID;
  readonly agentId: ID;
  readonly agentName: string;
  readonly revision: number;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly validUntil: UnixMs | null;
}

/**
 * Team Owner/Admin opt-in（AC#3）。每 team+agent 一条生效记录。
 * projectionId 作为 revision 围栏：projection supersede 后 opt-in.projectionId 与新
 * active 不符 → opt-in 失效，需 admin 针对新 revision 重设（避免静默套用到新内容）。
 * 默认 opted-out：无记录或 enabled=false 时 Team 不消费（AC#5 明确授权）。
 */
export interface TeamAgentMemoryOptInDto {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  /** revision fence：锁定到具体 active projection。 */
  readonly projectionId: ID;
  readonly enabled: boolean;
  readonly updatedBy: ID;
  readonly updatedAt: UnixMs;
}

// ---- 命令输入 ----

export interface CreateAgentMemoryProjectionDraftInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly MemorySourceRefDto[];
  readonly validFrom?: UnixMs;
  readonly validUntil?: UnixMs | null;
}

export interface UpdateAgentMemoryProjectionDraftInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly projectionId: ID;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly MemorySourceRefDto[];
  readonly validUntil?: UnixMs | null;
}

export interface PublishAgentMemoryProjectionInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly projectionId: ID;
}

/** 撤回当前 active projection（AC#2 撤回）。无 active 时幂等返回 revoked=false。 */
export interface WithdrawAgentMemoryProjectionInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly agentId: ID;
}

export interface ListAgentMemoryProjectionRevisionsInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly agentId: ID;
}

/** Team Owner/Admin 启用/停用本 Team 对某 Agent 投影的使用（AC#3）。 */
export interface UpsertTeamAgentMemoryOptInInput {
  readonly userId: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly enabled: boolean;
}

/**
 * PI / Team 消费查询（AC#6）。返回当前 Team 已 opt-in 的 active projection 消费视图。
 * agentId 可选：候选选择时按需检索特定 Agent（ADR-0008）；省略则返回全 Team 已启用投影。
 * userId 由 socket bind 层注入，服务端据此做 Team 成员校验（AC#4 隔离）。
 */
export interface GetConsumableAgentMemoryProjectionsInput {
  readonly teamId: ID;
  readonly agentId?: ID;
  readonly userId?: ID;
}

// ---- 结果 ----

export interface CreateAgentMemoryProjectionDraftResult {
  readonly projection: AgentMemoryProjectionDto;
}

export interface PublishAgentMemoryProjectionResult {
  readonly projection: AgentMemoryProjectionDto;
  /** 被 supersede 的旧 active projection id（若有）。 */
  readonly supersededProjectionId: ID | null;
}

export interface ListAgentMemoryProjectionRevisionsResult {
  readonly revisions: readonly AgentMemoryProjectionDto[];
  /** 当前生效 opt-in（若 team 已启用）。 */
  readonly activeOptIn: TeamAgentMemoryOptInDto | null;
}

export interface GetConsumableAgentMemoryProjectionsResult {
  readonly projections: readonly AgentMemoryProjectionConsumptionDto[];
}
