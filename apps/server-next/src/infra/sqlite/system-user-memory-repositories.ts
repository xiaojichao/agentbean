import type {
  SystemKnowledgeRecord,
  SystemKnowledgeRepository,
  UserMemoryRecord,
  UserMemoryRepository,
} from '../../application/system-user-memory-repositories.js';
import type { SqliteDatabase } from './repositories.js';

/**
 * System Knowledge 与 User Memory 的 sqlite 实现（Global DB，issue #717）。
 *
 * 与 Team DB 的 memory_items 物理隔离：读写仅触碰 system_knowledge_items /
 * user_memory_items 两张表，读路径不交叉 Team Memory（AC#5）。
 */
export function createSqliteSystemUserMemoryRepositories(db: SqliteDatabase): {
  readonly systemKnowledge: SystemKnowledgeRepository;
  readonly userMemory: UserMemoryRepository;
} {
  const systemKnowledge: SystemKnowledgeRepository = {
    async list() {
      return db.prepare('SELECT * FROM system_knowledge_items ORDER BY updated_at DESC, id')
        .all().map(mapSystemKnowledgeRequired);
    },
    async getById({ id }) {
      return mapSystemKnowledge(db.prepare('SELECT * FROM system_knowledge_items WHERE id = ?').get(id));
    },
    async listByVersionFamily({ versionFamilyId }) {
      return db.prepare('SELECT * FROM system_knowledge_items WHERE version_family_id = ? ORDER BY created_at ASC, id')
        .all(versionFamilyId).map(mapSystemKnowledgeRequired);
    },
    async create(record) {
      insertSystemKnowledge(db, record);
      return record;
    },
    async markSuperseded({ id, supersededById, updatedAt }) {
      db.prepare(`UPDATE system_knowledge_items
        SET superseded_by_id = ?, status = 'superseded', updated_at = ? WHERE id = ?`)
        .run(supersededById, updatedAt, id);
    },
    async markExpired({ id, changeReason, updatedAt }) {
      db.prepare(`UPDATE system_knowledge_items
        SET status = 'expired', change_reason = ?, updated_at = ? WHERE id = ?`)
        .run(changeReason, updatedAt, id);
    },
    async delete({ id }) {
      db.prepare('DELETE FROM system_knowledge_items WHERE id = ?').run(id);
    },
  };

  const userMemory: UserMemoryRepository = {
    async listByOwner({ ownerUserId }) {
      return db.prepare('SELECT * FROM user_memory_items WHERE owner_user_id = ? ORDER BY updated_at DESC, id')
        .all(ownerUserId).map(mapUserMemoryRequired);
    },
    async getById({ id }) {
      return mapUserMemory(db.prepare('SELECT * FROM user_memory_items WHERE id = ?').get(id));
    },
    async listByVersionFamily({ versionFamilyId }) {
      return db.prepare('SELECT * FROM user_memory_items WHERE version_family_id = ? ORDER BY created_at ASC, id')
        .all(versionFamilyId).map(mapUserMemoryRequired);
    },
    async create(record) {
      insertUserMemory(db, record);
      return record;
    },
    async markSuperseded({ id, supersededById, updatedAt }) {
      db.prepare(`UPDATE user_memory_items
        SET superseded_by_id = ?, status = 'superseded', updated_at = ? WHERE id = ?`)
        .run(supersededById, updatedAt, id);
    },
    async markExpired({ id, changeReason, updatedAt }) {
      db.prepare(`UPDATE user_memory_items
        SET status = 'expired', change_reason = ?, updated_at = ? WHERE id = ?`)
        .run(changeReason, updatedAt, id);
    },
    async delete({ id }) {
      db.prepare('DELETE FROM user_memory_items WHERE id = ?').run(id);
    },
  };

  return { systemKnowledge, userMemory };
}

function insertSystemKnowledge(db: SqliteDatabase, record: SystemKnowledgeRecord): void {
  db.prepare(`INSERT INTO system_knowledge_items
    (id, kind, status, content, summary, change_reason, version_family_id, superseded_by_id,
     created_by_user_id, valid_from, valid_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(record.id, record.kind, record.status, record.content, record.summary ?? null,
      record.changeReason ?? null, record.versionFamilyId, record.supersededById ?? null,
      record.createdByUserId, record.validFrom ?? null, record.validUntil ?? null,
      record.createdAt, record.updatedAt);
}

function insertUserMemory(db: SqliteDatabase, record: UserMemoryRecord): void {
  db.prepare(`INSERT INTO user_memory_items
    (id, owner_user_id, kind, status, content, summary, change_reason, version_family_id,
     superseded_by_id, created_by_user_id, valid_from, valid_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(record.id, record.ownerUserId, record.kind, record.status, record.content,
      record.summary ?? null, record.changeReason ?? null, record.versionFamilyId,
      record.supersededById ?? null, record.createdByUserId, record.validFrom ?? null,
      record.validUntil ?? null, record.createdAt, record.updatedAt);
}

function mapSystemKnowledge(value: unknown): SystemKnowledgeRecord | null {
  if (!value) return null;
  return mapSystemKnowledgeRequired(value);
}

function mapSystemKnowledgeRequired(value: unknown): SystemKnowledgeRecord {
  return {
    id: text(value, 'id'),
    kind: text(value, 'kind') as SystemKnowledgeRecord['kind'],
    status: text(value, 'status') as SystemKnowledgeRecord['status'],
    content: text(value, 'content'),
    summary: optionalText(value, 'summary'),
    changeReason: optionalText(value, 'change_reason'),
    versionFamilyId: text(value, 'version_family_id'),
    supersededById: optionalText(value, 'superseded_by_id'),
    createdByUserId: text(value, 'created_by_user_id'),
    validFrom: optionalNumber(value, 'valid_from'),
    validUntil: optionalNumber(value, 'valid_until'),
    createdAt: number(value, 'created_at'),
    updatedAt: number(value, 'updated_at'),
  };
}

function mapUserMemory(value: unknown): UserMemoryRecord | null {
  if (!value) return null;
  return mapUserMemoryRequired(value);
}

function mapUserMemoryRequired(value: unknown): UserMemoryRecord {
  return {
    ...mapSystemKnowledgeRequired(value),
    ownerUserId: text(value, 'owner_user_id'),
  };
}

function row(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function text(value: unknown, key: string): string {
  const result = row(value)[key];
  if (typeof result !== 'string') throw new Error(`Invalid system/user memory ${key}`);
  return result;
}

function optionalText(value: unknown, key: string): string | undefined {
  const result = row(value)[key];
  if (result === null || result === undefined) return undefined;
  if (typeof result !== 'string') throw new Error(`Invalid system/user memory ${key}`);
  return result;
}

function number(value: unknown, key: string): number {
  const result = row(value)[key];
  if (typeof result !== 'number') throw new Error(`Invalid system/user memory ${key}`);
  return result;
}

function optionalNumber(value: unknown, key: string): number | undefined {
  const result = row(value)[key];
  if (result === null || result === undefined) return undefined;
  if (typeof result !== 'number') throw new Error(`Invalid system/user memory ${key}`);
  return result;
}
