import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS, WEB_EVENTS, makeFailure, makeSuccess } from '../../../packages/contracts/src/index';
import { createServerNextUseCases, type ServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';
import { createInMemoryServerNext } from '../src/index';
import { attachServerNextNamespaces } from '../src/transport/socket-server';

type SocketIoServerConstructor = new (server: HttpServer, options?: Record<string, unknown>) => {
  of(namespace: string): unknown;
  close(callback?: () => void): void;
};
type ClientSocket = {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  emit(event: string, payload: unknown): void;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Server } = requireFromServer('socket.io') as { Server: SocketIoServerConstructor };
const { io: createClient } = requireFromServer('socket.io-client') as {
  io(url: string, options?: Record<string, unknown>): ClientSocket;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('server-next Socket.IO namespaces', () => {
  test('serves first-slice /web and /agent event flows through real Socket.IO clients', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'device-1',
        'runtime-1',
        'agent-1',
        'message-1',
        'dispatch-1',
        'request-1',
        'reply-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      agent.disconnect();
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.auth.register, {
        username: 'shaw',
        password: 'secret',
        teamName: 'AgentBean',
      }),
    ).resolves.toMatchObject({
      ok: true,
      user: { id: 'user-1', primaryTeamId: 'team-1' },
      currentTeam: { id: 'team-1' },
      defaultChannel: { id: 'channel-1' },
    });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });
    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.runtimes, {
        teamId: 'team-1',
        deviceId: 'device-1',
        runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      }),
    ).resolves.toMatchObject({ ok: true, runtimes: [{ id: 'runtime-1', adapterKind: 'codex' }] });
    await expect(
      agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      }),
    ).resolves.toMatchObject({ ok: true, agents: [{ id: 'agent-1', status: 'online' }] });

    const channelMessages: unknown[] = [];
    web.on(WEB_EVENTS.channel.message, (message) => {
      channelMessages.push(message);
    });
    await expect(
      web.emitWithAck(WEB_EVENTS.channel.subscribe, {
        userId: 'user-1',
        teamId: 'team-1',
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      web.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        body: '@Codex hello',
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', senderKind: 'human' },
      dispatches: [{ id: 'dispatch-1', requestId: 'request-1' }],
    });
    await expect(
      agent.emitWithAck(AGENT_EVENTS.dispatch.result, {
        dispatchId: 'dispatch-1',
        agentId: 'agent-1',
        body: 'done',
      }),
    ).resolves.toMatchObject({
      ok: true,
      dispatch: { id: 'dispatch-1', status: 'succeeded' },
      message: { id: 'reply-1', senderKind: 'agent', body: 'done' },
    });
    await eventually(async () => {
      expect(channelMessages).toEqual([
        expect.objectContaining({ id: 'message-1', senderKind: 'human', body: '@Codex hello' }),
        expect.objectContaining({ id: 'reply-1', senderKind: 'agent', body: 'done' }),
      ]);
    });
  });

  test('derives web command user identity from authenticated socket session', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrap = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      bootstrap.disconnect();
    });
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    expect(registerAck).toMatchObject({
      ok: true,
      token: expect.any(String),
      currentTeam: { id: 'team-1' },
      defaultChannel: { id: 'channel-1' },
    });

    const web = await connectClient(`${baseUrl}/web`, { auth: { token: (registerAck as { token: string }).token } });
    cleanups.push(async () => {
      web.disconnect();
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.channel.subscribe, {
        teamId: 'team-1',
      }),
    ).resolves.toMatchObject({ ok: true, channels: [{ id: 'channel-1' }] });
    await expect(
      web.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'attacker-user',
        teamId: 'team-1',
        channelId: 'channel-1',
        body: 'hello from session',
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', senderKind: 'human', senderId: 'user-1' },
    });
  });

  test('creates, validates, and consumes a user join link through web sockets', async () => {
    const app = createInMemoryServerNext({
      now: () => 1100,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'join-1', 'user-2', 'team-2', 'channel-2']),
      joinCodes: createIds(['code-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const ownerBootstrap = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      ownerBootstrap.disconnect();
    });
    const ownerRegister = await ownerBootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    expect(ownerRegister).toMatchObject({
      ok: true,
      token: expect.any(String),
      currentTeam: { id: 'team-1' },
    });

    const owner = await connectClient(`${baseUrl}/web`, { auth: { token: (ownerRegister as { token: string }).token } });
    const guest = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      owner.disconnect();
      guest.disconnect();
    });

    await expect(owner.emitWithAck(WEB_EVENTS.join.create, { teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      link: { code: 'code-1', teamId: 'team-1', usesCount: 0 },
      team: { id: 'team-1' },
    });
    await expect(guest.emitWithAck(WEB_EVENTS.join.validate, { code: 'code-1' })).resolves.toMatchObject({
      ok: true,
      link: { code: 'code-1', teamId: 'team-1' },
      team: { id: 'team-1', name: 'AgentBean' },
    });
    await expect(
      guest.emitWithAck(WEB_EVENTS.auth.register, {
        username: 'lin',
        password: 'secret',
        teamName: 'Lin Private',
        joinCode: 'code-1',
      }),
    ).resolves.toMatchObject({
      ok: true,
      user: { id: 'user-2', primaryTeamId: 'team-1' },
      currentTeam: { id: 'team-1', currentUserRole: 'member' },
      joinedTeam: { id: 'team-1', currentUserRole: 'member' },
    });
    await expect(guest.emitWithAck(WEB_EVENTS.join.validate, { code: 'code-1' })).resolves.toMatchObject({
      ok: false,
      error: 'INVITE_ALREADY_USED',
    });
  });

  test('delivers completed device invite credentials to the waiting daemon socket', async () => {
    const app = createInMemoryServerNext({
      now: () => 1200,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-invite-1', 'device-1']),
      deviceInviteCodes: createIds(['device-code-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrap = await connectClient(`${baseUrl}/web`);
    const daemon = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      daemon.disconnect();
    });
    const register = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    const owner = await connectClient(`${baseUrl}/web`, { auth: { token: (register as { token: string }).token } });
    cleanups.push(async () => {
      owner.disconnect();
    });

    await expect(
      owner.emitWithAck(WEB_EVENTS.deviceInvite.create, { teamId: 'team-1', profileId: 'agentbean-next' }),
    ).resolves.toMatchObject({
      ok: true,
      invite: { code: 'device-code-1', teamId: 'team-1', profileId: 'agentbean-next' },
    });
    const deliveredCredentials: unknown[] = [];
    daemon.on(AGENT_EVENTS.deviceInvite.credentials, (payload) => {
      deliveredCredentials.push(payload);
    });

    await expect(
      daemon.emitWithAck(AGENT_EVENTS.deviceInvite.wait, {
        code: 'device-code-1',
        machineId: 'machine-1',
        hostname: 'shaw-mbp',
      }),
    ).resolves.toMatchObject({
      ok: true,
      invite: { code: 'device-code-1', teamId: 'team-1' },
    });
    const completed = await owner.emitWithAck(WEB_EVENTS.deviceInvite.complete, {
      code: 'device-code-1',
      serverUrl: baseUrl,
    });
    expect(completed).toMatchObject({
      ok: true,
      credentials: {
        token: expect.stringMatching(/^abn_device\./),
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'agentbean-next',
        hostname: 'shaw-mbp',
        serverUrl: baseUrl,
      },
    });
    await eventually(async () => {
      expect(deliveredCredentials).toEqual([(completed as { credentials: unknown }).credentials]);
    });

    await expect(
      daemon.emitWithAck(AGENT_EVENTS.device.hello, {
        token: (completed as { credentials: { token: string } }).credentials.token,
        machineId: 'machine-1',
        profileId: 'agentbean-next',
        hostname: 'shaw-mbp',
      }),
    ).resolves.toMatchObject({
      ok: true,
      device: { id: 'device-1', teamId: 'team-1', ownerId: 'user-1' },
    });
  });

  test.each(['not-a-valid-token', ''])(
    'rejects invalid authenticated socket token %j instead of falling back to payload userId',
    async (token) => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrap = await connectClient(`${baseUrl}/web`);
    const web = await connectClient(`${baseUrl}/web`, { auth: { token } });
    cleanups.push(async () => {
      bootstrap.disconnect();
      web.disconnect();
    });
    await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.channel.subscribe, {
        userId: 'user-1',
        teamId: 'team-1',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    },
  );

  test('refreshes per-user channel snapshots after membership changes', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1000 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-all', 'channel-ops']) },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'user-2',
      username: 'teammate',
      role: 'member',
      joinedAt: 1000,
    });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'ops',
      visibility: 'private',
    });

    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const owner = await connectClient(`${baseUrl}/web`);
    const teammate = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      owner.disconnect();
      teammate.disconnect();
    });

    const ownerSnapshots: string[][] = [];
    const teammateSnapshots: string[][] = [];
    owner.on(WEB_EVENTS.channel.snapshot, (channels) => {
      ownerSnapshots.push(channelIds(channels));
    });
    teammate.on(WEB_EVENTS.channel.snapshot, (channels) => {
      teammateSnapshots.push(channelIds(channels));
    });

    await expect(
      owner.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      teammate.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-2', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true });

    await eventually(async () => {
      expect(ownerSnapshots.at(-1)).toEqual(['channel-all', 'channel-ops']);
      expect(teammateSnapshots.at(-1)).toEqual(['channel-all']);
    });

    await expect(
      owner.emitWithAck(WEB_EVENTS.channel.addMember, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        memberUserId: 'user-2',
      }),
    ).resolves.toMatchObject({ ok: true });
    await eventually(async () => {
      expect(ownerSnapshots.at(-1)).toEqual(['channel-all', 'channel-ops']);
      expect(teammateSnapshots.at(-1)).toEqual(['channel-all', 'channel-ops']);
    });

    await expect(
      owner.emitWithAck(WEB_EVENTS.channel.removeMember, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        memberUserId: 'user-2',
      }),
    ).resolves.toMatchObject({ ok: true });
    await eventually(async () => {
      expect(ownerSnapshots.at(-1)).toEqual(['channel-all', 'channel-ops']);
      expect(teammateSnapshots.at(-1)).toEqual(['channel-all']);
    });
  });

  test('keeps channel subscription ack successful when DM snapshot refresh fails', async () => {
    const socket = new IntegrationFakeSocket();
    const namespace = new IntegrationFakeNamespace();
    namespace.nextSocket = socket;
    const dmError = new Error('dm store unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = {
      listChannels: async () => makeSuccess({ channels: [{ id: 'channel-1', teamId: 'team-1' }] }),
      listDirectMessages: async () => {
        throw dmError;
      },
    } as unknown as ServerNextUseCases;

    try {
      attachServerNextNamespaces(new IntegrationFakeServer(namespace), app);

      await expect(socket.trigger(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' })).resolves.toEqual({
        ok: true,
        channels: [{ id: 'channel-1', teamId: 'team-1' }],
      });
      expect(socket.emitted).toEqual([
        { event: WEB_EVENTS.channel.snapshot, payload: [{ id: 'channel-1', teamId: 'team-1' }] },
      ]);
      expect(warn).toHaveBeenCalledWith('[socket] DM snapshot push failed (non-blocking):', dmError);
    } finally {
      warn.mockRestore();
    }
  });

  test('handles DM start, list, and snapshot through custom socket handlers', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-all',
        'device-1',
        'agent-1',
        'dm-channel-1',
        'message-1',
        'dispatch-1',
        'request-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const bootstrap = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      agent.disconnect();
    });

    const register = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    const web = await connectClient(`${baseUrl}/web`, { auth: { token: (register as { token: string }).token } });
    cleanups.push(async () => {
      web.disconnect();
    });
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    const dmSnapshots: unknown[] = [];
    web.on(WEB_EVENTS.dm.snapshot, (dms) => {
      dmSnapshots.push(dms);
    });
    await expect(
      web.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true, channels: [{ id: 'channel-all' }] });
    await eventually(async () => {
      expect(dmSnapshots.at(-1)).toEqual([]);
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.dm.start, { agentId: 'agent-1' }),
    ).resolves.toMatchObject({
      ok: true,
      dm: { id: 'dm-channel-1', name: 'dm-user-1-agent-1', dmTargetId: 'agent-1', createdAt: 1000 },
    });
    await eventually(async () => {
      expect(dmSnapshots.at(-1)).toEqual([
        { id: 'dm-channel-1', name: 'dm-user-1-agent-1', dmTargetId: 'agent-1', createdAt: 1000 },
      ]);
    });

    await expect(web.emitWithAck(WEB_EVENTS.dm.list, {})).resolves.toEqual({
      ok: true,
      dms: [{ id: 'dm-channel-1', name: 'dm-user-1-agent-1', dmTargetId: 'agent-1', createdAt: 1000 }],
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'dm-channel-1',
        body: 'hello',
      }),
    ).resolves.toMatchObject({ ok: true, message: { id: 'message-1', channelId: 'dm-channel-1' } });
    await expect(
      web.emitWithAck(WEB_EVENTS.dm.snapshot, { channelId: 'dm-channel-1' }),
    ).resolves.toMatchObject({
      ok: true,
      dm: { id: 'dm-channel-1', dmTargetId: 'agent-1' },
      messages: [{ id: 'message-1', body: 'hello' }],
    });
  });

  test('refreshes agent snapshots after daemon agent reports change status', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-all', 'device-1', 'agent-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      agent.disconnect();
    });

    await web.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });

    const agentSnapshots: Array<Array<{ id: string; status: string }>> = [];
    web.on(WEB_EVENTS.agent.snapshot, (agents) => {
      agentSnapshots.push(agentSummaries(agents));
    });
    await expect(
      web.emitWithAck(WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true, agents: [] });
    await eventually(async () => {
      expect(agentSnapshots.at(-1)).toEqual([]);
    });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1' } });
    await expect(
      agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      }),
    ).resolves.toMatchObject({ ok: true, agents: [{ id: 'agent-1', status: 'online' }] });
    await eventually(async () => {
      expect(agentSnapshots.at(-1)).toEqual([{ id: 'agent-1', status: 'online' }]);
    });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [],
      }),
    ).resolves.toMatchObject({ ok: true, missingOfflineIds: ['agent-1'] });
    await eventually(async () => {
      expect(agentSnapshots.at(-1)).toEqual([{ id: 'agent-1', status: 'offline' }]);
    });
  });

  test('stops refreshing agent snapshots when a subscribed user loses team access', async () => {
    let channelGateCalls = 0;
    let visibleAgentCalls = 0;
    const app = {
      listChannels: async () => {
        channelGateCalls += 1;
        return channelGateCalls === 1
          ? makeSuccess({ channels: [] })
          : makeFailure('FORBIDDEN', 'User is not a team member');
      },
      listVisibleAgents: async () => {
        visibleAgentCalls += 1;
        return makeSuccess({ agents: [{ id: 'agent-1', status: 'online' }] });
      },
      registerDiscoveredAgents: async () => makeSuccess({ agents: [], missingOfflineIds: [] }),
    } as unknown as ServerNextUseCases;
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      agent.disconnect();
    });

    const agentSnapshots: unknown[] = [];
    web.on(WEB_EVENTS.agent.snapshot, (agents) => {
      agentSnapshots.push(agents);
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true });
    await eventually(async () => {
      expect(agentSnapshots).toHaveLength(1);
      expect(visibleAgentCalls).toBe(1);
    });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      }),
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(channelGateCalls).toBe(2);
    expect(visibleAgentCalls).toBe(1);
    expect(agentSnapshots).toHaveLength(1);
  });

  test('refreshes device snapshots and runtimes after daemon device reports', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-all', 'device-1', 'runtime-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      agent.disconnect();
    });

    await web.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });

    const deviceSnapshots: Array<Array<{ id: string; status: string }>> = [];
    const runtimeEvents: Array<{
      deviceId: string;
      runtimes: Array<{ id: string; name: string; installed: boolean; command?: string; normalizedCommandKey?: string }>;
    }> = [];
    web.on(WEB_EVENTS.device.snapshot, (devices) => {
      deviceSnapshots.push(deviceSummaries(devices));
    });
    web.on(WEB_EVENTS.device.runtimes, (payload) => {
      runtimeEvents.push(runtimeSummary(payload));
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.device.list, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true, devices: [] });
    await eventually(async () => {
      expect(deviceSnapshots.at(-1)).toEqual([]);
    });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });
    await eventually(async () => {
      expect(deviceSnapshots.at(-1)).toEqual([{ id: 'device-1', status: 'online' }]);
    });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.runtimes, {
        teamId: 'team-1',
        deviceId: 'device-1',
        runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI', command: '/opt/homebrew/bin/codex' }],
      }),
    ).resolves.toMatchObject({
      ok: true,
      runtimes: [
        {
          id: 'runtime-1',
          name: 'Codex CLI',
          installed: true,
          command: '/opt/homebrew/bin/codex',
          normalizedCommandKey: '/opt/homebrew/bin/codex',
        },
      ],
    });
    await eventually(async () => {
      expect(runtimeEvents.at(-1)).toEqual({
        deviceId: 'device-1',
        runtimes: [
          {
            id: 'runtime-1',
            name: 'Codex CLI',
            installed: true,
            command: '/opt/homebrew/bin/codex',
            normalizedCommandKey: '/opt/homebrew/bin/codex',
          },
        ],
      });
    });

    const lateWeb = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      lateWeb.disconnect();
    });
    const lateRuntimeEvents: Array<{
      deviceId: string;
      runtimes: Array<{ id: string; name: string; installed: boolean; command?: string; normalizedCommandKey?: string }>;
    }> = [];
    lateWeb.on(WEB_EVENTS.device.runtimes, (payload) => {
      lateRuntimeEvents.push(runtimeSummary(payload));
    });

    await expect(
      lateWeb.emitWithAck(WEB_EVENTS.device.list, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({
      ok: true,
      devices: [{ id: 'device-1', status: 'online' }],
    });
    await eventually(async () => {
      expect(lateRuntimeEvents.at(-1)).toEqual({
        deviceId: 'device-1',
        runtimes: [
          {
            id: 'runtime-1',
            name: 'Codex CLI',
            installed: true,
            command: '/opt/homebrew/bin/codex',
            normalizedCommandKey: '/opt/homebrew/bin/codex',
          },
        ],
      });
    });
  });

  test('creates custom agents from runtime capability and refreshes agent snapshots', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-all', 'device-1', 'runtime-1', 'agent-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      agent.disconnect();
    });

    await web.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await agent.emitWithAck(AGENT_EVENTS.device.runtimes, {
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [
        {
          adapterKind: 'codex',
          name: 'Codex CLI',
          command: '/opt/homebrew/bin/codex',
          cwd: '/Users/shaw/AgentBean',
          installed: true,
        },
      ],
    });

    const agentSnapshots: unknown[][] = [];
    web.on(WEB_EVENTS.agent.snapshot, (agents) => {
      if (!Array.isArray(agents)) {
        throw new Error('Expected agent snapshot payload to be an array');
      }
      agentSnapshots.push(agents);
    });
    await web.emitWithAck(WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' });
    await eventually(async () => {
      expect(agentSnapshots.at(-1)).toEqual([]);
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.agent.create, {
        userId: 'user-1',
        teamId: 'team-1',
        deviceId: 'device-1',
        runtimeId: 'runtime-1',
        name: 'Custom Codex',
        env: { OPENAI_API_KEY: 'secret-value' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      agent: {
        id: 'agent-1',
        source: 'custom',
        command: '/opt/homebrew/bin/codex',
        envKeys: ['OPENAI_API_KEY'],
      },
    });
    await eventually(async () => {
      expect(agentSnapshots.at(-1)).toMatchObject([
        {
          id: 'agent-1',
          name: 'Custom Codex',
          source: 'custom',
          envKeys: ['OPENAI_API_KEY'],
        },
      ]);
    });
    expect(JSON.stringify(agentSnapshots)).not.toContain('secret-value');
  });

  test('refreshes published team agent and channel snapshots after custom agent management', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-all',
        'team-2',
        'channel-client',
        'device-1',
        'runtime-1',
        'agent-1',
        'channel-client-room',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const target = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      target.disconnect();
      agent.disconnect();
    });

    const targetAgentSnapshots: unknown[][] = [];
    const targetChannelSnapshots: unknown[][] = [];
    target.on(WEB_EVENTS.agent.snapshot, (agents) => {
      if (!Array.isArray(agents)) {
        throw new Error('Expected agent snapshot payload to be an array');
      }
      targetAgentSnapshots.push(agents);
    });
    target.on(WEB_EVENTS.channel.snapshot, (channels) => {
      if (!Array.isArray(channels)) {
        throw new Error('Expected channel snapshot payload to be an array');
      }
      targetChannelSnapshots.push(channels);
    });

    await web.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    await expect(web.emitWithAck(WEB_EVENTS.team.create, { userId: 'user-1', name: 'Client Team' })).resolves.toMatchObject({
      ok: true,
      team: { id: 'team-2' },
    });
    await target.emitWithAck(WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-2' });
    await target.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-2' });
    await eventually(async () => {
      expect(targetAgentSnapshots.at(-1)).toEqual([]);
      expect(channelIds(targetChannelSnapshots.at(-1))).toEqual(['channel-client']);
    });

    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await agent.emitWithAck(AGENT_EVENTS.device.runtimes, {
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [{ adapterKind: 'codex', name: 'Codex CLI', installed: true }],
    });
    await expect(web.emitWithAck(WEB_EVENTS.agent.create, {
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
    })).resolves.toMatchObject({ ok: true, agent: { id: 'agent-1' } });
    await expect(web.emitWithAck(WEB_EVENTS.agent.publish, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
    })).resolves.toMatchObject({ ok: true });
    await eventually(async () => {
      expect(targetAgentSnapshots.at(-1)).toMatchObject([{ id: 'agent-1', name: 'Custom Codex' }]);
    });
    await expect(web.emitWithAck(WEB_EVENTS.channel.create, {
      userId: 'user-1',
      teamId: 'team-2',
      name: 'ops',
      visibility: 'public',
    })).resolves.toMatchObject({ ok: true, channel: { id: 'channel-client-room' } });

    await expect(web.emitWithAck(WEB_EVENTS.channel.addAgent, {
      userId: 'user-1',
      teamId: 'team-2',
      channelId: 'channel-client-room',
      agentId: 'agent-1',
    })).resolves.toMatchObject({ ok: true, channel: { agentMemberIds: ['agent-1'] } });
    await eventually(async () => {
      expect(targetChannelSnapshots.at(-1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'channel-client-room', agentMemberIds: ['agent-1'] }),
      ]));
    });

    await web.emitWithAck(WEB_EVENTS.agent.updateConfig, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      name: 'Renamed Codex',
    });
    await eventually(async () => {
      expect(targetAgentSnapshots.at(-1)).toMatchObject([{ id: 'agent-1', name: 'Renamed Codex' }]);
    });

    await web.emitWithAck(WEB_EVENTS.agent.unpublish, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
    });
    await eventually(async () => {
      expect(targetAgentSnapshots.at(-1)).toEqual([]);
      expect(targetChannelSnapshots.at(-1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'channel-client-room', agentMemberIds: [] }),
      ]));
    });

    await web.emitWithAck(WEB_EVENTS.agent.publish, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
    });
    await web.emitWithAck(WEB_EVENTS.channel.addAgent, {
      userId: 'user-1',
      teamId: 'team-2',
      channelId: 'channel-client-room',
      agentId: 'agent-1',
    });
    await web.emitWithAck(WEB_EVENTS.agent.delete, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
    });
    await eventually(async () => {
      expect(targetAgentSnapshots.at(-1)).toEqual([]);
      expect(targetChannelSnapshots.at(-1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'channel-client-room', agentMemberIds: [] }),
      ]));
    });
  });

  test('sends custom agent dispatch secrets only to the daemon that owns the target device', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-all',
        'device-1',
        'runtime-1',
        'device-2',
        'runtime-2',
        'agent-1',
        'message-1',
        'dispatch-1',
        'request-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const targetDaemon = await connectClient(`${baseUrl}/agent`);
    const otherDaemon = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      targetDaemon.disconnect();
      otherDaemon.disconnect();
    });

    const targetDispatches: unknown[] = [];
    const otherDispatches: unknown[] = [];
    targetDaemon.on(AGENT_EVENTS.dispatch.request, (payload) => {
      targetDispatches.push(payload);
    });
    otherDaemon.on(AGENT_EVENTS.dispatch.request, (payload) => {
      otherDispatches.push(payload);
    });

    await web.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    await targetDaemon.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await targetDaemon.emitWithAck(AGENT_EVENTS.device.runtimes, {
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [
        {
          adapterKind: 'codex',
          name: 'Codex CLI',
          command: '/opt/homebrew/bin/codex',
          cwd: '/Users/shaw/AgentBean',
          installed: true,
        },
      ],
    });
    await otherDaemon.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-2',
      profileId: 'default',
    });
    await otherDaemon.emitWithAck(AGENT_EVENTS.device.runtimes, {
      teamId: 'team-1',
      deviceId: 'device-2',
      runtimes: [
        {
          adapterKind: 'codex',
          name: 'Codex CLI',
          command: '/opt/homebrew/bin/codex',
          cwd: '/Users/shaw/AgentBean',
          installed: true,
        },
      ],
    });

    await web.emitWithAck(WEB_EVENTS.agent.create, {
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Codex',
      args: ['--model', 'gpt-5.4'],
      env: { OPENAI_API_KEY: 'secret-value' },
    });

    await web.emitWithAck(WEB_EVENTS.message.send, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-all',
      body: '@Codex hello',
    });

    await eventually(async () => {
      expect(targetDispatches).toHaveLength(1);
    });
    expect(targetDispatches[0]).toMatchObject({
      id: 'dispatch-1',
      deviceId: 'device-1',
      customAgent: {
        adapterKind: 'codex',
        command: '/opt/homebrew/bin/codex',
        args: ['--model', 'gpt-5.4'],
        cwd: '/Users/shaw/AgentBean',
        env: { OPENAI_API_KEY: 'secret-value' },
      },
    });
    expect(otherDispatches).toEqual([]);
  });

  test('routes device scan requests only to the matching daemon socket', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-all', 'device-1', 'device-2', 'scan-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const agentOne = await connectClient(`${baseUrl}/agent`);
    const agentTwo = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      agentOne.disconnect();
      agentTwo.disconnect();
    });

    await web.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    const agentOneScanRequests: unknown[] = [];
    const agentTwoScanRequests: unknown[] = [];
    agentOne.on(AGENT_EVENTS.device.scanRequested, (payload) => {
      agentOneScanRequests.push(payload);
    });
    agentTwo.on(AGENT_EVENTS.device.scanRequested, (payload) => {
      agentTwoScanRequests.push(payload);
    });

    await expect(
      agentOne.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });
    await expect(
      agentTwo.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-2',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-2', status: 'online' } });

    await expect(
      web.emitWithAck(WEB_EVENTS.device.scan, { userId: 'user-1', deviceId: 'device-1' }),
    ).resolves.toEqual({
      ok: true,
      request: {
        requestId: 'scan-1',
        deviceId: 'device-1',
      },
    });
    await eventually(async () => {
      expect(agentOneScanRequests).toEqual([{ requestId: 'scan-1', deviceId: 'device-1' }]);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agentTwoScanRequests).toEqual([]);
  });

  test('emits DM channel history through channel:join for web listeners', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1', 'team-1', 'channel-all',
        'device-1', 'agent-1',
        'dm-channel-1', 'message-1', 'dispatch-1', 'request-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const bootstrap = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      agent.disconnect();
    });

    const register = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    const web = await connectClient(`${baseUrl}/web`, { auth: { token: (register as { token: string }).token } });
    cleanups.push(async () => {
      web.disconnect();
    });
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true, channels: [{ id: 'channel-all' }] });
    await expect(
      web.emitWithAck(WEB_EVENTS.dm.start, { agentId: 'agent-1' }),
    ).resolves.toMatchObject({
      ok: true,
      dm: { id: 'dm-channel-1', name: 'dm-user-1-agent-1', dmTargetId: 'agent-1' },
    });
    await expect(
      web.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'dm-channel-1',
        body: 'hello',
      }),
    ).resolves.toMatchObject({ ok: true, message: { id: 'message-1', channelId: 'dm-channel-1' } });

    const historyEvents: unknown[] = [];
    web.on(WEB_EVENTS.channel.history, (payload) => {
      historyEvents.push(payload);
    });
    await expect(
      web.emitWithAck(WEB_EVENTS.channel.join, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'dm-channel-1',
        limit: 50,
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: { id: 'dm-channel-1', kind: 'direct', name: 'dm-user-1-agent-1' },
      messages: [expect.objectContaining({ id: 'message-1', body: 'hello', channelId: 'dm-channel-1' })],
    });
    await eventually(async () => {
      expect(historyEvents).toEqual([
        {
          channelId: 'dm-channel-1',
          messages: [expect.objectContaining({ id: 'message-1', body: 'hello', channelId: 'dm-channel-1' })],
        },
      ]);
    });
  });

  test('rejects channel:join for DM when user is not a DM member', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1', 'team-1', 'channel-all',
        'join-1',
        'user-2', 'team-2', 'channel-2',
        'device-1', 'agent-1',
        'dm-channel-1', 'message-1', 'dispatch-1', 'request-1',
      ]),
      joinCodes: createIds(['code-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    // Owner registers and creates join link
    const ownerBootstrap = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      ownerBootstrap.disconnect();
    });
    const ownerRegister = await ownerBootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'owner',
      password: 'secret',
      teamName: 'OwnerTeam',
    });
    expect(ownerRegister).toMatchObject({ ok: true, currentTeam: { id: 'team-1' } });
    const owner = await connectClient(`${baseUrl}/web`, { auth: { token: (ownerRegister as { token: string }).token } });
    cleanups.push(async () => {
      owner.disconnect();
    });
    await expect(owner.emitWithAck(WEB_EVENTS.join.create, { teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      link: { code: 'code-1', teamId: 'team-1' },
    });

    // Guest registers and joins owner's team
    const guestBootstrap = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      guestBootstrap.disconnect();
    });
    const guestRegister = await guestBootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'guest',
      password: 'secret',
      teamName: 'GuestTeam',
      joinCode: 'code-1',
    });
    expect(guestRegister).toMatchObject({ ok: true, user: { id: 'user-2' }, joinedTeam: { id: 'team-1' } });
    const guest = await connectClient(`${baseUrl}/web`, { auth: { token: (guestRegister as { token: string }).token } });
    cleanups.push(async () => {
      guest.disconnect();
    });

    // Set up device and agent
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      agent.disconnect();
    });
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    // Owner starts DM and sends a message
    await expect(
      owner.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      owner.emitWithAck(WEB_EVENTS.dm.start, { agentId: 'agent-1' }),
    ).resolves.toMatchObject({
      ok: true,
      dm: { id: 'dm-channel-1' },
    });
    await expect(
      owner.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'dm-channel-1',
        body: 'secret message',
      }),
    ).resolves.toMatchObject({ ok: true });

    // Guest tries channel:join with the DM channel → should be rejected
    await expect(
      guest.emitWithAck(WEB_EVENTS.channel.join, {
        teamId: 'team-1',
        channelId: 'dm-channel-1',
        limit: 50,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/FORBIDDEN|NOT_FOUND/),
    });
  });

  test('pushes DM agent reply to web client via channel:message', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1', 'team-1', 'channel-all',
        'device-1', 'agent-1',
        'dm-channel-1', 'message-1', 'dispatch-1', 'request-1', 'reply-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const bootstrap = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      agent.disconnect();
    });

    const register = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    const web = await connectClient(`${baseUrl}/web`, { auth: { token: (register as { token: string }).token } });
    cleanups.push(async () => {
      web.disconnect();
    });
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    const channelMessages: unknown[] = [];
    web.on(WEB_EVENTS.channel.message, (message) => {
      channelMessages.push(message);
    });
    await expect(
      web.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      web.emitWithAck(WEB_EVENTS.dm.start, { agentId: 'agent-1' }),
    ).resolves.toMatchObject({
      ok: true,
      dm: { id: 'dm-channel-1' },
    });

    // User sends message in DM → creates dispatch
    await expect(
      web.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'dm-channel-1',
        body: 'hello agent',
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', channelId: 'dm-channel-1' },
      dispatches: [{ id: 'dispatch-1' }],
    });

    // Agent returns dispatch result
    await expect(
      agent.emitWithAck(AGENT_EVENTS.dispatch.result, {
        dispatchId: 'dispatch-1',
        agentId: 'agent-1',
        body: 'done',
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: 'reply-1', senderKind: 'agent', body: 'done' },
    });

    // Web client should receive both the human send and the agent reply via channel:message
    await eventually(async () => {
      expect(channelMessages).toEqual([
        expect.objectContaining({ id: 'message-1', senderKind: 'human', channelId: 'dm-channel-1', body: 'hello agent' }),
        expect.objectContaining({ id: 'reply-1', senderKind: 'agent', channelId: 'dm-channel-1', body: 'done' }),
      ]);
    });
  });
});

async function startSocketServer(app: ReturnType<typeof createInMemoryServerNext>) {
  const httpServer = createServer();
  const ioServer = new Server(httpServer, { cors: { origin: '*' } });
  attachServerNextNamespaces(ioServer, app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const address = httpServer.address() as AddressInfo;
  return {
    httpServer,
    ioServer,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function connectClient(url: string, options: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = createClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    ...options,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error) => reject(error));
    socket.connect();
  });
  return socket;
}

class IntegrationFakeServer {
  constructor(private readonly webNamespace: IntegrationFakeNamespace) {}

  of(namespace: '/web' | '/agent'): IntegrationFakeNamespace {
    return namespace === '/web' ? this.webNamespace : new IntegrationFakeNamespace();
  }
}

class IntegrationFakeNamespace {
  nextSocket?: IntegrationFakeSocket;

  on(event: 'connection', handler: (socket: IntegrationFakeSocket) => void): void {
    if (event === 'connection' && this.nextSocket) {
      handler(this.nextSocket);
    }
  }

  emit(): void {}
}

class IntegrationFakeSocket {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: (result: unknown) => void) => Promise<void> | void>();

  on(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void> | void): void {
    this.handlers.set(event, handler);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  async trigger(event: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`No handler for ${event}`);
    }
    let ackResult: unknown;
    await handler(payload, (result) => {
      ackResult = result;
    });
    return ackResult;
  }
}

async function eventually(assertion: () => Promise<void> | void, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) {
      throw new Error('Test id sequence exhausted');
    }
    return id;
  };
}

function channelIds(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    throw new Error('Expected channel snapshot payload to be an array');
  }
  return payload.map((channel) => {
    if (!channel || typeof channel !== 'object' || !('id' in channel)) {
      throw new Error('Expected channel snapshot item to include id');
    }
    return String(channel.id);
  });
}

function agentSummaries(payload: unknown): Array<{ id: string; status: string }> {
  if (!Array.isArray(payload)) {
    throw new Error('Expected agent snapshot payload to be an array');
  }
  return payload.map((agent) => {
    if (!agent || typeof agent !== 'object' || !('id' in agent) || !('status' in agent)) {
      throw new Error('Expected agent snapshot item to include id and status');
    }
    return { id: String(agent.id), status: String(agent.status) };
  });
}

function deviceSummaries(payload: unknown): Array<{ id: string; status: string }> {
  if (!Array.isArray(payload)) {
    throw new Error('Expected device snapshot payload to be an array');
  }
  return payload.map((device) => {
    if (!device || typeof device !== 'object' || !('id' in device) || !('status' in device)) {
      throw new Error('Expected device snapshot item to include id and status');
    }
    return { id: String(device.id), status: String(device.status) };
  });
}

function runtimeSummary(payload: unknown): {
  deviceId: string;
  runtimes: Array<{ id: string; name: string; installed: boolean; command?: string; normalizedCommandKey?: string }>;
} {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Expected device runtimes payload to be an object');
  }
  const candidate = payload as { deviceId?: unknown; runtimes?: unknown };
  if (typeof candidate.deviceId !== 'string' || !Array.isArray(candidate.runtimes)) {
    throw new Error('Expected device runtimes payload to include deviceId and runtimes');
  }
  return {
    deviceId: candidate.deviceId,
    runtimes: candidate.runtimes.map((runtime) => {
      if (!runtime || typeof runtime !== 'object' || !('id' in runtime) || !('name' in runtime) || !('installed' in runtime)) {
        throw new Error('Expected runtime item to include id and name');
      }
      const candidateRuntime = runtime as {
        id: unknown;
        name: unknown;
        installed: unknown;
        command?: unknown;
        normalizedCommandKey?: unknown;
      };
      if (typeof candidateRuntime.installed !== 'boolean') {
        throw new Error('Expected runtime item installed to be boolean');
      }
      return {
        id: String(candidateRuntime.id),
        name: String(candidateRuntime.name),
        installed: candidateRuntime.installed,
        command: typeof candidateRuntime.command === 'string' ? candidateRuntime.command : undefined,
        normalizedCommandKey:
          typeof candidateRuntime.normalizedCommandKey === 'string' ? candidateRuntime.normalizedCommandKey : undefined,
      };
    }),
  };
}
