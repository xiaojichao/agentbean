import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyTeamMigrations, createSqliteRepositories, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

const baseTask = {
  id: 'task-1',
  teamId: 'team-1',
  title: 'original objective',
  status: 'todo' as const,
  creatorId: 'user-1',
  channelId: 'chan-1',
  tags: [],
  sortOrder: 0,
  createdAt: 1000,
  updatedAt: 1000,
};

describe.each([
  ['memory', () => ({ repositories: createInMemoryRepositories(), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { repositories: createSqliteRepositories({ globalDb: db, teamDb: db }), close: () => db.close() };
  }],
] as const)('Task immutable revisions (%s)', (_name, createFixture) => {
  test('updateAtRevision appends a new revision row and preserves the superseded row (AC4)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.tasks.create(baseTask);
      const updated = await fixture.repositories.tasks.updateAtRevision({
        taskId: 'task-1',
        expectedRevision: 1,
        nextRevision: 2,
        reasonCode: 'TASK_REVISED',
        changes: { title: 'revised objective', updatedAt: 2000 },
      });
      expect(updated).toMatchObject({
        id: 'task-1',
        revision: 2,
        title: 'revised objective',
        supersededByRevision: null,
      });

      // 当前行 = revision 2（getById 只返回 superseded_by_revision IS NULL 的行）
      await expect(fixture.repositories.tasks.getById('task-1')).resolves.toMatchObject({
        revision: 2,
        title: 'revised objective',
        supersededByRevision: null,
      });

      // 历史保留：listRevisions 返回两行，按 revision ASC
      const revisions = await fixture.repositories.tasks.listRevisions({ taskId: 'task-1', teamId: 'team-1' });
      expect(revisions).toHaveLength(2);
      expect(revisions[0]).toMatchObject({
        revision: 1,
        title: 'original objective',
        supersededByRevision: 2,
        supersededReasonCode: 'TASK_REVISED',
      });
      expect(revisions[1]).toMatchObject({ revision: 2, supersededByRevision: null });
    } finally {
      fixture.close();
    }
  });

  test('list returns only the current revision (superseded rows excluded)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.tasks.create(baseTask);
      await fixture.repositories.tasks.updateAtRevision({
        taskId: 'task-1',
        expectedRevision: 1,
        nextRevision: 2,
        changes: { updatedAt: 2000 },
      });
      const tasks = await fixture.repositories.tasks.list({
        teamId: 'team-1',
        channelIds: ['chan-1'],
        includeGlobal: false,
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ revision: 2 });
    } finally {
      fixture.close();
    }
  });

  test('repeated updateAtRevision with same expectedRevision is a no-op (idempotent, AC6)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.tasks.create(baseTask);
      const first = await fixture.repositories.tasks.updateAtRevision({
        taskId: 'task-1',
        expectedRevision: 1,
        nextRevision: 2,
        changes: { updatedAt: 2000 },
      });
      expect(first).not.toBeNull();
      // revision 1 行已 superseded，再以 expectedRevision=1 调用应返回 null（不重复修订/不重复历史）
      const replay = await fixture.repositories.tasks.updateAtRevision({
        taskId: 'task-1',
        expectedRevision: 1,
        nextRevision: 2,
        changes: { updatedAt: 3000 },
      });
      expect(replay).toBeNull();
      const revisions = await fixture.repositories.tasks.listRevisions({ taskId: 'task-1', teamId: 'team-1' });
      expect(revisions).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });

  test('update (non-revision path) mutates the current row in place without creating a revision', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.tasks.create(baseTask);
      const updated = await fixture.repositories.tasks.update({
        taskId: 'task-1',
        changes: { status: 'done', updatedAt: 2000 },
      });
      // 状态变化是原地改当前行，不触发新 revision（AC4：仅目标/范围/验收重大变化才 revision）
      expect(updated).toMatchObject({ revision: 1, status: 'done' });
      const revisions = await fixture.repositories.tasks.listRevisions({ taskId: 'task-1', teamId: 'team-1' });
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ revision: 1, status: 'done' });
    } finally {
      fixture.close();
    }
  });

  test('stale expectedRevision is rejected (optimistic lock)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.tasks.create(baseTask);
      await fixture.repositories.tasks.updateAtRevision({
        taskId: 'task-1',
        expectedRevision: 1,
        nextRevision: 2,
        changes: { updatedAt: 2000 },
      });
      // 当前行已是 revision 2，用 stale expectedRevision=1 应失败
      const stale = await fixture.repositories.tasks.updateAtRevision({
        taskId: 'task-1',
        expectedRevision: 1,
        nextRevision: 3,
        changes: { updatedAt: 3000 },
      });
      expect(stale).toBeNull();
      const revisions = await fixture.repositories.tasks.listRevisions({ taskId: 'task-1', teamId: 'team-1' });
      expect(revisions).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });
});
