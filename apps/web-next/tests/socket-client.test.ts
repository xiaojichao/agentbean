import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { WEB_EVENTS, type AgentDto, type ChannelDto, type DeviceDto, type DispatchDto, type MessageDto, type RuntimeDto } from '../../../packages/contracts/src/index';
import { createWebSocketClient, type WebSocketTransport } from '../src/index';
import { agentEvents, authEvents, deviceEvents, emitWithTimeout } from '../lib/socket';

describe('web-next socket client', () => {
  test('keeps artifact upload fallback aligned with the App Router teams proxy', async () => {
    const { artifactUploadFallbackUrls } = await import('../lib/artifact-upload');

    const urls = artifactUploadFallbackUrls('http://localhost:4100', 'team 1', 'token 1');

    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.includes('/api/teams/team%201/artifacts/upload'))).toBe(true);
    expect(urls.some((url) => url.startsWith('/api/teams/'))).toBe(true);
    expect(urls.every((url) => !url.includes('/api/networks/'))).toBe(true);
  });

  test('removes the legacy artifact route and legacy network payload fields from UI flows', () => {
    const appDir = join(process.cwd(), 'app');
    expect(existsSync(join(appDir, 'api/teams/[teamId]/artifacts/upload/route.ts'))).toBe(true);
    expect(existsSync(join(
      appDir,
      'api',
      ['net', 'works'].join(''),
      `[${['network', 'Id'].join('')}]`,
      'artifacts/upload/route.ts',
    ))).toBe(false);

    for (const relativePath of [
      '../components/add-agent-modal.tsx',
      '../components/register-agent-modal.tsx',
      '../components/new-channel-dialog.tsx',
      '../app/[teamPath]/devices/page.tsx',
      '../app/[teamPath]/agents/page.tsx',
      '../app/[teamPath]/agents/[agentId]/page.tsx',
      '../app/[teamPath]/dashboard/page.tsx',
      '../app/[teamPath]/settings/page.tsx',
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, relativePath).not.toContain('networkId');
      expect(source, relativePath).not.toContain('networkName');
    }
  });

  test('treats discovered executor runtimes only as custom Agent creation sources', () => {
    const pageSource = readFileSync(new URL('../app/register/page.tsx', import.meta.url), 'utf8');
    const modalSource = readFileSync(new URL('../components/register-agent-modal.tsx', import.meta.url), 'utf8');

    expect(pageSource).toContain('创建自定义 Agent');
    expect(pageSource).not.toContain('existingAgents');
    expect(pageSource).not.toContain('findRegisteredExecutor');
    expect(pageSource).not.toContain('编辑配置');
    expect(modalSource).not.toContain('setVisibility');
    expect(modalSource).not.toContain("mode === 'update'");
  });

  test('uses first-slice web events for auth, team, and message commands', async () => {
    const transport = new FakeWebTransport();
    const client = createWebSocketClient(transport);

    await expect(client.register({ username: 'shaw', password: 'secret', teamName: 'AgentBean' })).resolves.toEqual({
      ok: true,
      event: WEB_EVENTS.auth.register,
    });
    await client.login({ username: 'shaw', password: 'secret' });
    await client.whoami({ token: 'token-1' });
    await client.listTeams({ userId: 'user-1' });
    await client.createTeam({ userId: 'user-1', name: 'Ops Team' });
    await client.switchTeam({ userId: 'user-1', teamId: 'team-2' });
    await client.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await client.validateJoinLink({ code: 'join-1' });
    await client.listJoinLinks({ userId: 'user-1', teamId: 'team-1' });
    await client.revokeJoinLink({ userId: 'user-1', teamId: 'team-1', code: 'join-1' });
    await client.createDeviceInvite({ userId: 'user-1', teamId: 'team-1', profileId: 'agentbean-next' });
    await client.completeDeviceInvite({ userId: 'user-1', code: 'device-code-1' });
    await client.listDevices({ userId: 'user-1', teamId: 'team-1' });
    await client.getDevice({ userId: 'user-1', deviceId: 'device-1' });
    await client.scanDevice({ userId: 'user-1', deviceId: 'device-1' });
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
    await client.createAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
    });
    await client.updateAgentConfig({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      name: 'Renamed Codex',
    });
    await client.deleteAgent({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
    });
    await client.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
    });
    await client.cancelDispatch({
      userId: 'user-1',
      dispatchId: 'dispatch-1',
    });

    expect(transport.emitted).toEqual([
      [WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'AgentBean' }],
      [WEB_EVENTS.auth.login, { username: 'shaw', password: 'secret' }],
      [WEB_EVENTS.auth.whoami, { token: 'token-1' }],
      [WEB_EVENTS.team.list, { userId: 'user-1' }],
      [WEB_EVENTS.team.create, { userId: 'user-1', name: 'Ops Team' }],
      [WEB_EVENTS.team.switch, { userId: 'user-1', teamId: 'team-2' }],
      [WEB_EVENTS.join.create, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.join.validate, { code: 'join-1' }],
      [WEB_EVENTS.join.list, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.join.revoke, { userId: 'user-1', teamId: 'team-1', code: 'join-1' }],
      [WEB_EVENTS.deviceInvite.create, { userId: 'user-1', teamId: 'team-1', profileId: 'agentbean-next' }],
      [WEB_EVENTS.deviceInvite.complete, { userId: 'user-1', code: 'device-code-1' }],
      [WEB_EVENTS.device.list, { userId: 'user-1', teamId: 'team-1' }],
      [WEB_EVENTS.device.get, { userId: 'user-1', deviceId: 'device-1' }],
      [WEB_EVENTS.device.scan, { userId: 'user-1', deviceId: 'device-1' }],
      [WEB_EVENTS.channel.create, { userId: 'user-1', teamId: 'team-1', name: 'ops', visibility: 'private' }],
      [WEB_EVENTS.channel.update, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', title: 'Team-wide updates' }],
      [WEB_EVENTS.channel.addMember, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', memberUserId: 'user-2' }],
      [WEB_EVENTS.channel.removeMember, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', memberUserId: 'user-2' }],
      [WEB_EVENTS.channel.addAgent, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', agentId: 'agent-1' }],
      [WEB_EVENTS.channel.removeAgent, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', agentId: 'agent-1' }],
      [WEB_EVENTS.channel.members, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2' }],
      [WEB_EVENTS.agent.create, { userId: 'user-1', teamId: 'team-1', deviceId: 'device-1', runtimeId: 'runtime-1', name: 'Custom Codex' }],
      [WEB_EVENTS.agent.updateConfig, { userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', name: 'Renamed Codex' }],
      [WEB_EVENTS.agent.delete, { userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' }],
      [WEB_EVENTS.message.send, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'hello' }],
      [WEB_EVENTS.dispatch.cancel, { userId: 'user-1', dispatchId: 'dispatch-1' }],
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
      installed: true,
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
      status: 'succeeded',
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

  test('allows session-authenticated commands to omit userId', async () => {
    const transport = new FakeWebTransport();
    const client = createWebSocketClient(transport);

    await client.listTeams({});
    await client.createTeam({ name: 'Ops Team' });
    await client.switchTeam({ teamId: 'team-2' });
    await client.createJoinLink({ teamId: 'team-1' });
    await client.listJoinLinks({ teamId: 'team-1' });
    await client.revokeJoinLink({ teamId: 'team-1', code: 'join-1' });
    await client.createDeviceInvite({ teamId: 'team-1' });
    await client.completeDeviceInvite({ code: 'device-code-1' });
    await client.subscribeChannels({ teamId: 'team-1' }, () => undefined);
    await client.listDevices({ teamId: 'team-1' });
    await client.createAgent({
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
    });
    await client.sendMessage({
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
    });

    expect(transport.emitted).toEqual([
      [WEB_EVENTS.team.list, {}],
      [WEB_EVENTS.team.create, { name: 'Ops Team' }],
      [WEB_EVENTS.team.switch, { teamId: 'team-2' }],
      [WEB_EVENTS.join.create, { teamId: 'team-1' }],
      [WEB_EVENTS.join.list, { teamId: 'team-1' }],
      [WEB_EVENTS.join.revoke, { teamId: 'team-1', code: 'join-1' }],
      [WEB_EVENTS.deviceInvite.create, { teamId: 'team-1' }],
      [WEB_EVENTS.deviceInvite.complete, { code: 'device-code-1' }],
      [WEB_EVENTS.channel.subscribe, { teamId: 'team-1' }],
      [WEB_EVENTS.device.list, { teamId: 'team-1' }],
      [WEB_EVENTS.agent.create, {
        teamId: 'team-1',
        deviceId: 'device-1',
        runtimeId: 'runtime-1',
        name: 'Custom Codex',
      }],
      [WEB_EVENTS.message.send, { teamId: 'team-1', channelId: 'channel-1', body: 'hello' }],
    ]);
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

  test('agentEvents.setVisibility emits agent:set-visibility with teamId and visible', async () => {
    // 用最小 fake socket（socket.io 风格 emit(event, payload, ack)）测试 lib/socket.ts 中的 agentEvents
    const fakeSocket = new FakeAgentEventsSocket();
    const { agentEvents } = await import('../lib/socket.js');
    const res = await agentEvents(fakeSocket as any).setVisibility('agent-1', 'team-1', false);
    expect(res.ok).toBe(true);
    expect(fakeSocket.emitted).toEqual([
      [WEB_EVENTS.agent.setVisibility, { agentId: 'agent-1', teamId: 'team-1', visible: false }],
    ]);
  });

  test('uses canonical Team fields for agent, invite, device-agent, and snapshot payloads', async () => {
    const socket = new CanonicalSocket();
    socket.responses.set(WEB_EVENTS.agent.create, {
      ok: true,
      agent: {
        id: 'agent-1',
        primaryTeamId: 'team-1',
        visibleTeamIds: ['team-1'],
        name: 'Codex',
        adapterKind: 'codex',
        status: 'online',
        lastSeenAt: 1,
        connectCommand: 'codex',
      },
    });

    const created = await agentEvents(socket as any).create({
      teamId: 'team-1',
      deviceId: 'device-1',
      name: 'Codex',
      adapterKind: 'codex',
      command: 'codex',
    });
    expect(socket.lastPayload(WEB_EVENTS.agent.create)).toMatchObject({ teamId: 'team-1', deviceId: 'device-1' });
    expect(JSON.stringify(created.agent)).not.toContain('networkId');
    expect(JSON.stringify(created.agent)).not.toContain('publishedNetworkIds');

    await authEvents(socket as any).inviteCreate({ teamId: 'team-1', purpose: 'device' });
    expect(socket.lastPayload(WEB_EVENTS.deviceInvite.create)).toEqual({
      teamId: 'team-1',
      purpose: 'device',
    });

    await deviceEvents(socket as any).agentsList('device-1', 'team-1');
    expect(socket.lastPayload(WEB_EVENTS.device.agentsList)).toEqual({
      deviceId: 'device-1',
      teamId: 'team-1',
    });

    const snapshots: unknown[] = [];
    agentEvents(socket as any).onSnapshot((snapshot) => snapshots.push(snapshot));
    await socket.trigger(WEB_EVENTS.agent.snapshot, [{
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      status: 'online',
      lastSeenAt: 1,
      connectCommand: 'codex',
    }]);
    expect(JSON.stringify(snapshots)).not.toContain('networkId');
    expect(JSON.stringify(snapshots)).not.toContain('publishedNetworkIds');
  });

  test('keeps device and admin snapshots on canonical Team fields', async () => {
    const schemaSource = readFileSync(new URL('../lib/schema.ts', import.meta.url), 'utf8');
    expect(schemaSource).toContain('teamId: string;');
    expect(schemaSource).toContain('teamName?: string;');
    expect(schemaSource).not.toContain('networkId');
    expect(schemaSource).not.toContain('networkName');
    expect(schemaSource).not.toContain('publishedNetworkIds');
    expect(schemaSource).not.toContain('unpublishedNetworkIds');

    const socket = new CanonicalSocket();
    const device = {
      id: 'device-1',
      teamId: 'team-1',
      teamName: 'Ops',
      status: 'online',
      lastSeenAt: 1,
      agentIds: ['agent-1'],
    };
    const adminAgent = {
      id: 'agent-1',
      primaryTeamId: 'team-1',
      primaryTeamName: 'Ops',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      status: 'online',
    };
    socket.responses.set(WEB_EVENTS.admin.listDevices, { ok: true, devices: [device] });
    socket.responses.set(WEB_EVENTS.admin.listAgents, { ok: true, agents: [adminAgent] });

    const deviceSnapshots: unknown[] = [];
    deviceEvents(socket as any).onSnapshot((snapshot) => deviceSnapshots.push(snapshot));
    await socket.trigger(WEB_EVENTS.device.snapshot, [device]);
    expect(deviceSnapshots).toEqual([[device]]);

    const adminDevices = await emitWithTimeout(socket as any, WEB_EVENTS.admin.listDevices, {});
    const adminAgents = await emitWithTimeout(socket as any, WEB_EVENTS.admin.listAgents, {});
    expect(adminDevices).toMatchObject({ ok: true, devices: [{ teamId: 'team-1', teamName: 'Ops' }] });
    expect(adminAgents).toMatchObject({
      ok: true,
      agents: [{ primaryTeamId: 'team-1', primaryTeamName: 'Ops', visibleTeamIds: ['team-1'] }],
    });
    expect(JSON.stringify({ deviceSnapshots, adminDevices, adminAgents })).not.toContain('networkId');
    expect(JSON.stringify({ deviceSnapshots, adminDevices, adminAgents })).not.toContain('networkName');
    expect(JSON.stringify({ deviceSnapshots, adminDevices, adminAgents })).not.toContain('publishedNetworkIds');
    expect(JSON.stringify({ deviceSnapshots, adminDevices, adminAgents })).not.toContain('unpublishedNetworkIds');
  });

  test('returns canonical teamId and teamPath from device login', async () => {
    const socket = new CanonicalSocket();
    socket.responses.set(WEB_EVENTS.auth.login, {
      ok: true,
      token: 'token-1',
      user: { id: 'user-1', username: 'shaw', role: 'user' },
      currentTeam: { id: 'team-1', name: 'Ops', path: 'ops' },
    });
    socket.responses.set(WEB_EVENTS.deviceInvite.complete, {
      ok: true,
      team: { id: 'team-1', name: 'Ops', path: 'ops' },
      credentials: { deviceId: 'device-1' },
    });

    const result = await authEvents(socket as any).deviceLogin({
      inviteCode: 'invite-1',
      username: 'shaw',
      password: 'secret',
    });

    expect(result).toMatchObject({
      ok: true,
      token: 'token-1',
      teamId: 'team-1',
      teamPath: 'ops',
      userId: 'user-1',
      username: 'shaw',
      role: 'user',
      deviceId: 'device-1',
    });
    expect(JSON.stringify(result)).not.toContain('networkId');
    expect(JSON.stringify(result)).not.toContain('networkPath');
    expect(socket.emitted).toEqual([
      [WEB_EVENTS.auth.login, { username: 'shaw', password: 'secret' }],
      [WEB_EVENTS.deviceInvite.complete, { code: 'invite-1', userId: 'user-1' }],
    ]);
  });

  test('returns the canonical join link and team response shape', async () => {
    const socket = new CanonicalSocket();
    socket.responses.set(WEB_EVENTS.join.validate, {
      ok: true,
      link: { id: 'join-1', code: 'code-1', teamId: 'team-1' },
      team: { id: 'team-1', name: 'Ops', path: 'ops' },
    });

    const { joinEvents } = await import('../lib/socket.js');
    const result = await joinEvents(socket as any).validate({ code: 'code-1' });

    expect(result).toMatchObject({
      ok: true,
      link: { code: 'code-1', teamId: 'team-1' },
      team: { id: 'team-1', name: 'Ops', path: 'ops' },
    });

    const joinPageSource = readFileSync(new URL('../app/join/[token]/page.tsx', import.meta.url), 'utf8');
    expect(joinPageSource).toContain('res.team?.name');
    expect(joinPageSource).not.toContain('res.teamName');
  });

  test('presents scanned AgentOS agents as server-managed Team members', () => {
    const registerPageSource = readFileSync(new URL('../app/register/page.tsx', import.meta.url), 'utf8');
    expect(registerPageSource).toContain('已由设备自动注册');
    expect(registerPageSource).not.toContain('Mesh');
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

// 最小 fake socket：模拟 socket.io 的 emit(event, payload, ack)
// 仅满足 lib/socket.ts 中 agentEvents().setVisibility 走 emitWithTimeout 的路径。
// ack 回调同步以 { ok: true } 调用，[event, payload] 记入 emitted 供断言。
class FakeAgentEventsSocket {
  readonly emitted: Array<[string, unknown]> = [];

  emit(event: string, payload: unknown, ack: (res: unknown) => void): this {
    this.emitted.push([event, payload]);
    ack({ ok: true });
    return this;
  }

  on(): this { return this; }
  off(): this { return this; }
}

class CanonicalSocket {
  readonly emitted: Array<[string, unknown]> = [];
  readonly responses = new Map<string, unknown>();
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

  emit(event: string, payload: unknown, ack: (res: unknown) => void): this {
    this.emitted.push([event, payload]);
    ack(this.responses.get(event) ?? { ok: true });
    return this;
  }

  on(event: string, handler: (payload: unknown) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  off(event?: string, handler?: (payload: unknown) => void): this {
    if (!event) return this;
    if (!handler) {
      this.handlers.delete(event);
      return this;
    }
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
    return this;
  }

  lastPayload(event: string): unknown {
    return [...this.emitted].reverse().find(([candidate]) => candidate === event)?.[1];
  }

  async trigger(event: string, payload: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload);
  }
}
