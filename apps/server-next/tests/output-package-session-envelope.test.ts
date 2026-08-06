import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { createServerNextUseCases } from '../src/application/usecases.js';

/**
 * #1 回归：socket bind 层 `withAuthenticatedUserId` 对每个已认证 payload 无条件注入
 * `currentDeviceId`（设备态需要）。OutputPackage 查询 handler 用 `parseOutputPackageQueryInputV1`
 * 做 exact-key 严格校验，必须把 `currentDeviceId` 与 userId/teamId 一同剥离，否则
 * `assertExactKeys` 拒绝未知字段 → 抛 OUTPUT_PACKAGE_PAYLOAD_INVALID（生产日志已实证）。
 *
 * 这些测试**显式带上 currentDeviceId** 模拟真实 socket 流量；单测若只传 {userId,teamId,channelId}
 * 抓不到这个 transport↔usecase 接缝 bug。
 */
describe('output package query tolerates socket-injected session envelope (#1)', () => {
  async function bootstrap() {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1 },
      ids: { nextId: () => 'id-1' },
    });
    const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    const channel = await app.createChannel({ userId, teamId, name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    return { app, userId, teamId, channelId: channel.channel.id };
  }

  test('listOutputPackages 不因 currentDeviceId 抛错', async () => {
    const { app, userId, teamId, channelId } = await bootstrap();
    const result = await app.listOutputPackages({
      userId,
      teamId,
      channelId,
      // 模拟 socket bind 注入；TS 类型不含此字段（它是运行期 session 注入），故 cast。
      currentDeviceId: 'device-1',
    } as Parameters<typeof app.listOutputPackages>[0]);
    expect(result.ok).toBe(true);
  });

  test('getOutputPackage 不因 currentDeviceId 抛错（包不存在返回 NOT_FOUND，而非 PAYLOAD_INVALID）', async () => {
    const { app, userId, teamId, channelId } = await bootstrap();
    const result = await app.getOutputPackage({
      userId,
      teamId,
      channelId,
      packageId: 'pkg-nonexistent',
      currentDeviceId: 'device-1',
    } as Parameters<typeof app.getOutputPackage>[0]);
    expect(result).toBeDefined();
    expect((result as { error?: string }).error).not.toBe('OUTPUT_PACKAGE_PAYLOAD_INVALID');
  });
});
