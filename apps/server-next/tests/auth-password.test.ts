import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';
import { isLegacyHash } from '../src/application/password';

/** 构造一个 app + 内存 repository 的组合，便于直接操作 repo 制造遗留数据。 */
function createApp() {
  const repositories = createInMemoryRepositories();
  let n = 0;
  const ids = { nextId: () => `id-${++n}` };
  const clock = { now: () => 1000 };
  return { app: createServerNextUseCases({ repositories, clock, ids }), repositories };
}

/** 模拟旧版 server-next 的裸 SHA256 哈希（无 salt）。 */
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 注册一个用户，返回带 userId 的上下文。 */
async function register(username: string, password: string) {
  const ctx = createApp();
  const res = await ctx.app.registerUser({ username, password });
  if (!res.ok) throw new Error(`register ${username} failed: ${JSON.stringify(res)}`);
  return { ...ctx, userId: res.user.id };
}

describe('auth: scrypt 哈希 + lazy migration + change-password', () => {
  test('register 存储的是 scrypt 哈希（含 ":"，非裸 SHA256）', async () => {
    const { repositories, userId } = await register('alice', 'pw-alice');
    const user = await repositories.users.getById(userId);
    expect(user?.passwordHash).toMatch(/:/);
    expect(isLegacyHash(user!.passwordHash)).toBe(false);
  });

  test('login 用 scrypt 密码成功', async () => {
    const { app } = await register('bob', 'pw-bob');
    const res = await app.loginUser({ username: 'bob', password: 'pw-bob' });
    expect(res.ok).toBe(true);
  });

  test('login 密码错误失败', async () => {
    const { app } = await register('carol', 'pw-carol');
    const res = await app.loginUser({ username: 'carol', password: 'wrong' });
    expect(res.ok).toBe(false);
  });

  test('login 把遗留 SHA256 哈希无感升级为 scrypt（lazy migration）', async () => {
    const { app, repositories, userId } = await register('dave', 'pw-dave');
    // 模拟遗留数据：直接把哈希改成裸 SHA256
    await repositories.users.updatePassword({ userId, passwordHash: sha256('legacy-pw'), updatedAt: 2000 });
    expect(isLegacyHash((await repositories.users.getById(userId))!.passwordHash)).toBe(true);

    // 用遗留密码登录 → 应成功并触发升级
    const res = await app.loginUser({ username: 'dave', password: 'legacy-pw' });
    expect(res.ok).toBe(true);

    const after = await repositories.users.getById(userId);
    expect(isLegacyHash(after!.passwordHash)).toBe(false);
    expect(after!.passwordHash).toMatch(/:/);
  });

  test('changePassword 当前密码错误则失败', async () => {
    const { app, userId } = await register('eve', 'pw-eve');
    const res = await app.changePassword({ userId, currentPassword: 'wrong', newPassword: 'newpw123' });
    expect(res.ok).toBe(false);
  });

  test('changePassword 新密码不足 6 位则失败', async () => {
    const { app, userId } = await register('frank', 'pw-frank');
    const res = await app.changePassword({ userId, currentPassword: 'pw-frank', newPassword: '12345' });
    expect(res.ok).toBe(false);
  });

  test('changePassword 成功后旧密码失效、新密码可用', async () => {
    const { app, userId } = await register('grace', 'pw-grace');
    const res = await app.changePassword({ userId, currentPassword: 'pw-grace', newPassword: 'newpw789' });
    expect(res.ok).toBe(true);

    expect((await app.loginUser({ username: 'grace', password: 'pw-grace' })).ok).toBe(false);
    expect((await app.loginUser({ username: 'grace', password: 'newpw789' })).ok).toBe(true);
  });

  test('changePassword 接受遗留 SHA256 当前密码（lazy 校验，改完升级为 scrypt）', async () => {
    const { app, repositories, userId } = await register('heidi', 'pw-heidi');
    await repositories.users.updatePassword({ userId, passwordHash: sha256('legacy-pw'), updatedAt: 2000 });

    const res = await app.changePassword({ userId, currentPassword: 'legacy-pw', newPassword: 'newpw000' });
    expect(res.ok).toBe(true);

    const login = await app.loginUser({ username: 'heidi', password: 'newpw000' });
    expect(login.ok).toBe(true);
    expect(isLegacyHash((await repositories.users.getById(userId))!.passwordHash)).toBe(false);
  });
});
