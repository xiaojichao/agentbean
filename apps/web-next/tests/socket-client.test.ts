import { describe, expect, test } from 'vitest';
import { WEB_EVENTS, type AgentDto, type ChannelDto, type DispatchDto, type MessageDto } from '../../../packages/contracts/src/index';
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
    await transport.trigger(WEB_EVENTS.channel.message, message);
    await transport.trigger(WEB_EVENTS.message.dispatchStatus, dispatch);

    expect(transport.emitted.slice(-2)).toEqual([
      [WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }],
    ]);
    expect(snapshots).toEqual({
      agents: [agent],
      channels: [channel],
      messages: [message],
      dispatches: [dispatch],
    });
  });
});

class FakeWebTransport implements WebSocketTransport {
  readonly emitted: Array<[string, unknown]> = [];
  private readonly handlers = new Map<string, (payload: unknown) => void>();

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    return { ok: true, event };
  }

  on(event: string, handler: (payload: unknown) => void): void {
    this.handlers.set(event, handler);
  }

  async trigger(event: string, payload: unknown): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`No handler for ${event}`);
    }
    handler(payload);
  }
}
