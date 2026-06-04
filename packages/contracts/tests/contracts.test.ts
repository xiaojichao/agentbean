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
  type ChannelDto,
  type CreateChannelCommandDto,
  type DeviceDto,
  type DispatchDto,
  type MessageDto,
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

    expect(ack.ok).toBe(true);
    expect(team.id).toBe(device.teamId);
    expect(agent.visibleTeamIds).toEqual(['team-1']);
    expect(message.meta?.routeReason).toBe('MENTION');
    expect(createChannel.visibility).toBe('private');
    expect(updateChannel.title).toBe('Team-wide updates');
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
