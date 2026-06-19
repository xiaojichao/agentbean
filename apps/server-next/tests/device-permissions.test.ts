import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

describe('server-next device permissions', () => {
  test('restricts device delete to the device owner or team admins', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-owner', 'team-1', 'channel-all']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'AgentBean' });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'user-member',
      username: 'member',
      role: 'member',
      joinedAt: 100,
    });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'user-admin',
      username: 'admin',
      role: 'admin',
      joinedAt: 100,
    });
    await repositories.devices.upsertHello({
      id: 'device-1',
      teamId: 'team-1',
      ownerId: 'user-owner',
      machineId: 'machine-1',
      profileId: 'default',
      name: 'Mac',
      status: 'online',
      lastSeenAt: 100,
      createdAt: 100,
      updatedAt: 100,
    });

    await expect(
      app.deleteDevice({
        userId: 'user-member',
        deviceId: 'device-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(
      app.deleteDevice({
        userId: 'user-admin',
        deviceId: 'device-1',
      }),
    ).resolves.toMatchObject({
      ok: true,
      device: { id: 'device-1' },
    });
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
