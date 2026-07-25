import type { ID, UnixMs } from './common.js';

/**
 * Reusable Experience Pack（issue #722，ADR 0006）。
 *
 * 频道归档后 PI 可以提出 Experience Pack draft，经用户第一次确认后进入 Team
 * Experience Library。Pack 是独立知识单元，不伪装成单条 Formal Memory（ADR 0047），
 * 也不复制完整频道历史（AC#4）。
 *
 * 生命周期：draft → approved → source_invalid | withdrawn
 * - draft：PI 提议但未批准（AC#5：不可搜索、不可跨 Team 可见）
 * - approved：用户确认后进入 Team Experience Library（AC#3）
 * - source_invalid：来源删除/权限撤销/被证错误，停止使用但保留审计（AC#6）
 * - withdrawn：用户主动撤回，已撤回内容不再用于新关联（AC#7）
 */

export const EXPERIENCE_PACK_STATUSES = [
  'draft',
  'approved',
  'source_invalid',
  'withdrawn',
] as const;
export type ExperiencePackStatus = (typeof EXPERIENCE_PACK_STATUSES)[number];

export const EXPERIENCE_PACK_SOURCE_KINDS = [
  'message',
  'task',
  'artifact',
  'workspace-run',
  'invocation',
  'memory',
  'manual',
] as const;
export type ExperiencePackSourceKind = (typeof EXPERIENCE_PACK_SOURCE_KINDS)[number];

// ── DTO ──────────────────────────────────────────────────────────────────────

export interface ExperiencePackDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly status: ExperiencePackStatus;
  /** 简短标题（必填，AC#2）。 */
  readonly title: string;
  /** 可选摘要。 */
  readonly summary?: string;
  /** 来源频道 id（AC#2）。 */
  readonly sourceChannelId: ID;
  /** 适用条件（AC#2）。 */
  readonly applicabilityConditions?: string;
  /** 排除条件（AC#2）。 */
  readonly exclusionConditions?: string;
  /** 结论（AC#2）。 */
  readonly conclusions?: string;
  /** 限制（AC#2）。 */
  readonly limitations?: string;
  /** 审批者（AC#2：第一次确认的审批人）。 */
  readonly approvedByUserId?: ID;
  /** 创建者。 */
  readonly createdByUserId?: ID;
  /** AC#6：来源失效原因（审计保留）。 */
  readonly sourceInvalidReason?: string;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface ExperiencePackSourceDto {
  readonly packId: ID;
  readonly teamId: ID;
  readonly sourceKind: ExperiencePackSourceKind;
  readonly sourceId: ID;
  /** 来源快照哈希（AC#2）。 */
  readonly snapshotHash: string;
  readonly sourceScopeType: string;
  readonly sourceScopeRef: string;
  readonly createdAt: UnixMs;
}

export interface ChannelExperienceAttachmentDto {
  readonly id: ID;
  readonly packId: ID;
  readonly channelId: ID;
  readonly teamId: ID;
  readonly attachedByUserId: ID;
  readonly attachedAt: UnixMs;
}

// ── 命令输入 ──────────────────────────────────────────────────────────────────

export interface CreateExperiencePackDraftInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly title: string;
  readonly summary?: string;
  readonly sourceChannelId: ID;
  readonly applicabilityConditions?: string;
  readonly exclusionConditions?: string;
  readonly conclusions?: string;
  readonly limitations?: string;
  readonly sources?: readonly {
    readonly sourceKind: ExperiencePackSourceKind;
    readonly sourceId: ID;
    readonly snapshotHash: string;
    readonly sourceScopeType: string;
    readonly sourceScopeRef: string;
  }[];
}

export interface ApproveExperiencePackInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly packId: ID;
}

export interface WithdrawExperiencePackInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly packId: ID;
}

export interface MarkExperiencePackSourceInvalidInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly packId: ID;
  /** 失效原因（AC#6：审计保留）。 */
  readonly reason: string;
}

export interface AttachExperiencePackToChannelInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly packId: ID;
  readonly channelId: ID;
}

export interface DetachExperiencePackFromChannelInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly packId: ID;
  readonly channelId: ID;
}
