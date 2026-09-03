import { describe, expect, test, vi } from 'vitest';
import { WEB_EVENTS } from '../../../packages/contracts/src/index.js';
import {
  createDeviceSocketProjection,
  type DeviceSocketProjectionPort,
} from '../src/transport/device-socket-projection.js';

function createPort(overrides: Partial<DeviceSocketProjectionPort> = {}): DeviceSocketProjectionPort {
  return {
    listDevices: vi.fn(async () => ({ ok: true, devices: [] })),
    getDevice: vi.fn(async () => ({ ok: false, error: 'NOT_FOUND', message: 'not found' })),
    ...overrides,
  } as unknown as DeviceSocketProjectionPort;
}

function subscriber(teamId = 'team-1') {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    events,
    value: {
      socket: {
        emit(event: string, payload: unknown) {
          events.push({ event, payload });
        },
      },
      devices: { userId: 'user-1', teamId },
    },
  };
}

describe('Device Socket projection', () => {
  test('建立订阅时先发 snapshot，再逐 Device 重读并发送已存 runtime', async () => {
    const current = subscriber();
    current.value.devices = undefined;
    const port = createPort({
      getDevice: vi.fn(async ({ deviceId }) => ({
        ok: true,
        device: {
          id: deviceId,
          runtimes: deviceId === 'device-1'
            ? [{ adapterKind: 'claude-code', command: 'claude' }]
            : [],
        },
      })) as never,
    });
    const projection = createDeviceSocketProjection([current.value], port);

    await projection.subscribe(
      current.value,
      { userId: 'user-1', teamId: 'team-1' },
      [{ id: 'device-1' }, { id: 'device-2' }],
    );

    expect(current.value.devices).toEqual({ userId: 'user-1', teamId: 'team-1' });
    expect(port.getDevice).toHaveBeenCalledTimes(2);
    expect(current.events).toEqual([
      { event: WEB_EVENTS.device.snapshot, payload: [{ id: 'device-1' }, { id: 'device-2' }] },
      {
        event: WEB_EVENTS.device.runtimes,
        payload: {
          deviceId: 'device-1',
          runtimes: [{ adapterKind: 'claude-code', command: 'claude' }],
        },
      },
    ]);
  });

  test('refresh 只重读目标 Team，并按 snapshot → status 顺序发送', async () => {
    const current = subscriber('team-1');
    const other = subscriber('team-2');
    const port = createPort({
      listDevices: vi.fn(async () => ({
        ok: true,
        devices: [{ id: 'device-1' }, { id: 'device-2' }],
      })) as never,
    });
    const projection = createDeviceSocketProjection([current.value, other.value], port);

    await projection.refresh('team-1');

    expect(port.listDevices).toHaveBeenCalledTimes(1);
    expect(current.events.map(({ event }) => event)).toEqual([
      WEB_EVENTS.device.snapshot,
      WEB_EVENTS.device.status,
      WEB_EVENTS.device.status,
    ]);
    expect(other.events).toEqual([]);
  });

  test('成功 mutation 固定执行 Device → Agent → Channel → runtime → availability', async () => {
    const current = subscriber();
    const sequence: string[] = [];
    current.value.socket.emit = (event) => {
      sequence.push(event);
    };
    const port = createPort({
      listDevices: vi.fn(async () => ({ ok: true, devices: [{ id: 'device-1' }] })) as never,
    });
    const projection = createDeviceSocketProjection([current.value], port, {
      async refreshAgents(teamId) {
        sequence.push(`agents:${teamId}`);
      },
      async refreshChannels(teamId) {
        sequence.push(`channels:${teamId}`);
      },
      async onAgentAvailabilityChanged(teamId) {
        sequence.push(`availability:${teamId}`);
      },
    });

    await projection.handleMutation({ teamId: 'team-1' }, {
      ok: true,
      affectedTeamIds: ['team-2', 'team-2'],
      channelTeamIds: ['team-3'],
      runtimes: [{ deviceId: 'device-1', adapterKind: 'claude-code' }],
    });

    expect(sequence).toEqual([
      WEB_EVENTS.device.snapshot,
      WEB_EVENTS.device.status,
      'agents:team-2',
      'channels:team-3',
      WEB_EVENTS.device.runtimes,
      'availability:team-1',
    ]);
  });

  test('失败 mutation 与失败 listDevices 不发送事件或触发后续 callback', async () => {
    const current = subscriber();
    const port = createPort({
      listDevices: vi.fn(async () => ({ ok: false, error: 'FORBIDDEN', message: 'forbidden' })) as never,
    });
    const refreshAgents = vi.fn();
    const refreshChannels = vi.fn();
    const onAgentAvailabilityChanged = vi.fn();
    const projection = createDeviceSocketProjection([current.value], port, {
      refreshAgents,
      refreshChannels,
      onAgentAvailabilityChanged,
    });

    await projection.refresh('team-1');
    await projection.handleMutation({ teamId: 'team-1' }, { ok: false });

    expect(current.events).toEqual([]);
    expect(refreshAgents).not.toHaveBeenCalled();
    expect(refreshChannels).not.toHaveBeenCalled();
    expect(onAgentAvailabilityChanged).not.toHaveBeenCalled();
  });
});
