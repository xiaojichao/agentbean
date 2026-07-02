import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

// fixture：注册 user-1/team-1，device.hello 上报 device-1 (machineId=machine-1, profileId=default)。
// 参照 device-management.test.ts 的直接 usecase 调用模式（不走 socket）。
async function boot() {
  const repositories = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 1000 },
    ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'runtime-1', 'agent-1']) },
  });

  await expect(
    app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' }),
  ).resolves.toMatchObject({ ok: true, user: { id: 'user-1', primaryTeamId: 'team-1' } });

  await expect(
    app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    }),
  ).resolves.toMatchObject({ ok: true, device: { id: 'device-1' } });

  return { app, repos: repositories };
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
