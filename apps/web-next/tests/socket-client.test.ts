import { describe, expect, test } from 'vitest';
import { WEB_EVENTS } from '../../../packages/contracts/src/index';
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
});

class FakeWebTransport implements WebSocketTransport {
  readonly emitted: Array<[string, unknown]> = [];

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    return { ok: true, event };
  }
}
