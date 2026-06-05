import { describe, expect, test } from 'vitest';
import { WEB_EVENTS, type AgentDto, type ChannelDto, type DeviceDto, type DispatchDto, type MessageDto, type RuntimeDto } from '../../../packages/contracts/src/index';
import { createWebSocketClient, type WebSocketTransport } from '../src/index';

describe('web-next socket client', () => {
  test('uses first-slice web events for auth, team, and message commands', async () => {
    const transport = new FakeWebTransport();
    const client = createWebSocketClient(transport);

    await expect(client.register({ username: 'shaw', password: 'secret', teamName: 'AgentBean' })).resolves.toEqual({
      ok: true,
      event: WEB_EVENTS.auth.register,
    });
    await client.login({ username: 'shaw', password: 'secret' });
    await client.listTeams({ userId: 'user-1' });
    await client.listDevices({ userId: 'user-1', teamId: 'team-1' });
    await client.getDevice({ userId: 'user-1', deviceId: 'device-1' });
    await client.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'ops',
      visibility: 'private',
    });
    await client.updateChannel({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      title: 'Team-wide updates',
    });
    await client.addChannelHumanMember({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      memberUserId: 'user-2',
    });
    await client.removeChannelHumanMember({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      memberUserId: 'user-2',
    });
    await client.addChannelAgentMember({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      agentId: 'agent-1',
    });
    await client.removeChannelAgentMember({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      agentId: 'agent-1',
    });
    await client.listChannelMembers({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
    });
    await client.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
    });

    expect(transport.emitted).toEqual([
      [WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'AgentBean' }],
      [WEB_EVENTS.auth.login, { username: 'shaw', password: 'secret' }],
      [WEB_EVENTS.team.list, { userId: 'user-1' }],
      [WEB_EVENTS.device.list, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.device.get, { userId: 'user-1', deviceId: 'device-1' }],
      [WEB_EVENTS.channel.create, { userId: 'user-1', teamId: 'team-1', name: 'ops', visibility: 'private' }],
      [WEB_EVENTS.channel.update, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', title: 'Team-wide updates' }],
      [WEB_EVENTS.channel.addMember, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', memberUserId: 'user-2' }],
      [WEB_EVENTS.channel.removeMember, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', memberUserId: 'user-2' }],
      [WEB_EVENTS.channel.addAgent, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', agentId: 'agent-1' }],
      [WEB_EVENTS.channel.removeAgent, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', agentId: 'agent-1' }],
      [WEB_EVENTS.channel.members, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2' }],
      [WEB_EVENTS.message.send, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'hello' }],
    ]);
    expect(transport.emitted.map(([event]) => event)).not.toContain('network:list');
  });

  test('subscribes to snapshots and realtime conversation events', async () => {
    const transport = new FakeWebTransport();
    const snapshots: {
      agents?: AgentDto[];
      channels?: ChannelDto[];
      devices?: DeviceDto[];
      runtimes?: Array<{ deviceId: string; runtimes: RuntimeDto[] }>;
      messages?: MessageDto[];
      dispatches?: DispatchDto[];
    } = {};
    const client = createWebSocketClient(transport);

    await client.subscribeAgents({ userId: 'user-1', teamId: 'team-1' }, (agents) => {
      snapshots.agents = agents;
    });
    await client.subscribeChannels({ userId: 'user-1', teamId: 'team-1' }, (channels) => {
      snapshots.channels = channels;
    });
    await client.listDevices({ userId: 'user-1', teamId: 'team-1' }, (devices) => {
      snapshots.devices = devices;
    });
    client.onDeviceRuntimes((payload) => {
      snapshots.runtimes = [...(snapshots.runtimes ?? []), payload];
    });
    client.onChannelMessage((message) => {
      snapshots.messages = [...(snapshots.messages ?? []), message];
    });
    client.onDispatchStatus((dispatch) => {
      snapshots.dispatches = [...(snapshots.dispatches ?? []), dispatch];
    });

    const agent = {
      id: 'agent-1',
      teamId: 'team-1',
      name: 'Codex',
      adapterKind: 'codex-cli',
      category: 'executor-hosted',
      status: 'online',
      source: 'self-register',
      lastSeenAt: 1,
      createdAt: 1,
      updatedAt: 1,
    } satisfies AgentDto;
    const channel = {
      id: 'channel-1',
      teamId: 'team-1',
      name: 'all',
      visibility: 'public',
      humanMemberIds: ['user-1'],
      agentMemberIds: [],
      createdBy: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    } satisfies ChannelDto;
    const device = {
      id: 'device-1',
      teamId: 'team-1',
      ownerId: 'user-1',
      status: 'online',
    } satisfies DeviceDto;
    const runtime = {
      id: 'runtime-1',
      deviceId: 'device-1',
      adapterKind: 'codex',
      name: 'Codex CLI',
      status: 'online',
    } satisfies RuntimeDto;
    const message = {
      id: 'message-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      sender: { kind: 'agent', id: 'agent-1', displayName: 'Codex' },
      body: 'hello',
      createdAt: 1,
    } satisfies MessageDto;
    const dispatch = {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      status: 'completed',
      requestId: 'request-1',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    } satisfies DispatchDto;

    await transport.trigger(WEB_EVENTS.agent.snapshot, [agent]);
    await transport.trigger(WEB_EVENTS.channel.snapshot, [channel]);
    await transport.trigger(WEB_EVENTS.device.snapshot, [device]);
    await transport.trigger(WEB_EVENTS.device.runtimes, { deviceId: 'device-1', runtimes: [runtime] });
    await transport.trigger(WEB_EVENTS.channel.message, message);
    await transport.trigger(WEB_EVENTS.message.dispatchStatus, dispatch);

    expect(transport.emitted.slice(-3)).toEqual([
      [WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.device.list, { userId: 'user-1', teamId: 'team-1' }],
    ]);
    expect(snapshots).toEqual({
      agents: [agent],
      channels: [channel],
      devices: [device],
      runtimes: [{ deviceId: 'device-1', runtimes: [runtime] }],
      messages: [message],
      dispatches: [dispatch],
    });
  });

  test('resubscribes active snapshot streams after reconnect without duplicating handlers', async () => {
    const transport = new FakeWebTransport();
    const snapshots: { agents: AgentDto[][]; channels: ChannelDto[][]; devices: DeviceDto[][] } = {
      agents: [],
      channels: [],
      devices: [],
    };
    const client = createWebSocketClient(transport);
    const agent = {
      id: 'agent-1',
      teamId: 'team-1',
      name: 'Codex',
      adapterKind: 'codex-cli',
      category: 'executor-hosted',
      status: 'online',
      source: 'self-register',
      lastSeenAt: 1,
      createdAt: 1,
      updatedAt: 1,
    } satisfies AgentDto;
    const channel = {
      id: 'channel-1',
      teamId: 'team-1',
      name: 'all',
      visibility: 'public',
      humanMemberIds: ['user-1'],
      agentMemberIds: [],
      createdBy: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    } satisfies ChannelDto;

    await client.subscribeAgents({ userId: 'user-1', teamId: 'team-1' }, (agents) => {
      snapshots.agents.push(agents);
    });
    await client.subscribeChannels({ userId: 'user-1', teamId: 'team-1' }, (channels) => {
      snapshots.channels.push(channels);
    });
    await client.listDevices({ userId: 'user-1', teamId: 'team-1' }, (devices) => {
      snapshots.devices.push(devices);
    });

    expect(transport.handlerCount(WEB_EVENTS.agent.snapshot)).toBe(1);
    expect(transport.handlerCount(WEB_EVENTS.channel.snapshot)).toBe(1);
    expect(transport.handlerCount(WEB_EVENTS.device.snapshot)).toBe(1);

    await transport.trigger('connect', undefined);
    await transport.trigger(WEB_EVENTS.agent.snapshot, [agent]);
    await transport.trigger(WEB_EVENTS.channel.snapshot, [channel]);

    expect(transport.emitted).toEqual([
      [WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.device.list, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.device.list, { userId: 'user-1', teamId: 'team-1' }],
    ]);
    expect(snapshots).toEqual({
      agents: [[agent]],
      channels: [[channel]],
      devices: [],
    });
  });

  test('replaces active snapshot subscriptions without adding duplicate snapshot handlers', async () => {
    const transport = new FakeWebTransport();
    const snapshots: AgentDto[][] = [];
    const client = createWebSocketClient(transport);
    const agent = {
      id: 'agent-2',
      teamId: 'team-2',
      name: 'Claude',
      adapterKind: 'claude-code',
      category: 'executor-hosted',
      status: 'online',
      source: 'self-register',
      lastSeenAt: 1,
      createdAt: 1,
      updatedAt: 1,
    } satisfies AgentDto;

    await client.subscribeAgents({ userId: 'user-1', teamId: 'team-1' }, (agents) => {
      snapshots.push(agents);
    });
    await client.subscribeAgents({ userId: 'user-1', teamId: 'team-2' }, (agents) => {
      snapshots.push(agents);
    });

    expect(transport.handlerCount(WEB_EVENTS.agent.snapshot)).toBe(1);

    await transport.trigger('connect', undefined);
    await transport.trigger(WEB_EVENTS.agent.snapshot, [agent]);

    expect(transport.emitted).toEqual([
      [WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-2' }],
      [WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-2' }],
    ]);
    expect(snapshots).toEqual([[agent]]);
  });
});

class FakeWebTransport implements WebSocketTransport {
  readonly emitted: Array<[string, unknown]> = [];
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    return { ok: true, event };
  }

  on(event: string, handler: (payload: unknown) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  async trigger(event: string, payload: unknown): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers) {
      throw new Error(`No handler for ${event}`);
    }
    for (const handler of handlers) {
      await handler(payload);
    }
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}
