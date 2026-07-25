import type {
  AttachmentStatus,
  ExperiencePackSourceKind,
  ExperiencePackStatus,
  ID,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';

/**
 * Experience Pack 持久化接口（issue #722）。
 *
 * 三表在 **Team DB**（与 Formal Memory 同 DB）：
 * - `experience_packs`：Pack 主记录
 * - `experience_pack_sources`：来源快照
 * - `channel_experience_attachments`：频道关联
 *
 * repository 是纯数据访问层，业务门控在 `experience-pack-policy`（domain）执行。
 */

/** experience_packs 行。 */
export interface ExperiencePackRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly status: ExperiencePackStatus;
  readonly title: string;
  readonly summary?: string;
  readonly sourceChannelId: ID;
  readonly applicabilityConditions?: string;
  readonly exclusionConditions?: string;
  readonly conclusions?: string;
  readonly limitations?: string;
  readonly approvedByUserId?: ID;
  readonly createdByUserId?: ID;
  readonly sourceInvalidReason?: string;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/** experience_pack_sources 行。 */
export interface ExperiencePackSourceRecord {
  readonly packId: ID;
  readonly teamId: ID;
  readonly sourceKind: ExperiencePackSourceKind;
  readonly sourceId: ID;
  readonly snapshotHash: string;
  readonly sourceScopeType: string;
  readonly sourceScopeRef: string;
  readonly createdAt: UnixMs;
}

/** channel_experience_attachments 行（#723：三态生命周期）。 */
export interface ChannelExperienceAttachmentRecord {
  readonly id: ID;
  readonly packId: ID;
  readonly channelId: ID;
  readonly teamId: ID;
  /** #723：pending → attached → revoked。 */
  readonly status: AttachmentStatus;
  /** 推荐者（PI 或用户）。 */
  readonly recommendedByUserId: ID;
  readonly recommendedAt: UnixMs;
  readonly confirmedByUserId?: ID;
  readonly confirmedAt?: UnixMs;
  readonly revokedByUserId?: ID;
  readonly revokedAt?: UnixMs;
}

// ── 仓库接口 ──────────────────────────────────────────────────────────────────

export interface ExperiencePackRepository {
  create(record: ExperiencePackRecord): Promise<ExperiencePackRecord>;
  getById(input: { teamId: ID; id: ID }): Promise<ExperiencePackRecord | null>;
  listByTeam(input: { teamId: ID; status?: ExperiencePackStatus }): Promise<ExperiencePackRecord[]>;
  /** 按来源频道列出（用于归档后建议 Pack draft）。 */
  listBySourceChannel(input: { teamId: ID; sourceChannelId: ID }): Promise<ExperiencePackRecord[]>;
  /** 列出关联到频道的已批准 Pack（JOIN 查询避免 N+1）。 */
  listApprovedByChannel(input: { teamId: ID; channelId: ID }): Promise<ExperiencePackRecord[]>;
  /** 状态迁移（乐观锁：expectedUpdatedAt）。 */
  updateStatus(input: {
    teamId: ID;
    id: ID;
    status: ExperiencePackStatus;
    approvedByUserId?: ID;
	    sourceInvalidReason?: string;
    updatedAt: UnixMs;
    expectedUpdatedAt: UnixMs;
  }): Promise<ExperiencePackRecord | null>;
}

export interface ExperiencePackSourceRepository {
  create(record: ExperiencePackSourceRecord): Promise<ExperiencePackSourceRecord>;
  listByPack(input: { teamId: ID; packId: ID }): Promise<ExperiencePackSourceRecord[]>;
}

export interface ChannelExperienceAttachmentRepository {
  create(record: ChannelExperienceAttachmentRecord): Promise<ChannelExperienceAttachmentRecord>;
  getByPackAndChannel(input: {
    teamId: ID;
    packId: ID;
    channelId: ID;
  }): Promise<ChannelExperienceAttachmentRecord | null>;
  listByChannel(input: { teamId: ID; channelId: ID }): Promise<ChannelExperienceAttachmentRecord[]>;
  listByPack(input: { teamId: ID; packId: ID }): Promise<ChannelExperienceAttachmentRecord[]>;
  /** #723：乐观状态迁移（expectedStatus 防并发）。返回 null 表示并发冲突。 */
  updateStatus(input: {
    teamId: ID;
    packId: ID;
    channelId: ID;
    status: AttachmentStatus;
    confirmedByUserId?: ID;
    confirmedAt?: UnixMs;
    revokedByUserId?: ID;
    revokedAt?: UnixMs;
    expectedStatus: AttachmentStatus;
  }): Promise<ChannelExperienceAttachmentRecord | null>;
}

export interface ExperiencePackRepositories {
  readonly packs: ExperiencePackRepository;
  readonly sources: ExperiencePackSourceRepository;
  readonly attachments: ChannelExperienceAttachmentRepository;
}
