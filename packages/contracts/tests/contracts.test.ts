import { describe, expect, test } from 'vitest';
import {
  ERROR_CODES,
  WEB_EVENTS,
  AGENT_EVENTS,
  ADAPTER_KINDS,
  AGENT_CATEGORIES,
  AGENT_SOURCES,
  AGENT_STATUSES,
  isErrorCode,
  makeFailure,
  makeSuccess,
  type Ack,
  type AgentDto,
  type ChannelAgentMemberCommandDto,
  type ChannelDto,
  type ChannelMembersDto,
  type ChannelHumanMemberCommandDto,
  type CreateAgentCommandDto,
  type DeleteAgentCommandDto,
  type CreateChannelCommandDto,
  type DeviceDto,
  type CreateDeviceInviteCommandDto,
  type CompleteDeviceInviteCommandDto,
  type DeviceInviteAckDto,
  type DeviceInviteCredentialsDto,
  type WaitForDeviceInviteCommandDto,
  type DiscoveredAgentDto,
  type DispatchRequestDto,
  type DispatchDto,
  type ListChannelMembersCommandDto,
  type MessageDto,
  type PublishAgentCommandDto,
  type RuntimeDto,
  type CreateTeamAckDto,
  type CreateTeamCommandDto,
  type CreateJoinLinkCommandDto,
  type JoinLinkAckDto,
  type ListTeamsAckDto,
  type SwitchTeamAckDto,
  type SwitchTeamCommandDto,
  type TeamDto,
  type UnpublishAgentCommandDto,
  type UpdateAgentConfigCommandDto,
  type UpdateChannelCommandDto,
  type ValidateJoinLinkCommandDto,
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
    const teamList: ListTeamsAckDto = {
      currentTeamId: team.id,
      teams: [team],
    };
    const createTeamCommand: CreateTeamCommandDto = {
      userId: user.id,
      name: 'Ops Team',
    };
    const createTeamAck: CreateTeamAckDto = {
      team: {
        ...team,
        id: 'team-2',
        name: createTeamCommand.name,
        path: 'ops-team',
      },
      defaultChannel: {
        id: 'channel-2',
        teamId: 'team-2',
        kind: 'channel',
        name: 'all',
        visibility: 'public',
        createdBy: user.id,
        createdAt: 2,
      },
    };
    const switchTeamCommand: SwitchTeamCommandDto = {
      userId: user.id,
      teamId: team.id,
    };
    const switchTeamAck: SwitchTeamAckDto = {
      currentTeam: team,
    };
    const createJoinLinkCommand: CreateJoinLinkCommandDto = {
      userId: user.id,
      teamId: team.id,
    };
    const validateJoinLinkCommand: ValidateJoinLinkCommandDto = {
      code: 'join-1',
    };
    const joinLinkAck: JoinLinkAckDto = {
      link: {
        id: 'join-1',
        code: validateJoinLinkCommand.code,
        teamId: createJoinLinkCommand.teamId,
        createdBy: user.id,
        createdAt: 3,
        maxUses: 1,
        usesCount: 0,
      },
      team,
    };
    const device: DeviceDto = {
      id: 'device-1',
      teamId: team.id,
      ownerId: user.id,
      status: 'online',
      lastSeenAt: 2,
    };
    const createDeviceInviteCommand: CreateDeviceInviteCommandDto = {
      userId: user.id,
      teamId: team.id,
      profileId: 'agentbean-next',
    };
    const deviceInviteAck: DeviceInviteAckDto = {
      invite: {
        id: 'device-invite-1',
        code: 'device-code-1',
        teamId: team.id,
        createdBy: user.id,
        createdAt: 2,
        expiresAt: 3,
        profileId: 'agentbean-next',
      },
      team,
    };
    const waitForDeviceInviteCommand: WaitForDeviceInviteCommandDto = {
      code: deviceInviteAck.invite.code,
      machineId: 'machine-1',
      profileId: 'agentbean-next',
      hostname: 'shaw-mbp',
    };
    const completeDeviceInviteCommand: CompleteDeviceInviteCommandDto = {
      userId: user.id,
      code: deviceInviteAck.invite.code,
    };
    const deviceInviteCredentials: DeviceInviteCredentialsDto = {
      token: 'device-token-1',
      teamId: team.id,
      ownerId: user.id,
      profileId: 'agentbean-next',
      serverUrl: 'http://127.0.0.1:4000',
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
    const dispatchRequest: DispatchRequestDto = {
      teamId: team.id,
      channelId: channel.id,
      messageId: message.id,
      agentId: agent.id,
      requestId: 'request-1',
      prompt: '@Codex hello',
      deviceId: device.id,
      customAgent: {
        adapterKind: 'codex',
        command: '/opt/homebrew/bin/codex',
        args: ['--model', 'gpt-5.4'],
        cwd: '/Users/shaw/AgentBean',
        env: { OPENAI_API_KEY: 'secret-value' },
      },
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
    expect(teamList.currentTeamId).toBe(team.id);
    expect(createTeamAck.defaultChannel.name).toBe('all');
    expect(createTeamAck.team.name).toBe(createTeamCommand.name);
    expect(switchTeamAck.currentTeam.id).toBe(switchTeamCommand.teamId);
    expect(joinLinkAck.link.code).toBe(validateJoinLinkCommand.code);
    expect(deviceInviteAck.invite.code).toBe(waitForDeviceInviteCommand.code);
    expect(completeDeviceInviteCommand.code).toBe(waitForDeviceInviteCommand.code);
    expect(deviceInviteCredentials.ownerId).toBe(user.id);
    expect(runtime.installed).toBe(true);
    expect(runtime.normalizedCommandKey).toBe('/opt/homebrew/bin/codex');
    expect(agent.visibleTeamIds).toEqual(['team-1']);
    expect(message.meta?.routeReason).toBe('MENTION');
    expect(dispatchRequest.customAgent?.env?.OPENAI_API_KEY).toBe('secret-value');
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
    expect(WEB_EVENTS.team.create).toBe('team:create');
    expect(WEB_EVENTS.team.switch).toBe('team:switch');
    expect(WEB_EVENTS.team.snapshot).toBe('teams:snapshot');
    expect(WEB_EVENTS.join.create).toBe('join:create');
    expect(WEB_EVENTS.join.validate).toBe('join:validate');
    expect(WEB_EVENTS.deviceInvite.create).toBe('device-invite:create');
    expect(WEB_EVENTS.deviceInvite.complete).toBe('device-invite:complete');
    expect(WEB_EVENTS.agent.publish).toBe('agent:publish');
    expect(WEB_EVENTS.agent.unpublish).toBe('agent:unpublish');
    expect(WEB_EVENTS.agent.updateConfig).toBe('agent:update-config');
    expect(WEB_EVENTS.agent.delete).toBe('agent:delete');
    expect(WEB_EVENTS.message.send).toBe('message:send');
    expect(AGENT_EVENTS.device.hello).toBe('device:hello');
    expect(AGENT_EVENTS.deviceInvite.wait).toBe('device-invite:wait');
    expect(AGENT_EVENTS.deviceInvite.credentials).toBe('device-invite:credentials');
    expect(AGENT_EVENTS.dispatch.request).toBe('dispatch:request');
    expect(Object.values(WEB_EVENTS.team)).not.toContain('network:list');
  });

  test('keeps agent contracts aligned with runtime capability and custom agent docs', () => {
    const customAgent: AgentDto = {
      id: 'agent-custom-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Custom Codex',
      description: 'Runs Codex from the selected runtime',
      adapterKind: 'codex',
      category: 'executor-hosted',
      source: 'custom',
      status: 'error',
      ownerId: 'user-1',
      deviceId: 'device-1',
      command: '/opt/homebrew/bin/codex',
      args: ['--model', 'gpt-5.4'],
      cwd: '/Users/shaw/AgentBean',
      envKeys: ['OPENAI_API_KEY'],
      lastSeenAt: 10,
      lastError: 'Missing OPENAI_API_KEY',
    };
    const selfRegisteredAgent: AgentDto = {
      id: 'agent-self-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Gateway Agent',
      adapterKind: 'claude-code',
      category: 'agentos-hosted',
      source: 'self-register',
      status: 'connecting',
      lastSeenAt: 11,
    };
    const discovered: DiscoveredAgentDto = {
      deviceId: 'device-1',
      teamId: 'team-1',
      name: 'Gateway Agent',
      adapterKind: 'claude-code',
      category: 'agentos-hosted',
      source: 'self-register',
      command: '/opt/homebrew/bin/claude',
      cwd: '/Users/shaw/AgentBean',
      gatewayInstanceKey: 'gateway-1',
      metadata: { provider: 'agentos' },
    };
    const createAgent: CreateAgentCommandDto = {
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
      env: { OPENAI_API_KEY: 'secret-value' },
    };
    const publishAgent: PublishAgentCommandDto = {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-custom-1',
      targetTeamId: 'team-2',
    };
    const unpublishAgent: UnpublishAgentCommandDto = {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-custom-1',
      targetTeamId: 'team-2',
    };
    const updateAgentConfig: UpdateAgentConfigCommandDto = {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-custom-1',
      name: 'Renamed Codex',
      env: { OPENAI_API_KEY: 'new-secret-value' },
    };
    const deleteAgent: DeleteAgentCommandDto = {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-custom-1',
    };

    expect(customAgent.source).toBe('custom');
    expect(ADAPTER_KINDS).toEqual(['codex', 'claude-code', 'gemini', 'kimi-cli', 'hermes', 'openclaw']);
    expect(AGENT_CATEGORIES).toEqual(['executor-hosted', 'agentos-hosted']);
    expect(AGENT_SOURCES).toEqual(['custom', 'self-register', 'scanned']);
    expect(AGENT_STATUSES).toEqual(['connecting', 'online', 'busy', 'offline', 'error']);
    expect(customAgent.envKeys).toEqual(['OPENAI_API_KEY']);
    expect(selfRegisteredAgent.category).toBe('agentos-hosted');
    expect(discovered.source).toBe('self-register');
    expect(discovered.gatewayInstanceKey).toBe('gateway-1');
    expect(createAgent.runtimeId).toBe('runtime-1');
    expect(publishAgent.targetTeamId).toBe('team-2');
    expect(unpublishAgent.targetTeamId).toBe('team-2');
    expect(updateAgentConfig.name).toBe('Renamed Codex');
    expect(deleteAgent.agentId).toBe('agent-custom-1');
  });
});
