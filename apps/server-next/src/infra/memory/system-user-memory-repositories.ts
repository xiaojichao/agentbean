import type {
  SystemKnowledgeRecord,
  SystemKnowledgeRepository,
  UserMemoryRecord,
  UserMemoryRepository,
} from '../../application/system-user-memory-repositories.js';

/**
 * System Knowledge 与 User Memory 的 in-memory 实现（issue #717）。
 *
 * 用于 service 双后端 parity 测试（与 sqlite 实现对照）。Map 存储，不验证 SQL schema
 * ——schema 约束（如 owner_user_id = created_by_user_id）由 sqlite 后端测试覆盖。
 */
export function createInMemorySystemUserMemoryRepositories(): {
  readonly systemKnowledge: SystemKnowledgeRepository;
  readonly userMemory: UserMemoryRepository;
} {
  const systemKnowledgeStore = new Map<string, SystemKnowledgeRecord>();
  const userMemoryStore = new Map<string, UserMemoryRecord>();

  const systemKnowledge: SystemKnowledgeRepository = {
    async list() {
      return [...systemKnowledgeStore.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    },
    async getById({ id }) {
      return systemKnowledgeStore.get(id) ?? null;
    },
    async listByVersionFamily({ versionFamilyId }) {
      return [...systemKnowledgeStore.values()]
        .filter((record) => record.versionFamilyId === versionFamilyId)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    },
    async create(record) {
      systemKnowledgeStore.set(record.id, record);
      return record;
    },
    async markSuperseded({ id, supersededById, updatedAt }) {
      const current = systemKnowledgeStore.get(id);
      if (current) {
        systemKnowledgeStore.set(id, { ...current, supersededById, status: 'superseded', updatedAt });
      }
    },
    async markExpired({ id, changeReason, updatedAt }) {
      const current = systemKnowledgeStore.get(id);
      if (current) {
        systemKnowledgeStore.set(id, { ...current, status: 'expired', changeReason, updatedAt });
      }
    },
    async delete({ id }) {
      systemKnowledgeStore.delete(id);
    },
  };

  const userMemory: UserMemoryRepository = {
    async listByOwner({ ownerUserId }) {
      return [...userMemoryStore.values()]
        .filter((record) => record.ownerUserId === ownerUserId)
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    },
    async getById({ id }) {
      return userMemoryStore.get(id) ?? null;
    },
    async listByVersionFamily({ versionFamilyId }) {
      return [...userMemoryStore.values()]
        .filter((record) => record.versionFamilyId === versionFamilyId)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    },
    async create(record) {
      userMemoryStore.set(record.id, record);
      return record;
    },
    async markSuperseded({ id, supersededById, updatedAt }) {
      const current = userMemoryStore.get(id);
      if (current) {
        userMemoryStore.set(id, { ...current, supersededById, status: 'superseded', updatedAt });
      }
    },
    async markExpired({ id, changeReason, updatedAt }) {
      const current = userMemoryStore.get(id);
      if (current) {
        userMemoryStore.set(id, { ...current, status: 'expired', changeReason, updatedAt });
      }
    },
    async delete({ id }) {
      userMemoryStore.delete(id);
    },
  };

  return { systemKnowledge, userMemory };
}
