import { afterEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyGlobalMigrations, applyTeamMigrations, createSqliteRepositories } from '../src/infra/sqlite/repositories.js';
import { createCompletionNotificationService } from '../src/application/completion-notification-service.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type { CompletionNotificationCursor } from '../../../packages/contracts/src/completion-notification.js';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach((close) => close()); });

async function seed(repos: ServerNextRepositories) {
  for (const id of ['user', 'other']) await repos.users.create({
    id, username: id, passwordHash: 'test-only', role: 'user', createdAt: 1, updatedAt: 1,
  });
  await repos.teams.create({ id: 'team', name: '测试', path: 'test', visibility: 'private', ownerId: 'user', createdAt: 1 });
  await repos.teams.addMember({ teamId: 'team', userId: 'user', username: 'user', role: 'owner', joinedAt: 1 });
  await repos.teams.addMember({ teamId: 'team', userId: 'other', username: 'other', role: 'member', joinedAt: 1 });
  await repos.channels.create({ id: 'channel', teamId: 'team', name: '项目', kind: 'channel', visibility: 'private',
    humanMemberIds: ['user', 'other'], agentMemberIds: [], createdAt: 1, updatedAt: 1 });
  await repos.tasks.create({ id: 'task', teamId: 'team', channelId: 'channel', creatorId: 'user',
    title: '生成报告', status: 'in_progress', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
}

describe('任务交付提醒', () => {
  test('发起人获得一条提醒；重放不重复；已读不验收；新交付重新未读', async () => {
    const repos = createInMemoryRepositories();
    await seed(repos);
    const service = createCompletionNotificationService(repos, () => 100);
    await repos.tasks.update({ taskId: 'task', changes: { status: 'in_review', updatedAt: 2 } });
    expect(await service.process()).toEqual([{ teamId: 'team', recipientId: 'user' }]);
    expect(await service.process()).toEqual([]);
    expect((await service.list({ teamId: 'team', userId: 'other' })).items).toEqual([]);
    const inbox = await service.list({ teamId: 'team', userId: 'user' });
    expect(inbox.unreadCount).toBe(1);
    const id = inbox.items![0].id;
    expect((await service.markRead({ teamId: 'team', userId: 'other', id })).ok).toBe(false);
    await service.markRead({ teamId: 'team', userId: 'user', id });
    expect((await service.list({ teamId: 'team', userId: 'user' })).unreadCount).toBe(0);
    expect((await repos.tasks.getById('task'))?.status).toBe('in_review');
    await repos.tasks.updateAtRevision({ taskId: 'task', expectedRevision: 1, nextRevision: 2,
      changes: { status: 'in_progress', updatedAt: 3 } });
    await repos.tasks.update({ taskId: 'task', changes: { status: 'in_review', updatedAt: 4 } });
    await service.process();
    expect((await service.list({ teamId: 'team', userId: 'user' })).unreadCount).toBe(1);
  });

  test('事务回滚不留下提醒源；失败源可恢复；撤销频道权限立即不可读', async () => {
    const repos = createInMemoryRepositories();
    await seed(repos);
    const service = createCompletionNotificationService(repos, () => 10_000);
    await expect(repos.taskCoordinationUnitOfWork.run(async (tx) => {
      await tx.tasks.update({ taskId: 'task', changes: { status: 'in_review', updatedAt: 2 } });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await repos.completionNotifications.pending(10_000, 100)).toEqual([]);
    await repos.tasks.update({ taskId: 'task', changes: { status: 'in_review', updatedAt: 3 } });
    const failure = vi.spyOn(repos.completionNotifications, 'complete').mockRejectedValueOnce(new Error('offline'));
    expect(await service.process()).toEqual([]);
    failure.mockRestore();
    await createCompletionNotificationService(repos, () => 20_000).process();
    expect((await service.list({ teamId: 'team', userId: 'user' })).unreadCount).toBe(1);
    await repos.channels.update({ channelId: 'channel', changes: { humanMemberIds: ['other'] } });
    expect((await service.list({ teamId: 'team', userId: 'user' })).items).toEqual([]);
    await repos.teams.removeMember({ teamId: 'team', userId: 'user' });
    expect((await service.list({ teamId: 'team', userId: 'user' })).ok).toBe(false);
  });

  test('直接请求只在最终回复提交后提醒；进度与失败不冒充完成', async () => {
    const repos = createInMemoryRepositories();
    await seed(repos);
    await repos.messages.append({ id: 'origin', teamId: 'team', channelId: 'channel',
      senderId: 'user', senderKind: 'human', body: '分析数据', createdAt: 1 });
    await repos.dispatches.create({ id: 'dispatch', teamId: 'team', channelId: 'channel',
      messageId: 'origin', agentId: 'agent', status: 'running', requestId: 'request', prompt: '分析', createdAt: 1, updatedAt: 1 });
    await repos.messages.append({ id: 'reply', teamId: 'team', channelId: 'channel',
      senderId: 'agent', senderKind: 'agent', body: '完成', createdAt: 3, meta: { dispatchId: 'dispatch' } });
    const service = createCompletionNotificationService(repos, () => 100);
    await repos.dispatches.markSucceeded({ dispatchId: 'dispatch', completedAt: 3 });
    expect(await service.process()).toEqual([]);
    await repos.messages.updateMeta({ messageId: 'reply', meta: { dispatchId: 'dispatch', completionNotificationReady: true } });
    await service.process();
    const inbox = await service.list({ teamId: 'team', userId: 'user' });
    expect(inbox.items).toMatchObject([{ kind: 'request_completed', messageId: 'reply', threadId: 'origin' }]);
  });

  test('SQLite：状态与待投递源原子提交，重启前后投递及已读均保持', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'completion-notifications-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const globalDb = new Database(join(dir, 'global.db'));
    let teamDb = new Database(join(dir, 'team.db'));
    cleanups.push(() => { teamDb.close(); globalDb.close(); });
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    let repos = createSqliteRepositories({ globalDb, teamDb });
    await seed(repos);
    await expect(repos.taskCoordinationUnitOfWork.run(async (tx) => {
      await tx.tasks.update({ taskId: 'task', changes: { status: 'in_review', updatedAt: 2 } });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await repos.completionNotifications.pending(100, 100)).toEqual([]);
    await repos.tasks.update({ taskId: 'task', changes: { status: 'in_review', updatedAt: 3 } });
    teamDb.close();
    teamDb = new Database(join(dir, 'team.db'));
    repos = createSqliteRepositories({ globalDb, teamDb });
    const service = createCompletionNotificationService(repos, () => 100);
    await service.process();
    const inbox = await service.list({ teamId: 'team', userId: 'user' });
    expect(inbox.unreadCount).toBe(1);
    await service.markRead({ teamId: 'team', userId: 'user', id: inbox.items![0].id });
    teamDb.close();
    teamDb = new Database(join(dir, 'team.db'));
    const restarted = createCompletionNotificationService(createSqliteRepositories({ globalDb, teamDb }), () => 200);
    expect(await restarted.process()).toEqual([]);
    expect((await restarted.list({ teamId: 'team', userId: 'user' })).unreadCount).toBe(0);
  });
});

describe.each(['memory', 'sqlite'] as const)('提醒历史与分页 %s', (variant) => {
  async function create() {
    if (variant === 'memory') return createInMemoryRepositories();
    const dir = mkdtempSync(join(tmpdir(), 'completion-pages-'));
    const globalDb = new Database(join(dir, 'global.db')); const teamDb = new Database(join(dir, 'team.db'));
    applyGlobalMigrations(globalDb); applyTeamMigrations(teamDb);
    cleanups.push(() => { teamDb.close(); globalDb.close(); rmSync(dir, { recursive: true, force: true }); });
    return createSqliteRepositories({ globalDb, teamDb });
  }
  test('千条未读按稳定游标读取，全量角标不截断，同范围只校验一次；页外精确已读', async () => {
    const repos = await create(); await seed(repos);
    const store = repos.completionNotifications;
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: 'n-' + String(i).padStart(4, '0'),
      teamId: 'team', recipientId: 'user', kind: 'request_completed' as const, title: '结果', channelId: 'channel',
      createdAt: 100, readAt: null }));
    await store.complete('bulk', rows);
    const service = createCompletionNotificationService(repos, () => 1000);
    const channelReads = vi.spyOn(repos.channels, 'getById');
    const first = await service.list({ teamId: 'team', userId: 'user' });
    expect(first.items).toHaveLength(50); expect(first.unreadCount).toBe(1000);
    expect(channelReads).toHaveBeenCalledTimes(1);
    expect((await store.list('team', 'user')).length).toBe(51);
    const seen = first.items!.map((item) => item.id);
    let cursor: CompletionNotificationCursor | null | undefined = first.nextCursor;
    // 新提醒插入首页，不使后续游标出现重复或漏项。
    await store.complete('later', [{ ...rows[0], id: 'later', createdAt: 101 }]);
    while (cursor) {
      const page = await service.list({ teamId: 'team', userId: 'user', cursor });
      seen.push(...page.items!.map((item) => item.id)); cursor = page.nextCursor;
    }
    expect(seen).toEqual(rows.map((row) => row.id));
    const list = vi.spyOn(store, 'list').mockRejectedValue(new Error('禁止全量查找'));
    expect(await service.markRead({ teamId: 'team', userId: 'user', id: 'n-0999' })).toEqual({ ok: true });
    expect(list).not.toHaveBeenCalled(); list.mockRestore();
    expect((await service.list({ teamId: 'team', userId: 'user' })).unreadCount).toBe(1000);
    await repos.channels.update({ channelId: 'channel', changes: { humanMemberIds: ['other'] } });
    expect(await service.get({ teamId: 'team', userId: 'user', id: 'n-0998' })).toBeNull();
    const denied = await service.list({ teamId: 'team', userId: 'user' });
    expect(denied.items).toEqual([]); expect(denied.unreadCount).toBe(0);
    expect(await service.markRead({ teamId: 'team', userId: 'other', id: 'n-0998' })).toMatchObject({ ok: false });
    expect(await service.list({ teamId: 'team', userId: 'user', cursor: { id: '', createdAt: NaN } })).toMatchObject({ error: 'INVALID_CURSOR' });
  });
  test('已读保留最近30天最多100条，未读永久保留，清理不重放来源或越过用户范围', async () => {
    const repos = await create(); await seed(repos);
    const store = repos.completionNotifications;
    const now = 40 * 86400_000;
    const rows = Array.from({ length: 130 }, (_, i) => ({ id: 'read-' + i, teamId: 'team', recipientId: 'user',
      kind: 'request_completed' as const, title: '结果', createdAt: i, readAt: now - i }));
    await store.enqueue({ id: 'history', teamId: 'team', taskId: null, dispatchId: null, revision: 1, createdAt: 1, retryAt: 0 });
    await store.complete('history', [...rows,
      { ...rows[0], id: 'expired', readAt: 1 }, { ...rows[0], id: 'unread', readAt: null },
      { ...rows[0], id: 'other', recipientId: 'other', readAt: 1 }]);
    await store.pruneRead('team', 'user', now);
    expect(await store.get('team', 'user', 'read-99')).not.toBeNull();
    expect(await store.get('team', 'user', 'read-100')).toBeNull();
    expect(await store.get('team', 'user', 'expired')).toBeNull();
    expect(await store.get('team', 'user', 'unread')).not.toBeNull();
    expect(await store.get('team', 'other', 'other')).not.toBeNull();
    await store.enqueue({ id: 'history', teamId: 'team', taskId: null, dispatchId: null, revision: 1, createdAt: 1, retryAt: 0 });
    expect(await store.pending(now, 100)).toEqual([]);
    expect(await store.get('team', 'user', 'expired')).toBeNull();
    await store.pruneRead('team', 'user', now + 31 * 86400_000);
    expect((await store.list('team', 'user')).map((row) => row.id)).toEqual(['unread']);
  });
});
