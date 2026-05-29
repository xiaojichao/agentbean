import { describe, expect, it } from 'vitest';
import { DeviceRegistry } from '../src/device-registry.js';
import { initGlobalDb } from '../src/db.js';

describe('team-scoped device profiles', () => {
  it('keeps the same physical machine online in two teams without kicking either socket', () => {
    const reg = new DeviceRegistry();
    const kicks: string[] = [];
    reg.onKick((sid) => kicks.push(sid));

    reg.register({
      id: 'dev-team-a-machine-1',
      machineId: 'machine-1',
      profileId: 'team-a',
      userId: 'test01',
      networkId: 'team-a',
      socket: { id: 'sock-a' } as any,
      agents: new Map(),
      lastSeenAt: 1,
      status: 'online',
    });
    reg.register({
      id: 'dev-team-b-machine-1',
      machineId: 'machine-1',
      profileId: 'team-b',
      userId: 'test01',
      networkId: 'team-b',
      socket: { id: 'sock-b' } as any,
      agents: new Map(),
      lastSeenAt: 2,
      status: 'online',
    });

    expect(kicks).toEqual([]);
    expect(reg.listByNetwork('team-a').map((device) => device.id)).toEqual(['dev-team-a-machine-1']);
    expect(reg.listByNetwork('team-b').map((device) => device.id)).toEqual(['dev-team-b-machine-1']);
    expect(reg.getBySocket('sock-a')?.machineId).toBe('machine-1');
    expect(reg.getBySocket('sock-b')?.profileId).toBe('team-b');
  });

  it('persists physical machine metadata separately from the team device instance', () => {
    const db = initGlobalDb(':memory:');
    db.users.create({ id: 'test01', username: 'test01', createdAt: 100 });
    db.networks.create({ id: 'team-a', ownerId: 'test01', name: 'Team A', createdAt: 101 });
    db.devices.upsert({
      id: 'dev-team-a-machine-1',
      machineId: 'machine-1',
      profileId: 'team-a',
      userId: 'test01',
      networkId: 'team-a',
      hostname: 'Shaw-MBP',
      lastSeenAt: 123,
      systemInfo: null,
    } as any);

    expect(db.devices.get('dev-team-a-machine-1')).toMatchObject({
      id: 'dev-team-a-machine-1',
      machineId: 'machine-1',
      profileId: 'team-a',
      networkId: 'team-a',
    });
    db.close();
  });
});
