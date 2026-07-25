import type {
  ChannelExperienceAttachmentDto,
  ExperiencePackDto,
  ID,
} from '../../../../packages/contracts/src/index.js';
import type {
  CreateExperiencePackDraftInput,
  ApproveExperiencePackInput,
  WithdrawExperiencePackInput,
  MarkExperiencePackSourceInvalidInput,
  AttachExperiencePackToChannelInput,
  DetachExperiencePackFromChannelInput,
} from '../../../../packages/contracts/src/index.js';
import {
  evaluateExperiencePackApproval,
  evaluateExperiencePackAttachment,
  evaluateExperiencePackSourceValidity,
  evaluateExperiencePackWithdrawal,
  validateExperiencePackDraft,
} from '../../../../packages/domain/src/index.js';
import type {
  ExperiencePackRecord,
  ExperiencePackSourceRecord,
} from './experience-pack-repositories.js';
import type { ServerNextRepositories } from './repositories.js';

/**
 * Experience Pack 产品服务层（issue #722）。
 *
 * 负责 Pack 生命周期：创建 draft → 审批 → 来源失效/撤回，以及频道关联。
 * 业务门控委托给 domain `experience-pack-policy` 纯函数；本层只做数据组装与仓库调度。
 */

export interface ExperiencePackService {
  createDraft(input: CreateExperiencePackDraftInput): Promise<ExperiencePackDto>;
  approve(input: ApproveExperiencePackInput): Promise<ExperiencePackDto>;
  withdraw(input: WithdrawExperiencePackInput): Promise<ExperiencePackDto>;
  markSourceInvalid(input: MarkExperiencePackSourceInvalidInput): Promise<ExperiencePackDto>;
  listByTeam(input: { teamId: ID; status?: 'draft' | 'approved' | 'source_invalid' | 'withdrawn' }): Promise<readonly ExperiencePackDto[]>;
  /** 列出可关联到活跃频道的已批准 Pack（AC#5：draft 不可搜索）。 */
  listApprovedForChannel(input: { teamId: ID; channelId: ID }): Promise<readonly ExperiencePackDto[]>;
  getById(input: { teamId: ID; packId: ID }): Promise<ExperiencePackDto | null>;
  attachToChannel(input: AttachExperiencePackToChannelInput): Promise<ChannelExperienceAttachmentDto>;
  detachFromChannel(input: DetachExperiencePackFromChannelInput): Promise<void>;
}

export function createExperiencePackService(input: {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}): ExperiencePackService {
  const { repositories, clock, ids } = input;

  return {
    async createDraft(input) {
      const channel = await repositories.channels.getById(input.sourceChannelId);
      const validation = validateExperiencePackDraft({
        title: input.title,
        sourceChannelArchived: channel?.archivedAt != null,
      });
      if (validation.kind === 'error') {
        throw new Error(`EXPERIENCE_PACK_DRAFT_INVALID:${validation.reason}`);
      }

      const now = clock.now();
      const record: ExperiencePackRecord = {
        id: ids.nextId(),
        teamId: input.teamId,
        status: 'draft',
        title: input.title,
        summary: input.summary,
        sourceChannelId: input.sourceChannelId,
        applicabilityConditions: input.applicabilityConditions,
        exclusionConditions: input.exclusionConditions,
        conclusions: input.conclusions,
        limitations: input.limitations,
        approvedByUserId: undefined,
        createdByUserId: input.actorId,
        createdAt: now,
        updatedAt: now,
      };
      await repositories.experiencePack.packs.create(record);

      if (input.sources && input.sources.length > 0) {
        for (const source of input.sources) {
          const sourceRecord: ExperiencePackSourceRecord = {
            packId: record.id,
            teamId: input.teamId,
            sourceKind: source.sourceKind,
            sourceId: source.sourceId,
            snapshotHash: source.snapshotHash,
            sourceScopeType: source.sourceScopeType,
            sourceScopeRef: source.sourceScopeRef,
            createdAt: now,
          };
          await repositories.experiencePack.sources.create(sourceRecord);
        }
      }

      return toDto(record);
    },

    async approve(input) {
      const pack = await repositories.experiencePack.packs.getById({
        teamId: input.teamId,
        id: input.packId,
      });
      if (!pack) throw new Error('EXPERIENCE_PACK_NOT_FOUND');

      const canManage = await checkCanManageTeam(repositories, input.teamId, input.actorId);
      const decision = evaluateExperiencePackApproval({
        pack: { status: pack.status, teamId: pack.teamId },
        actorId: input.actorId,
        canManageTeam: canManage,
      });
      if (decision.kind === 'error') {
        throw new Error(`EXPERIENCE_PACK_APPROVE:${decision.reason}`);
      }

      const now = clock.now();
      const updated = await repositories.experiencePack.packs.updateStatus({
        teamId: input.teamId,
        id: input.packId,
        status: 'approved',
        approvedByUserId: input.actorId,
        updatedAt: now,
        expectedUpdatedAt: pack.updatedAt,
      });
      if (!updated) throw new Error('EXPERIENCE_PACK_CONCURRENT_MODIFICATION');

      return toDto(updated);
    },

    async withdraw(input) {
      const pack = await repositories.experiencePack.packs.getById({
        teamId: input.teamId,
        id: input.packId,
      });
      if (!pack) throw new Error('EXPERIENCE_PACK_NOT_FOUND');

      const canManage = await checkCanManageTeam(repositories, input.teamId, input.actorId);
      const decision = evaluateExperiencePackWithdrawal({
        pack: { status: pack.status, teamId: pack.teamId },
        actorId: input.actorId,
        canManageTeam: canManage,
      });
      if (decision.kind === 'error') {
        throw new Error(`EXPERIENCE_PACK_WITHDRAW:${decision.reason}`);
      }

      const now = clock.now();
      const updated = await repositories.experiencePack.packs.updateStatus({
        teamId: input.teamId,
        id: input.packId,
        status: 'withdrawn',
        updatedAt: now,
        expectedUpdatedAt: pack.updatedAt,
      });
      if (!updated) throw new Error('EXPERIENCE_PACK_CONCURRENT_MODIFICATION');

      return toDto(updated);
    },

    async markSourceInvalid(input) {
      const pack = await repositories.experiencePack.packs.getById({
        teamId: input.teamId,
        id: input.packId,
      });
      if (!pack) throw new Error('EXPERIENCE_PACK_NOT_FOUND');

      const canManage = await checkCanManageTeam(repositories, input.teamId, input.actorId);
      const decision = evaluateExperiencePackSourceValidity({
        pack: { status: pack.status, teamId: pack.teamId },
        actorId: input.actorId,
        canManageTeam: canManage,
        reason: input.reason,
      });
      if (decision.kind === 'error') {
        throw new Error(`EXPERIENCE_PACK_SOURCE_INVALID:${decision.reason}`);
      }

      const now = clock.now();
      const updated = await repositories.experiencePack.packs.updateStatus({
        teamId: input.teamId,
        id: input.packId,
        status: 'source_invalid',
        sourceInvalidReason: input.reason,
        updatedAt: now,
        expectedUpdatedAt: pack.updatedAt,
      });
      if (!updated) throw new Error('EXPERIENCE_PACK_CONCURRENT_MODIFICATION');

      return toDto(updated);
    },

    async listByTeam(input) {
      const records = await repositories.experiencePack.packs.listByTeam(input);
      return records.map(toDto);
    },

    async listApprovedForChannel(input) {
      // 取该频道关联的所有 attachment → 筛出 approved pack
      const attachments = await repositories.experiencePack.attachments.listByChannel({
        teamId: input.teamId,
        channelId: input.channelId,
      });
      const dtos: ExperiencePackDto[] = [];
      for (const att of attachments) {
        const pack = await repositories.experiencePack.packs.getById({
          teamId: input.teamId,
          id: att.packId,
        });
        // AC#5：只返回 approved 状态；draft/source_invalid/withdrawn 不出现
        if (pack && pack.status === 'approved') {
          dtos.push(toDto(pack));
        }
      }
      return dtos;
    },

    async getById(input) {
      const record = await repositories.experiencePack.packs.getById({ teamId: input.teamId, id: input.packId });
      return record ? toDto(record) : null;
    },

    async attachToChannel(input) {
      const pack = await repositories.experiencePack.packs.getById({
        teamId: input.teamId,
        id: input.packId,
      });
      if (!pack) throw new Error('EXPERIENCE_PACK_NOT_FOUND');

      const channel = await repositories.channels.getById(input.channelId);
      if (!channel) throw new Error('CHANNEL_NOT_FOUND');

      const canManage = await checkCanManageTeam(repositories, input.teamId, input.actorId);
      const decision = evaluateExperiencePackAttachment({
        pack: { status: pack.status, teamId: pack.teamId },
        channel: { teamId: channel.teamId, archivedAt: channel.archivedAt ?? null },
        actorId: input.actorId,
        canManageChannel: canManage,
      });
      if (decision.kind === 'error') {
        throw new Error(`EXPERIENCE_PACK_ATTACH:${decision.reason}`);
      }

      // 幂等：已存在的 attachment 直接返回
      const existing = await repositories.experiencePack.attachments.getByPackAndChannel({
        teamId: input.teamId,
        packId: input.packId,
        channelId: input.channelId,
      });
      if (existing) return toAttachmentDto(existing);

      const now = clock.now();
      const record = {
        id: ids.nextId(),
        packId: input.packId,
        channelId: input.channelId,
        teamId: input.teamId,
        attachedByUserId: input.actorId,
        attachedAt: now,
      };
      await repositories.experiencePack.attachments.create(record);
      return toAttachmentDto(record);
    },

    async detachFromChannel(input) {
      const existing = await repositories.experiencePack.attachments.getByPackAndChannel({
        teamId: input.teamId,
        packId: input.packId,
        channelId: input.channelId,
      });
      if (!existing) return; // 幂等

      await repositories.experiencePack.attachments.delete({
        teamId: input.teamId,
        id: existing.id,
      });
    },
  };
}

// ── DTO 映射 ──────────────────────────────────────────────────────────────────

function toDto(record: ExperiencePackRecord): ExperiencePackDto {
  return {
    schemaVersion: 1,
    id: record.id,
    teamId: record.teamId,
    status: record.status,
    title: record.title,
    summary: record.summary,
    sourceChannelId: record.sourceChannelId,
    applicabilityConditions: record.applicabilityConditions,
    exclusionConditions: record.exclusionConditions,
    conclusions: record.conclusions,
    limitations: record.limitations,
    approvedByUserId: record.approvedByUserId,
    createdByUserId: record.createdByUserId,
    sourceInvalidReason: record.sourceInvalidReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toAttachmentDto(record: {
  id: string;
  packId: string;
  channelId: string;
  teamId: string;
  attachedByUserId: string;
  attachedAt: number;
}): ChannelExperienceAttachmentDto {
  return {
    id: record.id,
    packId: record.packId,
    channelId: record.channelId,
    teamId: record.teamId,
    attachedByUserId: record.attachedByUserId,
    attachedAt: record.attachedAt,
  };
}

// ── 权限辅助（server 侧 inject） ─────────────────────────────────────────────

async function checkCanManageTeam(
  repositories: ServerNextRepositories,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const member = await repositories.teams.getMember({ teamId, userId });
  if (!member) return false;
  return member.role === 'owner' || member.role === 'admin';
}

