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
      name: 'new-name',
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
      name: 'x',
      updatedAt: 1000,
    });
    expect(updated).toBeNull();
  });

  test('updateName sets nameSource=user', async () => {
    const repos = createInMemoryRepositories();
    await repos.devices.upsertHello({
      id: 'd1', teamId: 't1', ownerId: 'u1', status: 'online',
      name: 'host1', nameSource: 'hostname',
      lastSeenAt: 1000, createdAt: 1000, updatedAt: 1000,
    });
    const updated = await repos.devices.updateName({ deviceId: 'd1', name: '我的设备', updatedAt: 2000 });
    expect(updated?.name).toBe('我的设备');
    expect(updated?.nameSource).toBe('user');
  });

  test('delete soft-deletes agents (tombstone) and hard-deletes runtimes/device', async () => {
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
    await repos.agents.upsert({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex Agent',
      adapterKind: 'codex',
      category: 'cli',
      source: 'manual',
      status: 'offline',
      deviceId: 'device-1',
    });

    await repos.devices.delete({ deviceId: 'device-1', timestamp: 5000 });

    // device + runtimes hard-deleted
    expect(await repos.devices.getById('device-1')).toBeNull();
    expect((await repos.runtimes.listByDevice('device-1')).length).toBe(0);
    // agent soft-deleted: hidden from visible list (filtered by deleted_at IS NULL)
    expect((await repos.agents.listByDevice('device-1')).length).toBe(0);
    // ...but the row + history is preserved with a tombstone (not hard-deleted)
    const tombstoned = await repos.agents.getById('agent-1');
    expect(tombstoned).not.toBeNull();
    expect(tombstoned?.deletedAt).toBe(5000);
    expect(tombstoned?.status).toBe('offline');
  });

  test('findByMachineProfile is scoped to a team', async () => {
    const repos = createInMemoryRepositories();
    await repos.devices.upsertHello({
      id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'offline', name: 'team-one-mac',
      machineId: 'm-1', profileId: 'default',
      lastSeenAt: 1000, createdAt: 1000, updatedAt: 1000,
    });
    await repos.devices.upsertHello({
      id: 'device-2', teamId: 'team-2', ownerId: 'user-2', status: 'online', name: 'team-two-mac',
      machineId: 'm-1', profileId: 'default',
      lastSeenAt: 2000, createdAt: 2000, updatedAt: 2000,
    });

    await expect(
      repos.devices.findByMachineProfile({ teamId: 'team-1', machineId: 'm-1', profileId: 'default' }),
    ).resolves.toMatchObject({ id: 'device-1', teamId: 'team-1' });
  });
});

describe('deviceInvites repository', () => {
  test('findCompletedByMachineProfile returns the completed invite', async () => {
    const repos = createInMemoryRepositories();
    await repos.deviceInvites.create({
      id: 'inv-1', code: 'CODE1', teamId: 'team-1', createdBy: 'user-1',
      createdAt: 1000, machineId: 'mac-1', profileId: 'default',
    });
    await repos.deviceInvites.updateWaiter({
      code: 'CODE1',
      machineId: 'mac-1',
      profileId: 'default',
      hostname: 'mac',
      serverUrl: 'https://agentbean.example',
    });
    await repos.deviceInvites.complete({ code: 'CODE1', completedAt: 2000 });

    const found = await repos.deviceInvites.findCompletedByMachineProfile({
      teamId: 'team-1', machineId: 'mac-1', profileId: 'default',
    });
    expect(found?.code).toBe('CODE1');
    expect(found?.completedAt).toBe(2000);
    expect(found?.serverUrl).toBe('https://agentbean.example');
  });

  test('findCompletedByMachineProfile requires exact machine and profile match', async () => {
    const repos = createInMemoryRepositories();
    await repos.deviceInvites.create({
      id: 'inv-1', code: 'CODE1', teamId: 'team-1', createdBy: 'user-1',
      createdAt: 1000, machineId: 'mac-1', profileId: 'default',
    });
    await repos.deviceInvites.updateWaiter({ code: 'CODE1', machineId: 'mac-1', profileId: 'default', hostname: 'mac' });
    await repos.deviceInvites.complete({ code: 'CODE1', completedAt: 2000 });

    await expect(
      repos.deviceInvites.findCompletedByMachineProfile({
        teamId: 'team-1', machineId: 'mac-2', profileId: 'default',
      }),
    ).resolves.toBeNull();
  });

  test('findCompletedByMachineProfile returns null when no completed match', async () => {
    const repos = createInMemoryRepositories();
    const found = await repos.deviceInvites.findCompletedByMachineProfile({
      teamId: 'team-1', machineId: 'mac-x', profileId: 'default',
    });
    expect(found).toBeNull();
  });
});
