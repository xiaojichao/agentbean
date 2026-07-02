import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

// fixture：注册 user-1/team-1，device.hello 上报 device-1 (machineId=machine-1, profileId=default)。
// 参照 device-management.test.ts 的直接 usecase 调用模式（不走 socket）。
// 为支持跨团队吊销用例，同时建立 team-2 + user-2 + 同 machineId='machine-1' 的设备。
async function boot() {
  const repositories = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 1000 },
    ids: {
      nextId: createIds([
        // user-1/team-1
        'user-1', 'team-1', 'channel-1', 'device-1',
        // team-2 + user-2 + 同 machineId 设备（createTeam 消耗 teamId+channelId，registerUser 消耗 userId+teamId+channelId）
        'user-2', 'team-2', 'channel-2', 'device-2',
        // deviceHello 复活时会申请新 deviceId（当前 bug）；实现后不会走到这里
        'device-3',
      ]),
    },
  });

  await expect(
    app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' }),
  ).resolves.toMatchObject({ ok: true, user: { id: 'user-1', primaryTeamId: 'team-1' } });

  const team1Hello = await app.deviceHello({
    teamId: 'team-1',
    ownerId: 'user-1',
    machineId: 'machine-1',
    profileId: 'default',
  });
  expect(team1Hello.ok).toBe(true);
  // deviceHello 颁发的合法 device token（由 issueDeviceToken 用 sessionSecret 签发），
  // 供 deviceHelloFromCredentials 的 invite 重新接入路径使用。
  const team1Token = team1Hello.ok ? team1Hello.credentials?.token ?? '' : '';

  // team-2 + user-2 + 同 machineId='machine-1' 设备（跨团队用例：删 team-1 不影响 team-2）
  await expect(
    app.registerUser({ username: 'alex', password: 'secret', teamName: 'TeamTwo' }),
  ).resolves.toMatchObject({ ok: true, user: { id: 'user-2', primaryTeamId: 'team-2' } });

  await expect(
    app.deviceHello({
      teamId: 'team-2',
      ownerId: 'user-2',
      machineId: 'machine-1',
      profileId: 'default',
    }),
  ).resolves.toMatchObject({ ok: true, device: { id: 'device-2' } });

  return { app, repos: repositories, team1Token };
}

describe('deleteDevice writes revocations', () => {
  test('deleting a device revokes its (teamId, machineId, profileId)', async () => {
    const { app, repos } = await boot();
    await app.deleteDevice({ userId: 'user-1', deviceId: 'device-1' });
    const revoked = await repos.revocations.find({
      teamId: 'team-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    expect(revoked).not.toBeNull();
  });
});

describe('deviceHello rejects revoked devices', () => {
  test('deviceHello after delete returns DEVICE_REVOKED and does not re-create record', async () => {
    const { app, repos } = await boot();
    await app.deleteDevice({ userId: 'user-1', deviceId: 'device-1' });
    const res = await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'h',
    });
    expect(res).toMatchObject({ ok: false, error: 'DEVICE_REVOKED' });
    // 关键：不复活——DB 不应再出现该 machineId 的设备记录
    const found = await repos.devices.findByMachineProfile({
      teamId: 'team-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    expect(found).toBeNull();
  });

  test('cross-team: revoking teamA does not reject teamB deviceHello', async () => {
    const { app } = await boot(); // boot 内另建 team-2 + 同 machineId 设备（参照 fixture）
    await app.deleteDevice({ userId: 'user-1', deviceId: 'device-1' }); // 删 team-1
    const res = await app.deviceHello({
      teamId: 'team-2',
      ownerId: 'user-2',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'h',
    });
    expect(res.ok).toBe(true); // team-2 不受影响
  });
});

describe('deviceHelloFromCredentials clears revocation (re-invite)', () => {
  test('after delete, invite-path hello clears revocation and succeeds', async () => {
    const { app, repos, team1Token } = await boot();
    await app.deleteDevice({ userId: 'user-1', deviceId: 'device-1' });
    // 重新 invite 接入：deviceHelloFromCredentials（带合法 token）
    const res = await app.deviceHelloFromCredentials({
      token: team1Token,
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'h',
    });
    expect(res.ok).toBe(true);
    // 吊销应被清除
    expect(
      await repos.revocations.find({
        teamId: 'team-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).toBeNull();
  });
});

// 注：在线删除的 layer1（device:removed emit + 断开 socket）+ layer2（吊销写入）组合
// 双保险由 socket-integration.test.ts 的端到端用例验证（真 socket + repos 断言），
// 这里不再保留与之重复的纯 usecase 拷贝。

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) {
      throw new Error('Test id sequence exhausted');
    }
    return id;
  };
}
