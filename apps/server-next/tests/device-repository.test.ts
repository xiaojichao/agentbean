import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

describe('devices repository', () => {
  test('updateName renames device and returns updated record', async () => {
    const repos = createInMemoryRepositories();
    const created = await repos.devices.upsertHello({
      id: 'device-1',
      teamId: 'team-1',
      ownerId: 'user-1',
      status: 'online',
      name: 'old-name',
      lastSeenAt: 1000,
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(created.name).toBe('old-name');

    const updated = await repos.devices.updateName({
      deviceId: 'device-1',
      hostname: 'new-name',
      updatedAt: 2000,
    });

    expect(updated?.name).toBe('new-name');
    expect(updated?.updatedAt).toBe(2000);
    expect((await repos.devices.getById('device-1'))?.name).toBe('new-name');
  });

  test('updateName returns null when device missing', async () => {
    const repos = createInMemoryRepositories();
    const updated = await repos.devices.updateName({
      deviceId: 'missing',
      hostname: 'x',
      updatedAt: 1000,
    });
    expect(updated).toBeNull();
  });

  test('delete removes device and cascades runtimes', async () => {
    const repos = createInMemoryRepositories();
    await repos.devices.upsertHello({
      id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'online', name: 'mac',
      machineId: 'm-1', profileId: 'default', daemonVersion: null, systemInfo: undefined,
      lastSeenAt: 1000, createdAt: 1000, updatedAt: 1000,
    });
    await repos.runtimes.replaceForDevice({
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [
        { id: 'rt-1', deviceId: 'device-1', teamId: 'team-1', adapterKind: 'codex', name: 'Codex', installed: true, lastSeenAt: 1000 },
      ],
    });

    await repos.devices.delete({ deviceId: 'device-1' });

    expect(await repos.devices.getById('device-1')).toBeNull();
    expect((await repos.runtimes.listByDevice('device-1')).length).toBe(0);
  });
});
