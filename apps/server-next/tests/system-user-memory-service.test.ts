import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type { ServerNextRepositories } from '../src/index.js';
import { createSystemUserMemoryService } from '../src/application/system-user-memory-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly service: ReturnType<typeof createSystemUserMemoryService>;
  readonly close(): void;
}

function makeHarness(repositories: ServerNextRepositories): Harness {
  let tick = 1_000;
  const clock = { now: () => (tick += 1_000) };
  const service = createSystemUserMemoryService({ repositories, clock });
  return { repositories, service, close() {} };
}

function insertUser(db: SqliteDatabase, id: string, role: 'admin' | 'user'): void {
  db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, id, 'hash', role, 1, 1);
}

describe.each([
  ['memory', () => makeHarness(createInMemoryRepositories())],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(db);
    applyTeamMigrations(db);
    insertUser(db, 'admin-1', 'admin');
    insertUser(db, 'user-1', 'user');
    insertUser(db, 'user-2', 'user');
    const harness = makeHarness(createSqliteRepositories({ globalDb: db, teamDb: db }));
    return { ...harness, close: () => db.close() };
  }],
] as const)('System/User Memory Service (%s)', (_name, createHarness) => {
  test('System Knowledge create/list/detail; version family rooted at self id', async () => {
    const harness = createHarness();
    try {
      const created = await harness.service.createSystemKnowledge({
        actorId: 'admin-1', kind: 'rule', content: '所有 dispatch 先持久化 Message', changeReason: '初版',
      });
      expect(created.scope).toBe('system');
      expect(created.status).toBe('active');
      expect(created.versionFamilyId).toBe(created.id);

      const list = await harness.service.listSystemKnowledge();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(created.id);

      const detail = await harness.service.getSystemKnowledgeDetail({ id: created.id });
      expect(detail.versions).toHaveLength(1);
      expect(detail.versions[0]!.versionId).toBe(created.id);
    } finally {
      harness.close();
    }
  });

  test('System Knowledge revise creates new active version and supersedes the old', async () => {
    const harness = createHarness();
    try {
      const v1 = await harness.service.createSystemKnowledge({
        actorId: 'admin-1', kind: 'rule', content: 'v1', changeReason: '初版',
      });
      const v2 = await harness.service.reviseSystemKnowledge({
        actorId: 'admin-1', memoryId: v1.id, content: 'v2', changeReason: '补充例外',
      });
      expect(v2.status).toBe('active');
      expect(v2.versionFamilyId).toBe(v1.versionFamilyId); // 继承家族根
      expect(v2.id).not.toBe(v1.id);

      const detail = await harness.service.getSystemKnowledgeDetail({ id: v2.id });
      expect(detail.versions).toHaveLength(2);
      expect(detail.versions.map((v) => v.status)).toContain('superseded');
      expect(detail.versions.map((v) => v.content)).toEqual(['v1', 'v2']);

      // 已 superseded 的版本不能再次 revise。
      await expect(harness.service.reviseSystemKnowledge({
        actorId: 'admin-1', memoryId: v1.id, content: 'v3', changeReason: 'x',
      })).rejects.toThrow('SYSTEM_KNOWLEDGE_ALREADY_SUPERSEDED');
    } finally {
      harness.close();
    }
  });

  test('System Knowledge deactivate marks expired with reason; delete removes', async () => {
    const harness = createHarness();
    try {
      const created = await harness.service.createSystemKnowledge({
        actorId: 'admin-1', kind: 'fact', content: '过时事实', changeReason: '初版',
      });
      const deactivated = await harness.service.deactivateSystemKnowledge({
        actorId: 'admin-1', memoryId: created.id, changeReason: '不再适用',
      });
      expect(deactivated.status).toBe('expired');
      expect(deactivated.changeReason).toBe('不再适用');

      await harness.service.deleteSystemKnowledge({ actorId: 'admin-1', memoryId: created.id });
      await expect(harness.service.getSystemKnowledgeDetail({ id: created.id }))
        .rejects.toThrow('SYSTEM_KNOWLEDGE_NOT_FOUND');
    } finally {
      harness.close();
    }
  });

  test('User Memory is owned by its creator and isolated per owner (AC#3/AC#5)', async () => {
    const harness = createHarness();
    try {
      const u1 = await harness.service.createUserMemory({
        actorId: 'user-1', kind: 'preference', content: '回复尽量简洁',
      });
      expect(u1.scope).toBe('user');
      expect(u1.ownerUserId).toBe('user-1');

      // user-2 看不到 user-1 的 User Memory（AC#5 物理隔离按 owner 过滤）。
      const user2List = await harness.service.listUserMemory({ ownerUserId: 'user-2' });
      expect(user2List).toHaveLength(0);
      const user1List = await harness.service.listUserMemory({ ownerUserId: 'user-1' });
      expect(user1List).toHaveLength(1);

      // revise 保持 owner 不变（AC#6：仅本人）。
      const revised = await harness.service.reviseUserMemory({
        actorId: 'user-1', memoryId: u1.id, content: '回复尽量简洁，用要点', changeReason: '细化',
      });
      expect(revised.ownerUserId).toBe('user-1');
    } finally {
      harness.close();
    }
  });

  test('System Knowledge create accepts no automatic sources (AC#2 by interface design)', async () => {
    const harness = createHarness();
    try {
      // createSystemKnowledge 入参只有人工字段（kind/content/summary/changeReason/validUntil），
      // 无 message/task/agent sourceRefs —— 频道消息/Agent 结果/PI 推断无写入通路。
      const created = await harness.service.createSystemKnowledge({
        actorId: 'admin-1', kind: 'decision', content: '产品决策', summary: '摘要',
      });
      expect(created.content).toBe('产品决策');
    } finally {
      harness.close();
    }
  });

  test('operations on missing ids fail closed', async () => {
    const harness = createHarness();
    try {
      await expect(harness.service.getSystemKnowledgeDetail({ id: 'missing' })).rejects.toThrow('SYSTEM_KNOWLEDGE_NOT_FOUND');
      await expect(harness.service.reviseSystemKnowledge({
        actorId: 'admin-1', memoryId: 'missing', content: 'x', changeReason: 'x',
      })).rejects.toThrow('SYSTEM_KNOWLEDGE_NOT_FOUND');
      await expect(harness.service.getUserMemoryDetail({ id: 'missing' })).rejects.toThrow('USER_MEMORY_NOT_FOUND');
    } finally {
      harness.close();
    }
  });
});

// sqlite 专属：验证 DB 层 CHECK 约束（AC#3/AC#6 物理双保险）。
describe('System/User Memory sqlite CHECK constraints', () => {
  test('user_memory_items rejects owner_user_id != created_by_user_id (AC#6 physical guard)', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(db);
    applyTeamMigrations(db);
    insertUser(db, 'user-1', 'user');
    insertUser(db, 'user-2', 'user');
    try {
      // 直接 SQL 试图插入 owner != creator —— DB CHECK 必须拒绝。
      expect(() => db.prepare(`INSERT INTO user_memory_items
        (id, owner_user_id, kind, status, content, version_family_id, created_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('um-x', 'user-2', 'preference', 'active', '越权', 'um-x', 'user-1', 1, 1))
        .toThrow();
    } finally {
      db.close();
    }
  });
});
