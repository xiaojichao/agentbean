import type {
  ChannelExperienceAttachmentDto,
  ExperiencePackDto,
  ID,
} from '../../../../packages/contracts/src/index.js';
import type {
  ConfirmExperiencePackAttachmentInput,
  CreateExperiencePackDraftInput,
  ApproveExperiencePackInput,
  RecommendExperiencePackToChannelInput,
  RevokeExperiencePackAttachmentInput,
  WithdrawExperiencePackInput,
  MarkExperiencePackSourceInvalidInput,
} from '../../../../packages/contracts/src/index.js';
import {
  evaluateExperiencePackApproval,
  evaluateExperiencePackConfirmation,
  evaluateExperiencePackRecommendation,
  evaluateExperiencePackRevocation,
  evaluateExperiencePackSourceValidity,
  evaluateExperiencePackWithdrawal,
  validateExperiencePackDraft,
} from '../../../../packages/domain/src/index.js';
import type {
  ChannelExperienceAttachmentRecord,
  ExperiencePackRecord,
  ExperiencePackSourceRecord,
} from './experience-pack-repositories.js';
import type { ServerNextRepositories } from './repositories.js';

/**
 * Experience Pack 产品服务层（issue #722 + #723）。
 *
 * 负责 Pack 生命周期：创建 draft → 审批 → 来源失效/撤回，以及频道推荐/确认/撤销。
 * 业务门控委托给 domain `experience-pack-policy` 纯函数；本层只做数据组装与仓库调度。
 */

export interface ExperiencePackService {
  createDraft(input: CreateExperiencePackDraftInput): Promise<ExperiencePackDto>;
  approve(input: ApproveExperiencePackInput): Promise<ExperiencePackDto>;
  withdraw(input: WithdrawExperiencePackInput): Promise<ExperiencePackDto>;
  markSourceInvalid(input: MarkExperiencePackSourceInvalidInput): Promise<ExperiencePackDto>;
  listByTeam(input: { teamId: ID; status?: 'draft' | 'approved' | 'source_invalid' | 'withdrawn' }): Promise<readonly ExperiencePackDto[]>;
  /** 列出关联到频道的 attached Pack（#723：pending/revoked 不返回）。 */
  listApprovedForChannel(input: { teamId: ID; channelId: ID }): Promise<readonly ExperiencePackDto[]>;
  getById(input: { teamId: ID; packId: ID }): Promise<ExperiencePackDto | null>;
  /** #723：PI 或用户推荐 → 创建 pending attachment。 */
  recommendToChannel(input: RecommendExperiencePackToChannelInput): Promise<ChannelExperienceAttachmentDto>;
  /** #723：频道成员确认 pending → attached。 */
  confirmAttachment(input: ConfirmExperiencePackAttachmentInput): Promise<ChannelExperienceAttachmentDto>;
  /** #723：频道成员或 Admin 撤销 attached → revoked（保留审计记录）。 */
  revokeAttachment(input: RevokeExperiencePackAttachmentInput): Promise<ChannelExperienceAttachmentDto>;
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
      // AC#5：单次 JOIN 查询，只返回 approved 状态；draft/source_invalid/withdrawn 不出现
      const records = await repositories.experiencePack.packs.listApprovedByChannel({
        teamId: input.teamId,
        channelId: input.channelId,
      });
      return records.map(toDto);
    },

    async getById(input) {
      const record = await repositories.experiencePack.packs.getById({ teamId: input.teamId, id: input.packId });
      return record ? toDto(record) : null;
    },

    async recommendToChannel(input) {
      const pack = await repositories.experiencePack.packs.getById({
        teamId: input.teamId,
        id: input.packId,
      });
      if (!pack) throw new Error('EXPERIENCE_PACK_NOT_FOUND');

      const channel = await repositories.channels.getById(input.channelId);
      if (!channel) throw new Error('CHANNEL_NOT_FOUND');

      const decision = evaluateExperiencePackRecommendation({
        pack: { status: pack.status, teamId: pack.teamId },
        channel: { teamId: channel.teamId, archivedAt: channel.archivedAt ?? null },
        actorId: input.actorId,
      });
      if (decision.kind === 'error') {
        throw new Error(`EXPERIENCE_PACK_RECOMMEND:${decision.reason}`);
      }

      const now = clock.now();
      // 幂等：检查已存在的 attachment
      const existing = await repositories.experiencePack.attachments.getByPackAndChannel({
        teamId: input.teamId,
        packId: input.packId,
        channelId: input.channelId,
      });
      if (existing) {
        if (existing.status === 'pending') return toAttachmentDto(existing);
        if (existing.status === 'attached') return toAttachmentDto(existing);
        // revoked → revive to pending
        if (existing.status === 'revoked') {
          const revived = await repositories.experiencePack.attachments.updateStatus({
            teamId: input.teamId,
            packId: input.packId,
            channelId: input.channelId,
            status: 'pending',
            expectedStatus: 'revoked',
          });
          if (!revived) throw new Error('EXPERIENCE_PACK_CONCURRENT_MODIFICATION');
          return toAttachmentDto(revived);
        }
      }

      const record = {
        id: ids.nextId(),
        packId: input.packId,
        channelId: input.channelId,
        teamId: input.teamId,
        status: 'pending' as const,
        recommendedByUserId: input.actorId,
        recommendedAt: now,
        confirmedByUserId: undefined as string | undefined,
        confirmedAt: undefined as number | undefined,
        revokedByUserId: undefined as string | undefined,
        revokedAt: undefined as number | undefined,
      };
      await repositories.experiencePack.attachments.create(record);
      return toAttachmentDto(record);
    },

    async confirmAttachment(input) {
      const attachment = await repositories.experiencePack.attachments.getByPackAndChannel({
        teamId: input.teamId,
        packId: input.packId,
        channelId: input.channelId,
      });
      if (!attachment) throw new Error('EXPERIENCE_PACK_ATTACHMENT_NOT_FOUND');

      // 运行时复验：pack 仍需 approved
      const pack = await repositories.experiencePack.packs.getById({
        teamId: input.teamId,
        id: input.packId,
      });
      if (!pack || pack.status !== 'approved') {
        throw new Error('EXPERIENCE_PACK_CONFIRM:pack_not_approved');
      }

      const channel = await repositories.channels.getById(input.channelId);
      const isChannelMember = channel ? channel.humanMemberIds.includes(input.actorId) : false;

      const decision = evaluateExperiencePackConfirmation({
        attachment: { status: attachment.status },
        actorId: input.actorId,
        isChannelMember,
      });
      if (decision.kind === 'error') {
        throw new Error(`EXPERIENCE_PACK_CONFIRM:${decision.reason}`);
      }

      const now = clock.now();
      const updated = await repositories.experiencePack.attachments.updateStatus({
        teamId: input.teamId,
        packId: input.packId,
        channelId: input.channelId,
        status: 'attached',
        confirmedByUserId: input.actorId,
        confirmedAt: now,
        expectedStatus: 'pending',
      });
      if (!updated) throw new Error('EXPERIENCE_PACK_CONCURRENT_MODIFICATION');

      return toAttachmentDto(updated);
    },

    async revokeAttachment(input) {
      const attachment = await repositories.experiencePack.attachments.getByPackAndChannel({
        teamId: input.teamId,
        packId: input.packId,
        channelId: input.channelId,
      });
      if (!attachment) throw new Error('EXPERIENCE_PACK_ATTACHMENT_NOT_FOUND');

      // 频道成员 或 Team Admin 均可撤销
      const channel = await repositories.channels.getById(input.channelId);
      const isChannelMember = channel ? channel.humanMemberIds.includes(input.actorId) : false;
      const canManage = await checkCanManageTeam(repositories, input.teamId, input.actorId);

      const decision = evaluateExperiencePackRevocation({
        attachment: { status: attachment.status },
        actorId: input.actorId,
        canRevoke: isChannelMember || canManage,
      });
      if (decision.kind === 'error') {
        throw new Error(`EXPERIENCE_PACK_REVOKE:${decision.reason}`);
      }

      const now = clock.now();
      const updated = await repositories.experiencePack.attachments.updateStatus({
        teamId: input.teamId,
        packId: input.packId,
        channelId: input.channelId,
        status: 'revoked',
        revokedByUserId: input.actorId,
        revokedAt: now,
        expectedStatus: attachment.status,
      });
      if (!updated) throw new Error('EXPERIENCE_PACK_CONCURRENT_MODIFICATION');

      return toAttachmentDto(updated);
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

function toAttachmentDto(record: ChannelExperienceAttachmentRecord): ChannelExperienceAttachmentDto {
  return {
    id: record.id,
    packId: record.packId,
    channelId: record.channelId,
    teamId: record.teamId,
    status: record.status,
    recommendedByUserId: record.recommendedByUserId,
    recommendedAt: record.recommendedAt,
    confirmedByUserId: record.confirmedByUserId,
    confirmedAt: record.confirmedAt,
    revokedByUserId: record.revokedByUserId,
    revokedAt: record.revokedAt,
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

