import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyGlobalMigrations, applyTeamMigrations, createSqliteRepositories } from '../src/infra/sqlite/repositories.js';
import { createPushNotificationService } from '../src/application/push-notification-service.js';
import { parseBrowserSubscription, parseWebPushConfig, pushSubscriptionId } from '../src/infra/web-push.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach((fn) => fn()); });
function subscription() {
  const key = createECDH('prime256v1'); key.generateKeys();
  return { endpoint: 'https://fcm.googleapis.com/wp/test-' + randomBytes(8).toString('hex'),
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
async function seed(repos: ServerNextRepositories) {
  for (const id of ['user', 'other']) await repos.users.create({ id, username: id, passwordHash: 'test', role: 'user', createdAt: 1, updatedAt: 1 });
  await repos.teams.create({ id: 'team', path: 'project', name: '项目', ownerId: 'user', visibility: 'private', createdAt: 1 });
  await repos.teams.addMember({ teamId: 'team', userId: 'user', username: 'user', role: 'owner', joinedAt: 1 });
  await repos.channels.create({ id: 'channel', teamId: 'team', name: '项目', kind: 'channel', visibility: 'private',
    humanMemberIds: ['user'], agentMemberIds: [], createdAt: 1, updatedAt: 1 });
}
async function add(repos: ServerNextRepositories, id: string, time: number) {
  await repos.completionNotifications.enqueue({ id, teamId: 'team', taskId: null, dispatchId: null, revision: 1, createdAt: time, retryAt: 0 });
  await repos.completionNotifications.complete(id, [{ id, teamId: 'team', recipientId: 'user',
    kind: 'request_completed', title: '机密项目报告', channelId: 'channel', threadId: 'origin', messageId: 'reply', createdAt: time, readAt: null }]);
}
describe.each(['memory', 'sqlite'] as const)('Web Push %s', (variant) => {
  async function create() {
    if (variant === 'memory') return { repos: createInMemoryRepositories(), reopen: undefined };
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-push-'));
    const globalDb = new Database(join(dir, 'global.db'));
    let teamDb = new Database(join(dir, 'team.db'));
    applyGlobalMigrations(globalDb); applyTeamMigrations(teamDb);
    cleanups.push(() => { teamDb.close(); globalDb.close(); rmSync(dir, { recursive: true, force: true }); });
    return { repos: createSqliteRepositories({ globalDb, teamDb }), reopen() {
      teamDb.close(); teamDb = new Database(join(dir, 'team.db'));
      return createSqliteRepositories({ globalDb, teamDb });
    } };
  }
  test('持久化订阅与重试；不回放历史；不向其他用户推送；payload 不含任务正文', async () => {
    const fixture = await create();
    let repos = fixture.repos;
    await seed(repos);
    let now = 100;
    const send = vi.fn().mockRejectedValueOnce({ statusCode: 503 }).mockResolvedValue(undefined);
    let service = createPushNotificationService(repos, () => now, { publicKey: 'public', send });
    const sub = subscription();
    await add(repos, 'old', 50);
    expect(await service.subscribe({ userId: 'user', subscription: sub })).toEqual({ ok: true });
    expect(await service.subscribe({ userId: 'other', subscription: sub })).toMatchObject({ ok: false, error: 'SUBSCRIPTION_OWNED' });
    await add(repos, 'new', 101); now = 102;
    await service.process();
    expect(send).toHaveBeenCalledTimes(1);
    await service.process();
    expect(send).toHaveBeenCalledTimes(1);
    if (fixture.reopen) repos = fixture.reopen();
    service = createPushNotificationService(repos, () => now, { publicKey: 'public', send });
    now = 6000; await service.process(); await service.process();
    expect(send).toHaveBeenCalledTimes(2);
    const payload = send.mock.calls[1][1];
    expect(payload).toMatchObject({ id: 'new', recipientId: 'user' });
    expect(payload.url).toContain('/project/channel/channel?thread=channel%3Aorigin');
    expect(payload.url).toContain('notice=new');
    expect(JSON.stringify(payload)).not.toContain('机密');
  });
  test('未读与权限再次校验；410 移除订阅；退出的订阅不再投递', async () => {
    const { repos } = await create(); await seed(repos);
    let now = 100;
    const send = vi.fn().mockResolvedValue(undefined);
    const service = createPushNotificationService(repos, () => now, { publicKey: 'public', send });
    const sub = subscription();
    await service.subscribe({ userId: 'user', subscription: sub });
    await add(repos, 'read', 101);
    await repos.completionNotifications.markRead('team', 'user', 'read', 102);
    now = 103; await service.process(); expect(send).not.toHaveBeenCalled();
    await add(repos, 'revoked', 104);
    await repos.channels.update({ channelId: 'channel', changes: { humanMemberIds: [] } });
    now = 105; await service.process(); expect(send).not.toHaveBeenCalled();
    await repos.channels.update({ channelId: 'channel', changes: { humanMemberIds: ['user'] } });
    await add(repos, 'expired', 106);
    send.mockRejectedValueOnce({ statusCode: 410 });
    now = 107; await service.process();
    expect(await repos.completionNotifications.getPushSubscription(pushSubscriptionId(sub.endpoint))).toBeNull();
    const another = subscription();
    await service.subscribe({ userId: 'user', subscription: another });
    await service.unsubscribe({ userId: 'other', endpoint: another.endpoint });
    expect(await repos.completionNotifications.getPushSubscription(pushSubscriptionId(another.endpoint))).not.toBeNull();
    await service.unsubscribe({ userId: 'user', endpoint: another.endpoint });
    await add(repos, 'after-logout', 108);
    now = 109; await service.process();
    expect(send).toHaveBeenCalledTimes(1);
  });
  test('预留避免并发重复，崩溃租约到期后可继续，最多五次', async () => {
    const { repos } = await create(); await seed(repos);
    const sub = subscription();
    const service = createPushNotificationService(repos, () => 100, { publicKey: 'public', send: vi.fn() });
    await service.subscribe({ userId: 'user', subscription: sub });
    await add(repos, 'claim', 101);
    const store = repos.completionNotifications;
    expect(await store.claimPush(102, 10)).toHaveLength(1);
    expect(await store.claimPush(103, 10)).toHaveLength(0);
    for (let i = 1; i < 5; i++) expect(await store.claimPush(102 + 60_000 * i, 10)).toHaveLength(1);
    expect(await store.claimPush(400_000, 10)).toHaveLength(0);
  });
  test('20 个端点过期后可重新订阅；清理投递记录且事务失败能回滚', async () => {
    const { repos } = await create(); await seed(repos);
    let now = 100;
    const service = createPushNotificationService(repos, () => now, { publicKey: 'public', send: vi.fn() });
    const subs = Array.from({ length: 20 }, () => ({ ...subscription(), expirationTime: 200 }));
    for (const sub of subs) expect((await service.subscribe({ userId: 'user', subscription: sub })).ok).toBe(true);
    expect(await service.subscribe({ userId: 'user', subscription: subscription() })).toMatchObject({ error: 'SUBSCRIPTION_LIMIT' });
    await add(repos, 'pending', 101);
    const store = repos.completionNotifications;
    expect(await store.claimPush(102, 20)).toHaveLength(20);
    await expect(repos.taskCoordinationUnitOfWork.run(async () => {
      await store.prunePushSubscriptions('user', 200);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await store.countPushSubscriptions('user')).toBe(20);
    expect(await store.claimPush(103, 20)).toHaveLength(0);
    now = 200;
    expect(await service.subscribe({ userId: 'user', subscription: subscription() })).toEqual({ ok: true });
    expect(await store.countPushSubscriptions('user')).toBe(1);
    // 用同一端点重新建立测试订阅，旧的预留记录必须已删除。
    await store.savePushSubscription({ id: pushSubscriptionId(subs[0].endpoint), userId: 'user', endpoint: subs[0].endpoint,
      keys: subs[0].keys, createdAt: 100, expiresAt: 500 });
    expect(await store.claimPush(201, 20)).toMatchObject([{ notification: { id: 'pending' }, attempts: 1 }]);
  });
  test('大量历史下投递按 ID 查找，目标不在首页也能发送', async () => {
    const { repos } = await create(); await seed(repos);
    let now = 100;
    const send = vi.fn().mockResolvedValue(undefined);
    const service = createPushNotificationService(repos, () => now, { publicKey: 'public', send });
    await service.subscribe({ userId: 'user', subscription: subscription() });
    for (let i = 0; i < 120; i++) await add(repos, 'notice-' + i, 101 + i);
    const list = vi.spyOn(repos.completionNotifications, 'list').mockRejectedValue(new Error('禁止全量列表'));
    now = 300; await service.process();
    expect(send).toHaveBeenCalledTimes(10);
    expect(send.mock.calls[0][1]).toMatchObject({ id: 'notice-0' });
    expect(list).not.toHaveBeenCalled();
  });
});
test('推送地址拒绝 SSRF 和恶意 key；配置不泄露密钥且拒绝不完整配置', () => {
  const sub = subscription();
  expect(parseBrowserSubscription(sub)).not.toBeNull();
  expect(parseBrowserSubscription({ ...sub, endpoint: 'https://jmt17.google.com/fcm/send/test' })).not.toBeNull();
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x',
    'https://jmt17.google.com.evil.test/x', 'https://arbitrary.google.com/x',
    'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x']) {
    expect(parseBrowserSubscription({ ...sub, endpoint })).toBeNull();
  }
  expect(parseBrowserSubscription({ ...sub, keys: { p256dh: 'A'.repeat(87), auth: sub.keys.auth } })).toBeNull();
  expect(parseWebPushConfig({})).toBeUndefined();
  expect(() => parseWebPushConfig({ AGENTBEAN_WEB_PUSH_PRIVATE_KEY: 'secret-do-not-log' })).toThrow('configuration');
  const key = createECDH('prime256v1'); key.generateKeys();
  const config = { AGENTBEAN_WEB_PUSH_PUBLIC_KEY: key.getPublicKey().toString('base64url'),
    AGENTBEAN_WEB_PUSH_PRIVATE_KEY: key.getPrivateKey().toString('base64url'), AGENTBEAN_WEB_PUSH_SUBJECT: 'mailto:ops@example.com' };
  expect(parseWebPushConfig(config)?.publicKey).toBe(config.AGENTBEAN_WEB_PUSH_PUBLIC_KEY);
});
