import { describe, expect, test } from 'vitest';
import {
  ERROR_CODES,
  WEB_EVENTS,
  AGENT_EVENTS,
  isErrorCode,
  makeFailure,
  makeSuccess,
  type Ack,
  type AgentDto,
  type ChannelAgentMemberCommandDto,
  type ChannelDto,
  type ChannelMembersDto,
  type ChannelHumanMemberCommandDto,
  type CreateChannelCommandDto,
  type DeviceDto,
  type DispatchDto,
  type ListChannelMembersCommandDto,
  type MessageDto,
  type RuntimeDto,
  type TeamDto,
  type UpdateChannelCommandDto,
  type UserDto,
} from '../src/index';

describe('first-slice contract result shape', () => {
  test('creates success and failure acknowledgements with stable error codes', () => {
    const success = makeSuccess({ token: 'token-1' });
    const failure = makeFailure('FORBIDDEN', 'Not a team member');

    expect(success).toEqual({ ok: true, token: 'token-1' });
    expect(failure).toEqual({
      ok: false,
      error: 'FORBIDDEN',
      message: 'Not a team member',
    });
    expect(isErrorCode('DISPATCH_TIMEOUT')).toBe(true);
    expect(isErrorCode('DEVICE_NOT_IN_TEAM')).toBe(false);
    expect(ERROR_CODES).toContain('UNAUTHENTICATED');
  });

  test('accepts typed DTO fixtures for the first implementation slice', () => {
    const user: UserDto = {
      id: 'user-1',
      username: 'shaw',
      role: 'user',
    };
    const team: TeamDto = {
      id: 'team-1',
      name: 'AgentBean',
      path: 'agentbean',
      visibility: 'private',
      ownerId: user.id,
      currentUserRole: 'owner',
      createdAt: 1,
    };
    const device: DeviceDto = {
      id: 'device-1',
      teamId: team.id,
      ownerId: user.id,
      status: 'online',
      lastSeenAt: 2,
    };
    const agent: AgentDto = {
      id: 'agent-1',
      primaryTeamId: team.id,
      visibleTeamIds: [team.id],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'executor-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: device.id,
      lastSeenAt: 3,
    };
    const runtime: RuntimeDto = {
      id: 'runtime-1',
      deviceId: device.id,
      adapterKind: 'codex',
      name: 'Codex CLI',
      installed: true,
      command: '/opt/homebrew/bin/codex',
      cwd: '/opt/homebrew/bin',
      normalizedCommandKey: '/opt/homebrew/bin/codex',
      normalizedCwdKey: '/opt/homebrew/bin',
      version: '1.0.0',
      status: 'online',
      lastSeenAt: 3,
    };
    const channel: ChannelDto = {
      id: 'channel-1',
      teamId: team.id,
      kind: 'channel',
      name: 'all',
      visibility: 'public',
      createdAt: 4,
    };
    const message: MessageDto = {
      id: 'message-1',
      teamId: team.id,
      channelId: channel.id,
      senderKind: 'human',
      senderId: user.id,
      body: '@Codex hello',
      createdAt: 5,
      meta: { routeReason: 'MENTION', mentionedName: 'Codex' },
    };
    const dispatch: DispatchDto = {
      id: 'dispatch-1',
      teamId: team.id,
      channelId: channel.id,
      messageId: message.id,
      agentId: agent.id,
      status: 'queued',
      requestId: 'request-1',
      createdAt: 6,
      updatedAt: 6,
    };
    const ack: Ack<{ message: MessageDto; dispatches: DispatchDto[] }> =
      makeSuccess({ message, dispatches: [dispatch] });
    const createChannel: CreateChannelCommandDto = {
      userId: user.id,
      teamId: team.id,
      name: 'ops',
      visibility: 'private',
    };
    const updateChannel: UpdateChannelCommandDto = {
      userId: user.id,
      teamId: team.id,
      channelId: channel.id,
      title: 'Team-wide updates',
    };
    const humanMemberCommand: ChannelHumanMemberCommandDto = {
      userId: user.id,
      teamId: team.id,
      channelId: channel.id,
      memberUserId: 'user-2',
    };
    const agentMemberCommand: ChannelAgentMemberCommandDto = {
      userId: user.id,
      teamId: team.id,
      channelId: channel.id,
      agentId: agent.id,
    };
    const listMembersCommand: ListChannelMembersCommandDto = {
      userId: user.id,
      teamId: team.id,
      channelId: channel.id,
    };
    const channelMembers: ChannelMembersDto = {
      humanMemberIds: [user.id],
      agentMemberIds: [agent.id],
      humans: [
        {
          id: `${team.id}:${user.id}`,
          teamId: team.id,
          userId: user.id,
          username: user.username,
          role: 'owner',
        },
      ],
      agents: [agent],
    };

    expect(ack.ok).toBe(true);
    expect(team.id).toBe(device.teamId);
    expect(runtime.installed).toBe(true);
    expect(runtime.normalizedCommandKey).toBe('/opt/homebrew/bin/codex');
    expect(agent.visibleTeamIds).toEqual(['team-1']);
    expect(message.meta?.routeReason).toBe('MENTION');
    expect(createChannel.visibility).toBe('private');
    expect(updateChannel.title).toBe('Team-wide updates');
    expect(humanMemberCommand.memberUserId).toBe('user-2');
    expect(agentMemberCommand.agentId).toBe('agent-1');
    expect(listMembersCommand.channelId).toBe('channel-1');
    expect(channelMembers.humans[0]?.username).toBe('shaw');
    expect(channelMembers.agents[0]?.name).toBe('Codex');
  });

  test('exposes first-slice socket event constants without old network naming', () => {
    expect(WEB_EVENTS.auth.login).toBe('auth:login');
    expect(WEB_EVENTS.team.list).toBe('team:list');
    expect(WEB_EVENTS.team.snapshot).toBe('teams:snapshot');
    expect(WEB_EVENTS.message.send).toBe('message:send');
    expect(AGENT_EVENTS.device.hello).toBe('device:hello');
    expect(AGENT_EVENTS.dispatch.request).toBe('dispatch:request');
    expect(Object.values(WEB_EVENTS.team)).not.toContain('network:list');
  });
});
