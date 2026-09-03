import { describe, expect, test, vi } from 'vitest';
import { WEB_EVENTS } from '../../../packages/contracts/src/index.js';
import {
  createAgentSocketProjection,
  type AgentSocketProjectionPort,
} from '../src/transport/agent-socket-projection.js';

function createPort(overrides: Partial<AgentSocketProjectionPort> = {}): AgentSocketProjectionPort {
  return {
    listChannels: vi.fn(async () => ({ ok: true, channels: [] })),
    listVisibleAgents: vi.fn(async () => ({ ok: true, agents: [{ id: 'agent-1', teamId: 'team-1' }] })),
    getDevice: vi.fn(async () => ({ ok: false, error: 'NOT_FOUND', message: 'not found' })),
    ...overrides,
  } as unknown as AgentSocketProjectionPort;
}

function subscription(teamId = 'team-1') {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    events,
    subscriber: {
      socket: {
        emit(event: string, payload: unknown) {
          events.push({ event, payload });
        },
      },
      agents: { userId: 'user-1', teamId },
      devices: { userId: 'user-1', teamId },
    },
  };
}

describe('Agent Socket projection', () => {
  test('Web Agent mutation 对 Team 去重刷新，并按 Agent → Memory → Channel 顺序投影', async () => {
    const { subscriber, events } = subscription();
    const port = createPort();
    const sequence: string[] = [];
    subscriber.socket.emit = (event, payload) => {
      sequence.push(event);
      events.push({ event, payload });
    };
    const projection = createAgentSocketProjection([subscriber], port, {
      emitMemoryChanged(teamId) {
        sequence.push(`memory:${teamId}`);
      },
      async refreshChannels(teamId) {
        sequence.push(`channels:${teamId}`);
      },
    });

    await projection.handleMutation('web-command', {
      teamId: 'team-1',
      targetTeamId: 'team-2',
      affectedTeamIds: ['team-1'],
      channelTeamIds: ['team-3'],
    }, {
      ok: true,
      agent: { visibleTeamIds: ['team-2'] },
      dispatch: { teamId: 'team-3' },
    });

    expect(port.listChannels).toHaveBeenCalledTimes(1);
    expect(port.listVisibleAgents).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual([
      WEB_EVENTS.agent.snapshot,
      WEB_EVENTS.agent.status,
      'memory:team-1',
      'memory:team-2',
      'memory:team-3',
      'channels:team-3',
    ]);
  });

  test('daemon Agent report 刷新可见 Team、隔离 availability 失败，并规范化 discovered 信息', async () => {
    const { subscriber, events } = subscription();
    const availability: string[] = [];
    const port = createPort({
      getDevice: vi.fn(async () => ({
        ok: true,
        device: {
          runtimes: [{
            adapterKind: 'claude',
            command: 'claude',
            cwd: '/workspace',
          }],
        },
      })) as never,
    });
    const projection = createAgentSocketProjection([subscriber], port, {
      async onAgentAvailabilityChanged(teamId) {
        availability.push(teamId);
        if (teamId === 'team-1') throw new Error('availability unavailable');
      },
    });

    await projection.handleMutation('agent-report', {
      teamId: 'team-1',
      targetTeamId: 'team-2',
      deviceId: 'device-1',
      agents: [{
        name: 'Claude',
        adapterKind: 'Claude',
        category: 'agentos-hosted',
        projectDocumentInputSetVersions: [1, 2],
      }],
    }, { ok: true, agent: { visibleTeamIds: ['team-1'] } });

    expect(availability).toEqual(['team-1', 'team-2']);
    expect(events.map(({ event }) => event)).toEqual([
      WEB_EVENTS.agent.snapshot,
      WEB_EVENTS.agent.status,
      WEB_EVENTS.agent.discovered,
    ]);
    const discovered = events.at(-1)?.payload;
    expect(discovered).toEqual({
      runtimes: [expect.objectContaining({ adapterKind: 'claude', command: 'claude', cwd: '/workspace' })],
      agents: [{
        name: 'Claude',
        adapterKind: 'claude-code',
        category: 'agentos-hosted',
        source: 'runtime',
        command: 'claude',
        args: undefined,
        cwd: '/workspace',
        projectDocumentInputSetVersions: [1, 2],
      }],
    });
  });

  test('Agent subscription 撤权时 fail closed 并停止发送 snapshot/status', async () => {
    const { subscriber, events } = subscription();
    const port = createPort({
      listChannels: vi.fn(async () => ({ ok: false, error: 'FORBIDDEN', message: 'forbidden' })) as never,
    });
    const projection = createAgentSocketProjection([subscriber], port);

    await projection.refresh('team-1');

    expect(subscriber.agents).toBeUndefined();
    expect(port.listVisibleAgents).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test('失败 mutation 不读取投影，也不触发任何 callback', async () => {
    const { subscriber, events } = subscription();
    const port = createPort();
    const emitMemoryChanged = vi.fn();
    const refreshChannels = vi.fn();
    const onAgentAvailabilityChanged = vi.fn();
    const projection = createAgentSocketProjection([subscriber], port, {
      emitMemoryChanged,
      refreshChannels,
      onAgentAvailabilityChanged,
    });

    await projection.handleMutation('web-command', { teamId: 'team-1' }, { ok: false });
    await projection.handleMutation('agent-report', { teamId: 'team-1' }, { ok: false });

    expect(port.listChannels).not.toHaveBeenCalled();
    expect(port.listVisibleAgents).not.toHaveBeenCalled();
    expect(port.getDevice).not.toHaveBeenCalled();
    expect(emitMemoryChanged).not.toHaveBeenCalled();
    expect(refreshChannels).not.toHaveBeenCalled();
    expect(onAgentAvailabilityChanged).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
