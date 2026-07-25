import type {
  ChannelExperienceAttachmentRecord,
  ExperiencePackRecord,
  ExperiencePackRepositories,
  ExperiencePackSourceRecord,
} from '../../application/experience-pack-repositories.js';

/**
 * Experience Pack 内存实现（测试用，issue #722）。
 */
export function createMemoryExperiencePackRepositories(): ExperiencePackRepositories {
  const packs = new Map<string, ExperiencePackRecord>();
  const sources: ExperiencePackSourceRecord[] = [];
  const attachments = new Map<string, ChannelExperienceAttachmentRecord>();

  return {
    packs: {
      async create(record) {
        packs.set(record.id, record);
        return record;
      },
      async getById(input) {
        const record = packs.get(input.id);
        return record && record.teamId === input.teamId ? record : null;
      },
      async listByTeam(input) {
        const results = [...packs.values()].filter((r) => r.teamId === input.teamId);
        if (input.status) {
          return results.filter((r) => r.status === input.status)
            .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
        }
        return results.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      },
      async listBySourceChannel(input) {
        return [...packs.values()]
          .filter((r) => r.teamId === input.teamId && r.sourceChannelId === input.sourceChannelId)
          .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      },
      async listApprovedByChannel(input) {
        const packIds = new Set(
          [...attachments.values()]
            .filter((r) => r.teamId === input.teamId && r.channelId === input.channelId)
            .map((r) => r.packId),
        );
        return [...packs.values()]
          .filter((r) => r.teamId === input.teamId && r.status === 'approved' && packIds.has(r.id))
          .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      },
      async updateStatus(input) {
        const record = packs.get(input.id);
        if (!record || record.teamId !== input.teamId || record.updatedAt !== input.expectedUpdatedAt) return null;
        const updated: ExperiencePackRecord = {
          ...record,
          status: input.status,
          approvedByUserId: input.approvedByUserId ?? record.approvedByUserId,
          sourceInvalidReason: input.sourceInvalidReason ?? record.sourceInvalidReason,
          updatedAt: input.updatedAt,
        };
        packs.set(input.id, updated);
        return updated;
      },
    },

    sources: {
      async create(record) {
        sources.push(record);
        return record;
      },
      async listByPack(input) {
        return sources.filter((r) => r.teamId === input.teamId && r.packId === input.packId);
      },
    },

    attachments: {
      async create(record) {
        attachments.set(record.id, record);
        return record;
      },
      async getByPackAndChannel(input) {
        const found = [...attachments.values()].find(
          (r) => r.teamId === input.teamId && r.packId === input.packId && r.channelId === input.channelId,
        );
        return found ?? null;
      },
      async listByChannel(input) {
        return [...attachments.values()]
          .filter((r) => r.teamId === input.teamId && r.channelId === input.channelId)
          .sort((a, b) => b.attachedAt - a.attachedAt);
      },
      async listByPack(input) {
        return [...attachments.values()]
          .filter((r) => r.teamId === input.teamId && r.packId === input.packId)
          .sort((a, b) => b.attachedAt - a.attachedAt);
      },
      async delete(input) {
        const found = [...attachments.entries()].find(
          ([, r]) => r.teamId === input.teamId && r.id === input.id,
        );
        if (found) attachments.delete(found[0]);
      },
    },
  };
}
