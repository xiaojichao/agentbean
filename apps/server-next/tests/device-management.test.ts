import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../packages/contracts/src/index';
import { resetDaemonVersionCacheForTests } from '../src/daemon-version';
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

describe('device rename and delete (end-to-end)', () => {
  test('team member can rename and delete a device', async () => {
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

    // 注册用户（建立 authenticated web session）
    const bootstrap = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      agent.disconnect();
    });
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    expect(registerAck).toMatchObject({ ok: true, user: { id: 'user-1', primaryTeamId: 'team-1' } });

    // 用 token 建立第二个 authenticated socket（后续 rename/delete/get 的 userId 由 session 注入）
    const web = await connectClient(`${baseUrl}/web`, {
      auth: { token: (registerAck as { token: string }).token },
    });
    cleanups.push(async () => {
      web.disconnect();
    });

    // 设备上线（device-1 是 createIds 第 4 个 id）
    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });

    // 改名
    const renamed = await web.emitWithAck(WEB_EVENTS.device.rename, {
      deviceId: 'device-1',
      hostname: 'new-mac',
    });
    expect(renamed).toMatchObject({ ok: true, device: { id: 'device-1', name: 'new-mac' } });

    // 改名后 getDevice 反映新名
    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(got).toMatchObject({ ok: true, device: { id: 'device-1', name: 'new-mac' } });

    // 删除
    const deleted = await web.emitWithAck(WEB_EVENTS.device.delete, { deviceId: 'device-1' });
    expect(deleted).toMatchObject({ ok: true, device: { id: 'device-1' } });

    // 删除后 getDevice → NOT_FOUND
    const after = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(after).toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });

  test('rejects rename when caller is not a team member', async () => {
    // 同 team 的 owner 注册并创建 device；另一 team 的 user 试图改名该 device。
    // 跨 team 隔离：usecase 通过 teams.isMember 拒绝。
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'owner-1',
        'team-1',
        'channel-1',
        'device-1',
        'other-1',
        'team-2',
        'channel-2',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const ownerBootstrap = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      ownerBootstrap.disconnect();
      agent.disconnect();
    });
    const ownerRegister = await ownerBootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'owner',
      password: 'secret',
      teamName: 'OwnerTeam',
    });
    expect(ownerRegister).toMatchObject({ ok: true, user: { id: 'owner-1' } });
    const owner = await connectClient(`${baseUrl}/web`, {
      auth: { token: (ownerRegister as { token: string }).token },
    });
    cleanups.push(async () => {
      owner.disconnect();
    });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'owner-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });

    // 另一个 team 的用户（team-2 与 team-1 无交集）
    const otherBootstrap = await connectClient(`${baseUrl}/web`);
    const otherRegister = await otherBootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'other',
      password: 'secret',
      teamName: 'OtherTeam',
    });
    expect(otherRegister).toMatchObject({ ok: true, user: { id: 'other-1' } });
    const other = await connectClient(`${baseUrl}/web`, {
      auth: { token: (otherRegister as { token: string }).token },
    });
    cleanups.push(async () => {
      otherBootstrap.disconnect();
      other.disconnect();
    });

    // other-1 不在 team-1 → FORBIDDEN
    await expect(
      other.emitWithAck(WEB_EVENTS.device.rename, { deviceId: 'device-1', hostname: 'hacked' }),
    ).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('soft-deletes agents hosted on a device when the device is deleted', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'device-1',
        'runtime-1',
        'agent-1',
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
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    const web = await connectClient(`${baseUrl}/web`, {
      auth: { token: (registerAck as { token: string }).token },
    });
    cleanups.push(async () => {
      web.disconnect();
    });

    // device 上线并注册一个 hosted agent
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    const batchAck = await agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });
    expect(batchAck).toMatchObject({ ok: true, agents: [{ status: 'online', deviceId: 'device-1' }] });
    const agentId = (batchAck as { agents: Array<{ id: string }> }).agents[0]!.id;

    // 删除前：该 agent 可被该 device 查询到
    const before = (await web.emitWithAck(WEB_EVENTS.device.agentsList, {
      teamId: 'team-1',
      deviceId: 'device-1',
    })) as { ok: boolean; agents?: Array<{ id: string }> };
    expect(before).toMatchObject({ ok: true });
    expect(before.agents!.map((a) => a.id)).toContain(agentId);

    // 删除 device 后，device 已不存在 → listDeviceAgents NOT_FOUND
    // （级联软删除：repo delete 顺带软删除 device 下 hosted agents）
    await expect(
      web.emitWithAck(WEB_EVENTS.device.delete, { deviceId: 'device-1' }),
    ).resolves.toMatchObject({ ok: true });

    const after = await web.emitWithAck(WEB_EVENTS.device.agentsList, {
      teamId: 'team-1',
      deviceId: 'device-1',
    });
    expect(after).toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });

  test('device hello rich fields surface through getDevice', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'device-1',
        'runtime-1',
        'agent-1',
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
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    expect(registerAck).toMatchObject({ ok: true, user: { id: 'user-1', primaryTeamId: 'team-1' } });
    const web = await connectClient(`${baseUrl}/web`, {
      auth: { token: (registerAck as { token: string }).token },
    });
    cleanups.push(async () => {
      web.disconnect();
    });

    // daemon hello 上报富 systemInfo + daemonVersion（模拟 daemon collect 后上报）
    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
        hostname: 'mac',
        daemonVersion: '0.2.1',
        systemInfo: {
          hostname: 'mac',
          platform: 'darwin',
          arch: 'arm64',
          release: '24.0',
          osVersion: '24.0',
          cpuModel: 'M1',
          cpuCores: 8,
          totalMemoryGB: 16,
          freeMemoryGB: 8,
          nodeVersion: 'v22.0.0',
          daemonVersion: '0.2.1',
        },
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });

    // getDevice 透传 daemonVersion + 富 systemInfo
    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(got).toMatchObject({
      ok: true,
      device: {
        id: 'device-1',
        daemonVersion: '0.2.1',
        systemInfo: {
          hostname: 'mac',
          platform: 'darwin',
          arch: 'arm64',
          release: '24.0',
          osVersion: '24.0',
          cpuModel: 'M1',
          cpuCores: 8,
          totalMemoryGB: 16,
          freeMemoryGB: 8,
          nodeVersion: 'v22.0.0',
          daemonVersion: '0.2.1',
        },
      },
    });
  });

  test('device connectCommand surfaces after invite-based onboarding', async () => {
    // 完整接入流程：web create invite → daemon wait（agent，自动触发 owner approve complete）→
    // daemon hello（agent，反查 completed invite 生成 connectCommand）→ web getDevice 断言命令。
    // 说明：device-invite:wait 的后置钩子会以 invite.createdBy（owner）自动 complete，
    // 因此本流程不手动 emit device-invite:complete（手动 complete 会返回 INVITE_ALREADY_USED）。
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'invite-1', 'device-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    // 注册用户（建立 authenticated web session）
    const bootstrap = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      agent.disconnect();
    });
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    expect(registerAck).toMatchObject({ ok: true, user: { id: 'user-1', primaryTeamId: 'team-1' } });
    const web = await connectClient(`${baseUrl}/web`, {
      auth: { token: (registerAck as { token: string }).token },
    });
    cleanups.push(async () => {
      web.disconnect();
    });

    // web 建 device invite（teamId/profileId 来自 authenticated session）
    const inviteAck = await web.emitWithAck(WEB_EVENTS.deviceInvite.create, {
      teamId: 'team-1',
      profileId: 'default',
    });
    expect(inviteAck).toMatchObject({ ok: true });
    const invite = (inviteAck as { invite?: { code?: string; command?: string } }).invite;
    expect(invite?.code).toBeTruthy();
    const code = invite!.code!;

    // 先挂 credentials 监听（wait ack 在 owner approve 自动 complete 之前返回，避免竞态漏接推送）
    const credentialsPromise = new Promise<unknown>((resolve) => {
      agent.on(AGENT_EVENTS.deviceInvite.credentials, (payload) => resolve(payload));
    });

    // daemon wait（agent，会自动触发 owner approve complete；ack 返回 updated invite）
    await expect(
      agent.emitWithAck(AGENT_EVENTS.deviceInvite.wait, {
        code,
        machineId: 'mac-1',
        profileId: 'default',
        hostname: 'mac',
        serverUrl: 'https://agentbean.example',
      }),
    ).resolves.toMatchObject({ ok: true, invite: { createdBy: 'user-1' } });

    // 等待 owner approve 自动 complete（异步后置钩子）——用 device-invite:credentials 推送做同步信号
    const credentials = await credentialsPromise;
    expect(credentials).toMatchObject({
      token: expect.any(String),
      ownerId: 'user-1',
      serverUrl: 'https://agentbean.example',
    });

    // daemon hello（agent）：machineId/profileId 匹配 invite → 反查 completed invite 生成 connectCommand
    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'mac-1',
        profileId: 'default',
        hostname: 'mac',
        daemonVersion: '0.2.1',
        systemInfo: { hostname: 'mac', platform: 'darwin', arch: 'arm64', daemonVersion: '0.2.1' },
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });

    // getDevice 断言 connectCommand：含 npx @agentbean/daemon + invite code
    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(got).toMatchObject({ ok: true });
    const connectCommand = (got as { device?: { connectCommand?: string } }).device?.connectCommand;
    expect(connectCommand).toEqual(expect.stringContaining('npx @agentbean/daemon'));
    expect(connectCommand).toContain(code);
    expect(connectCommand).toContain('--server-url https://agentbean.example');
  });

  test('device getDevice surfaces daemonVersionInfo with update-available', async () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.3.0';
    resetDaemonVersionCacheForTests();

    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1']),
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
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    const web = await connectClient(`${baseUrl}/web`, {
      auth: { token: (registerAck as { token: string }).token },
    });
    cleanups.push(async () => {
      web.disconnect();
      delete process.env.AGENT_BEAN_DAEMON_LATEST_VERSION;
      resetDaemonVersionCacheForTests();
    });

    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'mac',
      daemonVersion: '0.2.1',
      systemInfo: {
        hostname: 'mac',
        platform: 'darwin',
        arch: 'arm64',
        daemonVersion: '0.2.1',
      },
    });

    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(got).toMatchObject({
      ok: true,
      device: {
        daemonVersionInfo: { current: '0.2.1', latest: '0.3.0', updateAvailable: true, status: 'update-available' },
        latestDaemonVersion: '0.3.0',
        daemonUpdateAvailable: true,
      },
    });
  });

  test('device select-directory returns path from daemon via request-response', async () => {
    // 端到端验证 request-response 链路：
    // web emitWithAck device:select-directory → server handler → options.deviceSelectDirectory →
    // socket.emitWithAck daemon selectDirectoryRequested → daemon（mock）ack path → server ack web path。
    // daemon 端用测试 client 监听 selectDirectoryRequested + ack 固定 path（模拟用户选目录，不真弹 OS 对话框）。
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    // 注册用户（建立 authenticated web session）
    const bootstrap = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      agent.disconnect();
    });
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    expect(registerAck).toMatchObject({ ok: true, user: { id: 'user-1', primaryTeamId: 'team-1' } });
    const web = await connectClient(`${baseUrl}/web`, {
      auth: { token: (registerAck as { token: string }).token },
    });
    cleanups.push(async () => {
      web.disconnect();
    });

    // device hello（daemon 上线，afterDeviceMutation 进 agentSocketsByDeviceId；device-1 = createIds 第 4）
    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'm-1',
        profileId: 'default',
        hostname: 'mac',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });

    // daemon 端：监听 selectDirectoryRequested，ack 固定 path（socket.io client on handler 第二参数是 ack）
    agent.on(AGENT_EVENTS.device.selectDirectoryRequested, (_payload: unknown, ack?: (r: unknown) => void) => {
      ack?.({ ok: true, path: '/home/user/project' });
    });

    // web 发 select-directory，应通过 server 转发拿到 daemon 返回的 path
    const result = await web.emitWithAck(WEB_EVENTS.device.selectDirectory, { deviceId: 'device-1' });
    expect(result).toMatchObject({ ok: true, path: '/home/user/project' });
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
